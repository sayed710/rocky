import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeTrustFailureCode } from '../src/trust-failure-code';
import type { Pool } from 'pg';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryPubSub, gamesEndedChannel } from '@chess-platform/realtime-gateway';
import { startTrustAnalyzers } from '../src/trust-analyzers';
import { JsonLogger } from '../src/ports/logger';

test('trust diagnostics distinguish known storage and engine failures without exposing arbitrary text', () => {
  for (const code of ['42P01', '57014', '55P03', '23514', 'engine_crashed', 'ECONNREFUSED']) {
    const error = Object.defineProperties({ code }, {
      message: { get: () => { assert.fail('message must never be read'); } },
      name: { get: () => { assert.fail('name must never be read'); } },
      routine: { get: () => { assert.fail('routine must never be read'); } },
    });
    assert.equal(safeTrustFailureCode(error), code);
  }
  for (const error of [null, 'secret payload', new Error('secret payload'),
    { code: 'secret\npayload' }, { code: 'x'.repeat(10_000) }, { code: ['42P01'] },
    Object.defineProperty({}, 'code', { get: () => { throw new Error('secret payload'); } }),
  ]) assert.equal(safeTrustFailureCode(error), null);
});

test('startup and wakeup storage failures retain safe diagnostic codes in worker logs', async () => {
  const lines: string[] = [];
  const secret = 'PRIVATE_STORED_PAYLOAD';
  const pool = { connect: async () => { throw Object.assign(new Error(secret), { code: '42P01', routine: secret }); } } as unknown as Pool;
  const pubsub = new InMemoryPubSub();
  const worker = await startTrustAnalyzers({
    config: { botAnalysis: true, antiCheatAnalysis: false }, pool,
    eventStore: new InMemoryEventStore(), pubsub, scanIntervalMs: 0,
    logger: new JsonLogger({}, { level: 'error', sink: (line) => lines.push(line) }),
  });
  try {
    await worker.initialScan;
    assert.equal(lines.length, 1);
    pubsub.publish(gamesEndedChannel(), { t: 'ended', gameId: 'any', result: '1-0', termination: 'resignation', winner: 'w', serverTs: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(line.includes('42P01'));
      assert.ok(line.includes('scan-store-error'));
      assert.ok(!line.includes(secret));
    }
  } finally { await worker.stop(); }
});
