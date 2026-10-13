/** R-02 F3: controlled connection completions, real consumer/authority/request state. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Redis } from 'ioredis';
import { GameAuthority, InMemoryEventLog, InMemoryPubSub, FLAG_ACTOR } from '@chess-platform/realtime-gateway';
import { OwnerCommandConsumer } from '../src/command-forwarder.js';
import { ENQUEUE_REQUEST, REQUEST_RETENTION_MS, START_REQUEST, requestKey } from '../src/forwarded-request.js';
import { ForwardRedis } from './support/forward-redis.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const done = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { done, resolve, reject };
}

/** Disconnect closes immediately; its pending rejection can be delivered after replacement. */
class BlockingConnection {
  calls = 0;
  closed = false;
  pending = deferred<[string, string] | null>();
  blpop() {
    this.calls++;
    if (this.calls > 1 && !this.closed) this.pending = deferred<[string, string] | null>();
    return this.closed ? Promise.reject(new Error('Connection is closed')) : this.pending.done;
  }
  disconnect() { this.closed = true; }
  rejectDisconnect() { this.pending.reject(new Error('Connection is closed')); }
}

async function turn() { await new Promise<void>(resolve => setImmediate(resolve)); }

/** Private promise observation measures obsolete loop settlement, not merely map membership. */
function loopOf(consumer: OwnerCommandConsumer, id: string): Promise<void> {
  // @ts-expect-error diagnostic observation of the actual production loop
  const loop: Promise<void> | undefined = consumer.loops.get(id);
  assert.ok(loop); return loop;
}

async function fixture(t: TestContext) {
  const transport = new ForwardRedis(), connections: BlockingConnection[] = [];
  transport.loseResponses = false;
  const boundary = { eval: transport.eval.bind(transport), duplicate: () => {
    const conn = new BlockingConnection(); connections.push(conn); return conn;
  } };
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  const consumer = new OwnerCommandConsumer(authority, boundary as unknown as Redis);
  consumer.bindOwner('owner');
  t.after(async () => { consumer.stop(); for (const conn of connections) conn.rejectDisconnect(); await turn(); });
  await authority.createGame({ gameId: 'g', players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' } });
  const enqueue = async (id: string, uci = 'e2e4') => {
    const payload = JSON.stringify({ version: 2, gameId: 'g', requestId: id, responseKey: `game:resp:${id}`,
      userId: 'alice', cmd: { kind: 'move', uci } });
    await transport.eval(ENQUEUE_REQUEST, 2, requestKey(id), 'game:cmd:v2:g', payload, 1000, REQUEST_RETENTION_MS);
    transport.lists.get('game:cmd:v2:g')!.shift();
    return payload;
  };
  return { consumer, connections, transport, boundary, authority, store, enqueue };
}

test('F3: stop without replacement settles the blocked instance quietly', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.consumer.startConsumer('g');
  const old = loopOf(f.consumer, 'g'), a = f.connections[0]!;
  f.consumer.stopConsumer('g'); a.rejectDisconnect(); await old;
  assert.equal(a.calls, 1); assert.equal(f.consumer.isConsuming('g'), false);
});

for (const stopAll of [false, true]) {
  test(`F3: delayed BLPOP rejection cannot revive an obsolete instance (stopAll=${stopAll})`, { timeout: 5000 }, async t => {
    const f = await fixture(t); const errors = t.mock.method(console, 'error', () => undefined);
    f.consumer.startConsumer('g');
    const old = loopOf(f.consumer, 'g'), a = f.connections[0]!; let settled = false;
    void old.then(() => { settled = true; });
    if (stopAll) f.consumer.stop(); else f.consumer.stopConsumer('g');
    f.consumer.startConsumer('g'); a.rejectDisconnect(); await turn();
    assert.equal(settled, true, 'obsolete A must settle despite B membership');
    assert.equal(a.calls, 1); assert.equal(errors.mock.callCount(), 0);
    assert.equal(f.consumer.isConsuming('g'), true); assert.equal(f.connections[1]!.closed, false);
  });
}

test('F3: five replacements leave no obsolete retry loops', { timeout: 5000 }, async t => {
  const f = await fixture(t); t.mock.method(console, 'error', () => undefined);
  let settled = 0; f.consumer.startConsumer('g');
  for (let i = 0; i < 5; i++) {
    void loopOf(f.consumer, 'g').then(() => { settled++; });
    f.consumer.stopConsumer('g'); f.consumer.startConsumer('g'); f.connections[i]!.rejectDisconnect();
  }
  await turn();
  assert.equal(settled, 5, 'all replaced promises must settle');
  assert.deepEqual(f.connections.map(c => c.calls), [1, 1, 1, 1, 1, 1]);
  assert.equal(f.consumer.isConsuming('g'), true);
});

test('F3: replacement during error backoff cannot resume the old loop', { timeout: 5000 }, async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = t.mock.method(console, 'error', () => undefined);
  f.consumer.startConsumer('g'); const old = loopOf(f.consumer, 'g'), a = f.connections[0]!;
  a.pending.reject(new Error('transport failure')); await turn();
  // Node 22 emits its deferred MockTimers warning through console.error too.
  const transportErrors = errors.mock.calls.filter(call => call.arguments[1] instanceof Error &&
    call.arguments[1].message === 'transport failure');
  assert.equal(transportErrors.length, 1, 'current transport failures remain observable');
  f.consumer.stopConsumer('g'); f.consumer.startConsumer('g'); t.mock.timers.tick(100);
  await turn();
  let settled = false; void old.then(() => { settled = true; }); await turn();
  assert.equal(settled, true); assert.equal(a.calls, 1);
  assert.equal(f.consumer.isConsuming('g'), true);
});

test('F3: idempotent start and stop-all disconnect each current game without touching restarted instances', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.consumer.startConsumer('g'); f.consumer.startConsumer('g'); f.consumer.startConsumer('other');
  assert.equal(f.connections.length, 2);
  const a = loopOf(f.consumer, 'g'), other = loopOf(f.consumer, 'other');
  f.consumer.stop(); assert.equal(f.consumer.isConsuming('g'), false); assert.equal(f.consumer.isConsuming('other'), false);
  assert.deepEqual(f.connections.map(c => c.closed), [true, true]);
  f.consumer.startConsumer('g'); f.connections[0]!.rejectDisconnect(); f.connections[1]!.rejectDisconnect();
  await Promise.all([a, other]);
  assert.equal(f.consumer.isConsuming('g'), true); assert.equal(f.connections[2]!.closed, false);
});

test('F3: obsolete not_owner callback cannot stop replacement; replacement processes legitimate work', { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(), reply = deferred<void>();
  t.after(() => reply.resolve());
  const evaluate = f.boundary.eval;
  f.boundary.eval = async (...args) => {
    const result = await evaluate(...args);
    if (args[0] === START_REQUEST) { entered.resolve(); await reply.done; }
    return result;
  };
  f.consumer.startConsumer('g'); const old = loopOf(f.consumer, 'g');
  f.transport.owner = 'other'; f.connections[0]!.pending.resolve(['game:cmd:v2:g', await f.enqueue('old')]);
  await entered.done;
  f.consumer.stopConsumer('g'); f.consumer.startConsumer('g');
  f.transport.owner = 'owner'; reply.resolve(); await old;
  assert.equal(f.consumer.isConsuming('g'), true, 'A callback must not delete B');
  const b = f.connections[1]!; assert.equal(b.closed, false);
  f.boundary.eval = evaluate;
  b.pending.resolve(['game:cmd:v2:g', await f.enqueue('new')]); await turn();
  assert.equal(f.authority.getState('g').ply, 1);
  assert.equal(f.transport.records.get(requestKey('new'))?.status, 'done');
  assert.equal(f.transport.records.get(requestKey('old'))?.status, 'queued');
});

test('F3: admitted old work completes its exact response without changing replacement lifecycle', { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>();
  t.after(() => release.resolve());
  const append = f.store.append.bind(f.store);
  f.store.append = async (...args) => { entered.resolve(); await release.done; return append(...args); };
  f.consumer.startConsumer('g'); const old = loopOf(f.consumer, 'g');
  f.connections[0]!.pending.resolve(['game:cmd:v2:g', await f.enqueue('admitted')]); await entered.done;
  f.consumer.stopConsumer('g'); f.consumer.startConsumer('g'); release.resolve(); await turn();
  assert.equal(f.authority.getState('g').ply, 1);
  assert.equal(f.transport.records.get(requestKey('admitted'))?.status, 'done');
  assert.equal(f.transport.lists.get('game:resp:admitted')?.length, 1);
  assert.equal(f.consumer.isConsuming('g'), true); assert.equal(f.connections[1]!.closed, false);
  let settled = false; void old.then(() => { settled = true; }); await turn(); assert.equal(settled, true);
});

for (const replacement of [false, true]) {
for (const status of ['not_owner', 'done', 'admitted'] as const) {
  test(`F3: stopped expiry completion (${status}, replacement=${replacement}) cleans only without replacement`, { timeout: 5000 }, async t => {
    const f = await fixture(t), entered = deferred<void>(), release = deferred<void>();
    t.after(() => release.resolve());
    await f.authority.apply('g', 'alice', { kind: 'resign' }); f.authority.evict('g');
    f.consumer.watchLocalSessions(() => false);
    const payload = JSON.stringify({ version: 2, gameId: 'g', requestId: 'expiry', responseKey: 'game:resp:expiry',
      userId: FLAG_ACTOR, cmd: { kind: 'expireFlag' } });
    await f.transport.eval(ENQUEUE_REQUEST, 2, requestKey('expiry'), 'game:cmd:v2:g', payload, 1000, REQUEST_RETENTION_MS);
    f.transport.lists.get('game:cmd:v2:g')!.shift();
    if (status === 'not_owner') f.transport.owner = 'other';
    if (status === 'done') f.transport.records.get(requestKey('expiry'))!.status = 'done';
    const evaluate = f.boundary.eval;
    f.boundary.eval = async (...args) => {
      const result = await evaluate(...args);
      if (args[0] === START_REQUEST) { assert.equal(result, status); entered.resolve(); await release.done; }
      return result;
    };
    f.consumer.startConsumer('g'); const old = loopOf(f.consumer, 'g');
    f.connections[0]!.pending.resolve(['game:cmd:v2:g', payload]); await entered.done;
    assert.equal(f.authority.has('g'), true, 'old expiry loaded the ended copy before replacement');
    f.consumer.stopConsumer('g'); if (replacement) f.consumer.startConsumer('g'); release.resolve(); await old;
    assert.equal(f.authority.has('g'), replacement, 'R04 cleanup remains required unless B owns residency');
    assert.equal(f.consumer.isConsuming('g'), replacement);
    if (replacement) assert.equal(f.connections[1]!.closed, false);
    if (status === 'not_owner') {
      assert.deepEqual(f.transport.lists.get('game:cmd:v2:g'), [payload], 'handoff preserves the original queued identity');
    }
    if (status === 'admitted') {
      assert.equal(f.transport.records.get(requestKey('expiry'))?.status, 'done');
      assert.equal(f.transport.lists.get('game:resp:expiry')?.length, 1);
    }
  });
}
}

for (const replacement of [false, true]) {
  test(`F3: late malformed delivery terminates quietly (replacement=${replacement})`, { timeout: 5000 }, async t => {
    const f = await fixture(t), errors = t.mock.method(console, 'error', () => undefined);
    f.consumer.startConsumer('g'); const old = loopOf(f.consumer, 'g');
    f.consumer.stopConsumer('g'); if (replacement) f.consumer.startConsumer('g');
    f.connections[0]!.pending.resolve(['game:cmd:v2:g', '{malformed']); await old;
    assert.equal(errors.mock.callCount(), 0); assert.equal(f.connections[0]!.calls, 1);
    assert.equal(f.consumer.isConsuming('g'), replacement);
    if (replacement) assert.equal(f.connections[1]!.closed, false);
  });
}
