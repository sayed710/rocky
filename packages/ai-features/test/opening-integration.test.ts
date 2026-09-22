/**
 * Env-gated integration test for `OpeningExplorer`.
 *
 * The live-provider runner registers only the selected, provisioned provider and runs the
 * real path against it, proving the wiring beyond fakes without creating skipped tests.
 *
 * Run with the package's `test:live-provider:openai` or `test:live-provider:anthropic` script.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OpenAiCompatibleAdapter,
  AnthropicAdapter,
} from '@chess-platform/ai-orchestrator';

import { OpeningExplorer, BundledOpeningDatabase } from '../src/index.js';

const TEST_MOVES = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'];

const openaiKey = process.env['OPENAI_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') describe('OpeningExplorer integration (OpenAI)', () => {
  test('real narrative with opening identification', async () => {
    const db = new BundledOpeningDatabase();
    const ai = new OpenAiCompatibleAdapter({
      id: 'openai',
      apiKey: openaiKey,
      defaultModel: 'gpt-4o-mini',
    });

    const explorer = new OpeningExplorer({ database: db, ai });
    const result = await explorer.explore({ moves: TEST_MOVES });

    // DB fields must be correct regardless of LLM.
    assert.equal(result.found, true);
    assert.equal(result.eco, 'B90');
    assert.equal(result.name, 'Sicilian Defense, Najdorf Variation');

    // LLM fields should be populated by the real provider.
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'openai');
    assert.ok(result.model!.length > 0);
  });
});

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') describe('OpeningExplorer integration (Anthropic)', () => {
  test('real narrative with opening identification', async () => {
    const db = new BundledOpeningDatabase();
    const ai = new AnthropicAdapter({
      apiKey: anthropicKey,
      defaultModel: 'claude-3-5-sonnet-20241022',
    });

    const explorer = new OpeningExplorer({ database: db, ai });
    const result = await explorer.explore({ moves: TEST_MOVES });

    assert.equal(result.found, true);
    assert.equal(result.eco, 'B90');
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'anthropic');
  });
});
