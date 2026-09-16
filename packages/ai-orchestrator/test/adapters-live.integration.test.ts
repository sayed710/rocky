import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '../src/index.js';

// Env-gated integration test (skips without OPENAI_API_KEY)
const openaiKey = process.env['OPENAI_API_KEY'];
test('OpenAI adapter: real completion', { skip: !openaiKey }, async () => {
  const adapter = new OpenAiCompatibleAdapter({
    id: 'openai',
    apiKey: openaiKey,
    defaultModel: 'gpt-4o-mini',
  });
  const response = await adapter.complete({
    task: 'general',
    messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
    maxTokens: 10,
  });
  assert.ok(response.content);
  assert.equal(response.providerId, 'openai');
});

// Env-gated integration test (skips without ANTHROPIC_API_KEY)
const anthropicKey = process.env['ANTHROPIC_API_KEY'];
test('Anthropic adapter: real completion', { skip: !anthropicKey }, async () => {
  const adapter = new AnthropicAdapter({
    apiKey: anthropicKey,
    defaultModel: 'claude-3-5-sonnet-20241022',
  });
  const response = await adapter.complete({
    task: 'general',
    messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
    maxTokens: 10,
  });
  assert.ok(response.content);
  assert.equal(response.providerId, 'anthropic');
});
