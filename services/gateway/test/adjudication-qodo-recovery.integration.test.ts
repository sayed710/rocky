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
  ADJUDICATION_ACTOR,
  AuthorityError,
  GameAuthority,
  InMemoryConnection,
  InMemoryEventLog,
  InMemoryPubSub,
  RealtimeGateway,
  type ApplyResult,
  type CommandRouter,
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

stackTest('resync recovers silently admitted game after owner death and lost worker notice', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const nodeA = createNode(redis, store, adjudicationStore, clock);
    const nodeB = createNode(redis, store, adjudicationStore, clock);

    try {
      const { gameId, black } = await seedGame(pool, FEN_MATE1);

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
      assert.equal(nodeB.gateway.hasLocalSessions(gameId), true);
      assert.equal(nodeB.gateway.localGameIds().has(gameId), true);

      // White's move is admitted directly to store (simulating Owner A committing AdjudicationStarted
      // to PostgreSQL but dying before publishing proving state to Redis)
      const operationId = randomUUID();
      await adjudicationStore.startAdjudication({
        gameId,
        command: { kind: 'move', uci: 'e7e4' },
        context: {
          operationId,
          color: 'w',
          at: 2000,
          rulesVersion: 'rocky-adjudication@1',
          clockPolicy: 'observed-release-v1',
        },
      });

      // Confirm Bob on Node B received ZERO proving state messages (silent admission)
      assert.equal(
        bobConn.sent.some((m) => m.t === 'state' && m.state.adjudication === 'proving'),
        false,
        'Proving state publication was lost; Bob must not have received proving state',
      );
      // Because proving state was never observed, gateway observed hint is EMPTY
      assert.deepEqual(nodeB.gateway.watchedAdjudicatingGames(), []);
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
      // On unpatched code (old 345): both authority.adjudicatingGames() and gateway.watchedAdjudicatingGames()
      // were empty, so resync routed 0 games and Bob remained permanently starved.
      // On corrected code: bounded fallback check of localGameIds() discovers the locally watched room,
      // routes adjudicationChanged, claims ownership, folds durable log, and broadcasts move and state!
      const failed = await nodeB.resync.runPass();
      assert.equal(failed, 0);

      // Verify Node B acquired ownership
      assert.equal(
        nodeB.registry.holdsValidLease(gameId),
        true,
        'Survivor replica must acquire ownership via fallback check of locally watched room',
      );
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

async function createGenuineApplyResult(): Promise<ApplyResult> {
  const pubsub = new InMemoryPubSub();
  const eventLog = new InMemoryEventLog();
  const authority = new GameAuthority(pubsub, () => 1000, eventLog);
  const state = await authority.createGame({
    gameId: 'fixture-game',
    players: { white: 'w-fixture', black: 'b-fixture' },
    timeControl: TC,
    rated: false,
    at: 1000,
  });
  return {
    events: [],
    broadcasts: [],
    state,
  };
}

test('AdjudicationResync enforces fallbackBatchSize budget and fair round-robin across passes', async () => {
  const dummyApplyResult = await createGenuineApplyResult();
  const routed: string[] = [];
  const router: CommandRouter = {
    route: async (gameId) => {
      routed.push(gameId);
      return dummyApplyResult;
    },
  };
  let localGames = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
  const resync = new AdjudicationResync({
    authority: { adjudicatingGames: () => [] },
    router,
    watched: {
      localGameIds: () => localGames,
      sendStateToRoom: () => {},
    },
    fallbackBatchSize: 2,
  });

  // Pass 1: routes first 2 games
  await resync.runPass();
  assert.deepEqual(routed, ['g1', 'g2']);

  // Pass 2: routes next 2 games (no starvation in stable set)
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, ['g3', 'g4']);

  // Pass 3: routes next 2 games
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, ['g5', 'g6']);

  // Pass 4: wraps around to g1, g2
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, ['g1', 'g2']);

  // Pass 5: when all rooms leave, zero routes occur
  localGames = [];
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, []);

  // Pass 6: reintroducing rooms resumes recovery
  localGames = ['g7', 'g8'];
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, ['g7', 'g8']);
});

test('AdjudicationResync prioritizes fast candidates and avoids fallback duplication', async () => {
  const dummyApplyResult = await createGenuineApplyResult();
  const routed: string[] = [];
  const router: CommandRouter = {
    route: async (gameId) => {
      routed.push(gameId);
      return dummyApplyResult;
    },
  };
  const fastCandidates = ['g2'];
  const localGames = ['g1', 'g2', 'g3'];
  const resync = new AdjudicationResync({
    authority: { adjudicatingGames: () => [] },
    router,
    watched: {
      watchedAdjudicatingGames: () => fastCandidates,
      localGameIds: () => localGames,
      sendStateToRoom: () => {},
    },
    fallbackBatchSize: 1,
  });

  // Pass 1: fast candidate g2 + fallback from cursor 0 (adds g1; inspected 1)
  await resync.runPass();
  assert.deepEqual(routed, ['g2', 'g1']);

  // Pass 2: fast candidate g2 + fallback from cursor 1 (inspects g2, already present, adds g3; inspected 2)
  routed.length = 0;
  await resync.runPass();
  assert.deepEqual(routed, ['g2', 'g3']);
});

test('AdjudicationResync validates constructor parameters', async () => {
  const dummyApplyResult = await createGenuineApplyResult();
  const router: CommandRouter = {
    route: async () => dummyApplyResult,
  };
  assert.throws(
    () => new AdjudicationResync({
      authority: { adjudicatingGames: () => [] },
      router,
      fallbackBatchSize: 0,
    }),
    RangeError,
  );
  assert.throws(
    () => new AdjudicationResync({
      authority: { adjudicatingGames: () => [] },
      router,
      fallbackBatchSize: -1,
    }),
    RangeError,
  );
  assert.throws(
    () => new AdjudicationResync({
      authority: { adjudicatingGames: () => [] },
      router,
      intervalMs: 0,
    }),
    RangeError,
  );
});

test('AdjudicationResync guarantees liveness for retained rooms under bounded churn counterexample', async () => {
  const dummyApplyResult = await createGenuineApplyResult();
  const allRouted: string[][] = [];
  const router: CommandRouter = {
    route: async (gameId) => {
      allRouted.at(-1)?.push(gameId);
      return dummyApplyResult;
    },
  };

  const groupA = Array.from({ length: 8 }, (_, i) => `a${i}`);
  const groupB = Array.from({ length: 8 }, (_, i) => `b${i}`);
  const groupZ = Array.from({ length: 8 }, (_, i) => `z${i}`);
  const groupZZ = Array.from({ length: 8 }, (_, i) => `zz${i}`);

  let currentRooms: string[] = [];
  const resync = new AdjudicationResync({
    authority: { adjudicatingGames: () => [] },
    router,
    watched: {
      localGameIds: () => currentRooms,
      sendStateToRoom: () => {},
    },
    fallbackBatchSize: 8,
  });

  // Cycle pattern across passes: [A + B + Z], [A + B + Z], [B + Z + ZZ]
  // Z is permanently watched (retained across all passes)
  const pattern = [
    [...groupA, ...groupB, ...groupZ],
    [...groupA, ...groupB, ...groupZ],
    [...groupB, ...groupZ, ...groupZZ],
  ];

  // Execute 4 cycles (12 passes total)
  for (let pass = 0; pass < 12; pass++) {
    currentRooms = pattern[pass % pattern.length]!;
    allRouted.push([]);
    await resync.runPass();
  }

  // 1. Initial waiting-survivor check: Pass 3 (index 2) must route waiting retained group Z
  assert.deepEqual(allRouted[2], groupZ, 'Pass 3 must route waiting retained group Z');

  // 2. Per-pass bounds, distinctness, and containment within currently watched rooms
  for (let p = 0; p < allRouted.length; p++) {
    const passRouted = allRouted[p]!;
    assert.ok(passRouted.length <= 8, `Pass ${p + 1} routed count ${passRouted.length} must be <= budget 8`);
    assert.equal(new Set(passRouted).size, passRouted.length, `Pass ${p + 1} must not contain duplicate routes`);
    const watchedSet = new Set(pattern[p % pattern.length]!);
    for (const id of passRouted) {
      assert.ok(watchedSet.has(id), `Pass ${p + 1} routed ${id} which is not currently watched`);
    }
  }

  // 3. Every retained Z ID must be present in the routed union for each successive 3-pass cycle (four cycles)
  for (let cycle = 0; cycle < 4; cycle++) {
    const cycleRouted = new Set(allRouted.slice(cycle * 3, cycle * 3 + 3).flat());
    for (const zId of groupZ) {
      assert.ok(
        cycleRouted.has(zId),
        `Cycle ${cycle + 1} (passes ${cycle * 3 + 1}..${cycle * 3 + 3}) must route retained room ${zId}`,
      );
    }
  }
});

stackTest('resync delivers authoritative state to local client when remote owner is cold and notices are lost', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const nodeB = createNode(redis, store, adjudicationStore, clock);
    const nodeC = createNode(redis, store, adjudicationStore, clock);

    try {
      const { gameId, black } = await seedGame(pool, FEN_MATE1);

      // Node C is the current valid owner in Redis
      const cClaim = await nodeC.registry.claim(gameId);
      assert.equal(cClaim.owned, true);
      assert.equal(nodeC.registry.holdsValidLease(gameId), true);
      // Ensure Node C's authority is genuinely cold in memory
      assert.equal(nodeC.authority.has(gameId), false);

      // Client Bob connects to replica Node B and joins
      const bobConn = nodeB.connect();
      nodeB.join(bobConn, gameId, black);
      await waitForCondition('Bob joined on node B', () => bobConn.sent.some((m) => m.t === 'joined'));

      // Node B does NOT own the lease and is watched stale at sequence 0
      assert.equal(nodeB.registry.holdsValidLease(gameId), false);
      assert.equal(nodeB.gateway.hasLocalSessions(gameId), true);
      assert.equal(nodeB.authority.adjudicatingGames().length, 0);

      // Adjudication started for move e7e4 directly in Postgres (silent admission, proving publication lost)
      const operationId = randomUUID();
      await adjudicationStore.startAdjudication({
        gameId,
        command: { kind: 'move', uci: 'e7e4' },
        context: {
          operationId,
          color: 'w',
          at: 2000,
          rulesVersion: 'rocky-adjudication@1',
          clockPolicy: 'observed-release-v1',
        },
      });

      // Worker proves, settles, and releases in Postgres; publish no-op simulates lost notice
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

      // Precondition verification:
      // Node C is STILL cold in authority memory immediately before resync
      assert.equal(nodeC.authority.has(gameId), false);
      assert.equal(nodeC.registry.holdsValidLease(gameId), true);
      // Bob on Node B has received NO move or state broadcast yet
      assert.equal(bobConn.sent.some((m) => m.t === 'move'), false);
      assert.equal(bobConn.sent.filter((m) => m.t === 'state').length, 0);

      // Replica Node B runs AdjudicationResync pass:
      // Node B routes adjudicationChanged to cold owner C (forwarded via Redis queue).
      // Node C's cold reload consumes current durable head; refreshSlot emits nothing to pubsub.
      // Node C's absorbDurable sees empty suffix and emits nothing to pubsub.
      // But B receives ApplyResult with result.state from C, and delivers it to local room via sendStateToRoom!
      const failed = await nodeB.resync.runPass();
      assert.equal(failed, 0);

      // Lease ownership unchanged: Node C is still the owner, Node B did NOT steal the lease
      assert.equal(nodeC.registry.holdsValidLease(gameId), true, 'Node C must remain owner');
      assert.equal(nodeB.registry.holdsValidLease(gameId), false, 'Node B must not steal lease from cold owner C');

      // CRITICAL: Deterministic immediate assertion before any timed wait so unpatched code fails immediately
      const stateMessages = bobConn.sent.filter((m) => m.t === 'state');
      assert.ok(
        stateMessages.some((m) => m.t === 'state' && m.state.ply === 1 && m.state.adjudication === undefined),
        'Bob on replica B must immediately recover committed position and released state',
      );

      // Verify final recovered state details
      const recoveredState = stateMessages.find((m) => m.t === 'state' && m.state.ply === 1);
      assert.ok(recoveredState !== undefined && recoveredState.t === 'state');
      if (recoveredState && recoveredState.t === 'state') {
        assert.equal(recoveredState.state.ply, 1);
        assert.equal(recoveredState.state.adjudication, undefined);
      }

      // Repeated resync must NOT replay ordinary history or send duplicate state broadcasts.
      // Note: Forwarding a command across nodes with options.requestId legitimately emits a
      // commandConfirmed acknowledgment, but must emit ZERO new gameplay/state frames (state, move, ended).
      const stateCountBefore = bobConn.sent.filter((m) => m.t === 'state').length;
      const moveCountBefore = bobConn.sent.filter((m) => m.t === 'move').length;
      const endedCountBefore = bobConn.sent.filter((m) => m.t === 'ended').length;

      const failed2 = await nodeB.resync.runPass();
      assert.equal(failed2, 0);

      const stateCountAfter = bobConn.sent.filter((m) => m.t === 'state').length;
      const moveCountAfter = bobConn.sent.filter((m) => m.t === 'move').length;
      const endedCountAfter = bobConn.sent.filter((m) => m.t === 'ended').length;

      assert.equal(
        stateCountAfter,
        stateCountBefore,
        'Repeated resync pass must not send duplicate state frames (deduplicated by lastFullStateRevision)',
      );
      assert.equal(
        moveCountAfter,
        moveCountBefore,
        'Repeated resync pass must not replay historical move frames',
      );
      assert.equal(
        endedCountAfter,
        endedCountBefore,
        'Repeated resync pass must not send duplicate ended frames',
      );
    } finally {
      await nodeB.close();
      await nodeC.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('invalid join overlapping resync cleans up orphan owner lease with ticket verification', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const node = createNode(redis, store, adjudicationStore, clock);

    try {
      await migrate(pool, migrationsDir());
      // Item 1: Schema-valid absent UUID, not fake-... prefix
      const absentGameId = randomUUID();

      // Client initiates join for nonexistent game, entering gateway joinBuffers
      const clientConn = node.connect();
      node.join(clientConn, absentGameId, 'user-absent');

      // Verify absentGameId is visible in gateway.localGameIds() via joinBuffers
      assert.equal(node.gateway.localGameIds().has(absentGameId), true);

      // Concurrent resync runs, discovers absentGameId from localGameIds.
      // With pre-validation check (authority.knows) before claim:
      // resync fails with unknown_game without leaving an orphan lease.
      const failed = await node.resync.runPass();
      assert.equal(failed, 1, 'Resync route fails for nonexistent game');

      // Client join completes and is rejected with unknown_game
      await waitForCondition('Client join rejected', () => clientConn.sent.some((m) => m.t === 'reject'));
      const rejectMsg = clientConn.sent.find((m) => m.t === 'reject');
      assert.ok(rejectMsg !== undefined && rejectMsg.t === 'reject');
      if (rejectMsg && rejectMsg.t === 'reject') {
        assert.equal(rejectMsg.code, 'unknown_game');
      }

      // 1. Redis owner key is GONE (deleted / never orphaned)
      assert.equal(
        await redis.get(ownerKey(absentGameId)),
        null,
        'Redis owner key for absent game must be cleaned up and not orphaned',
      );
      // 2. Local valid lease is GONE
      assert.equal(
        node.registry.holdsValidLease(absentGameId),
        false,
        'Local valid lease must be removed from ownership registry',
      );
      // 3. Local renewal entry / ticket is GONE
      assert.equal(
        node.registry.captureTicket(absentGameId),
        undefined,
        'No renewal ticket must remain in registry for absent game',
      );
      // 4. Join buffer cleared so localGameIds no longer contains absentGameId
      assert.equal(
        node.gateway.localGameIds().has(absentGameId),
        false,
        'Join buffer must be cleared from localGameIds after rejection',
      );

      // ── Item 2: Controlled async replacement-claim safety routed through production route ──
      // An in-flight operation with a captured ticket must NOT release a newer claim generation
      // if an async dependency failure arrives after release/reclaim of a new generation.
      const { gameId: realGameId, white } = await seedGame(pool);

      let notifyEnteredLoad: (() => void) | undefined;
      const enteredLoadPromise = new Promise<void>((resolve) => {
        notifyEnteredLoad = resolve;
      });
      let resolveResumeLoad: (() => void) | undefined;
      const resumeLoadPromise = new Promise<void>((resolve) => {
        resolveResumeLoad = resolve;
      });

      const originalLoad = store.load.bind(store);
      let routePromise1: Promise<ApplyResult> | undefined;
      try {
        store.load = async (gameId: string, signal?: AbortSignal) => {
          if (gameId === realGameId && notifyEnteredLoad) {
            const notify = notifyEnteredLoad;
            notifyEnteredLoad = undefined;
            notify();
            await resumeLoadPromise;
            throw new AuthorityError('unknown_game', `simulated delayed load failure for ${gameId}`);
          }
          return originalLoad(gameId, signal);
        };

        // Request 1 enters production router.route for realGameId (captures generation 1)
        routePromise1 = node.router.route(realGameId, white, { kind: 'move', uci: 'e2e4' });

        // Wait until Request 1 has claimed ownership in Redis, captured ticket 1, and entered store.load
        await enteredLoadPromise;

        const ticket1 = node.registry.captureTicket(realGameId);
        assert.ok(ticket1 !== undefined, 'Ticket 1 must be captured for Request 1');
        assert.equal(node.registry.isTicketCurrent(ticket1), true);

        // Concurrently release and re-claim on node.registry to advance to claim generation 2
        await node.registry.release(realGameId);
        const claim2 = await node.registry.claim(realGameId);
        assert.equal(claim2.owned, true);
        const ticket2 = node.registry.captureTicket(realGameId);
        assert.ok(ticket2 !== undefined);
        assert.notEqual(ticket1.claimGeneration, ticket2.claimGeneration, 'Generation must advance on re-claim');
        assert.equal(node.registry.isTicketCurrent(ticket1), false, 'Ticket 1 is now stale');
        assert.equal(node.registry.isTicketCurrent(ticket2), true, 'Ticket 2 is now current');

        // Now trigger the delayed dependency failure for Request 1
        resolveResumeLoad!();

        // Request 1 must reject with unknown_game
        await assert.rejects(routePromise1, (err: unknown) => {
          return err instanceof AuthorityError && err.code === 'unknown_game';
        });

        // CRITICAL ASSERTION: The NEW Redis key and generation 2 ticket MUST REMAIN intact.
        // If production lacked ticket verification, Request 1's cleanup would have deleted ticket2's lease!
        assert.equal(
          node.registry.isTicketCurrent(ticket2),
          true,
          'Newer generation ticket must remain current after stale failure cleanup',
        );
        assert.equal(
          node.registry.holdsValidLease(realGameId),
          true,
          'Local valid lease for generation 2 must remain held',
        );
        assert.equal(
          await redis.get(ownerKey(realGameId)),
          node.nodeId,
          'Redis owner key must remain owned by this node under generation 2',
        );
      } finally {
        store.load = originalLoad;
        resolveResumeLoad?.();
        await routePromise1?.catch(() => undefined);
      }
    } finally {
      await node.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('prevalidation no-orphan: absent UUID fails existence before claim and never creates owner key or ticket', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const node = createNode(redis, store, adjudicationStore, clock);

    try {
      await migrate(pool, migrationsDir());
      const absentGameId = randomUUID();

      // Initially no lease or key in Redis
      assert.equal(node.registry.holdsValidLease(absentGameId), false);
      assert.equal(await redis.get(ownerKey(absentGameId)), null);

      // Route server ADJUDICATION discovery for schema-valid absent UUID.
      // Pre-validation existence check (authority.knows) fails BEFORE any ownership claim in Redis.
      await assert.rejects(
        node.router.route(absentGameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' }),
        (err: unknown) => {
          assert.ok(err instanceof AuthorityError);
          assert.equal(err.code, 'unknown_game');
          return true;
        },
      );

      // Verify that NO owner key, local lease, or renewal ticket was ever created
      assert.equal(
        await redis.get(ownerKey(absentGameId)),
        null,
        'Redis owner key must not be created for absent game ID',
      );
      assert.equal(
        node.registry.holdsValidLease(absentGameId),
        false,
        'Local lease must not be held for absent game ID',
      );
      assert.equal(
        node.registry.captureTicket(absentGameId),
        undefined,
        'No renewal ticket must exist for absent game ID',
      );
    } finally {
      await node.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('shared/existing claim safety: pre-execution read failure on shared claim preserves valid ticket and key', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const node = createNode(redis, store, adjudicationStore, clock);

    const { gameId } = await seedGame(pool);

    let notifyEnteredKnows: (() => void) | undefined;
    const enteredKnowsPromise = new Promise<void>((resolve) => {
      notifyEnteredKnows = resolve;
    });
    let resolveResumeKnows: (() => void) | undefined;
    const resumeKnowsPromise = new Promise<void>((resolve) => {
      resolveResumeKnows = resolve;
    });

    const originalKnows = node.authority.knows.bind(node.authority);
    node.authority.knows = async (id: string) => {
      if (id === gameId && notifyEnteredKnows) {
        const notify = notifyEnteredKnows;
        notifyEnteredKnows = undefined;
        notify();
        await resumeKnowsPromise;
      }
      return originalKnows(id);
    };

    const originalLoad = store.load.bind(store);
    let failLoad = false;
    store.load = async (id: string, signal?: AbortSignal) => {
      if (id === gameId && failLoad) {
        throw new AuthorityError('invalid_command', `simulated pre-execution read failure for ${id}`);
      }
      return originalLoad(id, signal);
    };

    const originalClaim = node.registry.claim.bind(node.registry);
    let secondClaimReached = false;
    let knowsResumed = false;
    node.registry.claim = async (id: string) => {
      if (id === gameId && knowsResumed) {
        secondClaimReached = true;
      }
      return originalClaim(id);
    };

    let adjRoutePromise: Promise<ApplyResult> | undefined;
    try {
      // Request 1: Server ADJUDICATION discovery routes adjudicationChanged
      adjRoutePromise = node.router.route(gameId, ADJUDICATION_ACTOR, { kind: 'adjudicationChanged' });

      // Wait until Request 1 is paused in the existence check before claim
      await enteredKnowsPromise;

      // Meanwhile, another operation establishes a valid claim and ticket T
      const claim2 = await node.registry.claim(gameId);
      assert.equal(claim2.owned, true);
      assert.equal(claim2.nodeId, node.nodeId);
      const ticketT = node.registry.captureTicket(gameId);
      assert.ok(ticketT !== undefined);
      assert.equal(node.registry.isTicketCurrent(ticketT), true);

      // Arm pre-execution read failure for Request 1
      failLoad = true;
      knowsResumed = true;

      // Resume Request 1: completes knows(), then proceeds to claimOwnership() -> registry.claim()
      // under the existing valid lease, and inside applyLocal reloadFromLog -> store.load fails.
      resolveResumeKnows!();

      // Request 1 rejects with invalid_command
      await assert.rejects(adjRoutePromise, (err: unknown) => {
        return err instanceof AuthorityError && err.code === 'invalid_command';
      });

      // Verify that Request 1 actually reached the second registry.claim after knows() was resumed
      assert.equal(secondClaimReached, true, 'Second registry.claim must be reached after suspended knows');

      // CRITICAL ASSERTION: The continuous ticket generation and Redis owner key MUST REMAIN INTACT!
      const ticketAfter = node.registry.captureTicket(gameId);
      assert.ok(ticketAfter !== undefined);
      assert.equal(ticketAfter.claimGeneration, ticketT.claimGeneration, 'Same continuous ticket generation must be retained');
      assert.equal(node.registry.isTicketCurrent(ticketT), true, 'Ticket T must remain current');
      assert.equal(node.registry.holdsValidLease(gameId), true, 'Valid lease must remain held');
      assert.equal(await redis.get(ownerKey(gameId)), node.nodeId, 'Redis owner key must remain');
    } finally {
      node.authority.knows = originalKnows;
      store.load = originalLoad;
      node.registry.claim = originalClaim;
      resolveResumeKnows?.();
      await adjRoutePromise?.catch(() => undefined);
      await node.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('valid pending join coverage: resync overlapping real join preserves valid game and completes', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const node = createNode(redis, store, adjudicationStore, clock);

    try {
      const { gameId, black } = await seedGame(pool);

      // Client initiates join for real game, entering joinBuffers
      const clientConn = node.connect();
      node.join(clientConn, gameId, black);

      // Verify real game is in localGameIds via pending join buffer
      assert.equal(node.gateway.localGameIds().has(gameId), true);

      // Concurrent resync runs: authority.knows(gameId) validates true, route succeeds
      const failed = await node.resync.runPass();
      assert.equal(failed, 0, 'Resync must succeed for valid pending game');

      // Client join completes successfully
      await waitForCondition('Client joined', () => clientConn.sent.some((m) => m.t === 'joined'));
      const joinedMsg = clientConn.sent.find((m) => m.t === 'joined');
      assert.ok(joinedMsg !== undefined && joinedMsg.t === 'joined');

      // Room is active and lease is safely maintained
      assert.equal(node.gateway.hasLocalSessions(gameId), true);
      assert.equal(node.registry.holdsValidLease(gameId), true);
    } finally {
      await node.close();
      await redis.quit().catch(() => undefined);
    }
  });
});

stackTest('cleanup failure during missing-game handling propagates error with cause without silent discard', async () => {
  await withTestDatabase(async ({ pool }) => {
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const adjudicationStore = new PgAdjudicationStore(pool);
    const clock = { now: 2000 };
    const node = createNode(redis, store, adjudicationStore, clock);

    const originalRelease = node.registry.release.bind(node.registry);
    const originalApply = node.authority.apply.bind(node.authority);

    let routePromise: Promise<ApplyResult> | undefined;
    try {
      const { gameId, white } = await seedGame(pool);

      // Force lease to be held
      const claim = await node.registry.claim(gameId);
      assert.equal(claim.owned, true);

      // Mock release on node.registry to fail
      node.registry.release = async () => {
        throw new Error('simulated redis release connection error');
      };

      // Mock apply to fail with unknown_game
      node.authority.apply = async () => {
        throw new AuthorityError('unknown_game', 'simulated unknown game');
      };

      // Route command: apply fails with unknown_game, cleanup attempts release, release fails!
      // Must NOT silently swallow release failure; must propagate error with cause!
      routePromise = node.router.route(gameId, white, { kind: 'move', uci: 'e2e4' });
      await assert.rejects(
        routePromise,
        (err: unknown) => {
          assert.ok(err instanceof AuthorityError);
          assert.equal(err.code, 'unknown_game');
          assert.equal(err.message, 'simulated unknown game');
          // Raw sentinel / connection details must NOT leak in public reject message
          assert.equal(err.message.includes('simulated redis release connection error'), false);
          // But internal cause is preserved
          assert.ok(err.cause instanceof Error);
          assert.equal(err.cause.message, 'simulated redis release connection error');
          return true;
        },
      );
    } finally {
      node.registry.release = originalRelease;
      node.authority.apply = originalApply;
      await routePromise?.catch(() => undefined);
      await node.close();
      await redis.quit().catch(() => undefined);
    }
  });
});
