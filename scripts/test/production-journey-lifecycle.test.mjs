import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitJourney, startOnAvailablePort } from '../lib/production-journey-lifecycle.mjs';

test('deadline interrupts but does not release cleanup while active work remains', async () => {
  for (const fails of [false, true]) {
    let release;
    let announceInterrupt;
    let settled = false;
    const active = new Promise((resolve, reject) => { release = () => fails ? reject(new Error('Active command stopped')) : resolve(); });
    const interrupted = new Promise(resolve => { announceInterrupt = resolve; });
    const journey = awaitJourney(active, 1, announceInterrupt).finally(() => { settled = true; });
    const rejected = assert.rejects(journey, fails ? /Active command stopped/ : /deadline exceeded/);
    await interrupted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Cleanup must wait for active work');
    release();
    await rejected;
    assert.equal(settled, true);
  }
});

test('successful work clears its deadline without interrupting', async () => {
  let interrupted = false;
  await awaitJourney(Promise.resolve(), 60_000, () => { interrupted = true; });
  assert.equal(interrupted, false);
});

test('startup retries bind collisions with new ports, retaining the successful port', async () => {
  let next = 8000;
  const attempted = [];
  const selected = await startOnAvailablePort(() => ++next, async port => {
    attempted.push(port);
    if (attempted.length === 1) throw new Error('Bind: port is already allocated');
    if (attempted.length === 2) throw new Error('listen tcp: address already in use');
  });
  assert.deepEqual(attempted, [8001, 8002, 8003]);
  assert.equal(selected, 8003);
});

test('startup fails closed after three collisions and never retries unrelated failures', async () => {
  for (const [message, expectedAttempts] of [['ports are not available', 3], ['database migration failed', 1]]) {
    let attempts = 0;
    await assert.rejects(startOnAvailablePort(() => 8000, async () => { attempts++; throw new Error(message); }), { message });
    assert.equal(attempts, expectedAttempts);
  }
});
