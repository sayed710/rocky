/**
 * The `/endgames` route (M15 inc 20, ADR-0128).
 *
 * Its own route rather than a section of the game sidebar: every sidebar section describes the
 * position already on the board, and that board is driven by the live game's authoritative
 * snapshots. A training position there would be overwritten by the next move of the real game, and
 * the board's `onMove` submits to that game — so training gets its own surface, the way lessons do.
 */
import type { GambitClient } from '../api/client.js';
import type { EndgameAttemptResult, EndgamePosition } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { EndgameController } from './endgame-controller.js';
import {
  ENDGAME_MESSAGES,
  clearEndgame,
  getEndgameMessage,
  renderEndgameError,
  renderEndgameNote,
  renderEndgamePosition,
  renderEndgamePositionRows,
  renderEndgameVerdict,
  setEndgameBusy,
} from './endgame-view.js';

export interface EndgameMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly isAuthenticated: () => boolean;
  readonly i18n: I18nManager;
}

export interface MountedEndgames {
  dispose: () => void;
  /**
   * Authentication changed while this route stayed mounted.
   *
   * Session restore is asynchronous, so a visitor who lands here signed in arrives before their
   * session does; without this they stay in the signed-out UI until they navigate away, and a
   * logout leaves the controls enabled. Raised in the Qodo review of PR #151 — the same defect the
   * game route records being raised on PR #135.
   */
  onSessionChange: () => void;
}

/**
 * Mount the trainer onto the route's persistent DOM.
 *
 * @param deps - the document, the API client, and a live authentication check.
 * @returns a disposable; `BootstrappedDisposables` makes forgetting to call it a compile error.
 */
export function mountEndgames(deps: EndgameMountDependencies): MountedEndgames {
  const { doc } = deps;
  const nextBtn = doc.getElementById('endgame-next') as HTMLButtonElement | null;
  const submitBtn = doc.getElementById('endgame-submit') as HTMLButtonElement | null;
  const moveInput = doc.getElementById('endgame-move') as HTMLInputElement | null;
  const formEl = doc.getElementById('endgame-form');
  const noteEl = doc.getElementById('endgame-note');
  const errorEl = doc.getElementById('endgame-error');
  const resultEl = doc.getElementById('endgame-result');
  const rowsEl = doc.getElementById('endgame-rows');
  const positionRowsEl = doc.getElementById('endgame-position-rows');
  const boardEl = doc.getElementById('endgame-board');
  const layoutEl = doc.querySelector('.endgame-layout') as HTMLElement | null;

  const unbinds: Array<() => void> = [];
  let hasPosition = false;
  let lastPosition: EndgamePosition | null = null;
  let lastAttemptResult: EndgameAttemptResult | null = null;
  let lastVerdictNote: string | null = null;
  let lastNoteKey: keyof typeof ENDGAME_MESSAGES | null = null;
  let lastErrorKey: keyof typeof ENDGAME_MESSAGES | null = null;

  /** The board currently on screen. Held so it can be torn down; `mountBoard` binds listeners. */
  let board: { dispose: () => void } | null = null;

  /** Tear the current board down. Safe to call when there is none. */
  const disposeBoard = (): void => {
    board?.dispose();
    board = null;
  };

  /**
   * Clear everything the route owns.
   *
   * This DOM lives in `index.html` and outlives the mount, so a previous visit's position and
   * verdict are still on screen when the route is entered again.
   */
  const reset = (): void => {
    if (rowsEl && resultEl) clearEndgame(rowsEl, resultEl);
    if (positionRowsEl) positionRowsEl.innerHTML = '';
    disposeBoard();
    if (boardEl) boardEl.innerHTML = '';
    if (errorEl) renderEndgameError(errorEl, null);
    // The note too: `refresh()` deliberately preserves anything outside its owned set, so a
    // "too many attempts" or "unavailable" message would otherwise survive a remount and greet the
    // next visitor with the last one's failure.
    if (noteEl) renderEndgameNote(noteEl, null);
    if (moveInput) moveInput.value = '';
    hasPosition = false;
    lastPosition = null;
    lastAttemptResult = null;
    lastVerdictNote = null;
    lastNoteKey = null;
    lastErrorKey = null;
  };

  /** Bring the two controls into agreement with the session and whether a position is loaded. */
  const refresh = (): void => {
    const authed = deps.isAuthenticated();
    if (layoutEl) layoutEl.hidden = !authed || !hasPosition;
    if (nextBtn) nextBtn.disabled = !authed || controller.isPending;
    if (submitBtn) submitBtn.disabled = !authed || !hasPosition || controller.isPending;
    if (moveInput) moveInput.disabled = !authed || !hasPosition;
    if (!noteEl) return;
    const currentText = noteEl.textContent ?? '';
    const isOwned =
      currentText === '' ||
      currentText === getEndgameMessage('idle', deps.i18n) ||
      currentText === getEndgameMessage('signedOut', deps.i18n) ||
      currentText === getEndgameMessage('yourMove', deps.i18n);
    if (!isOwned) return;
    const noteKey = !authed ? 'signedOut' : hasPosition ? 'yourMove' : 'idle';
    lastNoteKey = noteKey;
    renderEndgameNote(noteEl, getEndgameMessage(noteKey, deps.i18n));
  };

  const controller = new EndgameController({
    client: deps.client,
    callbacks: {
      onPhase: (phase) => {
        // Both phases are work in flight; only announcing `loading` left the region reporting
        // "not busy" through the two engine searches an attempt costs.
        if (resultEl) setEndgameBusy(resultEl, phase === 'loading' || phase === 'attempting');
        refresh();
        if (noteEl && phase === 'loading') {
          lastNoteKey = 'loading';
          renderEndgameNote(noteEl, getEndgameMessage('loading', deps.i18n));
        }
        if (noteEl && phase === 'attempting') {
          lastNoteKey = 'judging';
          renderEndgameNote(noteEl, getEndgameMessage('judging', deps.i18n));
        }
      },
      onPosition: (position) => {
        lastPosition = position;
        lastAttemptResult = null;
        lastVerdictNote = null;
        if (boardEl && positionRowsEl) {
          disposeBoard();
          boardEl.innerHTML = '';
          board = renderEndgamePosition(doc, boardEl, positionRowsEl, position, deps.i18n);
        }
        if (rowsEl && resultEl) clearEndgame(rowsEl, resultEl);
        if (moveInput) moveInput.value = '';
        if (errorEl) {
          lastErrorKey = null;
          renderEndgameError(errorEl, null);
        }
        hasPosition = true;
        lastNoteKey = 'yourMove';
        if (noteEl) renderEndgameNote(noteEl, getEndgameMessage('yourMove', deps.i18n));
        refresh();
      },
      onAttemptResult: (result) => {
        lastAttemptResult = result;
        if (rowsEl && resultEl) {
          const note = renderEndgameVerdict(doc, rowsEl, resultEl, result, deps.i18n);
          lastVerdictNote = note;
          if (noteEl) renderEndgameNote(noteEl, note);
        }
        if (errorEl) {
          lastErrorKey = null;
          renderEndgameError(errorEl, null);
        }
        refresh();
      },
      onFailure: (failure) => {
        if (failure === 'rate-limited' || failure === 'unavailable' || failure === 'unauthenticated') {
          const key: keyof typeof ENDGAME_MESSAGES =
            failure === 'rate-limited' ? 'rateLimited' : failure === 'unavailable' ? 'unavailable' : 'signedOut';
          lastNoteKey = key;
          if (noteEl) renderEndgameNote(noteEl, getEndgameMessage(key, deps.i18n));
          if (errorEl) {
            lastErrorKey = null;
            renderEndgameError(errorEl, null);
          }
        } else {
          const key: keyof typeof ENDGAME_MESSAGES = failure === 'rejected' ? 'rejected' : 'failed';
          lastErrorKey = key;
          if (noteEl) {
            lastNoteKey = null;
            renderEndgameNote(noteEl, null);
          }
          if (errorEl) {
            renderEndgameError(errorEl, getEndgameMessage(key, deps.i18n));
          }
        }
        refresh();
      },
      // The controller has dropped its position, so the mount must drop the board and the form
      // with it. Clearing only the verdict left submission enabled against a position the
      // controller no longer owned, where an attempt silently did nothing.
      onInvalidated: () => {
        reset();
        refresh();
      },
    },
  });

  const unsub = deps.i18n.onLocaleChange(() => {
    if (hasPosition && lastPosition && positionRowsEl) {
      renderEndgamePositionRows(doc, positionRowsEl, lastPosition, deps.i18n);
    }
    if (lastAttemptResult && rowsEl && resultEl) {
      lastVerdictNote = renderEndgameVerdict(doc, rowsEl, resultEl, lastAttemptResult, deps.i18n);
    }
    if (lastVerdictNote !== null && noteEl) {
      renderEndgameNote(noteEl, lastVerdictNote);
    } else if (lastNoteKey && noteEl) {
      renderEndgameNote(noteEl, getEndgameMessage(lastNoteKey, deps.i18n));
    }
    if (lastErrorKey && errorEl) {
      renderEndgameError(errorEl, getEndgameMessage(lastErrorKey, deps.i18n));
    }
    refresh();
  });
  unbinds.push(unsub);

  reset();
  refresh();

  /**
   * Bind a listener for the lifetime of this mount.
   *
   * Route-scoped rather than a bare `addEventListener`: this DOM outlives the mount, so a bare
   * binding would stack a new listener — each holding a disposed controller — on every visit.
   *
   * @param el - the target, or `null` when the element is absent.
   * @param type - the event name.
   * @param listener - the handler.
   */
  const bind = (el: EventTarget | null, type: string, listener: (event: Event) => void): void => {
    if (!el) return;
    el.addEventListener(type, listener);
    unbinds.push(() => el.removeEventListener(type, listener));
  };

  bind(nextBtn, 'click', () => {
    void controller.next();
  });

  // The form owns submission so Enter in the input plays the move, which is what a player expects
  // and is what the lesson move step already does.
  bind(formEl, 'submit', (event) => {
    event.preventDefault();
    const move = (moveInput?.value ?? '').trim().toLowerCase();
    if (move === '') return;
    void controller.attempt(move);
  });

  return {
    onSessionChange: (): void => {
      refresh();
    },
    dispose: (): void => {
      controller.dispose();
      disposeBoard();
      for (const unbind of unbinds) unbind();
      unbinds.length = 0;
    },
  };
}
