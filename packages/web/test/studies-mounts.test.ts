import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GambitClient } from '../src/api/client.js';
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
