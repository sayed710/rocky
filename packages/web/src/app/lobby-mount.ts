import { resolveBrowserStorage } from '../i18n/storage.js';
import type { GambitClient } from '../api/client.js';
import { OFFERED_VARIANTS, type SeekView, type SocialPlayer, type Variant } from '../api/models.js';
import { shortId } from '../api/graphql.js';
import type { KeyValueStorage } from '../net/session.js';
import { CreateGamePanel } from './create-game-panel.js';
import { LobbyController } from './lobby-controller.js';
import { PlayBotDialog } from './play-bot-dialog.js';
import { formatTimeControl, renderEmpty } from './render-helpers.js';

import { applyAutoDirection, applyLtrIsolation } from '../i18n/bidi.js';
import { getSpeedLabel, getVariantLabel } from './variant-labels.js';
import type { I18nManager } from '../i18n/manager.js';

/**
 * Render a seek list into a DOM element. Each seek is a row with variant,
 * speed, time control, opponent handle (derived directly from seek.creatorHandle
 * or names map fallback), and — only on the viewer's own seeks — a cancel button
 * (`currentUserId`). Cancelling someone else's seek is a 403, so the affordance
 * is owner-only. An empty list renders a first-run empty state.
 *
 * @param container - Target DOM container element
 * @param seeks - List of active open seeks to render
 * @param currentUserId - ID of currently signed-in user or null if anonymous
 * @param names - Optional fallback map of player identity resolved via read layer
 * @param i18n - Optional internationalization manager
 */
export function renderSeeks(
  container: HTMLElement,
  seeks: readonly SeekView[],
  currentUserId: string | null,
  names: ReadonlyMap<string, SocialPlayer> | undefined,
  i18n: I18nManager,
): void {
  renderSeeksInternal({
    container,
    seeks,
    currentUserId,
    names,
    i18n,
    filterVariant: 'all',
  });
}

interface RenderSeeksInternalOptions {
  readonly container: HTMLElement;
  readonly seeks: readonly SeekView[];
  readonly currentUserId: string | null;
  readonly names: ReadonlyMap<string, SocialPlayer> | undefined;
  readonly i18n: I18nManager;
  readonly filterVariant?: string;
  readonly onFocusRecovery?: () => void;
}

function renderSeeksInternal(opts: RenderSeeksInternalOptions): void {
  const { container, seeks, currentUserId, names, i18n, filterVariant, onFocusRecovery } = opts;
  const isOwn = (seek: SeekView): boolean => currentUserId !== null && seek.creatorId === currentUserId;
  const filterActive = filterVariant !== undefined && filterVariant !== 'all';
  const visibleSeeks = filterActive
    ? seeks.filter((seek) => isOwn(seek) || seek.variant === filterVariant)
    : seeks;

  // Polling an unchanged live status must not speak the empty list again.
  // Compare localized copy so a language change still replaces the status.
  if (seeks.length === 0
    && container.getAttribute('role') === 'status'
    && container.querySelector('.empty-title')?.textContent === i18n.t('lobby.emptySeeksTitle')
    && container.querySelector('.empty-body')?.textContent === i18n.t('lobby.emptySeeksBody')) {
    return;
  }
  const doc = container.ownerDocument ?? document;
  const active = doc.activeElement;
  const renderedRows = [...container.querySelectorAll<HTMLElement>('.seek-row')];
  const focusedClassName = active instanceof HTMLElement
    ? ['seek-cancel', 'seek-accept', 'row-link'].find((name) => active.classList.contains(name))
    : undefined;
  const focusedRowIndex = active instanceof HTMLElement
    ? renderedRows.findIndex((row) => row.contains(active))
    : -1;
  const focusedControl = active instanceof HTMLElement
    && container.contains(active)
    && active.dataset.seekId
    && focusedClassName
    && focusedRowIndex >= 0
    ? {
        seekId: active.dataset.seekId,
        className: focusedClassName,
        rowIndex: focusedRowIndex,
      }
    : null;

  container.replaceChildren();
  if (seeks.length === 0) {
    container.setAttribute('role', 'status');
    container.setAttribute('tabindex', '-1');
    renderEmpty(container, {
      mark: '♟',
      title: i18n.t('lobby.emptySeeksTitle'),
      body: i18n.t('lobby.emptySeeksBody'),
    });
    if (focusedControl) {
      container.focus();
    }
    return;
  }
  container.setAttribute('role', 'list');
  container.removeAttribute('tabindex');
  for (const seek of visibleSeeks) {
    const owned = currentUserId !== null && seek.creatorId === currentUserId;
    const row = doc.createElement('div');
    row.className = owned ? 'seek-row seek-row-own' : 'seek-row';
    row.dataset.seekId = seek.id;
    row.setAttribute('role', 'listitem');

    const info = doc.createElement('span');
    info.className = 'seek-info';
    const tc = formatTimeControl(seek.timeControl, i18n);
    const variantStr = i18n.locale === 'en' ? seek.variant : getVariantLabel(seek.variant, i18n);
    const speedStr = i18n.locale === 'en' ? seek.speed : getSpeedLabel(seek.speed, i18n);
    const ratedStr = seek.rated ? ` · ${i18n.t('lobby.rated')}` : '';
    info.textContent = `${variantStr} · ${speedStr} · ${tc}${ratedStr}`;

    if (owned) {
      // Your own open seek is live and waiting to be accepted — say so, and
      // give it the cancel affordance (only the creator can cancel; others 403).
      const main = doc.createElement('div');
      main.className = 'seek-main';
      main.appendChild(info);

      const waiting = doc.createElement('span');
      waiting.className = 'seek-waiting';
      const dot = doc.createElement('span');
      dot.className = 'seek-dot';
      dot.setAttribute('aria-hidden', 'true');
      waiting.append(dot, i18n.t('lobby.waitingOpponent'));
      main.appendChild(waiting);
      row.appendChild(main);

      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'seek-cancel';
      cancelBtn.textContent = i18n.t('lobby.cancel');
      cancelBtn.dataset.seekId = seek.id;
      cancelBtn.setAttribute('aria-label', i18n.t('lobby.cancelSeekAria'));
      row.appendChild(cancelBtn);
    } else {
      const main = doc.createElement('div');
      main.className = 'seek-main';
      main.appendChild(info);

      const player = names?.get(seek.creatorId);
      const opponentHandle = seek.creatorHandle ?? player?.handle ?? null;
      const opponentEl = doc.createElement('span');
      opponentEl.className = 'seek-opponent';

      if (opponentHandle) {
        const link = doc.createElement('a');
        link.className = 'row-link';
        link.setAttribute('href', `/profile/${opponentHandle}`);
        link.setAttribute('data-route', 'profile');
        link.dataset.seekId = seek.id;
        link.textContent = opponentHandle;
        applyAutoDirection(link);
        opponentEl.appendChild(link);
      } else {
        opponentEl.textContent = shortId(seek.creatorId);
      }
      const rating = doc.createElement('span');
      rating.className = 'seek-rating';
      // Present the pool label and value atomically, rather than announcing the value twice.
      rating.setAttribute('role', 'img');
      const ratingText = seek.creatorRating == null
        ? i18n.t('lobby.creatorUnrated') : String(Math.round(seek.creatorRating));
      rating.textContent = ratingText;
      if (seek.creatorRating != null) applyLtrIsolation(rating);
      rating.setAttribute('aria-label', i18n.t('lobby.creatorRatingAria', {
        variant: getVariantLabel(seek.variant, i18n),
        speed: getSpeedLabel(seek.speed, i18n), rating: ratingText,
      }));
      opponentEl.append(' · ', rating);
      main.appendChild(opponentEl);

      const detailParts: string[] = [];
      if (seek.color === 'white') {
        detailParts.push(i18n.t('lobby.playsWhite'));
      } else if (seek.color === 'black') {
        detailParts.push(i18n.t('lobby.playsBlack'));
      }

      if (seek.minRating !== null && seek.maxRating !== null) {
        detailParts.push(`${seek.minRating}–${seek.maxRating}`);
      } else if (seek.minRating !== null) {
        detailParts.push(`≥ ${seek.minRating}`);
      } else if (seek.maxRating !== null) {
        detailParts.push(`≤ ${seek.maxRating}`);
      }

      if (detailParts.length > 0) {
        const detailsEl = doc.createElement('span');
        detailsEl.className = 'seek-details';
        detailsEl.textContent = detailParts.join(' · ');
        main.appendChild(detailsEl);
      }

      row.appendChild(main);

      const acceptBtn = doc.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.className = 'seek-accept button primary';
      acceptBtn.textContent = i18n.t('lobby.play');
      acceptBtn.dataset.seekId = seek.id;
      const acceptAria = opponentHandle
        ? i18n.t('lobby.acceptSeekWith', { handle: opponentHandle })
        : i18n.t('lobby.acceptSeek');
      acceptBtn.setAttribute('aria-label', acceptAria);
      row.appendChild(acceptBtn);
    }

    container.appendChild(row);
  }

  if (focusedControl) {
    const replacement = [...container.querySelectorAll<HTMLElement>(`.${focusedControl.className}`)]
      .find((candidate) => candidate.dataset.seekId === focusedControl.seekId);
    if (replacement) {
      replacement.focus();
      return;
    }

    const replacementRows = [...container.querySelectorAll<HTMLElement>('.seek-row')];
    if (replacementRows.length > 0) {
      const fallbackRow = replacementRows[Math.min(focusedControl.rowIndex, replacementRows.length - 1)];
      const fallbackControl = fallbackRow?.querySelector<HTMLElement>('.seek-accept')
        ?? fallbackRow?.querySelector<HTMLElement>('.seek-cancel')
        ?? fallbackRow?.querySelector<HTMLElement>('.row-link');
      fallbackControl?.focus();
      return;
    }
    onFocusRecovery?.();
  }
}

/** Dependencies required to mount the lobby view. */
export interface LobbyMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly isAuthenticated: () => boolean;
  readonly storage?: KeyValueStorage;
  readonly i18n: I18nManager;
}

/** The result of mounting the lobby view. */
export interface MountedLobby {
  readonly lobby: LobbyController;
  readonly setCreateGameAuthenticated: (authenticated: boolean) => void;
  readonly setPlayBotAuthenticated: (authenticated: boolean) => void;
  readonly onSessionChange: () => void;
}

/**
 * Mount the lobby view against the given DOM document.
 *
 * Wires the seek list, the create-game panel, the play-bot dialog,
 * and delegated click handlers for seek cancellation and acceptance.
 */
export function mountLobby(deps: LobbyMountDependencies): MountedLobby {
  const { doc, client, isAuthenticated, storage, i18n } = deps;
  const preferenceStorage = storage ?? resolveBrowserStorage();
  const seekListEl = doc.getElementById('seek-list');
  const filterHostEl = doc.getElementById('seek-filter');
  const createGameEl = doc.getElementById('create-game');
  const playBotMountEl = doc.getElementById('play-bot-mount');
  const errorEl = doc.getElementById('lobby-error');

  if (seekListEl) {
    seekListEl.replaceChildren();
    seekListEl.removeAttribute('role');
    seekListEl.removeAttribute('tabindex');
  }

  let panel: CreateGamePanel | null = null;
  let playBotDialog: PlayBotDialog | null = null;
  let routeActive = true;
  let hasReceivedSeeks = false;
  let selectedVariant: string = 'all';
  let renderedSeeks: readonly SeekView[] = [];
  let renderedNames: ReadonlyMap<string, SocialPlayer> | undefined;

  let filterSelectEl: HTMLSelectElement | null = null;
  let filterResetBtn: HTMLButtonElement | null = null;
  let filterLabelEl: HTMLLabelElement | null = null;
  let filterHelpEl: HTMLElement | null = null;
  let filterStatusEl: HTMLElement | null = null;
  let filterAnnouncerEl: HTMLElement | null = null;
  let lastStatusText = '';
  let lastAnnouncedText = '';

  const optionNodes: HTMLOptionElement[] = [];

  function isKnownOfferedVariant(val: string): val is Variant {
    for (const v of OFFERED_VARIANTS) {
      if (v === val) return true;
    }
    return false;
  }

  function relocalizeFilter(): void {
    if (filterLabelEl) filterLabelEl.textContent = i18n.t('lobby.filterLabel');
    if (filterResetBtn) filterResetBtn.textContent = i18n.t('lobby.filterReset');
    if (filterHelpEl) filterHelpEl.textContent = i18n.t('lobby.filterHelp');

    const allOpt = optionNodes[0];
    if (allOpt) allOpt.textContent = i18n.t('lobby.filterAll');
    for (let i = 0; i < OFFERED_VARIANTS.length; i++) {
      const v = OFFERED_VARIANTS[i]!;
      const opt = optionNodes[i + 1];
      if (opt) opt.textContent = getVariantLabel(v, i18n);
    }
  }

  function updateStatus(totalOpponents: number, matchingOpponentsCount: number, hiddenCount: number): void {
    if (!filterStatusEl) return;
    let nextStatus = '';
    if (totalOpponents === 0) {
      nextStatus = i18n.t('lobby.filterStatusNone');
    } else if (selectedVariant !== 'all' && matchingOpponentsCount === 0 && hiddenCount > 0) {
      nextStatus = i18n.t('lobby.filterEmpty');
    } else if (selectedVariant !== 'all' && hiddenCount > 0) {
      nextStatus = i18n.t('lobby.filterStatus', {
        shown: String(matchingOpponentsCount),
        total: String(totalOpponents),
      });
    } else {
      nextStatus = i18n.t('lobby.filterStatusAll', {
        total: String(totalOpponents),
      });
    }

    if (nextStatus !== lastStatusText) {
      filterStatusEl.textContent = nextStatus;
      lastStatusText = nextStatus;
    }
  }

  function renderCurrentSeeks(): void {
    if (!routeActive || !seekListEl || !hasReceivedSeeks) return;
    const currentUserId = client.session.current?.user.id ?? null;
    renderSeeksInternal({
      container: seekListEl,
      seeks: renderedSeeks,
      currentUserId,
      names: renderedNames,
      i18n,
      filterVariant: selectedVariant,
      onFocusRecovery: () => {
        if (filterSelectEl) filterSelectEl.focus();
      },
    });
    const isOwn = (s: SeekView): boolean => currentUserId !== null && s.creatorId === currentUserId;
    const opponentSeeks = renderedSeeks.filter((s) => !isOwn(s));
    const matchingOpponents = selectedVariant === 'all'
      ? opponentSeeks
      : opponentSeeks.filter((s) => s.variant === selectedVariant);
    const hiddenCount = opponentSeeks.length - matchingOpponents.length;
    updateStatus(opponentSeeks.length, matchingOpponents.length, hiddenCount);

    if (renderedSeeks.length === 0 && lastAnnouncedText !== '') {
      if (filterAnnouncerEl) filterAnnouncerEl.textContent = '';
      lastAnnouncedText = '';
    }
  }

  function announceFilterResult(): void {
    if (!routeActive || !hasReceivedSeeks || !filterAnnouncerEl || renderedSeeks.length === 0) {
      return;
    }
    if (lastStatusText !== lastAnnouncedText) {
      filterAnnouncerEl.textContent = lastStatusText;
      lastAnnouncedText = lastStatusText;
    }
  }

  function handleFilterChange(): void {
    if (!routeActive || !filterSelectEl) return;
    const val = filterSelectEl.value;
    if (val !== 'all' && !isKnownOfferedVariant(val)) {
      filterSelectEl.value = selectedVariant;
      return;
    }
    if (val === selectedVariant) {
      return;
    }
    selectedVariant = val;
    if (filterResetBtn) {
      filterResetBtn.hidden = selectedVariant === 'all';
    }
    renderCurrentSeeks();
    announceFilterResult();
  }

  function handleFilterReset(): void {
    if (!routeActive || selectedVariant === 'all') return;
    selectedVariant = 'all';
    if (filterSelectEl) {
      filterSelectEl.value = 'all';
    }
    if (filterResetBtn) {
      filterResetBtn.hidden = true;
    }
    renderCurrentSeeks();
    announceFilterResult();
    if (filterSelectEl) {
      filterSelectEl.focus();
    }
  }

  function handleSeekAction(event: Event): void {
    if (!routeActive) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.seekId) return;
    const id = target.dataset.seekId;
    if (target.classList.contains('seek-cancel')) {
      void lobby.cancelSeek(id);
    } else if (target.classList.contains('seek-accept')) {
      void lobby.acceptSeek(id);
    }
  }

  const unsubscribeLocale = i18n.onLocaleChange(() => {
    if (routeActive) {
      relocalizeFilter();
      renderCurrentSeeks();
      announceFilterResult();
    }
  });

  if (filterHostEl) {
    filterHostEl.replaceChildren();

    filterLabelEl = doc.createElement('label');
    filterLabelEl.className = 'seek-filter-label';
    filterLabelEl.htmlFor = 'lobby-variant-filter';
    filterLabelEl.textContent = i18n.t('lobby.filterLabel');

    filterSelectEl = doc.createElement('select');
    filterSelectEl.id = 'lobby-variant-filter';
    filterSelectEl.className = 'seek-filter-select';
    filterSelectEl.setAttribute('aria-describedby', 'seek-filter-help');

    const allOpt = doc.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = i18n.t('lobby.filterAll');
    filterSelectEl.appendChild(allOpt);
    optionNodes.push(allOpt);

    for (const v of OFFERED_VARIANTS) {
      const opt = doc.createElement('option');
      opt.value = v;
      opt.textContent = getVariantLabel(v, i18n);
      filterSelectEl.appendChild(opt);
      optionNodes.push(opt);
    }
    filterSelectEl.value = 'all';

    filterResetBtn = doc.createElement('button');
    filterResetBtn.type = 'button';
    filterResetBtn.className = 'seek-filter-reset button';
    filterResetBtn.textContent = i18n.t('lobby.filterReset');
    filterResetBtn.hidden = true;

    filterHelpEl = doc.createElement('p');
    filterHelpEl.id = 'seek-filter-help';
    filterHelpEl.className = 'seek-filter-help';
    filterHelpEl.textContent = i18n.t('lobby.filterHelp');

    filterStatusEl = doc.createElement('div');
    filterStatusEl.className = 'seek-filter-status';

    filterAnnouncerEl = doc.createElement('div');
    filterAnnouncerEl.className = 'seek-filter-announcement sr-only';
    filterAnnouncerEl.setAttribute('role', 'status');
    filterAnnouncerEl.setAttribute('aria-live', 'polite');

    filterSelectEl.addEventListener('change', handleFilterChange);
    filterResetBtn.addEventListener('click', handleFilterReset);

    filterHostEl.append(filterLabelEl, filterSelectEl, filterResetBtn, filterHelpEl, filterStatusEl, filterAnnouncerEl);
  }

  const lobby = new LobbyController({
    client,
    callbacks: {
      onSeeks: (seeks, names) => {
        renderedSeeks = seeks;
        renderedNames = names;
        hasReceivedSeeks = true;
        renderCurrentSeeks();
      },
      onCreatePending: (pending) => {
        panel?.setPending(pending);
      },
      onError: (msg) => {
        if (errorEl) errorEl.textContent = msg;
      },
      onGameMatched: (gameId) => {
        window.location.href = `/game/${gameId}`;
      },
    },
    isAuthenticated,
    onDispose: () => {
      routeActive = false;
      seekListEl?.removeEventListener('click', handleSeekAction);
      filterSelectEl?.removeEventListener('change', handleFilterChange);
      filterResetBtn?.removeEventListener('click', handleFilterReset);
      if (filterSelectEl) filterSelectEl.disabled = true;
      if (filterResetBtn) filterResetBtn.disabled = true;
      filterHostEl?.replaceChildren();
      panel?.dispose();
      playBotDialog?.dispose();
      unsubscribeLocale?.();
    },
  });

  // Mount the create-a-game panel; it hands validated params to the lobby.
  if (createGameEl) {
    panel = new CreateGamePanel({
      doc,
      mount: createGameEl,
      initialAuthenticated: isAuthenticated(),
      i18n,
      ...(preferenceStorage ? { storage: preferenceStorage } : {}),
      callbacks: {
        onSubmit: async (params) => {
          const seek = await lobby.createSeek(params);
          return routeActive && seek !== null;
        },
        onError: (msg) => {
          if (routeActive && errorEl) errorEl.textContent = msg ?? '';
        },
      },
    });
  }

  // Mount the play-vs-computer dialog.
  // Variant is hardcoded to 'standard': the backend POST /v1/games/bot contract
  // accepts any variant code, but the Stockfish engine worker build only supports
  // standard chess rules (not Atomic, Crazyhouse, etc.). Offering other variants
  // would be a promise the backend engine worker cannot keep.
  if (playBotMountEl) {
    playBotDialog = new PlayBotDialog({
      doc,
      mount: playBotMountEl,
      initialAuthenticated: isAuthenticated(),
      i18n,
      callbacks: {
        onSubmit: async (params) => {
          const result = await lobby.createBotGame({
            ...params,
            variant: 'standard',
          });
          if (!routeActive) return null;
          if (!result.ok) {
            playBotDialog?.setError(result.message);
            return null;
          }
          window.location.href = `/game/${result.gameId}`;
          return result.gameId;
        },
      },
    });
  }

  // Wire cancel/accept buttons (event delegation on the seek list).
  if (seekListEl) {
    seekListEl.addEventListener('click', handleSeekAction);
  }

  lobby.start();

  /** Forward session state only while this lobby route still owns its create-game panel. */
  function setCreateGameAuthenticated(authenticated: boolean): void {
    if (routeActive) panel?.setAuthenticated(authenticated);
  }

  /** Forward session state only while this lobby route still owns its bot-game dialog. */
  function setPlayBotAuthenticated(authenticated: boolean): void {
    if (routeActive) playBotDialog?.setAuthenticated(authenticated);
  }

  /** Re-render cached seeks after auth restoration changes which rows belong to the viewer. */
  function onSessionChange(): void {
    if (routeActive) {
      renderCurrentSeeks();
    }
  }

  return {
    lobby,
    setCreateGameAuthenticated,
    setPlayBotAuthenticated,
    onSessionChange,
  };
}
