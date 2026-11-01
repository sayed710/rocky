/**
 * @packageDocumentation
 * Core domain types for the chess engine.
 *
 * The engine uses the 0x88 board representation: a 128-element array where a
 * square index encodes rank and file as `rank * 16 + file`. A square is off the
 * board iff `(index & 0x88) !== 0`. This makes off-board detection a single
 * bitwise AND and makes sliding-piece generation branch-light.
 */

/** Piece colors. */
export type Color = 'w' | 'b';

/** Piece kinds using standard algebraic letters (lowercase). */
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/**
 * A piece on the board, encoded as a single character:
 * uppercase = white, lowercase = black. e.g. `'P'` white pawn, `'k'` black king.
 */
export type Piece =
  | 'P' | 'N' | 'B' | 'R' | 'Q' | 'K'
  | 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Supported rule sets. Each variant only overrides what differs from standard. */
export type Variant =
  | 'standard'
  | 'chess960'
  | 'kingofthehill'
  | 'atomic'
  | 'crazyhouse'
  | 'threecheck'
  | 'horde'
  | 'racingkings';

/** The two castling directions: `k` toward the h-file, `q` toward the a-file. */
export type CastlingSide = 'k' | 'q';

/**
 * One colour's castling rights, each held as the **file** of the rook that carries it, or `-1`.
 *
 * Standard chess can imply the rook — kingside is h, queenside is a — which is why a four-bit mask
 * was enough for it. Chess960 starts the rooks on arbitrary files, so the implication fails and a
 * mask cannot say which rook a right belongs to. Naming the file keeps rook identity in the state
 * itself rather than in an assumption about the board.
 */
export interface ColorCastlingRights {
  k: number;
  q: number;
}

/** Castling rights for both colours. See {@link ColorCastlingRights}. */
export interface CastlingRights {
  w: ColorCastlingRights;
  b: ColorCastlingRights;
}

/** Bit flags describing the nature of a move. */
export const enum MoveFlag {
  Normal = 0,
  Capture = 1 << 0,
  DoublePawnPush = 1 << 1,
  EnPassant = 1 << 2,
  KingCastle = 1 << 3,
  QueenCastle = 1 << 4,
  Promotion = 1 << 5,
}

/**
 * A fully-specified move. `from`/`to` are 0x88 square indices. For Crazyhouse
 * drops, `from` is -1 and `drop` names the piece being placed.
 */
export interface Move {
  readonly from: number;
  readonly to: number;
  readonly piece: Piece;
  readonly captured?: Piece;
  readonly promotion?: PieceType;
  readonly drop?: PieceType;
  /**
   * For a castling move, the 0x88 square the rook starts on.
   *
   * `to` remains the king's final square in every variant, so nothing that reads a move has to
   * know about Chess960. The rook cannot be re-derived from `from` by a fixed offset once it may
   * start anywhere, so the move has to carry it.
   */
  readonly castleRook?: number;
  readonly flags: number;
}

/**
 * A complete, self-contained game position. Immutable from the caller's
 * perspective — mutation happens only inside {@link Position.applyMove} via an
 * internal clone, so previously-returned positions are never altered.
 */
export interface PositionState {
  /** 0x88 board; each cell is a {@link Piece} or `null`. */
  board: (Piece | null)[];
  turn: Color;
  /** Castling rights, each naming the rook that carries it. See {@link CastlingRights}. */
  castling: CastlingRights;
  /** En-passant target square (0x88 index) or -1 if none. */
  epSquare: number;
  /** Halfmove clock for the fifty-move rule. */
  halfmoves: number;
  /** Fullmove counter, starts at 1, increments after Black moves. */
  fullmoves: number;
  /** Crazyhouse pockets: captured pieces available to drop. */
  pockets: { w: PieceType[]; b: PieceType[] };
  /** Three-check: checks delivered by each side. */
  checkCount: { w: number; b: number };
  variant: Variant;
}

/** Result of a legality/termination query. */
export type GameStatus =
  | { over: false }
  | { over: true; reason: 'checkmate'; winner: Color }
  | { over: true; reason: 'stalemate' }
  | { over: true; reason: 'insufficient_material' }
  | { over: true; reason: 'fifty_move' }
  | { over: true; reason: 'threefold' }
  | { over: true; reason: 'variant_win'; winner: Color }
  | { over: true; reason: 'variant_draw' }
  | { over: true; reason: 'dead_position' };
