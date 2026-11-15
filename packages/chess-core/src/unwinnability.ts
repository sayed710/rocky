/**
 * @packageDocumentation
 * General FIDE Article 5.2.2 Unwinnability Proof Engine (Issue #124).
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d).
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 *
 * Combines Miguel Ambrona's Semi-Static Mating Exclusion Certificate (FUN 2022)
 * with exact resumable cooperative graph search under clock-free semantics.
 *
 * Soundness Contract:
 * - A position is declared dead (`isDead: true`) iff checkmate is mathematically
 *   proven impossible for BOTH White and Black.
 * - If checkmate is reachable for either color, returns `isDead: false` with the
 *   exact root-to-checkmate legal move witness.
 * - If computation limits are reached, returns `isDead: 'pending'` without prematurely
 *   claiming a draw or victory.
 */

import { opposite } from './board';
import {
  cloneImpossibleResult,
  cloneMove,
  cloneReachableResult,
  cloneWinnabilityResult,
  CooperativeSearchSession,
} from './cooperative-search';
import { generateLegalMoves, inCheck } from './movegen';
import { validateAdmittedProofState } from './proof-admission';
import { isStaticallyUnwinnable } from './semi-static';
import type { Color, PositionState } from './types';
import type {
  AnalysisOptions,
  DeadPositionAnalysisResult,
  PendingReason,
  WinnabilityResult,
} from './unwinnability-types';

const DEFAULT_MAX_STEPS = 5000;

function resolveStepBudget(options?: AnalysisOptions): number {
  if (options?.maxSteps === undefined) return DEFAULT_MAX_STEPS;
  const s = options.maxSteps;
  if (typeof s !== 'number' || !Number.isFinite(s) || Number.isNaN(s) || !Number.isInteger(s) || s < 0) {
    return 0;
  }
  return s;
}

function isTerminalMateForWinner(state: PositionState, intendedWinner: Color): boolean {
  const opponent = opposite(intendedWinner);
  if (state.turn !== opponent || !inCheck(state, opponent)) return false;
  return generateLegalMoves(state).length === 0;
}

function resolvePendingReason(whiteRes: WinnabilityResult, blackRes: WinnabilityResult): PendingReason {
  if (whiteRes.status === 'pending' && whiteRes.reason === 'resource_limit') return 'resource_limit';
  if (blackRes.status === 'pending' && blackRes.reason === 'resource_limit') return 'resource_limit';
  if (whiteRes.status === 'pending') return whiteRes.reason;
  if (blackRes.status === 'pending') return blackRes.reason;
  return 'budget_exhausted';
}

/**
 * Analyzes whether `intendedWinner` can deliver checkmate by any possible series
 * of legal moves starting from `state`.
 *
 * Precedence:
 * 1. Admitted-state validation (orthodox rules, empty pockets, zero check counters, valid king/pawn geometry).
 * 2. Terminal root target checkmate (delivered immediately, even with 0 budget or static-only).
 * 3. Finite work allowance validation (0 budget halts before static/search work).
 * 4. Semi-Static Certificate (Figure 8).
 * 5. Exact Resumable Cooperative Graph Search (Figures 5 & 9).
 *
 * @param state Input position state.
 * @param intendedWinner Color whose winnability is evaluated.
 * @param options Analysis options (budget, enabled components).
 */
export function analyzeWinnability(
  state: PositionState,
  intendedWinner: Color,
  options?: AnalysisOptions,
): WinnabilityResult {
  const admission = validateAdmittedProofState(state);
  if (!admission.ok) {
    return {
      status: 'pending',
      winner: intendedWinner,
      reason: admission.reason ?? 'unsupported_state',
      steps: 0,
    };
  }

  if (isTerminalMateForWinner(state, intendedWinner)) {
    return {
      status: 'reachable',
      winner: intendedWinner,
      witness: [],
      steps: 0,
    };
  }

  const maxSteps = resolveStepBudget(options);
  if (maxSteps === 0) {
    return {
      status: 'pending',
      winner: intendedWinner,
      reason: 'budget_exhausted',
      steps: 0,
    };
  }

  const useStatic = options?.useStaticCertificate ?? true;
  const useSearch = options?.useCooperativeSearch ?? true;

  if (useStatic && isStaticallyUnwinnable(state, intendedWinner)) {
    return {
      status: 'impossible',
      winner: intendedWinner,
      provenance: 'static_certificate',
      steps: 1,
    };
  }

  if (!useSearch) {
    return {
      status: 'pending',
      winner: intendedWinner,
      reason: 'budget_exhausted',
      steps: 0,
    };
  }

  const session = new CooperativeSearchSession(state, intendedWinner, {
    maxRetainedStates: options?.maxRetainedStates,
  });
  return session.resume(maxSteps);
}

/**
 * Evaluates whether a position is a FIDE Article 5.2.2 dead position.
 * Evaluates winnability independently for both White and Black.
 *
 * @param state Input position state.
 * @param options Analysis options.
 */
export function analyzeDeadPosition(
  state: PositionState,
  options?: AnalysisOptions,
): DeadPositionAnalysisResult {
  const admission = validateAdmittedProofState(state);
  if (!admission.ok) {
    const reason = admission.reason ?? 'unsupported_state';
    return {
      isDead: 'pending',
      reason,
      white: { status: 'pending', winner: 'w', reason, steps: 0 },
      black: { status: 'pending', winner: 'b', reason, steps: 0 },
    };
  }

  const whiteRes = analyzeWinnability(state, 'w', options);
  if (whiteRes.status === 'reachable') {
    const blackRes = options?.useCooperativeSearch === false
      ? analyzeWinnability(state, 'b', { ...options, maxSteps: 0 })
      : { status: 'pending' as const, winner: 'b' as const, reason: 'budget_exhausted' as const, steps: 0 };
    return {
      isDead: false,
      reason: 'winnable',
      winner: 'w',
      witness: whiteRes.witness.map(cloneMove),
      white: cloneReachableResult(whiteRes),
      black: cloneWinnabilityResult(blackRes),
    };
  }

  const blackRes = analyzeWinnability(state, 'b', options);
  if (blackRes.status === 'reachable') {
    return {
      isDead: false,
      reason: 'winnable',
      winner: 'b',
      witness: blackRes.witness.map(cloneMove),
      white: cloneWinnabilityResult(whiteRes),
      black: cloneReachableResult(blackRes),
    };
  }

  if (whiteRes.status === 'impossible' && blackRes.status === 'impossible') {
    return {
      isDead: true,
      white: cloneImpossibleResult(whiteRes),
      black: cloneImpossibleResult(blackRes),
    };
  }

  return {
    isDead: 'pending',
    reason: resolvePendingReason(whiteRes, blackRes),
    white: cloneWinnabilityResult(whiteRes),
    black: cloneWinnabilityResult(blackRes),
  };
}
