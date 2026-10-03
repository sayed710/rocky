/**
 * Board UI wiring for the composition root.
 *
 * Assembles the interactive board (Increment 2) from the pure
 * `BoardInteraction` state machine, a `LegalMoveOracle`, the view-only optimistic
 * mover, and the DOM `BoardView`. This module composes the UI + presentation-core
 * only; it never imports the networking or API layers, preserving the separation
 * between UI and infrastructure.
 *
 * When an `onMove` callback is provided (increment 3E), resolved moves are
 * forwarded to the caller (typically a `GameController`) for server submission
 * instead of being applied optimistically here. The caller then drives position
 * updates back through `setPosition` via the controller's callbacks.
 */
import { BoardView } from '../ui/board-view.js';
import type { MoveFeedback, ResolvedMove } from '../ui/board-view.js';
import { BoardInteraction } from '../core/interaction.js';
import { NullMoveOracle } from '../ports/move-oracle.js';
import type { LegalMoveOracle } from '../ports/move-oracle.js';
import { applyMove } from '../core/mover.js';
import { STARTING_FEN } from '../core/position.js';
import type { Premove } from '../core/premove.js';
import { createI18nManager, type I18nManager } from '../i18n/manager.js';
import { createLtrElement } from '../i18n/bidi.js';

/**
 * DOM elements the board binds to.
 */
export interface BoardElements {
  readonly boardEl: HTMLElement;
  readonly statusEl?: HTMLElement | null;
  readonly flipEl?: HTMLElement | null;
  /**
   * Polite live region for locally rejected moves. Separate from `statusEl` because on the game
   * route the controller rewrites the status on every sync, which would erase the message before it
   * is heard. Pass it only where a real legality oracle is wired: with the null oracle every move
   * would be "rejected".
   */
  readonly feedbackEl?: HTMLElement | null;
}

/**
 * Optional configuration for {@link mountBoard}. The `oracle` is injected here
 * so the board module never imports the networking layer; the composition root
 * (or a game controller) creates an `AuthoritativeMoveOracle` from a `GameSync`
 * and passes it in. When omitted, a {@link NullMoveOracle} is used — the board
 * renders but offers no legal-move highlights.
 *
 * When `onMove` is provided, resolved user moves are forwarded to the caller
 * for server submission (the caller drives position updates back via
 * `setPosition`). When omitted, the board applies moves optimistically (the
 * standalone/offline mode from Increment 2).
 */
export interface MountBoardOptions {
  /** Legal-move oracle; defaults to {@link NullMoveOracle}. */
  readonly oracle?: LegalMoveOracle;
  /**
   * Callback invoked when the user resolves a move (drag/click/promotion).
   * The caller (e.g. `GameController`) submits it to the server and drives
   * position updates back via `setPosition`. When omitted, the board applies
   * moves optimistically itself.
   */
  readonly onMove?: (uci: string) => void;
  /** Localization manager for board status copy; optional for test resilience. */
  readonly i18n?: I18nManager;
}

/** Handle to the mounted board. */
export interface MountedBoard {
  readonly view: BoardView;
  /** Update the displayed position (FEN). Delegates to `BoardView.setPosition`. */
  setPosition: (fen: string) => void;
  /** Replace or clear the last-move highlight. Delegates to `BoardView.setLastMove`. */
  setLastMove: (from: string | null, to: string | null) => void;
  /** Update whose turn it is (affects legal highlights + premoves). */
  setTurn: (myTurn: boolean) => void;
  /** Accept or ignore move input (off once the game is over). */
  setInputEnabled: (enabled: boolean) => void;
  /** Set the board orientation ('white' or 'black' perspective). */
  setOrientation: (orientation: 'white' | 'black') => void;
  /**
   * Detach the view's listeners from the board element. Required wherever the element outlives the
   * mount — `bootstrap` re-runs on every SPA navigation, so a section that mounts into markup from
   * `index.html` stacks a fresh set of handlers on each visit unless it destroys the previous one.
   */
  destroy: () => void;
  /** Alias for {@link destroy} to normalise teardown verb across all disposables. */
  dispose: () => void;
}

/** Convert a {@link Premove} to UCI notation. */
function premoveToUci(m: Premove): string {
  return m.promotion ? `${m.from}${m.to}${m.promotion}` : `${m.from}${m.to}`;
}

/**
 * Mount the interactive board into the DOM and return a handle to it.
 *
 * The `oracle` (if provided) supplies legal-move data from the authoritative
 * server snapshot via `GameSync` state; when omitted, a `NullMoveOracle` is
 * used and the board renders without legal-move highlights.
 *
 * When `onMove` is provided, user-resolved moves are forwarded to the caller
 * for server submission. The caller is responsible for driving position
 * updates back via `setPosition` (typically through a `GameController`'s
 * `onPosition` callback). When `onMove` is omitted, the board applies moves
 * optimistically itself (standalone/offline mode).
 */
/**
 * The view currently mounted on each element, so a remount can detach the previous one.
 *
 * `BoardView` binds its click, pointer, and keyboard handlers to the *element*, and the board elements
 * (`#board`, `#chapter-board`) live in `index.html` — they outlive any route, while `bootstrap`
 * re-runs on every SPA navigation. Making the mount itself idempotent is what keeps that safe:
 * relying on each caller to destroy its previous board means one route that forgets reintroduces
 * doubled gestures, and forgetting is exactly what happens (see the tracked follow-up in
 * `docs/ROADMAP.md` about hand-maintained teardown lists).
 *
 * Weak so an element that is discarded takes its entry with it.
 */
const mountedTeardowns = new WeakMap<HTMLElement, () => void>();

export function mountBoard(
  elements: BoardElements,
  options?: MountBoardOptions,
): MountedBoard {
  const { boardEl, statusEl, flipEl, feedbackEl } = elements;

  // The whole teardown, not just the view's: the flip button's handler is bound out here and would
  // otherwise survive a remount, stacking one flip per navigation.
  mountedTeardowns.get(boardEl)?.();

  let fen = STARTING_FEN;
  const oracle = options?.oracle ?? new NullMoveOracle();
  const onMove = options?.onMove;
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  const i18n = options?.i18n ?? createI18nManager();
  type StatusKey = 'board.status.played' | 'board.status.premoveSet';
  interface StatusState {
    key: StatusKey;
    move: string;
  }
  let currentStatus: StatusState | null = null;

  const renderStatus = (): void => {
    if (!statusEl || !currentStatus) return;
    const doc = statusEl.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
    const template = i18n.t(currentStatus.key);
    if (!doc || !template.includes('{move}')) {
      statusEl.textContent = i18n.t(currentStatus.key, { move: currentStatus.move });
      return;
    }

    const [prefix = '', suffix = ''] = template.split('{move}');
    statusEl.textContent = '';
    if (prefix) {
      statusEl.appendChild(doc.createTextNode(prefix));
    }
    const moveEl = createLtrElement(doc, 'span', currentStatus.move);
    statusEl.appendChild(moveEl);
    if (suffix) {
      statusEl.appendChild(doc.createTextNode(suffix));
    }
  };

  const setStatus = (key: StatusKey, move: string): void => {
    currentStatus = { key, move };
    renderStatus();
  };

  // The live rejection message, if one is showing. Every rejection gets a new node: re-setting the
  // same text is not a change a screen reader announces, but an added node is, so a repeated
  // identical attempt is still heard.
  let rejection: HTMLElement | null = null;
  const showFeedback = (feedback: MoveFeedback): void => {
    if (!feedbackEl) return;
    if (feedback.kind === 'illegal') {
      rejection = feedbackEl.ownerDocument.createElement('span');
      rejection.textContent = i18n.t('board.feedback.illegalMove');
      feedbackEl.replaceChildren(rejection);
      return;
    }
    if (rejection === null) return;
    rejection = null;
    feedbackEl.replaceChildren();
  };
  const clearFeedback = (): void => showFeedback({ kind: 'clear' });

  const unsubscribeLocale = options?.i18n?.onLocaleChange(() => {
    renderStatus();
    if (rejection) rejection.textContent = i18n.t('board.feedback.illegalMove');
  });

  const view = new BoardView(boardEl, {
    interaction,
    orientation: 'white',
    onFeedback: showFeedback,
    onResult: (r: ResolvedMove) => {
      if (r.kind === 'move') {
        if (onMove) {
          // Server-authoritative mode: forward to the caller.
          onMove(premoveToUci(r.move));
        } else {
          // Standalone/offline mode: apply optimistically.
          fen = applyMove(fen, r.move);
          view.setPosition(fen);
          view.setLastMove(r.move.from, r.move.to);
          setStatus(
            'board.status.played',
            `${r.move.from}\u2013${r.move.to}${r.move.promotion ? `=${r.move.promotion.toUpperCase()}` : ''}`,
          );
        }
      } else {
        setStatus(
          'board.status.premoveSet',
          `${r.premove.from}\u2013${r.premove.to}${r.premove.promotion ? `=${r.premove.promotion.toUpperCase()}` : ''}`,
        );
      }
    },
  });
  view.setPosition(fen);

  // `#flip` is persistent markup too, so this listener needs the same treatment as the board's own:
  // named, and removed on destroy. Left anonymous it stacked one flip-per-navigation, which reads as
  // the board refusing to flip — an even number of handlers returns it to where it started.
  const onFlip = (): void => view.flip();
  flipEl?.addEventListener('click', onFlip);

  const teardown = (): void => {
    unsubscribeLocale?.();
    clearFeedback();
    flipEl?.removeEventListener('click', onFlip);
    view.destroy();
    if (mountedTeardowns.get(boardEl) === teardown) mountedTeardowns.delete(boardEl);
  };
  mountedTeardowns.set(boardEl, teardown);

  return {
    view,
    // A rejection describes the position and turn it was made in; once either moves on it is stale.
    setPosition: (f: string) => {
      clearFeedback();
      view.setPosition(f);
    },
    setLastMove: (from: string | null, to: string | null) => view.setLastMove(from, to),
    setTurn: (myTurn: boolean) => {
      clearFeedback();
      view.setTurn(myTurn);
    },
    // Called on every action-state update (a draw offer, a connection blip): only a real change may
    // clear a rejection the player has not heard yet, or rebuild the grid under anyone measuring or
    // focusing its cells.
    setInputEnabled: (enabled: boolean) => {
      if (enabled === interaction.acceptsInput) return;
      clearFeedback();
      view.setInputEnabled(enabled);
    },
    setOrientation: (orientation: 'white' | 'black') => {
      if (view.orientationColor !== orientation) view.flip();
    },
    destroy: teardown,
    dispose: teardown,
  };
}
