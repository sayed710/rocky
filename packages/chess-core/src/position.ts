/**
 * @packageDocumentation
 * High-level, ergonomic wrapper around the functional core. `Position` is
 * immutable: {@link Position.play} returns a new instance.
 */

import { fileOf, opposite, rankOf, squareFromName, squareName, typeOf } from './board';
import { START_FEN, cloneState, parseFen, toFen } from './fen';
import { CHESS960_STANDARD_ID, chess960Fen } from './chess960';
import {
  applyMove,
  findKing,
  generateLegalMoves,
  inCheck,
} from './movegen';
import { MoveFlag, type Color, type GameStatus, type Move, type PositionState, type Variant } from './types';

/** Thrown when an illegal or unpardeable move is played. */
export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

export class Position {
  private readonly state: PositionState;
  private cachedLegal: readonly Move[] | null = null;

  private constructor(state: PositionState) {
    this.state = state;
  }

  /**
   * Create the starting position for a variant.
   *
   * Chess960 resolves to starting-position 518, the traditional array, and does so on every
   * call. Choosing one of the 960 at random is a decision for whoever starts a game, not for the
   * rules engine: a core that reached for entropy here would make every position it produced
   * unreproducible, and callers that legitimately want a fixed position — tests, analysis,
   * replaying a stored game — would have no way to ask for one. Use {@link Position.chess960} to
   * name the arrangement you want.
   */
  static initial(variant: Variant = 'standard'): Position {
    if (variant === 'horde') return Position.fromFen(HORDE_FEN, 'horde');
    if (variant === 'racingkings') return Position.fromFen(RACING_KINGS_FEN, 'racingkings');
    if (variant === 'chess960') return Position.chess960(CHESS960_STANDARD_ID);
    return Position.fromFen(START_FEN, variant);
  }

  /**
   * Create the Chess960 starting position with Scharnagl id `id` (0..959).
   *
   * Deterministic: the same id always gives the same position. Throws `RangeError` for an
   * id outside the range.
   */
  static chess960(id: number): Position {
    return Position.fromFen(chess960Fen(id), 'chess960');
  }

  /** Create a position from FEN. */
  static fromFen(fen: string, variant: Variant = 'standard'): Position {
    return new Position(parseFen(fen, variant));
  }

  /** The side to move. */
  get turn(): Color {
    return this.state.turn;
  }

  /** The variant of this position. */
  get variant(): Variant {
    return this.state.variant;
  }

  /** Serialize to FEN. */
  fen(): string {
    return toFen(this.state);
  }

  /**
   * Raw, defensively-cloned state.
   *
   * Cloned directly rather than round-tripped through FEN. The FEN form is deliberately the
   * standard six fields, and Three-Check counters are not among them, so serialising and
   * reparsing silently reset both to zero — a snapshot that quietly disagreed with the position
   * it came from. That was not merely lossy in theory: `repetitionKey` includes the counters for
   * `threecheck`, and it is built from this snapshot, so every three-check position compared
   * equal on counters that were always zero and a game could be declared a threefold draw across
   * positions whose real check counts differed. See ADR-0099 §4.
   *
   * `cloneState` is the existing authoritative deep copy and stays the single place that knows
   * which fields a `PositionState` has; extending the state without extending it there is the
   * mistake this method must not make again.
   *
   * Serialising a three-check position to FEN is still lossy. That is a separate, external
   * question — it needs a wire format and an engine convention — and is deferred.
   */
  snapshot(): PositionState {
    return cloneState(this.state);
  }

  /** All legal moves in the current position. Memoized; the returned array is frozen at runtime. */
  legalMoves(): readonly Move[] {
    let cached = this.cachedLegal;
    if (cached === null) {
      cached = Object.freeze(generateLegalMoves(this.state));
      this.cachedLegal = cached;
    }
    return cached;
  }

  /** Is the side to move in check? */
  isCheck(): boolean {
    return inCheck(this.state, this.state.turn);
  }

  /**
   * Play a move given as a `Move`, a UCI string (`"e2e4"`, `"e7e8q"`), or a
   * drop (`"P@f7"`). Returns the resulting position. Throws on illegality.
   */
  play(move: Move | string): Position {
    const resolved = typeof move === 'string' ? this.resolveUci(move) : this.matchLegal(move);
    if (resolved === null) {
      throw new IllegalMoveError(`Illegal move: ${typeof move === 'string' ? move : squareName(move.from) + squareName(move.to)}`);
    }
    return new Position(applyMove(this.state, resolved));
  }

  /**
   * Find the generated move a caller-supplied one refers to.
   *
   * `from`, `to`, promotion and drop are not always enough. In Chess960 a king on b1 whose queenside
   * castle lands it on c1 can *also* simply step to c1, and both moves share all four. Matching on
   * them alone returned whichever was generated first — the ordinary step — so asking to castle
   * quietly moved the king one square and left the rook behind.
   *
   * Whatever the caller supplied is applied as a constraint, and the constraints are **cumulative**
   * rather than alternatives:
   *
   * - `castleRook`, when given, must match exactly. Every move from {@link Position.legalMoves}
   *   carries it, so a move handed straight back always resolves to itself.
   * - a castling **flag**, when given, must match too. That is what a hand-built move normally
   *   carries.
   * - when neither is given, the first move matching the four fields wins, which is what this method
   *   has always done.
   *
   * Two earlier versions were wrong in opposite directions, and both are worth recording.
   *
   * Requiring `castleRook` unconditionally silently narrowed the public API:
   * `play({ from: e1, to: g1, piece: 'K', flags: KingCastle })` is an ordinary way to express
   * standard castling and began throwing. Then treating the two as *alternatives* — checking the
   * flag only when no rook was named — accepted contradictory input: a move naming the queenside
   * rook while carrying `KingCastle` resolved to the queenside castle and played it, so a caller
   * that had confused itself got a silently different move rather than an error. Both raised in
   * review of PR #10, the second by Qodo.
   */
  private matchLegal(move: Move): Move | null {
    const castleFlags = MoveFlag.KingCastle | MoveFlag.QueenCastle;
    const wantedCastle = move.flags & castleFlags;
    for (const m of this.legalMoves()) {
      if (m.from !== move.from || m.to !== move.to) continue;
      if ((m.promotion ?? null) !== (move.promotion ?? null)) continue;
      if ((m.drop ?? null) !== (move.drop ?? null)) continue;
      if (move.castleRook !== undefined && m.castleRook !== move.castleRook) continue;
      if (wantedCastle !== 0 && (m.flags & castleFlags) !== wantedCastle) continue;
      return m;
    }
    return null;
  }

  private resolveUci(uci: string): Move | null {
    // Drop: "N@e4"
    const at = uci.indexOf('@');
    if (at !== -1) {
      const type = uci[0].toLowerCase() as Move['drop'];
      const to = squareFromName(uci.slice(at + 1, at + 3));
      for (const m of this.legalMoves()) {
        if (m.drop === type && m.to === to) return m;
      }
      return null;
    }
    const from = squareFromName(uci.slice(0, 2));
    const to = squareFromName(uci.slice(2, 4));
    const promo = uci.length >= 5 ? (uci[4].toLowerCase() as Move['promotion']) : undefined;
    const chess960 = this.state.variant === 'chess960';
    for (const m of this.legalMoves()) {
      // In Chess960 a castle is spelled king-takes-rook and is resolved by the second pass alone.
      // Letting it match here too would accept the king-destination spelling as well, including the
      // degenerate `g1g1` — a king that starts on its own castling destination — which no engine or
      // GUI emits and which reads as a move that goes nowhere. Raised in the CodeRabbit review of
      // PR #10.
      if (chess960 && m.castleRook !== undefined) continue;
      if (m.from === from && m.to === to && (m.promotion ?? undefined) === promo) return m;
    }
    // Chess960 castling arrives king-takes-rook, so a second pass reads `to` as the rook's square
    // instead of the king's.
    //
    // Gated on the variant, exactly as `toUci` is. Standard UCI spells castling `e1g1` and nothing
    // else, so accepting `e1h1` there would let a string no standard engine or GUI produces through
    // the one entry point that exists to refuse illegal moves. Raised in the Qodo review of PR #10.
    //
    // The two passes cannot disagree: this one only ever matches a square occupied by the mover's
    // own rook, and no ordinary move can land there. Worth stating because the opposite is easy to
    // assume — the two spellings look like they should collide.
    if (promo === undefined && chess960) {
      for (const m of this.legalMoves()) {
        if (m.from === from && m.castleRook === to) return m;
      }
    }
    return null;
  }

  /**
   * Convert a legal move to UCI notation.
   *
   * Chess960 castling is written **king-takes-rook** — `e1h1` rather than `e1g1` — which is
   * the convention a UCI engine expects once `UCI_Chess960` is on, and this repository already
   * switches that option on for the variant. The internal move is unaffected: `to` remains the
   * king's final square in every variant, and the engine spelling is applied only here, at the
   * wire boundary.
   *
   * The convention exists because the king's destination is not always a distinct square. A king
   * that starts on g1 finishes on g1 when it castles kingside, so `g1g1` would name a move that
   * appears to go nowhere; a king on f1 castling kingside would emit `f1g1`, indistinguishable
   * from stepping one square right. The rook's square is always unambiguous, because the king
   * starts strictly between the two rooks.
   */
  toUci(move: Move): string {
    if (move.drop) return `${move.drop.toUpperCase()}@${squareName(move.to)}`;
    if (move.castleRook !== undefined && this.state.variant === 'chess960') {
      return squareName(move.from) + squareName(move.castleRook);
    }
    return squareName(move.from) + squareName(move.to) + (move.promotion ?? '');
  }

  /** Convert a legal move to Standard Algebraic Notation (SAN). */
  toSan(move: Move): string {
    if (move.flags & MoveFlag.KingCastle) return this.suffix('O-O', move);
    if (move.flags & MoveFlag.QueenCastle) return this.suffix('O-O-O', move);

    const kind = typeOf(move.piece);
    let san = '';
    if (move.drop) {
      san = `${move.drop.toUpperCase()}@${squareName(move.to)}`;
      return this.suffix(san, move);
    }
    if (kind === 'p') {
      if (move.captured || move.flags & MoveFlag.EnPassant) {
        san += squareName(move.from)[0] + 'x';
      }
      san += squareName(move.to);
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
    } else {
      san += kind.toUpperCase();
      san += this.disambiguate(move);
      if (move.captured) san += 'x';
      san += squareName(move.to);
    }
    return this.suffix(san, move);
  }

  private disambiguate(move: Move): string {
    const same = this.legalMoves().filter(
      (m) => m.to === move.to && typeOf(m.piece) === typeOf(move.piece) && m.from !== move.from,
    );
    if (same.length === 0) return '';
    const sameFile = same.some((m) => fileOf(m.from) === fileOf(move.from));
    const sameRank = same.some((m) => rankOf(m.from) === rankOf(move.from));
    if (!sameFile) return squareName(move.from)[0];
    if (!sameRank) return squareName(move.from)[1];
    return squareName(move.from);
  }

  private suffix(san: string, move: Move): string {
    const next = applyMove(this.state, move);
    if (inCheck(next, next.turn)) {
      const mate = generateLegalMoves(next).length === 0;
      return san + (mate ? '#' : '+');
    }
    return san;
  }

  /** Compute the current game status (terminal or ongoing), variant-aware. */
  status(): GameStatus {
    const variantStatus = this.variantTerminalStatus();
    if (variantStatus) return variantStatus;

    const legal = this.legalMoves();
    if (legal.length === 0) {
      if (this.isCheck()) {
        return { over: true, reason: 'checkmate', winner: opposite(this.state.turn) };
      }
      return { over: true, reason: 'stalemate' };
    }

    if (this.state.halfmoves >= 100 && this.state.variant !== 'threecheck') {
      return { over: true, reason: 'fifty_move' };
    }
    if (this.hasInsufficientMaterial()) {
      return { over: true, reason: 'insufficient_material' };
    }
    return { over: false };
  }

  private variantTerminalStatus(): GameStatus | null {
    const s = this.state;

    // Variant win conditions checked before generic terminal states.
    if (s.variant === 'kingofthehill') {
      const centerWin = this.kingReachedCenter();
      if (centerWin) return { over: true, reason: 'variant_win', winner: centerWin };
    }
    if (s.variant === 'threecheck') {
      if (s.checkCount.w >= 3) return { over: true, reason: 'variant_win', winner: 'w' };
      if (s.checkCount.b >= 3) return { over: true, reason: 'variant_win', winner: 'b' };
    }
    if (s.variant === 'atomic') {
      if (findKing(s, 'w') === -1) return { over: true, reason: 'variant_win', winner: 'b' };
      if (findKing(s, 'b') === -1) return { over: true, reason: 'variant_win', winner: 'w' };
    }
    if (s.variant === 'racingkings') {
      const win = this.racingKingsResult();
      if (win) return win;
    }
    if (s.variant === 'horde') {
      // The Horde (White) loses when its entire army is captured.
      let whitePieces = 0;
      for (let sq = 0; sq < 128; sq++) {
        if ((sq & 0x88) !== 0) continue;
        const p = this.state.board[sq];
        if (p !== null && p === p.toUpperCase()) whitePieces++;
      }
      if (whitePieces === 0) return { over: true, reason: 'variant_win', winner: 'b' };
    }
    return null;
  }

  private kingReachedCenter(): Color | null {
    const center = ['d4', 'e4', 'd5', 'e5'].map(squareFromName);
    for (const c of ['w', 'b'] as const) {
      const k = findKing(this.state, c);
      if (k !== -1 && center.includes(k)) return c;
    }
    return null;
  }

  private racingKingsResult(): GameStatus | null {
    // A king reaching the 8th rank wins; if White reaches it, Black gets one
    // move to also reach it for a draw (handled by turn semantics upstream).
    const wk = findKing(this.state, 'w');
    const bk = findKing(this.state, 'b');
    const wIn = wk !== -1 && rankOf(wk) === 7;
    const bIn = bk !== -1 && rankOf(bk) === 7;
    if (wIn && bIn) return { over: true, reason: 'variant_draw' };

    if (this.state.turn === 'w') {
      if (wIn !== bIn) {
        return { over: true, reason: 'variant_win', winner: wIn ? 'w' : 'b' };
      }
    } else {
      if (bIn && !wIn) return { over: true, reason: 'variant_win', winner: 'b' };
      if (wIn && !bIn) {
        const blackCanReachGoal = this.legalMoves().some(
          (move) => typeOf(move.piece) === 'k' && rankOf(move.to) === 7,
        );
        if (!blackCanReachGoal) {
          return { over: true, reason: 'variant_win', winner: 'w' };
        }
      }
    }
    return null;
  }

  private hasInsufficientMaterial(): boolean {
    if (this.state.variant !== 'standard' && this.state.variant !== 'chess960') return false;
    // Draw only when no legal sequence can mate (a dead position), not when mate merely cannot be
    // forced: K+N+N vs K, K+N vs K+N and opposite-coloured bishops can all still be mated.
    // ponytail: other dead positions (e.g. locked pawn chains) are left to play on.
    const pieces: string[] = [];
    const bishopSquareColors = new Set<number>();
    for (let sq = 0; sq < 128; sq++) {
      if ((sq & 0x88) !== 0) continue;
      const p = this.state.board[sq];
      if (p === null || typeOf(p) === 'k') continue;
      pieces.push(typeOf(p));
      if (typeOf(p) === 'b') bishopSquareColors.add(((sq >> 4) + (sq & 7)) & 1);
    }
    if (pieces.length === 0) return true; // K vs K
    if (pieces.length === 1 && (pieces[0] === 'b' || pieces[0] === 'n')) return true; // K+minor vs K
    // Any number of bishops, for either side, all on squares of one colour.
    return pieces.every((p) => p === 'b') && bishopSquareColors.size === 1;
  }

  /** Perft: count leaf nodes to `depth`. Used for engine verification. */
  perft(depth: number): number {
    if (depth === 0) return 1;
    if (this.variantTerminalStatus() !== null) return 0;
    const moves = this.legalMoves();
    if (depth === 1) return moves.length;
    let nodes = 0;
    for (const move of moves) {
      nodes += new Position(applyMove(this.state, move)).perft(depth - 1);
    }
    return nodes;
  }

  /** Perft divided by root move (debugging aid). */
  perftDivide(depth: number): Record<string, number> {
    if (this.variantTerminalStatus() !== null) return {};
    const out: Record<string, number> = {};
    for (const move of this.legalMoves()) {
      out[this.toUci(move)] = new Position(applyMove(this.state, move)).perft(depth - 1);
    }
    return out;
  }
}

/** Horde starting position (Lichess rules). */
export const HORDE_FEN = 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1';
/** Racing Kings starting position. */
export const RACING_KINGS_FEN = '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1';
