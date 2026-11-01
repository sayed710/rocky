/**
 * @packageDocumentation
 * Explicit admitted-state boundary validation for unwinnability proof APIs.
 *
 * References:
 * - Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability",
 *   11th International Conference on Fun with Algorithms (FUN 2022),
 *   LIPIcs Vol. 226, pp. 2:1-2:20, DOI: 10.4230/LIPIcs.FUN.2022.2.
 * - Verified author full 25-page version: https://chasolver.org/FUN22-full.pdf
 *   (SHA256: 502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d).
 * - Upstream reference code: chasolver (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).
 */

import { fileOf, rankOf } from './board';
import { FenError } from './fen-error';
import { validatePositionSemantics } from './position-validator';
import type { Color, PositionState } from './types';
import type { PendingReason } from './unwinnability-types';

export interface AdmissionResult {
  readonly ok: boolean;
  readonly reason?: PendingReason;
  readonly message?: string;
}

const VALID_PIECES = new Set(['p', 'n', 'b', 'r', 'q', 'k', 'P', 'N', 'B', 'R', 'Q', 'K']);

function validateVariantAndTurn(s: Partial<PositionState>): AdmissionResult | null {
  if (typeof s.variant === 'string' && s.variant !== 'standard' && s.variant !== 'chess960') {
    return { ok: false, reason: 'unsupported_variant', message: `Unsupported variant: ${String(s.variant)}` };
  }
  if (s.variant !== 'standard' && s.variant !== 'chess960') {
    return { ok: false, reason: 'unsupported_state', message: 'Missing valid variant property' };
  }
  if (s.turn !== 'w' && s.turn !== 'b') {
    return { ok: false, reason: 'unsupported_state', message: `Invalid turn: ${String(s.turn)}` };
  }
  return null;
}

function validatePockets(s: Partial<PositionState>): AdmissionResult | null {
  const pockets = s.pockets;
  if (!pockets || typeof pockets !== 'object') {
    return { ok: false, reason: 'unsupported_state', message: 'Missing pockets structure' };
  }
  const p = pockets as { w?: unknown; b?: unknown };
  if (!Array.isArray(p.w) || !Array.isArray(p.b) || p.w.length !== 0 || p.b.length !== 0) {
    return { ok: false, reason: 'unsupported_state', message: 'Non-empty pockets in orthodox proof domain' };
  }
  return null;
}

function isZeroCounter(c: unknown): boolean {
  return typeof c === 'number' && Number.isInteger(c) && c === 0;
}

function validateCheckCounters(s: Partial<PositionState>): AdmissionResult | null {
  const checkCount = s.checkCount;
  if (!checkCount || typeof checkCount !== 'object') {
    return { ok: false, reason: 'unsupported_state', message: 'Missing check counters' };
  }
  const cc = checkCount as { w?: unknown; b?: unknown };
  if (!isZeroCounter(cc.w) || !isZeroCounter(cc.b)) {
    return { ok: false, reason: 'unsupported_state', message: 'Non-zero or invalid check counters' };
  }
  return null;
}

function isIllegalPawnRank(piece: string, sq: number): boolean {
  if (piece !== 'p' && piece !== 'P') return false;
  const r = rankOf(sq);
  return r === 0 || r === 7;
}

function validateBoardAndPieces(s: Partial<PositionState>): AdmissionResult | null {
  if (!Array.isArray(s.board) || s.board.length !== 128) {
    return { ok: false, reason: 'unsupported_state', message: 'Invalid board representation' };
  }
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = s.board[sq];
    if (piece === null) continue;
    if (typeof piece !== 'string' || !VALID_PIECES.has(piece)) {
      return { ok: false, reason: 'unsupported_state', message: `Invalid piece value at square ${sq}: ${String(piece)}` };
    }
    if (isIllegalPawnRank(piece, sq)) {
      return { ok: false, reason: 'unsupported_state', message: 'Pawn on illegal rank' };
    }
  }
  return null;
}

interface ColorCastlingContext {
  readonly color: Color;
  readonly rights: { readonly k: number; readonly q: number };
  readonly kingSq: number;
  readonly isChess960: boolean;
}

function isStandardRookPresent(
  board: readonly (string | null)[],
  rightFile: number,
  expectedSq: number,
  rookChar: string,
): boolean {
  if (rightFile === -1) return true;
  return rightFile === (expectedSq & 7) && board[expectedSq] === rookChar;
}

function validateStandardRights(
  board: readonly (string | null)[],
  ctx: ColorCastlingContext,
): AdmissionResult | null {
  const isWhite = ctx.color === 'w';
  const cName = isWhite ? 'White' : 'Black';
  const rankNum = isWhite ? '1' : '8';
  if (fileOf(ctx.kingSq) !== 4) {
    return { ok: false, reason: 'unsupported_state', message: `${cName} king must be on e${rankNum} in standard chess with castling rights` };
  }
  const rookChar = isWhite ? 'R' : 'r';
  const baseSq = isWhite ? 0x00 : 0x70;
  if (!isStandardRookPresent(board, ctx.rights.k, baseSq | 7, rookChar)) {
    return { ok: false, reason: 'unsupported_state', message: `${cName} kingside castling requires rook on h${rankNum}` };
  }
  if (!isStandardRookPresent(board, ctx.rights.q, baseSq | 0, rookChar)) {
    return { ok: false, reason: 'unsupported_state', message: `${cName} queenside castling requires rook on a${rankNum}` };
  }
  return null;
}

function validate960Kingside(
  board: readonly (string | null)[],
  ctx: ColorCastlingContext,
): AdmissionResult | null {
  const { k } = ctx.rights;
  if (k === -1) return null;
  const kingFile = fileOf(ctx.kingSq);
  if (k <= kingFile) {
    return { ok: false, reason: 'unsupported_state', message: 'Chess960 kingside rook must be to the right of the king' };
  }
  const isWhite = ctx.color === 'w';
  const baseSq = isWhite ? 0x00 : 0x70;
  const rookChar = isWhite ? 'R' : 'r';
  if (board[baseSq | k] !== rookChar) {
    const cName = isWhite ? 'White' : 'Black';
    return { ok: false, reason: 'unsupported_state', message: `Missing ${cName} rook on held Chess960 kingside castling file` };
  }
  return null;
}

function validate960Queenside(
  board: readonly (string | null)[],
  ctx: ColorCastlingContext,
): AdmissionResult | null {
  const { q } = ctx.rights;
  if (q === -1) return null;
  const kingFile = fileOf(ctx.kingSq);
  if (q >= kingFile) {
    return { ok: false, reason: 'unsupported_state', message: 'Chess960 queenside rook must be to the left of the king' };
  }
  const isWhite = ctx.color === 'w';
  const baseSq = isWhite ? 0x00 : 0x70;
  const rookChar = isWhite ? 'R' : 'r';
  if (board[baseSq | q] !== rookChar) {
    const cName = isWhite ? 'White' : 'Black';
    return { ok: false, reason: 'unsupported_state', message: `Missing ${cName} rook on held Chess960 queenside castling file` };
  }
  return null;
}

function validate960Rights(
  board: readonly (string | null)[],
  ctx: ColorCastlingContext,
): AdmissionResult | null {
  const { k, q } = ctx.rights;
  if (k !== -1 && q !== -1 && k === q) {
    return { ok: false, reason: 'unsupported_state', message: 'Duplicate castling rook files' };
  }

  const kCheck = validate960Kingside(board, ctx);
  if (kCheck) return kCheck;

  const qCheck = validate960Queenside(board, ctx);
  if (qCheck) return qCheck;

  return null;
}

function validateColorCastling(
  board: readonly (string | null)[],
  ctx: ColorCastlingContext,
): AdmissionResult | null {
  if (ctx.rights.k === -1 && ctx.rights.q === -1) return null;
  const isWhite = ctx.color === 'w';
  const expectedRank = isWhite ? 0 : 7;
  const cName = isWhite ? 'White' : 'Black';
  const rankNum = isWhite ? '1' : '8';
  if (ctx.kingSq === -1 || rankOf(ctx.kingSq) !== expectedRank) {
    return { ok: false, reason: 'unsupported_state', message: `${cName} king must be on rank ${rankNum} when castling rights are held` };
  }
  return ctx.isChess960 ? validate960Rights(board, ctx) : validateStandardRights(board, ctx);
}

function isValidCastlingFile(f: unknown): boolean {
  return typeof f === 'number' && Number.isInteger(f) && f >= -1 && f <= 7;
}

function hasValidCastlingFiles(rights: { k?: unknown; q?: unknown }): boolean {
  return isValidCastlingFile(rights.k) && isValidCastlingFile(rights.q);
}

function hasValidCastlingStructure(
  c: unknown,
): c is { w: { k: number; q: number }; b: { k: number; q: number } } {
  if (!c || typeof c !== 'object') return false;
  const cast = c as { w?: { k?: unknown; q?: unknown }; b?: { k?: unknown; q?: unknown } };
  if (!cast.w || !cast.b || typeof cast.w !== 'object' || typeof cast.b !== 'object') return false;
  return hasValidCastlingFiles(cast.w) && hasValidCastlingFiles(cast.b);
}

function findKingSquares(board: readonly (string | null)[]): { wk: number; bk: number } {
  let wk = -1;
  let bk = -1;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    if (board[sq] === 'K') wk = sq;
    else if (board[sq] === 'k') bk = sq;
  }
  return { wk, bk };
}

function validateCastlingAdmission(s: Partial<PositionState>): AdmissionResult | null {
  if (!hasValidCastlingStructure(s.castling)) {
    return { ok: false, reason: 'unsupported_state', message: 'Missing or invalid castling structure' };
  }

  const board = s.board as (string | null)[];
  const { wk, bk } = findKingSquares(board);
  const isChess960 = s.variant === 'chess960';

  const whiteCheck = validateColorCastling(board, { color: 'w', rights: s.castling.w, kingSq: wk, isChess960 });
  if (whiteCheck) return whiteCheck;

  return validateColorCastling(board, { color: 'b', rights: s.castling.b, kingSq: bk, isChess960 });
}

interface EnPassantExpectation {
  readonly expectedRank: number;
  readonly pawnSq: number;
  readonly expectedPawn: string;
  readonly originSq: number;
}

function getEpExpectation(turn: 'w' | 'b', epSq: number): EnPassantExpectation {
  return turn === 'w'
    ? { expectedRank: 5, pawnSq: epSq - 0x10, expectedPawn: 'p', originSq: epSq + 0x10 }
    : { expectedRank: 2, pawnSq: epSq + 0x10, expectedPawn: 'P', originSq: epSq - 0x10 };
}

function isValidBoardSquareIndex(sq: number): boolean {
  return sq >= 0 && sq < 128 && (sq & 0x88) === 0;
}

function validateEnPassantAdmission(s: Partial<PositionState>): AdmissionResult | null {
  if (typeof s.epSquare !== 'number' || !Number.isInteger(s.epSquare)) {
    return { ok: false, reason: 'unsupported_state', message: 'Missing or non-integer en passant square' };
  }
  if (s.epSquare === -1) return null;
  if (!isValidBoardSquareIndex(s.epSquare)) {
    return { ok: false, reason: 'unsupported_state', message: 'Invalid en passant square index' };
  }

  const board = s.board as (string | null)[];
  const exp = getEpExpectation(s.turn as 'w' | 'b', s.epSquare);

  if (rankOf(s.epSquare) !== exp.expectedRank || board[s.epSquare] !== null) {
    return { ok: false, reason: 'unsupported_state', message: 'Invalid en passant rank or non-empty target' };
  }
  if (board[exp.pawnSq] !== exp.expectedPawn || board[exp.originSq] !== null) {
    return { ok: false, reason: 'unsupported_state', message: 'Missing opponent pawn or non-empty double-push origin' };
  }
  return null;
}

function isSafeClock(n: unknown, min: number): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
}

function validateClockMetadata(s: Partial<PositionState>): AdmissionResult | null {
  if (!isSafeClock(s.halfmoves, 0)) {
    return { ok: false, reason: 'unsupported_state', message: 'halfmoves must be a non-negative safe integer' };
  }
  if (!isSafeClock(s.fullmoves, 1)) {
    return { ok: false, reason: 'unsupported_state', message: 'fullmoves must be a positive safe integer (>= 1)' };
  }
  return null;
}

const ADMISSION_VALIDATORS: readonly ((s: Partial<PositionState>) => AdmissionResult | null)[] = [
  validateVariantAndTurn,
  validatePockets,
  validateCheckCounters,
  validateBoardAndPieces,
  validateCastlingAdmission,
  validateEnPassantAdmission,
  validateClockMetadata,
];

/**
 * Validates whether an untrusted or caller-constructed state is within the
 * admitted mathematical domain of the unwinnability theorems and graph search.
 */
export function validateAdmittedProofState(state: unknown): AdmissionResult {
  if (!state || typeof state !== 'object') {
    return { ok: false, reason: 'unsupported_state', message: 'Input state must be an object' };
  }

  const s = state as Partial<PositionState>;
  for (let i = 0; i < ADMISSION_VALIDATORS.length; i++) {
    const res = ADMISSION_VALIDATORS[i](s);
    if (res) return res;
  }

  try {
    validatePositionSemantics(s as PositionState);
  } catch (error) {
    if (error instanceof FenError) {
      return { ok: false, reason: 'unsupported_state', message: error.message };
    }
    throw error;
  }

  return { ok: true };
}
