/**
 * The coaching section in the game sidebar: what it renders, and what it must never render.
 *
 * The two leak tests are the point of the file. The server withholds the endgame solution and the
 * tactic's move, and the UI is the last place either could reappear — a "show solution" affordance,
 * a stray field rendered from a section value, an evaluation invented for a section that has none.
 * Asserting over every rendered character rather than over a field list is deliberate: a field added
 * later is one nobody would have thought to name here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import type { CoachResponse } from '../src/api/models.js';
import { AsyncTransport, createGameDocument, makeState } from './support/analysis-fixtures.js';
import type { FakeElement } from './support/analysis-fixtures.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const UCI = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
const SAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
const LEDGER = UCI.map((uci, index) => ({
  ply: index + 1,
  uci,
  san: SAN[index]!,
  by: (index % 2 === 0 ? 'w' : 'b') as 'w' | 'b',
}));

/**
 * A response carrying the two sections that withhold something, both present.
 *
 * The values are the ones a real server would send: a tactic with a difficulty and no solution, and
 * a catalogue endgame with its objective and no mate distance.
 */
const COACHED: CoachResponse = {
  fen: FEN,
  variant: 'standard',
  move: null,
  mistake: { kind: 'omitted', reason: 'not_requested' },
  explanation: { kind: 'omitted', reason: 'unsupported' },
  opening: { kind: 'omitted', reason: 'not_applicable' },
  puzzle: {
    kind: 'present',
    value: { kind: 'puzzle', fen: FEN, variant: 'standard', difficulty: 'hard' },
  },
  endgame: {
    kind: 'present',
    value: {
      id: 'lucena-01',
      type: 'Lucena',
      name: 'Lucena position',
      fen: FEN,
      sideToMove: 'w',
      objective: 'win',
      difficulty: 'advanced',
      technique: 'Build a bridge with the rook',
    },
  },
  featuresFired: ['puzzleGeneration', 'endgameTraining'],
};

/**
 * @param el - a rows container.
 * @returns every character rendered under it, labels and values alike, so a leak into either column
 * is visible to an assertion.
 */
function allText(el: FakeElement): string {
  /**
   * @param node - a node in the fake tree.
   * @returns its own text plus every descendant's, so a leak into any cell is visible.
   */
  const walk = (node: { textContent: string; children: unknown[] }): string =>
    `${node.textContent} ${node.children.map((c) => walk(c as typeof node)).join(' ')}`;
  return walk(el as unknown as { textContent: string; children: unknown[] });
}

/**
 * Mount the game route against a fake socket and the given transport.
 *
 * @param transport - answers `/v1/capabilities` and `/v1/coach`.
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

/** `analysis: false`, to prove the section is gated on `coach` and not on the engine. */
function capabilities(): HttpResponse {
  return json(200, {
    capabilities: { analysis: false, coach: true },
    analysisVariants: [],
    puzzleVariants: [],
  });
}

/**
 * Deliver an authoritative snapshot, which is what supplies the variant and the move ledger.
 *
 * @param sockets - the fake socket factory.
 * @param ledger - the move ledger the coaching request reads its sequence from.
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
function teardown(mounted: ReturnType<typeof setup>['mounted'], app: ReturnType<typeof setup>['app']): void {
  mounted.analysis.dispose();
  mounted.connectivity.dispose();
  mounted.controller.dispose();
  app.dispose();
}

/** @returns a promise resolving once the microtask queue has drained and renders have run. */
const settled = (): Promise<void> =>
  new Promise<void>((done) => { setTimeout(done, 0); });

test('a coached tactic says one is there and never says what it is', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) return json(200, COACHED);
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();
    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();

    const rendered = allText(elements.get('coach-rows')!);
    assert.match(rendered, /Tactic/);
    assert.match(rendered, /Hard/i, 'the difficulty is the coaching signal and should be shown');

    // No solution, and no affordance implying one is a click away. `f1b5` is a move from the
    // ledger; nothing in this section should be able to name a move at all.
    assert.doesNotMatch(rendered, /solution|best move|show me|reveal|answer/i);
    assert.equal(rendered.includes('f1b5'), false);
  } finally {
    teardown(mounted, app);
  }
});

test('a coached endgame names the position and withholds the way to win it', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) return json(200, COACHED);
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();
    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();

    const rendered = allText(elements.get('coach-rows')!);
    assert.match(rendered, /Lucena position/);
    assert.match(rendered, /Build a bridge/);

    // The technique is a hint; a solution, a mate distance or an evaluation is the answer.
    assert.doesNotMatch(rendered, /solution|mate in|centipawn|\bdepth\b|principal|\beval\b/i);
  } finally {
    teardown(mounted, app);
  }
});

test('an omitted section says why, and distinguishes "not offered" from "nothing to say"', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) return json(200, COACHED);
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();
    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();

    const rendered = allText(elements.get('coach-rows')!);
    // `explanation` is `unsupported` and `opening` is `not_applicable`; the two must not read the
    // same, because only one of them might change if the reader comes back later.
    assert.match(rendered, /Not available on this server/i);
    assert.match(rendered, /Nothing to say here/i);
  } finally {
    teardown(mounted, app);
  }
});

test('a section the reader did not ask for is absent rather than explained away', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) return json(200, COACHED);
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();
    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();

    const rendered = allText(elements.get('coach-rows')!);
    // A positive control first. Without it this test passes on a page that rendered nothing at all —
    // a click handler that never fired would satisfy the absence assertion below perfectly.
    assert.match(rendered, /Lucena position/, 'nothing rendered, so the absence proves nothing');

    // `mistake` is `not_requested`. Rendering a row for it would spend space explaining that the
    // reader did not ask a question, above the sections that answer the ones they did.
    assert.doesNotMatch(rendered, /Move assessment/i);
  } finally {
    teardown(mounted, app);
  }
});

test('the section is offered on a deployment with no engine at all', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();

    // `analysis: false`, and the section is still there — coaching can identify an opening with no
    // engine, and gating it behind the engine would hide a feature that works.
    assert.equal(elements.get('coach')!.hidden, false);
  } finally {
    teardown(mounted, app);
  }
});

test('the move is sent with the position it was played from, not the one it produced', async () => {
  // The request body itself is the assertion. Every other test here stubs the transport and returns
  // a canned 200 regardless of what was sent, so a body the real server would refuse looked exactly
  // like one it would accept — which is how a request that answered 422 for every coached move
  // passed a green suite. Raised in the adversarial review of PR #152.
  const bodies: Array<Record<string, unknown>> = [];
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) {
      bodies.push(JSON.parse(req.body as string) as Record<string, unknown>);
      return json(200, COACHED);
    }
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    // Join at the start position, then play a move over the wire. A replayed move is the only way
    // `lastReplayedMove` becomes non-null — an authoritative snapshot has nothing after it to
    // replay — and it is the case the whole pairing bug lives in.
    sockets.last.open();
    sockets.last.emit({
      t: 'joined',
      gameId: 'g-test-1',
      role: 'white',
      state: makeState(FEN, 0, 'w'),
    });
    sockets.last.emit({
      t: 'move', gameId: 'g-test-1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
      fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {},
    });
    await settled();

    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();

    assert.equal(bodies.length, 1);
    const body = bodies[0]!;
    assert.equal(body['move'], 'e2e4');
    // The position `e2e4` was played *from* is the start position. Sending the position it produced
    // would ask the server to play it a second time, which is illegal and answers 422.
    assert.equal(
      body['fen'],
      FEN,
      'the position after the move was sent alongside the move itself',
    );

    // And the body carries nothing the server would reject as an unknown field.
    for (const key of Object.keys(body)) {
      assert.ok(
        ['fen', 'variant', 'move', 'moves'].includes(key),
        `the request carried "${key}", which the server refuses`,
      );
    }
  } finally {
    teardown(mounted, app);
  }
});

test('signing out clears the coaching on screen, not just the button', async () => {
  const transport = new AsyncTransport((req: HttpRequest) => {
    if (req.url.endsWith('/v1/capabilities')) return capabilities();
    if (req.url.endsWith('/v1/coach')) return json(200, COACHED);
    return json(404, {});
  });
  const { sockets, elements, mounted, app } = setup(transport);
  try {
    join(sockets);
    await settled();
    (elements.get('coach-run') as unknown as { click: () => void }).click();
    await settled();
    await settled();
    assert.match(allText(elements.get('coach-rows')!), /Lucena position/);

    // Sign out. Refreshing the controls alone left the advice rendered beside a disabled button and
    // a signed-out note — the page saying two contradictory things, with one session's answer still
    // in front of whoever is there now. Raised in the Qodo review of PR #152.
    app.api.session.reset();
    // Bootstrap is what tells a mounted route the session changed; calling the hook directly is
    // what it does.
    mounted.onSessionChange(null);
    await settled();

    assert.doesNotMatch(
      allText(elements.get('coach-rows')!),
      /Lucena position/,
      'the previous session\'s coaching survived sign-out',
    );
  } finally {
    teardown(mounted, app);
  }
});
