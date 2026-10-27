import { routeToPath } from './router.js';
import { browserClipboardWriter, type ClipboardWriter } from './game-pgn-export.js';
import type { I18n } from '../i18n/index.js';

export interface GameLinkShareOptions {
  readonly doc: Document;
  readonly gameId: string;
  readonly i18n: I18n;
  readonly writeClipboard?: ClipboardWriter | null;
}

export interface MountedGameLinkShare {
  relocalize(): void;
  dispose(): void;
}

type ShareState = 'idle' | 'copying' | 'copied' | 'error';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function canonicalGameLink(doc: Document, gameId: string): string | null {
  if (typeof gameId !== 'string' || !SAFE_ID_PATTERN.test(gameId)) return null;
  const href = doc.defaultView?.location?.href;
  if (typeof href !== 'string' || !href) return null;
  try {
    const url = new URL(href);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.origin || url.origin === 'null') {
      return null;
    }
    return `${url.origin}${routeToPath({ name: 'game', gameId })}`;
  } catch {
    return null;
  }
}

export function mountGameLinkShare(options: GameLinkShareOptions): MountedGameLinkShare {
  const { doc, gameId, i18n } = options;
  const copyButton = doc.getElementById('game-link-copy');
  const statusEl = doc.getElementById('game-link-status');
  const errorEl = doc.getElementById('game-link-error');
  const sharingEl = doc.getElementById('game-sharing');

  if (statusEl) { statusEl.textContent = ''; statusEl.hidden = false; }
  if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }

  const canonicalUrl = canonicalGameLink(doc, gameId);
  const writer =
    options.writeClipboard !== undefined
      ? options.writeClipboard
      : browserClipboardWriter(doc.defaultView?.navigator);

  if (!copyButton || !canonicalUrl || !writer) {
    if (copyButton) copyButton.hidden = true;
    if (sharingEl) sharingEl.hidden = true;
    return { relocalize: () => {}, dispose: () => {} };
  }

  copyButton.hidden = false;
  if (sharingEl) sharingEl.hidden = false;

  let state: ShareState = 'idle';
  let isPending = false;
  let disposed = false;

  const updateUI = () => {
    if (disposed) return;
    copyButton.setAttribute('aria-disabled', isPending ? 'true' : 'false');
    copyButton.textContent = i18n.t(
      state === 'copying' ? 'game.share.copying' : 'game.share.copyLink'
    );
    if (statusEl) {
      statusEl.textContent = state === 'copied' ? i18n.t('game.share.copied') : '';
    }
    if (errorEl) {
      errorEl.hidden = state !== 'error';
      errorEl.textContent = state === 'error' ? i18n.t('game.share.copyError') : '';
    }
  };

  const onClick = () => {
    if (disposed || isPending || copyButton.getAttribute('aria-disabled') === 'true') {
      return;
    }
    isPending = true;
    state = 'copying';
    updateUI();

    let writePromise: Promise<void>;
    try {
      writePromise = writer(Promise.resolve(canonicalUrl));
    } catch (err) {
      writePromise = Promise.reject(err);
    }

    writePromise
      .then(() => {
        if (disposed) return;
        isPending = false;
        state = 'copied';
        updateUI();
      })
      .catch(() => {
        if (disposed) return;
        isPending = false;
        state = 'error';
        updateUI();
      });
  };

  copyButton.addEventListener('click', onClick);
  updateUI();

  return {
    relocalize() {
      if (!disposed) updateUI();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      copyButton.removeEventListener('click', onClick);
    },
  };
}
