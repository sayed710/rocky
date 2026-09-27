/** Durable, exactly-once variant × speed ratings applied from the event log, against real PostgreSQL (ADR-0150). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { ENGINE_BOT_USER_IDS, Game, type CreateGameParams, type GameEvent, type TimeControl } from '@chess-platform/game';
import { initialRating, rateGame, uuidv7, type Glicko2Rating, type RateableGame } from '../src';
import { migrate } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgRatingsRepository, PgUsersRepository } from '../src/pg/repositories';
import { PgRatingsApplier, applyRatedGame, type RatingsBatch } from '../src/pg/ratings-applier';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), 'migrations');
const BLITZ: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };
const RAPID: TimeControl = { kind: 'increment', initialMs: 600_000, incrementMs: 0, delayMs: 0 };
const BULLET: TimeControl = { kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 };
const UNLIMITED: TimeControl = { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 };
const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

type Step = (game: Game) => { game: Game; events: GameEvent[] };
const move = (uci: string, at = 2_000): Step => (g) => g.playMove(uci, at);
const resign = (color: 'w' | 'b'): Step => (g) => g.resign(color, 3_000);
const agreeDraw: Step = (g) => {
  const offered = g.offerDraw('w', 3_000);
  const accepted = offered.game.acceptDraw('b', 3_001);
  return { game: accepted.game, events: [...offered.events, ...accepted.events] };
};

async function users(pool: Pool, n: number, flags: Record<string, unknown> = {}): Promise<string[]> {
  const repo = new PgUsersRepository(pool);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = uuidv7();
    await repo.create({ id, handle: `rate_${id.slice(-12)}` });
    if (Object.keys(flags).length > 0) await pool.query('UPDATE users SET flags = $2 WHERE id = $1', [id, flags]);
    ids.push(id);
  }
  return ids.sort();
}

function params(white: string, black: string, over: Partial<CreateGameParams> = {}): CreateGameParams {
  return { gameId: uuidv7(), variant: 'standard', timeControl: BLITZ, players: { white, black }, rated: true, at: 1_000, ...over };
}

/** Record a game the way the authority does: creation, then one transaction per step. */
async function record(pool: Pool, create: CreateGameParams, steps: readonly Step[]): Promise<string> {
  const store = new PostgresEventStore(pool);
  const created = Game.create(create);
  let head = await store.append(create.gameId, -1, created.events);
  let game = created.game;
  for (const step of steps) {
    const next = step(game);
    if (next.events.length > 0) head = await store.append(create.gameId, head, next.events);
    game = next.game;
  }
  return create.gameId;
}

async function pending(pool: Pool): Promise<boolean> {
  return (await pool.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM game_events e, rating_checkpoint c
       WHERE e.type = 'GameEnded' AND (e.xact_id, e.server_ts, e.game_id) > (c.xact_id, c.server_ts, c.game_id)
     ) AS pending`,
  )).rows[0]!.pending;
}

/**
 * Apply until every committed ending is passed. The horizon is cluster-wide, so a transaction in any
 * other database on the test server can hold it back for a moment; that delays rating, never fails.
 */
async function drain(pool: Pool, applier = new PgRatingsApplier(pool)): Promise<RatingsBatch[]> {
  const deadline = Date.now() + 30_000;
  const batches: RatingsBatch[] = [];
  for (;;) {
    const batch = await applier.runBatch();
    batches.push(batch);
    if (batch.busy || batch.more) continue;
    if (!(await pending(pool))) return batches;
    if (Date.now() > deadline) throw new Error('ratings did not catch up within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function total(batches: readonly RatingsBatch[], outcome: keyof RatingsBatch['outcomes']): number {
  return batches.reduce((sum, b) => sum + b.outcomes[outcome], 0);
}

async function rating(pool: Pool, userId: string, variant = 'standard', speed = 'blitz'): Promise<Glicko2Rating | undefined> {
  return (await pool.query<Glicko2Rating>(
    'SELECT rating, rd, vol FROM ratings WHERE user_id = $1 AND variant = $2 AND speed = $3',
    [userId, variant, speed],
  )).rows[0];
}

async function count(pool: Pool, table: 'ratings' | 'rating_applications' | 'rating_blocked_games'): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
}

async function inTx(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  return client;
}

/** Wait until `n` lock requests in this database are queued behind another transaction. */
async function waiters(pool: Pool, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE NOT l.granted AND a.datname = current_database()`,
  )).rows[0]!.n) < n) {
    if (Date.now() > deadline) throw new Error(`fewer than ${n} lock waiters after 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a first rated win creates both players\' pool rows from the defaults and rates both once', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await users(pool, 2);
    const gameId = await record(pool, params(white!, black!), [move('e2e4'), resign('b')]);

    const batches = await drain(pool);
    const expected = rateGame(initialRating(), initialRating(), 1);
    assert.deepEqual(await rating(pool, white!), expected.white);
    assert.deepEqual(await rating(pool, black!), expected.black);
    assert.equal(total(batches, 'applied'), 1);
    const ledger = (await pool.query(
      `SELECT game_id, variant, speed, white_id, black_id, white_score, white_rating_before, white_rating_after,
              black_rating_before, black_rating_after FROM rating_applications`,
    )).rows;
    assert.deepEqual(ledger, [{
      game_id: gameId, variant: 'standard', speed: 'blitz', white_id: white, black_id: black, white_score: 1,
      white_rating_before: 1500, white_rating_after: expected.white.rating,
      black_rating_before: 1500, black_rating_after: expected.black.rating,
    }]);
  });
});

test('a black win, a draw and an ordinary timeout each rate both players from their pre-game states, in order', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    await record(pool, params(a!, b!), FOOLS_MATE.map((uci) => move(uci))); // 0-1 checkmate
    await record(pool, params(b!, a!), [move('e2e4'), move('e7e5'), agreeDraw]); // ½-½ agreement
    // 1-0 on time: White moves, Black's clock runs from the move and is claimed long after it fell.
    await record(pool, params(a!, b!), [move('e2e4', 2_000), move('e7e5', 2_500), move('d2d4', 3_000), (g) => g.claimFlag(3_000 + 600_000)]);

    await drain(pool);
    let ra = initialRating();
    let rb = initialRating();
    let step = rateGame(ra, rb, 0);
    ra = step.white; rb = step.black;
    step = rateGame(rb, ra, 0.5);
    rb = step.white; ra = step.black;
    step = rateGame(ra, rb, 1);
    ra = step.white; rb = step.black;
    assert.deepEqual(await rating(pool, a!), ra);
    assert.deepEqual(await rating(pool, b!), rb);
    assert.deepEqual(
      (await pool.query('SELECT white_score FROM rating_applications')).rows.map((r) => r.white_score).sort(),
      [0, 0.5, 1],
    );
  });
});

test('casual games, aborts, seek no-shows and tournament forfeits change no rating; a played tournament game does', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    await record(pool, params(a!, b!, { rated: false }), [move('e2e4'), resign('b')]);
    await record(pool, params(a!, b!), [move('e2e4'), (g) => g.abort(2_500)]);
    const seek = { source: 'seek' as const, noShowAfterMs: 60_000 };
    const tournament = { source: 'tournament' as const, noShowAfterMs: 300_000 };
    await record(pool, params(a!, b!, seek), [(g) => g.markReady('w', 1_100), (g) => g.expireNoShow(61_000)]);
    await record(pool, params(a!, b!, tournament), [(g) => g.markReady('w', 1_100), (g) => g.expireNoShow(301_000)]); // 1-0 forfeit
    await record(pool, params(a!, b!, tournament), [(g) => g.expireNoShow(301_000)]); // double forfeit

    const skipped = await drain(pool);
    assert.equal(total(skipped, 'ineligible'), 5);
    assert.equal(total(skipped, 'applied'), 0);
    assert.equal(await count(pool, 'ratings'), 0);
    assert.equal(await count(pool, 'rating_applications'), 0);

    await record(pool, params(a!, b!, tournament), [
      (g) => g.markReady('w', 1_100), (g) => g.markReady('b', 1_200), move('e2e4', 2_000), resign('b'),
    ]);
    await drain(pool);
    const expected = rateGame(initialRating(), initialRating(), 1);
    assert.deepEqual(await rating(pool, a!), expected.white);
    assert.deepEqual(await rating(pool, b!), expected.black);
  });
});

test('games against a first-party engine, a bot-flagged account, a missing account or a non-account seat change no rating', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [human] = await users(pool, 1);
    const [flaggedBot] = await users(pool, 1, { bot: true });
    await record(pool, params(human!, ENGINE_BOT_USER_IDS.club), [move('e2e4'), resign('b')]);
    await record(pool, params(flaggedBot!, human!), [move('e2e4'), resign('w')]);
    await record(pool, params(human!, uuidv7()), [move('e2e4'), resign('b')]);
    await record(pool, params('harness-alice', human!), [move('e2e4'), resign('w')]);

    const batches = await drain(pool);
    assert.equal(total(batches, 'ineligible'), 4);
    assert.equal(await count(pool, 'ratings'), 0);
  });
});

test('each variant × speed is an independent pool, and unlimited games rate in correspondence', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    await record(pool, params(a!, b!, { timeControl: BLITZ }), [move('e2e4'), resign('b')]);
    await record(pool, params(a!, b!, { timeControl: RAPID }), [move('e2e4'), resign('w')]);
    await record(pool, params(a!, b!, { timeControl: BULLET }), [move('e2e4'), move('e7e5'), agreeDraw]);
    await record(pool, params(a!, b!, { timeControl: UNLIMITED }), [move('e2e4'), resign('b')]);
    await record(pool, params(a!, b!, { variant: 'crazyhouse', timeControl: BLITZ }), [move('e2e4'), resign('w')]);

    await drain(pool);
    const pools = (await pool.query<{ variant: string; speed: string; n: string }>(
      'SELECT variant, speed, count(*) AS n FROM ratings GROUP BY variant, speed ORDER BY variant, speed',
    )).rows.map((r) => `${r.variant}/${r.speed}:${r.n}`);
    assert.deepEqual(pools, ['crazyhouse/blitz:2', 'standard/blitz:2', 'standard/bullet:2', 'standard/correspondence:2', 'standard/rapid:2']);

    const win = rateGame(initialRating(), initialRating(), 1);
    const loss = rateGame(initialRating(), initialRating(), 0);
    const draw = rateGame(initialRating(), initialRating(), 0.5);
    assert.deepEqual(await rating(pool, a!, 'standard', 'blitz'), win.white);
    assert.deepEqual(await rating(pool, a!, 'standard', 'rapid'), loss.white);
    assert.deepEqual(await rating(pool, a!, 'standard', 'bullet'), draw.white);
    assert.deepEqual(await rating(pool, a!, 'standard', 'correspondence'), win.white);
    assert.deepEqual(await rating(pool, a!, 'crazyhouse', 'blitz'), loss.white);

    const repo = new PgRatingsRepository(pool);
    assert.deepEqual(
      (await repo.listForUser(a!)).map((r) => `${r.variant}/${r.speed}`),
      ['crazyhouse/blitz', 'standard/bullet', 'standard/blitz', 'standard/rapid', 'standard/correspondence'],
    );
    assert.deepEqual((await repo.leaderboard('standard', 'blitz', 10)).map((r) => [r.userId, r.speed]), [[a, 'blitz'], [b, 'blitz']]);
    assert.deepEqual((await repo.leaderboard('standard', 'rapid', 10)).map((r) => r.userId), [b, a]);
    assert.deepEqual(await repo.leaderboard('standard', 'classical', 10), []);
    assert.equal((await repo.get(a!, 'standard', 'rapid'))?.rating, loss.white.rating);
    assert.equal(await repo.get(a!, 'standard', 'classical'), null);
  });
});

test('replaying every ending again changes nothing: the ledger applies each game exactly once', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    await record(pool, params(a!, b!), [move('e2e4'), resign('b')]);
    await record(pool, params(b!, a!), [move('e2e4'), resign('b')]);
    await drain(pool);
    const before = (await pool.query('SELECT * FROM ratings ORDER BY user_id')).rows;

    await pool.query(`UPDATE rating_checkpoint SET xact_id = '0', server_ts = '-infinity', game_id = '00000000-0000-0000-0000-000000000000'`);
    const replay = await drain(pool);
    assert.equal(total(replay, 'already_applied'), 2);
    assert.equal(total(replay, 'applied'), 0);
    assert.deepEqual((await pool.query('SELECT * FROM ratings ORDER BY user_id')).rows, before);
    assert.equal(await count(pool, 'rating_applications'), 2);
  });
});

test('a replica finds the checkpoint held and does nothing; the holder\'s work is not duplicated', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    await record(pool, params(a!, b!), [move('e2e4'), resign('b')]);
    const holder = await inTx(pool);
    try {
      await holder.query('SELECT 1 FROM rating_checkpoint FOR UPDATE');
      const batch = await new PgRatingsApplier(pool).runBatch();
      assert.equal(batch.busy, true);
      assert.equal(await count(pool, 'ratings'), 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const [one, two] = await Promise.all([drain(pool, new PgRatingsApplier(pool)), drain(pool, new PgRatingsApplier(pool))]);
    assert.equal(total(one!, 'applied') + total(two!, 'applied'), 1);
    assert.equal(await count(pool, 'rating_applications'), 1);
  });
});

test('two transactions racing to apply one game: exactly one applies, the other finds the ledger row', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await users(pool, 2);
    const game: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'blitz', white: white!, black: black!, whiteScore: 1 };
    const first = await inTx(pool);
    const second = await inTx(pool);
    try {
      assert.equal(await applyRatedGame(first, game), 'applied');
      const racing = applyRatedGame(second, game); // waits on the first's row locks
      await waiters(pool, 1);
      await first.query('COMMIT');
      assert.equal(await racing, 'already_applied');
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
    const once = rateGame(initialRating(), initialRating(), 1);
    assert.deepEqual(await rating(pool, white!), once.white);
    assert.deepEqual(await rating(pool, black!), once.black);
  });
});

test('a failure after the first player\'s write rolls back both players, the ledger and the checkpoint', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await users(pool, 2);
    await record(pool, params(white!, black!), [move('e2e4'), resign('b')]);
    await pool.query(`CREATE FUNCTION fail_second_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure after the first rating write' USING ERRCODE = 'XX000'; END $$`);
    // White is written first; failing Black's update proves White's write cannot survive alone.
    await pool.query(`CREATE TRIGGER fail_second_write BEFORE UPDATE ON ratings FOR EACH ROW
      WHEN (NEW.user_id = '${black}') EXECUTE FUNCTION fail_second_write()`);
    const checkpointBefore = (await pool.query('SELECT xact_id::text, server_ts::text, game_id FROM rating_checkpoint')).rows;

    const deadline = Date.now() + 30_000;
    for (;;) {
      // Retry until the ending is below the horizon and the batch actually reaches it.
      const outcome = await new PgRatingsApplier(pool).runBatch().then(() => 'ok', (error: Error) => error.message);
      if (outcome !== 'ok') {
        assert.match(outcome, /injected failure/);
        break;
      }
      if (Date.now() > deadline) throw new Error('the ending never reached the applier');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await count(pool, 'ratings'), 0);
    assert.equal(await count(pool, 'rating_applications'), 0);
    assert.deepEqual((await pool.query('SELECT xact_id::text, server_ts::text, game_id FROM rating_checkpoint')).rows, checkpointBefore);

    await pool.query('DROP TRIGGER fail_second_write ON ratings');
    const retried = await drain(pool);
    assert.equal(total(retried, 'applied'), 1);
    assert.deepEqual(await rating(pool, black!), rateGame(initialRating(), initialRating(), 1).black);
  });
});

test('two games sharing players lock in player order whatever the colours, so they serialize without deadlock or lost update', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [low, high] = await users(pool, 2);
    for (const id of [low!, high!]) {
      await pool.query(`INSERT INTO ratings (user_id, variant, speed, rating, rd, vol) VALUES ($1, 'standard', 'blitz', 1500, 350, 0.06)`, [id]);
    }
    const lowWhite: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'blitz', white: low!, black: high!, whiteScore: 1 };
    const highWhite: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'blitz', white: high!, black: low!, whiteScore: 1 };

    const gate = await inTx(pool);
    const first = await inTx(pool);
    const second = await inTx(pool);
    try {
      await gate.query(`SELECT 1 FROM ratings WHERE user_id = $1 FOR UPDATE`, [low]);
      // Queue the low-white game on the low row first. Colour-order locking would then let the
      // high-white game take the high row and wait for the low one: a guaranteed deadlock.
      const a = applyRatedGame(first, lowWhite).then(async (r) => { await first.query('COMMIT'); return r; });
      await waiters(pool, 1);
      const b = applyRatedGame(second, highWhite).then(async (r) => { await second.query('COMMIT'); return r; });
      await waiters(pool, 2);
      await gate.query('COMMIT');
      assert.deepEqual(await Promise.all([a, b]), ['applied', 'applied']);
    } finally {
      gate.release();
      first.release();
      second.release();
    }
    const ledger = (await pool.query<{ game_id: string; white_rating_before: number; white_rating_after: number; black_rating_before: number; black_rating_after: number }>(
      'SELECT game_id, white_rating_before, white_rating_after, black_rating_before, black_rating_after FROM rating_applications',
    )).rows;
    const firstApplied = ledger.find((r) => r.game_id === lowWhite.gameId)!;
    const secondApplied = ledger.find((r) => r.game_id === highWhite.gameId)!;
    // The second game started from exactly what the first wrote: nothing was lost or read stale.
    assert.equal(secondApplied.black_rating_before, firstApplied.white_rating_after);
    assert.equal(secondApplied.white_rating_before, firstApplied.black_rating_after);
    assert.equal((await rating(pool, low!))?.rating, secondApplied.black_rating_after);
    assert.equal((await rating(pool, high!))?.rating, secondApplied.white_rating_after);
  });
});

test('two games creating the same new player\'s first rating row concurrently both apply, one after the other', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [newcomer, x, y] = await users(pool, 3);
    const g1: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'rapid', white: newcomer!, black: x!, whiteScore: 1 };
    const g2: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'rapid', white: y!, black: newcomer!, whiteScore: 0 };
    const first = await inTx(pool);
    const second = await inTx(pool);
    try {
      assert.equal(await applyRatedGame(first, g1), 'applied'); // holds the uncommitted new row
      const racing = applyRatedGame(second, g2);
      await waiters(pool, 1);
      await first.query('COMMIT');
      assert.equal(await racing, 'applied');
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
    const one = rateGame(initialRating(), initialRating(), 1);
    const two = rateGame(initialRating(), one.white, 0);
    assert.deepEqual(await rating(pool, newcomer!, 'standard', 'rapid'), two.black);
    assert.equal(await count(pool, 'ratings'), 3);
  });
});

test('historical endings are applied once each in log order, and a restart mid-backfill resumes without repeats', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b, c] = await users(pool, 3);
    // Written before any applier ran, like games played before this increment was deployed.
    await record(pool, params(a!, b!), [move('e2e4'), resign('b')]);
    await record(pool, params(b!, c!), [move('e2e4'), resign('w')]);
    await record(pool, params(a!, c!, { rated: false }), [move('e2e4'), resign('b')]);
    await record(pool, params(c!, a!), [move('e2e4'), (g) => g.abort(2_500)]);
    await record(pool, params(c!, a!), [move('e2e4'), move('e7e5'), agreeDraw]);

    // One ending per batch, and a fresh applier (a restarted process) after the first two.
    const small = { batchSize: 1 };
    await new PgRatingsApplier(pool, small).runBatch();
    await new PgRatingsApplier(pool, small).runBatch();
    const rest = await drain(pool, new PgRatingsApplier(pool, small));
    assert.equal(await count(pool, 'rating_applications'), 3);
    assert.equal(total(rest, 'already_applied'), 0);

    let ra = initialRating(); let rb = initialRating(); let rc = initialRating();
    let s = rateGame(ra, rb, 1); ra = s.white; rb = s.black;
    s = rateGame(rb, rc, 0); rb = s.white; rc = s.black;
    s = rateGame(rc, ra, 0.5); rc = s.white; ra = s.black;
    assert.deepEqual([await rating(pool, a!), await rating(pool, b!), await rating(pool, c!)], [ra, rb, rc]);
  });
});

test('a rebuild from zero replays to exactly the ratings the live applier produced', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const players = await users(pool, 4);
    // Interleave live application with new endings, so the live run sees them in several batches.
    for (let i = 0; i < 8; i += 1) {
      const white = players[i % 4]!;
      const black = players[(i * 3 + 1) % 4]!;
      if (white === black) continue;
      await record(pool, params(white, black), [move('e2e4'), i % 3 === 0 ? agreeDraw : resign(i % 2 === 0 ? 'b' : 'w')]);
      if (i % 3 === 1) await drain(pool);
    }
    await drain(pool);
    const live = (await pool.query('SELECT user_id, rating, rd, vol FROM ratings ORDER BY user_id')).rows;

    await pool.query('DELETE FROM rating_applications');
    await pool.query('DELETE FROM ratings');
    await pool.query(`UPDATE rating_checkpoint SET xact_id = '0', server_ts = '-infinity', game_id = '00000000-0000-0000-0000-000000000000'`);
    await drain(pool, new PgRatingsApplier(pool, { batchSize: 3 }));
    assert.deepEqual((await pool.query('SELECT user_id, rating, rd, vol FROM ratings ORDER BY user_id')).rows, live);
  });
});

test('an ending whose transaction commits late is applied before later-started endings, never after them', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [shared, x, y] = await users(pool, 3);
    const store = new PostgresEventStore(pool);
    // Game L: created and played, its ending appended by a transaction that starts first and commits last.
    const late = params(shared!, x!);
    const created = Game.create(late);
    let head = await store.append(late.gameId, -1, created.events);
    const moved = created.game.playMove('e2e4', 2_000);
    head = await store.append(late.gameId, head, moved.events);
    const ending = moved.game.resign('b', 3_000).events[0]!;

    const slow = await inTx(pool);
    try {
      await slow.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'GameEnded', 1, $3)`,
        [late.gameId, head + 1, ending],
      );
      // Game E ends in a later-started transaction that commits first.
      await record(pool, params(y!, shared!), [move('e2e4'), resign('w')]);
      for (let i = 0; i < 5; i += 1) await new PgRatingsApplier(pool).runBatch();
      assert.equal(await count(pool, 'rating_applications'), 0, 'nothing passes a transaction still in progress');
      await slow.query('COMMIT');
    } finally {
      slow.release();
    }
    await drain(pool);
    const first = rateGame(initialRating(), initialRating(), 1); // shared beats x
    const second = rateGame(initialRating(), first.white, 0); // y loses to shared
    assert.deepEqual(await rating(pool, shared!), second.black);
  });
});

test('a stream that cannot be proven rateable is blocked, reported and never rated, and later games still are', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b] = await users(pool, 2);
    const bad = params(a!, b!);
    const store = new PostgresEventStore(pool);
    const head = await store.append(bad.gameId, -1, Game.create(bad).events);
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'GameEnded', 1, $3)`,
      [bad.gameId, head + 1, { type: 'GameEnded', result: '1-0', termination: 'forfeit', winner: 'w', at: 5_000 }],
    );
    await record(pool, params(a!, b!), [move('e2e4'), resign('b')]);

    const batches = await drain(pool);
    assert.deepEqual(batches.flatMap((batch) => batch.blocked.map((x) => x.gameId)), [bad.gameId]);
    assert.match((await pool.query('SELECT error FROM rating_blocked_games')).rows[0]!.error, /unknown termination/);
    assert.equal(total(batches, 'applied'), 1);
    assert.deepEqual(await rating(pool, a!), rateGame(initialRating(), initialRating(), 1).white);
  });
});

test('an account deleted while its game is being rated makes the game ineligible, never a blocked data error', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await users(pool, 2);
    const game: RateableGame = { gameId: uuidv7(), variant: 'standard', speed: 'blitz', white: white!, black: black!, whiteScore: 1 };
    const deleter = await inTx(pool);
    const rater = await inTx(pool);
    try {
      await deleter.query('DELETE FROM users WHERE id = $1', [black]);
      const rating = applyRatedGame(rater, game); // waits for the deletion to resolve
      await waiters(pool, 1);
      await deleter.query('COMMIT');
      assert.equal(await rating, 'missing_account');
      await rater.query('COMMIT');
    } finally {
      deleter.release();
      rater.release();
    }
    assert.equal(await count(pool, 'ratings'), 0);
    assert.equal(await count(pool, 'rating_applications'), 0);
  });
});

test('endings sharing one transaction id (as migration 0040 left history) apply in ending-time order, one page at a time', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [a, b, c] = await users(pool, 3);
    // Game ids ascend g1 < g2 < g3, but the games ended in the opposite order: g3, then g2, then g1.
    const games = [params(a!, b!), params(a!, c!), params(b!, a!)];
    const endedAt = ['2026-01-01T00:00:03.000003Z', '2026-01-01T00:00:02.000002Z', '2026-01-01T00:00:01.000001Z'];
    const writer = await inTx(pool);
    try {
      for (const [i, create] of games.entries()) {
        const created = Game.create(create);
        const moved = created.game.playMove('e2e4', 2_000);
        const events = [...created.events, ...moved.events, ...moved.game.resign('b', 3_000).events];
        for (const [seq, event] of events.entries()) {
          await writer.query(
            `INSERT INTO game_events (game_id, seq, type, event_version, payload, server_ts)
             VALUES ($1, $2, $3, 1, $4, $5::timestamptz - ($6 * interval '1 millisecond'))`,
            [create.gameId, seq, event.type, event, endedAt[i], events.length - 1 - seq],
          );
        }
      }
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    assert.equal(Number((await pool.query<{ n: string }>(
      `SELECT count(DISTINCT xact_id) AS n FROM game_events WHERE type = 'GameEnded'`,
    )).rows[0]!.n), 1, 'all three endings share one transaction id');

    await drain(pool, new PgRatingsApplier(pool, { batchSize: 1 }));
    // White wins each game: g3 (b beats a), then g2 (a beats c), then g1 (a beats b).
    let ra = initialRating(); let rb = initialRating(); let rc = initialRating();
    let s = rateGame(rb, ra, 1); rb = s.white; ra = s.black;
    s = rateGame(ra, rc, 1); ra = s.white; rc = s.black;
    s = rateGame(ra, rb, 1); ra = s.white; rb = s.black;
    assert.deepEqual([await rating(pool, a!), await rating(pool, b!), await rating(pool, c!)], [ra, rb, rc]);

    // The same games in game-id order give different ratings, so this order was really decided by time.
    let xa = initialRating(); let xb = initialRating(); let xc = initialRating();
    s = rateGame(xa, xb, 1); xa = s.white; xb = s.black;
    s = rateGame(xa, xc, 1); xa = s.white; xc = s.black;
    s = rateGame(xb, xa, 1); xb = s.white; xa = s.black;
    assert.notDeepEqual(xa, ra);
  });
});
