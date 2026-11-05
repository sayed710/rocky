/**
 * @packageDocumentation
 * Types for general FIDE Article 5.2.2 unwinnability and dead-position proof analysis.
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d).
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 *
 * Distinguishes:
 * - Reachable checkmate with an exact root-to-checkmate legal move witness.
 * - Provably impossible checkmate with complete certificate, raw closed-graph,
 *   or material-lemma-assisted graph provenance.
 * - Pending status with explicit budget/resource/interruption reason and resumable session state.
 *
 * Whole-position deadness requires BOTH colors to be provably impossible.
 */

import type { Color, Move } from './types';
import type { CooperativeSearchSession } from './cooperative-search';

/** Terminal status of a single-color winnability evaluation. */
export type WinnabilityStatus = 'reachable' | 'impossible' | 'pending';

/** Proof provenance describing the mathematical basis for impossibility. */
export type ProofProvenance =
  | 'static_certificate'
  | 'closed_graph'
  | 'closed_graph_material_pruned';

/** Explicit reason when analysis is pending / interrupted. */
export type PendingReason =
  | 'budget_exhausted'
  | 'resource_limit'
  | 'unsupported_variant'
  | 'unsupported_state'
  | 'cancelled';

/** Result when checkmate is reachable for the intended winner. */
export interface WinnabilityReachableResult {
  readonly status: 'reachable';
  readonly winner: Color;
  readonly witness: readonly Move[];
  readonly steps: number;
}

/** Result when checkmate is provably impossible for the intended winner. */
export interface WinnabilityImpossibleResult {
  readonly status: 'impossible';
  readonly winner: Color;
  readonly provenance: ProofProvenance;
  readonly steps: number;
  readonly materialPrunedCount?: number;
}

/** Result when winnability remains pending / unresolved within allowance. */
export interface WinnabilityPendingResult {
  readonly status: 'pending';
  readonly winner: Color;
  readonly reason: PendingReason;
  readonly steps: number;
  readonly session?: CooperativeSearchSession;
}

/** Discriminated union of single-color helpmate winnability analysis. */
export type WinnabilityResult =
  | WinnabilityReachableResult
  | WinnabilityImpossibleResult
  | WinnabilityPendingResult;

/** Result when a position is provably dead under FIDE Article 5.2.2 (both colors impossible). */
export interface DeadPositionTrueResult {
  readonly isDead: true;
  readonly white: WinnabilityImpossibleResult;
  readonly black: WinnabilityImpossibleResult;
}

/**
 * Result when a position is not dead because at least one color has a verified checkmate witness.
 * Strongly encodes winner-associated reachable result typing.
 */
export type DeadPositionFalseResult =
  | {
      readonly isDead: false;
      readonly reason: 'winnable';
      readonly winner: 'w';
      readonly witness: readonly Move[];
      readonly white: WinnabilityReachableResult;
      readonly black: WinnabilityResult;
    }
  | {
      readonly isDead: false;
      readonly reason: 'winnable';
      readonly winner: 'b';
      readonly witness: readonly Move[];
      readonly white: WinnabilityResult;
      readonly black: WinnabilityReachableResult;
    };

/** Result when dead-position adjudication is pending / incomplete. */
export interface DeadPositionPendingResult {
  readonly isDead: 'pending';
  readonly reason: PendingReason;
  readonly white: WinnabilityResult;
  readonly black: WinnabilityResult;
}

/**
 * Result of whole-position FIDE 5.2.2 dead-position evaluation across both colors.
 * Encodes `isDead: true` => both impossible, and `isDead: false` => witnessed reachable.
 * `isDead` is strictly `true`, `false`, or `'pending'`. Pending is never conflated with false.
 */
export type DeadPositionAnalysisResult =
  | DeadPositionTrueResult
  | DeadPositionFalseResult
  | DeadPositionPendingResult;

/** Options for cooperative graph search session. */
export interface CooperativeSearchOptions {
  /**
   * Maximum retained states in memory before pausing with 'resource_limit'.
   * Finite positive integer (>= 1). Default: 50_000.
   */
  readonly maxRetainedStates?: number;
}

/** Options for unwinnability / dead-position analysis. */
export interface AnalysisOptions {
  /**
   * Maximum number of cooperative search node expansions allowed.
   * Finite non-negative integer. If 0, only terminal root checkmate is checked.
   * Note: non-zero allowance performs admission validation, root-mate inspection,
   * and an initial static certificate pass before cooperative node expansion.
   */
  readonly maxSteps?: number;
  /** Whether to attempt the fast static certificate before cooperative graph search. Default true. */
  readonly useStaticCertificate?: boolean;
  /** Whether to run cooperative search if static certificate is inconclusive. Default true. */
  readonly useCooperativeSearch?: boolean;
  /**
   * Maximum retained states in memory for the search session before pausing with 'resource_limit'.
   * Finite positive integer (>= 1). Default: 50_000.
   */
  readonly maxRetainedStates?: number;
}
