/**
 * @packageDocumentation
 * Narrowly-owned stopped-turn clock completion helper (Issue #124, Stage R1).
 *
 * Implements:
 * - Deterministic clock completion descriptor construction and replay validation.
 * - Stopped-turn basis transitions, deep cloning, and integer guard checks.
 * - Unified post-effect completion finalizer across all four completion exits.
 */

import type { Color } from '@chess-platform/core';
import type {
  AdjudicationClockCompletionDescriptor,
  AdjudicationClockPolicy,
  AdjudicationClockStoppedDescriptor,
  AdjudicationClockTerminalDescriptor,
  GameSource,
} from './events';
import type { TimeControl } from './clock';
import { GameError, MAX_SAFE_TIMESTAMP_MS } from './clock';
import {
  type AdjudicationClockBasis,
  createAdjudicationClockBasis,
  freezeClockBasis,
  validateTimeControl,
} from './adjudication-clock-accounting';
import {
  type GameReleasedClockState,
  freezeReleasedClockBasis,
} from './adjudication-release';

/** State record capturing a game's stopped-turn clock accounting basis and lineage. */
export interface GameStoppedClockState {
  readonly basis: AdjudicationClockBasis;
  readonly stopId: string;
  readonly originatingOperationId: string;
  readonly originatingResolvedSeq: number;
  readonly startedSeq: number;
  readonly rulesVersion: string;
  readonly turnLineageId: string;
  readonly parentStopId: string | null;
  readonly completionHead: number;
}

/** Asserts that a value matches the supported clock management policy. */
export function validateClockPolicy(policy: unknown): asserts policy is AdjudicationClockPolicy {
  if (policy !== 'observed-release-v1') {
    throw new GameError(`Unsupported or invalid clock policy: ${String(policy)}`);
  }
}

function validateBoundedInteger(val: unknown, name: string): void {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > MAX_SAFE_TIMESTAMP_MS) {
    throw new GameError(`${name} must be a non-negative safe integer <= ${MAX_SAFE_TIMESTAMP_MS}; got ${val}`);
  }
}

/** Validates that policy inputs adhere to the strict integer contracts of observed-release-v1. */
export function validateIntegerPolicyInputs(
  tc: TimeControl,
  balances: { readonly w: number; readonly b: number },
  noShowRemainderMs?: number | null,
): void {
  validateTimeControl(tc);
  validateBoundedInteger(balances.w, 'balances.w');
  validateBoundedInteger(balances.b, 'balances.b');
  if (noShowRemainderMs !== undefined && noShowRemainderMs !== null) {
    validateBoundedInteger(noShowRemainderMs, 'noShowRemainderMs');
  }
}

/** Derives deterministic stopId from originating operation and resolution sequence. */
export function deriveStopId(operationId: string, resolvedSeq: number): string {
  return `stop:${operationId}:${resolvedSeq}`;
}

/** Evaluates whether finite chess clock countdown applies given source, ply, and time control. */
export function isChessClockApplicable(
  source: GameSource | null | undefined,
  ply: number,
  tc: TimeControl,
): boolean {
  if (tc.kind === 'unlimited') return false;
  if ((source === 'tournament' || source === 'seek') && ply === 0) return false;
  return true;
}

/** Derives stable turn-lineage identity. */
export function deriveTurnLineageId(
  gameId: string,
  ply: number,
  parentTurnLineageId?: string | null,
  isNewTurn?: boolean,
): string {
  if (isNewTurn || typeof parentTurnLineageId !== 'string' || !parentTurnLineageId) {
    return `turn:${gameId}:${ply}`;
  }
  return parentTurnLineageId;
}

/** Parameters for constructing an adjudication clock completion descriptor. */
export interface BuildCompletionDescriptorParams {
  readonly policy: AdjudicationClockPolicy;
  readonly isTerminal: boolean;
  readonly operationId: string;
  readonly startedSeq: number;
  readonly resolvedSeq: number;
  readonly effectCount: number;
  readonly resultingSideToMove: Color;
  readonly resultingPly: number;
  readonly turnLineageId: string;
  readonly parentStopId: string | null;
}

/** Builds an immutable, deterministic clock completion descriptor for AdjudicationResolved. */
export function buildClockCompletionDescriptor(
  params: BuildCompletionDescriptorParams,
): AdjudicationClockCompletionDescriptor {
  validateClockPolicy(params.policy);
  const completionHead = params.resolvedSeq + params.effectCount;
  if (params.isTerminal) {
    const term: AdjudicationClockTerminalDescriptor = {
      policy: 'observed-release-v1',
      kind: 'terminal',
      originatingOperationId: params.operationId,
      startedSeq: params.startedSeq,
      resolvedSeq: params.resolvedSeq,
      completionHead,
      runningSince: null,
    };
    return Object.freeze(term);
  }
  const stopId = deriveStopId(params.operationId, params.resolvedSeq);
  const stopped: AdjudicationClockStoppedDescriptor = {
    policy: 'observed-release-v1',
    kind: 'stopped',
    stopId,
    originatingOperationId: params.operationId,
    startedSeq: params.startedSeq,
    resolvedSeq: params.resolvedSeq,
    completionHead,
    resultingSideToMove: params.resultingSideToMove,
    resultingPly: params.resultingPly,
    turnLineageId: params.turnLineageId,
    parentStopId: params.parentStopId,
    runningSince: null,
  };
  return Object.freeze(stopped);
}

function assertStoppedSequences(
  actual: AdjudicationClockStoppedDescriptor,
  expected: AdjudicationClockStoppedDescriptor,
): void {
  if (actual.stopId !== expected.stopId) {
    throw new GameError(`AdjudicationResolved stopId mismatch: expected "${expected.stopId}", got "${actual.stopId}"`);
  }
  if (actual.originatingOperationId !== expected.originatingOperationId) {
    throw new GameError('AdjudicationResolved originatingOperationId mismatch in clockCompletion');
  }
  if (actual.startedSeq !== expected.startedSeq) {
    throw new GameError(`AdjudicationResolved startedSeq mismatch in clockCompletion: expected ${expected.startedSeq}, got ${actual.startedSeq}`);
  }
  if (actual.resolvedSeq !== expected.resolvedSeq) {
    throw new GameError(`AdjudicationResolved resolvedSeq mismatch in clockCompletion: expected ${expected.resolvedSeq}, got ${actual.resolvedSeq}`);
  }
  if (actual.completionHead !== expected.completionHead) {
    throw new GameError(`AdjudicationResolved completionHead mismatch in clockCompletion: expected ${expected.completionHead}, got ${actual.completionHead}`);
  }
}

function assertStoppedLineage(
  actual: AdjudicationClockStoppedDescriptor,
  expected: AdjudicationClockStoppedDescriptor,
): void {
  if (actual.resultingSideToMove !== expected.resultingSideToMove) {
    throw new GameError(`AdjudicationResolved resultingSideToMove mismatch in clockCompletion: expected "${expected.resultingSideToMove}", got "${actual.resultingSideToMove}"`);
  }
  if (actual.resultingPly !== expected.resultingPly) {
    throw new GameError(`AdjudicationResolved resultingPly mismatch in clockCompletion: expected ${expected.resultingPly}, got ${actual.resultingPly}`);
  }
  if (actual.turnLineageId !== expected.turnLineageId) {
    throw new GameError(`AdjudicationResolved turnLineageId mismatch in clockCompletion: expected "${expected.turnLineageId}", got "${actual.turnLineageId}"`);
  }
  if (actual.parentStopId !== expected.parentStopId) {
    throw new GameError(`AdjudicationResolved parentStopId mismatch in clockCompletion: expected "${expected.parentStopId}", got "${actual.parentStopId}"`);
  }
  if (actual.runningSince !== null) {
    throw new GameError('AdjudicationResolved runningSince must be null in clockCompletion');
  }
}

function assertStoppedDescriptorProperties(
  actual: AdjudicationClockStoppedDescriptor,
  expected: AdjudicationClockStoppedDescriptor,
): void {
  assertStoppedSequences(actual, expected);
  assertStoppedLineage(actual, expected);
}

function assertTerminalDescriptorProperties(
  actual: AdjudicationClockTerminalDescriptor,
  expected: AdjudicationClockTerminalDescriptor,
): void {
  if (actual.originatingOperationId !== expected.originatingOperationId) {
    throw new GameError('AdjudicationResolved originatingOperationId mismatch in terminal clockCompletion');
  }
  if (actual.startedSeq !== expected.startedSeq) {
    throw new GameError(`AdjudicationResolved startedSeq mismatch in terminal clockCompletion: expected ${expected.startedSeq}, got ${actual.startedSeq}`);
  }
  if (actual.resolvedSeq !== expected.resolvedSeq) {
    throw new GameError(`AdjudicationResolved resolvedSeq mismatch in terminal clockCompletion: expected ${expected.resolvedSeq}, got ${actual.resolvedSeq}`);
  }
  if (actual.completionHead !== expected.completionHead) {
    throw new GameError(`AdjudicationResolved completionHead mismatch in terminal clockCompletion: expected ${expected.completionHead}, got ${actual.completionHead}`);
  }
  if (actual.runningSince !== null) {
    throw new GameError('AdjudicationResolved runningSince must be null in terminal clockCompletion');
  }
}

function assertDescriptorKindMatch(
  actual: AdjudicationClockCompletionDescriptor,
  expected: AdjudicationClockCompletionDescriptor,
): void {
  if (actual.kind !== expected.kind) {
    throw new GameError(`clockCompletion kind mismatch: expected "${expected.kind}", got "${actual.kind}"`);
  }
  if (actual.kind === 'terminal' && expected.kind === 'terminal') {
    assertTerminalDescriptorProperties(actual, expected);
    return;
  }
  if (actual.kind === 'stopped' && expected.kind === 'stopped') {
    assertStoppedDescriptorProperties(actual, expected);
  }
}

/** Asserts that a recorded clock completion descriptor strictly equals expected deterministic derivation. */
export function assertClockCompletionDescriptorMatch(
  actual: AdjudicationClockCompletionDescriptor | undefined,
  expected: AdjudicationClockCompletionDescriptor | undefined,
): void {
  if (expected === undefined) {
    if (actual !== undefined) {
      throw new GameError('AdjudicationResolved carries unexpected clockCompletion descriptor on legacy operation');
    }
    return;
  }
  if (!actual) {
    throw new GameError('AdjudicationResolved missing required clockCompletion descriptor for observed-release-v1');
  }
  if (actual.policy !== expected.policy) {
    throw new GameError(`clockCompletion policy mismatch: expected "${expected.policy}", got "${actual.policy}"`);
  }
  assertDescriptorKindMatch(actual, expected);
}

/** Deeply clones and freezes a GameStoppedClockState instance. */
export function cloneStoppedClockState(sc: GameStoppedClockState | null): GameStoppedClockState | null {
  if (sc === null) return null;
  const balances = Object.freeze({
    w: sc.basis.turnBaseBalances.w,
    b: sc.basis.turnBaseBalances.b,
  });
  const clonedBasis = Object.freeze({
    ...sc.basis,
    turnBaseBalances: balances,
  });
  return Object.freeze({
    basis: clonedBasis,
    stopId: sc.stopId,
    originatingOperationId: sc.originatingOperationId,
    originatingResolvedSeq: sc.originatingResolvedSeq ?? 0,
    startedSeq: sc.startedSeq ?? 0,
    rulesVersion: sc.rulesVersion ?? '',
    turnLineageId: sc.turnLineageId,
    parentStopId: sc.parentStopId,
    completionHead: sc.completionHead,
  });
}

/** Context required to derive the initial or frozen basis for an AdjudicationStarted event. */
export interface InitStartedBasisParams {
  readonly clockPolicy?: AdjudicationClockPolicy;
  readonly stoppedClock: GameStoppedClockState | null;
  readonly releasedClock?: GameReleasedClockState | null;
  readonly timeControl: TimeControl;
  readonly turnStartedAt: number | null;
  readonly remainingBalances: { readonly w: number; readonly b: number };
  readonly sideToMove: Color;
  readonly ply: number;
  readonly atA: number;
  readonly noShowRemainderMs: number | null;
}

/** Derives the AdjudicationClockBasis at suspension instant A. */
export function deriveStartedBasis(params: InitStartedBasisParams): AdjudicationClockBasis | null {
  if (params.clockPolicy !== 'observed-release-v1') {
    return null;
  }
  validateIntegerPolicyInputs(params.timeControl, params.remainingBalances, params.noShowRemainderMs);

  if (params.stoppedClock !== null) {
    return freezeClockBasis(params.stoppedClock.basis, params.atA, params.timeControl);
  }
  if (params.releasedClock !== null && params.releasedClock !== undefined) {
    return freezeReleasedClockBasis(params.releasedClock, params.atA, params.timeControl);
  }

  // First managed operation on game: create initial basis
  const runningSince = params.turnStartedAt;
  const basis = createAdjudicationClockBasis({
    initialBalances: params.remainingBalances,
    elapsedThinkingMs: 0,
    sideToMove: params.sideToMove,
    ply: params.ply,
    runningSince,
    stoppedAt: params.turnStartedAt === null ? params.atA : null,
    policy: 'observed-release-v1',
    noShowRemainderMs: params.noShowRemainderMs,
  });
  return freezeClockBasis(basis, params.atA, params.timeControl);
}
