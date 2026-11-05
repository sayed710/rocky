/**
 * @packageDocumentation
 * Adjudication clock accounting foundation. Pure, deterministic functions
 * modeling retained stopped-turn clock accounting, turn/ply identity, running anchors,
 * delay and increment isolation, and independent no-show deadlines.
 *
 * Implements Issue #124 Stage 124f stopped-turn accounting foundation.
 */

import type { Color } from '@chess-platform/core';
import type { TimeControl } from './clock';
import { GameError, MAX_SAFE_TIMESTAMP_MS } from './clock';

/**
 * Retained turn clock accounting basis.
 * Models immutable pre-turn balances, accumulated active thinking,
 * turn/ply identity, running anchor, stop causality, stop lineage, and independent no-show remainder.
 */
export interface AdjudicationClockBasis {
  readonly turnBaseBalances: Readonly<{ readonly w: number; readonly b: number }>;
  readonly elapsedThinkingMs: number;
  readonly sideToMove: Color;
  readonly ply: number;
  readonly runningSince: number | null;
  readonly stoppedAt: number | null;
  readonly stopId: string | null;
  readonly originatingCompletionId: string | null;
  readonly policy: string | null;
  readonly noShowRemainderMs: number | null;
}

/** Parameters for initializing or creating an AdjudicationClockBasis. */
export interface CreateAdjudicationClockBasisParams {
  readonly initialBalances: Readonly<{ readonly w: number; readonly b: number }>;
  readonly elapsedThinkingMs?: number;
  readonly sideToMove?: Color;
  readonly ply?: number;
  readonly runningSince?: number | null;
  readonly stoppedAt?: number | null;
  readonly stopId?: string | null;
  readonly originatingCompletionId?: string | null;
  readonly policy?: string | null;
  readonly noShowRemainderMs?: number | null;
}

/** Authorization token for retained-timestamp races where T < S. */
export interface RetainedTimestampAuthorization {
  readonly stopId: string;
  readonly retainedTimestampMs: number;
}

/** Lineage metadata for stop/suspension/release tracking. */
export interface StopLineage {
  readonly stopId?: string | null;
  readonly originatingCompletionId?: string | null;
  readonly policy?: string | null;
}

/** Options when applying a completed turn. */
export interface ApplyCompletedTurnOptions {
  readonly auth?: RetainedTimestampAuthorization;
  readonly clearNoShow?: boolean;
  readonly nextLineage?: StopLineage;
}

/** Result of completing a turn on the clock accounting basis. */
export interface ClockTurnCompletion {
  readonly nextBasis: AdjudicationClockBasis;
  readonly moveTimeMs: number;
  readonly chargedMs: number;
  readonly flagged: boolean;
}

/** Complete accounting snapshot for client DTOs and inspectors. */
export interface ClockAccountingSnapshot {
  readonly displayBalances: Readonly<{ readonly w: number; readonly b: number }>;
  readonly activeThinkingMs: number;
  readonly remainingDelayMs: number;
  readonly flagDeadline: number | null;
  readonly noShowDeadline: number | null;
  readonly isRunning: boolean;
  readonly flagged: boolean;
}

function isNonNegativeSafeInteger(val: unknown, max: number): boolean {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 && val <= max;
}

function validateNonNegativeSafeInteger(
  val: unknown,
  name: string,
  max: number = MAX_SAFE_TIMESTAMP_MS,
): asserts val is number {
  if (!isNonNegativeSafeInteger(val, max)) {
    throw new GameError(`${name} must be a non-negative safe integer <= ${max}; got ${val}`);
  }
}

function validateRequiredTimestampOrNull(val: unknown, name: string): void {
  if (val === null) {
    return;
  }
  if (typeof val !== 'number') {
    throw new GameError(`${name} must be a number or null; got ${typeof val}`);
  }
  validateNonNegativeSafeInteger(val, name);
}

function validateRequiredStringOrNull(val: unknown, name: string): void {
  if (val === null) {
    return;
  }
  if (typeof val !== 'string') {
    throw new GameError(`${name} must be a string or null; got ${typeof val}`);
  }
}

function validateOptionalLineageString(val: unknown, name: string): void {
  if (val === undefined || val === null) {
    return;
  }
  if (typeof val !== 'string') {
    throw new GameError(`${name} must be a string or null; got ${typeof val}`);
  }
}

function validateLineage(lineage: unknown, name: string): void {
  if (lineage === undefined || lineage === null) {
    return;
  }
  if (typeof lineage !== 'object') {
    throw new GameError(`${name} must be an object`);
  }
  const l = lineage as StopLineage;
  validateOptionalLineageString(l.stopId, `${name}.stopId`);
  validateOptionalLineageString(l.originatingCompletionId, `${name}.originatingCompletionId`);
  validateOptionalLineageString(l.policy, `${name}.policy`);
}

function validateAuth(auth: unknown, name: string): void {
  if (auth === undefined || auth === null) {
    return;
  }
  if (typeof auth !== 'object') {
    throw new GameError(`${name} must be an object`);
  }
  const a = auth as RetainedTimestampAuthorization;
  if (typeof a.stopId !== 'string') {
    throw new GameError(`${name}.stopId must be a string`);
  }
  validateNonNegativeSafeInteger(a.retainedTimestampMs, `${name}.retainedTimestampMs`);
}

function validateApplyOptions(options: unknown): void {
  if (options === undefined || options === null) {
    return;
  }
  if (typeof options !== 'object') {
    throw new GameError('options must be an object');
  }
  const opts = options as ApplyCompletedTurnOptions;
  if (opts.clearNoShow !== undefined && typeof opts.clearNoShow !== 'boolean') {
    throw new GameError('options.clearNoShow must be a boolean');
  }
  validateLineage(opts.nextLineage, 'options.nextLineage');
  validateAuth(opts.auth, 'options.auth');
}

function validateSideToMove(side: unknown): asserts side is Color {
  if (side !== 'w' && side !== 'b') {
    throw new GameError(`sideToMove must be 'w' or 'b'; got ${side}`);
  }
}

function validateTimeControlKind(kind: unknown): asserts kind is TimeControl['kind'] {
  if (kind !== 'increment' && kind !== 'delay' && kind !== 'sudden_death' && kind !== 'unlimited') {
    throw new GameError(`Invalid time control kind: ${kind}`);
  }
}

/** Validates that a TimeControl satisfies integer bounds and valid kinds. */
export function validateTimeControl(tc: TimeControl): void {
  if (!tc || typeof tc !== 'object') {
    throw new GameError('TimeControl must be an object');
  }
  validateTimeControlKind(tc.kind);
  validateNonNegativeSafeInteger(tc.initialMs, 'tc.initialMs');
  validateNonNegativeSafeInteger(tc.incrementMs, 'tc.incrementMs');
  validateNonNegativeSafeInteger(tc.delayMs, 'tc.delayMs');
}

function cloneBalances(
  balances: Readonly<{ readonly w: number; readonly b: number }>,
): Readonly<{ readonly w: number; readonly b: number }> {
  return Object.freeze({ w: balances.w, b: balances.b });
}

function validateTurnBaseBalances(balances: unknown): asserts balances is Readonly<{ w: number; b: number }> {
  if (!balances || typeof balances !== 'object') {
    throw new GameError('turnBaseBalances must be an object');
  }
  const b = balances as { readonly w: number; readonly b: number };
  validateNonNegativeSafeInteger(b.w, 'turnBaseBalances.w');
  validateNonNegativeSafeInteger(b.b, 'turnBaseBalances.b');
}

/** Validates that an adjudication clock basis conforms to numeric and structural contracts. */
export function validateClockBasis(basis: AdjudicationClockBasis): void {
  if (!basis || typeof basis !== 'object') {
    throw new GameError('basis must be an object');
  }
  validateTurnBaseBalances(basis.turnBaseBalances);
  validateNonNegativeSafeInteger(basis.elapsedThinkingMs, 'elapsedThinkingMs');
  validateSideToMove(basis.sideToMove);
  validateNonNegativeSafeInteger(basis.ply, 'ply', Number.MAX_SAFE_INTEGER);
  validateRequiredTimestampOrNull(basis.runningSince, 'runningSince');
  validateRequiredTimestampOrNull(basis.stoppedAt, 'stoppedAt');
  validateRequiredTimestampOrNull(basis.noShowRemainderMs, 'noShowRemainderMs');
  validateRequiredStringOrNull(basis.stopId, 'stopId');
  validateRequiredStringOrNull(basis.originatingCompletionId, 'originatingCompletionId');
  validateRequiredStringOrNull(basis.policy, 'policy');
}

function resolveConstructorNumber(
  val: unknown,
  name: string,
  defaultVal: number,
  max: number = MAX_SAFE_TIMESTAMP_MS,
): number {
  if (val === undefined) {
    return defaultVal;
  }
  validateNonNegativeSafeInteger(val, name, max);
  return val;
}

function resolveConstructorSide(val: unknown): Color {
  if (val === undefined) {
    return 'w';
  }
  validateSideToMove(val);
  return val;
}

function resolveConstructorTimestampOrNull(val: unknown, name: string): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  validateNonNegativeSafeInteger(val, name);
  return val;
}

function resolveConstructorStringOrNull(val: unknown, name: string): string | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'string') {
    throw new GameError(`${name} must be a string or null; got ${typeof val}`);
  }
  return val;
}

function resolveNextLineageField(
  lineageVal: unknown,
  currentVal: string | null,
  name: string,
): string | null {
  if (lineageVal === undefined) {
    return currentVal;
  }
  if (lineageVal === null) {
    return null;
  }
  if (typeof lineageVal !== 'string') {
    throw new GameError(`${name} must be a string or null; got ${typeof lineageVal}`);
  }
  return lineageVal;
}

/** Creates a deeply frozen, owned AdjudicationClockBasis. */
export function createAdjudicationClockBasis(
  params: CreateAdjudicationClockBasisParams,
): AdjudicationClockBasis {
  if (!params || typeof params !== 'object') {
    throw new GameError('params must be an object');
  }
  validateTurnBaseBalances(params.initialBalances);
  const elapsed = resolveConstructorNumber(params.elapsedThinkingMs, 'elapsedThinkingMs', 0);
  const ply = resolveConstructorNumber(params.ply, 'ply', 0, Number.MAX_SAFE_INTEGER);
  const side = resolveConstructorSide(params.sideToMove);
  const runningSince = resolveConstructorTimestampOrNull(params.runningSince, 'runningSince');
  const stoppedAt = resolveConstructorTimestampOrNull(params.stoppedAt, 'stoppedAt');
  const noShow = resolveConstructorTimestampOrNull(params.noShowRemainderMs, 'noShowRemainderMs');
  const stopId = resolveConstructorStringOrNull(params.stopId, 'stopId');
  const originId = resolveConstructorStringOrNull(params.originatingCompletionId, 'originatingCompletionId');
  const policy = resolveConstructorStringOrNull(params.policy, 'policy');

  const basis: AdjudicationClockBasis = {
    turnBaseBalances: cloneBalances(params.initialBalances),
    elapsedThinkingMs: elapsed,
    sideToMove: side,
    ply,
    runningSince,
    stoppedAt,
    stopId,
    originatingCompletionId: originId,
    policy,
    noShowRemainderMs: noShow,
  };
  return Object.freeze(basis);
}

function authorizeBackwardTime(
  basis: AdjudicationClockBasis,
  now: number,
  runningSince: number,
  auth?: RetainedTimestampAuthorization,
): number {
  if (!auth) {
    throw new GameError(
      `Timestamp ${now} precedes release anchor ${runningSince} without matching retained lineage authorization`,
    );
  }
  if (!basis.stopId || auth.stopId !== basis.stopId) {
    throw new GameError(
      `Timestamp ${now} precedes release anchor ${runningSince} with mismatched stop lineage ${auth.stopId} vs ${basis.stopId}`,
    );
  }
  if (auth.retainedTimestampMs !== now) {
    throw new GameError(
      `Timestamp ${now} does not match retained authorization timestamp ${auth.retainedTimestampMs}`,
    );
  }
  return 0;
}

function resolveRunningElapsed(
  basis: AdjudicationClockBasis,
  now: number,
  auth?: RetainedTimestampAuthorization,
): number {
  if (basis.runningSince === null) {
    return 0;
  }
  const S = basis.runningSince;
  if (now < S) {
    return authorizeBackwardTime(basis, now, S, auth);
  }
  return now - S;
}

function validateTemporalAdmissibility(
  basis: AdjudicationClockBasis,
  now: number,
  auth?: RetainedTimestampAuthorization,
): number {
  validateNonNegativeSafeInteger(now, 'Timestamp');
  if (basis.stoppedAt !== null && now < basis.stoppedAt) {
    throw new GameError(`Query timestamp ${now} cannot precede last stop observation ${basis.stoppedAt}`);
  }
  return resolveRunningElapsed(basis, now, auth);
}

function safeAdd(
  a: number,
  b: number,
  name: string,
  max: number = MAX_SAFE_TIMESTAMP_MS,
): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > max) {
    throw new GameError(`${name} overflow: ${a} + ${b} exceeds ${max}`);
  }
  return sum;
}

/** Computes total active thinking time spent this turn excluding stopped intervals. */
export function computeActiveThinkingMs(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  auth?: RetainedTimestampAuthorization,
): number {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateAuth(auth, 'auth');
  const runningElapsed = validateTemporalAdmissibility(basis, now, auth);
  if (tc.kind === 'unlimited') {
    return 0;
  }
  return safeAdd(basis.elapsedThinkingMs, runningElapsed, 'Active thinking');
}

/** Computes remaining delay time for the current turn. Never refreshed by repeated stops. */
export function computeRemainingDelayMs(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  auth?: RetainedTimestampAuthorization,
): number {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateAuth(auth, 'auth');
  const runningElapsed = validateTemporalAdmissibility(basis, now, auth);
  if (tc.kind !== 'delay') {
    return 0;
  }
  const totalActive = safeAdd(basis.elapsedThinkingMs, runningElapsed, 'Active thinking');
  return Math.max(0, tc.delayMs - totalActive);
}

/** Computes displayed clock balances at instant `now`. */
export function computeDisplayBalances(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  auth?: RetainedTimestampAuthorization,
): Readonly<{ readonly w: number; readonly b: number }> {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateAuth(auth, 'auth');
  const runningElapsed = validateTemporalAdmissibility(basis, now, auth);
  if (tc.kind === 'unlimited') {
    return cloneBalances(basis.turnBaseBalances);
  }
  const mover = basis.sideToMove;
  const totalActive = safeAdd(basis.elapsedThinkingMs, runningElapsed, 'Active thinking');
  const delay = tc.kind === 'delay' ? tc.delayMs : 0;
  const chargeable = Math.max(0, totalActive - delay);
  const moverRemaining = Math.max(0, basis.turnBaseBalances[mover] - chargeable);

  const balances = mover === 'w'
    ? { w: moverRemaining, b: basis.turnBaseBalances.b }
    : { w: basis.turnBaseBalances.w, b: moverRemaining };
  return cloneBalances(balances);
}

/** Computes flag deadline instant, or null if clock is stopped or unlimited. */
export function computeFlagDeadline(
  basis: AdjudicationClockBasis,
  tc: TimeControl,
): number | null {
  validateClockBasis(basis);
  validateTimeControl(tc);
  if (tc.kind === 'unlimited' || basis.runningSince === null) {
    return null;
  }
  const mover = basis.sideToMove;
  const baseBalance = basis.turnBaseBalances[mover];
  const delay = tc.kind === 'delay' ? tc.delayMs : 0;
  const totalAllowance = safeAdd(delay, baseBalance, 'Total time allowance');

  const stoppedChargeable = Math.max(0, basis.elapsedThinkingMs - delay);
  if (baseBalance - stoppedChargeable <= 0) {
    return basis.runningSince;
  }

  const remainingAllowance = totalAllowance - basis.elapsedThinkingMs;
  return safeAdd(basis.runningSince, remainingAllowance, 'Flag deadline');
}

/** Evaluates whether the side to move has flagged at instant `now`. */
export function hasFlaggedAt(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  auth?: RetainedTimestampAuthorization,
): boolean {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateAuth(auth, 'auth');
  const balances = computeDisplayBalances(basis, now, tc, auth);
  if (tc.kind === 'unlimited') {
    return false;
  }
  return balances[basis.sideToMove] <= 0;
}

/** Computes independent no-show deadline instant, or null if absent or stopped. */
export function computeNoShowDeadline(basis: AdjudicationClockBasis): number | null {
  validateClockBasis(basis);
  if (basis.runningSince === null || basis.noShowRemainderMs === null) {
    return null;
  }
  if (basis.noShowRemainderMs === 0) {
    return basis.runningSince;
  }
  return safeAdd(basis.runningSince, basis.noShowRemainderMs, 'No-show deadline');
}

/** Evaluates whether the no-show forfeit deadline has elapsed at instant `now`. */
export function isNoShowDueAt(basis: AdjudicationClockBasis, now: number): boolean {
  validateClockBasis(basis);
  validateTemporalAdmissibility(basis, now);
  const deadline = computeNoShowDeadline(basis);
  if (deadline === null) {
    return false;
  }
  return now >= deadline;
}

function computeNextNoShowRemainder(
  basis: AdjudicationClockBasis,
  runningElapsed: number,
  clearNoShow?: boolean,
): number | null {
  if (clearNoShow || basis.noShowRemainderMs === null) {
    return null;
  }
  if (basis.noShowRemainderMs === 0) {
    return 0;
  }
  return Math.max(0, basis.noShowRemainderMs - runningElapsed);
}

/** Freezes the clock basis at suspension instant `atR`, retaining pre-turn balances and causality. */
export function freezeClockBasis(
  basis: AdjudicationClockBasis,
  atR: number,
  tc: TimeControl,
  lineage?: StopLineage,
): AdjudicationClockBasis {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateLineage(lineage, 'lineage');
  validateNonNegativeSafeInteger(atR, 'Freeze timestamp');
  if (basis.stoppedAt !== null && atR < basis.stoppedAt) {
    throw new GameError(`Freeze timestamp ${atR} cannot precede last stop observation ${basis.stoppedAt}`);
  }

  let newElapsed = basis.elapsedThinkingMs;
  let runningElapsed = 0;
  if (basis.runningSince !== null) {
    if (atR < basis.runningSince) {
      throw new GameError(
        `Suspension timestamp ${atR} cannot precede release anchor ${basis.runningSince}`,
      );
    }
    runningElapsed = atR - basis.runningSince;
    if (tc.kind !== 'unlimited') {
      newElapsed = safeAdd(basis.elapsedThinkingMs, runningElapsed, 'Cumulative active thinking');
    }
  }

  const frozen: AdjudicationClockBasis = {
    turnBaseBalances: cloneBalances(basis.turnBaseBalances),
    elapsedThinkingMs: newElapsed,
    sideToMove: basis.sideToMove,
    ply: basis.ply,
    runningSince: null,
    stoppedAt: atR,
    stopId: resolveNextLineageField(lineage?.stopId, basis.stopId, 'lineage.stopId'),
    originatingCompletionId: resolveNextLineageField(
      lineage?.originatingCompletionId,
      basis.originatingCompletionId,
      'lineage.originatingCompletionId',
    ),
    policy: resolveNextLineageField(lineage?.policy, basis.policy, 'lineage.policy'),
    noShowRemainderMs: computeNextNoShowRemainder(basis, runningElapsed, false),
  };
  return Object.freeze(frozen);
}

function resolveReleaseAnchors(
  tcKind: TimeControl['kind'],
  noShowRemainderMs: number | null,
  atS: number,
): { readonly runningSince: number | null; readonly stoppedAt: number | null } {
  if (tcKind === 'unlimited' && noShowRemainderMs === null) {
    return { runningSince: null, stoppedAt: atS };
  }
  return { runningSince: atS, stoppedAt: null };
}

/** Releases the clock basis at release instant `atS`, resuming active counting under causality checks. */
export function releaseClockBasis(
  basis: AdjudicationClockBasis,
  atS: number,
  tc: TimeControl,
  lineage?: StopLineage,
): AdjudicationClockBasis {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateLineage(lineage, 'lineage');
  validateNonNegativeSafeInteger(atS, 'Release anchor');
  if (basis.runningSince !== null) {
    throw new GameError(`Clock basis is already running since ${basis.runningSince}`);
  }
  if (basis.stoppedAt !== null && atS < basis.stoppedAt) {
    throw new GameError(`Release anchor ${atS} cannot precede last stop observation ${basis.stoppedAt}`);
  }
  if (basis.noShowRemainderMs !== null) {
    safeAdd(atS, basis.noShowRemainderMs, 'No-show deadline');
  }

  const { runningSince, stoppedAt } = resolveReleaseAnchors(tc.kind, basis.noShowRemainderMs, atS);

  const released: AdjudicationClockBasis = {
    turnBaseBalances: cloneBalances(basis.turnBaseBalances),
    elapsedThinkingMs: basis.elapsedThinkingMs,
    sideToMove: basis.sideToMove,
    ply: basis.ply,
    runningSince,
    stoppedAt,
    stopId: resolveNextLineageField(lineage?.stopId, basis.stopId, 'lineage.stopId'),
    originatingCompletionId: resolveNextLineageField(
      lineage?.originatingCompletionId,
      basis.originatingCompletionId,
      'lineage.originatingCompletionId',
    ),
    policy: resolveNextLineageField(lineage?.policy, basis.policy, 'lineage.policy'),
    noShowRemainderMs: basis.noShowRemainderMs,
  };
  return Object.freeze(released);
}

function resolveFinalMoverBalance(
  baseBalance: number,
  chargedMs: number,
  tc: TimeControl,
): { readonly finalBalance: number; readonly flagged: boolean } {
  const postCharge = baseBalance - chargedMs;
  if (postCharge <= 0) {
    return { finalBalance: 0, flagged: true };
  }
  const finalBalance = tc.kind === 'increment'
    ? safeAdd(postCharge, tc.incrementMs, 'Mover balance with increment')
    : postCharge;
  return { finalBalance, flagged: false };
}

/** Applies a completed move to the clock basis, charging mover, updating no-show, and advancing turn. */
export function applyCompletedTurn(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  options?: ApplyCompletedTurnOptions,
): ClockTurnCompletion {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateApplyOptions(options);
  const runningElapsed = validateTemporalAdmissibility(basis, now, options?.auth);

  const mover = basis.sideToMove;
  const opponent = mover === 'w' ? 'b' : 'w';
  const totalActive = tc.kind === 'unlimited'
    ? 0
    : safeAdd(basis.elapsedThinkingMs, runningElapsed, 'Active thinking');

  const delay = tc.kind === 'delay' ? tc.delayMs : 0;
  const chargeable = tc.kind === 'unlimited' ? 0 : Math.max(0, totalActive - delay);
  const { finalBalance, flagged } = tc.kind === 'unlimited'
    ? { finalBalance: basis.turnBaseBalances[mover], flagged: false }
    : resolveFinalMoverBalance(basis.turnBaseBalances[mover], chargeable, tc);

  const newBalances = mover === 'w'
    ? { w: finalBalance, b: basis.turnBaseBalances.b }
    : { w: basis.turnBaseBalances.w, b: finalBalance };

  const nextBasis: AdjudicationClockBasis = {
    turnBaseBalances: cloneBalances(newBalances),
    elapsedThinkingMs: 0,
    sideToMove: opponent,
    ply: safeAdd(basis.ply, 1, 'Ply', Number.MAX_SAFE_INTEGER),
    runningSince: null,
    stoppedAt: now,
    stopId: resolveConstructorStringOrNull(options?.nextLineage?.stopId, 'options.nextLineage.stopId'),
    originatingCompletionId: resolveConstructorStringOrNull(
      options?.nextLineage?.originatingCompletionId,
      'options.nextLineage.originatingCompletionId',
    ),
    policy: resolveNextLineageField(options?.nextLineage?.policy, basis.policy, 'options.nextLineage.policy'),
    noShowRemainderMs: computeNextNoShowRemainder(basis, runningElapsed, options?.clearNoShow),
  };

  return Object.freeze({
    nextBasis: Object.freeze(nextBasis),
    moveTimeMs: totalActive,
    chargedMs: chargeable,
    flagged,
  });
}

/** Constructs an immutable snapshot of all clock accounting metrics at instant `now`. */
export function getClockAccountingSnapshot(
  basis: AdjudicationClockBasis,
  now: number,
  tc: TimeControl,
  auth?: RetainedTimestampAuthorization,
): ClockAccountingSnapshot {
  validateClockBasis(basis);
  validateTimeControl(tc);
  validateAuth(auth, 'auth');
  const displayBalances = computeDisplayBalances(basis, now, tc, auth);
  const activeThinkingMs = computeActiveThinkingMs(basis, now, tc, auth);
  const remainingDelayMs = computeRemainingDelayMs(basis, now, tc, auth);
  const flagDl = computeFlagDeadline(basis, tc);
  const noShowDl = computeNoShowDeadline(basis);
  const isRunning = basis.runningSince !== null;
  const flagged = tc.kind !== 'unlimited' && displayBalances[basis.sideToMove] <= 0;

  const snapshot: ClockAccountingSnapshot = {
    displayBalances: cloneBalances(displayBalances),
    activeThinkingMs,
    remainingDelayMs,
    flagDeadline: flagDl,
    noShowDeadline: noShowDl,
    isRunning,
    flagged,
  };
  return Object.freeze(snapshot);
}
