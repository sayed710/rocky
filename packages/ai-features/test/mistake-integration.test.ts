/**
 * Env-gated integration test for `MistakePredictor`.
 *
 * The live-provider runner registers only the selected, provisioned provider and runs the
 * real path against it, proving the wiring beyond fakes without creating skipped tests.
 *
 * Run with the package's `test:live-provider:openai` or `test:live-provider:anthropic` script.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import {
  OpenAiCompatibleAdapter,
  AnthropicAdapter,
} from '@chess-platform/ai-orchestrator';

import { MistakePredictor } from '../src/index.js';

// ---------------------------------------------------------------------------
// A minimal AnalysisProvider that returns pre-computed results.
// ---------------------------------------------------------------------------

const BEFORE_RESULTS: readonly EngineResult[] = [
  {
    multipv: 1,
    evaluation: { type: 'cp', value: 200 },
    principalVariation: ['g1f3', 'e7e5'],
    depth: 20,
    selDepth: 25,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
];

const AFTER_RESULTS: readonly EngineResult[] = [
  {
    multipv: 1,
    // From the opponent's perspective: +200cp (opponent is now better)
    evaluation: { type: 'cp', value: 200 },
    principalVariation: ['e7e5', 'g1f3'],
    depth: 20,
    selDepth: 25,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
];

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const fakeEngine: AnalysisProvider = {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    // Return before or after results based on the FEN.
    // For the integration test we supply pre-computed analysis, so this
    // should never be called.
    return BEFORE_RESULTS;
  },
  async play(_request: PlayRequest): Promise<PlayResult> {
    return { move: 'g1f3' };
  },
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return {
      engineName: 'FakeStockfish',
      engineAuthor: 'chess-platform',
      version: '1.0',
      fingerprint: 'fake',
      variants: new Set(['chess']),
      options: new Map(),
      supportsMultiPv: true,
      supportsLimitStrength: false,
      supportsSkillLevel: false,
      supportsPonder: false,
    };
  },
};

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (env-gated on OPENAI_API_KEY)
// ---------------------------------------------------------------------------

const openaiKey = process.env['OPENAI_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('MistakePredictor integration (OpenAI)', () => {
  test('real completion with engine-verified verdict', async () => {
    const ai = new OpenAiCompatibleAdapter({
      id: 'openai',
      apiKey: openaiKey,
      defaultModel: 'gpt-4o-mini',
    });

    const predictor = new MistakePredictor({ engine: fakeEngine, ai });
    const result = await predictor.predict({
      fen: TEST_FEN,
      move: 'a2a3',
      analysisBefore: BEFORE_RESULTS,
      analysisAfter: AFTER_RESULTS,
    });

    // Engine fields must be correct regardless of LLM.
    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 400); // 200 - (-200) = 400
    assert.equal(result.betterMove, 'g1f3');
    assert.equal(result.evalBefore.value, 200);
    assert.equal(result.moveOutcome.kind, 'evaluation');
    assert.deepEqual(
      result.moveOutcome.kind === 'evaluation' ? result.moveOutcome.evaluation : null,
      { type: 'cp', value: -200 },
    );

    // LLM fields should be populated by the real provider.
    assert.ok(result.coaching);
    assert.equal(result.providerId, 'openai');
    assert.ok(result.model!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic adapter (env-gated on ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('MistakePredictor integration (Anthropic)', () => {
  test('real completion with engine-verified verdict', async () => {
    const ai = new AnthropicAdapter({
      apiKey: anthropicKey,
      defaultModel: 'claude-sonnet-4-6',
    });

    const predictor = new MistakePredictor({ engine: fakeEngine, ai });
    const result = await predictor.predict({
      fen: TEST_FEN,
      move: 'a2a3',
      analysisBefore: BEFORE_RESULTS,
      analysisAfter: AFTER_RESULTS,
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 400);
    assert.ok(result.coaching);
    assert.equal(result.providerId, 'anthropic');
  });
});
