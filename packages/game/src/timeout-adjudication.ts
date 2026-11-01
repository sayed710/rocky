/**
 * @packageDocumentation
 * FIDE Article 6.9 timeout reachability adjudication for Standard and Chess960.
 *
 * Implements a bounded cooperative reachability proof: a timeout is adjudicated
 * as a draw ('insufficient_material') if and only if it is proven impossible for
 * the prospective winner to deliver checkmate by any possible series of legal moves.
 *
 * Uncertainty bias (ADR-0100): if the proof budget is exhausted or an unclosed
 * cycle is encountered, the outcome defaults to possible ('timeout' win).
 */

import {
  Position,
  type Color,
  typeOf,
} from '@chess-platform/core';

export type ProofOutcome = 'possible' | 'impossible' | 'unknown';

export interface AdjudicationCounters {
  admittedNodes: number;
  legalGenerations: number;
  plays: number;
  cycleHits: number;
  materialChecks: number;
  materialLeaves: number;
  depthCutoffs: number;
  capacityCutoffs: number;
}

export function createAdjudicationCounters(): AdjudicationCounters {
  return {
    admittedNodes: 0,
    legalGenerations: 0,
    plays: 0,
    cycleHits: 0,
    materialChecks: 0,
    materialLeaves: 0,
    depthCutoffs: 0,
    capacityCutoffs: 0,
  };
}

interface PieceSummary {
  p: number;
  n: number;
  b: number;
  r: number;
  q: number;
  k: number;
}

function emptySummary(): PieceSummary {
  return { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
}

/**
 * Checks whether prospective winner W can provably never checkmate opponent F
 * based purely on qualified static material rules.
 *
 * Exact 3 sufficient predicate rules:
 * 1. Winner has no non-king pieces => impossible (lone king can never mate).
 * 2. Winner has exactly ONE knight and no other non-king pieces; opponent has
 *    only king and zero or more queens (no pawns, knights, bishops, or rooks) => impossible.
 * 3. Winner has bishop(s) and no other non-king pieces; there are NO pawns or knights
 *    anywhere on the board (neither side); and ALL bishops on the board (both sides)
 *    reside on the SAME square color => impossible.
 *
 * All other material configurations return false (material check cannot prove impossibility;
 * fall through to bounded reachability search).
 */
export function isMaterialImpossible(
  pos: Position,
  winner: Color,
  counters?: AdjudicationCounters,
): boolean {
  if (counters) counters.materialChecks++;

  const snap = pos.snapshot();
  const wMat = emptySummary();
  const fMat = emptySummary();
  const allBishopColors = new Set<number>();

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = snap.board[sq];
    if (p === null) continue;

    const isWhite = p === p.toUpperCase();
    const pColor: Color = isWhite ? 'w' : 'b';
    const kind = typeOf(p);
    const target = pColor === winner ? wMat : fMat;

    if (kind === 'p') target.p++;
    else if (kind === 'n') target.n++;
    else if (kind === 'b') {
      target.b++;
      const file = sq & 7;
      const rank = sq >> 4;
      allBishopColors.add((file + rank) & 1);
    } else if (kind === 'r') target.r++;
    else if (kind === 'q') target.q++;
    else if (kind === 'k') target.k++;
  }

  const wNonKing = wMat.p + wMat.n + wMat.b + wMat.r + wMat.q;

  // Rule 1: Winner has no non-king pieces (bare King).
  if (wNonKing === 0) return true;

  // Rule 2: Winner has exactly ONE knight and no other non-king pieces.
  // Opponent has ONLY king and zero or more queens (no pawns, knights, bishops, or rooks).
  if (wMat.n === 1 && wNonKing === 1) {
    const fEnabling = fMat.p + fMat.n + fMat.b + fMat.r;
    if (fEnabling === 0) return true;
  }

  // Rule 3: Winner has bishop(s) and no other non-king pieces.
  // There are NO pawns or knights anywhere on the board (neither side).
  // ALL bishops on the board (both sides) share the exact same square color.
  if (wMat.b >= 1 && wNonKing === wMat.b) {
    const totalPawnsAndKnights = wMat.p + fMat.p + wMat.n + fMat.n;
    if (totalPawnsAndKnights === 0 && allBishopColors.size === 1) {
      return true;
    }
  }

  // All other cases: material cannot prove impossibility statically; fall through to search.
  return false;
}

interface WorkerBudget {
  readonly maxDepth: number;
  tokensRemaining: number;
}

/**
 * Recursive worker for cooperative reachability.
 * Invariant: The admission token for `pos` was ALREADY reserved before entry.
 * Uses natural legal move order directly from pos.legalMoves().
 */
function proveWorker(
  pos: Position,
  winner: Color,
  depth: number,
  ancestors: Set<string>,
  budget: WorkerBudget,
  counters?: AdjudicationCounters,
): ProofOutcome {
  const stateKey = pos.fen().split(' ').slice(0, 4).join(' ');

  // 1. Static leaf proof (material impossibility on admitted node closes leaf).
  if (isMaterialImpossible(pos, winner, counters)) {
    if (counters) counters.materialLeaves++;
    return 'impossible';
  }

  // 2. Depth boundary check BEFORE move generation.
  // Note: Non-material mate at depth boundary safely defaults to unknown.
  if (depth >= budget.maxDepth) {
    if (counters) counters.depthCutoffs++;
    return 'unknown';
  }

  // 3. Canonical cycle detection (raw first-four FEN fields).
  if (ancestors.has(stateKey)) {
    if (counters) counters.cycleHits++;
    return 'unknown';
  }

  // 4. Generate legal moves in natural order (memoized on Position).
  if (counters) counters.legalGenerations++;
  const legalMoves = pos.legalMoves();

  if (legalMoves.length === 0) {
    if (pos.isCheck() && pos.turn !== winner) {
      return 'possible'; // Checkmate delivered by winner: witness found!
    }
    return 'impossible'; // Stalemate or opponent checkmate: terminal leaf, no winner mate.
  }

  ancestors.add(stateKey);
  let sawUnknown = false;
  let allChildrenClosed = true;

  try {
    for (const move of legalMoves) {
      // Strict reservation contract: reserve BEFORE child play or evaluation.
      if (budget.tokensRemaining <= 0) {
        if (counters) counters.capacityCutoffs++;
        sawUnknown = true;
        allChildrenClosed = false;
        break; // Stop loop: capacity reached with unexpanded children remaining.
      }

      budget.tokensRemaining--;
      if (counters) {
        counters.admittedNodes++;
        counters.plays++;
      }

      const child = pos.play(move);
      const childOutcome = proveWorker(child, winner, depth + 1, ancestors, budget, counters);

      if (childOutcome === 'possible') {
        return 'possible'; // Propagate witness immediately.
      }
      if (childOutcome === 'unknown') {
        sawUnknown = true;
        allChildrenClosed = false;
      }
      // childOutcome === 'impossible' keeps branch candidate closed.
    }
  } finally {
    ancestors.delete(stateKey);
  }

  return (allChildrenClosed && !sawUnknown) ? 'impossible' : 'unknown';
}

/**
 * Worker entry with explicit total capacity (including root).
 * Internal export for tests requiring custom capacity or counter inspection.
 */
export function proveMatingPossibilityWithCapacity(
  pos: Position,
  winner: Color,
  maxDepth: number,
  totalCapacity: number,
  counters?: AdjudicationCounters,
): ProofOutcome {
  if (totalCapacity <= 0) {
    return 'unknown';
  }

  // Reserve 1 token for the root node.
  if (counters) counters.admittedNodes++;
  const budget: WorkerBudget = {
    maxDepth,
    tokensRemaining: totalCapacity - 1,
  };

  return proveWorker(pos, winner, 0, new Set<string>(), budget, counters);
}

/**
 * Production timeout reachability adjudication under FIDE Article 6.9.
 * Fixed depth 4, capacity 512 tokens.
 * Returns true if mate is possible (or uncertain); returns false if proven impossible (Draw).
 */
export function adjudicateTimeoutPossibility(
  pos: Position,
  winner: Color,
): boolean {
  const outcome = proveMatingPossibilityWithCapacity(pos, winner, 4, 512);
  // Conservative uncertainty bias: Draw only on proven impossibility.
  return outcome !== 'impossible';
}
