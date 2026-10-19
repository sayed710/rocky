/**
 * Stage B: Confirmed Redis SUBSCRIBE readiness and subscriber reconnects.
 * Tests SB1 to SB10.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryEventLog,
  RedisPubSub,
  RealtimeGateway,
  gameChannel,
  type RedisLike,
} from '../src/index';
import { InMemoryConnection } from '../src/transport';
import { FakeTokenVerifier } from './fake-token-verifier';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class ManualScheduler {
  private tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

  get pendingCount(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  schedule = (fn: () => void, ms: number): (() => void) => {
    const task = { fn, ms, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  fire(): void {
    const active = this.tasks.filter((t) => !t.cancelled);
    this.tasks = this.tasks.filter((t) => t.cancelled);
    for (const t of active) {
      t.fn();
    }
  }
}

// ── Deterministic Fake Redis Broker ─────────────────────────────────────────

class FakeRedisClient implements RedisLike {
  private readonly messageListeners = new Set<(channel: string, message: string) => void>();
  private readonly lifecycleListeners = new Map<'close' | 'ready', Set<() => void>>([
    ['close', new Set()],
    ['ready', new Set()],
  ]);

  constructor(
    readonly broker: FakeRedisBroker,
    readonly id: string,
  ) {}

  publish(channel: string, message: string): Promise<number> | number {
    return this.broker.clientPublish(this, channel, message);
  }

  subscribe(channel: string): Promise<void> | void {
    return this.broker.clientSubscribe(this, channel);
  }

  unsubscribe(channel: string): Promise<void> | void {
    return this.broker.clientUnsubscribe(this, channel);
  }

  on(event: 'message', listener: (channel: string, message: string) => void): void;
  on(event: 'close' | 'ready', listener: () => void): void;
  on(
    event: 'message' | 'close' | 'ready',
    listener: ((channel: string, message: string) => void) | (() => void),
  ): void {
    if (event === 'message') {
      this.messageListeners.add(listener as (channel: string, message: string) => void);
    } else {
      this.lifecycleListeners.get(event)?.add(listener as () => void);
    }
  }

  off(event: 'message', listener: (channel: string, message: string) => void): void;
  off(event: 'close' | 'ready', listener: () => void): void;
  off(
    event: 'message' | 'close' | 'ready',
    listener: ((channel: string, message: string) => void) | (() => void),
  ): void {
    if (event === 'message') {
      this.messageListeners.delete(listener as (channel: string, message: string) => void);
    } else {
      this.lifecycleListeners.get(event)?.delete(listener as () => void);
    }
  }

  quit(): Promise<void> | void {
    this.broker.clientQuit(this);
    this.messageListeners.clear();
    this.lifecycleListeners.get('close')?.clear();
    this.lifecycleListeners.get('ready')?.clear();
    return Promise.resolve();
  }

  deliverMessage(channel: string, message: string): void {
    for (const listener of [...this.messageListeners]) {
      listener(channel, message);
    }
  }

  emitLifecycle(event: 'close' | 'ready'): void {
    const set = this.lifecycleListeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener();
    }
  }
}

interface PendingSubscription {
  channel: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

class FakeRedisBroker {
  private readonly clients = new Set<FakeRedisClient>();
  private readonly activeSubscriptions = new Map<FakeRedisClient, Set<string>>();
  private readonly pendingSubscriptions = new Map<FakeRedisClient, Map<string, PendingSubscription[]>>();
  private readonly gatedChannels = new Set<string>();
  private readonly failingSubscribeChannels = new Map<string, Error>();
  private publishError: Error | null = null;
  public readonly subscribeCallCount = new Map<string, number>();

  createClient(id: string): FakeRedisClient {
    const client = new FakeRedisClient(this, id);
    this.clients.add(client);
    this.activeSubscriptions.set(client, new Set());
    this.pendingSubscriptions.set(client, new Map());
    return client;
  }

  gateChannel(channel: string): void {
    this.gatedChannels.add(channel);
  }

  ungateChannel(channel: string): void {
    this.gatedChannels.delete(channel);
  }

  failSubscribe(channel: string, err: Error): void {
    this.failingSubscribeChannels.set(channel, err);
  }

  clearFailSubscribe(channel: string): void {
    this.failingSubscribeChannels.delete(channel);
  }

  failPublish(err: Error | null): void {
    this.publishError = err;
  }

  clientPublish(_client: FakeRedisClient, channel: string, message: string): Promise<number> {
    if (this.publishError) {
      return Promise.reject(this.publishError);
    }
    let count = 0;
    for (const otherClient of this.clients) {
      const active = this.activeSubscriptions.get(otherClient);
      if (active?.has(channel)) {
        otherClient.deliverMessage(channel, message);
        count++;
      }
    }
    return Promise.resolve(count);
  }

  clientSubscribe(client: FakeRedisClient, channel: string): Promise<void> {
    const count = (this.subscribeCallCount.get(channel) ?? 0) + 1;
    this.subscribeCallCount.set(channel, count);

    const failErr = this.failingSubscribeChannels.get(channel);
    if (failErr) {
      return Promise.reject(failErr);
    }

    if (this.gatedChannels.has(channel)) {
      return new Promise<void>((resolve, reject) => {
        let clientPending = this.pendingSubscriptions.get(client);
        if (!clientPending) {
          clientPending = new Map();
          this.pendingSubscriptions.set(client, clientPending);
        }
        let list = clientPending.get(channel);
        if (!list) {
          list = [];
          clientPending.set(channel, list);
        }
        list.push({ channel, resolve, reject });
      });
    }

    const active = this.activeSubscriptions.get(client);
    active?.add(channel);
    return Promise.resolve();
  }

  clientUnsubscribe(client: FakeRedisClient, channel: string): Promise<void> {
    this.activeSubscriptions.get(client)?.delete(channel);
    return Promise.resolve();
  }

  clientQuit(client: FakeRedisClient): void {
    this.clients.delete(client);
    this.activeSubscriptions.delete(client);
    this.pendingSubscriptions.delete(client);
  }

  acknowledge(client: FakeRedisClient, channel: string): void {
    const clientPending = this.pendingSubscriptions.get(client);
    const pendingList = clientPending?.get(channel);
    if (pendingList && pendingList.length > 0) {
      const item = pendingList.shift()!;
      this.activeSubscriptions.get(client)?.add(channel);
      item.resolve();
    }
  }

  acknowledgeAll(channel: string): void {
    for (const [client, clientPending] of this.pendingSubscriptions) {
      const pendingList = clientPending.get(channel);
      if (pendingList) {
        while (pendingList.length > 0) {
          const item = pendingList.shift()!;
          this.activeSubscriptions.get(client)?.add(channel);
          item.resolve();
        }
      }
    }
  }

  simulateClose(client: FakeRedisClient): void {
    this.activeSubscriptions.get(client)?.clear();
    this.pendingSubscriptions.get(client)?.clear();
    client.emitLifecycle('close');
  }

  simulateReady(client: FakeRedisClient): void {
    client.emitLifecycle('ready');
  }
}

function getReadinessPubSub(pubsub: RedisPubSub): RedisPubSub {
  return pubsub;
}

function getStageBGateway(gateway: RealtimeGateway): RealtimeGateway {
  return gateway;
}

// ── Tests SB1 - SB10 ────────────────────────────────────────────────────────

test('SB1 (the P2 reproducer): Cold join on B with SUBSCRIBE unacknowledged; writer commits a move; acknowledge', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pubA = broker.createClient('pub-a');
  const subA = broker.createClient('sub-a');
  const pubB = broker.createClient('pub-b');
  const subB = broker.createClient('sub-b');

  const pubsubA = new RedisPubSub(pubA, subA, 'node-a');
  const pubsubB = new RedisPubSub(pubB, subB, 'node-b');

  const authorityA = new GameAuthority(pubsubA, () => 1000, store);
  const authorityB = new GameAuthority(pubsubB, () => 1000, store);

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const _gatewayA = new RealtimeGateway(authorityA, pubsubA, verifier);
  const gatewayB = new RealtimeGateway(authorityB, pubsubB, verifier);

  const gameId = 'game-sb1';
  await authorityA.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  // Gate SUBSCRIBE acknowledgement on Node B for this game's channel
  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  // Cold join on Gateway B
  const clientB = new InMemoryConnection('client-b');
  gatewayB.handleConnection(clientB);
  clientB.deliver({ t: 'join', gameId });
  await flush();

  // Writer on Node A commits a move (ply 1: e4)
  await authorityA.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Now acknowledge B's SUBSCRIBE
  broker.acknowledge(subB, ch);
  await flush();

  // B's client receives that move exactly once, either in joined or as a frame, and never loses it.
  const joined = clientB.last('joined');
  assert.ok(joined, 'client B must receive joined frame');

  const movesInFrames = clientB.all('move');
  const moveInJoined = joined.state.ply >= 1;
  const moveReceived = moveInJoined || movesInFrames.length > 0;

  assert.ok(
    moveReceived,
    `B's client must receive move 1 either in joined or as a frame, but joined ply=${joined.state.ply} rev=${joined.state.stateRevision} and move frames count=${movesInFrames.length}`,
  );

  if (moveInJoined) {
    assert.equal(movesInFrames.filter((m) => m.ply === 1).length, 0, 'move 1 already in joined state, should not be duplicated as frame');
  } else {
    assert.equal(movesInFrames.filter((m) => m.ply === 1).length, 1, 'move 1 must appear exactly once as frame');
  }
});

test('SB2: Two concurrent joins on B for the same game', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pubA = broker.createClient('pub-a');
  const subA = broker.createClient('sub-a');
  const pubB = broker.createClient('pub-b');
  const subB = broker.createClient('sub-b');

  const pubsubA = new RedisPubSub(pubA, subA, 'node-a');
  const pubsubB = new RedisPubSub(pubB, subB, 'node-b');

  const authorityA = new GameAuthority(pubsubA, () => 1000, store);
  const authorityB = new GameAuthority(pubsubB, () => 1000, store);

  const verifier = new FakeTokenVerifier().allow('tok-alice', 'alice').allow('tok-bob', 'bob');
  const gatewayB = new RealtimeGateway(authorityB, pubsubB, verifier);

  const gameId = 'game-sb2';
  await authorityA.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  // Two concurrent joins on B
  const c1 = new InMemoryConnection('c1');
  const c2 = new InMemoryConnection('c2');
  gatewayB.handleConnection(c1);
  gatewayB.handleConnection(c2);

  c1.deliver({ t: 'join', gameId });
  c2.deliver({ t: 'join', gameId });
  await flush();

  // Exactly one SUBSCRIBE issued
  assert.equal(broker.subscribeCallCount.get(ch), 1, 'exactly one SUBSCRIBE command should be issued to Redis for concurrent joins');

  // Writer commits move
  await authorityA.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Acknowledge the single SUBSCRIBE
  broker.acknowledge(subB, ch);
  await flush();

  const j1 = c1.last('joined');
  const j2 = c2.last('joined');
  assert.ok(j1, 'c1 must have joined');
  assert.ok(j2, 'c2 must have joined');

  const c1HasMove = j1.state.ply >= 1 || c1.all('move').length > 0;
  const c2HasMove = j2.state.ply >= 1 || c2.all('move').length > 0;

  assert.ok(c1HasMove, `c1 must receive move 1; got ply=${j1.state.ply} frames=${c1.all('move').length}`);
  assert.ok(c2HasMove, `c2 must receive move 1; got ply=${j2.state.ply} frames=${c2.all('move').length}`);
});

test('SB3: Subscribe -> unsubscribe (join abandoned) -> subscribe again while the first acknowledgement is still pending', async () => {
  const broker = new FakeRedisBroker();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));

  const ch = 'game:sb3';
  broker.gateChannel(ch);

  // First subscriber
  const unsub1 = pubsub.subscribe(ch, () => {});
  assert.equal(pubsub.subscriberCount(ch), 1);
  assert.equal(pubsub.subscriptionState?.(ch), 'pending', 'first subscription is pending');

  // Unsubscribe (join abandoned)
  unsub1();
  assert.equal(pubsub.subscriberCount(ch), 0, 'no subscribers left');
  assert.equal(pubsub.subscriptionState?.(ch), undefined, 'subscription state cleaned up on last unsubscribe');

  // Subscribe again while first acknowledgement is still pending
  const unsub2 = pubsub.subscribe(ch, () => {});
  assert.equal(pubsub.subscriberCount(ch), 1);
  assert.equal(pubsub.subscriptionState?.(ch), 'pending', 'second subscription generation is pending');

  // Now the stale first acknowledgement arrives
  broker.acknowledge(sub, ch);
  await flush();

  // Stale acknowledgement must NOT mark generation 2 as ready
  assert.equal(pubsub.subscriptionState?.(ch), 'pending', 'stale acknowledgement must not mark new generation as ready');

  // Now acknowledge generation 2
  broker.acknowledge(sub, ch);
  await flush();
  assert.equal(pubsub.subscriptionState?.(ch), 'ok', 'new generation is now ok');

  unsub2();
  assert.equal(pubsub.subscriberCount(ch), 0);
  assert.equal(pubsub.subscriptionState?.(ch), undefined, 'no leak');
});

test('SB4: SUBSCRIBE fails', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = getStageBGateway(new RealtimeGateway(authority, pubsub, verifier));

  const gameId = 'game-sb4';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.failSubscribe(ch, new Error('Redis connection refused'));

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  // Join still completes (no reject)
  const joined = c.last('joined');
  assert.ok(joined, 'join must still complete successfully');
  assert.equal(c.last('reject'), undefined, 'no reject message');

  // Game is in unconfirmedSubscriptions
  assert.equal(gateway.unconfirmedSubscriptionCount?.(), 1, 'game is in unconfirmedSubscriptions');
  assert.ok(gateway.unconfirmedSubscriptions?.has(gameId), 'gameId is in unconfirmedSubscriptions set');
  assert.equal(pubsub.subscriptionState?.(ch), 'failed', 'channel state is failed');

  // Later ready() re-issues SUBSCRIBE
  broker.clearFailSubscribe(ch);
  const readyPromise = pubsub.ready?.(ch);
  assert.ok(readyPromise, 'ready() returns a promise');
  await readyPromise;
  assert.equal(pubsub.subscriptionState?.(ch), 'ok', 're-issued SUBSCRIBE succeeded');
});

test('SB5: Subscriber close then ready', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'sb5-1';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch1 = gameChannel(gameId); // 'game:sb5-1'
  const ch2 = 'game:sb5-2';

  pubsub.subscribe(ch1, () => {});
  pubsub.subscribe(ch2, () => {});
  await flush();
  assert.equal(pubsub.subscriptionState?.(ch1), 'ok');
  assert.equal(pubsub.subscriptionState?.(ch2), 'ok');

  let reconnectCount = 0;
  assert.ok(typeof pubsub.onReconnect === 'function', 'onReconnect must be implemented on RedisPubSub');
  pubsub.onReconnect?.(() => {
    reconnectCount++;
  });

  // Simulate close
  broker.simulateClose(sub);

  // After 'close' and before 'ready', ready(channel) is pending: check with a flag after flush.
  let readyResolvedInGap = false;
  void pubsub.ready?.(ch1)?.then(() => {
    readyResolvedInGap = true;
  });
  await flush();
  assert.equal(readyResolvedInGap, false, 'ready(channel) must be pending during the reconnect gap');
  assert.equal(pubsub.subscriptionState?.(ch1), 'pending', 'channel state must be pending during reconnect gap');

  // Gate ch1 so resubscribe acknowledgement on reconnect is paused
  broker.gateChannel(ch1);

  // A gateway join started in the gap does NOT complete its snapshot before the resubscribe acknowledgement (it waits).
  const client = new InMemoryConnection('client');
  gateway.handleConnection(client);
  client.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(client.last('joined'), undefined, 'join started in the gap does not complete before resubscribe ack');

  // During resubscribe, ch1 will succeed and ch2 will fail
  broker.failSubscribe(ch2, new Error('ch2 subscription failed'));

  // Simulate ready
  broker.simulateReady(sub);
  await flush();

  // ch1 resubscribe is still gated, so join still waits and ready is still pending
  assert.equal(client.last('joined'), undefined, 'join still waiting on gated resubscribe');
  assert.equal(readyResolvedInGap, false, 'ready(ch1) is still pending while resubscribe is gated');

  // After the reconnect is acknowledged, the join completes and a move published after the ack is received exactly once.
  broker.acknowledge(sub, ch1);
  await flush();

  const joined = client.last('joined');
  assert.ok(joined, 'join completes after resubscribe ack');
  assert.equal(readyResolvedInGap, true, 'ready(ch1) must resolve after resubscribe ack');

  // Move published after the ack is received exactly once
  const moveMsg = {
    t: 'move' as const,
    gameId,
    ply: 1,
    move: { from: 'e2', to: 'e4' },
    san: 'e4',
    clock: { white: 300000, black: 300000 },
    stateRevision: 1,
    serverTs: 1000,
  };
  sub.deliverMessage(ch1, JSON.stringify({ origin: 'other-node', msg: moveMsg }));
  await flush();

  const moves = client.all('move');
  assert.equal(moves.length, 1, 'move published after ack is received exactly once');
  assert.equal(moves[0]!.ply, 1);

  assert.equal(reconnectCount, 1, 'onReconnect fires once after all settled');
  assert.equal(pubsub.subscriptionState?.(ch1), 'ok', 'ch1 resubscribe succeeded');
  assert.equal(pubsub.subscriptionState?.(ch2), 'failed', 'ch2 resubscribe failed');
});

test('SB6: Readiness timeout via the authority deadline and a ManualScheduler', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));

  const scheduler = new ManualScheduler();
  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 100,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = getStageBGateway(new RealtimeGateway(authority, pubsub, verifier));

  const gameId = 'game-sb6';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  // SUBSCRIBE is pending; join is waiting for ready
  assert.equal(c.last('joined'), undefined, 'join must be waiting for ready');

  // Trigger timeout via scheduler
  scheduler.fire();
  await flush();

  // Join continues and game is marked unconfirmed
  const joined = c.last('joined');
  assert.ok(joined, 'join continues after timeout');
  assert.equal(gateway.unconfirmedSubscriptionCount?.(), 1, 'game is recorded in unconfirmedSubscriptions');
  assert.ok(gateway.unconfirmedSubscriptions?.has(gameId));
});

test('SB7: Client disconnects while waiting for ready', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = getStageBGateway(new RealtimeGateway(authority, pubsub, verifier));

  const gameId = 'game-sb7';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  // Client disconnects while waiting for ready
  c.close();
  await flush();

  // Now acknowledge SUBSCRIBE
  broker.acknowledge(sub, ch);
  await flush();

  // No joined frame sent
  assert.equal(c.sent.length, 0, 'No joined frame should be sent to disconnected client');
  assert.equal(gateway.roomCount, 0, 'no room leak');
  assert.equal(gateway.unconfirmedSubscriptionCount?.(), 0, 'unconfirmed mark cleaned');
  assert.equal(pubsub.subscriberCount(ch), 0, 'buffer stopped and unsubscribed from pubsub');
});

test('SB8: Failed or revoked token while waiting for readiness', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));
  const authority = new GameAuthority(pubsub, () => 1000, store);

  class RevocableTokenVerifier {
    private valid = true;
    revoke(): void {
      this.valid = false;
    }
    verify(token: string): { readonly userId: string } | null {
      if (!this.valid) return null;
      return token === 'tok-valid' ? { userId: 'alice' } : null;
    }
  }

  const verifier = new RevocableTokenVerifier();
  const gateway = getStageBGateway(new RealtimeGateway(authority, pubsub, verifier));

  const gameId = 'game-sb8';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId, token: 'tok-valid' });
  await flush();

  // Revoke token while waiting for readiness
  verifier.revoke();

  // Now acknowledge SUBSCRIBE
  broker.acknowledge(sub, ch);
  await flush();

  // Rejected unauthorized
  const reject = c.last('reject');
  assert.ok(reject, 'client must receive reject');
  assert.equal(reject.code, 'unauthorized');
  assert.equal(gateway.roomCount, 0, 'no room created');
  assert.equal(gateway.hasLocalSessions(gameId), false, 'no membership');
});

test('SB9: Duplicate state frame on the room channel at the observed revision', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-sb9';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const c = new InMemoryConnection('c');
  gateway.handleConnection(c);
  c.deliver({ t: 'join', gameId });
  await flush();

  const joined = c.last('joined');
  assert.ok(joined);
  const currentRev = joined.state.stateRevision; // 0

  // Send duplicate state frame at observed revision (0) via sub message listener
  const duplicateStateMsg = {
    t: 'state' as const,
    gameId,
    state: { ...joined.state, stateRevision: currentRev },
  };
  // Send via Redis message from another origin
  sub.deliverMessage(gameChannel(gameId), JSON.stringify({ origin: 'other-node', msg: duplicateStateMsg }));
  await flush();

  // Duplicate state frame should NOT be forwarded to client
  assert.equal(c.all('state').length, 0, 'duplicate state at observed revision must not be forwarded');

  // Send a newer state frame (revision currentRev + 1)
  const newerStateMsg = {
    t: 'state' as const,
    gameId,
    state: { ...joined.state, stateRevision: currentRev + 1 },
  };
  sub.deliverMessage(gameChannel(gameId), JSON.stringify({ origin: 'other-node', msg: newerStateMsg }));
  await flush();

  // Newer state frame MUST be forwarded to client
  assert.equal(c.all('state').length, 1, 'newer state frame must be forwarded');
  assert.equal(c.all('state')[0]!.state.stateRevision, currentRev + 1);
});

test('SB10: publish rejection', async () => {
  const broker = new FakeRedisBroker();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = getReadinessPubSub(new RedisPubSub(pub, sub, 'node-1'));

  assert.ok(typeof pubsub.onPublishFailed === 'function', 'onPublishFailed must be implemented');

  const failedChannels: string[] = [];
  const unsub = pubsub.onPublishFailed?.((ch) => {
    failedChannels.push(ch);
  });

  broker.failPublish(new Error('Redis cluster down'));

  pubsub.publish('game:sb10', {
    t: 'ended',
    gameId: 'sb10',
    stateRevision: 1,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 1000,
  });
  await flush();

  assert.deepEqual(failedChannels, ['game:sb10'], 'onPublishFailed listener should be called with channel');

  unsub?.();
});

test('SB11: a ready() waiter on a pending SUBSCRIBE; reconnect replaces the entry; acknowledge the new SUBSCRIBE; the old waiter resolves', async () => {
  const broker = new FakeRedisBroker();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');

  const ch = 'game:sb11';
  broker.gateChannel(ch);

  // Subscribe issues pending SUBSCRIBE
  pubsub.subscribe(ch, () => {});

  let waiterResolved = false;
  const waiter = pubsub.ready(ch);
  void waiter.then(() => {
    waiterResolved = true;
  });
  await flush();
  assert.equal(waiterResolved, false, 'waiter is waiting on pending SUBSCRIBE');

  // Reconnect replaces the entry
  broker.simulateClose(sub);
  broker.simulateReady(sub);
  await flush();
  assert.equal(waiterResolved, false, 'waiter is still waiting on new generation');

  // Acknowledge the new SUBSCRIBE
  broker.acknowledge(sub, ch);
  await flush();

  assert.equal(waiterResolved, true, 'old waiter resolves once new SUBSCRIBE is acknowledged');
});

test('SB12: a ready() waiter; the last handler unsubscribes while SUBSCRIBE is pending; the waiter resolves', async () => {
  const broker = new FakeRedisBroker();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');

  const ch = 'game:sb12';
  broker.gateChannel(ch);

  const unsub = pubsub.subscribe(ch, () => {});

  let waiterResolved = false;
  const waiter = pubsub.ready(ch);
  void waiter.then(() => {
    waiterResolved = true;
  });
  await flush();
  assert.equal(waiterResolved, false, 'waiter is waiting on pending SUBSCRIBE');

  // Last handler unsubscribes while SUBSCRIBE is pending
  unsub();
  await flush();

  assert.equal(waiterResolved, true, 'waiter resolves when last handler unsubscribes');
});

test('SB13: a gateway join with NO read deadline is waiting on readiness; subscription superseded by reconnect resubscribe that is acknowledged; join completes', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');
  // Authority without durableReadTimeoutMs
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-sb13';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);

  const client = new InMemoryConnection('client');
  gateway.handleConnection(client);
  client.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(client.last('joined'), undefined, 'join waiting on readiness');

  // Reconnect replaces the entry
  broker.simulateClose(sub);
  broker.simulateReady(sub);
  await flush();

  assert.equal(client.last('joined'), undefined, 'join still waiting');

  // Acknowledge the new SUBSCRIBE
  broker.acknowledge(sub, ch);
  await flush();

  const joined = client.last('joined');
  assert.ok(joined, 'join completes after reconnect resubscribe is acknowledged');
  assert.equal(joined.t, 'joined');
});

test('SB14: client disconnects while waiting for ready, then readiness times out; unconfirmedSubscriptions stays empty', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');

  const scheduler = new ManualScheduler();
  const authority = new GameAuthority(pubsub, () => 1000, store, {
    durableReadTimeoutMs: 100,
    schedule: scheduler.schedule,
  });
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-sb14';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.gateChannel(ch);
  // Keep channel subscription active on the node (e.g. spectator or other handler)
  const unsubOther = pubsub.subscribe(ch, () => {});

  const client = new InMemoryConnection('client');
  gateway.handleConnection(client);
  client.deliver({ t: 'join', gameId });
  await flush();

  // Client disconnects while waiting
  client.close();
  await flush();

  // Now readiness times out
  scheduler.fire();
  await flush();

  // The set stays empty
  assert.equal(gateway.unconfirmedSubscriptionCount(), 0, 'unconfirmedSubscriptions set stays empty');
  assert.equal(gateway.unconfirmedSubscriptions.has(gameId), false);

  unsubOther();
});

test('SB15: failed readiness marks game unconfirmed; reconnect resubscribe succeeds; set is empty', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-sb15';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.failSubscribe(ch, new Error('Redis connection refused'));

  const client = new InMemoryConnection('client');
  gateway.handleConnection(client);
  client.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(gateway.unconfirmedSubscriptionCount(), 1, 'game is unconfirmed after subscribe failure');
  assert.ok(gateway.unconfirmedSubscriptions.has(gameId));

  // Clear the failure so resubscribe can succeed
  broker.clearFailSubscribe(ch);

  // Trigger reconnect
  broker.simulateClose(sub);
  broker.simulateReady(sub);
  await flush();

  assert.equal(gateway.unconfirmedSubscriptionCount(), 0, 'unconfirmed set is empty after reconnect resubscribe succeeds');
  assert.equal(gateway.unconfirmedSubscriptions.has(gameId), false);
});

test('SB16: failed readiness followed by a successful later join on the same game clears the set', async () => {
  const broker = new FakeRedisBroker();
  const store = new InMemoryEventLog();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new FakeTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier);

  const gameId = 'game-sb16';
  await authority.createGame({ gameId, players: { white: 'alice', black: 'bob' }, timeControl: TC, rated: false });

  const ch = gameChannel(gameId);
  broker.failSubscribe(ch, new Error('Redis connection refused'));

  const c1 = new InMemoryConnection('c1');
  gateway.handleConnection(c1);
  c1.deliver({ t: 'join', gameId });
  await flush();

  assert.equal(gateway.unconfirmedSubscriptionCount(), 1, 'game is in unconfirmed set');
  assert.ok(gateway.unconfirmedSubscriptions.has(gameId));

  // Clear failure so future subscribe/ready succeeds
  broker.clearFailSubscribe(ch);

  // Later join on the same game
  const c2 = new InMemoryConnection('c2');
  gateway.handleConnection(c2);
  c2.deliver({ t: 'join', gameId });
  await flush();

  assert.ok(c2.last('joined'), 'c2 joined successfully');
  assert.equal(gateway.unconfirmedSubscriptionCount(), 0, 'unconfirmed set is cleared by successful later join');
  assert.equal(gateway.unconfirmedSubscriptions.has(gameId), false);
});

test('SB17: a pending ready() waiter resolves after close()', async () => {
  const broker = new FakeRedisBroker();
  const pub = broker.createClient('pub');
  const sub = broker.createClient('sub');
  const pubsub = new RedisPubSub(pub, sub, 'node-1');

  const ch = 'game:sb17';
  broker.gateChannel(ch);

  // Subscribe issues pending SUBSCRIBE
  pubsub.subscribe(ch, () => {});

  let waiterResolved = false;
  const waiter = pubsub.ready(ch);
  void waiter.then(() => {
    waiterResolved = true;
  });
  await flush();
  assert.equal(waiterResolved, false, 'waiter is waiting on pending SUBSCRIBE');

  // Close the pubsub while ready() is pending
  await pubsub.close();
  await flush();

  assert.equal(waiterResolved, true, 'pending ready() waiter resolves after close()');
});







