/**
 * @packageDocumentation
 * Miguel Ambrona's Semi-Static Unwinnability Algorithm (Figure 8).
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d).
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 *
 * Checks whether an intended loser's king can ever be checkmated under the
 * over-approximated piece mobility solution.
 *
 * Soundness (Theorem 12):
 * `UnwinnableStatic(pos, c) === true ==> pos is unwinnable for player c`.
 */

import { fileOf, opposite, rankOf } from './board';
import { computeMobility, type MobilitySolution, type OriginalPiece } from './mobility';
import { validateAdmittedProofState } from './proof-admission';
import type { Color, PositionState } from './types';

function getOrthogonalNeighbors(sq64: number): number[] {
  const r = sq64 >> 3;
  const f = sq64 & 7;
  const neighbors: number[] = [];
  if (r > 0) neighbors.push(((r - 1) << 3) | f);
  if (r < 7) neighbors.push(((r + 1) << 3) | f);
  if (f > 0) neighbors.push((r << 3) | (f - 1));
  if (f < 7) neighbors.push((r << 3) | (f + 1));
  return neighbors;
}

function setsIntersect(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length <= b.length) {
    for (let i = 0; i < a.length; i++) {
      if (b.includes(a[i])) return true;
    }
  } else {
    for (let i = 0; i < b.length; i++) {
      if (a.includes(b[i])) return true;
    }
  }
  return false;
}

function validateStaticDomain(state: PositionState): boolean {
  const admission = validateAdmittedProofState(state);
  if (!admission.ok) return false;

  if (state.epSquare !== -1) return false;
  const c = state.castling;
  if (c.w.k !== -1 || c.w.q !== -1 || c.b.k !== -1 || c.b.q !== -1) {
    return false;
  }
  return true;
}

function identifyKings(
  pieces: readonly OriginalPiece[],
  intendedWinner: Color,
  loserColor: Color,
): { winnerKingId: number; loserKingId: number } | null {
  let winnerKingId = -1;
  let loserKingId = -1;

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.type === 'k') {
      if (p.color === intendedWinner) winnerKingId = i;
      else if (p.color === loserColor) loserKingId = i;
    }
  }

  if (winnerKingId === -1 || loserKingId === -1) {
    return null;
  }
  return { winnerKingId, loserKingId };
}

interface SemiStaticContext {
  readonly pieces: readonly OriginalPiece[];
  readonly mob: MobilitySolution;
  readonly winner: Color;
  readonly loser: Color;
}

function validateIntruders(
  ctx: SemiStaticContext,
  loserKingRegion: readonly number[],
): boolean {
  const intruders: number[] = [];
  for (let i = 0; i < ctx.pieces.length; i++) {
    const p = ctx.pieces[i];
    if (p.color === ctx.winner && setsIntersect(ctx.mob.region(i), loserKingRegion)) {
      intruders.push(i);
    }
  }

  for (let i = 0; i < intruders.length; i++) {
    if (ctx.pieces[intruders[i]].type !== 'b') {
      return false;
    }
  }

  if (intruders.length > 1) {
    const firstP = ctx.pieces[intruders[0]];
    const firstColor = (rankOf(firstP.sq0x88) + fileOf(firstP.sq0x88)) % 2;
    for (let i = 1; i < intruders.length; i++) {
      const p = ctx.pieces[intruders[i]];
      const sqColor = (rankOf(p.sq0x88) + fileOf(p.sq0x88)) % 2;
      if (sqColor !== firstColor) {
        return false;
      }
    }
  }

  return true;
}

function canWinnerAttackSquare(ctx: SemiStaticContext, s: number): boolean {
  for (let i = 0; i < ctx.pieces.length; i++) {
    if (ctx.pieces[i].color === ctx.winner && ctx.mob.attRegion(i).includes(s)) {
      return true;
    }
  }
  return false;
}

function countBlockers(ctx: SemiStaticContext, plusS: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < ctx.pieces.length; i++) {
    const p = ctx.pieces[i];
    if (p.color === ctx.loser && p.type !== 'k' && setsIntersect(ctx.mob.region(i), plusS)) {
      count++;
    }
  }
  return count;
}

function countAssistants(ctx: SemiStaticContext, plusS: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < ctx.pieces.length; i++) {
    const p = ctx.pieces[i];
    if (p.color === ctx.winner && setsIntersect(ctx.mob.attRegion(i), plusS)) {
      count++;
    }
  }
  return count;
}

function canSquareBeMatingSquare(
  ctx: SemiStaticContext,
  s: number,
  plusS: readonly number[],
): boolean {
  if (!canWinnerAttackSquare(ctx, s)) {
    return false;
  }
  return countBlockers(ctx, plusS) + countAssistants(ctx, plusS) >= plusS.length;
}

/**
 * Evaluates whether a position is provably unwinnable for `intendedWinner`
 * using the semi-static mating exclusion conditions from Figure 8.
 *
 * Mobility is computed internally to guarantee position-bound proof integrity
 * and prevent fabricated or mismatched mobility injection.
 *
 * @param state Chess position state.
 * @param intendedWinner The player whose ability to deliver checkmate is evaluated.
 * @returns `true` if provably unwinnable for `intendedWinner`; `false` if inconclusive.
 */
export function isStaticallyUnwinnable(
  state: PositionState,
  intendedWinner: Color,
): boolean {
  if (!validateStaticDomain(state)) {
    return false;
  }

  const mob = computeMobility(state);
  if (!mob || !mob.saturated) {
    return false;
  }

  const pieces = mob.pieces;
  const loserColor = opposite(intendedWinner);
  const kings = identifyKings(pieces, intendedWinner, loserColor);
  if (!kings) return false;

  const loserKingRegion = mob.region(kings.loserKingId);
  if (loserKingRegion.length === 0) return false;

  const ctx: SemiStaticContext = {
    pieces,
    mob,
    winner: intendedWinner,
    loser: loserColor,
  };

  if (!validateIntruders(ctx, loserKingRegion)) {
    return false;
  }

  for (let sIdx = 0; sIdx < loserKingRegion.length; sIdx++) {
    const s = loserKingRegion[sIdx];
    const plusS = getOrthogonalNeighbors(s);
    if (canSquareBeMatingSquare(ctx, s, plusS)) {
      return false;
    }
  }

  return true;
}
