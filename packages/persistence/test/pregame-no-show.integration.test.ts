/**
 * Pregame lifecycle storage against real PostgreSQL (ADR-0148): the migrations, the projected source,
 * readiness and no-show endings in the games projection, and the bounded candidate scan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameSource, type TimeControl } from '@chess-platform/game';
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
    gameId, timeControl: TC, players: { white, black }, rated: true, at, ...(source ? { source } : {}),
  });
  await store.append(gameId, -1, events);
  return gameId;
}

/** Apply a domain step to the stored stream, the way the authority appends. */
async function step(store: PostgresEventStore, gameId: string, fn: (game: Game) => { events: import('@chess-platform/game').GameEvent[] }): Promise<void> {
  const stored = await store.load(gameId);
  const result = fn(Game.fromEvents(stored.map((e) => e.event)));
  await store.append(gameId, stored.at(-1)!.seq, result.events);
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

async function row(pool: Pool, id: string) {
  return (await pool.query<{ source: string | null; ply_count: number; last_seq: number; result: string | null; termination: string | null; ended_at: Date | null }>(
    'SELECT source, ply_count, last_seq, result, termination, ended_at FROM games WHERE id = $1', [id],
  )).rows[0];
}

const due = (candidates: PgNoShowCandidates, now: number) => candidates.due({
  seekDueBy: new Date(now - 60_000), tournamentDueBy: new Date(now - 300_000), after: null, limit: 100,
});

test('migrations add the no_show termination, a validated source constraint and the partial pending index', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const termination = await pool.query(`SELECT is_draw FROM terminations WHERE code = 'no_show'`);
    assert.deepEqual(termination.rows, [{ is_draw: false }]);
    const check = await pool.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'games_source_check'`,
    );
    assert.deepEqual(check.rows, [{ convalidated: true }]);
    const index = await pool.query<{ indexdef: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'games_pregame_pending_idx'`,
    );
    assert.equal(index.rows[0]?.valid, true);
    assert.match(index.rows[0]!.indexdef, /\(started_at, id\) WHERE \(\(source IS NOT NULL\) AND \(result IS NULL\) AND \(ply_count = 0\)\)/);
    await assert.rejects(
      pool.query(`INSERT INTO games (id, variant, rated, speed, started_at, source) VALUES ($1, 'standard', true, 'blitz', now(), 'lobby')`, [uuidv7()]),
      /games_source_check/,
    );
  });
});

test('the candidate scan is served by the partial pending index', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const client = await pool.connect();
    try {
      // A tiny table would be scanned sequentially anyway; forbid that to see which index answers.
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id, source, started_at FROM games
         WHERE source IS NOT NULL AND result IS NULL AND ply_count = 0
           AND started_at <= GREATEST($1::timestamptz, $2::timestamptz)
           AND ((source = 'seek' AND started_at <= $1) OR (source = 'tournament' AND started_at <= $2))
           AND (started_at, id) > ($3::timestamptz, $4::uuid)
         ORDER BY started_at, id LIMIT 50`,
        [new Date(T0), new Date(T0), new Date(0), '00000000-0000-0000-0000-000000000000'],
      );
      assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /games_pregame_pending_idx/);
    } finally {
      client.release();
    }
  });
});

test('readiness projects without plies, a no-show projects result, cause and end, and leaves the pending set', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const candidates = new PgNoShowCandidates(pool);
    const seek = await create(store, w!, b!, T0, 'seek');
    await step(store, seek, (g) => g.markReady('w', T0 + 1_000));
    await project(pool);
    assert.deepEqual({ ...(await row(pool, seek)) }, {
      source: 'seek', ply_count: 0, last_seq: 1, result: null, termination: null, ended_at: null,
    });
    assert.deepEqual((await due(candidates, T0 + 59_999)).map((c) => c.gameId), [], 'not before the deadline');
    assert.deepEqual((await due(candidates, T0 + 60_000)).map((c) => [c.gameId, c.source]), [[seek, 'seek']]);

    await step(store, seek, (g) => g.expireNoShow(60_000, T0 + 60_000));
    await project(pool);
    assert.deepEqual({ ...(await row(pool, seek)) }, {
      source: 'seek', ply_count: 0, last_seq: 2, result: '*', termination: 'no_show', ended_at: new Date(T0 + 60_000),
    });
    assert.deepEqual(await due(candidates, T0 + 3_600_000), [], 'an ended game is no longer a candidate');
  });
});

test('each source has its own deadline; moved, ended and source-less games are never candidates; pages are keyset', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const candidates = new PgNoShowCandidates(pool);
    const seek = await create(store, w!, b!, T0, 'seek');
    const tournament = await create(store, w!, b!, T0 + 1, 'tournament');
    const legacy = await create(store, w!, b!, T0 + 2);
    const moved = await create(store, w!, b!, T0 + 3, 'seek');
    await step(store, moved, (g) => g.markReady('w', T0 + 4));
    await step(store, moved, (g) => g.markReady('b', T0 + 5));
    await step(store, moved, (g) => g.playMove('e2e4', T0 + 6));
    // A tournament game created by the event-only launcher path (no games row at creation).
    const eventOnly = await create(store, w!, b!, T0 + 7, 'tournament');
    await project(pool);

    assert.deepEqual((await due(candidates, T0 + 60_000)).map((c) => c.gameId), [seek], 'tournament games wait five minutes');
    const all = await due(candidates, T0 + 300_007);
    assert.deepEqual(all.map((c) => c.gameId), [seek, tournament, eventOnly]);
    assert.ok(!all.some((c) => c.gameId === legacy || c.gameId === moved));

    const first = await candidates.due({ seekDueBy: new Date(T0 + 400_000), tournamentDueBy: new Date(T0 + 400_000), after: null, limit: 2 });
    const second = await candidates.due({
      seekDueBy: new Date(T0 + 400_000), tournamentDueBy: new Date(T0 + 400_000),
      after: { startedAt: first.at(-1)!.startedAt, gameId: first.at(-1)!.gameId }, limit: 2,
    });
    assert.deepEqual([...first, ...second].map((c) => c.gameId), [seek, tournament, eventOnly]);
  });
});

test('rebuild keeps the source and no-show rows identical, and replay is idempotent', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const game = await create(store, w!, b!, T0, 'tournament');
    await step(store, game, (g) => g.expireNoShow(300_000, T0 + 300_000));
    await project(pool);
    const before = await row(pool, game);
    await new PgGamesProjector(pool).rebuildAll();
    await project(pool);
    assert.deepEqual(await row(pool, game), before);
    assert.equal(before?.termination, 'no_show');
    assert.equal(before?.result, '*');
  });
});

test('games created before migration 0042 project with no source and are never scanned', { skip }, async () => {
  const before = mkdtempSync(join(tmpdir(), 'pre-0042-'));
  try {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f < '0042')) cpSync(join(MIGRATIONS, file), join(before, file));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, before);
      const [w, b] = await users(pool, 2);
      const store = new PostgresEventStore(pool);
      const old = await create(store, w!, b!, T0);
      // The row an earlier release's projector (or seek acceptance) wrote before the column existed.
      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at, last_seq) VALUES ($1, 'standard', true, 'blitz', $2, $3, $4, 0)`,
        [old, w, b, new Date(T0)],
      );
      assert.equal(await migrate(pool, MIGRATIONS), 3, '0042, 0043 and the online index 0044');
      assert.equal((await row(pool, old))?.source, null, 'existing rows gain a NULL source and pass validation');
      await project(pool);
      await new PgGamesProjector(pool).rebuildAll();
      assert.equal((await row(pool, old))?.source, null);
      assert.deepEqual(await due(new PgNoShowCandidates(pool), T0 + 86_400_000), []);
      // The stream still replays exactly as it always did: clock anchored at creation.
      const replayed = Game.fromEvents((await store.load(old)).map((e) => e.event)).snapshot();
      assert.equal(replayed.clock.turnStartedAt, T0);
      assert.equal(replayed.source, null);
    });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
});

test('readiness and a racing first move and expiry are decided by the log\'s sequence check', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [w, b] = await users(pool, 2);
    const store = new PostgresEventStore(pool);
    const game = await create(store, w!, b!, T0, 'seek');
    await step(store, game, (g) => g.markReady('w', T0 + 1));
    await step(store, game, (g) => g.markReady('b', T0 + 2));
    const head = (await store.load(game)).at(-1)!.seq;
    const base = Game.fromEvents((await store.load(game)).map((e) => e.event));
    // Two writers decided from the same head: a first move and an expiry.
    const results = await Promise.allSettled([
      store.append(game, head, base.playMove('e2e4', T0 + 60_000).events),
      store.append(game, head, base.expireNoShow(60_000, T0 + 60_000).events),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const types = (await store.load(game)).map((e) => e.event.type);
    assert.equal(types.length, 4);
    assert.ok(types[3] === 'MovePlayed' || types[3] === 'GameEnded');

    // A stale writer arriving after the winner committed, as a lagging owner would.
    const stale = await create(store, w!, b!, T0, 'seek');
    await step(store, stale, (g) => g.markReady('w', T0 + 1));
    await step(store, stale, (g) => g.markReady('b', T0 + 2));
    const staleHead = (await store.load(stale)).at(-1)!.seq;
    const staleCopy = Game.fromEvents((await store.load(stale)).map((e) => e.event));
    await store.append(stale, staleHead, staleCopy.expireNoShow(60_000, T0 + 60_000).events);
    await assert.rejects(store.append(stale, staleHead, staleCopy.playMove('e2e4', T0 + 60_001).events));
    assert.deepEqual((await store.load(stale)).map((e) => e.event.type), ['GameCreated', 'PlayerReady', 'PlayerReady', 'GameEnded']);
  });
});
