/**
 * BoardInteraction — pure, DOM-free interaction state machine for the board.
 *
 * It owns the *decisions* the UI needs — selection, drag/click resolution,
 * highlight sets, promotion detection, and premove queueing/application — while
 * the rendering layer (`ui/board-view`) owns only pixels and pointer events.
 *
 * Legality is delegated to an injected {@link LegalMoveOracle}; this class
 * contains no chess rules and never mutates the server's truth. A resolved
 * gesture is returned as a {@link GestureResult} the caller submits to the
 * server (authoritative) or queues as a premove.
 */
import {
  type Color,
  type Square,
  isSquare,
  rankIndex,
} from './board.js';
import { parsePlacement, type Piece } from './position.js';
import { PremoveQueue, type Premove } from './premove.js';
import type { LegalMoveOracle } from '../ports/move-oracle.js';

export type PromotionRole = 'q' | 'r' | 'b' | 'n';

export interface Highlights {
  readonly selected: Square | null;
  readonly legal: readonly Square[];
  readonly lastMove: readonly [Square, Square] | null;
  readonly premove: readonly Square[];
}

export type GestureResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly square: Square }
  | { readonly kind: 'deselect' }
  | { readonly kind: 'move'; readonly move: Premove }
  | { readonly kind: 'premove'; readonly premove: Premove }
  | { readonly kind: 'promotion'; readonly from: Square; readonly to: Square; readonly premove: boolean }
  /**
   * On our turn, the selected piece was sent to a destination the oracle does not offer. Nothing is
   * submitted and the selection is cleared. Carries no reason: the oracle only answers "which
   * destinations", so any explanation beyond "not legal" would be invented here.
   */
  | { readonly kind: 'illegal'; readonly from: Square; readonly to: Square };

export interface BoardInteractionOptions {
  readonly oracle: LegalMoveOracle;
  /** The side this client may move. Omit to allow whichever side is to move. */
  readonly playerColor?: Color;
  /** Whether it is currently this client's turn to move. Default true. */
  readonly myTurn?: boolean;
  /** Max chained premoves (see PremoveQueue). Default 1. */
  readonly premoveDepth?: number;
}

interface Pending {
  readonly from: Square;
  readonly to: Square;
  readonly premove: boolean;
}

export class BoardInteraction {
  private readonly oracle: LegalMoveOracle;
  private readonly playerColor: Color | undefined;
  private readonly premoves: PremoveQueue;

  private pieces = new Map<Square, Piece>();
  private sideToMove: Color = 'white';
  private myTurn: boolean;
  private selected: Square | null = null;
  private legal: readonly Square[] = [];
  private lastMove: readonly [Square, Square] | null = null;
  private pending: Pending | null = null;
  private inputEnabled = true;

  constructor(options: BoardInteractionOptions) {
    this.oracle = options.oracle;
    this.playerColor = options.playerColor;
    this.myTurn = options.myTurn ?? true;
    this.premoves = new PremoveQueue(
      options.premoveDepth !== undefined ? { maxDepth: options.premoveDepth } : {},
    );
  }

  // ---- position / turn sync -------------------------------------------------

  setPosition(fen: string): void {
    this.pieces = parsePlacement(fen);
    const field = fen.trim().split(/\s+/)[1];
    this.sideToMove = field === 'b' ? 'black' : 'white';
    this.oracle.setPosition(fen);
    this.clearSelection();
    this.pending = null;
  }

  /** Replace the authoritative last-move highlight, or clear it when no move exists. */
  setLastMove(from: Square | null, to: Square | null): void {
    this.lastMove = from !== null && to !== null ? [from, to] : null;
  }

  setTurn(myTurn: boolean): void {
    this.myTurn = myTurn;
    // The turn can arrive without a new position (readiness, an acknowledged move), so a selection
    // made off-turn survives it. Judge that selection by this turn's destinations, not the empty
    // off-turn list, or a legal move would be reported illegal.
    if (this.selected !== null) this.setSelection(this.selected);
  }

  /**
   * Accept or ignore gestures. A finished game takes none: off-turn is not "anything goes", so
   * without this a finished board would still select pieces and queue premoves.
   */
  setInputEnabled(enabled: boolean): void {
    if (enabled === this.inputEnabled) return;
    this.inputEnabled = enabled;
    if (enabled) return;
    this.clearSelection();
    this.pending = null;
    this.premoves.clear();
  }

  get acceptsInput(): boolean {
    return this.inputEnabled;
  }

  get hasPremove(): boolean {
    return this.premoves.active;
  }

  get awaitingPromotion(): boolean {
    return this.pending !== null;
  }

  // ---- queries --------------------------------------------------------------

  /** The colour this client is allowed to move right now. */
  private movableColor(): Color {
    return this.playerColor ?? this.sideToMove;
  }

  private isOwnPiece(sq: Square): boolean {
    const p = this.pieces.get(sq);
    return p !== undefined && (p.color === (this.movableColor() === 'white' ? 'w' : 'b'));
  }

  private isPromotion(from: Square, to: Square): boolean {
    const p = this.pieces.get(from);
    if (!p || p.role !== 'p') return false;
    return (p.color === 'w' && rankIndex(to) === 7) || (p.color === 'b' && rankIndex(to) === 0);
  }

  highlights(): Highlights {
    const pm = this.premoves.list();
    const premoveSquares: Square[] = [];
    for (const m of pm) {
      premoveSquares.push(m.from, m.to);
    }
    return {
      selected: this.selected,
      legal: this.legal,
      lastMove: this.lastMove,
      premove: premoveSquares,
    };
  }

  // ---- gestures -------------------------------------------------------------

  /** Begin a drag on `sq`; selects it if it is a movable piece. */
  dragStart(sq: Square): GestureResult {
    if (this.pending || !this.inputEnabled) return { kind: 'none' };
    if (!this.isOwnPiece(sq)) return { kind: 'none' };
    return this.select(sq);
  }

  /** Complete a drag from `from` onto `to`. */
  drop(from: Square, to: Square): GestureResult {
    if (this.pending || !this.inputEnabled) return { kind: 'none' };
    if (!isSquare(from) || !isSquare(to) || from === to) {
      this.clearSelection();
      return { kind: 'deselect' };
    }
    this.setSelection(from);
    return this.attempt(to);
  }

  /** Handle a click/tap on a square (click-to-move). */
  tap(sq: Square): GestureResult {
    if (this.pending || !this.inputEnabled) return { kind: 'none' };
    if (this.selected === null) {
      return this.isOwnPiece(sq) ? this.select(sq) : { kind: 'none' };
    }
    if (sq === this.selected) {
      this.clearSelection();
      return { kind: 'deselect' };
    }
    return this.attempt(sq);
  }

  private select(sq: Square): GestureResult {
    this.setSelection(sq);
    return { kind: 'select', square: sq };
  }

  private setSelection(sq: Square): void {
    this.selected = sq;
    this.legal = this.myTurn ? this.oracle.destinations(sq) : [];
  }

  /** Resolve the selected square moving to `to`. */
  private attempt(to: Square): GestureResult {
    const from = this.selected;
    if (from === null) return { kind: 'none' };

    // Reselect when tapping another own piece that is not a legal target.
    const legalTarget = this.myTurn && this.legal.includes(to);
    if (!legalTarget && this.isOwnPiece(to)) {
      return this.select(to);
    }

    if (this.myTurn) {
      if (!legalTarget) {
        this.clearSelection();
        return { kind: 'illegal', from, to };
      }
      if (this.isPromotion(from, to)) {
        this.pending = { from, to, premove: false };
        return { kind: 'promotion', from, to, premove: false };
      }
      this.clearSelection();
      return { kind: 'move', move: { from, to } };
    }

    // Not our turn -> premove. Cannot capture our own piece.
    if (this.isOwnPiece(to)) {
      this.clearSelection();
      return { kind: 'deselect' };
    }
    if (this.isPromotion(from, to)) {
      this.pending = { from, to, premove: true };
      return { kind: 'promotion', from, to, premove: true };
    }
    const premove: Premove = { from, to };
    this.premoves.enqueue(premove);
    this.clearSelection();
    return { kind: 'premove', premove };
  }

  /** Supply the chosen promotion piece for a pending promotion gesture. */
  resolvePromotion(role: PromotionRole): GestureResult {
    const p = this.pending;
    if (!p) return { kind: 'none' };
    this.pending = null;
    this.clearSelection();
    const move: Premove = { from: p.from, to: p.to, promotion: role };
    if (p.premove) {
      this.premoves.enqueue(move);
      return { kind: 'premove', premove: move };
    }
    return { kind: 'move', move };
  }

  /** Abort a pending promotion (e.g. user dismissed the dialog). */
  cancelPromotion(): void {
    this.pending = null;
    this.clearSelection();
  }

  /**
   * Attempt to play the queued premove now that it is our turn. Validates the
   * head against the oracle; returns a move to submit, or null (and clears the
   * queue) if it is no longer legal.
   */
  applyPremove(): GestureResult {
    if (!this.myTurn) return { kind: 'none' };
    const head = this.premoves.peek();
    if (!head) return { kind: 'none' };
    const legal = this.oracle.destinations(head.from);
    if (!legal.includes(head.to)) {
      this.premoves.clear();
      return { kind: 'none' };
    }
    this.premoves.dequeue();
    return { kind: 'move', move: head };
  }

  clearPremoves(): void {
    this.premoves.clear();
  }

  private clearSelection(): void {
    this.selected = null;
    this.legal = [];
  }
}
