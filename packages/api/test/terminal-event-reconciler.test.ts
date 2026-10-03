import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTerminalEventInbox, TERMINAL_LEASE_MS, TERMINAL_RENEW_MS, TERMINAL_RENEW_TIMEOUT_MS, TERMINAL_RETRY_BASE_MS, type TerminalEventWork } from '@chess-platform/persistence';
import { gamesEndedChannel, InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { TerminalEventReconciler } from '../src/terminal-event-reconciler';

function rows(count: number): TerminalEventWork[] {
  return Array.from({ length: count }, (_, n) => ({ stored: {
    gameId: `game-${String(n).padStart(6, '0')}`, seq: 1, version: 1, serverTs: n,
    event: { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: n },
  } }));
}
const quiet = { scanIntervalMs: 0, onError: () => {} };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('poison backoff survives restart and duplicated Redis wakeups cannot bypass due time', async () => {
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => now);
  const pubsub = new InMemoryPubSub();
  let calls = 0;
  const make = () => new TerminalEventReconciler(pubsub, inbox, 'bot-analysis', async () => {
    calls += 1; throw new Error('poison');
  }, quiet);
  const first = make();
  await first.start();
  await first.scan();
  await first.stop();
  const restarted = make();
  await restarted.start();
  for (let n = 0; n < 10; n++) pubsub.publish(gamesEndedChannel(), { t: 'ended', gameId: 'game-000000', result: '1-0', termination: 'resignation', winner: 'w', serverTs: now });
  await restarted.scan();
  assert.equal(calls, 1);
  now = TERMINAL_RETRY_BASE_MS - 1;
  await restarted.scan();
  assert.equal(calls, 1);
  now += 1;
  await restarted.scan();
  assert.equal(calls, 2);
  now += TERMINAL_RETRY_BASE_MS;
  await restarted.scan();
  assert.equal(calls, 2, 'second failure doubles the delay');
  await restarted.stop();
});

test('overlapping same-consumer workers invoke expensive analysis only once', async () => {
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => 0);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const workers = [0, 1].map(() => new TerminalEventReconciler(new InMemoryPubSub(), inbox,
    'bot-analysis', async () => { calls += 1; await blocked; }, quiet));
  const scans = workers.map((worker) => worker.start());
  await flush();
  assert.equal(calls, 1);
  release();
  await Promise.all(scans);
  await Promise.all(workers.map((worker) => worker.stop()));
  assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
});

test('bounded scanning advances past a failure and retries it below the forward cursor when due', async () => {
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(rows(1_101), () => now);
  const done = new Set<string>();
  let failures = 0;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async (gameId) => {
    if (gameId === 'game-000000' && failures++ === 0) throw new Error('transient');
    done.add(gameId);
  }, quiet);
  await worker.start();
  assert.equal(done.size, 999);
  await worker.scan();
  assert.equal(done.size, 1_100, 'deferred work is skipped while healthy later work drains');
  now = TERMINAL_RETRY_BASE_MS;
  await worker.scan();
  assert.equal(done.size, 1_101);
  await worker.stop();
});

test('one thousand persistent failures cannot starve a later committed ending', async () => {
  const inbox = new InMemoryTerminalEventInbox(rows(1_001), () => 0);
  const seen: string[] = [];
  let calls = 0;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'anti-cheat-analysis', async (gameId) => {
    calls++;
    if (gameId !== 'game-001000') throw new Error('persistent');
    seen.push(gameId);
  }, quiet);
  await worker.start();
  assert.equal(calls, 1_000);
  await worker.scan();
  assert.deepEqual(seen, ['game-001000']);
  assert.equal(calls, 1_001);
  await worker.stop();
});

test('reverse sweep rediscovers newly due older poison and newly committed older work while newer work stays busy', async () => {
  let now = 0;
  const work = rows(4_000);
  const inbox = new InMemoryTerminalEventInbox(work, () => now);
  const seen = new Set<string>();
  let poisonCalls = 0;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async (gameId) => {
    if (gameId === 'game-000000') { poisonCalls++; throw new Error('poison'); }
    seen.add(gameId);
  }, quiet);
  await worker.start();
  await worker.scan();
  assert.equal(poisonCalls, 1);
  work.push({ stored: { ...('stored' in work[1]! ? work[1].stored : assert.fail()), gameId: 'game-000001a' } });
  now = TERMINAL_RETRY_BASE_MS;
  await worker.scan();
  assert.ok(seen.has('game-000001a'));
  assert.equal(poisonCalls, 2, 'due work below the retained cursor is found before newer work drains');
  assert.ok(seen.size > 2_999);
  await worker.stop();
});

test('undecodable poison is leased and deferred while thousands of healthy endings drain', async () => {
  let now = 0;
  const work = rows(2_500);
  work.unshift({ gameId: 'game--poison', seq: 0, decodeError: 'corruption' });
  const inbox = new InMemoryTerminalEventInbox(work, () => now);
  let healthy = 0;
  const errors: Array<{ gameId: string; failures?: number; nextRetryAt?: number }> = [];
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async () => { healthy++; }, {
    scanIntervalMs: 0, onError: (gameId, _error, metadata) => errors.push({ gameId,
      ...(metadata?.retry ? { failures: metadata.retry.failures, nextRetryAt: metadata.retry.nextRetryAt } : {}) }),
  });
  await worker.start();
  for (let n = 0; n < 5; n++) await worker.scan();
  assert.equal(healthy, 2_500);
  assert.deepEqual(errors, [{ gameId: 'game--poison', failures: 1, nextRetryAt: TERMINAL_RETRY_BASE_MS }]);
  now = TERMINAL_RETRY_BASE_MS;
  await worker.scan();
  assert.equal(errors.length, 2);
  assert.equal(errors[1]?.failures, 2);
  await worker.stop();
});

test('stop waits for the current consumer and begins no other item, including a claim already in flight', async () => {
  const inbox = new InMemoryTerminalEventInbox(rows(2), () => 0);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async () => { calls++; await blocked; }, quiet);
  const start = worker.start();
  await flush();
  let stopped = false;
  const stop = worker.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  release();
  await Promise.all([start, stop]);
  assert.equal(calls, 1);
  await worker.scan();
  assert.equal(calls, 1);

  let releaseClaim!: () => void;
  let enteredClaim!: () => void;
  const gate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const entered = new Promise<void>((resolve) => { enteredClaim = resolve; });
  const claimAfter = inbox.claimAfter.bind(inbox);
  inbox.claimAfter = async (consumer, after) => {
    const claim = await claimAfter(consumer, after);
    enteredClaim();
    await gate;
    return claim;
  };
  const claiming = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'anti-cheat-analysis', async () => { calls++; }, quiet);
  const inFlight = claiming.start();
  await entered;
  const stoppedClaiming = claiming.stop();
  releaseClaim();
  await Promise.all([inFlight, stoppedClaiming]);
  assert.equal(calls, 1, 'stop during the awaited claim must not start consumption');
});

test('renewal keeps long analysis owned; lease loss cancels it and writes neither failure nor receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => now);
  let aborted = false;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'anti-cheat-analysis', async (_game, _ending, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  }, quiet);
  const started = worker.start();
  await flush();
  for (let n = 0; n < 6; n++) {
    now += TERMINAL_RENEW_MS;
    t.mock.timers.tick(TERMINAL_RENEW_MS);
    await flush();
    assert.equal(await inbox.claimAfter('anti-cheat-analysis', null), undefined);
  }
  assert.equal(aborted, false, 'analysis may outlive the original five-minute lease');
  inbox.renew = async () => false;
  t.mock.timers.tick(TERMINAL_RENEW_MS);
  await flush();
  await started;
  await worker.stop();
  assert.equal(aborted, true);
  now += TERMINAL_LEASE_MS;
  const recovered = await inbox.claimAfter('anti-cheat-analysis', null);
  assert.ok(recovered);
  assert.equal((await inbox.fail(recovered.lease))?.failures, 1, 'lease loss did not manufacture a failure');
});

test('unresponsive renewal cancels analysis before expiry without blocking graceful stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => 0);
  inbox.renew = () => new Promise(() => {});
  let cancelled = false;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'anti-cheat-analysis', async (_game, _ending, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
  }, quiet);
  const started = worker.start();
  await flush();
  t.mock.timers.tick(TERMINAL_RENEW_MS);
  t.mock.timers.tick(TERMINAL_RENEW_TIMEOUT_MS);
  await started;
  await worker.stop();
  assert.equal(cancelled, true);
});

test('a failed retry-state write preserves the lease and recovers after expiry without a manufactured failure', async () => {
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => now);
  const fail = inbox.fail.bind(inbox);
  let unavailable = true;
  inbox.fail = async (lease) => {
    if (unavailable) throw new Error('database unavailable');
    return fail(lease);
  };
  let calls = 0;
  const failures: Array<number | undefined> = [];
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async () => {
    calls++; throw new Error('consumer error');
  }, { scanIntervalMs: 0, onError: (_id, _error, metadata) => failures.push(metadata?.retry?.failures) });
  await worker.start();
  unavailable = false;
  await worker.scan();
  assert.equal(calls, 1);
  now = TERMINAL_LEASE_MS;
  await worker.scan();
  assert.equal(calls, 2);
  assert.deepEqual(failures, [undefined, undefined, 1]);
  await worker.stop();
});

test('an acknowledgement outage leaves success unreceipted and safely repeats the idempotent consumer when due', async () => {
  let now = 0;
  const inbox = new InMemoryTerminalEventInbox(rows(1), () => now);
  const acknowledge = inbox.acknowledge.bind(inbox);
  let unavailable = true;
  inbox.acknowledge = async (lease) => {
    if (unavailable) throw new Error('database unavailable');
    return acknowledge(lease);
  };
  let calls = 0;
  const worker = new TerminalEventReconciler(new InMemoryPubSub(), inbox, 'bot-analysis', async () => { calls++; }, quiet);
  await worker.start();
  unavailable = false;
  await worker.scan();
  assert.equal(calls, 1);
  now = TERMINAL_RETRY_BASE_MS;
  await worker.scan();
  assert.equal(calls, 2);
  now += TERMINAL_LEASE_MS;
  assert.equal(await inbox.claimAfter('bot-analysis', null), undefined);
  await worker.stop();
});
