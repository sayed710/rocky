import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GambitClient } from '../src/api/client.js';
import { createI18nManager } from '../src/i18n/index.js';
import { mountCourseDetail, mountCourseList } from '../src/app/learning-mounts.js';
import { httpErrorFrom } from '../src/net/errors.js';

const defaultI18n = createI18nManager();

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('course detail waits for session restoration and disposal prevents its delayed request', async () => {
  const restored = deferred();
  let requests = 0;
  const surface = {} as HTMLElement;
  const client = {
    learning: {
      courseBySlug: async () => {
        requests += 1;
        throw new Error('unexpected request');
      },
    },
  } as unknown as GambitClient;
  const controller = mountCourseDetail({
    doc: { getElementById: () => null } as unknown as Document,
    client,
    surface,
    slug: 'openings',
    sessionPresent: false,
    restorePromise: restored.promise,
    i18n: defaultI18n,
  });
  assert.equal(requests, 0);

  controller.dispose();
  restored.resolve();
  await restored.promise;
  await Promise.resolve();
  assert.equal(requests, 0);
});

test('course list renders the existing unavailable state for an unconfigured service', async () => {
  let child: { className: string; textContent: string | null } | null = null;
  const surface = {
    replaceChildren: () => {
      child = null;
    },
    appendChild: (next: { className: string; textContent: string | null }) => {
      child = next;
      return next;
    },
  } as unknown as HTMLElement;
  const doc = {
    getElementById: () => null,
    createElement: () => ({ className: '', textContent: null }),
  } as unknown as Document;
  const client = {
    learning: {
      listCourses: async () => {
        throw httpErrorFrom(503, undefined);
      },
    },
  } as unknown as GambitClient;

  mountCourseList({ doc, client, surface, i18n: defaultI18n });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(child, {
    className: 'count',
    textContent: 'Learning service unavailable.',
  });
});
