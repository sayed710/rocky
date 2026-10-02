/**
 * Finished-game PGN download (ADR-0154).
 *
 * The bytes saved are exactly the server's export of the durable event log. Nothing here writes PGN,
 * reads the board, or uses Game Review; nothing is kept in storage. The control exists only while
 * the authoritative game state is over.
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

export interface GamePgnExportOptions {
  readonly doc: Document;
  readonly gameId: string;
  readonly i18n: I18n;
  readonly requestPgn: (gameId: string, signal: AbortSignal) => Promise<string>;
  readonly save?: (file: PgnFile) => void;
}

export interface MountedGamePgnExport {
  /** Show the control only for an authoritatively finished game. */
  setFinished(over: boolean): void;
  /** Re-translate the current status or error after a locale change. */
  relocalize(): void;
  /** Abandon any in-flight request; nothing it returns reaches the page. */
  dispose(): void;
}

type StatusKey = 'game.export.preparing' | 'game.export.started';
const ERROR_KEY = 'game.export.unavailableError';

/** Mount the Download PGN control on the game route. */
export function mountGamePgnExport(options: GamePgnExportOptions): MountedGamePgnExport {
  const { doc, gameId, i18n, requestPgn } = options;
  const save = options.save ?? ((file: PgnFile) => saveFile(doc, file));
  const section = doc.getElementById('game-export');
  const button = doc.getElementById('game-pgn-download');
  const statusEl = doc.getElementById('game-pgn-status');
  const errorEl = doc.getElementById('game-pgn-error');

  let finished = false;
  let disposed = false;
  let inFlight: AbortController | null = null;
  let statusKey: StatusKey | null = null;
  let failed = false;

  const render = (): void => {
    if (section) section.hidden = !finished;
    // `aria-disabled` rather than `disabled`: a disabled button drops keyboard focus mid-request.
    button?.setAttribute('aria-disabled', String(inFlight !== null));
    section?.setAttribute('aria-busy', String(inFlight !== null));
    if (statusEl) statusEl.textContent = statusKey ? i18n.t(statusKey) : '';
    if (errorEl) {
      errorEl.hidden = !failed;
      errorEl.textContent = failed ? i18n.t(ERROR_KEY) : '';
    }
  };

  const download = async (): Promise<void> => {
    if (disposed || !finished || inFlight !== null) return;
    const controller = new AbortController();
    inFlight = controller;
    failed = false;
    statusKey = 'game.export.preparing';
    render();
    try {
      const text = await requestPgn(gameId, controller.signal);
      if (inFlight !== controller) return;
      save({ filename: pgnFilename(gameId), text });
      statusKey = 'game.export.started';
    } catch {
      if (inFlight !== controller) return;
      statusKey = null;
      failed = true;
    }
    inFlight = null;
    render();
  };

  const onClick = (): void => { void download(); };
  button?.addEventListener('click', onClick);
  render();

  return {
    setFinished(over: boolean): void {
      if (disposed || finished === over) return;
      finished = over;
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
      button?.removeEventListener('click', onClick);
    },
  };
}
