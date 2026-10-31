/**
 * Atomic application of the fencing foundation (0050) and its helper hardening
 * (0051) by the migration runner.
 *
 * 0050 installs `game_fencing.insert_batch` as SECURITY DEFINER; 0051 re-declares
 * the four internal helpers SECURITY INVOKER. Applied as two commits — the old
 * per-migration behaviour — the committed-0050/pre-0051 state is visible to other
 * connections, during which a role holding EXECUTE on `insert_batch` plus schema
 * USAGE (but no `game_events` INSERT and no owner membership) can call the DEFINER
 * helper directly and persist events it cannot write (demonstrated against the
 * baseline runner in RZ-PR114-PG-ISOLATED-20261018-04 and reproduced as a genuine
 * failing-invariant RED against the HEAD runner in experiment07/harness). The
 * runner now coalesces the two into a single transaction when both are pending,
 * and fails closed on any other fencing shape. These tests pin: window closure
 * (with a real restricted connection probing DURING the pause), exact-checksum
 * ledger rows, all-or-nothing rollback across SQL and ledger-insert failures with
 * clean retry, the post-commit INVOKER denial with named/default-ACL and
 * no-USAGE/no-EXECUTE controls and distinct-principal identity assertions, the
 * assertion-failure cleanup contract, and the fail-closed negatives (0050 without
 * 0051, malformed/renamed pair, impossible history).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationsDir, migrationChecksum, readMigrationSql } from '../src/pg/migrate';
import { MigrationError } from '../src/errors';
import { withTestDatabase } from '../src/test-support/database';
import { Pool, type PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const connectionString = process.env['DATABASE_URL'];
const skip = connectionString ? false : 'DATABASE_URL not set';

const INSERT_BATCH_SIG = 'game_fencing.insert_batch(uuid,integer,jsonb,boolean)';
const FILE_0050 = '0050_inactive_game_fencing.sql';
const FILE_0051 = '0051_non_escalating_fencing_helpers.sql';
const CANON_0050 = 'f2f0e83d1074aa4021117191e93796b19b11f5b24ad0868c5a71e701e189ce3b';
const CANON_0051 = '1827a4ceb64ba8a10600693e2780eac132637608120b10cbde31c66148338b83';

const isFoundation = (sql: string): boolean => sql.includes('CREATE SCHEMA game_fencing');
const isHardening = (sql: string): boolean => sql.includes('ALTER FUNCTION') && sql.includes('SECURITY INVOKER');
const isLedgerInsert = (sql: string): boolean => sql.includes('INSERT INTO schema_migrations');
const createdBatch = (game: string): string =>
  JSON.stringify([{ type: 'GameCreated', version: 1, payload: { type: 'GameCreated', gameId: game } }]);
const hasCode = (code: string) => (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === code;

type QueryHook = (phase: 'before' | 'after', sql: string, values: unknown, client: InstrumentedClient) => Promise<void>;
interface InstrumentedClient extends PoolClient {
  _sawLedger51?: boolean;
}

/** Wrap a real pool so a hook can pause or throw around each query the runner issues. */
function instrument(real: Pool, hook: QueryHook): Pool {
  return {
    async connect(): Promise<PoolClient> {
      const c = (await real.connect()) as InstrumentedClient;
      const client: InstrumentedClient = {
        ...c,
        query: async (text: unknown, values?: unknown) => {
          const sql = typeof text === 'string' ? text : ((text as { text?: string })?.text ?? '');
          await hook('before', sql, values, client);
          const r = await (c.query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
          await hook('after', sql, values, client);
          return r;
        },
        release: (...a: unknown[]) => (c.release as (...x: unknown[]) => void)(...a),
      } as unknown as InstrumentedClient;
      return client;
    },
    query: (text: unknown, values?: unknown) =>
      (real.query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values),
    end: () => real.end(),
  } as unknown as Pool;
}

function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((res) => { open = res; });
  return { wait: () => p, open };
}

async function waitFor(predicate: () => boolean, what: string, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

async function dropRole(pool: Pool, role: string): Promise<void> {
  try { await pool.query(`DROP OWNED BY ${role}`); } catch { /* role may not exist */ }
  try { await pool.query(`DROP ROLE IF EXISTS ${role}`); } catch { /* ignore */ }
}

async function makeLogin(admin: Pool, dbUrl: string, role: string, password: string): Promise<Pool> {
  await dropRole(admin, role);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'
    NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const url = new URL(dbUrl);
  url.username = role;
  url.password = password;
  return new Pool({ connectionString: url.toString(), max: 1 });
}

/** session_user/current_user are the login, not superuser, no game_events INSERT, not a member of the helper owner. */
async function assertRestrictedPrincipal(probe: Pool, admin: Pool, role: string, helperVisible = true): Promise<void> {
  const who = (await probe.query<{ s: string; c: string; sup: boolean }>(
    "SELECT session_user AS s, current_user AS c, current_setting('is_superuser') = 'on' AS sup")).rows[0]!;
  assert.equal(who.s, role, 'session_user is the authenticated login');
  assert.equal(who.c, role, 'current_user is the authenticated login');
  assert.equal(who.sup, false, 'probe is not superuser');
  const rights = (await admin.query<{ ins: boolean; owner: boolean }>(
    `SELECT has_table_privilege($1,'public.game_events','INSERT') AS ins,
            pg_has_role($1, ${helperVisible ? '(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=$2::regprocedure)' : 'current_user'}, 'MEMBER') AS owner`,
    helperVisible ? [role, INSERT_BATCH_SIG] : [role])).rows[0]!;
  assert.equal(rights.ins, false, 'probe has no game_events INSERT');
  assert.equal(rights.owner, false, 'probe is not a member of the protected helper owner');
}

async function ledgerRows(pool: Pool): Promise<unknown[]> {
  return (await pool.query(
    `SELECT version, name, checksum, state FROM schema_migrations WHERE version IN (50,51) ORDER BY version`)).rows;
}
const EXPECTED_LEDGER = [
  { version: 50, name: FILE_0050, checksum: CANON_0050, state: 'applied' },
  { version: 51, name: FILE_0051, checksum: CANON_0051, state: 'applied' },
];
async function insertBatchIsInvoker(pool: Pool): Promise<boolean> {
  return !(await pool.query<{ d: boolean }>(
    `SELECT prosecdef AS d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='game_fencing' AND proname='insert_batch'`)).rows[0]!.d;
}

test('PG-F1 runner groups 0050+0051 atomically; a restricted connection cannot see or escalate during the pause, and is denied after commit', { skip }, async (t) => {
  await withTestDatabase(async ({ pool, connectionString: dbUrl }) => {
    const suffix = randomBytes(6).toString('hex');
    const duringRole = `rz_a07_during_${suffix}`, namedRole = `rz_a07_named_${suffix}`;
    const password = randomBytes(18).toString('hex');
    const g = gate();
    let paused = false;
    const hook: QueryHook = async (phase, sql) => { if (phase === 'before' && isHardening(sql)) { paused = true; await g.wait(); } };
    const run = migrate(instrument(pool, hook), migrationsDir());

    const observer = new Pool({ connectionString: dbUrl, max: 1 });
    // Distinct restricted login that attempts helper access DURING the pause.
    let during: Pool | undefined;
    let named: Pool | undefined;
    void run.catch(() => undefined);
    try {
      during = await makeLogin(pool, dbUrl, duringRole, password);
      await during.query("SET statement_timeout = '5s'");
      await waitFor(() => paused, 'the runner to reach 0051 inside the atomic group');

      // Mid-group: the whole fencing schema and both ledger rows are uncommitted.
      assert.deepEqual((await observer.query<{ version: number }>(
        'SELECT version FROM schema_migrations WHERE version IN (50,51) ORDER BY version')).rows.map((r) => r.version),
        [], 'a separate connection sees neither 0050 nor 0051 before commit');
      assert.equal((await observer.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v,
        false, 'game_fencing is invisible to other connections mid-group');

      // A real restricted connection attempts the helper during the window.
      await assertRestrictedPrincipal(during, pool, duringRole, false);
      const windowGame = randomUUID();
      let duringCode = 'NONE';
      try {
        await during.query('SELECT game_fencing.insert_batch($1::uuid,$2::int,$3::jsonb,$4::boolean)', [windowGame, -1, createdBatch(windowGame), true]);
        assert.fail('insert_batch must not be callable during the atomic group');
      } catch (err) {
        duringCode = (err as { code?: string }).code ?? 'NONE';
      }
      t.diagnostic(`during-pause authenticated helper call SQLSTATE=${duringCode}; no rows persisted`);
      assert.equal(duringCode, '3F000', `during-pause call is rejected because game_fencing is invisible (got ${duringCode})`);
      assert.equal((await observer.query('SELECT 1 FROM public.game_events WHERE game_id=$1', [windowGame])).rowCount, 0,
        'no event was persisted during the window');

      g.open();
      assert.equal(await run, 51, 'the full migration completes');

      // Exact ledger rows, canonical checksums.
      assert.deepEqual(await ledgerRows(pool), EXPECTED_LEDGER, 'both ledger rows have exact version/name/state/canonical checksum');
      assert.equal(await insertBatchIsInvoker(pool), true, 'insert_batch is SECURITY INVOKER after the grouped upgrade');

      // Post-commit: a distinct role with an EXPLICIT named EXECUTE + EXPLICIT schema USAGE is denied.
      named = await makeLogin(pool, dbUrl, namedRole, password);
      await pool.query(`GRANT USAGE ON SCHEMA game_fencing TO ${namedRole}`); // explicit, not a default
      await pool.query(`GRANT EXECUTE ON FUNCTION ${INSERT_BATCH_SIG} TO ${namedRole}`);
      await assertRestrictedPrincipal(named, pool, namedRole);
      const game = randomUUID();
      await assert.rejects(
        named.query('SELECT game_fencing.insert_batch($1::uuid,$2::int,$3::jsonb,$4::boolean)', [game, -1, createdBatch(game), true]),
        hasCode('42501'), 'named EXECUTE + explicit USAGE still cannot persist through the INVOKER helper');
      assert.equal((await pool.query('SELECT 1 FROM public.game_events WHERE game_id=$1', [game])).rowCount, 0, 'nothing persisted');
    } finally {
      // Correction contract: release the gate and settle the migration even if an
      // assertion above threw, so no transaction/advisory-lock client stays checked
      // out and teardown cannot hang.
      g.open();
      await run.catch(() => undefined);
      if (named) await named.end();
      if (during) await during.end();
      await observer.end();
      await dropRole(pool, duringRole);
      await dropRole(pool, namedRole);
    }
  }, { connectionString, max: 4 });
});

test('PG-F1 atomic group: an assertion escaping the paused body still releases and settles before pool teardown', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const g = gate();
    let paused = false, settledInFinally = false;
    const run = migrate(instrument(pool, async (phase, sql) => {
      if (phase === 'before' && isHardening(sql)) { paused = true; await g.wait(); }
    }), migrationsDir());
    void run.catch(() => undefined);
    await assert.rejects(async () => {
      try {
        await waitFor(() => paused, 'runner paused before cleanup assertion');
        assert.fail('intentional observer assertion failure');
      } finally {
        g.open();
        assert.equal(await run, 51);
        settledInFinally = true;
      }
    }, { message: 'intentional observer assertion failure' });
    assert.equal(settledInFinally, true, 'the promise settles in finally before callback exits/pool.end');
    assert.deepEqual(await ledgerRows(pool), EXPECTED_LEDGER);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid=ANY(SELECT pid FROM pg_stat_activity WHERE datname=current_database())")).rows[0]?.n, 0);
  }, { connectionString, max: 4 });
});

for (const injectAt of ['before-0051-sql', 'after-ledger50', 'before-ledger51', 'ledger51-server-error', 'after-ledger51-before-commit'] as const) {
  test(`PG-F1 atomic group rolls back ALL SQL and ledger rows on failure (${injectAt}), then a clean retry applies them with exact checksums`, { skip }, async () => {
    await withTestDatabase(async ({ pool }) => {
      let thrown = false;
      const hook: QueryHook = async (phase, sql, values, client) => {
        const version = Array.isArray(values) ? (values as unknown[])[0] : undefined;
        if (phase === 'after' && isLedgerInsert(sql) && version === 51) client._sawLedger51 = true;
        if (injectAt === 'after-ledger50' && phase === 'after' && isLedgerInsert(sql) && version === 50) { thrown = true; throw new Error('injected after 0050 ledger insert'); }
        if (injectAt === 'ledger51-server-error' && phase === 'before' && isFoundation(sql)) {
          await pool.query(`CREATE FUNCTION public.reject_ledger51() RETURNS trigger LANGUAGE plpgsql AS $ledger$ BEGIN IF NEW.version=51 THEN RAISE EXCEPTION 'injected ledger51 server failure'; END IF; RETURN NEW; END $ledger$;
            CREATE TRIGGER reject_ledger51 BEFORE INSERT ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.reject_ledger51()`);
          thrown = true;
        }
        if (injectAt === 'before-0051-sql' && phase === 'before' && isHardening(sql)) { thrown = true; throw new Error('injected before 0051 SQL'); }
        if (injectAt === 'before-ledger51' && phase === 'before' && isLedgerInsert(sql) && version === 51) { thrown = true; throw new Error('injected before the 0051 ledger insert'); }
        if (injectAt === 'after-ledger51-before-commit' && phase === 'before' && sql.trim() === 'COMMIT' && client._sawLedger51) { thrown = true; throw new Error('injected after the 0051 ledger insert, before COMMIT'); }
      };
      await assert.rejects(migrate(instrument(pool, hook), migrationsDir()), (err: unknown) => {
        assert.ok(err instanceof MigrationError);
        assert.match((err as Error).message, /atomic migration group .*failed/);
        if (injectAt === 'ledger51-server-error') assert.match((err as Error).message, /injected ledger51 server failure/);
        return true;
      });
      assert.equal(thrown, true, 'the failure was injected inside the group');
      assert.equal((await pool.query('SELECT version FROM schema_migrations WHERE version IN (50,51)')).rowCount, 0,
        'neither 0050 nor 0051 is recorded after rollback');
      assert.equal((await pool.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v,
        false, 'the whole fencing schema rolled back');

      if (injectAt === 'ledger51-server-error') await pool.query('DROP TRIGGER reject_ledger51 ON public.schema_migrations; DROP FUNCTION public.reject_ledger51()');
      // Clean retry: 0001..0049 already committed, only the rolled-back pair remains.
      assert.equal(await migrate(pool, migrationsDir()), 2, 'the retry applies exactly the rolled-back fencing pair');
      assert.deepEqual(await ledgerRows(pool), EXPECTED_LEDGER, 'retry records both rows with exact canonical checksums');
      assert.equal(await insertBatchIsInvoker(pool), true, 'insert_batch is INVOKER after the retry');
    }, { connectionString, max: 4 });
  });
}

test('PG-F1 runner denies a role with migration-DEFAULT EXECUTE after the atomic upgrade, with no-USAGE and no-EXECUTE controls', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString: dbUrl }) => {
    const suffix = randomBytes(6).toString('hex');
    const dflt = `rz_a07_dflt_${suffix}`, noUsage = `rz_a07_nousage_${suffix}`, noExec = `rz_a07_noexec_${suffix}`;
    const password = randomBytes(18).toString('hex');
    await pool.query(`DROP ROLE IF EXISTS ${dflt}`);
    await pool.query(`CREATE ROLE ${dflt} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await pool.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${dflt}`);

    assert.equal(await migrate(pool, migrationsDir()), 51, 'full migrate applies the atomic pair among the rest');
    assert.deepEqual(await ledgerRows(pool), EXPECTED_LEDGER, 'exact canonical ledger rows');

    await pool.query(`GRANT USAGE ON SCHEMA game_fencing TO ${dflt}`); // explicit schema USAGE (not implied by the default function ACL)
    assert.equal((await pool.query<{ p: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') AS p", [dflt, INSERT_BATCH_SIG])).rows[0]!.p,
      true, 'the pre-existing default ACL granted EXECUTE with no explicit per-function grant');
    const dfltUrl = new URL(dbUrl); dfltUrl.username = dflt; dfltUrl.password = password;
    const dfltConn = new Pool({ connectionString: dfltUrl.toString(), max: 1 });
    const noUsageConn = await makeLogin(pool, dbUrl, noUsage, password);
    const noExecConn = await makeLogin(pool, dbUrl, noExec, password);
    try {
      await assertRestrictedPrincipal(dfltConn, pool, dflt);
      const g1 = randomUUID();
      await assert.rejects(dfltConn.query('SELECT game_fencing.insert_batch($1::uuid,$2::int,$3::jsonb,$4::boolean)', [g1, -1, createdBatch(g1), true]),
        hasCode('42501'), 'default-ACL EXECUTE + explicit USAGE is denied by the INVOKER helper');

      await assertRestrictedPrincipal(noUsageConn, pool, noUsage);
      await assertRestrictedPrincipal(noExecConn, pool, noExec);
      await pool.query(`GRANT EXECUTE ON FUNCTION ${INSERT_BATCH_SIG} TO ${noUsage}`); // EXECUTE but NO schema USAGE
      const g2 = randomUUID();
      await assert.rejects(noUsageConn.query('SELECT game_fencing.insert_batch($1::uuid,$2::int,$3::jsonb,$4::boolean)', [g2, -1, createdBatch(g2), true]),
        hasCode('42501'), 'no schema USAGE is denied');

      await pool.query(`GRANT USAGE ON SCHEMA game_fencing TO ${noExec}`); // schema USAGE but NO EXECUTE
      assert.equal((await pool.query<{ p: boolean }>("SELECT has_function_privilege('public',$1,'EXECUTE') AS p", [INSERT_BATCH_SIG])).rows[0]!.p,
        false, 'PUBLIC holds no EXECUTE by default');
      const g3 = randomUUID();
      await assert.rejects(noExecConn.query('SELECT game_fencing.insert_batch($1::uuid,$2::int,$3::jsonb,$4::boolean)', [g3, -1, createdBatch(g3), true]),
        hasCode('42501'), 'no EXECUTE is denied');

      for (const g of [g1, g2, g3]) assert.equal((await pool.query('SELECT 1 FROM public.game_events WHERE game_id=$1', [g])).rowCount, 0, 'nothing persisted by any probe');
    } finally {
      await dfltConn.end(); await noUsageConn.end(); await noExecConn.end();
      for (const r of [dflt, noUsage, noExec]) await dropRole(pool, r);
    }
  }, { connectionString, max: 4 });
});

test('PG-F1 runner FAILS CLOSED when 0050 is pending without 0051 (never installs the DEFINER helpers alone)', { skip }, async () => {
  const only0050 = await mkdtemp(join(tmpdir(), 'rz-a07-0050only-'));
  try {
    for (const name of await readdir(migrationsDir()))
      if (/^\d{4}_.*\.sql$/.test(name) && name < '0051') await copyFile(join(migrationsDir(), name), join(only0050, name));
    await withTestDatabase(async ({ pool }) => {
      await assert.rejects(migrate(pool, only0050), (err: unknown) => {
        assert.ok(err instanceof MigrationError);
        assert.match((err as Error).message, /must be applied together with migration 51/);
        return true;
      });
      assert.equal((await pool.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v,
        false, '0050 was never installed');
      assert.equal((await pool.query('SELECT 1 FROM schema_migrations WHERE version=50')).rowCount, 0, 'no 0050 ledger row');
    }, { connectionString, max: 4 });
  } finally {
    await rm(only0050, { recursive: true, force: true });
  }
});

test('PG-F1 runner FAILS CLOSED on a malformed pair: a renamed 0050 or a non-transactional member', { skip }, async () => {
  const renamed = await mkdtemp(join(tmpdir(), 'rz-a07-renamed-'));
  const nontx = await mkdtemp(join(tmpdir(), 'rz-a07-nontx-'));
  try {
    for (const name of await readdir(migrationsDir())) {
      if (!/^\d{4}_.*\.sql$/.test(name)) continue;
      if (name < '0050') { await copyFile(join(migrationsDir(), name), join(renamed, name)); await copyFile(join(migrationsDir(), name), join(nontx, name)); }
    }
    // renamed 0050 (same version 50, unexpected filename) + real 0051
    await copyFile(join(migrationsDir(), FILE_0050), join(renamed, '0050_renamed_foundation.sql'));
    await copyFile(join(migrationsDir(), FILE_0051), join(renamed, FILE_0051));
    // real 0050 + a 0051 rewritten as a (disallowed here) online-index directive
    await copyFile(join(migrationsDir(), FILE_0050), join(nontx, FILE_0050));
    await writeFile(join(nontx, FILE_0051), '-- migrate:online-index game_fencing_bogus_idx\nCREATE INDEX CONCURRENTLY game_fencing_bogus_idx ON public.game_events (game_id);\n');

    await withTestDatabase(async ({ pool }) => {
      await assert.rejects(migrate(pool, renamed), (err: unknown) => {
        assert.ok(err instanceof MigrationError);
        assert.match((err as Error).message, /must be named 0050_inactive_game_fencing\.sql/);
        return true;
      });
      assert.equal((await pool.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v, false, 'renamed pair installed nothing');
    }, { connectionString, max: 4 });

    await withTestDatabase(async ({ pool }) => {
      await assert.rejects(migrate(pool, nontx), (err: unknown) => {
        assert.ok(err instanceof MigrationError);
        assert.match((err as Error).message, /must be a plain transactional migration/);
        return true;
      });
      assert.equal((await pool.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v, false, 'non-transactional pair installed nothing');
    }, { connectionString, max: 4 });
  } finally {
    await rm(renamed, { recursive: true, force: true });
    await rm(nontx, { recursive: true, force: true });
  }
});

test('PG-F1 runner FAILS CLOSED on impossible history: 0051 recorded but 0050 missing', { skip }, async () => {
  const through0049 = await mkdtemp(join(tmpdir(), 'rz-a07-0049-'));
  try {
    for (const name of await readdir(migrationsDir()))
      if (/^\d{4}_.*\.sql$/.test(name) && name < '0050') await copyFile(join(migrationsDir(), name), join(through0049, name));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, through0049);
      // Corrupt the ledger: record 0051 without 0050 (a state the runner must reject).
      await pool.query(
        `INSERT INTO schema_migrations (version, name, checksum, state) VALUES (51, $1, $2, 'applied')`,
        [FILE_0051, CANON_0051],
      );
      await assert.rejects(migrate(pool, migrationsDir()), (err: unknown) => {
        assert.ok(err instanceof MigrationError);
        assert.match((err as Error).message, /inconsistent fencing history/);
        return true;
      });
      assert.equal((await pool.query<{ v: boolean }>("SELECT to_regnamespace('game_fencing') IS NOT NULL AS v")).rows[0]!.v, false, '0050 still not installed');
    }, { connectionString, max: 4 });
  } finally {
    await rm(through0049, { recursive: true, force: true });
  }
});

for (const shape of ['only-0051','renamed-0051','online-0050','pending-ledger50','pending-ledger51'] as const) {
  test(`PG-F1 planner rejects ${shape} before fencing SQL`, {skip}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rz-a07-invalid-'));
    try {
      for (const file of await readdir(migrationsDir())) {
        if (!/^\d{4}_.*\.sql$/.test(file)) continue;
        if (shape === 'only-0051' && file === FILE_0050) continue;
        if (shape === 'renamed-0051' && file === FILE_0051) await copyFile(join(migrationsDir(), file),join(dir,'0051_renamed_hardening.sql'));
        else await copyFile(join(migrationsDir(), file),join(dir,file));
      }
      if (shape === 'online-0050') await writeFile(join(dir,FILE_0050),'-- migrate:online-index bogus_idx\nCREATE INDEX CONCURRENTLY bogus_idx ON public.game_events (game_id);\n');
      await withTestDatabase(async ({pool}) => {
        if (shape.startsWith('pending-ledger')) {
          await pool.query(`CREATE TABLE schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,state text NOT NULL)`);
          await pool.query(`INSERT INTO schema_migrations VALUES (50,$1,$2,$3)`,[FILE_0050,CANON_0050,shape==='pending-ledger50'?'pending':'applied']);
          if(shape==='pending-ledger51')await pool.query(`INSERT INTO schema_migrations VALUES (51,$1,$2,'pending')`,[FILE_0051,CANON_0051]);
        }
        let fencingSQL = false;
        await assert.rejects(migrate(instrument(pool,async(phase,sql)=>{if(phase==='before'&&(isFoundation(sql)||isHardening(sql)))fencingSQL=true;}),dir),MigrationError);
        assert.equal(fencingSQL,false,'invalid pair refused before SQL');
        assert.equal((await pool.query("SELECT to_regnamespace('game_fencing') IS NOT NULL AS present")).rows[0]?.present,false);
      },{connectionString,max:4});
    }finally{await rm(dir,{recursive:true,force:true});}
  });
}

for (const incomplete of ['through0050', 'through0049'] as const) {
  test(`PG-F1 already-0050 database refuses missing hardening in ${incomplete} tree`, {skip}, async (t) => {
    const before50 = await mkdtemp(join(tmpdir(), 'rz-a08-prior-'));
    const missing51 = await mkdtemp(join(tmpdir(), 'rz-a08-missing-'));
    try {
      for (const file of await readdir(migrationsDir())) {
        if (!/^\d{4}_.*\.sql$/.test(file)) continue;
        if (file < '0050') await copyFile(join(migrationsDir(), file), join(before50, file));
        if (file < (incomplete === 'through0050' ? '0051' : '0050'))
          await copyFile(join(migrationsDir(), file), join(missing51, file));
      }
      await withTestDatabase(async ({pool}) => {
        assert.equal(await migrate(pool,before50),49);
        const seed = await pool.connect();
        try {
          await seed.query('BEGIN');
          await seed.query(readMigrationSql(migrationsDir(),FILE_0050));
          await seed.query(`INSERT INTO schema_migrations(version,name,checksum,state) VALUES (50,$1,$2,'applied')`,[FILE_0050,CANON_0050]);
          await seed.query('COMMIT');
        } catch(error) { await seed.query('ROLLBACK'); throw error; } finally { seed.release(); }
        const before=await ledgerRows(pool);
        assert.deepEqual(before,[EXPECTED_LEDGER[0]]);
        await assert.rejects(async()=>{
          const returned=await migrate(pool,missing51);
          t.diagnostic(`unexpected incomplete-tree migrate result: ${returned}`);
        }, /already applied.*50.*missing.*51/);
        assert.deepEqual(await ledgerRows(pool),before,'rejection does not fabricate a hardening row');
        assert.equal(await insertBatchIsInvoker(pool),false,'rejection did not pretend to harden the historical helper');
        assert.equal(await migrate(pool,migrationsDir()),1,'trusted installer with complete tree applies real hardening');
        assert.deepEqual(await ledgerRows(pool),EXPECTED_LEDGER);
        assert.equal(await insertBatchIsInvoker(pool),true);
        assert.equal(await migrate(pool,migrationsDir()),0,'complete hardened tree is idempotent');
      },{connectionString,max:4});
    } finally { await rm(before50,{recursive:true,force:true});await rm(missing51,{recursive:true,force:true}); }
  });
}
