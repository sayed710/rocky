import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLeaderboard } from '../src/app/competition-mounts.js';
import { GambitClient } from '../src/api/client.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { json } from './support/fake-transport.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { createI18nManager } from '../src/i18n/index.js';

const flush = () => new Promise<void>((r) => setImmediate(r));
const selectedVal = (el: FakeElement) => (el.children as unknown as HTMLOptionElement[]).find((o) => o.selected)?.value;
function bindDoc(doc: unknown) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  return () => (prev ? Object.defineProperty(globalThis, 'document', prev) : Reflect.deleteProperty(globalThis, 'document'));
}
function createTestEnv(initialHref: string, sendFn?: (req: HttpRequest) => Promise<HttpResponse>, sentinel: unknown = { marker: 'sentinel' }) {
  const variantSelect = new FakeElement('select', 'leaderboard-variant-select');
  const speedSelect = new FakeElement('select', 'leaderboard-speed-select');
  const loadingEl = new FakeElement('div', 'leaderboard-loading');
  const resultsEl = new FakeElement('div', 'leaderboard-results');
  const errorEl = new FakeElement('div', 'leaderboard-error');
  const doc = createFakeDoc(new Map<string, FakeElement>([
    ['leaderboard-variant-select', variantSelect], ['leaderboard-speed-select', speedSelect],
    ['leaderboard-loading', loadingEl], ['leaderboard-results', resultsEl], ['leaderboard-error', errorEl],
  ]));
  const historyCalls: Array<{ state: unknown; title: string; url: string | URL | null }> = [];
  const parsed = new URL(initialHref);
  const fakeLocation = { href: parsed.href, search: parsed.search };
  const fakeHistory = {
    state: sentinel,
    replaceState(state: unknown, _title: string, url: string | URL | null) {
      historyCalls.push({ state, title: _title, url });
      fakeHistory.state = state;
      const next = new URL(url ?? '', fakeLocation.href);
      fakeLocation.href = next.href;
      fakeLocation.search = next.search;
    },
  };
  Object.defineProperty(doc, 'defaultView', { value: { location: fakeLocation, history: fakeHistory } as unknown as Window, configurable: true });
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      return sendFn ? sendFn(req) : json(200, []);
    },
  };
  return {
    doc, variantSelect, speedSelect, loadingEl, resultsEl, errorEl, fakeLocation, fakeHistory, historyCalls, requests,
    client: new GambitClient({ baseUrl: 'https://api.test', transport }), i18n: createI18nManager(),
  };
}

test('direct query initialization and selector updates with history and localization', async () => {
  const sentinel = { marker: 'initial-state' };
  const env = createTestEnv('https://chess.test/leaderboard?extra=keep&variant=atomic&speed=blitz#heading', undefined, sentinel);
  const restoreDoc = bindDoc(env.doc);
  let mountHandle: { dispose: () => void } | undefined;
  try {
    mountHandle = mountLeaderboard(env.doc, env.client, env.i18n);
    await flush();
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0]?.url, 'https://api.test/v1/leaderboard/atomic/blitz?limit=100');
    assert.equal(selectedVal(env.variantSelect), 'atomic');
    assert.equal(selectedVal(env.speedSelect), 'blitz');
    assert.equal(env.historyCalls.length, 0);

    env.variantSelect.value = 'standard';
    env.variantSelect.dispatchEvent({ type: 'change', target: env.variantSelect } as unknown as Event);
    await flush();
    assert.equal(env.historyCalls.length, 1);
    assert.strictEqual(env.historyCalls[0]?.state, sentinel);
    assert.strictEqual(env.fakeHistory.state, sentinel);
    const currentUrl = new URL(env.fakeLocation.href);
    assert.equal(currentUrl.searchParams.get('variant'), 'standard');
    assert.equal(currentUrl.searchParams.get('speed'), 'blitz');
    assert.equal(currentUrl.searchParams.get('extra'), 'keep');
    assert.equal(currentUrl.hash, '#heading');
    assert.equal(env.requests.length, 2);
    assert.equal(env.requests[1]?.url, 'https://api.test/v1/leaderboard/standard/blitz?limit=100');

    await env.i18n.setLocale('ar');
    await flush();
    assert.equal(selectedVal(env.variantSelect), 'standard');
    assert.equal(selectedVal(env.speedSelect), 'blitz');
    assert.equal(new URL(env.fakeLocation.href).searchParams.get('variant'), 'standard');
    assert.equal(env.requests.length, 2);
    assert.equal(env.historyCalls.length, 1);
  } finally {
    mountHandle?.dispose();
    restoreDoc();
  }
});

test('same-doc remount race guards stale callbacks and preserves single ownership', async () => {
  let resolveOld!: (value: HttpResponse) => void;
  let resolveNew!: (value: HttpResponse) => void;
  const oldPromise = new Promise<HttpResponse>((r) => { resolveOld = r; });
  const newPromise = new Promise<HttpResponse>((r) => { resolveNew = r; });
  const env = createTestEnv('https://chess.test/leaderboard?variant=atomic&speed=blitz', async (req) => {
    if (req.url.includes('atomic')) return oldPromise;
    if (req.url.includes('standard')) return newPromise;
    return json(200, []);
  });
  const restoreDoc = bindDoc(env.doc);
  let mountOld: { dispose: () => void } | undefined;
  let mountNew: { dispose: () => void } | undefined;
  try {
    mountOld = mountLeaderboard(env.doc, env.client, env.i18n);
    assert.equal(env.requests.length, 1);
    assert.match(env.requests[0]!.url, /atomic/);
    const oldVariantListener = env.variantSelect.listeners['change']?.[0];
    assert.ok(oldVariantListener, 'expected change listener on variant select');

    mountOld.dispose();
    env.fakeLocation.search = '?variant=standard&speed=blitz';
    env.fakeLocation.href = 'https://chess.test/leaderboard?variant=standard&speed=blitz';
    mountNew = mountLeaderboard(env.doc, env.client, env.i18n);
    assert.equal(env.loadingEl.hidden, false);
    assert.equal(env.resultsEl.hidden, true);
    assert.equal(env.resultsEl.getAttribute('aria-busy'), 'true');
    assert.equal(env.errorEl.textContent, '');
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1]!.url, /standard/);

    resolveOld(json(200, []));
    await flush();
    assert.equal(env.loadingEl.hidden, false);
    assert.equal(env.resultsEl.hidden, true);
    assert.equal(env.resultsEl.getAttribute('aria-busy'), 'true');
    assert.equal(env.errorEl.textContent, '');

    const reqCount = env.requests.length;
    const histCount = env.historyCalls.length;
    env.variantSelect.value = 'atomic';
    oldVariantListener?.({ type: 'change', target: env.variantSelect } as unknown as Event);
    await flush();
    assert.equal(env.requests.length, reqCount);
    assert.equal(env.historyCalls.length, histCount);

    resolveNew(json(200, []));
    await flush();
    assert.equal(env.loadingEl.hidden, true);
    assert.equal(env.resultsEl.getAttribute('aria-busy'), 'false');

    mountOld.dispose();
    env.variantSelect.value = 'atomic';
    env.variantSelect.dispatchEvent({ type: 'change', target: env.variantSelect } as unknown as Event);
    await flush();
    assert.equal(env.historyCalls.length, 1);
    assert.equal(env.requests.length, 3);
    assert.equal(env.requests[2]?.url, 'https://api.test/v1/leaderboard/atomic/blitz?limit=100');
    assert.match(env.fakeLocation.search, /variant=atomic/);
  } finally {
    mountOld?.dispose();
    mountNew?.dispose();
    restoreDoc();
  }
});

test('bare remount after pending request resets markup and prevents stale mutation', async () => {
  let resolveOld!: (v: HttpResponse) => void;
  const env = createTestEnv('https://chess.test/leaderboard?variant=atomic&speed=blitz', () => new Promise<HttpResponse>((r) => { resolveOld = r; }));
  const restoreDoc = bindDoc(env.doc);
  let mountOld: { dispose: () => void } | undefined;
  let mountBare: { dispose: () => void } | undefined;
  try {
    mountOld = mountLeaderboard(env.doc, env.client, env.i18n);
    assert.equal(env.requests.length, 1);
    mountOld.dispose();
    env.fakeLocation.href = 'https://chess.test/leaderboard';
    env.fakeLocation.search = '';
    mountBare = mountLeaderboard(env.doc, env.client, env.i18n);
    assert.equal(env.requests.length, 1);
    assert.equal(env.loadingEl.hidden, true);
    assert.equal(env.resultsEl.hidden, false);
    assert.equal(env.resultsEl.getAttribute('aria-busy'), 'false');
    assert.equal(env.resultsEl.getAttribute('role'), 'status');
    assert.equal(env.errorEl.textContent, '');
    assert.equal(selectedVal(env.variantSelect), 'standard');
    assert.equal(selectedVal(env.speedSelect), '');
    assert.match(env.resultsEl.textContent ?? '', /Choose a time control/);
    resolveOld(json(200, []));
    await flush();
    assert.equal(env.loadingEl.hidden, true);
    assert.equal(env.resultsEl.hidden, false);
    assert.equal(env.resultsEl.getAttribute('aria-busy'), 'false');
    assert.equal(env.resultsEl.getAttribute('role'), 'status');
    assert.equal(env.errorEl.textContent, '');
    assert.equal(selectedVal(env.variantSelect), 'standard');
    assert.equal(selectedVal(env.speedSelect), '');
    assert.match(env.resultsEl.textContent ?? '', /Choose a time control/);
    assert.equal(env.requests.length, 1);
  } finally {
    mountOld?.dispose();
    mountBare?.dispose();
    restoreDoc();
  }
});
