import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import { InvalidFenError } from '@chess-platform/engine';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';
import { MoveExplainer } from '@chess-platform/ai-features';
import { CoreFenValidator } from '../src/analysis/fen-validator';
import { AnalysisService } from '../src/analysis/service';
import { createPuzzleGeneration, createMistakePrediction } from '../src/analysis/composition';
import { MoveExplanationService } from '../src/ai/move-explanation-service';
import { CorePositionReader } from '../src/studies/position-reader';
import { startHarness } from './helpers';

const FEN_ADJACENT_KINGS = '8/8/8/8/8/8/8/kK6 b - - 0 1';
const FEN_ADJACENT_KINGS_BISHOP = '8/8/8/8/8/8/B7/kK6 b - - 0 1';
const FEN_SIDE_NOT_TO_MOVE_IN_CHECK = '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1';
const ATOMIC_WIN_FIXTURE = '8/8/3k4/3n4/5N2/8/8/K7 w - - 0 1';

class CountingAnalysisProvider implements AnalysisProvider {
  calls = 0;
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.calls++;
    return [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 35 },
        principalVariation: ['e2e4', 'e7e5'],
        depth: 16,
        selDepth: 16,
        nodes: 1000,
        nps: 1000,
        timeMs: 10,
      },
    ];
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

test('F125-01/F125-02: CoreFenValidator unit rejects recorded illegal FENs and variant edge cases', () => {
  const validator = new CoreFenValidator();

  // 1. Three recorded FENs from Issue 125
  assert.throws(
    () => validator.validate(FEN_ADJACENT_KINGS, 'standard'),
    InvalidFenError,
    'adjacent kings must be rejected',
  );
  assert.throws(
    () => validator.validate(FEN_ADJACENT_KINGS_BISHOP, 'standard'),
    InvalidFenError,
    'adjacent kings with bishop must be rejected',
  );
  assert.throws(
    () => validator.validate(FEN_SIDE_NOT_TO_MOVE_IN_CHECK, 'standard'),
    InvalidFenError,
    'side not to move in check must be rejected',
  );

  // 2. Crazyhouse pocket kings
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[K] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[k] w KQkq - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Kk] w KQkq - 0 1',
  ]) {
    assert.throws(
      () => validator.validate(fen, 'crazyhouse'),
      InvalidFenError,
      `crazyhouse pocket king must be rejected: ${fen}`,
    );
  }

  // 3. Variant rules
  // Atomic allows adjacent kings
  assert.doesNotThrow(() => {
    validator.validate('8/8/8/3k4/3K4/8/8/8 w - - 0 1', 'atomic');
  });

  // Racing Kings: neither king may be checked (both kings present, non-adjacent)
  assert.throws(
    () => validator.validate('5r2/8/8/8/8/8/8/3k1K2 w - - 0 1', 'racingkings'),
    InvalidFenError,
  );
  assert.throws(
    () => validator.validate('3R4/8/8/8/8/8/8/3k1K2 b - - 0 1', 'racingkings'),
    InvalidFenError,
  );

  // Horde: Black king in check on White turn is illegal
  assert.throws(
    () => validator.validate('4k3/8/8/8/8/8/8/4R3 w - - 0 1', 'horde'),
    InvalidFenError,
  );
});

test('F125-04/F125-C1/F125-I1: API caller FEN ingress returns stable 422 and does not dispatch to engine or LLM', async (t) => {
  const provider = new CountingAnalysisProvider();
  const fakeAi = new FakeProvider({
    id: 'mock-llm',
    model: 'mock-model',
    content: 'e4 stakes a claim in the center and frees lines for the queen and bishop.',
  });
  const explainer = new MoveExplainer({
    ai: fakeAi,
    defaultVariant: 'standard',
    temperature: 0.3,
    maxTokens: 512,
  });

  const analysis = new AnalysisService({ provider });
  const puzzleGeneration = createPuzzleGeneration(analysis);
  const mistakePrediction = createMistakePrediction(analysis);
  const moveExplanation = new MoveExplanationService({ analysis, explainer });

  const h = await startHarness(
    {},
    {
      analysis,
      puzzleGeneration,
      mistakePrediction,
      moveExplanation,
    },
  );
  t.after(() => h.close());

  const user = await h.makeUser('fen-tester', ['admin']);
  const startFen = Position.initial('standard').fen();

  // --- Positive controls proving instrumentation catches real dispatches ---
  // 1. Positive analysis dispatch
  const validAnalysisRes = await h.json('POST', '/v1/analysis', {
    token: user.token,
    body: { fen: startFen, variant: 'standard' },
  });
  assert.equal(validAnalysisRes.status, 200);
  assert.equal(provider.calls, 1, 'positive control: engine provider was called once');

  // 2. Positive move explanation dispatch
  const validExplainRes = await h.json('POST', '/v1/ai/move-explanation', {
    token: user.token,
    body: { fen: startFen, variant: 'standard', move: 'e2e4' },
  });
  assert.equal(validExplainRes.status, 200);
  assert.equal(fakeAi.calls.length, 1, 'positive control: fakeAi was called once');
  // Record baseline dispatch counts after positive controls
  const baseEngineCalls = provider.calls;
  const baseAiCalls = fakeAi.calls.length;

  // --- Negative checks across all routes: dispatches must remain at baseline ---

  // 1. POST /v1/analysis with adjacent kings
  const resAnalysis = await h.json('POST', '/v1/analysis', {
    token: user.token,
    body: { fen: FEN_ADJACENT_KINGS, variant: 'standard' },
  });
  assert.equal(resAnalysis.status, 422, 'analysis must return 422 for adjacent kings');
  assert.equal(resAnalysis.body.error.code, 'validation_failed');
  assert.equal(resAnalysis.body.error.message, 'invalid FEN');
  assert.deepEqual(resAnalysis.body.error.details, { fen: 'invalid FEN' });
  assert.equal(provider.calls, baseEngineCalls, 'engine provider must not be called');
  assert.equal(fakeAi.calls.length, baseAiCalls, 'LLM provider must not be called');

  // 2. POST /v1/analysis/puzzle with adjacent kings
  const resPuzzle = await h.json('POST', '/v1/analysis/puzzle', {
    token: user.token,
    body: { fen: FEN_ADJACENT_KINGS, variant: 'standard' },
  });
  assert.equal(resPuzzle.status, 422, 'puzzle generation must return 422 for adjacent kings');
  assert.equal(resPuzzle.body.error.code, 'validation_failed');
  assert.equal(resPuzzle.body.error.message, 'invalid FEN');
  assert.deepEqual(resPuzzle.body.error.details, { fen: 'invalid FEN' });
  assert.equal(provider.calls, baseEngineCalls);
  assert.equal(fakeAi.calls.length, baseAiCalls);

  // 3. POST /v1/analysis/mistake-prediction with adjacent kings
  const resMistake = await h.json('POST', '/v1/analysis/mistake-prediction', {
    token: user.token,
    body: { fen: FEN_ADJACENT_KINGS, variant: 'standard', move: 'a1b1' },
  });
  assert.equal(resMistake.status, 422, 'mistake prediction must return 422 for adjacent kings');
  assert.equal(resMistake.body.error.code, 'validation_failed');
  assert.equal(resMistake.body.error.message, 'invalid FEN');
  assert.deepEqual(resMistake.body.error.details, { fen: 'invalid FEN' });
  assert.equal(provider.calls, baseEngineCalls);
  assert.equal(fakeAi.calls.length, baseAiCalls);

  // 4. POST /v1/coach with adjacent kings
  const resCoach = await h.json('POST', '/v1/coach', {
    token: user.token,
    body: { fen: FEN_ADJACENT_KINGS, variant: 'standard' },
  });
  assert.equal(resCoach.status, 422, 'coach must return 422 for adjacent kings');
  assert.equal(resCoach.body.error.code, 'validation_failed');
  assert.equal(resCoach.body.error.message, 'invalid FEN');
  assert.deepEqual(resCoach.body.error.details, { fen: 'invalid FEN' });
  assert.equal(provider.calls, baseEngineCalls);
  assert.equal(fakeAi.calls.length, baseAiCalls);

  // 5. POST /v1/ai/move-explanation with adjacent kings
  const resExplain = await h.json('POST', '/v1/ai/move-explanation', {
    token: user.token,
    body: { fen: FEN_ADJACENT_KINGS, variant: 'standard', move: 'a1b1' },
  });
  assert.equal(resExplain.status, 422, 'move explanation must return 422 for adjacent kings');
  assert.equal(resExplain.body.error.code, 'validation_failed');
  assert.equal(resExplain.body.error.message, 'invalid FEN');
  assert.deepEqual(resExplain.body.error.details, { fen: 'invalid FEN' });
  assert.equal(provider.calls, baseEngineCalls);
  assert.equal(fakeAi.calls.length, baseAiCalls);

  // 6. POST /v1/study-partner/sessions with adjacent kings
  const resStudyPartner = await h.json('POST', '/v1/study-partner/sessions', {
    token: user.token,
    body: { initialFen: FEN_ADJACENT_KINGS, variant: 'standard' },
  });
  assert.equal(resStudyPartner.status, 422, 'study-partner create must return 422');
  assert.equal(resStudyPartner.body.error.code, 'validation_failed');
  assert.equal(resStudyPartner.body.error.message, 'invalid FEN');
  assert.deepEqual(resStudyPartner.body.error.details, { initialFen: 'invalid FEN for variant' });
  assert.equal(provider.calls, baseEngineCalls);
  assert.equal(fakeAi.calls.length, baseAiCalls);

  // 7. POST /v1/studies/:id/chapters with adjacent kings startingFen
  const studyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Test Study', visibility: 'public', variant: 'standard' },
  });
  assert.equal(studyRes.status, 201, 'study creation prerequisite must succeed');
  const studyId = studyRes.body.id as string;
  const resChapter = await h.json('POST', `/v1/studies/${studyId}/chapters`, {
    token: user.token,
    body: { name: 'Illegal Chapter', startingFen: FEN_ADJACENT_KINGS },
  });
  assert.equal(resChapter.status, 422, 'study chapter create must return 422 for adjacent kings');
  assert.equal(resChapter.body.error.code, 'validation_failed');
  assert.ok(resChapter.body.error.message.includes('startingFen is not a valid FEN'));
  assert.deepEqual(resChapter.body.error.details, { startingFen: 'invalid FEN' });

  // 8. POST /v1/lessons/:id/steps with illegal rook FEN and expectedSan Rxe8
  const courseRes = await h.json('POST', '/v1/courses', {
    token: user.token,
    body: {
      slug: 'test-course',
      title: 'Test Course',
      description: 'Course',
      difficulty: 'beginner',
    },
  });
  assert.equal(courseRes.status, 201, 'course creation prerequisite must succeed');
  const courseId = courseRes.body.id as string;

  // F125-I1: lesson create body ONLY has title
  const lessonRes = await h.json('POST', `/v1/courses/${courseId}/lessons`, {
    token: user.token,
    body: {
      title: 'Test Lesson',
    },
  });
  assert.equal(lessonRes.status, 201, 'lesson creation prerequisite must succeed');
  assert.ok(lessonRes.body.id, 'lesson creation returned ID');
  const lessonId = lessonRes.body.id as string;

  const resStepCreate = await h.json('POST', `/v1/lessons/${lessonId}/steps`, {
    token: user.token,
    body: {
      kind: 'move',
      fen: FEN_SIDE_NOT_TO_MOVE_IN_CHECK,
      expectedSan: 'Rxe8',
    },
  });
  assert.equal(resStepCreate.status, 422, 'lesson step create must return 422 for illegal rook FEN');
  assert.equal(resStepCreate.body.error.code, 'validation_failed');
  assert.ok(resStepCreate.body.error.message.includes("'Rxe8' is not a legal move from FEN"));

  // 9. PATCH /v1/steps/:id with illegal rook FEN
  const legalStepRes = await h.json('POST', `/v1/lessons/${lessonId}/steps`, {
    token: user.token,
    body: {
      kind: 'move',
      fen: Position.initial().fen(),
      expectedSan: 'e4',
    },
  });
  assert.equal(legalStepRes.status, 201, 'legal step prerequisite must succeed');
  const legalStepId = legalStepRes.body.id as string;

  const resStepPatch = await h.json('PATCH', `/v1/steps/${legalStepId}`, {
    token: user.token,
    body: {
      fen: FEN_SIDE_NOT_TO_MOVE_IN_CHECK,
      expectedSan: 'Rxe8',
    },
  });
  assert.equal(resStepPatch.status, 422, 'lesson step patch must return 422 for illegal rook FEN');
  assert.equal(resStepPatch.body.error.code, 'validation_failed');
  assert.ok(resStepPatch.body.error.message.includes("'Rxe8' is not a legal move from FEN"));

  // 10. POST /v1/studies/:id/import with illegal PGN [FEN]
  // Empty movetext
  const pgnEmptyMoves = `[Event "Test"]
[Site "Chess Platform"]
[FEN "${FEN_SIDE_NOT_TO_MOVE_IN_CHECK}"]

*`;
  const resImportEmpty = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnEmptyMoves },
  });
  assert.equal(resImportEmpty.status, 422, 'study import empty movetext with illegal FEN must return 422');
  assert.equal(resImportEmpty.body.error.code, 'validation_failed');
  assert.ok(resImportEmpty.body.error.message.includes('position is not a valid FEN'));

  // With moves
  const pgnWithMoves = `[Event "Test"]
[Site "Chess Platform"]
[FEN "${FEN_SIDE_NOT_TO_MOVE_IN_CHECK}"]

1. Rxe8# *`;
  const resImportMoves = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnWithMoves },
  });
  assert.equal(resImportMoves.status, 422, 'study import with illegal FEN must return 422');
  assert.equal(resImportMoves.body.error.code, 'validation_failed');
  assert.ok(resImportMoves.body.error.message.includes('position is not a valid FEN'));

  // Mixed games: 1 valid game followed by 1 invalid game - must not write any chapter!
  const pgnMixed = `[Event "Valid Game"]
[Site "Chess Platform"]

1. e4 e5 *

[Event "Invalid Game"]
[Site "Chess Platform"]
[FEN "${FEN_SIDE_NOT_TO_MOVE_IN_CHECK}"]

1. Rxe8# *`;
  const resImportMixed = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnMixed },
  });
  assert.equal(resImportMixed.status, 422, 'study import mixed games must return 422');
  assert.equal(resImportMixed.body.error.code, 'validation_failed');
  assert.ok(resImportMixed.body.error.message.includes('position is not a valid FEN'));

  // Verify zero chapters were written for study (atomic failure, no partial writes)
  const chaptersRes = await h.json('GET', `/v1/studies/${studyId}/chapters`, { token: user.token });
  assert.equal(chaptersRes.status, 200);
  assert.equal(chaptersRes.body.items.length, 0, 'zero chapters must be written when import fails');

  // Final check: provider and LLM calls must remain exactly at baseline
  assert.equal(provider.calls, baseEngineCalls, 'engine provider calls must remain at baseline');
  assert.equal(fakeAi.calls.length, baseAiCalls, 'LLM calls must remain at baseline');
});

test('F125-C2: Horde study chapter creation and PGN import default to Horde initial position', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const user = await h.makeUser('horde-tester', ['admin']);

  // 1. Create a Horde study
  const studyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Horde Repertoire', visibility: 'public', variant: 'horde' },
  });
  assert.equal(studyRes.status, 201);
  const studyId = studyRes.body.id as string;
  const hordeInitial = Position.initial('horde').fen();

  // 2. Create chapter with omitted startingFen
  const chapterRes = await h.json('POST', `/v1/studies/${studyId}/chapters`, {
    token: user.token,
    body: { name: 'Horde Chapter 1' },
  });
  assert.equal(chapterRes.status, 201);
  assert.equal(chapterRes.body.startingFen, hordeInitial, 'omitted startingFen must default to hordeInitial');

  // 3. Import PGN without [FEN] tag into Horde study
  const pgnWithoutFen = `[Event "Horde Test"]
[Site "Chess Platform"]

*`;
  const importRes = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnWithoutFen },
  });
  assert.equal(importRes.status, 200);
  assert.equal(importRes.body.items[0].startingFen, hordeInitial, 'PGN import without FEN must use hordeInitial');

  // 3b. Create a Racing Kings study with omitted startingFen
  const rkStudyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'RK Repertoire', visibility: 'public', variant: 'racingkings' },
  });
  assert.equal(rkStudyRes.status, 201);
  const rkStudyId = rkStudyRes.body.id as string;
  const rkInitial = Position.initial('racingkings').fen();
  const rkChapterRes = await h.json('POST', `/v1/studies/${rkStudyId}/chapters`, {
    token: user.token,
    body: { name: 'RK Chapter 1' },
  });
  assert.equal(rkChapterRes.status, 201);
  assert.equal(rkChapterRes.body.startingFen, rkInitial, 'omitted startingFen must default to rkInitial');

  // 4. Engine-neutral initialFen control across all variants
  const reader = new CorePositionReader();
  const variants = ['standard', 'chess960', 'threecheck', 'crazyhouse', 'kingofthehill', 'atomic', 'horde', 'racingkings'] as const;
  for (const v of variants) {
    assert.equal(reader.initialFen(v), Position.initial(v).fen(), `initialFen for ${v} matches Position.initial`);
  }
});

test('Atomic strict input vs derived leaf: legal win append/import succeeds; continuation and forged setups reject', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const user = await h.makeUser('atomic-tester', ['admin']);

  // 1. Create Atomic study
  const studyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Atomic Explosions', visibility: 'public', variant: 'atomic' },
  });
  assert.equal(studyRes.status, 201);
  const studyId = studyRes.body.id as string;

  // 2. Create chapter with valid 2-king starting position: ATOMIC_WIN_FIXTURE
  const chapterRes = await h.json('POST', `/v1/studies/${studyId}/chapters`, {
    token: user.token,
    body: { name: 'Winning Move Chapter', startingFen: ATOMIC_WIN_FIXTURE },
  });
  assert.equal(chapterRes.status, 201);
  const chapterId = chapterRes.body.id as string;

  // 3. Append winning move Nxd5 (explodes Black king, White king survives)
  const appendRes = await h.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
    token: user.token,
    body: { san: 'Nxd5' },
  });
  assert.equal(appendRes.status, 201, 'winning move append must succeed');
  const winNodeId = appendRes.body.id as string;

  // 4. Stored leaf is readable and exportable
  const readRes = await h.json('GET', `/v1/studies/${studyId}/chapters/${chapterId}`, { token: user.token });
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.tree.length, 1);
  assert.equal(readRes.body.tree[0].san, 'Nxd5');

  const exportRes = await fetch(`${h.baseUrl}/v1/studies/${studyId}/export.pgn`);
  assert.equal(exportRes.status, 200);
  const pgnText = await exportRes.text();
  assert.ok(pgnText.includes('Nxd5'));

  // 5. Continuation after winning leaf must be rejected (one-king FEN cannot be continued from)
  const contRes = await h.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
    token: user.token,
    body: { parentId: winNodeId, san: 'a4' },
  });
  assert.equal(contRes.status, 422, 'continuation from terminal one-king leaf must return 422');

  // Verify tree still only has 1 node (zero added nodes)
  const readAfterCont = await h.json('GET', `/v1/studies/${studyId}/chapters/${chapterId}`, { token: user.token });
  assert.equal(readAfterCont.body.tree.length, 1);

  // 6. Import PGN ending with winning move succeeds
  const pgnWin = `[Event "Atomic Win PGN"]
[Variant "atomic"]
[FEN "${ATOMIC_WIN_FIXTURE}"]

1. Nxd5 *`;
  const importWinRes = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnWin },
  });
  assert.equal(importWinRes.status, 200, 'import PGN with winning leaf must succeed');

  // 7. PGN with movetext continuing past the winning explosion must reject with zero chapters added
  const currentChapters = await h.json('GET', `/v1/studies/${studyId}/chapters`, { token: user.token });
  const chapterCountBefore = currentChapters.body.items.length;

  const pgnOverCont = `[Event "Atomic Overcontinuation"]
[Variant "atomic"]
[FEN "${ATOMIC_WIN_FIXTURE}"]

1. Nxd5 a5 *`;
  const importOverRes = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnOverCont },
  });
  assert.equal(importOverRes.status, 422, 'import with extra move after king explosion must reject');

  const chaptersAfterOver = await h.json('GET', `/v1/studies/${studyId}/chapters`, { token: user.token });
  assert.equal(chaptersAfterOver.body.items.length, chapterCountBefore, 'no chapters added on failed import');

  // 8. Forged one-king chapter FEN must be rejected
  const forgedChapterRes = await h.json('POST', `/v1/studies/${studyId}/chapters`, {
    token: user.token,
    body: { name: 'Forged 1-King', startingFen: '8/8/8/8/8/8/8/K7 w - - 0 1' },
  });
  assert.equal(forgedChapterRes.status, 422, 'forged one-king chapter FEN must be rejected');

  // 9. Forged one-king PGN FEN (both empty movetext and with moves) must be rejected
  const pgnForgedEmpty = `[Event "Forged Empty"]
[Variant "atomic"]
[FEN "8/8/8/8/8/8/8/K7 w - - 0 1"]

*`;
  const importForgedEmpty = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnForgedEmpty },
  });
  assert.equal(importForgedEmpty.status, 422, 'forged one-king PGN with empty movetext must be rejected');

  const pgnForgedMoves = `[Event "Forged Moves"]
[Variant "atomic"]
[FEN "8/8/8/8/8/8/8/K7 w - - 0 1"]

1. Ka2 *`;
  const importForgedMoves = await h.json('POST', `/v1/studies/${studyId}/import`, {
    token: user.token,
    body: { pgn: pgnForgedMoves },
  });
  assert.equal(importForgedMoves.status, 422, 'forged one-king PGN with moves must be rejected');
});

test('F125-05: historical stored invalid StudyPartner session turn returns 422 and does not crash or dispatch', async (t) => {
  const provider = new CountingAnalysisProvider();
  const fakeAi = new FakeProvider({
    id: 'mock-llm',
    model: 'mock-model',
    content: 'mock explanation',
  });
  const explainer = new MoveExplainer({
    ai: fakeAi,
    defaultVariant: 'standard',
    temperature: 0.3,
    maxTokens: 512,
  });

  const analysis = new AnalysisService({ provider });
  const puzzleGeneration = createPuzzleGeneration(analysis);
  const mistakePrediction = createMistakePrediction(analysis);
  const moveExplanation = new MoveExplanationService({ analysis, explainer });

  const h = await startHarness(
    {},
    {
      analysis,
      puzzleGeneration,
      mistakePrediction,
      moveExplanation,
    },
  );
  t.after(() => h.close());

  const user = await h.makeUser('historical-partner-tester', ['admin']);

  // Simulate an invalid session created in storage prior to strict FEN ingress validation
  const corruptSessionId = '00000000-0000-7000-8000-000000000099';
  await h.repos.studyPartner.createSession({
    id: corruptSessionId,
    ownerId: user.userId,
    variant: 'standard',
    initialFen: FEN_ADJACENT_KINGS,
    now: new Date(),
  });

  // Attempting to submit a turn must gracefully return 422 rather than unhandled 500 or engine dispatch
  const turnRes = await h.json('POST', `/v1/study-partner/sessions/${corruptSessionId}/turns`, {
    token: user.token,
    body: { move: 'a1b1', expectedVersion: 0 },
    headers: { 'Idempotency-Key': 'key-corrupt-1' },
  });

  assert.equal(turnRes.status, 422, 'must return 422 for corrupt stored session FEN');
  assert.equal(turnRes.body.error.code, 'validation_failed');
  assert.equal(turnRes.body.error.message, 'invalid FEN in study partner session');
  assert.deepEqual(turnRes.body.error.details, { currentFen: 'invalid FEN for variant' });

  // Engine and LLM must not be called
  assert.equal(provider.calls, 0);
  assert.equal(fakeAi.calls.length, 0);
});

test('Atomic four-move sequence reachable FEN accepted across caller ingress with winning blast capture', async (t) => {
  const provider = new CountingAnalysisProvider();
  const analysis = new AnalysisService({ provider });
  const h = await startHarness({}, { analysis });
  t.after(() => h.close());
  const user = await h.makeUser('atomic-blast-tester', ['admin']);

  // Four legal Atomic moves from initial setup: 1. e4 Nc6 2. Qh5 a6
  // Exact reachable FEN before winning capture Qxf7#:
  const blastFen = 'r1bqkbnr/1ppppppp/p1n5/7Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3';

  // 1. Validator directly accepts the reachable setup
  const validator = new CoreFenValidator();
  assert.doesNotThrow(() => validator.validate(blastFen, 'atomic'));

  // 2. POST /v1/analysis accepts the FEN
  const analysisRes = await h.json('POST', '/v1/analysis', {
    token: user.token,
    body: {
      fen: blastFen,
      variant: 'atomic',
    },
  });
  assert.equal(analysisRes.status, 200, 'analysis must accept valid Atomic blast setup');
  assert.equal(analysisRes.body.variant, 'atomic');

  // 3. POST /v1/studies creates an atomic study and chapter with this starting position
  const studyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Atomic Blast Study', visibility: 'public', variant: 'atomic' },
  });
  assert.equal(studyRes.status, 201);
  const studyId = studyRes.body.id as string;

  const chapterRes = await h.json('POST', `/v1/studies/${studyId}/chapters`, {
    token: user.token,
    body: { name: 'Qxf7 Blast Chapter', startingFen: blastFen },
  });
  assert.equal(chapterRes.status, 201);
  const chapterId = chapterRes.body.id as string;

  // 4. Append winning capture Qxf7 (explodes Black king on e8)
  const appendWin = await h.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
    token: user.token,
    body: { san: 'Qxf7' },
  });
  assert.equal(appendWin.status, 201, 'winning capture Qxf7 must succeed');
  assert.equal(
    appendWin.body.fenAfter,
    'r1bq3r/1pppp1pp/p1n5/8/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3',
    'winning blast eliminates Black king leaving 1-king leaf',
  );

  // 5. Continuation past winning leaf is rejected
  const contRes = await h.json('POST', `/v1/studies/${studyId}/chapters/${chapterId}/nodes`, {
    token: user.token,
    body: { san: 'e5', parentId: appendWin.body.id },
  });
  assert.equal(contRes.status, 422, 'continuation past terminal blast leaf must return 422');
});

test('F125-06: PGN export/import round-trip preserves exact start across variants and legacy setups (Qodo fef0004f)', async (t) => {
  const provider = new CountingAnalysisProvider();
  const analysis = new AnalysisService({ provider });
  const h = await startHarness({}, { analysis });
  t.after(() => h.close());
  const user = await h.makeUser('export-roundtrip-tester', ['admin']);

  const reader = new CorePositionReader();

  // 1. Stored legacy Racing Kings with Standard start export includes FEN tag and roundtrips faithfully
  const legacyStudyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Legacy RK Study', visibility: 'public', variant: 'racingkings' },
  });
  assert.equal(legacyStudyRes.status, 201);
  const legacyStudyId = legacyStudyRes.body.id as string;

  const standardStartFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const legacyChapterRes = await h.json('POST', `/v1/studies/${legacyStudyId}/chapters`, {
    token: user.token,
    body: { name: 'Legacy Standard Start Chapter', startingFen: standardStartFen },
  });
  assert.equal(legacyChapterRes.status, 201);
  const legacyChapterId = legacyChapterRes.body.id as string;

  const legacyExportRes = await fetch(`${h.baseUrl}/v1/studies/${legacyStudyId}/export.pgn?chapterId=${legacyChapterId}`, {
    headers: { authorization: `Bearer ${user.token}` },
  });
  assert.equal(legacyExportRes.status, 200);
  const legacyPgn = await legacyExportRes.text();
  assert.ok(legacyPgn.includes(`[FEN "${standardStartFen}"]`), 'export of legacy standard start under RK must include FEN tag');

  // Reimporting this PGN must preserve the exact legacy standard start FEN
  const reimportStudyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Reimported Legacy RK', visibility: 'public', variant: 'racingkings' },
  });
  assert.equal(reimportStudyRes.status, 201);
  const reimportStudyId = reimportStudyRes.body.id as string;

  const reimportRes = await h.json('POST', `/v1/studies/${reimportStudyId}/import`, {
    token: user.token,
    body: { pgn: legacyPgn },
  });
  assert.equal(reimportRes.status, 200);
  assert.equal(reimportRes.body.items.length, 1);
  assert.equal(reimportRes.body.items[0].startingFen, standardStartFen, 'reimported chapter must retain exact legacy start');

  // 2. Canonical Racing Kings omitted start exports WITHOUT FEN tag and roundtrips to canonical RK start
  const canonicalRkStudyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Canonical RK Study', visibility: 'public', variant: 'racingkings' },
  });
  const canonicalRkStudyId = canonicalRkStudyRes.body.id as string;
  const canonicalRkChapterRes = await h.json('POST', `/v1/studies/${canonicalRkStudyId}/chapters`, {
    token: user.token,
    body: { name: 'Default Start Chapter' },
  });
  const canonicalRkChapterId = canonicalRkChapterRes.body.id as string;
  const canonicalExportRes = await fetch(`${h.baseUrl}/v1/studies/${canonicalRkStudyId}/export.pgn?chapterId=${canonicalRkChapterId}`, {
    headers: { authorization: `Bearer ${user.token}` },
  });
  const canonicalPgn = await canonicalExportRes.text();
  assert.ok(!canonicalPgn.includes('[FEN '), 'export of canonical RK start must omit FEN tag');

  const canonicalReimportStudyRes = await h.json('POST', '/v1/studies', {
    token: user.token,
    body: { name: 'Canonical Reimport', visibility: 'public', variant: 'racingkings' },
  });
  const canonicalReimportId = canonicalReimportStudyRes.body.id as string;
  const canonicalReimportRes = await h.json('POST', `/v1/studies/${canonicalReimportId}/import`, {
    token: user.token,
    body: { pgn: canonicalPgn },
  });
  assert.equal(canonicalReimportRes.status, 200);
  assert.equal(
    canonicalReimportRes.body.items[0].startingFen,
    '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
    'reimport of canonical RK export must derive canonical RK start',
  );

  // 3. Direct InMemoryStudiesRepository verification with CorePositionReader (matching root probe)
  const { InMemoryStudiesRepository } = await import('@chess-platform/studies');
  const repo = new InMemoryStudiesRepository(reader);
  await repo.createStudy('s-direct', 'owner', 'Direct RK', '', 'private', undefined, { variant: 'racingkings' });
  await repo.createChapter('ch-direct', 's-direct', 'owner', 'Stored legacy start', standardStartFen);
  const directPgn = await repo.exportPgn('s-direct', 'owner', 'ch-direct');
  assert.ok(directPgn.includes(`[FEN "${standardStartFen}"]`), 'direct repo export of legacy RK start must include FEN tag');
  await repo.createStudy('s-direct-reimport', 'owner', 'Direct Reimport', '', 'private', undefined, { variant: 'racingkings' });
  const [directReimported] = await repo.importPgn('s-direct-reimport', 'owner', directPgn, reader);
  assert.equal(directReimported.startingFen, standardStartFen, 'direct repo reimport must preserve legacy start');
});
