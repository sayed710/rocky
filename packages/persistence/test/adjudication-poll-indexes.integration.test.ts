/**
 * Integration tests for Migration 0055: Ordered poll indexes for adjudication worker.
 *
 * Qodo finding 43f5378b-fe11-4b5e-b4a9-869f5d81f5f5:
 *   listClaimableAdjudications orders eligible proving operations by (created_at, game_id)
 *   listReleasableStops orders current stops by (completed_at, game_id)
 *
 * Verifies on real PostgreSQL:
 * 1. Schema without 0055 (baseline through 0054) lacks the ordered poll indexes.
 * 2. Applying 0055 creates exact matching partial ordered indexes on public.game_adjudications.
 * 3. PostgreSQL catalog reflects exact column ordering and immutable partial predicates.
 * 4. Controlled EXPLAIN demonstrates that actual store queries can traverse ordered indexes
 *    without an explicit Sort node before LIMIT under an ordered index scan.
 * 5. Query execution through PgAdjudicationStore executes against the new schema without error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate, migrationFiles, migrationsDir } from '../src/pg/migrate';
import { PgAdjudicationStore } from '../src/pg/adjudication-store';
import { withTestDatabase } from '../src/test-support/database';

const MIGRATIONS_DIR = process.env['TEST_MIGRATIONS_DIR'] ?? migrationsDir();

const CLAIMABLE_POLL_INDEX = 'game_adjudications_claimable_poll_idx';
const RELEASABLE_POLL_INDEX = 'game_adjudications_releasable_poll_idx';

/**
 * Creates an isolated temporary directory containing migrations up to `maxVersion`.
 * Allows safe verification of the baseline 0054 schema before 0055 is applied.
 */
function migrationsThrough(maxVersion: number): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `adjudication-poll-indexes-${maxVersion}-`));
  const sourceDir = migrationsDir();
  for (const migration of migrationFiles(sourceDir)) {
    if (migration.version > maxVersion) continue;
    copyFileSync(join(sourceDir, migration.file), join(dir, migration.file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function getIndexNames(pool: Pool): Promise<string[]> {
  const rows = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'game_adjudications'
     ORDER BY indexname`,
  );
  return rows.rows.map((r) => r.indexname);
}

/**
 * Tolerates surrounding parenthesis wrappers that PostgreSQL's expression decompiler
 * may add around boolean expressions, without permitting extra boolean clauses.
 */
function normalizePredicate(predicate: string): string {
  let s = predicate.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function findPlanNodes(
  plan: Record<string, unknown> | undefined,
  predicate: (node: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) matches.push(node);
    const plans = node['Plans'] as Record<string, unknown>[] | undefined;
    if (Array.isArray(plans)) {
      for (const child of plans) walk(child);
    }
  };
  walk(plan);
  return matches;
}

test('baseline schema 0054 lacks ordered poll indexes and migration 0055 adds them', async () => {
  const baseline = migrationsThrough(54);
  try {
    await withTestDatabase(async ({ pool }) => {
      // 1. Migrate through version 54 (baseline)
      await migrate(pool, baseline.dir);

      const baselineIndexes = await getIndexNames(pool);
      assert.ok(
        !baselineIndexes.includes(CLAIMABLE_POLL_INDEX),
        `baseline 0054 schema must not have ${CLAIMABLE_POLL_INDEX}`,
      );
      assert.ok(
        !baselineIndexes.includes(RELEASABLE_POLL_INDEX),
        `baseline 0054 schema must not have ${RELEASABLE_POLL_INDEX}`,
      );

      // Verify that 0053 single-column unique indexes are present in baseline
      assert.ok(baselineIndexes.includes('game_adjudications_one_active_idx'));
      assert.ok(baselineIndexes.includes('game_adjudications_one_current_stop_idx'));

      // 2. Apply migration 0055 from the full migrations directory
      await migrate(pool, MIGRATIONS_DIR);

      const post55Indexes = await getIndexNames(pool);
      assert.ok(
        post55Indexes.includes(CLAIMABLE_POLL_INDEX),
        `post-0055 schema must have ${CLAIMABLE_POLL_INDEX}`,
      );
      assert.ok(
        post55Indexes.includes(RELEASABLE_POLL_INDEX),
        `post-0055 schema must have ${RELEASABLE_POLL_INDEX}`,
      );

      // Verify schema_migrations recorded version 55
      const latest = await pool.query<{ version: number; state: string }>(
        'SELECT version, state FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      assert.equal(latest.rows[0]?.version, 55);
      assert.equal(latest.rows[0]?.state, 'applied');
    });
  } finally {
    baseline.cleanup();
  }
});

test('exact catalog verification of 0055 index attributes, ordering, and predicates', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS_DIR);

    const catalogRows = await pool.query<{
      index_name: string;
      predicate: string;
      columns: string[];
    }>(
      `SELECT
         c.relname AS index_name,
         pg_get_expr(i.indpred, i.indrelid) AS predicate,
         ARRAY(
           SELECT a.attname::text
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           ORDER BY k.ord
         )::text[] AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'game_adjudications'
         AND c.relname IN ($1, $2)
       ORDER BY c.relname`,
      [CLAIMABLE_POLL_INDEX, RELEASABLE_POLL_INDEX],
    );

    assert.equal(catalogRows.rows.length, 2, 'expected exactly 2 poll index entries');

    const claimable = catalogRows.rows.find((r) => r.index_name === CLAIMABLE_POLL_INDEX);
    assert.ok(claimable, `catalog entry for ${CLAIMABLE_POLL_INDEX} must exist`);
    assert.deepEqual(claimable.columns, ['created_at', 'game_id']);
    assert.equal(
      normalizePredicate(claimable.predicate),
      "execution_state = 'proving'::text",
      'claimable poll index must match exact proving state predicate',
    );

    const releasable = catalogRows.rows.find((r) => r.index_name === RELEASABLE_POLL_INDEX);
    assert.ok(releasable, `catalog entry for ${RELEASABLE_POLL_INDEX} must exist`);
    assert.deepEqual(releasable.columns, ['completed_at', 'game_id']);
    assert.equal(
      normalizePredicate(releasable.predicate),
      'is_current_stop',
      'releasable poll index must match exact current stop predicate',
    );
  });
});

test('controlled EXPLAIN: actual store query text can use ordered indexes without Sort node', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS_DIR);

    // Query 1: listClaimableAdjudications exact parameterized text from PgAdjudicationStore
    const claimableQuery = `
      SELECT game_id, operation_id, generation::text AS generation FROM game_adjudications
      WHERE execution_state = 'proving' AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      ORDER BY created_at, game_id LIMIT $1
    `;

    // Query 2: listReleasableStops exact parameterized text from PgAdjudicationStore
    const releasableQuery = `
      SELECT a.game_id, a.operation_id FROM game_adjudications a
      WHERE a.is_current_stop
        AND a.game_id <> ALL($3::uuid[])
        AND a.completed_at <= clock_timestamp() - make_interval(secs => $2::double precision / 1000)
        AND NOT EXISTS (
          SELECT 1 FROM game_adjudications p WHERE p.game_id = a.game_id AND p.execution_state = 'proving')
      ORDER BY a.completed_at, a.game_id LIMIT $1
    `;

    const client = await pool.connect();
    try {
      // NOTE: Scope: controlled planner indexability proof on empty fixture to demonstrate that both
      // partial indexes (game_adjudications_claimable_poll_idx and game_adjudications_releasable_poll_idx)
      // directly supply the required ORDER BY without a Sort node under an ordered Index Scan.
      // Both SET LOCAL enable_seqscan = off and SET LOCAL enable_bitmapscan = off are applied strictly
      // locally within this test transaction to prevent the cost-based planner on a zero-row fixture from
      // preferring sequential or bitmap scans (which do not preserve B-tree tuple order). The production
      // cost-based planner remains completely free to select whichever access path it deems optimal for
      // real production data, and production latency is not measured or claimed here.
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');

      // EXPLAIN claimable query
      const claimablePlanRes = await client.query<{ 'QUERY PLAN': [ { Plan: Record<string, unknown> } ] }>(
        `EXPLAIN (FORMAT JSON) ${claimableQuery}`,
        [20],
      );
      const claimablePlan = claimablePlanRes.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
      assert.ok(claimablePlan, 'claimable query plan must be non-null');
      assert.match(
        JSON.stringify(claimablePlan),
        new RegExp(CLAIMABLE_POLL_INDEX),
        'claimable plan must reference claimable poll index',
      );
      const claimableSorts = findPlanNodes(claimablePlan, (n) => n['Node Type'] === 'Sort');
      assert.equal(
        claimableSorts.length,
        0,
        `claimable query plan unexpectedly required a Sort node under controlled ordered index scan:\n${JSON.stringify(claimablePlan, null, 2)}`,
      );

      // EXPLAIN releasable query
      const releasablePlanRes = await client.query<{ 'QUERY PLAN': [ { Plan: Record<string, unknown> } ] }>(
        `EXPLAIN (FORMAT JSON) ${releasableQuery}`,
        [20, 0, []],
      );
      const releasablePlan = releasablePlanRes.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
      assert.ok(releasablePlan, 'releasable query plan must be non-null');
      assert.match(
        JSON.stringify(releasablePlan),
        new RegExp(RELEASABLE_POLL_INDEX),
        'releasable plan must reference releasable poll index',
      );
      const releasableSorts = findPlanNodes(releasablePlan, (n) => n['Node Type'] === 'Sort');
      assert.equal(
        releasableSorts.length,
        0,
        `releasable query plan unexpectedly required a Sort node under controlled ordered index scan:\n${JSON.stringify(releasablePlan, null, 2)}`,
      );

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

test('query execution semantics: empty store poll calls return valid arrays without schema errors', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS_DIR);
    const store = new PgAdjudicationStore(pool);

    const claimable = await store.listClaimableAdjudications(20);
    assert.deepEqual(claimable, []);

    const releasable = await store.listReleasableStops(20, 0, []);
    assert.deepEqual(releasable, []);

    const filtered = await store.listReleasableStops(10, 5000, ['00000000-0000-0000-0000-000000000001']);
    assert.deepEqual(filtered, []);
  });
});
