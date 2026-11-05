/**
 * @packageDocumentation
 * Recorded adjudication clock release domain contract (Issue #124, Stage K).
 *
 * Implements:
 * - Deterministic replay of recorded AdjudicationClocksStarted events.
 * - Distinct released clock state retaining F basis and consumed-stop identity.
 * - Independent chess and no-show running anchors.
 * - Read-only release retry inspection and immutable receipt ownership.
 * - Pure standalone batch validation for recorded S releases.
 */

import type { Color } from '@chess-platform/core';
import type {
  AdjudicationClockPolicy,
  AdjudicationClocksStartedEvent,
  GameSource,
} from './events';
import type { TimeControl } from './clock';
import { GameError, MAX_SAFE_TIMESTAMP_MS } from './clock';
import {
  type AdjudicationClockBasis,
  computeFlagDeadline,
  createAdjudicationClockBasis,
  freezeClockBasis,
  releaseClockBasis,
} from './adjudication-clock-accounting';
import {
  type GameStoppedClockState,
  isChessClockApplicable,
  validateClockPolicy,
} from './adjudication-completion';
import type { Game, GameState } from './game';

/** State record capturing a game's released-turn clock accounting basis and lineage. */
export interface GameReleasedClockState {
  readonly basis: AdjudicationClockBasis;
  readonly consumedStopId: string;
  readonly originatingOperationId: string;
  readonly originatingResolvedSeq: number;
  readonly startedSeq: number;
  readonly rulesVersion: string;
  readonly turnLineageId: string;
  readonly parentStopId: string | null;
  readonly completionHead: number;
  readonly releaseRequestId: string;
  readonly releaseSeq: number;
  readonly releasedAt: number;
  readonly isChessApplicable: boolean;
  readonly noShowRunningSince: number | null;
}

/** Immutable receipt of a folded clock release event. */
export interface AdjudicationReleaseReceipt {
  readonly releaseRequestId: string;
  readonly gameId: string;
  readonly stopId: string;
  readonly originatingOperationId: string;
  readonly originatingResolvedSeq: number;
  readonly completionHead: number;
  readonly expectedHead: number;
  readonly releaseSeq: number;
  readonly at: number;
  readonly turnLineageId: string;
  readonly side: Color;
  readonly ply: number;
  readonly clockPolicy: AdjudicationClockPolicy;
  readonly rulesVersion: string;
}

/** Parameters required to propose or inspect a release retry. */
export interface ReleaseProposalParams {
  readonly releaseRequestId: string;
  readonly gameId: string;
  readonly stopId: string;
  readonly originatingOperationId: string;
  readonly originatingResolvedSeq: number;
  readonly completionHead: number;
  readonly expectedHead: number;
  readonly turnLineageId: string;
  readonly side: Color;
  readonly ply: number;
  readonly at: number;
  readonly clockPolicy: AdjudicationClockPolicy;
  readonly rulesVersion: string;
}

/** Discriminated outcome of read-only release retry inspection. */
export type ReleaseRetryInspection =
  | { readonly kind: 'existing_match'; readonly receipt: AdjudicationReleaseReceipt }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'consumed_stop'; readonly reason: string }
  | { readonly kind: 'not_released' };

function validateSafeNonNegativeInteger(val: unknown, name: string): void {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0 || val > MAX_SAFE_TIMESTAMP_MS) {
    throw new GameError(`${name} must be a non-negative safe integer <= ${MAX_SAFE_TIMESTAMP_MS}; got ${val}`);
  }
}

/** Deeply clones and freezes a GameReleasedClockState instance. */
export function cloneReleasedClockState(rc: GameReleasedClockState | null): GameReleasedClockState | null {
  if (rc === null) return null;
  const balances = Object.freeze({
    w: rc.basis.turnBaseBalances.w,
    b: rc.basis.turnBaseBalances.b,
  });
  const clonedBasis = Object.freeze({
    ...rc.basis,
    turnBaseBalances: balances,
  });
  return Object.freeze({
    basis: clonedBasis,
    consumedStopId: rc.consumedStopId,
    originatingOperationId: rc.originatingOperationId,
    originatingResolvedSeq: rc.originatingResolvedSeq,
    startedSeq: rc.startedSeq,
    rulesVersion: rc.rulesVersion,
    turnLineageId: rc.turnLineageId,
    parentStopId: rc.parentStopId,
    completionHead: rc.completionHead,
    releaseRequestId: rc.releaseRequestId,
    releaseSeq: rc.releaseSeq,
    releasedAt: rc.releasedAt,
    isChessApplicable: rc.isChessApplicable,
    noShowRunningSince: rc.noShowRunningSince,
  });
}

/** Clones and freezes an AdjudicationReleaseReceipt instance. */
export function cloneReleaseReceipt(receipt: AdjudicationReleaseReceipt): AdjudicationReleaseReceipt {
  return Object.freeze({
    releaseRequestId: receipt.releaseRequestId,
    gameId: receipt.gameId,
    stopId: receipt.stopId,
    originatingOperationId: receipt.originatingOperationId,
    originatingResolvedSeq: receipt.originatingResolvedSeq,
    completionHead: receipt.completionHead,
    expectedHead: receipt.expectedHead,
    releaseSeq: receipt.releaseSeq,
    at: receipt.at,
    turnLineageId: receipt.turnLineageId,
    side: receipt.side,
    ply: receipt.ply,
    clockPolicy: receipt.clockPolicy,
    rulesVersion: receipt.rulesVersion,
  });
}

/** Clones an immutable release receipts map. */
export function cloneReleaseReceiptsMap(
  map: ReadonlyMap<string, AdjudicationReleaseReceipt>,
): ReadonlyMap<string, AdjudicationReleaseReceipt> {
  const cloned = new Map<string, AdjudicationReleaseReceipt>();
  for (const [key, value] of map.entries()) {
    cloned.set(key, cloneReleaseReceipt(value));
  }
  return Object.freeze(cloned);
}

function assertReleaseProposalIdentity(proposal: ReleaseProposalParams): void {
  if (typeof proposal.releaseRequestId !== 'string' || proposal.releaseRequestId.length === 0) {
    throw new GameError('releaseRequestId must be a non-empty string');
  }
  if (typeof proposal.gameId !== 'string' || proposal.gameId.length === 0) {
    throw new GameError('gameId must be a non-empty string');
  }
  if (typeof proposal.stopId !== 'string' || proposal.stopId.length === 0) {
    throw new GameError('stopId must be a non-empty string');
  }
  if (typeof proposal.originatingOperationId !== 'string' || proposal.originatingOperationId.length === 0) {
    throw new GameError('originatingOperationId must be a non-empty string');
  }
}

function assertReleaseProposalLineage(proposal: ReleaseProposalParams): void {
  if (typeof proposal.turnLineageId !== 'string' || proposal.turnLineageId.length === 0) {
    throw new GameError('turnLineageId must be a non-empty string');
  }
  if (typeof proposal.rulesVersion !== 'string' || proposal.rulesVersion.length === 0) {
    throw new GameError('rulesVersion must be a non-empty string');
  }
  if (proposal.side !== 'w' && proposal.side !== 'b') {
    throw new GameError(`Invalid side: ${String(proposal.side)}`);
  }
  validateClockPolicy(proposal.clockPolicy);
}

function assertReleaseProposalSequences(proposal: ReleaseProposalParams): void {
  validateSafeNonNegativeInteger(proposal.at, 'Release timestamp at');
  validateSafeNonNegativeInteger(proposal.originatingResolvedSeq, 'originatingResolvedSeq');
  validateSafeNonNegativeInteger(proposal.completionHead, 'completionHead');
  validateSafeNonNegativeInteger(proposal.expectedHead, 'expectedHead');
  validateSafeNonNegativeInteger(proposal.ply, 'ply');
}

/** Validates structural shape and integer bounds of a release proposal. */
export function assertReleaseProposalShape(proposal: ReleaseProposalParams): void {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    throw new GameError('Release proposal must be a non-null object');
  }
  assertReleaseProposalIdentity(proposal);
  assertReleaseProposalLineage(proposal);
  assertReleaseProposalSequences(proposal);
}

function checkReceiptSequencesMatch(
  existing: AdjudicationReleaseReceipt,
  proposal: ReleaseProposalParams,
): string | null {
  if (existing.gameId !== proposal.gameId) return `gameId mismatch: ${existing.gameId} !== ${proposal.gameId}`;
  if (existing.stopId !== proposal.stopId) return `stopId mismatch: ${existing.stopId} !== ${proposal.stopId}`;
  if (existing.originatingOperationId !== proposal.originatingOperationId) {
    return `originatingOperationId mismatch: ${existing.originatingOperationId} !== ${proposal.originatingOperationId}`;
  }
  if (existing.originatingResolvedSeq !== proposal.originatingResolvedSeq) {
    return `originatingResolvedSeq mismatch: ${existing.originatingResolvedSeq} !== ${proposal.originatingResolvedSeq}`;
  }
  if (existing.completionHead !== proposal.completionHead) {
    return `completionHead mismatch: ${existing.completionHead} !== ${proposal.completionHead}`;
  }
  if (existing.expectedHead !== proposal.expectedHead) {
    return `expectedHead mismatch: ${existing.expectedHead} !== ${proposal.expectedHead}`;
  }
  return null;
}

function checkReceiptDetailsMatch(
  existing: AdjudicationReleaseReceipt,
  proposal: ReleaseProposalParams,
): string | null {
  if (existing.at !== proposal.at) return `timestamp at mismatch: ${existing.at} !== ${proposal.at}`;
  if (existing.turnLineageId !== proposal.turnLineageId) {
    return `turnLineageId mismatch: ${existing.turnLineageId} !== ${proposal.turnLineageId}`;
  }
  if (existing.side !== proposal.side) return `side mismatch: ${existing.side} !== ${proposal.side}`;
  if (existing.ply !== proposal.ply) return `ply mismatch: ${existing.ply} !== ${proposal.ply}`;
  if (existing.clockPolicy !== proposal.clockPolicy) {
    return `clockPolicy mismatch: ${existing.clockPolicy} !== ${proposal.clockPolicy}`;
  }
  if (existing.rulesVersion !== proposal.rulesVersion) {
    return `rulesVersion mismatch: ${existing.rulesVersion} !== ${proposal.rulesVersion}`;
  }
  return null;
}

function findReceiptConflict(
  existing: AdjudicationReleaseReceipt,
  proposal: ReleaseProposalParams,
): string | null {
  return checkReceiptSequencesMatch(existing, proposal) ?? checkReceiptDetailsMatch(existing, proposal);
}

/** Performs read-only retry comparison against existing release receipts. */
export function inspectReleaseRetry(
  game: Game,
  proposal: ReleaseProposalParams,
): ReleaseRetryInspection {
  assertReleaseProposalShape(proposal);
  const existingReceipt = game.getReleaseReceipt(proposal.releaseRequestId);
  if (existingReceipt !== null) {
    const diff = findReceiptConflict(existingReceipt, proposal);
    if (diff !== null) {
      return { kind: 'conflict', reason: diff };
    }
    return { kind: 'existing_match', receipt: existingReceipt };
  }
  if (game.isStopConsumed(proposal.stopId)) {
    return {
      kind: 'consumed_stop',
      reason: `Stop "${proposal.stopId}" was already consumed by an earlier release request`,
    };
  }
  return { kind: 'not_released' };
}

/** Asserts that a release retry is valid and returns its existing receipt, or throws GameError. */
export function assertReleaseRetryValid(
  game: Game,
  proposal: ReleaseProposalParams,
): AdjudicationReleaseReceipt {
  const result = inspectReleaseRetry(game, proposal);
  if (result.kind === 'conflict') {
    throw new GameError(`Release request conflict for "${proposal.releaseRequestId}": ${result.reason}`);
  }
  if (result.kind === 'consumed_stop') {
    throw new GameError(`New release request rejected: ${result.reason}`);
  }
  if (result.kind === 'not_released') {
    throw new GameError(`Release request "${proposal.releaseRequestId}" has not been recorded`);
  }
  return result.receipt;
}

function assertReleaseEventFields(event: AdjudicationClocksStartedEvent): void {
  if (typeof event.releaseRequestId !== 'string' || event.releaseRequestId.length === 0) {
    throw new GameError('AdjudicationClocksStarted releaseRequestId must be a non-empty string');
  }
  if (typeof event.stopId !== 'string' || event.stopId.length === 0) {
    throw new GameError('AdjudicationClocksStarted stopId must be a non-empty string');
  }
  if (typeof event.rulesVersion !== 'string' || event.rulesVersion.length === 0) {
    throw new GameError('AdjudicationClocksStarted rulesVersion must be a non-empty string');
  }
  validateClockPolicy(event.clockPolicy);
  validateSafeNonNegativeInteger(event.at, 'AdjudicationClocksStarted at');
  validateSafeNonNegativeInteger(event.originatingResolvedSeq, 'originatingResolvedSeq');
  validateSafeNonNegativeInteger(event.completionHead, 'completionHead');
  validateSafeNonNegativeInteger(event.expectedHead, 'expectedHead');
  validateSafeNonNegativeInteger(event.ply, 'ply');
}

function assertReleaseStatePreconditions(
  state: GameState,
  event: AdjudicationClocksStartedEvent,
): void {
  if (state.phase !== 'idle') {
    throw new GameError(`Cannot release adjudication clocks in phase "${state.phase}"`);
  }
  if (state.status.over) {
    throw new GameError('Cannot release adjudication clocks on a finished game');
  }
  if (state.clockPolicy !== 'observed-release-v1') {
    throw new GameError('AdjudicationClocksStarted requires active observed-release-v1 clock policy');
  }
  if (event.gameId !== state.gameId) {
    throw new GameError(`AdjudicationClocksStarted gameId mismatch: expected "${state.gameId}", got "${event.gameId}"`);
  }
  if (state.releaseReceipts.has(event.releaseRequestId)) {
    throw new GameError(`Duplicate committed AdjudicationClocksStarted event rejected: "${event.releaseRequestId}"`);
  }
  if (event.expectedHead !== state.eventSequence) {
    throw new GameError(`AdjudicationClocksStarted expectedHead mismatch: expected ${state.eventSequence}, got ${event.expectedHead}`);
  }
  if (state.stoppedClock === null) {
    throw new GameError('No outstanding stopped adjudication clock completion to release');
  }
}

function assertReleaseLineageMatch(
  stopped: GameStoppedClockState,
  event: AdjudicationClocksStartedEvent,
  currentTurn: Color,
  currentPly: number,
): void {
  if (event.stopId !== stopped.stopId) {
    throw new GameError(`AdjudicationClocksStarted stopId mismatch: expected "${stopped.stopId}", got "${event.stopId}"`);
  }
  if (event.originatingOperationId !== stopped.originatingOperationId) {
    throw new GameError(`AdjudicationClocksStarted originatingOperationId mismatch: expected "${stopped.originatingOperationId}", got "${event.originatingOperationId}"`);
  }
  if (event.originatingResolvedSeq !== stopped.originatingResolvedSeq) {
    throw new GameError(`AdjudicationClocksStarted originatingResolvedSeq mismatch: expected ${stopped.originatingResolvedSeq}, got ${event.originatingResolvedSeq}`);
  }
  if (event.completionHead !== stopped.completionHead) {
    throw new GameError(`AdjudicationClocksStarted completionHead mismatch: expected ${stopped.completionHead}, got ${event.completionHead}`);
  }
  if (event.turnLineageId !== stopped.turnLineageId) {
    throw new GameError(`AdjudicationClocksStarted turnLineageId mismatch: expected "${stopped.turnLineageId}", got "${event.turnLineageId}"`);
  }
  if (event.side !== currentTurn) {
    throw new GameError(`AdjudicationClocksStarted side mismatch: expected "${currentTurn}", got "${event.side}"`);
  }
  if (event.ply !== currentPly) {
    throw new GameError(`AdjudicationClocksStarted ply mismatch: expected ${currentPly}, got ${event.ply}`);
  }
  if (event.rulesVersion !== stopped.rulesVersion) {
    throw new GameError(`AdjudicationClocksStarted rulesVersion mismatch: expected "${stopped.rulesVersion}", got "${event.rulesVersion}"`);
  }
}

function assertReleaseCausalBounds(
  event: AdjudicationClocksStartedEvent,
  causalFloor: number,
  stoppedAt: number | null,
): void {
  if (event.at < causalFloor) {
    throw new GameError(`Release anchor ${event.at} cannot precede active causal floor ${causalFloor}`);
  }
  if (stoppedAt !== null && event.at < stoppedAt) {
    throw new GameError(`Release anchor ${event.at} cannot precede last stop observation ${stoppedAt}`);
  }
}

function assertReleaseDeadlinesValid(
  stoppedBasis: AdjudicationClockBasis,
  atS: number,
  tc: TimeControl,
  chessApplicable: boolean,
): void {
  if (stoppedBasis.noShowRemainderMs !== null) {
    const sum = atS + stoppedBasis.noShowRemainderMs;
    if (!Number.isSafeInteger(sum) || sum > MAX_SAFE_TIMESTAMP_MS) {
      throw new GameError(`No-show deadline overflow: ${atS} + ${stoppedBasis.noShowRemainderMs} exceeds ${MAX_SAFE_TIMESTAMP_MS}`);
    }
  }
  if (chessApplicable) {
    const candidateBasis = deriveReleasedBasis(stoppedBasis, atS, tc, true);
    computeFlagDeadline(candidateBasis, tc);
  }
}

/** Evaluates whether either chess or no-show countdown applies upon release. */
export function isCountdownApplicable(
  source: GameSource | null | undefined,
  ply: number,
  tc: TimeControl,
  noShowRemainder: number | null,
): boolean {
  const chessApplicable = isChessClockApplicable(source, ply, tc);
  const noShowApplicable = noShowRemainder !== null;
  return chessApplicable || noShowApplicable;
}

/** Validates all structural, lineage, and causal preconditions of a recorded release event. */
export function validateRecordedReleaseEvent(
  state: GameState,
  event: AdjudicationClocksStartedEvent,
  causalFloor: number,
): boolean {
  assertReleaseEventFields(event);
  assertReleaseStatePreconditions(state, event);
  const stopped = state.stoppedClock!;
  assertReleaseLineageMatch(stopped, event, state.position.turn, state.ply);
  assertReleaseCausalBounds(event, causalFloor, stopped.basis.stoppedAt);

  const chessApplicable = isChessClockApplicable(state.source, state.ply, state.timeControl);
  const noShowApplicable = stopped.basis.noShowRemainderMs !== null;
  if (!chessApplicable && !noShowApplicable) {
    throw new GameError('Cannot release adjudication clocks: no countdown is applicable');
  }
  assertReleaseDeadlinesValid(stopped.basis, event.at, state.timeControl, chessApplicable);
  return chessApplicable;
}

function deriveReleasedBasis(
  stoppedBasis: AdjudicationClockBasis,
  atS: number,
  tc: TimeControl,
  isChessApplicable: boolean,
): AdjudicationClockBasis {
  if (isChessApplicable) {
    return releaseClockBasis(stoppedBasis, atS, tc);
  }
  return createAdjudicationClockBasis({
    initialBalances: stoppedBasis.turnBaseBalances,
    elapsedThinkingMs: stoppedBasis.elapsedThinkingMs,
    sideToMove: stoppedBasis.sideToMove,
    ply: stoppedBasis.ply,
    runningSince: null,
    stoppedAt: atS,
    stopId: stoppedBasis.stopId,
    originatingCompletionId: stoppedBasis.originatingCompletionId,
    policy: stoppedBasis.policy,
    noShowRemainderMs: stoppedBasis.noShowRemainderMs,
  });
}

/** Builds the new GameReleasedClockState and AdjudicationReleaseReceipt records for folding. */
export function buildReleasedClockState(
  state: GameState,
  event: AdjudicationClocksStartedEvent,
  isChessApplicable: boolean,
): { releasedClock: GameReleasedClockState; receipt: AdjudicationReleaseReceipt } {
  const stopped = state.stoppedClock!;
  const basis = deriveReleasedBasis(stopped.basis, event.at, state.timeControl, isChessApplicable);
  const noShowRunningSince = stopped.basis.noShowRemainderMs !== null ? event.at : null;

  const releasedClock: GameReleasedClockState = Object.freeze({
    basis,
    consumedStopId: stopped.stopId,
    originatingOperationId: stopped.originatingOperationId,
    originatingResolvedSeq: stopped.originatingResolvedSeq,
    startedSeq: stopped.startedSeq,
    rulesVersion: stopped.rulesVersion,
    turnLineageId: stopped.turnLineageId,
    parentStopId: stopped.parentStopId,
    completionHead: stopped.completionHead,
    releaseRequestId: event.releaseRequestId,
    releaseSeq: state.eventSequence + 1,
    releasedAt: event.at,
    isChessApplicable,
    noShowRunningSince,
  });

  const receipt: AdjudicationReleaseReceipt = Object.freeze({
    releaseRequestId: event.releaseRequestId,
    gameId: event.gameId,
    stopId: event.stopId,
    originatingOperationId: event.originatingOperationId,
    originatingResolvedSeq: event.originatingResolvedSeq,
    completionHead: event.completionHead,
    expectedHead: event.expectedHead,
    releaseSeq: state.eventSequence + 1,
    at: event.at,
    turnLineageId: event.turnLineageId,
    side: event.side,
    ply: event.ply,
    clockPolicy: event.clockPolicy,
    rulesVersion: event.rulesVersion,
  });

  return { releasedClock, receipt };
}

function freezeReleasedUnstartedChessBasis(
  released: GameReleasedClockState,
  atA: number,
): AdjudicationClockBasis {
  let nextNoShow = released.basis.noShowRemainderMs;
  if (released.noShowRunningSince !== null && nextNoShow !== null) {
    const elapsed = Math.max(0, atA - released.noShowRunningSince);
    nextNoShow = Math.max(0, nextNoShow - elapsed);
  }
  return createAdjudicationClockBasis({
    initialBalances: released.basis.turnBaseBalances,
    elapsedThinkingMs: released.basis.elapsedThinkingMs,
    sideToMove: released.basis.sideToMove,
    ply: released.basis.ply,
    runningSince: null,
    stoppedAt: atA,
    stopId: released.consumedStopId,
    originatingCompletionId: released.originatingOperationId,
    policy: 'observed-release-v1',
    noShowRemainderMs: nextNoShow,
  });
}

/** Freezes released accounting basis at command instant A. */
export function freezeReleasedClockBasis(
  released: GameReleasedClockState,
  atA: number,
  tc: TimeControl,
): AdjudicationClockBasis {
  if (atA < released.releasedAt) {
    throw new GameError(`Suspension timestamp ${atA} cannot precede release anchor ${released.releasedAt}`);
  }
  if (released.isChessApplicable) {
    return freezeClockBasis(released.basis, atA, tc);
  }
  return freezeReleasedUnstartedChessBasis(released, atA);
}

/** Resolves the active causal floor from the game state record. */
export function getActiveCausalBasis(state: GameState): number {
  let basis = state.createdAt;
  if (state.clock.turnStartedAt !== null && state.clock.turnStartedAt > basis) {
    basis = state.clock.turnStartedAt;
  }
  if (state.lastResolutionAt !== null && state.lastResolutionAt !== undefined && state.lastResolutionAt > basis) {
    basis = state.lastResolutionAt;
  }
  if (state.releasedClock !== null && state.releasedClock.releasedAt > basis) {
    basis = state.releasedClock.releasedAt;
  }
  if (state.moves.length > 0) {
    const lastMoveAt = state.moves[state.moves.length - 1].at;
    if (lastMoveAt > basis) {
      basis = lastMoveAt;
    }
  }
  return basis;
}

/** Validates a standalone recorded release batch structurally against the preceding game state. */
export function validateStandaloneRecordedReleaseBatch(
  before: Game,
  event: AdjudicationClocksStartedEvent,
): void {
  const state = before.snapshot();
  const causalFloor = getActiveCausalBasis(state);
  validateRecordedReleaseEvent(state, event, causalFloor);
}

