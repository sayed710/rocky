import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisPort } from '../src/analysis/service.js';
import type { MistakePredictionInput, MistakePredictionOutcome } from '../src/analysis/mistake-prediction-service.js';
import type { FinishedGameForReview } from '../src/game-review/finished-game-review.js';
import { createGameReview } from '../src/game-review/composition.js';
import {
  GameReviewService,
  MAX_REVIEWED_PLAYER_MOVES,
} from '../src/game-review/service.js';
import { startHarness } from './helpers.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

/** Build one legal authoritative archive record with optional case-specific overrides. */
const game = (overrides: Partial<FinishedGameForReview> = {}): FinishedGameForReview => ({
  gameId: '00000000-0000-4000-8000-000000000001',
  variant: 'standard',
  white: 'white-player',
  black: 'black-player',
  result: '1-0',
  termination: 'resignation',
  moves: [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenBefore: FEN },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b', fenBefore: AFTER_E4_FEN },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w', fenBefore: AFTER_E4_E5_FEN },
  ],
  ...overrides,
});

/** Echo assessment identity while selecting the base mistake-prediction verdict. */
const outcome = (input: MistakePredictionInput, classification: MistakePredictionOutcome['classification']): MistakePredictionOutcome => ({
  fen: input.fen,
  variant: input.variant,
  move: input.move,
  classification,
  before: { evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
  after: { kind: 'evaluation', evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
  centipawnLoss: 10,
  bestMove: input.move,
  bestLine: [input.move],
  depth: 16,
});

const reviewAnalysis: AnalysisPort = {
  analyze: async (input) => ({
    fen: input.fen,
    variant: input.variant,
    applied: { depth: 16, movetimeMs: 1_000, multiPv: 2 },
    lines: [
      { multipv: 1, evaluation: { type: 'cp', value: 20 }, principalVariation: ['e2e4'], depth: 16, nodes: 1, nps: 1, timeMs: 1 },
      { multipv: 2, evaluation: { type: 'cp', value: -150 }, principalVariation: ['d2d4'], depth: 16, nodes: 1, nps: 1, timeMs: 1 },
    ],
  }),
  supportsVariant: () => true,
  supportsMultiPv: () => true,
  canSatisfyLimits: () => true,
};

/** Compose the service with a fixed archive result and capture every assessment input. */
function build(source: FinishedGameForReview | undefined) {
  const assessed: MistakePredictionInput[] = [];
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return source; } },
    analysis: reviewAnalysis,
    createMoveAssessment: () => ({
      async predict(input) {
        assessed.push(input);
        return outcome(input, input.move === 'g1f3' ? 'mistake' : 'ok');
      },
    }),
  });
  return { service, assessed };
}

test('completed-game review assesses only the authenticated player moves and returns their board positions', async () => {
  const { service, assessed } = build(game());
  let charged = 0;
  const result = await service.review({
    gameId: '00000000-0000-4000-8000-000000000001',
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => { charged += 1; });

  assert.equal(charged, 1);
  assert.deepEqual(assessed.map((entry) => entry.move), ['e2e4', 'g1f3']);
  assert.deepEqual(
    assessed.map((entry) => entry.analysisBefore?.map((line) => line.multipv)),
    [[1, 2], [1, 2]],
  );
  assert.equal(result.playerColor, 'white');
  assert.deepEqual(result.summary, {
    brilliant: 0, great: 1, best: 0, excellent: 0, good: 0, book: 0,
    inaccuracy: 0, mistake: 1, miss: 0, blunder: 0, missed_win: 0,
  });
  assert.deepEqual(result.moves.map((move) => [move.ply, move.san, move.fenBefore]), [
    [1, 'e4', FEN],
    [3, 'Nf3', AFTER_E4_E5_FEN],
  ]);
  assert.equal(
    Object.values(result.summary).reduce((total, count) => total + count, 0),
    result.moves.length,
  );
});

test('completed-game review selects the runner-up by MultiPV identity when engine lines are reordered', async () => {
  const reorderedAnalysis: AnalysisPort = {
    ...reviewAnalysis,
    analyze: async (input) => {
      const result = await reviewAnalysis.analyze(input);
      return { ...result, lines: [result.lines[1]!, result.lines[0]!] };
    },
  };
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return game({ moves: [game().moves[0]!] }); } },
    analysis: reorderedAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
  });

  const result = await service.review({
    gameId: game().gameId,
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => undefined);

  assert.equal(result.moves[0]!.classification, 'great');
  assert.equal(result.summary.great, 1);
});

test('completed-game review falls back to best when the runner-up MultiPV line is absent', async () => {
  const singleLineAnalysis: AnalysisPort = {
    ...reviewAnalysis,
    analyze: async (input) => {
      const result = await reviewAnalysis.analyze(input);
      return { ...result, lines: [result.lines[0]!] };
    },
  };
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return game({ moves: [game().moves[0]!] }); } },
    analysis: singleLineAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
  });

  const result = await service.review({
    gameId: game().gameId,
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => undefined);

  assert.equal(result.moves[0]!.classification, 'best');
  assert.equal(result.summary.best, 1);
});

test('completed-game review hides a game from a non-player without charging or assessing it', async () => {
  const { service, assessed } = build(game());
  let charged = 0;
  await assert.rejects(
    () => service.review({
      gameId: '00000000-0000-4000-8000-000000000001',
      userId: 'spectator',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'not_found' },
  );
  assert.equal(charged, 0);
  assert.equal(assessed.length, 0);
});

test('completed-game review rejects a mismatched archive identity before charging or assessing it', async () => {
  const requestedGameId = game().gameId;
  const { service, assessed } = build(game({
    gameId: '00000000-0000-4000-8000-000000000002',
  }));
  let charged = 0;

  await assert.rejects(
    () => service.review({
      gameId: requestedGameId,
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'not_found' },
  );

  assert.equal(charged, 0);
  assert.equal(assessed.length, 0);
});

test('completed-game review provides bounded partial review for overlong games with explicit metadata', async () => {
  const totalMoves = MAX_REVIEWED_PLAYER_MOVES + 15;
  const moves = Array.from({ length: totalMoves }, (_, index) => ({
    ply: index * 2 + 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w' as const,
    fenBefore: FEN,
  }));
  const { service, assessed } = build(game({ moves }));
  let charged = 0;
  const result = await service.review({
    gameId: '00000000-0000-4000-8000-000000000001',
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => { charged += 1; });

  assert.equal(charged, 1);
  assert.equal(result.isPartial, true);
  assert.equal(result.totalPlayerMoves, totalMoves);
  assert.equal(result.analyzedPlayerMoves, MAX_REVIEWED_PLAYER_MOVES);
  assert.equal(result.cutoffReason, 'move_limit');
  assert.equal(result.moves.length, MAX_REVIEWED_PLAYER_MOVES);
  assert.equal(assessed.length, MAX_REVIEWED_PLAYER_MOVES);
  assert.equal(
    Object.values(result.summary).reduce((total, count) => total + count, 0),
    MAX_REVIEWED_PLAYER_MOVES,
  );
});

test('completed-game review at the move limit remains complete', async () => {
  const moves = Array.from({ length: MAX_REVIEWED_PLAYER_MOVES }, (_, index) => ({
    ply: index * 2 + 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w' as const,
    fenBefore: FEN,
  }));
  const { service } = build(game({ moves }));

  const result = await service.review({
    gameId: '00000000-0000-4000-8000-000000000001',
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => undefined);

  assert.equal(result.isPartial, false);
  assert.equal(result.totalPlayerMoves, MAX_REVIEWED_PLAYER_MOVES);
  assert.equal(result.analyzedPlayerMoves, MAX_REVIEWED_PLAYER_MOVES);
  assert.equal(result.cutoffReason, undefined);
  assert.equal(result.moves.length, MAX_REVIEWED_PLAYER_MOVES);
});

test('completed-game review of a normal-length game marks isPartial as false', async () => {
  const { service, assessed } = build(game());
  let charged = 0;
  const result = await service.review({
    gameId: '00000000-0000-4000-8000-000000000001',
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => { charged += 1; });

  assert.equal(charged, 1);
  assert.equal(result.isPartial, false);
  assert.equal(result.totalPlayerMoves, 2);
  assert.equal(result.analyzedPlayerMoves, 2);
  assert.equal(result.cutoffReason, undefined);
  assert.equal(result.moves.length, 2);
  assert.equal(assessed.length, 2);
});

test('completed-game review rejects a game with zero player moves before charging', async () => {
  const moves = [
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' as const, fenBefore: AFTER_E4_FEN },
  ];
  const { service, assessed } = build(game({ moves }));
  let charged = 0;
  await assert.rejects(
    () => service.review({
      gameId: '00000000-0000-4000-8000-000000000001',
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'validation_failed' },
  );
  assert.equal(charged, 0);
  assert.equal(assessed.length, 0);
});

test('cancellation during archive lookup is rejected before review quota is charged', async () => {
  let resolveArchive: ((source: FinishedGameForReview) => void) | undefined;
  const archiveResult = new Promise<FinishedGameForReview>((resolve) => { resolveArchive = resolve; });
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return archiveResult; } },
    analysis: reviewAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
  });
  const controller = new AbortController();
  let charged = 0;

  const pending = service.review({
    gameId: game().gameId,
    userId: 'white-player',
    signal: controller.signal,
  }, async () => { charged += 1; });
  controller.abort();
  resolveArchive!(game());

  await assert.rejects(pending, { code: 'service_unavailable', message: 'game review was cancelled' });
  assert.equal(charged, 0);
});

test('completed-game review rejects an unsupported engine policy before charging the player', async () => {
  let analyzed = 0;
  const unsupportedAnalysis: AnalysisPort = {
    ...reviewAnalysis,
    analyze: async (input) => {
      analyzed += 1;
      return reviewAnalysis.analyze(input);
    },
    supportsMultiPv: () => false,
  };
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return game(); } },
    analysis: unsupportedAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
  });
  let charged = 0;

  await assert.rejects(
    () => service.review({
      gameId: game().gameId,
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'validation_failed' },
  );
  assert.equal(charged, 0);
  assert.equal(analyzed, 0);
});

test('completed-game review enforces a server-owned total deadline', async () => {
  let observedSignal: AbortSignal | undefined;
  const hangingAnalysis: AnalysisPort = {
    ...reviewAnalysis,
    analyze: (input) => new Promise((_, reject) => {
      observedSignal = input.signal;
      input.signal?.addEventListener('abort', () => reject(new Error('engine stopped')), { once: true });
    }),
  };
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return game(); } },
    analysis: hangingAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
    deadlineMs: 5,
  });

  await assert.rejects(
    () => service.review({
      gameId: game().gameId,
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => undefined),
    { code: 'service_unavailable', message: 'game review deadline exceeded' },
  );
  assert.equal(observedSignal?.aborted, true);
});

test('Game Review composition stays absent unless one variant can honor its exact policy', () => {
  const archive = { async finishedGameForReview() { return undefined; } };
  const insufficientLimits: AnalysisPort = {
    ...reviewAnalysis,
    canSatisfyLimits: () => false,
  };
  const noMultiPv: AnalysisPort = {
    ...reviewAnalysis,
    supportsMultiPv: () => false,
  };
  const standardOnly: AnalysisPort = {
    ...reviewAnalysis,
    supportsMultiPv: (variant, count) => variant === 'standard' && count === 2,
  };

  assert.equal(createGameReview(insufficientLimits, archive), undefined);
  assert.equal(createGameReview(noMultiPv, archive), undefined);
  const composed = createGameReview(standardOnly, archive);
  assert.ok(composed);
  assert.equal(composed.supportsVariant('standard'), true);
  assert.equal(composed.supportsVariant('atomic'), false);
});

test('POST /v1/games/:id/review requires a player token and presents only that player\'s review', async () => {
  let source: FinishedGameForReview | undefined;
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return source; } },
    analysis: reviewAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'blunder'); } }),
  });
  const h = await startHarness({}, { gameReview: service });
  try {
    const white = await h.makeUser('reviewwhite');
    const spectator = await h.makeUser('reviewspectator');
    source = game({ white: white.userId });

    const unauthenticated = await h.json('POST', `/v1/games/${source.gameId}/review`);
    assert.equal(unauthenticated.status, 401);

    const hidden = await h.json('POST', `/v1/games/${source.gameId}/review`, { token: spectator.token });
    assert.equal(hidden.status, 404);

    const withBody = await h.json('POST', `/v1/games/${source.gameId}/review`, {
      token: white.token,
      body: {},
    });
    assert.equal(withBody.status, 422);

    const response = await h.json('POST', `/v1/games/${source.gameId}/review`, { token: white.token });
    assert.equal(response.status, 200);
    assert.equal(response.body.playerColor, 'white');
    assert.equal(response.body.moves.length, 2);
    assert.equal(response.body.moves[0].san, 'e4');
    assert.equal(response.body.moves[0].assessment.classification, 'blunder');
    assert.equal(response.body.moves[0].classification, 'blunder');
    assert.equal(response.body.summary.blunder, 2);
  } finally {
    await h.close();
  }
});
