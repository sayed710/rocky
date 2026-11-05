/**
 * The adjudication worker on real PostgreSQL (Issue #124, ADR-0175): genuine proof jobs through
 * PgAdjudicationStore, the migration 0053/0054 fences and real leases. Covered: a stopped completion
 * settled, published and released with replay parity; racing workers on one operation; a worker that
 * dies mid-proof replaced by a successor at a higher generation; an exhausted proof settled as
 * unresolved without a dead-position draw. Gated behind DATABASE_URL; the zero-skip runner turns a
 * missing database into a failure in CI.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Game, type GameEvent } from '@chess-platform/game';
import { PgAdjudicationStore, migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase, type TestDatabase } from '@chess-platform/persistence/test-support';
import { AdjudicationWorker, stopReleaseRequestId, type AdjudicationChange } from '../src/adjudication-worker.js';

type Pool = TestDatabase['pool'];

const DATABASE_URL = process.env['DATABASE_URL'];
const pgTest = (name: string, fn: () => Promise<void>): void => {
  (DATABASE_URL ? test : test.skip)(name, { timeout: 90_000 }, fn);
};

const RULES = 'standard@1.0.0';
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

async function setup(pool: Pool): Promise<{ white: string; black: string }> {
  await migrate(pool, migrationsDir());
  const white = randomUUID();
  const black = randomUUID();
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, 'white_player', 'white@example.com', NOW(), NOW()), ($2, 'black_player', 'black@example.com', NOW(), NOW())`,
    [white, black],
  );
  return { white, black };
}

async function createGame(pool: Pool, players: { white: string; black: string }, initialFen?: string): Promise<string> {
  const gameId = randomUUID();
  const created = Game.create({
    gameId, players,
    timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
    rated: false, at: 1000, ...(initialFen ? { initialFen } : {}),
  });
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at) VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, players.white, players.black],
  );
  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
    [gameId, JSON.stringify(created.events[0])],
  );
  return gameId;
}

async function startMove(store: PgAdjudicationStore, gameId: string, uci: string, color: 'w' | 'b', at: number): Promise<string> {
  const operationId = randomUUID();
  const res = await store.startAdjudication({
    gameId,
    command: { kind: 'move', uci },
    context: { operationId, color, at, rulesVersion: RULES, clockPolicy: 'observed-release-v1' },
  });
  assert.equal(res.status, 'started');
  return operationId;
}

async function events(pool: Pool, gameId: string): Promise<GameEvent[]> {
  const rows = await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId]);
  return rows.rows.map((r) => r.payload as GameEvent);
}

function worker(store: PgAdjudicationStore, clock: { now: number }, published: AdjudicationChange[], extra: object = {}): AdjudicationWorker {
  return new AdjudicationWorker({
    store, executorId: randomUUID(), leaseMs: 5_000, sliceBudget: 200, releaseGraceMs: 0,
    publish: async (change) => {
      published.push(change);
    },
    now: () => clock.now,
    ...extra,
  });
}

pgTest('a stopped completion is settled, published, then released, with replay parity', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool, players, FEN_MATE1);
    const operationId = await startMove(store, gameId, 'e7e4', 'w', 1100);
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const pass = await worker(store, clock, published).runPass();
    assert.deepEqual({ settled: pass.settled, released: pass.released, failed: pass.failed }, { settled: 1, released: 1, failed: 0 });
    assert.deepEqual(published.map((c) => c.kind), ['settled', 'released']);

    const logged = await events(pool, gameId);
    const types = logged.map((e) => e.type);
    assert.deepEqual(types.slice(-3), ['AdjudicationResolved', 'MovePlayed', 'AdjudicationClocksStarted']);
    const release = logged.at(-1) as Extract<GameEvent, { type: 'AdjudicationClocksStarted' }>;
    assert.equal(release.releaseRequestId, stopReleaseRequestId(operationId));
    const game = Game.fromEvents(logged);
    assert.equal(game.stoppedClock, null);
    assert.equal(game.adjudication, null);
    assert.equal(game.status.over, false);

    // Nothing is left: another pass finds no work.
    const idle = await worker(store, clock, published).runPass();
    assert.deepEqual({ settled: idle.settled, released: idle.released, skipped: idle.skipped }, { settled: 0, released: 0, skipped: 0 });
  });
});

pgTest('racing workers settle one operation exactly once', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const other = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool, players, FEN_MATE1);
    await startMove(store, gameId, 'e7e4', 'w', 1100);
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const [a, b] = await Promise.all([worker(store, clock, published).runPass(), worker(other, clock, published).runPass()]);
    assert.equal(a.settled + b.settled, 1);
    assert.equal(a.failed + b.failed, 0);
    assert.equal(published.filter((c) => c.kind === 'settled').length, 1);
    assert.equal(published.filter((c) => c.kind === 'released').length >= 1, true);
    const types = (await events(pool, gameId)).map((e) => e.type);
    assert.equal(types.filter((t) => t === 'AdjudicationResolved').length, 1);
    assert.equal(types.filter((t) => t === 'AdjudicationClocksStarted').length, 1);
  });
});

pgTest('a worker that dies mid-proof is replaced by a successor once its lease lapses', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const gameId = await createGame(pool, players, FEN_MATE1);
    const dying = new PgAdjudicationStore(pool);
    const operationId = await startMove(dying, gameId, 'e7e4', 'w', 1100);
    // The first executor claims and then vanishes (its process, and proof job, are gone).
    await dying.claimAdjudication({
      gameId, operationId, executorId: randomUUID(), expectedGeneration: '0', leaseMs: 1_000,
      intent: PgAdjudicationStore.newClaimIntent(),
    });
    const successor = new PgAdjudicationStore(pool);
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const early = await worker(successor, clock, published).runPass();
    assert.equal(early.settled, 0, 'a live lease is not taken over');
    // Leases are database time: wait the lease out rather than forging it.
    for (let i = 0; i < 50; i++) {
      const r = await successor.reconcileAdjudication(gameId, operationId);
      if (r.status === 'proving' && r.leaseStatus === 'expired') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const late = await worker(successor, clock, published).runPass();
    assert.equal(late.settled, 1);
    const row = (await pool.query('SELECT completed_generation::text AS g FROM game_adjudications WHERE operation_id = $1', [operationId])).rows[0];
    assert.equal(row.g, '2', 'the successor settled at a higher generation');
  });
});

pgTest('an exhausted proof settles as unresolved: the move applies and no draw is declared', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool, players);
    await startMove(store, gameId, 'e2e4', 'w', 1100);
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const pass = await worker(store, clock, published, { sliceBudget: 50_000 }).runPass();
    assert.equal(pass.settled, 1);
    const logged = await events(pool, gameId);
    const resolved = logged.find((e) => e.type === 'AdjudicationResolved') as Extract<GameEvent, { type: 'AdjudicationResolved' }>;
    assert.ok(resolved);
    assert.match(JSON.stringify(resolved), /"unresolved"/);
    assert.equal(logged.some((e) => e.type === 'GameEnded'), false);
    const game = Game.fromEvents(logged);
    assert.equal(game.status.over, false);
    assert.equal(game.ply, 1, 'the move applied');
  });
});

/** A pool whose COMMIT of an event-writing transaction fails (after rolling back) while `failures` is positive. */
function failingCommits(pool: Pool, state: { failures: number }): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') return target.query.bind(target);
      if (prop !== 'connect') return Reflect.get(target, prop, receiver);
      return async () => {
        const client = await target.connect();
        let wroteEvents = false;
        return new Proxy(client, {
          get(c, p, r) {
            if (p !== 'query') return Reflect.get(c, p, r);
            return async (sql: unknown, ...rest: unknown[]) => {
              if (sql === 'BEGIN') wroteEvents = false;
              if (typeof sql === 'string' && /INSERT INTO\s+game_events/i.test(sql)) wroteEvents = true;
              if (sql === 'COMMIT' && wroteEvents && state.failures > 0) {
                state.failures -= 1;
                await c.query('ROLLBACK');
                throw new Error('connection lost at COMMIT');
              }
              return (c.query as (...a: unknown[]) => unknown).call(c, sql, ...rest);
            };
          },
        });
      };
    },
  }) as Pool;
}

pgTest('a settlement whose writes fail is settled later as evaluated, without proving again', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const gameId = await createGame(pool, players, FEN_MATE1);
    await startMove(new PgAdjudicationStore(pool), gameId, 'e7e4', 'w', 1100);
    // One store (one process): claim succeeds, then every settlement write fails for this pass.
    const faults = { failures: 0 };
    const store = new PgAdjudicationStore(failingCommits(pool, faults));
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const w = worker(store, clock, published, { leaseMs: 1_000 });
    const settle = store.settleAdjudication.bind(store);
    store.settleAdjudication = async (params) => {
      faults.failures = 1;
      return settle(params);
    };
    const failed = await w.runPass();
    assert.equal(failed.failed, 1);
    const evaluatedAt = store.retainedResolutionAt(gameId, (await pool.query('SELECT operation_id FROM game_adjudications WHERE game_id = $1', [gameId])).rows[0].operation_id);
    assert.equal(evaluatedAt, 1200, 'the evaluation is retained');
    store.settleAdjudication = settle;
    // Wait out the database-time lease, then the same process settles with the retained instant.
    for (let i = 0; i < 50; i++) {
      const rows = await pool.query(`SELECT 1 FROM game_adjudications WHERE game_id = $1 AND lease_until <= clock_timestamp()`, [gameId]);
      if (rows.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    clock.now = 5000;
    const later = await w.runPass();
    assert.equal(later.settled, 1);
    const row = (await pool.query(`SELECT completed_generation::text AS g, settlement_receipt FROM game_adjudications WHERE game_id = $1`, [gameId])).rows[0];
    assert.equal(row.g, '2');
    assert.equal(row.settlement_receipt.resolvedEvent.at, 1200, 'settled at the instant first evaluated');
  });
});

pgTest('a stop waits out the grace period; a blocked game never starves the stops behind it', async () => {
  await withTestDatabase(async ({ pool }) => {
    const players = await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const first = await createGame(pool, players, FEN_MATE1);
    const second = await createGame(pool, players, FEN_MATE1);
    await startMove(store, first, 'e7e4', 'w', 1100);
    await startMove(store, second, 'e7e4', 'w', 1100);
    const clock = { now: 1200 };
    const published: AdjudicationChange[] = [];
    const pass = await worker(store, clock, published, { releaseGraceMs: 60_000 }).runPass();
    assert.deepEqual({ settled: pass.settled, released: pass.released }, { settled: 2, released: 0 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_adjudications WHERE is_current_stop')).rows[0].n, 2);

    // With a one-stop page, the older stop's game excluded, the newer one is still released.
    const stops = await store.listReleasableStops(1, 0, [first]);
    assert.deepEqual(stops.map((s) => s.gameId), [second]);
    assert.deepEqual((await store.listReleasableStops(1, 0, [])).map((s) => s.gameId), [first]);
  });
});
