/**
 * Pregame lifecycle storage against real PostgreSQL (ADR-0148): migration 0042, the trigger-kept
 * `pregame_deadlines` queue, readiness and no-show endings in the games projection, and the log's
 * sequence check deciding a first move against an expiry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameEvent, type GameSource, type TimeControl } from '@chess-platform/game';
import { uuidv7 } from '../src';
import { migrate } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgUsersRepository } from '../src/pg/repositories';
import { PgGamesProjector } from '../src/pg/games-projector';
import { PgNoShowCandidates } from '../src/pg/no-show-candidates';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), 'migrations');
const TC: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
const DEADLINE: Record<GameSource, number> = { seek: 60_000, tournament: 300_000 };

async function users(pool: Pool, n: number): Promise<string[]> {
  const repo = new PgUsersRepository(pool);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = uuidv7();
    await repo.create({ id, handle: `pg_${id.slice(-12)}` });
    ids.push(id);
  }
  return ids;
}

async function create(store: PostgresEventStore, white: string, black: string, at: number, source?: GameSource): Promise<string> {
  const gameId = uuidv7();
  const { events } = Game.create({
    gameId, timeControl: TC, players: { white, black }, rated: true, at,
    ...(source ? { source, noShowAfterMs: DEADLINE[source] } : {}),
  });
  await store.append(gameId, -1, events);
  return gameId;
}

/** Apply a domain step to the stored stream, the way the authority appends. */
async function step(store: PostgresEventStore, gameId: string, fn: (game: Game) => { events: GameEvent[] }): Promise<void> {
  const stored = await store.load(gameId);
  const result = fn(Game.fromEvents(stored.map((e) => e.event)));
  await store.append(gameId, stored.at(-1)!.seq, result.events);
}

async function queue(pool: Pool): Promise<Array<{ game_id: string; due_at: Date }>> {
  return (await pool.query<{ game_id: string; due_at: Date }>('SELECT game_id, due_at FROM pregame_deadlines ORDER BY due_at, game_id')).rows;
}

async function project(pool: Pool): Promise<void> {
  const projector = new PgGamesProjector(pool);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const batch = await projector.runBatch();
    const pending = (await pool.query<{ pending: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM game_events e, projection_checkpoints c
        WHERE c.projection = 'games' AND (e.xact_id, e.game_id, e.seq) > (c.xact_id, c.game_id, c.seq)) AS pending`,
    )).rows[0]!.pending;
    if (!batch.busy && !batch.more && !pending) return;
    if (Date.now() > deadline) throw new Error('projection did not catch up');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('migration 0042 adds the no_show termination and the trigger-kept queue with its scan index', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    assert.deepEqual((await pool.query(`SELECT is_draw FROM terminations WHERE code = 'no_show'`)).rows, [{ is_draw: false }]);
    const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'pregame_deadlines_track' AND NOT tgisinternal`);
    assert.equal(trigger.rowCount, 1);
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT game_id, due_at FROM pregame_deadlines
         WHERE due_at <= $1 AND (due_at, game_id) > ($2::timestamptz, $3::uuid) ORDER BY due_at, game_id LIMIT 50`,
        [new Date(T0), new Date(0), '00000000-0000-0000-0000-000000000000'],
      );
      assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /pregame_deadlines_due_idx/);
    } finally {
      client.release();
    }
  });
});

test('a sourced creation enters the queue at its own deadline; readiness keeps it; the first move or an ending removes it', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const seek = await create(store, w!, b!, T0, 'seek');
    const tournament = await create(store, w!, b!, T0 + 1, 'tournament');
    const legacy = await create(store, w!, b!, T0 + 2);
    assert.deepEqual(await queue(pool), [
      { game_id: seek, due_at: new Date(T0 + 60_000) },
      { game_id: tournament, due_at: new Date(T0 + 1 + 300_000) },
    ], 'a game without a source never enters the queue');
    void legacy;

    await step(store, seek, (g) => g.markReady('w', T0 + 10));
    await step(store, seek, (g) => g.markReady('b', T0 + 11));
    assert.equal((await queue(pool)).length, 2, 'readiness does not remove a game');
    await step(store, seek, (g) => g.playMove('e2e4', T0 + 20));
    await step(store, seek, (g) => g.playMove('e7e5', T0 + 30));
    assert.deepEqual((await queue(pool)).map((r) => r.game_id), [tournament], 'the first move removed it');
    await step(store, tournament, (g) => g.expireNoShow(T0 + 1 + 300_000));
    assert.deepEqual(await queue(pool), [], 'the ending removed it');
  });
});

test('only a deadline the game aggregate accepts is queued; anything malformed is skipped without rejecting the append', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const base = Game.create({ gameId: uuidv7(), timeControl: TC, players: { white: 'x', black: 'y' }, at: T0 }).events[0]!;
    const malformed: Array<Record<string, unknown>> = [
      { source: 'seek', noShowAfterMs: 'soon' },
      { source: 'seek', noShowAfterMs: 0 },
      { source: 'seek', noShowAfterMs: -60000 },
      { source: 'seek', noShowAfterMs: 1.5 },
      { source: 'seek', noShowAfterMs: 2 ** 53 },
      { noShowAfterMs: 60000 },
      { source: 'lobby', noShowAfterMs: 60000 },
      { source: 'tournament' },
      { source: 'seek', noShowAfterMs: 60000, at: null },
      { source: 'seek', noShowAfterMs: 60000, at: 'now' },
    ];
    for (const fields of malformed) {
      const gameId = uuidv7();
      await pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
        [gameId, JSON.stringify({ ...base, gameId, ...fields })],
      );
      // The domain refuses each of these on replay, so queueing one would fail every worker pass.
      assert.throws(() => Game.fromEvents([{ ...base, gameId, ...fields } as unknown as GameEvent]), JSON.stringify(fields));
    }
    assert.deepEqual(await queue(pool), [], 'no malformed creation entered the queue');
    const valid = uuidv7();
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
      [valid, JSON.stringify({ ...base, gameId: valid, source: 'tournament', noShowAfterMs: 300000 })],
    );
    assert.deepEqual(await queue(pool), [{ game_id: valid, due_at: new Date(T0 + 300_000) }]);
  });
});

test('due pages are keyset-ordered by deadline and a dismissed game leaves the queue', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const candidates = new PgNoShowCandidates(pool);
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(await create(store, w!, b!, T0 + i, 'seek'));
    const tournament = await create(store, w!, b!, T0, 'tournament');
    assert.deepEqual(await candidates.due({ dueBy: new Date(T0 + 59_999), after: null, limit: 10 }), []);
    const first = await candidates.due({ dueBy: new Date(T0 + 60_002), after: null, limit: 2 });
    const second = await candidates.due({ dueBy: new Date(T0 + 60_002), after: { dueAt: first.at(-1)!.dueAt, gameId: first.at(-1)!.gameId }, limit: 2 });
    assert.deepEqual([...first, ...second].map((c) => c.gameId), ids, 'tournament games are not due after one minute');
    assert.deepEqual((await candidates.due({ dueBy: new Date(T0 + 300_000), after: null, limit: 10 })).map((c) => c.gameId), [...ids, tournament]);
    await candidates.dismiss(tournament);
    assert.ok(!(await queue(pool)).some((r) => r.game_id === tournament));
  });
});

test('readiness projects without plies and a no-show ending projects result, cause and end time', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const game = await create(store, w!, b!, T0, 'tournament');
    await step(store, game, (g) => g.markReady('w', T0 + 1));
    await step(store, game, (g) => g.expireNoShow(T0 + 300_000));
    await project(pool);
    const row = (await pool.query('SELECT ply_count, last_seq, result, termination, ended_at FROM games WHERE id = $1', [game])).rows[0];
    assert.deepEqual(row, { ply_count: 0, last_seq: 2, result: '1-0', termination: 'no_show', ended_at: new Date(T0 + 300_000) });
    await new PgGamesProjector(pool).rebuildAll();
    assert.deepEqual((await pool.query('SELECT ply_count, last_seq, result, termination, ended_at FROM games WHERE id = $1', [game])).rows[0], row, 'rebuild is idempotent');
  });
});

test('games created before migration 0042 never enter the queue and replay exactly as before', { skip }, async () => {
  const before = mkdtempSync(join(tmpdir(), 'pre-0042-'));
  try {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f < '0042')) cpSync(join(MIGRATIONS, file), join(before, file));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, before);
      const [w, b] = await users(pool, 2);
      const store = new PostgresEventStore(pool);
      const old = await create(store, w!, b!, T0);
      assert.equal(await migrate(pool, MIGRATIONS), 1, 'only 0042');
      assert.deepEqual(await queue(pool), []);
      const replayed = Game.fromEvents((await store.load(old)).map((e) => e.event)).snapshot();
      assert.equal(replayed.clock.turnStartedAt, T0, 'the clock is still anchored at creation');
      assert.equal(replayed.source, null);
      await step(store, old, (g) => g.playMove('e2e4', T0 + 5_000));
      const move = (await store.load(old)).at(-1)!.event;
      assert.ok(move.type === 'MovePlayed' && move.moveTimeMs === 5_000, 'its first move is charged from creation, as before');
    });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
});

test('a first move and an expiry decided from one head are settled by the log\'s sequence check', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const game = await create(store, w!, b!, T0, 'seek');
    await step(store, game, (g) => g.markReady('w', T0 + 1));
    await step(store, game, (g) => g.markReady('b', T0 + 2));
    const head = (await store.load(game)).at(-1)!.seq;
    const base = Game.fromEvents((await store.load(game)).map((e) => e.event));
    const results = await Promise.allSettled([
      store.append(game, head, base.playMove('e2e4', T0 + 59_999).events),
      store.append(game, head, base.expireNoShow(T0 + 60_000).events),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await store.load(game)).length, 4);

    // A stale writer arriving after the winner committed, as a lagging owner would.
    const stale = await create(store, w!, b!, T0, 'seek');
    await step(store, stale, (g) => g.markReady('w', T0 + 1));
    await step(store, stale, (g) => g.markReady('b', T0 + 2));
    const staleHead = (await store.load(stale)).at(-1)!.seq;
    const staleCopy = Game.fromEvents((await store.load(stale)).map((e) => e.event));
    await store.append(stale, staleHead, staleCopy.expireNoShow(T0 + 60_000).events);
    await assert.rejects(store.append(stale, staleHead, staleCopy.playMove('e2e4', T0 + 59_999).events));
    assert.deepEqual((await store.load(stale)).map((e) => e.event.type), ['GameCreated', 'PlayerReady', 'PlayerReady', 'GameEnded']);
  });
});
