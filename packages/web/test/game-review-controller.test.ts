import test from 'node:test';
import assert from 'node:assert/strict';
import { GameReviewController, type GameReviewPhase } from '../src/app/game-review-controller.js';
import type { GameReviewResponse } from '../src/api/models.js';

interface ReviewCall {
  readonly gameId: string;
  readonly signal: AbortSignal;
}

/** Build a minimal successful review whose identity is controlled by the test. */
function review(gameId: string): GameReviewResponse {
  return {
    gameId,
    variant: 'standard',
    playerColor: 'white',
    result: '1-0',
    termination: 'resignation',
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
}

/** Capture requests, phases, results, failures, and manual promise settlement deterministically. */
function harness(gameId: string, sessionId: string | null) {
  const calls: ReviewCall[] = [];
  const settlers: Array<{
    resolve: (review: GameReviewResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  let rendered: GameReviewResponse | null = null;
  let invalidations = 0;
  let failures = 0;
  const phases: GameReviewPhase[] = [];
  const controller = new GameReviewController({
    gameId,
    sessionId,
    requestReview: (requestedGameId, signal) => {
      calls.push({ gameId: requestedGameId, signal });
      return new Promise<GameReviewResponse>((resolve, reject) => settlers.push({ resolve, reject }));
    },
    callbacks: {
      onPhase: (phase) => { phases.push(phase); },
      onResult: (completedReview) => { rendered = completedReview; },
      onFailure: () => { failures += 1; },
      onInvalidated: () => {
        rendered = null;
        invalidations += 1;
      },
    },
  });

  return {
    controller,
    calls,
    rendered: () => rendered,
    invalidations: () => invalidations,
    failures: () => failures,
    phases: () => phases,
    resolve: (index: number, completedReview: GameReviewResponse) => settlers[index]!.resolve(completedReview),
    reject: (index: number, error: unknown) => settlers[index]!.reject(error),
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('rapid game switching aborts the old request and only the new game renders', async () => {
  const gameA = harness('game-a', 'user-1');
  void gameA.controller.review();
  gameA.controller.dispose();

  const gameB = harness('game-b', 'user-1');
  void gameB.controller.review();
  gameB.resolve(0, review('game-b'));
  await gameB.flush();
  gameA.resolve(0, review('game-a'));
  await gameA.flush();

  assert.equal(gameA.calls[0]!.signal.aborted, true);
  assert.equal(gameA.rendered(), null);
  assert.equal(gameB.rendered()?.gameId, 'game-b');
});

test('sign-out during an in-flight review aborts and clears private state immediately', async () => {
  const h = harness('game-a', 'user-1');
  void h.controller.review();

  h.controller.sessionChanged(null);

  assert.equal(h.calls[0]!.signal.aborted, true);
  assert.equal(h.rendered(), null);
  assert.equal(h.invalidations(), 1);
  h.resolve(0, review('game-a'));
  await h.flush();
  assert.equal(h.rendered(), null);
  assert.equal(h.failures(), 0);
});

test('sign-out after a completed review clears the rendered private result', async () => {
  const h = harness('game-a', 'user-1');
  void h.controller.review();
  h.resolve(0, review('game-a'));
  await h.flush();
  assert.equal(h.rendered()?.gameId, 'game-a');

  h.controller.sessionChanged(null);

  assert.equal(h.rendered(), null);
  assert.equal(h.invalidations(), 1);
});

test('request A completing after request B cannot replace the new session result', async () => {
  const h = harness('game-a', 'user-1');
  void h.controller.review();
  h.controller.sessionChanged('user-2');
  void h.controller.review();

  h.resolve(1, review('game-a'));
  await h.flush();
  const requestBResult = h.rendered();
  assert.deepEqual(requestBResult, review('game-a'));
  h.resolve(0, review('game-a'));
  await h.flush();

  assert.equal(h.calls[0]!.signal.aborted, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.rendered(), requestBResult);
});

test('a response carrying another game identity is rejected at the final commit boundary', async () => {
  const h = harness('game-a', 'user-1');
  void h.controller.review();
  h.resolve(0, review('game-b'));
  await h.flush();

  assert.equal(h.rendered(), null);
  assert.equal(h.failures(), 1);
});

test('request rejection reports an error, while an aborted rejection stays silent', async () => {
  const failed = harness('game-a', 'user-1');
  void failed.controller.review();
  failed.reject(0, new Error('network failed'));
  await failed.flush();

  assert.equal(failed.failures(), 1);
  assert.deepEqual(failed.phases(), ['loading', 'error']);

  const aborted = harness('game-a', 'user-1');
  void aborted.controller.review();
  aborted.controller.sessionChanged(null);
  aborted.reject(0, new Error('aborted transport'));
  await aborted.flush();

  assert.equal(aborted.failures(), 0);
  assert.deepEqual(aborted.phases(), ['loading', 'idle']);
});
