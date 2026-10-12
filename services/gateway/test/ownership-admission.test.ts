/** R-01 D3: real registry/router/authority, deterministic Redis boundary and log scheduling. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Redis, RedisOptions } from 'ioredis';
import { GameAuthority, InMemoryEventLog, InMemoryPubSub, LocalCommandRouter, gameChannel,
  type EventLog, type Broadcast } from '@chess-platform/realtime-gateway';
import { OwnershipRegistry } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';

function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  return { done, resolve };
}

/** Only external Redis I/O is simulated; domain objects and admission are production code. */
class LeaseRedis {
  now = 0;
  owner: string | null = null;
  expires = 0;
  compare: (() => Promise<void>) | undefined;
  connectError = false;
  disconnected = 0;
  options: RedisOptions | undefined;
  readonly client = this as unknown as Redis;
  current() { return this.now < this.expires ? this.owner : null; }
  async set(_key: string, node: string, _ex: string, seconds: number) {
    if (this.current()) return null;
    this.owner = node; this.expires = this.now + seconds * 1000; return 'OK';
  }
  async get() { return this.current(); }
  async eval(script: string, _n: number, _key: string, node: string, seconds?: string) {
    if (this.current() !== node) return 0;
    if (script.includes("'DEL'")) { this.owner = null; return 1; }
    this.expires = this.now + Number(seconds) * 1000; return 1;
  }
  duplicate(options?: RedisOptions) {
    if (!options) return { blpop: () => new Promise<null>(() => undefined), disconnect: () => undefined };
    this.options = options;
    return {
      on: () => undefined,
      connect: async () => { if (this.connectError) throw Error('Redis connection unavailable'); },
      get: async () => { const snapshot = this.current(); await this.compare?.(); return snapshot; },
      disconnect: () => { this.disconnected++; },
    };
  }
}

async function fixture(t: TestContext, opts: { log?: (store: EventLog) => EventLog; timeout?: number } = {}) {
  const redis = new LeaseRedis(), store = new InMemoryEventLog(), pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, opts.log?.(store) ?? store);
  const registry = new OwnershipRegistry({ redis: redis.client, nodeId: 'local',
    leaseTtlSec: 30, renewalIntervalSec: 15, monotonicNow: () => redis.now });
  const consumer = new OwnerCommandConsumer(authority, redis.client);
  t.after(() => consumer.stop());
  const router = new RedisCommandRouter({ authority, registry, redis: redis.client, nodeId: 'local',
    consumer, ownershipCheckTimeoutMs: opts.timeout ?? 1000 });
  await authority.createGame({ gameId: 'g', players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
  assert.equal(await router.prepareOwnership('g'), true);
  const frames: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g'), msg => { frames.push(msg); });
  return { authority, registry, router, redis, store, frames };
}

function observeQueue(authority: GameAuthority) {
  const queued = barrier(), apply = authority.apply.bind(authority);
  authority.apply = (...args) => { const done = apply(...args); queued.resolve(); return done; };
  return queued;
}

test('D3: same-node release/reclaim refuses the original queued gesture without replay or receipt', { timeout: 5000 }, async t => {
  const entered = barrier(), release = barrier(); let paused = false;
  const f = await fixture(t, { log: store => ({ exists: id => store.exists(id), load: id => store.load(id),
    append: async (...args) => { if (paused) { paused = false; entered.resolve(); await release.done; } return store.append(...args); } }) });
  paused = true;
  const first = f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' });
  await entered.done;
  const queued = observeQueue(f.authority);
  const second = assert.rejects(f.router.route('g', 'bob', { kind: 'move', uci: 'e7e5' }), /ownership.*changed/);
  await queued.done;
  await f.registry.release('g'); await f.registry.claim('g');
  release.resolve();
  assert.equal((await first).state.ply, 1); await second;
  assert.deepEqual((await f.store.load('g')).map(e => e.seq), [0, 1]);
  assert.equal(f.authority.getState('g').ply, 1);
  assert.equal(f.frames.filter(m => m.t === 'move').length, 1);
  assert.equal(f.frames.filter(m => m.t === 'commandConfirmed').length, 0);
  assert.equal((await f.router.route('g', 'bob', { kind: 'move', uci: 'e7e5' })).state.ply, 2,
    'a separate new intent may settle new-claim debt and execute');
});

test('D3: generation change during takeover hydration refuses the original intent', { timeout: 5000 }, async t => {
  const entered = barrier(), release = barrier(); let paused = false;
  const f = await fixture(t, { log: store => ({ exists: id => store.exists(id), append: (...args) => store.append(...args),
    load: async id => { const snapshot = await store.load(id); if (paused) { paused = false; entered.resolve(); await release.done; } return snapshot; } }) });
  await f.registry.release('g'); await f.registry.claim('g'); paused = true;
  const old = assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), /ownership.*changed/);
  await entered.done;
  await f.registry.release('g'); await f.registry.claim('g');
  release.resolve(); await old;
  assert.equal((await f.store.load('g')).length, 1);
  assert.equal(f.frames.length, 0);
  assert.equal((await f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});

for (const failure of ['expiry', 'generation', 'lifecycle', 'reload'] as const) {
  test(`D3: ${failure} during asynchronous owner comparison refuses before mutation`, { timeout: 5000 }, async t => {
    const f = await fixture(t), entered = barrier(), release = barrier();
    f.redis.compare = async () => { entered.resolve(); await release.done; };
    const attempt = assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), /(ownership.*(changed|verified)|fresh ownership attempt)/);
    await entered.done;
    if (failure === 'expiry') f.redis.now = 30000;
    if (failure === 'generation') { await f.registry.release('g'); await f.registry.claim('g'); }
    if (failure === 'lifecycle') f.authority.evict('g');
    const reload = failure === 'reload' ? f.authority.reloadFromLog('g') : undefined;
    release.resolve();
    await attempt;
    await reload;
    assert.equal((await f.store.load('g')).length, 1);
    assert.equal(f.frames.length, 0);
  });
}

test('D3: Redis owner mismatch refuses a locally valid lease without forwarding the gesture', async t => {
  const f = await fixture(t); f.redis.owner = 'successor';
  await assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), /could not be verified/);
  assert.equal((await f.store.load('g')).length, 1); assert.equal(f.frames.length, 0);
  assert.equal(f.authority.getState('g').ply, 0);
});

test('D3: comparison timeout is bounded, disconnects, and releases the slot for a new attempt', { timeout: 5000 }, async t => {
  const f = await fixture(t, { timeout: 20 });
  f.redis.compare = () => new Promise<void>(() => undefined);
  await assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), /could not be verified/);
  assert.equal((await f.store.load('g')).length, 1); assert.equal(f.frames.length, 0);
  assert.equal(f.redis.disconnected, 1);
  assert.equal(f.redis.options?.enableOfflineQueue, false);
  assert.equal(f.redis.options?.autoResendUnfulfilledCommands, false);
  f.redis.compare = undefined;
  assert.equal((await f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});

test('D3: an unavailable comparison socket fails closed; single-node local routing needs no lease', async t => {
  const f = await fixture(t); f.redis.connectError = true;
  await assert.rejects(f.router.route('g', 'alice', { kind: 'resign' }), /could not be verified/);
  assert.equal(f.frames.length, 0); assert.equal((await f.store.load('g')).length, 1);
  assert.equal((await new LocalCommandRouter(f.authority).route('g', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});
