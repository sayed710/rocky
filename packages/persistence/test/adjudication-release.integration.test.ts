/**
 * @packageDocumentation
 * Real PostgreSQL tests for migration 0054 and PgAdjudicationStore.releaseClocks (Issue #124).
 *
 * Driven through genuine proof jobs: an observed-release move completes stopped, the store releases
 * it, and the released game runs on through the next adjudication. Covered: exact event and queue
 * parity with the domain, replay parity, idempotent and lost-reply recovery, the managed-game fence,
 * forged or misplaced releases, permit tampering, and racing releases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { Game } from '@chess-platform/game';
import { AdjudicationConflictError } from '../src/errors';
import { migrate } from '../src/pg/migrate';
import { PgAdjudicationStore } from '../src/pg/adjudication-store';
import { withTestDatabase } from '../src/test-support/database';

const migrationsDir = [
  join(__dirname, '../../migrations'),
  join(__dirname, '../migrations'),
  join(process.cwd(), 'migrations'),
  join(process.cwd(), 'packages/persistence/migrations'),
].find((d) => existsSync(d))!;

const USER_W = '018f2780-0000-7000-8000-000000000010';
const USER_B = '018f2780-0000-7000-8000-000000000020';
const EXECUTOR = '018f2780-0000-7000-8000-000000000099';
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
const RULES = 'standard@1.0.0';
let counter = 0;
const uuid = (): string => `018f2780-0000-7000-8000-${(0xf00000000000 + ++counter).toString(16)}`;

function hasCode(code: string) {
  return (err: unknown): boolean => {
    assert.equal((err as { code?: string }).code, code, `expected ${code}, got ${String((err as Error).message)}`);
    return true;
  };
}

async function setup(pool: Pool): Promise<void> {
  await migrate(pool, migrationsDir);
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, 'white_player', 'white@example.com', NOW(), NOW()), ($2, 'black_player', 'black@example.com', NOW(), NOW())`,
    [USER_W, USER_B],
  );
}

async function createGame(pool: Pool): Promise<string> {
  const gameId = uuid();
  const created = Game.create({
    gameId, players: { white: USER_W, black: USER_B },
    timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
    rated: false, at: 1000, initialFen: FEN_MATE1,
  });
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at) VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, USER_W, USER_B],
  );
  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, 'GameCreated', 1, $2::jsonb)`,
    [gameId, JSON.stringify(created.events[0])],
  );
  return gameId;
}

/** Start, prove and settle one observed-release command; returns the settlement receipt. */
async function adjudicate(store: PgAdjudicationStore, gameId: string, cmd: { uci?: string; kind: 'move' | 'offerDraw' }, color: 'w' | 'b', at: number) {
  const operationId = uuid();
  const res = await store.startAdjudication({
    gameId,
    command: cmd.kind === 'move' ? { kind: 'move', uci: cmd.uci! } : { kind: 'offerDraw' },
    context: { operationId, color, at, rulesVersion: RULES, clockPolicy: 'observed-release-v1' },
  });
  assert.equal(res.status, 'started');
  const grant = await store.claimAdjudication({
    gameId, operationId, executorId: EXECUTOR, expectedGeneration: '0', leaseMs: 60_000,
    intent: PgAdjudicationStore.newClaimIntent(),
  });
  await store.createProofJob(gameId, operationId);
  let status = store.getProofJob(operationId)?.status;
  for (let i = 0; status === 'active' && i < 100_000; i++) status = store.stepProofJob(operationId, 100).status;
  assert.equal(status, 'ready');
  return store.settleAdjudication({ gameId, operationId, grant, resolutionAt: at + 100 });
}

async function replay(pool: Pool, gameId: string): Promise<Game> {
  const rows = await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId]);
  return Game.fromEvents(rows.rows.map((r) => r.payload));
}

async function queues(pool: Pool, gameId: string) {
  const flag = (await pool.query('SELECT seq, due_ms::text AS due FROM flag_deadlines WHERE game_id = $1', [gameId])).rows;
  const pregame = (await pool.query('SELECT seq FROM pregame_deadlines WHERE game_id = $1', [gameId])).rows;
  return { flag, pregame };
}

test('a stopped completion is released: exact event, domain deadlines, replay parity, then the next adjudication', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool);
    const settled = await adjudicate(store, gameId, { kind: 'move', uci: 'e7e4' }, 'w', 1100);
    assert.deepEqual(await queues(pool, gameId), { flag: [], pregame: [] }, 'stopped: no deadlines');

    // Before the release nothing raw may follow the stop.
    await assert.rejects(
      pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'DrawOffered', 1, '{"type":"DrawOffered","by":"b","at":1}')`,
        [gameId, settled.finalSeq + 1]),
      hasCode('PMA10'),
    );

    const stoppedGame = await replay(pool, gameId);
    const receipt = await store.releaseClocks({ gameId, releaseRequestId: 'release-1', at: 1500 });
    assert.equal(receipt.releaseSeq, settled.finalSeq + 1);

    const { event, game: expected } = stoppedGame.prepareClockRelease({ releaseRequestId: 'release-1', at: 1500 });
    const stored = (await pool.query('SELECT type, payload FROM game_events WHERE game_id = $1 AND seq = $2', [gameId, receipt.releaseSeq])).rows[0];
    assert.equal(stored.type, 'AdjudicationClocksStarted');
    assert.deepEqual(stored.payload, event);
    const replayed = await replay(pool, gameId);
    assert.deepEqual(replayed.snapshot(), expected.snapshot());
    assert.equal(replayed.stoppedClock, null);

    // The flag queue holds exactly the deadline the released clocks run towards.
    assert.ok(expected.flagDeadline !== null);
    assert.equal(receipt.flagDueMs, Math.ceil(expected.flagDeadline!));
    assert.deepEqual(await queues(pool, gameId), { flag: [{ seq: receipt.releaseSeq, due: String(receipt.flagDueMs) }], pregame: [] });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_adjudications WHERE game_id = $1 AND is_current_stop', [gameId])).rows[0].n, 0);

    // A released managed game still refuses raw events: the next command is an adjudication.
    await assert.rejects(
      pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'DrawOffered', 1, '{"type":"DrawOffered","by":"b","at":1}')`,
        [gameId, receipt.releaseSeq + 1]),
      hasCode('PMA14'),
    );
    const next = await adjudicate(store, gameId, { kind: 'offerDraw' }, 'b', 2000);
    assert.equal(next.startedSeq, receipt.releaseSeq + 1);
    assert.deepEqual(await queues(pool, gameId), { flag: [], pregame: [] }, 'stopped again after the next completion');
    const after = await replay(pool, gameId);
    assert.ok(after.stoppedClock, 'the new completion is the current stop');
  });
});

test('release is idempotent by request id, survives a lost COMMIT reply, and cannot happen twice', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    let loseCommit = false;
    const lossy = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== 'connect') return Reflect.get(target, prop, receiver);
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
          client.query = (async (text: unknown, ...rest: unknown[]) => {
            const result = await original(text, ...rest);
            if (text === 'COMMIT' && loseCommit) {
              loseCommit = false;
              throw new Error('Connection terminated unexpectedly');
            }
            return result;
          }) as typeof client.query;
          const release = client.release.bind(client);
          client.release = ((err?: Error | boolean) => {
            client.query = original as typeof client.query;
            return release(err);
          }) as typeof client.release;
          return client;
        };
      },
    });
    const store = new PgAdjudicationStore(lossy);
    const gameId = await createGame(pool);
    await adjudicate(store, gameId, { kind: 'move', uci: 'e7e4' }, 'w', 1100);

    loseCommit = true;
    await assert.rejects(store.releaseClocks({ gameId, releaseRequestId: 'r-lost', at: 1500 }), /Connection terminated/);
    // The retry (even with a later instant) answers with the release that committed.
    const retried = await store.releaseClocks({ gameId, releaseRequestId: 'r-lost', at: 9999 });
    assert.equal(retried.at, 1500);
    const again = await store.releaseClocks({ gameId, releaseRequestId: 'r-lost', at: 1500 });
    assert.deepEqual(again, retried);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM game_events WHERE game_id = $1 AND type = 'AdjudicationClocksStarted'", [gameId])).rows[0].n, 1);
    // Another request id finds no stop left to release.
    await assert.rejects(store.releaseClocks({ gameId, releaseRequestId: 'r-other', at: 1600 }), AdjudicationConflictError);
  });
});

test('racing releases with different request ids: exactly one commits', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const a = new PgAdjudicationStore(pool);
    const b = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool);
    await adjudicate(a, gameId, { kind: 'move', uci: 'e7e4' }, 'w', 1100);
    const results = await Promise.allSettled([
      a.releaseClocks({ gameId, releaseRequestId: 'race-a', at: 1500 }),
      b.releaseClocks({ gameId, releaseRequestId: 'race-b', at: 1501 }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_adjudication_releases WHERE game_id = $1', [gameId])).rows[0].n, 1);
  });
});

test('forged, misplaced and tampered releases are refused immediately or at COMMIT', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const gameId = await createGame(pool);
    const settled = await adjudicate(store, gameId, { kind: 'move', uci: 'e7e4' }, 'w', 1100);
    const stoppedGame = await replay(pool, gameId);
    const { event } = stoppedGame.prepareClockRelease({ releaseRequestId: 'manual', at: 1500 });
    const seq = settled.finalSeq + 1;
    const stopOp = settled.operationId;

    // No permit: the release event alone is refused.
    await assert.rejects(
      pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'AdjudicationClocksStarted', 1, $3::jsonb)`,
        [gameId, seq, JSON.stringify(event)]),
      hasCode('PMA01'),
    );

    const client = await pool.connect();
    const permit = (overrides: { seq?: number; stop?: string } = {}) => client.query(
      `INSERT INTO game_adjudication_releases (game_id, release_request_id, stop_operation_id, release_seq, event_payload)
       VALUES ($1, 'manual', $2, $3, $4::jsonb)`,
      [gameId, overrides.stop ?? stopOp, overrides.seq ?? seq, JSON.stringify(event)],
    );
    const inTx = async (body: () => Promise<void>) => {
      await client.query('BEGIN');
      try { await body(); } finally { await client.query('ROLLBACK').catch(() => undefined); }
    };
    try {
      await inTx(async () => { await assert.rejects(permit({ seq: seq + 1 }), hasCode('PMA43')); });
      await inTx(async () => { await assert.rejects(permit({ stop: uuid() }), hasCode('PMA42')); });
      // A permit with a different event than the one appended.
      await inTx(async () => {
        await permit();
        await assert.rejects(
          client.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'AdjudicationClocksStarted', 1, $3::jsonb)`,
            [gameId, seq, JSON.stringify({ ...event, at: 1501 })]),
          hasCode('PMA15'),
        );
      });
      // A permit whose event is never appended cannot commit.
      await client.query('BEGIN');
      await permit();
      await assert.rejects(client.query('COMMIT'), hasCode('PMD23'));
      // A release whose queues differ from what it recorded cannot commit.
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO game_adjudication_releases (game_id, release_request_id, stop_operation_id, release_seq, event_payload, flag_due_ms)
         VALUES ($1, 'manual', $2, $3, $4::jsonb, 123456)`,
        [gameId, stopOp, seq, JSON.stringify(event)],
      );
      await client.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'AdjudicationClocksStarted', 1, $3::jsonb)`,
        [gameId, seq, JSON.stringify(event)]);
      await assert.rejects(client.query('COMMIT'), hasCode('PMD25'));
      // The right deadline under a wrong fence (queue seq) cannot commit either.
      const released = stoppedGame.prepareClockRelease({ releaseRequestId: 'manual', at: 1500 }).game;
      const flagDue = Math.ceil(released.flagDeadline!);
      for (const fence of [seq - 1, seq + 7]) {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO game_adjudication_releases (game_id, release_request_id, stop_operation_id, release_seq, event_payload, flag_due_ms)
           VALUES ($1, 'manual', $2, $3, $4::jsonb, $5)`,
          [gameId, stopOp, seq, JSON.stringify(event), flagDue],
        );
        await client.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'AdjudicationClocksStarted', 1, $3::jsonb)`,
          [gameId, seq, JSON.stringify(event)]);
        await client.query('INSERT INTO flag_deadlines (game_id, seq, due_ms) VALUES ($1, $2, $3)', [gameId, fence, flagDue]);
        await assert.rejects(client.query('COMMIT'), hasCode('PMD25'));
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // A committed release is immutable and cannot be deleted or truncated.
    await store.releaseClocks({ gameId, releaseRequestId: 'real', at: 1500 });
    await assert.rejects(pool.query(`UPDATE game_adjudication_releases SET flag_due_ms = 1 WHERE game_id = $1`, [gameId]), hasCode('PMA44'));
    await assert.rejects(pool.query(`UPDATE game_adjudication_releases SET consumed = false WHERE game_id = $1`, [gameId]), hasCode('PMA44'));
    await assert.rejects(pool.query(`DELETE FROM game_adjudication_releases WHERE game_id = $1`, [gameId]), hasCode('PMA30'));
    await assert.rejects(pool.query('TRUNCATE game_adjudication_releases'), hasCode('PMA30'));
  });
});
