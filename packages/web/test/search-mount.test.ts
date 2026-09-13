/**
 * The `/search` route, gated on what the deployment actually serves (ADR-0132).
 *
 * `GET /v1/search` serves three modes from two dependency sets the server gates separately.
 * `SEARCH_ENABLED=0` — the chart's `search.enabled: false` — removes the repository and every mode
 * answers 503, keyword included; `search.semanticEnabled: false` leaves keyword working and the
 * other two refusing. So there are three states to cover, not two.
 *
 * The flags arrive asynchronously, so the assertions are about *timing* as much as markup: what is
 * on screen before the answer, what after, and what happens when the answer lands on a route that
 * is already gone. Nothing may be offered before the answer — a control shown for 200ms is a
 * control that can be used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSearch } from '../src/app/search-mount.js';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeElement } from './support/analysis-fixtures.js';

const ELEMENT_IDS = ['search-mode', 'search-input', 'search-results', 'search-error'] as const;

interface SearchHarness {
  readonly doc: Document;
  readonly elements: Map<string, FakeElement>;
  readonly client: GambitClient;
  readonly searches: { q: string | null; mode: string | null }[];
  readonly replaced: string[];
  readonly pushed: string[];
  restore(): void;
}

/**
 * @param search - the query string the route is entered with, e.g. `?q=rook&mode=semantic`.
 * @returns the fake document, the recorded search requests, and the history calls.
 */
function harness(search: string): SearchHarness {
  const elements = new Map<string, FakeElement>();
  for (const id of ELEMENT_IDS) elements.set(id, new FakeElement(id));

  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  } as unknown as Document;

  const searches: { q: string | null; mode: string | null }[] = [];
  const transport = new FakeTransport((req) => {
    const url = new URL(req.url, 'https://example.test');
    searches.push({ q: url.searchParams.get('q'), mode: url.searchParams.get('mode') });
    return json(200, { total: 0, results: [] });
  });

  const replaced: string[] = [];
  const pushed: string[] = [];
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  // Choosing a mode calls `navigateToSearchMode`, which pushes state and then dispatches a
  // `popstate` so the router re-runs. Neither global exists under `node --test`.
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalPopState = Object.getOwnPropertyDescriptor(globalThis, 'PopStateEvent');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  });
  Object.defineProperty(globalThis, 'PopStateEvent', {
    configurable: true,
    value: class {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
  });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search } });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
      pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
    },
  });

  return {
    doc,
    elements,
    client: new GambitClient({ baseUrl: 'https://example.test', transport }),
    searches,
    replaced,
    pushed,
    restore(): void {
      if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
      else delete (globalThis as { location?: unknown }).location;
      if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
      else delete (globalThis as { history?: unknown }).history;
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (originalPopState) Object.defineProperty(globalThis, 'PopStateEvent', originalPopState);
      else delete (globalThis as { PopStateEvent?: unknown }).PopStateEvent;
    },
  };
}

/** The mode values currently rendered as radio controls, in order. */
function renderedModes(container: FakeElement): string[] {
  return container.children.map((control) => control.children[0]?.value ?? '');
}

/** The text of whatever empty-state occupies the results panel. */
function resultsText(container: FakeElement): string {
  const walk = (node: FakeElement): string =>
    node.textContent + node.children.map(walk).join(' ');
  return walk(container);
}

const flags = (search: boolean, semanticSearch: boolean): (() => Promise<unknown>) =>
  async () => ({ capabilities: { search, semanticSearch } });

/** A capability answer that never arrives until released, for testing the window before it does. */
function deferredFlags(): { load: () => Promise<unknown>; release: (payload: unknown) => void } {
  let release!: (payload: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { load: () => pending, release };
}

/** Let the flag promise and its `.then` settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('search switched off: no request, no modes, and an honest notice', async () => {
  const h = harness('?q=rook');
  try {
    const controller = mountSearch(h.doc, h.client, flags(false, false));
    await settle();

    assert.deepEqual(
      h.searches,
      [],
      'a request guaranteed to answer 503 must not be sent — the 503 would read as broken',
    );
    const mode = h.elements.get('search-mode');
    const results = h.elements.get('search-results');
    assert.ok(mode);
    assert.ok(results);
    assert.deepEqual(renderedModes(mode), []);
    assert.equal(mode.hidden, true, 'an empty radiogroup is still a radiogroup');
    assert.match(resultsText(results), /unavailable/i);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/**
 * `semanticSearch: true` with `search: false` should not come off a real server — the composition
 * root only builds the semantic pair when keyword search is on. The client asks anyway, because
 * leaning on a server invariant the wire does not state is the habit this increment exists to break.
 */
test('search off outranks semantic on, whatever the server claims', async () => {
  const h = harness('?q=rook&mode=semantic');
  try {
    const controller = mountSearch(h.doc, h.client, flags(false, true));
    await settle();

    assert.deepEqual(h.searches, []);
    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    assert.deepEqual(renderedModes(mode), []);
    controller.dispose();
  } finally {
    h.restore();
  }
});

test('keyword only: the mode it can serve, and a working search', async () => {
  const h = harness('?q=rook');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, false));
    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    assert.deepEqual(renderedModes(mode), [], 'nothing is offered before the answer arrives');

    await settle();
    assert.deepEqual(renderedModes(mode), ['keyword']);
    assert.equal(mode.hidden, false);
    assert.deepEqual(h.searches, [{ q: 'rook', mode: 'keyword' }]);
    controller.dispose();
  } finally {
    h.restore();
  }
});

test('both on: all three modes are offered', async () => {
  const h = harness('?q=rook');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, true));
    await settle();

    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    assert.deepEqual(renderedModes(mode), ['keyword', 'semantic', 'hybrid']);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/**
 * The link someone shared from a deployment that has the mode, opened on one that does not.
 *
 * It must not become a 503, and must not become a back-button destination — hence `replaceState`.
 */
test('a deep link to an unavailable mode searches by keyword and rewrites the URL', async () => {
  const h = harness('?q=rook&mode=semantic');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, false));
    await settle();

    assert.deepEqual(h.searches, [{ q: 'rook', mode: 'keyword' }]);
    assert.deepEqual(h.replaced, ['/search?q=rook']);
    assert.deepEqual(h.pushed, [], 'a mode this deployment cannot serve is not a history entry');

    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    assert.deepEqual(renderedModes(mode), ['keyword']);
    assert.deepEqual(
      mode.children.map((control) => control.children[0]?.checked),
      [true],
      'the surviving mode must be the checked one after the fallback',
    );
    controller.dispose();
  } finally {
    h.restore();
  }
});

test('a deep link to an available mode searches in that mode and leaves the URL alone', async () => {
  const h = harness('?q=rook&mode=semantic');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, true));
    await settle();
    assert.deepEqual(h.searches, [{ q: 'rook', mode: 'semantic' }]);
    assert.deepEqual(h.replaced, []);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/** A deep link with search off must not rewrite the URL either — there is nowhere better to go. */
test('a deep link with search off issues nothing and rewrites nothing', async () => {
  const h = harness('?q=rook&mode=hybrid');
  try {
    const controller = mountSearch(h.doc, h.client, flags(false, false));
    await settle();
    assert.deepEqual(h.searches, []);
    assert.deepEqual(h.replaced, []);
    assert.deepEqual(h.pushed, []);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/**
 * A server predating these flags omits them, and a missing flag reads as off — the rule stated on
 * `analysisEnabled`. The cost is a search box that does nothing on an old server; the alternative is
 * a control whose every request answers 503.
 */
test('missing capability fields fail closed', async () => {
  for (const payload of [{}, { capabilities: {} }, null, { capabilities: { search: 'yes' } }]) {
    const h = harness('?q=rook');
    try {
      const controller = mountSearch(h.doc, h.client, async () => payload);
      await settle();
      assert.deepEqual(h.searches, [], `payload ${JSON.stringify(payload)} must not search`);
      controller.dispose();
    } finally {
      h.restore();
    }
  }
});

/**
 * `bootstrap` re-runs on every SPA navigation, so the flags can resolve after this route is gone.
 * `SearchController.search` refuses on its own after disposal; the renders would not.
 */
test('flags resolving after disposal neither render nor search', async () => {
  const h = harness('?q=rook&mode=hybrid');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, true));
    controller.dispose();
    await settle();

    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    assert.deepEqual(renderedModes(mode), [], 'a torn-down route must not be repainted');
    assert.deepEqual(h.searches, []);
    assert.deepEqual(h.replaced, []);
  } finally {
    h.restore();
  }
});

/** A rejected capabilities request is "not answered", which fails closed like an explicit false. */
test('a failed capability request offers nothing rather than hanging', async () => {
  const h = harness('?q=rook&mode=semantic');
  try {
    const controller = mountSearch(h.doc, h.client, async () => {
      throw new Error('offline');
    });
    await settle();

    assert.deepEqual(h.searches, []);
    assert.deepEqual(h.replaced, []);
    const results = h.elements.get('search-results');
    assert.ok(results);
    assert.match(resultsText(results), /unavailable/i);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/** With search on and no query there is nothing to ask for, but the modes are still offered. */
test('search on with an empty query prompts rather than searching', async () => {
  const h = harness('');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, true));
    await settle();

    assert.deepEqual(h.searches, []);
    const results = h.elements.get('search-results');
    const mode = h.elements.get('search-mode');
    assert.ok(results);
    assert.ok(mode);
    assert.match(resultsText(results), /Search Rookzen/);
    assert.deepEqual(renderedModes(mode), ['keyword', 'semantic', 'hybrid']);
    controller.dispose();
  } finally {
    h.restore();
  }
});

/**
 * A failed capability request is not evidence about how the deployment is configured.
 *
 * `loadCapabilities` turns a failure into `null` and memoises it for the page, so without this
 * distinction one transient outage tells the visitor "this server has search switched off" — a claim
 * about configuration, made on no evidence, standing for the rest of the visit. Raised by the Qodo
 * review of PR #155. Both still fail closed; only the sentence differs.
 */
test('an explicit search: false and an unanswered request say different things', async () => {
  const off = harness('?q=rook');
  try {
    const controller = mountSearch(off.doc, off.client, flags(false, false));
    await settle();
    const results = off.elements.get('search-results');
    assert.ok(results);
    assert.match(resultsText(results), /switched off/i);
    controller.dispose();
  } finally {
    off.restore();
  }

  for (const payload of [null, {}, { capabilities: {} }] as const) {
    const unknown = harness('?q=rook');
    try {
      const controller = mountSearch(unknown.doc, unknown.client, async () => payload);
      await settle();
      const results = unknown.elements.get('search-results');
      assert.ok(results);
      assert.doesNotMatch(
        resultsText(results),
        /switched off/i,
        `payload ${JSON.stringify(payload)} is not the server saying search is off`,
      );
      assert.match(resultsText(results), /could not check/i);
      assert.deepEqual(unknown.searches, [], 'and it still fails closed');
      controller.dispose();
    } finally {
      unknown.restore();
    }
  }
});

/**
 * Results belong to the query that produced them.
 *
 * Every path now waits for the capability answer before rendering anything, so hits from the
 * previous query would sit under the new URL for as long as that takes — and on a deployment with
 * search off, above a notice saying there is no search. Raised by the CodeRabbit review of PR #155;
 * the delay is what makes the window observable.
 */
test('a new mount clears the previous query results before the flags settle', async () => {
  const first = harness('?q=rook');
  try {
    const controller = mountSearch(first.doc, first.client, flags(true, false));
    await settle();
    controller.dispose();
  } finally {
    first.restore();
  }

  const results = first.elements.get('search-results');
  assert.ok(results);
  results.innerHTML = 'stale';
  results.children = [new FakeElement('previous-hit')];

  const second = harness('?q=bishop');
  try {
    const deferred = deferredFlags();
    // Same elements, as on an SPA navigation: `bootstrap` re-mounts the route over the same DOM.
    const controller = mountSearch(
      { getElementById: (id: string) => first.elements.get(id) ?? null, createElement: () => new FakeElement() } as unknown as Document,
      second.client,
      deferred.load,
    );

    assert.equal(results.innerHTML, '', 'the previous query results must be gone immediately');
    assert.deepEqual(results.children, []);

    deferred.release({ capabilities: { search: true, semanticSearch: false } });
    await settle();
    controller.dispose();
  } finally {
    second.restore();
  }
});

/**
 * Choosing a mode carries the term the visitor has typed, not the one the route mounted with.
 *
 * `createModeInput` used to close over the query captured at mount. Type a new term into the header
 * box, click **Semantic** without pressing enter, and the navigation carried the old term while the
 * remount reset the box to match it — the typed text was gone, with no indication it had been
 * discarded. Found by the adversarial review of PR #155 and tracked from M15 Increment 24.
 *
 * The mount-time value is still the fallback, for a document with no header input at all.
 */
test('changing mode uses the query typed since mount, not the one it mounted with', async () => {
  const h = harness('?q=rook');
  try {
    const controller = mountSearch(h.doc, h.client, flags(true, true));
    await settle();

    const input = h.elements.get('search-input');
    const mode = h.elements.get('search-mode');
    assert.ok(input);
    assert.ok(mode);
    assert.equal(input.value, 'rook', 'the mount seeds the box from the URL');

    // The visitor edits the box and picks a mode without pressing enter.
    input.value = '  bishop  ';
    const semantic = mode.children[1]?.children[0];
    assert.ok(semantic, 'semantic must be the second rendered mode');
    semantic.checked = true;
    for (const fire of semantic.listeners['change'] ?? []) fire(new Event('change'));

    assert.deepEqual(
      h.pushed,
      ['/search?q=bishop&mode=semantic'],
      'the mode change must carry the typed term, trimmed, exactly as pressing enter would',
    );
    controller.dispose();
  } finally {
    h.restore();
  }
});

/** With no header input in the document, the mount-time query is still what a mode change carries. */
test('changing mode falls back to the mounted query when there is no input element', async () => {
  const h = harness('?q=rook');
  try {
    const docWithoutInput = {
      getElementById: (id: string) => (id === 'search-input' ? null : h.elements.get(id) ?? null),
      createElement: () => new FakeElement(),
    } as unknown as Document;

    const controller = mountSearch(docWithoutInput, h.client, flags(true, true));
    await settle();

    const mode = h.elements.get('search-mode');
    assert.ok(mode);
    const hybrid = mode.children[2]?.children[0];
    assert.ok(hybrid);
    hybrid.checked = true;
    for (const fire of hybrid.listeners['change'] ?? []) fire(new Event('change'));

    assert.deepEqual(h.pushed, ['/search?q=rook&mode=hybrid']);
    controller.dispose();
  } finally {
    h.restore();
  }
});
