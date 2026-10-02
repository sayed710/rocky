/**
 * The Assess-last-move control, driven through the real mount, the real controller and the real
 * client against a fake transport (ADR-0118).
 *
 * Deliberately the same harness as `explain-mount.test.ts`: the two controls sit in one panel and
 * share a target, a lifecycle and a capability payload, so testing them the same way is what makes a
 * divergence between them visible.
 *
 * `explain-capability-gate.test.ts` records why the capability-off case needs its own file:
 * `loadCapabilities` memoises per process with no reset seam, so the first payload fetched in a file
 * is the one every later test in that file sees. `assess-capability-gate.test.ts` exists for the
 * same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import type { MistakePredictionResponse } from '../src/api/models.js';
import { createGameDocument, makeState } from './support/analysis-fixtures.js';
import type { FakeElement } from './support/analysis-fixtures.js';

/**
 * The text a rendered element actually shows.
 *
 * `FakeElement.innerHTML` is a plain string that `appendChild` does not update, so asserting on it
 * would pass for an empty element. Walking the children is what the DOM would show.
 */
function renderedText(el: FakeElement): string {
  const parts: string[] = [];
  const walk = (node: FakeElement): void => {
    if (node.textContent) parts.push(node.textContent);
    for (const child of node.children) walk(child);
  };
  for (const child of el.children) walk(child);
  return parts.join(' ');
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function verdict(overrides: Partial<MistakePredictionResponse> = {}): MistakePredictionResponse {
  return {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    classification: 'mistake',
    before: { evalKind: 'cp', evalValue: 150, evalLabel: '+1.50' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: -20, evalLabel: '-0.20' },
    centipawnLoss: 170,
    bestMove: 'd2d4',
    bestLine: ['d2d4', 'd7d5'],
    depth: 16,
    ...overrides,
  };
}

function setup(opts?: {
  mistakePrediction?: boolean;
  analysisVariants?: readonly string[];
  onAssess?: (req: HttpRequest) => unknown;
  signedIn?: boolean;
  /**
   * Mount into an existing document instead of a fresh one.
   *
   * The panel DOM lives in `index.html` and outlives any single mount, so a remount in the browser
   * binds to the *same* button element the previous mount bound to. A test that builds a new
   * document per mount cannot observe a leaked listener at all — the second mount is clicking a
   * different element. This is what makes the remount test able to fail.
   */
  shared?: { readonly doc: Document; readonly elements: Map<string, FakeElement> };
}) {
  const sockets = new FakeSocketFactory();
  const requests: HttpRequest[] = [];

  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, {
        capabilities: {
          analysis: true,
          // Off on purpose in most of this file: assessment must not depend on it, and a deployment
          // with an engine and no AI provider is the case that proves it.
          moveExplanation: false,
          mistakePrediction: opts?.mistakePrediction ?? true,
        },
        analysisVariants: opts?.analysisVariants ?? ['standard'],
      });
    }
    if (req.url.includes('/v1/analysis/mistake-prediction')) {
      requests.push(req);
      const custom = opts?.onAssess?.(req);
      return (custom as ReturnType<typeof json> | undefined) ?? json(200, verdict());
    }
    return json(200, {});
  });

  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  if (opts?.signedIn !== false) {
    app.api.session.adopt({
      user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
      tokens: {
        accessToken: 'tok-123',
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshExpiresAt: '2030-01-01T00:00:00Z',
      },
    });
  }

  const { doc, elements } = opts?.shared ?? createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId: 'g-test-1',
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'test-token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  return { sockets, elements, mounted, requests, app };
}

/** Join, then deliver one live move so the controller replays it and can assess it. */
function joinAndPlay(sockets: FakeSocketFactory, uci: string): void {
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState(START_FEN, 0, 'w'),
  });
  sockets.last.emit({
    t: 'move', gameId: 'g-test-1', ply: 1, uci, san: uci, by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {},
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Dispose everything the mount owns.
 *
 * `controller` is the one that is easy to forget and the one that matters: it owns the GameSync
 * reconnect timers and a 100 ms clock interval, so a test that disposes only the analysis and
 * connectivity handles leaves the event loop alive and the whole file hangs after its last
 * assertion passes. Every test here routes through this rather than listing two of the three.
 */
function teardown(mounted: {
  readonly analysis: { dispose: () => void };
  readonly connectivity: { dispose: () => void };
  readonly controller: { dispose: () => void };
}): void {
  mounted.analysis.dispose();
  mounted.controller.dispose();
  mounted.connectivity.dispose();
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test('the block is offered on a deployment with an engine and no AI provider', async () => {
  const { elements, mounted } = setup();
  await tick();
  // The whole point of dropping the provider call: this control does not go dark with the AI.
  assert.equal(elements.get('assess')!.hidden, false, 'assess is offered');
  assert.equal(elements.get('explain')!.hidden, true, 'while explain, which needs a provider, is not');
  teardown(mounted);
});

test('the control is disabled until a move has actually been replayed', async () => {
  const { sockets, elements, mounted } = setup();
  await tick();
  assert.equal(elements.get('assess-run')!.disabled, true, 'nothing to assess yet');
  assert.equal(elements.get('assess-note')!.textContent, 'No move to assess yet.');

  joinAndPlay(sockets, 'e2e4');
  await tick();
  assert.equal(elements.get('assess-run')!.disabled, false);
  assert.equal(elements.get('assess-note')!.textContent, 'Assess the last move played.');

  teardown(mounted);
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('assessing sends the position before the move, not the position after it', async () => {
  const { sockets, elements, mounted, requests } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();

  elements.get('assess-run')!.click();
  await tick();

  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body['fen'], START_FEN, 'the position the move was played from');
  assert.equal(body['move'], 'e2e4');
  assert.equal(body['variant'], 'standard');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['fen', 'move', 'variant'],
    'no threshold, depth or provider field is sent — none exists',
  );

  teardown(mounted);
});

test('a promotion keeps its suffix in the assessed move', async () => {
  const { sockets, elements, mounted, requests } = setup();
  await tick();
  // `onLastMove` deliberately keeps only the two squares because a highlight needs no more, and
  // reusing that is the obvious way to build this. `e7e8q` and `e7e8n` are different moves, and a
  // bare `e7e8` is not legal UCI at all.
  joinAndPlay(sockets, 'e7e8q');
  await tick();

  elements.get('assess-run')!.click();
  await tick();

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body['move'], 'e7e8q');

  teardown(mounted);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('the verdict renders classification, the swing, and the engine move', async () => {
  const { sockets, elements, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  elements.get('assess-run')!.click();
  await tick();

  const rows = renderedText(elements.get('assess-rows')!);
  assert.match(rows, /Mistake/, 'the classification is a word');
  assert.match(rows, /−1\.70|-1\.70/, 'a 170 cp loss reads as a 1.70 pawn cost');
  assert.match(rows, /e2e4/);
  assert.match(rows, /-0\.20/, 'what the move achieved');
  assert.match(rows, /Engine prefers d2d4/);
  assert.match(rows, /\+1\.50/, 'what the engine move achieves');
  assert.equal(elements.get('assess-result')!.hidden, false);

  teardown(mounted);
});

test('the engine row is omitted when the player found the engine move', async () => {
  const { sockets, elements, mounted } = setup({
    onAssess: () =>
      json(200, verdict({ classification: 'ok', bestMove: 'e2e4', centipawnLoss: 0 })),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  elements.get('assess-run')!.click();
  await tick();

  const rows = renderedText(elements.get('assess-rows')!);
  assert.match(rows, /Good move/);
  assert.equal(/Engine prefers/.test(rows), false, 'no row saying it prefers the move just played');

  teardown(mounted);
});

test('a checkmating move renders its result, never an evaluation', async () => {
  const { sockets, elements, mounted } = setup({
    onAssess: () =>
      json(
        200,
        verdict({
          classification: 'ok',
          centipawnLoss: null,
          after: {
            kind: 'terminal',
            reason: 'checkmate',
            result: '1-0',
            label: 'checkmate — White wins',
          },
          bestMove: 'e2e4',
        }),
      ),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  elements.get('assess-run')!.click();
  await tick();

  const rows = renderedText(elements.get('assess-rows')!);
  assert.match(rows, /checkmate — White wins/);
  assert.match(rows, /Good move/, 'delivering mate is not a blunder');
  // The regression that produced this whole increment: a decided position has no evaluation, and
  // showing one — in particular a level one — is the opposite of the truth (ADR-0116).
  assert.equal(/\+0\.00/.test(rows), false, 'no fabricated evaluation for a finished game');
  assert.match(rows, /—/, 'and no fabricated centipawn loss either');

  teardown(mounted);
});

test('every classification is legible as text, whatever the styling does', async () => {
  for (const [classification, word] of [
    ['ok', 'Good move'],
    ['inaccuracy', 'Inaccuracy'],
    ['mistake', 'Mistake'],
    ['blunder', 'Blunder'],
  ] as const) {
    const { sockets, elements, mounted } = setup({
      onAssess: () => json(200, verdict({ classification })),
    });
    await tick();
    joinAndPlay(sockets, 'e2e4');
    await tick();
    elements.get('assess-run')!.click();
    await tick();

    // DESIGN.md settles this: achievement tiers render as words rather than three metals, because a
    // one-accent system cannot grow a second, third and fourth, and meaning in hue alone fails
    // colourblind readers. The severity of a move is the same shape of problem.
    assert.match(renderedText(elements.get('assess-rows')!), new RegExp(word));

    teardown(mounted);
  }
});
// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

for (const [status, note, isError] of [
  [429, 'Too many assessments. Try again shortly.', false],
  [503, 'Move assessment is unavailable right now.', false],
  [422, 'This position cannot be assessed.', true],
] as const) {
  test(`a ${status} response explains itself without showing anything from the server`, async () => {
    const { sockets, elements, mounted } = setup({
      onAssess: () =>
        json(status, {
          error: { code: 'x', message: 'engine /usr/local/bin/stockfish-16 exploded' },
        }),
    });
    await tick();
    joinAndPlay(sockets, 'e2e4');
    await tick();
    elements.get('assess-run')!.click();
    await tick();

    const target = isError ? elements.get('assess-error')! : elements.get('assess-note')!;
    assert.equal(target.textContent, note);
    const shown = `${elements.get('assess-note')!.textContent}${elements.get('assess-error')!.textContent}`;
    assert.equal(shown.includes('stockfish'), false, 'nothing the server said reaches the page');

    teardown(mounted);
  });
}

// ---------------------------------------------------------------------------
// Currency and lifecycle
// ---------------------------------------------------------------------------

test('a further move clears a verdict that no longer describes the last move', async () => {
  const { sockets, elements, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  elements.get('assess-run')!.click();
  await tick();
  assert.equal(elements.get('assess-result')!.hidden, false, 'precondition: a verdict is shown');

  sockets.last.emit({
    t: 'move', gameId: 'g-test-1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 58_000 }, serverTs: 2, legalMoves: {},
  });
  await tick();

  assert.equal(elements.get('assess-result')!.hidden, true, 'the stale verdict is withdrawn');
  assert.equal(renderedText(elements.get('assess-rows')!), '');

  teardown(mounted);
});

test('a resync that clears the assessable move withdraws the verdict', async () => {
  const { sockets, elements, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  elements.get('assess-run')!.click();
  await tick();
  assert.equal(elements.get('assess-result')!.hidden, false);

  // An authoritative snapshot taken at the position already on screen. The FEN does not change, so
  // `onPosition` stays silent — but there is no longer a move after the snapshot ply to replay, so
  // the verdict describes a move the client can no longer identify.
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: makeState('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 1, 'b'),
  });
  await tick();

  assert.equal(elements.get('assess-result')!.hidden, true);
  assert.equal(elements.get('assess-run')!.disabled, true, 'and there is nothing to assess now');

  teardown(mounted);
});

test('a response arriving after disposal is discarded', async () => {
  const { sockets, elements, mounted } = setup({
    onAssess: () => new Promise((resolve) => setTimeout(() => resolve(json(200, verdict())), 20)),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();

  elements.get('assess-run')!.click();
  teardown(mounted);

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(elements.get('assess-result')!.hidden, true, 'nothing paints onto a disposed route');
  assert.equal(renderedText(elements.get('assess-rows')!), '');
});

test('remounting the route does not stack click handlers', async () => {
  // One document across both mounts, because that is the situation being tested: the panel lives in
  // index.html and outlives the route, so the second mount binds to the *same* button element the
  // first one did. A fresh document per mount makes this test unable to fail — the second mount
  // would be clicking an element the first had never seen. Mutation-verified: replacing the
  // route-scoped `bindClick` with a bare `addEventListener` survived the fresh-document version of
  // this test and fails this one.
  const shared = createGameDocument();

  const first = setup({ shared });
  await tick();
  joinAndPlay(first.sockets, 'e2e4');
  await tick();
  teardown(first.mounted);

  const second = setup({ shared });
  await tick();
  joinAndPlay(second.sockets, 'e2e4');
  await tick();
  shared.elements.get('assess-run')!.click();
  await tick();

  assert.equal(second.requests.length, 1, 'one click, one request');

  // The count of *listeners*, not of requests — because a request count cannot see this leak. The
  // stranded handler still fires; it just calls a disposed controller, which correctly refuses, so
  // nothing reaches the network and a behavioural assertion passes while the leak is real. What
  // actually leaks is the handler itself, and through it the whole disposed mount, once per
  // navigation to a game, for the life of the page. Mutation-verified: this fails when
  // `bindClick` is replaced by a bare `addEventListener`, and the request-count version did not.
  assert.equal(
    shared.elements.get('assess-run')!.listeners['click']?.length ?? 0,
    1,
    'the previous mount’s handler was removed, not left stacked beneath this one',
  );

  teardown(second.mounted);
});

test('a repeat click while a request is in flight does not buy a second one', async () => {
  const { sockets, elements, mounted, requests } = setup({
    onAssess: () => new Promise((resolve) => setTimeout(() => resolve(json(200, verdict())), 25)),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();

  elements.get('assess-run')!.click();
  await tick();
  elements.get('assess-run')!.click();
  await tick();

  // Each accepted request costs up to two engine searches and the API cannot observe a disconnect
  // (ADR-0113), so superseding would multiply real work while merely looking responsive.
  assert.equal(requests.length, 1);
  await new Promise((r) => setTimeout(r, 60));

  teardown(mounted);
});

test('the control is withdrawn when the game variant turns out to be unservable', async () => {
  const { sockets, elements, mounted } = setup({ analysisVariants: ['standard'] });
  await tick();
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: { ...makeState(START_FEN, 0, 'w'), variant: 'crazyhouse' },
  });
  await tick();

  // ADR-0114 Decision 7: a deployment carrying Stockfish alone reports analysis on while answering
  // 422 for six of the eight variants. An enabled control there fails on every click.
  assert.equal(elements.get('assess')!.hidden, true);

  teardown(mounted);
});

test('signing out disables the control and says why', async () => {
  const { sockets, elements, mounted, app } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4');
  await tick();
  assert.equal(elements.get('assess-run')!.disabled, false, 'precondition: enabled while signed in');

  app.api.session.reset();
  mounted.onSessionChange(null);
  await tick();

  assert.equal(elements.get('assess-run')!.disabled, true);
  assert.equal(elements.get('assess-note')!.textContent, 'Sign in to assess moves.');

  teardown(mounted);
});

// ---------------------------------------------------------------------------
// Coexistence with Explain
// ---------------------------------------------------------------------------

test('both controls read the same move without either disturbing the other', async () => {
  const explainRequests: HttpRequest[] = [];
  const sockets = new FakeSocketFactory();
  const assessRequests: HttpRequest[] = [];

  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, {
        capabilities: { analysis: true, moveExplanation: true, mistakePrediction: true },
        analysisVariants: ['standard'],
      });
    }
    if (req.url.includes('/v1/analysis/mistake-prediction')) {
      assessRequests.push(req);
      return json(200, verdict());
    }
    if (req.url.includes('/v1/ai/move-explanation')) {
      explainRequests.push(req);
      return json(200, {
        fen: START_FEN,
        variant: 'standard',
        move: 'e7e8q',
        explanation: 'It promotes.',
        citation: {
          moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -20, evalLabel: '-0.20' },
          evalKind: 'cp',
          evalValue: 35,
          evalLabel: '+0.35',
          bestMove: 'd2d4',
          bestLine: ['d2d4'],
          depth: 16,
        },
        providerId: 'p',
        model: 'm',
      });
    }
    return json(200, {});
  });

  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    wsFactory: sockets.factory,
    httpTransport: transport,
  });
  app.api.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: 'tok-123', tokenType: 'Bearer', expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
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
    token: 'test-token',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });

  await tick();
  joinAndPlay(sockets, 'e7e8q');
  await tick();

  elements.get('explain-run')!.click();
  await tick();
  elements.get('assess-run')!.click();
  await tick();

  assert.equal(explainRequests.length, 1);
  assert.equal(assessRequests.length, 1);
  // One target function, two consumers — including the promotion suffix, which a second copy of the
  // target logic is exactly where you would lose.
  const explainBody = JSON.parse(String(explainRequests[0]!.body)) as Record<string, unknown>;
  const assessBody = JSON.parse(String(assessRequests[0]!.body)) as Record<string, unknown>;
  assert.equal(explainBody['fen'], assessBody['fen']);
  assert.equal(explainBody['move'], assessBody['move']);
  assert.equal(assessBody['move'], 'e7e8q');

  // Both answers are on screen at once; neither cleared the other.
  assert.equal(elements.get('explain-result')!.hidden, false, 'Explain still works alongside Assess');
  assert.equal(elements.get('assess-result')!.hidden, false);

  teardown(mounted);
});
