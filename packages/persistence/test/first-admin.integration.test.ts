/** The operator-only first-admin bootstrap against PostgreSQL (ADR-0152). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { migrate } from '../src/pg/migrate';
import { bootstrapFirstAdmin } from '../src/pg/first-admin';
import { withTestDatabase } from '../src/test-support/database';
import { uuidv7 } from '../src/ids';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const migrations = join(process.cwd(), 'migrations');
const cli = join(process.cwd(), 'dist-test', 'src', 'pg', 'first-admin-cli.js');
const run = promisify(execFile);

async function human(pool: Pool, name: string): Promise<string> {
  const id = uuidv7();
  await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [id, `${name}_${id.slice(-12)}`]);
  await pool.query(`INSERT INTO roles (user_id, role) VALUES ($1, 'user')`, [id]);
  return id;
}

async function admins(pool: Pool): Promise<string[]> {
  return (await pool.query(`SELECT user_id FROM roles WHERE role = 'admin' ORDER BY user_id`)).rows.map((r) => r.user_id);
}

/** Run the real CLI; resolve to its exit code and output instead of throwing on a non-zero exit. */
async function bootstrapCli(connectionString: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env: { ...process.env, DATABASE_URL: connectionString } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('the CLI grants the first admin once, records who ran it, and then refuses every later attempt', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrations);
    const first = await human(pool, 'first');
    const second = await human(pool, 'second');

    const granted = await bootstrapCli(connectionString, first, 'ops.alice');
    assert.equal(granted.code, 0, granted.stderr);
    assert.deepEqual(JSON.parse(granted.stdout), { granted: true, userId: first });
    const password = decodeURIComponent(new URL(connectionString).password);
    assert.ok(password && !`${granted.stdout}${granted.stderr}`.includes(password), 'no database credential is printed');
    assert.deepEqual(await admins(pool), [first]);
    const audit = (await pool.query(`SELECT actor_id, target, meta FROM audit_log WHERE action = 'roles.bootstrap_first_admin'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, null, 'no HTTP actor is invented');
    assert.equal(audit[0].target, first);
    assert.equal(audit[0].meta.source, 'operator-cli');
    assert.equal(audit[0].meta.operator, 'ops.alice');
    assert.equal(typeof audit[0].meta.databaseUser, 'string');

    for (const target of [first, second]) {
      const again = await bootstrapCli(connectionString, target, 'ops.alice');
      assert.equal(again.code, 1);
      assert.match(again.stderr, /admin already exists/);
    }
    assert.deepEqual(await admins(pool), [first]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'roles.bootstrap_first_admin'`)).rows[0].n, 1);
  });
});

test('the CLI refuses unknown users, bot accounts and malformed arguments without writing', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrations);
    const person = await human(pool, 'person');
    // Migration 0021 seeds the engine bots; they must never become admins.
    const bot = '00000000-0000-7000-8000-000000000001';
    const cases: Array<[string[], RegExp]> = [
      [[uuidv7(), 'ops'], /no such user/],
      [[bot, 'ops'], /bot account/],
      [['not-a-uuid', 'ops'], /valid user UUID/],
      [[person, 'bad operator; drop'], /operator must be/],
      [[person], /operator must be/],
    ];
    for (const [args, message] of cases) {
      const refused = await bootstrapCli(connectionString, ...args);
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, message);
    }
    assert.deepEqual(await admins(pool), []);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'roles.bootstrap_first_admin'`)).rows[0].n, 0);
  });
});

test('two operators racing for different users create at most one first admin', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const a = await human(pool, 'a');
    const b = await human(pool, 'b');

    // Hold the table so both attempts are provably in flight before either can finish. Without the
    // bootstrap's own lock both would read "no admin" now and both insert once this commits.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE roles IN SHARE MODE');
      const racing = Promise.all([bootstrapFirstAdmin(pool, a, 'ops.a'), bootstrapFirstAdmin(pool, b, 'ops.b')]);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await pool.query(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'roles' AND NOT l.granted`,
        )).rows[0].n;
        if (waiting >= 2) break;
        assert.ok(Date.now() < deadline, 'both bootstraps should be waiting on the roles table');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query('COMMIT');
      const outcomes = await racing;
      assert.deepEqual(outcomes.map((o) => (o.kind === 'refused' ? o.reason : o.kind)).sort(), ['admin_exists', 'granted']);
    } finally {
      holder.release();
    }
    assert.equal((await admins(pool)).length, 1);
  });
});

test('a bootstrap that fails before commit leaves no role behind', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const person = await human(pool, 'person');
    await pool.query(`CREATE FUNCTION refuse_bootstrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`);
    await pool.query('CREATE TRIGGER refuse_bootstrap_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_bootstrap_audit()');
    await assert.rejects(bootstrapFirstAdmin(pool, person, 'ops'), /audit unavailable/);
    assert.deepEqual(await admins(pool), [], 'the role rolled back with its audit row');

    await pool.query('DROP TRIGGER refuse_bootstrap_audit ON audit_log');
    assert.equal((await bootstrapFirstAdmin(pool, person, 'ops')).kind, 'granted');
    assert.deepEqual(await admins(pool), [person]);
  });
});
