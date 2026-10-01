/**
 * The opening section in the game sidebar: request shape, rendering, and the lifetime rules the
 * panel's DOM forces on it.
 *
 * That DOM lives in `index.html` and outlives any single mount, so a section left populated by the
 * last game is still on screen when the next one mounts. The reset-on-mount test below is the one
 * that catches that, and it is the same failure mode the tactic block was fixed for.
 *
 * The capability-off case lives in `opening-capability-gate.test.ts` instead: `loadCapabilities`
 * memoises per module, so a second payload in this file would never be fetched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import type { OpeningExplorationResponse } from '../src/api/models.js';
import { AsyncTransport, createGameDocument, makeState } from './support/analysis-fixtures.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const UCI = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
const SAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
const LEDGER = UCI.map((uci, index) => ({
  ply: index + 1,
  uci,
  san: SAN[index]!,
  by: (index % 2 === 0 ? 'w' : 'b') as 'w' | 'b',
}));

const RUY_LOPEZ: OpeningExplorationResponse = {
  moves: UCI,
  found: true,
  eco: 'C60',
  name: 'Ruy Lopez (Spanish Opening)',
  matchedMoves: 5,
  outOfBook: false,
  continuations: [
    { move: 'a7a6', san: 'a6', eco: 'C70', name: 'Ruy Lopez, Morphy Defense' },
    { move: 'd7d6', san: null, eco: 'C62', name: null },
  ],
};

/**
 * Mount the game route against a fake socket and the given transport.
 *
 * @param transport - answers `/v1/capabilities` and `/v1/openings/explore`.
 * @returns the mounted route plus the element map standing in for the page.
 */
function setup(transport: HttpTransport) {
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  app.api.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });
  return { sockets, elements, mounted, app, doc };
}

/**
 * `analysis: false` on purpose. This deployment has no engine, and the opening section must still
 * appear — it is the claim the whole increment rests on (ADR-0127), and every other block in the
 * sidebar sits behind the engine gate that this one is deliberately in front of.
 */
function capabilities(): HttpResponse {
  return json(200, {
    capabilities: { analysis: false, openingExplorer: true },
    analysisVariants: [],
    puzzleVariants: [],
  });
}

/**
 * Deliver an authoritative snapshot, which is what supplies the variant and the move ledger.
 *
 * @param sockets - the fake socket factory.
 * @param ledger - the move ledger; the opening feature reads this rather than the FEN.
 */
function join(sockets: FakeSocketFactory, ledger = LEDGER): void {
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState(FEN, ledger.length, 'w', ledger),
  });
}

/**
 * Dispose everything the mount owns.
 *
 * @param mounted - the mounted route.
 * @param app - the composed app.
 */
function cleanup(mounted: ReturnType<typeof mountGame>, app: ReturnType<typeof createApp>): void {
  mounted.analysis.dispose();
  mounted.connectivity.dispose();
  mounted.controller.dispose();
  app.dispose();
}

/**
 * @param el - a container from the fake DOM.
 * @returns its text with descendants flattened, so an assertion reads what a person would see
 * rather than the element tree that produced it.
 */
function renderedText(el: { children: Array<{ textContent: string; children: unknown[] }> }): string {
  const walk = (node: { textContent: string; children: unknown[] }): string =>
    `${node.textContent}${node.children.map((child) => walk(child as typeof node)).join('')}`;
  return el.children.map((child) => walk(child)).join(' ');
}

/** @returns a promise resolving after the microtask queue drains, so pending renders have run. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

test('Identify opening sends the game ledger, coalesces repeat clicks, and renders the book fields', async () => {
  let resolveOpening: ((response: HttpResponse) => void) | undefined;
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) {
      return new Promise<HttpResponse>((resolve) => { resolveOpening = resolve; });
    }
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets);
    assert.equal(
      elements.get('opening')!.hidden,
      false,
      'revealed on a deployment with no engine at all',
    );
    assert.equal(
      elements.get('analysis')!.hidden,
      true,
      'while the engine panel beside it stays hidden, which is the point of the separation',
    );

    const button = elements.get('opening-run')!;
    button.click();
    button.click();
    await Promise.resolve();
    assert.equal(button.disabled, true);
    assert.equal(elements.get('opening-note')!.textContent, 'Looking up the opening…');

    const requests = transport.calls.filter((request) => request.url.endsWith('/v1/openings/explore'));
    assert.equal(requests.length, 1, 'a repeat click must not start a second look-up');
    assert.deepEqual(JSON.parse(String(requests[0]!.body)), { variant: 'standard', moves: UCI });

    resolveOpening?.(json(200, RUY_LOPEZ));
    await settled();

    assert.equal(elements.get('opening-result')!.hidden, false);
    const text = renderedText(elements.get('opening-rows')!);
    assert.match(text, /OpeningRuy Lopez \(Spanish Opening\)/);
    assert.match(text, /ECOC60/);
    assert.match(text, /Book depth5 plies/);
    assert.match(text, /PositionIn book/);
    assert.match(text, /a6Ruy Lopez, Morphy Defense/, 'a continuation with SAN shows the SAN');
    assert.match(text, /d7d6C62/, 'one without falls back to the UCI, and to its ECO for a name');
  } finally {
    cleanup(mounted, app);
  }
});

/**
 * No statistic reaches the page, asserted on the rendered rows rather than on the response.
 *
 * The server publishes no field for one (ADR-0127), so this guards the other direction: a view that
 * started deriving a "popularity" or "score" row from what it does receive.
 */
test('the rendered rows carry only the fields the server sent, and no statistic', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) return json(200, RUY_LOPEZ);
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets);
    elements.get('opening-run')!.click();
    await settled();

    const labels = elements.get('opening-rows')!.children.map(
      (row) => (row.children[0] as { textContent: string }).textContent,
    );
    assert.deepEqual(labels, ['Opening', 'ECO', 'Book depth', 'Position', 'a6', 'd7d6']);
    assert.doesNotMatch(
      renderedText(elements.get('opening-rows')!),
      /games|win|draw rate|popularity|%/i,
    );
  } finally {
    cleanup(mounted, app);
  }
});

test('an unmatched move order renders the no-opening message and no rows', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) {
      return json(200, {
        moves: UCI,
        found: false,
        eco: null,
        name: null,
        matchedMoves: 0,
        outOfBook: false,
        continuations: [],
      });
    }
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets);
    elements.get('opening-run')!.click();
    await settled();

    assert.equal(elements.get('opening-result')!.hidden, true);
    assert.equal(elements.get('opening-rows')!.children.length, 0);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'No known opening matches this move order.',
    );
  } finally {
    cleanup(mounted, app);
  }
});

/**
 * A game whose ledger does not start at ply 1 has no identifiable move order.
 *
 * `GameController.moveSequence` answers `null` there, and the control must decline rather than send
 * a sequence that would name an opening for moves never played in that order.
 */
test('a ledger that does not begin at ply 1 disables the control and says why', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets, LEDGER.map((move) => ({ ...move, ply: move.ply + 4 })));
    assert.equal(elements.get('opening-run')!.disabled, true);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'The full move order for this game is not available.',
    );
    elements.get('opening-run')!.click();
    await settled();
    assert.equal(
      transport.calls.filter((request) => request.url.endsWith('/v1/openings/explore')).length,
      0,
      'and nothing is sent even if the disabled control is activated anyway',
    );
  } finally {
    cleanup(mounted, app);
  }
});

/** The panel's DOM outlives the mount, so a second mount must not inherit the first game's opening. */
test('a remount clears an opening left on screen by the previous game', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) return json(200, RUY_LOPEZ);
    return json(200, {});
  });
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  app.api.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const { doc, elements } = createGameDocument();
  const mount = (): ReturnType<typeof mountGame> => mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  const first = mount();
  try {
    await settled();
    join(sockets);
    elements.get('opening-run')!.click();
    await settled();
    assert.ok(elements.get('opening-rows')!.children.length > 0, 'the first game left rows behind');
  } finally {
    first.analysis.dispose();
    first.connectivity.dispose();
    first.controller.dispose();
  }

  const second = mount();
  try {
    assert.equal(elements.get('opening-rows')!.children.length, 0);
    assert.equal(elements.get('opening-result')!.hidden, true);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'Identify the opening played in this game.',
    );
  } finally {
    second.analysis.dispose();
    second.connectivity.dispose();
    second.controller.dispose();
    app.dispose();
  }
});

/**
 * Past the ceiling is a different message from no ledger at all.
 *
 * Both leave the control unusable, but one says the game has left the opening behind and the other
 * says its move order could not be recovered. Reporting the second for the first would be wrong
 * about what happened.
 */
test('a game past the server ceiling says it left the opening, not that the moves are missing', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    const long = Array.from({ length: 61 }, (_, index) => ({
      ply: index + 1,
      uci: 'e2e4',
      san: 'e4',
      by: (index % 2 === 0 ? 'w' : 'b') as 'w' | 'b',
    }));
    join(sockets, long);
    assert.equal(elements.get('opening-run')!.disabled, true);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'This game is past the opening phase the book covers.',
    );
  } finally {
    cleanup(mounted, app);
  }
});

/**
 * A ledger that grows past the ceiling while a result is on screen must take the result down.
 *
 * `openingTarget()` returns null there, and the earlier wiring skipped `sequenceChanged` on a null
 * target — so the rendered opening kept describing a move order the game had left, and the note was
 * not corrected because a result note is not one the block owns. Raised in the Qodo and CodeRabbit
 * reviews of PR #150.
 */
test('a result is taken down when the game grows past the ceiling', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) return json(200, RUY_LOPEZ);
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets);
    elements.get('opening-run')!.click();
    await settled();
    assert.ok(elements.get('opening-rows')!.children.length > 0, 'a result is on screen');

    const long = Array.from({ length: 61 }, (_, index) => ({
      ply: index + 1,
      uci: index < 5 ? UCI[index]! : 'a2a3',
      san: index < 5 ? SAN[index]! : 'a3',
      by: (index % 2 === 0 ? 'w' : 'b') as 'w' | 'b',
    }));
    sockets.last.emit({
      t: 'joined',
      gameId: 'g-test-1',
      role: 'white',
      state: makeState('8/8/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 31', long.length, 'b', long),
    });
    await settled();

    assert.equal(elements.get('opening-rows')!.children.length, 0, 'the stale result is gone');
    assert.equal(elements.get('opening-result')!.hidden, true);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'The game has moved on. Identify again.',
    );
  } finally {
    cleanup(mounted, app);
  }
});

/** A game at its start has nothing to identify, and the answer is known without asking. */
test('a game with no moves yet disables the control instead of asking for a known no-match', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets, []);
    assert.equal(elements.get('opening-run')!.disabled, true);
    assert.equal(elements.get('opening-note')!.textContent, 'No moves have been played yet.');
    elements.get('opening-run')!.click();
    await settled();
    assert.equal(
      transport.calls.filter((request) => request.url.endsWith('/v1/openings/explore')).length,
      0,
    );
  } finally {
    cleanup(mounted, app);
  }
});

/**
 * The section is revealed by capability, so a remount must put it back to hidden first.
 *
 * `loadCapabilities` memoises and can resolve to `null`, in which case nothing reveals *or* hides
 * it — and a section revealed by an earlier game would sit there on a deployment that never said it
 * offered the feature.
 */
test('a remount re-hides the section before the capability has spoken', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    return json(200, {});
  });
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  const { doc, elements } = createGameDocument();
  const mount = (): ReturnType<typeof mountGame> => mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  const first = mount();
  await settled();
  assert.equal(elements.get('opening')!.hidden, false, 'the capability revealed it once');
  first.analysis.dispose();
  first.connectivity.dispose();
  first.controller.dispose();

  const second = mount();
  try {
    assert.equal(
      elements.get('opening')!.hidden,
      true,
      'and the next mount starts hidden rather than inheriting that reveal',
    );
  } finally {
    second.analysis.dispose();
    second.connectivity.dispose();
    second.controller.dispose();
    app.dispose();
  }
});

/**
 * Signing in has to reach this control too.
 *
 * The route refreshes analysis, explain, assess and puzzle on every authentication transition; an
 * omission here left Identify opening disabled under a stale signed-out note until some unrelated
 * game event happened to refresh it. That is the same defect the comment beside `onSessionChange`
 * records being raised on PR #135 for Explain — raised again here by Qodo on PR #150.
 */
test('signing in enables the control without waiting for an unrelated game event', async () => {
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    return json(200, {});
  });
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  const { doc, elements } = createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });
  try {
    await settled();
    join(sockets);
    assert.equal(elements.get('opening-run')!.disabled, true);
    assert.equal(elements.get('opening-note')!.textContent, 'Sign in to identify openings.');

    app.api.session.adopt({
      user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
      tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
    });
    mounted.onSessionChange({ userId: 'u1', handle: 'alice', accessToken: 'token' } as never);

    assert.equal(elements.get('opening-run')!.disabled, false);
    assert.equal(
      elements.get('opening-note')!.textContent,
      'Identify the opening played in this game.',
    );
  } finally {
    mounted.analysis.dispose();
    mounted.connectivity.dispose();
    mounted.controller.dispose();
    app.dispose();
  }
});

/**
 * The mount-level disposer reaches the opening controller.
 *
 * `cleanup` in this file disposes through `mounted.analysis`, which is the route's disposable for
 * every sidebar controller — the game controller's own `dispose()` only stops the sync. If the
 * opening controller were ever dropped from that list, a late response would render into a disposed
 * mount and leak across tests, so this pins the wiring rather than trusting the ordering.
 *
 * Raised as a finding in the CodeRabbit review of PR #150, on the premise that `cleanup` did not
 * dispose the controller. It does, through the same disposer the finding recommends; this is the
 * evidence.
 */
test('disposing the mount aborts an in-flight opening look-up', async () => {
  let openingSignal: AbortSignal | undefined;
  const transport = new AsyncTransport((request: HttpRequest) => {
    if (request.url.endsWith('/v1/capabilities')) return capabilities();
    if (request.url.endsWith('/v1/openings/explore')) {
      openingSignal = request.signal;
      return new Promise<HttpResponse>(() => undefined);
    }
    return json(200, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    await settled();
    join(sockets);
    elements.get('opening-run')!.click();
    await Promise.resolve();
    assert.ok(openingSignal, 'the look-up is open and carries a signal');
    assert.equal(openingSignal.aborted, false);

    mounted.analysis.dispose();
    assert.equal(openingSignal.aborted, true, 'the mount disposer reaches this controller');
  } finally {
    mounted.connectivity.dispose();
    mounted.controller.dispose();
    app.dispose();
  }
});
