/** The event-log-driven `games` projection against real PostgreSQL (ADR-0147). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { registerUpcaster, uuidv7 } from '../src';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgGameStarter, PgSeekAcceptor, PgSeeksRepository, PgUsersRepository } from '../src/pg/repositories';
import { PgGamesProjector } from '../src/pg/games-projector';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), 'migrations');
const BLITZ: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };
const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

interface Row {
  variant: string; rated: boolean; speed: string; white_id: string | null; black_id: string | null;
  result: string | null; termination: string | null; ply_count: number; last_seq: number;
  started_at: Date; ended_at: Date | null;
}

async function gameRow(pool: Pool, id: string): Promise<Row | undefined> {
  return (await pool.query<Row>(
    `SELECT variant, rated, speed, white_id, black_id, result, termination, ply_count, last_seq, started_at, ended_at
     FROM games WHERE id = $1`, [id],
  )).rows[0];
}

async function newUsers(pool: Pool, n: number): Promise<string[]> {
  const repo = new PgUsersRepository(pool);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = uuidv7();
    await repo.create({ id, handle: `proj_${id.slice(-12)}` });
    ids.push(id);
  }
  return ids;
}

function creation(gameId: string, white: string, black: string, at = 1_000): GameEvent[] {
  return Game.create({ gameId, variant: 'standard', timeControl: BLITZ, players: { white, black }, rated: true, at }).events;
}

/** Append plies one transaction at a time, the way the authority does. Returns the new head. */
async function play(store: PostgresEventStore, gameId: string, ucis: readonly string[], at = 2_000): Promise<number> {
  const stored = await store.load(gameId);
  let game = Game.fromEvents(stored.map((e) => e.event));
  let head = stored.at(-1)!.seq;
  for (const [i, uci] of ucis.entries()) {
    const step = game.playMove(uci, at + i);
    head = await store.append(gameId, head, step.events);
    game = step.game;
  }
  return head;
}

/** Whether the checkpoint has passed every committed event. */
async function caughtUp(pool: Pool): Promise<boolean> {
  return !(await pool.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM game_events e, projection_checkpoints c
       WHERE c.projection = 'games' AND (e.xact_id, e.game_id, e.seq) > (c.xact_id, c.game_id, c.seq)
     ) AS pending`,
  )).rows[0]!.pending;
}

/**
 * Project until caught up. The horizon is cluster-wide, so a transaction in any other database on the
 * test server can hold it back for a moment; that delays projection and must not fail the test.
 */
async function drain(projector: PgGamesProjector, pool: Pool): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  const endings: string[] = [];
  for (;;) {
    const batch = await projector.runBatch();
    endings.push(...batch.endings.map((e) => e.gameId));
    if (batch.busy || batch.more) continue;
    if (await caughtUp(pool)) return endings;
    if (Date.now() > deadline) throw new Error('projection did not catch up within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until every committed event is below the horizon, so one batch can see all of them. */
async function settle(pool: Pool): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await pool.query<{ ok: boolean }>(
    `SELECT pg_snapshot_xmin(pg_current_snapshot())
       > COALESCE((SELECT xact_id FROM game_events ORDER BY xact_id DESC LIMIT 1), '0'::xid8) AS ok`,
  )).rows[0]!.ok) {
    if (Date.now() > deadline) throw new Error('the transaction horizon did not advance within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function checkpoint(pool: Pool): Promise<{ xact_id: string; game_id: string; seq: number }> {
  return (await pool.query<{ xact_id: string; game_id: string; seq: number }>(
    `SELECT xact_id::text AS xact_id, game_id, seq FROM projection_checkpoints WHERE projection = 'games'`,
  )).rows[0]!;
}

test('a directly appended creation-only stream gains a correct row', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const gameId = uuidv7();
    await new PostgresEventStore(pool).append(gameId, -1, creation(gameId, white!, black!, 1_234));
    assert.equal(await gameRow(pool, gameId), undefined, 'the direct/authority path writes no row itself');

    await drain(new PgGamesProjector(pool), pool);
    assert.deepEqual(await gameRow(pool, gameId), {
      variant: 'standard', rated: true, speed: 'blitz', white_id: white, black_id: black,
      result: null, termination: null, ply_count: 0, last_seq: 0, started_at: new Date(1_234), ended_at: null,
    });
  });
});

test('seats that are not registered accounts project as NULL instead of failing the stream', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const gameId = uuidv7();
    await new PostgresEventStore(pool).append(gameId, -1, creation(gameId, 'harness-alice', uuidv7()));
    await settle(pool);
    const batch = await new PgGamesProjector(pool).runBatch();
    assert.deepEqual(batch.failures, []);
    const row = await gameRow(pool, gameId);
    assert.equal(row?.white_id, null);
    assert.equal(row?.black_id, null);
  });
});

test('moves update progress, the ending projects result, termination and end time, and is reported once', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const projector = new PgGamesProjector(pool);
    const gameId = uuidv7();
    await store.append(gameId, -1, creation(gameId, white!, black!));
    await play(store, gameId, FOOLS_MATE.slice(0, 2));
    await drain(projector, pool);
    let row = await gameRow(pool, gameId);
    assert.equal(row?.ply_count, 2);
    assert.equal(row?.last_seq, 2);
    assert.equal(row?.ended_at, null);

    const head = await play(store, gameId, FOOLS_MATE.slice(2), 5_000);
    const endings = await drain(projector, pool);
    row = await gameRow(pool, gameId);
    assert.equal(row?.ply_count, 4);
    assert.equal(row?.last_seq, head);
    assert.equal(row?.result, '0-1');
    assert.equal(row?.termination, 'checkmate');
    assert.deepEqual(row?.ended_at, new Date(5_001), 'end time is the GameEnded timestamp, not projection time');
    assert.deepEqual(endings, [gameId], 'the ending is reported once');

    await pool.query(`UPDATE projection_checkpoints SET xact_id = '0', game_id = '00000000-0000-0000-0000-000000000000', seq = -1`);
    assert.deepEqual(await drain(projector, pool), [], 'a replayed ending is not reported again');
    assert.deepEqual((await projector.rebuildAll()).endings, [], 'nor by a rebuild');
  });
});

test('seek-created rows are reconciled, follow progress, and the ended-game seek receipt guard becomes truthful', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [creator, acceptor] = await newUsers(pool, 2);
    const seeks = new PgSeeksRepository(pool);
    const seek = await seeks.create({ id: uuidv7(), creatorId: creator!, variant: 'standard', timeControl: BLITZ, rated: true });
    const gameId = uuidv7();
    await new PgSeekAcceptor(pool).accept(seek.id, gameId, creation(gameId, creator!, acceptor!, 7_000), {
      id: gameId, variant: 'standard', rated: true, speed: 'blitz', whiteId: creator!, blackId: acceptor!, startedAt: new Date(7_000),
    });
    const inserted = await gameRow(pool, gameId);
    const projector = new PgGamesProjector(pool);
    await drain(projector, pool);
    assert.deepEqual(await gameRow(pool, gameId), inserted, 'projection agrees with the row the seek transaction wrote');

    const receipt = async () => (await seeks.listOpen(10, creator)).some((s) => s.gameId === gameId);
    assert.equal(await receipt(), true, 'the creator is redirected to the live game');
    await play(new PostgresEventStore(pool), gameId, FOOLS_MATE, 8_000);
    assert.equal(await receipt(), true, 'before projection the guard still sees an unfinished game');
    await drain(projector, pool);
    assert.equal(await receipt(), false, 'once the ending is projected the creator is not sent to a finished game');
    assert.equal((await gameRow(pool, gameId))?.ply_count, 4);
  });
});

test('bot-started rows are reconciled and follow progress', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [human, bot] = await newUsers(pool, 2);
    const gameId = uuidv7();
    const events = Game.create({ gameId, variant: 'standard', timeControl: BLITZ, players: { white: human!, black: bot! }, rated: false, at: 3_000 }).events;
    assert.equal(await new PgGameStarter(pool).start(gameId, events, {
      id: gameId, variant: 'standard', rated: false, speed: 'blitz', whiteId: human!, blackId: bot!, startedAt: new Date(3_000),
    }), true);
    const inserted = await gameRow(pool, gameId);
    await drain(new PgGamesProjector(pool), pool);
    assert.deepEqual(await gameRow(pool, gameId), inserted);

    await play(new PostgresEventStore(pool), gameId, ['e2e4', 'e7e5']);
    await drain(new PgGamesProjector(pool), pool);
    const row = await gameRow(pool, gameId);
    assert.equal(row?.rated, false);
    assert.equal(row?.ply_count, 2);
    assert.equal(row?.last_seq, 2);
  });
});

test('replay is idempotent: repeated batches and rebuilds leave identical rows and one row per game', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) await store.append(id, -1, creation(id, white!, black!));
    await play(store, ids[0]!, FOOLS_MATE);
    await play(store, ids[1]!, ['e2e4']);
    const projector = new PgGamesProjector(pool, { batchSize: 2 });
    await drain(projector, pool);
    const snapshot = async () => (await pool.query('SELECT * FROM games ORDER BY id')).rows;
    const first = await snapshot();
    assert.equal(first.length, 3);

    await pool.query(`UPDATE projection_checkpoints SET xact_id = '0', game_id = '00000000-0000-0000-0000-000000000000', seq = -1`);
    await drain(projector, pool);
    await projector.rebuildAll();
    await projector.rebuildAll();
    assert.deepEqual(await snapshot(), first);
  });
});

test('a fold of an older sequence can never regress a newer row', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const gameId = uuidv7();
    await store.append(gameId, -1, creation(gameId, white!, black!));
    await play(store, gameId, ['e2e4']);
    const projector = new PgGamesProjector(pool);
    await drain(projector, pool);
    // Stand-in for a row some newer fold already wrote: every log-derived field is ahead of this log.
    await pool.query(
      `UPDATE games SET last_seq = 50, ply_count = 49, result = '1-0', termination = 'resignation', ended_at = now() WHERE id = $1`,
      [gameId],
    );
    const ahead = await gameRow(pool, gameId);
    await pool.query(`UPDATE projection_checkpoints SET xact_id = '0', game_id = '00000000-0000-0000-0000-000000000000', seq = -1`);
    await drain(projector, pool);
    await projector.rebuildAll();
    assert.deepEqual(await gameRow(pool, gameId), ahead);
  });
});

test('rebuild creates missing rows and repairs stale progress and missing results', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const missing = uuidv7();
    const stale = uuidv7();
    await store.append(missing, -1, creation(missing, white!, black!));
    await store.append(stale, -1, creation(stale, white!, black!));
    await play(store, stale, FOOLS_MATE);
    const projector = new PgGamesProjector(pool);
    await drain(projector, pool);
    const truth = await gameRow(pool, stale);
    // Reproduce what main left behind: a missing row and a creation-time row that never advanced,
    // with the checkpoint already past both so the live path will not revisit them.
    await pool.query('DELETE FROM games WHERE id = $1', [missing]);
    await pool.query(`UPDATE games SET ply_count = 0, last_seq = 0, result = NULL, termination = NULL, ended_at = NULL WHERE id = $1`, [stale]);
    assert.equal((await projector.runBatch()).projected, 0);

    const rebuilt = await projector.rebuildAll();
    assert.equal(rebuilt.projected, 2);
    assert.equal((await gameRow(pool, missing))?.last_seq, 0);
    assert.deepEqual(await gameRow(pool, stale), truth);
  });
});

test('a rebuild leaves a game the live projector has yet to reach, so its ending is still reported once', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const settledGame = uuidv7();
    const finishing = uuidv7();
    await store.append(settledGame, -1, creation(settledGame, white!, black!));
    await store.append(finishing, -1, creation(finishing, white!, black!));
    const projector = new PgGamesProjector(pool);
    await drain(projector, pool);
    await pool.query('DELETE FROM games WHERE id = $1', [settledGame]);
    await play(store, finishing, FOOLS_MATE);

    const rebuilt = await projector.rebuildAll();
    assert.equal(rebuilt.projected, 1, 'the game the checkpoint already passed is repaired');
    assert.equal(rebuilt.deferred, 1);
    assert.equal((await gameRow(pool, settledGame))?.last_seq, 0);
    assert.equal((await gameRow(pool, finishing))?.ended_at, null, 'the unreached ending is not absorbed by the rebuild');
    assert.deepEqual(await drain(projector, pool), [finishing], 'the live batch reports it');
    assert.equal((await gameRow(pool, finishing))?.result, '0-1');
  });
});

test('streams written before migration 0040 are projected by the first pass without an operator step', { skip }, async () => {
  const before = mkdtempSync(join(tmpdir(), 'pre-0040-'));
  try {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f < '0040')) cpSync(join(MIGRATIONS, file), join(before, file));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, before);
      const [white, black] = await newUsers(pool, 2);
      const store = new PostgresEventStore(pool);
      const legacy = uuidv7();
      await store.append(legacy, -1, creation(legacy, white!, black!));
      await play(store, legacy, FOOLS_MATE);

      assert.equal(await migrate(pool, MIGRATIONS), 2, '0040 and the online index 0041');
      await drain(new PgGamesProjector(pool), pool);
      const row = await gameRow(pool, legacy);
      assert.equal(row?.result, '0-1');
      assert.equal(row?.last_seq, 5);
      await assert.rejects(pool.query('UPDATE game_events SET seq = seq WHERE game_id = $1', [legacy]), /append-only/,
        'the append-only guard survives the column rewrite');
    });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
});

test('the checkpoint lock admits one projector; concurrent projectors converge and report each ending once', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const store = new PostgresEventStore(pool);
    const gameIds: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const id = uuidv7();
      gameIds.push(id);
      await store.append(id, -1, creation(id, white!, black!));
      await play(store, id, i % 2 === 0 ? FOOLS_MATE : ['e2e4', 'e7e5']);
    }

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM projection_checkpoints WHERE projection = 'games' FOR UPDATE`);
      const blocked = await new PgGamesProjector(pool).runBatch();
      assert.equal(blocked.busy, true);
      assert.equal(blocked.projected, 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    const pools = [createPool({ connectionString, max: 3 }), createPool({ connectionString, max: 3 })];
    try {
      const endings: string[] = [];
      await Promise.all(pools.map(async (p) => {
        const projector = new PgGamesProjector(p, { batchSize: 7 });
        for (;;) {
          const batch = await projector.runBatch();
          endings.push(...batch.endings.map((e) => e.gameId));
          if (!batch.busy && !batch.more && await caughtUp(pool)) return;
          if (!batch.more) await new Promise((r) => setTimeout(r, 1));
        }
      }));
      assert.deepEqual(endings.sort(), gameIds.filter((_, i) => i % 2 === 0).sort(), 'each ending reported by exactly one replica');
      for (const [i, id] of gameIds.entries()) {
        const row = await gameRow(pool, id);
        assert.equal(row?.ply_count, i % 2 === 0 ? 4 : 2);
        assert.equal(row?.result, i % 2 === 0 ? '0-1' : null);
      }
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});

test('a batch that dies before commit leaves no projection and no checkpoint movement; restart resumes', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const gameId = uuidv7();
    await new PostgresEventStore(pool).append(gameId, -1, creation(gameId, white!, black!));
    await settle(pool);
    const before = await checkpoint(pool);
    // Fail at the last statement of the batch, after the projection write succeeded.
    await pool.query(`CREATE FUNCTION crash() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated crash'; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER crash BEFORE UPDATE ON projection_checkpoints FOR EACH ROW EXECUTE FUNCTION crash()');
    const projector = new PgGamesProjector(pool);
    await assert.rejects(projector.runBatch(), /simulated crash/);
    assert.equal(await gameRow(pool, gameId), undefined, 'the projection write rolled back with the checkpoint');
    assert.deepEqual(await checkpoint(pool), before);

    await pool.query('DROP TRIGGER crash ON projection_checkpoints');
    await drain(projector, pool);
    assert.equal((await gameRow(pool, gameId))?.last_seq, 0);
  });
});

test('an event whose transaction commits after a later-started one is never skipped', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const early = uuidv7();
    const late = uuidv7();
    const slow = await pool.connect();
    try {
      // Transaction A takes its id first and stays open; B starts later and commits first.
      await slow.query('BEGIN');
      await slow.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
        [early, JSON.stringify(creation(early, white!, black!)[0])],
      );
      await new PostgresEventStore(pool).append(late, -1, creation(late, white!, black!));
      const projector = new PgGamesProjector(pool);
      const blocked = await projector.runBatch();
      assert.equal(blocked.projected, 0, 'nothing at or above the oldest running transaction is consumed');
      assert.equal(await gameRow(pool, late), undefined);

      await slow.query('COMMIT');
      await drain(projector, pool);
      assert.equal((await gameRow(pool, early))?.last_seq, 0, 'the late-committing lower transaction was projected');
      assert.equal((await gameRow(pool, late))?.last_seq, 0);
    } finally {
      slow.release();
    }
  });
});

test('an unreadable stream is recorded and retried with backoff, never blocks other games, and recovers', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const corrupt = uuidv7();
    const healthy = uuidv7();
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 99, $2::jsonb)`,
      [corrupt, JSON.stringify(creation(corrupt, white!, black!)[0])],
    );
    await new PostgresEventStore(pool).append(healthy, -1, creation(healthy, white!, black!));
    const projector = new PgGamesProjector(pool);

    await settle(pool);
    const batch = await projector.runBatch();
    assert.deepEqual(batch.failures.map((f) => f.gameId), [corrupt]);
    assert.match(batch.failures[0]!.error, /no upcaster registered for event GameCreated@99/);
    assert.equal((await gameRow(pool, healthy))?.last_seq, 0, 'the healthy game is projected in the same batch');
    assert.equal(await gameRow(pool, corrupt), undefined);
    const failure = async () => (await pool.query<{ attempts: number; due: boolean }>(
      'SELECT attempts, retry_at <= now() AS due FROM games_projection_failures WHERE game_id = $1', [corrupt],
    )).rows[0];
    assert.deepEqual(await failure(), { attempts: 1, due: false });

    assert.deepEqual((await projector.runBatch()).failures, [], 'not retried before its backoff expires');
    await pool.query(`UPDATE games_projection_failures SET retry_at = now() - interval '1 second'`);
    assert.equal((await projector.runBatch()).failures.length, 1);
    assert.deepEqual(await failure(), { attempts: 2, due: false });

    // The stream becomes readable (a deploy registers the missing upcaster); the durable record brings it back.
    registerUpcaster('GameCreated', 99, (payload) => payload as GameEvent);
    await pool.query(`UPDATE games_projection_failures SET retry_at = now() - interval '1 second'`);
    const recovered = await projector.runBatch();
    assert.deepEqual(recovered.failures, []);
    assert.equal((await gameRow(pool, corrupt))?.last_seq, 0);
    assert.equal(await failure(), undefined);
  });
});

test('a checkpoint from another cluster\'s transaction ids rewinds instead of skipping new events', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await newUsers(pool, 2);
    const gameId = uuidv7();
    await pool.query(`UPDATE projection_checkpoints SET xact_id = '9000000000000' WHERE projection = 'games'`);
    await new PostgresEventStore(pool).append(gameId, -1, creation(gameId, white!, black!));
    await settle(pool);
    const batch = await new PgGamesProjector(pool).runBatch();
    assert.equal(batch.rewound, true);
    assert.equal((await gameRow(pool, gameId))?.last_seq, 0);
    assert.notEqual((await checkpoint(pool)).xact_id, '9000000000000');
  });
});
