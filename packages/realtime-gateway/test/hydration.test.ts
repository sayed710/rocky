import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameAuthority, AuthorityError } from '../src/authority';
import { InMemoryEventLog, type EventLog } from '../src/event-log';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import type { Broadcast } from '../src/protocol';
import { RealtimeGateway } from '../src/gateway';
import { InMemoryConnection } from '../src/transport';

function barrier() {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  return { done, resolve };
}

async function fixture() {
  const store = new InMemoryEventLog();
  const seed = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await seed.createGame({ gameId: 'g', players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
  return { store, seed };
}

function delayedFirstRead(store: EventLog) {
  const entered = barrier(), release = barrier();
  let reads = 0;
  const log: EventLog = {
    exists: (id) => store.exists(id), append: (...args) => store.append(...args),
    load: async (id) => {
      const snapshot = await store.load(id);
      if (++reads === 1) { entered.resolve(); await release.done; }
      return snapshot;
    },
  };
  return { log, entered, release, reads: () => reads };
}

test('D4: simultaneous cold callers share one load and one command boundary', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  const d = delayedFirstRead(store);
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, d.log);
  const first = a.ensureLoaded('g'); await d.entered.done;
  const second = a.ensureLoaded('g');
  const white = a.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const black = a.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
  d.release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal((await white).state.ply, 1);
  assert.equal((await black).state.ply, 2);
  assert.equal(d.reads(), 1);
  assert.deepEqual((await store.load('g')).map(e => e.seq), [0, 1, 2]);
});

test('forced takeover reads after the ordinary cold snapshot, before a queued command', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const d = delayedFirstRead(store);
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, d.log);
  const cold = a.ensureLoaded('g'); await d.entered.done;
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const takeover = a.reloadFromLog('g');
  const ordinary = a.ensureLoaded('g');
  const black = a.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
  d.release.resolve();
  assert.equal(await cold, true);
  assert.equal(await takeover, true);
  assert.equal(await ordinary, true);
  assert.equal((await black).state.ply, 2);
  assert.equal(d.reads(), 2, 'takeover cannot reuse the older cold read');
});

test('eviction invalidates a delayed cold result; rejoin retains the busy slot and loads anew', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const d = delayedFirstRead(store);
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, d.log);
  const obsolete = a.ensureLoaded('g'); await d.entered.done;
  a.evict('g');
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const rejoin = a.ensureLoaded('g');
  d.release.resolve();
  assert.equal(await obsolete, true, 'invalidated ordinary callers retry the current lifecycle');
  assert.equal(await rejoin, true);
  assert.equal(a.getState('g').ply, 1);
  assert.equal(d.reads(), 2);
});

test('eviction while append and another command wait never creates a second active lock', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  const entered = barrier(), release = barrier();
  let appends = 0, active = 0, maximum = 0;
  const log: EventLog = { exists: id => store.exists(id), load: id => store.load(id),
    append: async (...args) => {
      active++; maximum = Math.max(maximum, active);
      try {
        if (++appends === 1) { entered.resolve(); await release.done; }
        return await store.append(...args);
      } finally { active--; }
    } };
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, log);
  await a.ensureLoaded('g');
  const white = a.apply('g', 'alice', { kind: 'move', uci: 'b1c3' }); await entered.done;
  const black = a.apply('g', 'bob', { kind: 'move', uci: 'e7e5' });
  a.evict('g');
  const rejoin = a.ensureLoaded('g');
  release.resolve();
  assert.equal((await white).state.ply, 1);
  assert.equal((await black).state.ply, 2);
  assert.equal(await rejoin, true);
  assert.equal(a.getState('g').ply, 2);
  assert.equal(maximum, 1);
});

test('deferred eviction removes an idle slot after queued commands drain', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  const entered = barrier(), release = barrier();
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await a.ensureLoaded('g');
  const move = a.apply('g', 'alice', { kind: 'move', uci: 'b1c3' }, {
    beforeExecute: async () => { entered.resolve(); await release.done; },
  });
  await entered.done; a.evict('g');
  assert.equal(a.has('g'), false);
  assert.equal(a.hasFresh('g'), false);
  assert.throws(() => a.getState('g'), AuthorityError);
  assert.throws(() => a.apply('g', 'bob', { kind: 'move', uci: 'e7e5' }), AuthorityError);
  release.resolve(); await move;
  assert.equal(a.has('g'), false);
  assert.equal(await a.ensureLoaded('g'), true);
  assert.equal(a.getState('g').ply, 1);
});

test('cold joiners and synchronous readers cannot bypass a pending forced reload', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const d = delayedFirstRead(store), forcedEntered = barrier(), forcedRelease = barrier();
  let reads = 0;
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, {
    ...d.log, load: async id => {
      const snapshot = await d.log.load(id);
      if (++reads === 2) { forcedEntered.resolve(); await forcedRelease.done; }
      return snapshot;
    },
  });
  let joined = false;
  const cold = a.ensureLoaded('g').then(loaded => { joined = loaded; return loaded; });
  await d.entered.done;
  const second = a.ensureLoaded('g');
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const reload = a.reloadFromLog('g'); d.release.resolve(); await forcedEntered.done;
  assert.equal(joined, false);
  assert.equal(a.hasFresh('g'), false);
  assert.throws(() => a.getState('g'), /reload is required/);
  assert.throws(() => a.colorOf('g', 'alice'), /reload is required/);
  assert.throws(() => a.getMissedSince('g', 0), /reload is required/);
  forcedRelease.resolve();
  assert.deepEqual(await Promise.all([cold, second, reload]), [true, true, true]);
  assert.equal(a.getState('g').ply, 1);
});

test('failed cold and forced reads remain retryable, missing log never retains a fresh record', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  let fail = true, missing = false;
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, {
    exists: id => store.exists(id), append: (...args) => store.append(...args),
    load: async id => { if (fail) throw Error('read failed'); return missing ? [] : store.load(id); },
  });
  await assert.rejects(a.ensureLoaded('g'), /read failed/);
  fail = false; assert.equal(await a.ensureLoaded('g'), true);
  fail = true; await assert.rejects(a.reloadFromLog('g'), /read failed/);
  assert.equal(a.hasFresh('g'), false);
  fail = false; assert.equal(await a.ensureLoaded('g'), true);
  missing = true; assert.equal(await a.reloadFromLog('g'), false);
  assert.equal(a.has('g'), false);
  assert.throws(() => a.apply('g', 'alice', { kind: 'resign' }), AuthorityError);
  assert.equal(await a.ensureLoaded('g'), false);
  missing = false; assert.equal(await a.ensureLoaded('g'), true);
});

test('eviction invalidates a forced read and a later generation must read again', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const d = delayedFirstRead(store);
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, d.log);
  const old = a.reloadFromLog('g'); await d.entered.done;
  a.evict('g');
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const current = a.reloadFromLog('g'); d.release.resolve();
  assert.equal(await old, false);
  assert.equal(await current, true);
  assert.equal(a.getState('g').ply, 1);
});

test('rejoin after eviction cannot wait on an obsolete forced reload as its current load', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const d = delayedFirstRead(store);
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, d.log);
  const old = a.reloadFromLog('g'); await d.entered.done;
  a.evict('g');
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const rejoin = a.ensureLoaded('g'); d.release.resolve();
  assert.equal(await old, false);
  assert.equal(await rejoin, true);
  assert.equal(d.reads(), 2);
  assert.equal(a.getState('g').ply, 1);
});

test('admission selects the reloaded resident and only a successful exact request gets a receipt', { timeout: 5000 }, async () => {
  const { store, seed } = await fixture();
  const pubsub = new InMemoryPubSub(), frames: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g'), msg => frames.push(msg));
  const a = new GameAuthority(pubsub, () => 1000, store);
  await a.ensureLoaded('g');
  await seed.apply('g', 'alice', { kind: 'move', uci: 'b1c3' });
  const reload = a.reloadFromLog('g');
  let admittedPly = -1;
  const move = a.apply('g', 'bob', { kind: 'move', uci: 'e7e5' }, {
    beforeExecute: async () => { admittedPly = a.getState('g').ply; }, requestId: 'exact-success',
  });
  await reload; await move;
  assert.equal(admittedPly, 1);
  await assert.rejects(a.apply('g', 'alice', { kind: 'resign' }, {
    beforeExecute: async () => { throw new AuthorityError('command_expired', 'expired'); }, requestId: 'expired',
  }), /expired/);
  assert.deepEqual(frames.filter(msg => msg.t === 'commandConfirmed').map(msg => msg.requestId), ['exact-success']);
  assert.equal((await store.load('g')).length, 3);
});

test('D3: lifecycle invalidation during admission refuses mutation and emits no exact receipt', { timeout: 5000 }, async () => {
  const { store } = await fixture(), pubsub = new InMemoryPubSub(), frames: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g'), msg => frames.push(msg));
  const a = new GameAuthority(pubsub, () => 1000, store);
  await a.ensureLoaded('g');
  const entered = barrier(), release = barrier(), lifecycleGeneration = a.captureLifecycle('g');
  const refused = assert.rejects(a.apply('g', 'alice', { kind: 'move', uci: 'b1c3' }, {
    lifecycleGeneration, requestId: 'obsolete-exact-id',
    beforeExecute: async () => { entered.resolve(); await release.done; },
  }), /lifecycle changed/);
  await entered.done; a.evict('g'); release.resolve(); await refused;
  assert.equal((await store.load('g')).length, 1); assert.equal(frames.length, 0);
  await a.ensureLoaded('g');
  await a.apply('g', 'alice', { kind: 'move', uci: 'b1c3' }, {
    lifecycleGeneration: a.captureLifecycle('g'), requestId: 'current-exact-id',
  });
  assert.deepEqual(frames.filter(m => m.t === 'commandConfirmed').map(m => m.requestId), ['current-exact-id']);
});

test('D3: an evicted and recreated idle slot never reuses an old lifecycle ticket', async () => {
  const { store } = await fixture(), a = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  await a.ensureLoaded('g'); const generation = a.captureLifecycle('g');
  a.evict('g'); await a.ensureLoaded('g');
  await assert.rejects(a.apply('g', 'alice', { kind: 'resign' }, { lifecycleGeneration: generation }), /lifecycle changed/);
  assert.equal(a.getState('g').status.over, false); assert.equal((await store.load('g')).length, 1);
});

test('D3: synchronous admission recheck covers loss between callback resolution and slot continuation', async () => {
  const { store, seed } = await fixture(); let current = true;
  await assert.rejects(seed.apply('g', 'alice', { kind: 'resign' }, {
    beforeExecute: async () => { queueMicrotask(() => { current = false; }); },
    recheckAdmission: () => { if (!current) throw new AuthorityError('command_expired', 'ownership lost at continuation'); },
    requestId: 'lost-at-continuation',
  }), /lost at continuation/);
  assert.equal(seed.getState('g').status.over, false); assert.equal((await store.load('g')).length, 1);
});

for (const resident of [true, false]) {
  test(`forced-read failures reach ${resident ? 'resident' : 'cold'} joiners as load errors`, { timeout: 5000 }, async () => {
    const { store } = await fixture();
    const entered = barrier(), release = barrier();
    let fail = false;
    const a = new GameAuthority(new InMemoryPubSub(), () => 1000, {
      exists: id => store.exists(id), append: (...args) => store.append(...args),
      load: async id => {
        if (fail) { entered.resolve(); await release.done; throw Error('forced read failed'); }
        return store.load(id);
      },
    });
    if (resident) await a.ensureLoaded('g');
    const pubsub = new InMemoryPubSub();
    const gateway = new RealtimeGateway(a, pubsub, { verify: () => null });
    const joiner = new InMemoryConnection(); gateway.handleConnection(joiner);
    fail = true;
    const reload = assert.rejects(a.reloadFromLog('g'), /forced read failed/);
    await entered.done;
    const waiter = assert.rejects(a.ensureLoaded('g'), /forced read failed/);
    joiner.deliver({ t: 'join', gameId: 'g' });
    release.resolve(); await Promise.all([reload, waiter]);
    await new Promise<void>(r => setImmediate(r));
    assert.equal(joiner.last('reject')?.code, 'invalid_command');
    assert.equal(joiner.last('reject')?.message, 'failed to load game');
    fail = false;
    assert.equal(await a.ensureLoaded('g'), true);
    joiner.close();
  });
}

test('successful creation remains resident after eviction during its durable append', { timeout: 5000 }, async () => {
  const store = new InMemoryEventLog(), entered = barrier(), release = barrier();
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, {
    exists: id => store.exists(id), load: id => store.load(id),
    append: async (...args) => { entered.resolve(); await release.done; return store.append(...args); },
  });
  const creation = a.createGame({ gameId: 'new', players: { white: 'alice', black: 'bob' }, rated: false,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } });
  await entered.done; a.evict('new'); release.resolve(); await creation;
  assert.equal(a.hasFresh('new'), true);
  assert.equal((await a.apply('new', 'alice', { kind: 'move', uci: 'b1c3' })).state.ply, 1);
});

test('a joiner waiting on a forced read retries eviction instead of reporting a missing game', { timeout: 5000 }, async () => {
  const { store } = await fixture(), d = delayedFirstRead(store), pubsub = new InMemoryPubSub();
  const a = new GameAuthority(pubsub, () => 1000, d.log);
  const reload = a.reloadFromLog('g'); await d.entered.done;
  const gateway = new RealtimeGateway(a, pubsub, { verify: () => null });
  const joiner = new InMemoryConnection(); gateway.handleConnection(joiner);
  joiner.deliver({ t: 'join', gameId: 'g' });
  a.evict('g'); d.release.resolve();
  assert.equal(await reload, false);
  await new Promise<void>(r => setImmediate(r));
  assert.ok(joiner.last('joined'));
  assert.equal(joiner.last('reject'), undefined);
  // post-hydration recovery read (Qodo cold-race fix)
  assert.equal(d.reads(), 3);
  joiner.close();
});

test('ordinary cold callers propagate a forced read failure requested during their load', { timeout: 5000 }, async () => {
  const { store } = await fixture(), d = delayedFirstRead(store);
  let reads = 0;
  const a = new GameAuthority(new InMemoryPubSub(), () => 1000, {
    ...d.log, load: async id => {
      if (++reads === 2) throw Error('later forced read failed');
      return d.log.load(id);
    },
  });
  const cold = a.ensureLoaded('g'); await d.entered.done;
  const coldFailure = assert.rejects(cold, /later forced read failed/);
  const forcedFailure = assert.rejects(a.reloadFromLog('g'), /later forced read failed/);
  d.release.resolve();
  await Promise.all([coldFailure, forcedFailure]);
  assert.equal(a.hasFresh('g'), false);
  assert.equal(await a.ensureLoaded('g'), true);
});
