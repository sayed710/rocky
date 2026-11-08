/**
 * @packageDocumentation
 * Regressions for Bug 08be28ea-7202-4c8b-b610-27780eb3ccec (Issue #124, ADR-0176):
 * Delivery boundary exception isolation across Room.broadcast, PubSub local delivery,
 * and remote Redis fanout.
 *
 * Verifies that a synchronous throwing local recipient (socket or pubsub subscriber)
 * does not abort fanout to healthy same-room clients, other local subscribers, or
 * remote Redis fanout, does not leak sensitive payload sentinels in diagnostics,
 * and does not corrupt authority sequence or block subsequent commands.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdjudicationJobController,
  Game,
  prepareAuthoritativeCommand,
  type AdjudicationStartedEvent,
  type GameEvent,
  type PreparedOperation,
  type TimeControl,
} from '@chess-platform/game';
import type { Broadcast, MoveBroadcast, ServerMessage, TokenVerifier } from '../src/protocol';
import { InMemoryConnection } from '../src/transport';
import {
  ADJUDICATION_ACTOR,
  GameAuthority,
  InMemoryEventLog,
  InMemoryPubSub,
  RealtimeGateway,
  RedisPubSub,
  gameChannel,
  type AdjudicationAdmission,
  type EventLog,
  type RedisLike,
} from '../src/index';

const TC: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };

class FakeRedisBus {
  private readonly subscribers = new Map<string, Set<(channel: string, message: string) => void>>();

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

class FakeRedisClient implements RedisLike {
  private messageListeners: ((channel: string, message: string) => void)[] = [];
  private lifecycleListeners = new Map<'close' | 'ready', Set<() => void>>();
  readonly published: Array<{ readonly channel: string; readonly message: string }> = [];

  constructor(private readonly bus: FakeRedisBus) {}

  publish(channel: string, message: string): number {
    this.published.push({ channel, message });
    this.bus.publish(channel, message);
    return 1;
  }

  subscribe(channel: string): void {
    this.bus.subscribe(channel, (ch, msg) => {
      for (const listener of [...this.messageListeners]) listener(ch, msg);
    });
  }

  unsubscribe(channel: string): void {
    void channel;
  }

  on(event: 'message', listener: (channel: string, message: string) => void): void;
  on(event: 'close' | 'ready', listener: () => void): void;
  on(event: 'message' | 'close' | 'ready', listener: ((channel: string, message: string) => void) | (() => void)): void {
    if (event === 'message') {
      this.messageListeners.push(listener as (channel: string, message: string) => void);
    } else {
      let set = this.lifecycleListeners.get(event);
      if (!set) {
        set = new Set();
        this.lifecycleListeners.set(event, set);
      }
      set.add(listener as () => void);
    }
  }

  off(event: 'message', listener: (channel: string, message: string) => void): void;
  off(event: 'close' | 'ready', listener: () => void): void;
  off(event: 'message' | 'close' | 'ready', listener: ((channel: string, message: string) => void) | (() => void)): void {
    if (event === 'message') {
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    } else {
      this.lifecycleListeners.get(event)?.delete(listener as () => void);
    }
  }

  quit(): void {}
}

class StaticTokenVerifier implements TokenVerifier {
  verify(token: string): { readonly userId: string } | null {
    return token.startsWith('token:') ? { userId: token.slice('token:'.length) } : null;
  }
}

class FailingConnection extends InMemoryConnection {
  public armed = false;

  constructor(id: string) {
    super(id);
  }

  override send(msg: ServerMessage): void {
    if (this.armed && (msg.t === 'move' || msg.t === 'state' || msg.t === 'ended')) {
      throw new Error('Simulated synchronous socket transmission failure');
    }
    super.send(msg);
  }
}

async function waitForMessage<T extends ServerMessage['t']>(
  conn: InMemoryConnection,
  type: T,
  timeoutMs = 5000,
): Promise<Extract<ServerMessage, { t: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const msg = conn.last(type);
    if (msg) return msg;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`Timed out waiting for message of type ${type}`);
}

function makeMoveBroadcast(gameId: string): MoveBroadcast {
  return {
    stateRevision: 1,
    t: 'move',
    gameId,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'hash-sec-test',
    clock: { w: 180_000, b: 180_000 },
    serverTs: 1000,
    legalMoves: {},
  };
}

test('synchronous failing local socket in room does not suppress healthy same-room client or remote Redis fanout', async () => {
  const bus = new FakeRedisBus();
  const localPub = new FakeRedisClient(bus);
  const localSub = new FakeRedisClient(bus);
  const remotePub = new FakeRedisClient(bus);
  const remoteSub = new FakeRedisClient(bus);

  const localPubSub = new RedisPubSub(localPub, localSub, 'local-node');
  const remotePubSub = new RedisPubSub(remotePub, remoteSub, 'remote-node');

  const remoteBroadcasts: Broadcast[] = [];
  const unsubRemote = remotePubSub.subscribe(gameChannel('game-1'), (msg) => {
    remoteBroadcasts.push(msg);
  });
  await remotePubSub.ready(gameChannel('game-1'));

  const eventLog = new InMemoryEventLog();
  const authority = new GameAuthority(localPubSub, () => 1000, eventLog);
  const verifier = new StaticTokenVerifier();
  const gateway = new RealtimeGateway(authority, localPubSub, verifier, () => 1000);

  const whiteId = 'user-white';
  const blackId = 'user-black';

  await authority.createGame({
    gameId: 'game-1',
    players: { white: whiteId, black: blackId },
    timeControl: TC,
    rated: false,
    at: 1000,
  });

  // Client 1: Alice (white player)
  const aliceConn = new InMemoryConnection('conn-alice');
  gateway.handleConnection(aliceConn);
  aliceConn.deliver({ t: 'join', gameId: 'game-1', token: `token:${whiteId}` });
  await waitForMessage(aliceConn, 'joined');

  // Client 2: Bob (black player) - failing socket after arming
  const bobConn = new FailingConnection('conn-bob');
  gateway.handleConnection(bobConn);
  bobConn.deliver({ t: 'join', gameId: 'game-1', token: `token:${blackId}` });
  await waitForMessage(bobConn, 'joined');

  // Client 3: Charlie (healthy spectator in same room)
  const charlieConn = new InMemoryConnection('conn-charlie');
  gateway.handleConnection(charlieConn);
  charlieConn.deliver({ t: 'join', gameId: 'game-1', token: undefined });
  await waitForMessage(charlieConn, 'joined');

  // Local independent subscribers: one failing, one healthy
  let localFailingSubscriberCount = 0;
  const healthyLocalSubscriberBroadcasts: Broadcast[] = [];
  const unsubFailing = localPubSub.subscribe(gameChannel('game-1'), () => {
    localFailingSubscriberCount++;
    throw new Error('Simulated synchronous local pubsub subscriber failure');
  });
  const unsubHealthy = localPubSub.subscribe(gameChannel('game-1'), (msg) => {
    healthyLocalSubscriberBroadcasts.push(msg);
  });

  // Arm the failing socket only AFTER join handshake is completely established
  bobConn.armed = true;

  try {
    // Exercise real public authority.apply after actual joins and assert.doesNotReject
    await assert.doesNotReject(async () => {
      await authority.apply('game-1', whiteId, { kind: 'move', uci: 'e2e4' });
    });

    // 1. Explicit immediate assertion: failing subscriber executed
    assert.equal(localFailingSubscriberCount, 1, 'Failing subscriber must have executed');

    // 2. Explicit immediate assertion: Charlie (healthy spectator in same room) received the move
    const charlieMove = charlieConn.last('move');
    assert.ok(charlieMove !== undefined, 'Healthy spectator in room must receive move broadcast');
    assert.equal(charlieMove?.uci, 'e2e4');
    assert.equal(charlieMove?.ply, 1);

    // 3. Explicit immediate assertion: healthy local pubsub subscriber received the move
    const healthySubMove = healthyLocalSubscriberBroadcasts.find((m) => m.t === 'move');
    assert.ok(healthySubMove !== undefined, 'Healthy local pubsub subscriber must receive move broadcast');

    // 4. Explicit immediate assertion: remote Redis fanout was NOT aborted by local failures
    assert.ok(localPub.published.length > 0, 'RedisLike publish must be called for remote fanout');
    const remoteMove = remoteBroadcasts.find((m) => m.t === 'move');
    assert.ok(remoteMove !== undefined, 'Remote node must receive move broadcast via Redis fanout');
    if (remoteMove && remoteMove.t === 'move') {
      assert.equal(remoteMove.uci, 'e2e4');
    }

    // 5. Subsequent command remains safe and functional
    await assert.doesNotReject(async () => {
      const nextResult = await authority.apply('game-1', blackId, { kind: 'move', uci: 'e7e5' });
      assert.equal(nextResult.events[0]?.type, 'MovePlayed');
    });
    assert.equal(authority.getState('game-1').ply, 2);
  } finally {
    unsubRemote();
    unsubFailing();
    unsubHealthy();
    aliceConn.close();
    bobConn.close();
    charlieConn.close();
    await localPubSub.close();
    await remotePubSub.close();
  }
});

test('adjudication absorbDurable delivery with failing local recipient preserves healthy clients and subsequent commands', async () => {
  const bus = new FakeRedisBus();
  const localPub = new FakeRedisClient(bus);
  const localSub = new FakeRedisClient(bus);
  const remotePub = new FakeRedisClient(bus);
  const remoteSub = new FakeRedisClient(bus);

  const localPubSub = new RedisPubSub(localPub, localSub, 'node-1');
  const remotePubSub = new RedisPubSub(remotePub, remoteSub, 'node-2');

  const remoteBroadcasts: Broadcast[] = [];
  const unsubRemote = remotePubSub.subscribe(gameChannel('game-2'), (msg) => {
    remoteBroadcasts.push(msg);
  });
  await remotePubSub.ready(gameChannel('game-2'));

  const eventLog = new InMemoryEventLog();
  const authority = new GameAuthority(localPubSub, () => 2000, eventLog);
  const verifier = new StaticTokenVerifier();
  const gateway = new RealtimeGateway(authority, localPubSub, verifier, () => 2000);

  const whiteId = 'user-white';
  const blackId = 'user-black';

  await authority.createGame({
    gameId: 'game-2',
    players: { white: whiteId, black: blackId },
    timeControl: TC,
    rated: false,
    at: 2000,
  });

  const aliceConn = new InMemoryConnection('conn-alice');
  gateway.handleConnection(aliceConn);
  aliceConn.deliver({ t: 'join', gameId: 'game-2', token: `token:${whiteId}` });
  await waitForMessage(aliceConn, 'joined');

  // Failing local socket in room
  const failingConn = new FailingConnection('conn-failing');
  gateway.handleConnection(failingConn);
  failingConn.deliver({ t: 'join', gameId: 'game-2', token: undefined });
  await waitForMessage(failingConn, 'joined');

  // Healthy local spectator
  const healthyConn = new InMemoryConnection('conn-healthy');
  gateway.handleConnection(healthyConn);
  healthyConn.deliver({ t: 'join', gameId: 'game-2', token: undefined });
  await waitForMessage(healthyConn, 'joined');

  // Arm failing socket after join completion
  failingConn.armed = true;

  // Local independent subscriber to verify local pubsub delivery under absorbDurable
  const healthyLocalBroadcasts: Broadcast[] = [];
  const unsubHealthyLocal = localPubSub.subscribe(gameChannel('game-2'), (msg) => {
    healthyLocalBroadcasts.push(msg);
  });

  // Use real Game domain to produce canonical MovePlayed event with valid clock accounting and head
  const initialLogged = await eventLog.load('game-2');
  const baseGame = Game.fromEvents(initialLogged.map((e) => e.event));
  const moveResult = baseGame.playMove('e2e4', 2100);
  assert.equal(moveResult.events.length, 1);
  assert.equal(moveResult.events[0]?.type, 'MovePlayed');

  // Append canonical events directly to the store
  await eventLog.append('game-2', 0, moveResult.events);

  try {
    // absorbDurable is invoked via ADJUDICATION_ACTOR - exercise public authority.apply with assert.doesNotReject
    await assert.doesNotReject(async () => {
      const result = await authority.apply('game-2', ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'MovePlayed');
    });

    // Explicit immediate assertion: Healthy connection received the broadcast from absorbDurable
    const moveMsg = healthyConn.last('move');
    assert.ok(moveMsg !== undefined, 'Healthy spectator in room must receive move broadcast from absorbDurable');
    assert.equal(moveMsg?.uci, 'e2e4');
    assert.equal(moveMsg?.ply, 1);

    // Explicit immediate assertion: Healthy local pubsub subscriber received the broadcast
    const localMove = healthyLocalBroadcasts.find((m) => m.t === 'move');
    assert.ok(localMove !== undefined, 'Healthy local subscriber must receive move broadcast');

    // Explicit immediate assertion: Remote Redis fanout received the broadcast
    const remoteMove = remoteBroadcasts.find((m) => m.t === 'move');
    assert.ok(remoteMove !== undefined, 'Remote node must receive move broadcast via Redis fanout');
    if (remoteMove && remoteMove.t === 'move') {
      assert.equal(remoteMove.uci, 'e2e4');
    }

    // Authority state view is properly updated
    const updatedState = authority.getState('game-2');
    assert.equal(updatedState.ply, 1);

    // Later commands still safe
    await assert.doesNotReject(async () => {
      const nextResult = await authority.apply('game-2', blackId, { kind: 'move', uci: 'e7e5' });
      assert.equal(nextResult.events[0]?.type, 'MovePlayed');
    });
    assert.equal(authority.getState('game-2').ply, 2);
  } finally {
    unsubRemote();
    unsubHealthyLocal();
    aliceConn.close();
    failingConn.close();
    healthyConn.close();
    await localPubSub.close();
    await remotePubSub.close();
  }
});

test('throwing subscriber in InMemoryPubSub and RedisPubSub redacts raw Error, message, and payload sentinel across all console.error arguments', async () => {
  const sentinel = 'SYNTHETIC_SECURITY_SENTINEL_FEN_7k/4Q3/6K1/8/8/8/8/8';

  const bus = new FakeRedisBus();
  const localPub = new FakeRedisClient(bus);
  const localSub = new FakeRedisClient(bus);
  const remotePub = new FakeRedisClient(bus);
  const remoteSub = new FakeRedisClient(bus);

  const redisLocal = new RedisPubSub(localPub, localSub, 'sec-local');
  const redisRemote = new RedisPubSub(remotePub, remoteSub, 'sec-remote');

  const loggedErrors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    // 1. InMemoryPubSub throwing subscriber isolation and redaction
    const inMemoryPubSub = new InMemoryPubSub();
    let inMemoryHealthyDelivered = 0;
    inMemoryPubSub.subscribe(gameChannel('sec-game-1'), () => {
      throw new Error(sentinel);
    });
    inMemoryPubSub.subscribe(gameChannel('sec-game-1'), () => {
      inMemoryHealthyDelivered++;
    });

    const msg1 = makeMoveBroadcast('sec-game-1');
    inMemoryPubSub.publish(gameChannel('sec-game-1'), msg1);

    assert.equal(inMemoryHealthyDelivered, 1, 'Healthy InMemory subscriber must receive broadcast despite throwing peer');
    assert.ok(loggedErrors.length >= 1, 'console.error must be called on throwing subscriber');

    let allArgs = loggedErrors.flat().map((arg) => String(arg));
    assert.ok(allArgs.some((arg) => arg.includes('[InMemoryPubSub]')), 'Must include [InMemoryPubSub] tag');
    assert.ok(allArgs.some((arg) => arg.includes('sec-game-1')), 'Must include gameId');
    assert.ok(allArgs.every((arg) => !arg.includes(sentinel)), 'Must NOT leak sentinel across any argument');

    loggedErrors.length = 0;

    // 2. RedisPubSub local throwing subscriber isolation, redaction, and remote fanout preservation
    let redisLocalHealthyDelivered = 0;
    let redisRemoteDelivered = 0;

    redisLocal.subscribe(gameChannel('sec-game-2'), () => {
      throw new Error(sentinel);
    });
    redisLocal.subscribe(gameChannel('sec-game-2'), () => {
      redisLocalHealthyDelivered++;
    });
    redisRemote.subscribe(gameChannel('sec-game-2'), () => {
      redisRemoteDelivered++;
    });
    await redisRemote.ready(gameChannel('sec-game-2'));

    const msg2 = makeMoveBroadcast('sec-game-2');
    redisLocal.publish(gameChannel('sec-game-2'), msg2);

    assert.equal(redisLocalHealthyDelivered, 1, 'Healthy local subscriber must receive broadcast');
    assert.equal(redisRemoteDelivered, 1, 'Remote subscriber must receive broadcast via Redis fanout');
    assert.ok(loggedErrors.length >= 1, 'console.error must be called on throwing local subscriber');

    allArgs = loggedErrors.flat().map((arg) => String(arg));
    assert.ok(allArgs.some((arg) => arg.includes('[RedisPubSub]')), 'Must include [RedisPubSub] tag');
    assert.ok(allArgs.some((arg) => arg.includes('sec-game-2')), 'Must include gameId');
    assert.ok(allArgs.every((arg) => !arg.includes(sentinel)), 'Must NOT leak sentinel across any argument');

    loggedErrors.length = 0;

    // 3. RedisPubSub remote message listener throwing subscriber isolation and redaction
    let remoteHealthyDelivered = 0;
    redisRemote.subscribe(gameChannel('sec-game-3'), () => {
      throw new Error(sentinel);
    });
    redisRemote.subscribe(gameChannel('sec-game-3'), () => {
      remoteHealthyDelivered++;
    });
    await redisRemote.ready(gameChannel('sec-game-3'));

    const msg3 = makeMoveBroadcast('sec-game-3');
    redisLocal.publish(gameChannel('sec-game-3'), msg3);

    assert.equal(remoteHealthyDelivered, 1, 'Healthy remote subscriber must receive broadcast');
    assert.ok(loggedErrors.length >= 1, 'console.error must be called on throwing remote subscriber');

    allArgs = loggedErrors.flat().map((arg) => String(arg));
    assert.ok(allArgs.some((arg) => arg.includes('[RedisPubSub]')), 'Must include [RedisPubSub] tag');
    assert.ok(allArgs.some((arg) => arg.includes('sec-game-3')), 'Must include gameId');
    assert.ok(allArgs.every((arg) => !arg.includes(sentinel)), 'Must NOT leak sentinel across any argument');
  } finally {
    console.error = origError;
    await redisLocal.close();
    await redisRemote.close();
  }
});

const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

function startedFor(op: PreparedOperation): AdjudicationStartedEvent {
  return {
    type: 'AdjudicationStarted',
    gameId: op.gameId,
    operationId: op.operationId,
    baseRevision: op.baseRevision,
    at: op.at,
    rulesVersion: op.rulesVersion,
    prepared: op,
    ...(op.clockPolicy ? { clockPolicy: op.clockPolicy } : {}),
  };
}

class FakeAdmission implements AdjudicationAdmission {
  readonly rulesVersion = 'rocky-adjudication@1';
  readonly clockPolicy = 'observed-release-v1' as const;
  constructor(private readonly log: EventLog) {}
  async start(params: Parameters<AdjudicationAdmission['start']>[0]): Promise<{ status: 'started' | 'noop' }> {
    const logged = await this.log.load(params.gameId);
    const game = Game.fromEvents(logged.map((e) => e.event));
    let op: PreparedOperation;
    if ('prepared' in params) {
      op = params.prepared;
    } else {
      const adm = prepareAuthoritativeCommand(game, params.command, params.context);
      if (adm.kind === 'noop') return { status: 'noop' };
      op = adm.operation;
    }
    await this.log.append(params.gameId, logged.length - 1, [startedFor(op)]);
    return { status: 'started' };
  }
}

async function settleAndRelease(log: EventLog, gameId: string, at: number, releaseAt: number): Promise<void> {
  const logged = await log.load(gameId);
  const game = Game.fromEvents(logged.map((e) => e.event));
  const pending = game.adjudication;
  if (!pending) throw new Error('No pending adjudication to settle');
  const ctrl = new AdjudicationJobController();
  ctrl.createJob(pending.prepared, game);
  while (ctrl.getJob(pending.operationId)!.status === 'active') {
    ctrl.stepJob(pending.operationId, 1000);
  }
  const settled = ctrl.settleJob(game, pending.operationId, at);
  await log.append(gameId, logged.length - 1, settled.batch);
  const released = settled.game.prepareClockRelease({ releaseRequestId: `stop:${pending.operationId}`, at: releaseAt });
  await log.append(gameId, logged.length - 1 + settled.batch.length, [released.event]);
}

test('authority takeover reload consumes durable suffix and delivers missed broadcasts and state to watched room client, followed by idempotent adjudicationChanged and reload repeat', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const admission = new FakeAdmission(store);
  const authority = new GameAuthority(pubsub, () => 1000, store, { adjudication: admission });
  const verifier = new StaticTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier, () => 1000);

  const gameId = 'reload-suffix-delivery-1';
  const whiteId = 'user-white';
  const blackId = 'user-black';

  await authority.createGame({
    gameId,
    players: { white: whiteId, black: blackId },
    timeControl: TC,
    rated: false,
    initialFen: FEN_MATE1,
    at: 1000,
  });

  // Client connects and joins the room at sequence 0
  const bobConn = new InMemoryConnection('conn-bob');
  gateway.handleConnection(bobConn);
  bobConn.deliver({ t: 'join', gameId, token: `token:${blackId}` });
  await waitForMessage(bobConn, 'joined');

  assert.equal(authority.getState(gameId).stateRevision, 0);
  assert.equal(bobConn.sent.some((m) => m.t === 'move'), false);

  // White plays move under adjudication; authority becomes proving
  const admitRes = await authority.apply(gameId, whiteId, { kind: 'move', uci: 'e7e4' });
  assert.equal(admitRes.events[0]?.type, 'AdjudicationStarted');
  assert.equal(authority.getState(gameId).adjudication, 'proving');

  // External worker settles and releases the move directly in the durable log
  await settleAndRelease(store, gameId, 1100, 1200);

  try {
    // 1. Takeover reload consumes suffix from the durable log
    const reloaded = await authority.reloadFromLog(gameId);
    assert.equal(reloaded, true);

    // Authority state is updated: no longer adjudicating
    assert.equal(authority.getState(gameId).adjudication, undefined);
    assert.equal(authority.getState(gameId).ply, 1);

    // Watched client Bob receives the missed move broadcast and the updated state
    const moveMsg = bobConn.last('move');
    assert.ok(moveMsg !== undefined, 'Bob must receive missed move broadcast upon takeover reload');
    assert.equal(moveMsg?.uci, 'e7e4');
    assert.equal(moveMsg?.ply, 1);

    const stateMsg = bobConn.last('state');
    assert.ok(stateMsg !== undefined, 'Bob must receive updated state upon takeover reload');
    assert.equal(stateMsg?.state.ply, 1);

    const initialMoveCount = bobConn.sent.filter((m) => m.t === 'move').length;
    assert.equal(initialMoveCount, 1, 'Exactly one move broadcast must be received');

    // 2. Subsequent adjudicationChanged sees empty suffix (already consumed by reload)
    await assert.doesNotReject(async () => {
      const applyResult = await authority.apply(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      assert.equal(applyResult.events.length, 0, 'No new durable events absorbed');
      assert.equal(applyResult.broadcasts.length, 0, 'No duplicate broadcasts produced');
    });

    // Bob still has exactly 1 move broadcast (no duplicate emitted by adjudicationChanged)
    assert.equal(
      bobConn.sent.filter((m) => m.t === 'move').length,
      1,
      'No duplicate move broadcast on empty-suffix adjudicationChanged',
    );

    // 3. Idempotent repeat: a second reload on unchanged head does NOT duplicate broadcasts
    const secondReload = await authority.reloadFromLog(gameId);
    assert.equal(secondReload, true);
    assert.equal(
      bobConn.sent.filter((m) => m.t === 'move').length,
      1,
      'No duplicate move broadcast on second idempotent reload',
    );
  } finally {
    bobConn.close();
  }
});

test('authority takeover reload for prior-normal resident delivers missed broadcasts and state when durable suffix contains adjudication transition', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const verifier = new StaticTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier, () => 1000);

  const gameId = 'reload-prior-normal-adjudication-1';
  const whiteId = 'user-white';
  const blackId = 'user-black';

  await authority.createGame({
    gameId,
    players: { white: whiteId, black: blackId },
    timeControl: TC,
    rated: false,
    initialFen: FEN_MATE1,
    at: 1000,
  });

  // Client connects and joins the room at sequence 0
  const bobConn = new InMemoryConnection('conn-bob');
  gateway.handleConnection(bobConn);
  bobConn.deliver({ t: 'join', gameId, token: `token:${blackId}` });
  await waitForMessage(bobConn, 'joined');

  // Authority cache is resident and NORMAL (not proving, not stopped)
  assert.equal(authority.getState(gameId).stateRevision, 0);
  assert.equal(authority.getState(gameId).adjudication, undefined);
  assert.equal(bobConn.sent.some((m) => m.t === 'move'), false);

  // External writer commits an entire adjudication workflow directly to store:
  // 1) AdjudicationStarted for move e7e4
  const initialLogged = await store.load(gameId);
  const baseGame = Game.fromEvents(initialLogged.map((e) => e.event));
  const adm = prepareAuthoritativeCommand(baseGame, { kind: 'move', uci: 'e7e4' }, {
    color: 'w',
    at: 1100,
    rulesVersion: 'rocky-adjudication@1',
    clockPolicy: 'observed-release-v1',
    operationId: 'op-ext-1',
  });
  assert.equal(adm.kind, 'prepared');
  await store.append(gameId, 0, [startedFor(adm.operation)]);

  // 2) Settle and release the move directly in the durable store
  await settleAndRelease(store, gameId, 1200, 1300);

  try {
    // Takeover reload: prior resident was NORMAL, but newly validated suffix contains adjudication workflow
    const reloaded = await authority.reloadFromLog(gameId);
    assert.equal(reloaded, true);

    // Authority state is updated: no longer adjudicating, ply advanced
    assert.equal(authority.getState(gameId).adjudication, undefined);
    assert.equal(authority.getState(gameId).ply, 1);

    // Watched client Bob receives the missed move broadcast and the updated state
    const moveMsg = bobConn.last('move');
    assert.ok(moveMsg !== undefined, 'Bob must receive missed move broadcast upon takeover reload');
    assert.equal(moveMsg?.uci, 'e7e4');
    assert.equal(moveMsg?.ply, 1);

    const stateMsg = bobConn.last('state');
    assert.ok(stateMsg !== undefined, 'Bob must receive updated state upon takeover reload');
    assert.equal(stateMsg?.state.ply, 1);

    const initialMoveCount = bobConn.sent.filter((m) => m.t === 'move').length;
    assert.equal(initialMoveCount, 1, 'Exactly one move broadcast must be received');

    // Subsequent adjudicationChanged sees empty suffix and emits 0 duplicate broadcasts
    await assert.doesNotReject(async () => {
      const applyResult = await authority.apply(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });
      assert.equal(applyResult.events.length, 0);
      assert.equal(applyResult.broadcasts.length, 0);
    });
    assert.equal(bobConn.sent.filter((m) => m.t === 'move').length, 1);

    // Idempotent repeat: a second reload on unchanged head does NOT duplicate broadcasts
    const secondReload = await authority.reloadFromLog(gameId);
    assert.equal(secondReload, true);
    assert.equal(bobConn.sent.filter((m) => m.t === 'move').length, 1);
  } finally {
    bobConn.close();
  }
});

test('ordinary game reload without adjudication does NOT publish broadcasts to room channel', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const gameId = 'ordinary-reload-no-broadcast-1';

  await authority.createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
    at: 1000,
  });

  const publishedBroadcasts: Broadcast[] = [];
  const unsub = pubsub.subscribe(gameChannel(gameId), (msg) => {
    publishedBroadcasts.push(msg);
  });

  // External node appends move directly to store (e.g., losing append sequence race)
  const initialLogged = await store.load(gameId);
  const baseGame = Game.fromEvents(initialLogged.map((e) => e.event));
  const moveResult = baseGame.playMove('e2e4', 1100);
  await store.append(gameId, 0, moveResult.events);

  try {
    // Authority reloads: since prior copy was NOT adjudicating, zero broadcasts are published
    const reloaded = await authority.reloadFromLog(gameId);
    assert.equal(reloaded, true);
    assert.equal(authority.getState(gameId).ply, 1);
    assert.equal(publishedBroadcasts.length, 0, 'Ordinary reload must not publish broadcasts to room channel');
  } finally {
    unsub();
  }
});

test('authority reloadFromLog honors eviction lifecycle race and aborts publication if slot is disposed during load', async () => {
  const innerStore = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();

  let enteredLoad!: () => void;
  let releaseLoad!: () => void;
  const loadEntered = new Promise<void>((r) => { enteredLoad = r; });
  const loadGate = new Promise<void>((r) => { releaseLoad = r; });

  let pauseLoad = false;
  const interceptingStore: EventLog = {
    load: async (gameId: string, signal?: AbortSignal) => {
      if (pauseLoad) {
        enteredLoad();
        await loadGate;
      }
      return innerStore.load(gameId, signal);
    },
    append: (gameId, expectedSeq, events, signal) => innerStore.append(gameId, expectedSeq, events, signal),
    exists: (gameId, signal) => innerStore.exists(gameId, signal),
    head: (gameId, signal) => innerStore.head(gameId, signal),
  };

  const authority = new GameAuthority(pubsub, () => 1000, interceptingStore);
  const gameId = 'race-evict-reload-1';

  await authority.createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
    at: 1000,
  });

  // Track any publications to the game channel
  const publishedBroadcasts: Broadcast[] = [];
  const unsub = pubsub.subscribe(gameChannel(gameId), (msg) => {
    publishedBroadcasts.push(msg);
  });

  // Append move directly to inner store so log head is advanced
  const initialLogged = await innerStore.load(gameId);
  const baseGame = Game.fromEvents(initialLogged.map((e) => e.event));
  const moveResult = baseGame.playMove('e2e4', 1100);
  await innerStore.append(gameId, 0, moveResult.events);

  try {
    // Start reload with paused load
    pauseLoad = true;
    const reloadP = authority.reloadFromLog(gameId);
    await loadEntered;

    // While load is paused in I/O, evict the game
    authority.evict(gameId);

    // Resume load
    releaseLoad();
    const result = await reloadP;

    // Reload must acknowledge invalidation (returns false)
    assert.equal(result, false, 'Reload must return false when slot is evicted during load');

    // Crucial lifecycle race protection: ZERO broadcasts published for evicted slot
    assert.equal(
      publishedBroadcasts.length,
      0,
      'No broadcasts may be published to pubsub when slot is evicted during reload',
    );
  } finally {
    unsub();
  }
});

test('evicted game slot is cleanly revived upon subsequent ensureLoaded or reload', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1000, store);
  const gameId = 'evict-revive-lifecycle-1';

  await authority.createGame({
    gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
    at: 1000,
  });

  assert.equal(authority.has(gameId), true);

  // Evict game from hot cache
  authority.evict(gameId);

  // Subsequent ensureLoaded must revive slot (revive = true clears slot.dispose)
  const revived = await authority.ensureLoaded(gameId);
  assert.equal(revived, true, 'ensureLoaded must revive evicted slot from durable log');
  assert.equal(authority.has(gameId), true, 'authority must now have fresh resident copy');

  // Commands can be executed on revived slot
  await assert.doesNotReject(async () => {
    const moveRes = await authority.apply(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
    assert.equal(moveRes.events[0]?.type, 'MovePlayed');
  });
  assert.equal(authority.getState(gameId).ply, 1);
});

test('gateway localGameIds accurately tracks rooms and clears upon disconnect', async () => {
  const pubsub = new InMemoryPubSub();
  const eventLog = new InMemoryEventLog();
  const authority = new GameAuthority(pubsub, () => 1000, eventLog);
  const verifier = new StaticTokenVerifier();
  const gateway = new RealtimeGateway(authority, pubsub, verifier, () => 1000);

  const whiteId = 'user-white';
  const blackId = 'user-black';

  await authority.createGame({
    gameId: 'game-local-1',
    players: { white: whiteId, black: blackId },
    timeControl: TC,
    rated: false,
    at: 1000,
  });

  assert.equal(gateway.localGameIds().size, 0);

  const conn1 = new InMemoryConnection('conn-1');
  gateway.handleConnection(conn1);
  conn1.deliver({ t: 'join', gameId: 'game-local-1', token: `token:${whiteId}` });
  await waitForMessage(conn1, 'joined');

  // Active room is present in localGameIds
  assert.equal(gateway.localGameIds().has('game-local-1'), true);
  assert.equal(gateway.localGameIds().size, 1);

  // Disconnect removes game from localGameIds
  conn1.close();
  assert.equal(gateway.localGameIds().has('game-local-1'), false);
  assert.equal(gateway.localGameIds().size, 0);
});
