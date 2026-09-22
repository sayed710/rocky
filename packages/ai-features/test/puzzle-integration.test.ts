/**
 * Env-gated integration test for `PuzzleGenerator`.
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

import { PuzzleGenerator } from '../src/index.js';

// ---------------------------------------------------------------------------
// A minimal AnalysisProvider that returns pre-computed multi-PV results.
// ---------------------------------------------------------------------------

const PUZZLE_RESULTS: readonly EngineResult[] = [
  {
    multipv: 1,
    evaluation: { type: 'cp', value: 350 },
    principalVariation: ['d8a5', 'b1c3'],
    depth: 20,
    selDepth: 25,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
  {
    multipv: 2,
    evaluation: { type: 'cp', value: 80 },
    principalVariation: ['e7e6', 'd2d4'],
    depth: 20,
    selDepth: 24,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
  {
    multipv: 3,
    evaluation: { type: 'cp', value: 30 },
    principalVariation: ['g8f6', 'e2e4'],
    depth: 20,
    selDepth: 23,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  },
];

const TEST_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 0 1';

const fakeEngine: AnalysisProvider = {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return PUZZLE_RESULTS;
  },
  async play(_request: PlayRequest): Promise<PlayResult> {
    return { move: 'd8a5' };
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

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('PuzzleGenerator integration (OpenAI)', () => {
  test('real completion with engine-verified puzzle', async () => {
    const ai = new OpenAiCompatibleAdapter({
      id: 'openai',
      apiKey: openaiKey,
      defaultModel: 'gpt-4o-mini',
    });

    const generator = new PuzzleGenerator({ engine: fakeEngine, ai });
    const result = await generator.generate({
      fen: TEST_FEN,
      analysis: PUZZLE_RESULTS,
    });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;

    // Engine fields must be correct regardless of LLM.
    assert.equal(puzzle.solutionMove, 'd8a5');
    assert.equal(puzzle.bestEval.value, 350);
    assert.deepEqual(puzzle.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.deepEqual([...puzzle.solutionLine], ['d8a5', 'b1c3']);

    // LLM fields should be populated by the real provider.
    assert.ok(puzzle.theme);
    assert.ok(puzzle.hint);
    assert.equal(puzzle.providerId, 'openai');
    assert.ok(puzzle.model!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic adapter (env-gated on ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('PuzzleGenerator integration (Anthropic)', () => {
  test('real completion with engine-verified puzzle', async () => {
    const ai = new AnthropicAdapter({
      apiKey: anthropicKey,
      defaultModel: 'claude-3-5-sonnet-20241022',
    });

    const generator = new PuzzleGenerator({ engine: fakeEngine, ai });
    const result = await generator.generate({
      fen: TEST_FEN,
      analysis: PUZZLE_RESULTS,
    });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;

    assert.equal(puzzle.solutionMove, 'd8a5');
    assert.deepEqual(puzzle.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.ok(puzzle.theme);
    assert.equal(puzzle.providerId, 'anthropic');
  });
});
