/**
 * Env-gated integration test for `EndgameTrainer`.
 *
 * The live-provider runner registers this file only for the selected, provisioned provider.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '@chess-platform/ai-orchestrator';

import { EndgameTrainer, BundledEndgameDatabase } from '../src/index.js';

const KQ_FEN = '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1';

const SOLUTION_RESULTS: readonly EngineResult[] = [
  { multipv: 1, evaluation: { type: 'mate', value: 2 }, principalVariation: ['g6g7'], depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000 },
];

const AFTER_RESULTS: readonly EngineResult[] = [
  { multipv: 1, evaluation: { type: 'mate', value: -1 }, principalVariation: ['h8h7'], depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800 },
];

const fakeEngine: AnalysisProvider = {
  async analyze(_req: AnalysisRequest): Promise<readonly EngineResult[]> { return SOLUTION_RESULTS; },
  async play(_req: PlayRequest): Promise<PlayResult> { return { move: 'g6g7' }; },
  capabilitiesFor(_v: string): EngineCapabilities | undefined { return undefined; },
};

const openaiKey = process.env['OPENAI_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('EndgameTrainer integration (OpenAI)', () => {
  test('real narrative with engine-verified solution', async () => {
    const db = new BundledEndgameDatabase();
    const ai = new OpenAiCompatibleAdapter({ id: 'openai', apiKey: openaiKey, defaultModel: 'gpt-4o-mini' });
    const trainer = new EndgameTrainer({ database: db, engine: fakeEngine, ai });

    const result = await trainer.nextPosition({ id: 'kq-vs-k-01', analysis: SOLUTION_RESULTS });
    assert.equal(result.entry.id, 'kq-vs-k-01');
    assert.equal(result.solution.mateDistance, 2);
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'openai');
  });
});

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('EndgameTrainer integration (Anthropic)', () => {
  test('real coaching with engine-verified evaluation', async () => {
    const db = new BundledEndgameDatabase();
    const ai = new AnthropicAdapter({ apiKey: anthropicKey, defaultModel: 'claude-3-5-sonnet-20241022' });
    const trainer = new EndgameTrainer({ database: db, engine: fakeEngine, ai });

    const result = await trainer.evaluateAttempt({
      entry: { id: 'kq-vs-k-01', type: 'KQ_vs_K', name: 'Queen vs King mate', fen: KQ_FEN, sideToMove: 'w', goal: { kind: 'mate', distance: 2 }, difficulty: 'beginner' },
      move: 'g6g7',
      analysisBefore: SOLUTION_RESULTS,
      analysisAfter: AFTER_RESULTS,
    });
    assert.equal(result.classification, 'optimal');
    assert.ok(result.coaching);
    assert.equal(result.providerId, 'anthropic');
  });
});
