/**
 * @packageDocumentation
 * Real PostgreSQL integration tests for Stage M Start boundary and identical Start retry (Issue #124).
 *
 * Covers:
 * 1. Ordinary Start commit: exact row in game_adjudications, Started in game_events, head, deadline queues suppressed.
 * 2. Creation coordinators (PgSeekAcceptor and PgGameStarter): pre-Started prefix first, finite-clock / no-show accounting,
 *    exact Started event, games projection, queue finalization, and atomic seek/projection/event rollback.
 * 3. Identical Start retries: proving command retry, proving prepared op retry, completed retry through genuine proof,
 *    reconciling original durable base prefix without duplicate events.
 * 4. Changed immutable request conflicts / differing requests that would no-op / no duplicate events.
 * 5. Boundary fault injection: lost-ACK after real PostgreSQL COMMIT, followed by clean recovery via identical Start retry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  Game,
  prepareCreationAdmission,
  type AdjudicationStartedEvent,
  type GameEvent,
  type PreparedOperation,
} from '@chess-platform/game';
import { CURRENT_EVENT_VERSION } from '../src/event-store';
import { AdjudicationConflictError } from '../src/errors';
import type { GameStart } from '../src/repositories';
import { migrate } from '../src/pg/migrate';
import { PgAdjudicationStore } from '../src/pg/adjudication-store';
import { PgGameStarter, PgSeekAcceptor } from '../src/pg/repositories';
import { withTestDatabase } from '../src/test-support/database';

const migrationsDir = [
  join(__dirname, '../../migrations'),
  join(__dirname, '../migrations'),
  join(process.cwd(), 'migrations'),
  join(process.cwd(), 'packages/persistence/migrations'),
].find((d) => existsSync(d))!;

const USER_W = '018f2780-0000-7000-8000-000000000010';
const USER_B = '018f2780-0000-7000-8000-000000000020';
const EXECUTOR_ID = '018f2780-0000-7000-8000-000000000099';

async function createTestUsers(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, 'white_player', 'white@example.com', NOW(), NOW()),
            ($2, 'black_player', 'black@example.com', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [USER_W, USER_B],
  );
}

async function createBaseGame(
  pool: Pool,
  gameId: string,
  initialFen?: string,
  sourced = true,
): Promise<{ game: Game; createdEvent: GameEvent }> {
  const created = Game.create({
    gameId,
    players: { white: USER_W, black: USER_B },
    timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
    rated: false,
    at: 1000,
    ...(sourced ? { source: 'seek' as const, noShowAfterMs: 60_000 } : {}),
    ...(initialFen ? { initialFen } : {}),
  });

  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
     VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, USER_W, USER_B],
  );

  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload)
     VALUES ($1, 0, $2, 1, $3::jsonb)`,
    [gameId, created.events[0]!.type, JSON.stringify(created.events[0]!)],
  );

  return { game: created.game, createdEvent: created.events[0]! };
}

function createQueryObserverPool(
  basePool: Pool,
  onQuery: (sql: string, params: unknown[]) => void,
): Pool {
  return new Proxy(basePool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async function (...args: unknown[]): Promise<PoolClient> {
          const client = await target.connect();
          const origQuery = client.query.bind(client);
          client.query = async function (queryTextOrConfig: unknown, ...queryArgs: unknown[]) {
            const sql = typeof queryTextOrConfig === 'string'
              ? queryTextOrConfig
              : ((queryTextOrConfig as { text?: string })?.text ?? '');
            const params = Array.isArray(queryArgs[0]) ? queryArgs[0] : [];
            onQuery(sql, params);
            return (origQuery as (...a: unknown[]) => Promise<unknown>)(queryTextOrConfig, ...queryArgs);
          } as typeof client.query;
          return client;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

test('ordinary Start commit: persists exact row, Started in game_events, updates head, suppresses queues', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = '018f2780-0000-7000-8000-000000000101';
    const opId = '018f2780-0000-7000-8000-000000000102';
    await createBaseGame(pool, gameId);

    // Insert dummy deadline to verify queue suppression on Start
    await pool.query(
      `INSERT INTO pregame_deadlines (game_id, due_at, seq)
       VALUES ($1, NOW() + interval '1 minute', 0)
       ON CONFLICT (game_id) DO NOTHING`,
      [gameId],
    );

    const store = new PgAdjudicationStore(pool);
    const startResult = await store.startAdjudication({
      gameId,
      command: { kind: 'ready' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });

    assert.equal(startResult.status, 'started');
    assert.equal(startResult.operationId, opId);
    assert.equal(startResult.startedSeq, 1);

    // Verify row in game_adjudications
    const adjRes = await pool.query<{
      execution_state: string;
      generation: string;
      start_permit_consumed: boolean;
      started_seq: number;
      started_type: string;
      started_version: number;
      started_payload: unknown;
    }>('SELECT * FROM game_adjudications WHERE game_id = $1 AND operation_id = $2', [gameId, opId]);
    assert.equal(adjRes.rowCount, 1);
    const row = adjRes.rows[0]!;
    assert.equal(row.execution_state, 'proving');
    assert.equal(row.generation, '0');
    assert.equal(row.start_permit_consumed, true);
    assert.equal(row.started_seq, 1);
    assert.equal(row.started_type, 'AdjudicationStarted');
    assert.equal(row.started_version, CURRENT_EVENT_VERSION);

    // Verify exact Started event in game_events
    const eventRes = await pool.query<{
      seq: number;
      type: string;
      payload: unknown;
    }>('SELECT seq, type, payload FROM game_events WHERE game_id = $1 ORDER BY seq ASC', [gameId]);
    assert.equal(eventRes.rowCount, 2);
    assert.equal(eventRes.rows[0]!.type, 'GameCreated');
    assert.equal(eventRes.rows[1]!.seq, 1);
    assert.equal(eventRes.rows[1]!.type, 'AdjudicationStarted');
    assert.deepEqual(eventRes.rows[1]!.payload, row.started_payload);

    // Verify deadline queue suppression
    const queueRes = await pool.query('SELECT 1 FROM pregame_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(queueRes.rowCount, 0);
  });
});

test('creation coordinator PgSeekAcceptor: pre-Started prefix first, finite accounting, atomic rollback', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const seekId = '018f2780-0000-7000-8000-000000000201';
    const gameId = '018f2780-0000-7000-8000-000000000202';
    const opId = '018f2780-0000-7000-8000-000000000203';

    await pool.query(
      `INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, created_at)
       VALUES ($1, $2, 'standard', '{"kind":"increment","initialMs":180000,"incrementMs":2000,"delayMs":0}'::jsonb, false, 'white', NOW())`,
      [seekId, USER_W],
    );

    const created = Game.create({
      gameId,
      players: { white: USER_W, black: USER_B },
      timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
      rated: false,
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const createdEvent = created.events[0]!;
    const canonPrep = prepareCreationAdmission(created.game, {
      operationId: opId,
      rulesVersion: 'standard@1.0.0',
      at: 1000,
    });
    const startedEvent: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId,
      operationId: opId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: canonPrep,
    };

    const gameStart: GameStart = {
      id: gameId,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: USER_W,
      blackId: USER_B,
      startedAt: new Date(1000),
    };

    const seekAcceptor = new PgSeekAcceptor(pool);
    const seekResult = await seekAcceptor.accept(seekId, gameId, [createdEvent, startedEvent], gameStart);
    assert.ok(seekResult);
    assert.equal(seekResult.gameId, gameId);

    // Verify events: GameCreated at 0, AdjudicationStarted at 1 with exact payload
    const eventRes = await pool.query<{ seq: number; type: string; payload: unknown }>(
      'SELECT seq, type, payload FROM game_events WHERE game_id = $1 ORDER BY seq ASC',
      [gameId],
    );
    assert.equal(eventRes.rowCount, 2);
    assert.equal(eventRes.rows[0]!.type, 'GameCreated');
    assert.equal(eventRes.rows[1]!.type, 'AdjudicationStarted');
    assert.deepEqual(eventRes.rows[1]!.payload, JSON.parse(JSON.stringify(startedEvent)));

    // Verify complete derived acceptance accounting in game_adjudications
    const adjRes = await pool.query<{
      execution_state: string;
      generation: string;
      start_permit_consumed: boolean;
      started_seq: number;
      started_type: string;
      started_version: number;
      started_payload: unknown;
      original_clock: unknown;
      thinking_elapsed_at_a: string;
      original_no_show_at: string;
      remaining_no_show_time_at_a: string;
      original_basis: unknown;
    }>('SELECT * FROM game_adjudications WHERE game_id = $1 AND operation_id = $2', [gameId, opId]);
    assert.equal(adjRes.rowCount, 1);
    const adj = adjRes.rows[0]!;
    assert.equal(adj.execution_state, 'proving');
    assert.equal(adj.generation, '0');
    assert.equal(adj.start_permit_consumed, true);
    assert.equal(adj.started_seq, 1);
    assert.equal(adj.started_type, 'AdjudicationStarted');
    assert.equal(adj.started_version, CURRENT_EVENT_VERSION);
    assert.deepEqual(adj.started_payload, JSON.parse(JSON.stringify(startedEvent)));
    assert.deepEqual(adj.original_clock, { turnStartedAt: null, remaining: { w: 180000, b: 180000 } });
    assert.equal(BigInt(adj.thinking_elapsed_at_a), 0n);
    assert.equal(BigInt(adj.original_no_show_at), 61_000n);
    assert.equal(BigInt(adj.remaining_no_show_time_at_a), 60_000n);
    assert.equal(adj.original_basis, null);

    // Verify games projection row
    const gameProj = await pool.query<{
      id: string;
      variant: string;
      rated: boolean;
      speed: string;
      white_id: string;
      black_id: string;
    }>('SELECT id, variant, rated, speed, white_id, black_id FROM games WHERE id = $1', [gameId]);
    assert.equal(gameProj.rowCount, 1);
    assert.equal(gameProj.rows[0]!.id, gameId);
    assert.equal(gameProj.rows[0]!.variant, 'standard');
    assert.equal(gameProj.rows[0]!.rated, false);
    assert.equal(gameProj.rows[0]!.speed, 'blitz');
    assert.equal(gameProj.rows[0]!.white_id, USER_W);
    assert.equal(gameProj.rows[0]!.black_id, USER_B);

    // Verify absence from both pregame and flag deadline queues
    const pregameQ = await pool.query('SELECT 1 FROM pregame_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(pregameQ.rowCount, 0);
    const flagQ = await pool.query('SELECT 1 FROM flag_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(flagQ.rowCount, 0);

    // Verify atomic rollback on already-claimed seek (same seekId second invocation)
    const secondResult = await seekAcceptor.accept(
      seekId,
      '018f2780-0000-7000-8000-000000000299',
      [createdEvent, startedEvent],
      gameStart,
    );
    assert.equal(secondResult, null);

    // Exercise new PgSeekAcceptor existing-game branch with a DIFFERENT OPEN seek targeting existing gameId
    const diffOpenSeekId = '018f2780-0000-7000-8000-000000000204';
    await pool.query(
      `INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, created_at)
       VALUES ($1, $2, 'standard', '{"kind":"increment","initialMs":180000,"incrementMs":2000,"delayMs":0}'::jsonb, false, 'white', NOW())`,
      [diffOpenSeekId, USER_W],
    );
    const diffSeekResult = await seekAcceptor.accept(
      diffOpenSeekId,
      gameId,
      [createdEvent, startedEvent],
      gameStart,
    );
    assert.equal(diffSeekResult, null);
    // Seek remains unclaimed and open, events for gameId remain unchanged
    const diffSeekCheck = await pool.query<{ game_id: string | null }>('SELECT game_id FROM seeks WHERE id = $1', [diffOpenSeekId]);
    assert.equal(diffSeekCheck.rows[0]?.game_id, null);
    const evDiffCheck = await pool.query('SELECT count(*) AS c FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(evDiffCheck.rows[0]?.c, '2');

    // Verify atomic rollback on early malformed batch with multiple Started events
    const badSeekId = '018f2780-0000-7000-8000-000000000205';
    const badGameId = '018f2780-0000-7000-8000-000000000206';
    await pool.query(
      `INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, created_at)
       VALUES ($1, $2, 'standard', '{"kind":"increment","initialMs":180000,"incrementMs":2000,"delayMs":0}'::jsonb, false, 'white', NOW())`,
      [badSeekId, USER_W],
    );
    await assert.rejects(
      () => seekAcceptor.accept(badSeekId, badGameId, [createdEvent, startedEvent, startedEvent], gameStart),
      AdjudicationConflictError,
    );
    // Bad game has zero events, zero adjudications, zero games projection, seek remains unclaimed
    const badEvRes = await pool.query('SELECT 1 FROM game_events WHERE game_id = $1', [badGameId]);
    assert.equal(badEvRes.rowCount, 0);
    const badAdjRes = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [badGameId]);
    assert.equal(badAdjRes.rowCount, 0);
    const badGameRes = await pool.query('SELECT 1 FROM games WHERE id = $1', [badGameId]);
    assert.equal(badGameRes.rowCount, 0);
    const badSeekCheck = await pool.query<{ game_id: string | null }>('SELECT game_id FROM seeks WHERE id = $1', [badSeekId]);
    assert.equal(badSeekCheck.rows[0]?.game_id, null);

    // Verify deterministic LATE failure AFTER lifecycle writes (games INSERT CHECK constraint fails)
    const lateSeekId = '018f2780-0000-7000-8000-000000000207';
    const lateGameId = '018f2780-0000-7000-8000-000000000208';
    const lateOpId = '018f2780-0000-7000-8000-000000000209';

    await pool.query(
      `INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, created_at)
       VALUES ($1, $2, 'standard', '{"kind":"increment","initialMs":180000,"incrementMs":2000,"delayMs":0}'::jsonb, false, 'white', NOW())`,
      [lateSeekId, USER_W],
    );

    const lateCreated = Game.create({
      gameId: lateGameId,
      players: { white: USER_W, black: USER_B },
      timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
      rated: false,
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const lateCreatedEvent = lateCreated.events[0]!;
    const lateCanonPrep = prepareCreationAdmission(lateCreated.game, {
      operationId: lateOpId,
      rulesVersion: 'standard@1.0.0',
      at: 1000,
    });
    const lateStartedEvent: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: lateGameId,
      operationId: lateOpId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: lateCanonPrep,
    };

    let lateStartedWritten = false;
    let lateGamesAttempted = false;
    const observedPool = createQueryObserverPool(pool, (sql, params) => {
      if (sql.includes('INSERT INTO game_events') && params.includes('AdjudicationStarted')) {
        lateStartedWritten = true;
      }
      if (sql.includes('INSERT INTO games')) {
        lateGamesAttempted = true;
      }
    });

    const lateSeekAcceptor = new PgSeekAcceptor(observedPool);
    const lateBadStart: GameStart = {
      id: lateGameId,
      variant: 'standard',
      rated: false,
      speed: 'invalid_speed' as unknown as GameStart['speed'],
      whiteId: USER_W,
      blackId: USER_B,
      startedAt: new Date(1000),
    };

    await assert.rejects(
      () => lateSeekAcceptor.accept(lateSeekId, lateGameId, [lateCreatedEvent, lateStartedEvent], lateBadStart),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string; table?: string };
        return pgErr.code === '23514' && (pgErr.constraint === 'games_speed_check' || pgErr.table === 'games');
      },
    );

    // Verify execution order: Started event was persisted to transaction BEFORE games INSERT failed
    assert.equal(lateStartedWritten, true);
    assert.equal(lateGamesAttempted, true);

    // Verify full rollback: zero events, zero adjudications, zero games, seek remains unclaimed
    const lateEvCheck = await pool.query('SELECT 1 FROM game_events WHERE game_id = $1', [lateGameId]);
    assert.equal(lateEvCheck.rowCount, 0);
    const lateAdjCheck = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [lateGameId]);
    assert.equal(lateAdjCheck.rowCount, 0);
    const lateGameCheck = await pool.query('SELECT 1 FROM games WHERE id = $1', [lateGameId]);
    assert.equal(lateGameCheck.rowCount, 0);
    const lateSeekCheck = await pool.query<{ game_id: string | null }>('SELECT game_id FROM seeks WHERE id = $1', [lateSeekId]);
    assert.equal(lateSeekCheck.rows[0]?.game_id, null);
  });
});

test('creation coordinator PgGameStarter: pre-Started prefix first, finite accounting, atomic rollback', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = '018f2780-0000-7000-8000-000000000301';
    const opId = '018f2780-0000-7000-8000-000000000302';

    const created = Game.create({
      gameId,
      players: { white: USER_W, black: USER_B },
      timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
      rated: false,
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const createdEvent = created.events[0]!;
    const canonPrep = prepareCreationAdmission(created.game, {
      operationId: opId,
      rulesVersion: 'standard@1.0.0',
      at: 1000,
    });
    const startedEvent: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId,
      operationId: opId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: canonPrep,
    };

    const gameStart: GameStart = {
      id: gameId,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: USER_W,
      blackId: USER_B,
      startedAt: new Date(1000),
    };

    const starter = new PgGameStarter(pool);
    const startOk = await starter.start(gameId, [createdEvent, startedEvent], gameStart);
    assert.equal(startOk, true);

    // Verify events: GameCreated at 0, AdjudicationStarted at 1 with exact payload
    const eventRes = await pool.query<{ seq: number; type: string; payload: unknown }>(
      'SELECT seq, type, payload FROM game_events WHERE game_id = $1 ORDER BY seq ASC',
      [gameId],
    );
    assert.equal(eventRes.rowCount, 2);
    assert.equal(eventRes.rows[0]!.type, 'GameCreated');
    assert.equal(eventRes.rows[1]!.type, 'AdjudicationStarted');
    assert.deepEqual(eventRes.rows[1]!.payload, JSON.parse(JSON.stringify(startedEvent)));

    // Verify complete derived acceptance accounting in game_adjudications
    const adjRes = await pool.query<{
      execution_state: string;
      generation: string;
      start_permit_consumed: boolean;
      started_seq: number;
      started_type: string;
      started_version: number;
      started_payload: unknown;
      original_clock: unknown;
      thinking_elapsed_at_a: string;
      original_no_show_at: string;
      remaining_no_show_time_at_a: string;
      original_basis: unknown;
    }>('SELECT * FROM game_adjudications WHERE game_id = $1 AND operation_id = $2', [gameId, opId]);
    assert.equal(adjRes.rowCount, 1);
    const adj = adjRes.rows[0]!;
    assert.equal(adj.execution_state, 'proving');
    assert.equal(adj.generation, '0');
    assert.equal(adj.start_permit_consumed, true);
    assert.equal(adj.started_seq, 1);
    assert.equal(adj.started_type, 'AdjudicationStarted');
    assert.equal(adj.started_version, CURRENT_EVENT_VERSION);
    assert.deepEqual(adj.started_payload, JSON.parse(JSON.stringify(startedEvent)));
    assert.deepEqual(adj.original_clock, { turnStartedAt: null, remaining: { w: 180000, b: 180000 } });
    assert.equal(BigInt(adj.thinking_elapsed_at_a), 0n);
    assert.equal(BigInt(adj.original_no_show_at), 61_000n);
    assert.equal(BigInt(adj.remaining_no_show_time_at_a), 60_000n);
    assert.equal(adj.original_basis, null);

    // Verify games projection row
    const gameProj = await pool.query<{
      id: string;
      variant: string;
      rated: boolean;
      speed: string;
      white_id: string;
      black_id: string;
    }>('SELECT id, variant, rated, speed, white_id, black_id FROM games WHERE id = $1', [gameId]);
    assert.equal(gameProj.rowCount, 1);
    assert.equal(gameProj.rows[0]!.id, gameId);
    assert.equal(gameProj.rows[0]!.variant, 'standard');
    assert.equal(gameProj.rows[0]!.rated, false);
    assert.equal(gameProj.rows[0]!.speed, 'blitz');
    assert.equal(gameProj.rows[0]!.white_id, USER_W);
    assert.equal(gameProj.rows[0]!.black_id, USER_B);

    // Verify absence from both pregame and flag deadline queues
    const pregameQ = await pool.query('SELECT 1 FROM pregame_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(pregameQ.rowCount, 0);
    const flagQ = await pool.query('SELECT 1 FROM flag_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(flagQ.rowCount, 0);

    // Duplicate game start returns false without PMA09 (checked under game lock)
    const duplicateStart = await starter.start(gameId, [createdEvent, startedEvent], gameStart);
    assert.equal(duplicateStart, false);

    // Early malformed batch rollback (non-terminal AdjudicationStarted)
    const badGameId = '018f2780-0000-7000-8000-000000000303';
    await assert.rejects(
      () => starter.start(badGameId, [startedEvent, createdEvent], gameStart),
      AdjudicationConflictError,
    );
    const badEvRes = await pool.query('SELECT 1 FROM game_events WHERE game_id = $1', [badGameId]);
    assert.equal(badEvRes.rowCount, 0);
    const badAdjRes = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [badGameId]);
    assert.equal(badAdjRes.rowCount, 0);
    const badGameRes = await pool.query('SELECT 1 FROM games WHERE id = $1', [badGameId]);
    assert.equal(badGameRes.rowCount, 0);

    // Deterministic LATE failure AFTER lifecycle writes (games INSERT CHECK constraint fails)
    const lateStarterGameId = '018f2780-0000-7000-8000-000000000304';
    const lateStarterOpId = '018f2780-0000-7000-8000-000000000305';

    const lateStarterCreated = Game.create({
      gameId: lateStarterGameId,
      players: { white: USER_W, black: USER_B },
      timeControl: { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 },
      rated: false,
      at: 1000,
      source: 'seek',
      noShowAfterMs: 60_000,
    });
    const lateStarterCreatedEvent = lateStarterCreated.events[0]!;
    const lateStarterCanonPrep = prepareCreationAdmission(lateStarterCreated.game, {
      operationId: lateStarterOpId,
      rulesVersion: 'standard@1.0.0',
      at: 1000,
    });
    const lateStarterStartedEvent: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId: lateStarterGameId,
      operationId: lateStarterOpId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: lateStarterCanonPrep,
    };

    let starterStartedWritten = false;
    let starterGamesAttempted = false;
    const observedStarterPool = createQueryObserverPool(pool, (sql, params) => {
      if (sql.includes('INSERT INTO game_events') && params.includes('AdjudicationStarted')) {
        starterStartedWritten = true;
      }
      if (sql.includes('INSERT INTO games')) {
        starterGamesAttempted = true;
      }
    });

    const observedStarter = new PgGameStarter(observedStarterPool);
    const lateBadStarterStart: GameStart = {
      id: lateStarterGameId,
      variant: 'standard',
      rated: false,
      speed: 'invalid_speed' as unknown as GameStart['speed'],
      whiteId: USER_W,
      blackId: USER_B,
      startedAt: new Date(1000),
    };

    await assert.rejects(
      () => observedStarter.start(lateStarterGameId, [lateStarterCreatedEvent, lateStarterStartedEvent], lateBadStarterStart),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string; table?: string };
        return pgErr.code === '23514' && (pgErr.constraint === 'games_speed_check' || pgErr.table === 'games');
      },
    );

    // Verify execution order: Started event was persisted to transaction BEFORE games INSERT failed
    assert.equal(starterStartedWritten, true);
    assert.equal(starterGamesAttempted, true);

    // Verify full rollback: zero events, zero adjudications, zero games
    const starterEvCheck = await pool.query('SELECT 1 FROM game_events WHERE game_id = $1', [lateStarterGameId]);
    assert.equal(starterEvCheck.rowCount, 0);
    const starterAdjCheck = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [lateStarterGameId]);
    assert.equal(starterAdjCheck.rowCount, 0);
    const starterGameCheck = await pool.query('SELECT 1 FROM games WHERE id = $1', [lateStarterGameId]);
    assert.equal(starterGameCheck.rowCount, 0);
  });
});

test('identical Start retries: proving command retry, proving prepared retry, completed retry through genuine stepped proof', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = '018f2780-0000-7000-8000-000000000401';
    const opId = '018f2780-0000-7000-8000-000000000402';
    // Mate in 1 position: Queen on e7, King on g6 vs Black King on h8 -> White move e7g7#
    // Admitted through public store on unsourced game, proof requires genuine search stepping to establish readiness
    const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
    await createBaseGame(pool, gameId, FEN_MATE1, false);

    const store = new PgAdjudicationStore(pool);
    const initial = await store.startAdjudication({
      gameId,
      command: { kind: 'move', uci: 'e7g7' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(initial.status, 'started');
    assert.equal(initial.operationId, opId);
    const origPrepared = initial.prepared;

    // Retry 1: identical move command & context while proving returns proving status
    const retryCommand = await store.startAdjudication({
      gameId,
      command: { kind: 'move', uci: 'e7g7' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(retryCommand.status, 'proving');
    assert.equal(retryCommand.operationId, opId);
    assert.equal(retryCommand.startedSeq, 1);

    // Retry 2: identical prepared operation while proving returns proving status
    const retryPrepared = await store.startAdjudication({
      gameId,
      prepared: origPrepared,
    });
    assert.equal(retryPrepared.status, 'proving');
    assert.equal(retryPrepared.operationId, opId);
    assert.equal(retryPrepared.startedSeq, 1);

    // Ensure NO duplicate events were appended while proving (GameCreated + AdjudicationStarted)
    const evCount = await pool.query('SELECT count(*) AS c FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(evCount.rows[0]?.c, '2');

    // Genuine proof stepping to deterministic readiness: job starts active, steps solver, performs work
    const claim = await store.claimAdjudication({
      gameId,
      operationId: opId,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 60_000,
    });
    await store.createProofJob(gameId, opId);
    const jobBefore = store.getProofJob(opId);
    assert.equal(jobBefore?.status, 'active'); // genuine proof starts in active state

    const step = store.stepProofJob(opId, 1000);
    assert.equal(step.status, 'ready');
    assert.equal(step.handlesReady, true);
    assert.ok(step.deltaWork > 0); // algorithm genuinely performs positive delta work

    const receipt = await store.settleAdjudication({
      gameId,
      operationId: opId,
      grant: claim,
      resolutionAt: 1200,
    });
    assert.ok(receipt);
    assert.equal(receipt.operationId, opId);

    // Record baseline event count and head seq immediately after settlement
    const evAfterSettle = await pool.query<{ count: string; head: string }>(
      'SELECT count(*) AS count, max(seq) AS head FROM game_events WHERE game_id = $1',
      [gameId],
    );

    // Retry 3: identical command retry after completion returns recorded status and receipt
    const retryCompleted = await store.startAdjudication({
      gameId,
      command: { kind: 'move', uci: 'e7g7' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(retryCompleted.status, 'completed');
    assert.equal(retryCompleted.operationId, opId);
    assert.deepEqual(retryCompleted.receipt, receipt);

    // Retry 4: identical prepared operation retry after completion
    const retryCompletedPrep = await store.startAdjudication({
      gameId,
      prepared: origPrepared,
    });
    assert.equal(retryCompletedPrep.status, 'completed');
    assert.equal(retryCompletedPrep.operationId, opId);
    assert.deepEqual(retryCompletedPrep.receipt, receipt);

    // Assert event count and head seq remain completely unchanged after retries
    const evAfterRetries = await pool.query<{ count: string; head: string }>(
      'SELECT count(*) AS count, max(seq) AS head FROM game_events WHERE game_id = $1',
      [gameId],
    );
    assert.equal(evAfterRetries.rows[0]?.count, evAfterSettle.rows[0]?.count);
    assert.equal(evAfterRetries.rows[0]?.head, evAfterSettle.rows[0]?.head);

    // Terminal-base authorization (root ending) completed retry: ready at creation, settles without solver
    const termGameId = '018f2780-0000-7000-8000-000000000411';
    const termOpId = '018f2780-0000-7000-8000-000000000412';
    const FEN_TERMINAL = '4k3/4Q3/4K3/8/8/8/8/8 b - - 0 1';
    const termBase = await createBaseGame(pool, termGameId, FEN_TERMINAL, false);
    assert.equal(termBase.game.position.status().over, true);
    await store.startAdjudication({
      gameId: termGameId,
      command: { kind: 'resign' },
      context: { operationId: termOpId, color: 'b', at: 1100, rulesVersion: 'standard@1.0.0' },
    });
    const termClaim = await store.claimAdjudication({
      gameId: termGameId,
      operationId: termOpId,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 60_000,
    });
    await store.createProofJob(termGameId, termOpId);
    const termJobView = store.getProofJob(termOpId);
    assert.equal(termJobView?.status, 'ready'); // terminal-base authorization is ready on creation
    const termReceipt = await store.settleAdjudication({
      gameId: termGameId,
      operationId: termOpId,
      grant: termClaim,
      resolutionAt: 1200,
    });
    const termRetryCompleted = await store.startAdjudication({
      gameId: termGameId,
      command: { kind: 'resign' },
      context: { operationId: termOpId, color: 'b', at: 1100, rulesVersion: 'standard@1.0.0' },
    });
    assert.equal(termRetryCompleted.status, 'completed');
    assert.deepEqual(termRetryCompleted.receipt, termReceipt);
  });
});

test('changed immutable request conflicts, no-op shortcut prevented, fresh operation no-op on separate game', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = '018f2780-0000-7000-8000-000000000501';
    const opId = '018f2780-0000-7000-8000-000000000502';
    // Create unsourced base game (source: null) where ready demonstrably returns a no-op
    await createBaseGame(pool, gameId, undefined, false);

    const store = new PgAdjudicationStore(pool);
    const initial = await store.startAdjudication({
      gameId,
      command: { kind: 'resign' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(initial.status, 'started');

    // Differing command (abort instead of resign) with same operationId rejects
    await assert.rejects(
      () =>
        store.startAdjudication({
          gameId,
          command: { kind: 'abort' },
          context: {
            operationId: opId,
            color: 'w',
            at: 1100,
            rulesVersion: 'standard@1.0.0',
          },
        }),
      AdjudicationConflictError,
    );

    // Differing prepared operation (e.g. different at timestamp) rejects
    const alteredPrepared: PreparedOperation = {
      ...initial.prepared,
      at: 9999,
    };
    await assert.rejects(
      () =>
        store.startAdjudication({
          gameId,
          prepared: alteredPrepared,
        }),
      AdjudicationConflictError,
    );

    // Differing command that would produce a genuine no-op on this unsourced game (ready)
    // Reconciling existing operation rejects with AdjudicationConflictError (no no-op shortcut)
    await assert.rejects(
      () =>
        store.startAdjudication({
          gameId,
          command: { kind: 'ready' },
          context: {
            operationId: opId,
            color: 'w',
            at: 1100,
            rulesVersion: 'standard@1.0.0',
          },
        }),
      AdjudicationConflictError,
    );

    // For a genuinely NEW operation no-op, create a SEPARATE fresh unsourced game with no pending adjudication
    const freshNoopGameId = '018f2780-0000-7000-8000-000000000504';
    const freshNoopOpId = '018f2780-0000-7000-8000-000000000505';
    await createBaseGame(pool, freshNoopGameId, undefined, false);

    const evBefore = await pool.query<{ count: string; head: string }>(
      'SELECT count(*) AS count, max(seq) AS head FROM game_events WHERE game_id = $1',
      [freshNoopGameId],
    );

    const noopResult = await store.startAdjudication({
      gameId: freshNoopGameId,
      command: { kind: 'ready' },
      context: {
        operationId: freshNoopOpId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(noopResult.status, 'noop');
    assert.equal(noopResult.reason, 'unsourced');

    // Fresh operation creates zero obligations in game_adjudications
    const freshAdjCheck = await pool.query('SELECT 1 FROM game_adjudications WHERE operation_id = $1', [freshNoopOpId]);
    assert.equal(freshAdjCheck.rowCount, 0);

    // Event count and head remain completely unchanged on freshNoopGameId
    const evAfter = await pool.query<{ count: string; head: string }>(
      'SELECT count(*) AS count, max(seq) AS head FROM game_events WHERE game_id = $1',
      [freshNoopGameId],
    );
    assert.equal(evAfter.rows[0]?.count, evBefore.rows[0]?.count);
    assert.equal(evAfter.rows[0]?.head, evBefore.rows[0]?.head);

    // Ensure event count on initial game remains exactly 2 (GameCreated and AdjudicationStarted for opId)
    const origEvCount = await pool.query('SELECT count(*) AS c FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(origEvCount.rows[0]?.c, '2');
  });
});

test('boundary fault injection: lost-ACK after real PostgreSQL COMMIT recovers cleanly via identical retry', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = '018f2780-0000-7000-8000-000000000601';
    const opId = '018f2780-0000-7000-8000-000000000602';
    await createBaseGame(pool, gameId);

    // Instrument pool so the first COMMIT executes on PostgreSQL but throws before acknowledging
    let injectAckLoss = true;
    const instrumentedPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'connect') {
          return async function (...args: unknown[]): Promise<PoolClient> {
            const client = await target.connect();
            const origQuery = client.query.bind(client);
            client.query = async function (queryTextOrConfig: unknown, ...queryArgs: unknown[]) {
              const res = await (origQuery as (...a: unknown[]) => Promise<unknown>)(queryTextOrConfig, ...queryArgs);
              if (
                injectAckLoss &&
                typeof queryTextOrConfig === 'string' &&
                queryTextOrConfig.trim().toUpperCase() === 'COMMIT'
              ) {
                injectAckLoss = false;
                throw new Error('Simulated network failure: COMMIT acknowledged to server but lost before driver ACK');
              }
              return res;
            } as typeof client.query;
            return client;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const storeWithFault = new PgAdjudicationStore(instrumentedPool);
    const startParams = {
      gameId,
      command: { kind: 'ready' } as const,
      context: {
        operationId: opId,
        color: 'w' as const,
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    };

    // First attempt: COMMIT executes on PostgreSQL, but throws the lost-ACK error
    await assert.rejects(
      () => storeWithFault.startAdjudication(startParams),
      /Simulated network failure: COMMIT acknowledged to server but lost before driver ACK/,
    );

    // Verify PostgreSQL did durably commit the transaction
    const rowCheck = await pool.query<{ execution_state: string }>(
      'SELECT execution_state FROM game_adjudications WHERE game_id = $1 AND operation_id = $2',
      [gameId, opId],
    );
    assert.equal(rowCheck.rowCount, 1);
    assert.equal(rowCheck.rows[0]!.execution_state, 'proving');

    const evCheck = await pool.query('SELECT count(*) AS c FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(evCheck.rows[0]?.c, '2');

    // Caller retries identical command on normal store: reconciles existing row and returns proving
    const normalStore = new PgAdjudicationStore(pool);
    const retryResult = await normalStore.startAdjudication(startParams);
    assert.equal(retryResult.status, 'proving');
    assert.equal(retryResult.operationId, opId);
    assert.equal(retryResult.startedSeq, 1);

    // Still exactly 2 events in game_events (no duplicate Started inserted)
    const evFinalCheck = await pool.query('SELECT count(*) AS c FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(evFinalCheck.rows[0]?.c, '2');
  });
});
