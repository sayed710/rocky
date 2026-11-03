/**
 * @packageDocumentation
 * Domain-owned prepared command types and admission preflight (Issue #124, Stage 1).
 *
 * Extracts cheap command admission, move legality, normalized intent, and successor computation
 * before expensive proof or clock suspension.
 */

import type { Color, Position, Variant } from '@chess-platform/core';
import type { AdjudicationClockPolicy, GameEndedEvent } from './events';
import { type TimeControl, hasFlagged, validateTimestamp } from './clock';
import { Game, GameError, NOT_READY_MESSAGE } from './game';
import {
  type GameStoppedClockState,
  isChessClockApplicable,
  validateClockPolicy,
  validateIntegerPolicyInputs,
} from './adjudication-completion';
import type { GameReleasedClockState } from './adjudication-release';
import {
  computeDisplayBalances,
  hasFlaggedAt,
} from './adjudication-clock-accounting';

/** Normalized command intent held under adjudication. */
export type PreparedIntent =
  | {
      readonly kind: 'move';
      readonly mover: Color;
      readonly uci: string;
      readonly san: string;
      readonly successorFen: string;
    }
  | { readonly kind: 'resign'; readonly color: Color }
  | { readonly kind: 'offerDraw'; readonly color: Color }
  | { readonly kind: 'acceptDraw'; readonly color: Color }
  | { readonly kind: 'declineDraw'; readonly color: Color }
  | { readonly kind: 'abort'; readonly color?: Color }
  | { readonly kind: 'ready'; readonly color: Color; readonly isNoop: boolean }
  | { readonly kind: 'expireFlag'; readonly flagged: Color }
  | { readonly kind: 'expireNoShow'; readonly ending: GameEndedEvent }
  | { readonly kind: 'creationAdmission' };

/** Immutable prepared operation binding exact revision, position FEN, rules, and intent. */
export interface PreparedOperation {
  readonly kind?: 'prepared';
  readonly operationId: string;
  readonly gameId: string;
  readonly baseRevision: number;
  readonly baseFen: string;
  readonly variant: Variant;
  readonly rulesVersion: string;
  readonly intent: PreparedIntent;
  readonly at: number;
  readonly clockPolicy?: AdjudicationClockPolicy;
  readonly parentStopId?: string | null;
  readonly turnLineageId?: string | null;
}

/** Legitimate readiness no-op reasons. */
export type ReadyNoopReason =
  | 'unsourced'
  | 'post_first_move'
  | 'already_ready'
  | 'late'
  | 'game_over';

/** Discriminated decision for a readiness call requiring no Started event or proof job. */
export interface ReadyNoopDecision {
  readonly kind: 'noop';
  readonly reason: ReadyNoopReason;
}

/** Result of direct player readiness preparation. */
export type PrepareReadyResult = PreparedOperation | ReadyNoopDecision;

/** Player commands admissible via the authoritative path. */
export type AuthoritativePlayerCommand =
  | { readonly kind: 'move'; readonly uci: string }
  | { readonly kind: 'resign' }
  | { readonly kind: 'offerDraw' }
  | { readonly kind: 'acceptDraw' }
  | { readonly kind: 'declineDraw' }
  | { readonly kind: 'abort' }
  | { readonly kind: 'ready' };

/** Operational context for authoritative command arbitration. */
export interface AuthoritativeCommandContext {
  readonly color: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

/** Outcome of authoritative player command arbitration. */
export type AuthoritativeAdmissionResult =
  | { readonly kind: 'prepared'; readonly operation: PreparedOperation }
  | ReadyNoopDecision;

function cloneDrawIntent(intent: PreparedIntent): PreparedIntent | null {
  if (intent.kind === 'offerDraw') return { kind: 'offerDraw', color: intent.color };
  if (intent.kind === 'acceptDraw') return { kind: 'acceptDraw', color: intent.color };
  if (intent.kind === 'declineDraw') return { kind: 'declineDraw', color: intent.color };
  return null;
}

function cloneTerminationIntent(intent: PreparedIntent): PreparedIntent | null {
  if (intent.kind === 'resign') return Object.freeze({ kind: 'resign', color: intent.color });
  if (intent.kind === 'abort') return Object.freeze({ kind: 'abort', ...(intent.color !== undefined ? { color: intent.color } : {}) });
  if (intent.kind === 'expireFlag') return Object.freeze({ kind: 'expireFlag', flagged: intent.flagged });
  if (intent.kind === 'expireNoShow') {
    const ending = intent.ending as unknown as Record<string, unknown>;
    if (!ending || ending.type !== 'GameEnded') {
      throw new GameError('Prepared no-show ending must have type "GameEnded"');
    }
    return Object.freeze({
      kind: 'expireNoShow',
      ending: Object.freeze({
        type: 'GameEnded' as const,
        result: intent.ending.result,
        termination: intent.ending.termination,
        winner: intent.ending.winner,
        at: intent.ending.at,
      }),
    });
  }
  return null;
}

function cloneActionIntent(intent: PreparedIntent): PreparedIntent {
  if (intent.kind === 'move') {
    return {
      kind: 'move',
      mover: intent.mover,
      uci: intent.uci,
      san: intent.san,
      successorFen: intent.successorFen,
    };
  }
  if (intent.kind === 'ready') return { kind: 'ready', color: intent.color, isNoop: intent.isNoop };
  if (intent.kind === 'creationAdmission') return { kind: 'creationAdmission' };
  throw new GameError(`Unknown prepared intent kind: ${(intent as { kind: string }).kind}`);
}

/** Deep clone a prepared intent to enforce defensive copying. */
export function clonePreparedIntent(intent: PreparedIntent): PreparedIntent {
  const draw = cloneDrawIntent(intent);
  if (draw) return Object.freeze(draw);
  const term = cloneTerminationIntent(intent);
  if (term) return Object.freeze(term);
  return Object.freeze(cloneActionIntent(intent));
}

/** Deep clone a prepared operation to prevent input or returned mutation tampering. */
export function clonePreparedOperation(op: PreparedOperation): PreparedOperation {
  return Object.freeze({
    operationId: op.operationId,
    gameId: op.gameId,
    baseRevision: op.baseRevision,
    baseFen: op.baseFen,
    variant: op.variant,
    rulesVersion: op.rulesVersion,
    intent: clonePreparedIntent(op.intent),
    at: op.at,
    ...(op.clockPolicy !== undefined ? { clockPolicy: op.clockPolicy } : {}),
    ...(op.parentStopId !== undefined ? { parentStopId: op.parentStopId } : {}),
    ...(op.turnLineageId !== undefined ? { turnLineageId: op.turnLineageId } : {}),
  });
}

function resolveParentStopId(
  stopped: GameStoppedClockState | null,
  released: GameReleasedClockState | null,
): string | null {
  if (stopped !== null) return stopped.stopId;
  if (released !== null) return released.consumedStopId;
  return null;
}

function resolveActivePolicyInfo(
  game: Game,
  activePolicy: AdjudicationClockPolicy,
  explicitPolicy?: AdjudicationClockPolicy,
): { clockPolicy: AdjudicationClockPolicy; parentStopId: string | null; turnLineageId: string | null } {
  if (explicitPolicy !== undefined && explicitPolicy !== activePolicy) {
    throw new GameError(`Cannot downgrade or strip active managed clock policy "${activePolicy}"`);
  }
  const stopped = game.stoppedClock;
  const released = game.releasedClock;
  const currentOrigin = stopped ?? released;
  const parentStopId = resolveParentStopId(stopped, released);
  const turnLineageId = currentOrigin !== null ? currentOrigin.turnLineageId : null;
  return { clockPolicy: activePolicy, parentStopId, turnLineageId };
}

function resolveInitialNoShowRemainder(game: Game): number | null {
  if (game.stoppedClock !== null) return game.stoppedClock.basis.noShowRemainderMs;
  if (game.releasedClock !== null) return game.releasedClock.basis.noShowRemainderMs;
  const snap = game.snapshot();
  if (snap.noShowAt !== null) return Math.max(0, snap.noShowAt - snap.createdAt);
  return null;
}

function resolveExplicitPolicyInfo(
  game: Game,
  explicitPolicy: AdjudicationClockPolicy,
): { clockPolicy: AdjudicationClockPolicy } {
  validateClockPolicy(explicitPolicy);
  const noShowRemainder = resolveInitialNoShowRemainder(game);
  validateIntegerPolicyInputs(game.timeControl, game.clock.remaining, noShowRemainder);
  return { clockPolicy: explicitPolicy };
}

function resolveCommandPolicy(
  game: Game,
  explicitPolicy?: AdjudicationClockPolicy,
): {
  clockPolicy?: AdjudicationClockPolicy;
  parentStopId?: string | null;
  turnLineageId?: string | null;
} {
  const activePolicy = game.clockPolicy;
  if (activePolicy !== null && activePolicy !== undefined) {
    return resolveActivePolicyInfo(game, activePolicy, explicitPolicy);
  }
  if (explicitPolicy !== undefined) {
    return resolveExplicitPolicyInfo(game, explicitPolicy);
  }
  return {};
}

function assertOngoingAndNotBlocked(game: Game): void {
  if (game.status.over) {
    throw new GameError('Game is already over');
  }
  if (game.isBlocked) {
    throw new GameError('Cannot admit command: adjudication is currently pending');
  }
}

function assertValidOperationMetadata(operationId: string, rulesVersion: string, at: number): void {
  if (typeof operationId !== 'string' || operationId.trim().length === 0) {
    throw new GameError('operationId must be a non-empty string');
  }
  if (typeof rulesVersion !== 'string' || rulesVersion.trim().length === 0) {
    throw new GameError('rulesVersion must be a non-empty string');
  }
  validateTimestamp(at, 'Suspension timestamp');
}

function assertPreparationCausalFloor(game: Game, at: number): void {
  if (game.stoppedClock !== null && game.stoppedClock.basis.stoppedAt !== null) {
    if (at < game.stoppedClock.basis.stoppedAt) {
      throw new GameError(`Command timestamp ${at} cannot precede last stop observation ${game.stoppedClock.basis.stoppedAt}`);
    }
  } else if (game.releasedClock !== null) {
    if (at < game.releasedClock.releasedAt) {
      throw new GameError(`Command timestamp ${at} cannot precede active release floor ${game.releasedClock.releasedAt}`);
    }
  }
}

/** Resolves a legal move matching a UCI string on a Position, or throws GameError. */
export function resolveLegalMove(pos: Position, uci: string): ReturnType<Position['legalMoves']>[number] {
  const legal = pos.legalMoves();
  for (const m of legal) {
    if (pos.toUci(m) === uci) return m;
  }
  throw new GameError(`No legal move matches "${uci}"`);
}

/** Preflight parameters for preparing a move. */
export interface PrepareMoveParams {
  readonly uci: string;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

function assertReleasedNoShowExpired(released: GameReleasedClockState | null, at: number): void {
  if (released === null) return;
  if (released.basis.noShowRemainderMs === 0) {
    throw new GameError('Cannot play move: no-show deadline has expired');
  }
  if (released.noShowRunningSince !== null && released.basis.noShowRemainderMs !== null) {
    if (at >= released.noShowRunningSince + released.basis.noShowRemainderMs) {
      throw new GameError('Cannot play move: no-show deadline has expired');
    }
  }
}

function assertMoveReadiness(game: Game, at: number): void {
  if (game.stoppedClock) {
    if (game.stoppedClock.basis.noShowRemainderMs === 0) {
      throw new GameError('Cannot play move: no-show deadline has expired');
    }
  } else if (game.releasedClock) {
    assertReleasedNoShowExpired(game.releasedClock, at);
  } else if (game.noShowVerdict(at).kind === 'expire') {
    throw new GameError('Cannot play move: no-show deadline has expired');
  }
  if (game.awaitingReadiness) {
    throw new GameError(NOT_READY_MESSAGE);
  }
}

function assertReleasedClockNotExpired(
  rel: GameReleasedClockState,
  mover: Color,
  at: number,
  tc: TimeControl,
): void {
  if (rel.isChessApplicable) {
    const dispBalances = computeDisplayBalances(rel.basis, at, tc);
    if (tc.kind !== 'unlimited' && dispBalances[mover] <= 0) {
      throw new GameError(`Cannot play move: clock expired for ${mover}`);
    }
    return;
  }
  if (tc.kind !== 'unlimited' && rel.basis.turnBaseBalances[mover] <= 0) {
    throw new GameError(`Cannot play move: clock expired for ${mover}`);
  }
}

function assertMoveClockNotExpired(game: Game, mover: Color, at: number, snap: ReturnType<Game['snapshot']>): void {
  if (game.stoppedClock) {
    const dispBalances = computeDisplayBalances(game.stoppedClock.basis, at, snap.timeControl);
    if (snap.timeControl.kind !== 'unlimited' && dispBalances[mover] <= 0) {
      throw new GameError(`Cannot play move: clock expired for ${mover}`);
    }
  } else if (game.releasedClock) {
    assertReleasedClockNotExpired(game.releasedClock, mover, at, snap.timeControl);
  } else if (hasFlagged(snap.clock, mover, at, snap.timeControl)) {
    throw new GameError(`Cannot play move: clock expired for ${mover}`);
  }
}

/**
 * Prepares and validates a move command before proof or clock suspension.
 * Rejects illegal moves, wrong turn, not-ready state, or expired clock.
 */
export function prepareMove(game: Game, params: PrepareMoveParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  assertMoveReadiness(game, params.at);

  const snap = game.snapshot();
  const mover = snap.position.turn;
  assertMoveClockNotExpired(game, mover, params.at, snap);

  let moveObj;
  try {
    moveObj = game.resolveMovePublic(params.uci);
  } catch (err) {
    throw new GameError(`Illegal move "${params.uci}": ${(err as Error).message}`);
  }

  const san = snap.position.toSan(moveObj);
  let successorPos;
  try {
    successorPos = snap.position.play(moveObj);
  } catch (err) {
    throw new GameError(`Illegal move "${params.uci}": ${(err as Error).message}`);
  }

  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);

  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: {
      kind: 'move',
      mover,
      uci: params.uci,
      san,
      successorFen: successorPos.fen(),
    },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for preparing resignation. */
export interface PrepareResignParams {
  readonly color: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

export function prepareResign(game: Game, params: PrepareResignParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  if (params.color !== 'w' && params.color !== 'b') {
    throw new GameError(`Invalid resigning color ${JSON.stringify(params.color)}`);
  }
  const snap = game.snapshot();
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'resign', color: params.color },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for draw offer/accept/decline. */
export interface PrepareDrawActionParams {
  readonly color: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

export function prepareDrawOffer(game: Game, params: PrepareDrawActionParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  if (params.color !== 'w' && params.color !== 'b') {
    throw new GameError(`Invalid draw offer color ${JSON.stringify(params.color)}`);
  }
  const snap = game.snapshot();
  if (snap.drawOffer === params.color) {
    throw new GameError('Draw already offered by this side');
  }
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'offerDraw', color: params.color },
    at: params.at,
    ...policyInfo,
  };
}

export function prepareDrawAccept(game: Game, params: PrepareDrawActionParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  const snap = game.snapshot();
  const opponent: Color = params.color === 'w' ? 'b' : 'w';
  if (snap.drawOffer !== opponent) {
    throw new GameError('No draw offer to accept');
  }
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'acceptDraw', color: params.color },
    at: params.at,
    ...policyInfo,
  };
}

export function prepareDrawDecline(game: Game, params: PrepareDrawActionParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  const snap = game.snapshot();
  if (snap.drawOffer === null) {
    throw new GameError('No draw offer to decline');
  }
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'declineDraw', color: params.color },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for preparing game abort. */
export interface PrepareAbortParams {
  readonly color?: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

export function prepareAbort(game: Game, params: PrepareAbortParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  const snap = game.snapshot();
  if (snap.ply >= 2) {
    throw new GameError('Game can no longer be aborted');
  }
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'abort', ...(params.color !== undefined ? { color: params.color } : {}) },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for preparing player readiness. */
export interface PrepareReadyParams {
  readonly color: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

function isReadyLate(game: Game, at: number): boolean {
  if (game.stoppedClock !== null) {
    return game.stoppedClock.basis.noShowRemainderMs === 0;
  }
  if (game.releasedClock !== null && game.releasedClock.basis.noShowRemainderMs === 0) {
    return true;
  }
  return game.noShowDeadline !== null && at >= game.noShowDeadline;
}

function classifyReadyNoop(game: Game, color: Color, at: number): ReadyNoopReason | null {
  const snap = game.snapshot();
  if (snap.status.over) return 'game_over';
  if (snap.source === null) return 'unsourced';
  if (snap.ply > 0) return 'post_first_move';
  if (snap.ready[color] === true) return 'already_ready';
  if (isReadyLate(game, at)) return 'late';
  return null;
}

export function prepareReady(game: Game, params: PrepareReadyParams): PrepareReadyResult {
  if (game.isBlocked) {
    throw new GameError('Cannot admit command: adjudication is currently pending');
  }
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  if (params.color !== 'w' && params.color !== 'b') {
    throw new GameError(`Invalid ready seat ${JSON.stringify(params.color)}`);
  }
  const noopReason = classifyReadyNoop(game, params.color, params.at);
  if (noopReason !== null) {
    return { kind: 'noop', reason: noopReason };
  }
  assertPreparationCausalFloor(game, params.at);
  const snap = game.snapshot();
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    kind: 'prepared',
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'ready', color: params.color, isNoop: false },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for timeout expiry. */
export interface PrepareFlagExpiryParams {
  readonly flagged: Color;
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

function isManagedGameOrParam(game: Game, paramPolicy?: AdjudicationClockPolicy): boolean {
  if (game.clockPolicy !== null || paramPolicy !== undefined) return true;
  return game.stoppedClock !== null || game.releasedClock !== null;
}

function assertFlagHasFallen(game: Game, flagged: Color, at: number, snap: ReturnType<Game['snapshot']>): void {
  if (game.stoppedClock) {
    if (!hasFlaggedAt(game.stoppedClock.basis, at, snap.timeControl)) {
      throw new GameError(`Flag has not fallen for ${flagged} at ${at}`);
    }
    return;
  }
  if (game.releasedClock) {
    if (!game.releasedClock.isChessApplicable || !hasFlaggedAt(game.releasedClock.basis, at, snap.timeControl)) {
      throw new GameError(`Flag has not fallen for ${flagged} at ${at}`);
    }
    return;
  }
  if (!hasFlagged(snap.clock, flagged, at, snap.timeControl)) {
    throw new GameError(`Flag has not fallen for ${flagged} at ${at}`);
  }
}

export function prepareFlagExpiry(game: Game, params: PrepareFlagExpiryParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  const snap = game.snapshot();
  if (snap.position.turn !== params.flagged) {
    throw new GameError(`Flag request invalid: ${params.flagged} is not side to move`);
  }
  if (isManagedGameOrParam(game, params.clockPolicy) && !isChessClockApplicable(snap.source, snap.ply, snap.timeControl)) {
    throw new GameError(`Chess clock flag expiry is not applicable for ${params.flagged} at ply ${snap.ply}`);
  }
  assertFlagHasFallen(game, params.flagged, params.at, snap);
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'expireFlag', flagged: params.flagged },
    at: params.at,
    ...policyInfo,
  };
}

/** Preflight parameters for creation admission on a game aggregate. */
export interface PrepareCreationAdmissionParams {
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly at: number;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

/** Preflight parameters for creation admission from raw parameters. */
export interface PrepareCreationParams {
  readonly operationId: string;
  readonly gameId: string;
  readonly rulesVersion: string;
  readonly initialFen: string;
  readonly variant: Variant;
  readonly at: number;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

export function prepareCreationAdmission(
  gameOrParams: Game | PrepareCreationParams,
  maybeParams?: PrepareCreationAdmissionParams,
): PreparedOperation {
  if (gameOrParams instanceof Game) {
    const game = gameOrParams;
    if (!maybeParams) {
      throw new GameError('Missing parameters for prepareCreationAdmission(game, params)');
    }
    assertValidOperationMetadata(maybeParams.operationId, maybeParams.rulesVersion, maybeParams.at);
    const snap = game.snapshot();
    const policyInfo = resolveCommandPolicy(game, maybeParams.clockPolicy);
    return {
      operationId: maybeParams.operationId,
      gameId: snap.gameId,
      baseRevision: 0,
      baseFen: snap.position.fen(),
      variant: snap.variant,
      rulesVersion: maybeParams.rulesVersion,
      intent: { kind: 'creationAdmission' },
      at: maybeParams.at,
      ...policyInfo,
    };
  }
  const params = gameOrParams;
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  if (params.clockPolicy !== undefined) {
    validateClockPolicy(params.clockPolicy);
  }
  return {
    operationId: params.operationId,
    gameId: params.gameId,
    baseRevision: 0,
    baseFen: params.initialFen,
    variant: params.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'creationAdmission' },
    at: params.at,
    ...(params.clockPolicy !== undefined ? { clockPolicy: params.clockPolicy } : {}),
  };
}

/** Preflight parameters for pregame no-show expiry. */
export interface PrepareNoShowExpiryParams {
  readonly at: number;
  readonly operationId: string;
  readonly rulesVersion: string;
  readonly clockPolicy?: AdjudicationClockPolicy;
}

export function prepareNoShowExpiry(game: Game, params: PrepareNoShowExpiryParams): PreparedOperation {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(params.operationId, params.rulesVersion, params.at);
  assertPreparationCausalFloor(game, params.at);
  const verdict = game.noShowVerdict(params.at);
  if (verdict.kind !== 'expire') {
    throw new GameError(`No-show expiry refused: ${verdict.kind}`);
  }
  const snap = game.snapshot();
  const policyInfo = resolveCommandPolicy(game, params.clockPolicy);
  return {
    operationId: params.operationId,
    gameId: snap.gameId,
    baseRevision: game.eventSequence,
    baseFen: snap.position.fen(),
    variant: snap.variant,
    rulesVersion: params.rulesVersion,
    intent: { kind: 'expireNoShow', ending: verdict.ending },
    at: params.at,
    ...policyInfo,
  };
}

function arbitrateMoveCommand(
  game: Game,
  uci: string,
  ctx: AuthoritativeCommandContext,
): AuthoritativeAdmissionResult {
  if (game.turn !== ctx.color) {
    throw new GameError('It is not your turn');
  }
  if (game.awaitingReadiness) {
    throw new GameError(NOT_READY_MESSAGE);
  }
  return {
    kind: 'prepared',
    operation: prepareMove(game, {
      uci,
      at: ctx.at,
      operationId: ctx.operationId,
      rulesVersion: ctx.rulesVersion,
      clockPolicy: ctx.clockPolicy,
    }),
  };
}

function arbitrateDrawCommand(
  game: Game,
  kind: 'offerDraw' | 'acceptDraw' | 'declineDraw',
  ctx: AuthoritativeCommandContext,
): AuthoritativeAdmissionResult {
  const params = {
    color: ctx.color,
    at: ctx.at,
    operationId: ctx.operationId,
    rulesVersion: ctx.rulesVersion,
    clockPolicy: ctx.clockPolicy,
  };
  if (kind === 'offerDraw') {
    return { kind: 'prepared', operation: prepareDrawOffer(game, params) };
  }
  if (kind === 'acceptDraw') {
    return { kind: 'prepared', operation: prepareDrawAccept(game, params) };
  }
  return { kind: 'prepared', operation: prepareDrawDecline(game, params) };
}

function arbitrateRequestedCommand(
  game: Game,
  cmd: AuthoritativePlayerCommand,
  ctx: AuthoritativeCommandContext,
): AuthoritativeAdmissionResult {
  if (cmd.kind === 'move') {
    return arbitrateMoveCommand(game, cmd.uci, ctx);
  }
  if (cmd.kind === 'resign') {
    return {
      kind: 'prepared',
      operation: prepareResign(game, {
        color: ctx.color,
        at: ctx.at,
        operationId: ctx.operationId,
        rulesVersion: ctx.rulesVersion,
        clockPolicy: ctx.clockPolicy,
      }),
    };
  }
  if (cmd.kind === 'offerDraw' || cmd.kind === 'acceptDraw' || cmd.kind === 'declineDraw') {
    return arbitrateDrawCommand(game, cmd.kind, ctx);
  }
  if (cmd.kind === 'abort') {
    return {
      kind: 'prepared',
      operation: prepareAbort(game, {
        color: ctx.color,
        at: ctx.at,
        operationId: ctx.operationId,
        rulesVersion: ctx.rulesVersion,
        clockPolicy: ctx.clockPolicy,
      }),
    };
  }
  if (cmd.kind === 'ready') {
    const res = prepareReady(game, {
      color: ctx.color,
      at: ctx.at,
      operationId: ctx.operationId,
      rulesVersion: ctx.rulesVersion,
      clockPolicy: ctx.clockPolicy,
    });
    if (res.kind === 'noop') return res;
    return { kind: 'prepared', operation: res };
  }
  throw new GameError(`Unknown command kind: ${(cmd as { kind: string }).kind}`);
}

/**
 * Pure authority-style selector arbitrating player commands.
 * Normalizes to due no-show expiry, then due running flag expiry, before command-specific admission.
 */
export function prepareAuthoritativeCommand(
  game: Game,
  cmd: AuthoritativePlayerCommand,
  ctx: AuthoritativeCommandContext,
): AuthoritativeAdmissionResult {
  assertOngoingAndNotBlocked(game);
  assertValidOperationMetadata(ctx.operationId, ctx.rulesVersion, ctx.at);
  assertPreparationCausalFloor(game, ctx.at);
  if (ctx.color !== 'w' && ctx.color !== 'b') {
    throw new GameError(`Invalid player color ${JSON.stringify(ctx.color)}`);
  }
  if (game.noShowVerdict(ctx.at).kind === 'expire') {
    return {
      kind: 'prepared',
      operation: prepareNoShowExpiry(game, {
        at: ctx.at,
        operationId: ctx.operationId,
        rulesVersion: ctx.rulesVersion,
        clockPolicy: ctx.clockPolicy,
      }),
    };
  }
  if (game.timeoutDue(ctx.at)) {
    return {
      kind: 'prepared',
      operation: prepareFlagExpiry(game, {
        flagged: game.turn,
        at: ctx.at,
        operationId: ctx.operationId,
        rulesVersion: ctx.rulesVersion,
        clockPolicy: ctx.clockPolicy,
      }),
    };
  }
  return arbitrateRequestedCommand(game, cmd, ctx);
}
