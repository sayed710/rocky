/**
 * @packageDocumentation
 * Regressions for Bug 40525c29-c864-49eb-b63a-985553d3546a (resync ownership recovery)
 * and Bug 8452095c-1f35-4393-89b1-4ab83f04ea0d (forwarded adjudication notice eviction)
 * on real PostgreSQL + Redis (Issue #124, ADR-0176).
 *
 * Gated behind REDIS_URL and DATABASE_URL; zero-skip in CI.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Game, type TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryConnection,
  RealtimeGateway,
  type TokenVerifier,
} from '@chess-platform/realtime-gateway';
import {
  PgAdjudicationStore,
  PostgresEventStore,
  migrate,
  migrationsDir,
} from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { OwnershipRegistry, ownerKey } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { createRedisPubSub } from '../src/redis-pubsub.js';
import { AdjudicationResync } from '../src/adjudication-resync.js';
import { AdjudicationWorker, routedAdjudicationChange, type AdjudicationChange } from '../src/adjudication-worker.js';

type Pool = TestDatabase['pool'];

const REDIS_URL = process.env['REDIS_URL'];
const DATABASE_URL = process.env['DATABASE_URL'];
const stackTest = (name: string, fn: () => Promise<void>): void => {
  (REDIS_URL && DATABASE_URL ? test : test.skip)(name, { timeout: 120_000 }, fn);
};

const TC: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

class SimpleTokenVerifier implements TokenVerifier {
  verify(token: string): { readonly userId: string } | null {
    return token.startsWith('token-') ? { userId: token.slice('token-'.length) } : null;
  }
}

interface NodeHarness {
  readonly nodeId: string;
  readonly authority: GameAuthority;
  readonly registry: OwnershipRegistry;
  readonly consumer: OwnerCommandConsumer;
  readonly router: RedisCommandRouter;
  readonly gateway: RealtimeGateway;
  readonly resync: AdjudicationResync;
  readonly connect: () => InMemoryConnection;
  readonly join: (conn: InMemoryConnection, gameId: string, user: string) => void;
  readonly close: () => Promise<void>;
}

function createNode(
  redis: Redis,
  store: PostgresEventStore,
  adjudicationStore: PgAdjudicationStore,
  clock: { now: number },
): NodeHarness {
  const nodeId = `node-${randomUUID()}`;
  const redisPubSub = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const pubsub = redisPubSub.pubsub;
  const authority = new GameAuthority(pubsub, () => clock.now, store, {
    adjudication: {
      rulesVersion: 'rocky-adjudication@1',
      clockPolicy: 'observed-release-v1',
      start: (p) => adjudicationStore.startAdjudication(p),
    },
  });
  const registry = new OwnershipRegistry({ redis, nodeId, leaseTtlSec: 30, renewalIntervalSec: 15 });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer, forwardTimeoutMs: 3000 });
  const gateway = new RealtimeGateway(authority, pubsub, new SimpleTokenVerifier(), () => clock.now, router);
  consumer.watchLocalSessions((id) => gateway.hasLocalSessions(id));
  const resync = new AdjudicationResync({ authority, router, watched: gateway });

  const connect = (): InMemoryConnection => {
    const conn = new InMemoryConnection(`${nodeId}-${randomUUID()}`);
    gateway.handleConnection(conn);
    return conn;
  };

  const join = (conn: InMemoryConnection, gameId: string, user: string): void => {
    conn.deliver({ t: 'join', gameId, token: `token-${user}` });
  };

  const close = async (): Promise<void> => {
    await resync.stop();
    consumer.stop();
    registry.stopRenewal();
    await registry.releaseAll();
    await redisPubSub.close().catch(() => undefined);
  };

  return { nodeId, authority, registry, consumer, router, gateway, resync, connect, join, close };
}

async function seedGame(pool: Pool, initialFen?: string): Promise<{ gameId: string; white: string; black: string }> {
  await migrate(pool, migrationsDir());
  const white = randomUUID();
  const black = randomUUID();
  const gameId = randomUUID();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, $2, $3, NOW(), NOW()), ($4, $5, $6, NOW(), NOW())`,
    [white, `white_${suffix}`, `white_${suffix}@example.com`, black, `black_${suffix}`, `black_${suffix}@example.com`],
  );
  const created = Game.create({
    gameId,
    players: { white, black },
    timeControl: TC,
    rated: false,
    at: 1000,
    ...(initialFen ? { initialFen } : {}),
  });
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at) VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, white, black],
  );
  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
    [gameId, JSON.stringify(created.events[0])],
  );
  return { gameId, white, black };
}

async function waitForCondition(desc: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${desc}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

stackTest('resync alone acquires ownership and broadcasts settled and released state for survivor replica with lost notice', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const nodeA = createNode(redis, store, adjudicationStore, clock);
    const nodeB = createNode(redis, store, adjudicationStore, clock);

    try {
      const { gameId, white, black } = await seedGame(pool, FEN_MATE1);

      // Node A claims initial ownership
      const initialClaim = await nodeA.registry.claim(gameId);
      assert.equal(initialClaim.owned, true);

      // White plays move under adjudication through Node A
      assert.equal(await nodeA.authority.ensureLoaded(gameId), true);
      const admitted = await nodeA.router.route(gameId, white, { kind: 'move', uci: 'e7e4' });
      assert.deepEqual(admitted.events.map((e) => e.type), ['AdjudicationStarted']);
      assert.equal(nodeA.authority.getState(gameId).adjudication, 'proving');

      // Bob connects to survivor replica Node B and joins
      const bobConn = nodeB.connect();
      nodeB.join(bobConn, gameId, black);
      await waitForCondition('Bob joined on node B', () => bobConn.sent.some((m) => m.t === 'joined'));

      // Node B has a resident copy that is proving, but does NOT hold the lease
      assert.equal(nodeB.authority.has(gameId), true);
      assert.equal(nodeB.registry.holdsValidLease(gameId), false);
      assert.deepEqual(nodeB.authority.adjudicatingGames(), [gameId]);

      // Worker settles and releases in Postgres; publish no-op simulates accepted-but-lost notice
      const worker = new AdjudicationWorker({
        store: adjudicationStore,
        executorId: randomUUID(),
        sliceBudget: 5_000,
        releaseGraceMs: 0,
        now: () => clock.now,
        publish: async () => {},
      });
      clock.now = 2500;
      const pass = await worker.runPass();
      assert.equal(pass.settled, 1);
      assert.equal(pass.released, 1);

      // Old owner (Node A) dies completely
      await nodeA.close();
      await redis.del(ownerKey(gameId));

      // Prior to resync: Bob has received neither the move nor the release
      assert.equal(bobConn.sent.some((m) => m.t === 'move'), false);

      // Survivor Node B runs AdjudicationResync pass
      // On unpatched code: Node B skipped non-owned game (holdsValidLease was false), leaving Bob starved.
      // On corrected code: Node B routes through Redis router fallback, claims ownership, folds log, and broadcasts!
      const failed = await nodeB.resync.runPass();
      assert.equal(failed, 0);

      // Verify Node B acquired ownership and folded settled/released state
      assert.equal(nodeB.registry.holdsValidLease(gameId), true);
      assert.equal(nodeB.authority.getState(gameId).adjudication, undefined);
      assert.deepEqual(nodeB.authority.adjudicatingGames(), []);

      // Verify Bob received the broadcasted move and state frames
      await waitForCondition('Bob received move broadcast on node B', () => bobConn.sent.some((m) => m.t === 'move'));
      const moveMsg = bobConn.sent.find((m) => m.t === 'move');
      assert.ok(moveMsg !== undefined);
      if (moveMsg && moveMsg.t === 'move') {
        assert.equal(moveMsg.uci, 'e7e4');
      }
      assert.ok(bobConn.sent.some((m) => m.t === 'state'), 'Bob must also receive state broadcast');
    } finally {
      await nodeA.close();
      await nodeB.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('resync recovers pre-admission connected client on survivor replica after remote admission and lost notice', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const nodeA = createNode(redis, store, adjudicationStore, clock);
    const nodeB = createNode(redis, store, adjudicationStore, clock);

    try {
      const { gameId, white, black } = await seedGame(pool, FEN_MATE1);

      // Node A claims initial ownership
      const initialClaim = await nodeA.registry.claim(gameId);
      assert.equal(initialClaim.owned, true);
      assert.equal(await nodeA.authority.ensureLoaded(gameId), true);

      // CRITICAL TIMING: Bob connects to survivor replica Node B and joins BEFORE admission
      const bobConn = nodeB.connect();
      nodeB.join(bobConn, gameId, black);
      await waitForCondition('Bob joined on node B before admission', () => bobConn.sent.some((m) => m.t === 'joined'));

      // Node B has a resident copy at sequence 0 (pre-admission) which is NOT proving
      assert.equal(nodeB.authority.has(gameId), true);
      assert.equal(nodeB.registry.holdsValidLease(gameId), false);
      assert.deepEqual(nodeB.authority.adjudicatingGames(), [], 'Node B authority copy predates admission and is not proving');

      // White plays move under adjudication through owner Node A
      const admitted = await nodeA.router.route(gameId, white, { kind: 'move', uci: 'e7e4' });
      assert.deepEqual(admitted.events.map((e) => e.type), ['AdjudicationStarted']);
      assert.equal(nodeA.authority.getState(gameId).adjudication, 'proving');

      // Verify real proving state delivery over Redis fanout to already-connected Bob on Node B
      await waitForCondition('Bob received proving state on node B', () =>
        bobConn.sent.some((m) => m.t === 'state' && m.state.adjudication === 'proving'),
      );
      // Gateway observed-state hint records the locally watched proving game
      assert.deepEqual(nodeB.gateway.watchedAdjudicatingGames(), [gameId]);
      // Authority cache on Node B still predates admission
      assert.deepEqual(nodeB.authority.adjudicatingGames(), []);

      // Worker settles and releases in Postgres; publish no-op simulates accepted-but-lost notice
      const worker = new AdjudicationWorker({
        store: adjudicationStore,
        executorId: randomUUID(),
        sliceBudget: 5_000,
        releaseGraceMs: 0,
        now: () => clock.now,
        publish: async () => {},
      });
      clock.now = 2500;
      const pass = await worker.runPass();
      assert.equal(pass.settled, 1);
      assert.equal(pass.released, 1);

      // Old owner (Node A) dies completely
      await nodeA.close();
      await redis.del(ownerKey(gameId));

      // Prior to resync: Bob has received neither the move nor the release
      assert.equal(bobConn.sent.some((m) => m.t === 'move'), false);

      // Survivor Node B runs AdjudicationResync pass
      // Without watched hint: nodeB.authority.adjudicatingGames() is empty, so resync scans 0 games and Bob is starved.
      // With watched hint: nodeB.resync detects locally watched proving game, routes through router, claims ownership, and emits broadcasts!
      const failed = await nodeB.resync.runPass();
      assert.equal(failed, 0);

      // Verify Node B acquired ownership and cleared adjudication state
      assert.equal(nodeB.registry.holdsValidLease(gameId), true);
      assert.equal(nodeB.authority.getState(gameId).adjudication, undefined);
      assert.deepEqual(nodeB.authority.adjudicatingGames(), []);
      assert.deepEqual(nodeB.gateway.watchedAdjudicatingGames(), []);

      // Verify Bob received the broadcasted move and final released state frames
      await waitForCondition('Bob received move broadcast on node B', () => bobConn.sent.some((m) => m.t === 'move'));
      const moveMsg = bobConn.sent.find((m) => m.t === 'move');
      assert.ok(moveMsg !== undefined);
      if (moveMsg && moveMsg.t === 'move') {
        assert.equal(moveMsg.uci, 'e7e4');
      }
      const finalStateMsg = bobConn.sent.filter((m) => m.t === 'state').at(-1);
      assert.ok(finalStateMsg !== undefined && finalStateMsg.t === 'state');
      if (finalStateMsg && finalStateMsg.t === 'state') {
        assert.equal(finalStateMsg.state.adjudication, undefined);
        assert.equal(finalStateMsg.state.ply, 1);
      }
    } finally {
      await nodeA.close();
      await nodeB.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('forwarded remote adjudication notice evicts unwatched ended game on owner before reply while preserving watched copy', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 3000 };
    const nodeA = createNode(redis, store, adjudicationStore, clock);
    const nodeB = createNode(redis, store, adjudicationStore, clock);

    try {
      // ── Scenario 1: Unwatched ended game loaded for forwarded adjudication notice must evict before reply ──
      const { gameId } = await seedGame(pool, FEN_MATE1);

      // Node B is the owner in Redis
      const bClaim = await nodeB.registry.claim(gameId);
      assert.equal(bClaim.owned, true);

      // Ensure Node B is genuinely UNLOADED in authority memory and has no local sessions
      assert.equal(nodeB.authority.has(gameId), false);
      assert.equal(nodeB.gateway.hasLocalSessions(gameId), false);

      // Adjudication started for legal mating move e7g7 in FEN_MATE1
      const operationId = randomUUID();
      await adjudicationStore.startAdjudication({
        gameId,
        command: { kind: 'move', uci: 'e7g7' },
        context: {
          operationId,
          color: 'w',
          at: 3000,
          rulesVersion: 'rocky-adjudication@1',
          clockPolicy: 'observed-release-v1',
        },
      });

      // Worker proves and settles the mating move, capturing canonical settlement notice
      const published: AdjudicationChange[] = [];
      const worker = new AdjudicationWorker({
        store: adjudicationStore,
        executorId: randomUUID(),
        sliceBudget: 5_000,
        releaseGraceMs: 0,
        now: () => clock.now,
        publish: async (change) => {
          published.push(change);
        },
      });
      clock.now = 3500;
      const pass = await worker.runPass();
      assert.equal(pass.settled, 1);
      assert.equal(published.length, 1);
      const settlementNotice = published[0]!;

      // Confirm game is genuinely ended in durable PostgreSQL log
      const events = await store.load(gameId);
      assert.ok(events.some((e) => e.event.type === 'GameEnded'), 'Mating move must end game in log');

      // Verify remote owner Node B is STILL unloaded immediately before the notice arrives
      assert.equal(nodeB.authority.has(gameId), false);
      assert.equal(nodeB.registry.holdsValidLease(gameId), true);

      // Node A sends forwarded adjudication notice to remote owner Node B
      const notifyUnwatched = routedAdjudicationChange({
        authority: nodeA.authority,
        router: nodeA.router,
        hasLocalSessions: () => false,
      });

      await notifyUnwatched(settlementNotice);

      // Verify Node B evicted the unwatched ended copy before replying to Node A
      assert.equal(
        nodeB.authority.has(gameId),
        false,
        'Remote owner must evict unwatched ended copy loaded only for forwarded adjudication notice',
      );

      // ── Scenario 2: Watched/preexisting owner copy must NOT be evicted ──
      const { gameId: watchedGameId, black: black2 } = await seedGame(pool, FEN_MATE1);

      // Node B claims ownership
      await nodeB.registry.claim(watchedGameId);

      // Client connects and joins on Node B (making it watched)
      const conn = nodeB.connect();
      nodeB.join(conn, watchedGameId, black2);
      await waitForCondition('Bob joined on node B', () => conn.sent.some((m) => m.t === 'joined'));

      assert.equal(nodeB.authority.has(watchedGameId), true);
      assert.equal(nodeB.gateway.hasLocalSessions(watchedGameId), true);

      // Start and settle move e7g7 in store
      const op2 = randomUUID();
      await adjudicationStore.startAdjudication({
        gameId: watchedGameId,
        command: { kind: 'move', uci: 'e7g7' },
        context: {
          operationId: op2,
          color: 'w',
          at: 3600,
          rulesVersion: 'rocky-adjudication@1',
          clockPolicy: 'observed-release-v1',
        },
      });

      published.length = 0;
      clock.now = 3700;
      await worker.runPass();
      const settlementNotice2 = published.find((p) => p.gameId === watchedGameId);
      assert.ok(settlementNotice2 !== undefined);

      const notifyWatched = routedAdjudicationChange({
        authority: nodeA.authority,
        router: nodeA.router,
        hasLocalSessions: () => false,
      });

      if (settlementNotice2) {
        await notifyWatched(settlementNotice2);
      }

      // Verify Node B preserved the watched resident copy
      assert.equal(
        nodeB.authority.has(watchedGameId),
        true,
        'Remote owner must preserve watched resident copy after forwarded notice',
      );

      conn.close();
    } finally {
      await nodeA.close();
      await nodeB.close();
      await redis.quit().catch(() => undefined);
    }
  });
});
