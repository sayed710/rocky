import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Broadcast } from '../src/protocol';
import { InMemoryPubSub, RedisPubSub, type RedisLike } from '../src/pubsub';

// ── Fake Redis client for hermetic testing ──────────────────────────────────

/**
 * A minimal in-memory fake that satisfies {@link RedisLike}. Multiple fakes
 * share a common bus so messages published on one fake are delivered to all
 * fakes subscribed to the same channel — mirroring real Redis pub/sub.
 */
class FakeRedisBus {
  private subscribers = new Map<string, Set<(channel: string, message: string) => void>>();

  publish(channel: string, message: string): void {
    const subs = this.subscribers.get(channel);
    if (!subs) return;
    for (const cb of [...subs]) cb(channel, message);
  }

  subscribe(channel: string, cb: (channel: string, message: string) => void): void {
    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(cb);
  }

  unsubscribe(channel: string, cb: (channel: string, message: string) => void): void {
    const set = this.subscribers.get(channel);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this.subscribers.delete(channel);
  }
}

class FakeRedis implements RedisLike {
  private listeners: ((channel: string, message: string) => void)[] = [];

  constructor(private readonly bus: FakeRedisBus) {}

  publish(channel: string, message: string): number {
    this.bus.publish(channel, message);
    return 1;
  }

  subscribe(channel: string): void {
    this.bus.subscribe(channel, (ch, msg) => {
      for (const listener of [...this.listeners]) listener(ch, msg);
    });
  }

  unsubscribe(channel: string): void {
    // The bus removes the callback; we registered a single shared callback.
    // In this fake, subscribe adds a wrapper that calls all listeners.
    // For simplicity, unsubscribe is a no-op here — the real Redis client
    // handles this. The ref-counting logic in RedisPubSub ensures subscribe/
    // unsubscribe are called correctly.
  }

  on(event: 'message', listener: (channel: string, message: string) => void): void;
  on(event: 'close' | 'ready', listener: () => void): void;
  on(
    event: 'message' | 'close' | 'ready',
    listener: ((channel: string, message: string) => void) | (() => void),
  ): void {
    if (event === 'message') this.listeners.push(listener as (channel: string, message: string) => void);
  }

  off(event: 'message', listener: (channel: string, message: string) => void): void;
  off(event: 'close' | 'ready', listener: () => void): void;
  off(
    event: 'message' | 'close' | 'ready',
    listener: ((channel: string, message: string) => void) | (() => void),
  ): void {
    if (event === 'message') {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
  }

  quit(): void {
    this.listeners = [];
  }
}

function makeBroadcast(ply: number): Broadcast {
  return {
    t: 'move',
    stateRevision: ply,
    gameId: 'g1',
    ply,
    uci: 'e2e4',
    san: 'e4',
    by: 'w' as const,
    fenHash: 'abc123',
    clock: { w: 300000, b: 300000 },
    serverTs: 1000,
    legalMoves: {},
  };
}

// ── InMemoryPubSub tests (regression) ───────────────────────────────────────

test('InMemoryPubSub: publish delivers to all subscribers', () => {
  const pubsub = new InMemoryPubSub();
  const received: Broadcast[] = [];
  pubsub.subscribe('game:g1', (msg) => received.push(msg));
  pubsub.subscribe('game:g1', (msg) => received.push(msg));

  const msg = makeBroadcast(1);
  pubsub.publish('game:g1', msg);
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], msg);
});

test('InMemoryPubSub: unsubscribe stops delivery', () => {
  const pubsub = new InMemoryPubSub();
  const received: Broadcast[] = [];
  const unsub = pubsub.subscribe('game:g1', (msg) => received.push(msg));

  pubsub.publish('game:g1', makeBroadcast(1));
  assert.equal(received.length, 1);

  unsub();
  pubsub.publish('game:g1', makeBroadcast(2));
  assert.equal(received.length, 1);
});

test('InMemoryPubSub: subscriberCount tracks active subscribers', () => {
  const pubsub = new InMemoryPubSub();
  assert.equal(pubsub.subscriberCount('game:g1'), 0);

  const u1 = pubsub.subscribe('game:g1', () => {});
  assert.equal(pubsub.subscriberCount('game:g1'), 1);

  const u2 = pubsub.subscribe('game:g1', () => {});
  assert.equal(pubsub.subscriberCount('game:g1'), 2);

  u1();
  assert.equal(pubsub.subscriberCount('game:g1'), 1);

  u2();
  assert.equal(pubsub.subscriberCount('game:g1'), 0);
});

// ── RedisPubSub tests ───────────────────────────────────────────────────────

test('RedisPubSub: publish delivers to subscribers on another node', async () => {
  const bus = new FakeRedisBus();
  const pubA = new FakeRedis(bus);
  const subA = new FakeRedis(bus);
  const pubB = new FakeRedis(bus);
  const subB = new FakeRedis(bus);

  const nodeA = new RedisPubSub(pubA, subA, 'node-a');
  const nodeB = new RedisPubSub(pubB, subB, 'node-b');

  const received: Broadcast[] = [];
  nodeB.subscribe('game:g1', (msg) => received.push(msg));

  // Node A publishes — node B should receive it.
  const msg = makeBroadcast(1);
  nodeA.publish('game:g1', msg);

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], msg);

  await nodeA.close();
  await nodeB.close();
});

test('RedisPubSub: single-node local delivery (regression — publish must deliver to local subscribers)', async () => {
  const bus = new FakeRedisBus();
  const pub = new FakeRedis(bus);
  const sub = new FakeRedis(bus);

  const node = new RedisPubSub(pub, sub, 'node-a');

  const received: Broadcast[] = [];
  node.subscribe('game:g1', (msg) => received.push(msg));

  // A single RedisPubSub node with a local subscriber must receive its own
  // published message. Before the fix, publish() only sent to Redis and the
  // self-origin skip prevented the echo from arriving — so local subscribers
  // got nothing. This test proves the fix: publish() delivers locally first.
  const msg = makeBroadcast(1);
  node.publish('game:g1', msg);
  assert.equal(received.length, 1, 'local subscriber must receive the published message');
  assert.deepEqual(received[0], msg);

  await node.close();
});

test('RedisPubSub: local delivery in publish, Redis echo skipped (no double-fanout)', async () => {
  const bus = new FakeRedisBus();
  const pubA = new FakeRedis(bus);
  const subA = new FakeRedis(bus);

  const nodeA = new RedisPubSub(pubA, subA, 'node-a');

  const received: Broadcast[] = [];
  nodeA.subscribe('game:g1', (msg) => received.push(msg));

  // Node A publishes — the local subscriber receives the message synchronously
  // in publish() (local delivery). The Redis echo is skipped by the message
  // listener (origin === nodeId), so the subscriber receives exactly once,
  // NOT twice.
  const msg = makeBroadcast(1);
  nodeA.publish('game:g1', msg);
  assert.equal(received.length, 1, 'local subscriber receives exactly once (local delivery, Redis echo skipped)');
  assert.deepEqual(received[0], msg);

  await nodeA.close();
});

test('RedisPubSub: ref-counted subscribe issues Redis SUBSCRIBE once', async () => {
  const bus = new FakeRedisBus();
  const pub = new FakeRedis(bus);
  const sub = new FakeRedis(bus);

  let subscribeCount = 0;
  const origSubscribe = sub.subscribe.bind(sub);
  sub.subscribe = (channel: string): void => {
    subscribeCount++;
    origSubscribe(channel);
  };

  let unsubscribeCount = 0;
  const origUnsub = sub.unsubscribe.bind(sub);
  sub.unsubscribe = (channel: string): void => {
    unsubscribeCount++;
    origUnsub(channel);
  };

  const node = new RedisPubSub(pub, sub, 'node-a');

  const u1 = node.subscribe('game:g1', () => {});
  assert.equal(subscribeCount, 1, 'first subscribe issues Redis SUBSCRIBE');

  const u2 = node.subscribe('game:g1', () => {});
  assert.equal(subscribeCount, 1, 'second subscribe does NOT re-issue Redis SUBSCRIBE');

  u1();
  assert.equal(unsubscribeCount, 0, 'unsubscribe with remaining subs does NOT issue Redis UNSUBSCRIBE');

  u2();
  assert.equal(unsubscribeCount, 1, 'last unsubscribe issues Redis UNSUBSCRIBE');

  await node.close();
});

test('RedisPubSub: multiple channels are independent', async () => {
  const bus = new FakeRedisBus();
  const pubA = new FakeRedis(bus);
  const subA = new FakeRedis(bus);
  const pubB = new FakeRedis(bus);
  const subB = new FakeRedis(bus);

  const nodeA = new RedisPubSub(pubA, subA, 'node-a');
  const nodeB = new RedisPubSub(pubB, subB, 'node-b');

  const g1Received: Broadcast[] = [];
  const g2Received: Broadcast[] = [];
  nodeB.subscribe('game:g1', (msg) => g1Received.push(msg));
  nodeB.subscribe('game:g2', (msg) => g2Received.push(msg));

  nodeA.publish('game:g1', makeBroadcast(1));
  nodeA.publish('game:g2', makeBroadcast(2));

  assert.equal(g1Received.length, 1);
  const g1 = g1Received[0]!;
  assert.equal(g1.t, 'move');
  if (g1.t === 'move') assert.equal(g1.ply, 1);

  assert.equal(g2Received.length, 1);
  const g2 = g2Received[0]!;
  assert.equal(g2.t, 'move');
  if (g2.t === 'move') assert.equal(g2.ply, 2);

  await nodeA.close();
  await nodeB.close();
});

test('RedisPubSub: subscriberCount tracks local subscribers', async () => {
  const bus = new FakeRedisBus();
  const pub = new FakeRedis(bus);
  const sub = new FakeRedis(bus);

  const node = new RedisPubSub(pub, sub, 'node-a');
  assert.equal(node.subscriberCount('game:g1'), 0);

  const u1 = node.subscribe('game:g1', () => {});
  assert.equal(node.subscriberCount('game:g1'), 1);

  const u2 = node.subscribe('game:g1', () => {});
  assert.equal(node.subscriberCount('game:g1'), 2);

  u1();
  assert.equal(node.subscriberCount('game:g1'), 1);

  u2();
  assert.equal(node.subscriberCount('game:g1'), 0);

  await node.close();
});

test('RedisPubSub: close stops delivery and cleans up', async () => {
  const bus = new FakeRedisBus();
  const pubA = new FakeRedis(bus);
  const subA = new FakeRedis(bus);
  const pubB = new FakeRedis(bus);
  const subB = new FakeRedis(bus);

  const nodeA = new RedisPubSub(pubA, subA, 'node-a');
  const nodeB = new RedisPubSub(pubB, subB, 'node-b');

  const received: Broadcast[] = [];
  nodeB.subscribe('game:g1', (msg) => received.push(msg));

  await nodeB.close();

  // After close, publish from nodeA should not reach nodeB.
  nodeA.publish('game:g1', makeBroadcast(1));
  assert.equal(received.length, 0, 'closed node should not receive messages');

  await nodeA.close();
});

test('RedisPubSub: three-node fanout — all non-origin nodes receive', async () => {
  const bus = new FakeRedisBus();
  const makeNode = (id: string) => {
    return new RedisPubSub(new FakeRedis(bus), new FakeRedis(bus), id);
  };

  const nodeA = makeNode('node-a');
  const nodeB = makeNode('node-b');
  const nodeC = makeNode('node-c');

  const recvB: Broadcast[] = [];
  const recvC: Broadcast[] = [];
  nodeB.subscribe('game:g1', (msg) => recvB.push(msg));
  nodeC.subscribe('game:g1', (msg) => recvC.push(msg));

  const msg = makeBroadcast(5);
  nodeA.publish('game:g1', msg);

  assert.equal(recvB.length, 1, 'node B should receive');
  assert.equal(recvC.length, 1, 'node C should receive');
  assert.deepEqual(recvB[0], msg);
  assert.deepEqual(recvC[0], msg);

  await nodeA.close();
  await nodeB.close();
  await nodeC.close();
});

test('RedisPubSub: malformed payload is ignored, not crashed', async () => {
  const bus = new FakeRedisBus();
  const pubA = new FakeRedis(bus);
  const subA = new FakeRedis(bus);
  const pubB = new FakeRedis(bus);
  const subB = new FakeRedis(bus);

  const nodeA = new RedisPubSub(pubA, subA, 'node-a');
  const nodeB = new RedisPubSub(pubB, subB, 'node-b');

  const received: Broadcast[] = [];
  nodeB.subscribe('game:g1', (msg) => received.push(msg));

  // Directly publish a malformed payload via the bus (bypassing the envelope).
  bus.publish('game:g1', 'not-valid-json');

  // Node B should not crash and should not have received anything.
  assert.equal(received.length, 0);

  // Normal publish still works after a malformed message.
  nodeA.publish('game:g1', makeBroadcast(1));
  assert.equal(received.length, 1);

  await nodeA.close();
  await nodeB.close();
});
