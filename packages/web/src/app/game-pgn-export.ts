/**
 * Finished-game PGN download and copy (ADR-0154).
 *
 * The bytes saved or copied are exactly the server's export of the durable event log. Nothing here
 * writes PGN, reads the board, or uses Game Review; nothing is kept in storage. The controls exist
 * only while the authoritative game state is over.
 */
import type { I18n } from '../i18n/index.js';
import { PGN_MEDIA_TYPE } from '../api/client.js';

/** A file to hand to the browser. */
export interface PgnFile {
  readonly filename: string;
  readonly text: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The saved file's name, built only from a validated game id (the server's own filename rule), so
 * no handle and no route text can reach it.
 */
export function pgnFilename(gameId: string): string {
  return UUID.test(gameId) ? `game-${gameId}.pgn` : 'game.pgn';
}

/**
 * How long a download's object URL outlives the click. Revoking it in the same task can cancel the
 * download in some browsers; the timer still always revokes it, so no URL outlives the route by more.
 */
export const OBJECT_URL_REVOKE_MS = 30_000;

/** The browser seams {@link saveFile} uses, injectable so tests need no real Blob URLs or timers. */
export interface DownloadEnvironment {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly schedule: (callback: () => void, ms: number) => void;
}

const BROWSER_DOWNLOADS: DownloadEnvironment = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  schedule: (callback, ms) => { setTimeout(callback, ms); },
};

/**
 * Save `file` through a detached `download` link: no navigation, so the SPA session survives, and the
 * Blob holds the received text unchanged. The router already leaves `download` links alone.
 */
export function saveFile(doc: Document, file: PgnFile, env: DownloadEnvironment = BROWSER_DOWNLOADS): void {
  const url = env.createObjectURL(new Blob([file.text], { type: PGN_MEDIA_TYPE }));
  try {
    const link = doc.createElement('a');
    link.href = url;
    link.download = file.filename;
    link.hidden = true;
    doc.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    env.schedule(() => env.revokeObjectURL(url), OBJECT_URL_REVOKE_MS);
  }
}

/**
 * Puts the text a promise settles to on the clipboard. It is called synchronously inside the click,
 * before the request resolves: Safari drops the user activation a later clipboard call would need.
 * A rejected promise must leave the clipboard untouched.
 */
export type ClipboardWriter = (text: Promise<string>) => Promise<void>;

/**
 * The browser's clipboard writer, or null where there is none (an insecure context, or no Clipboard
 * API), in which case Copy PGN is not offered at all.
 */
export function browserClipboardWriter(nav: Navigator | undefined): ClipboardWriter | null {
  const clipboard = nav?.clipboard;
  if (!clipboard) return null;
  const writeText = typeof clipboard.writeText === 'function'
    ? async (text: Promise<string>) => clipboard.writeText(await text)
    : null;
  if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
    return (text) => {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      // The browser may reject the write before the text settles; a later rejection is not unhandled.
      blob.catch(() => {});
      let item: ClipboardItem;
      try {
        item = new ClipboardItem({ 'text/plain': blob });
      } catch (error) {
        // Older engines accept only a ready Blob, not a promised one.
        if (writeText) return writeText(text);
        throw error;
      }
      return clipboard.write([item]);
    };
  }
  return writeText;
}

export interface GamePgnExportOptions {
  readonly doc: Document;
  readonly gameId: string;
  readonly i18n: I18n;
  readonly requestPgn: (gameId: string, signal: AbortSignal) => Promise<string>;
  readonly save?: (file: PgnFile) => void;
  /** Defaults to the document's browser clipboard; null hides Copy PGN. */
  readonly writeClipboard?: ClipboardWriter | null;
}

export interface MountedGamePgnExport {
  /** Show the controls only for an authoritatively finished game. */
  setFinished(over: boolean): void;
  /** Re-translate the current status or error after a locale change. */
  relocalize(): void;
  /** Abandon any in-flight request; nothing it returns reaches the page. */
  dispose(): void;
}

type Action = 'download' | 'copy';
type StatusKey = 'game.export.preparing' | 'game.export.started' | 'game.export.copying' | 'game.export.copied';
const PENDING_KEY: Record<Action, StatusKey> = { download: 'game.export.preparing', copy: 'game.export.copying' };
const DONE_KEY: Record<Action, StatusKey> = { download: 'game.export.started', copy: 'game.export.copied' };
const ERROR_KEY = { download: 'game.export.unavailableError', copy: 'game.export.copyError' } as const;

/** Mount the Download PGN and Copy PGN controls on the game route. */
export function mountGamePgnExport(options: GamePgnExportOptions): MountedGamePgnExport {
  const { doc, gameId, i18n, requestPgn } = options;
  const save = options.save ?? ((file: PgnFile) => saveFile(doc, file));
  const writeClipboard = options.writeClipboard === undefined
    ? browserClipboardWriter(doc.defaultView?.navigator)
    : options.writeClipboard;
  const section = doc.getElementById('game-export');
  const button = doc.getElementById('game-pgn-download');
  const copyButton = doc.getElementById('game-pgn-copy');
  const statusEl = doc.getElementById('game-pgn-status');
  const errorEl = doc.getElementById('game-pgn-error');

  let finished = false;
  let disposed = false;
  let inFlight: AbortController | null = null;
  let statusKey: StatusKey | null = null;
  let failed: Action | null = null;

  const render = (): void => {
    if (section) section.hidden = !finished;
    if (copyButton) copyButton.hidden = writeClipboard === null;
    // `aria-disabled` rather than `disabled`: a disabled button drops keyboard focus mid-request.
    // Both controls share one request at a time.
    button?.setAttribute('aria-disabled', String(inFlight !== null));
    copyButton?.setAttribute('aria-disabled', String(inFlight !== null));
    section?.setAttribute('aria-busy', String(inFlight !== null));
    if (statusEl) statusEl.textContent = statusKey ? i18n.t(statusKey) : '';
    if (errorEl) {
      errorEl.hidden = failed === null;
      errorEl.textContent = failed ? i18n.t(ERROR_KEY[failed]) : '';
    }
  };

  const run = async (action: Action): Promise<void> => {
    if (disposed || !finished || inFlight !== null) return;
    if (action === 'copy' && writeClipboard === null) return;
    const controller = new AbortController();
    inFlight = controller;
    failed = null;
    statusKey = PENDING_KEY[action];
    render();
    // A superseded request's text never reaches the clipboard or a file: the promise rejects instead.
    // The executor turns a synchronous throw into a rejection, so the controls are always released.
    const text = new Promise<string>((resolve) => resolve(requestPgn(gameId, controller.signal))).then((value) => {
      if (inFlight !== controller) throw new Error('stale PGN response');
      return value;
    });
    text.catch(() => {});
    try {
      if (action === 'copy') await writeClipboard!(text);
      else save({ filename: pgnFilename(gameId), text: await text });
      if (inFlight !== controller) return;
      statusKey = DONE_KEY[action];
    } catch {
      if (inFlight !== controller) return;
      // A clipboard refusal can arrive before the response: do not leave that request running.
      controller.abort();
      statusKey = null;
      failed = action;
    }
    inFlight = null;
    render();
  };

  const onDownload = (): void => { void run('download'); };
  const onCopy = (): void => { void run('copy'); };
  button?.addEventListener('click', onDownload);
  copyButton?.addEventListener('click', onCopy);
  render();

  return {
    setFinished(over: boolean): void {
      if (disposed || finished === over) return;
      finished = over;
      if (!over) {
        // No longer authoritatively over: a pending request must not copy or save anything.
        inFlight?.abort();
        inFlight = null;
        statusKey = null;
        failed = null;
      }
      render();
    },
    relocalize(): void {
      if (!disposed) render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      button?.removeEventListener('click', onDownload);
      copyButton?.removeEventListener('click', onCopy);
    },
  };
}
