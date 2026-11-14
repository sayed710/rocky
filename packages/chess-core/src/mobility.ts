/**
 * @packageDocumentation
 * Mobility saturation engine following Miguel Ambrona's FUN 2022 algorithm.
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d).
 * - Upstream reference code: chasolver commit 3484c7e65247003fac8705a9290dc2b5d0978b94
 *   (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 */

import { colorOf, typeOf } from './board';
import { validateAdmittedProofState } from './proof-admission';
import type { CastlingRights, Color, Piece, PieceType, PositionState } from './types';

export interface OriginalPiece {
  readonly id: number;
  readonly type: PieceType;
  readonly color: Color;
  readonly sq0x88: number;
  readonly sq64: number;
}

export interface MobilitySolution {
  readonly pieces: readonly OriginalPiece[];
  readonly saturated: boolean;
  readonly steps: number;
  isReachable(pieceId: number, sq64: number): boolean;
  isCleared(pieceId: number): boolean;
  isReachableByNonKing(color: Color, sq64: number): boolean;
  region(pieceId: number): readonly number[];
  attRegion(pieceId: number): readonly number[];
}

export function sq0x88To64(sq: number): number {
  return ((sq >> 4) << 3) | (sq & 7);
}

export function sq64To0x88(sq: number): number {
  return ((sq >> 3) << 4) | (sq & 7);
}

const KNIGHT_DELTAS: readonly (readonly [number, number])[] = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];

const BISHOP_DELTAS: readonly (readonly [number, number])[] = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

const ROOK_DELTAS: readonly (readonly [number, number])[] = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

const WHITE_PROMOTION_SQUARES: readonly number[] = [56, 57, 58, 59, 60, 61, 62, 63];
const BLACK_PROMOTION_SQUARES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];

function collectDeltas(r: number, f: number, deltas: readonly (readonly [number, number])[]): number[] {
  const preds: number[] = [];
  for (let i = 0; i < deltas.length; i++) {
    const nr = r + deltas[i][0];
    const nf = f + deltas[i][1];
    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
      preds.push((nr << 3) | nf);
    }
  }
  return preds;
}

function collectRadialPredecessors(r: number, f: number): number[] {
  const preds: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let df = -1; df <= 1; df++) {
      if (dr === 0 && df === 0) continue;
      const nr = r + dr;
      const nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        preds.push((nr << 3) | nf);
      }
    }
  }
  return preds;
}

function getPredecessors(type: PieceType, color: Color, s: number): number[] {
  const r = s >> 3;
  const f = s & 7;

  switch (type) {
    case 'k':
    case 'q':
      return collectRadialPredecessors(r, f);
    case 'n':
      return collectDeltas(r, f, KNIGHT_DELTAS);
    case 'b':
      return collectDeltas(r, f, BISHOP_DELTAS);
    case 'r':
      return collectDeltas(r, f, ROOK_DELTAS);
    case 'p':
      if (color === 'w') {
        return r > 0 ? [((r - 1) << 3) | f] : [];
      }
      return r < 7 ? [((r + 1) << 3) | f] : [];
  }
}

function getCapturePredecessors(type: PieceType, color: Color, s: number): number[] {
  if (type !== 'p') {
    return getPredecessors(type, color, s);
  }
  const r = s >> 3;
  const f = s & 7;
  const preds: number[] = [];
  if (color === 'w' && r > 0) {
    if (f > 0) preds.push(((r - 1) << 3) | (f - 1));
    if (f < 7) preds.push(((r - 1) << 3) | (f + 1));
  } else if (color === 'b' && r < 7) {
    if (f > 0) preds.push(((r + 1) << 3) | (f - 1));
    if (f < 7) preds.push(((r + 1) << 3) | (f + 1));
  }
  return preds;
}

function hasAnyCastlingRight(c: CastlingRights): boolean {
  return c.w.k !== -1 || c.w.q !== -1 || c.b.k !== -1 || c.b.q !== -1;
}

function isSafeBudget(b: unknown): boolean {
  return typeof b === 'number' && Number.isSafeInteger(b) && b >= 0;
}

function validateMobilityDomain(state: PositionState, stepBudget?: number): { ok: boolean; budget?: number } {
  if (!validateAdmittedProofState(state).ok || state.epSquare !== -1 || hasAnyCastlingRight(state.castling)) {
    return { ok: false };
  }
  if (stepBudget !== undefined && !isSafeBudget(stepBudget)) {
    return { ok: false };
  }
  return { ok: true, budget: stepBudget };
}

function collectOriginalPieces(board: readonly (Piece | null)[]): {
  pieces: OriginalPiece[];
  pieceOnInitialSq: Int32Array;
} {
  const pieces: OriginalPiece[] = [];
  const pieceOnInitialSq = new Int32Array(64).fill(-1);

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = board[sq];
    if (p === null) continue;
    const sq64 = sq0x88To64(sq);
    const id = pieces.length;
    pieces.push({
      id,
      type: typeOf(p),
      color: colorOf(p),
      sq0x88: sq,
      sq64,
    });
    pieceOnInitialSq[sq64] = id;
  }

  return { pieces, pieceOnInitialSq };
}

interface PredecessorTables {
  readonly predsTable: readonly (readonly (readonly number[])[])[];
  readonly captPredsTable: readonly (readonly (readonly number[])[])[];
}

function buildPredecessorsTables(pieces: readonly OriginalPiece[]): PredecessorTables {
  const N = pieces.length;
  const predsTable: number[][][] = new Array(N);
  const captPredsTable: number[][][] = new Array(N);

  for (let i = 0; i < N; i++) {
    predsTable[i] = new Array(64);
    captPredsTable[i] = new Array(64);
    const p = pieces[i];
    for (let s = 0; s < 64; s++) {
      predsTable[i][s] = getPredecessors(p.type, p.color, s);
      captPredsTable[i][s] = getCapturePredecessors(p.type, p.color, s);
    }
  }

  return { predsTable, captPredsTable };
}

function buildDirectAttackers(
  pieces: readonly OriginalPiece[],
  captPredsTable: readonly (readonly (readonly number[])[])[],
): number[][] {
  const N = pieces.length;
  const directAttackers: number[][] = new Array(64);
  for (let s = 0; s < 64; s++) {
    directAttackers[s] = [];
    for (let i = 0; i < N; i++) {
      if (captPredsTable[i][s].includes(pieces[i].sq64)) {
        directAttackers[s].push(i);
      }
    }
  }
  return directAttackers;
}

interface MobilityAnalysisContext {
  readonly pieces: readonly OriginalPiece[];
  readonly pieceOnInitialSq: Int32Array;
  readonly predsTable: readonly (readonly (readonly number[])[])[];
  readonly captPredsTable: readonly (readonly (readonly number[])[])[];
  readonly directAttackers: readonly (readonly number[])[];
  readonly M: Uint8Array;
  readonly C: Uint8Array;
  readonly Rw: Uint8Array;
  readonly Rb: Uint8Array;
}

function initializeMobilityContext(
  pieces: readonly OriginalPiece[],
  pieceOnInitialSq: Int32Array,
  tables: PredecessorTables,
  directAttackers: readonly (readonly number[])[],
): MobilityAnalysisContext {
  const N = pieces.length;
  const M = new Uint8Array(N * 64);
  const C = new Uint8Array(N);
  const Rw = new Uint8Array(64);
  const Rb = new Uint8Array(64);

  for (let i = 0; i < N; i++) {
    const sq64 = pieces[i].sq64;
    M[i * 64 + sq64] = 1;
    if (pieces[i].type !== 'k') {
      if (pieces[i].color === 'w') Rw[sq64] = 1;
      else Rb[sq64] = 1;
    }
  }

  return {
    pieces,
    pieceOnInitialSq,
    predsTable: tables.predsTable,
    captPredsTable: tables.captPredsTable,
    directAttackers,
    M,
    C,
    Rw,
    Rb,
  };
}

function isTargetSquareAdmissible(
  ctx: MobilityAnalysisContext,
  pieceIndex: number,
  targetSq: number,
): boolean {
  const p = ctx.pieces[pieceIndex];
  const pieceAtS = ctx.pieceOnInitialSq[targetSq];

  if (pieceAtS !== -1 && pieceAtS !== pieceIndex) {
    if (ctx.pieces[pieceAtS].color === p.color && ctx.C[pieceAtS] === 0) {
      return false;
    }
  }

  if (p.type === 'k') {
    const attackers = ctx.directAttackers[targetSq];
    for (let a = 0; a < attackers.length; a++) {
      const attId = attackers[a];
      if (ctx.pieces[attId].color !== p.color && ctx.C[attId] === 0) {
        return false;
      }
    }
  }

  return true;
}

function canPawnPush(ctx: MobilityAnalysisContext, pieceIndex: number, s: number): boolean {
  const p = ctx.pieces[pieceIndex];
  const pieceAtS = ctx.pieceOnInitialSq[s];
  const isFreeOfEnemy = pieceAtS === -1 || ctx.pieces[pieceAtS].color === p.color || ctx.C[pieceAtS] === 1;
  if (!isFreeOfEnemy) return false;

  const preds = ctx.predsTable[pieceIndex][s];
  for (let i = 0; i < preds.length; i++) {
    if (ctx.M[pieceIndex * 64 + preds[i]] === 1) return true;
  }
  return false;
}

function canPawnCapture(ctx: MobilityAnalysisContext, pieceIndex: number, s: number): boolean {
  const p = ctx.pieces[pieceIndex];
  const enemyR = p.color === 'w' ? ctx.Rb : ctx.Rw;
  if (enemyR[s] !== 1) return false;

  const captPreds = ctx.captPredsTable[pieceIndex][s];
  for (let i = 0; i < captPreds.length; i++) {
    if (ctx.M[pieceIndex * 64 + captPreds[i]] === 1) return true;
  }
  return false;
}

function canPawnPromote(ctx: MobilityAnalysisContext, pieceIndex: number): boolean {
  const p = ctx.pieces[pieceIndex];
  const promSquares = p.color === 'w' ? WHITE_PROMOTION_SQUARES : BLACK_PROMOTION_SQUARES;
  for (let i = 0; i < promSquares.length; i++) {
    if (ctx.M[pieceIndex * 64 + promSquares[i]] === 1) return true;
  }
  return false;
}

function canPawnReach(ctx: MobilityAnalysisContext, pieceIndex: number, s: number): boolean {
  return canPawnPush(ctx, pieceIndex, s) || canPawnCapture(ctx, pieceIndex, s) || canPawnPromote(ctx, pieceIndex);
}

function canPieceReach(ctx: MobilityAnalysisContext, pieceIndex: number, s: number): boolean {
  if (ctx.pieces[pieceIndex].type === 'p') {
    return canPawnReach(ctx, pieceIndex, s);
  }
  const preds = ctx.predsTable[pieceIndex][s];
  for (let i = 0; i < preds.length; i++) {
    if (ctx.M[pieceIndex * 64 + preds[i]] === 1) return true;
  }
  return false;
}

function hasPieceMoved(ctx: MobilityAnalysisContext, i: number, sq64: number): boolean {
  for (let s = 0; s < 64; s++) {
    if (s !== sq64 && ctx.M[i * 64 + s] === 1) return true;
  }
  return false;
}

function isSquareCapturedByEnemy(ctx: MobilityAnalysisContext, color: Color, sq64: number): boolean {
  const N = ctx.pieces.length;
  for (let j = 0; j < N; j++) {
    if (ctx.pieces[j].color !== color && ctx.M[j * 64 + sq64] === 1) return true;
  }
  return false;
}

function runClearancePass(ctx: MobilityAnalysisContext): boolean {
  let changed = false;
  const N = ctx.pieces.length;

  for (let i = 0; i < N; i++) {
    if (ctx.C[i] === 1) continue;
    const p = ctx.pieces[i];
    if (hasPieceMoved(ctx, i, p.sq64) || isSquareCapturedByEnemy(ctx, p.color, p.sq64)) {
      ctx.C[i] = 1;
      changed = true;
    }
  }

  return changed;
}

function runReachabilityPass(ctx: MobilityAnalysisContext): boolean {
  let changed = false;
  const N = ctx.pieces.length;

  for (let i = 0; i < N; i++) {
    const p = ctx.pieces[i];
    const ownR = p.color === 'w' ? ctx.Rw : ctx.Rb;

    for (let s = 0; s < 64; s++) {
      const mIdx = i * 64 + s;
      if (ctx.M[mIdx] === 1) continue;
      if (!isTargetSquareAdmissible(ctx, i, s)) continue;

      if (canPieceReach(ctx, i, s)) {
        ctx.M[mIdx] = 1;
        changed = true;
        if (p.type !== 'k') ownR[s] = 1;
      }
    }
  }

  return changed;
}

function buildRegionCache(M: Uint8Array, N: number): number[][] {
  const cache: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    const reg: number[] = [];
    for (let s = 0; s < 64; s++) {
      if (M[i * 64 + s] === 1) reg.push(s);
    }
    cache[i] = reg;
  }
  return cache;
}

function doesAttackerReachSquare(M: Uint8Array, pieceIndex: number, captPreds: readonly number[]): boolean {
  for (let c = 0; c < captPreds.length; c++) {
    if (M[pieceIndex * 64 + captPreds[c]] === 1) return true;
  }
  return false;
}

function buildAttRegionCache(
  M: Uint8Array,
  N: number,
  captPredsTable: readonly (readonly (readonly number[])[])[],
): number[][] {
  const cache: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    const attReg: number[] = [];
    for (let s = 0; s < 64; s++) {
      if (doesAttackerReachSquare(M, i, captPredsTable[i][s])) {
        attReg.push(s);
      }
    }
    cache[i] = attReg;
  }
  return cache;
}

function buildMobilitySolution(
  ctx: MobilityAnalysisContext,
  saturated: boolean,
  steps: number,
): MobilitySolution {
  const N = ctx.pieces.length;
  const regionCache = buildRegionCache(ctx.M, N);
  const attRegionCache = buildAttRegionCache(ctx.M, N, ctx.captPredsTable);
  const defensivePieces: readonly OriginalPiece[] = ctx.pieces.map((p) => Object.freeze({ ...p }));

  return {
    pieces: defensivePieces,
    saturated,
    steps,
    isReachable(pieceId: number, sq64: number): boolean {
      if (pieceId < 0 || pieceId >= N || sq64 < 0 || sq64 >= 64) return false;
      return ctx.M[pieceId * 64 + sq64] === 1;
    },
    isCleared(pieceId: number): boolean {
      if (pieceId < 0 || pieceId >= N) return false;
      return ctx.C[pieceId] === 1;
    },
    isReachableByNonKing(color: Color, sq64: number): boolean {
      if (sq64 < 0 || sq64 >= 64) return false;
      return color === 'w' ? ctx.Rw[sq64] === 1 : ctx.Rb[sq64] === 1;
    },
    region(pieceId: number): readonly number[] {
      if (pieceId < 0 || pieceId >= N) return [];
      return regionCache[pieceId].slice();
    },
    attRegion(pieceId: number): readonly number[] {
      if (pieceId < 0 || pieceId >= N) return [];
      return attRegionCache[pieceId].slice();
    },
  };
}

/**
 * Computes the mobility solution for a position following Ambrona Figures 6 & 7.
 *
 * @param state Input position state.
 * @param stepBudget Optional maximum iteration step budget before pausing.
 */
export function computeMobility(state: PositionState, stepBudget?: number): MobilitySolution | null {
  const domain = validateMobilityDomain(state, stepBudget);
  if (!domain.ok) return null;

  const { pieces, pieceOnInitialSq } = collectOriginalPieces(state.board);
  const tables = buildPredecessorsTables(pieces);
  const directAttackers = buildDirectAttackers(pieces, tables.captPredsTable);
  const ctx = initializeMobilityContext(pieces, pieceOnInitialSq, tables, directAttackers);

  let steps = 0;
  let saturated = false;

  while (domain.budget === undefined || steps < domain.budget) {
    const reachChanged = runReachabilityPass(ctx);
    const clearChanged = runClearancePass(ctx);

    steps++;
    if (!reachChanged && !clearChanged) {
      saturated = true;
      break;
    }
  }

  return buildMobilitySolution(ctx, saturated, steps);
}
