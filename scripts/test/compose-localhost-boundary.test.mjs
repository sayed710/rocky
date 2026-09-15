import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const compose = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const chaosCompose = await readFile(
  new URL('../../docker-compose.chaos.yml', import.meta.url),
  'utf8',
);

const publishedPorts = (source) => [...source.matchAll(/^\s+- "([^"]+:[^"]+)"$/gm)]
  .map((match) => match[1]);

test('the local Compose stack exposes only datastores and the trusted web edge on loopback', () => {
  assert.deepEqual(publishedPorts(compose), [
    '127.0.0.1:5432:5432',
    '127.0.0.1:6379:6379',
    '127.0.0.1:${WEB_PORT:-3000}:8080',
  ]);
});

test('the supported chaos override explicitly exposes direct-mode test endpoints on loopback', () => {
  assert.deepEqual(publishedPorts(chaosCompose), [
    '127.0.0.1:${PORT:-8080}:8080',
    '127.0.0.1:${GATEWAY_PORT:-4175}:4175',
    '127.0.0.1:${GATEWAY_HEALTH_PORT:-4176}:4176',
    '127.0.0.1:${GATEWAY_NODE2_PORT:-4177}:4175',
    '127.0.0.1:${GATEWAY_NODE2_HEALTH_PORT:-4178}:4176',
  ]);
  assert.equal((chaosCompose.match(/TRUST_PROXY: "false"/g) ?? []).length, 3);
});
