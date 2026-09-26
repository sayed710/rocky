/**
 * Durable readiness and pregame no-show expiry on the real stack (ADR-0148): two gateway replicas
 * with the production RedisCommandRouter, OwnershipRegistry, owner consumers and Redis pub/sub,
 * sharing one PostgreSQL event log, games projection and tournament store. Gated behind both
 * REDIS_URL and DATABASE_URL; the zero-skip runner turns a missing service into a failure in CI.
 *
 * Time is a shared controllable clock read by both authorities and both workers, so deadlines are
 * crossed by assignment, never by sleeping.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Game, type GameEvent, type GameSource, type TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryConnection,
  RealtimeGateway,
  type TokenVerifier,
} from '@chess-platform/realtime-gateway';
import {
  PgGamesProjector,
  PgNoShowCandidates,
  PgTournamentsRepository,
  PostgresEventStore,
  migrate,
  migrationsDir,
} from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';

type Pool = TestDatabase['pool'];
import { ArenaService, DurableGameLauncher, TournamentResultReporter, TournamentService } from '@chess-platform/api';
import { OwnershipRegistry, ownerKey } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';
import { createRedisPubSub } from '../src/redis-pubsub.js';
import { NoShowExpiryWorker, routedNoShowExpiry } from '../src/no-show-expiry.js';

const REDIS_URL = process.env['REDIS_URL'];
const DATABASE_URL = process.env['DATABASE_URL'];
const stackTest = (name: string, fn: () => Promise<void>): void => {
  (REDIS_URL && DATABASE_URL ? test : test.skip)(name, { timeout: 90_000 }, fn);
};

const TC: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
const SEEK_MS = 60_000;
const TOURNAMENT_MS = 300_000;

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
  const worker = new NoShowExpiryWorker({
    candidates: new PgNoShowCandidates(pool),
    events: store,
    expire: routedNoShowExpiry({ authority, router, ownership: registry, hasLocalSessions: (id) => gateway.hasLocalSessions(id) }),
    now: () => clock.now,
    pollMs: 20,
  });
  const connect = (): InMemoryConnection => {
    const conn = new InMemoryConnection(`${nodeId}-${randomUUID()}`);
    gateway.handleConnection(conn);
    return conn;
  };
  const join = (conn: InMemoryConnection, gameId: string, user: string | null): void => {
    conn.deliver(user === null ? { t: 'join', gameId } : { t: 'join', gameId, token: `token-${user}` });
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

async function createGame(node: Node, source: GameSource): Promise<string> {
  const gameId = randomUUID();
  await node.authority.createGame({
    gameId, timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true, at: T0,
    source, noShowAfterMs: source === 'seek' ? SEEK_MS : TOURNAMENT_MS,
  });
  return gameId;
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

/** Fold committed events into `games` until caught up, as the gateway's projection worker does. */
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

const readiness = async (store: PostgresEventStore, gameId: string): Promise<string[]> =>
  (await logged(store, gameId)).flatMap((e) => (e.type === 'PlayerReady' ? [e.by] : []));

stackTest('seek no-show: two replicas scan the same deadline and exactly one ending is appended, with nothing left claimed', async () => {
  await withStack(async ({ a, b, redis, pool, store, clock }) => {
    const gameId = await createGame(a, 'seek');
    await project(pool);
    clock.now = T0 + SEEK_MS - 1;
    assert.equal((await a.worker.runPass()).expired, 0, 'not before the deadline');

    clock.now = T0 + SEEK_MS;
    const passes = await Promise.all([a.worker.runPass(), b.worker.runPass()]);
    assert.ok(passes.every((p) => p.failed === 0 || p.expired === 0));
    const endings = (await logged(store, gameId)).filter((e) => e.type === 'GameEnded');
    assert.deepEqual(endings, [{ type: 'GameEnded', result: '*', termination: 'no_show', winner: null, at: T0 + SEEK_MS }]);
    await waitFor('the expiring claim to be released', async () => (await redis.get(ownerKey(gameId))) === null);
    assert.equal(a.consumer.isConsuming(gameId) || b.consumer.isConsuming(gameId), false, 'no owner consumer is left running');

    await project(pool);
    const row = (await pool.query('SELECT result, termination, ended_at, ply_count FROM games WHERE id = $1', [gameId])).rows[0];
    assert.deepEqual(row, { result: '*', termination: 'no_show', ended_at: new Date(T0 + SEEK_MS), ply_count: 0 });
    assert.equal((await a.worker.runPass()).scanned, 0, 'the ended game left the pending set');
  });
});

stackTest('readiness from joins on different replicas is durable once per seat and reaches both rooms', async () => {
  await withStack(async ({ a, b, store }) => {
    const gameId = await createGame(a, 'seek');
    const alice = a.connect();
    const bob = b.connect();
    const spectator = b.connect();
    const eve = a.connect();
    a.join(alice, gameId, 'alice');
    b.join(bob, gameId, 'bob');
    b.join(spectator, gameId, null);
    a.join(eve, gameId, 'eve');
    const extraTab = a.connect();
    a.join(extraTab, gameId, 'alice');
    await waitFor('both seats to be durably ready', async () => (await readiness(store, gameId)).length === 2);
    await waitFor('the readiness to reach the other replica', () => alice.last('ready')?.ready.b === true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await readiness(store, gameId)).sort(), ['b', 'w'], 'one record per seat, never for a spectator or stranger');
    assert.deepEqual(spectator.last('ready')?.ready, { w: true, b: true });
  });
});

stackTest('a replica that crashes after White\'s readiness committed leaves it durable for a fresh replica', async () => {
  await withStack(async ({ a, store, makeNode }) => {
    const gameId = await createGame(a, 'seek');
    const alice = a.connect();
    a.join(alice, gameId, 'alice');
    await waitFor('White to be ready', async () => (await readiness(store, gameId)).length === 1);
    await a.close(); // the replica goes away with its sockets, cache and lease

    const c = makeNode();
    const bob = c.connect();
    c.join(bob, gameId, 'bob');
    await waitFor('Bob to join', () => bob.last('joined') !== undefined);
    assert.equal(bob.last('joined')!.state.ready?.w, true, 'the reload still knows White is ready');
    await waitFor('Black to be ready too', async () => (await readiness(store, gameId)).length === 2);
    assert.deepEqual(await readiness(store, gameId), ['w', 'b']);
  });
});

stackTest('tournament no-show: the one ready player wins either way, and neither ready is a double forfeit', async () => {
  await withStack(async ({ a, b, pool, store, clock }) => {
    const cases: Array<[readonly ('alice' | 'bob')[], string, 'w' | 'b' | null]> = [
      [['alice'], '1-0', 'w'],
      [['bob'], '0-1', 'b'],
      [[], '*', null],
    ];
    const games: string[] = [];
    for (const [ready] of cases) {
      const gameId = await createGame(a, 'tournament');
      games.push(gameId);
      for (const user of ready) {
        const conn = b.connect();
        b.join(conn, gameId, user);
      }
    }
    await waitFor('readiness to commit', async () => (await Promise.all(games.map((g) => readiness(store, g)))).flat().length === 2);
    await project(pool);
    clock.now = T0 + TOURNAMENT_MS - 1;
    assert.equal((await a.worker.runPass()).expired, 0);
    clock.now = T0 + TOURNAMENT_MS;
    await Promise.all([a.worker.runPass(), b.worker.runPass()]);
    for (const [i, [, result, winner]] of cases.entries()) {
      const endings = (await logged(store, games[i]!)).filter((e) => e.type === 'GameEnded');
      assert.deepEqual(endings, [{ type: 'GameEnded', result, termination: 'no_show', winner, at: T0 + TOURNAMENT_MS }]);
    }
  });
});

stackTest('tournament players who are both ready wait with full clocks; the first move is charged nothing', async () => {
  await withStack(async ({ a, b, pool, store, clock }) => {
    const gameId = await createGame(a, 'tournament');
    const alice = a.connect();
    const bob = b.connect();
    a.join(alice, gameId, 'alice');
    b.join(bob, gameId, 'bob');
    await waitFor('both ready', async () => (await readiness(store, gameId)).length === 2);
    await project(pool);
    clock.now = T0 + TOURNAMENT_MS + 30_000;
    await Promise.all([a.worker.runPass(), b.worker.runPass()]);
    assert.equal((await logged(store, gameId)).some((e) => e.type === 'GameEnded'), false, 'no no-show once both are ready');

    alice.deliver({ t: 'move', gameId, uci: 'e2e4', clientSeq: 1 });
    await waitFor('the first move', async () => (await logged(store, gameId)).some((e) => e.type === 'MovePlayed'));
    const move = (await logged(store, gameId)).find((e) => e.type === 'MovePlayed');
    assert.ok(move?.type === 'MovePlayed');
    assert.equal(move.moveTimeMs, 0);
    assert.deepEqual(move.remaining, { w: 182_000, b: 180_000 });
    await waitFor('Bob to see the move', () => bob.last('move') !== undefined);
    const replayed = Game.fromEvents(await logged(store, gameId)).snapshot();
    assert.equal(replayed.clock.turnStartedAt, clock.now, "Black's clock runs from the move's server time");
  });
});

stackTest('a first move racing the expiry at the deadline on different replicas yields exactly one no-show', async () => {
  for (let round = 0; round < 3; round += 1) {
    await withStack(async ({ a, b, pool, store, clock }) => {
      const gameId = await createGame(a, 'seek');
      const alice = a.connect();
      const bob = b.connect();
      a.join(alice, gameId, 'alice');
      b.join(bob, gameId, 'bob');
      await waitFor('both ready', async () => (await readiness(store, gameId)).length === 2);
      await project(pool);
      clock.now = T0 + SEEK_MS;
      // White's move goes through replica A while replica B's worker expires the game.
      alice.deliver({ t: 'move', gameId, uci: 'e2e4', clientSeq: 1 });
      await b.worker.runPass();
      await waitFor('an outcome', async () => {
        const types = (await logged(store, gameId)).map((e) => e.type);
        return types.includes('MovePlayed') || types.includes('GameEnded');
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const types = (await logged(store, gameId)).map((e) => e.type);
      // At the deadline the no-show wins in either order: the expiry, or White's move recording it.
      assert.deepEqual(types.slice(3), ['GameEnded'], `exactly one no-show and no move, got ${JSON.stringify(types)}`);
      await waitFor('White to learn the outcome', () => alice.last('ended') !== undefined);
    });
  }
});

stackTest('an expiry decided on another replica is applied by the owner, so the owner never serves a stale ongoing game', async () => {
  await withStack(async ({ a, b, redis, pool, store, clock }) => {
    const gameId = await createGame(a, 'seek');
    const alice = a.connect();
    a.join(alice, gameId, 'alice'); // routing White's readiness makes A the owner
    await waitFor('White to be ready', async () => (await readiness(store, gameId)).length === 1);
    assert.equal(await redis.get(ownerKey(gameId)), a.nodeId);
    await project(pool);
    clock.now = T0 + SEEK_MS;
    assert.equal((await b.worker.runPass()).expired, 1, 'B decided the expiry');
    await waitFor('the room on A to hear the ending', () => alice.last('ended') !== undefined);
    const late = a.connect();
    a.join(late, gameId, null);
    await waitFor('the late join', () => late.last('joined') !== undefined);
    assert.equal(late.last('joined')!.state.status.over, true, "the owner's own copy holds the ending");
    assert.equal(await redis.get(ownerKey(gameId)), a.nodeId, 'B did not take over a game A owns');
  });
});

stackTest('a replica restarted while games are overdue expires them on its first pass', async () => {
  await withStack(async ({ a, pool, store, clock, makeNode }) => {
    const gameId = await createGame(a, 'seek');
    await project(pool);
    await a.close(); // nothing was running when the deadline passed
    clock.now = T0 + 10 * SEEK_MS;
    const restarted = makeNode();
    restarted.worker.start();
    await waitFor('the overdue game to end', async () => (await logged(store, gameId)).some((e) => e.type === 'GameEnded'));
  });
});

stackTest('a tournament double forfeit is recorded by the reporter from the durable ending and never relaunched', async () => {
  await withStack(async ({ a, pool, store, clock }) => {
    const repo = new PgTournamentsRepository(pool);
    const launcher = new DurableGameLauncher(store, { now: () => T0 }, TOURNAMENT_MS);
    const tournaments = new TournamentService(repo, launcher);
    const arenas = new ArenaService(repo, launcher, () => clock.now);
    const id = `rr-${randomUUID()}`;
    await tournaments.create({ id, name: id, format: 'round_robin', variant: 'standard', timeControl: TC });
    for (const player of [randomUUID(), randomUUID()]) await tournaments.register(id, player);
    await tournaments.start(id);
    const [[, gameId]] = (await tournaments.load(id)).toSnapshot().gameLinks as [[string, string]];

    const reporter = new TournamentResultReporter(a.pubsub, repo, tournaments, arenas, store, { scanIntervalMs: 0 });
    await reporter.start();
    try {
      await project(pool);
      clock.now = T0 + TOURNAMENT_MS;
      assert.equal((await a.worker.runPass()).expired, 1);
      // The ended broadcast crosses Redis to the reporter's subscription; the scan is the backstop.
      await waitFor('the reporter to record the outcome', async () => {
        await reporter.scan();
        return (await tournaments.load(id)).resultFor(0, 0) !== undefined;
      });
      const t = await tournaments.load(id);
      assert.equal(t.resultFor(0, 0), 'double_forfeit');
      assert.equal(t.launchAttemptFor(0, 0), 0, 'the aborted-game relaunch did not run');
      assert.equal(t.gameIdFor(0, 0), gameId);

      // A reporter restart replays the same durable ending without changing anything.
      reporter.stop();
      const again = new TournamentResultReporter(a.pubsub, repo, tournaments, arenas, store, { scanIntervalMs: 0 });
      await again.start();
      again.stop();
      const after = await tournaments.load(id);
      assert.equal(after.resultFor(0, 0), 'double_forfeit');
      assert.equal(after.launchAttemptFor(0, 0), 0);
    } finally {
      reporter.stop();
    }
  });
});
