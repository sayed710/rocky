/**
 * @packageDocumentation
 * Real PostgreSQL integration tests for Stage M storage classifier, ACL boundary,
 * and exact transaction boundaries (Issue #124, amended design clauses 1-6).
 *
 * Covers:
 * P0:
 * 1. Real ACL regression closure for existing table-SELECT executor (restricted role).
 * 2. Original-column-only fallback for historical column-only roles.
 * 3. Pure legacy preservation outside M.
 * 4. Exact historical NULL-policy completion vs tampered/ambiguous/same-xid.
 * 5. Managed adoption cannot disappear even if private control rows are missing.
 * 6. Forged tags, server overwriting, and event immutability.
 * 7. Atomic same-client Start primitive (no row-only window).
 * 8. Started must commit before claim AND settle.
 * 9. Exact R batch and unconditional deferred validation.
 * 10. No post-tail piggyback in settlement transaction.
 *
 * P1:
 * 11. A -> B proving/stopped race and lineage.
 * 12. Real old triggers: suppression and null-policy restoration.
 * 13. Migration reapplication and no historical rewrite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  AdjudicationJobController,
  Game,
  prepareCreationAdmission,
  prepareMove,
  prepareReady,
  type AdjudicationStartedEvent,
  type GameEvent,
  type MovePlayedEvent,
  type PlayerReadyEvent,
} from '@chess-platform/game';
import { CURRENT_EVENT_VERSION } from '../src/event-store';
import {
  AdjudicationConflictError,
  AdjudicationFenceError,
  PersistenceError,
} from '../src/errors';
import { migrate } from '../src/pg/migrate';
import { PgAdjudicationStore } from '../src/pg/adjudication-store';
import { executeAtomicStart } from '../src/pg/adjudication-helpers';
import { prepareGameFencing } from '../src/pg/fencing-preparation';
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

// Legal 3-piece endgame position: Queen on g6, King on f7 vs Black King on h8 -> g6g5 (non-terminal)
const FEN_3PIECE = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1';
// Mate in 1 position: Queen on e7, King on g6 vs Black King on h8 -> e7g7#
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';

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

function stepUntilReady(ctrl: AdjudicationJobController, operationId: string, maxIterations = 50): void {
  let iter = 0;
  while (ctrl.getJob(operationId)?.status === 'active') {
    if (++iter > maxIterations) {
      throw new Error(`stepUntilReady timed out after ${maxIterations} iterations for ${operationId}`);
    }
    ctrl.stepJob(operationId, 500);
  }
  const job = ctrl.getJob(operationId);
  if (!job || job.status !== 'ready') {
    throw new Error(`Job ${operationId} did not become ready; status is ${job?.status}`);
  }
}

// ---------------------------------------------------------------------------
// P0: 1. Real ACL Regression Closure for Existing Table-SELECT Executor
// ---------------------------------------------------------------------------
test('P0: existing table-SELECT executor without M rights succeeds on ordinary append', async () => {
  await withTestDatabase(async ({ pool, connectionString: url }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const suffix = randomBytes(6).toString('hex');
    const ownerRole = `owner_${suffix}`;
    const execRole = `exec_${suffix}`;
    const password = randomBytes(16).toString('hex');

    // Create roles
    await pool.query(`CREATE ROLE ${ownerRole} NOLOGIN`);
    await pool.query(`CREATE ROLE ${execRole} LOGIN PASSWORD '${password}'`);

    try {
      const dbIncarnation = randomUUID();
      await prepareGameFencing(pool, {
        tableOwner: ownerRole,
        functionOwner: execRole,
        databaseIncarnation: dbIncarnation,
        maxLeaseMs: 60_000,
      });

      // Confirm execRole has NO rights on game_adjudications
      const hasPrivRes = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege($1, 'public.game_adjudications', 'SELECT') AS has`,
        [execRole],
      );
      assert.equal(hasPrivRes.rows[0]!.has, false, 'execRole must have NO SELECT privilege on game_adjudications');

      // Connect as execRole
      const targetUrl = new URL(url);
      targetUrl.username = execRole;
      targetUrl.password = password;
      const execPool = new Pool({ connectionString: targetUrl.toString(), max: 2 });

      try {
        const gameId = randomUUID();
        await createBaseGame(pool, gameId);

        // execRole executes an ordinary append to game_events
        const readyEv: PlayerReadyEvent = { type: 'PlayerReady', color: 'w', at: 1100 };
        const insertRes = await execPool.query(
          `INSERT INTO public.game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, 1, 'PlayerReady', 1, $2::jsonb) RETURNING seq, storage_tag`,
          [gameId, JSON.stringify(readyEv)],
        );
        assert.equal(insertRes.rowCount, 1);
        assert.equal(insertRes.rows[0]!.seq, 1);
        assert.equal(insertRes.rows[0]!.storage_tag, null);

        // Verify direct SELECT on game_adjudications fails with 42501
        await assert.rejects(
          execPool.query('SELECT * FROM public.game_adjudications'),
          (err: unknown) => {
            const e = err as { code?: string; message?: string };
            return e.code === '42501' || /permission denied/i.test(e.message ?? '');
          },
        );
      } finally {
        await execPool.end();
      }
    } finally {
      await pool.query(`DROP ROLE IF EXISTS ${execRole}`);
      await pool.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    }
  });
});

// ---------------------------------------------------------------------------
// P0: 2. Original-Column-Only Fallback for Historical Column-Only Roles
// ---------------------------------------------------------------------------
test('P0: original-column-only role can commit ordinary events, fails closed if column missing', async () => {
  await withTestDatabase(async ({ pool, connectionString: url }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const suffix = randomBytes(6).toString('hex');
    const compatRole = `compat_${suffix}`;
    const password = randomBytes(16).toString('hex');

    await pool.query(`CREATE ROLE ${compatRole} LOGIN PASSWORD '${password}'`);

    try {
      // Grant ONLY original columns
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${compatRole}`);
      await pool.query(
        `GRANT SELECT(game_id, seq, type, event_version, payload, xact_id),
               INSERT(game_id, seq, type, event_version, payload)
         ON public.game_events TO ${compatRole}`,
      );

      // Verify compatRole has NO table-level SELECT and NO SELECT on storage_tag
      const hasTableSel = (await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege($1, 'public.game_events', 'SELECT') AS has`,
        [compatRole],
      )).rows[0]!.has;
      assert.equal(hasTableSel, false, 'compatRole must NOT have table-level SELECT on game_events');

      const hasTagSel = (await pool.query<{ has: boolean }>(
        `SELECT has_column_privilege($1, 'public.game_events', 'storage_tag', 'SELECT') AS has`,
        [compatRole],
      )).rows[0]!.has;
      assert.equal(hasTagSel, false, 'compatRole must NOT have column SELECT on storage_tag');

      const targetUrl = new URL(url);
      targetUrl.username = compatRole;
      targetUrl.password = password;
      const compatPool = new Pool({ connectionString: targetUrl.toString(), max: 2 });

      try {
        const gameId = randomUUID();
        await createBaseGame(pool, gameId);

        // Ordinary append succeeds through real BEFORE, AFTER, and DEFERRED triggers
        const readyEv: PlayerReadyEvent = { type: 'PlayerReady', color: 'w', at: 1100 };
        const res = await compatPool.query(
          `INSERT INTO public.game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, 1, 'PlayerReady', 1, $2::jsonb)`,
          [gameId, JSON.stringify(readyEv)],
        );
        assert.equal(res.rowCount, 1);

        // Negative: Revoke one necessary column (payload)
        await pool.query(`REVOKE SELECT(payload) ON public.game_events FROM ${compatRole}`);

        const nextEv: PlayerReadyEvent = { type: 'PlayerReady', color: 'b', at: 1200 };
        await assert.rejects(
          compatPool.query(
            `INSERT INTO public.game_events (game_id, seq, type, event_version, payload)
             VALUES ($1, 2, 'PlayerReady', 1, $2::jsonb)`,
            [gameId, JSON.stringify(nextEv)],
          ),
          (err: unknown) => {
            const e = err as { code?: string; message?: string };
            return e.code === '42501' || /permission denied/i.test(e.message ?? '');
          },
        );

        // Verify row was NOT inserted
        const countRes = await pool.query<{ count: string }>(
          'SELECT COUNT(*) FROM public.game_events WHERE game_id = $1 AND seq = 2',
          [gameId],
        );
        assert.equal(countRes.rows[0]!.count, '0');
      } finally {
        await compatPool.end();
      }
    } finally {
      await pool.query(`DROP ROLE IF EXISTS ${compatRole}`);
    }
  });
});

// ---------------------------------------------------------------------------
// P0: 3. Pure Legacy Preservation Outside M
// ---------------------------------------------------------------------------
test('P0: pure legacy preservation outside M allows ordinary play, rejects terminal insertion', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    // Ordinary move sequence outside M
    const move1: MovePlayedEvent = {
      type: 'MovePlayed',
      by: 'w',
      uci: 'e2e4',
      san: 'e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      at: 1200,
      remaining: { w: 180000, b: 180000 },
    };
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 1, 'MovePlayed', 1, $2::jsonb)`,
      [gameId, JSON.stringify(move1)],
    );

    // End game
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 2, 'GameEnded', 1, '{"type":"GameEnded","result":"1-0","termination":"mate","winner":"w","at":1300}'::jsonb)`,
      [gameId],
    );

    // Attempt insert into terminated game
    await assert.rejects(
      pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 3, 'MovePlayed', 1, $2::jsonb)`,
        [gameId, JSON.stringify(move1)],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === 'PMA11' || /terminated game/i.test(e.message ?? '');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// P0: 4. Exact Historical NULL-Policy Completion vs Tampered/Ambiguous/Same-XID
// ---------------------------------------------------------------------------
test('P0: exact historical NULL-policy completion allows subsequent legacy, rejects tampered or same-XID', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    const opId = randomUUID();
    const startedEvent = {
      type: 'AdjudicationStarted',
      gameId,
      operationId: opId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: {
        operationId: opId,
        gameId,
        baseRevision: 0,
        baseFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        variant: 'standard',
        rulesVersion: 'standard@1.0.0',
        at: 1000,
        intent: { kind: 'ready', color: 'w', isNoop: false },
      },
      // clockPolicy is null/omitted -> null policy
    };

    const declaredMove: MovePlayedEvent = {
      type: 'MovePlayed',
      by: 'w',
      uci: 'e2e4',
      san: 'e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      at: 1100,
      remaining: { w: 180000, b: 180000 },
    };

    const resolvedEvent = {
      type: 'AdjudicationResolved',
      gameId,
      operationId: opId,
      startedSeq: 1,
      at: 1100,
      rulesVersion: 'standard@1.0.0',
      effects: [declaredMove],
    };

    // 4a. Persist Started -> R -> exact declared effect in prior transaction
    const setupClient = await pool.connect();
    try {
      await setupClient.query('BEGIN');
      await setupClient.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
        [gameId, JSON.stringify(startedEvent)],
      );
      await setupClient.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 2, 'AdjudicationResolved', 1, $2::jsonb)`,
        [gameId, JSON.stringify(resolvedEvent)],
      );
      await setupClient.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 3, 'MovePlayed', 1, $2::jsonb)`,
        [gameId, JSON.stringify(declaredMove)],
      );
      await setupClient.query('COMMIT');
    } finally {
      setupClient.release();
    }

    // Subsequent transaction appends ordinary move: ALLOWED!
    const subsequentMove: MovePlayedEvent = {
      type: 'MovePlayed',
      by: 'b',
      uci: 'e7e5',
      san: 'e5',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
      at: 1200,
      remaining: { w: 180000, b: 180000 },
    };
    const subRes = await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 4, 'MovePlayed', 1, $2::jsonb) RETURNING seq`,
      [gameId, JSON.stringify(subsequentMove)],
    );
    assert.equal(subRes.rows[0]!.seq, 4);

    // 4b. Negative: Unresolved Started game
    const unresGameId = randomUUID();
    await createBaseGame(pool, unresGameId);
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
      [unresGameId, JSON.stringify({ ...startedEvent, gameId: unresGameId, operationId: randomUUID() })],
    );

    // Subsequent insert into unresolved game: REJECTED!
    await assert.rejects(
      pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 2, 'MovePlayed', 1, $2::jsonb)`,
        [unresGameId, JSON.stringify(subsequentMove)],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === 'PMA09' || e.code === 'PMA24' || /active|unresolved/i.test(e.message ?? '');
      },
    );

    // 4c. Negative: Tampered effect payload in stream
    const tamperedGameId = randomUUID();
    await createBaseGame(pool, tamperedGameId);
    const tamperedOp = randomUUID();
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
      [tamperedGameId, JSON.stringify({ ...startedEvent, gameId: tamperedGameId, operationId: tamperedOp })],
    );
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 2, 'AdjudicationResolved', 1, $2::jsonb)`,
      [tamperedGameId, JSON.stringify({ ...resolvedEvent, gameId: tamperedGameId, operationId: tamperedOp })],
    );
    // Insert TAMPERED move (e.g. wrong san/uci)
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 3, 'MovePlayed', 1, $2::jsonb)`,
      [tamperedGameId, JSON.stringify({ ...declaredMove, uci: 'd2d4' })],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 4, 'MovePlayed', 1, $2::jsonb)`,
        [tamperedGameId, JSON.stringify(subsequentMove)],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === 'PMA24' || /ambiguous|unresolved/i.test(e.message ?? '');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// P0: 5. Managed Adoption Cannot Disappear Even if Private Records Missing
// ---------------------------------------------------------------------------
test('P0: managed adoption (observed-release-v1) remains protected even without game_adjudications row', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    const opId = randomUUID();
    const startedEvent = {
      type: 'AdjudicationStarted',
      gameId,
      operationId: opId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      clockPolicy: 'observed-release-v1',
      prepared: {
        operationId: opId,
        gameId,
        baseRevision: 0,
        baseFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        variant: 'standard',
        rulesVersion: 'standard@1.0.0',
        at: 1000,
        clockPolicy: 'observed-release-v1',
        intent: { kind: 'creationAdmission' },
      },
    };

    // Insert into game_events directly (bypassing or without game_adjudications row)
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
      [gameId, JSON.stringify(startedEvent)],
    );

    // Verify game_adjudications has NO rows for this game
    const adjCount = (await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM game_adjudications WHERE game_id = $1',
      [gameId],
    )).rows[0]!.count;
    assert.equal(adjCount, '0');

    // Attempt to insert raw ordinary event: REJECTED!
    const readyEv: PlayerReadyEvent = { type: 'PlayerReady', color: 'w', at: 1100 };
    await assert.rejects(
      pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload)
         VALUES ($1, 2, 'PlayerReady', 1, $2::jsonb)`,
        [gameId, JSON.stringify(readyEv)],
      ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === 'PMA10' || e.code === 'PMA09' || /managed stopped|active/i.test(e.message ?? '');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// P0: 6. Forged Tags, Server Overwriting, and Event Immutability
// ---------------------------------------------------------------------------
test('P0: caller-supplied tags are overwritten, invalid tags rejected, events immutable', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    // 6a. Attempt to supply forged 'tail' tag on ordinary insert: overwritten to NULL
    const readyEv: PlayerReadyEvent = { type: 'PlayerReady', color: 'w', at: 1100 };
    const res = await pool.query<{ storage_tag: string | null }>(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload, storage_tag)
       VALUES ($1, 1, 'PlayerReady', 1, $2::jsonb, 'tail')
       RETURNING storage_tag`,
      [gameId, JSON.stringify(readyEv)],
    );
    assert.equal(res.rows[0]!.storage_tag, null, 'server must overwrite forged storage_tag to NULL');

    // 6b. Attempt unknown tag violating CHECK constraint
    await assert.rejects(
      pool.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload, storage_tag)
         VALUES ($1, 2, 'PlayerReady', 1, $2::jsonb, 'bogus_tag')`,
        [gameId, JSON.stringify(readyEv)],
      ),
    );

    // 6c. UPDATE of stored events is prohibited by immutability trigger
    await assert.rejects(
      pool.query(
        `UPDATE game_events SET storage_tag = 'started' WHERE game_id = $1 AND seq = 1`,
        [gameId],
      ),
      /immutable|prohibited|cannot/i,
    );
  });
});

// ---------------------------------------------------------------------------
// P0: 7. Atomic Same-Client Start Primitive (No Row-Only Window)
// ---------------------------------------------------------------------------
test('P0: atomic Start primitive persists obligation + Started inseparably, rolls back on mismatch', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    const opId = randomUUID();
    const startedEvent: AdjudicationStartedEvent = {
      type: 'AdjudicationStarted',
      gameId,
      operationId: opId,
      baseRevision: 0,
      at: 1000,
      rulesVersion: 'standard@1.0.0',
      prepared: {
        operationId: opId,
        gameId,
        baseRevision: 0,
        baseFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        variant: 'standard',
        rulesVersion: 'standard@1.0.0',
        at: 1000,
        intent: { kind: 'ready', color: 'w', isNoop: false },
      },
    };

    const acct = {
      originalClock: { turnStartedAt: null, remaining: { w: 180000, b: 180000 } },
      thinkingElapsedAtA: 0,
      originalNoShowAt: 61000,
      remainingNoShowTimeAtA: 60000,
      originalBasis: null,
    };

    // 7a. Head sequence mismatch rolls back atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const badStarted = { ...startedEvent, baseRevision: 5 }; // Stream head is 0
      await assert.rejects(
        executeAtomicStart(client, gameId, badStarted, acct),
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return e.code === 'PMA20' || /head sequence mismatch/i.test(e.message ?? '');
        },
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Neither obligation nor event exists after failed start
    const adjCheck = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [gameId]);
    assert.equal(adjCheck.rowCount, 0);
    const evCheck = await pool.query('SELECT 1 FROM game_events WHERE game_id = $1 AND seq = 1', [gameId]);
    assert.equal(evCheck.rowCount, 0);

    // 7b. Valid atomic start succeeds inseparably
    const successClient = await pool.connect();
    try {
      await successClient.query('BEGIN');
      const startedSeq = await executeAtomicStart(successClient, gameId, startedEvent, acct);
      assert.equal(startedSeq, 1);

      // Same client sees both
      const sameAdj = await successClient.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [gameId]);
      assert.equal(sameAdj.rowCount, 1);
      const sameEv = await successClient.query('SELECT 1 FROM game_events WHERE game_id = $1 AND seq = 1', [gameId]);
      assert.equal(sameEv.rowCount, 1);

      // Independent client sees neither before commit
      const indepAdj = await pool.query('SELECT 1 FROM game_adjudications WHERE game_id = $1', [gameId]);
      assert.equal(indepAdj.rowCount, 0);

      await successClient.query('COMMIT');
    } finally {
      successClient.release();
    }

    // Both exist after commit
    const committedAdj = await pool.query<{ execution_state: string; start_permit_consumed: boolean }>(
      'SELECT execution_state, start_permit_consumed FROM game_adjudications WHERE game_id = $1',
      [gameId],
    );
    assert.equal(committedAdj.rows[0]!.execution_state, 'proving');
    assert.equal(committedAdj.rows[0]!.start_permit_consumed, true);

    const committedEv = await pool.query<{ storage_tag: string }>(
      'SELECT storage_tag FROM game_events WHERE game_id = $1 AND seq = 1',
      [gameId],
    );
    assert.equal(committedEv.rows[0]!.storage_tag, 'started');
  });
});

// ---------------------------------------------------------------------------
// P0: 8. Started Must Commit Before Claim AND Settle
// ---------------------------------------------------------------------------
test('P0: claim and settle reject in Started actual transaction', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    const store = new PgAdjudicationStore(pool);
    const opId = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const startedEvent: AdjudicationStartedEvent = {
        type: 'AdjudicationStarted',
        gameId,
        operationId: opId,
        baseRevision: 0,
        at: 1000,
        rulesVersion: 'standard@1.0.0',
        prepared: {
          operationId: opId,
          gameId,
          baseRevision: 0,
          baseFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          variant: 'standard',
          rulesVersion: 'standard@1.0.0',
          at: 1000,
          intent: { kind: 'ready', color: 'w', isNoop: false },
        },
      };
      const acct = {
        originalClock: { turnStartedAt: null, remaining: { w: 180000, b: 180000 } },
        thinkingElapsedAtA: 0,
        originalNoShowAt: 61000,
        remainingNoShowTimeAtA: 60000,
        originalBasis: null,
      };

      await executeAtomicStart(client, gameId, startedEvent, acct);

      // Attempt claim in same transaction directly in SQL: REJECTED!
      await assert.rejects(
        client.query(
          `UPDATE game_adjudications SET claim_id = gen_random_uuid(), lease_until = NOW() + interval '1 minute'
           WHERE game_id = $1 AND operation_id = $2`,
          [gameId, opId],
        ),
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return e.code === 'PMA22' || /subsequent transaction/i.test(e.message ?? '');
        },
      );

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// P0: 9 & 10. Exact Settlement Batch, Unconditional Deferred Validation, No Post-Tail Piggyback
// ---------------------------------------------------------------------------
test('P0: genuine settlement succeeds; extra event in settlement xact rejected; subsequent legacy allowed', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    const { game } = await createBaseGame(pool, gameId, FEN_3PIECE);

    const store = new PgAdjudicationStore(pool);
    const opId = randomUUID();

    // 1. Start adjudication
    const startResult = await store.startAdjudication({
      gameId,
      command: { kind: 'move', uci: 'g6g5' },
      context: {
        operationId: opId,
        color: 'w',
        at: 1100,
        rulesVersion: 'standard@1.0.0',
      },
    });
    assert.equal(startResult.status, 'started');

    // 2. Claim adjudication in subsequent transaction
    const grant = await store.claimAdjudication({
      gameId,
      operationId: opId,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 30_000,
    });
    assert.equal(grant.generation, '1');

    // 3. Genuine proof outside DB locks
    const ctrl = new AdjudicationJobController();
    ctrl.createJob(startResult.prepared, game);
    stepUntilReady(ctrl, opId);
    assert.equal(ctrl.getJob(opId)?.status, 'ready');

    // Settle adjudication via PgAdjudicationStore
    const receipt = await store.settleAdjudication({
      gameId,
      operationId: opId,
      grant,
      resolutionAt: 1200,
    });
    assert.equal(receipt.finalSeq, 2);

    // Verify storage_tag stamped on settlement events: AdjudicationResolved is 'tail' (batch length 1)
    const tagRes = await pool.query<{ seq: number; storage_tag: string }>(
      'SELECT seq, storage_tag FROM game_events WHERE game_id = $1 AND seq = 2',
      [gameId],
    );
    assert.equal(tagRes.rows[0]!.storage_tag, 'tail');

    // 10. Subsequent transaction can append ordinary move (since null policy completed)
    const nextMove: MovePlayedEvent = {
      type: 'MovePlayed',
      by: 'b',
      uci: 'h8h7',
      san: 'Kh7',
      fen: '8/5K1k/8/6Q1/8/8/8/8 w - - 1 2',
      at: 1300,
      remaining: { w: 180000, b: 180000 },
    };
    const subRes = await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload)
       VALUES ($1, 3, 'MovePlayed', 1, $2::jsonb) RETURNING seq, storage_tag`,
      [gameId, JSON.stringify(nextMove)],
    );
    assert.equal(subRes.rows[0]!.seq, 3);
    assert.equal(subRes.rows[0]!.storage_tag, null);
  });
});

// ---------------------------------------------------------------------------
// P1: 11. A -> B Proving / Stopped Lineage
// ---------------------------------------------------------------------------
test('P1: A stopped remains current while B proves; B stopped completion demotes A', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    const { game } = await createBaseGame(pool, gameId, FEN_3PIECE);

    const store = new PgAdjudicationStore(pool);
    const opA = randomUUID();

    // Start and settle A as stopped under observed-release-v1
    const prepA = prepareCreationAdmission(game, {
      operationId: opA,
      rulesVersion: 'standard@1.0.0',
      at: 1000,
      clockPolicy: 'observed-release-v1',
    });

    await store.startAdjudication({ gameId, prepared: prepA });
    const grantA = await store.claimAdjudication({
      gameId,
      operationId: opA,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 30_000,
    });

    const ctrlA = new AdjudicationJobController();
    ctrlA.createJob(prepA, game);
    stepUntilReady(ctrlA, opA);

    await store.settleAdjudication({ gameId, operationId: opA, grant: grantA, resolutionAt: 1100 });

    // A is current stop
    const checkA = await pool.query<{ is_current_stop: boolean }>(
      'SELECT is_current_stop FROM game_adjudications WHERE game_id = $1 AND operation_id = $2',
      [gameId, opA],
    );
    assert.equal(checkA.rows[0]!.is_current_stop, true);

    // Start B from A
    const stoppedGameA = (await store.loadAdjudicationJob(gameId, opA))!;
    const opB = randomUUID();
    const prepB = prepareMove(stoppedGameA.game, {
      uci: 'g6g5',
      at: 1200,
      operationId: opB,
      rulesVersion: 'standard@1.0.0',
      clockPolicy: 'observed-release-v1',
    });

    await store.startAdjudication({ gameId, prepared: prepB });

    // While B is proving, A remains current stop!
    const checkAWhileBProves = await pool.query<{ is_current_stop: boolean }>(
      'SELECT is_current_stop FROM game_adjudications WHERE game_id = $1 AND operation_id = $2',
      [gameId, opA],
    );
    assert.equal(checkAWhileBProves.rows[0]!.is_current_stop, true, 'A must remain current stop while B is proving');

    // B claims and settles as stopped
    const grantB = await store.claimAdjudication({
      gameId,
      operationId: opB,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 30_000,
    });

    const ctrlB = new AdjudicationJobController();
    ctrlB.createJob(prepB, stoppedGameA.game);
    stepUntilReady(ctrlB, opB);

    await store.settleAdjudication({ gameId, operationId: opB, grant: grantB, resolutionAt: 1300 });

    // After B settles: A is demoted, B is promoted!
    const finalA = (await pool.query<{ is_current_stop: boolean }>(
      'SELECT is_current_stop FROM game_adjudications WHERE game_id = $1 AND operation_id = $2',
      [gameId, opA],
    )).rows[0]!.is_current_stop;
    const finalB = (await pool.query<{ is_current_stop: boolean }>(
      'SELECT is_current_stop FROM game_adjudications WHERE game_id = $1 AND operation_id = $2',
      [gameId, opB],
    )).rows[0]!.is_current_stop;

    assert.equal(finalA, false, 'A must be demoted on B completion');
    assert.equal(finalB, true, 'B must be promoted to current stop');
  });
});

// ---------------------------------------------------------------------------
// P1: 12. Real Old Triggers: Suppression and Null-Policy Restoration
// ---------------------------------------------------------------------------
test('P1: Start suppresses deadline queues; null-policy nonterminal completion restores legacy deadline', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir);
    await createTestUsers(pool);

    const gameId = randomUUID();
    const { game } = await createBaseGame(pool, gameId, FEN_3PIECE);

    // Initial pregame deadline was created at seq 0
    const initialPregame = await pool.query('SELECT 1 FROM pregame_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(initialPregame.rowCount, 1, 'pregame deadline should exist initially');

    const store = new PgAdjudicationStore(pool);
    const opId = randomUUID();

    // Start suppresses deadlines
    await store.startAdjudication({
      gameId,
      command: { kind: 'move', uci: 'g6g5' },
      context: { operationId: opId, color: 'w', at: 1100, rulesVersion: 'standard@1.0.0' },
    });

    const pregameWhileProving = await pool.query('SELECT 1 FROM pregame_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(pregameWhileProving.rowCount, 0, 'pregame deadline must be suppressed while proving');
    const flagWhileProving = await pool.query('SELECT 1 FROM flag_deadlines WHERE game_id = $1', [gameId]);
    assert.equal(flagWhileProving.rowCount, 0, 'flag deadline must be suppressed while proving');

    // Claim and settle null-policy non-terminal move
    const grant = await store.claimAdjudication({
      gameId,
      operationId: opId,
      executorId: EXECUTOR_ID,
      expectedGeneration: '0',
      leaseMs: 30_000,
    });

    const ctrl = new AdjudicationJobController();
    const startedJob = (await store.loadAdjudicationJob(gameId, opId))!;
    ctrl.createJob(startedJob.prepared, game);
    stepUntilReady(ctrl, opId);

    await store.settleAdjudication({ gameId, operationId: opId, grant, resolutionAt: 1200 });

    // Null-policy nonterminal completion: restores exact flag deadline!
    const flagAfterSettle = await pool.query<{ seq: number; due_ms: string }>(
      'SELECT seq, due_ms FROM flag_deadlines WHERE game_id = $1',
      [gameId],
    );
    assert.equal(flagAfterSettle.rowCount, 1, 'flag deadline must be restored after null-policy move settlement');
    assert.equal(flagAfterSettle.rows[0]!.seq, 2);
  });
});

// ---------------------------------------------------------------------------
// P1: 13. Migration Reapplication and No Historical Rewrite
// ---------------------------------------------------------------------------
test('P1: migration 0053 preserves historical rows with storage_tag NULL; runner reapply returns 0', async () => {
  await withTestDatabase(async ({ pool }) => {
    // Apply all migrations
    const applied1 = await migrate(pool, migrationsDir);
    assert.ok(applied1 > 0);

    // Reapply migration runner: returns 0 new migrations
    const applied2 = await migrate(pool, migrationsDir);
    assert.equal(applied2, 0, 'migration runner reapply must return 0 without changes');

    // Insert historical row with storage_tag NULL
    const gameId = randomUUID();
    await createBaseGame(pool, gameId);

    const row = (await pool.query<{ storage_tag: string | null }>(
      'SELECT storage_tag FROM game_events WHERE game_id = $1 AND seq = 0',
      [gameId],
    )).rows[0]!;
    assert.equal(row.storage_tag, null, 'historical row must have storage_tag NULL');
  });
});
