import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/composition.js';
import { mountGame } from '../src/app/game-mount.js';
import type { GameReviewMove, GameReviewResponse } from '../src/api/models.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { AsyncTransport, createGameDocument, makeFinishedState, makeState } from './support/analysis-fixtures.js';
import type { FakeElement } from './support/analysis-fixtures.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { json } from './support/fake-transport.js';

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
  const transport: HttpTransport = new AsyncTransport((request) => {
    if (request.url.endsWith('/v1/capabilities')) {
      return json(200, { capabilities: { gameReview: true }, gameReviewVariants });
    }
    if (request.url.endsWith(`/v1/games/${gameId}/review`)) {
      return new Promise<HttpResponse>((resolve) => pendingReviews.push({ request, resolve }));
    }
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
  });
  sockets.last.open();
  sockets.last.emit({
    t: 'joined',
    gameId,
    role,
    state: { ...(lifecycle === 'finished' ? makeFinishedState(fen) : makeState(fen)), gameId, variant },
  });

  return { app, elements, mounted, pendingReviews, socket: sockets.last };
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
    assert.equal(reviewedMove.children[1]!.textContent, '★ Best move · 10 cp');
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
