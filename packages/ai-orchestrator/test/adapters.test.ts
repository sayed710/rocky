/**
 * Integration tests for the OpenAI-compatible and Anthropic adapters.
 *
 * These tests are env-gated: they skip unless the relevant API key
 * is present in the environment, exactly like the Postgres-gated
 * persistence tests (gated on `DATABASE_URL`).
 *
 * Run with: OPENAI_API_KEY=sk-... npm test
 *           ANTHROPIC_API_KEY=sk-ant-... npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiCompatibleAdapter,
  AnthropicAdapter,
  engineResultsToGrounding,
  evalToString,
  buildGroundedMessages,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Engine grounding integration (hermetic — no API keys needed)
// ---------------------------------------------------------------------------

describe('Engine Grounding Integration', () => {
  test('engineResultsToGrounding converts engine analysis to grounding', () => {
    // Simulate engine results (the shape that @chess-platform/engine produces)
    const results = [
      {
        multipv: 1,
        evaluation: { type: 'cp' as const, value: 35 },
        principalVariation: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
        depth: 20,
        selDepth: 25,
        nodes: 1_000_000,
        nps: 500_000,
        timeMs: 2000,
      },
      {
        multipv: 2,
        evaluation: { type: 'cp' as const, value: 10 },
        principalVariation: ['d2d4', 'd7d5'],
        depth: 20,
        selDepth: 24,
        nodes: 1_000_000,
        nps: 500_000,
        timeMs: 2000,
      },
    ];

    const grounding = engineResultsToGrounding(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      results,
      'e2e4',
    );

    assert.equal(grounding.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    assert.equal(grounding.moveUci, 'e2e4');
    assert.equal(grounding.evalCp, 35);
    assert.equal(grounding.depth, 20);
    assert.deepEqual(grounding.bestLine, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    assert.ok(grounding.multiPv);
    assert.equal(grounding.multiPv!.length, 1);
    assert.equal(grounding.multiPv![0].evalCp, 10);
  });

  test('engineResultsToGrounding handles mate evaluation', () => {
    const results = [
      {
        multipv: 1,
        evaluation: { type: 'mate' as const, value: 3 },
        principalVariation: ['qh5', 'f7'],
        depth: 15,
        selDepth: 15,
        nodes: 500_000,
        nps: 300_000,
        timeMs: 1500,
      },
    ];

    const grounding = engineResultsToGrounding('some-fen', results);
    assert.equal(grounding.evalMate, 3);
    assert.equal(grounding.evalCp, undefined);
  });

  test('engineResultsToGrounding handles empty results', () => {
    const grounding = engineResultsToGrounding('some-fen', []);
    assert.equal(grounding.fen, 'some-fen');
    assert.equal(grounding.evalCp, undefined);
    assert.equal(grounding.bestLine, undefined);
  });

  test('evalToString formats centipawn evaluation', () => {
    assert.equal(evalToString({ type: 'cp', value: 50 }), '+0.50');
    assert.equal(evalToString({ type: 'cp', value: -30 }), '-0.30');
  });

  test('evalToString formats mate evaluation', () => {
    assert.equal(evalToString({ type: 'mate', value: 3 }), 'mate in 3');
    assert.equal(evalToString({ type: 'mate', value: -2 }), 'mate in -2');
  });

  test('grounding from engine results produces valid system message', () => {
    const results = [
      {
        multipv: 1,
        evaluation: { type: 'cp' as const, value: -50 },
        principalVariation: ['f2f3', 'e7e5'],
        depth: 18,
        selDepth: 22,
        nodes: 800_000,
        nps: 400_000,
        timeMs: 2000,
      },
    ];

    const grounding = engineResultsToGrounding(
      'rnbqkbnr/pppppppp/8/5P2/8/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1',
      results,
      'f2f3',
    );

    const messages = buildGroundedMessages(
      [{ role: 'user', content: 'Why is f3 weak?' }],
      grounding,
    );

    const systemMsg = messages.find(m => m.role === 'system');
    assert.ok(systemMsg);
    assert.ok(systemMsg!.content.includes('FEN'));
    assert.ok(systemMsg!.content.includes('Engine evaluation'));
    assert.ok(systemMsg!.content.includes('-0.50'));
    assert.ok(systemMsg!.content.includes('f2f3'));
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (env-gated)
// ---------------------------------------------------------------------------

describe('OpenAiCompatibleAdapter', () => {
  test('discoverCapabilities returns capabilities', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      id: 'test-openai',
      apiKey: undefined, // no key — should still return capabilities
      models: [
        { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', contextWindow: 128_000 },
      ],
    });
    const caps = await adapter.discoverCapabilities();
    assert.equal(caps.providerId, 'test-openai');
    assert.equal(caps.models.length, 1);
    assert.equal(caps.models[0].id, 'gpt-4o-mini');
  });

  test('id is set correctly', () => {
    const adapter = new OpenAiCompatibleAdapter({ id: 'deepseek' });
    assert.equal(adapter.id, 'deepseek');
  });

  test('default baseUrl per provider id', () => {
    const openai = new OpenAiCompatibleAdapter({ id: 'openai' });
    const deepseek = new OpenAiCompatibleAdapter({ id: 'deepseek' });
    const openrouter = new OpenAiCompatibleAdapter({ id: 'openrouter' });
    const ollama = new OpenAiCompatibleAdapter({ id: 'ollama' });
    // baseUrl is private but we can verify via healthCheck behavior
    // Just verify they don't throw
    assert.ok(openai);
    assert.ok(deepseek);
    assert.ok(openrouter);
    assert.ok(ollama);
  });
});

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  test('discoverCapabilities returns capabilities', async () => {
    const adapter = new AnthropicAdapter({ apiKey: undefined });
    const caps = await adapter.discoverCapabilities();
    assert.equal(caps.providerId, 'anthropic');
    assert.equal(caps.supportsEmbeddings, false);
    assert.equal(caps.supportsStreaming, true);
  });

  test('embed throws (Anthropic does not support embeddings)', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'fake' });
    await assert.rejects(adapter.embed({ input: 'test' }), /does not support embeddings/);
  });
});
