/**
 * The running-clock flag queue against real PostgreSQL (ADR-0149): migration 0043, the trigger that
 * keeps `flag_deadlines` in step with every append, its agreement with the game domain's deadline,
 * the backfill of games already running, the queue adapter, and the timeout in the games projection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { uuidv7 } from '../src';
import { migrate } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgUsersRepository } from '../src/pg/repositories';
import { PgGamesProjector } from '../src/pg/games-projector';
import { PgFlagCandidates } from '../src/pg/flag-candidates';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), 'migrations');
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const SUDDEN: TimeControl = { kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 };
const FISCHER: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };
const DELAY: TimeControl = { kind: 'delay', initialMs: 300_000, incrementMs: 0, delayMs: 5_000 };
const UNLIMITED: TimeControl = { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 };

async function players(pool: Pool): Promise<{ white: string; black: string }> {
  const repo = new PgUsersRepository(pool);
  const [white, black] = [uuidv7(), uuidv7()];
  for (const id of [white, black]) await repo.create({ id, handle: `fl_${id.slice(-12)}` });
  return { white, black };
}

async function create(
  store: PostgresEventStore,
  pool: Pool,
  tc: TimeControl,
  extra: { source?: 'seek' | 'tournament'; variant?: 'standard' | 'chess960' | 'atomic' } = {},
): Promise<string> {
  const gameId = uuidv7();
  const { events } = Game.create({
    gameId, timeControl: tc, players: await players(pool), rated: true, at: T0,
    ...(extra.variant ? { variant: extra.variant } : {}),
    ...(extra.variant === 'chess960' ? { chess960StartId: 518 } : {}),
    ...(extra.source ? { source: extra.source, noShowAfterMs: 60_000 } : {}),
  });
  await store.append(gameId, -1, events);
  if (extra.source) {
    await step(store, gameId, (g) => g.markReady('w', T0));
    await step(store, gameId, (g) => g.markReady('b', T0));
  }
  return gameId;
}

/** Apply a domain step to the stored stream, the way the authority appends. */
async function step(store: PostgresEventStore, gameId: string, fn: (game: Game) => { events: GameEvent[] }): Promise<Game> {
  const stored = await store.load(gameId);
  const result = fn(Game.fromEvents(stored.map((e) => e.event)));
  await store.append(gameId, stored.at(-1)!.seq, result.events);
  return Game.fromEvents([...stored.map((e) => e.event), ...result.events]);
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

async function row(pool: Pool, gameId: string): Promise<{ seq: number; due: number } | null> {
  const res = await pool.query<{ seq: number; due_ms: string }>('SELECT seq, due_ms FROM flag_deadlines WHERE game_id = $1', [gameId]);
  return res.rows[0] ? { seq: res.rows[0].seq, due: Number(res.rows[0].due_ms) } : null;
}

test('migration 0043 adds the trigger-kept flag queue with an index the worker query uses', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'flag_deadlines_track' AND NOT tgisinternal`);
    assert.equal(trigger.rowCount, 1);
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT game_id, due_ms FROM flag_deadlines
         WHERE due_ms <= $1 AND (due_ms, game_id) > ($2::bigint, $3::uuid) ORDER BY due_ms, game_id LIMIT 50`,
        [T0, 0, '00000000-0000-0000-0000-000000000000'],
      );
      assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /flag_deadlines_due_idx/);
    } finally {
      client.release();
    }
  });
});

test('the first move starts the deadline, each move replaces it, and any ending removes it', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    for (const ending of ['checkmate', 'resignation', 'agreement', 'timeout'] as const) {
      const gameId = await create(store, pool, FISCHER, { source: 'seek' });
      assert.equal(await row(pool, gameId), null, 'no row before the first move');
      let game = await step(store, gameId, (g) => g.playMove('f2f3', T0 + 1_000));
      assert.deepEqual(await row(pool, gameId), { seq: 3, due: game.flagDeadline }, 'first move');
      game = await step(store, gameId, (g) => g.playMove('e7e5', T0 + 11_000));
      assert.deepEqual(await row(pool, gameId), { seq: 4, due: game.flagDeadline }, 'replaced, not added');
      await step(store, gameId, (g) => g.offerDraw('w', T0 + 12_000));
      assert.deepEqual(await row(pool, gameId), { seq: 4, due: game.flagDeadline }, 'a draw offer does not move the clock');
      if (ending === 'checkmate') {
        await step(store, gameId, (g) => g.playMove('g2g4', T0 + 13_000));
        game = await step(store, gameId, (g) => g.playMove('d8h4', T0 + 14_000));
        assert.equal(game.status.over && game.status.termination, 'checkmate');
      }
      if (ending === 'resignation') await step(store, gameId, (g) => g.resign('w', T0 + 13_000));
      if (ending === 'agreement') await step(store, gameId, (g) => g.acceptDraw('b', T0 + 13_000));
      if (ending === 'timeout') await step(store, gameId, (g) => g.claimFlag(game.flagDeadline!));
      assert.equal(await row(pool, gameId), null, `${ending} leaves the queue`);
    }
  });
});

test('the trigger and Game.flagDeadline agree for sudden death, increment, delay and every source', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const script = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'];
    const variants = [{}, { source: 'seek' as const }, { source: 'tournament' as const }, { variant: 'chess960' as const }, { variant: 'atomic' as const }];
    for (const tc of [SUDDEN, FISCHER, DELAY]) {
      for (const extra of variants) {
        const gameId = await create(store, pool, tc, extra);
        let at = T0 + 777;
        for (const uci of extra.variant === 'chess960' ? ['e2e4', 'e7e5', 'g1f3', 'b8c6'] : script) {
          at += 1_234 + (at % 4_567); // irregular think times, including ones inside the delay
          const game = await step(store, gameId, (g) => g.playMove(uci, at));
          assert.equal((await row(pool, gameId))?.due, game.flagDeadline, `${tc.kind} ${JSON.stringify(extra)} ${uci}`);
        }
      }
    }
    const unlimited = await create(store, pool, UNLIMITED);
    await step(store, unlimited, (g) => g.playMove('e2e4', T0 + 5));
    assert.equal(await row(pool, unlimited), null, 'an unlimited game never enters the queue');
  });
});

test('a move the domain would not write never rejects the append: an unusable clock falls back to a lower bound or is skipped', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const move = (payload: Record<string, unknown>) => ({ type: 'MovePlayed', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', moveTimeMs: 0, ...payload }) as unknown as GameEvent;
    const cases: Array<[Record<string, unknown>, number | null]> = [
      [{ at: T0, remaining: { w: 60_000, b: 'x' } }, T0],
      [{ at: T0, remaining: null }, T0],
      [{ at: T0, remaining: { w: 60_000, b: 1e308 } }, T0],
      [{ at: 1e300, remaining: { w: 1, b: 1 } }, null],
      [{ at: 'soon', remaining: { w: 1, b: 1 } }, null],
      [{ at: T0, by: 'x', remaining: { w: 1, b: 1 } }, T0],
      [{ at: T0 + 0.25, remaining: { w: 60_000, b: 0 } }, T0 + 1],
      [{ at: T0 + 0.25, remaining: { w: 60_000, b: 1_000.5 } }, T0 + 1_001],
    ];
    for (const [payload, expected] of cases) {
      const gameId = await create(store, pool, SUDDEN);
      await store.append(gameId, 0, [move(payload)]);
      assert.equal((await row(pool, gameId))?.due ?? null, expected, JSON.stringify(payload));
    }
  });
});

test('due pages are keyset-ordered by deadline; corrections never touch a row a newer move wrote', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const queue = new PgFlagCandidates(pool);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const gameId = await create(store, pool, SUDDEN);
      await step(store, gameId, (g) => g.playMove('e2e4', T0 + i));
      ids.push(gameId);
    }
    const dueBy = new Date(T0 + 60_001);
    const first = await queue.due({ dueBy, after: null, limit: 2 });
    assert.deepEqual(first.map((c) => [c.gameId, c.dueAt.getTime()]), [[ids[0], T0 + 60_000], [ids[1], T0 + 60_001]]);
    const next = await queue.due({ dueBy, after: first[1]!, limit: 2 });
    assert.deepEqual(next, [], 'the third is not due by then');
    assert.equal((await queue.due({ dueBy: new Date(T0 + 59_999), after: null, limit: 5 })).length, 0);

    // A correction from a log read at seq 1 applies; after a newer move (seq 2) it does not.
    await queue.reschedule(ids[0]!, 1, T0 + 99_000);
    assert.equal((await row(pool, ids[0]!))?.due, T0 + 99_000);
    const moved = await step(store, ids[1]!, (g) => g.playMove('e7e5', T0 + 30_000));
    await queue.reschedule(ids[1]!, 1, T0 + 1);
    await queue.dismiss(ids[1]!, 1);
    assert.deepEqual(await row(pool, ids[1]!), { seq: 2, due: moved.flagDeadline }, 'the newer move\'s row stands');
    await queue.dismiss(ids[2]!, 1);
    assert.equal(await row(pool, ids[2]!), null);
  });
});

test('games already running when 0043 is applied are backfilled from their latest move; ended and unstarted ones are not', { skip }, async () => {
  const before = mkdtempSync(join(tmpdir(), 'pre-0043-'));
  try {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f < '0043')) cpSync(join(MIGRATIONS, file), join(before, file));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, before);
      const store = new PostgresEventStore(pool);
      const running = await create(store, pool, FISCHER);
      await step(store, running, (g) => g.playMove('e2e4', T0 + 1_000));
      const latest = await step(store, running, (g) => g.playMove('e7e5', T0 + 5_000));
      const overdue = await create(store, pool, SUDDEN);
      const stale = await step(store, overdue, (g) => g.playMove('e2e4', T0));
      const ended = await create(store, pool, SUDDEN);
      await step(store, ended, (g) => g.playMove('e2e4', T0));
      await step(store, ended, (g) => g.resign('b', T0 + 1));
      const unstarted = await create(store, pool, SUDDEN);
      const unlimited = await create(store, pool, UNLIMITED);
      await step(store, unlimited, (g) => g.playMove('e2e4', T0));

      await migrate(pool, MIGRATIONS);
      assert.deepEqual(await row(pool, running), { seq: 2, due: latest.flagDeadline });
      assert.deepEqual(await row(pool, overdue), { seq: 1, due: stale.flagDeadline }, 'long overdue: due at once');
      for (const id of [ended, unstarted, unlimited]) assert.equal(await row(pool, id), null);
    });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
});

test('a timeout projects its result, cause and end time like any other ending', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const store = new PostgresEventStore(pool);
    const gameId = await create(store, pool, SUDDEN, { source: 'tournament' });
    const game = await step(store, gameId, (g) => g.playMove('e2e4', T0 + 1_000));
    await step(store, gameId, (g) => g.claimFlag(game.flagDeadline!));
    await project(pool);
    const projected = await pool.query<{ result: string; termination: string; ended_at: Date }>(
      'SELECT result, termination, ended_at FROM games WHERE id = $1', [gameId],
    );
    assert.deepEqual(projected.rows, [{ result: '1-0', termination: 'timeout', ended_at: new Date(game.flagDeadline!) }]);
  });
});
