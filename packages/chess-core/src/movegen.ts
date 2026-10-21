/**
 * @packageDocumentation
 * Move generation, attack detection, and move application.
 *
 * The public surface is {@link generateLegalMoves} and {@link applyMove}, both
 * pure with respect to their input (they never mutate the argument state).
 * Standard-chess correctness is verified by the `perft` suite against published
 * reference node counts (start position and "Kiwipete").
 */

import {
  BISHOP_OFFSETS,
  KING_OFFSETS,
  KNIGHT_OFFSETS,
  ROOK_OFFSETS,
  colorOf,
  fileOf,
  makePiece,
  makeSquare,
  onBoard,
  opposite,
  rankOf,
  typeOf,
} from './board';
import {
  NO_CASTLING_ROOK,
  backRankOf,
  castledKingSquare,
  castledRookSquare,
  clearColorRights,
  clearRightsForSquare,
  cloneCastlingRights,
} from './castling';
import { cloneState } from './fen';
import {
  MoveFlag,
  type CastlingRights,
  type CastlingSide,
  type Color,
  type Move,
  type Piece,
  type PieceType,
  type PositionState,
} from './types';

const PROMOTION_TYPES: readonly PieceType[] = ['q', 'r', 'b', 'n'];

/** Locate the king of `color`. Returns -1 if there is none (variant edge case). */
export function findKing(state: PositionState, color: Color): number {
  const king = makePiece(color, 'k');
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) === 0 && state.board[sq] === king) return sq;
  }
  return -1;
}

/**
 * Is square `sq` attacked by any piece of color `by`?
 * Used for check detection, castling legality, and variant rules.
 */
export function isSquareAttacked(state: PositionState, sq: number, by: Color): boolean {
  const board = state.board;

  // Pawn attacks. A white pawn on x attacks x+15 and x+17.
  if (by === 'w') {
    if (board[sq - 17] === 'P' && onBoard(sq - 17)) return true;
    if (board[sq - 15] === 'P' && onBoard(sq - 15)) return true;
  } else {
    if (board[sq + 17] === 'p' && onBoard(sq + 17)) return true;
    if (board[sq + 15] === 'p' && onBoard(sq + 15)) return true;
  }

  // Knight attacks.
  const knight = makePiece(by, 'n');
  for (const off of KNIGHT_OFFSETS) {
    const t = sq + off;
    if (onBoard(t) && board[t] === knight) return true;
  }

  // King attacks.
  const king = makePiece(by, 'k');
  for (const off of KING_OFFSETS) {
    const t = sq + off;
    if (onBoard(t) && board[t] === king) return true;
  }

  // Sliding: bishop/queen on diagonals.
  const bishop = makePiece(by, 'b');
  const queen = makePiece(by, 'q');
  for (const off of BISHOP_OFFSETS) {
    let t = sq + off;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== null) {
        if (p === bishop || p === queen) return true;
        break;
      }
      t += off;
    }
  }

  // Sliding: rook/queen on ranks/files.
  const rook = makePiece(by, 'r');
  for (const off of ROOK_OFFSETS) {
    let t = sq + off;
    while (onBoard(t)) {
      const p = board[t];
      if (p !== null) {
        if (p === rook || p === queen) return true;
        break;
      }
      t += off;
    }
  }

  return false;
}

/** True if the side `color`'s king is currently in check. */
export function inCheck(state: PositionState, color: Color): boolean {
  const k = findKing(state, color);
  if (k === -1) return false;
  // Atomic: a king can never capture (it would explode), so kings standing next to each other
  // ("connected") cannot be in check — the enemy king shields its neighbour from every capture.
  if (state.variant === 'atomic' && isAdjacent(k, findKing(state, opposite(color)))) return false;
  return isSquareAttacked(state, k, opposite(color));
}

/** True if 0x88 squares `a` and `b` (either may be -1) are a king step apart. */
function isAdjacent(a: number, b: number): boolean {
  return a !== -1 && b !== -1 && KING_OFFSETS.includes(b - a);
}

function pushMove(list: Move[], m: Move): void {
  list.push(m);
}

/** Generate pseudo-legal moves (may leave own king in check). */
export function generatePseudoLegal(state: PositionState): Move[] {
  const moves: Move[] = [];
  const us = state.turn;
  const them = opposite(us);
  const board = state.board;
  const forward = us === 'w' ? 16 : -16;
  const startRank = us === 'w' ? 1 : 6;
  const promoRank = us === 'w' ? 7 : 0;

  for (let from = 0; from < 128; from++) {
    if ((from & 0x88) !== 0) continue;
    const piece = board[from];
    if (piece === null || colorOf(piece) !== us) continue;
    const kind = typeOf(piece);

    switch (kind) {
      case 'p': {
        // Single push.
        const one = from + forward;
        if (onBoard(one) && board[one] === null) {
          if (rankOf(one) === promoRank) {
            for (const promo of PROMOTION_TYPES) {
              pushMove(moves, { from, to: one, piece, promotion: promo, flags: MoveFlag.Promotion });
            }
          } else {
            pushMove(moves, { from, to: one, piece, flags: MoveFlag.Normal });
            // Double push.
            const canDouble = rankOf(from) === startRank || (state.variant === 'horde' && us === 'w' && rankOf(from) === 0);
            if (canDouble) {
              const two = from + forward * 2;
              if (board[two] === null) {
                pushMove(moves, { from, to: two, piece, flags: MoveFlag.DoublePawnPush });
              }
            }
          }
        }
        // Captures (including en passant).
        for (const diag of us === 'w' ? [15, 17] : [-15, -17]) {
          const to = from + diag;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target !== null && colorOf(target) === them) {
            if (rankOf(to) === promoRank) {
              for (const promo of PROMOTION_TYPES) {
                pushMove(moves, {
                  from, to, piece, captured: target, promotion: promo,
                  flags: MoveFlag.Capture | MoveFlag.Promotion,
                });
              }
            } else {
              pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
            }
          } else if (to === state.epSquare && state.epSquare !== -1) {
            const capturedSq = to - forward;
            pushMove(moves, {
              from, to, piece, captured: board[capturedSq] as Piece,
              flags: MoveFlag.Capture | MoveFlag.EnPassant,
            });
          }
        }
        break;
      }

      case 'n': {
        for (const off of KNIGHT_OFFSETS) {
          const to = from + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target === null) {
            pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
          } else if (colorOf(target) === them) {
            pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
          }
        }
        break;
      }

      case 'k': {
        for (const off of KING_OFFSETS) {
          const to = from + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target === null) {
            pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
          } else if (colorOf(target) === them) {
            pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
          }
        }
        generateCastles(state, from, piece, moves);
        break;
      }

      case 'b': generateSliding(state, from, piece, BISHOP_OFFSETS, moves); break;
      case 'r': generateSliding(state, from, piece, ROOK_OFFSETS, moves); break;
      case 'q': generateSliding(state, from, piece, KING_OFFSETS, moves); break;
    }
  }

  // Crazyhouse drops.
  if (state.variant === 'crazyhouse') {
    generateDrops(state, moves);
  }

  return moves;
}

function generateSliding(
  state: PositionState,
  from: number,
  piece: Piece,
  offsets: readonly number[],
  moves: Move[],
): void {
  const board = state.board;
  const them = opposite(colorOf(piece));
  for (const off of offsets) {
    let to = from + off;
    while (onBoard(to)) {
      const target = board[to];
      if (target === null) {
        pushMove(moves, { from, to, piece, flags: MoveFlag.Normal });
      } else {
        if (colorOf(target) === them) {
          pushMove(moves, { from, to, piece, captured: target, flags: MoveFlag.Capture });
        }
        break;
      }
      to += off;
    }
  }
}

const CASTLING_SIDES: readonly CastlingSide[] = ['k', 'q'];

/** Where the king and rooks must stand to castle in every rule set except Chess960. */
const TRADITIONAL_KING_FILE = 4;
const TRADITIONAL_ROOK_FILES: Readonly<Record<CastlingSide, number>> = { k: 7, q: 0 };

/**
 * Every square the king and the rook pass over, the two movers themselves excepted, must be empty.
 *
 * Both spans are checked, not just the king's. In standard chess the rook's span is contained in
 * the king's for the kingside and adds only b1 for the queenside, which is why a hardcoded
 * three-square test worked. In Chess960 the rook can start further out than the king travels, or on
 * the far side of where the king lands, so neither span contains the other.
 *
 * The king and the castling rook are skipped by square rather than by piece kind, because either may
 * already be standing on its own destination and must not be read as an obstruction to itself.
 */
function castlingSpanClear(
  board: readonly (Piece | null)[],
  kingFrom: number,
  kingTo: number,
  rookFrom: number,
  rookTo: number,
): boolean {
  const rank = rankOf(kingFrom);
  for (const [a, b] of [[kingFrom, kingTo], [rookFrom, rookTo]] as const) {
    const lo = Math.min(fileOf(a), fileOf(b));
    const hi = Math.max(fileOf(a), fileOf(b));
    for (let file = lo; file <= hi; file++) {
      const sq = makeSquare(file, rank);
      if (sq === kingFrom || sq === rookFrom) continue;
      if (board[sq] !== null) return false;
    }
  }
  return true;
}

/**
 * The king may not castle out of, through, or into check.
 *
 * Every square from its origin to its destination inclusive is tested, which in Chess960 may be no
 * squares of movement at all (a king already on g1 castling kingside) or as many as four. The
 * destination is tested here as well as by the ordinary post-move legality filter; that is
 * deliberate redundancy, since the two look at different boards — this one before the rook has
 * moved, the filter after.
 *
 * Note what is *not* tested: the rook's own path. A rook may legally pass over an attacked square,
 * and only the king's transit is constrained. Conflating the two is the classic Chess960 castling
 * bug and would refuse legal moves.
 */
function kingPathSafe(state: PositionState, kingFrom: number, kingTo: number, them: Color): boolean {
  const rank = rankOf(kingFrom);
  const lo = Math.min(fileOf(kingFrom), fileOf(kingTo));
  const hi = Math.max(fileOf(kingFrom), fileOf(kingTo));
  // Atomic: a square next to the enemy king is safe for ours, since connected kings are never in check.
  const shield = state.variant === 'atomic' ? findKing(state, them) : -1;
  for (let file = lo; file <= hi; file++) {
    const sq = makeSquare(file, rank);
    if (!isAdjacent(sq, shield) && isSquareAttacked(state, sq, them)) return false;
  }
  return true;
}

/**
 * Castling from wherever the king and the chosen rook actually stand — in Chess960.
 *
 * For Chess960 nothing here assumes the e-file, the a/h-files, or that the king moves two squares:
 * the rook is read from the castling rights, which name it by file, and the destinations are the
 * fixed g/f and c/d squares that standard chess already uses.
 *
 * **Every other rule set keeps the traditional origins, and that is a rule rather than a
 * coincidence.** Ordinary chess does not merely happen to castle from e1 with the rook on a or h; it
 * permits nothing else. Applying the general form everywhere let a standard position with a king on
 * d1 and a rook on h1 produce `d1g1` — a legal Chess960 castle and an illegal standard one. Raised
 * in the Qodo review of PR #10.
 */
function generateCastles(state: PositionState, from: number, piece: Piece, moves: Move[]): void {
  const us = colorOf(piece);
  // Racing Kings has no castling at all.
  //
  // Horde is deliberately *not* excluded here, though it used to be. Only White is a horde of
  // pawns; Black is an ordinary army with a king, and `HORDE_FEN` grants it `kq` — so the engine
  // was handing Black rights it then refused to honour. Excluding White is unnecessary as well as
  // insufficient: White has no king, so this function is only ever reached for Black anyway, being
  // called from the king branch of `generatePseudoLegal`. Raised in the CodeRabbit review of PR #10;
  // see ADR-0136.
  if (state.variant === 'racingkings') return;

  const backRank = backRankOf(us);
  if (rankOf(from) !== backRank) return;

  // Outside Chess960 the king castles only from its e-file home square.
  const arbitraryOrigins = state.variant === 'chess960';
  if (!arbitraryOrigins && fileOf(from) !== TRADITIONAL_KING_FILE) return;

  // "May not castle out of check" is enforced by `kingPathSafe` below, not by a separate test here.
  // That function walks from the king's origin to its destination inclusive, so the origin is
  // already among the squares required to be unattacked. A second early return would restate the
  // same rule in a form no test could tell apart from the first.
  const them = opposite(us);

  for (const side of CASTLING_SIDES) {
    const rookFile = state.castling[us][side];
    if (rookFile === NO_CASTLING_ROOK) continue;
    // ...and only with the rook on a or h. A standard position whose kingside right had been
    // resolved to a rook on g1 would otherwise castle with it.
    if (!arbitraryOrigins && rookFile !== TRADITIONAL_ROOK_FILES[side]) continue;

    const rookFrom = makeSquare(rookFile, backRank);
    // A right whose rook is not standing there cannot be exercised. Rights are kept in step with
    // the board on every move, so this is a guard against a hand-written FEN rather than drift.
    if (state.board[rookFrom] !== makePiece(us, 'r')) continue;

    const kingTo = castledKingSquare(us, side);
    const rookTo = castledRookSquare(us, side);
    if (!castlingSpanClear(state.board, from, kingTo, rookFrom, rookTo)) continue;
    if (!kingPathSafe(state, from, kingTo, them)) continue;

    pushMove(moves, {
      from,
      to: kingTo,
      piece,
      castleRook: rookFrom,
      flags: side === 'k' ? MoveFlag.KingCastle : MoveFlag.QueenCastle,
    });
  }
}

function generateDrops(state: PositionState, moves: Move[]): void {
  const us = state.turn;
  const pocket = state.pockets[us];
  const seen = new Set<PieceType>();
  for (const type of pocket) {
    if (seen.has(type)) continue;
    seen.add(type);
    for (let to = 0; to < 128; to++) {
      if ((to & 0x88) !== 0) continue;
      if (state.board[to] !== null) continue;
      // Pawns may not be dropped on the 1st or 8th rank.
      if (type === 'p') {
        const r = rankOf(to);
        if (r === 0 || r === 7) continue;
      }
      moves.push({ from: -1, to, piece: makePiece(us, type), drop: type, flags: MoveFlag.Normal });
    }
  }
}

/**
 * Apply a move to a *copy* of `state` and return the new state. The input state
 * is never mutated. Handles captures, promotions, en passant, castling,
 * castling-right updates, halfmove/fullmove clocks, and variant side effects.
 */
export function applyMove(state: PositionState, move: Move): PositionState {
  const next = cloneState(state);
  const board = next.board;
  const us = state.turn;
  const them = opposite(us);

  next.epSquare = -1;

  if (move.drop) {
    // Crazyhouse drop.
    board[move.to] = move.piece;
    const idx = next.pockets[us].indexOf(move.drop);
    if (idx !== -1) next.pockets[us].splice(idx, 1);
    next.halfmoves = 0;
  } else if (move.flags & (MoveFlag.KingCastle | MoveFlag.QueenCastle)) {
    // Castling is written as its own branch because the general path cannot express it. In
    // Chess960 the king's origin, the rook's origin and the two destinations may be any
    // combination of the same four squares — a king already on g1, a rook already on f1, a king
    // and rook that swap — so clearing an origin after placing a destination can erase a piece
    // that was just put down. Both origins are vacated first, then both destinations written.
    const side: CastlingSide = move.flags & MoveFlag.KingCastle ? 'k' : 'q';
    const rookFrom = move.castleRook;
    if (rookFrom === undefined) {
      // `applyMove` is exported, so a caller can hand it a move this package did not generate.
      // Without the rook's origin there is no square to vacate, and the writes below would leave a
      // rook standing on both its old square and its new one — a position quietly wrong rather than
      // obviously broken. Refusing is the only honest answer.
      // Deliberately a plain Error: `IllegalMoveError` lives in `position.ts`, which imports this
      // module, and importing it back would make the cycle real for the sake of a label.
      throw new Error('A castling move must carry castleRook, the square its rook starts on');
    }
    const rookTo = castledRookSquare(us, side);
    board[move.from] = null;
    board[rookFrom] = null;
    board[move.to] = makePiece(us, 'k');
    board[rookTo] = makePiece(us, 'r');
    next.halfmoves = state.halfmoves + 1;
    next.castling = updateCastlingRights(state.castling, move);
  } else {
    const movingPiece = board[move.from];
    board[move.from] = null;

    // Handle capture bookkeeping (pocket for crazyhouse).
    if (move.flags & MoveFlag.EnPassant) {
      const capturedSq = move.to - (us === 'w' ? 16 : -16);
      const capd = board[capturedSq];
      board[capturedSq] = null;
      if (next.variant === 'crazyhouse' && capd) next.pockets[us].push('p');
    } else if (move.captured) {
      if (next.variant === 'crazyhouse') {
        // Demoted pieces return as pawns per Crazyhouse rules.
        next.pockets[us].push(typeOf(move.captured));
      }
    }

    // Place piece (with promotion).
    if (move.promotion) {
      board[move.to] = makePiece(us, move.promotion);
    } else {
      board[move.to] = movingPiece;
    }

    // Double pawn push sets the en-passant target (only from standard starting rank).
    if ((move.flags & MoveFlag.DoublePawnPush) && rankOf(move.from) === (us === 'w' ? 1 : 6)) {
      next.epSquare = move.from + (us === 'w' ? 16 : -16);
    }

    // Halfmove clock: reset on pawn move or capture.
    if (typeOf(move.piece) === 'p' || move.captured) next.halfmoves = 0;
    else next.halfmoves = state.halfmoves + 1;

    // Update castling rights.
    next.castling = updateCastlingRights(state.castling, move);

    // Atomic explosion.
    if (next.variant === 'atomic' && move.captured) {
      explode(next, move.to);
    }
  }

  // Three-check accounting.
  if (next.variant === 'threecheck') {
    if (inCheck(next, them)) next.checkCount[us] += 1;
  }

  next.turn = them;
  if (us === 'b') next.fullmoves = state.fullmoves + 1;
  return next;
}

/**
 * Rights after a move.
 *
 * The standard version switched on the four corner squares, which is correct only while the rooks
 * start in the corners. Rights now name the rook by file, so a right dies when something happens
 * on the square that rook occupies — it moving away, or an enemy capturing it there — whichever
 * file that is. `clearRightsForSquare` also checks the rank, so a move on White's back rank can
 * never disturb Black's rights.
 */
function updateCastlingRights(rights: CastlingRights, move: Move): CastlingRights {
  const next = cloneCastlingRights(rights);
  if (typeOf(move.piece) === 'k') clearColorRights(next, colorOf(move.piece));
  clearRightsForSquare(next, move.from);
  clearRightsForSquare(next, move.to);
  // A castling rook vacates a square that is neither `from` nor `to`.
  if (move.castleRook !== undefined) clearRightsForSquare(next, move.castleRook);
  return next;
}

/** Atomic: remove the captured piece, the capturer, and all adjacent non-pawns. */
function explode(state: PositionState, at: number): void {
  const board = state.board;
  board[at] = null; // capturer
  for (const off of KING_OFFSETS) {
    const sq = at + off;
    if (!onBoard(sq)) continue;
    const p = board[sq];
    if (p !== null && typeOf(p) !== 'p') board[sq] = null;
  }
}

/**
 * Generate fully legal moves for the side to move, respecting the position's
 * variant (check rules, atomic king-adjacency, king-of-the-hill, etc.).
 */
export function generateLegalMoves(state: PositionState): Move[] {
  const pseudo = generatePseudoLegal(state);
  const us = state.turn;
  const legal: Move[] = [];

  for (const move of pseudo) {
    const next = applyMove(state, move);
    if (isLegalAfter(state, next, us)) legal.push(move);
  }
  return legal;
}

function isLegalAfter(before: PositionState, after: PositionState, us: Color): boolean {
  const them = opposite(us);

  if (before.variant === 'atomic') {
    // A move that destroys your own king is illegal even if the enemy king goes with it (#127):
    // that covers every king capture, since the capturer always explodes.
    if (findKing(after, us) === -1) return false;
    if (findKing(after, them) === -1) return true; // you exploded their king → legal & winning
    return !inCheck(after, us); // connected kings are never in check
  }

  if (before.variant === 'racingkings') {
    // No move may leave *either* king in check (racing kings forbids checks).
    if (inCheck(after, us) || inCheck(after, them)) return false;
    return true;
  }

  // Standard rule: your king must not be in check after your move.
  const myKing = findKing(after, us);
  if (myKing === -1) {
    // Horde's pawn army has no king and therefore no check constraint.
    // Any other kingless side is a terminal/illegal position.
    return before.variant === 'horde';
  }
  return !isSquareAttacked(after, myKing, them);
}
