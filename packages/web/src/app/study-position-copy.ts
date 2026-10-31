import type { I18n } from '../i18n/index.js';
import { browserClipboardWriter, type ClipboardWriter } from './game-pgn-export.js';

export interface StudyPositionCopyOptions {
  readonly doc: Document;
  readonly i18n: I18n;
  readonly writeClipboard?: ClipboardWriter | null | undefined;
}

export interface MountedStudyPositionCopy {
  setPosition(fen: string | null): void;
  relocalize(): void;
  dispose(): void;
}

type CopyState = 'idle' | 'copying' | 'copied' | 'error';
type ReadyTextWriter = (fen: string) => Promise<void>;

function resolveReadyTextWriter(options: StudyPositionCopyOptions): ReadyTextWriter | null {
  if (options.writeClipboard !== undefined) {
    const injected = options.writeClipboard;
    if (!injected) return null;
    return (fen: string) => injected(Promise.resolve(fen));
  }

  const navigator = options.doc.defaultView?.navigator;
  const clipboard = navigator?.clipboard;

  if (typeof clipboard?.writeText === 'function') {
    return (fen: string) => clipboard.writeText(fen);
  }

  const fallback = browserClipboardWriter(navigator);
  if (fallback) {
    return (fen: string) => fallback(Promise.resolve(fen));
  }

  return null;
}

export function mountStudyPositionCopy(options: StudyPositionCopyOptions): MountedStudyPositionCopy {
  const { doc, i18n } = options;
  const copyButton = doc.getElementById('study-position-copy');
  const statusEl = doc.getElementById('study-position-status');
  const errorEl = doc.getElementById('study-position-error');

  const writer = resolveReadyTextWriter(options);

  if (!copyButton || !writer) {
    if (copyButton) copyButton.hidden = true;
    if (statusEl) statusEl.textContent = '';
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
    return {
      setPosition: () => {},
      relocalize: () => {},
      dispose: () => {},
    };
  }

  let currentFen: string | null = null;
  let revision = 0;
  let state: CopyState = 'idle';
  let isPending = false;
  let disposed = false;

  const updateUI = (): void => {
    if (disposed) return;
    if (!currentFen) {
      copyButton.hidden = true;
      if (statusEl) statusEl.textContent = '';
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
      return;
    }

    copyButton.hidden = false;
    copyButton.setAttribute('aria-disabled', isPending ? 'true' : 'false');
    copyButton.textContent = i18n.t(
      state === 'copying' ? 'learning.studies.copyingFen' : 'learning.studies.copyFen',
    );
    if (statusEl) {
      statusEl.textContent = state === 'copied' ? i18n.t('learning.studies.copiedFen') : '';
    }
    if (errorEl) {
      errorEl.hidden = state !== 'error';
      errorEl.textContent = state === 'error' ? i18n.t('learning.studies.copyFenError') : '';
    }
  };

  const onClick = (): void => {
    if (disposed || isPending || !currentFen || copyButton.getAttribute('aria-disabled') === 'true') {
      return;
    }
    const snapshotRevision = revision;
    const targetFen = currentFen;
    isPending = true;
    state = 'copying';
    updateUI();

    let writePromise: Promise<void>;
    try {
      writePromise = writer(targetFen);
    } catch (err) {
      writePromise = Promise.reject(err);
    }

    writePromise
      .then(() => {
        if (disposed) return;
        isPending = false;
        state = snapshotRevision === revision && currentFen ? 'copied' : 'idle';
        updateUI();
      })
      .catch(() => {
        if (disposed) return;
        isPending = false;
        state = snapshotRevision === revision && currentFen ? 'error' : 'idle';
        updateUI();
      });
  };

  copyButton.addEventListener('click', onClick);
  updateUI();

  return {
    setPosition(fen: string | null): void {
      if (disposed) return;
      revision++;
      currentFen = fen;
      if (state === 'copied' || state === 'error') {
        state = 'idle';
      }
      updateUI();
    },
    relocalize(): void {
      if (!disposed) {
        updateUI();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revision++;
      copyButton.removeEventListener('click', onClick);
      copyButton.hidden = true;
      if (statusEl) statusEl.textContent = '';
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    },
  };
}
