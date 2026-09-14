/**
 * Automated tests for the Postgres backup/restore drill and verification engine.
 *
 * Verifies:
 * 1. Security: credential masking in logs/diagnostics, no leaking passwords.
 * 2. Isolation: fails safe if target matches source or is not an isolated drill target.
 * 3. Backup validation: detects missing, empty, or corrupt backup files.
 * 4. Verification checks: detects missing extensions, missing migration ledgers,
 *    checksum drift, missing tables, row count discrepancies, and missing/inactive
 *    append-only triggers on game_events.
 * 5. CLI argument parsing: flags, defaults, and environment fallbacks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sanitizeDatabaseUrl,
  validateTargetIsolation,
  validateBackupFile,
  verifyRestoredDatabase,
  parseArgs,
  generateIsolatedDbName,
  runBackupRestoreDrill,
  resolvePgTooling,
  CRITICAL_APPLICATION_TABLES,
  REQUIRED_EXTENSIONS,
  parsePgRestoreError,
} from '../db-backup-restore-drill.mjs';

test('security: sanitizeDatabaseUrl masks plaintext passwords in postgres URLs', () => {
  const plainUrl = 'postgres://gambit:my_super_secret_pw@db.production.internal:5432/gambit';
  const sanitized = sanitizeDatabaseUrl(plainUrl);
  assert.equal(sanitized, 'postgres://gambit:***@db.production.internal:5432/gambit');
  assert.equal(sanitized.includes('my_super_secret_pw'), false);
});

test('security: sanitizeDatabaseUrl handles URLs with URL-encoded special characters', () => {
  const complexUrl = 'postgresql://admin%40corp:p%40ss%3Aword%21@127.0.0.1:5432/gambit_prod?sslmode=require';
  const sanitized = sanitizeDatabaseUrl(complexUrl);
  assert.equal(sanitized.includes('p%40ss%3Aword%21'), false);
  assert.equal(sanitized, 'postgresql://admin%40corp:***@127.0.0.1:5432/gambit_prod?sslmode=require');
});

test('security: sanitizeDatabaseUrl safely handles URLs without passwords', () => {
  const noPwUrl = 'postgres://gambit@localhost:5432/gambit_dev';
  assert.equal(sanitizeDatabaseUrl(noPwUrl), 'postgres://gambit@localhost:5432/gambit_dev');
});

test('security: sanitizeDatabaseUrl handles non-URL strings and errors safely', () => {
  assert.equal(sanitizeDatabaseUrl('not a url'), 'not a url');
  assert.equal(sanitizeDatabaseUrl(''), '');
});

test('isolation: validateTargetIsolation rejects when target URL matches source URL', async () => {
  const source = 'postgres://gambit:pass@localhost:5432/gambit';
  const target = 'postgres://gambit:pass@localhost:5432/gambit';

  await assert.rejects(
    async () => await validateTargetIsolation(source, target),
    /Target database URL must not be identical to source database URL/,
  );
});

test('isolation: validateTargetIsolation rejects when source and target have identical DB name on same host/port', async () => {
  const source = 'postgres://gambit:pass1@localhost:5432/gambit';
  const target = 'postgres://gambit_admin:pass2@localhost:5432/gambit';

  await assert.rejects(
    async () => await validateTargetIsolation(source, target),
    /Target database name "gambit" matches source database name on the same host/,
  );
});

test('isolation: validateTargetIsolation rejects dangerous production or system databases as target', async () => {
  const source = 'postgres://gambit:pass@localhost:5432/source_test';
  for (const dangerous of ['gambit', 'postgres', 'template1', 'template0', 'production']) {
    const target = `postgres://gambit:pass@localhost:5432/${dangerous}`;
    await assert.rejects(
    async () => await validateTargetIsolation(source, target),
      /Target database name .* is a protected or non-isolated database/,
    );
  }
});

test('isolation: validateTargetIsolation rejects target names without isolated naming markers unless explicitly allowed', async () => {
  const source = 'postgres://gambit:pass@localhost:5432/gambit';
  const target = 'postgres://gambit:pass@localhost:5432/arbitrary_name';

  await assert.rejects(
    async () => await validateTargetIsolation(source, target, { allowCustomTargetName: false }),
    /Target database name "arbitrary_name" does not contain an isolated drill marker/,
  );

  // When explicitly permitted via allowCustomTargetName flag
  const result = await validateTargetIsolation(source, target, { allowCustomTargetName: true });
  assert.equal(result.isolated, true);
  assert.equal(result.targetDbName, 'arbitrary_name');
});

test('isolation: validateTargetIsolation accepts valid isolated database names', async () => {
  const source = 'postgres://gambit:pass@localhost:5432/gambit';
  const validTargets = [
    'gambit_backup_drill_restore',
    'gambit_backup_drill_restore_1720000000_abcd',
    'test_db_restore',
    'gambit_disposable_drill',
    'gambit_isolated_restore',
  ];

  for (const name of validTargets) {
    const target = `postgres://gambit:pass@localhost:5432/${name}`;
    const validated = await validateTargetIsolation(source, target);
    assert.equal(validated.isolated, true);
    assert.equal(validated.targetDbName, name);
  }
});

test('isolation: generateIsolatedDbName generates prefixed unique name', async () => {
  const name1 = generateIsolatedDbName('gambit');
  const name2 = generateIsolatedDbName('gambit');
  assert.match(name1, /^gambit_backup_drill_restore_\d+_[a-f0-9]+$/);
  assert.notEqual(name1, name2);
});

test('isolation: validateTargetIsolation rejects malicious injection payloads in target URL', async () => {
  const source = 'postgres://gambit:pass@localhost:5432/gambit';
  const maliciousTarget = 'postgres://gambit:pass@localhost:5432/test" OR 1=1; DROP DATABASE production; --';

  await assert.rejects(
    async () => await validateTargetIsolation(source, maliciousTarget, { allowCustomTargetName: true }),
    /Invalid target database name format/
  );
});

test('backup validation: validateBackupFile rejects non-existent file', async () => {
  const nonExistent = join(tmpdir(), 'non-existent-backup-file-12345.dump');
  await assert.rejects(
    async () => await validateBackupFile(nonExistent, 'custom'),
    /Backup file does not exist/,
  );
});

test('backup validation: validateBackupFile rejects 0-byte empty file', async () => {
  const emptyFile = join(tmpdir(), `test-empty-backup-${Date.now()}.dump`);
  writeFileSync(emptyFile, Buffer.alloc(0));
  try {
    await assert.rejects(
      async () => await validateBackupFile(emptyFile, 'custom'),
      /Backup file is empty \(0 bytes\)/,
    );
  } finally {
    unlinkSync(emptyFile);
  }
});

test('backup validation: validateBackupFile rejects corrupted custom format archive without PGDMP header', async () => {
  const corruptFile = join(tmpdir(), `test-corrupt-backup-${Date.now()}.dump`);
  writeFileSync(corruptFile, Buffer.from('NOT_A_VALID_PG_DUMP_HEADER'));
  try {
    await assert.rejects(
      async () => await validateBackupFile(corruptFile, 'custom'),
      /Invalid custom-format backup: missing PostgreSQL dump magic header "PGDMP"/,
    );
  } finally {
    unlinkSync(corruptFile);
  }
});

test('backup validation: validateBackupFile accepts valid custom format archive with PGDMP header', async () => {
  const validFile = join(tmpdir(), `test-valid-backup-${Date.now()}.dump`);
  const header = Buffer.from('PGDMP\x01\x10\x00\x01');
  writeFileSync(validFile, header);
  try {
    const meta = await validateBackupFile(validFile, 'custom');
    assert.equal(meta.valid, true);
    assert.equal(meta.sizeBytes, header.length);
    assert.equal(typeof meta.sha256, 'string');
    assert.equal(meta.sha256.length, 64);
  } finally {
    unlinkSync(validFile);
  }
});

test('verification engine: detects missing extensions in restored database', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['users', 'games'],
    rowCounts: { users: 2, games: 1 },
    sampleData: {},
  };

  // Mock target database pool missing the 'vector' extension
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext', extversion: '1.6' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Missing required extension in restored database: vector/);
      return true;
    },
  );
});

test('verification engine: detects extension version mismatch between source and restored database', async () => {
  const sourceBaseline = {
    extensions: [{ extname: 'citext', extversion: '1.6' }, { extname: 'vector', extversion: '0.5.1' }],
    migrations: [],
    tables: [],
    rowCounts: {},
    sampleData: {},
  };

  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext', extversion: '1.6' }, { extname: 'vector', extversion: '0.4.0' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Extension version mismatch in restored database for vector: source 0.5.1 vs restored 0.4.0/);
      return true;
    },
  );
});

test('verification engine: detects missing schema_migrations table', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users'],
    rowCounts: { schema_migrations: 1, users: 1 },
    sampleData: {},
  };

  // Mock target where schema_migrations table does not exist
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Table schema_migrations does not exist in restored database/);
      return true;
    },
  );
});

test('verification engine: detects missing schema_migrations table or count mismatch', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [
      { version: 1, name: '0001_init.sql', checksum: 'abc1', state: 'applied' },
      { version: 2, name: '0002_seek_color.sql', checksum: 'abc2', state: 'applied' },
    ],
    tables: ['schema_migrations', 'users'],
    rowCounts: { schema_migrations: 2, users: 1 },
    sampleData: {},
  };

  // Mock target where only migration 1 is present
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'abc1', state: 'applied' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Migration count mismatch: source had 2, restored has 1/);
      return true;
    },
  );
});

test('verification engine: detects corrupted or modified migration checksum in restored database', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [
      { version: 1, name: '0001_init.sql', checksum: 'original_checksum_123', state: 'applied' },
    ],
    tables: ['schema_migrations'],
    rowCounts: { schema_migrations: 1 },
    sampleData: {},
  };

  // Mock target where migration 1 has altered checksum
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'corrupted_checksum_999', state: 'applied' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Migration 1 mismatch/);
      return true;
    },
  );
});

test('verification engine: detects missing tables in restored database', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users', 'games', 'tournaments'],
    rowCounts: { schema_migrations: 1, users: 2, games: 1, tournaments: 1 },
    sampleData: {},
  };

  // Mock target where 'tournaments' table is missing
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }] };
      }
      if (text.includes('information_schema.tables') || text.includes('pg_tables')) {
        return { rows: [{ tablename: 'schema_migrations' }, { tablename: 'users' }, { tablename: 'games' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Missing required table in restored database: tournaments/);
      return true;
    },
  );
});

test('verification engine: detects row count mismatch in critical tables', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users', 'game_events'],
    rowCounts: { schema_migrations: 1, users: 5, game_events: 100 },
    sampleData: {},
  };

  // Mock target where game_events only has 90 rows restored (incomplete restore!)
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }] };
      }
      if (text.includes('information_schema.tables') || text.includes('pg_tables')) {
        return { rows: [...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t })), ...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t }))] };
      }
      if (text.includes('COUNT(*) FROM "users"') || text.includes('COUNT(*) AS count FROM "users"')) {
        return { rows: [{ count: '5' }] };
      }
      if (text.includes('COUNT(*) FROM "game_events"') || text.includes('COUNT(*) AS count FROM "game_events"')) {
        return { rows: [{ count: '90' }] }; // 90 != 100
      }
      if (text.includes('COUNT(*) FROM "schema_migrations"') || text.includes('COUNT(*) AS count FROM "schema_migrations"')) {
        return { rows: [{ count: '1' }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Row count mismatch for table "game_events": source had 100, restored has 90/);
      return true;
    },
  );
});

test('verification engine: detects missing or inactive append-only trigger on game_events', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users', 'game_events'],
    rowCounts: { schema_migrations: 1, users: 1, game_events: 1 },
    sampleData: {},
  };

  // Mock target where table exists and row count matches, but trigger probe does NOT throw
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }] };
      }
      if (text.includes('information_schema.tables') || text.includes('pg_tables')) {
        return { rows: [...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t })), ...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t }))] };
      }
      if (text.includes('COUNT(*)')) {
        return { rows: [{ count: '1' }] };
      }
      if (text.includes('UPDATE game_events')) {
        // Trigger did NOT fire! Update silently returned 1 row updated!
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Append-only trigger on game_events failed: mutation was not blocked/);
      return true;
    },
  );
});

test('verification engine: passes when all structural and functional checks succeed', async () => {
  const sourceBaseline = {
    extensions: ['citext', 'vector'],
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users', 'game_events', 'variants'],
    rowCounts: { schema_migrations: 1, users: 1, game_events: 1, variants: 8 },
    sampleData: {
      users: [{ id: 'u1', handle: 'alice' }],
      game_events: [{ game_id: 'g1', seq: 0, type: 'MovePlayed' }],
    },
  };

  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text, params) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext' }, { extname: 'vector' }] };
      }
      if (text.includes("to_regclass('schema_migrations')")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes('SELECT version, name, checksum, state FROM schema_migrations')) {
        return { rows: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }] };
      }
      if (text.includes('information_schema.tables') || text.includes('pg_tables')) {
        return {
          rows: CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t })),
        };
      }
      if (text.includes('COUNT(*)')) {
        if (text.includes('variants')) return { rows: [{ count: '8' }] };
        return { rows: [{ count: '1' }] };
      }
      if (text.includes('SELECT id, handle FROM users')) {
        return { rows: [{ id: 'u1', handle: 'alice' }] };
      }
      if (text.includes('SELECT game_id, seq, type FROM game_events')) {
        return { rows: [{ game_id: 'g1', seq: 0, type: 'MovePlayed' }] };
      }
      if (text.includes('UPDATE game_events')) {
        // Trigger correctly blocks update
        const error = new Error('game_events is append-only (UPDATE.game_events attempted)');
        error.code = 'P0001';
        throw error;
      }
      if (text.includes('search_embeddings')) {
        return { rows: [{ index_name: 'search_embeddings_hnsw_idx', access_method: 'hnsw', indisvalid: true, indisready: true }] };
      }
      return { rows: [] };
    },
  };

  const report = await verifyRestoredDatabase(sourceBaseline, mockTargetPool);
  assert.equal(report.passed, true);
  assert.ok(report.checks.length >= 5);
  assert.equal(report.failures.length, 0);
});

test('cli: parseArgs parses options, flags, and environment fallbacks', () => {
  const customArgs = [
    '--source-url', 'postgres://u:p@localhost:5432/src',
    '--target-url', 'postgres://u:p@localhost:5432/gambit_backup_drill_restore',
    '--backup-file', '/tmp/my-backup.dump',
    '--keep-backup',
    '--keep-target',
    '--format', 'custom',
    '--json',
  ];

  const parsed = parseArgs(customArgs);
  assert.equal(parsed.sourceUrl, 'postgres://u:p@localhost:5432/src');
  assert.equal(parsed.targetUrl, 'postgres://u:p@localhost:5432/gambit_backup_drill_restore');
  assert.equal(parsed.backupFile, '/tmp/my-backup.dump');
  assert.equal(parsed.keepBackup, true);
  assert.equal(parsed.keepTarget, true);
  assert.equal(parsed.format, 'custom');
  assert.equal(parsed.json, true);
});

test('cli: parseArgs defaults to safe isolated target when not specified', () => {
  const originalEnv = process.env.BACKUP_DRILL_TARGET_URL;
  delete process.env.BACKUP_DRILL_TARGET_URL;
  try {
    const parsed = parseArgs(['--source-url', 'postgres://u:p@localhost:5432/gambit']);
    assert.equal(parsed.sourceUrl, 'postgres://u:p@localhost:5432/gambit');
    assert.match(parsed.targetUrl, /^postgres:\/\/u:p@localhost:5432\/gambit_backup_drill_restore_\d+_[a-f0-9]+$/);
    assert.equal(parsed.keepBackup, false);
    assert.equal(parsed.keepTarget, false);
    assert.equal(parsed.format, 'custom');
  } finally {
    if (originalEnv !== undefined) {
      process.env.BACKUP_DRILL_TARGET_URL = originalEnv;
    }
  }
});

test('tooling: resolvePgTooling accepts options and detects native or docker runner', () => {
  const mockExec = (cmd, args) => { return Buffer.from('mock version'); };

  const customTooling = resolvePgTooling({ format: 'custom', execSyncFn: mockExec });
  assert.ok(customTooling.type === 'native' || customTooling.type === 'docker');
  assert.equal(typeof customTooling.runDump, 'function');
  assert.equal(typeof customTooling.runRestore, 'function');
  assert.equal(typeof customTooling.runPsql, 'function');

  const plainTooling = resolvePgTooling({ format: 'plain', execSyncFn: mockExec });
  assert.ok(plainTooling.type === 'native' || plainTooling.type === 'docker');
});

test('pg_restore: parsePgRestoreError rejects nonzero status even with warning-only diagnostics', () => {
  const err = new Error('Command failed: pg_restore exit code 1');
  err.status = 1;
  err.stderr = Buffer.from(
    'pg_restore: warning: errors ignored on restore: 1\n' +
    'pg_restore: warning: could not execute query: ERROR:  schema "public" does not exist'
  );

  assert.throws(() => parsePgRestoreError(err), error => error === err);
});

test('pg_restore: parsePgRestoreError throws on real errors including missing objects', () => {
  const err = new Error('Command failed: pg_restore exit code 1');
  err.status = 1;
  err.stderr = Buffer.from(
    'pg_restore: warning: errors ignored on restore: 1\n' +
    'pg_restore: error: could not execute query: ERROR:  role "postgres" does not exist'
  );

  assert.throws(() => parsePgRestoreError(err), /Command failed/);
});

test('verification engine: checks REQUIRED_EXTENSIONS even when not present in source baseline', async () => {
  const sourceBaseline = {
    extensions: [], // Missing from source!
    migrations: [{ version: 1, name: '0001_init.sql', checksum: 'abc', state: 'applied' }],
    tables: ['schema_migrations', 'users'],
    rowCounts: { schema_migrations: 1, users: 1 },
    sampleData: {},
  };

  // Mock target database pool where required extension "vector" is missing
  const mockTargetPool = {
    async connect() { return { query: this.query, release: () => {} }; },
    async query(text) {
      if (text.includes('pg_extension')) {
        return { rows: [{ extname: 'citext', extversion: '1.6' }] }; // "vector" missing
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyRestoredDatabase(sourceBaseline, mockTargetPool),
    (err) => {
      assert.match(err.message, /Missing required extension in restored database: vector/);
      return true;
    },
  );
});

test(
  'integration: full backup, isolated restore, and verification drill against live Postgres',
  { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL not set' },
  async () => {
    const sourceUrl = process.env.DATABASE_URL;
    const report = await runBackupRestoreDrill({
      sourceUrl,
      keepTarget: false,
      keepBackup: false,
    });
    assert.equal(report.success, true);
    assert.ok(report.checks.length > 0);
  },
);
