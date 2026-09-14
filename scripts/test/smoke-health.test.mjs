import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForHealth } from '../lib/wait-for-health.mjs';

test('waitForHealth caps its polling delay at the remaining deadline', async () => {
  let now = 0;
  const sleeps = [];

  await assert.rejects(
    () =>
      waitForHealth('http://health.invalid', 'test service', {
        timeoutMs: 25,
        pollInterval: 100,
        now: () => now,
        fetch: async () => ({ ok: false }),
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      }),
    /did not become healthy within 0\.025s/,
  );

  assert.deepEqual(sleeps, [25]);
});

test('waitForHealth caps each request timeout at the remaining deadline', async () => {
  let now = 0;
  const requestedTimeouts = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    requestedTimeouts.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  };

  try {
    await assert.rejects(
      () => waitForHealth('http://health.invalid', 'test service', {
        timeoutMs: 25,
        pollInterval: 25,
        now: () => now,
        fetch: async () => ({ ok: false }),
        sleep: async (delayMs) => { now += delayMs; },
      }),
      /did not become healthy within 0\.025s/,
    );
    assert.deepEqual(requestedTimeouts, [25]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('waitForHealth does not fetch after an already-expired deadline', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => waitForHealth('http://health.invalid', 'test service', {
      timeoutMs: 0,
      fetch: async () => {
        fetchCalled = true;
        return { ok: true };
      },
    }),
    /did not become healthy within 0s/,
  );
  assert.equal(fetchCalled, false);
});
