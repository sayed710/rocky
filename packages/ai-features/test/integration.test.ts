/**
 * Env-gated integration test for `MoveExplainer`.
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
  engineResultsToGrounding,
} from '@chess-platform/ai-orchestrator';

import { MoveExplainer } from '../src/index.js';

// ---------------------------------------------------------------------------
// A minimal AnalysisProvider that returns pre-computed results.
// In a real integration test we'd use a real engine binary, but the
// purpose of this test is to verify the MoveExplainer → AiProvider
// wiring against a real LLM, not the engine itself (which has its own
// env-gated golden test in the engine package).
// ---------------------------------------------------------------------------

const PRE_COMPUTED_RESULTS: readonly EngineResult[] = [
  {
    multipv: 1,
    evaluation: { type: 'cp', value: -35 },
    principalVariation: ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
    depth: 20,
    selDepth: 25,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
];

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

const fakeEngine: AnalysisProvider = {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return PRE_COMPUTED_RESULTS;
  },
  async play(_request: PlayRequest): Promise<PlayResult> {
    return { move: 'e7e5' };
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

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('MoveExplainer integration (OpenAI)', () => {
  test('real completion with grounded citation', async () => {
    const ai = new OpenAiCompatibleAdapter({
      id: 'openai',
      apiKey: openaiKey,
      defaultModel: 'gpt-4o-mini',
    });

    const explainer = new MoveExplainer({ engine: fakeEngine, ai });
    const result = await explainer.explain({
      fen: TEST_FEN,
      move: 'e7e5',
      side: 'black',
      analysis: PRE_COMPUTED_RESULTS,
    });

    // The explanation should be non-empty prose.
    assert.ok(result.explanation.length > 0);

    // The citation must carry the correct engine numbers.
    assert.equal(result.citation.fen, TEST_FEN);
    assert.equal(result.citation.move, 'e7e5');
    assert.equal(result.citation.evalKind, 'cp');
    assert.equal(result.citation.evalValue, -35);
    assert.equal(result.citation.evalLabel, '-0.35');
    assert.deepEqual([...result.citation.bestLine], ['e7e5', 'g1f3', 'b8c6', 'f1b5']);
    assert.equal(result.citation.depth, 20);

    // The real provider should identify itself.
    assert.equal(result.providerId, 'openai');
    assert.ok(result.model.length > 0);
    assert.ok(result.usage.totalTokens > 0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic adapter (env-gated on ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('MoveExplainer integration (Anthropic)', () => {
  test('real completion with grounded citation', async () => {
    const ai = new AnthropicAdapter({
      apiKey: anthropicKey,
      defaultModel: 'claude-3-5-sonnet-20241022',
    });

    const explainer = new MoveExplainer({ engine: fakeEngine, ai });
    const result = await explainer.explain({
      fen: TEST_FEN,
      move: 'e7e5',
      side: 'black',
      analysis: PRE_COMPUTED_RESULTS,
    });

    assert.ok(result.explanation.length > 0);
    assert.equal(result.citation.evalValue, -35);
    assert.equal(result.citation.evalLabel, '-0.35');
    assert.deepEqual([...result.citation.bestLine], ['e7e5', 'g1f3', 'b8c6', 'f1b5']);
    assert.equal(result.providerId, 'anthropic');
  });
});
