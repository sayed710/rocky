/**
 * @packageDocumentation
 * The event-sourced `Game` aggregate — the authoritative model of a single
 * chess game. Commands validate an intent against current state and return the
 * emitted {@link GameEvent}s plus the resulting `Game`. State is always a pure
 * fold of events, so {@link Game.fromEvents} reconstructs any game exactly.
 *
 * The server is the sole authority: legality is decided here via
 * `@chess-platform/core`, never by clients.
 */

import {
  CHESS960_POSITIONS,
  Position,
  chess960Fen,
  opposite,
  parseFen,
  typeOf,
  type Color,
  type Variant,
  repetitionKey,
} from '@chess-platform/core';
import {
  charge,
  hasFlagged,
  initClock,
  type ClockState,
  type TimeControl,
} from './clock';
import type {
  GameCreatedEvent,
  GameEndedEvent,
  GameEvent,
  GameSource,
  MovePlayedEvent,
  Players,
  ResultString,
  Termination,
} from './events';

/** Raised when a command is invalid for the current game state. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}

/** Terminal or ongoing status of a game. */
export type GameStatus =
  | { readonly over: false }
  | {
      readonly over: true;
      readonly result: ResultString;
      readonly termination: Termination;
      readonly winner: Color | null;
    };

/**
 * Map from repetition key → occurrence count. Part of {@link GameState} so it
 * survives `Game.fromEvents` replay (the reducer builds it, not a side channel).
 */
export type RepetitionHistory = ReadonlyMap<string, number>;

/** Immutable snapshot of a game's derived state. */
export interface GameState {
  readonly gameId: string;
  readonly variant: Variant;
  readonly players: Players;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly createdAt: number;
  readonly position: Position;
  readonly clock: ClockState;
  readonly ply: number;
  readonly moves: readonly MovePlayedEvent[];
  readonly status: GameStatus;
  readonly drawOffer: Color | null;
  /** Position-key → occurrence count, for threefold-repetition detection. */
  readonly repetition: RepetitionHistory;
  /**
   * The Scharnagl id this Chess960 game started from, or `null` for every other variant — and for a
   * Chess960 game stored before {@link GameCreatedEvent.chess960StartId} existed, whose arrangement
   * replays exactly but whose *identity* was never recorded and is therefore not knowable.
   */
  readonly chess960StartId: number | null;
  /** The pregame lifecycle this game follows, or `null` for the original one (ADR-0148). */
  readonly source: GameSource | null;
  /**
   * When the pregame no-show deadline falls (`GameCreated.at + noShowAfterMs`), or `null` for a game
   * without a source. Durable, so every replica and every replay agrees on it.
   */
  readonly noShowAt: number | null;
  /** Durable readiness per seat, recorded only before {@link noShowAt}. Only meaningful with a source. */
  readonly ready: { readonly w: boolean; readonly b: boolean };
}

/**
 * What the pregame no-show rule says about a game at a moment (ADR-0148).
 *
 * - `expire`: the deadline has passed with no move played; `ending` is the event to append.
 * - `not_applicable`: the game has no source, is over, or has had its first move.
 * - `not_due`: the deadline has not passed yet.
 * - `both_ready`: a tournament game whose players are both ready; it waits for the first move.
 */
export type NoShowVerdict =
  | { readonly kind: 'expire'; readonly ending: GameEndedEvent }
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'not_due' }
  | { readonly kind: 'both_ready' };

/** Parameters to create a new game. */
export interface CreateGameParams {
  readonly gameId: string;
  readonly variant?: Variant;
  readonly initialFen?: string;
  readonly timeControl: TimeControl;
  readonly players: Players;
  readonly rated?: boolean;
  readonly at: number;
  /**
   * The Scharnagl starting-position id (0..959) for a `chess960` game.
   *
   * Required for that variant and refused for every other. The caller draws it — this is a rules
   * boundary, not a source of entropy (ADR-0136 §1) — which is what lets a test name the arrangement
   * it wants and a tournament derive one reproducibly.
   */
  readonly chess960StartId?: number;
  /** The pregame lifecycle to follow; omitted for bot and direct games (ADR-0148). */
  readonly source?: GameSource;
  /** Required with `source` and refused without it: how long the game may wait for its first move. */
  readonly noShowAfterMs?: number;
}

const GAME_SOURCES: readonly unknown[] = ['seek', 'tournament'] satisfies readonly GameSource[];

/**
 * A stored or requested pregame lifecycle. Both fields absent is the original lifecycle; a known
 * source with a positive integer deadline and a finite creation time is a sourced game; anything else
 * is refused rather than guessed, because a sourced game whose deadline cannot be computed could never
 * be ended. This is the same rule the `pregame_deadlines` trigger applies (migration 0042), so a game
 * the log can replay as sourced is always one the queue holds.
 */
function pregameOf(source: unknown, noShowAfterMs: unknown, at: unknown): { source: GameSource; noShowAfterMs: number } | null {
  if (source === undefined && noShowAfterMs === undefined) return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new GameError(`a sourced game needs a numeric creation time in epoch milliseconds; got ${JSON.stringify(at)}`);
  }
  if (!GAME_SOURCES.includes(source)) throw new GameError(`unknown game source ${JSON.stringify(source)}`);
  if (typeof noShowAfterMs !== 'number' || !Number.isSafeInteger(noShowAfterMs) || noShowAfterMs <= 0) {
    throw new GameError(`a ${String(source)} game needs a positive integer no-show deadline; got ${JSON.stringify(noShowAfterMs)}`);
  }
  if (at + noShowAfterMs > MAX_DEADLINE_MS) {
    throw new GameError(`a no-show deadline must fall before the latest representable date; got ${at} + ${noShowAfterMs}`);
  }
  return { source: source as GameSource, noShowAfterMs };
}

/**
 * The latest instant a no-show deadline may fall: ECMAScript's maximum `Date` (year 275760), which is
 * also inside PostgreSQL's `timestamptz` range, so a deadline the domain accepts is always one the
 * `pregame_deadlines` trigger can store. Migration 0042 applies the same bound.
 */
const MAX_DEADLINE_MS = 8_640_000_000_000_000;

/** Why a first move is refused until both seats are durably ready. */
export const NOT_READY_MESSAGE = 'Both players must be ready before the first move';

/** Whether `id` is a usable Scharnagl starting-position id. */
function isStartId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < CHESS960_POSITIONS;
}

const ONGOING: GameStatus = { over: false };

// Re-exported for backward compatibility with tests and consumers.
export { repetitionKey } from '@chess-platform/core';

export class Game {
  private constructor(private readonly state: GameState) {}

  /**
   * Create a new game, returning the aggregate and its `GameCreated` event.
   *
   * **Chess960 requires `chess960StartId`, and every other variant refuses it.** The rule lives here
   * rather than only at the API because this is the one place every game is born: seek acceptance,
   * the bot route and the tournament launcher all arrive at this call, and a fourth caller added
   * tomorrow inherits the rule instead of having to remember it. That is the same boundary ADR-0123
   * chose to refuse the variant at; what changed is that there is now something truthful to do.
   *
   * ADR-0123 refused creation because the engine could only play one arrangement. ADR-0136 fixed the
   * rules and kept the refusal, because nothing could yet *say* which arrangement a game used, and
   * writing `variant: 'chess960'` beside an arrangement nobody chose would put a durable falsehood
   * into an append-only store. The id closes exactly that gap: it is chosen once, by the server, and
   * recorded on the creation event.
   *
   * The id is required rather than defaulted. Defaulting it to 518 would make the traditional array
   * the silent answer to "which arrangement?", which is the falsehood in its most plausible costume —
   * a real Chess960 game and a caller that forgot to draw an id would be indistinguishable afterwards.
   *
   * `initialFen` is refused for Chess960 for the same reason: the id already determines the position,
   * and two ways to state one fact is two facts that can disagree. Every other variant keeps
   * `initialFen` exactly as before.
   */
  static create(params: CreateGameParams): { game: Game; events: GameEvent[] } {
    const variant = params.variant ?? 'standard';
    const startId = params.chess960StartId;

    // Narrowed once, here, rather than asserted at each use below. `isStartId` is a type predicate,
    // so the assignment inside this branch is what carries `number` out to the two places that need
    // it; the alternative was `startId as number` twice, spending a cast to restate a check the line
    // above already made.
    let chess960StartId: number | null = null;

    if (variant === 'chess960') {
      if (!isStartId(startId)) {
        throw new GameError(
          `chess960 games need a starting-position id in 0..${CHESS960_POSITIONS - 1}; got ` +
            `${startId === undefined ? 'none' : JSON.stringify(startId)}. The server draws it at ` +
            'creation and records it on the GameCreated event. See ADR-0137.',
        );
      }
      if (params.initialFen !== undefined) {
        throw new GameError(
          'chess960 games are started by starting-position id, not by initialFen: the id already ' +
            'determines the position, and accepting both would let them disagree.',
        );
      }
      chess960StartId = startId;
    } else if (startId !== undefined) {
      throw new GameError(
        `a starting-position id is meaningless for '${variant}' and was refused rather than stored; ` +
          'only chess960 games have one.',
      );
    }

    const pregame = pregameOf(params.source, params.noShowAfterMs, params.at);
    const initialFen =
      chess960StartId !== null ? chess960Fen(chess960StartId) : params.initialFen ?? Position.initial(variant).fen();
    const event: GameEvent = {
      type: 'GameCreated',
      gameId: params.gameId,
      variant,
      initialFen,
      timeControl: params.timeControl,
      players: params.players,
      rated: params.rated ?? false,
      at: params.at,
      ...(chess960StartId !== null ? { chess960StartId } : {}),
      ...(pregame !== null ? pregame : {}),
    };
    return { game: Game.fromEvents([event]), events: [event] };
  }

  /** Reconstruct a game by folding its full event history. */
  static fromEvents(events: readonly GameEvent[]): Game {
    let state: GameState | null = null;
    for (const event of events) {
      state = Game.reduce(state, event);
    }
    if (state === null) throw new GameError('Cannot reconstruct a game from zero events');
    return new Game(state);
  }

  /** The current derived state (read-only). */
  snapshot(): GameState {
    return this.state;
  }

  get status(): GameStatus {
    return this.state.status;
  }

  get turn(): Color {
    return this.state.position.turn;
  }

  get fen(): string {
    return this.state.position.fen();
  }

  /** True while a sourced game still needs a seat's readiness before its first move can be played. */
  get awaitingReadiness(): boolean {
    const s = this.state;
    return s.source !== null && !s.status.over && s.ply === 0 && !(s.ready.w && s.ready.b);
  }

  // --- Commands ----------------------------------------------------------

  /**
   * Play a move (UCI). Emits `MovePlayed` and, if the position becomes terminal
   * or the mover flags, a following `GameEnded`. Throws on illegal moves,
   * wrong turn, or a finished game.
   */
  playMove(uci: string, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    // Like a move after a flag fall: once the no-show deadline has passed without a first move, the
    // move does not count and the no-show ending is what gets recorded, however late the worker is.
    if (this.noShowVerdict(at).kind === 'expire') return this.expireNoShow(at);
    if (this.awaitingReadiness) throw new GameError(NOT_READY_MESSAGE);
    const s = this.state;
    const mover = s.position.turn;

    // Flag check first: a move submitted after the clock expired does not count.
    const charged = charge(s.clock, mover, at, s.timeControl);
    if (charged.flagged) {
      return this.endByTimeout(mover, at);
    }

    let nextPos: Position;
    let san: string;
    try {
      const move = this.resolveMove(uci);
      san = s.position.toSan(move);
      nextPos = s.position.play(move);
    } catch (err) {
      throw new GameError(`Illegal move "${uci}": ${(err as Error).message}`);
    }

    const moveEvent: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: s.ply + 1,
      uci,
      san,
      by: mover,
      moveTimeMs: charged.moveTimeMs,
      remaining: charged.clock.remaining,
      at,
    };
    const events: GameEvent[] = [moveEvent];

    const posStatus = nextPos.status();
    if (posStatus.over) {
      events.push(this.terminalEventFor(posStatus, at));
    } else {
      // Check threefold repetition: if the new position's key has occurred
      // 3 times (including this one), the game ends as a draw.
      const key = repetitionKey(nextPos.snapshot());
      if ((s.repetition.get(key) ?? 0) + 1 >= 3) {
        events.push({
          type: 'GameEnded',
          result: '1/2-1/2',
          termination: 'threefold',
          winner: null,
          at,
        });
      }
    }

    return { game: Game.applyAll(this, events), events };
  }

  /** Resign as `color`. */
  resign(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: color === 'w' ? '0-1' : '1-0',
      termination: 'resignation',
      winner: opposite(color),
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Offer a draw as `color`. */
  offerDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.drawOffer === color) {
      throw new GameError('Draw already offered by this side');
    }
    const events: GameEvent[] = [{ type: 'DrawOffered', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Accept an outstanding draw offer made by the opponent of `color`. */
  acceptDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const offer = this.state.drawOffer;
    if (offer === null || offer === color) {
      throw new GameError('No draw offer from the opponent to accept');
    }
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: '1/2-1/2',
      termination: 'agreement',
      winner: null,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Decline the outstanding draw offer as `color`. */
  declineDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.drawOffer === null) throw new GameError('No draw offer to decline');
    const events: GameEvent[] = [{ type: 'DrawDeclined', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Claim the side-to-move has flagged (opponent's clock claim). */
  claimFlag(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const s = this.state;
    const sideToMove = s.position.turn;
    if (!hasFlagged(s.clock, sideToMove, at, s.timeControl)) {
      throw new GameError('Opponent has not flagged');
    }
    return this.endByTimeout(sideToMove, at);
  }

  /** Abort the game (allowed only before both players have moved). */
  abort(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.ply >= 2) throw new GameError('Game can no longer be aborted');
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: '*',
      termination: 'aborted',
      winner: null,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  /**
   * Record that `color` is ready. Emits `PlayerReady` only when it changes something: a sourced game,
   * not over, no move played yet, and that seat not already ready. Every other call is a no-op, so
   * duplicate joins, reconnects and racing replicas can neither duplicate nor fail readiness.
   */
  markReady(color: Color, at: number): { game: Game; events: GameEvent[] } {
    const s = this.state;
    // Readiness after the deadline does not count: it must not undo a no-show that was already due.
    if (s.noShowAt === null || at >= s.noShowAt) return { game: this, events: [] };
    if (s.status.over || s.ply > 0 || s.ready[color]) return { game: this, events: [] };
    const events: GameEvent[] = [{ type: 'PlayerReady', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  /**
   * The pregame no-show verdict at `at`, from the durable deadline (ADR-0148). Readiness counts only
   * if it was recorded before the deadline, which {@link markReady} guarantees.
   *
   * Seek: aborted with no result whoever was ready, because the deadline governs the whole wait for
   * the first move. Tournament: a forfeit win for the one ready player, a double forfeit when
   * neither is ready, and no ending at all when both are.
   */
  noShowVerdict(at: number): NoShowVerdict {
    const s = this.state;
    if (s.source === null || s.noShowAt === null || s.status.over || s.ply > 0) return { kind: 'not_applicable' };
    if (at < s.noShowAt) return { kind: 'not_due' };
    const end = (result: ResultString, winner: Color | null): NoShowVerdict => ({
      kind: 'expire',
      ending: { type: 'GameEnded', result, termination: 'no_show', winner, at },
    });
    if (s.source === 'seek') return end('*', null);
    if (s.ready.w && s.ready.b) return { kind: 'both_ready' };
    if (s.ready.w) return end('1-0', 'w');
    if (s.ready.b) return end('0-1', 'b');
    return end('*', null);
  }

  /** End the game by the pregame no-show rule. Throws unless {@link noShowVerdict} says `expire`. */
  expireNoShow(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const verdict = this.noShowVerdict(at);
    if (verdict.kind !== 'expire') throw new GameError(`No-show expiry refused: ${verdict.kind}`);
    const events: GameEvent[] = [verdict.ending];
    return { game: Game.applyAll(this, events), events };
  }

  // --- Internals ---------------------------------------------------------

  private assertOngoing(): void {
    if (this.state.status.over) throw new GameError('Game is already over');
  }

  private resolveMove(uci: string) {
    // Position.play validates legality; we resolve to a Move for SAN first.
    const legal = this.state.position.legalMoves();
    for (const m of legal) {
      if (this.state.position.toUci(m) === uci) return m;
    }
    throw new GameError(`No legal move matches "${uci}"`);
  }

  private endByTimeout(flagged: Color, at: number): { game: Game; events: GameEvent[] } {
    const winner = opposite(flagged);
    // If the side that would win on time cannot possibly mate, it is a draw.
    const drawByInsufficient = !canMate(this.state.position.fen(), winner, this.state.variant);
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: drawByInsufficient ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1',
      termination: drawByInsufficient ? 'insufficient_material' : 'timeout',
      winner: drawByInsufficient ? null : winner,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  private terminalEventFor(
    posStatus: Exclude<ReturnType<Position['status']>, { over: false }>,
    at: number,
  ): GameEvent {
    switch (posStatus.reason) {
      case 'checkmate':
        return {
          type: 'GameEnded',
          result: posStatus.winner === 'w' ? '1-0' : '0-1',
          termination: 'checkmate',
          winner: posStatus.winner,
          at,
        };
      case 'variant_win':
        return {
          type: 'GameEnded',
          result: posStatus.winner === 'w' ? '1-0' : '0-1',
          termination: 'variant',
          winner: posStatus.winner,
          at,
        };
      case 'stalemate':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'stalemate', winner: null, at };
      case 'insufficient_material':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at };
      case 'fifty_move':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'fifty_move', winner: null, at };
      case 'threefold':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'threefold', winner: null, at };
      case 'variant_draw':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'variant', winner: null, at };
    }
  }

  private static applyAll(game: Game, events: readonly GameEvent[]): Game {
    let state: GameState = game.state;
    for (const event of events) state = Game.reduce(state, event);
    return new Game(state);
  }

  /**
   * The starting-position id a stored `GameCreated` asserts, validated against the rest of the event.
   *
   * This runs on **replay**, not just on creation, because `Game.create` is not the only way an event
   * reaches the reducer: a stored payload is JSON that was written by some earlier version of this
   * code, and `Game.fromEvents` is where a game comes back from disk. A creation-time check alone
   * would leave the store's own contents unchecked, which is the half that matters — the append-only
   * log is the thing that cannot be corrected afterwards.
   *
   * Three ways an event can be wrong, and all three throw rather than resolve to something plausible:
   *
   * - **An id on a non-Chess960 game.** Only Chess960 has one; a `standard` event carrying one is
   *   describing a game that does not exist.
   * - **An out-of-range or non-integer id.** `-1`, `960` and `3.5` name no arrangement.
   * - **An id that disagrees with `initialFen`.** Both are stored, so both can be tampered with
   *   independently; a client that fabricated an initial state would show up here and nowhere else.
   *   The comparison is exact string equality against `chess960Fen(id)`, which is what `Game.create`
   *   writes, so agreement is the only thing that can pass.
   *
   * A `chess960` event with **no** id is the one case that is not an error: it predates the field.
   * It replays from `initialFen` exactly as it always did and reports `null` — see
   * {@link GameCreatedEvent.chess960StartId}.
   */
  private static startIdOf(event: GameCreatedEvent): number | null {
    const id = event.chess960StartId;
    if (id === undefined) return null;
    if (event.variant !== 'chess960') {
      throw new GameError(
        `GameCreated for '${event.variant}' carries a chess960 starting-position id (${JSON.stringify(id)}); ` +
          'only chess960 games have one.',
      );
    }
    if (!isStartId(id)) {
      throw new GameError(
        `GameCreated carries an invalid chess960 starting-position id: ${JSON.stringify(id)} is not an ` +
          `integer in 0..${CHESS960_POSITIONS - 1}.`,
      );
    }
    const expected = chess960Fen(id);
    if (event.initialFen !== expected) {
      throw new GameError(
        `GameCreated claims chess960 starting position ${id} but its initialFen is not that position ` +
          `(expected "${expected}", stored "${event.initialFen}").`,
      );
    }
    return id;
  }

  /** The pure reducer: `(state, event) -> state`. */
  private static reduce(state: GameState | null, event: GameEvent): GameState {
    switch (event.type) {
      case 'GameCreated': {
        const startId = Game.startIdOf(event);
        const pregame = pregameOf(event.source, event.noShowAfterMs, event.at);
        const source = pregame?.source ?? null;
        const position = Position.fromFen(event.initialFen, event.variant);
        // Seed the repetition history with the initial position (count = 1).
        const rep = new Map<string, number>();
        rep.set(repetitionKey(position.snapshot()), 1);
        return {
          gameId: event.gameId,
          variant: event.variant,
          players: event.players,
          timeControl: event.timeControl,
          rated: event.rated,
          createdAt: event.at,
          position,
          // A sourced game's clock starts at its first move, so nothing is anchored at creation. A game
          // without a source keeps the creation anchor it always had, so a game stored before ADR-0148
          // and still in progress is not reinterpreted.
          clock: initClock(event.timeControl, source === null ? event.at : null),
          ply: 0,
          moves: [],
          status: ONGOING,
          drawOffer: null,
          repetition: rep,
          chess960StartId: startId,
          source,
          noShowAt: pregame === null ? null : event.at + pregame.noShowAfterMs,
          ready: { w: false, b: false },
        };
      }
      case 'PlayerReady': {
        if (state === null) throw new GameError('PlayerReady before GameCreated');
        if (event.by !== 'w' && event.by !== 'b') {
          throw new GameError(`PlayerReady for unknown seat ${JSON.stringify(event.by)}`);
        }
        return { ...state, ready: { ...state.ready, [event.by]: true } };
      }
      case 'MovePlayed': {
        if (state === null) throw new GameError('MovePlayed before GameCreated');
        const position = state.position.play(event.uci);
        const charged = charge(state.clock, event.by, event.at, state.timeControl, event.moveTimeMs);
        // Update repetition history: increment the count for the new position's key.
        const key = repetitionKey(position.snapshot());
        const rep = new Map(state.repetition);
        rep.set(key, (rep.get(key) ?? 0) + 1);
        return {
          ...state,
          position,
          clock: charged.clock,
          ply: event.ply,
          moves: [...state.moves, event],
          drawOffer: null,
          repetition: rep,
        };
      }
      case 'DrawOffered': {
        if (state === null) throw new GameError('DrawOffered before GameCreated');
        return { ...state, drawOffer: event.by };
      }
      case 'DrawDeclined': {
        if (state === null) throw new GameError('DrawDeclined before GameCreated');
        return { ...state, drawOffer: null };
      }
      case 'GameEnded': {
        if (state === null) throw new GameError('GameEnded before GameCreated');
        return {
          ...state,
          status: { over: true, result: event.result, termination: event.termination, winner: event.winner },
          drawOffer: null,
        };
      }
    }
  }
}

/**
 * Whether `color` could still win, used to convert a timeout into a draw when the opponent could
 * not possibly have won anyway.
 *
 * The question is variant-specific, and asking the standard one everywhere is wrong in a way that
 * costs players games. "Enough material to deliver checkmate" only means anything in a variant whose
 * win condition *is* checkmate. King of the Hill is won by walking a king to the centre; Racing
 * Kings by reaching the eighth rank; Three-check by giving three checks; Atomic by exploding the
 * enemy king; Crazyhouse by dropping the pieces in hand, which the board position does not show at
 * all. Treating those as standard chess turned a win into a draw whenever the loser flagged.
 *
 * Conservative in one direction on purpose: it answers "could this side possibly win", so where the
 * honest answer is unclear it says yes. Awarding a draw the winner did not deserve is the failure
 * mode worth avoiding; the guard exists only to spare someone a loss they could never have converted.
 */
export function canMate(fen: string, color: Color, variant: Variant = 'standard'): boolean {
  const st = parseFen(fen, variant);

  let bishops = 0;
  let knights = 0;
  let majorOrPawn = false;
  let anyPiece = false;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = st.board[sq];
    if (p === null) continue;
    const isWhite = p === p.toUpperCase();
    if ((isWhite && color !== 'w') || (!isWhite && color !== 'b')) continue;
    const t = typeOf(p);
    if (t === 'k') continue;
    anyPiece = true;
    if (t === 'p' || t === 'r' || t === 'q') majorOrPawn = true;
    else if (t === 'b') bishops++;
    else if (t === 'n') knights++;
  }

  switch (variant) {
    case 'kingofthehill':
    case 'racingkings':
      // Both are won by walking a king somewhere. A player reduced to a bare king still has the only
      // piece the win condition needs, so material can never rule the win out.
      return true;

    case 'crazyhouse':
      // Anything in hand can be dropped, and the board alone never shows it — but the deciding point
      // is that a king captures like any other piece, so even a bare king with an empty pocket can
      // take something and drop it back. There is no material configuration from which winning is
      // impossible, which makes the guard inapplicable rather than merely generous.
      return true;

    case 'threecheck':
      // Won by giving three checks rather than by mating, so the two-minor threshold does not apply:
      // a lone knight can check. Only a bare king can never give check.
      return anyPiece;

    case 'atomic':
      // Won by exploding the enemy king. A king may not capture — it would explode itself — so a bare
      // king cannot win, but any other piece can deliver the capture that ends it.
      return anyPiece;

    case 'horde':
      // White is an army of pawns with no king and wins by mating Black; Black wins by capturing
      // every white piece, and a king captures perfectly well on its own. Neither side reaches a
      // material state that rules the win out, so as in Crazyhouse the guard does not apply.
      return true;

    case 'standard':
    case 'chess960':
    default:
      // Checkmate is the win condition, so the classical material test applies: a lone king, K+N and
      // K+B cannot force mate; two minors can.
      if (majorOrPawn) return true;
      return bishops + knights >= 2;
  }
}
