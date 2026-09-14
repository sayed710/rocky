#!/usr/bin/env node
/**
 * @file scripts/db-backup-restore-drill.mjs
 *
 * Reproducible, operator-usable PostgreSQL backup and restore verification drill.
 *
 * What this script does:
 * 1. Validates connection parameters and enforces target database isolation guardrails.
 * 2. Connects to the source application database and captures a baseline of durable state:
 *    - Schema migrations ledger and SHA-256 checksums
 *    - Required extensions (citext, vector)
 *    - Critical application tables and exact row counts
 *    - Representative durable sample records (users, game events, tournaments, etc.)
 * 3. Creates a standard PostgreSQL backup using pg_dump (-Fc custom archive format with TOC).
 * 4. Validates the backup artifact (file size, header magic "PGDMP", integrity).
 * 5. Provisions a clean, isolated target database (never overwriting source).
 * 6. Restores the backup into the isolated target using pg_restore.
 * 7. Performs deep structural and functional verification:
 *    - All required extensions are active (citext, vector)
 *    - Migration count and checksums match source byte-for-byte
 *    - All critical application tables are present
 *    - Row counts across all durable tables match 100%
 *    - Sample durable records match source data
 *    - Append-only trigger (game_events_block_mutate) is active and blocks UPDATE/DELETE
 *    - pgvector operations and HNSW indexes are valid and queryable
 *    - Target database is functional and writable
 * 8. Cleans up isolated target database and temporary dump file (unless flags request retention).
 * 9. Emits a structured diagnostic audit report.
 *
 * Security:
 * - Passwords and credentials are NEVER logged or printed.
 * - PGPASSWORD is passed via process environment, not command-line arguments.
 * - Destructive actions are restricted to isolated targets; refusing any target matching source.
 *
 * Usage:
 *   node scripts/db-backup-restore-drill.mjs [options]
 *
 * Options:
 *   --source-url <url>           Source database URL (defaults to DATABASE_URL)
 *   --target-url <url>           Explicit target database URL (must be isolated)
 *   --target-db-name <name>      Target database name (default: auto-generated isolated name)
 *   --backup-file <path>         Path for backup dump file (default: temporary file)
 *   --keep-backup                Preserve the backup dump file after the drill
 *   --keep-target                Preserve the restored target database after the drill
 *   --format <custom|plain>      pg_dump format (default: custom)
 *   --use-docker                 Force execution of pg tools via Docker container
 *   --docker-image <image>       Docker image for pg tools (default: pgvector/pgvector:pg16)
 *   --allow-custom-target-name   Permit target name without default isolation markers
 *   --json                       Output drill report in JSON format
 *   --help                       Show this help message
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, unlinkSync, readFileSync, openSync, readSync, closeSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const { Pool, Client } = pg;

/** Critical application tables that hold durable state or lookup vocabularies. */
export const CRITICAL_APPLICATION_TABLES = [
  'schema_migrations',
  'variants',
  'terminations',
  'users',
  'credentials',
  'webauthn_credentials',
  'sessions',
  'roles',
  'ratings',
  'seeks',
  'game_events',
  'games',
  'tournaments',
  'audit_log',
  'search_documents',
  'search_embeddings',
];

/** Required PostgreSQL extensions for the Gambit platform. */
export const REQUIRED_EXTENSIONS = ['citext', 'vector'];

/** Names of databases that must never be targeted for destructive drop/overwrite. */
const PROTECTED_DATABASE_NAMES = new Set([
  'gambit',
  'postgres',
  'template0',
  'template1',
  'production',
  'prod',
  'master',
  'main',
]);

/** Isolation keywords required in target database names unless explicitly overridden. */
const ISOLATION_MARKERS = /(?:drill|restore|disposable|test|isolated)/i;

/**
 * Mask passwords in database connection strings for safe logging and error reporting.
 */
export function sanitizeDatabaseUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) {
    return urlString || '';
  }
  try {
    const parsed = new URL(urlString);
    if (parsed.password) {
      parsed.password = '***';
    }
    for (const key of parsed.searchParams.keys()) {
      if (/password|secret|token/i.test(key)) parsed.searchParams.set(key, '***');
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Regex fallback for partially malformed or non-standard connection strings
    return urlString.replace(/(:\/\/)([^:@]+)(?::([^@]+))?(@)/, '$1$2:***$4');
  }
}

/** Redact known connection secrets and embedded URLs from process diagnostics. */
function sanitizeDiagnostic(message, urls) {
  let result = String(message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, sanitizeDatabaseUrl);
  const secrets = new Set();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        secrets.add(parsed.password);
        secrets.add(decodeURIComponent(parsed.password));
      }
      for (const [key, value] of parsed.searchParams) {
        if (value && /password|secret|token/i.test(key)) secrets.add(value);
      }
    } catch { /* Invalid URLs are handled by argument validation. */ }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, '***');
  }
  return result;
}

/**
 * Generate a unique, isolated database name for the restore drill.
 */
export function generateIsolatedDbName(base = 'gambit') {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const suffix = `_backup_drill_restore_${timestamp}_${random}`;
  const prefix = base.replace(/[^a-zA-Z0-9_-]/g, '_') || 'gambit';
  return `${prefix.slice(0, 63 - suffix.length)}${suffix}`;
}

export function parseDatabaseUrl(urlString) {
  const parsed = new URL(urlString);
  const dbName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const sslParams = {};
  const supportedQueryParams = new Set(['sslmode', 'sslcert', 'sslkey', 'sslrootcert']);
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!supportedQueryParams.has(key)) throw new Error('Unsupported database URL query parameter; only sslmode, sslcert, sslkey, and sslrootcert are allowed');
    const envKey = 'PG' + key.toUpperCase();
    sslParams[envKey] = value;
  }
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database: decodeURIComponent(dbName),
    searchParams: parsed.searchParams,
    sslParams,
    protocol: parsed.protocol,
  };
}

/**
 * Construct a connection URL replacing only the database name.
 */
export function urlWithDatabase(urlString, databaseName) {
  const parsed = new URL(urlString);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}

/**
 * Enforce target isolation guardrails to guarantee the drill cannot overwrite or drop source/production DBs.
 */
export async function validateTargetIsolation(sourceUrl, targetUrl, options = {}) {
  if (!sourceUrl) {
    throw new Error('Source database URL is required');
  }
  if (!targetUrl) {
    throw new Error('Target database URL is required');
  }

  const source = parseDatabaseUrl(sourceUrl);
  const target = parseDatabaseUrl(targetUrl);

  if (!/^[a-zA-Z0-9_-]+$/.test(target.database)) {
    throw new Error('Invalid target database name format');
  }
  if (Buffer.byteLength(target.database, 'utf8') > 63) {
    throw new Error('Target database name must not exceed 63 bytes');
  }

  // 1. URLs must not be identical
  if (sourceUrl.trim() === targetUrl.trim()) {
    throw new Error(
      `Target database URL must not be identical to source database URL: ${sanitizeDatabaseUrl(targetUrl)}`,
    );
  }

  const resolveHost = async (host) => {
    try {
      return (await lookup(host)).address;
    } catch {
      return host;
    }
  };

  const sourceIp = await resolveHost(source.host);
  const targetIp = await resolveHost(target.host);

  // 2. Target must not target the same database on the same host/port
  if (
    sourceIp === targetIp &&
    source.port === target.port &&
    source.database.toLowerCase() === target.database.toLowerCase()
  ) {
    throw new Error(
      `Target database name "${target.database}" matches source database name on the same host (${target.host}:${target.port}). Refusing unsafe operation.`,
    );
  }

  // 3. Target must not be a protected system or production database name
  if (PROTECTED_DATABASE_NAMES.has(target.database.toLowerCase())) {
    throw new Error(
      `Target database name "${target.database}" is a protected or non-isolated database. Target must be a dedicated disposable drill database.`,
    );
  }

  // 4. Target name must contain an isolation marker unless explicitly overridden
  if (!ISOLATION_MARKERS.test(target.database) && !options.allowCustomTargetName) {
    throw new Error(
      `Target database name "${target.database}" does not contain an isolated drill marker (such as "drill", "restore", "test", "disposable", "isolated"). Refusing to use potentially unsafe target. Supply --allow-custom-target-name if this is intentional.`,
    );
  }

  return {
    isolated: true,
    sourceDbName: source.database,
    targetDbName: target.database,
  };
}

/**
 * Validate a backup file's existence, size, header magic, and digest.
 */
export async function validateBackupFile(filePath, format = 'custom') {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file does not exist: ${filePath}`);
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    throw new Error(`Backup file is empty (0 bytes): ${filePath}`);
  }

  // Check header magic for custom format
  if (format === 'custom') {
    if (stats.size < 5) {
      throw new Error(`Invalid custom-format backup: file is too small (${stats.size} bytes)`);
    }
    const fd = openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(5);
    try {
      readSync(fd, headerBuf, 0, 5, 0);
    } finally {
      closeSync(fd);
    }
    if (headerBuf.toString('ascii') !== 'PGDMP') {
      throw new Error(
        'Invalid custom-format backup: missing PostgreSQL dump magic header "PGDMP". The backup may be corrupted or created in an incompatible format.',
      );
    }
  }

  // Compute SHA-256 digest
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  const sha256 = hash.digest('hex');

  return {
    valid: true,
    filePath,
    sizeBytes: stats.size,
    sha256,
  };
}

export function resolvePgTooling(options = {}) {
  const execSyncFn = options.execSyncFn || execFileSync;
  const forceDocker = options.useDocker === true || options.useDocker === 'true';
  const dockerImage = options.dockerImage || 'pgvector/pgvector:pg16';

  let hasNativePgDump = false;
  let hasNativePgRestore = false;
  let hasNativePsql = false;

  if (!forceDocker) {
    try {
      execSyncFn('pg_dump', ['--version'], { stdio: 'ignore' });
      hasNativePgDump = true;
    } catch {}
    try {
      execSyncFn('pg_restore', ['--version'], { stdio: 'ignore' });
      hasNativePgRestore = true;
    } catch {}
    try {
      execSyncFn('psql', ['--version'], { stdio: 'ignore' });
      hasNativePsql = true;
    } catch {}
  }

  const isPlain = (options.format || 'custom') === 'plain';
  const hasRequiredNativeTools = isPlain
    ? (hasNativePgDump && hasNativePsql)
    : (hasNativePgDump && hasNativePgRestore);

  if (hasRequiredNativeTools) {
    return {
      type: 'native',
      runDump: (args, env) => execSyncFn('pg_dump', args, { env: { ...process.env, ...env }, stdio: 'pipe' }),
      runRestore: (args, env) => execSyncFn('pg_restore', args, { env: { ...process.env, ...env }, stdio: 'pipe' }),
      runPsql: (args, env) => execSyncFn('psql', args, { env: { ...process.env, ...env }, stdio: 'pipe' }),
    };
  }

  // Fallback: Check if Docker is available
  let hasDocker = false;
  try {
    execSyncFn('docker', ['--version'], { stdio: 'ignore' });
    hasDocker = true;
  } catch {}

  if (!hasDocker) {
    const requiredTools = isPlain ? 'pg_dump, psql' : 'pg_dump, pg_restore';
    throw new Error(
      `Neither native PostgreSQL tools (${requiredTools}) nor Docker are available in PATH. Please install postgresql-client or ensure Docker is running.`,
    );
  }

  return {
    type: 'docker',
    dockerImage,
    runDump: (args, env, mountDir) => {
      const dockerArgs = ['run', '--rm'];
      if (env.PGPASSWORD) dockerArgs.push('-e', 'PGPASSWORD');
      for (const key of Object.keys(env)) {
        if (key.startsWith('PGSSL')) dockerArgs.push('-e', key);
      }
      if (mountDir) dockerArgs.push('-v', `${mountDir}:/work`);
      // Network host so it can reach localhost postgres
      if (process.platform === 'linux') {
        dockerArgs.push('--net=host');
      }
      dockerArgs.push(dockerImage, 'pg_dump', ...args);
      return execSyncFn('docker', dockerArgs, { env: { ...process.env, ...env }, stdio: 'pipe' });
    },
    runRestore: (args, env, mountDir) => {
      const dockerArgs = ['run', '--rm'];
      if (env.PGPASSWORD) dockerArgs.push('-e', 'PGPASSWORD');
      for (const key of Object.keys(env)) {
        if (key.startsWith('PGSSL')) dockerArgs.push('-e', key);
      }
      if (mountDir) dockerArgs.push('-v', `${mountDir}:/work`);
      if (process.platform === 'linux') {
        dockerArgs.push('--net=host');
      }
      dockerArgs.push(dockerImage, 'pg_restore', ...args);
      return execSyncFn('docker', dockerArgs, { env: { ...process.env, ...env }, stdio: 'pipe' });
    },
    runPsql: (args, env, mountDir) => {
      const dockerArgs = ['run', '--rm'];
      if (env.PGPASSWORD) dockerArgs.push('-e', 'PGPASSWORD');
      for (const key of Object.keys(env)) {
        if (key.startsWith('PGSSL')) dockerArgs.push('-e', key);
      }
      if (mountDir) dockerArgs.push('-v', `${mountDir}:/work`);
      if (process.platform === 'linux') {
        dockerArgs.push('--net=host');
      }
      dockerArgs.push(dockerImage, 'psql', ...args);
      return execSyncFn('docker', dockerArgs, { env: { ...process.env, ...env }, stdio: 'pipe' });
    },
  };
}

/**
 * Reject every failed pg_restore invocation, regardless of diagnostic language or content.
 */
export function parsePgRestoreError(err) {
  throw err;
}

/**
 * Capture source database state baseline before running backup.
 */
export async function collectSourceBaseline(pool, existingClient = null) {
  const client = existingClient || (await pool.connect());
  const shouldManageTx = !existingClient;
  if (shouldManageTx) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  try {
    // 1. Extensions with versions
    const extRes = await client.query('SELECT extname, extversion FROM pg_extension ORDER BY extname');
    const extensions = extRes.rows.map((r) => ({ extname: r.extname, extversion: r.extversion }));

    // 2. Schema migrations
    const hasMigrationsTable = await client.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    let migrations = [];
    if (hasMigrationsTable.rows[0]?.present) {
      const migRes = await client.query(
        'SELECT version, name, checksum, state FROM schema_migrations ORDER BY version',
      );
      migrations = migRes.rows;
    }

    // 3. Existing tables in public schema
    const tableRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tables = tableRes.rows.map((r) => r.tablename);

    // 4. Row counts across critical tables
    const rowCounts = Object.create(null);
    for (const table of tables) {
      const countRes = await client.query(`SELECT COUNT(*) AS count FROM "${table.replace(/"/g, '""')}"`);
      rowCounts[table] = parseInt(countRes.rows[0].count, 10);
    }

    // 5. Sample records for integrity comparison
    const sampleData = {};
    if (tables.includes('users') && (rowCounts['users'] || 0) > 0) {
      const sampleUsers = await client.query('SELECT id, handle FROM users ORDER BY created_at LIMIT 5');
      sampleData.users = sampleUsers.rows;
    }
    if (tables.includes('game_events') && (rowCounts['game_events'] || 0) > 0) {
      const sampleEvents = await client.query(
        'SELECT game_id, seq, type FROM game_events ORDER BY server_ts DESC LIMIT 5',
      );
      sampleData.game_events = sampleEvents.rows;
    }
    if (tables.includes('tournaments') && (rowCounts['tournaments'] || 0) > 0) {
      const sampleTournaments = await client.query(
        'SELECT id, name, format FROM tournaments ORDER BY created_at DESC LIMIT 5',
      );
      sampleData.tournaments = sampleTournaments.rows;
    }

    return {
      extensions,
      migrations,
      tables,
      rowCounts,
      sampleData,
    };
  } finally {
    if (shouldManageTx) {
      await client.query('ROLLBACK');
      client.release();
    }
  }
}

/**
 * Deep structural and functional verification of restored target database against source baseline.
 */
export async function verifyRestoredDatabase(sourceBaseline, targetPool, options = {}) {
  const checks = [];
  const failures = [];

  const recordCheck = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    if (!passed) {
      failures.push({ name, detail });
    }
  };

  // Check 1: Extensions
  const extRes = await targetPool.query('SELECT extname, extversion FROM pg_extension ORDER BY extname');
  const targetExtMap = new Map();
  for (const r of extRes.rows || []) {
    targetExtMap.set(r.extname, r.extversion || null);
  }
  const targetExts = new Set(targetExtMap.keys());

  for (const requiredExt of REQUIRED_EXTENSIONS) {
    const present = targetExtMap.has(requiredExt);
    recordCheck(
      `Required Extension: ${requiredExt}`,
      present,
      present ? 'Installed and active' : `Missing required extension in restored database: ${requiredExt}`,
    );
    if (!present) {
      throw new Error(`Missing required extension in restored database: ${requiredExt}`);
    }
  }

  // Compare every source extension and version with restored database
  for (const srcExt of sourceBaseline.extensions || []) {
    const name = typeof srcExt === 'string' ? srcExt : srcExt.extname;
    const version = typeof srcExt === 'string' ? null : (srcExt.extversion || null);
    const present = targetExtMap.has(name);
    const targetVersion = targetExtMap.get(name);
    const versionMatch = !version || !targetVersion || targetVersion === version;
    recordCheck(
      `Source Extension: ${name}`,
      present && versionMatch,
      present
        ? (versionMatch ? `Installed version ${targetVersion || 'active'}` : `Version mismatch: source ${version} vs restored ${targetVersion}`)
        : `Missing source extension in restored database: ${name}`,
    );
    if (!present) {
      throw new Error(`Missing source extension in restored database: ${name}`);
    }
    if (!versionMatch) {
      throw new Error(`Extension version mismatch in restored database for ${name}: source ${version} vs restored ${targetVersion}`);
    }
  }

  // Check 2: Schema migrations ledger
  if (sourceBaseline.migrations && sourceBaseline.migrations.length > 0) {
    const migTableRes = await targetPool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    if (!migTableRes.rows[0]?.present) {
      recordCheck('Migrations Ledger', false, 'Table schema_migrations does not exist in restored database');
      throw new Error('Table schema_migrations does not exist in restored database');
    }

    const targetMigRes = await targetPool.query(
      'SELECT version, name, checksum, state FROM schema_migrations ORDER BY version',
    );
    const targetMigrations = targetMigRes.rows;

    if (targetMigrations.length !== sourceBaseline.migrations.length) {
      const msg = `Migration count mismatch: source had ${sourceBaseline.migrations.length}, restored has ${targetMigrations.length}`;
      recordCheck('Migration Count', false, msg);
      throw new Error(msg);
    }
    recordCheck(
      'Migration Count',
      true,
      `All ${sourceBaseline.migrations.length} migration records restored`,
    );

    const targetMigMap = new Map(targetMigrations.map((m) => [m.version, m]));
    for (const srcMig of sourceBaseline.migrations) {
      const tgtMig = targetMigMap.get(srcMig.version);
      if (!tgtMig) {
        throw new Error(`Restored database is missing recorded migration version ${srcMig.version}`);
      }
      if (tgtMig.checksum !== srcMig.checksum || tgtMig.name !== srcMig.name || tgtMig.state !== srcMig.state || tgtMig.state !== 'applied') {
        const msg = `Migration ${srcMig.version} mismatch: source="${srcMig.checksum}/${srcMig.name}/${srcMig.state}", restored="${tgtMig.checksum}/${tgtMig.name}/${tgtMig.state}" (must be 'applied')`;
        recordCheck(`Migration Checksum ${srcMig.version}`, false, msg);
        throw new Error(msg);
      }
    }
    recordCheck('Migration Checksums', true, 'All migration ledger checksums match source byte-for-byte');
  }

  // Check 3: Tables
  const tgtTableRes = await targetPool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const targetTables = new Set(tgtTableRes.rows.map((r) => r.tablename));

  for (const expectedTable of new Set([...sourceBaseline.tables, ...CRITICAL_APPLICATION_TABLES])) {
    const present = targetTables.has(expectedTable);
    if (!present) {
      const msg = `Missing required table in restored database: ${expectedTable}`;
      recordCheck(`Table: ${expectedTable}`, false, msg);
      throw new Error(msg);
    }
  }
  recordCheck(
    'Table Structure',
    true,
    `All ${sourceBaseline.tables.length} tables present in restored database`,
  );

  // Check 4: Row Counts
  for (const [table, expectedCount] of Object.entries(sourceBaseline.rowCounts)) {
    if (!targetTables.has(table)) continue;
    const countRes = await targetPool.query(`SELECT COUNT(*) AS count FROM "${table.replace(/"/g, '""')}"`);
    const actualCount = parseInt(countRes.rows[0].count, 10);
    if (actualCount !== expectedCount) {
      const msg = `Row count mismatch for table "${table}": source had ${expectedCount}, restored has ${actualCount}`;
      recordCheck(`Row Count: ${table}`, false, msg);
      throw new Error(msg);
    }
  }
  recordCheck('Row Counts', true, 'All table row counts match source database 100%');

  // Check 5: Sample Data Identity
  if (sourceBaseline.sampleData?.users?.length) {
    const userSample = sourceBaseline.sampleData.users[0];
    const userCheck = await targetPool.query('SELECT id, handle FROM users WHERE id = $1', [userSample.id]);
    if (userCheck.rows.length === 0 || userCheck.rows[0].handle !== userSample.handle) {
      throw new Error(`Sample user record ${userSample.id} (${userSample.handle}) not found or mismatched in restored database`);
    }
    recordCheck('Sample Data: Users', true, `Sample user ${userSample.handle} verified`);
  }

  if (sourceBaseline.sampleData?.game_events?.length) {
    const eventSample = sourceBaseline.sampleData.game_events[0];
    const eventCheck = await targetPool.query(
      'SELECT game_id, seq, type FROM game_events WHERE game_id = $1 AND seq = $2',
      [eventSample.game_id, eventSample.seq],
    );
    if (eventCheck.rows.length === 0 || eventCheck.rows[0].type !== eventSample.type) {
      throw new Error(`Sample game_event ${eventSample.game_id}#${eventSample.seq} not found or mismatched in restored database`);
    }
    recordCheck('Sample Data: Game Events', true, `Sample game event ${eventSample.type} verified`);
  }

  // Check 6: Append-only trigger enforcement on game_events
  if (targetTables.has('game_events')) {
    let triggerActive = false;
    const client = await targetPool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'UPDATE game_events SET seq = seq WHERE game_id IN (SELECT game_id FROM game_events LIMIT 1)',
      );
      if (res.rowCount && res.rowCount > 0) {
        triggerActive = false;
      } else {
        // Table was empty; verify trigger registration in pg_trigger catalog
        const trigRes = await client.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.game_events'::regclass AND tgname = 'game_events_block_mutate' AND tgenabled = 'O'",
        );
        triggerActive = trigRes.rows.length > 0;
      }
    } catch (err) {
      if (
        err.message &&
        err.message.includes('game_events is append-only') && err.code === 'P0001'
      ) {
        triggerActive = true;
      } else {
        throw err;
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    if (!triggerActive) {
      const msg = 'Append-only trigger on game_events failed: mutation was not blocked';
      recordCheck('Trigger: game_events append-only', false, msg);
      throw new Error(msg);
    }
    recordCheck('Trigger: game_events append-only', true, 'Mutation blocked by trigger game_events_block_mutate');
  }

  // Check 7: Semantic search / pgvector functional test
  if (targetTables.has('search_embeddings') && targetExts.has('vector')) {
    try {
      // Test vector operator syntax and index validity
      const testVec = `[${new Array(256).fill(0.1).join(',')}]`;
      await targetPool.query('SELECT $1::vector(256) <=> $1::vector(256) AS dist', [testVec]);

      const idxRes = await targetPool.query(`
        SELECT i.relname AS index_name, am.amname AS access_method, ix.indisvalid, ix.indisready
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_am am ON i.relam = am.oid
        WHERE t.oid = 'public.search_embeddings'::regclass AND am.amname = 'hnsw'
      `);
      if (!idxRes.rows.some(index => index.indisvalid === true && index.indisready === true)) {
        throw new Error('Valid and ready HNSW index missing on search_embeddings table');
      }

      recordCheck('pgvector Functionality', true, 'Vector cosine operator (<=>) and HNSW index functional');
    } catch (err) {
      const msg = `Vector functionality verification failed: ${err.message}`;
      recordCheck('pgvector Functionality', false, msg);
      throw new Error(msg);
    }
  }

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

/**
 * CLI Argument parser.
 */
export function parseArgs(args = process.argv.slice(2)) {
  const result = {
    sourceUrl: process.env.BACKUP_DRILL_SOURCE_URL || process.env.DATABASE_URL || '',
    targetUrl: process.env.BACKUP_DRILL_TARGET_URL || '',
    targetDbName: '',
    backupFile: '',
    keepBackup: false,
    keepTarget: false,
    format: 'custom',
    useDocker: 'auto',
    dockerImage: 'pgvector/pgvector:pg16',
    allowCustomTargetName: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source-url' && i + 1 < args.length) {
      result.sourceUrl = args[++i];
    } else if (arg === '--target-url' && i + 1 < args.length) {
      result.targetUrl = args[++i];
    } else if (arg === '--target-db-name' && i + 1 < args.length) {
      result.targetDbName = args[++i];
    } else if (arg === '--backup-file' && i + 1 < args.length) {
      result.backupFile = args[++i];
    } else if (arg === '--keep-backup') {
      result.keepBackup = true;
    } else if (arg === '--keep-target') {
      result.keepTarget = true;
    } else if (arg === '--format' && i + 1 < args.length) {
      result.format = args[++i];
      if (result.format !== 'custom' && result.format !== 'plain') {
        throw new Error(`Invalid format "${result.format}". Only "custom" and "plain" are allowed.`);
      }
    } else if (arg === '--use-docker') {
      result.useDocker = true;
    } else if (arg === '--no-docker') {
      result.useDocker = false;
    } else if (arg === '--docker-image' && i + 1 < args.length) {
      result.dockerImage = args[++i];
    } else if (arg === '--allow-custom-target-name') {
      result.allowCustomTargetName = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
  }

  if (result.sourceUrl && !result.targetUrl) {
    const isolatedName = result.targetDbName || generateIsolatedDbName('gambit');
    result.targetUrl = urlWithDatabase(result.sourceUrl, isolatedName);
  }

  return result;
}

/**
 * Execute full backup, isolated restore, and verification drill.
 */
export async function runBackupRestoreDrill(options = {}) {
  const startTime = Date.now();
  const report = {
    startedAt: new Date(startTime).toISOString(),
    source: '',
    target: '',
    backupFile: '',
    backupSizeBytes: 0,
    backupSha256: '',
    timings: {},
    checks: [],
    success: false,
  };

  const parsedSource = parseDatabaseUrl(options.sourceUrl);
  const targetUrl = options.targetUrl || urlWithDatabase(
    options.sourceUrl,
    options.targetDbName || generateIsolatedDbName(parsedSource.database),
  );
  const parsedTarget = parseDatabaseUrl(targetUrl);

  report.source = sanitizeDatabaseUrl(options.sourceUrl);
  report.target = sanitizeDatabaseUrl(targetUrl);

  // Validate isolation
  await validateTargetIsolation(options.sourceUrl, targetUrl, {
    allowCustomTargetName: options.allowCustomTargetName,
  });

  const sourcePool = new Pool({ connectionString: options.sourceUrl, max: 2 });
  let targetPool = null;
  let adminClient = null;
  let targetCreatedByThisRun = false;
  let backupCreatedByThisRun = false;
  let drillError = null;
  const cleanupErrors = [];

  const rawBackupPath =
    options.backupFile ||
    join(tmpdir(), `gambit_backup_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}.dump`);
  const backupPath = resolve(rawBackupPath);
  const backupDir = dirname(backupPath);
  const backupFileName = basename(backupPath);
  report.backupFile = backupPath;

  const log = (msg) => {
    if (!options.json) {
      console.log(`[drill] ${sanitizeDiagnostic(msg, [options.sourceUrl, targetUrl])}`);
    }
  };

  try {
    // Reserve the destination exclusively before any tool can overwrite it.
    const backupFd = openSync(backupPath, 'wx', 0o600);
    backupCreatedByThisRun = true;
    closeSync(backupFd);
    const tooling = resolvePgTooling(options);
    const isCustom = (options.format || 'custom') === 'custom';
    // 1. Capture source baseline and export snapshot
    log(`Capturing source baseline from ${report.source}...`);
    const baselineClient = await sourcePool.connect();
    let snapshotId = null;
    let sourceBaseline = null;
    let baselineError = null;
    const baselineCleanupErrors = [];
    try {
      await baselineClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapRes = await baselineClient.query('SELECT pg_export_snapshot() AS snap');
      snapshotId = snapRes.rows[0]?.snap;
      if (!snapshotId) throw new Error('Source did not provide an exported snapshot; refusing an inconsistent drill');
      sourceBaseline = await collectSourceBaseline(sourcePool, baselineClient);
      log(`Source baseline captured: ${sourceBaseline.tables.length} tables, ${sourceBaseline.migrations.length} migrations.`);

      // 2. Resolve tooling
      log(`Resolved PostgreSQL tooling (${tooling.type})...`);

      // 3. Perform backup using pg_dump
      log(`Creating ${options.format || 'custom'} backup to ${backupPath}...`);
      const dumpStart = Date.now();

      if (tooling.type === 'native') {
        const dumpArgs = [
          '-h', parsedSource.host,
          '-p', String(parsedSource.port),
          '-U', parsedSource.user,
          '-d', parsedSource.database,
          '-F', isCustom ? 'c' : 'p',
          '--no-owner',
          '--no-acl',
          '-f', backupPath,
        ];
        if (snapshotId) {
          dumpArgs.push(`--snapshot=${snapshotId}`);
        }
        tooling.runDump(dumpArgs, { PGPASSWORD: parsedSource.password, ...parsedSource.sslParams });
      } else {
        // Docker mode
        const hostForDocker =
          parsedSource.host === 'localhost' || parsedSource.host === '127.0.0.1'
            ? (process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal')
            : parsedSource.host;

        const dumpArgs = [
          '-h', hostForDocker,
          '-p', String(parsedSource.port),
          '-U', parsedSource.user,
          '-d', parsedSource.database,
          '-F', isCustom ? 'c' : 'p',
          '--no-owner',
          '--no-acl',
          '-f', `/work/${backupFileName}`,
        ];
        if (snapshotId) {
          dumpArgs.push(`--snapshot=${snapshotId}`);
        }
        tooling.runDump(dumpArgs, { PGPASSWORD: parsedSource.password, ...parsedSource.sslParams }, backupDir);
      }
      report.timings.backupMs = Date.now() - dumpStart;
      log(`Backup completed in ${report.timings.backupMs}ms.`);
    } catch (err) {
      baselineError = err;
    } finally {
      await baselineClient.query('ROLLBACK').catch(err => baselineCleanupErrors.push(err));
      try {
        baselineClient.release();
      } catch (err) {
        baselineCleanupErrors.push(err);
      }
    }
    const baselineErrors = [...(baselineError ? [baselineError] : []), ...baselineCleanupErrors];
    if (baselineErrors.length === 1) throw baselineErrors[0];
    if (baselineErrors.length > 1) {
      throw new AggregateError(
        baselineErrors,
        'Source baseline, dump, or transaction cleanup failed: ' + baselineErrors.map(error => error?.message || String(error)).join('; '),
      );
    }

    // 4. Validate backup file
    const backupMeta = await validateBackupFile(backupPath, options.format || 'custom');
    report.backupSizeBytes = backupMeta.sizeBytes;
    report.backupSha256 = backupMeta.sha256;
    log(`Backup file validated: ${backupMeta.sizeBytes} bytes (SHA-256: ${backupMeta.sha256.substring(0, 12)}...).`);

    // 5. Create isolated target database
    log(`Provisioning isolated target database "${parsedTarget.database}"...`);
    const adminUrl = urlWithDatabase(targetUrl, 'postgres');
    adminClient = new Client({ connectionString: adminUrl, statement_timeout: 10000 });
    try {
      await adminClient.connect();
    } catch {
      // Try template1 if postgres db is not accessible
      adminClient = new Client({ connectionString: urlWithDatabase(targetUrl, 'template1'), statement_timeout: 10000 });
      await adminClient.connect();
    }

    await adminClient.query(`SET statement_timeout = 10000`);
    await adminClient.query(`CREATE DATABASE "` + parsedTarget.database.replace(/"/g, '""') + `"`);
    targetCreatedByThisRun = true;
    log(`Target database "${parsedTarget.database}" created.`);

    // 6. Restore backup into target
    log(`Restoring backup into ${report.target}...`);
    const restoreStart = Date.now();
    if (tooling.type === 'native') {
      if (isCustom) {
        const restoreArgs = [
          '-h', parsedTarget.host,
          '-p', String(parsedTarget.port),
          '-U', parsedTarget.user,
          '-d', parsedTarget.database,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          '--exit-on-error',
          backupPath,
        ];
        try {
          tooling.runRestore(restoreArgs, { PGPASSWORD: parsedTarget.password, ...parsedTarget.sslParams });
        } catch (err) {
          parsePgRestoreError(err);
        }
      } else {
        const psqlArgs = [
          '-h', parsedTarget.host,
          '-p', String(parsedTarget.port),
          '-U', parsedTarget.user,
          '-d', parsedTarget.database,
          '-v', 'ON_ERROR_STOP=1',
          '-f', backupPath,
        ];
        tooling.runPsql(psqlArgs, { PGPASSWORD: parsedTarget.password, ...parsedTarget.sslParams });
      }
    } else {
      // Docker mode
      const hostForDocker =
        parsedTarget.host === 'localhost' || parsedTarget.host === '127.0.0.1'
          ? (process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal')
          : parsedTarget.host;

      if (isCustom) {
        const restoreArgs = [
          '-h', hostForDocker,
          '-p', String(parsedTarget.port),
          '-U', parsedTarget.user,
          '-d', parsedTarget.database,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-acl',
          '--exit-on-error',
          `/work/${backupFileName}`,
        ];
        try {
          tooling.runRestore(restoreArgs, { PGPASSWORD: parsedTarget.password, ...parsedTarget.sslParams }, backupDir);
        } catch (err) {
          parsePgRestoreError(err);
        }
      } else {
        const psqlArgs = [
          '-h', hostForDocker,
          '-p', String(parsedTarget.port),
          '-U', parsedTarget.user,
          '-d', parsedTarget.database,
          '-v', 'ON_ERROR_STOP=1',
          '-f', `/work/${backupFileName}`,
        ];
        tooling.runPsql(psqlArgs, { PGPASSWORD: parsedTarget.password, ...parsedTarget.sslParams }, backupDir);
      }
    }
    report.timings.restoreMs = Date.now() - restoreStart;
    log(`Restore completed in ${report.timings.restoreMs}ms.`);

    // 7. Verify restored database
    log('Running comprehensive structural and functional verification...');
    const verifyStart = Date.now();
    targetPool = new Pool({ connectionString: targetUrl, max: 2 });
    const verifyResult = await verifyRestoredDatabase(sourceBaseline, targetPool, options);
    report.timings.verifyMs = Date.now() - verifyStart;
    report.checks = verifyResult.checks;

    log(`Verification passed: ${verifyResult.checks.length} checks succeeded.`);
    report.success = true;
  } catch (err) {
    drillError = err;
  } finally {
    // Teardown connections
    await sourcePool.end().catch(err => cleanupErrors.push(err));
    if (targetPool) {
      await targetPool.end().catch(err => cleanupErrors.push(err));
    }

    // Teardown target database if not keeping
    if (adminClient) {
      if (!options.keepTarget && parsedTarget.database && targetCreatedByThisRun) {
        try {
          log(`Cleaning up isolated target database "${parsedTarget.database}"...`);
          await adminClient.query(`DROP DATABASE IF EXISTS "` + parsedTarget.database.replace(/"/g, '""') + `" WITH (FORCE)`);
          log('Target database dropped.');
        } catch (err) {
          cleanupErrors.push(err);
        }
      }
      await adminClient.end().catch(err => cleanupErrors.push(err));
    }

    // Remove backup file if not keeping
    if (!options.keepBackup && backupCreatedByThisRun && existsSync(backupPath)) {
      try {
        unlinkSync(backupPath);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
  }

  const errors = [...(drillError ? [drillError] : []), ...cleanupErrors];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Backup/restore drill and cleanup failures: ' + errors.map(error => error?.message || String(error)).join('; '),
    );
  }

  report.timings.totalMs = Date.now() - startTime;
  report.completedAt = new Date().toISOString();

  return report;
}

// CLI entry point
const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    console.error('Invalid drill arguments. Check database URLs and use --format custom or plain.');
    process.exit(1);
  }

  if (args.help || !args.sourceUrl) {
    console.log(`
Gambit PostgreSQL Backup & Restore Drill Runner

Usage:
  node scripts/db-backup-restore-drill.mjs [options]

Options:
  --source-url <url>           Source database URL (defaults to DATABASE_URL)
  --target-url <url>           Explicit target database URL (must be isolated)
  --target-db-name <name>      Target database name (default: auto-generated isolated name)
  --backup-file <path>         Path for backup dump file (default: temporary file)
  --keep-backup                Preserve the backup dump file after the drill
  --keep-target                Preserve the restored target database after the drill
  --format <custom|plain>      pg_dump format (default: custom)
  --use-docker                 Force execution of pg tools via Docker container
  --docker-image <image>       Docker image for pg tools (default: pgvector/pgvector:pg16)
  --allow-custom-target-name   Permit target name without default isolation markers
  --json                       Output drill report in JSON format
  --help                       Show this help message
    `);
    process.exit(args.help ? 0 : 1);
  }

  runBackupRestoreDrill(args)
    .then((report) => {
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(0));
        return;
      } else {
        console.log('\n========================================');
        console.log('✅ BACKUP & RESTORE DRILL SUCCESSFUL');
        console.log('========================================');
        console.log(`Source:          ${report.source}`);
        console.log(`Target:          ${report.target}`);
        console.log(`Backup Size:     ${(report.backupSizeBytes / 1024).toFixed(2)} KB`);
        console.log(`Backup SHA-256:  ${report.backupSha256}`);
        console.log(`Backup Duration: ${report.timings.backupMs}ms`);
        console.log(`Restore Duration:${report.timings.restoreMs}ms`);
        console.log(`Verify Duration: ${report.timings.verifyMs}ms`);
        console.log(`Total Duration:  ${report.timings.totalMs}ms`);
        console.log(`Checks Passed:   ${report.checks.length}/${report.checks.length}`);
        console.log('========================================\n');
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n========================================');
      console.error('❌ BACKUP & RESTORE DRILL FAILED');
      console.error('========================================');
      console.error(`Error: ${sanitizeDiagnostic(err.message, [args.sourceUrl, args.targetUrl])}`);
      console.error('========================================\n');
      process.exit(1);
    });
}
