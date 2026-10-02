import type { GambitClient } from '../api/client.js';
import type {
  LeaderboardEntry,
  SocialPlayer,
  Speed,
  TournamentDetail,
  TournamentGameCommentary,
  TournamentLiveBoard,
  TournamentRound,
  TournamentRoundRecap,
  TournamentStanding,
  TournamentSummary,
  Variant,
} from '../api/models.js';
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
import type { CommentaryFailure, CommentaryPhase, CommentaryResult, CommentaryTarget } from './tournament-commentary-controller.js';
import {
  COMMENTARY_MESSAGES,
  getCommentaryMessage,
  renderGameCommentary,
  renderRoundRecap,
} from './tournament-commentary-view.js';
import type { I18n } from '../i18n/manager.js';

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
    elements.results.innerHTML = '';
    elements.loading.hidden = false;
    return;
  }
  elements.loading.hidden = true;
  elements.results.hidden = false;
  if (!state.resultsRendered) elements.results.innerHTML = '';
}

function createLeaderboardCallbacks(
  elements: LeaderboardElements,
  onEntries: (
    entries: readonly LeaderboardEntry[],
    names: ReadonlyMap<string, SocialPlayer>,
    variant: Variant,
    speed: Speed,
  ) => void,
  i18n: I18n,
): LeaderboardCallbacks {
  const state: LeaderboardRenderState = { resultsRendered: false };
  return {
    onResults: (entries, names, variant, speed) => {
      state.resultsRendered = true;
      onEntries(entries, names, variant, speed);
      if (elements.error) elements.error.textContent = '';
      if (elements.results) renderLeaderboard(elements.results, entries, names, i18n);
    },
    onLoading: (loading) => setLeaderboardLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountLeaderboard(doc: Document, client: GambitClient, i18n: I18n): LeaderboardMount {
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
  let currentLoadedPool: {
    variant: Variant;
    speed: Speed;
    entries: readonly LeaderboardEntry[];
    names: ReadonlyMap<string, SocialPlayer>;
  } | null = null;

  if (elements.select) renderVariantSelector(elements.select, activeVariant, i18n);
  if (elements.speedSelect) renderSpeedSelector(elements.speedSelect, activeSpeed, i18n);
  if (elements.results) renderChooseSpeed(elements.results, i18n);

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    if (elements.select) renderVariantSelector(elements.select, activeVariant, i18n);
    if (elements.speedSelect) renderSpeedSelector(elements.speedSelect, activeSpeed, i18n);
    if (elements.results) {
      if (
        currentLoadedPool !== null &&
        currentLoadedPool.variant === activeVariant &&
        currentLoadedPool.speed === activeSpeed
      ) {
        renderLeaderboard(elements.results, currentLoadedPool.entries, currentLoadedPool.names, i18n);
      } else if (activeSpeed === null) {
        renderChooseSpeed(elements.results, i18n);
      } else {
        elements.results.innerHTML = '';
      }
    }
  });

  const controller = new LeaderboardController({
    client,
    callbacks: createLeaderboardCallbacks(
      elements,
      (entries, names, variant, speed) => {
        if (variant === activeVariant && speed === activeSpeed) {
          currentLoadedPool = { variant, speed, entries, names };
        }
      },
      i18n,
    ),
  });
  const load = (): void => {
    if (activeSpeed !== null) void controller.loadLeaderboard(activeVariant, activeSpeed);
  };
  const unbindVariant = elements.select
    ? bindVariantSelector(elements.select, (variant) => {
        activeVariant = variant;
        currentLoadedPool = null;
        load();
      })
    : () => {};
  const unbindSpeed = elements.speedSelect
    ? bindSpeedSelector(elements.speedSelect, (speed) => {
        activeSpeed = speed;
        currentLoadedPool = null;
        load();
      })
    : () => {};

  return {
    dispose: () => {
      unbindVariant();
      unbindSpeed();
      unsubscribeLocale();
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
  i18n: I18n,
): void {
  if (!elements.list) return;
  elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.listRendered = false;
    const row = (elements.list.ownerDocument ?? document).createElement('div');
    row.className = 'panel-row';
    row.textContent = i18n.t('common.loading');
    elements.list.replaceChildren(row);
    return;
  }
  // A failed request has already populated the error region. Keeping the loading row would
  // contradict that failure and imply that work is still in progress.
  if (!state.listRendered) elements.list.replaceChildren();
}

function createTournamentListCallbacks(
  elements: TournamentListElements,
  onTournaments: (tournaments: readonly TournamentSummary[]) => void,
  i18n: I18n,
): TournamentCallbacks {
  const state: TournamentListRenderState = { listRendered: false };
  return {
    onList: (tournaments) => {
      state.listRendered = true;
      onTournaments(tournaments);
      if (elements.list) renderTournamentList(elements.list, tournaments, i18n);
    },
    onDetail: () => {},
    onStandings: () => {},
    onLiveGames: () => {},
    onLoading: (loading) => setTournamentListLoading(elements, state, loading, i18n),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentList(
  doc: Document,
  client: GambitClient,
  i18n: I18n,
): TournamentController {
  const elements: TournamentListElements = {
    list: doc.getElementById('tournament-list'),
    error: doc.getElementById('tournaments-error'),
  };

  let lastTournaments: readonly TournamentSummary[] | null = null;

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastTournaments !== null && elements.list) {
      renderTournamentList(elements.list, lastTournaments, i18n);
    }
  });

  const controller = new TournamentController({
    client,
    callbacks: createTournamentListCallbacks(
      elements,
      (tournaments) => {
        lastTournaments = tournaments;
      },
      i18n,
    ),
    onDispose: () => {
      unsubscribeLocale();
    },
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
  i18n: I18n,
): void {
  if (elements.meta) elements.meta.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.standings) elements.standings.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (elements.live) elements.live.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (!elements.meta) return;
  if (loading && state.currentDetail === null) {
    const row = (elements.meta.ownerDocument ?? document).createElement('div');
    row.className = 'panel-row';
    row.textContent = i18n.t('common.loading');
    elements.meta.replaceChildren(row);
    return;
  }
  // A failed initial load has already populated the error region. Clear only its stale placeholder.
  if (!loading && state.currentDetail === null) elements.meta.replaceChildren();
}

function createTournamentDetailCallbacks(
  elements: TournamentDetailElements,
  startLive: (tournamentId: string) => void,
  onStateUpdate: {
    onDetail: (detail: TournamentDetail) => void;
    onStandings: (
      standings: readonly TournamentStanding[],
      names: ReadonlyMap<string, { id: string; handle: string }>,
    ) => void;
    onLiveGames: (
      games: readonly TournamentLiveBoard[],
      names: ReadonlyMap<string, { id: string; handle: string }>,
    ) => void;
  },
  i18n: I18n,
): TournamentCallbacks {
  const state: TournamentDetailRenderState = { currentDetail: null };
  return {
    onList: () => {},
    onDetail: (detail) => {
      state.currentDetail = detail;
      onStateUpdate.onDetail(detail);
      const nameElement = elements.doc.getElementById('tournament-name');
      if (nameElement) nameElement.textContent = detail.name;
      if (elements.meta) renderTournamentDetail(elements.meta, detail, i18n);
      if (detail.state === 'running') startLive(detail.id);
    },
    onStandings: (standings, names) => {
      onStateUpdate.onStandings(standings, names);
      if (elements.standings) renderStandings(elements.standings, standings, names, i18n);
    },
    onLiveGames: (games, names) => {
      onStateUpdate.onLiveGames(games, names);
      if (elements.live) renderLiveBoards(elements.live, games, names, i18n);
    },
    onLoading: (loading) => setTournamentDetailLoading(elements, state, loading, i18n),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountTournamentDetail(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
  i18n: I18n,
): TournamentController {
  const elements: TournamentDetailElements = {
    doc,
    meta: doc.getElementById('tournament-meta'),
    standings: doc.getElementById('tournament-standings'),
    live: doc.getElementById('tournament-live'),
    error: doc.getElementById('tournament-error'),
  };

  let lastDetail: TournamentDetail | null = null;
  let lastStandings: readonly TournamentStanding[] | null = null;
  let lastStandingsNames: ReadonlyMap<string, { id: string; handle: string }> | null = null;
  let lastLiveGames: readonly TournamentLiveBoard[] | null = null;
  let lastLiveNames: ReadonlyMap<string, { id: string; handle: string }> | null = null;

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastDetail && elements.meta) {
      renderTournamentDetail(elements.meta, lastDetail, i18n);
    }
    if (lastStandings && lastStandingsNames && elements.standings) {
      renderStandings(elements.standings, lastStandings, lastStandingsNames, i18n);
    }
    if (lastLiveGames && lastLiveNames && elements.live) {
      renderLiveBoards(elements.live, lastLiveGames, lastLiveNames, i18n);
    }
  });

  let controller: TournamentController;
  controller = new TournamentController({
    client,
    callbacks: createTournamentDetailCallbacks(
      elements,
      (runningTournamentId) => controller.startLive(runningTournamentId),
      {
        onDetail: (d) => { lastDetail = d; },
        onStandings: (s, n) => { lastStandings = s; lastStandingsNames = n; },
        onLiveGames: (g, n) => { lastLiveGames = g; lastLiveNames = n; },
      },
      i18n,
    ),
    onDispose: () => {
      unsubscribeLocale();
    },
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
 * @param i18n - internationalization manager.
 * @returns the wording for it, in this section's vocabulary.
 */
function commentaryFailureMessage(failure: CommentaryFailure, i18n: I18n): string {
  switch (failure) {
    case 'unauthenticated':
      return getCommentaryMessage('signedOut', i18n);
    case 'rate-limited':
      return getCommentaryMessage('rateLimited', i18n);
    case 'unavailable':
      return getCommentaryMessage('unavailable', i18n);
    case 'unsupported-variant':
      return getCommentaryMessage('unsupportedVariant', i18n);
    case 'not-ready':
      return getCommentaryMessage('notReady', i18n);
    case 'rejected':
      return getCommentaryMessage('rejected', i18n);
    default:
      return getCommentaryMessage('failed', i18n);
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
 * @param i18n - internationalization manager.
 * @param loadFlags - the memoised capabilities read, injectable for tests.
 * @returns the mounted section.
 */
export function mountTournamentCommentary(
  doc: Document,
  client: GambitClient,
  tournamentId: string,
  i18n: I18n,
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
  type CommentaryViewState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'failure'; failure: CommentaryFailure }
    | { kind: 'result'; result: CommentaryResult };

  let viewState: CommentaryViewState = { kind: 'idle' };
  let currentRounds: readonly TournamentRound[] | null = null;

  /** Drop whatever answer is on screen and hide the region it was in. */
  const clearResult = (): void => {
    if (viewState.kind === 'result') {
      viewState = { kind: 'idle' };
    }
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
        if (phase === 'loading') {
          viewState = { kind: 'loading' };
          elements.status.textContent = getCommentaryMessage('running', i18n);
        } else if (phase === 'idle') {
          viewState = { kind: 'idle' };
          elements.status.textContent = getCommentaryMessage('idle', i18n);
        } else if (phase === 'result') {
          elements.status.textContent = '';
        }
      },
      onResult: (result) => {
        viewState = { kind: 'result', result };
        if (!elements.result) return;
        if (result.kind === 'game') {
          renderGameCommentary(doc, elements.result, result.value, i18n);
        } else {
          renderRoundRecap(doc, elements.result, result.value, i18n);
        }
        elements.result.hidden = false;
      },
      onFailure: (failure) => {
        viewState = { kind: 'failure', failure };
        clearResult();
        if (elements.status) elements.status.textContent = commentaryFailureMessage(failure, i18n);
      },
      onInvalidated: () => {
        viewState = { kind: 'idle' };
        clearResult();
      },
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
      const recapLabel = i18n.t('tournaments.recapRound', { number });
      addControl(
        `tournament-commentary-recap-${String(round.roundIndex)}`,
        recapLabel,
        { kind: 'round', tournamentId, round: round.roundIndex },
      );

      // A pairing with no `gameId` has not been launched, so there is nothing to commentate and no
      // id to ask about. A bye carries no game at all.
      round.pairings.forEach((pairing, board) => {
        if (pairing.kind !== 'game' || pairing.gameId === null) return;
        const commentateLabel = i18n.t('tournaments.commentateRoundBoard', { number, board: board + 1 });
        addControl(
          `tournament-commentary-game-${String(round.roundIndex)}-${String(board)}`,
          commentateLabel,
          { kind: 'game', tournamentId, gameId: pairing.gameId },
        );
      });
    }
  };

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    if (elements.status) {
      switch (viewState.kind) {
        case 'failure':
          elements.status.textContent = commentaryFailureMessage(viewState.failure, i18n);
          break;
        case 'loading':
          elements.status.textContent = getCommentaryMessage('running', i18n);
          break;
        case 'idle':
          elements.status.textContent = getCommentaryMessage('idle', i18n);
          break;
        case 'result':
          elements.status.textContent = '';
          break;
      }
    }
    if (elements.result && viewState.kind === 'result') {
      if (viewState.result.kind === 'game') {
        renderGameCommentary(doc, elements.result, viewState.result.value, i18n);
      } else {
        renderRoundRecap(doc, elements.result, viewState.result.value, i18n);
      }
    }
    if (currentRounds !== null && elements.controls) {
      for (const entry of appended) {
        entry.el.removeEventListener('click', entry.onClick);
        elements.controls?.removeChild(entry.el);
      }
      appended.length = 0;
      renderControls(currentRounds);
    }
  });

  void loadFlags(client)
    .then(async (flags) => {
      if (disposed) return;
      available = tournamentCommentaryEnabled(flags);
      if (elements.panel) elements.panel.hidden = !available;
      if (!available) return;
      if (elements.status) elements.status.textContent = getCommentaryMessage('idle', i18n);

      // Read only once the capability says the panel will be shown, so a deployment without
      // commentary makes no request on behalf of a section nobody will see.
      const rounds = await client.tournaments.rounds(tournamentId);
      if (disposed) return;
      currentRounds = rounds;
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
      if (elements.status) elements.status.textContent = getCommentaryMessage('failed', i18n);
    });

  return {
    dispose: () => {
      disposed = true;
      controller.dispose();
      unsubscribeLocale();
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
