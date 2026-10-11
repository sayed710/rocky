import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  CommandOutcomeUnknownError,
} from '@chess-platform/realtime-gateway';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import type { OwnershipRegistry } from '../src/ownership.js';
import { ForwardRedis } from './support/forward-redis.js';

// Only transport and lease discovery are simulated. Both replicas use the production
// router/consumer/authority and share the real in-memory event-log implementation.
function fixture(gameId: string) {
  const store = new InMemoryEventLog();
  const owner = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  const other = new GameAuthority(new InMemoryPubSub(), () => 1000, store);
  const transport = new ForwardRedis();
  const redis = transport.client;
  let claims = 0;
  const registry = {
    holdsValidLease: () => false,
    claim: async () => { claims += 1; return { owned: false, ownerNodeId: 'owner' }; },
    setHooks: () => undefined,
  } as unknown as OwnershipRegistry;
  const consumer = new OwnerCommandConsumer(owner, redis);
  consumer.bindOwner('owner');
  const router = new RedisCommandRouter({
    authority: other, registry, redis, nodeId: 'forwarder',
    forwardTimeoutMs: 1000, consumer: new OwnerCommandConsumer(other, redis),
  });
  const consume = async (copy?: string) => {
    const payload = copy ?? transport.lists.get(`game:cmd:v2:${gameId}`)?.shift();
    assert.ok(payload, 'forwarded command exists in transport queue');
    // Exercise the actual receiving path without launching an infinite BLPOP loop.
    // @ts-expect-error accessing private method for focused regression test
    await consumer.processCommand(payload);
  };
  return {
    store, owner, router, transport, consume, claims: () => claims,
    onTimeout: (work: () => Promise<void>) => { transport.onWait = work; },
    create: () => owner.createGame({
      gameId, players: { white: 'alice', black: 'bob' }, rated: false,
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'increment' },
    }),
  };
}

test('R-03: resignation rejected by forward timeout must not execute on delayed consumption', async () => {
  const gameId = 'forward-timeout-delayed-resignation';
  const f = fixture(gameId);
  await f.create();
  const before = await f.store.load(gameId);
  let delayed = '';
  f.onTimeout(async () => { delayed = f.transport.lists.get(`game:cmd:v2:${gameId}`)![0]!; });
  await assert.rejects(f.router.route(gameId, 'alice', { kind: 'resign' }), /expired before execution/);
  assert.equal(f.owner.getState(gameId).status.over, false);
  await f.consume(delayed);
  assert.deepEqual(await f.store.load(gameId), before, 'expired command must not append events');
  assert.equal(f.owner.getState(gameId).status.over, false, 'expired resignation must not end game');
});

test('R-03: committed resignation survives a lost acknowledgement and durable replay', async () => {
  const gameId = 'forward-timeout-lost-ack';
  const f = fixture(gameId);
  await f.create();
  f.onTimeout(f.consume);
  const result = await f.router.route(gameId, 'alice', { kind: 'resign' });
  assert.equal(result.state.status.over, true, 'retained result reconciles lost response');
  assert.equal(f.owner.getState(gameId).status.over, true, 'commit precedes response timeout');
  const committed = await f.store.load(gameId);
  assert.equal(committed.filter(({ event }) => event.type === 'GameEnded').length, 1);
  const replay = new GameAuthority(new InMemoryPubSub(), () => 1000, f.store);
  await replay.ensureLoaded(gameId);
  assert.equal(replay.getState(gameId).status.over, true, 'authoritative committed result survives replay');
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('R-03: timeout during append is unknown, preserves commit, and never replays on takeover', async () => {
  const id = 'forward-inflight'; const f = fixture(id); await f.create();
  const entered = latch(); const release = latch();
  const append = f.store.append.bind(f.store);
  f.store.append = async (...args) => { entered.resolve(); await release.promise; return append(...args); };
  let processing!: Promise<void>; let copy = '';
  f.onTimeout(async () => {
    copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!;
    processing = f.consume(); await entered.promise;
  });
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), (err: unknown) => {
    assert.ok(err instanceof CommandOutcomeUnknownError); assert.ok(err.requestId.startsWith('forwarder-')); return true;
  });
  assert.equal(f.claims(), 1, 'no timeout takeover or automatic local replay');
  assert.equal(f.owner.getState(id).status.over, false);
  release.resolve(); await processing; await f.consume(copy);
  assert.equal((await f.store.load(id)).filter(({ event }) => event.type === 'GameEnded').length, 1);
});

test('R-03: waiting behind authority lock remains queued and is cancelled at timeout', async () => {
  const id = 'forward-lock-wait'; const f = fixture(id); await f.create();
  const entered = latch(); const release = latch(); const append = f.store.append.bind(f.store);
  f.store.append = async (...args) => { entered.resolve(); await release.promise; return append(...args); };
  const move = f.owner.apply(id, 'alice', { kind: 'move', uci: 'e2e4' });
  await entered.promise;
  let processing!: Promise<void>;
  f.onTimeout(async () => { processing = f.consume(); });
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), /expired before execution/);
  release.resolve(); await move; await processing;
  assert.equal(f.owner.getState(id).ply, 1);
  assert.equal(f.owner.getState(id).status.over, false);
  assert.equal((await f.store.load(id)).filter(({ event }) => event.type === 'GameEnded').length, 0);
});

for (const time of [999, 1000]) {
  test(`R-03: Redis admission boundary at ${time}ms`, async () => {
    const id = `forward-boundary-${time}`; const f = fixture(id); await f.create();
    f.onTimeout(async () => { f.transport.now = time; await f.consume(); });
    if (time < 1000) assert.equal((await f.router.route(id, 'alice', { kind: 'resign' })).state.status.over, true);
    else await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), /expired before execution/);
    assert.equal(f.owner.getState(id).status.over, time < 1000);
  });
}

test('R-03: Redis completion failure after commit returns unknown and duplicates cannot mutate', async () => {
  const id = 'forward-finish-failure'; const f = fixture(id); await f.create();
  f.transport.failFinish = true; let copy = '';
  f.onTimeout(async () => {
    copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!;
    await assert.rejects(f.consume(), /Redis unavailable after commit/);
  });
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), CommandOutcomeUnknownError);
  const committed = await f.store.load(id);
  f.transport.failFinish = false;
  await f.consume(copy);
  f.transport.now = 31_001; await f.consume(copy); // Tombstone TTL elapsed: missing never authorizes execution.
  assert.deepEqual(await f.store.load(id), committed);
});

test('R-03: response transport failure does not overwrite retained successful result', async () => {
  const id = 'forward-response-failure'; const f = fixture(id); await f.create();
  f.transport.failResponse = true;
  f.onTimeout(async () => { await assert.rejects(f.consume(), /response lost/); });
  assert.equal((await f.router.route(id, 'alice', { kind: 'resign' })).state.status.over, true);
});

test('R-03: response connection timeout settles queued work without late execution', async () => {
  const id = 'forward-response-timeout'; const f = fixture(id); await f.create();
  f.transport.responseConnectionLost = true;
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), /expired before execution/);
  assert.equal(f.owner.getState(id).status.over, false);
  assert.equal(f.transport.lists.get(`game:cmd:v2:${id}`)?.length, 0);
});

test('R-03: response connection timeout recovers a retained durable result', async () => {
  const id = 'forward-response-timeout-committed'; const f = fixture(id); await f.create();
  f.transport.responseConnectionLost = true; f.onTimeout(f.consume);
  assert.equal((await f.router.route(id, 'alice', { kind: 'resign' })).state.status.over, true);
  assert.equal((await f.store.load(id)).filter(({ event }) => event.type === 'GameEnded').length, 1);
});

test('R-03: uncertain enqueue response cancels queued work without applying it', async () => {
  const id = 'forward-enqueue-lost'; const f = fixture(id); await f.create();
  f.transport.enqueueReplyLost = true;
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), /expired before execution/);
  assert.equal(f.owner.getState(id).status.over, false);
  assert.equal(f.transport.lists.get(`game:cmd:v2:${id}`)?.length, 0);
});

test('R-03: lost enqueue acknowledgement cannot recreate its identity after reconnect beyond retention', async () => {
  const id = 'forward-enqueue-reconnect'; const f = fixture(id); await f.create();
  f.transport.enqueueReplyLost = true; f.transport.reconnectAfterLostEnqueue = true;
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), CommandOutcomeUnknownError);
  assert.equal(f.transport.enqueueAttempts, 1, 'unfulfilled enqueue is never automatically resent');
  const copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!;
  await f.consume(copy);
  assert.equal(f.owner.getState(id).status.over, false);
  assert.equal((await f.store.load(id)).filter(({ event }) => event.type === 'GameEnded').length, 0);
});

test('R-03: legacy envelopes fail closed without appending events', async () => {
  const id = 'forward-legacy'; const f = fixture(id); await f.create();
  const before = await f.store.load(id);
  await f.consume(JSON.stringify({ requestId: 'legacy', gameId: id, userId: 'alice', cmd: { kind: 'resign' }, responseKey: 'game:resp:legacy' }));
  assert.deepEqual(await f.store.load(id), before);
});

test('R-03: valid move retains identity and duplicate delivery leaves event log unchanged', async () => {
  const id = 'forward-valid-move'; const f = fixture(id); await f.create(); let copy = '';
  f.transport.loseResponses = false;
  f.onTimeout(async () => { copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!; await f.consume(); });
  assert.equal((await f.router.route(id, 'alice', { kind: 'move', uci: 'e2e4' })).state.ply, 1);
  const committed = await f.store.load(id); await f.consume(copy);
  assert.deepEqual(await f.store.load(id), committed);
});

test('R-03: Redis failure during timeout produces unknown, never a confirmed rejection', async () => {
  const id = 'forward-settle-failure'; const f = fixture(id); await f.create();
  f.transport.failSettle = true;
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), CommandOutcomeUnknownError);
  const queued = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!;
  f.transport.now = 1000; await f.consume(queued);
  assert.equal(f.owner.getState(id).status.over, false, 'server deadline still protects queued work when cancellation cannot reach Redis');
});

test('R-03: failure before admission revokes the queued identity before reporting expiration', async () => {
  const id = 'forward-load-failure'; const f = fixture(id); await f.create();
  f.owner.evict(id); const load = f.store.load.bind(f.store); let copy = '';
  f.store.load = async () => [];
  f.onTimeout(async () => { copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!; await f.consume(); });
  await assert.rejects(f.router.route(id, 'alice', { kind: 'resign' }), /expired before execution/);
  f.store.load = load; await f.consume(copy);
  assert.equal((await f.store.load(id)).filter(({ event }) => event.type === 'GameEnded').length, 0);
});

test('R-03: stale consumer hands unstarted work to new owner with the same identity', async () => {
  const id = 'forward-owner-handoff'; const f = fixture(id); await f.create(); let copy = '';
  f.transport.owner = 'new-owner';
  f.onTimeout(async () => {
    copy = f.transport.lists.get(`game:cmd:v2:${id}`)![0]!;
    await f.consume();
    assert.equal(f.owner.getState(id).status.over, false, 'old owner cannot execute');
    assert.equal(f.transport.lists.get(`game:cmd:v2:${id}`)![0], copy, 'same identity and deadline requeued');
    // A separate consumer represents the succeeding replica.
    const successor = new OwnerCommandConsumer(f.owner, f.transport.client); successor.bindOwner('new-owner');
    const payload = f.transport.lists.get(`game:cmd:v2:${id}`)!.shift()!;
    // @ts-expect-error controlled delivery at ownership boundary
    await successor.processCommand(payload);
  });
  assert.equal((await f.router.route(id, 'alice', { kind: 'resign' })).state.status.over, true);
  const committed = await f.store.load(id); await f.consume(copy);
  assert.deepEqual(await f.store.load(id), committed);
});
