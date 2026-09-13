# Gambit — Database Backup & Restore Drill Runbook

> **Audience:** Operators, SREs, Database Administrators.<br>
> **Frequency:** Monthly scheduled drill, pre-release rehearsal for major schema migrations, disaster recovery validation.<br>
> **Target RTO:** < 15 minutes for 100k games.<br>
> **Target RPO:** 0 data loss for committed transactions (append-only event store).

---

## 1. Objectives & Overview

Gambit's system of record relies on PostgreSQL 16 with the `citext` and `vector` (pgvector) extensions. The primary source of truth is the append-only `game_events` event store, supported by relational projections (`users`, `credentials`, `games`, `ratings`, `tournaments`, `search_embeddings`).

This runbook defines the operational procedure to:
1. Generate a consistent backup of the application database without downtime.
2. Restore the backup into a brand-new, isolated target database.
3. Validate that all durable application data, triggers, indexes, and extensions survived.
4. Ensure safety: destructive actions are strictly guarded against touching the primary or production databases.

---

## 2. Automated Drill Execution

The platform includes an automated, operator-usable drill tool: [`scripts/db-backup-restore-drill.mjs`](../../scripts/db-backup-restore-drill.mjs).

### 2.1 Basic Usage

Run against the default `DATABASE_URL` or an explicit source URL:

```bash
# Run with default environment DATABASE_URL
node scripts/db-backup-restore-drill.mjs

# Run with explicit source URL
node scripts/db-backup-restore-drill.mjs --source-url "postgres://gambit:secret@localhost:5432/gambit"
```

The script will automatically:
1. Connect to the source and record a baseline of tables, row counts, migrations, and sample data.
2. Resolve pg tooling (native `pg_dump`/`pg_restore` if installed, or automatic Docker `pgvector/pgvector:pg16` fallback).
3. Create a custom-format archive (`-Fc`).
4. Validate the backup file size and `PGDMP` header magic.
5. Create a disposable isolated target database (e.g. `gambit_backup_drill_restore_<timestamp>_<random>`).
6. Restore the backup into the isolated database.
7. Perform deep structural and functional verification.
8. Drop the isolated target database and clean up the temporary dump file.
9. Print a structured diagnostic summary.

### 2.2 CLI Options & Flags

| Option | Default | Description |
|---|---|---|
| `--source-url <url>` | `$DATABASE_URL` | Source database URL (defaults to DATABASE_URL) |
| `--target-url <url>` | Auto-generated | Explicit target database URL (must be isolated) |
| `--target-db-name <name>` | Auto-generated | Target database name (default: auto-generated isolated name) |
| `--backup-file <path>` | Temp file | Path for backup dump file (default: temporary file) |
| `--keep-backup` | `false` | Preserve the backup dump file after the drill |
| `--keep-target` | `false` | Preserve the restored target database after the drill |
| `--format <custom\|plain>` | `custom` | pg_dump format (default: custom) |
| `--use-docker` | `auto` | Force execution of pg tools via Docker container |
| `--docker-image <image>` | `pgvector/pgvector:pg16` | Docker image for pg tools (default: pgvector/pgvector:pg16) |
| `--allow-custom-target-name`| `false` | Permit target name without default isolation markers |
| `--json` | `false` | Output drill report in JSON format |
| `--help` | `false` | Show help message |

The backup path must not already exist. The drill reserves a new file exclusively
and removes only the file it created. Target names are limited to 63 ASCII bytes;
generated names retain their isolation marker and unique suffix within that limit.
Connection URL query parameters are restricted to `sslmode`, `sslcert`, `sslkey`,
and `sslrootcert`, so the JavaScript client and PostgreSQL tools use the same
host, port, and credentials.

Both dump formats use the source transaction's exported snapshot. Snapshot export
or row-count failures abort the drill. Every nonzero restore exit is fatal,
including warning-only or localized diagnostics. Cleanup is attempted after a
failure; a failed database drop or backup removal also fails the drill, and combined
restore and cleanup failures are reported together.

### 2.3 Retaining the Target Database for Forensic Inspection

When diagnosing schema discrepancies or inspecting restore behavior, instruct the drill to keep the restored database:

```bash
node scripts/db-backup-restore-drill.mjs \
  --source-url "postgres://gambit:secret@localhost:5432/gambit" \
  --keep-target \
  --keep-backup
```

Output will report the exact target database name created:
```text
Target: postgres://gambit:***@localhost:5432/gambit_backup_drill_restore_1788672281592_96c80ce5
Backup: /tmp/gambit_backup_1788672281593_2706.dump
```

When finished with forensic analysis, drop the database manually:
```sql
DROP DATABASE "gambit_backup_drill_restore_1788672281592_96c80ce5" WITH (FORCE);
```

---

## 3. Manual Operator Walkthrough

If the automated script is unavailable, perform the drill manually using standard PostgreSQL client utilities (`pg_dump`, `pg_restore`, `psql`).

### Step 1: Create Backup

Generate a PostgreSQL custom archive format backup. The custom format includes a table of contents (TOC) for selective restore and parallel processing:

```bash
pg_dump \
  -h "${PGHOST:-localhost}" \
  -p "${PGPORT:-5432}" \
  -U "${PGUSER:-gambit}" \
  -d "${PGDATABASE:-gambit}" \
  -F c \
  -f "/tmp/gambit_manual_drill_$(date +%s).dump"
```

### Step 2: Validate Backup File Integrity

Ensure the dump file is non-empty and starts with the PostgreSQL dump magic bytes (`PGDMP`):

```bash
# Check size
ls -lh /tmp/gambit_manual_drill_*.dump

# Check header magic (should print PGDMP)
head -c 5 /tmp/gambit_manual_drill_*.dump
```

### Step 3: Provision Clean Isolated Target Database

Connect to the PostgreSQL administrative database (`postgres` or `template1`) and create a dedicated drill database:

```bash
TARGET_DB="gambit_backup_drill_restore_$(date +%s)"

psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "${PGUSER:-gambit}" -d postgres -c "
  CREATE DATABASE \"${TARGET_DB}\";
"
```

### Step 4: Restore into Isolated Target

Restore the custom archive into the target database:

```bash
BACKUP_FILE=$(ls -t /tmp/gambit_manual_drill_*.dump | head -n 1)

pg_restore \
  -h "${PGHOST:-localhost}" \
  -p "${PGPORT:-5432}" \
  -U "${PGUSER:-gambit}" \
  -d "${TARGET_DB}" \
  --clean \
  --if-exists \
  "${BACKUP_FILE}"
```

### Step 5: Verification Checklist

Connect to the restored database (`${TARGET_DB}`) and execute the following checks:

#### 1. Extension Verification
Verify that both `citext` and `vector` extensions exist:
```sql
SELECT extname, extversion FROM pg_extension WHERE extname IN ('citext', 'vector');
-- Expected: 2 rows (citext and vector)
```

#### 2. Schema Migrations Ledger
Confirm that the migrations ledger exists in both the source and restored
databases before comparing it:
```sql
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present;
```
Both queries must return `present = true`. If either database is missing the
table, stop the drill and investigate before continuing.

Then run the same query against the source and restored databases:
```sql
SELECT version, name, checksum, state
FROM schema_migrations
ORDER BY version;
```
The two ordered result sets must match exactly, and every row must have
`state = 'applied'`.

#### 3. Append-Only Trigger Verification
Verify that the `game_events` immutability trigger is active by testing an `UPDATE`:
```sql
BEGIN;
UPDATE game_events SET seq = seq WHERE game_id IN (SELECT game_id FROM game_events LIMIT 1);
-- Expected error: "game_events is append-only (UPDATE.game_events attempted)"
ROLLBACK;
```
If the statement succeeds without raising an exception, the trigger is missing or inactive!

#### 4. Durable State Row Counts
Compare row counts between source and restored databases:
```sql
SELECT 'users' AS tbl, count(*) FROM users
UNION ALL
SELECT 'game_events', count(*) FROM game_events
UNION ALL
SELECT 'games', count(*) FROM games
UNION ALL
SELECT 'tournaments', count(*) FROM tournaments
UNION ALL
SELECT 'ratings', count(*) FROM ratings
UNION ALL
SELECT 'search_embeddings', count(*) FROM search_embeddings;
```

#### 5. Vector Query Functionality
Verify pgvector cosine distance operations and HNSW indexing:
```sql
-- Test cosine distance operator (<=>)
SELECT id, embedding <=> embedding AS distance FROM search_embeddings LIMIT 1;
-- Verify HNSW index
SELECT i.relname, am.amname, ix.indisvalid, ix.indisready
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_am am ON i.relam = am.oid
WHERE t.oid = 'public.search_embeddings'::regclass
  AND am.amname = 'hnsw'
  AND ix.indisvalid = true
  AND ix.indisready = true;
```

### Step 6: Cleanup Isolated Target

After verification succeeds, reconnect to the administrative `postgres`
database before dropping the temporary drill database. PostgreSQL cannot drop
the database used by the current session, even with `WITH (FORCE)`:

```bash
psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "${PGUSER:-gambit}" -d postgres -c "
  DROP DATABASE \"${TARGET_DB}\" WITH (FORCE);
"
```

---

## 4. Safety & Isolation Guardrails

1. **Never Overwrite Source:** The drill script explicitly compares the normalized source and target URLs. If the host, port, and database name match, execution aborts immediately.
2. **Protected Databases:** Destructive commands will refuse to drop databases named `gambit`, `postgres`, `template1`, `production`, `master`, or `main`.
3. **Naming Convention:** Target databases must contain an isolation indicator (`drill`, `restore`, `disposable`, `test`, or `isolated`) unless the `--allow-custom-target-name` flag is explicitly provided.
4. **Credential Security:** Database URLs and known connection passwords are masked in diagnostics. PostgreSQL tool subprocesses receive passwords through `PGPASSWORD`. Prefer setting `DATABASE_URL` when invoking the drill; a URL supplied through `--source-url` or `--target-url` is still visible in the drill process's arguments.

The structural checks require the append-only trigger on `public.game_events`
and a valid, ready HNSW index on `public.search_embeddings`; identically named
objects on another relation do not satisfy verification. The tests in
`scripts/test/backup-restore-safety.test.mjs` exercise orchestration and failure
paths without contacting a database. The separate live integration test remains
opt-in through `DATABASE_URL`; use a disposable, migrated database for that test.

---

## 5. Troubleshooting Failed Restores

| Symptom | Probable Cause | Corrective Action |
|---|---|---|
| `extension "vector" is not available` | Target PostgreSQL instance lacks `pgvector` library | Install `postgresql-16-pgvector` package or use `pgvector/pgvector:pg16` image. |
| `Trigger on game_events failed: mutation was not blocked` | Restore command stripped or disabled triggers | Ensure `pg_restore` did not run with `--disable-triggers` without re-enabling them. |
| `Row count mismatch for table "X"` | Partial dump or table-level exclusion | Ensure `pg_dump` was run for the whole database without `--schema-only` or `--exclude-table`. |
| `Migration checksum mismatch` | Working copy newline translation or modified migration | Run `npm run check:ci-parity` and ensure canonical LF newlines in migration files. |
| `Backup file does not exist or empty` | Permissions or disk space exhaustion | Check disk space in `/tmp` and file write permissions for PostgreSQL process. |
