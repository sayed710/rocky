import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRoute, routeToPath } from '../src/app/router.js';
import { LeaderboardController } from '../src/app/leaderboard-controller.js';
import { bindSpeedSelector, bindVariantSelector, renderChooseSpeed, renderLeaderboard, renderSpeedSelector, renderVariantSelector } from '../src/app/leaderboard-view.js';
import { OFFERED_VARIANTS, SPEEDS } from '../src/api/models.js';
import { SPEED_LABELS, VARIANT_LABELS } from '../src/app/variant-labels.js';
import type { LeaderboardEntry, Speed, Variant, SocialPlayer } from '../src/api/models.js';
import type { GambitClient } from '../src/api/client.js';

const HTML_TEMPLATE = readFileSync(
  resolve(process.cwd(), 'index.html'),
  'utf-8',
);

// --- 1. Router integration tests ---

test('parseRoute: /leaderboard -> leaderboard route', () => {
  const route = parseRoute('/leaderboard');
  assert.equal(route.name, 'leaderboard');
});

test('routeToPath: leaderboard -> /leaderboard', () => {
  const path = routeToPath({ name: 'leaderboard' });
  assert.equal(path, '/leaderboard');
});

test('round-trip: parseRoute(routeToPath({ name: "leaderboard" })) is stable', () => {
  const path = routeToPath({ name: 'leaderboard' });
  const parsed = parseRoute(path);
  assert.deepEqual(parsed, { name: 'leaderboard' });
});

// --- 2. Controller tests ---

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeClient(opts: {
  leaderboardImpl?: (variant: Variant, limit?: number) => Promise<LeaderboardEntry[]>;
  resolvePlayersImpl?: (ids: readonly string[]) => Promise<Map<string, SocialPlayer>>;
} = {}) {
  const leaderboardCalls: Array<{ variant: Variant; speed: Speed; limit?: number }> = [];
  const resolvePlayerCalls: Array<readonly string[]> = [];

  const client = {
    leaderboard: async (variant: Variant, speed: Speed, options: { limit?: number } = {}) => {
      const limit = options.limit;
      leaderboardCalls.push(limit !== undefined ? { variant, speed, limit } : { variant, speed });
      if (opts.leaderboardImpl) {
        return opts.leaderboardImpl(variant, options.limit);
      }
      return [
        { userId: 'user_1', variant, speed, rating: 1800, rd: 45 },
        { userId: 'user_2', variant, speed, rating: 1750, rd: 50 },
      ];
    },
    graphql: {
      resolvePlayers: async (ids: readonly string[]) => {
        resolvePlayerCalls.push(ids);
        if (opts.resolvePlayersImpl) {
          return opts.resolvePlayersImpl(ids);
        }
        const map = new Map<string, SocialPlayer>();
        if (ids.includes('user_1')) map.set('user_1', { id: 'user_1', handle: 'alice' });
        return map;
      },
    },
  };

  return { client, leaderboardCalls, resolvePlayerCalls };
}

test('controller loads leaderboard with default limit 100 and resolves handles', async () => {
  const { client, leaderboardCalls, resolvePlayerCalls } = makeFakeClient();
  let results: { entries: readonly LeaderboardEntry[]; names: ReadonlyMap<string, SocialPlayer>; variant: Variant } | null = null;
  let loadingState: boolean | null = null;
  let errorMsg: string | null = null;

  const controller = new LeaderboardController({
    client: client as unknown as GambitClient,
    callbacks: {
      onResults: (entries: readonly LeaderboardEntry[], names: ReadonlyMap<string, SocialPlayer>, variant: Variant) => {
        results = { entries, names, variant };
      },
      onLoading: (loading: boolean) => {
        loadingState = loading;
      },
      onError: (msg: string) => {
        errorMsg = msg;
      },
    },
  });

  await controller.loadLeaderboard('standard', 'blitz');

  assert.equal(leaderboardCalls.length, 1);
  assert.equal(leaderboardCalls[0]?.variant, 'standard');
  assert.equal(leaderboardCalls[0]?.speed, 'blitz');
  assert.equal(leaderboardCalls[0]?.limit, 100);

  assert.equal(resolvePlayerCalls.length, 1);
  assert.deepEqual(resolvePlayerCalls[0], ['user_1', 'user_2']);

  assert.equal(errorMsg, null);
  assert.equal(loadingState, false);
  assert.ok(results !== null);
  if (results) {
    const res = results as { entries: readonly LeaderboardEntry[]; names: ReadonlyMap<string, SocialPlayer>; variant: Variant };
    assert.equal(res.variant, 'standard');
    assert.equal(res.entries.length, 2);
    assert.equal(res.names.get('user_1')?.handle, 'alice');
    assert.equal(res.names.get('user_2'), undefined);
  }
});

test('controller gracefully degrades when GraphQL player resolution fails', async () => {
  const { client } = makeFakeClient({
    resolvePlayersImpl: async () => {
      throw new Error('GraphQL service unavailable');
    },
  });

  let results: { entries: readonly LeaderboardEntry[]; names: ReadonlyMap<string, SocialPlayer> } | null = null;
  let errorMsg: string | null = null;

  const controller = new LeaderboardController({
    client: client as unknown as GambitClient,
    callbacks: {
      onResults: (entries: readonly LeaderboardEntry[], names: ReadonlyMap<string, SocialPlayer>) => {
        results = { entries, names };
      },
      onLoading: () => {},
      onError: (msg: string) => {
        errorMsg = msg;
      },
    },
  });

  await controller.loadLeaderboard('standard', 'blitz');

  assert.equal(errorMsg, null, 'GraphQL error should not fail the leaderboard page');
  assert.ok(results !== null);
  if (results) {
    const res = results as { entries: readonly LeaderboardEntry[]; names: ReadonlyMap<string, SocialPlayer> };
    assert.equal(res.entries.length, 2);
    assert.equal(res.names.size, 0);
  }
});

test('controller handles REST leaderboard fetch failure', async () => {
  const { client } = makeFakeClient({
    leaderboardImpl: async () => {
      throw new Error('Network request failed');
    },
  });

  let errorMsg: string | null = null;

  const controller = new LeaderboardController({
    client: client as unknown as GambitClient,
    callbacks: {
      onResults: () => {},
      onLoading: () => {},
      onError: (msg: string) => {
        errorMsg = msg;
      },
    },
  });

  await controller.loadLeaderboard('standard', 'blitz');

  assert.equal(errorMsg, 'Network request failed');
});

test('deferred-promise race test: older request resolving after newer request cannot replace results', async () => {
  const reqA = deferred<LeaderboardEntry[]>();
  const reqB = deferred<LeaderboardEntry[]>();

  const { client } = makeFakeClient({
    leaderboardImpl: async (variant) => {
      if (variant === 'standard') return reqA.promise;
      if (variant === 'atomic') return reqB.promise;
      return [];
    },
  });

  const paintedVariants: Variant[] = [];

  const controller = new LeaderboardController({
    client: client as unknown as GambitClient,
    callbacks: {
      onResults: (_entries: readonly LeaderboardEntry[], _names: ReadonlyMap<string, SocialPlayer>, variant: Variant) => {
        paintedVariants.push(variant);
      },
      onLoading: () => {},
      onError: () => {},
    },
  });

  // Start Request A for standard
  const pA = controller.loadLeaderboard('standard', 'blitz');
  // Start Request B for atomic
  const pB = controller.loadLeaderboard('atomic', 'blitz');

  // Resolve Request B first
  reqB.resolve([{ userId: 'b1', variant: 'atomic', speed: 'blitz', rating: 1900, rd: 30 }]);
  await pB;

  assert.deepEqual(paintedVariants, ['atomic']);

  // Resolve Request A second (out-of-order completion)
  reqA.resolve([{ userId: 'a1', variant: 'standard', speed: 'blitz', rating: 1500, rd: 50 }]);
  await pA;

  assert.deepEqual(paintedVariants, ['atomic'], 'Request A must not overwrite Request B');
});

test('dispose-before-resolution clears loading without painting late results or errors', async () => {
  const req = deferred<LeaderboardEntry[]>();

  const { client } = makeFakeClient({
    leaderboardImpl: async () => req.promise,
  });

  const callbacks: string[] = [];

  const controller = new LeaderboardController({
    client: client as unknown as GambitClient,
    callbacks: {
      onResults: () => { callbacks.push('results'); },
      onLoading: (loading) => { callbacks.push(`loading:${loading}`); },
      onError: () => { callbacks.push('error'); },
    },
  });

  const p = controller.loadLeaderboard('standard', 'blitz');
  assert.deepEqual(callbacks, ['loading:true'], 'Initial loading state emitted');

  controller.dispose();

  req.resolve([{ userId: 'u1', variant: 'standard', speed: 'blitz', rating: 1600, rd: 40 }]);
  await p;

  assert.deepEqual(
    callbacks,
    ['loading:true', 'loading:false'],
    'Late completion should only clear loading after dispose()',
  );
});

// --- 3. View rendering tests ---

interface FakeElement {
  tagName: string;
  className: string;
  classList: DOMTokenList;
  children: FakeElement[];
  attributes: Map<string, string>;
  id: string;
  selected?: boolean;
  value?: string;
  ownerDocument: unknown;
  get textContent(): string;
  set textContent(val: string);
  set innerHTML(val: string);
  get innerHTML(): string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(child: FakeElement): void;
  append(...children: (FakeElement | string)[]): void;
  querySelector(sel: string): FakeElement | null;
  querySelectorAll(sel: string): FakeElement[];
  addEventListener(event: string, handler: EventListener): void;
  removeEventListener(event: string, handler: EventListener): void;
  dispatchEvent(event: { type: string; target?: unknown }): void;
}

function createFakeDoc() {
  const elementsById = new Map<string, FakeElement>();

  const doc: any = {};

  const createEl = (tag: string) => {
    let explicitTextContent: string | null = null;
    const children: FakeElement[] = [];
    const attrs = new Map<string, string>();
    const listeners: Record<string, EventListener[]> = {};

    const elObj: FakeElement = {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      children,
      attributes: attrs,
      ownerDocument: doc,
      get textContent(): string {
        if (explicitTextContent !== null) return explicitTextContent;
        return children.map((c) => c.textContent).join('');
      },
      set textContent(val: string) {
        explicitTextContent = val;
        children.length = 0;
      },
      get innerHTML(): string {
        return '';
      },
      set innerHTML(_val: string) {
        explicitTextContent = null;
        children.length = 0;
      },
      setAttribute(k: string, v: string) {
        if (k === 'class') {
          this.className = v;
          this.classList.add(v);
        }
        else if (k === 'id') {
          if (this.id) elementsById.delete(this.id);
          this.id = v;
          elementsById.set(v, this);
        }
        else attrs.set(k, v);
      },
      getAttribute(k: string) {
        if (k === 'class') return this.className;
        if (k === 'id') return this.id;
        return attrs.get(k) ?? null;
      },
      appendChild(child: FakeElement) {
        explicitTextContent = null;
        children.push(child);
      },
      append(...items: (FakeElement | string)[]) {
        for (const item of items) {
          if (typeof item === 'string') {
            const txt = createEl('span');
            txt.textContent = item;
            children.push(txt);
          } else {
            children.push(item);
          }
        }
      },
      querySelector(sel: string): FakeElement | null {
        return this.querySelectorAll(sel)[0] ?? null;
      },
      querySelectorAll(sel: string): FakeElement[] {
        const matched: FakeElement[] = [];
        const visit = (n: FakeElement) => {
          if (sel === '.panel-row' && n.className.includes('panel-row')) matched.push(n);
          else if (sel === 'a.row-link' && n.tagName === 'A' && n.className.includes('row-link')) matched.push(n);
          else if (sel === 'a' && n.tagName === 'A') matched.push(n);
          else if (sel === '.empty' && n.className.includes('empty')) matched.push(n);
          else if (sel === 'option' && n.tagName === 'OPTION') matched.push(n);

          for (const child of n.children) visit(child);
        };
        for (const child of children) visit(child);
        return matched;
      },
      addEventListener(event: string, handler: EventListener) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
      },
      removeEventListener(event: string, handler: EventListener) {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter(h => h !== handler);
      },
      dispatchEvent(event: { type: string; target?: unknown }) {
        if (!event.target) {
          event = { ...event, target: this };
        }
        if (!listeners[event.type]) return;
        for (const handler of listeners[event.type]!) {
          handler(event as any);
        }
      },
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => false,
      } as unknown as DOMTokenList
    };

    return elObj;
  };

  doc.createElement = createEl;
  doc.getElementById = function(id: string): FakeElement | null {
    return elementsById.get(id) ?? null;
  };
  doc.documentElement = createEl('html');
  doc.body = createEl('body');

  return doc;
}



test('renderLeaderboard renders rows with rank, player handle link, rating, and RD', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div') as unknown as HTMLElement;

  const entries: LeaderboardEntry[] = [
    { userId: 'user_1', variant: 'standard', speed: 'blitz', rating: 2100, rd: 35 },
    { userId: 'user_2', variant: 'standard', speed: 'blitz', rating: 1950, rd: 42 },
  ];
  const names = new Map<string, SocialPlayer>([
    ['user_1', { id: 'user_1', handle: 'magnus' }],
  ]);

  renderLeaderboard(container, entries, names);

  const fakeContainer = container as unknown as FakeElement;
  const rows = fakeContainer.querySelectorAll('.panel-row');
  assert.equal(rows.length, 2);

  // First row has resolved handle 'magnus' -> linked to profile
  const firstRow = rows[0]!;
  assert.ok(firstRow.textContent.includes('#1'));
  assert.ok(firstRow.textContent.includes('2100'));
  assert.ok(firstRow.textContent.includes('35'));

  const firstLink = firstRow.querySelector('a.row-link');
  assert.ok(firstLink, 'Resolved handle must be rendered as a link');
  assert.equal(firstLink?.getAttribute('href'), '/profile/magnus');
  assert.equal(firstLink?.getAttribute('data-route'), 'profile');
  assert.equal(firstLink?.textContent, 'magnus');

  // Second row has unresolved bare user_2 -> NO link to profile
  const secondRow = rows[1]!;
  assert.ok(secondRow.textContent.includes('#2'));
  assert.ok(secondRow.textContent.includes('1950'));
  assert.ok(secondRow.textContent.includes('42'));

  const secondLink = secondRow.querySelector('a');
  assert.equal(secondLink, null, 'Unresolved bare user id must NOT be rendered as a link');
  assert.ok(secondRow.textContent.includes('user_2'), 'Bare id shortId fallback rendered as text');
});

test('renderLeaderboard renders empty state when entries list is empty', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div') as unknown as HTMLElement;

  renderLeaderboard(container, [], new Map());

  const fakeContainer = container as unknown as FakeElement;
  assert.ok(fakeContainer.querySelector('.empty'), 'Empty state element rendered');
  assert.ok(fakeContainer.textContent.includes('No leaderboard entries'));
});

test('renderVariantSelector renders one option per OFFERED_VARIANTS entry', () => {
  const doc = createFakeDoc();
  const select = doc.createElement('select') as unknown as HTMLSelectElement;

  renderVariantSelector(select, 'atomic');

  const fakeSelect = select as unknown as FakeElement;
  const options = fakeSelect.querySelectorAll('option');
  assert.equal(options.length, OFFERED_VARIANTS.length);

  const values = options.map((opt) => opt.getAttribute('value'));
  assert.deepEqual(values, OFFERED_VARIANTS);
  // Chess960 ratings were always readable and are now earnable too (ADR-0137), so the leaderboard
  // offers the same list the lobby does. What this pins is that the selector renders whatever
  // `OFFERED_VARIANTS` holds rather than a second copy of it — the omission it used to assert was
  // never this module's decision to make.
  assert.equal(values.includes('chess960'), true, 'the selector follows OFFERED_VARIANTS');

  const selectedOpt = options.find((opt) => opt.selected);
  assert.equal(selectedOpt?.getAttribute('value'), 'atomic');
  assert.equal(selectedOpt?.textContent, VARIANT_LABELS['atomic']);
});

// --- 4. Static HTML Accessibility & Markup tests ---

test('nav link is present for leaderboard', () => {
  assert.ok(
    HTML_TEMPLATE.includes('href="/leaderboard" data-route="leaderboard">Leaderboard</a>'),
    'Navigation link for /leaderboard must be present in index.html',
  );
});

test('leaderboard section carries aria-labelledby', () => {
  assert.ok(
    HTML_TEMPLATE.includes('id="leaderboard"') && HTML_TEMPLATE.includes('aria-labelledby="leaderboard-heading"'),
    'Leaderboard section must carry aria-labelledby="leaderboard-heading"',
  );
});

test('leaderboard results region carries aria-label', () => {
  assert.ok(
    HTML_TEMPLATE.includes('id="leaderboard-results"') && HTML_TEMPLATE.includes('aria-label="Leaderboard standings"'),
    'Leaderboard results region must carry aria-label="Leaderboard standings"',
  );
});

test('leaderboard error region is announced with role="alert"', () => {
  assert.match(
    HTML_TEMPLATE,
    /id="leaderboard-error"[^>]*role="alert"/,
    'Leaderboard error region must have role="alert"',
  );
});

test('leaderboard variant select has associated label', () => {
  assert.match(
    HTML_TEMPLATE,
    /<label[^>]*for="leaderboard-variant-select"[^>]*>/,
    'Leaderboard variant select must have an associated label',
  );
});

test('bindVariantSelector fires onChange for valid variants and unbind removes listener', () => {
  const doc = createFakeDoc();
  const selectEl = doc.createElement('select') as unknown as HTMLSelectElement;
  let calls = 0;

  const unbind = bindVariantSelector(selectEl, () => { calls++; });

  // Valid variant triggers onChange
  (selectEl as any).value = 'standard';
  (selectEl as unknown as FakeElement).dispatchEvent({ type: 'change', target: selectEl });
  assert.equal(calls, 1, 'Change listener should trigger for valid variant');

  // Invalid variant does not trigger onChange
  (selectEl as any).value = 'invalid';
  (selectEl as unknown as FakeElement).dispatchEvent({ type: 'change', target: selectEl });
  assert.equal(calls, 1, 'Change listener should ignore invalid variant');

  unbind();

  // Does not trigger after unbind
  (selectEl as any).value = 'atomic';
  (selectEl as unknown as FakeElement).dispatchEvent({ type: 'change', target: selectEl });
  assert.equal(calls, 1, 'Change listener should not trigger after unbind');
});

test('renderSpeedSelector offers every speed and, with none chosen, selects only a prompt', () => {
  const doc = createFakeDoc();
  const select = doc.createElement('select') as unknown as HTMLSelectElement;
  renderSpeedSelector(select, null);
  const options = (select as unknown as FakeElement).querySelectorAll('option');
  assert.deepEqual(options.map((o) => o.getAttribute('value')), ['', ...SPEEDS]);
  assert.equal(options[0]?.getAttribute('disabled'), '', 'the prompt cannot itself be chosen');
  assert.deepEqual(options.filter((o) => o.selected).map((o) => o.getAttribute('value')), ['']);

  renderSpeedSelector(select, 'correspondence');
  const again = (select as unknown as FakeElement).querySelectorAll('option');
  const chosen = again.filter((o) => o.selected);
  assert.deepEqual(chosen.map((o) => o.getAttribute('value')), ['correspondence']);
  assert.equal(chosen[0]?.textContent, SPEED_LABELS.correspondence);
});

test('bindSpeedSelector reports only real speeds and stops after unbind', () => {
  const doc = createFakeDoc();
  const selectEl = doc.createElement('select') as unknown as HTMLSelectElement;
  const seen: Speed[] = [];
  const unbind = bindSpeedSelector(selectEl, (speed) => { seen.push(speed); });
  for (const value of ['rapid', '', 'hyperbullet']) {
    (selectEl as any).value = value;
    (selectEl as unknown as FakeElement).dispatchEvent({ type: 'change', target: selectEl });
  }
  unbind();
  (selectEl as any).value = 'bullet';
  (selectEl as unknown as FakeElement).dispatchEvent({ type: 'change', target: selectEl });
  assert.deepEqual(seen, ['rapid']);
});

test('renderChooseSpeed asks for a time control instead of showing a default pool', () => {
  const doc = createFakeDoc();
  const container = doc.createElement('div') as unknown as HTMLElement;
  renderChooseSpeed(container);
  assert.equal(container.getAttribute('role'), 'status');
  assert.ok((container as unknown as FakeElement).textContent.includes('Choose a time control'));
});

test('leaderboard speed select has an associated label', () => {
  assert.match(HTML_TEMPLATE, /<label[^>]*for="leaderboard-speed-select"[^>]*>/);
  assert.ok(HTML_TEMPLATE.includes('id="leaderboard-speed-select"'));
});
