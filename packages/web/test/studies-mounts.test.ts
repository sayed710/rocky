import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { HttpTransport, HttpResponse, HttpRequest } from '../src/ports/http.js';
import type { ClipboardWriter } from '../src/app/game-pgn-export.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { json } from './support/fake-transport.js';
import type { StudyView } from '../src/api/models.js';
import { createI18nManager } from '../src/i18n/index.js';
import { mountStudiesList, mountStudyChapter } from '../src/app/studies-mounts.js';
import { httpErrorFrom } from '../src/net/errors.js';

const defaultI18n = createI18nManager();

const STUDY: StudyView = {
  id: 'study-1',
  ownerId: 'owner-1',
  name: 'Openings',
  description: 'A study',
  visibility: 'public',
  variant: 'standard',
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
};

function settleRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeBoardElement(): {
  readonly element: HTMLElement;
  readonly liveCount: (type: string) => number;
} {
  const listeners = new Map<string, Set<unknown>>();
  return {
    element: {
      classList: { add: (): void => undefined },
      setAttribute: (): void => undefined,
      set innerHTML(_value: string) {
        // Board rendering is covered by the board and studies Playwright suites.
      },
      getBoundingClientRect: () => ({ width: 512, height: 512, left: 0, top: 0 }),
      addEventListener(type: string, listener: unknown): void {
        const current = listeners.get(type) ?? new Set<unknown>();
        current.add(listener);
        listeners.set(type, current);
      },
      removeEventListener(type: string, listener: unknown): void {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as HTMLElement,
    liveCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

test('remounting studies replaces the persistent search handler', async () => {
  const form = { onsubmit: null as ((event: Event) => void) | null };
  const input = { value: '  endgames  ' };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'study-search-form') return form;
      if (id === 'study-search-input') return input;
      return null;
    },
  } as unknown as Document;
  const surface = {} as HTMLElement;
  const firstQueries: unknown[] = [];
  const secondQueries: unknown[] = [];
  const client = (queries: unknown[]): GambitClient =>
    ({
      studies: {
        listStudies: async (options: unknown) => {
          queries.push(options);
          return { total: 0, items: [] };
        },
      },
    }) as unknown as GambitClient;

  const first = mountStudiesList({ doc, client: client(firstQueries), surface, i18n: defaultI18n });
  const second = mountStudiesList({ doc, client: client(secondQueries), surface, i18n: defaultI18n });
  await settleRequests();

  form.onsubmit?.({ preventDefault: () => undefined } as unknown as Event);
  await settleRequests();

  assert.deepEqual(firstQueries, [undefined]);
  assert.deepEqual(secondQueries, [undefined, { search: 'endgames' }]);
  first.dispose();
  second.dispose();
});

test('studies list renders the existing unavailable state on a 503', async () => {
  let rendered: { className: string; textContent: string | null } | null = null;
  const surface = {
    replaceChildren: () => {
      rendered = null;
    },
    appendChild: (child: { className: string; textContent: string | null }) => {
      rendered = child;
      return child;
    },
  } as unknown as HTMLElement;
  const doc = {
    getElementById: () => null,
    createElement: () => ({ className: '', textContent: null }),
  } as unknown as Document;
  const client = {
    studies: {
      listStudies: async () => {
        throw httpErrorFrom(503, undefined);
      },
    },
  } as unknown as GambitClient;

  mountStudiesList({ doc, client, surface, i18n: defaultI18n });
  await settleRequests();

  assert.deepEqual(rendered, {
    className: 'count',
    textContent: 'Studies service unavailable.',
  });
});

test('chapter route disposal detaches its board and suppresses a stale response', async () => {
  let resolveStudy!: (study: StudyView) => void;
  const pendingStudy = new Promise<StudyView>((resolve) => {
    resolveStudy = resolve;
  });
  let chapterRequests = 0;
  const board = fakeBoardElement();
  const busyStates: string[] = [];
  const tree = {
    setAttribute: (name: string, value: string) => {
      if (name === 'aria-busy') busyStates.push(value);
    },
    replaceChildren: () => undefined,
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'chapter-board') return board.element;
      if (id === 'chapter-tree') return tree;
      return null;
    },
  } as unknown as Document;
  const client = {
    studies: {
      study: () => pendingStudy,
      chapterDetail: async () => {
        chapterRequests += 1;
        throw new Error('stale chapter request');
      },
    },
  } as unknown as GambitClient;

  const mounted = mountStudyChapter({
    doc,
    client,
    surface: {} as HTMLElement,
    studyId: STUDY.id,
    chapterId: 'chapter-1',
    i18n: defaultI18n,
  });
  assert.ok(mounted.board);
  assert.equal(board.liveCount('click'), 1);
  assert.equal(board.liveCount('pointerdown'), 1);
  assert.equal(board.liveCount('keydown'), 1);

  mounted.board.dispose();
  mounted.studies.dispose();
  resolveStudy(STUDY);
  await pendingStudy;
  await settleRequests();

  assert.equal(board.liveCount('click'), 0);
  assert.equal(board.liveCount('pointerdown'), 0);
  assert.equal(board.liveCount('keydown'), 0);
  assert.equal(chapterRequests, 0);
  assert.deepEqual(busyStates, ['true', 'false']);
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';
const CHAPTER_C1 = { id: 'c1', studyId: 's1', name: 'Chapter', orderIndex: 0, startingFen: START };
const TREE_C1 = [{ id: 'n1', chapterId: 'c1', parentId: null, san: 'e4', fenAfter: E4, nags: [], orderIndex: 0 }];
const CHAPTER_C2 = { id: 'c2', studyId: 's1', name: 'Chapter 2', orderIndex: 1, startingFen: D4 };

async function withGlobalDoc<T>(doc: Document, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'document', desc);
    else delete (globalThis as unknown as { document?: Document }).document;
  }
}

function createStudyFixture() {
  const copyBtn = new FakeElement('button', 'study-position-copy');
  const statusEl = new FakeElement('div', 'study-position-status');
  const errorEl = new FakeElement('div', 'study-position-error');
  const treeEl = new FakeElement('div', 'chapter-tree');
  const chapterErrorEl = new FakeElement('div', 'study-chapter-error');
  const boardEl = new FakeElement('div', 'chapter-board');
  const studyLinkEl = new FakeElement('a', 'chapter-study-link');
  const nameEl = new FakeElement('h2', 'chapter-name');
  const exportBtn = new FakeElement('a', 'chapter-export-link');
  const navEl = new FakeElement('nav', 'chapter-list-nav');
  const elements = new Map<string, FakeElement>([
    ['study-position-copy', copyBtn],
    ['study-position-status', statusEl],
    ['study-position-error', errorEl],
    ['chapter-tree', treeEl],
    ['study-chapter-error', chapterErrorEl],
    ['chapter-board', boardEl],
    ['chapter-study-link', studyLinkEl],
    ['chapter-name', nameEl],
    ['chapter-export-link', exportBtn],
    ['chapter-list-nav', navEl],
  ]);
  const doc = createFakeDoc(elements);
  const surface = new FakeElement('section') as unknown as HTMLElement;
  return {
    copyBtn,
    statusEl,
    errorEl,
    treeEl,
    chapterErrorEl,
    boardEl,
    studyLinkEl,
    nameEl,
    exportBtn,
    navEl,
    doc,
    surface,
  };
}

test('study position copy button hides during reload failure and recovers', async () => {
  const {
    copyBtn,
    treeEl,
    chapterErrorEl,
    boardEl,
    studyLinkEl,
    nameEl,
    exportBtn,
    navEl,
    doc,
    surface,
  } = createStudyFixture();
  const requests: HttpRequest[] = [];
  let resolveC2!: (res: HttpResponse) => void;
  const c2Deferred = new Promise<HttpResponse>((resolve) => { resolveC2 = resolve; });
  const transport: HttpTransport = {
    async send(req) {
      requests.push(req);
      const pathname = new URL(req.url).pathname;
      if (pathname === '/v1/studies/s1') return json(200, { ...STUDY, id: 's1' });
      if (pathname === '/v1/studies/s1/chapters') return json(200, { items: [] });
      if (pathname === '/v1/studies/s1/chapters/c1') return json(200, { chapter: CHAPTER_C1, tree: TREE_C1 });
      if (pathname === '/v1/studies/s1/chapters/c2') return c2Deferred;
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    },
  };
  const client = new GambitClient({ baseUrl: 'https://api.test', transport });
  const copied: string[] = [];
  const i18n = createI18nManager();

  await withGlobalDoc(doc, async () => {
    const mounted = mountStudyChapter({
      doc, client, surface, studyId: 's1', chapterId: 'c1', i18n,
      writeClipboard: async (text) => { copied.push(await text); },
    });
    try {
      await settleRequests();
      assert.equal(requests.length, 3);
      assert.equal(boardEl.hidden, false);
      assert.equal(exportBtn.hidden, false);
      assert.equal(studyLinkEl.hidden, false);
      assert.equal(nameEl.hidden, false);
      assert.equal(navEl.hidden, false);

      const oldNotation = treeEl.querySelectorAll('.notation-move')[0] as FakeElement;
      assert.ok(oldNotation);
      copyBtn.click();
      await settleRequests();
      assert.deepEqual(copied, [START]);

      const loadPromise = mounted.studies.loadChapter('s1', 'c2');
      assert.equal(copyBtn.hidden, true);
      assert.equal(boardEl.hidden, true);
      assert.equal(exportBtn.hidden, true);
      assert.equal(studyLinkEl.hidden, true);
      assert.equal(nameEl.hidden, true);
      assert.equal(navEl.hidden, true);
      assert.equal(treeEl.querySelectorAll('.notation-move').length, 0);

      oldNotation.click();
      assert.equal(copyBtn.hidden, true);
      assert.equal(boardEl.hidden, true);
      assert.equal(oldNotation.classList.contains('active'), false);

      await i18n.setLocale('ar');
      assert.equal(copyBtn.hidden, true);
      assert.equal(boardEl.hidden, true);
      assert.equal(exportBtn.hidden, true);
      assert.equal(treeEl.querySelectorAll('.notation-move').length, 0);

      resolveC2(json(403, { error: { code: 'FORBIDDEN', message: 'Denied' } }));
      await loadPromise;
      await settleRequests();
      assert.equal(copyBtn.hidden, true);
      assert.equal(boardEl.hidden, true);
      assert.equal(exportBtn.hidden, true);
      assert.equal(studyLinkEl.hidden, true);
      assert.equal(nameEl.hidden, true);
      assert.equal(navEl.hidden, true);
      assert.equal(treeEl.querySelectorAll('.notation-move').length, 0);
      assert.ok(chapterErrorEl.textContent);

      oldNotation.click();
      assert.equal(copyBtn.hidden, true);
      assert.equal(exportBtn.hidden, true);

      await mounted.studies.loadChapter('s1', 'c1');
      await settleRequests();
      assert.equal(copyBtn.hidden, false);
      assert.equal(boardEl.hidden, false);
      assert.equal(exportBtn.hidden, false);
      assert.equal(studyLinkEl.hidden, false);
      assert.equal(nameEl.hidden, false);
      assert.equal(navEl.hidden, false);

      const freshNotation = treeEl.querySelectorAll('.notation-move')[0] as FakeElement;
      assert.ok(freshNotation);

      const callsAfterLoad = requests.length;
      copyBtn.click();
      await settleRequests();
      assert.equal(requests.length, callsAfterLoad);
      assert.equal(copied.at(-1), START);

      freshNotation.click();
      await settleRequests();
      copyBtn.click();
      await settleRequests();
      assert.equal(copied.at(-1), E4);

      oldNotation.click();
      await settleRequests();
      copyBtn.click();
      await settleRequests();
      assert.equal(copied.at(-1), E4);
    } finally {
      mounted.board?.dispose();
      mounted.studies.dispose();
    }
  });
});

test('retained callbacks and double cleanup do not corrupt remounted study state', async () => {
  const { copyBtn, statusEl, treeEl, doc, surface } = createStudyFixture();
  const transport: HttpTransport = {
    async send(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/v1/studies/s1') return json(200, { ...STUDY, id: 's1' });
      if (pathname === '/v1/studies/s1/chapters') return json(200, { items: [] });
      if (pathname === '/v1/studies/s1/chapters/c1') return json(200, { chapter: CHAPTER_C1, tree: TREE_C1 });
      if (pathname === '/v1/studies/s1/chapters/c2') return json(200, { chapter: CHAPTER_C2, tree: [] });
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    },
  };
  const client = new GambitClient({ baseUrl: 'https://api.test', transport });
  let settleOldClipboard!: () => void;
  const oldPromise = new Promise<void>((resolve) => { settleOldClipboard = resolve; });
  let oldWriterCalls = 0;
  const oldCopied: string[] = [];
  const oldWriter: ClipboardWriter = async (text) => {
    oldWriterCalls += 1;
    const resolved = await text;
    await oldPromise;
    oldCopied.push(resolved);
  };

  await withGlobalDoc(doc, async () => {
    const first = mountStudyChapter({
      doc, client, surface, studyId: 's1', chapterId: 'c1', i18n: defaultI18n,
      writeClipboard: oldWriter,
    });
    let second: ReturnType<typeof mountStudyChapter> | null = null;
    try {
      await settleRequests();

      const oldNotation = treeEl.querySelectorAll('.notation-move')[0] as FakeElement;
      assert.ok(oldNotation);
      copyBtn.click();
      assert.equal(oldWriterCalls, 1);

      first.studies.dispose();

      const newCopied: string[] = [];
      const newWriter: ClipboardWriter = async (text) => { newCopied.push(await text); };
      second = mountStudyChapter({
        doc, client, surface, studyId: 's1', chapterId: 'c2', i18n: defaultI18n,
        writeClipboard: newWriter,
      });
      await settleRequests();

      copyBtn.click();
      await settleRequests();
      assert.deepEqual(newCopied, [D4]);
      const snapshotStatus = statusEl.textContent;

      settleOldClipboard();
      await settleRequests();
      assert.deepEqual(oldCopied, [START]);

      first.studies.dispose();
      oldNotation.click();
      await settleRequests();

      copyBtn.click();
      await settleRequests();
      assert.deepEqual(newCopied, [D4, D4]);
      assert.equal(statusEl.textContent, snapshotStatus);
    } finally {
      first.board?.dispose();
      first.studies.dispose();
      second?.board?.dispose();
      second?.studies.dispose();
    }
  });
});
