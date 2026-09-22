import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '../src/index.js';

const openaiKey = process.env['OPENAI_API_KEY'];
if (process.env['GAMBIT_LIVE_PROVIDER'] === 'openai') test('OpenAI adapter: real completion', async () => {
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

const anthropicKey = process.env['ANTHROPIC_API_KEY'];
if (process.env['GAMBIT_LIVE_PROVIDER'] === 'anthropic') test('Anthropic adapter: real completion', async () => {
  const adapter = new AnthropicAdapter({
    apiKey: anthropicKey,
    defaultModel: 'claude-sonnet-4-6',
  });
  const response = await adapter.complete({
    task: 'general',
    messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
    maxTokens: 10,
  });
  assert.ok(response.content);
  assert.equal(response.providerId, 'anthropic');
});
