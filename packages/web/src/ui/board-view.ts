/**
 * BoardView — DOM rendering plus pointer and keyboard input for the chess board.
 *
 * All decisions (selection, legality-driven highlights, promotion, premoves)
 * live in the injected {@link BoardInteraction}; this class only turns state into
 * pixels and turns pointer/click gestures into interaction calls. It emits
 * resolved moves/premoves via `onResult` so the app can submit them to the
 * server (authoritative) and optimistically update the position.
 */
import {
  type Color,
  type Square,
  ranksForOrientation,
  filesForOrientation,
  toSquare,
  squareShade,
  rankIndex,
  pixelToSquare,
  isSquare,
} from '../core/board.js';
import { parsePlacement, type Piece } from '../core/position.js';
import type { BoardInteraction, GestureResult, PromotionRole } from '../core/interaction.js';
import type { Premove } from '../core/premove.js';

const PROMO_ROLES: readonly PromotionRole[] = ['q', 'r', 'b', 'n'];

const PIECE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const COLOR_NAMES: Record<string, string> = {
  w: 'white',
  b: 'black',
};

/**
 * Build the accessible label for a grid cell: square name plus piece description,
 * or `"<sq>, empty"` when there is no piece. Screen readers announce this as the
 * cell's name, so it must unambiguously identify both location and occupant.
 */
function squareAccessibleLabel(sq: Square, piece?: Piece): string {
  if (!piece) return `${sq}, empty`;
  const color = COLOR_NAMES[piece.color] ?? piece.color;
  const role = PIECE_NAMES[piece.role] ?? piece.role;
  return `${sq}, ${color} ${role}`;
}

/**
 * CSS class carrying a piece's image, e.g. `cb-p-wk`. The artwork itself (the
 * Cburnett SVG set) is bound to these classes in `style.css`; the renderer only
 * names the piece, keeping image paths out of the DOM layer.
 */
function pieceClass(color: string, role: string): string {
  return `cb-p-${color}${role}`;
}
const DRAG_THRESHOLD = 6;

/** A resolved user gesture: either a committed move or a queued premove. */
export type ResolvedMove =
  | { readonly kind: 'move'; readonly move: Premove }
  | { readonly kind: 'premove'; readonly premove: Premove };

/** Construction-time options for {@link BoardView}. */
export interface BoardViewOptions {
  readonly interaction: BoardInteraction;
  readonly orientation?: Color;
  readonly onResult?: (result: ResolvedMove) => void;
}

/**
 * DOM-rendering layer for the interactive chess board.
 *
 * Turns {@link BoardInteraction} state into a grid of ARIA-annotated cells and converts
 * pointer/keyboard gestures back into interaction calls. All decisions (legality,
 * promotion, premoves) live in the injected `BoardInteraction`; this class is
 * presentation-only. Emits resolved moves/premoves via `onResult`.
 */
export class BoardView {
  private readonly root: HTMLElement;
  private readonly interaction: BoardInteraction;
  private readonly onResult: (result: ResolvedMove) => void;
  private orientation: Color;
  private pieces = new Map<Square, Piece>();

  private dragFrom: Square | null = null;
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private pointerId: number | null = null;
  private floatEl: HTMLElement | null = null;
  private suppressClick = false;
  private overlay: HTMLElement | null = null;
  private focusedSquare: Square | null = null;
  // Held as fields so `destroy` can remove the very same references `addEventListener` received.
  private readonly onClick = (e: MouseEvent): void => this.handleClick(e);
  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointerDown(e);
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);
  /** Keep promotion dismissal available while focus is anywhere in the owning document. */
  private readonly onPromotionKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.overlay) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelPromotion();
  };

  /** Mount the board into `root`, attaching all pointer and keyboard listeners. */
  constructor(root: HTMLElement, options: BoardViewOptions) {
    this.root = root;
    this.interaction = options.interaction;
    this.orientation = options.orientation ?? 'white';
    this.onResult = options.onResult ?? (() => undefined);
    this.root.classList.add('cb-board');
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', 'Chess board');
    this.root.setAttribute('aria-rowcount', '8');
    this.root.setAttribute('aria-colcount', '8');
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('keydown', this.onKeyDown);
    this.render();
  }

  /**
   * Detach from the root element.
   *
   * Mounting is not idempotent: the listeners above are bound to the element, not to this
   * instance, so mounting a second view onto the same element leaves the first one's listeners
   * attached and every gesture is handled twice. Sections whose board element outlives the view —
   * anything rendered into markup that `bootstrap` re-runs over — must call this before remounting.
   */
  destroy(): void {
    this.closeOverlay();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('keydown', this.onKeyDown);
  }

  /** Set the position: updates both the rendered pieces and the interaction. */
  setPosition(fen: string): void {
    const nextPieces = parsePlacement(fen);
    const restorePromotionFocus = this.overlay !== null;
    this.closeOverlay();
    this.pieces = nextPieces;
    this.interaction.setPosition(fen);
    this.render();
    if (restorePromotionFocus) this.focusCurrentSquare();
  }

  /** Replace the last-move highlight, or clear it when the game has no last move. */
  setLastMove(from: Square | null, to: Square | null): void {
    this.interaction.setLastMove(from, to);
    this.render();
  }

  /** Inform the interaction layer whose turn it is, enabling or disabling move input. */
  setTurn(myTurn: boolean): void {
    this.interaction.setTurn(myTurn);
  }

  /** Toggle the board between white-at-bottom and black-at-bottom orientations. */
  flip(): void {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.render();
  }

  /** The color whose pieces appear at the bottom of the board. */
  get orientationColor(): Color {
    return this.orientation;
  }

  // ---- input ---------------------------------------------------------------

  private squareAt(clientX: number, clientY: number): Square | null {
    const rect = this.root.getBoundingClientRect();
    return pixelToSquare(
      { x: clientX - rect.left, y: clientY - rect.top },
      rect.width,
      this.orientation,
    );
  }

  private handleClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.overlay) return;
    const sq = this.squareAt(event.clientX, event.clientY);
    if (!sq) return;
    this.focusedSquare = sq;
    this.dispatch(this.interaction.tap(sq));
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.overlay || !(event.target instanceof Element)) return;
    const cell = event.target.closest<HTMLElement>('.cb-sq[data-square]');
    if (!cell || !this.root.contains(cell)) return;
    const square = cell.dataset['square'];
    if (square === undefined || !isSquare(square)) return;

    const activatesSquare = event.key === 'Enter'
      || event.key === ' '
      || event.key === 'Spacebar'
      || event.code === 'Space';
    if (activatesSquare) {
      event.preventDefault();
      this.focusedSquare = square;
      this.dispatch(this.interaction.tap(square));
      return;
    }

    const cells = Array.from(this.root.querySelectorAll<HTMLElement>('.cb-sq[data-square]'));
    const currentIndex = cells.indexOf(cell);
    if (currentIndex === -1) return;
    const row = Math.floor(currentIndex / 8);
    const column = currentIndex % 8;
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case 'ArrowUp': nextRow -= 1; break;
      case 'ArrowDown': nextRow += 1; break;
      case 'ArrowLeft': nextColumn -= 1; break;
      case 'ArrowRight': nextColumn += 1; break;
      case 'Home':
        if (event.ctrlKey) {
          nextRow = 0;
          nextColumn = 0;
        } else {
          nextColumn = 0;
        }
        break;
      case 'End':
        if (event.ctrlKey) {
          nextRow = 7;
          nextColumn = 7;
        } else {
          nextColumn = 7;
        }
        break;
      case 'PageUp':
        nextRow = 0;
        break;
      case 'PageDown':
        nextRow = 7;
        break;
      default: return;
    }

    event.preventDefault();
    if (nextRow < 0 || nextRow > 7 || nextColumn < 0 || nextColumn > 7) return;
    const nextCell = cells[(nextRow * 8) + nextColumn];
    const nextSquare = nextCell?.dataset['square'];
    if (!nextCell || nextSquare === undefined || !isSquare(nextSquare)) return;
    this.focusedSquare = nextSquare;
    for (const candidate of cells) candidate.tabIndex = candidate === nextCell ? 0 : -1;
    nextCell.focus();
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.overlay) return;
    const sq = this.squareAt(event.clientX, event.clientY);
    if (!sq) return;
    this.dragFrom = sq;
    this.dragging = false;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.pointerId = event.pointerId;
    const move = (e: PointerEvent): void => this.handlePointerMove(e);
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.handlePointerUp(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.dragFrom === null || event.pointerId !== this.pointerId) return;
    if (!this.dragging) {
      const dist = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
      if (dist < DRAG_THRESHOLD) return;
      const res = this.interaction.dragStart(this.dragFrom);
      if (res.kind === 'none') {
        this.dragFrom = null;
        return;
      }
      this.dragging = true;
      this.beginFloat(this.dragFrom);
      this.render();
    }
    this.moveFloat(event.clientX, event.clientY);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging || this.dragFrom === null) {
      this.dragFrom = null;
      return;
    }
    const target = this.squareAt(event.clientX, event.clientY);
    const from = this.dragFrom;
    this.endFloat();
    this.dragging = false;
    this.dragFrom = null;
    this.suppressClick = true;
    if (target) {
      this.dispatch(this.interaction.drop(from, target));
    } else {
      this.interaction.cancelPromotion();
      this.render();
    }
  }

  // ---- gesture results -----------------------------------------------------

  private dispatch(result: GestureResult): void {
    switch (result.kind) {
      case 'move':
        this.onResult({ kind: 'move', move: result.move });
        this.render();
        break;
      case 'premove':
        this.onResult({ kind: 'premove', premove: result.premove });
        this.render();
        break;
      case 'promotion':
        this.showPromotion(result.to);
        break;
      default:
        this.render();
    }
  }

  // ---- floating drag piece -------------------------------------------------

  private beginFloat(sq: Square): void {
    const p = this.pieces.get(sq);
    if (!p) return;
    const el = document.createElement('div');
    el.className = `cb-float ${pieceClass(p.color, p.role)}`;
    const cell = this.root.getBoundingClientRect().width / 8;
    el.style.width = `${cell}px`;
    el.style.height = `${cell}px`;
    document.body.appendChild(el);
    this.floatEl = el;
  }

  private moveFloat(x: number, y: number): void {
    if (!this.floatEl) return;
    const half = this.floatEl.offsetWidth / 2;
    this.floatEl.style.left = `${x - half}px`;
    this.floatEl.style.top = `${y - half}px`;
  }

  private endFloat(): void {
    this.floatEl?.remove();
    this.floatEl = null;
  }

  // ---- promotion overlay ---------------------------------------------------

  private showPromotion(to: Square): void {
    this.closeOverlay();
    this.focusedSquare = to;
    const color: Piece['color'] = rankIndex(to) === 7 ? 'w' : 'b';
    const overlay = document.createElement('div');
    overlay.className = 'cb-promotion';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Choose promotion piece');
    for (const role of PROMO_ROLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cb-promo-choice ${pieceClass(color, role)}`;
      const roleName = PIECE_NAMES[role] ?? role;
      btn.setAttribute('aria-label', `Promote to ${roleName}`);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeOverlay();
        this.dispatch(this.interaction.resolvePromotion(role));
      });
      overlay.appendChild(btn);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cb-promo-cancel';
    cancel.textContent = '\u2715';
    cancel.setAttribute('aria-label', 'Cancel promotion');
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cancelPromotion();
    });
    overlay.appendChild(cancel);
    this.root.appendChild(overlay);
    this.overlay = overlay;
    this.root.ownerDocument.addEventListener('keydown', this.onPromotionKeyDown, true);
    const first = overlay.querySelector('button');
    if (first instanceof HTMLElement) first.focus();
  }

  /** Cancel the pending promotion and return keyboard focus to its destination square. */
  private cancelPromotion(): void {
    this.interaction.cancelPromotion();
    this.closeOverlay();
    this.render();
    this.focusCurrentSquare();
  }

  /** Return focus to the board's current roving-focus square. */
  private focusCurrentSquare(): void {
    if (this.focusedSquare) {
      this.root.querySelector<HTMLElement>(`[data-square="${this.focusedSquare}"]`)?.focus();
    }
  }

  private closeOverlay(): void {
    if (!this.overlay) return;
    this.root.ownerDocument.removeEventListener('keydown', this.onPromotionKeyDown, true);
    this.overlay.remove();
    this.overlay = null;
  }

  // ---- rendering -----------------------------------------------------------

  private render(): void {
    const hl = this.interaction.highlights();
    const legal = new Set(hl.legal);
    const premove = new Set(hl.premove);
    const last = new Set<Square>(hl.lastMove ?? []);
    const lastMoveTo = hl.lastMove ? hl.lastMove[1] : null;
    const ranks = ranksForOrientation(this.orientation);
    const files = filesForOrientation(this.orientation);
    this.focusedSquare ??= toSquare(files[0]!, ranks[0]!);
    const activeElement = this.root.ownerDocument?.activeElement;
    const restoreSquareFocus = activeElement !== undefined
      && activeElement !== null
      && typeof HTMLElement !== 'undefined'
      && activeElement instanceof HTMLElement
      && this.root.contains(activeElement)
      && activeElement.matches('.cb-sq[data-square]');

    const rowElements: string[] = [];
    for (let r = 0; r < ranks.length; r++) {
      const rank = ranks[r]!;
      const rowIndex = r + 1;
      const cellElements: string[] = [];
      for (let c = 0; c < files.length; c++) {
        const file = files[c]!;
        const colIndex = c + 1;
        const sq = toSquare(file, rank);
        const piece = this.pieces.get(sq);
        const classes = ['cb-sq', `cb-${squareShade(sq)}`];
        if (sq === hl.selected) classes.push('cb-selected');
        if (last.has(sq)) classes.push('cb-last');
        if (premove.has(sq)) classes.push('cb-premove');
        if (legal.has(sq)) classes.push(piece ? 'cb-capture' : 'cb-legal');
        const label = squareAccessibleLabel(sq, piece);
        const dragged = this.dragging && sq === this.dragFrom ? ' cb-dragging' : '';
        const inner = piece
          ? `<span class="cb-piece ${pieceClass(piece.color, piece.role)}${dragged}" aria-hidden="true"></span>`
          : '';
        // Algebraic coordinates belong to the board, so they move with its orientation. Rank labels
        // live on the visible left edge and file labels on the visible bottom edge: exactly once per
        // rank/file, never a second gutter that can desynchronise when the board flips.
        const rankCoordinate = file === files[0]
          ? `<span class="cb-coordinate cb-rank" aria-hidden="true">${rank + 1}</span>`
          : '';
        const fileCoordinate = rank === ranks[7]
          ? `<span class="cb-coordinate cb-file" aria-hidden="true">${String.fromCharCode(97 + file)}</span>`
          : '';

        const states: string[] = [];
        if (legal.has(sq)) {
          states.push(piece ? 'capture' : 'legal move');
        }
        if (last.has(sq)) {
          states.push('last move');
        }
        if (premove.has(sq)) {
          states.push('premove');
        }
        
        const descAttr = states.length > 0 ? ` aria-description="${states.join(', ')}"` : '';

        const currentAttr = sq === lastMoveTo ? ' aria-current="true"' : '';

        cellElements.push(
          `<div class="${classes.join(' ')}" role="gridcell" data-square="${sq}" aria-label="${label}" aria-selected="${sq === hl.selected}" aria-rowindex="${rowIndex}" aria-colindex="${colIndex}" tabindex="${sq === this.focusedSquare ? '0' : '-1'}"${descAttr}${currentAttr}>${rankCoordinate}${fileCoordinate}${inner}</div>`,
        );
      }
      rowElements.push(
        `<div class="cb-row" role="row" aria-rowindex="${rowIndex}">${cellElements.join('')}</div>`,
      );
    }
    // Preserve the overlay across re-renders.
    this.root.innerHTML = rowElements.join('');
    if (this.overlay) this.root.appendChild(this.overlay);
    if (restoreSquareFocus) {
      this.root.querySelector<HTMLElement>(`[data-square="${this.focusedSquare}"]`)?.focus();
    }
  }
}
