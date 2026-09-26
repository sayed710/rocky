/**
 * @packageDocumentation
 * The Game Authority: the single owner of live game state.
 *
 * Responsibilities (`docs/ARCHITECTURE.md` §3):
 * - Owns the in-memory {@link Game} aggregate for each live game, keyed by id
 *   (a shard owns a disjoint set of games; one owner per game).
 * - Validates every command via `@chess-platform/game` (which itself uses the
 *   perft-verified core engine) — the server is the sole authority on legality.
 * - Appends emitted events to an append-only log and publishes the resulting
 *   authoritative broadcasts to the game's channel for gateway fanout.
 * - Serializes commands **per game** so concurrent intents can never interleave
 *   and corrupt state (the explicit race-condition guard from the roadmap).
 *
 * The authority is transport-agnostic: it neither knows nor cares whether a
 * command arrived over WebSocket, HTTP, or a test harness.
 */

import { createHash } from 'node:crypto';
import { Game, type GameEvent } from '@chess-platform/game';
import type { Color, Position } from '@chess-platform/core';
import type { CreateGameParams } from '@chess-platform/game';
import { InMemoryEventLog, type EventLog } from './event-log';
import type { GameBroadcast, LegalMoves, ReadyView, StateView } from './protocol';
import { gameChannel, gamesEndedChannel, type PubSub } from './pubsub';

/**
 * A command against a game. Every kind but the last two is issued by a seated player through the
 * wire protocol. `ready` is issued by the gateway itself after a seated player's authenticated join,
 * and `expireNoShow` only by the server's no-show worker as {@link NO_SHOW_ACTOR}; the protocol
 * decoder produces neither (ADR-0148).
 */
export type Command =
  | { readonly kind: 'move'; readonly uci: string }
  | { readonly kind: 'resign' }
  | { readonly kind: 'offerDraw' }
  | { readonly kind: 'acceptDraw' }
  | { readonly kind: 'declineDraw' }
  | { readonly kind: 'claimFlag' }
  | { readonly kind: 'abort' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'expireNoShow' };

/**
 * The actor that issues `expireNoShow`. Not an account id: player identities come only from verified
 * tokens, and anonymous spectators are `anon-<connection>`, so no client can act as it.
 */
export const NO_SHOW_ACTOR = 'system:no-show';

/** Reasons a command can be refused, aligned with the protocol reject codes. */
export type AuthorityErrorCode =
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'unknown_game'
  | 'invalid_command'
  | 'not_ready';

/** A refused command. `code` maps directly onto a protocol `RejectCode`. */
export class AuthorityError extends Error {
  constructor(readonly code: AuthorityErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityError';
  }
}

interface BroadcastLogEntry {
  readonly seq: number;
  readonly ply: number | null;
  readonly msg: GameBroadcast;
}

interface GameRecord {
  game: Game;
  readonly events: GameEvent[];
  readonly broadcasts: BroadcastLogEntry[];
  /** Serialization tail: commands await the previous command's completion. */
  lock: Promise<void>;
  broadcastSeq: number;
  /** Durable-log head seq already persisted (`events.length - 1`). */
  persistedSeq: number;
  /** Set when an uncertain append could not be reconciled with the durable log. */
  stale: boolean;
}

/** Short, stable hash of a FEN string for cheap desync detection. */
export function fenHash(fen: string): string {
  return createHash('sha256').update(fen).digest('hex').slice(0, 12);
}

/**
 * Legal destinations for the side to move, keyed by origin square. Reuses the
 * position's own (perft-verified) move generator — the single source of truth
 * for legality — and collapses promotions to their shared destination square.
 * Returns `{}` for terminal positions (no legal moves).
 */
export function legalMovesOf(position: Position): LegalMoves {
  const byFrom = new Map<string, Set<string>>();
  for (const move of position.legalMoves()) {
    const uci = position.toUci(move);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    let dests = byFrom.get(from);
    if (dests === undefined) {
      dests = new Set<string>();
      byFrom.set(from, dests);
    }
    dests.add(to);
  }
  const out: Record<string, readonly string[]> = {};
  for (const [from, dests] of byFrom) {
    out[from] = [...dests];
  }
  return out;
}

/** The result of applying a command. */
export interface ApplyResult {
  readonly events: readonly GameEvent[];
  readonly broadcasts: readonly GameBroadcast[];
  readonly state: StateView;
}

export class GameAuthority {
  private readonly games = new Map<string, GameRecord>();

  constructor(
    private readonly pubsub: PubSub,
    /** Injectable clock so tests are deterministic; defaults to wall time. */
    private readonly now: () => number = () => Date.now(),
    /**
     * Durable event log. Every event is persisted before its broadcast fans
     * out, so a game survives eviction/restart and rehydrates exactly. Defaults
     * to a process-local in-memory log; the deployable service injects the
     * Postgres store (`@chess-platform/persistence`).
     */
    private readonly store: EventLog = new InMemoryEventLog(),
  ) {}

  /** Whether a live game is currently held in the hot cache. */
  has(gameId: string): boolean {
    return this.games.has(gameId);
  }

  /** A resident game is safe for synchronous edge reads only after any reload completes. */
  hasFresh(gameId: string): boolean {
    const record = this.games.get(gameId);
    return record !== undefined && !record.stale;
  }

  /**
   * Whether a game exists at all — in the hot cache or the durable log.
   * Unlike {@link has} this consults the store, so an evicted/cold game counts.
   */
  async knows(gameId: string): Promise<boolean> {
    return this.games.has(gameId) || this.store.exists(gameId);
  }

  /**
   * Create and register a new game. Throws if the id is already in use (in the
   * hot cache or the durable log). `at` defaults to the authority's clock. The
   * `GameCreated` event is persisted before the game is registered; creation is
   * not a broadcast (joiners receive the full state instead).
   */
  async createGame(params: Omit<CreateGameParams, 'at'> & { at?: number }): Promise<StateView> {
    if (this.games.has(params.gameId)) {
      throw new AuthorityError('invalid_command', `game ${params.gameId} already exists`);
    }
    const at = params.at ?? this.now();
    // Wrapped for the same reason the persist below is: this function's contract is that a refused
    // creation surfaces as `AuthorityError`, and `Game.create` refuses some of them itself — a
    // `chess960` game without a starting-position id, or any other variant carrying one (ADR-0137).
    // `codeOf` in `gateway.ts` does fall back to `invalid_command` for an unrecognised error, so an
    // escaping `GameError` would already reach the client as the right reject code; this makes that
    // a stated guarantee rather than a lucky default, and keeps the two failure paths in this one
    // function consistent. Raised in the Qodo review of PR #145.
    let game: Game;
    let events: GameEvent[];
    try {
      ({ game, events } = Game.create({ ...params, at }));
    } catch (err) {
      throw new AuthorityError('invalid_command', `cannot create game ${params.gameId}: ${(err as Error).message}`);
    }
    // Persist first: an append against a fresh id fails if the game already
    // exists in the durable log, so the store is the single source of truth for
    // uniqueness across restarts.
    let persistedSeq: number;
    try {
      persistedSeq = await this.store.append(params.gameId, -1, events);
    } catch (err) {
      throw new AuthorityError('invalid_command', `cannot create game ${params.gameId}: ${(err as Error).message}`);
    }
    this.games.set(params.gameId, {
      game,
      events: [...events],
      broadcasts: [],
      lock: Promise.resolve(),
      broadcastSeq: 0,
      persistedSeq,
      stale: false,
    });
    return this.viewOf(game);
  }

  /**
   * Ensure a game is resident in the hot cache, hydrating it from the durable
   * log if it was evicted or the process restarted. Returns `false` if no such
   * game exists anywhere. Safe to call repeatedly; a cache hit is a no-op.
   */
  async ensureLoaded(gameId: string): Promise<boolean> {
    const resident = this.games.get(gameId);
    if (resident) return resident.stale ? this.reloadFromLog(gameId) : true;
    const logged = await this.store.load(gameId);
    if (logged.length === 0) return false;
    this.games.set(gameId, this.rebuildRecord(gameId, logged));
    return true;
  }

  /**
   * Reload a game from the durable log, replacing any cached copy.
   *
   * Unlike {@link ensureLoaded}, a cache hit does NOT short-circuit: this exists for the moment a
   * node takes over ownership, where the cached copy is precisely what cannot be trusted — the
   * previous owner's moves reached this node as room broadcasts, which never touch the authority.
   *
   * The record is swapped in only after the log read resolves, so there is no window in which the
   * game is missing from the cache. Evicting first and loading second would open one, and a
   * concurrent command or join landing inside it would be answered `unknown_game`.
   */
  async reloadFromLog(gameId: string): Promise<boolean> {
    const resident = this.games.get(gameId);
    if (!resident) {
      const logged = await this.store.load(gameId);
      if (logged.length === 0) return false;
      this.games.set(gameId, this.rebuildRecord(gameId, logged));
      return true;
    }
    resident.stale = true;
    const run = resident.lock.then(() => this.refreshRecord(gameId, resident));
    resident.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Preserve the command queue while replacing its state with PostgreSQL truth. */
  private async refreshRecord(gameId: string, record: GameRecord): Promise<boolean> {
    const logged = await this.store.load(gameId);
    if (logged.length === 0) return false;
    const fresh = this.rebuildRecord(gameId, logged);
    record.game = fresh.game;
    record.events.splice(0, record.events.length, ...fresh.events);
    record.broadcasts.splice(0, record.broadcasts.length, ...fresh.broadcasts);
    record.broadcastSeq = fresh.broadcastSeq;
    record.persistedSeq = fresh.persistedSeq;
    record.stale = false;
    return true;
  }

  /**
   * Drop a game from the hot cache. Durable state is untouched, so the next
   * access rehydrates it from the log. Intended for finished/idle games to
   * bound memory; a no-op for an unknown id.
   */
  evict(gameId: string): void {
    this.games.delete(gameId);
  }

  /**
   * Rebuild a full {@link GameRecord} from a durable event log: the folded
   * {@link Game}, plus the broadcast history replayed exactly as the live path
   * produced it, so resume/catch-up ({@link getMissedSince}) works after a
   * restart.
   */
  private rebuildRecord(gameId: string, logged: readonly { readonly event: GameEvent }[]): GameRecord {
    const events = logged.map((e) => e.event);
    const game = Game.fromEvents(events);
    const broadcasts: BroadcastLogEntry[] = [];
    let broadcastSeq = 0;
    // Replay incrementally: a MovePlayed/GameEnded broadcast carries the
    // fenHash + legalMoves of the position *after* that event, exactly as the
    // live path computes them.
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type !== 'MovePlayed' && ev.type !== 'GameEnded' && ev.type !== 'PlayerReady') continue;
      const upto = Game.fromEvents(events.slice(0, i + 1));
      const snap = upto.snapshot();
      const fh = fenHash(upto.fen);
      const legal: LegalMoves = snap.status.over ? {} : legalMovesOf(snap.position);
      const msg = this.toBroadcast(gameId, ev, fh, legal, snap.ready);
      if (!msg) continue;
      const seq = ++broadcastSeq;
      broadcasts.push({ seq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }
    return {
      game,
      events,
      broadcasts,
      lock: Promise.resolve(),
      broadcastSeq,
      persistedSeq: events.length - 1,
      stale: false,
    };
  }

  /** Current authoritative state view. Throws if the game is unknown. */
  getState(gameId: string): StateView {
    const record = this.require(gameId);
    if (record.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    return this.viewOf(record.game);
  }

  /**
   * Every broadcast a resuming client missed: all broadcasts recorded after the
   * move whose ply equals `lastPly`. `lastPly <= 0` returns the full history.
   */
  getMissedSince(gameId: string, lastPly: number): GameBroadcast[] {
    const rec = this.require(gameId);
    if (rec.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    if (lastPly <= 0) return rec.broadcasts.map((e) => e.msg);
    let cutSeq = -1;
    for (const e of rec.broadcasts) {
      if (e.ply === lastPly) cutSeq = e.seq;
    }
    return rec.broadcasts.filter((e) => e.seq > cutSeq).map((e) => e.msg);
  }

  /** Resolve a user's seat in a game, or `null` if they are a spectator. */
  colorOf(gameId: string, userId: string): Color | null {
    const record = this.require(gameId);
    if (record.stale) throw new AuthorityError('invalid_command', 'durable game reload is required');
    const { players } = record.game.snapshot();
    if (players.white === userId) return 'w';
    if (players.black === userId) return 'b';
    return null;
  }

  /**
   * Apply a command from `userId`. Serialized per game: the returned promise
   * resolves only after any in-flight command for the same game completes, so
   * two moves can never race. Rejections surface as {@link AuthorityError}.
   */
  apply(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const rec = this.require(gameId);
    const run = rec.lock.then(() => this.applyNow(gameId, rec, userId, cmd));
    // Keep the chain alive regardless of this command's success/failure.
    rec.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyNow(gameId: string, rec: GameRecord, userId: string, cmd: Command): Promise<ApplyResult> {
    if (rec.stale && !(await this.refreshRecord(gameId, rec))) {
      throw new AuthorityError('unknown_game', `no durable game ${gameId}`);
    }
    const at = this.now();
    if (cmd.kind === 'expireNoShow') {
      // Checked before anything else so a player can never issue it, and the worker never as a seat.
      // The deadline is the game's own durable one; the caller supplies none.
      if (userId !== NO_SHOW_ACTOR) throw new AuthorityError('not_a_player', 'only the server may expire a no-show');
      return this.commit(gameId, rec, this.guard(() => rec.game.expireNoShow(at)));
    }
    const players = rec.game.snapshot().players;
    const color = players.white === userId ? 'w' : players.black === userId ? 'b' : null;
    if (color === null) {
      throw new AuthorityError('not_a_player', 'only players may issue commands');
    }
    // A player command arriving after a due no-show deadline records the no-show instead, as a move
    // after a flag fall records the timeout. The outcome never depends on how late the worker runs.
    if (rec.game.noShowVerdict(at).kind === 'expire') {
      return this.commit(gameId, rec, rec.game.expireNoShow(at));
    }
    let result: { game: Game; events: GameEvent[] };

    switch (cmd.kind) {
      case 'move': {
        if (rec.game.turn !== color) {
          throw new AuthorityError('not_your_turn', 'it is not your turn');
        }
        // The domain refuses this too; checked here only to give the precise reject code.
        if (rec.game.awaitingReadiness) {
          throw new AuthorityError('not_ready', 'both players must be ready before the first move');
        }
        try {
          result = rec.game.playMove(cmd.uci, at);
        } catch (err) {
          throw new AuthorityError('illegal_move', (err as Error).message);
        }
        break;
      }
      case 'resign':
        result = this.guard(() => rec.game.resign(color, at));
        break;
      case 'offerDraw':
        result = this.guard(() => rec.game.offerDraw(color, at));
        break;
      case 'acceptDraw':
        result = this.guard(() => rec.game.acceptDraw(color, at));
        break;
      case 'declineDraw':
        result = this.guard(() => rec.game.declineDraw(color, at));
        break;
      case 'claimFlag':
        result = this.guard(() => rec.game.claimFlag(at));
        break;
      case 'abort':
        result = this.guard(() => rec.game.abort(at));
        break;
      case 'ready':
        result = rec.game.markReady(color, at);
        break;
      default: {
        const _exhaustive: never = cmd;
        throw new AuthorityError('invalid_command', `unknown command ${JSON.stringify(_exhaustive)}`);
      }
    }
    return this.commit(gameId, rec, result);
  }

  /** Persist a command's events, then commit them to the hot record and publish their broadcasts. */
  private async commit(
    gameId: string,
    rec: GameRecord,
    result: { game: Game; events: GameEvent[] },
  ): Promise<ApplyResult> {
    // A no-op (a repeated readiness) changes nothing, so it neither touches the log nor broadcasts.
    if (result.events.length === 0) return { events: [], broadcasts: [], state: this.viewOf(rec.game) };

    // Compute the resulting position's legal moves once per command.
    // For MovePlayed broadcasts this is the post-move position's side-to-move
    // legal moves (empty if the move ended the game). For GameEnded broadcasts
    // the game is over so legal moves are always {}.
    const resultingSnap = result.game.snapshot();
    const resultingLegalMoves: LegalMoves =
      resultingSnap.status.over ? {} : legalMovesOf(resultingSnap.position);
    const resultingFenHash = fenHash(result.game.fen);

    const pending: BroadcastLogEntry[] = [];
    let nextSeq = rec.broadcastSeq;
    for (const ev of result.events) {
      const msg = this.toBroadcast(gameId, ev, resultingFenHash, resultingLegalMoves, resultingSnap.ready);
      if (!msg) continue;
      pending.push({ seq: ++nextSeq, ply: msg.t === 'move' ? msg.ply : null, msg });
    }

    // Persist the emitted events *before* mutating the hot record or publishing,
    // so a durable-log failure leaves the in-memory game and the store in lock
    // step (nothing committed, nothing broadcast) rather than ahead of disk.
    try {
      rec.persistedSeq = await this.store.append(gameId, rec.persistedSeq, result.events);
    } catch (err) {
      rec.stale = true;
      try {
        await this.refreshRecord(gameId, rec);
      } catch {
        // A later command must retry the durable reload before using this cache entry.
      }
      throw new AuthorityError('invalid_command', `failed to persist events for ${gameId}: ${(err as Error).message}`);
    }

    // Commit to the hot record only after the durable append succeeded.
    rec.game = result.game;
    rec.events.push(...result.events);
    rec.broadcasts.push(...pending);
    rec.broadcastSeq = nextSeq;

    // Publish only after state is durably committed, so a subscriber can never
    // observe a broadcast for a state the authority has not persisted.
    const broadcasts = pending.map((e) => e.msg);
    for (const msg of broadcasts) {
      this.pubsub.publish(gameChannel(gameId), msg);
      if (msg.t === 'ended') this.pubsub.publish(gamesEndedChannel(), msg);
    }

    return { events: result.events, broadcasts, state: this.viewOf(rec.game) };
  }

  private guard(fn: () => { game: Game; events: GameEvent[] }): { game: Game; events: GameEvent[] } {
    try {
      return fn();
    } catch (err) {
      throw new AuthorityError('invalid_command', (err as Error).message);
    }
  }

  private toBroadcast(
    gameId: string,
    ev: GameEvent,
    resultingFenHash: string,
    resultingLegalMoves: LegalMoves,
    resultingReady: ReadyView,
  ): GameBroadcast | null {
    switch (ev.type) {
      case 'PlayerReady':
        return { t: 'ready', gameId, ready: { ...resultingReady }, serverTs: ev.at };
      case 'MovePlayed':
        return {
          t: 'move',
          gameId,
          ply: ev.ply,
          uci: ev.uci,
          san: ev.san,
          by: ev.by,
          fenHash: resultingFenHash,
          clock: { w: ev.remaining.w, b: ev.remaining.b },
          serverTs: ev.at,
          legalMoves: resultingLegalMoves,
        };
      case 'GameEnded':
        return {
          t: 'ended',
          gameId,
          result: ev.result,
          termination: ev.termination,
          winner: ev.winner,
          serverTs: ev.at,
        };
      default:
        return null;
    }
  }

  private viewOf(game: Game): StateView {
    const snap = game.snapshot();
    const fen = game.fen;
    return {
      gameId: snap.gameId,
      variant: snap.variant,
      players: snap.players,
      timeControl: snap.timeControl,
      fen,
      fenHash: fenHash(fen),
      ply: snap.ply,
      turn: game.turn,
      clock: { w: snap.clock.remaining.w, b: snap.clock.remaining.b },
      turnStartedAt: snap.clock.turnStartedAt,
      status: snap.status,
      drawOffer: snap.drawOffer,
      moves: snap.moves.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, by: m.by })),
      legalMoves: snap.status.over ? {} : legalMovesOf(snap.position),
      chess960StartId: snap.chess960StartId,
      ready: snap.source === null ? null : { ...snap.ready },
    };
  }

  private require(gameId: string): GameRecord {
    const rec = this.games.get(gameId);
    if (!rec) throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    return rec;
  }
}
