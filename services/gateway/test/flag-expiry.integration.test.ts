/**
 * In-play flag expiry on the real stack (ADR-0149): two gateway replicas with the production
 * RedisCommandRouter, OwnershipRegistry, owner consumers and Redis pub/sub, sharing one PostgreSQL
 * event log, trigger-kept flag queue, games projection and tournament store. Gated behind both
 * REDIS_URL and DATABASE_URL; the zero-skip runner turns a missing service into a failure in CI.
 *
 * Time is a shared controllable clock read by both authorities and both workers, so deadlines are
 * crossed by assignment, never by sleeping.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { ENGINE_BOT_USER_IDS, Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryConnection,
  RealtimeGateway,
  type TokenVerifier,
} from '@chess-platform/realtime-gateway';
import {
  PgFlagCandidates,
  PgGamesProjector,
  PgTournamentsRepository,
  PostgresEventStore,
  migrate,
  migrationsDir,
} from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { ArenaService, DurableGameLauncher, TournamentResultReporter, TournamentService } from '@chess-platform/api';
import { OwnershipRegistry, ownerKey } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { createRedisPubSub } from '../src/redis-pubsub.js';
import { FlagExpiryWorker, routedFlagExpiry } from '../src/flag-expiry.js';

type Pool = TestDatabase['pool'];

const REDIS_URL = process.env['REDIS_URL'];
const DATABASE_URL = process.env['DATABASE_URL'];
const stackTest = (name: string, fn: () => Promise<void>): void => {
  (REDIS_URL && DATABASE_URL ? test : test.skip)(name, { timeout: 90_000 }, fn);
};

const TC: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const MOVED = T0 + 1_000;
/** Black's clock, started by White's first move at MOVED. */
const DEADLINE = MOVED + 180_000;

class Tokens implements TokenVerifier {
  verify(token: string): { readonly userId: string } | null {
    return token.startsWith('token-') ? { userId: token.slice('token-'.length) } : null;
  }
}

interface Clock { now: number }

function makeNode(redis: Redis, store: PostgresEventStore, pool: Pool, clock: Clock) {
  const nodeId = `node-${randomUUID()}`;
  const redisPubSub = createRedisPubSub({ url: REDIS_URL!, nodeId });
  const pubsub = redisPubSub.pubsub;
  const authority = new GameAuthority(pubsub, () => clock.now, store);
  const registry = new OwnershipRegistry({ redis, nodeId, leaseTtlSec: 30, renewalIntervalSec: 15 });
  const consumer = new OwnerCommandConsumer(authority, redis);
  const router = new RedisCommandRouter({ authority, registry, redis, nodeId, consumer, forwardTimeoutMs: 3000 });
  const gateway = new RealtimeGateway(authority, pubsub, new Tokens(), () => clock.now, router);
  const worker = new FlagExpiryWorker({
    candidates: new PgFlagCandidates(pool),
    events: store,
    expire: routedFlagExpiry({ authority, router, ownership: registry, hasLocalSessions: (id) => gateway.hasLocalSessions(id) }),
    now: () => clock.now,
    pollMs: 20,
  });
  const connect = (): InMemoryConnection => {
    const conn = new InMemoryConnection(`${nodeId}-${randomUUID()}`);
    gateway.handleConnection(conn);
    return conn;
  };
  const join = (conn: InMemoryConnection, gameId: string, user: string): void => {
    conn.deliver({ t: 'join', gameId, token: `token-${user}` });
  };
  const close = async (): Promise<void> => {
    await worker.stop();
    consumer.stop();
    registry.stopRenewal();
    await registry.releaseAll();
    await redisPubSub.close().catch(() => undefined);
  };
  return { nodeId, pubsub, authority, registry, consumer, router, gateway, worker, connect, join, close };
}
type Node = ReturnType<typeof makeNode>;

interface Stack {
  readonly a: Node;
  readonly b: Node;
  readonly redis: Redis;
  readonly pool: Pool;
  readonly store: PostgresEventStore;
  readonly clock: Clock;
  readonly makeNode: () => Node;
}

async function withStack(fn: (s: Stack) => Promise<void>): Promise<void> {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const store = new PostgresEventStore(pool);
    const clock: Clock = { now: T0 };
    const extra: Node[] = [];
    const a = makeNode(redis, store, pool, clock);
    const b = makeNode(redis, store, pool, clock);
    try {
      await fn({
        a, b, redis, pool, store, clock,
        makeNode: () => {
          const node = makeNode(redis, store, pool, clock);
          extra.push(node);
          return node;
        },
      });
    } finally {
      for (const node of [a, b, ...extra]) await node.close();
      await redis.quit().catch(() => undefined);
    }
  }, { max: 10 });
}

async function logged(store: PostgresEventStore, gameId: string): Promise<GameEvent[]> {
  return (await store.load(gameId)).map((e) => e.event);
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function project(pool: Pool): Promise<void> {
  const projector = new PgGamesProjector(pool);
  await waitFor('the games projection to catch up', async () => {
    const batch = await projector.runBatch();
    if (batch.busy || batch.more) return false;
    return !(await pool.query<{ pending: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM game_events e, projection_checkpoints c
        WHERE c.projection = 'games' AND (e.xact_id, e.game_id, e.seq) > (c.xact_id, c.game_id, c.seq)) AS pending`,
    )).rows[0]!.pending;
  });
}

/** A seek game both players joined on different replicas, with White's first move played through A. */
async function seekGameUnderway(s: Stack): Promise<{ gameId: string; alice: InMemoryConnection; bob: InMemoryConnection }> {
  const gameId = randomUUID();
  await s.a.authority.createGame({
    gameId, timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true, at: T0, source: 'seek', noShowAfterMs: 60_000,
  });
  const alice = s.a.connect();
  const bob = s.b.connect();
  s.a.join(alice, gameId, 'alice');
  s.b.join(bob, gameId, 'bob');
  await waitFor('both seats ready', async () => (await logged(s.store, gameId)).filter((e) => e.type === 'PlayerReady').length === 2);
  s.clock.now = MOVED;
  alice.deliver({ t: 'move', gameId, uci: 'e2e4', clientSeq: 1 });
  await waitFor('the first move', async () => (await logged(s.store, gameId)).some((e) => e.type === 'MovePlayed'));
  return { gameId, alice, bob };
}

const TIMEOUT_WHITE_WINS = { type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w' };

stackTest('both players gone: two replicas scan the same flag and exactly one timeout is appended, nothing left claimed', async () => {
  await withStack(async (s) => {
    const { gameId, alice, bob } = await seekGameUnderway(s);
    alice.close();
    bob.close();
    await waitFor('rooms to empty', () => !s.a.gateway.hasLocalSessions(gameId) && !s.b.gateway.hasLocalSessions(gameId));
    const owner = await s.redis.get(ownerKey(gameId));
    const ownerNode = owner === s.a.nodeId ? s.a : s.b;
    await ownerNode.registry.release(gameId); // the replicas went idle: no lease, no cached copy
    s.a.authority.evict(gameId);
    s.b.authority.evict(gameId);

    s.clock.now = DEADLINE - 1;
    assert.equal((await s.a.worker.runPass()).expired, 0, 'not before the flag');
    s.clock.now = DEADLINE;
    await Promise.all([s.a.worker.runPass(), s.b.worker.runPass()]);
    const endings = (await logged(s.store, gameId)).filter((e) => e.type === 'GameEnded');
    assert.deepEqual(endings, [{ ...TIMEOUT_WHITE_WINS, at: DEADLINE }]);
    await waitFor('the expiring claim to be released', async () => (await s.redis.get(ownerKey(gameId))) === null);
    assert.equal(s.a.authority.has(gameId) || s.b.authority.has(gameId), false, 'copies loaded only for the expiry are evicted');
    assert.equal((await s.pool.query('SELECT 1 FROM flag_deadlines WHERE game_id = $1', [gameId])).rowCount, 0);

    await project(s.pool);
    const row = (await s.pool.query('SELECT result, termination, ended_at, ply_count FROM games WHERE id = $1', [gameId])).rows[0];
    assert.deepEqual(row, { result: '1-0', termination: 'timeout', ended_at: new Date(DEADLINE), ply_count: 1 });
  });
});

stackTest('an expiry decided on a non-owner is applied by the watched owner, whose rooms hear the ending', async () => {
  await withStack(async (s) => {
    const { gameId, alice, bob } = await seekGameUnderway(s);
    const owner = await s.redis.get(ownerKey(gameId));
    const [ownerNode, other] = owner === s.a.nodeId ? [s.a, s.b] : [s.b, s.a];
    s.clock.now = DEADLINE;
    assert.equal((await other.worker.runPass()).expired, 1);
    await waitFor('both players to hear the ending', () => alice.last('ended') !== undefined && bob.last('ended') !== undefined);
    assert.equal(await s.redis.get(ownerKey(gameId)), ownerNode.nodeId, 'a watched owner keeps its lease');
    assert.equal(ownerNode.authority.getState(gameId).status.over, true, "the owner's own copy holds the ending");
  });
});

stackTest('a move racing the expiry at the flag on different replicas yields exactly one timeout and no move', async () => {
  for (let round = 0; round < 3; round += 1) {
    await withStack(async (s) => {
      const { gameId, bob } = await seekGameUnderway(s);
      s.clock.now = DEADLINE;
      // Black's too-late reply goes through B while A's worker expires the clock.
      bob.deliver({ t: 'move', gameId, uci: 'e7e5', clientSeq: 1 });
      await s.a.worker.runPass();
      await waitFor('an outcome', async () => (await logged(s.store, gameId)).some((e) => e.type === 'GameEnded'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const tail = (await logged(s.store, gameId)).slice(4);
      assert.deepEqual(tail, [{ ...TIMEOUT_WHITE_WINS, at: DEADLINE }], `round ${round}`);
    });
  }
});

stackTest('a reply one millisecond before the flag stands, and the worker finds nothing due at the old deadline', async () => {
  await withStack(async (s) => {
    const { gameId, bob } = await seekGameUnderway(s);
    s.clock.now = DEADLINE - 1;
    bob.deliver({ t: 'move', gameId, uci: 'e7e5', clientSeq: 1 });
    await waitFor('the reply', async () => (await logged(s.store, gameId)).filter((e) => e.type === 'MovePlayed').length === 2);
    s.clock.now = DEADLINE;
    const passes = await Promise.all([s.a.worker.runPass(), s.b.worker.runPass()]);
    assert.deepEqual(passes.map((p) => p.scanned), [0, 0]);
    const game = Game.fromEvents(await logged(s.store, gameId));
    const queued = await s.pool.query<{ due_ms: string }>('SELECT due_ms FROM flag_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(Number(queued.rows[0]!.due_ms), game.flagDeadline, "White's new deadline replaced Black's");
  });
});

stackTest('a gateway restarted after the flag ends the game on its first pass; while stopped nothing ended it', async () => {
  await withStack(async (s) => {
    const { gameId, alice, bob } = await seekGameUnderway(s);
    alice.close();
    bob.close();
    await s.a.close();
    await s.b.close(); // every replica is down while the clock runs out
    s.clock.now = DEADLINE + 3_600_000;
    assert.equal((await logged(s.store, gameId)).some((e) => e.type === 'GameEnded'), false);
    const restarted = s.makeNode();
    restarted.worker.start();
    await waitFor('the overdue game to end', async () => (await logged(s.store, gameId)).some((e) => e.type === 'GameEnded'));
    const ending = (await logged(s.store, gameId)).find((e) => e.type === 'GameEnded');
    assert.deepEqual(ending, { ...TIMEOUT_WHITE_WINS, at: DEADLINE + 3_600_000 });
  });
});

stackTest('a bot game flags like any other once its first move is played; the engine account never needs to connect', async () => {
  await withStack(async (s) => {
    const gameId = randomUUID();
    const bot = ENGINE_BOT_USER_IDS.club;
    await s.a.authority.createGame({ gameId, timeControl: TC, players: { white: 'alice', black: bot }, rated: false, at: T0 });
    s.clock.now = MOVED;
    await s.a.router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
    await s.a.router.route(gameId, bot, { kind: 'move', uci: 'e7e5' }); // the engine mover's path
    const game = Game.fromEvents(await logged(s.store, gameId));
    s.clock.now = game.flagDeadline!;
    assert.equal((await s.b.worker.runPass()).expired, 1, 'the human left while on move');
    const ending = (await logged(s.store, gameId)).at(-1);
    assert.deepEqual(ending, { type: 'GameEnded', result: '0-1', termination: 'timeout', winner: 'b', at: game.flagDeadline });
  });
});

stackTest('a tournament timeout is recorded once by the reporter from the durable ending', async () => {
  await withStack(async (s) => {
    const repo = new PgTournamentsRepository(s.pool);
    const launcher = new DurableGameLauncher(s.store, { now: () => T0 }, 300_000);
    const tournaments = new TournamentService(repo, launcher);
    const arenas = new ArenaService(repo, launcher, () => s.clock.now);
    const id = `rr-${randomUUID()}`;
    await tournaments.create({ id, name: id, format: 'round_robin', variant: 'standard', timeControl: TC });
    for (const player of [randomUUID(), randomUUID()]) await tournaments.register(id, player);
    await tournaments.start(id);
    const [[, gameId]] = (await tournaments.load(id)).toSnapshot().gameLinks as [[string, string]];
    const { players } = Game.fromEvents(await logged(s.store, gameId)).snapshot();
    const white = s.a.connect();
    const black = s.b.connect();
    s.a.join(white, gameId, players.white);
    s.b.join(black, gameId, players.black);
    await waitFor('both ready', async () => (await logged(s.store, gameId)).filter((e) => e.type === 'PlayerReady').length === 2);
    s.clock.now = MOVED;
    white.deliver({ t: 'move', gameId, uci: 'e2e4', clientSeq: 1 });
    await waitFor('the first move', async () => (await logged(s.store, gameId)).some((e) => e.type === 'MovePlayed'));

    const reporter = new TournamentResultReporter(s.a.pubsub, repo, tournaments, arenas, s.store, { scanIntervalMs: 0 });
    await reporter.start();
    try {
      s.clock.now = DEADLINE;
      await Promise.all([s.a.worker.runPass(), s.b.worker.runPass()]);
      await waitFor('the reporter to record the outcome', async () => {
        await reporter.scan();
        return (await tournaments.load(id)).resultFor(0, 0) !== undefined;
      });
      const t = await tournaments.load(id);
      assert.equal(t.resultFor(0, 0), 'white_win');
      assert.equal(t.launchAttemptFor(0, 0), 0, 'a decided result is never relaunched');
      reporter.stop();
      const again = new TournamentResultReporter(s.a.pubsub, repo, tournaments, arenas, s.store, { scanIntervalMs: 0 });
      await again.start();
      again.stop();
      assert.equal((await tournaments.load(id)).resultFor(0, 0), 'white_win', 'a restart replays the same ending unchanged');
      assert.equal((await logged(s.store, gameId)).filter((e) => e.type === 'GameEnded').length, 1);
    } finally {
      reporter.stop();
    }
  });
});
