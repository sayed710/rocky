/**
 * The `/endgames` route (M15 inc 20, ADR-0128).
 *
 * Its own route rather than a section of the game sidebar: every sidebar section describes the
 * position already on the board, and that board is driven by the live game's authoritative
 * snapshots. A training position there would be overwritten by the next move of the real game, and
 * the board's `onMove` submits to that game — so training gets its own surface, the way lessons do.
 */
import type { GambitClient } from '../api/client.js';
import { EndgameController } from './endgame-controller.js';
import {
  ENDGAME_MESSAGES,
  clearEndgame,
  renderEndgameError,
  renderEndgameNote,
  renderEndgamePosition,
  renderEndgameVerdict,
  setEndgameBusy,
} from './endgame-view.js';

export interface EndgameMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly isAuthenticated: () => boolean;
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
  };

  /** Bring the two controls into agreement with the session and whether a position is loaded. */
  const refresh = (): void => {
    const authed = deps.isAuthenticated();
    if (layoutEl) layoutEl.hidden = !authed || !hasPosition;
    if (nextBtn) nextBtn.disabled = !authed || controller.isPending;
    if (submitBtn) submitBtn.disabled = !authed || !hasPosition || controller.isPending;
    if (moveInput) moveInput.disabled = !authed || !hasPosition;
    if (!noteEl) return;
    const owned = new Set<string>([
      ENDGAME_MESSAGES.idle,
      ENDGAME_MESSAGES.signedOut,
      // Owned too: it is the prompt for a position, so it must not outlive one. A remount clears
      // the position but leaves this DOM behind, and a note this function will not overwrite would
      // sit there telling a visitor to move in a position that is no longer on the board.
      ENDGAME_MESSAGES.yourMove,
      '',
    ]);
    if (!owned.has(noteEl.textContent ?? '')) return;
    // `yourMove` is owned so a remount can clear it, which means this has to know when to put it
    // back: without the `hasPosition` arm, `onPosition` set the prompt and the `refresh()` at the
    // end of the same callback replaced it with "pick a training endgame" over a loaded board.
    // Raised in the CodeRabbit review of PR #151.
    renderEndgameNote(
      noteEl,
      !authed
        ? ENDGAME_MESSAGES.signedOut
        : hasPosition
          ? ENDGAME_MESSAGES.yourMove
          : ENDGAME_MESSAGES.idle,
    );
  };

  const controller = new EndgameController({
    client: deps.client,
    callbacks: {
      onPhase: (phase) => {
        // Both phases are work in flight; only announcing `loading` left the region reporting
        // "not busy" through the two engine searches an attempt costs.
        if (resultEl) setEndgameBusy(resultEl, phase === 'loading' || phase === 'attempting');
        refresh();
        if (noteEl && phase === 'loading') renderEndgameNote(noteEl, ENDGAME_MESSAGES.loading);
        if (noteEl && phase === 'attempting') renderEndgameNote(noteEl, ENDGAME_MESSAGES.judging);
      },
      onPosition: (position) => {
        if (boardEl && positionRowsEl) {
          disposeBoard();
          boardEl.innerHTML = '';
          board = renderEndgamePosition(doc, boardEl, positionRowsEl, position);
        }
        if (rowsEl && resultEl) clearEndgame(rowsEl, resultEl);
        if (moveInput) moveInput.value = '';
        if (errorEl) renderEndgameError(errorEl, null);
        hasPosition = true;
        if (noteEl) renderEndgameNote(noteEl, ENDGAME_MESSAGES.yourMove);
        refresh();
      },
      onAttemptResult: (result) => {
        if (rowsEl && resultEl) {
          const note = renderEndgameVerdict(doc, rowsEl, resultEl, result);
          if (noteEl) renderEndgameNote(noteEl, note);
        }
        if (errorEl) renderEndgameError(errorEl, null);
        refresh();
      },
      onFailure: (failure) => {
        const noteFor: Partial<Record<typeof failure, string>> = {
          'rate-limited': ENDGAME_MESSAGES.rateLimited,
          unavailable: ENDGAME_MESSAGES.unavailable,
          unauthenticated: ENDGAME_MESSAGES.signedOut,
        };
        const note = noteFor[failure];
        if (note) {
          if (noteEl) renderEndgameNote(noteEl, note);
          if (errorEl) renderEndgameError(errorEl, null);
        } else {
          if (noteEl) renderEndgameNote(noteEl, null);
          if (errorEl) {
            renderEndgameError(
              errorEl,
              failure === 'rejected' ? ENDGAME_MESSAGES.rejected : ENDGAME_MESSAGES.failed,
            );
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
