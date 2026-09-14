import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runBackupRestoreDrill,
  CRITICAL_APPLICATION_TABLES,
  generateIsolatedDbName,
  validateTargetIsolation,
  collectSourceBaseline,
  sanitizeDatabaseUrl,
} from '../db-backup-restore-drill.mjs';

/**
 * Build a disposable drill harness that replaces only database and subprocess
 * boundaries while exercising the real validation, orchestration, and cleanup.
 */
function drillFixture(t, behavior = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'backup-drill-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backupFile = join(directory, 'backup.dump');
  const events = [];
  /** Return complete catalog/data responses and record every SQL side effect. */
  const databaseQuery = async (sql) => {
    events.push(sql);
    if (sql === 'ROLLBACK' && behavior.rollbackError) throw behavior.rollbackError;
    if (sql.includes('pg_export_snapshot')) return { rows: behavior.missingSnapshot ? [] : [{ snap: '00000001-00000001-1' }] };
    if (sql.includes('pg_extension')) return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
    if (sql.includes('pg_tables')) return { rows: CRITICAL_APPLICATION_TABLES.map(tablename => ({ tablename })) };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
    if (sql.includes('UPDATE game_events') && behavior.unrelatedTriggerError) throw Object.assign(new Error('unrelated trigger failure'), { code: 'P0001' });
    if (sql.includes('pg_trigger')) return { rows: behavior.otherTriggerRelation && sql.includes("tgrelid = 'public.game_events'::regclass") ? [] : [{ tgname: 'game_events_block_mutate' }] };
    if (sql.includes('pg_index')) return { rows: behavior.otherIndexRelation && sql.includes("t.oid = 'public.search_embeddings'::regclass") ? [] : [{ index_name: 'search_embeddings_hnsw_idx', access_method: 'hnsw', indisvalid: !behavior.invalidIndex, indisready: true }] };
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    if (behavior.connectError) throw behavior.connectError;
    return {
      query: databaseQuery,
      release() {
        events.push('release');
        if (behavior.releaseError) throw behavior.releaseError;
      },
    };
  });
  t.mock.method(pg.Pool.prototype, 'query', databaseQuery);
  t.mock.method(pg.Pool.prototype, 'end', async () => { events.push('pool.end'); });
  t.mock.method(pg.Client.prototype, 'connect', async () => { events.push('admin.connect'); });
  t.mock.method(pg.Client.prototype, 'end', async () => { events.push('admin.end'); });
  t.mock.method(pg.Client.prototype, 'query', async (sql) => {
    events.push(sql);
    if (sql.startsWith('CREATE DATABASE') && behavior.createError) throw behavior.createError;
    if (sql.startsWith('DROP DATABASE') && behavior.dropError) throw behavior.dropError;
    return { rows: [] };
  });
  /** Simulate PostgreSQL tooling while materializing a real disposable dump file. */
  const execSyncFn = (command, args) => {
    if (args.includes('--version')) return Buffer.from('test tooling');
    const executable = command === 'docker' ? args.find(arg => ['pg_dump', 'pg_restore', 'psql'].includes(arg)) : command;
    events.push({ executable, args });
    if (executable === 'pg_dump') {
      const dumpPath = args[args.indexOf('-f') + 1];
      writeFileSync(command === 'docker' ? join(directory, basename(dumpPath)) : dumpPath, 'PGDMP test archive');
    } else if (behavior.restoreError) {
      throw behavior.restoreError;
    } else if (behavior.backupCleanupError) {
      rmSync(backupFile);
      mkdirSync(backupFile);
    }
    return Buffer.alloc(0);
  };
  return {
    events, backupFile,
    options: {
      sourceUrl: 'postgres://u:test-password@127.0.0.1/source_test',
      targetUrl: 'postgres://u:test-password@127.0.0.1/isolated_restore_test',
      backupFile, json: true, execSyncFn,
    },
  };
}

for (const stderr of ['', 'pg_restore: warning: errors ignored on restore: 1', 'pg_restore: erreur: restauration incomplète']) {
  test(`restore errors: nonzero exit fails closed with diagnostics ${JSON.stringify(stderr)}`, async t => {
    const restoreError = Object.assign(new Error('restore command failed'), { status: 1, stderr: Buffer.from(stderr) });
    const fixture = drillFixture(t, { restoreError });
    await assert.rejects(runBackupRestoreDrill(fixture.options), error => error === restoreError);
    assert.equal(existsSync(fixture.backupFile), false);
    assert.ok(fixture.events.some(event => typeof event === 'string' && event.startsWith('DROP DATABASE')));
  });
}

test('identifiers: generated names retain isolation and uniqueness suffix within 63 bytes', () => {
  for (const base of ['x'.repeat(63), '測試'.repeat(32), 'strange " source']) {
    const name = generateIsolatedDbName(base);
    assert.ok(Buffer.byteLength(name) <= 63, `generated identifier has ${Buffer.byteLength(name)} bytes`);
    assert.match(name, /^[a-zA-Z0-9_-]+_backup_drill_restore_\d+_[a-f0-9]{8}$/);
  }
});

test('ownership: an existing backup file survives an early failed drill', async t => {
  const fixture = drillFixture(t, { connectError: new Error('source unavailable') });
  writeFileSync(fixture.backupFile, 'operator-owned backup');
  await assert.rejects(runBackupRestoreDrill(fixture.options));
  assert.equal(existsSync(fixture.backupFile), true);
  assert.equal(readFileSync(fixture.backupFile, 'utf8'), 'operator-owned backup');
});

test('ownership: an existing backup file is refused before it can be overwritten', async t => {
  const fixture = drillFixture(t);
  writeFileSync(fixture.backupFile, 'operator-owned backup');
  await assert.rejects(runBackupRestoreDrill(fixture.options), /exist/i);
  assert.equal(readFileSync(fixture.backupFile, 'utf8'), 'operator-owned backup');
  assert.equal(fixture.events.some(event => event.executable === 'pg_dump'), false);
});

test('ownership: CREATE failure never drops a target this drill does not own', async t => {
  const createError = new Error('database already exists');
  const fixture = drillFixture(t, { createError });
  await assert.rejects(runBackupRestoreDrill(fixture.options), error => error === createError);
  assert.equal(fixture.events.some(event => typeof event === 'string' && event.startsWith('DROP DATABASE')), false);
  assert.equal(existsSync(fixture.backupFile), false);
});

test('cleanup: drop failure preserves the restore failure and still closes admin and removes backup', async t => {
  const restoreError = new Error('restore failed');
  const dropError = new Error('drop failed');
  const fixture = drillFixture(t, { restoreError, dropError });
  await assert.rejects(runBackupRestoreDrill(fixture.options), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [restoreError, dropError]);
    return true;
  });
  assert.ok(fixture.events.includes('admin.end'));
  assert.equal(existsSync(fixture.backupFile), false);
});

test('cleanup: baseline rollback and release failures do not mask the dump failure or skip outer cleanup', async t => {
  const dumpError = new Error('dump failed');
  const rollbackError = new Error('rollback failed');
  const releaseError = new Error('release failed');
  const fixture = drillFixture(t, { restoreError: dumpError, rollbackError, releaseError });
  const options = {
    ...fixture.options,
    execSyncFn(command, args) {
      if (args.includes('--version')) return Buffer.from('test tooling');
      if (command === 'pg_dump') throw dumpError;
      return Buffer.alloc(0);
    },
  };

  await assert.rejects(runBackupRestoreDrill(options), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [dumpError, rollbackError, releaseError]);
    return true;
  });
  assert.ok(fixture.events.includes('pool.end'));
  assert.equal(existsSync(fixture.backupFile), false);
});

test('cleanup: backup removal failure prevents a success report', async t => {
  const fixture = drillFixture(t, { backupCleanupError: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /directory|EPERM|EISDIR/i);
  assert.ok(fixture.events.includes('admin.end'));
});

test('snapshot: plain dumps use the same exported snapshot as the baseline', async t => {
  const fixture = drillFixture(t);
  await runBackupRestoreDrill({ ...fixture.options, format: 'plain' });
  const dump = fixture.events.find(event => event.executable === 'pg_dump');
  assert.ok(dump.args.includes('--snapshot=00000001-00000001-1'));
});

test('snapshot: no exported snapshot aborts before creating a dump or target', async t => {
  const fixture = drillFixture(t, { missingSnapshot: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /snapshot/i);
  assert.equal(fixture.events.some(event => event.executable === 'pg_dump'), false);
  assert.ok(fixture.events.includes('release'));
});

test('connection: query overrides cannot send pg clients and tools to different servers', async () => {
  const source = 'postgres://u:p@127.0.0.1/source_test';
  for (const query of ['host=elsewhere', 'port=5433', 'user=other', 'password=query-secret', 'options=-csearch_path=other']) {
    await assert.rejects(validateTargetIsolation(source, `postgres://u:p@127.0.0.1/restore_test?${query}`), /parameter/i);
  }
});

test('security: URL diagnostics redact query passwords and fragments', () => {
  const result = sanitizeDatabaseUrl('postgres://u:authority-secret@127.0.0.1/source_test?password=query-secret#fragment-secret');
  assert.doesNotMatch(result, /authority-secret|query-secret|fragment-secret/);
});

test('security: CLI never echoes credentials from malformed arguments', () => {
  const script = fileURLToPath(new URL('../db-backup-restore-drill.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--format', 'postgres://u:cli-regression-secret@invalid/db'], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', BACKUP_DRILL_SOURCE_URL: '', BACKUP_DRILL_TARGET_URL: '' },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /cli-regression-secret/);
});

test('security: CLI failure diagnostics redact known connection passwords outside URLs', () => {
  const script = fileURLToPath(new URL('../db-backup-restore-drill.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script,
    '--source-url', 'postgres://u:production@127.0.0.1/source_test',
    '--target-url', 'postgres://u:production@127.0.0.1/production',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /production/);
});

test('baseline: unreadable table fails instead of silently omitting its row count', async () => {
  const failure = new Error('permission denied for table');
  const client = {
    async query(sql) {
      if (sql.includes('pg_extension')) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
      if (sql.includes('pg_tables')) return { rows: [{ tablename: 'durable_data' }] };
      if (sql.includes('COUNT(*)')) throw failure;
      throw new Error(`unexpected query ${sql}`);
    },
  };
  await assert.rejects(collectSourceBaseline(null, client), error => error === failure);
});

for (const table of ['with"quote', '__proto__']) test(`baseline: ${table} preserves its exact row count`, async () => {
  const client = {
    async query(sql) {
      if (sql.includes('pg_extension')) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
      if (sql.includes('pg_tables')) return { rows: [{ tablename: table }] };
      if (sql === 'SELECT COUNT(*) AS count FROM "with""quote"') return { rows: [{ count: '3' }] };
      if (sql === 'SELECT COUNT(*) AS count FROM "__proto__"') return { rows: [{ count: '7' }] };
      throw new Error('invalid quoted identifier');
    },
  };
  const baseline = await collectSourceBaseline(null, client);
  assert.equal(Object.hasOwn(baseline.rowCounts, table), true);
  assert.equal(baseline.rowCounts[table], table === '__proto__' ? 7 : 3);
});

test('verification: an unrelated P0001 error does not prove append-only protection', async t => {
  const fixture = drillFixture(t, { unrelatedTriggerError: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /unrelated trigger failure/);
});

test('verification: an invalid HNSW index cannot pass verification', async t => {
  const fixture = drillFixture(t, { invalidIndex: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /HNSW.*index/i);
});

test('verification: a trigger on another relation cannot protect empty public.game_events', async t => {
  const fixture = drillFixture(t, { otherTriggerRelation: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /Append-only trigger/);
});

test('verification: an index on another schema cannot verify public.search_embeddings', async t => {
  const fixture = drillFixture(t, { otherIndexRelation: true });
  await assert.rejects(runBackupRestoreDrill(fixture.options), /HNSW.*index/i);
});

test('identifiers: explicit target cannot rely on PostgreSQL identifier truncation', async () => {
  const source = 'postgres://u:p@127.0.0.1/source_test';
  await assert.rejects(validateTargetIsolation(source, `postgres://u:p@127.0.0.1/${'x'.repeat(63)}_restore`, { allowCustomTargetName: true }), /63/);
  const boundary = 'restore_' + 'x'.repeat(55);
  assert.equal((await validateTargetIsolation(source, `postgres://u:p@127.0.0.1/${boundary}`)).targetDbName, boundary);
});

for (const format of ['custom', 'plain']) {
  for (const useDocker of [false, true]) {
    test(`orchestration: ${format} restore completes with ${useDocker ? 'docker' : 'native'} tooling`, async t => {
      const fixture = drillFixture(t);
      const report = await runBackupRestoreDrill({ ...fixture.options, format, useDocker });
      assert.equal(report.success, true);
      const restore = fixture.events.find(event => event.executable === (format === 'custom' ? 'pg_restore' : 'psql'));
      assert.ok(restore);
      if (format === 'custom') assert.ok(restore.args.includes('--exit-on-error'));
      assert.ok(fixture.events.some(event => typeof event === 'string' && event.startsWith('DROP DATABASE')));
      assert.equal(existsSync(fixture.backupFile), false);
    });
  }
}
