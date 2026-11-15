/**
 * Integration test for custom dead position Game event emission into real PostgreSQL.
 *
 * Verifies that when Game.create emits [GameCreated, GameEnded] for a frozen K/P dead position:
 * 1. PostgresEventStore appends the batch with distinct sequence numbers (seq 0 and 1).
 * 2. PgGamesProjector processes the events and updates the `games` row with:
 *    - result: '1/2-1/2'
 *    - termination: 'dead_position'
 *    - last_seq: 1
 *    - ended_at set to creation timestamp
 * 3. PgTerminalEventInbox claims the terminal event for consumers, decoding the payload
 *    as a dead_position draw with winner = null, and successfully acknowledges it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { Game, type TimeControl } from '@chess-platform/game';
import { uuidv7 } from '../src';
import { migrate, migrationsDir } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgGamesProjector } from '../src/pg/games-projector';
import { PgTerminalEventInbox } from '../src/pg/terminal-event-inbox';
import { PgUsersRepository } from '../src/pg/repositories';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = migrationsDir();

const DEAD_POSITION_FEN = '8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1';
const BLITZ: TimeControl = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };

interface GameRow {
  variant: string;
  rated: boolean;
  speed: string;
  white_id: string | null;
  black_id: string | null;
  result: string | null;
  termination: string | null;
  ply_count: number;
  last_seq: number;
  started_at: Date;
  ended_at: Date | null;
}

async function getGameRow(pool: Pool, id: string): Promise<GameRow | undefined> {
  const result = await pool.query<GameRow>(
    `SELECT variant, rated, speed, white_id, black_id, result, termination, ply_count, last_seq, started_at, ended_at
     FROM games WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function createTestUsers(pool: Pool, count: number): Promise<string[]> {
  const repo = new PgUsersRepository(pool);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = uuidv7();
    await repo.create({ id, handle: `dp_user_${id.slice(-12)}` });
    ids.push(id);
  }
  return ids;
}

async function settleHorizon(pool: Pool): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (
    !(
      await pool.query<{ ok: boolean }>(
        `SELECT pg_snapshot_xmin(pg_current_snapshot())
           > COALESCE((SELECT xact_id FROM game_events ORDER BY xact_id DESC LIMIT 1), '0'::xid8) AS ok`,
      )
    ).rows[0]!.ok
  ) {
    if (Date.now() > deadline) throw new Error('transaction horizon did not advance within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function drainProjector(projector: PgGamesProjector, pool: Pool): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  const endings: string[] = [];
  for (;;) {
    const batch = await projector.runBatch();
    for (const ending of batch.endings) {
      endings.push(ending.gameId);
    }
    if (batch.busy || batch.more) continue;

    const pending = (
      await pool.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM game_events e, projection_checkpoints c
           WHERE c.projection = 'games' AND (e.xact_id, e.game_id, e.seq) > (c.xact_id, c.game_id, c.seq)
         ) AS pending`,
      )
    ).rows[0]!.pending;

    if (!pending) return endings;
    if (Date.now() > deadline) throw new Error('projection did not catch up within 30 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('custom dead position Game.create emission durable persistence, projection and terminal inbox', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const [white, black] = await createTestUsers(pool, 2);
    const gameId = uuidv7();
    const createdAt = 1_700_000_000_000;

    // 1. Create custom dead position game emitting [GameCreated, GameEnded]
    const created = Game.create({
      gameId,
      variant: 'standard',
      initialFen: DEAD_POSITION_FEN,
      timeControl: BLITZ,
      players: { white: white!, black: black! },
      rated: true,
      at: createdAt,
    });

    assert.equal(created.events.length, 2, 'custom dead position must emit exactly GameCreated and GameEnded');
    assert.equal(created.events[0]?.type, 'GameCreated');
    assert.equal(created.events[1]?.type, 'GameEnded');
    assert.equal(created.events[1]?.termination, 'dead_position');
    assert.equal(created.events[1]?.result, '1/2-1/2');

    // 2. Persist events in PostgresEventStore
    const store = new PostgresEventStore(pool);
    const head = await store.append(gameId, -1, created.events);
    assert.equal(head, 1, 'store.append returns head sequence 1');

    const storedEvents = await store.load(gameId);
    assert.equal(storedEvents.length, 2);
    assert.equal(storedEvents[0]?.seq, 0);
    assert.equal(storedEvents[1]?.seq, 1);

    // 3. Project events into games projection
    await settleHorizon(pool);
    const projector = new PgGamesProjector(pool);
    const projectedEndings = await drainProjector(projector, pool);

    assert.ok(projectedEndings.includes(gameId), 'projector batch must report game ending');

    const row = await getGameRow(pool, gameId);
    assert.ok(row, 'game row must exist in games table');
    assert.equal(row.result, '1/2-1/2');
    assert.equal(row.termination, 'dead_position');
    assert.equal(row.last_seq, 1);
    assert.equal(row.started_at.getTime(), createdAt);
    assert.equal(row.ended_at?.getTime(), createdAt);

    // 4. PgTerminalEventInbox claims and completes the dead_position ending
    const inbox = new PgTerminalEventInbox(pool, () => createdAt + 10_000);
    const claim = await inbox.claimAfter('bot-analysis', null);

    assert.ok(claim, 'inbox must claim the pending terminal event');
    assert.equal(claim.lease.gameId, gameId);
    assert.equal(claim.lease.seq, 1, 'terminal event seq must match GameEnded seq 1');
    assert.ok('stored' in claim.work, 'claimed work must be valid stored event');
    assert.equal(claim.work.stored.event.type, 'GameEnded');
    assert.equal(claim.work.stored.event.termination, 'dead_position');
    assert.equal(claim.work.stored.event.result, '1/2-1/2');
    assert.equal(claim.work.stored.event.winner, null);

    const acknowledged = await inbox.acknowledge(claim.lease);
    assert.equal(acknowledged, true, 'terminal event claim must be acknowledged cleanly');

    // Repeat query from the original cursor (null) to ensure acknowledged ending is not reclaimed
    const fromOriginalCursor = await inbox.claimAfter('bot-analysis', null);
    assert.equal(fromOriginalCursor, undefined, 'acknowledged terminal event must not be reclaimed from original cursor');
  });
});
