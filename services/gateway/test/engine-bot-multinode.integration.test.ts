/**
 * Real-Redis proof that the engine bot is safe on more than one gateway replica (ADR-0080,
 * ADR-0010). Gated behind REDIS_URL like redis-ownership.integration.test.ts.
 *
 * Two nodes run the production RedisCommandRouter + OwnershipRegistry and each has its own
 * production Redis pub/sub (`createRedisPubSub`, as `serve.ts` wires it), so a broadcast reaches
 * the other node asynchronously through Redis, exactly as between two pods. They share one event
 * log; it is in memory here (Postgres in production), which does not change what is proven: the
 * log is only read on takeover. Each node's GameAuthority is its own cache — a non-owner's copy
 * never sees the owner's moves, which is exactly what the mover must not compute from.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  GameAuthority,
  InMemoryEventLog,
  gameChannel,
  type Broadcast,
  type EventLog,
  type LoggedEvent,
  type PubSub,
  type Unsubscribe,
} from '@chess-platform/realtime-gateway';
import type {
  AnalysisProvider,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { BOT_ACCOUNTS } from '@chess-platform/api';
import { OwnershipRegistry, ownerKey } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { EngineBotMover } from '../src/engine-bot.js';
import { createRedisPubSub } from '../src/redis-pubsub.js';

const REDIS_URL = process.env['REDIS_URL'];
/**
 * A per-test ceiling. The clients below retry forever (as in production), so without it a Redis
 * that disappears mid-run turns into a hang that only the outer CI timeout ends.
 */
const REDIS_TEST_TIMEOUT_MS = 30_000;
const redisTest = (name: string, fn: () => Promise<void>): void => {
  (REDIS_URL ? test : test.skip)(name, { timeout: REDIS_TEST_TIMEOUT_MS }, fn);
};

/**
 * Fail a run promptly and by name when Redis is not there. Test-only: a single probe connection
 * with a short connect timeout and no retries. The clients the tests exercise keep the production
 * settings (retry forever), which is exactly why they cannot be the thing that notices.
 */
async function assertRedisReachable(url: string, connectTimeoutMs = 2_000): Promise<void> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined); // reported through the rejection below
  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    throw new Error(`Redis at ${url} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    probe.disconnect();
  }
}
const BOT = BOT_ACCOUNTS[0]!;
const HUMAN = 'human-1';

// Runs with or without REDIS_URL: nothing listens on port 1.
test('the Redis preflight fails promptly and by name when Redis is unreachable', async () => {
  const started = Date.now();
  await assert.rejects(assertRedisReachable('redis://127.0.0.1:1', 1_000), /Redis at redis:\/\/127\.0\.0\.1:1 is unreachable/);
  assert.ok(Date.now() - started < 5_000, 'no retry loop');
});

/**
 * Engine that answers its scripted moves in order and records every FEN it was asked about.
 * With `hold`, each answer is kept back until `release()`, so a test can act while it "thinks".
 */
class ScriptedEngine implements AnalysisProvider {
  readonly fens: string[] = [];
  private pending: (() => void)[] = [];
  constructor(private readonly moves: readonly string[], private readonly hold = false) {}
  async analyze(): Promise<readonly EngineResult[]> {
    return [];
  }
  capabilitiesFor(): EngineCapabilities | undefined {
    return undefined;
  }
  async play(request: PlayRequest): Promise<PlayResult> {
    const move = this.moves[this.fens.length] ?? 'a7a6';
    this.fens.push(request.fen);
    if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve));
    await new Promise((resolve) => setImmediate(resolve)); // a real engine answers over a pipe
    return { move };
  }
  release(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

/** A node's pub/sub, counting live subscriptions per channel so a test can see a mover let go. */
class CountingPubSub implements PubSub {
  private readonly live = new Map<string, number>();
  constructor(private readonly inner: PubSub) {}
  publish(channel: string, msg: Broadcast): void {
    this.inner.publish(channel, msg);
  }
  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    this.live.set(channel, this.active(channel) + 1);
    const unsubscribe = this.inner.subscribe(channel, handler);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.live.set(channel, this.active(channel) - 1);
      unsubscribe();
    };
  }
  active(channel: string): number {
    return this.live.get(channel) ?? 0;
  }
}

/**
 * An event log whose reads can be made slow: `load` takes its snapshot at once but hands it back
 * only when released — a read that started before the game moved on and finishes after.
 */
class SlowReadLog implements EventLog {
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;
  constructor(private readonly inner: InMemoryEventLog) {}
  holdReads(): void {
    this.gate = new Promise<void>((resolve) => (this.open = resolve));
  }
  releaseReads(): void {
    this.open?.();
    this.gate = undefined;
  }
  append(gameId: string, expectedSeq: number, events: Parameters<EventLog['append']>[2]): Promise<number> {
    return this.inner.append(gameId, expectedSeq, events);
  }
  async load(gameId: string): Promise<readonly LoggedEvent[]> {
    const snapshot = await this.inner.load(gameId);
    if (this.gate) await this.gate;
    return snapshot;
  }
  exists(gameId: string): Promise<boolean> {
    return this.inner.exists(gameId);
  }
}

function makeNode(redis: Redis, store: EventLog, engine: ScriptedEngine, nonOwnerRecheckMs?: number, leaseTtlSec = 30) {
  const nodeId = `node-${randomUUID()}`;
  const redisPubSub = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const pubsub = new CountingPubSub(redisPubSub.pubsub);
  const authority = new GameAuthority(pubsub, () => Date.now(), store);
  const registry = new OwnershipRegistry({ redis, nodeId, leaseTtlSec, renewalIntervalSec: Math.max(1, Math.floor(leaseTtlSec / 2)) });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer, forwardTimeoutMs: 3000 });
  const mover = new EngineBotMover({ authority, router, pubsub, provider: engine, ownership: router, nonOwnerRecheckMs });
  return { nodeId, pubsub, closePubSub: redisPubSub.close, authority, registry, consumer, router, mover, engine };
}
type Node = ReturnType<typeof makeNode>;

interface Cluster {
  readonly a: Node;
  readonly b: Node;
  readonly redis: Redis;
  readonly store: InMemoryEventLog;
}

async function withCluster(engines: [ScriptedEngine, ScriptedEngine], fn: (c: Cluster) => Promise<void>): Promise<void> {
  await assertRedisReachable(REDIS_URL!);
  const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  const store = new InMemoryEventLog();
  const a = makeNode(redis, store, engines[0]);
  const b = makeNode(redis, store, engines[1]);
  try {
    await fn({ a, b, redis, store });
  } finally {
    for (const node of [a, b]) {
      node.engine.release();
      node.mover.stop();
      node.consumer.stop();
      await node.registry.releaseAll();
      await node.closePubSub().catch(() => undefined);
    }
    await redis.quit().catch(() => undefined);
  }
}

async function createBotGame(node: Node, botColor: 'white' | 'black'): Promise<string> {
  const gameId = randomUUID();
  await node.authority.createGame({
    gameId,
    variant: 'standard',
    rated: false,
    timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
    players: botColor === 'white' ? { white: BOT.userId, black: HUMAN } : { white: HUMAN, black: BOT.userId },
  });
  return gameId;
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * How long a negative check watches for something that must not happen. Everything it guards is a
 * local engine answer followed by a local or Redis round trip — tens of milliseconds normally, so
 * this leaves headroom for a throttled CI runner, where a short window could pass for the wrong
 * reason.
 */
const NEGATIVE_WINDOW_MS = 1_500;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, NEGATIVE_WINDOW_MS));

/** Moves as recorded in the shared durable log — the one history every node agrees on. */
async function loggedMoves(store: InMemoryEventLog, gameId: string): Promise<string[]> {
  const moves: string[] = [];
  for (const { event } of await store.load(gameId)) {
    if (event.type === 'MovePlayed') moves.push(event.uci);
  }
  return moves;
}

redisTest('two replicas observe one bot game: only the owner computes, even on duplicate broadcasts', async () => {
  await withCluster([new ScriptedEngine(['e7e5', 'b8c6']), new ScriptedEngine(['c7c5'])], async ({ a, b, store }) => {
    const gameId = await createBotGame(a, 'black');
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' }); // A claims ownership
    // B joins with the bot to move at ply 1. Its copy stays there, so if B computed from it, it
    // would ask the engine on every wake-up.
    await b.authority.ensureLoaded(gameId);
    a.mover.registerGame(gameId);
    b.mover.registerGame(gameId);
    await waitFor('the owner to reply', async () => (await loggedMoves(store, gameId)).length === 2);

    // The human moves through the non-owner, which forwards to A; B hears the result via Redis.
    const seen: Broadcast[] = [];
    const unsub = b.pubsub.subscribe(gameChannel(gameId), (msg) => seen.push(msg));
    await b.router.route(gameId, HUMAN, { kind: 'move', uci: 'g1f3' });
    await waitFor('the owner to reply again', async () => (await loggedMoves(store, gameId)).length === 4);
    await waitFor('B to hear the move broadcast', () => seen.length > 0);
    unsub();

    // Duplicate delivery of an already-handled broadcast wakes both movers once more: B locally,
    // A through Redis.
    b.pubsub.publish(gameChannel(gameId), seen[0]!);
    b.pubsub.publish(gameChannel(gameId), seen[0]!);
    await settle();

    assert.equal(b.engine.fens.length, 0, 'the non-owner never invoked the engine');
    assert.equal(b.authority.getState(gameId).ply, 1, 'the non-owner still holds its stale bot-to-move copy');
    assert.equal(a.engine.fens.length, 2, 'the owner computed once per bot turn, not per broadcast');
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  });
});

redisTest('bot as White at ply 0 in an unowned game: one replica claims ownership and moves', async () => {
  await withCluster([new ScriptedEngine(['e2e4']), new ScriptedEngine(['d2d4'])], async ({ a, b, redis, store }) => {
    const gameId = await createBotGame(a, 'white');
    await b.authority.ensureLoaded(gameId);
    assert.equal(await redis.get(ownerKey(gameId)), null, 'nobody owns the game yet');

    a.mover.registerGame(gameId);
    b.mover.registerGame(gameId);
    await waitFor('the bot to open', async () => (await loggedMoves(store, gameId)).length === 1);
    await settle();

    const owner = await redis.get(ownerKey(gameId));
    const [winner, loser] = owner === a.nodeId ? [a, b] : [b, a];
    assert.ok(owner === a.nodeId || owner === b.nodeId, 'one of the replicas claimed the game');
    assert.equal(winner.engine.fens.length, 1, 'the claiming replica computed the opening move');
    assert.equal(loser.engine.fens.length, 0, 'the other replica did not compute');
    assert.equal((await loggedMoves(store, gameId)).length, 1, 'exactly one opening move was applied');
  });
});

redisTest('owner takeover rehydrates from the event log before the engine is asked', async () => {
  // A owns and plays three plies, then "crashes"; B inherits the game with a ply-0 copy.
  await withCluster([new ScriptedEngine([]), new ScriptedEngine(['b8c6'])], async ({ a, b, redis, store }) => {
    const gameId = await createBotGame(a, 'black');
    await b.authority.ensureLoaded(gameId); // stale at ply 0
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' });
    await a.router.route(gameId, BOT.userId, { kind: 'move', uci: 'e7e5' });
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'g1f3' });
    const current = a.authority.getState(gameId);

    // A crashes: its lease disappears and it stops serving.
    a.consumer.stop();
    await redis.del(ownerKey(gameId));

    b.mover.registerGame(gameId);
    await waitFor('B to move', async () => (await loggedMoves(store, gameId)).length === 4);

    assert.equal(b.engine.fens[0], current.fen, 'B computed from the rehydrated position, not its ply-0 copy');
    assert.equal(await redis.get(ownerKey(gameId)), b.nodeId);
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  });
});

redisTest('ownership lost while the engine thinks: the stale result is never applied', async () => {
  await withCluster([new ScriptedEngine(['g8f6'], true), new ScriptedEngine(['b8c6', 'd7d5'], true)], async ({ a, b, store }) => {
    const gameId = await createBotGame(a, 'black');
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' });
    a.mover.registerGame(gameId);
    await waitFor('A to start thinking', () => a.engine.fens.length === 1);

    // Mid-think, A loses the lease and B takes over, advancing the game: 1...Nc6 2.Nf3.
    await a.registry.release(gameId);
    await b.authority.ensureLoaded(gameId);
    b.mover.registerGame(gameId);
    await waitFor('B to start thinking', () => b.engine.fens.length === 1);
    b.engine.release();
    await waitFor('B to reply', async () => (await loggedMoves(store, gameId)).length === 2);
    await b.router.route(gameId, HUMAN, { kind: 'move', uci: 'g1f3' });
    await waitFor('B to think about ply 3', () => b.engine.fens.length === 2);

    // A's ply-1 answer (…Nf6) arrives while the bot is to move at ply 3, where it is legal: only
    // the post-engine check stands between it and the board.
    a.engine.release();
    await settle();
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'b8c6', 'g1f3'], 'A submitted nothing');
    assert.equal(a.engine.fens.length, 1, 'A, now a non-owner, did not compute again');

    b.engine.release();
    await waitFor('the owner to reply', async () => (await loggedMoves(store, gameId)).length === 4);
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'b8c6', 'g1f3', 'd7d5']);
  });
});

redisTest('ownership lost and regained while the engine thinks: the untouched stale copy is not trusted', async () => {
  // The dangerous shape: A's cached copy never saw B's moves, so after A re-claims the game that
  // copy still matches the FEN A computed from. Only the reload debt recorded on claim says it is
  // stale.
  await withCluster([new ScriptedEngine(['g8f6', 'd7d5'], true), new ScriptedEngine(['b8c6', 'a7a6'], true)], async ({ a, b, redis, store }) => {
    const gameId = await createBotGame(a, 'black');
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' });
    a.mover.registerGame(gameId);
    await waitFor('A to start thinking', () => a.engine.fens.length === 1);
    const computedFor = a.engine.fens[0]!;

    await a.registry.release(gameId);
    await b.authority.ensureLoaded(gameId);
    b.mover.registerGame(gameId);
    await waitFor('B to start thinking', () => b.engine.fens.length === 1);
    b.engine.release();
    await waitFor('B to reply', async () => (await loggedMoves(store, gameId)).length === 2);
    await b.router.route(gameId, HUMAN, { kind: 'move', uci: 'g1f3' });
    await waitFor('B to think about ply 3', () => b.engine.fens.length === 2);

    // B goes away and A takes the game back before its ply-1 answer arrives.
    await b.registry.release(gameId);
    assert.ok((await a.registry.claim(gameId)).owned);
    assert.equal(a.authority.getState(gameId).fen, computedFor, "A's copy is untouched by B's moves");

    a.engine.release();
    await waitFor('A to recompute', () => a.engine.fens.length === 2);
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'b8c6', 'g1f3'], 'the ply-1 answer was dropped');
    assert.notEqual(a.engine.fens[1], computedFor, 'A rehydrated before computing again');

    a.engine.release();
    b.engine.release(); // B's ply-3 answer: B no longer owns the game, so it is dropped too
    await waitFor('the owner to reply', async () => (await loggedMoves(store, gameId)).length === 4);
    await settle();
    assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'b8c6', 'g1f3', 'd7d5']);
    assert.equal(await redis.get(ownerKey(gameId)), a.nodeId);
  });
});

redisTest('a reload begun for an earlier claim does not settle a later claim', async () => {
  // A claims, and its takeover reload reads the log slowly. Meanwhile A loses the game, B plays
  // 1.e4 through it, and A claims again. The old read finishes after that second claim, with a
  // pre-e4 snapshot; it must not settle the reload debt the second claim recorded.
  await withCluster([new ScriptedEngine([]), new ScriptedEngine([])], async ({ a: creator, b, redis, store }) => {
    const slowLog = new SlowReadLog(store);
    const a = makeNode(redis, slowLog, new ScriptedEngine([]));
    try {
      const gameId = await createBotGame(creator, 'black');
      await a.authority.ensureLoaded(gameId);

      slowLog.holdReads();
      const firstClaim = a.router.prepareOwnership(gameId); // reload #1 reads ply 0, then waits
      await waitFor('A to own the game', async () => (await redis.get(ownerKey(gameId))) === a.nodeId);
      await a.registry.release(gameId);
      await b.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' }); // B claims and plays
      await b.registry.release(gameId);

      // Claim #2 records its reload debt; its own reload has not started when the old read lands.
      assert.ok((await a.registry.claim(gameId)).owned, 'A owns the game again');
      slowLog.releaseReads();
      await firstClaim.catch(() => undefined);
      assert.equal(await a.router.prepareOwnership(gameId), true);

      assert.equal(a.authority.getState(gameId).ply, 1, "A's copy includes B's move, not the earlier read");
      assert.equal(a.router.holdsOwnership(gameId), true);
    } finally {
      a.consumer.stop();
      await a.registry.releaseAll();
      await a.closePubSub().catch(() => undefined);
    }
  });
});

redisTest('an owner that dies mid-game is replaced without any further event', async () => {
  // Nothing is broadcast when a dead pod's lease runs out, and nobody else acts in the game: B's
  // own re-check has to notice, claim, rehydrate and move.
  await withCluster([new ScriptedEngine([]), new ScriptedEngine([])], async ({ a, redis, store }) => {
    const b = makeNode(redis, store, new ScriptedEngine(['e7e5']), 100);
    try {
      const gameId = await createBotGame(a, 'black');
      await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' }); // A owns; bot to move
      await b.authority.ensureLoaded(gameId);
      b.mover.registerGame(gameId);
      await settle();
      assert.equal(b.engine.fens.length, 0, 'B does not compute while A owns the game');

      // A dies before moving: its consumer stops and its lease expires.
      a.consumer.stop();
      await redis.del(ownerKey(gameId));

      await waitFor('B to take over and move', async () => (await loggedMoves(store, gameId)).length === 2);
      assert.equal(await redis.get(ownerKey(gameId)), b.nodeId);
      assert.deepEqual(await loggedMoves(store, gameId), ['e2e4', 'e7e5']);
      assert.equal(b.engine.fens.length, 1, 'exactly one computation, from the rehydrated position');
    } finally {
      b.mover.stop();
      b.consumer.stop();
      await b.registry.releaseAll();
      await b.closePubSub().catch(() => undefined);
    }
  });
});

redisTest("a claim after a lease lapsed unnoticed still reloads, though the game never left this node's books", async () => {
  // A renewal that throws (Redis unreachable) keeps the game in the registry's owned set on
  // purpose, while its local lease ages out and the key expires. Here no renewal runs at all, which
  // leaves the same state. Another node then owns and advances the game; when this node claims it
  // again, SET NX creating the key must count as a new claim, or nothing reloads.
  await withCluster([new ScriptedEngine([]), new ScriptedEngine([])], async ({ a: creator, b, redis, store }) => {
    const a = makeNode(redis, store, new ScriptedEngine([]), undefined, 2);
    try {
      const gameId = await createBotGame(creator, 'black');
      await a.authority.ensureLoaded(gameId);
      assert.equal(await a.router.prepareOwnership(gameId), true, 'A owns the game at ply 0');

      await waitFor("A's lease to lapse locally and in Redis", async () =>
        !a.registry.holdsValidLease(gameId) && (await redis.get(ownerKey(gameId))) === null);
      assert.ok(a.registry.ownedGameIds.includes(gameId), 'A still lists the game as owned');

      await b.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' }); // B claims and plays
      await b.registry.release(gameId);

      assert.equal(await a.router.prepareOwnership(gameId), true, 'A claims the game again');
      assert.equal(a.authority.getState(gameId).ply, 1, "A's copy includes B's move");
    } finally {
      a.consumer.stop();
      await a.registry.releaseAll();
      await a.closePubSub().catch(() => undefined);
    }
  });
});

redisTest('a finished game stops bot work on every replica, including the non-owner', async () => {
  await withCluster([new ScriptedEngine(['e7e5']), new ScriptedEngine(['c7c5'])], async ({ a, b, store }) => {
    const gameId = await createBotGame(a, 'black');
    await b.authority.ensureLoaded(gameId);
    await a.router.route(gameId, HUMAN, { kind: 'move', uci: 'e2e4' });
    a.mover.registerGame(gameId);
    b.mover.registerGame(gameId);
    await waitFor('the owner to reply', async () => (await loggedMoves(store, gameId)).length === 2);

    await b.router.route(gameId, HUMAN, { kind: 'resign' }); // forwarded to the owner
    await waitFor('both movers to let go', () =>
      a.pubsub.active(gameChannel(gameId)) === 0 && b.pubsub.active(gameChannel(gameId)) === 0);

    assert.equal(b.authority.getState(gameId).status.over, false, "B's copy never saw the end — the broadcast did");
    assert.equal(a.engine.fens.length, 1);
    assert.equal(b.engine.fens.length, 0);
  });
});
