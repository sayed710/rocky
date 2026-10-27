import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import type { GameReviewMove, GameReviewResponse } from '../src/api/models.js';
import type { HttpRequest, HttpResponse } from '../src/ports/http.js';
import { AsyncTransport, createGameDocument, makeFinishedState, makeState, sampleAnalysisResponse } from './support/analysis-fixtures.js';
import type { FakeElement } from './support/analysis-fixtures.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';
import { enMessages } from '../src/i18n/catalog/index.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

const COMPLETED_REVIEW: GameReviewResponse = {
  gameId: 'g-test-1',
  variant: 'standard',
  playerColor: 'white',
  result: '1-0',
  termination: 'checkmate',
  moves: [],
  summary: {
    brilliant: 0,
    great: 0,
    best: 0,
    excellent: 0,
    good: 0,
    book: 0,
    inaccuracy: 0,
    mistake: 0,
    miss: 0,
    blunder: 0,
    missed_win: 0,
  },
  isPartial: false,
  totalPlayerMoves: 0,
  analyzedPlayerMoves: 0,
};

const REVIEWED_MOVE: GameReviewMove = {
  ply: 1,
  san: 'e4',
  move: 'e2e4',
  fenBefore: FEN,
  classification: 'best',
  assessment: {
    fen: FEN,
    variant: 'standard',
    move: 'e2e4',
    classification: 'ok',
    before: { evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
    centipawnLoss: 10,
    bestMove: 'e2e4',
    bestLine: ['e2e4'],
    depth: 16,
  },
};

const COMPLETED_REVIEW_WITH_MOVE: GameReviewResponse = {
  ...COMPLETED_REVIEW,
  moves: [REVIEWED_MOVE],
  summary: { ...COMPLETED_REVIEW.summary, best: 1 },
  totalPlayerMoves: 1,
  analyzedPlayerMoves: 1,
};

const COMPLETED_REVIEW_PARTIAL: GameReviewResponse = {
  ...COMPLETED_REVIEW_WITH_MOVE,
  moves: Array<GameReviewMove>(40).fill(REVIEWED_MOVE),
  summary: { ...COMPLETED_REVIEW.summary, best: 40 },
  isPartial: true,
  totalPlayerMoves: 55,
  analyzedPlayerMoves: 40,
  cutoffReason: 'move_limit',
};

interface PendingReview {
  readonly request: HttpRequest;
  readonly resolve: (response: HttpResponse) => void;
}

interface SetupOptions {
  readonly variant?: string;
  readonly gameReviewVariants?: readonly string[];
  readonly lifecycle?: 'live' | 'finished';
  readonly role?: 'white' | 'black' | 'spectator';
  readonly gameDocument?: ReturnType<typeof createGameDocument>;
  readonly gameId?: string;
  readonly fen?: string;
}

/** Mount a controllable finished-game route with a deferred private review response. */
function setup(options: SetupOptions = {}) {
  const {
    variant = 'standard',
    gameReviewVariants = ['standard'],
    lifecycle = 'finished',
    role = 'white',
    gameDocument,
    gameId = 'g-test-1',
    fen = FEN,
  } = options;
  const pendingReviews: PendingReview[] = [];
  const pendingAnalysis: PendingReview[] = [];
  const pendingPuzzles: PendingReview[] = [];
  const transport = new AsyncTransport((request) => {
    if (request.url.endsWith('/v1/capabilities')) {
      return json(200, {
        capabilities: { gameReview: true, analysis: true, puzzleGeneration: true },
        gameReviewVariants, analysisVariants: ['standard'], puzzleVariants: ['standard'],
      });
    }
    if (request.url.endsWith(`/v1/games/${gameId}/review`)) {
      return new Promise<HttpResponse>((resolve) => pendingReviews.push({ request, resolve }));
    }
    if (request.url.endsWith('/v1/analysis')) {
      return new Promise<HttpResponse>((resolve) => pendingAnalysis.push({ request, resolve }));
    }
    if (request.url.endsWith('/v1/analysis/puzzle')) {
      return new Promise<HttpResponse>((resolve) => pendingPuzzles.push({ request, resolve }));
    }
    if (request.url.endsWith('/v1/auth/refresh')) return json(200, app.api.session.current);
    return json(404, {});
  });
  const sockets = new FakeSocketFactory();
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    httpTransport: transport,
    wsFactory: sockets.factory,
  });
  app.api.session.adopt({
    user: { id: 'user-1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const { doc, elements } = gameDocument ?? createGameDocument();
  const mounted = mountGame({
    doc,
    boardEl: elements.get('board')! as unknown as HTMLElement,
    gameId,
    createGameSync: app.createGameSync,
    createGameOracle: app.createGameOracle,
    getAccessToken: () => app.api.session.current?.tokens.accessToken,
    client: app.api,
    token: 'token',
    initialSessionId: 'user-1',
    restorePromise: Promise.resolve(null),
    i18n: app.i18n,
  });
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId,
    role,
    state: { ...(lifecycle === 'finished' ? makeFinishedState(fen) : makeState(fen)), gameId, variant },
  });

  return { app, elements, mounted, pendingReviews, pendingAnalysis, pendingPuzzles, sockets, socket: sockets.last, transport };
}

/** Drain the promise turns used by controller completion callbacks. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Drain bounded promise turns until a deterministic DOM condition becomes true. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail('condition did not become true while draining queued work');
}

/** Activate the mounted Game Review control. */
function runReview(elements: Map<string, FakeElement>): void {
  elements.get('game-review-run')!.click();
}

/** Read rendered coordinate labels in their visual DOM order. */
function coordinateValues(html: string, kind: 'rank' | 'file'): string[] {
  return [...html.matchAll(new RegExp(`cb-coordinate cb-${kind}[^>]*>([^<]+)<`, 'g'))]
    .map((match) => match[1]!);
}

/** Tear down every route-scoped controller created by the fixture. */
function dispose(setupResult: ReturnType<typeof setup>): void {
  setupResult.mounted.analysis.dispose();
  setupResult.mounted.connectivity.dispose();
  setupResult.mounted.controller.dispose();
  setupResult.app.dispose();
}

/** Publish two selectable positions while keeping the final game position distinct. */
async function loadSelectableReview(g: ReturnType<typeof setup>): Promise<void> {
  await waitUntil(() => g.elements.get('game-review-run')!.disabled === false);
  runReview(g.elements);
  await waitUntil(() => g.pendingReviews.length === 1);
  g.pendingReviews[0]!.resolve(json(200, {
    ...COMPLETED_REVIEW_WITH_MOVE,
    moves: [REVIEWED_MOVE, { ...REVIEWED_MOVE, ply: 3, san: 'Nf3', fenBefore: AFTER_E4_FEN }],
  }));
  await waitUntil(() => g.elements.get('game-review-moves')!.childElementCount === 2);
}

const POSITION_TOOLS = [
  { name: 'Analyse', button: 'analysis-run', result: 'analysis-results', pending: 'pendingAnalysis',
    response: (fen: string) => ({ ...sampleAnalysisResponse(), fen }) },
  { name: 'Find tactic', button: 'puzzle-run', result: 'puzzle-rows', pending: 'pendingPuzzles',
    response: (fen: string) => ({ kind: 'puzzle', fen, variant: 'standard',
      evidence: { kind: 'centipawn_gap', gapCp: 270 }, bestMove: 'e2e4', comparisonMove: 'd2d4',
      bestEvaluation: { type: 'cp', value: 350 }, comparisonEvaluation: { type: 'cp', value: 80 },
      depth: 16, solutionMove: 'e2e4', solutionLine: ['e2e4', 'e7e5'], difficulty: 'easy' }) },
] as const;

test('Find tactic explains a second 401 after refresh while the local session remains active', async () => {
  const g = setup();
  try {
    await waitUntil(() => g.elements.get('puzzle-run')!.disabled === false);
    g.elements.get('puzzle-run')!.click();
    await waitUntil(() => g.pendingPuzzles.length === 1);
    g.pendingPuzzles[0]!.resolve(json(401, {}));
    await waitUntil(() => g.pendingPuzzles.length === 2);
    g.pendingPuzzles[1]!.resolve(json(401, {}));
    await waitUntil(() => g.elements.get('puzzle-run')!.disabled === false);
    await settle();
    assert.ok(g.app.api.session.current, 'successful refresh retains the local session');
    assert.equal(g.elements.get('puzzle-note')!.textContent, g.app.i18n.t('ai.puzzle.signedOut'));
    assert.equal(g.pendingPuzzles.length, 2, 'existing HTTP refresh replay is unchanged');
  } finally { dispose(g); }
});

for (const responseStatus of [200, 422]) {
  test(`Find tactic restores retained ${responseStatus === 200 ? 'result' : 'error'} presentation after signing back in`, async () => {
    const g = setup();
    try {
      await waitUntil(() => g.elements.get('puzzle-run')!.disabled === false);
      const session = g.app.api.session.current!;
      g.elements.get('puzzle-run')!.click();
      await waitUntil(() => g.pendingPuzzles.length === 1);
      g.pendingPuzzles[0]!.resolve(json(responseStatus, responseStatus === 200 ? POSITION_TOOLS[1].response(FEN) : {}));
      await waitUntil(() => responseStatus === 200
        ? g.elements.get('puzzle-rows')!.childElementCount > 0
        : g.elements.get('puzzle-error')!.hidden === false);
      const expectedNote = g.elements.get('puzzle-note')!.textContent;
      const expectedError = g.elements.get('puzzle-error')!.textContent;
      g.app.api.session.reset(false);
      g.mounted.onSessionChange(null);
      assert.equal(g.elements.get('puzzle-note')!.textContent, g.app.i18n.t('ai.puzzle.signedOut'));
      g.app.api.session.adopt(session);
      g.mounted.onSessionChange({ userId: session.user.id, handle: session.user.handle });
      assert.equal(g.elements.get('puzzle-run')!.disabled, false);
      assert.equal(g.elements.get('puzzle-note')!.textContent, expectedNote);
      assert.equal(g.elements.get('puzzle-error')!.textContent, expectedError);
      assert.equal(g.pendingPuzzles.length, 1, 'auth presentation never issues another tactic request');
    } finally { dispose(g); }
  });
}

for (const outcome of ['pending', 'rate-limited', 'unavailable', 'settled-while-out'] as const) {
  test(`Find tactic preserves ${outcome} request state across sign-out and sign-in`, async () => {
    const g = setup();
    try {
      await waitUntil(() => g.elements.get('puzzle-run')!.disabled === false);
      const session = g.app.api.session.current!;
      g.elements.get('puzzle-run')!.click();
      await waitUntil(() => g.pendingPuzzles.length === 1);
      if (outcome === 'rate-limited' || outcome === 'unavailable') {
        g.pendingPuzzles[0]!.resolve(json(outcome === 'rate-limited' ? 429 : 503, {}));
        await waitUntil(() => g.elements.get('puzzle-note')!.textContent === g.app.i18n.t(
          outcome === 'rate-limited' ? 'ai.puzzle.rateLimited' : 'ai.puzzle.unavailable'));
      }
      let expectedNote = g.elements.get('puzzle-note')!.textContent;
      g.app.api.session.reset(false);
      g.mounted.onSessionChange(null);
      assert.equal(g.elements.get('puzzle-note')!.textContent, g.app.i18n.t('ai.puzzle.signedOut'));
      g.app.i18n.registerCatalog('ar', enMessages);
      g.app.i18n.setLocale('ar');
      assert.equal(g.elements.get('puzzle-note')!.textContent, g.app.i18n.t('ai.puzzle.signedOut'));
      if (outcome === 'settled-while-out') {
        g.pendingPuzzles[0]!.resolve(json(429, {}));
        await settle();
        await settle();
        expectedNote = g.app.i18n.t('ai.puzzle.rateLimited');
        assert.equal(g.elements.get('puzzle-note')!.textContent, g.app.i18n.t('ai.puzzle.signedOut'));
      }
      g.app.api.session.adopt(session);
      g.mounted.onSessionChange({ userId: session.user.id, handle: session.user.handle });
      assert.equal(g.elements.get('puzzle-note')!.textContent, expectedNote);
      assert.equal(g.elements.get('puzzle-run')!.disabled, outcome === 'pending');
      assert.equal(g.pendingPuzzles.length, 1);
    } finally { dispose(g); }
  });
}

for (const tool of POSITION_TOOLS) {
  test(`${tool.name} targets the displayed review FEN and clears completed results on selection`, async () => {
    const g = setup({ fen: AFTER_E4_FEN });
    try {
      await loadSelectableReview(g);
      const finalBoard = g.elements.get('board')!.innerHTML;
      g.elements.get('game-review-moves')!.children[0]!.click();
      assert.notEqual(g.elements.get('board')!.innerHTML, finalBoard);
      assert.equal(g.mounted.controller.fen, AFTER_E4_FEN, 'live controller keeps the final position');
      g.elements.get(tool.button)!.click();
      await waitUntil(() => g[tool.pending].length === 1);
      assert.equal(JSON.parse(g[tool.pending][0]!.request.body!).fen, FEN);
      g[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
      await waitUntil(() => g.elements.get(tool.result)!.childElementCount > 0);
      g.elements.get('game-review-moves')!.children[1]!.click();
      assert.equal(g.elements.get(tool.result)!.childElementCount, 0);
      assert.equal(g.socket.sent.some((frame) => JSON.parse(frame).t === 'move'), false);
    } finally { dispose(g); }
  });

  for (const staleStatus of [200, 503]) {
    test(`${tool.name} rejects a late ${staleStatus} after A-B-A review selection`, async () => {
      const g = setup({ fen: AFTER_E4_FEN });
      try {
        await loadSelectableReview(g);
        const rows = g.elements.get('game-review-moves')!.children;
        rows[0]!.click();
        g.elements.get(tool.button)!.click();
        await waitUntil(() => g[tool.pending].length === 1);
        rows[1]!.click();
        assert.equal(g[tool.pending][0]!.request.signal!.aborted, true);
        rows[0]!.click();
        g.elements.get(tool.button)!.click();
        await waitUntil(() => g[tool.pending].length === 2);
        const fresh = tool.response(FEN);
        g[tool.pending][1]!.resolve(json(200, fresh));
        await waitUntil(() => g.elements.get(tool.result)!.childElementCount > 0);
        const freshRows = [...g.elements.get(tool.result)!.children];
        g[tool.pending][0]!.resolve(json(staleStatus, staleStatus === 200 ? tool.response(AFTER_E4_FEN) : {}));
        await settle();
        await settle();
        assert.deepEqual(g.elements.get(tool.result)!.children, freshRows);
        assert.equal(g.elements.get(tool.button)!.disabled, false);
      } finally { dispose(g); }
    });
  }

  for (const boundary of ['sign-out', 'account-change', 'retry', 'navigation'] as const) {
    test(`${tool.name} clears selected review work on ${boundary}, even at the same final FEN`, async () => {
      const g = setup();
      try {
        await loadSelectableReview(g);
        const orphan = g.elements.get('game-review-moves')!.children[0]!;
        orphan.click();
        g.elements.get(tool.button)!.click();
        await waitUntil(() => g[tool.pending].length === 1);
        if (boundary === 'sign-out') {
          g.app.api.session.reset(false);
          g.mounted.onSessionChange(null);
        }
        else if (boundary === 'account-change') g.mounted.onSessionChange({ userId: 'user-2', handle: 'bob' });
        else if (boundary === 'retry') runReview(g.elements);
        else g.mounted.analysis.dispose();
        assert.equal(g[tool.pending][0]!.request.signal!.aborted, true);
        if (boundary === 'sign-out') {
          const noteKey = tool.name === 'Analyse' ? 'game.analysis.signedOut' : 'ai.puzzle.signedOut';
          const note = g.elements.get(tool.name === 'Analyse' ? 'analysis-note' : 'puzzle-note')!;
          assert.equal(g.elements.get(tool.button)!.disabled, true);
          assert.equal(note.textContent, g.app.i18n.t(noteKey));
          g.app.i18n.registerCatalog('ar', { ...enMessages, [noteKey]: 'AR sign in for this tool' });
          g.app.i18n.setLocale('ar');
          assert.equal(note.textContent, 'AR sign in for this tool');
        }
        const restoredBoard = g.elements.get('board')!.innerHTML;
        orphan.click();
        assert.equal(g.elements.get('board')!.innerHTML, restoredBoard, 'orphaned row cannot select');
        g[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
        await settle();
        await settle();
        assert.equal(g.elements.get(tool.result)!.childElementCount, 0);
        if (boundary === 'retry' || boundary === 'account-change') {
          g.elements.get(tool.button)!.click();
          await waitUntil(() => g[tool.pending].length === 2);
          assert.equal(JSON.parse(g[tool.pending][1]!.request.body!).fen, g.mounted.controller.fen);
        }
      } finally { dispose(g); }
    });
  }

  test(`${tool.name} clears completed same-FEN review results only when account identity changes`, async () => {
    const g = setup();
    try {
      await loadSelectableReview(g);
      g.elements.get('game-review-moves')!.children[0]!.click();
      g.elements.get(tool.button)!.click();
      await waitUntil(() => g[tool.pending].length === 1);
      g[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
      await waitUntil(() => g.elements.get(tool.result)!.childElementCount > 0);
      g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
      assert.ok(g.elements.get(tool.result)!.childElementCount > 0, 'same account token refresh preserves review');
      g.mounted.onSessionChange({ userId: 'user-2', handle: 'bob' });
      assert.equal(g.elements.get(tool.result)!.childElementCount, 0);
    } finally { dispose(g); }
  });

  test(`${tool.name} cannot publish selected-position work into the next game's reused DOM`, async () => {
    const gameDocument = createGameDocument();
    const first = setup({ fen: AFTER_E4_FEN, gameDocument });
    let next: ReturnType<typeof setup> | null = null;
    try {
      await loadSelectableReview(first);
      const orphan = first.elements.get('game-review-moves')!.children[0]!;
      orphan.click();
      first.elements.get(tool.button)!.click();
      await waitUntil(() => first[tool.pending].length === 1);
      dispose(first);
      next = setup({ gameDocument, gameId: 'next-game', fen: AFTER_E4_FEN });
      await waitUntil(() => next!.elements.get(tool.button)!.disabled === false);
      const nextBoard = next.elements.get('board')!.innerHTML;
      orphan.click();
      assert.equal(next.elements.get('board')!.innerHTML, nextBoard);
      next.elements.get(tool.button)!.click();
      await waitUntil(() => next![tool.pending].length === 1);
      assert.equal(JSON.parse(next[tool.pending][0]!.request.body!).fen, AFTER_E4_FEN);
      first[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
      await settle();
      await settle();
      assert.equal(next.elements.get(tool.result)!.childElementCount, 0);
      assert.equal(next.elements.get(tool.button)!.disabled, true, 'old response cannot settle the new request');
    } finally { if (next) dispose(next); else dispose(first); }
  });

  test(`${tool.name} returns to authoritative position after a changed server snapshot`, async () => {
    const g = setup({ fen: AFTER_E4_FEN });
    const authoritativeFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    try {
      await loadSelectableReview(g);
      g.elements.get('game-review-moves')!.children[0]!.click();
      g.elements.get(tool.button)!.click();
      await waitUntil(() => g[tool.pending].length === 1);
      g.socket.emit({ t: 'state', gameId: 'g-test-1', state: makeFinishedState(authoritativeFen, 2) });
      assert.equal(g[tool.pending][0]!.request.signal!.aborted, true);
      g.elements.get(tool.button)!.click();
      await waitUntil(() => g[tool.pending].length === 2);
      assert.equal(JSON.parse(g[tool.pending][1]!.request.body!).fen, authoritativeFen);
    } finally { dispose(g); }
  });

  for (const phase of ['pending', 'completed'] as const) {
    test(`${tool.name} clears ${phase} review work when a server correction has the same selected FEN`, async () => {
      const g = setup({ fen: AFTER_E4_FEN });
      try {
        await loadSelectableReview(g);
        g.elements.get('game-review-moves')!.children[0]!.click();
        g.elements.get(tool.button)!.click();
        await waitUntil(() => g[tool.pending].length === 1);
        if (phase === 'completed') {
          g[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
          await waitUntil(() => g.elements.get(tool.result)!.childElementCount > 0);
        }
        g.socket.emit({ t: 'state', gameId: 'g-test-1', state: makeFinishedState(FEN) });
        assert.equal(g.mounted.controller.fen, FEN);
        if (phase === 'pending') assert.equal(g[tool.pending][0]!.request.signal!.aborted, true);
        assert.equal(g.elements.get(tool.result)!.childElementCount, 0);
        if (phase === 'pending') {
          g[tool.pending][0]!.resolve(json(200, tool.response(FEN)));
          await settle();
          await settle();
          assert.equal(g.elements.get(tool.result)!.childElementCount, 0);
        }
      } finally { dispose(g); }
    });
  }
}

test('review pending and failure relocalize without requests and clear on retry/sign-out', async () => {
  const g = setup();
  g.app.i18n.registerCatalog('ar', { ...enMessages,
    'game.review.reviewingMoves': 'AR reviewing moves',
    'game.review.unavailableError': 'AR review unavailable',
    'game.review.noteSignedOut': 'AR sign in for review',
  });
  try {
    await waitUntil(() => g.elements.get('game-review-run')!.disabled === false);
    runReview(g.elements);
    await waitUntil(() => g.pendingReviews.length === 1);
    runReview(g.elements);
    g.app.i18n.setLocale('ar');
    assert.equal(g.elements.get('game-review-note')!.textContent, g.app.i18n.t('game.review.reviewingMoves'));
    assert.equal(g.pendingReviews.length, 1);
    assert.equal(g.elements.get('game-review-run')!.disabled, true);
    g.pendingReviews[0]!.resolve(json(503, {}));
    await waitUntil(() => g.elements.get('game-review-error')!.hidden === false);
    g.app.i18n.setLocale('en');
    assert.equal(g.elements.get('game-review-error')!.textContent, g.app.i18n.t('game.review.unavailableError'));
    g.app.i18n.setLocale('ar');
    assert.equal(g.elements.get('game-review-error')!.textContent, g.app.i18n.t('game.review.unavailableError'));
    assert.equal(g.pendingReviews.length, 1);
    runReview(g.elements);
    await waitUntil(() => g.pendingReviews.length === 2);
    assert.equal(g.elements.get('game-review-error')!.hidden, true);
    g.app.i18n.setLocale('en');
    assert.equal(g.elements.get('game-review-note')!.textContent, g.app.i18n.t('game.review.reviewingMoves'));
    g.mounted.onSessionChange?.(null);
    g.app.i18n.setLocale('ar');
    assert.equal(g.elements.get('game-review-note')!.textContent, g.app.i18n.t('game.review.noteSignedOut'));
    assert.equal(g.elements.get('game-review-error')!.hidden, true);
    g.pendingReviews[1]!.resolve(json(503, {}));
    await settle();
    assert.equal(g.elements.get('game-review-error')!.hidden, true);
  } finally { dispose(g); }
});

test('mounted session changes synchronously refresh Game Review controls', async () => {
  const mountedGame = setup();
  try {
    const runButton = mountedGame.elements.get('game-review-run')!;
    const note = mountedGame.elements.get('game-review-note')!;
    await waitUntil(() => runButton.disabled === false);

    mountedGame.mounted.onSessionChange(null);

    assert.equal(runButton.disabled, true);
    assert.equal(note.textContent, 'Sign in to review your game.');

    mountedGame.mounted.onSessionChange({ handle: 'alice', userId: 'user-1' });

    mountedGame.sockets.last.open();
    mountedGame.sockets.last.emit({ t: 'joined', gameId: 'g-test-1', role: 'white', state: makeFinishedState(FEN) });

    assert.equal(runButton.disabled, false);
    assert.equal(note.textContent, 'Review your moves after the game.');
  } finally {
    dispose(mountedGame);
  }
});

test('sign-out removes a completed private review and restores the authoritative game presentation', async () => {
  const mountedGame = setup({ fen: AFTER_E4_FEN });
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    const board = mountedGame.elements.get('board')!;
    const status = mountedGame.elements.get('status')!;
    const authoritativeBoard = board.innerHTML;
    const authoritativeStatus = status.textContent;
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW_WITH_MOVE));
    await waitUntil(() => mountedGame.elements.get('game-review-summary')!.hidden === false);

    const summary = mountedGame.elements.get('game-review-summary')!;
    assert.equal(summary.hidden, false);
    assert.equal(summary.childElementCount, 11);
    assert.equal(summary.children[2]!.children[0]!.textContent, '★ Best');
    assert.equal(summary.children[2]!.children[1]!.textContent, '1');
    mountedGame.elements.get('game-review-moves')!.children[0]!.click();
    assert.notEqual(board.innerHTML, authoritativeBoard);
    assert.match(status.textContent, /^Reviewing e4\. Best move:/);

    mountedGame.mounted.onSessionChange(null);

    assert.equal(summary.hidden, true);
    assert.equal(summary.childElementCount, 0);
    assert.equal(mountedGame.elements.get('game-review-moves')!.childElementCount, 0);
    assert.equal(mountedGame.elements.get('game-review-note')!.textContent, 'Sign in to review your game.');
    assert.equal(board.innerHTML, authoritativeBoard);
    assert.equal(status.textContent, authoritativeStatus);
    mountedGame.app.i18n.registerCatalog('ar', enMessages);
    mountedGame.app.i18n.setLocale('ar');
    assert.equal(summary.hidden, true, 'locale replay cannot restore a signed-out private review');
    assert.equal(summary.childElementCount, 0);
    assert.equal(mountedGame.elements.get('game-review-moves')!.childElementCount, 0);
  } finally {
    dispose(mountedGame);
  }
});

test('sign-out aborts an in-flight review and a late response cannot repopulate the page', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    const pending = mountedGame.pendingReviews[0]!;

    mountedGame.mounted.onSessionChange(null);

    assert.equal(pending.request.signal?.aborted, true);
    assert.equal(mountedGame.elements.get('game-review-summary')!.hidden, true);
    pending.resolve(json(200, COMPLETED_REVIEW));
    await settle();
    assert.equal(mountedGame.elements.get('game-review-summary')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-summary')!.childElementCount, 0);
  } finally {
    dispose(mountedGame);
  }
});

test('Game Review stays unavailable while the game is live and unlocks only when it ends', async () => {
  const mountedGame = setup({ lifecycle: 'live' });
  try {
    await settle();
    assert.equal(mountedGame.elements.get('game-review')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-run')!.disabled, true);
    runReview(mountedGame.elements);
    assert.equal(mountedGame.pendingReviews.length, 0);

    mountedGame.socket.emit({
      t: 'ended',
      gameId: 'g-test-1',
      result: '1-0',
      termination: 'checkmate',
      winner: 'w',
      serverTs: 1,
    });

    await waitUntil(() => mountedGame.elements.get('game-review')!.hidden === false);
    assert.equal(mountedGame.elements.get('game-review-run')!.disabled, false);
  } finally {
    dispose(mountedGame);
  }
});

test('RET-01: Return to final position button visibility gates across lifecycle, roles, and selection FEN equality', async () => {
  const liveGame = setup({ lifecycle: 'live' });
  try {
    assert.equal(liveGame.elements.get('game-review-return-final')!.hidden, true);
  } finally {
    dispose(liveGame);
  }

  const specGame = setup({ role: 'spectator' });
  try {
    assert.equal(specGame.elements.get('game-review-return-final')!.hidden, true);
  } finally {
    dispose(specGame);
  }

  const g = setup();
  try {
    const returnBtn = g.elements.get('game-review-return-final')!;
    assert.equal(returnBtn.hidden, true);
    assert.equal(returnBtn.textContent, 'Return to final position');

    const baselineBoard = g.elements.get('board')!.innerHTML;
    const baselineStatus = g.elements.get('status')!.textContent;
    const callsBefore = g.transport.calls.length;

    // Clicking while unselected/hidden is a no-op
    returnBtn.click();
    assert.equal(returnBtn.hidden, true);
    assert.equal(g.elements.get('board')!.innerHTML, baselineBoard);
    assert.equal(g.elements.get('status')!.textContent, baselineStatus);
    assert.equal(g.elements.get('status')!.focused, false);
    assert.equal(g.transport.calls.length, callsBefore);

    await loadSelectableReview(g);
    assert.equal(returnBtn.hidden, true);

    const movesEl = g.elements.get('game-review-moves')!;
    assert.equal(movesEl.childElementCount, 2);

    // Row 1: distinct FEN selection (AFTER_E4_FEN != FEN) shows return button
    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);
    assert.equal(returnBtn.textContent, 'Return to final position');

    // Row 0: EQUAL final FEN selection (fenBefore === FEN === game final FEN) also counts as active ownership
    movesEl.children[0]!.click();
    assert.equal(returnBtn.hidden, false);
  } finally {
    dispose(g);
  }
});

test('RET-01: Controller FEN state frame preserves selection on identical FEN and clears on changed FEN', async () => {
  const g = setup();
  try {
    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const returnBtn = g.elements.get('game-review-return-final')!;

    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);
    const selectedBoardHtml = g.elements.get('board')!.innerHTML;

    // Server frame with IDENTICAL retained controller FEN preserves selection and placement
    g.socket.emit({
      t: 'state',
      gameId: 'g-test-1',
      state: makeFinishedState(FEN),
    });
    await settle();
    assert.equal(g.mounted.controller.fen, FEN);
    assert.equal(g.elements.get('board')!.innerHTML, selectedBoardHtml);
    assert.equal(returnBtn.hidden, false);

    // Server frame with CHANGED controller FEN (distinct third position after e4 e5) clears selection and updates board
    const afterE5Fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    g.socket.emit({
      t: 'state',
      gameId: 'g-test-1',
      state: makeFinishedState(afterE5Fen, 2),
    });
    await settle();
    assert.equal(g.mounted.controller.fen, afterE5Fen);
    assert.notEqual(g.elements.get('board')!.innerHTML, selectedBoardHtml);
    assert.equal(returnBtn.hidden, true);
  } finally {
    dispose(g);
  }
});

test('RET-02, RET-03, RET-07: Return activation restores baseline board/status/highlight/orientation, focuses status, retains review, and triggers zero HTTP/WS commands', async () => {
  const afterE5Fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const retainedMoves = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' as const },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' as const },
  ];
  const g = setup({ fen: afterE5Fen });
  try {
    // Send state with retained last-move ledger (last move e7e5 highlighted)
    g.socket.emit({
      t: 'state',
      gameId: 'g-test-1',
      state: makeFinishedState(afterE5Fen, 2, 'w', retainedMoves),
    });
    await settle();

    // Flip to non-default black orientation via native flip button
    g.elements.get('flip')!.click();
    const flippedBaselineBoard = g.elements.get('board')!.innerHTML;
    const baselineStatus = g.elements.get('status')!.textContent;
    const baselineControllerFen = g.mounted.controller.fen;

    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const summaryEl = g.elements.get('game-review-summary')!;
    const returnBtn = g.elements.get('game-review-return-final')!;

    const baselineSummaryContent = summaryEl.children.flatMap((child) => [
      ...(child.textContent ? [child.textContent] : []),
      ...child.children.map((grand) => grand.textContent).filter(Boolean),
    ]);
    assert.ok(baselineSummaryContent.length > 0, 'summary must have meaningful initial content');

    const hasLastHighlight = (html: string, sq: string) =>
      new RegExp(`cb-last[^>]*\\b${sq}\\b|\\b${sq}\\b[^>]*cb-last`).test(html);

    // Precondition: baseline board has retained e7/e5 highlight, not e2/e4
    assert.equal(hasLastHighlight(flippedBaselineBoard, 'e7'), true, 'baseline board must highlight retained e7 move');
    assert.equal(hasLastHighlight(flippedBaselineBoard, 'e5'), true, 'baseline board must highlight retained e5 move');
    assert.equal(hasLastHighlight(flippedBaselineBoard, 'e2'), false, 'baseline board must not highlight e2');

    // Row 0 reviews move 1 (e2e4 highlight, FEN placement) differing from retained position (e7e5 highlight, afterE5Fen placement)
    movesEl.children[0]!.click();
    assert.equal(returnBtn.hidden, false);
    const selectedBoardHtml = g.elements.get('board')!.innerHTML;
    assert.notEqual(selectedBoardHtml, flippedBaselineBoard);
    assert.notEqual(g.elements.get('status')!.textContent, baselineStatus);

    // Precondition: selected review position has e2/e4 highlight, not e7/e5
    assert.equal(hasLastHighlight(selectedBoardHtml, 'e2'), true, 'selected position must highlight e2 move');
    assert.equal(hasLastHighlight(selectedBoardHtml, 'e4'), true, 'selected position must highlight e4 move');
    assert.equal(hasLastHighlight(selectedBoardHtml, 'e7'), false, 'selected position must not highlight e7');

    const httpCallsBeforeReturn = g.transport.calls.length;
    const wsMessagesBeforeReturn = g.socket.sent.length;
    const reviewsBeforeReturn = g.pendingReviews.length;

    g.elements.get('status')!.focused = false;

    returnBtn.click();

    assert.equal(returnBtn.hidden, true);
    assert.equal(g.elements.get('status')!.focused, true);
    assert.equal(g.elements.get('board')!.innerHTML, flippedBaselineBoard);
    assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e7'), true, 'restored board must restore e7 highlight');
    assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e5'), true, 'restored board must restore e5 highlight');
    assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e2'), false, 'restored board must clear e2 highlight');
    assert.equal(g.elements.get('status')!.textContent, baselineStatus);
    assert.equal(g.mounted.controller.fen, baselineControllerFen);

    assert.equal(g.transport.calls.length, httpCallsBeforeReturn);
    assert.equal(g.socket.sent.length, wsMessagesBeforeReturn);
    assert.equal(g.pendingReviews.length, reviewsBeforeReturn);

    assert.equal(summaryEl.hidden, false);
    const returnedSummaryContent = summaryEl.children.flatMap((child) => [
      ...(child.textContent ? [child.textContent] : []),
      ...child.children.map((grand) => grand.textContent).filter(Boolean),
    ]);
    assert.deepEqual(returnedSummaryContent, baselineSummaryContent);
    assert.equal(movesEl.childElementCount, 2);

    movesEl.children[0]!.click();
    assert.equal(returnBtn.hidden, false);
    assert.notEqual(g.elements.get('board')!.innerHTML, flippedBaselineBoard);
    assert.equal(g.pendingReviews.length, reviewsBeforeReturn);
  } finally {
    dispose(g);
  }
});

for (const tool of POSITION_TOOLS) {
  for (const staleStatus of [200, 503] as const) {
    test(`RET-04: ${tool.name} tool invalidation on equal-FEN return, stale late ${staleStatus} isolation (fresh first, old last), and fresh controller FEN targeting`, async () => {
      const g = setup();
      try {
        await loadSelectableReview(g);
        const movesEl = g.elements.get('game-review-moves')!;
        const returnBtn = g.elements.get('game-review-return-final')!;
        const resultEl = g.elements.get(tool.result)!;
        const noteEl = g.elements.get(tool.name === 'Analyse' ? 'analysis-note' : 'puzzle-note')!;
        const errorEl = g.elements.get(tool.name === 'Analyse' ? 'analysis-error' : 'puzzle-error')!;
        const buttonEl = g.elements.get(tool.button)!;
        const getPending = () => (tool.pending === 'pendingAnalysis' ? g.pendingAnalysis : g.pendingPuzzles);

        // 1. Equal-FEN selection: completed tool results are invalidated on Return
        movesEl.children[0]!.click();
        assert.equal(returnBtn.hidden, false);

        buttonEl.click();
        await waitUntil(() => getPending().length === 1);
        getPending()[0]!.resolve(json(200, tool.response(FEN)));
        await waitUntil(() => resultEl.childElementCount > 0);

        returnBtn.click();
        assert.equal(returnBtn.hidden, true);
        assert.equal(resultEl.childElementCount, 0);

        // 2. Fencing in-flight request on Return: verify note/error/button presentation
        movesEl.children[0]!.click();
        assert.equal(returnBtn.hidden, false);

        const pInFlightIdx = getPending().length;
        buttonEl.click();
        await waitUntil(() => getPending().length === pInFlightIdx + 1);
        const inFlight = getPending()[pInFlightIdx]!;

        returnBtn.click();
        assert.equal(returnBtn.hidden, true);
        assert.equal(inFlight.request.signal!.aborted, true);

        const noteAfterReturn = noteEl.textContent;
        const errorAfterReturn = errorEl.textContent;
        const errorHiddenAfterReturn = errorEl.hidden;
        const btnDisabledAfterReturn = buttonEl.disabled;

        inFlight.resolve(json(staleStatus, staleStatus === 200 ? tool.response(FEN) : { error: 'Service Unavailable' }));
        await settle();
        await settle();

        assert.equal(resultEl.childElementCount, 0);
        assert.equal(noteEl.textContent, noteAfterReturn);
        assert.equal(errorEl.textContent, errorAfterReturn);
        assert.equal(errorEl.hidden, errorHiddenAfterReturn);
        assert.equal(buttonEl.disabled, btnDisabledAfterReturn);

        // 3. A -> return -> A: resolve fresh first, deliver old last (valid FEN)
        movesEl.children[1]!.click(); // Position A (AFTER_E4_FEN)
        assert.equal(returnBtn.hidden, false);

        const pA1Idx = getPending().length;
        buttonEl.click();
        await waitUntil(() => getPending().length === pA1Idx + 1);
        const oldReq = getPending()[pA1Idx]!;

        returnBtn.click();
        assert.equal(returnBtn.hidden, true);
        assert.equal(oldReq.request.signal!.aborted, true);

        movesEl.children[1]!.click();
        assert.equal(returnBtn.hidden, false);

        const pA2Idx = getPending().length;
        buttonEl.click();
        await waitUntil(() => getPending().length === pA2Idx + 1);
        const freshReq = getPending()[pA2Idx]!;

        const freshPayload = tool.name === 'Analyse'
          ? { ...tool.response(AFTER_E4_FEN), lines: [{ multipv: 1, evaluation: { type: 'cp', value: 150 }, moves: ['e2e4'], depth: 22, nodes: 250000, timeMs: 950 }] }
          : { ...tool.response(AFTER_E4_FEN), evidence: { kind: 'centipawn_gap', gapCp: 400 } };
        freshReq.resolve(json(200, freshPayload));
        await waitUntil(() => resultEl.childElementCount > 0);

        const freshChildren = [...resultEl.children];
        const freshNote = noteEl.textContent;
        const freshError = errorEl.textContent;
        const freshBtnDisabled = buttonEl.disabled;
        const freshCallsCount = g.transport.calls.length;

        const stalePayload = staleStatus === 200
          ? (tool.name === 'Analyse'
            ? { ...tool.response(AFTER_E4_FEN), lines: [{ multipv: 1, evaluation: { type: 'cp', value: 20 }, moves: ['d2d4'], depth: 10, nodes: 80000, timeMs: 300 }] }
            : { ...tool.response(AFTER_E4_FEN), evidence: { kind: 'centipawn_gap', gapCp: 120 } })
          : { error: 'Service Unavailable' };
        oldReq.resolve(json(staleStatus, stalePayload));
        await settle();
        await settle();

        assert.deepEqual(resultEl.children, freshChildren);
        assert.equal(noteEl.textContent, freshNote);
        assert.equal(errorEl.textContent, freshError);
        assert.equal(buttonEl.disabled, freshBtnDisabled);
        assert.equal(g.transport.calls.length, freshCallsCount);

        // 4. Return clears tool work; fresh request after return targets controller FEN
        returnBtn.click();
        assert.equal(resultEl.childElementCount, 0);

        const pCtrlIdx = getPending().length;
        buttonEl.click();
        await waitUntil(() => getPending().length === pCtrlIdx + 1);
        const controllerReq = getPending()[pCtrlIdx]!;
        const reqPayload = JSON.parse(typeof controllerReq.request.body === 'string' ? controllerReq.request.body : '{}') as { fen?: string };
        assert.equal(reqPayload.fen, g.mounted.controller.fen);

        controllerReq.resolve(json(200, tool.response(g.mounted.controller.fen)));
        await waitUntil(() => resultEl.childElementCount > 0);
      } finally {
        dispose(g);
      }
    });
  }
}

test('RET-05: EN -> AR while selected preserves review meaning and button, Return displays localized final status, and AR -> EN avoids focus stealing or selection restoration', async () => {
  const g = setup();
  try {
    const statusEl = g.elements.get('status')!;
    const enFinalStatus = g.app.i18n.t('game.status.checkmateWins', {
      winner: g.app.i18n.t('game.player.white'),
      result: '1-0',
    });
    assert.equal(statusEl.textContent, enFinalStatus);

    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const returnBtn = g.elements.get('game-review-return-final')!;

    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);
    assert.equal(returnBtn.textContent, 'Return to final position');
    const expectedEnReviewStatus = g.app.i18n.t('game.review.statusReviewing', { san: 'Nf3', bestMove: 'e2e4' });
    assert.equal(statusEl.textContent, expectedEnReviewStatus);

    g.app.i18n.setLocale('ar');
    assert.equal(returnBtn.hidden, false);
    assert.equal(returnBtn.textContent, 'العودة إلى الوضع النهائي');

    const expectedArReviewStatus = g.app.i18n.t('game.review.statusReviewing', { san: 'Nf3', bestMove: 'e2e4' });
    assert.equal(statusEl.textContent, expectedArReviewStatus);
    assert.notEqual(expectedArReviewStatus, expectedEnReviewStatus);

    statusEl.focused = false;
    returnBtn.click();

    assert.equal(returnBtn.hidden, true);
    assert.equal(statusEl.focused, true);
    const expectedArFinalStatus = g.app.i18n.t('game.status.checkmateWins', {
      winner: g.app.i18n.t('game.player.white'),
      result: '1-0',
    });
    assert.equal(statusEl.textContent, expectedArFinalStatus);
    assert.notEqual(expectedArFinalStatus, expectedArReviewStatus);

    statusEl.focused = false;
    returnBtn.focused = false;
    g.app.i18n.setLocale('en');

    assert.equal(returnBtn.hidden, true);
    assert.equal(statusEl.textContent, enFinalStatus);
    assert.equal(returnBtn.focused, false);
    assert.equal(statusEl.focused, false);
  } finally {
    dispose(g);
  }
});

test('RET-06: Persistent DOM remount cleans up orphan handlers, resets return button visibility, and keeps second mount actionable', async () => {
  const persistentDoc = createGameDocument();
  let g1Row: FakeElement | null = null;
  let g1Return: FakeElement | null = null;

  const g1 = setup({ gameDocument: persistentDoc });
  try {
    await loadSelectableReview(g1);
    const g1Moves = g1.elements.get('game-review-moves')!;
    g1Row = g1Moves.children[1]!;
    g1Return = g1.elements.get('game-review-return-final')!;

    g1Row.click();
    assert.equal(g1Return.hidden, false);
  } finally {
    dispose(g1);
  }

  const g2 = setup({ gameDocument: persistentDoc });
  try {
    const g2Return = g2.elements.get('game-review-return-final')!;
    assert.equal(g2Return.hidden, true);

    const g2BaselineBoard = g2.elements.get('board')!.innerHTML;
    const g2BaselineStatus = g2.elements.get('status')!.textContent;
    const callsBeforeOrphan = g2.transport.calls.length;

    g1Row!.click();
    assert.equal(g2.elements.get('board')!.innerHTML, g2BaselineBoard, 'orphan row cannot change mount 2 board');
    assert.equal(g2.elements.get('status')!.textContent, g2BaselineStatus, 'orphan row cannot change mount 2 status');
    assert.equal(g2Return.hidden, true, 'orphan click cannot show button');
    assert.equal(g2.transport.calls.length, callsBeforeOrphan);

    g1Return!.click();
    assert.equal(g2Return.hidden, true);
    assert.equal(g2.elements.get('board')!.innerHTML, g2BaselineBoard);
    assert.equal(g2Return.focused, false);
    assert.equal(g2.transport.calls.length, callsBeforeOrphan);

    await loadSelectableReview(g2);
    const g2Moves = g2.elements.get('game-review-moves')!;
    assert.equal(g2Moves.childElementCount, 2);

    g2Moves.children[1]!.click();
    assert.equal(g2Return.hidden, false);
    assert.notEqual(g2.elements.get('board')!.innerHTML, g2BaselineBoard);

    g2Return.click();
    assert.equal(g2Return.hidden, true);
    assert.equal(g2.elements.get('board')!.innerHTML, g2BaselineBoard);
    assert.equal(g2.elements.get('status')!.textContent, g2BaselineStatus);
    assert.equal(g2Moves.childElementCount, 2);

    g2Moves.children[0]!.click();
    assert.equal(g2Return.hidden, false);
    g2Return.click();
    assert.equal(g2Return.hidden, true);
    assert.equal(g2.elements.get('board')!.innerHTML, g2BaselineBoard);
  } finally {
    dispose(g2);
  }
});

test('RET-06: Session change notifications: same account preserves ownership, account change clears selection', async () => {
  const g = setup();
  try {
    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const returnBtn = g.elements.get('game-review-return-final')!;

    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);
    const selectedBoardHtml = g.elements.get('board')!.innerHTML;
    const selectedStatusText = g.elements.get('status')!.textContent;

    // Same-user session change notification disconnects/reconnects GameSync; Return is hidden while unjoined
    g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
    await settle();
    assert.equal(returnBtn.hidden, true, 'return hidden while unjoined after session change');
    assert.equal(movesEl.childElementCount, 2, 'cached review rows preserved across same-user change');
    assert.equal(g.elements.get('status')!.textContent, selectedStatusText, 'review status meaning retained');

    // Complete the new socket reconnect and join flow with unchanged retained controller FEN
    g.sockets.last.open();
    await waitUntil(() =>
      g.sockets.last.sent.some((raw) => {
        try {
          return (JSON.parse(raw) as { t?: string }).t === 'join';
        } catch {
          return false;
        }
      }),
    );
    g.sockets.last.emit({
      t: 'joined',
      gameId: 'g-test-1',
      role: 'white',
      state: makeFinishedState(FEN),
    });
    await settle();

    // After rejoining with authorized player role, Return is visible again and review selection is intact
    assert.equal(returnBtn.hidden, false, 'return visible again after rejoin with role');
    assert.equal(g.elements.get('board')!.innerHTML, selectedBoardHtml, 'selected review board preserved');
    assert.equal(g.elements.get('status')!.textContent, selectedStatusText, 'selected review status preserved');

    g.mounted.onSessionChange({ userId: 'user-2', handle: 'bob' });
    await settle();
    assert.equal(returnBtn.hidden, true, 'account change notification clears review selection');
    assert.equal(movesEl.childElementCount, 0, 'account change invalidates review rows');
  } finally {
    dispose(g);
  }
});

test('RET-06: Sign-out via session reset and onSessionChange(null) clears selection and hides return button', async () => {
  const g = setup();
  try {
    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const returnBtn = g.elements.get('game-review-return-final')!;

    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);

    g.app.api.session.reset(false);
    g.mounted.onSessionChange(null);
    await settle();

    assert.equal(returnBtn.hidden, true, 'sign-out clears review selection and hides return button');
  } finally {
    dispose(g);
  }
});

for (const rejectCode of ['unknown_game', 'unauthorized'] as const) {
  test(`RET-06 regression: Conclusive reconnect join rejection (${rejectCode}) restores retained state and fences review ownership`, async () => {
    const afterE5Fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const retainedMoves = [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' as const },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' as const },
    ];
    const g = setup({ fen: afterE5Fen });
    try {
      g.socket.emit({
        t: 'state',
        gameId: 'g-test-1',
        state: makeFinishedState(afterE5Fen, 2, 'w', retainedMoves),
      });
      await settle();

      g.elements.get('flip')!.click();
      const flippedBaselineBoard = g.elements.get('board')!.innerHTML;
      const baselineStatus = g.elements.get('status')!.textContent;
      const baselineControllerFen = g.mounted.controller.fen;

      const hasLastHighlight = (html: string, sq: string) =>
        new RegExp(`cb-last[^>]*\\b${sq}\\b|\\b${sq}\\b[^>]*cb-last`).test(html);

      assert.equal(hasLastHighlight(flippedBaselineBoard, 'e7'), true);
      assert.equal(hasLastHighlight(flippedBaselineBoard, 'e5'), true);
      assert.equal(hasLastHighlight(flippedBaselineBoard, 'e2'), false);

      await loadSelectableReview(g);
      const reviewContainer = g.elements.get('game-review')!;
      const movesEl = g.elements.get('game-review-moves')!;
      const returnBtn = g.elements.get('game-review-return-final')!;
      const statusEl = g.elements.get('status')!;

      // Capture REQUIRED actual orphan review row BEFORE rejection
      assert.ok(movesEl.children.length > 0, 'review moves must exist before rejection');
      const orphanRow = movesEl.children[0]!;

      // Select row 0 (move e2e4 highlight, FEN placement)
      orphanRow.click();
      assert.equal(returnBtn.hidden, false);
      const selectedBoardHtml = g.elements.get('board')!.innerHTML;
      const selectedStatusText = statusEl.textContent;
      assert.notEqual(selectedBoardHtml, flippedBaselineBoard);
      assert.equal(hasLastHighlight(selectedBoardHtml, 'e2'), true);
      assert.equal(hasLastHighlight(selectedBoardHtml, 'e4'), true);
      assert.equal(hasLastHighlight(selectedBoardHtml, 'e7'), false);

      const rejectMessage = 'Join rejected';
      const actionErrorEl = g.elements.get('action-error')!;

      // Seed ordinary command reject while joined with code illegal_move and the SAME message string
      g.socket.emit({
        t: 'reject',
        gameId: 'g-test-1',
        ref: null,
        code: 'illegal_move',
        message: rejectMessage,
      });
      await settle();
      assert.equal(actionErrorEl.textContent, rejectMessage);
      assert.equal(actionErrorEl.hidden, false);

      const httpBefore = g.transport.calls.length;
      statusEl.focused = false;
      returnBtn.focused = false;

      // Same-user session change triggers reconnect
      g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
      await settle();

      // Explicitly assert state remains intact and action-error text unchanged during pending same-user rejoin BEFORE reject
      assert.equal(actionErrorEl.textContent, rejectMessage);
      assert.equal(returnBtn.hidden, true, 'return button hidden during unjoined reconnect');
      assert.equal(g.elements.get('board')!.innerHTML, selectedBoardHtml, 'board remains in review position while pending rejoin');
      assert.equal(statusEl.textContent, selectedStatusText, 'review status retained while pending rejoin');
      assert.equal(movesEl.childElementCount, 2, 'cached review rows preserved while pending rejoin');

      // Wait for serialized join on new socket
      g.sockets.last.open();
      await waitUntil(() =>
        g.sockets.last.sent.some((raw) => {
          try {
            return (JSON.parse(raw) as { t?: string }).t === 'join';
          } catch {
            return false;
          }
        }),
      );

      const wsSentCountBeforeReject = g.sockets.last.sent.length;

      // Server conclusively rejects the join with the SAME message string
      g.sockets.last.emit({
        t: 'reject',
        gameId: 'g-test-1',
        ref: null,
        code: rejectCode,
        message: rejectMessage,
      });
      await settle();

      // Confirm action-error text unchanged across conclusive rejection
      assert.equal(actionErrorEl.textContent, rejectMessage);

      // Board, highlight, status restored to retained game state
      assert.equal(g.elements.get('board')!.innerHTML, flippedBaselineBoard);
      assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e7'), true);
      assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e5'), true);
      assert.equal(hasLastHighlight(g.elements.get('board')!.innerHTML, 'e2'), false);
      assert.equal(statusEl.textContent, baselineStatus);
      assert.equal(g.mounted.controller.fen, baselineControllerFen);

      // Private review and Return controls hidden
      assert.equal(returnBtn.hidden, true);
      assert.equal(reviewContainer.hidden, true);

      // Unconditionally click orphan row: cannot alter restored board or reveal Return
      orphanRow.click();
      assert.equal(returnBtn.hidden, true, 'orphan row click cannot reveal Return');
      assert.equal(g.elements.get('board')!.innerHTML, flippedBaselineBoard, 'orphan row click cannot alter restored board');

      // No focus stealing
      assert.equal(statusEl.focused, false);
      assert.equal(returnBtn.focused, false);

      // No cleanup-induced HTTP calls or outbound WS commands
      assert.equal(g.transport.calls.length, httpBefore);
      assert.equal(g.sockets.last.sent.length, wsSentCountBeforeReject);
    } finally {
      dispose(g);
    }
  });
}

for (const tool of POSITION_TOOLS) {
  for (const staleStatus of [200, 503] as const) {
    test(`RET-04 regression: ${tool.name} tool in-flight request aborted and fenced on reconnect join rejection (late ${staleStatus})`, async () => {
      const g = setup();
      try {
        await loadSelectableReview(g);
        const movesEl = g.elements.get('game-review-moves')!;
        const returnBtn = g.elements.get('game-review-return-final')!;
        const resultEl = g.elements.get(tool.result)!;
        const noteEl = g.elements.get(tool.name === 'Analyse' ? 'analysis-note' : 'puzzle-note')!;
        const errorEl = g.elements.get(tool.name === 'Analyse' ? 'analysis-error' : 'puzzle-error')!;
        const buttonEl = g.elements.get(tool.button)!;
        const statusEl = g.elements.get('status')!;
        const getPending = () => (tool.pending === 'pendingAnalysis' ? g.pendingAnalysis : g.pendingPuzzles);

        // Borrow equal-FEN review ownership
        movesEl.children[0]!.click();
        assert.equal(returnBtn.hidden, false);
        const selectedBoardHtml = g.elements.get('board')!.innerHTML;
        const selectedStatusText = statusEl.textContent;

        // Launch tool request for review position
        buttonEl.click();
        await waitUntil(() => getPending().length === 1);
        const inFlight = getPending()[0]!;
        assert.equal(inFlight.request.signal!.aborted, false);

        // Same-user reconnect triggered while tool is pending
        g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
        await settle();

        // Explicitly assert in-flight request and review presentation remain pending during rejoin interval BEFORE reject
        assert.equal(inFlight.request.signal!.aborted, false, 'tool request must remain pending during same-user unjoined reconnect');
        assert.equal(g.elements.get('board')!.innerHTML, selectedBoardHtml, 'board must remain in review position while pending rejoin');
        assert.equal(statusEl.textContent, selectedStatusText, 'review status retained while pending rejoin');
        assert.equal(movesEl.childElementCount, 2, 'cached review rows preserved while pending rejoin');
        assert.equal(returnBtn.hidden, true, 'return button hidden during unjoined reconnect');

        g.sockets.last.open();
        await waitUntil(() =>
          g.sockets.last.sent.some((raw) => {
            try {
              return (JSON.parse(raw) as { t?: string }).t === 'join';
            } catch {
              return false;
            }
          }),
        );

        // Server conclusively rejects the join
        g.sockets.last.emit({
          t: 'reject',
          gameId: 'g-test-1',
          ref: null,
          code: 'unknown_game',
          message: 'Game not found',
        });
        await settle();

        // In-flight request must be aborted specifically upon conclusive rejection
        assert.equal(inFlight.request.signal!.aborted, true, 'tool request must be aborted upon conclusive join rejection');

        const noteAfterReject = noteEl.textContent;
        const errorAfterReject = errorEl.textContent;
        const errorHiddenAfterReject = errorEl.hidden;
        const btnDisabledAfterReject = buttonEl.disabled;

        // Late response arrives after rejection
        inFlight.resolve(json(staleStatus, staleStatus === 200 ? tool.response(FEN) : { error: 'Service Unavailable' }));
        await settle();
        await settle();

        // Presentation cannot revive from stale response
        assert.equal(resultEl.childElementCount, 0);
        assert.equal(noteEl.textContent, noteAfterReject);
        assert.equal(errorEl.textContent, errorAfterReject);
        assert.equal(errorEl.hidden, errorHiddenAfterReject);
        assert.equal(buttonEl.disabled, btnDisabledAfterReject);
        assert.equal(returnBtn.hidden, true);
      } finally {
        dispose(g);
      }
    });
  }
}

test('RET-06 negative control: immediate transient invalid_command reconnect reject does not clear review ownership or abort tool work', async () => {
  const g = setup();
  let inFlightRequest: PendingReview | null = null;
  try {
    const baselineBoard = g.elements.get('board')!.innerHTML;

    await loadSelectableReview(g);
    const movesEl = g.elements.get('game-review-moves')!;
    const returnBtn = g.elements.get('game-review-return-final')!;
    const statusEl = g.elements.get('status')!;

    // Select row 1 (AFTER_E4_FEN)
    movesEl.children[1]!.click();
    assert.equal(returnBtn.hidden, false);
    const selectedBoardHtml = g.elements.get('board')!.innerHTML;
    const selectedStatusText = statusEl.textContent;
    assert.notEqual(selectedBoardHtml, baselineBoard);

    // Start in-flight analysis tool request for borrowed review position
    g.elements.get('analysis-run')!.click();
    await waitUntil(() => g.pendingAnalysis.length === 1);
    const inFlight = g.pendingAnalysis[0]!;
    inFlightRequest = inFlight;
    assert.equal(inFlight.request.signal!.aborted, false);

    // Same-user session change triggers reconnect
    g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
    await settle();
    assert.equal(returnBtn.hidden, true, 'return button hidden while unjoined');
    assert.equal(inFlight.request.signal!.aborted, false, 'tool request remains pending during reconnect');

    g.sockets.last.open();
    await waitUntil(() =>
      g.sockets.last.sent.some((raw) => {
        try {
          return (JSON.parse(raw) as { t?: string }).t === 'join';
        } catch {
          return false;
        }
      }),
    );

    // Server emits transient hydration reject (invalid_command)
    g.sockets.last.emit({
      t: 'reject',
      gameId: 'g-test-1',
      ref: null,
      code: 'invalid_command',
      message: 'Hydration retry',
    });
    await settle();

    // Immediate non-cleanup: transient reject does NOT clear review ownership or abort tool work
    assert.equal(inFlight.request.signal!.aborted, false, 'transient reject must not abort in-flight tool request');
    assert.equal(g.elements.get('board')!.innerHTML, selectedBoardHtml, 'transient reject must not clear selected board');
    assert.equal(statusEl.textContent, selectedStatusText, 'transient reject must not clear review status');
    assert.equal(movesEl.childElementCount, 2, 'cached review rows preserved across transient reject');
    assert.equal(returnBtn.hidden, true, 'return button remains hidden until authorized join');
    assert.equal(statusEl.focused, false);
    assert.equal(returnBtn.focused, false);
  } finally {
    dispose(g);
    if (inFlightRequest) {
      // Resolve pending fake request after dispose with valid selected AFTER_E4_FEN payload and assert no revival
      inFlightRequest.resolve(json(200, { ...sampleAnalysisResponse(), fen: AFTER_E4_FEN }));
      await settle();
      assert.equal(g.elements.get('analysis-results')!.childElementCount, 0, 'disposed analysis results cannot revive');
    }
  }
});

for (const staleStatus of [200, 503] as const) {
  test(`RET-06 regression: in-flight Game Review request aborted on conclusive join rejection and fenced against late ${staleStatus}`, async () => {
    const g = setup();
    try {
      await waitUntil(() => g.elements.get('game-review-run')!.disabled === false);
      const reviewContainer = g.elements.get('game-review')!;
      const movesEl = g.elements.get('game-review-moves')!;
      const summaryEl = g.elements.get('game-review-summary')!;
      const noteEl = g.elements.get('game-review-note')!;
      const errorEl = g.elements.get('game-review-error')!;
      const returnBtn = g.elements.get('game-review-return-final')!;
      const statusEl = g.elements.get('status')!;
      const idleNoteText = enMessages['game.review.noteSignedIn'];

      // Start actual Game Review request with no selected row
      runReview(g.elements);
      await waitUntil(() => g.pendingReviews.length === 1);
      const inFlightReview = g.pendingReviews[0]!;
      assert.equal(inFlightReview.request.signal!.aborted, false);
      assert.equal(movesEl.childElementCount, 0);
      assert.equal(movesEl.getAttribute('aria-busy'), 'true');

      // Same-user session change triggers reconnect while review request is pending
      g.mounted.onSessionChange({ userId: 'user-1', handle: 'alice' });
      await settle();

      // Negative reconnect precondition: request is not already aborted during pending rejoin
      assert.equal(inFlightReview.request.signal!.aborted, false, 'review request must remain pending during same-user unjoined reconnect');

      g.sockets.last.open();
      await waitUntil(() =>
        g.sockets.last.sent.some((raw) => {
          try {
            return (JSON.parse(raw) as { t?: string }).t === 'join';
          } catch {
            return false;
          }
        }),
      );

      // Server conclusively rejects the join
      g.sockets.last.emit({
        t: 'reject',
        gameId: 'g-test-1',
        ref: null,
        code: 'unknown_game',
        message: 'Game not found',
      });
      await settle();

      // Conclusive rejection aborts pending review request and resets/clears review state
      assert.equal(inFlightReview.request.signal!.aborted, true, 'pending review request must be aborted upon conclusive join rejection');
      assert.equal(movesEl.getAttribute('aria-busy'), 'false', 'moves container busy state must reset');
      assert.equal(g.elements.get('game-review-run')!.disabled, true, 'review run button remains disabled while not a player');
      assert.equal(movesEl.childElementCount, 0, 'review moves must remain empty');
      assert.equal(summaryEl.hidden, true, 'summary must remain hidden');
      assert.equal(noteEl.textContent, idleNoteText, 'idle signed-in note displayed');
      assert.equal(errorEl.hidden, true, 'review error must remain hidden');
      assert.equal(returnBtn.hidden, true, 'return button must remain hidden');
      assert.equal(reviewContainer.hidden, true, 'review container must be hidden');
      assert.equal(statusEl.focused, false);
      assert.equal(g.pendingReviews.length, 1, 'no new review request initiated');

      // Deliver late valid review response (200 or 503)
      inFlightReview.resolve(staleStatus === 200 ? json(200, COMPLETED_REVIEW_WITH_MOVE) : json(503, { error: 'Service Unavailable' }));
      await settle();
      await settle();

      // Stale response cannot revive or repopulate review rows, summary, note, or error
      assert.equal(movesEl.childElementCount, 0, 'stale review response must not populate moves');
      assert.equal(summaryEl.hidden, true, 'stale review response must not reveal summary');
      assert.equal(noteEl.textContent, idleNoteText, 'stale review response must not overwrite idle note');
      assert.equal(errorEl.hidden, true, 'stale review response must not reveal error');
      assert.equal(returnBtn.hidden, true, 'stale review response must not show return button');
      assert.equal(g.pendingReviews.length, 1, 'no new review request initiated');
    } finally {
      dispose(g);
    }
  });
}
test('review centipawn values retain their sign and unit in either locale', async () => {
  for (const loss of [-1, 0, 10, null]) {
    const g = setup();
    try {
      await waitUntil(() => g.elements.get('game-review-run')!.disabled === false);
      runReview(g.elements);
      await waitUntil(() => g.pendingReviews.length === 1);
      g.pendingReviews[0]!.resolve(json(200, {
        ...COMPLETED_REVIEW_WITH_MOVE,
        moves: [{ ...REVIEWED_MOVE, assessment: { ...REVIEWED_MOVE.assessment, centipawnLoss: loss } }],
      }));
      await waitUntil(() => g.elements.get('game-review-moves')!.childElementCount === 1);
      for (const locale of ['en', 'ar'] as const) {
        g.app.i18n.setLocale(locale);
        const verdict = g.elements.get('game-review-moves')!.children[0]!.children[1]!;
        if (loss === null) {
          assert.equal(verdict.children.length, 0, 'unavailable loss has no numeric token');
        } else {
          const token = verdict.children[0];
          assert.ok(token, 'centipawn value must be isolated from translated prose');
          assert.equal(token.textContent, `${loss} cp`);
          assert.equal(token.getAttribute('dir'), 'ltr');
          assert.match(token.className, /\bbidi-ltr\b/);
          assert.doesNotMatch(token.textContent, /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
        }
      }
    } finally {
      dispose(g);
    }
  }
});

test('reviewed-position navigation preserves every coordinate in the flipped orientation', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW_WITH_MOVE));
    await waitUntil(() => mountedGame.elements.get('game-review-moves')!.childElementCount === 1);

    mountedGame.mounted.board.view.flip();
    const reviewedMove = mountedGame.elements.get('game-review-moves')!.children[0]!;
    const verdict = reviewedMove.children[1]!;
    assert.equal(verdict.textContent + verdict.children[0]!.textContent, '★ Best move · 10 cp');
    reviewedMove.click();

    const boardHtml = mountedGame.elements.get('board')!.innerHTML;
    assert.deepEqual(coordinateValues(boardHtml, 'rank'), ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.deepEqual(coordinateValues(boardHtml, 'file'), ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
  } finally {
    dispose(mountedGame);
  }
});

test('a spectator cannot reveal or run a completed-game review', async () => {
  const mountedGame = setup({ role: 'spectator' });
  try {
    await settle();
    assert.equal(mountedGame.elements.get('game-review')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-run')!.disabled, true);
    runReview(mountedGame.elements);
    assert.equal(mountedGame.pendingReviews.length, 0);
  } finally {
    dispose(mountedGame);
  }
});

test('mounting another game clears completed review DOM owned by the previous route', async () => {
  const gameDocument = createGameDocument();
  const firstGame = setup({ gameDocument, gameId: 'g-test-1' });
  try {
    await waitUntil(() => firstGame.elements.get('game-review-run')!.disabled === false);
    runReview(firstGame.elements);
    await waitUntil(() => firstGame.pendingReviews.length === 1);
    firstGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW_WITH_MOVE));
    await waitUntil(() => firstGame.elements.get('game-review-moves')!.childElementCount === 1);
    assert.equal(firstGame.elements.get('game-review-summary')!.hidden, false);
  } finally {
    dispose(firstGame);
  }

  const secondGame = setup({ gameDocument, gameId: 'g-test-2' });
  try {
    assert.equal(secondGame.elements.get('game-review-summary')!.hidden, true);
    assert.equal(secondGame.elements.get('game-review-summary')!.childElementCount, 0);
    assert.equal(secondGame.elements.get('game-review-moves')!.childElementCount, 0);
  } finally {
    dispose(secondGame);
  }
});

test('a completed game with an unsupported variant never offers Game Review', async () => {
  const mountedGame = setup({ variant: 'atomic', gameReviewVariants: ['standard'] });
  try {
    await settle();
    assert.equal(mountedGame.elements.get('game-review')!.hidden, true);
    assert.equal(mountedGame.elements.get('game-review-run')!.disabled, true);
    mountedGame.elements.get('game-review-run')!.click();
    assert.equal(mountedGame.pendingReviews.length, 0);
  } finally {
    dispose(mountedGame);
  }
});

test('a complete review displays standard navigation note', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW_WITH_MOVE));
    await waitUntil(() => mountedGame.elements.get('game-review-moves')!.childElementCount === 1);

    const note = mountedGame.elements.get('game-review-note')!;
    assert.equal(note.textContent, 'Select a move to see the position before it was played.');
  } finally {
    dispose(mountedGame);
  }
});

test('a partial review truthfully displays bounded analysis notice with move counts', async () => {
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, COMPLETED_REVIEW_PARTIAL));
    await waitUntil(() => mountedGame.elements.get('game-review-moves')!.childElementCount === 40);

    const note = mountedGame.elements.get('game-review-note')!;
    assert.equal(
      note.textContent,
      'Partial review: first 40 of 55 player moves analyzed due to move limit. Select a move to see the position before it was played.',
    );
    const summary = mountedGame.elements.get('game-review-summary')!;
    assert.equal(summary.hidden, false);

    const reviewedMove = mountedGame.elements.get('game-review-moves')!.children[39]!;
    reviewedMove.click();
    const status = mountedGame.elements.get('status')!;
    assert.match(status.textContent, /^Reviewing e4\. Best move:/);
  } finally {
    dispose(mountedGame);
  }
});

test('a review cut short by a stored pre-#127 atomic move says so instead of blaming the move limit', async () => {
  const historicalPartial: GameReviewResponse = {
    ...COMPLETED_REVIEW_WITH_MOVE,
    variant: 'atomic',
    result: '0-1',
    termination: 'variant',
    isPartial: true,
    totalPlayerMoves: 2,
    analyzedPlayerMoves: 1,
    cutoffReason: 'historical_move',
  };
  const mountedGame = setup();
  try {
    await waitUntil(() => mountedGame.elements.get('game-review-run')!.disabled === false);
    runReview(mountedGame.elements);
    await waitUntil(() => mountedGame.pendingReviews.length === 1);
    mountedGame.pendingReviews[0]!.resolve(json(200, historicalPartial));
    await waitUntil(() => mountedGame.elements.get('game-review-moves')!.childElementCount === 1);

    const note = mountedGame.elements.get('game-review-note')!.textContent;
    assert.equal(
      note,
      'Partial review: 1 of 2 player moves analyzed. Your final move was recorded under earlier Atomic rules that no longer allow it, so it cannot be analyzed. Select a move to see the position before it was played.',
    );
    assert.doesNotMatch(note, /move limit/);
  } finally {
    dispose(mountedGame);
  }
});
