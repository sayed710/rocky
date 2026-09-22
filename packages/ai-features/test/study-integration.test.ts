/**
 * Env-gated integration test for `StudyPartner`.
 *
 * The live-provider runner registers this file only for the selected, provisioned provider.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '@chess-platform/ai-orchestrator';

import { StudyPartner, InMemoryStudySessionStore } from '../src/index.js';
import { Coach } from '../src/coach.js';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const fakeEngine: AnalysisProvider = {
  async analyze(_req: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [{ multipv: 1, evaluation: { type: 'cp', value: 200 }, principalVariation: ['g1f3'], depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000 }];
  },
  async play(_req: PlayRequest): Promise<PlayResult> { return { move: 'g1f3' }; },
  capabilitiesFor(_v: string): EngineCapabilities | undefined { return undefined; },
};

const openaiKey = process.env['OPENAI_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('StudyPartner integration (OpenAI)', () => {
  test('real session with narrative', async () => {
    const ai = new OpenAiCompatibleAdapter({ id: 'openai', apiKey: openaiKey, defaultModel: 'gpt-4o-mini' });
    const coach = new Coach({ engine: fakeEngine, ai });
    const store = new InMemoryStudySessionStore();
    const partner = new StudyPartner({ store, coach, ai, idGenerator: () => 'int-openai' });

    const start = await partner.startSession({ topic: 'Tactics' });
    assert.ok(start.narrative);

    const turn = await partner.submitTurn({ sessionId: 'int-openai', fen: STARTPOS, move: 'a2a3' });
    assert.ok(turn.narrative);

    const end = await partner.endSession({ sessionId: 'int-openai' });
    assert.ok(end.narrative);
    assert.equal(end.providerId, 'openai');
  });
});

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('StudyPartner integration (Anthropic)', () => {
  test('real session with narrative', async () => {
    const ai = new AnthropicAdapter({ apiKey: anthropicKey, defaultModel: 'claude-3-5-sonnet-20241022' });
    const coach = new Coach({ engine: fakeEngine, ai });
    const store = new InMemoryStudySessionStore();
    const partner = new StudyPartner({ store, coach, ai, idGenerator: () => 'int-anthropic' });

    await partner.startSession({ topic: 'Endgames' });
    await partner.submitTurn({ sessionId: 'int-anthropic', fen: STARTPOS, move: 'e2e4' });
    const end = await partner.endSession({ sessionId: 'int-anthropic' });
    assert.ok(end.narrative);
    assert.equal(end.providerId, 'anthropic');
  });
});
