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
  IllegalMoveError,
  Position,
  chess960Fen,
  isFrozenDeadPosition,
  opposite,
  parseFen,
  repetitionKey,
  typeOf,
  type Color,
  type Variant,
} from '@chess-platform/core';
import {
  charge,
  flagDeadline,
  freezeClock,
  GameError,
  hasFlagged,
  initClock,
  validateTimestamp,
  type ClockState,
  type TimeControl,
} from './clock';
import { adjudicateTimeoutPossibility } from './timeout-adjudication';
import type {
  AdjudicationClockPolicy,
  AdjudicationClocksStartedEvent,
  AdjudicationEffect,
  AdjudicationResolvedEvent,
  AdjudicationStartedEvent,
  DrawDeclinedEvent,
  DrawOfferedEvent,
  GameCreatedEvent,
  GameEndedEvent,
  GameEvent,
  GameSource,
  MovePlayedEvent,
  Players,
  PlayerReadyEvent,
  ResultString,
  Termination,
} from './events';
import { FOLD_STORED } from './internal/stored-replay-key';
import {
  assertEffectsMatch,
  deepCloneEffect,
  projectSurvivingObligations,
  validateRecordedResolution,
  type AdjudicationPhase,
  type PendingAdjudicationState,
  type ResolutionContext,
} from './adjudication-lifecycle';
import {
  clonePreparedOperation,
  resolveLegalMove,
  type PreparedIntent,
  type PreparedOperation,
} from './prepared-command';
import {
  applyCompletedTurn,
  computeDisplayBalances,
  computeFlagDeadline,
  createAdjudicationClockBasis,
  getClockAccountingSnapshot,
  hasFlaggedAt,
  type AdjudicationClockBasis,
  type ClockAccountingSnapshot,
} from './adjudication-clock-accounting';
import {
  cloneStoppedClockState,
  deriveStartedBasis,
  deriveStopId,
  deriveTurnLineageId,
  isChessClockApplicable,
  validateClockPolicy,
  validateIntegerPolicyInputs,
  type GameStoppedClockState,
} from './adjudication-completion';
import {
  cloneReleasedClockState,
  cloneReleaseReceipt,
  cloneReleaseReceiptsMap,
  validateRecordedReleaseEvent,
  buildReleasedClockState,
  getActiveCausalBasis,
  type AdjudicationReleaseReceipt,
  type GameReleasedClockState,
} from './adjudication-release';

const REPLAY_TOKEN = Symbol('REPLAY_TOKEN');

export { FOLD_STORED, GameError };
export { repetitionKey } from '@chess-platform/core';

export type PregameSource = GameSource;

export interface PregameRules {
  readonly source: GameSource;
  readonly noShowAfterMs: number;
}

export const SEEK_NO_SHOW_MS = 60_000;
export const TOURNAMENT_NO_SHOW_MS = 30_000;
export const NOT_READY_MESSAGE = 'Both players must be ready before the first move';

const GAME_SOURCES: readonly unknown[] = ['seek', 'tournament'] satisfies readonly GameSource[];
const MAX_DEADLINE_MS = 8_640_000_000_000_000;

export type NoShowVerdict =
  | { readonly kind: 'expire'; readonly ending: GameEndedEvent }
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'not_due' }
  | { readonly kind: 'both_ready' };

export type GameStatus =
  | { readonly over: false }
  | {
      readonly over: true;
      readonly result: ResultString;
      readonly termination: Termination;
      readonly winner: Color | null;
    };

export type RepetitionHistory = ReadonlyMap<string, number>;

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
  readonly repetition: RepetitionHistory;
  readonly chess960StartId: number | null;
  readonly source: GameSource | null;
  readonly noShowAt: number | null;
  readonly ready: Readonly<Record<Color, boolean>>;
  readonly phase: AdjudicationPhase;
  readonly isBlocked: boolean;
  readonly adjudication: PendingAdjudicationState | null;
  readonly eventSequence: number;
  readonly lastResolutionAt: number | null;
  readonly clockPolicy: AdjudicationClockPolicy | null;
  readonly stoppedClock: GameStoppedClockState | null;
  readonly releasedClock: GameReleasedClockState | null;
  readonly releaseReceipts: ReadonlyMap<string, AdjudicationReleaseReceipt>;
  readonly releaseNeeded: boolean;
}

export type GameSnapshot = GameState;

export interface CreateGameParams {
  readonly gameId: string;
  readonly variant?: Variant;
  readonly initialFen?: string;
  readonly timeControl: TimeControl;
  readonly players: Players;
  readonly rated?: boolean;
  readonly at: number;
  readonly chess960StartId?: number;
  readonly source?: GameSource;
  readonly noShowAfterMs?: number;
}

const ONGOING: GameStatus = Object.freeze({ over: false });

function isStartId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < CHESS960_POSITIONS;
}

function resolveChess960StartId(
  variant: Variant,
  startId: number | undefined,
  initialFen: string | undefined,
): number | null {
  if (variant === 'chess960') {
    if (!isStartId(startId)) {
      throw new GameError(
        `chess960 games need a starting-position id in 0..${CHESS960_POSITIONS - 1}; got ` +
          `${startId === undefined ? 'none' : JSON.stringify(startId)}. The server draws it at ` +
          'creation and records it on the GameCreated event. See ADR-0137.',
      );
    }
    if (initialFen !== undefined) {
      throw new GameError(
        'chess960 games are started by starting-position id, not by initialFen: the id already ' +
          'determines the position, and accepting both would let them disagree.',
      );
    }
    return startId;
  }
  if (startId !== undefined) {
    throw new GameError(
      `a starting-position id is meaningless for '${variant}' and was refused rather than stored; ` +
        'only chess960 games have one.',
    );
  }
  return null;
}

function checkInitialDeadEnding(initialPos: Position, at: number): GameEndedEvent | null {
  if (!isFrozenDeadPosition(initialPos.snapshot())) return null;
  const initialStatus = initialPos.status();
  if (initialStatus.over && initialStatus.reason === 'dead_position') {
    return { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null, at };
  }
  return null;
}

function deepClonePendingState(pending: PendingAdjudicationState): PendingAdjudicationState {
  return Object.freeze({
    operationId: pending.operationId,
    baseRevision: pending.baseRevision,
    startedSeq: pending.startedSeq,
    acceptedAt: pending.acceptedAt,
    rulesVersion: pending.rulesVersion,
    thinkingElapsedAtA: pending.thinkingElapsedAtA,
    originalNoShowAt: pending.originalNoShowAt,
    remainingNoShowTimeAtA: pending.remainingNoShowTimeAtA,
    ...(pending.resolutionAt !== undefined ? { resolutionAt: pending.resolutionAt } : {}),
    cursor: pending.cursor,
    prepared: clonePreparedOperation(pending.prepared),
    originalClock: Object.freeze({
      ...pending.originalClock,
      remaining: Object.freeze({ ...pending.originalClock.remaining }),
    }),
    expectedEffects: Object.freeze(pending.expectedEffects.map(e => deepCloneEffect(e))),
    ...(pending.clockPolicy !== undefined ? { clockPolicy: pending.clockPolicy } : {}),
    ...(pending.originalBasis !== undefined ? { originalBasis: pending.originalBasis } : {}),
  });
}

function checkNoShowApplicable(s: GameState, isBlocked: boolean, at: number): boolean {
  if (s.source === null || s.noShowAt === null) return false;
  if (s.status.over || s.ply > 0) return false;
  return !isBlocked && at >= s.noShowAt;
}

function resolveTournamentNoShowEnding(ready: { w: boolean; b: boolean }, at: number): NoShowVerdict {
  if (ready.w && ready.b) return { kind: 'both_ready' };
  if (ready.w) return { kind: 'expire', ending: { type: 'GameEnded', result: '1-0', termination: 'no_show', winner: 'w', at } };
  if (ready.b) return { kind: 'expire', ending: { type: 'GameEnded', result: '0-1', termination: 'no_show', winner: 'b', at } };
  return { kind: 'expire', ending: { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at } };
}

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

const throwFrozenMap = (): never => {
  throw new TypeError('Cannot mutate frozen Map');
};

function freezeMap<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const copy = new Map(map);
  copy.set = throwFrozenMap;
  copy.delete = throwFrozenMap;
  copy.clear = throwFrozenMap;
  return Object.freeze(copy);
}

function cloneTimeControl(tc: TimeControl): TimeControl {
  return Object.freeze({
    initialMs: tc.initialMs,
    incrementMs: tc.incrementMs,
    delayMs: tc.delayMs,
    kind: tc.kind,
  });
}

function clonePlayers(players: Players): Players {
  return Object.freeze({
    white: players.white,
    black: players.black,
  });
}

function cloneMovePlayedEvent(event: MovePlayedEvent): MovePlayedEvent {
  return Object.freeze({
    type: 'MovePlayed',
    ply: event.ply,
    uci: event.uci,
    san: event.san,
    by: event.by,
    moveTimeMs: event.moveTimeMs,
    remaining: Object.freeze({ ...event.remaining }),
    at: event.at,
  });
}

function isolateState(state: GameState): GameState {
  return Object.freeze({
    ...state,
    timeControl: cloneTimeControl(state.timeControl),
    players: clonePlayers(state.players),
    status: Object.freeze({ ...state.status }),
    ready: Object.freeze({ ...state.ready }),
    clock: Object.freeze({
      ...state.clock,
      remaining: Object.freeze({ ...state.clock.remaining }),
    }),
    moves: Object.freeze(state.moves.map(cloneMovePlayedEvent)),
    repetition: new Map(state.repetition),
    adjudication: state.adjudication ? deepClonePendingState(state.adjudication) : null,
    stoppedClock: cloneStoppedClockState(state.stoppedClock),
    releasedClock: cloneReleasedClockState(state.releasedClock),
    releaseReceipts: cloneReleaseReceiptsMap(state.releaseReceipts),
    clockPolicy: state.clockPolicy,
    releaseNeeded: state.releaseNeeded,
  });
}

function isolateSnapshot(state: GameState): GameState {
  return Object.freeze({
    ...state,
    timeControl: cloneTimeControl(state.timeControl),
    players: clonePlayers(state.players),
    status: Object.freeze({ ...state.status }),
    ready: Object.freeze({ ...state.ready }),
    clock: Object.freeze({
      ...state.clock,
      remaining: Object.freeze({ ...state.clock.remaining }),
    }),
    moves: Object.freeze(state.moves.map(cloneMovePlayedEvent)),
    repetition: freezeMap(new Map(state.repetition)),
    adjudication: state.adjudication ? deepClonePendingState(state.adjudication) : null,
    stoppedClock: cloneStoppedClockState(state.stoppedClock),
    releasedClock: cloneReleasedClockState(state.releasedClock),
    releaseReceipts: freezeMap(cloneReleaseReceiptsMap(state.releaseReceipts)),
    clockPolicy: state.clockPolicy,
    releaseNeeded: state.releaseNeeded,
  });
}

function isNoShowSuppressedInPhase(s: GameState): boolean {
  return s.phase === 'proving' || s.phase === 'settling' || s.phase === 'ended' || s.status.over;
}

function resolveManagedNoShowDeadline(s: GameState): number | null {
  if (s.stoppedClock !== null || isNoShowSuppressedInPhase(s)) {
    return null;
  }
  const rc = s.releasedClock;
  if (rc === null) return s.noShowAt;
  if (rc.noShowRunningSince === null || rc.basis.noShowRemainderMs === null) {
    return null;
  }
  return rc.noShowRunningSince + rc.basis.noShowRemainderMs;
}

function resolveLegacyNoShowDeadline(s: GameState): number | null {
  if (s.phase === 'proving' || s.phase === 'settling' || s.stoppedClock !== null) {
    return null;
  }
  return s.noShowAt;
}

function getStoppedAccountingSnapshot(
  stopped: GameStoppedClockState,
  timeControl: TimeControl,
  createdAt: number,
  at?: number,
): ClockAccountingSnapshot {
  const basis = stopped.basis;
  const now = at ?? basis.stoppedAt ?? createdAt;
  return getClockAccountingSnapshot(basis, now, timeControl);
}

function getReleasedAccountingSnapshot(
  rel: GameReleasedClockState,
  timeControl: TimeControl,
  at?: number,
): ClockAccountingSnapshot {
  const now = at ?? rel.releasedAt;
  const snap = getClockAccountingSnapshot(rel.basis, now, timeControl);
  if (rel.isChessApplicable) {
    return snap;
  }
  const noShowDl = rel.noShowRunningSince !== null && rel.basis.noShowRemainderMs !== null
    ? rel.noShowRunningSince + rel.basis.noShowRemainderMs
    : null;
  return Object.freeze({
    ...snap,
    flagDeadline: null,
    flagged: false,
    noShowDeadline: noShowDl,
    isRunning: rel.noShowRunningSince !== null,
  });
}

export class Game {
  private readonly state: GameState;

  private constructor(state: GameState) {
    this.state = isolateState(state);
  }

  static create(params: CreateGameParams): { game: Game; event: GameCreatedEvent; events: GameEvent[] } {
    const at = params.at;
    const variant = params.variant ?? 'standard';
    const chess960StartId = resolveChess960StartId(variant, params.chess960StartId, params.initialFen);
    const pregame = pregameOf(params.source, params.noShowAfterMs, at);
    const initialFen =
      chess960StartId !== null ? chess960Fen(chess960StartId) : params.initialFen ?? Position.initial(variant).fen();
    const tc = cloneTimeControl(params.timeControl);
    const players = clonePlayers(params.players);
    const event: GameCreatedEvent = {
      type: 'GameCreated',
      gameId: params.gameId,
      variant,
      initialFen,
      timeControl: tc,
      players,
      rated: params.rated ?? false,
      at,
      ...(chess960StartId !== null ? { chess960StartId } : {}),
      ...(pregame !== null ? pregame : {}),
    };

    const initialPos = Position.fromFen(initialFen, variant);
    const events: GameEvent[] = [event];
    const deadEnding = checkInitialDeadEnding(initialPos, at);
    if (deadEnding) events.push(deadEnding);

    return { game: Game.fromEvents(events), event, events };
  }

  static fromEvents(events: readonly GameEvent[]): Game {
    if (events.length === 0) {
      throw new GameError('Cannot reconstruct a game from zero events');
    }
    let state: GameState | null = null;
    for (const event of events) {
      state = Game.reduce(state, event, REPLAY_TOKEN);
    }
    return new Game(state as GameState);
  }

  static applyAll(initial: Game, events: readonly GameEvent[]): Game {
    let state: GameState = initial.state;
    for (const event of events) {
      state = Game.reduce(state, event);
    }
    return new Game(state);
  }

  withEvent(event: GameEvent): Game {
    return new Game(Game.reduce(this.state, event));
  }

  withEvents(events: readonly GameEvent[]): Game {
    return Game.applyAll(this, events);
  }

  /**
   * The authoritative release of the current managed stop at instant `at` (Issue #124): the
   * `AdjudicationClocksStarted` event and the game after it. The event is derived only from the
   * stop this game records and is folded through the same reducer replay uses, so a live release
   * and its replay can never disagree; any precondition replay would refuse is refused here.
   */
  prepareClockRelease(params: { readonly releaseRequestId: string; readonly at: number }): {
    readonly game: Game;
    readonly event: AdjudicationClocksStartedEvent;
  } {
    const stopped = this.state.stoppedClock;
    if (!stopped || this.state.status.over || this.state.phase === 'proving') {
      throw new GameError('No managed stop to release');
    }
    if (typeof params.releaseRequestId !== 'string' || params.releaseRequestId.length === 0) {
      throw new GameError('releaseRequestId must be a non-empty string');
    }
    const event: AdjudicationClocksStartedEvent = Object.freeze({
      type: 'AdjudicationClocksStarted',
      gameId: this.state.gameId,
      clockPolicy: 'observed-release-v1',
      rulesVersion: stopped.rulesVersion,
      releaseRequestId: params.releaseRequestId,
      stopId: stopped.stopId,
      originatingOperationId: stopped.originatingOperationId,
      originatingResolvedSeq: stopped.originatingResolvedSeq,
      completionHead: stopped.completionHead,
      expectedHead: this.state.eventSequence,
      turnLineageId: stopped.turnLineageId,
      side: this.state.position.turn,
      ply: this.state.ply,
      at: params.at,
    });
    return { event, game: new Game(Game.reduce(this.state, event, REPLAY_TOKEN)) };
  }

  get id(): string { return this.state.gameId; }
  get variant(): Variant { return this.state.variant; }
  get players(): Players { return this.state.players; }
  get timeControl(): TimeControl { return this.state.timeControl; }
  get rated(): boolean { return this.state.rated; }
  get createdAt(): number { return this.state.createdAt; }
  get position(): Position { return this.state.position; }
  get turn(): Color { return this.state.position.turn; }
  get clock(): ClockState { return this.state.clock; }
  get ply(): number { return this.state.ply; }
  get moves(): readonly MovePlayedEvent[] { return this.state.moves; }
  get status(): GameStatus { return this.state.status; }
  get drawOffer(): Color | null { return this.state.drawOffer; }
  get chess960StartId(): number | null { return this.state.chess960StartId; }
  get pregameSource(): GameSource | null { return this.state.source; }
  get noShowDeadline(): number | null {
    const s = this.state;
    if (s.clockPolicy === 'observed-release-v1') {
      return resolveManagedNoShowDeadline(s);
    }
    return resolveLegacyNoShowDeadline(s);
  }
  get phase(): AdjudicationPhase { return this.state.phase; }
  get isBlocked(): boolean { return this.state.phase === 'proving' || this.state.phase === 'settling'; }

  get clockPolicy(): AdjudicationClockPolicy | null { return this.state.clockPolicy; }
  get stoppedClock(): GameStoppedClockState | null { return cloneStoppedClockState(this.state.stoppedClock); }
  get releasedClock(): GameReleasedClockState | null { return cloneReleasedClockState(this.state.releasedClock); }
  get releaseNeeded(): boolean { return this.state.releaseNeeded; }

  get releaseReceipts(): readonly AdjudicationReleaseReceipt[] {
    return Object.freeze(Array.from(this.state.releaseReceipts.values()).map(r => cloneReleaseReceipt(r)));
  }

  getReleaseReceipt(requestId: string): AdjudicationReleaseReceipt | null {
    const r = this.state.releaseReceipts.get(requestId);
    return r ? cloneReleaseReceipt(r) : null;
  }

  isStopConsumed(stopId: string): boolean {
    for (const r of this.state.releaseReceipts.values()) {
      if (r.stopId === stopId) return true;
    }
    return false;
  }

  clockAccountingSnapshot(at?: number): ClockAccountingSnapshot | null {
    const s = this.state;
    if (s.stoppedClock !== null) {
      return getStoppedAccountingSnapshot(s.stoppedClock, s.timeControl, s.createdAt, at);
    }
    if (s.releasedClock !== null) {
      return getReleasedAccountingSnapshot(s.releasedClock, s.timeControl, at);
    }
    return null;
  }

  get fen(): string {
    return this.state.position.fen();
  }

  get flagDeadline(): number | null {
    const s = this.state;
    if (s.status.over || s.stoppedClock !== null) return null;
    if (s.releasedClock !== null) {
      if (!s.releasedClock.isChessApplicable) return null;
      return computeFlagDeadline(s.releasedClock.basis, s.timeControl);
    }
    if (s.ply === 0) return null;
    return flagDeadline(s.clock, s.position.turn, s.timeControl);
  }

  timeoutDue(at: number): boolean {
    const s = this.state;
    if (s.status.over) return false;
    if (s.stoppedClock !== null) {
      if (!isChessClockApplicable(s.source, s.ply, s.timeControl)) return false;
      return hasFlaggedAt(s.stoppedClock.basis, at, s.timeControl);
    }
    if (s.releasedClock !== null) {
      if (!s.releasedClock.isChessApplicable) return false;
      return hasFlaggedAt(s.releasedClock.basis, at, s.timeControl);
    }
    if (s.ply === 0) return false;
    return hasFlagged(s.clock, s.position.turn, at, s.timeControl);
  }

  get adjudication(): PendingAdjudicationState | null {
    return this.state.adjudication ? deepClonePendingState(this.state.adjudication) : null;
  }

  get eventSequence(): number {
    return this.state.eventSequence;
  }

  isReady(color: Color): boolean {
    return this.state.ready[color];
  }

  get awaitingReadiness(): boolean {
    if (this.state.source === null || this.state.ply > 0 || this.state.status.over) return false;
    return !this.state.ready.w || !this.state.ready.b;
  }

  snapshot(): GameState {
    return isolateSnapshot(this.state);
  }

  resolveMovePublic(uci: string): ReturnType<Position['legalMoves']>[number] {
    return resolveLegalMove(this.state.position, uci);
  }

  assertNotBlocked(): void {
    if (this.isBlocked) {
      throw new GameError('Cannot execute command: game is currently blocked under adjudication');
    }
  }

  private assertOngoing(): void {
    if (this.state.status.over) {
      throw new GameError('Game is already over');
    }
  }

  playMove(uci: string, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    const verdict = this.noShowVerdict(at);
    if (verdict.kind === 'expire') {
      return this.expireNoShow(at);
    }
    if (this.awaitingReadiness) {
      throw new GameError(NOT_READY_MESSAGE);
    }

    const sideToMove = this.state.position.turn;
    const charged = charge(this.state.clock, sideToMove, at, this.state.timeControl);
    if (charged.flagged) {
      return this.endByTimeout(sideToMove, at);
    }

    const move = this.resolveMovePublic(uci);
    const san = this.state.position.toSan(move);
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;

    const nextPos = this.state.position.play(move);
    const moveEvent: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: this.state.ply + 1,
      uci,
      san,
      by: sideToMove,
      moveTimeMs: charged.moveTimeMs,
      remaining: charged.clock.remaining,
      at,
    };

    const events: GameEvent[] = [moveEvent];
    const posStatus = nextPos.status();
    if (posStatus.over) {
      events.push(this.terminalEventFor(posStatus, at));
    } else {
      const repKey = repetitionKey(nextPos.snapshot());
      const seen = (this.state.repetition.get(repKey) ?? 0) + 1;
      if (seen >= 3) {
        events.push({ type: 'GameEnded', result: '1/2-1/2', termination: 'threefold', winner: null, at });
      }
    }
    return { game: Game.applyAll(this, events), events };
  }

  move(uci: string, at: number): { game: Game; events: GameEvent[] } {
    return this.playMove(uci, at);
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
      case 'dead_position':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'dead_position', winner: null, at };
    }
  }

  private deadPositionEnding(at: number): { game: Game; events: GameEvent[] } | null {
    if (!isFrozenDeadPosition(this.state.position.snapshot())) return null;
    const status = this.state.position.status();
    if (status.over && status.reason === 'dead_position') {
      const events: GameEvent[] = [this.terminalEventFor(status, at)];
      return { game: Game.applyAll(this, events), events };
    }
    return null;
  }

  resign(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const ending: GameEndedEvent = {
      type: 'GameEnded',
      result: color === 'w' ? '0-1' : '1-0',
      termination: 'resignation',
      winner: opposite(color),
      at,
    };
    return { game: this.withEvent(ending), events: [ending] };
  }

  offerDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    if (this.state.drawOffer === color) throw new GameError('Draw already offered by this side');
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const event: DrawOfferedEvent = { type: 'DrawOffered', by: color, at };
    return { game: this.withEvent(event), events: [event] };
  }

  acceptDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    const offer = this.state.drawOffer;
    if (offer === null || offer === color) {
      throw new GameError('No draw offer from the opponent to accept');
    }
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const ending: GameEndedEvent = { type: 'GameEnded', result: '1/2-1/2', termination: 'agreement', winner: null, at };
    return { game: this.withEvent(ending), events: [ending] };
  }

  declineDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    if (this.state.drawOffer === null) throw new GameError('No draw offer to decline');
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const event: DrawDeclinedEvent = { type: 'DrawDeclined', by: color, at };
    return { game: this.withEvent(event), events: [event] };
  }

  claimFlag(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    const sideToMove = this.state.position.turn;
    if (!hasFlagged(this.state.clock, sideToMove, at, this.state.timeControl)) {
      throw new GameError('Opponent has not flagged');
    }
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    return this.endByTimeout(sideToMove, at);
  }

  claimTimeout(at: number): { game: Game; events: GameEvent[] } {
    return this.claimFlag(at);
  }

  private endByTimeout(flagged: Color, at: number): { game: Game; events: GameEvent[] } {
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const winner = opposite(flagged);
    const drawByInsufficient = !canMate(this.state.position.fen(), winner, this.state.variant);
    const ending: GameEndedEvent = {
      type: 'GameEnded',
      result: drawByInsufficient ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1',
      termination: drawByInsufficient ? 'insufficient_material' : 'timeout',
      winner: drawByInsufficient ? null : winner,
      at,
    };
    return { game: this.withEvent(ending), events: [ending] };
  }

  abort(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    if (this.state.ply >= 2) throw new GameError('Game can no longer be aborted');
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const events: GameEvent[] = [{ type: 'GameEnded', result: '*', termination: 'aborted', winner: null, at }];
    return { game: this.withEvent(events[0]), events };
  }

  markReady(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertNotBlocked();
    if (this.state.clockPolicy === 'observed-release-v1') {
      throw new GameError('Cannot execute raw command on managed game; use prepared command flow');
    }
    const s = this.state;
    if (s.noShowAt === null || at >= s.noShowAt) return { game: this, events: [] };
    if (s.status.over || s.ply > 0 || s.ready[color]) return { game: this, events: [] };
    const events: GameEvent[] = [{ type: 'PlayerReady', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  noShowVerdict(at: number): NoShowVerdict {
    return checkStateNoShowVerdict(this.state, at, this.isBlocked);
  }

  expireNoShow(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    this.assertNotBlocked();
    const verdict = this.noShowVerdict(at);
    if (verdict.kind !== 'expire') throw new GameError(`No-show expiry refused: ${verdict.kind}`);
    const dead = this.deadPositionEnding(at);
    if (dead) return dead;
    const events: GameEvent[] = [verdict.ending];
    return { game: this.withEvent(verdict.ending), events };
  }

  static startIdOf(event: GameCreatedEvent): number | null {
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

  private static computeMoveClock(state: GameState, event: MovePlayedEvent): ClockState {
    if (state.adjudication?.clockPolicy === 'observed-release-v1') {
      if (!state.adjudication.originalBasis) {
        throw new GameError('Missing originalBasis for observed-release-v1 move fold');
      }
      const turnComp = applyCompletedTurn(
        state.adjudication.originalBasis,
        event.at,
        state.timeControl,
        {
          clearNoShow: true,
          nextLineage: { policy: 'observed-release-v1' },
        },
      );
      if (turnComp.flagged) {
        throw new GameError(`Cannot play move: clock expired for ${state.position.turn}`);
      }
      if (
        event.moveTimeMs !== turnComp.moveTimeMs ||
        event.remaining.w !== turnComp.nextBasis.turnBaseBalances.w ||
        event.remaining.b !== turnComp.nextBasis.turnBaseBalances.b
      ) {
        throw new GameError('MovePlayed payload does not match deterministic managed turn accounting');
      }
      return Object.freeze({
        remaining: Object.freeze({ ...turnComp.nextBasis.turnBaseBalances }),
        turnStartedAt: null,
      });
    }
    const clockToCharge = state.adjudication ? state.adjudication.originalClock : state.clock;
    const charged = charge(clockToCharge, event.by, event.at, state.timeControl, event.moveTimeMs);
    return charged.clock;
  }

  private static foldMove(state: GameState, event: MovePlayedEvent, position: Position): GameState {
    const moveClock = Game.computeMoveClock(state, event);
    const key = repetitionKey(position.snapshot());
    const rep = new Map(state.repetition);
    rep.set(key, (rep.get(key) ?? 0) + 1);

    const intermediate: GameState = {
      ...state,
      position,
      clock: moveClock,
      ply: event.ply,
      moves: [...state.moves, cloneMovePlayedEvent(event)],
      drawOffer: null,
      repetition: rep,
      eventSequence: state.eventSequence + 1,
    };

    if (state.phase === 'settling' && state.adjudication) {
      const adjudication = state.adjudication;
      if (adjudication.cursor + 1 === adjudication.expectedEffects.length) {
        const resAt = adjudication.resolutionAt ?? adjudication.acceptedAt;
        return finalizeCompletion(intermediate, adjudication, resAt, adjudication.expectedEffects);
      }
      return {
        ...intermediate,
        phase: 'settling',
        isBlocked: true,
        clock: { ...moveClock, turnStartedAt: null },
        adjudication: Object.freeze({ ...adjudication, cursor: adjudication.cursor + 1 }),
      };
    }

    return intermediate;
  }

  static [FOLD_STORED](
    events: readonly GameEvent[],
    admit: (index: number, state: GameState, event: MovePlayedEvent) => Position | null,
    onPly: (state: GameState, event: MovePlayedEvent, after: Position, admitted: boolean) => void,
  ): Game {
    let state: GameState | null = null;
    for (const [index, event] of events.entries()) {
      if (state !== null && state.status.over) {
        throw new GameError(`${event.type} after GameEnded`);
      }
      if (event.type !== 'MovePlayed' || state === null) {
        state = Game.reduce(state, event, REPLAY_TOKEN);
        continue;
      }
      assertStoredMoveAllowed(state, event);
      const safeEvent: MovePlayedEvent = Object.freeze({
        ...event,
        remaining: Object.freeze({ ...event.remaining }),
      });
      const { after, admitted } = resolveStoredMovePosition(index, state, safeEvent, admit);
      onPly(isolateSnapshot(state), safeEvent, after, admitted);
      state = Game.foldMove(state, safeEvent, after);
    }
    if (state === null) throw new GameError('Cannot reconstruct a game from zero events');
    return new Game(state);
  }

  private static advanceSettlingNonMove(state: GameState): GameState {
    if (state.phase !== 'settling' || !state.adjudication) {
      return state;
    }
    const nextCursor = state.adjudication.cursor + 1;
    if (nextCursor === state.adjudication.expectedEffects.length) {
      const resAt = state.adjudication.resolutionAt ?? state.adjudication.acceptedAt;
      return finalizeCompletion(state, state.adjudication, resAt, state.adjudication.expectedEffects);
    }
    return {
      ...state,
      phase: 'settling',
      isBlocked: true,
      adjudication: Object.freeze({ ...state.adjudication, cursor: nextCursor }),
    };
  }

  private static reduce(state: GameState | null, event: GameEvent, replayToken?: symbol): GameState {
    assertLifecyclePreconditions(state, event);

    switch (event.type) {
      case 'GameCreated':
        return reduceGameCreated(state, event);
      case 'PlayerReady':
        return reducePlayerReady(state as GameState, event);
      case 'MovePlayed':
        return reduceMovePlayed(state as GameState, event);
      case 'DrawOffered':
        return reduceDrawOffered(state as GameState, event);
      case 'DrawDeclined':
        return reduceDrawDeclined(state as GameState, event);
      case 'GameEnded':
        return reduceGameEnded(state as GameState, event);
      default:
        return reduceAdjudicationEvent(state as GameState, event, replayToken);
    }
  }
}

function reduceAdjudicationEvent(
  state: GameState,
  event: GameEvent,
  replayToken?: symbol,
): GameState {
  if (event.type === 'AdjudicationStarted') {
    return reduceAdjudicationStarted(state, event);
  }
  if (event.type === 'AdjudicationResolved') {
    return reduceAdjudicationResolved(state, event);
  }
  if (event.type === 'AdjudicationClocksStarted') {
    if (replayToken !== REPLAY_TOKEN) {
      throw new GameError('AdjudicationClocksStarted cannot be submitted directly via live Game.withEvents; replay/reconstruction route required');
    }
    return reduceAdjudicationClocksStarted(state, event);
  }
  throw new GameError(`Unknown event type ${JSON.stringify((event as { type: unknown }).type)}`);
}

function finalizeLegacyCompletion(
  state: GameState,
  adjudication: PendingAdjudicationState,
  resolutionAt: number,
  effects: readonly AdjudicationEffect[],
): GameState {
  if (state.status.over) {
    return {
      ...state,
      phase: 'ended',
      isBlocked: false,
      adjudication: null,
      clock: { ...state.clock, turnStartedAt: null },
    };
  }
  const moveEffect = effects.find(e => e.type === 'MovePlayed');
  if (moveEffect) {
    return {
      ...state,
      phase: 'idle',
      isBlocked: false,
      adjudication: null,
    };
  }
  const resumed = projectSurvivingObligations(
    adjudication,
    effects,
    resolutionAt,
    {
      source: state.source,
      ply: state.ply,
      ready: state.ready,
      timeControl: state.timeControl,
      sideToMove: state.position.turn,
      historicalNoShowAt: state.noShowAt,
    },
  );
  return {
    ...state,
    phase: 'idle',
    isBlocked: false,
    adjudication: null,
    clock: resumed.resumedClock,
    noShowAt: resumed.resumedNoShowAt,
  };
}

function finalizeManagedTerminal(
  state: GameState,
  _adjudication: PendingAdjudicationState,
): GameState {
  return {
    ...state,
    phase: 'ended',
    isBlocked: false,
    adjudication: null,
    clock: { ...state.clock, turnStartedAt: null },
    noShowAt: null,
    stoppedClock: null,
    releasedClock: null,
    releaseReceipts: state.releaseReceipts,
    releaseNeeded: false,
  };
}

function deriveNextManagedBasis(
  state: GameState,
  adjudication: PendingAdjudicationState,
  resolutionAt: number,
  moveEffect?: MovePlayedEvent,
): AdjudicationClockBasis {
  if (moveEffect) {
    if (!adjudication.originalBasis) {
      throw new GameError('Missing originalBasis for observed-release-v1 move completion');
    }
    const turnComp = applyCompletedTurn(
      adjudication.originalBasis,
      resolutionAt,
      state.timeControl,
      {
        clearNoShow: true,
        nextLineage: { policy: 'observed-release-v1' },
      },
    );
    return turnComp.nextBasis;
  }

  const currentBasis = adjudication.originalBasis;
  if (!currentBasis) {
    throw new GameError('Missing originalBasis for observed-release-v1 non-move completion');
  }
  const isTournamentBothReady = state.source === 'tournament' && state.ready.w && state.ready.b;
  const nextNoShow = (isTournamentBothReady || state.ply > 0)
    ? null
    : currentBasis.noShowRemainderMs;

  return createAdjudicationClockBasis({
    initialBalances: currentBasis.turnBaseBalances,
    elapsedThinkingMs: currentBasis.elapsedThinkingMs,
    sideToMove: currentBasis.sideToMove,
    ply: currentBasis.ply,
    runningSince: null,
    stoppedAt: resolutionAt,
    policy: 'observed-release-v1',
    noShowRemainderMs: nextNoShow,
  });
}

function finalizeManagedCompletion(
  state: GameState,
  adjudication: PendingAdjudicationState,
  resolutionAt: number,
  effects: readonly AdjudicationEffect[],
): GameState {
  const moveEffect = effects.find(e => e.type === 'MovePlayed') as MovePlayedEvent | undefined;
  const nextBasis = deriveNextManagedBasis(state, adjudication, resolutionAt, moveEffect);
  const isNewTurn = moveEffect !== undefined;
  const resolvedSeq = adjudication.startedSeq + 1;
  const stopId = deriveStopId(adjudication.operationId, resolvedSeq);
  const turnLineageId = deriveTurnLineageId(
    adjudication.prepared.gameId,
    state.ply,
    adjudication.prepared.turnLineageId,
    isNewTurn,
  );
  const completionHead = resolvedSeq + effects.length;

  const stoppedClock: GameStoppedClockState = Object.freeze({
    basis: nextBasis,
    stopId,
    originatingOperationId: adjudication.operationId,
    originatingResolvedSeq: resolvedSeq,
    startedSeq: adjudication.startedSeq,
    rulesVersion: adjudication.rulesVersion,
    turnLineageId,
    parentStopId: adjudication.prepared.parentStopId ?? null,
    completionHead,
  });

  const dispBalances = computeDisplayBalances(nextBasis, resolutionAt, state.timeControl);
  const exposedClock: ClockState = Object.freeze({
    remaining: dispBalances,
    turnStartedAt: null,
  });

  const releaseNeeded = isChessClockApplicable(state.source, state.ply, state.timeControl) || nextBasis.noShowRemainderMs !== null;

  return {
    ...state,
    phase: 'idle',
    isBlocked: false,
    adjudication: null,
    clock: exposedClock,
    clockPolicy: 'observed-release-v1',
    stoppedClock,
    releasedClock: null,
    releaseReceipts: state.releaseReceipts,
    releaseNeeded,
  };
}

function finalizeCompletion(
  state: GameState,
  adjudication: PendingAdjudicationState,
  resolutionAt: number,
  effects: readonly AdjudicationEffect[],
): GameState {
  if (adjudication.clockPolicy !== 'observed-release-v1') {
    return finalizeLegacyCompletion(state, adjudication, resolutionAt, effects);
  }
  if (state.status.over) {
    return finalizeManagedTerminal(state, adjudication);
  }
  return finalizeManagedCompletion(state, adjudication, resolutionAt, effects);
}

function assertStoredMoveAllowed(state: GameState, event: MovePlayedEvent): void {
  if (state.phase === 'proving') {
    throw new GameError('MovePlayed forbidden while adjudication is pending');
  }
  if (state.phase === 'settling') {
    const adjudication = state.adjudication;
    if (!adjudication) throw new GameError('Missing adjudication state while settling');
    const expected = adjudication.expectedEffects[adjudication.cursor];
    if (!expected) throw new GameError(`No declared effect expected at cursor ${adjudication.cursor}`);
    assertEffectsMatch(event, expected, adjudication.cursor);
  }
  if (state.phase === 'idle' && state.clockPolicy === 'observed-release-v1') {
    throw new GameError('Raw MovePlayed cannot bypass managed adjudication route when clock policy is observed-release-v1');
  }
}

function resolveStoredMovePosition(
  index: number,
  state: GameState,
  event: MovePlayedEvent,
  admit: (index: number, state: GameState, event: MovePlayedEvent) => Position | null,
): { after: Position; admitted: boolean } {
  try {
    return { after: state.position.play(event.uci), admitted: false };
  } catch (err) {
    const fallback = err instanceof IllegalMoveError ? admit(index, state, event) : null;
    if (fallback === null) throw err;
    return { after: fallback, admitted: true };
  }
}

function assertIdlePhasePreconditions(state: GameState, event: GameEvent): void {
  if (event.type === 'AdjudicationResolved') {
    throw new GameError('AdjudicationResolved without matching AdjudicationStarted');
  }
  if (
    state.clockPolicy === 'observed-release-v1' &&
    event.type !== 'AdjudicationStarted' &&
    event.type !== 'AdjudicationClocksStarted'
  ) {
    throw new GameError(`Raw ${event.type} cannot bypass managed adjudication route when clock policy is observed-release-v1`);
  }
}

function assertLifecyclePreconditions(state: GameState | null, event: GameEvent): void {
  if (state === null) return;
  if (state.status.over) {
    throw new GameError(`${event.type} after GameEnded`);
  }
  if (state.phase === 'proving' && event.type !== 'AdjudicationResolved') {
    throw new GameError(`${event.type} forbidden while adjudication is pending`);
  }
  if (state.phase === 'settling') {
    assertSettlingEventAllowed(state, event);
  }
  if (state.phase === 'idle') {
    assertIdlePhasePreconditions(state, event);
  }
}

function assertSettlingEventAllowed(state: GameState, event: GameEvent): void {
  if (
    event.type === 'AdjudicationStarted' ||
    event.type === 'AdjudicationResolved' ||
    event.type === 'AdjudicationClocksStarted'
  ) {
    throw new GameError(`${event.type} forbidden while settling adjudication effects`);
  }
  const adjudication = state.adjudication;
  if (!adjudication) throw new GameError('Missing adjudication state while settling');
  const expected = adjudication.expectedEffects[adjudication.cursor];
  if (!expected) {
    throw new GameError(`No declared effect expected at cursor ${adjudication.cursor}`);
  }
  assertEffectsMatch(event, expected, adjudication.cursor);
}

function reduceGameCreated(state: GameState | null, event: GameCreatedEvent): GameState {
  if (state !== null) throw new GameError('GameCreated after GameCreated');
  const startId = Game.startIdOf(event);
  const pregame = pregameOf(event.source, event.noShowAfterMs, event.at);
  const source = pregame?.source ?? null;
  const position = Position.fromFen(event.initialFen, event.variant);
  const rep = new Map<string, number>();
  rep.set(repetitionKey(position.snapshot()), 1);
  const tc = cloneTimeControl(event.timeControl);
  return {
    gameId: event.gameId,
    variant: event.variant,
    players: clonePlayers(event.players),
    timeControl: tc,
    rated: event.rated,
    createdAt: event.at,
    position,
    clock: initClock(tc, source === null ? event.at : null),
    ply: 0,
    moves: [],
    status: ONGOING,
    drawOffer: null,
    repetition: rep,
    chess960StartId: startId,
    source,
    noShowAt: pregame === null ? null : event.at + pregame.noShowAfterMs,
    ready: { w: false, b: false },
    phase: 'idle',
    isBlocked: false,
    adjudication: null,
    eventSequence: 0,
    lastResolutionAt: null,
    clockPolicy: null,
    stoppedClock: null,
    releasedClock: null,
    releaseReceipts: Object.freeze(new Map()),
    releaseNeeded: false,
  };
}

function reducePlayerReady(state: GameState, event: PlayerReadyEvent): GameState {
  if (event.by !== 'w' && event.by !== 'b') {
    throw new GameError(`PlayerReady for unknown seat ${JSON.stringify(event.by)}`);
  }
  const intermediate: GameState = {
    ...state,
    ready: { ...state.ready, [event.by]: true },
    eventSequence: state.eventSequence + 1,
  };
  return Game['advanceSettlingNonMove'](intermediate);
}

function reduceMovePlayed(state: GameState, event: MovePlayedEvent): GameState {
  return Game['foldMove'](state, event, state.position.play(event.uci));
}

function reduceDrawOffered(state: GameState, event: DrawOfferedEvent): GameState {
  const intermediate: GameState = {
    ...state,
    drawOffer: event.by,
    eventSequence: state.eventSequence + 1,
  };
  return Game['advanceSettlingNonMove'](intermediate);
}

function reduceDrawDeclined(state: GameState, _event: DrawDeclinedEvent): GameState {
  const intermediate: GameState = {
    ...state,
    drawOffer: null,
    eventSequence: state.eventSequence + 1,
  };
  return Game['advanceSettlingNonMove'](intermediate);
}

function reduceGameEnded(state: GameState, event: GameEndedEvent): GameState {
  if (state.phase === 'settling') {
    const adjudication = state.adjudication;
    if (adjudication && adjudication.cursor + 1 < adjudication.expectedEffects.length) {
      throw new GameError('Premature GameEnded effect: declared effects plan has unconsumed suffix');
    }
  }
  const intermediate: GameState = {
    ...state,
    status: { over: true, result: event.result, termination: event.termination, winner: event.winner },
    drawOffer: null,
    phase: 'ended',
    isBlocked: false,
    clock: { ...state.clock, turnStartedAt: null },
    eventSequence: state.eventSequence + 1,
  };
  if (state.adjudication) {
    const resAt = state.adjudication.resolutionAt ?? state.adjudication.acceptedAt;
    return finalizeCompletion(intermediate, state.adjudication, resAt, state.adjudication.expectedEffects);
  }
  return intermediate;
}

function reduceAdjudicationClocksStarted(state: GameState, event: AdjudicationClocksStartedEvent): GameState {
  const causalFloor = getActiveCausalBasis(state);
  const isChessApplicable = validateRecordedReleaseEvent(state, event, causalFloor);
  const { releasedClock, receipt } = buildReleasedClockState(state, event, isChessApplicable);
  const nextReceipts = new Map(state.releaseReceipts);
  nextReceipts.set(event.releaseRequestId, receipt);

  const dispBalances = computeDisplayBalances(releasedClock.basis, event.at, state.timeControl);
  const exposedClock: ClockState = Object.freeze({
    remaining: dispBalances,
    turnStartedAt: null,
  });

  return {
    ...state,
    stoppedClock: null,
    releasedClock,
    releaseReceipts: Object.freeze(nextReceipts),
    releaseNeeded: false,
    clock: exposedClock,
    eventSequence: state.eventSequence + 1,
    lastResolutionAt: event.at,
  };
}

function assertStartedTopLevel(state: GameState, event: AdjudicationStartedEvent): void {
  if (state.phase !== 'idle') throw new GameError(`Cannot start adjudication in phase "${state.phase}"`);
  if (event.gameId !== state.gameId) throw new GameError(`AdjudicationStarted gameId mismatch: expected "${state.gameId}", got "${event.gameId}"`);
  if (event.baseRevision !== state.eventSequence) throw new GameError(`AdjudicationStarted baseRevision mismatch: expected ${state.eventSequence}, got ${event.baseRevision}`);
  if (event.at !== event.prepared.at) throw new GameError('AdjudicationStarted timestamp mismatch');
  validateTimestamp(event.at, 'AdjudicationStarted timestamp');
  const basis = getActiveCausalBasis(state);
  if (event.at < basis) {
    throw new GameError(`Suspension timestamp ${event.at} cannot precede active causal basis ${basis}`);
  }
}

function assertNegotiationColor(color: unknown): void {
  if (color !== 'w' && color !== 'b') {
    throw new GameError(`Invalid negotiation color: ${JSON.stringify(color)}`);
  }
}

function resolveStartedMove(pos: Position, uci: string): ReturnType<Position['legalMoves']>[number] {
  try {
    return resolveLegalMove(pos, uci);
  } catch (err) {
    throw new GameError(`Illegal move "${uci}": ${(err as Error).message}`);
  }
}

function assertStoppedMoveReadiness(state: GameState): void {
  if (state.stoppedClock?.basis.noShowRemainderMs === 0) {
    throw new GameError('Cannot play move: no-show deadline has expired');
  }
  if (state.source !== null && state.ply === 0 && (!state.ready.w || !state.ready.b)) {
    throw new GameError(NOT_READY_MESSAGE);
  }
}

function assertUnstoppedMoveReadiness(state: GameState, at: number): void {
  if (state.source === null || state.ply > 0) return;
  const verdict = checkStateNoShowVerdict(state, at);
  if (verdict.kind === 'expire') {
    throw new GameError('Cannot play move: no-show deadline has expired');
  }
  if (!state.ready.w || !state.ready.b) {
    throw new GameError(NOT_READY_MESSAGE);
  }
}

function assertReleasedMoveReadiness(state: GameState, at: number): void {
  const rel = state.releasedClock!;
  if (rel.basis.noShowRemainderMs === 0) {
    throw new GameError('Cannot play move: no-show deadline has expired');
  }
  if (rel.noShowRunningSince !== null && rel.basis.noShowRemainderMs !== null) {
    if (at >= rel.noShowRunningSince + rel.basis.noShowRemainderMs) {
      throw new GameError('Cannot play move: no-show deadline has expired');
    }
  }
  if (state.source !== null && state.ply === 0 && (!state.ready.w || !state.ready.b)) {
    throw new GameError(NOT_READY_MESSAGE);
  }
}

function assertStartedMoveReadiness(state: GameState, at: number): void {
  if (state.stoppedClock !== null) {
    assertStoppedMoveReadiness(state);
    return;
  }
  if (state.releasedClock !== null) {
    assertReleasedMoveReadiness(state, at);
    return;
  }
  assertUnstoppedMoveReadiness(state, at);
}

function assertReleasedMoveBalanceNotExpired(
  rc: GameReleasedClockState,
  tc: TimeControl,
  mover: Color,
  at: number,
): void {
  if (rc.isChessApplicable) {
    const dispBalances = computeDisplayBalances(rc.basis, at, tc);
    if (tc.kind !== 'unlimited' && dispBalances[mover] <= 0) {
      throw new GameError(`Cannot play move: clock expired for ${mover}`);
    }
    return;
  }
  if (tc.kind !== 'unlimited' && rc.basis.turnBaseBalances[mover] <= 0) {
    throw new GameError(`Cannot play move: clock expired for ${mover}`);
  }
}

function assertMoveBalanceNotExpired(state: GameState, mover: Color, at: number): void {
  if (state.stoppedClock !== null) {
    const dispBalances = computeDisplayBalances(state.stoppedClock.basis, at, state.timeControl);
    if (state.timeControl.kind !== 'unlimited' && dispBalances[mover] <= 0) {
      throw new GameError(`Cannot play move: clock expired for ${mover}`);
    }
    return;
  }
  if (state.releasedClock !== null) {
    assertReleasedMoveBalanceNotExpired(state.releasedClock, state.timeControl, mover, at);
    return;
  }
  if (hasFlagged(state.clock, mover, at, state.timeControl)) {
    throw new GameError(`Cannot play move: clock expired for ${mover}`);
  }
}

function assertStartedMoveAdmission(state: GameState, op: PreparedOperation): void {
  const intent = op.intent as { kind: 'move'; mover: Color; uci: string; san: string; successorFen: string };
  if (intent.mover !== state.position.turn) {
    throw new GameError(`Move mover mismatch: expected ${state.position.turn}, got ${intent.mover}`);
  }
  assertStartedMoveReadiness(state, op.at);
  assertMoveBalanceNotExpired(state, intent.mover, op.at);
  const moveObj = resolveStartedMove(state.position, intent.uci);
  const san = state.position.toSan(moveObj);
  if (intent.san !== san) {
    throw new GameError(`Prepared SAN mismatch: expected "${san}", got "${intent.san}"`);
  }
  const succ = state.position.play(moveObj);
  if (intent.successorFen !== succ.fen()) {
    throw new GameError('Prepared successor FEN mismatch');
  }
}

function assertStartedDrawNegotiation(state: GameState, intent: PreparedIntent): boolean {
  if (intent.kind === 'offerDraw') {
    assertNegotiationColor(intent.color);
    if (state.drawOffer === intent.color) throw new GameError('Draw already offered by this side');
    return true;
  }
  if (intent.kind === 'acceptDraw') {
    assertNegotiationColor(intent.color);
    const opp = intent.color === 'w' ? 'b' : 'w';
    if (state.drawOffer !== opp) throw new GameError('No draw offer to accept');
    return true;
  }
  if (intent.kind === 'declineDraw') {
    assertNegotiationColor(intent.color);
    if (state.drawOffer === null) throw new GameError('No draw offer to decline');
    return true;
  }
  return false;
}

function assertStartedEndingNegotiation(state: GameState, intent: PreparedIntent): void {
  if (intent.kind === 'resign') {
    assertNegotiationColor(intent.color);
  } else if (intent.kind === 'abort') {
    if (intent.color !== undefined) assertNegotiationColor(intent.color);
    if (state.ply >= 2) throw new GameError('Game can no longer be aborted');
  }
}

function assertStartedNegotiationAdmission(state: GameState, intent: PreparedIntent): void {
  if (assertStartedDrawNegotiation(state, intent)) return;
  assertStartedEndingNegotiation(state, intent);
}

function resolveNoShowEndingForSource(
  source: GameSource | null | undefined,
  ready: Readonly<{ w: boolean; b: boolean }>,
  at: number,
): NoShowVerdict {
  if (source === 'seek') {
    return { kind: 'expire', ending: { type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at } };
  }
  return resolveTournamentNoShowEnding(ready, at);
}

function checkStoppedNoShowVerdict(s: GameState, at: number): NoShowVerdict {
  const stopped = s.stoppedClock;
  if (!stopped) return { kind: 'not_applicable' };
  if (stopped.basis.noShowRemainderMs === null || s.status.over || s.ply > 0) {
    return { kind: 'not_applicable' };
  }
  if (stopped.basis.noShowRemainderMs === 0) {
    return resolveNoShowEndingForSource(s.source, s.ready, at);
  }
  return { kind: 'not_due' };
}

function checkReleasedNoShowVerdict(s: GameState, at: number, isBlocked: boolean): NoShowVerdict {
  const rel = s.releasedClock;
  if (!rel) return { kind: 'not_applicable' };
  if (rel.basis.noShowRemainderMs === null || s.status.over || s.ply > 0) {
    return { kind: 'not_applicable' };
  }
  if (rel.basis.noShowRemainderMs === 0) {
    return resolveNoShowEndingForSource(s.source, s.ready, at);
  }
  if (rel.noShowRunningSince !== null) {
    const deadline = rel.noShowRunningSince + rel.basis.noShowRemainderMs;
    if (!isBlocked && at >= deadline) {
      return resolveNoShowEndingForSource(s.source, s.ready, at);
    }
  }
  return { kind: 'not_due' };
}

function checkStateNoShowVerdict(s: GameState, at: number, isBlocked: boolean = false): NoShowVerdict {
  if (s.stoppedClock !== null) {
    return checkStoppedNoShowVerdict(s, at);
  }
  if (s.releasedClock !== null) {
    return checkReleasedNoShowVerdict(s, at, isBlocked);
  }
  if (!checkNoShowApplicable(s, isBlocked, at)) {
    return (s.noShowAt === null || s.status.over || s.ply > 0)
      ? { kind: 'not_applicable' }
      : { kind: 'not_due' };
  }
  return resolveNoShowEndingForSource(s.source, s.ready, at);
}

function assertReleasedReadyDeadline(rel: GameReleasedClockState, at: number): void {
  if (rel.basis.noShowRemainderMs === 0) {
    throw new GameError('Cannot mark ready after no-show deadline');
  }
  if (rel.noShowRunningSince !== null && rel.basis.noShowRemainderMs !== null) {
    if (at >= rel.noShowRunningSince + rel.basis.noShowRemainderMs) {
      throw new GameError('Cannot mark ready after no-show deadline');
    }
  }
}

function assertReadyDeadlineValid(state: GameState, at: number): void {
  if (state.stoppedClock !== null) {
    if (state.stoppedClock.basis.noShowRemainderMs === 0) {
      throw new GameError('Cannot mark ready after no-show deadline');
    }
    return;
  }
  if (state.releasedClock !== null) {
    assertReleasedReadyDeadline(state.releasedClock, at);
    return;
  }
  if (state.noShowAt !== null && at >= state.noShowAt) {
    throw new GameError('Cannot mark ready after no-show deadline');
  }
}

function assertStartedReadyAdmission(
  state: GameState,
  intent: { kind: 'ready'; color: Color; isNoop?: boolean },
  at: number,
): void {
  if (intent.color !== 'w' && intent.color !== 'b') throw new GameError('Invalid ready seat');
  if (state.source === null || state.ply > 0) throw new GameError('Readiness is only valid before first move of sourced games');
  if (intent.isNoop === true) throw new GameError('AdjudicationStarted cannot be created for ready no-op');
  if (state.ready[intent.color] === true) throw new GameError('Player is already marked ready');
  assertReadyDeadlineValid(state, at);
}

function assertEndingResultMatch(ending: Record<string, unknown>, verdict: GameEndedEvent): void {
  if (ending.result !== verdict.result || ending.winner !== verdict.winner) {
    throw new GameError('Prepared no-show ending mismatch');
  }
  if (ending.termination !== verdict.termination || ending.at !== verdict.at) {
    throw new GameError('Prepared no-show ending mismatch');
  }
}

function assertStartedNoShowEnding(intentEnding: unknown, verdictEnding: GameEndedEvent): void {
  if (typeof intentEnding !== 'object' || intentEnding === null) {
    throw new GameError('Prepared no-show ending must be an object');
  }
  const ending = intentEnding as Record<string, unknown>;
  if (ending.type !== 'GameEnded') {
    throw new GameError('Prepared no-show ending must have type "GameEnded"');
  }
  const allowed = new Set(['type', 'result', 'termination', 'winner', 'at']);
  for (const k of Object.keys(ending)) {
    if (!allowed.has(k)) {
      throw new GameError(`Unexpected property "${k}" in prepared no-show ending`);
    }
  }
  assertEndingResultMatch(ending, verdictEnding);
}

function assertStartedNoShowAdmission(state: GameState, intent: { kind: 'expireNoShow'; ending: GameEndedEvent }, at: number): void {
  if (state.source === null || state.ply > 0) {
    throw new GameError('No-show expiry is only valid before first move of sourced games');
  }
  const verdict = checkStateNoShowVerdict(state, at);
  if (verdict.kind !== 'expire') {
    throw new GameError(`No-show expiry refused: ${verdict.kind}`);
  }
  assertStartedNoShowEnding(intent.ending, verdict.ending);
}

function assertStartedPregameAdmission(state: GameState, intent: PreparedIntent, at: number): void {
  if (intent.kind === 'ready') {
    assertStartedReadyAdmission(state, intent, at);
  } else if (intent.kind === 'expireNoShow') {
    assertStartedNoShowAdmission(state, intent, at);
  } else if (intent.kind === 'creationAdmission') {
    if (state.eventSequence !== 0) throw new GameError('Creation admission is only valid at base revision 0');
  } else {
    throw new GameError(`Unknown prepared intent kind: ${(intent as { kind: string }).kind}`);
  }
}

function assertManagedFlagFallen(state: GameState, flagged: Color, at: number, tc: TimeControl): void {
  if (!isChessClockApplicable(state.source, state.ply, tc)) {
    throw new GameError(`Chess clock flag expiry is not applicable for ${flagged} at ply ${state.ply}`);
  }
  if (state.stoppedClock !== null) {
    if (!hasFlaggedAt(state.stoppedClock.basis, at, tc)) {
      throw new GameError(`Flag has not fallen for ${flagged} at ${at}`);
    }
    return;
  }
  if (state.releasedClock !== null) {
    if (!state.releasedClock.isChessApplicable || !hasFlaggedAt(state.releasedClock.basis, at, tc)) {
      throw new GameError(`Flag has not fallen for ${flagged} at ${at}`);
    }
  }
}

function assertStartedTimeoutAdmission(state: GameState, intent: PreparedIntent, at: number, tc: TimeControl): void {
  if (intent.kind !== 'expireFlag') return;
  if (intent.flagged !== state.position.turn) throw new GameError(`Flagged color ${intent.flagged} is not side to move`);
  const isManaged = state.clockPolicy === 'observed-release-v1' || state.stoppedClock !== null || state.releasedClock !== null;
  if (isManaged) {
    assertManagedFlagFallen(state, intent.flagged, at, tc);
    return;
  }
  if (!hasFlagged(state.clock, intent.flagged, at, tc)) {
    throw new GameError(`Flag has not fallen for ${intent.flagged} at ${at}`);
  }
}

function isNegotiationIntent(kind: string): boolean {
  return kind === 'offerDraw' || kind === 'acceptDraw' || kind === 'declineDraw' || kind === 'resign' || kind === 'abort';
}

function assertStartedIntentAdmissible(state: GameState, event: AdjudicationStartedEvent): void {
  const intent = event.prepared.intent;
  if (intent.kind === 'move') {
    assertStartedMoveAdmission(state, event.prepared);
  } else if (intent.kind === 'expireFlag') {
    assertStartedTimeoutAdmission(state, intent, event.at, state.timeControl);
  } else if (isNegotiationIntent(intent.kind)) {
    assertStartedNegotiationAdmission(state, intent);
  } else {
    assertStartedPregameAdmission(state, intent, event.at);
  }
}

function assertStartedPreparedCore(state: GameState, event: AdjudicationStartedEvent): void {
  if (event.prepared.gameId !== state.gameId) throw new GameError('AdjudicationStarted prepared gameId mismatch');
  if (event.prepared.operationId !== event.operationId) throw new GameError('AdjudicationStarted operationId mismatch');
  if (event.prepared.baseRevision !== state.eventSequence) throw new GameError('AdjudicationStarted prepared baseRevision mismatch');
  if (event.prepared.baseFen !== state.position.fen()) throw new GameError('AdjudicationStarted baseFen mismatch');
  if (event.prepared.variant !== state.variant) throw new GameError('AdjudicationStarted variant mismatch');
  if (event.rulesVersion !== event.prepared.rulesVersion) throw new GameError('AdjudicationStarted rulesVersion mismatch');
}

function assertStartedPolicyMatch(state: GameState, event: AdjudicationStartedEvent): void {
  if (event.clockPolicy !== event.prepared.clockPolicy) {
    throw new GameError('AdjudicationStarted clockPolicy mismatch with prepared operation');
  }
  if (state.clockPolicy !== null && event.clockPolicy !== state.clockPolicy) {
    throw new GameError(`Cannot change or downgrade clock policy: active is "${state.clockPolicy}", event has "${String(event.clockPolicy)}"`);
  }
  if (event.clockPolicy !== undefined) {
    validateClockPolicy(event.clockPolicy);
  }
}

function assertStoppedLineage(stoppedClock: GameStoppedClockState, prepared: PreparedOperation): void {
  if (typeof prepared.parentStopId !== 'string' || prepared.parentStopId !== stoppedClock.stopId) {
    throw new GameError(`AdjudicationStarted prepared parentStopId mismatch: expected "${stoppedClock.stopId}", got "${String(prepared.parentStopId)}"`);
  }
  if (typeof prepared.turnLineageId !== 'string' || prepared.turnLineageId !== stoppedClock.turnLineageId) {
    throw new GameError(`AdjudicationStarted prepared turnLineageId mismatch: expected "${stoppedClock.turnLineageId}", got "${String(prepared.turnLineageId)}"`);
  }
}

function assertReleasedLineage(releasedClock: GameReleasedClockState, prepared: PreparedOperation): void {
  if (typeof prepared.parentStopId !== 'string' || prepared.parentStopId !== releasedClock.consumedStopId) {
    throw new GameError(`AdjudicationStarted prepared parentStopId mismatch: expected "${releasedClock.consumedStopId}", got "${String(prepared.parentStopId)}"`);
  }
  if (typeof prepared.turnLineageId !== 'string' || prepared.turnLineageId !== releasedClock.turnLineageId) {
    throw new GameError(`AdjudicationStarted prepared turnLineageId mismatch: expected "${releasedClock.turnLineageId}", got "${String(prepared.turnLineageId)}"`);
  }
}

function assertUnstoppedLineage(gameId: string, ply: number, prepared: PreparedOperation): void {
  if (prepared.parentStopId !== null && prepared.parentStopId !== undefined) {
    throw new GameError('AdjudicationStarted prepared parentStopId must be null for non-stopped game');
  }
  if (prepared.turnLineageId !== null && prepared.turnLineageId !== undefined) {
    const canonical = deriveTurnLineageId(gameId, ply);
    if (typeof prepared.turnLineageId !== 'string' || prepared.turnLineageId !== canonical) {
      throw new GameError('AdjudicationStarted prepared turnLineageId must be null, undefined, or canonical for non-stopped game');
    }
  }
}

function resolveRemainingNoShow(state: GameState, at: number): number | null {
  if (state.stoppedClock !== null) {
    return state.stoppedClock.basis.noShowRemainderMs;
  }
  if (state.releasedClock !== null) {
    const rel = state.releasedClock;
    if (rel.noShowRunningSince !== null && rel.basis.noShowRemainderMs !== null) {
      return Math.max(0, rel.basis.noShowRemainderMs - Math.max(0, at - rel.noShowRunningSince));
    }
    return rel.basis.noShowRemainderMs;
  }
  return state.noShowAt !== null ? Math.max(0, state.noShowAt - at) : null;
}

function assertStartedLineageAndBounds(state: GameState, event: AdjudicationStartedEvent): void {
  if (state.stoppedClock !== null) {
    assertStoppedLineage(state.stoppedClock, event.prepared);
  } else if (state.releasedClock !== null) {
    assertReleasedLineage(state.releasedClock, event.prepared);
  } else {
    assertUnstoppedLineage(state.gameId, state.ply, event.prepared);
  }
  const remainingNoShow = resolveRemainingNoShow(state, event.at);
  validateIntegerPolicyInputs(state.timeControl, state.clock.remaining, remainingNoShow);
}

function assertStartedPrepared(state: GameState, event: AdjudicationStartedEvent): void {
  assertStartedPreparedCore(state, event);
  assertStartedPolicyMatch(state, event);
  if (event.clockPolicy === 'observed-release-v1') {
    assertStartedLineageAndBounds(state, event);
  }
  assertStartedIntentAdmissible(state, event);
}

function assertStartedMetadata(state: GameState, event: AdjudicationStartedEvent): void {
  assertStartedTopLevel(state, event);
  assertStartedPrepared(state, event);
}

function reduceAdjudicationStarted(state: GameState, event: AdjudicationStartedEvent): GameState {
  assertStartedMetadata(state, event);
  const { frozenClock, elapsed } = freezeClock(state.clock, state.position.turn, event.at, state.timeControl);
  const remainingNoShow = resolveRemainingNoShow(state, event.at);

  const basis = deriveStartedBasis({
    clockPolicy: event.clockPolicy,
    stoppedClock: state.stoppedClock,
    releasedClock: state.releasedClock,
    timeControl: state.timeControl,
    turnStartedAt: state.clock.turnStartedAt,
    remainingBalances: state.clock.remaining,
    sideToMove: state.position.turn,
    ply: state.ply,
    atA: event.at,
    noShowRemainderMs: remainingNoShow,
  });

  const publicFrozenClock: ClockState = basis !== null
    ? Object.freeze({
        remaining: computeDisplayBalances(basis, event.at, state.timeControl),
        turnStartedAt: null,
      })
    : frozenClock;
  const thinkingElapsed = basis !== null ? basis.elapsedThinkingMs : elapsed;
  const pendingNoShowRemainder = basis !== null ? basis.noShowRemainderMs : remainingNoShow;

  const pending: PendingAdjudicationState = deepClonePendingState({
    operationId: event.operationId,
    baseRevision: event.baseRevision,
    startedSeq: state.eventSequence + 1,
    acceptedAt: event.at,
    rulesVersion: event.rulesVersion,
    prepared: event.prepared,
    originalClock: state.clock,
    thinkingElapsedAtA: thinkingElapsed,
    originalNoShowAt: state.noShowAt,
    remainingNoShowTimeAtA: pendingNoShowRemainder,
    cursor: 0,
    expectedEffects: [],
    ...(event.clockPolicy ? { clockPolicy: event.clockPolicy } : {}),
    ...(basis ? { originalBasis: basis } : {}),
  });

  return {
    ...state,
    clock: publicFrozenClock,
    phase: 'proving',
    isBlocked: true,
    adjudication: pending,
    eventSequence: state.eventSequence + 1,
  };
}

function reduceAdjudicationResolved(state: GameState, event: AdjudicationResolvedEvent): GameState {
  if (state.phase !== 'proving' || !state.adjudication) {
    throw new GameError(`Cannot resolve adjudication in phase "${state.phase}"`);
  }
  const clockPolicy = state.adjudication.clockPolicy ?? state.clockPolicy;
  const context: ResolutionContext = {
    pending: state.adjudication,
    basePosition: state.position,
    variant: state.variant,
    timeControl: state.timeControl,
    repetition: state.repetition,
    drawOffer: state.drawOffer,
    ready: state.ready,
    source: state.source,
    noShowAt: state.noShowAt,
    ply: state.ply,
    ...(clockPolicy ? { clockPolicy } : {}),
    stoppedClock: state.stoppedClock,
  };

  const derivedEffects = validateRecordedResolution(context, event);

  if (derivedEffects.length === 0) {
    const kind = state.adjudication.prepared.intent.kind;
    if (kind === 'move' || kind === 'resign') {
      throw new GameError(`No-op resolution cannot swallow ${kind}`);
    }
    const intermediate: GameState = {
      ...state,
      eventSequence: state.eventSequence + 1,
      lastResolutionAt: event.at,
    };
    return finalizeCompletion(intermediate, state.adjudication, event.at, []);
  }

  return {
    ...state,
    phase: 'settling',
    isBlocked: true,
    adjudication: Object.freeze({
      ...state.adjudication,
      resolutionAt: event.at,
      cursor: 0,
      expectedEffects: derivedEffects,
    }),
    eventSequence: state.eventSequence + 1,
    lastResolutionAt: event.at,
  };
}

export function canMate(fen: string, color: Color, variant: Variant = 'standard'): boolean {
  switch (variant) {
    case 'kingofthehill':
    case 'racingkings':
    case 'crazyhouse':
    case 'horde':
      parseFen(fen, variant);
      return true;

    case 'threecheck':
    case 'atomic': {
      const st = parseFen(fen, variant);
      for (let sq = 0; sq < 128; sq++) {
        if ((sq & 0x88) !== 0) continue;
        const p = st.board[sq];
        if (p === null) continue;
        const isWhite = p === p.toUpperCase();
        if ((isWhite && color !== 'w') || (!isWhite && color !== 'b')) continue;
        if (typeOf(p) !== 'k') return true;
      }
      return false;
    }

    case 'standard':
    case 'chess960':
    default: {
      const pos = Position.fromFen(fen, variant);
      if (isFrozenDeadPosition(pos.snapshot())) {
        const status = pos.status();
        if (status.over && status.reason === 'dead_position') {
          return false;
        }
      }
      return adjudicateTimeoutPossibility(pos, color);
    }
  }
}
