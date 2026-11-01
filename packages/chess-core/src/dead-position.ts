/**
 * @packageDocumentation
 * Bounded frozen King and Pawn dead-position certificate for Standard and Chess960.
 *
 * Implements a pure, sufficient mathematical proof that neither side can ever
 * deliver checkmate by any possible series of legal moves under FIDE Article 5.2.2.
 */

import {
  KING_OFFSETS,
  colorOf,
  fileOf,
  onBoard,
  opposite,
  rankOf,
  typeOf,
} from './board';
import { generateLegalMoves, inCheck } from './movegen';
import type { Color, PositionState } from './types';

/** Compute diagonal attack destinations for a pawn at sq. */
function pawnAttackSquares(sq: number, color: Color): number[] {
  const attacks: number[] = [];
  const file = fileOf(sq);
  if (color === 'w') {
    if (file > 0) {
      const left = sq + 15;
      if (onBoard(left)) attacks.push(left);
    }
    if (file < 7) {
      const right = sq + 17;
      if (onBoard(right)) attacks.push(right);
    }
  } else {
    if (file > 0) {
      const left = sq - 17;
      if (onBoard(left)) attacks.push(left);
    }
    if (file < 7) {
      const right = sq - 15;
      if (onBoard(right)) attacks.push(right);
    }
  }
  return attacks;
}

interface DomainKings {
  wk: number;
  bk: number;
}

/** Validate domain, composition, and rank constraints. */
function validateDomainAndComposition(state: PositionState): DomainKings | null {
  if (state.variant !== 'standard' && state.variant !== 'chess960') {
    return null;
  }
  if (state.pockets.w.length > 0 || state.pockets.b.length > 0) {
    return null;
  }
  if (
    state.castling.w.k !== -1 ||
    state.castling.w.q !== -1 ||
    state.castling.b.k !== -1 ||
    state.castling.b.q !== -1
  ) {
    return null;
  }
  if (state.epSquare !== -1) {
    return null;
  }

  let whiteKings = 0;
  let blackKings = 0;
  let whitePawns = 0;
  let blackPawns = 0;
  let wk = -1;
  let bk = -1;

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = state.board[sq];
    if (piece === null) continue;

    const type = typeOf(piece);
    const color = colorOf(piece);

    if (type === 'k') {
      if (color === 'w') {
        whiteKings++;
        wk = sq;
      } else {
        blackKings++;
        bk = sq;
      }
    } else if (type === 'p') {
      const r = rankOf(sq);
      if (r === 0 || r === 7) {
        return null;
      }
      if (color === 'w') {
        whitePawns++;
      } else {
        blackPawns++;
      }
    } else {
      return null;
    }
  }

  if (whiteKings !== 1 || blackKings !== 1 || whitePawns + blackPawns === 0) {
    return null;
  }

  // Kings nonadjacent
  if (
    Math.abs(rankOf(wk) - rankOf(bk)) <= 1 &&
    Math.abs(fileOf(wk) - fileOf(bk)) <= 1
  ) {
    return null;
  }

  // Side not to move not in check
  if (inCheck(state, opposite(state.turn))) {
    return null;
  }

  return { wk, bk };
}

/** Verify every pawn is forward-blocked by a pawn and has no diagonal captures. */
function verifyPawnGridlock(state: PositionState): boolean {
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = state.board[sq];
    if (piece === null || typeOf(piece) !== 'p') continue;

    const color = colorOf(piece);
    const forwardSq = color === 'w' ? sq + 16 : sq - 16;
    if (!onBoard(forwardSq)) return false;

    const forwardPiece = state.board[forwardSq];
    if (forwardPiece === null || typeOf(forwardPiece) !== 'p') {
      return false;
    }

    const enemyPawn = color === 'w' ? 'p' : 'P';
    for (const attackSq of pawnAttackSquares(sq, color)) {
      if (state.board[attackSq] === enemyPawn) {
        return false;
      }
    }
  }
  return true;
}

/** Compute static pawn attack/defense masks for both colors. */
function computeStaticPawnAttackMasks(state: PositionState): { Aw: boolean[]; Ab: boolean[] } {
  const Aw = new Array(128).fill(false);
  const Ab = new Array(128).fill(false);

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = state.board[sq];
    if (piece === null || typeOf(piece) !== 'p') continue;

    const color = colorOf(piece);
    const targetMask = color === 'w' ? Aw : Ab;
    for (const attackSq of pawnAttackSquares(sq, color)) {
      targetMask[attackSq] = true;
    }
  }
  return { Aw, Ab };
}

/** Conservative BFS flood of reachable squares from king square. */
function floodKingReachability(
  state: PositionState,
  kingSq: number,
  enemyAttackMask: boolean[],
): boolean[] {
  const visited = new Array(128).fill(false);
  const queue: number[] = [kingSq];
  visited[kingSq] = true;
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++];
    for (const off of KING_OFFSETS) {
      const nextSq = curr + off;
      if (!onBoard(nextSq)) continue;
      if (
        Math.abs(fileOf(nextSq) - fileOf(curr)) > 1 ||
        Math.abs(rankOf(nextSq) - rankOf(curr)) > 1
      ) {
        continue;
      }
      if (visited[nextSq]) continue;

      // Pawns are impassable barriers
      const targetPiece = state.board[nextSq];
      if (targetPiece !== null && typeOf(targetPiece) === 'p') {
        continue;
      }

      // Squares attacked by enemy pawns are legally impassable
      if (enemyAttackMask[nextSq]) {
        continue;
      }

      // Kings are ignored as obstacles and enemy king attacks are ignored (superset)
      visited[nextSq] = true;
      queue.push(nextSq);
    }
  }
  return visited;
}

/** Check if any reached square is adjacent to an enemy pawn lacking fixed defense. */
function hasReachableUnprotectedPawn(
  state: PositionState,
  visited: boolean[],
  enemyPawn: string,
  enemyDefenseMask: boolean[],
): boolean {
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0 || !visited[sq]) continue;

    for (const off of KING_OFFSETS) {
      const adjSq = sq + off;
      if (!onBoard(adjSq)) continue;
      if (
        Math.abs(fileOf(adjSq) - fileOf(sq)) > 1 ||
        Math.abs(rankOf(adjSq) - rankOf(sq)) > 1
      ) {
        continue;
      }

      if (state.board[adjSq] === enemyPawn) {
        // Unprotected enemy pawn adjacent to reachable square
        if (!enemyDefenseMask[adjSq]) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Pure sufficient certificate for the frozen King/Pawn dead position subclass.
 *
 * Returns true if the position is proven to be an unalterable dead position:
 * - Domain: standard or chess960 variants only.
 * - Piece composition: exactly one King per color, pawns only, at least one pawn.
 * - Legal guards: kings nonadjacent, side not to move not in check, no rank 1/8 pawns,
 *   no crazyhouse pockets, no castling rights, epSquare === -1.
 * - Pawn immobility: every pawn is forward-blocked by another pawn of either color,
 *   and neither pawn-attack destination contains an enemy pawn.
 * - Static attack masks: fixed pawn attack masks Aw and Ab are computed.
 * - Conservative reachability: a BFS flood from each king over non-pawn squares excluding
 *   enemy pawn attacks (ignoring kings as obstacles and enemy king attacks) proves that
 *   no reached square neighbors an enemy pawn that lacks fixed pawn defense.
 * - Root escape: if the side to move is checked, verifies it has a legal escape.
 */
export function isFrozenDeadPosition(state: PositionState): boolean {
  const kings = validateDomainAndComposition(state);
  if (!kings) return false;

  if (!verifyPawnGridlock(state)) return false;

  const { Aw, Ab } = computeStaticPawnAttackMasks(state);

  // White king reachability and barrier check
  const whiteVisited = floodKingReachability(state, kings.wk, Ab);
  if (hasReachableUnprotectedPawn(state, whiteVisited, 'p', Ab)) {
    return false;
  }

  // Black king reachability and barrier check
  const blackVisited = floodKingReachability(state, kings.bk, Aw);
  if (hasReachableUnprotectedPawn(state, blackVisited, 'P', Aw)) {
    return false;
  }

  // Root escape check: must not be checkmate or stalemate
  if (generateLegalMoves(state).length === 0) {
    return false;
  }

  return true;
}
