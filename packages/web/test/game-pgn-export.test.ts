import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_URL_REVOKE_MS,
  mountGamePgnExport,
  pgnFilename,
  saveFile,
  type DownloadEnvironment,
  type PgnFile,
} from '../src/app/game-pgn-export.js';
import { createGameDocument, type FakeElement } from './support/analysis-fixtures.js';
import { createTestI18n } from './support/localization-dom.js';

const GAME_ID = '00000000-0000-4000-8000-0000000000a1';
const PGN = '[Event "?"]\n[White "Ünïcødé"]\n[Black "b\\"q"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n';

// --- Filename -------------------------------------------------------------------------------------

test('the filename is built only from a validated game id', () => {
  assert.equal(pgnFilename(GAME_ID), `game-${GAME_ID}.pgn`);
  for (const hostile of ['../../etc/passwd', 'g"; filename="evil.exe', 'a\r\nX-Evil: 1', 'alice', '']) {
    assert.equal(pgnFilename(hostile), 'game.pgn', hostile);
  }
});

// --- Saving -------------------------------------------------------------------------------------

interface FakeLink {
  href: string;
  download: string;
  hidden: boolean;
  clicks: number;
  removed: boolean;
  click(): void;
  remove(): void;
}

function downloadDoc(onClick: (link: FakeLink) => void = () => {}) {
  const appended: FakeLink[] = [];
  const doc = {
    createElement: (tag: string) => {
      assert.equal(tag, 'a');
      const link: FakeLink = {
        href: '', download: '', hidden: false, clicks: 0, removed: false,
        click() { this.clicks += 1; onClick(this); },
        remove() { this.removed = true; },
      };
      return link;
    },
    body: { append: (link: FakeLink) => { appended.push(link); } },
  } as unknown as Document;
  return { doc, appended };
}

function recordingEnv() {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const scheduled: { ms: number; run: () => void }[] = [];
  const env: DownloadEnvironment = {
    createObjectURL: (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; },
    revokeObjectURL: (url) => { revoked.push(url); },
    schedule: (run, ms) => { scheduled.push({ ms, run }); },
  };
  return { env, blobs, revoked, scheduled };
}

test('saving writes the received text byte for byte through a detached download link', async () => {
  const { doc, appended } = downloadDoc();
  const { env, blobs, revoked, scheduled } = recordingEnv();

  saveFile(doc, { filename: `game-${GAME_ID}.pgn`, text: PGN }, env);

  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.type, 'application/x-chess-pgn');
  assert.deepEqual(new Uint8Array(await blobs[0]!.arrayBuffer()), new TextEncoder().encode(PGN));
  assert.equal(appended.length, 1);
  const link = appended[0]!;
  assert.equal(link.href, 'blob:test/1');
  assert.equal(link.download, `game-${GAME_ID}.pgn`);
  assert.equal(link.hidden, true);
  assert.equal(link.clicks, 1);
  assert.equal(link.removed, true, 'the link does not stay in the page');

  assert.deepEqual(scheduled.map((entry) => entry.ms), [OBJECT_URL_REVOKE_MS]);
  assert.deepEqual(revoked, []);
  scheduled[0]!.run();
  assert.deepEqual(revoked, ['blob:test/1'], 'every object URL is revoked');
});

test('the object URL is revoked and the link removed even when the click throws', () => {
  const { doc, appended } = downloadDoc(() => { throw new Error('blocked'); });
  const { env, revoked, scheduled } = recordingEnv();

  assert.throws(() => saveFile(doc, { filename: 'game.pgn', text: PGN }, env), /blocked/);
  assert.equal(appended[0]!.removed, true);
  scheduled.forEach((entry) => entry.run());
  assert.deepEqual(revoked, ['blob:test/1']);
});

// --- The control ---------------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function setup(locale: 'en' | 'ar' = 'en') {
  const { doc, elements } = createGameDocument();
  const i18n = createTestI18n();
  if (locale === 'ar') i18n.setLocale('ar');
  const requests: { gameId: string; signal: AbortSignal; reply: ReturnType<typeof deferred<string>> }[] = [];
  const saved: PgnFile[] = [];
  const mounted = mountGamePgnExport({
    doc,
    gameId: GAME_ID,
    i18n,
    requestPgn: (gameId, signal) => {
      const reply = deferred<string>();
      requests.push({ gameId, signal, reply });
      return reply.promise;
    },
    save: (file) => { saved.push(file); },
  });
  const el = (id: string): FakeElement => elements.get(id)!;
  return { mounted, requests, saved, el, i18n };
}

test('the control is absent during a live game and offered once the game is over', () => {
  const { mounted, requests, el } = setup();
  assert.equal(el('game-export').hidden, true, 'no dead PGN control beside a live board');
  el('game-pgn-download').click();
  assert.equal(requests.length, 0, 'a live game is never requested');

  mounted.setFinished(true);
  assert.equal(el('game-export').hidden, false);
  assert.equal(el('game-pgn-download').getAttribute('aria-disabled'), 'false');
});

test('activating the control saves exactly the server text under the id filename', async () => {
  const { mounted, requests, saved, el } = setup();
  mounted.setFinished(true);

  el('game-pgn-download').click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.gameId, GAME_ID);
  assert.equal(el('game-pgn-download').getAttribute('aria-disabled'), 'true');
  assert.equal(el('game-export').getAttribute('aria-busy'), 'true');
  assert.equal(el('game-pgn-status').textContent, 'Preparing the PGN file…');

  requests[0]!.reply.resolve(PGN);
  await settle();

  assert.deepEqual(saved, [{ filename: `game-${GAME_ID}.pgn`, text: PGN }]);
  assert.equal(el('game-pgn-status').textContent, 'PGN download started.');
  assert.equal(el('game-pgn-download').getAttribute('aria-disabled'), 'false');
  assert.equal(el('game-export').getAttribute('aria-busy'), 'false');
  assert.equal(el('game-pgn-error').hidden, true);
});

test('a second activation while a request is pending starts nothing', async () => {
  const { mounted, requests, saved, el } = setup();
  mounted.setFinished(true);
  el('game-pgn-download').click();
  el('game-pgn-download').click();
  el('game-pgn-download').click();
  assert.equal(requests.length, 1);
  requests[0]!.reply.resolve(PGN);
  await settle();
  assert.equal(saved.length, 1);

  el('game-pgn-download').click();
  assert.equal(requests.length, 2, 'a settled request frees the control');
});

test('a failed request shows a localized alert, saves nothing, and a retry clears it', async () => {
  const { mounted, requests, saved, el } = setup();
  mounted.setFinished(true);
  el('game-pgn-download').click();
  requests[0]!.reply.reject(new Error('503'));
  await settle();

  assert.equal(saved.length, 0);
  assert.equal(el('game-pgn-error').hidden, false);
  assert.equal(el('game-pgn-error').textContent, 'The PGN file could not be downloaded. Please try again.');
  assert.equal(el('game-pgn-status').textContent, '');
  assert.equal(el('game-pgn-download').getAttribute('aria-disabled'), 'false');

  el('game-pgn-download').click();
  assert.equal(el('game-pgn-error').hidden, true, 'a new attempt clears the previous failure');
  requests[1]!.reply.resolve(PGN);
  await settle();
  assert.equal(saved.length, 1);
});

test('a save that throws is reported as a failure, not as a started download', async () => {
  const { doc } = createGameDocument();
  const i18n = createTestI18n();
  const mounted = mountGamePgnExport({
    doc, gameId: GAME_ID, i18n,
    requestPgn: async () => PGN,
    save: () => { throw new Error('downloads blocked'); },
  });
  mounted.setFinished(true);
  (doc.getElementById('game-pgn-download') as unknown as FakeElement).click();
  await settle();
  assert.equal((doc.getElementById('game-pgn-error') as unknown as FakeElement).hidden, false);
  assert.equal((doc.getElementById('game-pgn-status') as unknown as FakeElement).textContent, '');
});

test('a response arriving after route disposal is dropped and its request aborted', async () => {
  const { mounted, requests, saved, el } = setup();
  mounted.setFinished(true);
  el('game-pgn-download').click();
  const statusBefore = el('game-pgn-status').textContent;

  mounted.dispose();
  assert.equal(requests[0]!.signal.aborted, true);
  requests[0]!.reply.resolve(PGN);
  await settle();

  assert.equal(saved.length, 0, 'nothing is saved for a route that no longer exists');
  assert.equal(el('game-pgn-status').textContent, statusBefore, 'no stale render');
  assert.equal(el('game-pgn-error').hidden, true);

  el('game-pgn-download').click();
  assert.equal(requests.length, 1, 'the disposed control no longer listens');
});

test('a failure arriving after disposal shows nothing', async () => {
  const { mounted, requests, el } = setup();
  mounted.setFinished(true);
  el('game-pgn-download').click();
  mounted.dispose();
  requests[0]!.reply.reject(new Error('aborted'));
  await settle();
  assert.equal(el('game-pgn-error').hidden, true);
});

test('a new mount for another game starts hidden and clean on the shared route DOM', async () => {
  const { doc, elements } = createGameDocument();
  const i18n = createTestI18n();
  const first = mountGamePgnExport({ doc, gameId: GAME_ID, i18n, requestPgn: async () => { throw new Error('x'); } });
  first.setFinished(true);
  (elements.get('game-pgn-download')!).click();
  await settle();
  assert.equal(elements.get('game-pgn-error')!.hidden, false);
  first.dispose();

  mountGamePgnExport({ doc, gameId: '00000000-0000-4000-8000-0000000000b2', i18n, requestPgn: async () => PGN });
  assert.equal(elements.get('game-export')!.hidden, true);
  assert.equal(elements.get('game-pgn-error')!.hidden, true);
  assert.equal(elements.get('game-pgn-status')!.textContent, '');
});

test('status and error re-translate in place, and technical tokens are not rewritten in RTL', async () => {
  const { mounted, requests, el, i18n } = setup();
  mounted.setFinished(true);
  el('game-pgn-download').click();
  requests[0]!.reply.reject(new Error('x'));
  await settle();

  i18n.setLocale('ar');
  mounted.relocalize();
  assert.equal(el('game-pgn-error').textContent, 'تعذّر تنزيل ملف PGN. حاول مرة أخرى.');
  assert.ok(!/[‎‏⁦-⁩]/.test(el('game-pgn-error').textContent), 'no invisible direction marks');
  assert.equal(i18n.t('game.export.downloadPgn'), 'تنزيل PGN');

  el('game-pgn-download').click();
  requests[1]!.reply.resolve(PGN);
  await settle();
  assert.equal(el('game-pgn-status').textContent, 'بدأ تنزيل PGN.');
});

test('the saved bytes are never changed by the locale', async () => {
  const { mounted, requests, saved, el } = setup('ar');
  mounted.setFinished(true);
  el('game-pgn-download').click();
  requests[0]!.reply.resolve(PGN);
  await settle();
  assert.equal(saved[0]!.text, PGN);
  assert.equal(saved[0]!.filename, `game-${GAME_ID}.pgn`);
});
