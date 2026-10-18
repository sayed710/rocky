/**
 * @packageDocumentation
 * Forward-only SQL migration runner. Applies `NNNN_*.sql` files in order and
 * records them in `schema_migrations` with a checksum so history is immutable (a
 * changed, already-applied file is a hard error). Migrations are transactional by
 * default; a narrowly validated directive supports online index creation.
 *
 * Migration files are read through a single canonical representation — UTF-8
 * text with LF newlines, matching the committed Git blob. The repository has no
 * `.gitattributes`, so the bytes on disk depend on each machine's
 * `core.autocrlf`: one commit checks out with LF on Linux and CRLF on Windows.
 * Hashing or executing those bytes directly would make both the ledger checksum
 * and the SQL sent to PostgreSQL a property of the checkout rather than of the
 * migration, so canonicalization happens once, at read time.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { MigrationError } from '../errors';

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  state: 'pending' | 'applied';
}

export type ParsedMigration =
  | { kind: 'transactional'; sql: string }
  | { kind: 'online-index'; indexName: string; sql: string };

interface RelationRow {
  relkind: string;
  indisvalid: boolean | null;
}

interface OnlineIndexApplication {
  version: number;
  file: string;
  checksum: string;
  migration: Extract<ParsedMigration, { kind: 'online-index' }>;
  existing?: AppliedRow;
}

/** Advisory-lock key that namespaces the migration runner (arbitrary constant). */
const MIGRATION_ADVISORY_LOCK_KEY = 4915219603172;

/**
 * The fencing foundation (0050) and its helper hardening (0051), applied as one
 * transaction when both are pending.
 *
 * 0050 installs the `game_fencing` helpers as SECURITY DEFINER; 0051 immediately
 * re-declares the four internal helpers SECURITY INVOKER. Applied as two separate
 * commits — which is what the per-migration loop below does for every other
 * migration — the committed-0050 / pre-0051 state is visible to any other
 * connection, and in that state a role holding EXECUTE on
 * `game_fencing.insert_batch` plus schema USAGE (but no `game_events` INSERT and
 * no owner membership) can call the DEFINER helper directly and persist events it
 * has no privilege to write. That window was demonstrated against the unmodified
 * runner in disposable PostgreSQL 16.14 (task RZ-PR114-PG-ISOLATED-20261018-04).
 *
 * Coalescing these two — and only these two, matched by version AND filename — so
 * their SQL and both ledger rows commit together means no other connection ever
 * observes the intermediate state: either both are visible or neither is. This is
 * narrow by construction (not a general cross-migration batch) and leaves every
 * other migration, the online-index path, checksum immutability and transaction
 * cleanup exactly as they were. It changes no migration bytes and writes each
 * migration's own canonical checksum to the ledger, so a later run validates
 * history identically.
 *
 * It does not and cannot close the window on a database that already committed
 * 0050 under an earlier runner: that exposure is historical and is addressed by
 * the operational upgrade path (isolate untrusted writers, then apply 0051 with
 * trusted installer credentials), not retroactively by this runner. When 0050 is
 * already applied, 0051 falls through to the ordinary per-migration path, where
 * its unconditional `ALTER FUNCTION ... SECURITY INVOKER` fails closed for a
 * caller that does not own the (possibly ownership-transferred) helpers.
 *
 * Applying 0050 without a pending 0051 is refused outright (see
 * {@link planAtomicFencing}); the production runner never installs the DEFINER
 * helpers alone. An already-0050 database is reproduced in tests by executing the
 * real 0050 SQL and a truthful ledger row, not by that refused path.
 */
const FENCING_FOUNDATION_VERSION = 50;
const FENCING_HARDENING_VERSION = 51;
const ATOMIC_FENCING_PAIR: readonly { readonly version: number; readonly file: string }[] = [
  { version: FENCING_FOUNDATION_VERSION, file: '0050_inactive_game_fencing.sql' },
  { version: FENCING_HARDENING_VERSION, file: '0051_non_escalating_fencing_helpers.sql' },
];

interface AtomicGroupMember {
  readonly version: number;
  readonly file: string;
  readonly checksum: string;
  readonly sql: string;
}

/**
 * Reduce a migration to its canonical form: the committed LF text.
 *
 * Only the CRLF pair is rewritten, because that is the only difference a Git
 * checkout can introduce. Every other byte — indentation, blank lines, a lone
 * CR, a missing trailing newline — is migration content and stays untouched, so
 * canonicalization cannot mask an edit to an applied migration.
 *
 * This exactly inverts Git's LF-to-CRLF checkout conversion over the inputs a
 * checkout can produce. Git does not double-convert — a blob that already holds
 * CRLF is checked out unchanged rather than as `\r\r\n` — so one pass is enough.
 */
/**
 * The migrations this package ships, ordered, with the version each filename declares.
 *
 * The `NNNN_` prefix is the only thing that orders a migration and the only thing that identifies
 * it in the ledger, so it is parsed in exactly one place. {@link runMigrations} and
 * {@link missingMigrations} both read the directory, and a second copy of this rule is how the
 * runner and the readiness check would come to disagree about what "migration 4" means.
 */
export function migrationFiles(dir: string): readonly { readonly file: string; readonly version: number }[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = /^(\d+)_/.exec(file);
      if (!match) throw new MigrationError(`invalid migration filename: ${file}`);
      return { file, version: parseInt(match[1]!, 10) };
    });

  // The version is the migration's identity — it is the ledger's primary key and the only thing
  // {@link missingMigrations} compares. Two files claiming the same number would make one ledger row
  // answer for both, so a migration that never ran would read as applied and readiness would say the
  // schema is complete. The runner reaches the same conclusion by a stranger route, reporting the
  // second file as a checksum violation of the first, which describes the symptom rather than the
  // mistake. Raised by CodeRabbit on this PR.
  const seen = new Map<number, string>();
  for (const { file, version } of files) {
    const first = seen.get(version);
    if (first !== undefined) {
      throw new MigrationError(
        `duplicate migration version ${version}: ${first} and ${file} cannot both be migration ${version}`,
      );
    }
    seen.set(version, file);
  }
  return files;
}

let resolvedMigrationsDir: string | undefined;

/**
 * The `migrations/` directory shipped alongside this package.
 *
 * Found by walking up from this module rather than from `process.cwd()`, because the callers do not
 * agree on a working directory: the API image runs `node packages/api/dist/scripts/serve.js` from
 * `/app`, `npm run migrate` runs from `packages/persistence`, and the test build sits one level
 * deeper again under `dist-test/`. Anchoring on the compiled file's own location is the one thing
 * true in all three.
 *
 * **A function, and not a module-level constant.** Resolving this at import time would throw inside
 * the `pg` barrel, and the barrel is imported by things that never migrate anything: the gateway
 * loads it for `createPool` and `PostgresEventStore`, and its image copies this package's `dist`
 * without its `migrations`. A constant would therefore have turned a missing directory the gateway
 * has no use for into a crash before its server ever started. Resolution is memoized on success
 * only, so the repeated calls a readiness probe makes cost one `existsSync` walk in total, while a
 * failure stays a failure rather than being cached as one.
 *
 * Raised by Qodo on this PR.
 *
 * `from` exists so the walk can be exercised against a tree that has no migrations, and only the
 * default resolution is memoized — a cache that answered for an explicitly supplied root would make
 * the argument a lie, and did, until this test caught it.
 */
export function migrationsDir(from?: string): string {
  if (from === undefined && resolvedMigrationsDir !== undefined) return resolvedMigrationsDir;
  let dir = from ?? __dirname;
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '0001_init.sql'))) {
      if (from === undefined) resolvedMigrationsDir = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MigrationError('cannot locate the migrations directory shipped with this package');
}

/**
 * Which shipped migrations the database has no record of.
 *
 * This is the question a readiness probe needs answered and `SELECT 1` cannot answer: the server can
 * be reachable, authenticated and completely empty. A database missing migration 4 has no
 * `rate_limit_buckets`, so every rate-limited route — sign-in first among them — fails with
 * `undefined_table` the moment it is asked for.
 *
 * **Presence, not state, and not checksums.** A row in `pending` counts as present: that state
 * belongs to an online index whose table already exists and whose `CREATE INDEX CONCURRENTLY` may
 * legitimately run for an hour, and refusing traffic for that hour would defeat the point of
 * building it concurrently. Checksums are deliberately not compared either — {@link migrate} already
 * owns immutability, and it rewrites legacy checksums in place, so a probe that compared them would
 * refuse a database that is correct but has not been re-migrated since that fix.
 *
 * A missing `schema_migrations` table means nothing has been applied, which is reported as every
 * version missing rather than as an error, because "not migrated" is exactly what it is.
 */
export async function missingMigrations(
  pool: Pool,
  dir: string = migrationsDir(),
): Promise<readonly number[]> {
  const shipped = migrationFiles(dir).map((m) => m.version);
  const ledger = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (ledger.rows[0]?.present !== true) return shipped;

  const applied = await pool.query<{ version: number }>('SELECT version FROM schema_migrations');
  const recorded = new Set(applied.rows.map((row) => row.version));
  return shipped.filter((version) => !recorded.has(version));
}

export function canonicalizeMigrationSql(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Read a migration file in its canonical form.
 *
 * Decoding is verified to round-trip. Node's UTF-8 decoder silently replaces a
 * malformed byte with U+FFFD, so `0xFF` and the valid encoding of U+FFFD would
 * otherwise reduce to the same text and the same checksum — letting one stand in
 * for the other in an applied migration. Only CRLF may be normalized away.
 */
export function readMigrationSql(dir: string, file: string): string {
  const bytes = readFileSync(join(dir, file));
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new MigrationError(`migration ${file} is not valid UTF-8`);
  }
  return canonicalizeMigrationSql(text);
}

/**
 * Hex SHA-256 of `text`, encoded as UTF-8.
 *
 * The encoding is named rather than left to the default so a ledger checksum
 * depends only on the characters hashed — the whole point of canonicalizing the
 * migration first. Callers pass canonical text, or the CRLF rendering of it when
 * checking a checksum an older runner wrote.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Ledger checksum of a migration, derived from its canonical form. */
export function migrationChecksum(canonicalSql: string): string {
  return sha256(canonicalSql);
}

/**
 * True when a stored checksum was written by the pre-canonicalization runner,
 * which hashed the checked-out bytes and so recorded the CRLF rendering on
 * Windows. The content is proven identical apart from newline encoding, so this
 * is the same migration under the old scheme rather than a history violation.
 * A real content edit matches neither rendering and still fails.
 */
function isLegacyCrlfChecksum(stored: string, canonicalSql: string): boolean {
  return stored === sha256(canonicalSql.replace(/\n/g, '\r\n'));
}

/**
 * Parse the optional online-index directive and reject any broader escape from
 * transactional migration execution.
 */
export function parseMigration(sql: string): ParsedMigration {
  if (!/^\s*--\s*migrate:online-index\b/i.test(sql)) {
    return { kind: 'transactional', sql };
  }
  return parseOnlineIndex(sql);
}

function parseOnlineIndex(sql: string): ParsedMigration {
  const directive = /^\s*--\s*migrate:online-index\s+([a-z_][a-z0-9_]*)\s*\r?\n([\s\S]*)$/i.exec(
    sql,
  );
  if (!directive) {
    throw new MigrationError('invalid migrate:online-index directive');
  }

  const indexName = directive[1]!.toLowerCase();
  const statement = directive[2]!.trim();
  const statementIndexName = concurrentIndexName(statement);
  if (statementIndexName !== indexName) {
    throw new MigrationError(`online-index statement must match declared index ${indexName}`);
  }
  return { kind: 'online-index', indexName, sql: statement };
}

function concurrentIndexName(statement: string): string {
  const create = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+([a-z_][a-z0-9_]*)\b[\s\S]*;$/i.exec(
    statement,
  );
  if (!create || (statement.match(/;/g) ?? []).length !== 1) {
    throw new MigrationError(
      'an online-index migration must contain exactly one CREATE INDEX CONCURRENTLY statement',
    );
  }
  return create[1]!.toLowerCase();
}

/**
 * Apply all pending migrations in `dir`. Returns the number newly applied.
 *
 * The whole run holds a database-wide advisory lock (on a dedicated connection)
 * so parallel callers — concurrent test files, or multiple app instances booting
 * at once — serialize instead of racing to apply the same migration.
 */
export async function migrate(pool: Pool, dir: string): Promise<number> {
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    return await runMigrations(pool, dir);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    lockClient.release();
  }
}

/**
 * Decide how the fencing pair is applied this run, failing closed on any shape
 * that cannot be applied safely rather than silently degrading.
 *
 * Returns the two members to apply in one transaction when both 0050 and 0051
 * are pending and consistent; returns `null` when there is nothing fencing-
 * specific to do (neither pending — already applied, or absent from this tree —
 * so the ordinary loop handles them, including the legitimate "0050 already
 * applied, 0051 pending" trusted-installer upgrade). It THROWS, before any 0050
 * SQL executes, when:
 *
 *  - 0051 is recorded as applied but 0050 is not — an impossible history;
 *  - 0051 is pending with no 0050 to build on (neither applied nor pending);
 *  - 0050 is pending without a pending 0051 — installing the SECURITY DEFINER
 *    helpers without the hardening that closes the escalation window is refused
 *    in the production runner (a historical already-0050 database is reproduced
 *    in tests by executing the real 0050 SQL and its truthful ledger row, never
 *    by applying 0050 alone through this runner);
 *  - either member is present under an unexpected filename or is not a plain
 *    transactional migration — a malformed pair must not lose atomicity.
 */
function planAtomicFencing(
  dir: string,
  files: readonly { readonly file: string; readonly version: number }[],
  applied: ReadonlyMap<number, AppliedRow>,
): readonly AtomicGroupMember[] | null {
  const present = new Map(ATOMIC_FENCING_PAIR.map(({ version }) => [version, files.find((f) => f.version === version)]));
  const applied50 = applied.has(FENCING_FOUNDATION_VERSION);
  const applied51 = applied.has(FENCING_HARDENING_VERSION);
  const pending50 = present.get(FENCING_FOUNDATION_VERSION) !== undefined && !applied50;
  const pending51 = present.get(FENCING_HARDENING_VERSION) !== undefined && !applied51;

  if (applied51 && !applied50) {
    throw new MigrationError(
      `inconsistent fencing history: migration ${FENCING_HARDENING_VERSION} is recorded as applied but ${FENCING_FOUNDATION_VERSION} is not`,
    );
  }
  if (pending51 && !applied50 && !pending50) {
    throw new MigrationError(
      `migration ${FENCING_HARDENING_VERSION} (fencing helper hardening) cannot be applied without migration ${FENCING_FOUNDATION_VERSION}`,
    );
  }
  // A recorded online-index-style pending row is not an installed foundation.
  for (const { version } of ATOMIC_FENCING_PAIR) {
    const row = applied.get(version);
    if (row && row.state !== 'applied') throw new MigrationError(`fencing migration ${version} has an invalid pending ledger state`);
  }
  if (applied50 && !applied51 && !pending51) {
    throw new MigrationError('already applied migration 50 is missing migration 51 hardening file; refusing an incomplete migration tree');
  }
  // Validate a pending hardening-only upgrade too; never route an unexpected
  // version-51 filename/directive through the ordinary migration path.
  if (!pending50) {
    if (pending51) {
      const hardening = ATOMIC_FENCING_PAIR[1]!;
      const found = present.get(hardening.version)!;
      if (found.file !== hardening.file) throw new MigrationError(`fencing migration 51 must be named ${hardening.file}`);
      if (parseMigration(readMigrationSql(dir, found.file)).kind !== 'transactional')
        throw new MigrationError(`fencing migration ${found.file} must be a plain transactional migration`);
    }
    return null;
  }
  if (!pending51) {
    throw new MigrationError(
      `migration ${FENCING_FOUNDATION_VERSION} (inactive fencing foundation) must be applied together with migration ` +
        `${FENCING_HARDENING_VERSION}: installing the SECURITY DEFINER helpers without the hardening that closes the ` +
        `escalation window is refused`,
    );
  }

  const members: AtomicGroupMember[] = [];
  for (const { version, file } of ATOMIC_FENCING_PAIR) {
    const found = present.get(version);
    if (!found || found.file !== file) {
      throw new MigrationError(
        `fencing migration ${version} must be named ${file} to be applied atomically; refusing an unexpected filename`,
      );
    }
    const sql = readMigrationSql(dir, file);
    if (parseMigration(sql).kind !== 'transactional') {
      throw new MigrationError(
        `fencing migration ${file} must be a plain transactional migration to be grouped atomically`,
      );
    }
    members.push({ version, file, checksum: migrationChecksum(sql), sql });
  }
  return members;
}

/**
 * Apply the fencing pair in a single transaction: each member's SQL and its
 * ledger row, then one COMMIT. Any failure rolls back both migrations and both
 * ledger rows, leaving neither committed — mirroring the single-migration block
 * in {@link runMigrations}, extended across the pair.
 */
async function applyAtomicFencingPair(
  pool: Pool,
  pair: readonly AtomicGroupMember[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const member of pair) {
      await client.query(member.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, state)
           VALUES ($1, $2, $3, 'applied')`,
        [member.version, member.file, member.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw new MigrationError(
      `atomic migration group ${pair.map((m) => m.file).join(' + ')} failed: ${(err as Error).message}`,
    );
  } finally {
    client.release();
  }
}

/**
 * The walk itself: ensure the ledger exists, then apply every file the database has no record of.
 *
 * Separated from {@link migrate} because the advisory lock is that function's whole job — this one
 * assumes it is already held and may therefore read `schema_migrations`, decide what is outstanding,
 * and write to it without racing another booting instance. The ledger is created here rather than in
 * a migration because it is the thing that records migrations, and the `ADD COLUMN IF NOT EXISTS`
 * below is how a ledger written before online indexes existed acquires the `state` column.
 */
async function runMigrations(pool: Pool, dir: string): Promise<number> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       checksum   TEXT NOT NULL,
       state      TEXT NOT NULL DEFAULT 'applied',
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    `ALTER TABLE schema_migrations
       ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'applied'`,
  );

  const files = migrationFiles(dir);

  const applied = await pool.query<AppliedRow>(
    'SELECT version, name, checksum, state FROM schema_migrations',
  );
  const byVersion = new Map<number, AppliedRow>(applied.rows.map((r) => [r.version, r]));

  // Decide the fencing pair up front: this fails closed on an inconsistent or
  // unsafe shape (see planAtomicFencing) before any 0050 SQL executes, and the
  // impossible-history check fires even when 0050 itself is not iterated.
  const fencingPair = planAtomicFencing(dir, files, byVersion);

  let count = 0;
  const coalescedVersions = new Set<number>();
  for (const { file, version } of files) {
    if (coalescedVersions.has(version)) continue;

    // Close the fencing escalation window: when 0050 and 0051 are both pending,
    // apply them atomically so the committed-0050/pre-0051 state is never visible
    // to another connection. Every other case (0050 already applied with 0051
    // pending — the trusted-installer upgrade — and any unrelated migration) uses
    // the normal per-migration path; unsafe shapes already threw above.
    if (version === FENCING_FOUNDATION_VERSION && fencingPair) {
      await applyAtomicFencingPair(pool, fencingPair);
      count += fencingPair.length;
      for (const member of fencingPair) coalescedVersions.add(member.version);
      continue;
    }

    const sql = readMigrationSql(dir, file);
    const checksum = migrationChecksum(sql);
    const migration = parseMigration(sql);

    const existing = byVersion.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        if (!isLegacyCrlfChecksum(existing.checksum, sql)) {
          throw new MigrationError(
            `migration ${file} (version ${version}) changed after being applied; history is immutable`,
          );
        }
        await adoptCanonicalChecksum(pool, version, checksum);
      }
      if (existing.state === 'applied') continue;
      if (migration.kind !== 'online-index') {
        throw new MigrationError(`migration ${file} has an unsupported pending state`);
      }
    }

    if (migration.kind === 'online-index') {
      try {
        await applyOnlineIndex(pool, { version, file, checksum, migration, existing });
        count += 1;
      } catch (err) {
        throw new MigrationError(`migration ${file} failed: ${(err as Error).message}`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, state)
           VALUES ($1, $2, $3, 'applied')`,
        [version, file, checksum],
      );
      await client.query('COMMIT');
      count += 1;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw new MigrationError(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return count;
}

/**
 * Rewrite a legacy CRLF checksum to the canonical one, so a ledger written by a
 * Windows checkout converges instead of re-deriving the legacy form on every
 * run. Runs under the migration advisory lock and touches only the checksum.
 */
async function adoptCanonicalChecksum(
  pool: Pool,
  version: number,
  checksum: string,
): Promise<void> {
  await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
    version,
    checksum,
  ]);
}

async function applyOnlineIndex(
  pool: Pool,
  application: OnlineIndexApplication,
): Promise<void> {
  const client = await pool.connect();
  try {
    const relation = await findRelation(client, application.migration.indexName);
    await reserveOnlineIndex(client, application, relation);
    await ensureValidOnlineIndex(client, application.migration, relation);
    await completeOnlineIndex(client, application.version);
  } finally {
    client.release();
  }
}

async function reserveOnlineIndex(
  client: PoolClient,
  application: OnlineIndexApplication,
  relation: RelationRow | undefined,
): Promise<void> {
  if (application.existing) return;
  if (relation) throw new Error(`relation ${application.migration.indexName} already exists`);
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, state)
       VALUES ($1, $2, $3, 'pending')`,
    [application.version, application.file, application.checksum],
  );
}

async function ensureValidOnlineIndex(
  client: PoolClient,
  migration: Extract<ParsedMigration, { kind: 'online-index' }>,
  relation: RelationRow | undefined,
): Promise<void> {
  if (relation && relation.relkind !== 'i') {
    throw new Error(`relation ${migration.indexName} exists but is not an index`);
  }
  if (relation && relation.indisvalid !== true) {
    await client.query(`DROP INDEX CONCURRENTLY "${migration.indexName}"`);
  }
  if (!relation || relation.indisvalid !== true) await client.query(migration.sql);

  const created = await findRelation(client, migration.indexName);
  if (!created || created.relkind !== 'i' || created.indisvalid !== true) {
    throw new Error(`online index ${migration.indexName} was not created as a valid index`);
  }
}

async function completeOnlineIndex(client: PoolClient, version: number): Promise<void> {
  const completion = await client.query(
    `UPDATE schema_migrations
        SET state = 'applied', applied_at = now()
      WHERE version = $1 AND state = 'pending'`,
    [version],
  );
  if (completion.rowCount !== 1) throw new Error(`pending migration ${version} was not completed`);
}

async function findRelation(
  client: PoolClient,
  name: string,
): Promise<RelationRow | undefined> {
  const result = await client.query<RelationRow>(
    `SELECT c.relkind, i.indisvalid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = current_schema()
        AND c.relname = $1`,
    [name],
  );
  return result.rows[0];
}
