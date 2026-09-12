import type { GambitClient } from '../api/client.js';
import type { SeekView, SocialPlayer } from '../api/models.js';
import { shortId } from '../api/graphql.js';
import type { KeyValueStorage } from '../net/session.js';
import { CreateGamePanel } from './create-game-panel.js';
import { LobbyController } from './lobby-controller.js';
import { PlayBotDialog } from './play-bot-dialog.js';
import { formatTimeControl, renderEmpty } from './render-helpers.js';

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
 */
export function renderSeeks(
  container: HTMLElement,
  seeks: readonly SeekView[],
  currentUserId: string | null,
  names?: ReadonlyMap<string, SocialPlayer>,
): void {
  container.innerHTML = '';
  if (seeks.length === 0) {
    renderEmpty(container, {
      mark: '♟',
      title: 'No open seeks right now',
      body: 'Create a game above — the first player to accept joins you.',
    });
    return;
  }
  const doc = container.ownerDocument ?? document;
  for (const seek of seeks) {
    const owned = currentUserId !== null && seek.creatorId === currentUserId;
    const row = doc.createElement('div');
    row.className = owned ? 'seek-row seek-row-own' : 'seek-row';
    row.dataset.seekId = seek.id;

    const info = doc.createElement('span');
    info.className = 'seek-info';
    const tc = formatTimeControl(seek.timeControl);
    info.textContent = `${seek.variant} · ${seek.speed} · ${tc}${seek.rated ? ' · rated' : ''}`;

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
      waiting.append(dot, 'Waiting for an opponent…');
      main.appendChild(waiting);
      row.appendChild(main);

      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'seek-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.dataset.seekId = seek.id;
      cancelBtn.setAttribute('aria-label', 'Cancel your seek');
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
        link.textContent = opponentHandle;
        opponentEl.appendChild(link);
      } else {
        opponentEl.textContent = shortId(seek.creatorId);
      }
      main.appendChild(opponentEl);

      const detailParts: string[] = [];
      if (seek.color === 'white') {
        detailParts.push('plays White');
      } else if (seek.color === 'black') {
        detailParts.push('plays Black');
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
      acceptBtn.textContent = 'Play';
      acceptBtn.dataset.seekId = seek.id;
      acceptBtn.setAttribute(
        'aria-label',
        opponentHandle ? `Accept seek from ${opponentHandle}` : 'Accept seek',
      );
      row.appendChild(acceptBtn);
    }

    container.appendChild(row);
  }
}

/** Dependencies required to mount the lobby view. */
interface LobbyMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly isAuthenticated: () => boolean;
  readonly storage?: KeyValueStorage;
}

/** The result of mounting the lobby view. */
interface MountedLobby {
  readonly lobby: LobbyController;
  readonly setCreateGameAuthenticated: (authenticated: boolean) => void;
  readonly setPlayBotAuthenticated: (authenticated: boolean) => void;
}

/**
 * Mount the lobby view against the given DOM document.
 *
 * Wires the seek list, the create-game panel, the play-bot dialog,
 * and delegated click handlers for seek cancellation and acceptance.
 */
export function mountLobby(deps: LobbyMountDependencies): MountedLobby {
  const { doc, client, isAuthenticated, storage } = deps;
  const seekListEl = doc.getElementById('seek-list');
  const createGameEl = doc.getElementById('create-game');
  const playBotMountEl = doc.getElementById('play-bot-mount');
  const errorEl = doc.getElementById('lobby-error');

  let panel: CreateGamePanel | null = null;
  let playBotDialog: PlayBotDialog | null = null;
  let routeActive = true;

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

  const lobby = new LobbyController({
    client,
    callbacks: {
      onSeeks: (seeks, names) => {
        if (seekListEl) renderSeeks(seekListEl, seeks, client.session.current?.user.id ?? null, names);
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
    },
  });

  // Mount the create-a-game panel; it hands validated params to the lobby.
  if (createGameEl) {
    panel = new CreateGamePanel({
      doc,
      mount: createGameEl,
      initialAuthenticated: isAuthenticated(),
      ...(storage !== undefined
        ? { storage }
        : typeof localStorage !== 'undefined'
          ? { storage: localStorage }
          : {}),
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

  return {
    lobby,
    setCreateGameAuthenticated,
    setPlayBotAuthenticated,
  };
}
