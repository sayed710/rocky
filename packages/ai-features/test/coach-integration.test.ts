/**
 * Env-gated integration test for `Coach`.
 *
 * The live-provider runner registers this file only for the selected, provisioned provider.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '@chess-platform/ai-orchestrator';

import { Coach } from '../src/index.js';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FAKE_RESULTS: readonly EngineResult[] = [
  { multipv: 1, evaluation: { type: 'cp', value: 200 }, principalVariation: ['g1f3', 'e7e5'], depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000 },
];

const fakeEngine: AnalysisProvider = {
  async analyze(_req: AnalysisRequest): Promise<readonly EngineResult[]> { return FAKE_RESULTS; },
  async play(_req: PlayRequest): Promise<PlayResult> { return { move: 'g1f3' }; },
  capabilitiesFor(_v: string): EngineCapabilities | undefined { return undefined; },
};

const openaiKey = process.env['OPENAI_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('Coach integration (OpenAI)', () => {
  test('real narrative with composed feature results', async () => {
    const ai = new OpenAiCompatibleAdapter({ id: 'openai', apiKey: openaiKey, defaultModel: 'gpt-4o-mini' });
    const coach = new Coach({ engine: fakeEngine, ai });

    const result = await coach.coach({ fen: STARTPOS, move: 'a2a3' });

    assert.ok(result.mistakeVerdict);
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'openai');
  });
});

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('Coach integration (Anthropic)', () => {
  test('real narrative with composed feature results', async () => {
    const ai = new AnthropicAdapter({ apiKey: anthropicKey, defaultModel: 'claude-sonnet-4-6' });
    const coach = new Coach({ engine: fakeEngine, ai });

    const result = await coach.coach({ fen: STARTPOS, move: 'a2a3' });
    assert.ok(result.mistakeVerdict);
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'anthropic');
  });
});
