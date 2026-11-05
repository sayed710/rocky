/**
 * @packageDocumentation
 * Real PostgreSQL tests for least-privilege ownership of the 0053 SECURITY DEFINER routines.
 *
 * 1. After preparation every routine is owned by the dedicated NOLOGIN role, nothing else can
 *    execute it, and a full adjudication lifecycle still works through the real store.
 * 2. The owner holds only what the routines use: as that role, DDL, trigger disabling, TRUNCATE,
 *    event writes, unrelated reads and CREATE in public are all refused.
 * 3. Unsafe owners are refused atomically, and preparation is idempotent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game } from '@chess-platform/game';
import { PersistenceError } from '../src/errors';
import { migrate } from '../src/pg/migrate';
import { PgAdjudicationStore } from '../src/pg/adjudication-store';
import { ADJUDICATION_DEFINER_ROUTINES, prepareAdjudicationGuard } from '../src/pg/adjudication-preparation';
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
let counter = 0;
const uuid = (): string => `018f2780-0000-7000-8000-${(0xe00000000000 + ++counter).toString(16)}`;

function hasCode(code: string) {
  return (err: unknown): boolean => {
    assert.equal((err as { code?: string }).code, code, `expected ${code}, got ${String((err as Error).message)}`);
    return true;
  };
}

/** A fresh role name per test: roles are cluster-wide and tests share the cluster. */
async function withRole<T>(pool: Pool, attributes: string, body: (name: string) => Promise<T>): Promise<T> {
  const name = `adj_guard_${randomBytes(5).toString('hex')}`;
  await pool.query(`CREATE ROLE ${name} ${attributes}`);
  try {
    return await body(name);
  } finally {
    await pool.query(`REASSIGN OWNED BY ${name} TO CURRENT_USER`).catch(() => undefined);
    await pool.query(`DROP OWNED BY ${name}`).catch(() => undefined);
    await pool.query(`DROP ROLE ${name}`);
  }
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

async function routineOwners(pool: Pool): Promise<Array<{ owner: string; public_exec: boolean }>> {
  return (await pool.query<{ owner: string; public_exec: boolean }>(
    `SELECT pg_get_userbyid(p.proowner) AS owner,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE') AS public_exec
     FROM unnest($1::text[]) AS s(sig) JOIN pg_proc p ON p.oid = s.sig::regprocedure`,
    [ADJUDICATION_DEFINER_ROUTINES],
  )).rows;
}

test('prepared routines run as the dedicated owner and the full lifecycle still works', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    await withRole(pool, 'NOLOGIN', async (owner) => {
      await prepareAdjudicationGuard(pool, { functionOwner: owner });
      const owners = await routineOwners(pool);
      assert.equal(owners.length, ADJUDICATION_DEFINER_ROUTINES.length);
      assert.ok(owners.every((o) => o.owner === owner && !o.public_exec), JSON.stringify(owners));

      // Idempotent: a second run changes nothing and succeeds.
      await prepareAdjudicationGuard(pool, { functionOwner: owner });
      assert.deepEqual(await routineOwners(pool), owners);

      const store = new PgAdjudicationStore(pool);
      const gameId = await createGame(pool);
      const operationId = uuid();
      const started = await store.startAdjudication({
        gameId, command: { kind: 'move', uci: 'e7e4' },
        context: { operationId, color: 'w', at: 1100, rulesVersion: 'standard@1.0.0' },
      });
      assert.equal(started.status, 'started');
      await assert.rejects(
        pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 2, 'DrawOffered', 1, '{"type":"DrawOffered","by":"b","at":1}')`, [gameId]),
        hasCode('PMA09'),
      );
      const grant = await store.claimAdjudication({
        gameId, operationId, executorId: EXECUTOR, expectedGeneration: '0', leaseMs: 60_000,
        intent: PgAdjudicationStore.newClaimIntent(),
      });
      await store.createProofJob(gameId, operationId);
      let status = store.getProofJob(operationId)?.status;
      for (let i = 0; status === 'active' && i < 100_000; i++) status = store.stepProofJob(operationId, 100).status;
      const receipt = await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });
      assert.equal(receipt.finalSeq, 3);
      // Restoration (an owner-run trigger) wrote the flag deadline the domain implies.
      const flag = await pool.query('SELECT seq FROM flag_deadlines WHERE game_id = $1', [gameId]);
      assert.deepEqual(flag.rows, [{ seq: 3 }]);
      // Deferred validation (owner-run) still refuses an obligation without its Started event.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO game_adjudications (game_id, operation_id, base_revision, started_seq, started_type, started_version,
             started_payload, prepared, accepted_at, rules_version, original_clock, thinking_elapsed_at_a, execution_state)
           VALUES ($1, $2, 3, 4, 'AdjudicationStarted', 1, '{}'::jsonb, '{}'::jsonb, 1300, 'standard@1.0.0', '{}'::jsonb, 0, 'proving')`,
          [gameId, uuid()],
        );
        await assert.rejects(client.query('COMMIT'), hasCode('PMD03'));
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });
});

test('the prepared owner holds only what the routines use', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    await withRole(pool, 'NOLOGIN', async (owner) => {
      await prepareAdjudicationGuard(pool, { functionOwner: owner });
      const client = await pool.connect();
      try {
        const refused = async (sql: string) => {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE ${owner}`);
          try {
            await assert.rejects(client.query(sql), hasCode('42501'), sql);
          } finally {
            await client.query('ROLLBACK');
          }
        };
        await refused('DROP TABLE game_events');
        await refused('ALTER TABLE game_adjudications DISABLE TRIGGER ALL');
        await refused('ALTER TABLE game_events DISABLE TRIGGER game_events_adjudication_guard');
        await refused('TRUNCATE game_adjudications');
        await refused('DELETE FROM game_adjudications');
        await refused(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES (gen_random_uuid(), 0, 'GameCreated', 1, '{}')`);
        await refused('SELECT 1 FROM users');
        await refused('SELECT 1 FROM sessions');
        await refused('CREATE FUNCTION public.planted() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
        await refused(`INSERT INTO game_adjudications (game_id, operation_id) VALUES (gen_random_uuid(), gen_random_uuid())`);
      } finally {
        client.release();
      }
    });
  });
});

test('unsafe owners are refused and leave the routines untouched', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const before = await routineOwners(pool);
    const refuses = async (attributes: string, extra?: (name: string) => Promise<void>) =>
      withRole(pool, attributes, async (name) => {
        if (extra) await extra(name);
        await assert.rejects(prepareAdjudicationGuard(pool, { functionOwner: name }), PersistenceError);
        assert.deepEqual(await routineOwners(pool), before);
      });
    await refuses('LOGIN');
    await refuses('NOLOGIN SUPERUSER');
    await refuses('NOLOGIN CREATEROLE');
    await refuses('NOLOGIN BYPASSRLS');
    await refuses('NOLOGIN', async (name) => { await pool.query(`GRANT CREATE ON SCHEMA public TO ${name}`); });
    await refuses('NOLOGIN', async (name) => {
      await pool.query(`CREATE TABLE public.owned_${name} (x int); ALTER TABLE public.owned_${name} OWNER TO ${name}`);
    });
    const member = `adj_member_${randomBytes(4).toString('hex')}`;
    await pool.query(`CREATE ROLE ${member} LOGIN`);
    try {
      await refuses('NOLOGIN', async (name) => { await pool.query(`GRANT ${name} TO ${member}`); });
    } finally {
      await pool.query(`DROP ROLE ${member}`);
    }
    await assert.rejects(prepareAdjudicationGuard(pool, { functionOwner: 'missing_role_xyz' }), PersistenceError);
    await assert.rejects(prepareAdjudicationGuard(pool, { functionOwner: 'Bad-Name;' }), PersistenceError);
    assert.deepEqual(await routineOwners(pool), before);
  });
});
