import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeDocker } from '../lib/docker-probe.mjs';

/** A fake clock advanced by exec durations and sleeps, so no test waits in real time. */
function harness(outcomes) {
  let clock = 0;
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    exec: (timeoutMs) => {
      const outcome = outcomes[calls.length] ?? outcomes.at(-1);
      calls.push(timeoutMs);
      clock += Math.min(outcome.ms, timeoutMs);
      if (outcome.ms > timeoutMs) throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
      if (outcome.fail) throw Object.assign(new Error('Command failed'), { stderr: `${outcome.fail}\nmore detail` });
    },
  };
}

test('a daemon that answers in more than four seconds is available, not missing', async () => {
  // The CI failure: `docker info` took longer than the old fixed 4 s timeout on a busy runner.
  const h = harness([{ ms: 6_500 }]);
  const result = await probeDocker(h);
  assert.deepEqual(result, { available: true, attempts: 1 });
  assert.equal(h.calls[0], 20_000);
});

test('a daemon that is briefly unreachable is retried with backoff until it answers', async () => {
  const h = harness([
    { ms: 50, fail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' },
    { ms: 20_000 + 1 },
    { ms: 300 },
  ]);
  const logs = [];
  const result = await probeDocker({ ...h, log: (m) => logs.push(m) });
  assert.deepEqual(result, { available: true, attempts: 3 });
  assert.deepEqual(h.sleeps, [2_000, 2_000]);
  assert.match(logs[0], /attempt 1\/5 failed: Cannot connect to the Docker daemon/);
  assert.match(logs[1], /attempt 2\/5 failed: docker info timed out/);
});

test('a daemon that never answers is reported unavailable with the last real reason', async () => {
  const h = harness([{ ms: 10, fail: 'permission denied while trying to connect to the Docker daemon socket' }]);
  const result = await probeDocker(h);
  assert.equal(result.available, false);
  assert.equal(result.attempts, 5);
  assert.equal(result.reason, 'permission denied while trying to connect to the Docker daemon socket');
  assert.equal(h.sleeps.length, 4, 'no sleep after the last attempt');
});

test('the total budget bounds the probe and the last attempt never outlives it', async () => {
  const h = harness([{ ms: 999_999 }]);
  const result = await probeDocker({ ...h, budgetMs: 45_000 });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'docker info timed out');
  // 20 s + 2 s backoff + 20 s + 2 s backoff leaves 1 s for a third, shortened attempt.
  assert.deepEqual(h.calls, [20_000, 20_000, 1_000]);
  assert.ok(h.now() <= 45_000);
});
