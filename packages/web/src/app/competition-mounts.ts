import type { GambitClient } from '../api/client.js';
import type { Speed, TournamentDetail, TournamentRound, Variant } from '../api/models.js';
import { LeaderboardController } from './leaderboard-controller.js';
import type { LeaderboardCallbacks } from './leaderboard-controller.js';
import {
  bindSpeedSelector,
  bindVariantSelector,
  renderChooseSpeed,
  renderLeaderboard,
  renderSpeedSelector,
  renderVariantSelector,
} from './leaderboard-view.js';
import { TournamentController } from './tournament-controller.js';
import type { TournamentCallbacks } from './tournament-controller.js';
import {
  renderLiveBoards,
  renderStandings,
  renderTournamentDetail,
  renderTournamentList,
} from './tournament-view.js';
import { loadCapabilities, tournamentCommentaryEnabled } from './capabilities-nav.js';
import { TournamentCommentaryController } from './tournament-commentary-controller.js';
import type { CommentaryFailure, CommentaryTarget } from './tournament-commentary-controller.js';
import {
  COMMENTARY_MESSAGES,
  renderGameCommentary,
  renderRoundRecap,
} from './tournament-commentary-view.js';

interface LeaderboardMount {
  dispose(): void;
}

interface LeaderboardElements {
  readonly select: HTMLSelectElement | null;
  readonly speedSelect: HTMLSelectElement | null;
  readonly loading: HTMLElement | null;
  readonly results: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface LeaderboardRenderState {
  resultsRendered: boolean;
}

function setLeaderboardLoading(
  elements: LeaderboardElements,
  state: LeaderboardRenderState,
  loading: boolean,
): void {
  if (!elements.results || !elements.loading) return;
  elements.results.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.resultsRendered = false;
    if (elements.error) elements.error.textContent = '';
    elements.results.hidden = true;
    elements.loading.hidden = false;
    return;
  }
  elements.loading.hidden = true;
  elements.results.hidden = false;
  if (!state.resultsRendered) elements.results.innerHTML = '';
}

function createLeaderboardCallbacks(elements: LeaderboardElements): LeaderboardCallbacks {
  const state: LeaderboardRenderState = { resultsRendered: false };
  return {
    onResults: (entries, names) => {
      state.resultsRendered = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.results) renderLeaderboard(elements.results, entries, names);
    },
    onLoading: (loading) => setLeaderboardLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountLeaderboard(doc: Document, client: GambitClient): LeaderboardMount {
  const elements: LeaderboardElements = {
    select: doc.getElementById('leaderboard-variant-select') as HTMLSelectElement | null,
    speedSelect: doc.getElementById('leaderboard-speed-select') as HTMLSelectElement | null,
    loading: doc.getElementById('leaderboard-loading'),
    results: doc.getElementById('leaderboard-results'),
    error: doc.getElementById('leaderboard-error'),
  };
  let activeVariant: Variant = 'standard';
  // No speed is chosen for the viewer: a pool is a variant and a speed, and there is no default pool.
  let activeSpeed: Speed | null = null;
  if (elements.select) renderVariantSelector(elements.select, activeVariant);
  if (elements.speedSelect) renderSpeedSelector(elements.speedSelect, activeSpeed);
  if (elements.results) renderChooseSpeed(elements.results);

  const controller = new LeaderboardController({
    client,
    callbacks: createLeaderboardCallbacks(elements),
  });
  const load = (): void => {
    if (activeSpeed !== null) void controller.loadLeaderboard(activeVariant, activeSpeed);
  };
  const unbindVariant = elements.select
    ? bindVariantSelector(elements.select, (variant) => {
        activeVariant = variant;
        load();
      })
    : () => {};
  const unbindSpeed = elements.speedSelect
    ? bindSpeedSelector(elements.speedSelect, (speed) => {
        activeSpeed = speed;
        load();
      })
    : () => {};

  return {
    dispose: () => {
      unbindVariant();
      unbindSpeed();
      controller.dispose();
    },
  };
}

interface TournamentListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TournamentListRenderState {
  listRendered: boolean;
}

function setTournamentListLoading(
  elements: TournamentListElements,
  state: TournamentListRenderState,
  loading: boolean,
): void {
  if (!elements.list) return;
  elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.listRendered = false;
    elements.list.innerHTML = '<div class="panel-row">Loading…</div>';
    return;
  }
  // A failed request has already populated the error region. Keeping the loading row would
  // contradict that failure and imply that work is still in progress.
  if (!state.listRendered) elements.list.innerHTML = '';
}

function createTournamentListCallbacks(elements: TournamentListElements): TournamentCallbacks {
  const state: TournamentListRenderState = { listRendered: false };
  return {
    onList: (tournaments) => {
      state.listRendered = true;
      if (elements.list) renderTournamentList(elements.list, tournaments);
    },
    onDetail: () => {},
    onStandings: () => {},
    onLiveGames: () => {},
    onLoading: (loading) => setTournamentListLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentList(doc: Document, client: GambitClient): TournamentController {
  const elements: TournamentListElements = {
    list: doc.getElementById('tournament-list'),
    error: doc.getElementById('tournaments-error'),
  };
  const controller = new TournamentController({
    client,
    callbacks: createTournamentListCallbacks(elements),
  });
  void controller.loadList();
  return controller;
}

interface TournamentDetailElements {
  readonly doc: Document;
  readonly meta: HTMLElement | null;
  readonly standings: HTMLElement | null;
  readonly live: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TournamentDetailRenderState {
  currentDetail: TournamentDetail | null;
}

function setTournamentDetailLoading(
  elements: TournamentDetailElements,
  state: TournamentDetailRenderState,
  loading: boolean,
): void {
  if (elements.meta) elements.meta.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.standings) elements.standings.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.live) elements.live.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (!elements.meta) return;
  if (loading && state.currentDetail === null) {
    elements.meta.innerHTML = '<div class="panel-row">Loading…</div>';
    return;
  }
  // A failed initial load has already populated the error region. Clear only its stale placeholder.
  if (!loading && state.currentDetail === null) elements.meta.innerHTML = '';
}

function createTournamentDetailCallbacks(
  elements: TournamentDetailElements,
  startLive: (tournamentId: string) => void,
): TournamentCallbacks {
  const state: TournamentDetailRenderState = { currentDetail: null };
  return {
    onList: () => {},
    onDetail: (detail) => {
      state.currentDetail = detail;
      const nameElement = elements.doc.getElementById('tournament-name');
      if (nameElement) nameElement.textContent = detail.name;
      if (elements.meta) renderTournamentDetail(elements.meta, detail);
      if (detail.state === 'running') startLive(detail.id);
    },
    onStandings: (standings, names) => {
      if (elements.standings) renderStandings(elements.standings, standings, names);
    },
    onLiveGames: (games, names) => {
      if (elements.live) renderLiveBoards(elements.live, games, names);
    },
    onLoading: (loading) => setTournamentDetailLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentDetail(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
): TournamentController {
  const elements: TournamentDetailElements = {
    doc,
    meta: doc.getElementById('tournament-meta'),
    standings: doc.getElementById('tournament-standings'),
    live: doc.getElementById('tournament-live'),
    error: doc.getElementById('tournament-error'),
  };
  let controller: TournamentController;
  controller = new TournamentController({
    client,
    callbacks: createTournamentDetailCallbacks(
      elements,
      (runningTournamentId) => controller.startLive(runningTournamentId),
    ),
  });
  void controller.loadDetail(tournamentId);
  return controller;
}

/** What {@link mountTournamentCommentary} hands back to the lifecycle. */
export interface MountedTournamentCommentary {
  /** Abandon anything in flight and remove every control this mount appended. */
  dispose(): void;
  /** Called when the session changes; a sign-out clears whatever is on screen. */
  sessionChanged(signedIn: boolean): void;
}

interface CommentaryElements {
  readonly panel: HTMLElement | null;
  readonly controls: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly result: HTMLElement | null;
}

/**
 * @param failure - what went wrong.
 * @returns the wording for it, in this section's vocabulary.
 */
function commentaryFailureMessage(failure: CommentaryFailure): string {
  switch (failure) {
    case 'unauthenticated':
      return COMMENTARY_MESSAGES.signedOut;
    case 'rate-limited':
      return COMMENTARY_MESSAGES.rateLimited;
    case 'unavailable':
      return COMMENTARY_MESSAGES.unavailable;
    case 'unsupported-variant':
      return COMMENTARY_MESSAGES.unsupportedVariant;
    case 'not-ready':
      return COMMENTARY_MESSAGES.notReady;
    case 'rejected':
      return COMMENTARY_MESSAGES.rejected;
    default:
      return COMMENTARY_MESSAGES.failed;
  }
}

/**
 * Wire the commentary panel on a tournament detail page (ADR-0130).
 *
 * The panel stays hidden until capabilities answer, and it is the capability flag that reveals it —
 * not the presence of a tournament. A deployment with an engine but no provider composes no
 * commentary at all, and offering a button there would spend a request to be told 503.
 *
 * A recap control per generated round, a commentary control per launched game, and the server
 * decides which of them can be answered.
 *
 * The client cannot know which: `GET /v1/tournaments/:id/rounds` publishes pairings and no results,
 * so round completeness and game terminality are facts only the server holds. Rather than guess —
 * the first draft hard-coded round 0 under a label promising "the last complete round", which was a
 * label that lied — every round and every launched game is offered, and a 409 renders as "that game
 * is still being played, or that round is not finished yet". A specific true answer from the server
 * beats a wrong guess made locally.
 *
 * Both kinds of control, because there are two endpoints. Shipping only the recap left the
 * finished-game commentary reachable from the client library and from nowhere a person could click,
 * which is half a feature — raised in the Qodo review of PR #153.
 *
 * @param doc - the owning document.
 * @param client - the API client.
 * @param tournamentId - the tournament on screen.
 * @param loadFlags - the memoised capabilities read, injectable for tests.
 * @returns the mounted section.
 */
export function mountTournamentCommentary(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
  loadFlags: (api: GambitClient) => Promise<unknown> = loadCapabilities,
): MountedTournamentCommentary {
  const elements: CommentaryElements = {
    panel: doc.getElementById('tournament-commentary-panel'),
    controls: doc.getElementById('tournament-commentary-controls'),
    status: doc.getElementById('tournament-commentary-status'),
    result: doc.getElementById('tournament-commentary-result'),
  };

  let disposed = false;
  let available = false;

  /** Drop whatever answer is on screen and hide the region it was in. */
  const clearResult = (): void => {
    if (elements.result) {
      elements.result.textContent = '';
      elements.result.hidden = true;
    }
  };

  const controller = new TournamentCommentaryController({
    client,
    callbacks: {
      onPhase: (phase) => {
        if (!elements.status) return;
        // `error` is deliberately absent. The controller reports the failure first and the phase
        // immediately after, so a branch here that wrote anything for `error` would erase the
        // message `onFailure` had just set — which is what it did, blanking the status line on every
        // refusal until a mount test caught it.
        if (phase === 'loading') elements.status.textContent = COMMENTARY_MESSAGES.running;
        else if (phase === 'idle') elements.status.textContent = COMMENTARY_MESSAGES.idle;
        else if (phase === 'result') elements.status.textContent = '';
      },
      onResult: (result) => {
        if (!elements.result) return;
        if (result.kind === 'game') {
          renderGameCommentary(doc, elements.result, result.value);
        } else {
          renderRoundRecap(doc, elements.result, result.value);
        }
        elements.result.hidden = false;
      },
      onFailure: (failure) => {
        clearResult();
        if (elements.status) elements.status.textContent = commentaryFailureMessage(failure);
      },
      onInvalidated: clearResult,
    },
  });

  // Everything this mount appends, and the listener bound to each, so `dispose` can undo exactly
  // what it did. The controls container comes from `getElementById` and belongs to the page, not to
  // this mount: `lifecycle.ts` tears down and re-bootstraps on every SPA navigation, so a mount that
  // appended without removing would leave a second button with the same id — shadowing the first for
  // `getElementById` — and a click listener still holding a disposed controller.
  const appended: { el: HTMLElement; onClick: () => void }[] = [];

  // Called exactly once, from the capability read below and only after it has established that the
  // panel will be shown. No clear-first loop and no second availability check, because both would be
  // guards on a path that cannot be taken — and an unreachable guard is one nothing can keep honest.
  // Removing whatever this appended is `dispose`'s job, and it is tested there.
  /**
   * @param id - the element id to give the control.
   * @param label - what it says.
   * @param request - what clicking it asks for.
   */
  const addControl = (id: string, label: string, request: CommentaryTarget): void => {
    if (!elements.controls) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = id;
    button.textContent = label;
    /** Ask for this control's commentary, unless the capability read said there is none. */
    const onClick = (): void => {
      if (!available) return;
      void controller.request(request);
    };
    button.addEventListener('click', onClick);
    elements.controls.appendChild(button);
    appended.push({ el: button, onClick });
  };

  /**
   * Build one control per round and one per launched game.
   *
   * @param rounds - the tournament's generated rounds, pairings and all.
   */
  const renderControls = (rounds: readonly TournamentRound[]): void => {
    for (const round of rounds) {
      const number = round.roundIndex + 1;
      addControl(
        `tournament-commentary-recap-${String(round.roundIndex)}`,
        `Recap round ${String(number)}`,
        { kind: 'round', tournamentId, round: round.roundIndex },
      );

      // A pairing with no `gameId` has not been launched, so there is nothing to commentate and no
      // id to ask about. A bye carries no game at all.
      round.pairings.forEach((pairing, board) => {
        if (pairing.kind !== 'game' || pairing.gameId === null) return;
        addControl(
          `tournament-commentary-game-${String(round.roundIndex)}-${String(board)}`,
          `Commentate round ${String(number)}, board ${String(board + 1)}`,
          { kind: 'game', tournamentId, gameId: pairing.gameId },
        );
      });
    }
  };

  void loadFlags(client)
    .then(async (flags) => {
      if (disposed) return;
      available = tournamentCommentaryEnabled(flags);
      if (elements.panel) elements.panel.hidden = !available;
      if (!available) return;
      if (elements.status) elements.status.textContent = COMMENTARY_MESSAGES.idle;

      // Read only once the capability says the panel will be shown, so a deployment without
      // commentary makes no request on behalf of a section nobody will see.
      const rounds = await client.tournaments.rounds(tournamentId);
      if (disposed) return;
      renderControls(rounds);
    })
    .catch(() => {
      if (disposed) return;
      // Two failures reach here and they need opposite answers.
      //
      // A capabilities read that fails leaves `available` false and the panel hidden — failing
      // closed, the same choice `capabilityFlags` makes on a malformed payload.
      //
      // A *rounds* read that fails happens after the panel has been shown and its status set to
      // "ask for commentary", so saying nothing left a reader looking at a panel that claimed to be
      // ready with nothing in it to click. Raised in the CodeRabbit review of PR #153.
      if (!available) return;
      if (elements.status) elements.status.textContent = COMMENTARY_MESSAGES.failed;
    });

  return {
    dispose: () => {
      disposed = true;
      controller.dispose();
      // Removed, not just abandoned. See `appended` above: the container outlives this mount.
      for (const entry of appended) {
        entry.el.removeEventListener('click', entry.onClick);
        elements.controls?.removeChild(entry.el);
      }
      appended.length = 0;
      clearResult();
    },
    // ADR-0074 applied to this region: the answer on screen was written for a caller who is gone,
    // so it goes with them rather than staying up for whoever signs in next.
    sessionChanged: (signedIn) => {
      if (signedIn) return;
      controller.targetLost();
    },
  };
}
