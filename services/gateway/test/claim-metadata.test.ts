/** R-02 F4: production router/registry/authority, controlled external lease and log I/O. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Redis, RedisOptions } from 'ioredis';
import { AuthorityError, GameAuthority, InMemoryEventLog, InMemoryPubSub, gameChannel,
  type EventLog, type Broadcast } from '@chess-platform/realtime-gateway';
import { OwnershipRegistry } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';

function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  return { done, resolve };
}

/** Per-key Redis boundary; no routing/admission code is replaced. */
class LeaseRedis {
  readonly owners = new Map<string, string>();
  now = 0;
  releaseFailure = false;
  disconnected = 0;
  async set(key: string, node: string) {
    if (this.owners.has(key)) return null;
    this.owners.set(key, node); return 'OK';
  }
  async get(key: string) { return this.owners.get(key) ?? null; }
  async eval(script: string, _count: number, key: string, node: string) {
    if (script.includes("'DEL'") && this.releaseFailure) throw Error('release I/O failed');
    if (this.owners.get(key) !== node) return 0;
    if (script.includes("'DEL'")) this.owners.delete(key);
    return 1;
  }
  duplicate(options?: RedisOptions) {
    if (!options) return { blpop: () => new Promise<null>(() => undefined), disconnect: () => { this.disconnected++; } };
    return { on: () => undefined, connect: async () => undefined,
      get: (key: string) => this.get(key), disconnect: () => undefined };
  }
}

interface RouterMetadata {
  readonly staleAfterClaim: Set<string>;
  readonly claimGeneration: Map<string, number>;
  readonly rehydrations: Map<string, { readonly generation: number; readonly done: Promise<void> }>;
}

/** Observe private retention, not a public diagnostics API added solely for these tests. */
function metadata(router: RedisCommandRouter): RouterMetadata { return router as unknown as RouterMetadata; }

async function fixture(t: TestContext) {
  const redis = new LeaseRedis(), store = new InMemoryEventLog(), pubsub = new InMemoryPubSub();
  const reads: Array<{ entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier>; fail: boolean }> = [];
  const plan: typeof reads = [];
  const log: EventLog = {
    exists: id => store.exists(id), append: (...args) => store.append(...args),
    load: async id => {
      const gate = plan.shift();
      if (gate) { gate.entered.resolve(); await gate.release.done; if (gate.fail) throw Error('durable reload failed'); }
      return store.load(id);
    },
  };
  const authority = new GameAuthority(pubsub, () => 1000, log);
  const client = redis as unknown as Redis;
  const registry = new OwnershipRegistry({ redis: client, nodeId: 'local', monotonicNow: () => redis.now });
  const consumer = new OwnerCommandConsumer(authority, client);
  const router = new RedisCommandRouter({ authority, registry, redis: client, nodeId: 'local', consumer });
  t.after(() => { for (const gate of reads) gate.release.resolve(); consumer.stop(); registry.stopRenewal(); });
  async function create(id = 'g') {
    await authority.createGame({ gameId: id, players: { white: 'alice', black: 'bob' }, rated: false,
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
    assert.equal((await registry.claim(id)).owned, true);
  }
  function hold(fail = false) {
    const gate = { entered: barrier(), release: barrier(), fail }; reads.push(gate); plan.push(gate); return gate;
  }
  const frames: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g'), message => { frames.push(message); });
  return { redis, store, authority, registry, consumer, router, create, hold, frames, meta: metadata(router) };
}

function emptyDebt(meta: RouterMetadata, gameId: string) {
  assert.equal(meta.staleAfterClaim.has(gameId), false, 'released claim must not retain stale debt');
  assert.equal(meta.claimGeneration.has(gameId), false, 'released claim must not retain its generation');
}

test('F4-01: failed reload remains retryable while owned, then release retires abandoned debt', async t => {
  const f = await fixture(t); await f.create();
  const gate = f.hold(true);
  const failed = assert.rejects(f.router.prepareOwnership('g'), /durable reload failed/);
  await gate.entered.done; gate.release.resolve(); await failed;
  assert.equal(f.meta.staleAfterClaim.has('g'), true);
  assert.equal(f.meta.claimGeneration.has('g'), true);
  assert.equal(f.meta.rehydrations.size, 0);
  assert.equal(f.router.holdsOwnership('g'), false);
  await f.registry.release('g'); emptyDebt(f.meta, 'g');
  assert.equal(f.registry.ownedCount, 0);
  assert.equal(f.router.holdsOwnership('g'), false, 'debt retirement must not reopen ownership admission');
});

test('F4-02: twelve distinct failed-load/release cycles leave no cumulative router metadata', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 12; n++) {
    const id = `abandoned-${n}`; await f.create(id);
    const gate = f.hold(true), failed = assert.rejects(f.router.prepareOwnership(id), /durable reload failed/);
    await gate.entered.done; gate.release.resolve(); await failed; await f.registry.release(id);
  }
  assert.equal(f.meta.rehydrations.size, 0);
  assert.equal(f.registry.ownedCount, 0);
  assert.equal(f.meta.staleAfterClaim.size, 0, 'retention must not grow with abandoned game IDs');
  assert.equal(f.meta.claimGeneration.size, 0);
});

for (const fails of [false, true]) {
  test(`F4-03/04/05/06: old ${fails ? 'rejection' : 'success'} preserves unresolved replacement reload and fresh admission`, { timeout: 5000 }, async t => {
    const f = await fixture(t); await f.create();
    const oldGeneration = f.meta.claimGeneration.get('g');
    const oldGate = f.hold(fails);
    const old = assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), error =>
      fails ? error instanceof Error && error.message === 'durable reload failed' :
        error instanceof AuthorityError && error.code === 'command_expired');
    await oldGate.entered.done;
    const oldFlight = f.meta.rehydrations.get('g'); assert.ok(oldFlight);
    await f.registry.release('g');
    assert.equal(f.meta.rehydrations.get('g'), oldFlight, 'pending old promise remains tracked until settlement');
    assert.equal((await f.registry.claim('g')).owned, true);
    const newGeneration = f.meta.claimGeneration.get('g'); assert.ok(newGeneration);
    assert.notEqual(newGeneration, oldGeneration);
    const newGate = f.hold();
    const fresh = f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' });
    const newFlight = f.meta.rehydrations.get('g'); assert.ok(newFlight);
    assert.equal(newFlight.generation, newGeneration);
    assert.notEqual(newFlight.done, oldFlight.done);
    oldGate.release.resolve(); await newGate.entered.done;
    if (fails) await old;
    else await oldFlight.done;
    assert.equal(f.meta.claimGeneration.get('g'), newGeneration);
    assert.equal(f.meta.staleAfterClaim.has('g'), true);
    assert.equal(f.meta.rehydrations.get('g'), newFlight, 'old finally cannot erase pending B');
    assert.equal(f.router.holdsOwnership('g'), false);
    assert.equal(f.frames.length, 0);
    assert.deepEqual((await f.store.load('g')).map(e => e.seq), [0]);
    newGate.release.resolve(); assert.equal((await fresh).state.ply, 1); await old;
    emptyDebt(f.meta, 'g'); assert.equal(f.meta.rehydrations.size, 0);
    assert.equal(f.router.holdsOwnership('g'), true);
    assert.deepEqual((await f.store.load('g')).map(e => e.seq), [0, 1]);
    assert.equal(f.frames.filter(m => m.t === 'move').length, 1, 'old gesture is not automatically replayed');
  });
}

for (const fails of [false, true]) {
  test(`F4-06: release without replacement preserves pending ${fails ? 'failure' : 'success'} settlement, not debt`, { timeout: 5000 }, async t => {
    const f = await fixture(t); await f.create();
    const gate = f.hold(fails);
    const old = assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), error =>
      fails ? error instanceof Error && error.message === 'durable reload failed' :
        error instanceof AuthorityError && error.code === 'command_expired');
    await gate.entered.done;
    const pending = f.meta.rehydrations.get('g'); assert.ok(pending);
    await f.registry.release('g');
    assert.equal(f.meta.rehydrations.get('g'), pending);
    gate.release.resolve(); await old;
    assert.equal(f.meta.rehydrations.size, 0);
    emptyDebt(f.meta, 'g');
    assert.equal(f.router.holdsOwnership('g'), false);
    assert.equal(f.frames.length, 0); assert.deepEqual((await f.store.load('g')).map(e => e.seq), [0]);
  });
}

test('F4-07: consumer-only stop/replacement preserves still-owned failed-reload debt', async t => {
  const f = await fixture(t); await f.create();
  const gate = f.hold(true), failed = assert.rejects(f.router.prepareOwnership('g'), /durable reload failed/);
  await gate.entered.done; gate.release.resolve(); await failed;
  const generation = f.meta.claimGeneration.get('g');
  f.consumer.stopConsumer('g'); f.consumer.startConsumer('g'); f.consumer.stop(); f.consumer.startConsumer('g');
  assert.equal(f.meta.claimGeneration.get('g'), generation); assert.equal(f.meta.staleAfterClaim.has('g'), true);
  assert.equal(f.router.holdsOwnership('g'), false);
  assert.equal((await f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});

test('F4-08: release/reclaim keeps the busy D4 slot and refuses D3 obsolete admission', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.create();
  const lifecycle = f.authority.captureLifecycle('g'), oldTicket = f.registry.captureTicket('g'); assert.ok(oldTicket);
  const gate = f.hold();
  const old = assert.rejects(f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' }), error =>
    error instanceof AuthorityError && error.code === 'command_expired');
  await gate.entered.done;
  const released = f.registry.release('g'), claimed = f.registry.claim('g');
  assert.equal(f.registry.isTicketCurrent(oldTicket), false);
  await released; await claimed;
  assert.equal(f.authority.captureLifecycle('g'), lifecycle, 'cleanup must not evict/split a busy authority slot');
  const fresh = f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' });
  gate.release.resolve(); await old; assert.equal((await fresh).state.ply, 1);
  assert.equal(f.authority.captureLifecycle('g'), lifecycle);
  assert.deepEqual((await f.store.load('g')).map(e => e.seq), [0, 1]);
});

test('F4: failed Redis release retires invalid local debt without treating the extant key as valid admission', async t => {
  const f = await fixture(t); await f.create();
  const gate = f.hold(true), failed = assert.rejects(f.router.prepareOwnership('g'), /durable reload failed/);
  await gate.entered.done; gate.release.resolve(); await failed;
  f.redis.releaseFailure = true;
  await assert.rejects(f.registry.release('g'), /release I\/O failed/);
  emptyDebt(f.meta, 'g'); assert.equal(f.router.holdsOwnership('g'), false);
  assert.equal((await f.registry.claim('g')).owned, true);
  assert.equal(f.meta.staleAfterClaim.has('g'), true, 'a new claim must reload even though the key remained');
  assert.equal((await f.router.route('g', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});

test('F4: shutdown stop/releaseAll retires only released generations', async t => {
  const f = await fixture(t); await f.create('first'); await f.create('second');
  f.consumer.stop();
  assert.equal(f.meta.claimGeneration.size, 2, 'stopping sockets alone is not ownership abandonment');
  await f.registry.releaseAll();
  assert.equal(f.meta.staleAfterClaim.size, 0); assert.equal(f.meta.claimGeneration.size, 0);
  assert.equal(f.meta.rehydrations.size, 0); assert.equal(f.registry.ownedCount, 0);
});

test('F4: confirmed renewal loss retires debt, unlike local safety-margin expiry alone', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t); await f.create();
  const gate = f.hold(true), failed = assert.rejects(f.router.prepareOwnership('g'), /durable reload failed/);
  await gate.entered.done; gate.release.resolve(); await failed;
  f.redis.now = 22000;
  assert.equal(f.registry.holdsValidLease('g'), false);
  assert.equal(f.meta.staleAfterClaim.has('g'), true, 'local expiry alone is not permanent ownership abandonment');
  assert.equal(f.meta.claimGeneration.has('g'), true);
  f.redis.owners.set('game:owner:g', 'remote');
  f.registry.startRenewal(); t.mock.timers.tick(15000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.registry.ownedCount, 0);
  assert.equal(f.consumer.isConsuming('g'), false);
  emptyDebt(f.meta, 'g'); assert.equal(f.router.holdsOwnership('g'), false);
});
