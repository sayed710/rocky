/**
 * The Move Explanation block in the game sidebar (ADR-0117).
 *
 * The properties worth pinning here are the ones invisible in a screenshot: which position and which
 * move the request actually carries, that a promotion suffix survives, that model prose and engine
 * evidence stay separate elements, and that a superseded answer can never paint over a newer one.
 *
 * Mirrors `analysis-mount.test.ts`'s harness deliberately — same route, same disposal, and a second
 * harness idiom would be one more thing to keep in step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { HttpRequest } from '../src/ports/http.js';
import type { MoveExplanationResponse } from '../src/api/models.js';
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

function explanation(overrides: Partial<MoveExplanationResponse> = {}): MoveExplanationResponse {
  return {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    explanation: 'It stakes a claim in the centre.',
    citation: {
      moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -20, evalLabel: '-0.20' },
      evalKind: 'cp',
      evalValue: 35,
      evalLabel: '+0.35',
      bestMove: 'd2d4',
      bestLine: ['d2d4', 'd7d5'],
      depth: 16,
    },
    providerId: 'test-provider',
    model: 'test-model',
    ...overrides,
  };
}

function setup(opts?: {
  moveExplanation?: boolean;
  analysisVariants?: readonly string[];
  onExplain?: (req: HttpRequest) => unknown;
  /**
   * Mount into an existing document instead of a fresh one.
   *
   * The panel DOM lives in `index.html` and outlives any single mount, so a remount in the browser
   * binds to the *same* button element the previous mount bound to. A test that builds a new
   * document per mount cannot observe a leaked listener at all — the second mount is clicking an
   * element the first had never seen.
   */
  shared?: { readonly doc: Document; readonly elements: Map<string, FakeElement> };
}) {
  const sockets = new FakeSocketFactory();
  const requests: HttpRequest[] = [];

  const transport = new FakeTransport().onEach((req: HttpRequest) => {
    if (req.url.includes('/v1/capabilities')) {
      return json(200, {
        capabilities: { analysis: true, moveExplanation: opts?.moveExplanation ?? true },
        analysisVariants: opts?.analysisVariants ?? ['standard'],
      });
    }
    if (req.url.includes('/v1/ai/move-explanation')) {
      requests.push(req);
      const custom = opts?.onExplain?.(req);
      return (custom as ReturnType<typeof json> | undefined) ?? json(200, explanation());
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
      accessToken: 'tok-123',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  });

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

  return { sockets, elements, mounted, requests };
}

/** Join, then deliver one live move so the controller replays it and can explain it. */
function joinAndPlay(sockets: FakeSocketFactory, uci: string, resultFen: string): void {
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

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

test('the block is revealed when the capability reports it on', async () => {
  const { elements, mounted } = setup();
  await tick();
  assert.equal(elements.get('explain')!.hidden, false);

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

test('the control is disabled until a move has actually been replayed', async () => {
  const { elements, sockets, mounted } = setup();
  await tick();
  assert.equal(elements.get('explain-run')!.disabled, true, 'nothing to explain yet');

  joinAndPlay(sockets, 'e2e4', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  await tick();
  assert.equal(elements.get('explain-run')!.disabled, false, 'a replayed move enables it');

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

/**
 * The request must carry the position the move was played *from*, not the one now on the board.
 *
 * Sending the current FEN would ask the server to explain a move that is not legal in it, and the
 * server would correctly answer 422 — so this is the difference between a working feature and one
 * that rejects every request.
 */
test('explaining sends the position before the move, not the position after it', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, requests, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();

  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0]!.body as string) as Record<string, unknown>;
  assert.equal(body['fen'], START_FEN, 'the position the move was played from');
  assert.equal(body['move'], 'e2e4');
  assert.equal(body['variant'], 'standard');
  assert.deepEqual(Object.keys(body).sort(), ['fen', 'move', 'variant'], 'and nothing else');

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * A promotion suffix is part of the move's identity.
 *
 * `onLastMove` deliberately keeps only the two squares because a highlight needs no more, and the
 * obvious way to build this feature is to reuse that. `e7e8q` and `e7e8n` are different moves with
 * different evaluations, so the explanation would be about the wrong one — and a bare `e7e8` is not
 * a legal UCI move at all, so the server would reject it.
 */
test('a promotion keeps its suffix in the explained move', async () => {
  const beforePromotion = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const afterPromotion = '4Q3/8/8/8/8/8/8/4K3 b - - 0 1';
  const { elements, sockets, requests, mounted } = setup();
  await tick();

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: { ...makeState(beforePromotion, 0, 'w'), fen: beforePromotion },
  });
  sockets.last.emit({
    t: 'move', gameId: 'g-test-1', ply: 1, uci: 'e7e8q', san: 'e8=Q', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {},
  });
  await tick();

  elements.get('explain-run')!.click();
  await tick();

  const body = JSON.parse(requests[0]!.body as string) as Record<string, unknown>;
  assert.equal(body['move'], 'e7e8q', 'the promotion piece is part of the move');
  assert.equal(body['fen'], beforePromotion);

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('prose and engine evidence are rendered into separate elements', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();

  const prose = elements.get('explain-prose')!;
  const evidence = elements.get('explain-evidence')!;

  assert.equal(prose.textContent, 'It stakes a claim in the centre.');
  // The numbers live in the evidence element and nowhere else — a reader (or a test) can trust one
  // without parsing the other.
  const evidenceText = renderedText(evidence);
  assert.ok(evidenceText.includes('-0.20'), 'what the move achieved');
  assert.ok(evidenceText.includes('d2d4'), 'and what the engine preferred');
  assert.equal(prose.textContent.includes('-0.20'), false, 'prose carries no facts of its own');
  assert.ok(elements.get('explain-source')!.textContent.includes('test-provider'));

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * A game-ending move is rendered as a result, never as an evaluation.
 *
 * This is the client half of ADR-0116: the server stopped reporting `+0.00` for a decided position,
 * and the client must not reintroduce it by rendering the union's terminal arm as a score.
 */
test('a checkmating move is rendered as checkmate, not as an evaluation', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, mounted } = setup({
    onExplain: () =>
      json(
        200,
        explanation({
          citation: {
            moveOutcome: { kind: 'terminal', reason: 'checkmate', result: '1-0' },
            evalKind: 'mate',
            evalValue: 1,
            evalLabel: 'mate in 1',
            bestMove: 'e2e4',
            bestLine: ['e2e4'],
            depth: 12,
          },
        }),
      ),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();

  const evidence = elements.get('explain-evidence')!;
  const evidenceText = renderedText(evidence);
  assert.ok(evidenceText.includes('Checkmate'), 'the result is named');
  assert.ok(evidenceText.includes('White wins'));
  assert.equal(evidenceText.includes('+0.00'), false, 'and never scored as level');

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

// ---------------------------------------------------------------------------
// Failure states
// ---------------------------------------------------------------------------

for (const [status, expected] of [
  [429, 'Too many explanations. Try again shortly.'],
  [503, 'Move explanation is unavailable right now.'],
] as const) {
  test(`a ${status} response explains itself without showing anything from the server`, async () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const { elements, sockets, mounted } = setup({
      onExplain: () =>
        json(status, { error: { code: 'x', message: 'internal vendor detail', requestId: 'r' } }),
    });
    await tick();
    joinAndPlay(sockets, 'e2e4', afterE4);
    await tick();

    elements.get('explain-run')!.click();
    await tick();

    assert.equal(elements.get('explain-note')!.textContent, expected);
    const rendered = `${elements.get('explain-note')!.textContent}${elements.get('explain-error')!.textContent}`;
    assert.equal(rendered.includes('internal vendor detail'), false, 'no server text is shown');
    assert.equal(elements.get('explain-result')!.hidden, true, 'and no stale result is left behind');

    // GameSync keeps reconnect timers and the controller keeps a 100ms clock interval, so an
    // undisposed route stops the file exiting at all.
    mounted.controller.dispose();
    mounted.analysis.dispose();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * A new move supersedes the explanation of the previous one.
 *
 * Leaving it up would put an explanation of a move two plies old beside a changed board, with
 * nothing marking it stale — the same failure the analysis panel's invalidation exists to prevent.
 */
test('a further move clears an explanation that no longer describes the last move', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const { elements, sockets, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();
  assert.equal(elements.get('explain-result')!.hidden, false);

  sockets.last.emit({
    t: 'move', gameId: 'g-test-1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2, legalMoves: {},
  });
  await tick();

  assert.equal(elements.get('explain-result')!.hidden, true, 'the stale explanation is withdrawn');
  assert.equal(elements.get('explain-prose')!.textContent, '');

  // GameSync keeps reconnect timers, so an undisposed route stops the file exiting.
  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * A response that lands after the route is gone renders nothing.
 *
 * The generation guard is what stops it. Delayed with a timer rather than a manually-resolved
 * promise: a promise held open across  leaves the aborted request's rejection unsettled,
 * which the test runner waits on and the file never exits.
 */
test('a response arriving after disposal is discarded', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, mounted } = setup({
    onExplain: () =>
      new Promise((resolve) => setTimeout(() => resolve(json(200, explanation())), 20)),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  mounted.analysis.dispose();
  mounted.controller.dispose();

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(elements.get('explain-result')!.hidden, true, 'nothing is rendered after disposal');
  assert.equal(elements.get('explain-prose')!.textContent, '');
});

/**
 * The control is not offered on a variant this deployment has no engine for.
 *
 * The capability answer and the game snapshot race, and the reveal used to be decided once, at
 * capability time, treating an unknown variant as supported and never revisiting it. On a
 * Stockfish-only deployment a Crazyhouse game therefore got an enabled control whose every request
 * answers 422 — the failure ADR-0114 Decision 7 was written about. Raised in the Qodo review of
 * PR #135.
 */
test('the control is withdrawn when the game variant turns out to be unservable', async () => {
  const { elements, sockets, mounted } = setup({ analysisVariants: ['standard'] });
  await tick();

  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId: 'g-test-1',
    role: 'white',
    state: { ...makeState(START_FEN, 0, 'w'), variant: 'crazyhouse' },
  });
  await tick();

  assert.equal(
    elements.get('explain')!.hidden,
    true,
    'a variant with no engine here is never offered one',
  );

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * A resync at the position already on screen clears the explainable move without changing the FEN.
 *
 * `onPosition` is suppressed when the FEN is unchanged, so a consumer keyed on it alone kept an
 * enabled button and a displayed explanation for a move the controller could no longer identify.
 * `onExplainableChange` exists for exactly this. Raised in the Qodo review of PR #135.
 */
test('a resync that clears the explainable move withdraws the explanation', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, mounted } = setup();
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();
  assert.equal(elements.get('explain-result')!.hidden, false, 'precondition: an explanation is up');

  // An authoritative snapshot taken at the position already displayed: same FEN, nothing left to
  // replay, so there is no longer a move whose prior position the client knows.
  sockets.last.emit({
    t: 'state',
    gameId: 'g-test-1',
    state: { ...makeState(afterE4, 1, 'b'), ply: 1 },
  });
  await tick();

  assert.equal(elements.get('explain-result')!.hidden, true, 'the explanation is withdrawn');
  assert.equal(elements.get('explain-run')!.disabled, true, 'and the control stops offering');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});

/**
 * Every mount's click handler is route-scoped.
 *
 * `#explain-run` lives in `index.html` and outlives the mount, so a bare `addEventListener` stacked
 * one listener per SPA navigation, each holding a disposed controller. Two mounts and one click must
 * still produce one request. Raised in the Qodo review of PR #135.
 */
test('remounting the route does not stack click handlers', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  // One document across both mounts, because that is the situation being tested: the panel lives in
  // index.html and outlives the route, so the second mount binds to the *same* button element the
  // first one did. This test built a fresh document per mount until M15 increment 5, which made it
  // unable to fail — the second mount was clicking an element the first had never touched, so
  // replacing `bindClick` with a bare `addEventListener` passed it.
  const shared = createGameDocument();

  const first = setup({ shared });
  await tick();
  joinAndPlay(first.sockets, 'e2e4', afterE4);
  await tick();

  // Navigate away.
  first.mounted.controller.dispose();
  first.mounted.analysis.dispose();
  first.mounted.connectivity.dispose();

  const second = setup({ shared });
  await tick();
  joinAndPlay(second.sockets, 'e2e4', afterE4);
  await tick();

  shared.elements.get('explain-run')!.click();
  await tick();

  assert.equal(second.requests.length, 1, 'one click, one request');

  // The count of *listeners*, not of requests. A request count cannot see this leak: the stranded
  // handler still fires, it just calls a disposed controller which correctly refuses, so nothing
  // reaches the network. What leaks is the handler itself — and through it the whole disposed
  // mount — once per navigation to a game, for the life of the page.
  assert.equal(
    shared.elements.get('explain-run')!.listeners['click']?.length ?? 0,
    1,
    'the previous mount\u2019s handler was removed, not left stacked beneath this one',
  );

  second.mounted.controller.dispose();
  second.mounted.analysis.dispose();
  second.mounted.connectivity.dispose();
});

/**
 * A response that resolves *after* the move it describes was superseded renders nothing.
 *
 * Aborting alone does not cover this: a response already received and waiting only on its microtask
 * still resolves, and without a generation bump it passes the currency check and paints an
 * explanation of the previous move next to the new one. The transport here ignores the abort signal
 * deliberately, which is what makes the race observable. Found in the independent review of PR #135.
 */
test('a response that resolves after its move was superseded does not render', async () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const { elements, sockets, mounted } = setup({
    onExplain: () =>
      // Resolves regardless of abort, like a response that landed a tick before the move did.
      new Promise((resolve) => setTimeout(() => resolve(json(200, explanation())), 25)),
  });
  await tick();
  joinAndPlay(sockets, 'e2e4', afterE4);
  await tick();

  elements.get('explain-run')!.click();
  await tick();

  // Black replies before the explanation of 1.e4 comes back.
  sockets.last.emit({
    t: 'move', gameId: 'g-test-1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2, legalMoves: {},
  });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(
    elements.get('explain-result')!.hidden,
    true,
    'the superseded explanation must not paint over the cleared panel',
  );
  assert.equal(elements.get('explain-prose')!.textContent, '');

  mounted.controller.dispose();
  mounted.analysis.dispose();
});
