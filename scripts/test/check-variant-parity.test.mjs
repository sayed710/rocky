/**
 * Tests for the variant parity guard.
 *
 * A guard is only worth its green tick while it still catches what it claims to. These drive the
 * guard's own parsing against synthetic sources and a synthetic migration directory, so the cases
 * that matter — a commented-out entry, a forward migration, a constraint replaced rather than
 * edited — are pinned without touching the real tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from 'node:crypto';
import {
  stripComments,
  splitStatements,
  tokenizeSql,
  splitSqlStatements,
  parseQualifiedTableTarget,
  readDollarQuoteDelimiter,
  replayStudiesSchema,
  extractRegion,
  migrationFiles,
  effectiveLookupVariants,
  effectiveStudyVariantConstraint,
  effectiveStudyVariantForeignKey,
  collectMirrors,
  evaluateParity,
  tableKey,
  STUDIES_TABLE_KEY,
  VARIANTS_TABLE_KEY,
  KNOWN_HISTORICAL_PROCEDURAL_MIGRATIONS,
  disagreements,
  ROOT,
  TS_MIRRORS,
  MIGRATIONS_DIR,
} from '../check-variant-parity.mjs';

/** A throwaway migration directory. Files are named so the runner's ordering applies. */
function migrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'variant-parity-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, 'utf8');
  return dir;
}

test('a commented-out variant does not count as present', () => {
  // The defect this replaced: quoted tokens were matched in raw source, so commenting an entry out
  // left the guard green while the executable array no longer held it. Raised in the Qodo review of
  // PR #141.
  /** Extracts variants from a synthetic TypeScript declaration body. */
  const region = (body) =>
    extractRegion({
      label: 'test',
      file: 'test.ts',
      open: /export const VARIANTS: readonly Variant\[\] = \[/,
      close: /\]/,
      text: `export const VARIANTS: readonly Variant[] = [\n${body}\n];`,
    }).variants;

  assert.deepEqual(region("  'standard',\n  'atomic',"), ['standard', 'atomic']);
  assert.deepEqual(region("  'standard',\n  // 'atomic',"), ['standard'], 'line comment');
  assert.deepEqual(region("  'standard',\n  /* 'atomic', */"), ['standard'], 'block comment');
  assert.deepEqual(
    region("  'standard',\n  'atomic', // keep this one"),
    ['standard', 'atomic'],
    'a trailing comment does not remove the entry beside it',
  );
});

test('a comment marker inside a string literal is not a comment', () => {
  assert.equal(stripComments(`const a = 'http://x'; // gone`, 'ts').trim(), `const a = 'http://x';`);
  assert.equal(stripComments(`SELECT '--x'; -- gone`, 'sql').trim(), `SELECT '--x';`);
});

test('the lookup table is the sum of every migration, not the contents of 0001', () => {
  // Applied migrations are checksummed and immutable (`pg/migrate.ts`), so a ninth variant arrives
  // in a NEW file. A guard that read 0001 directly would fail forever on the correct change and
  // could only be satisfied by editing an applied migration. Raised in the Qodo review of PR #141.
  const dir = migrations({
    '0001_init.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO variants (code, name) VALUES
  ('standard', 'Standard'),
  ('atomic',   'Atomic');`,
    '0023_add_antichess.sql': `INSERT INTO variants (code, name) VALUES ('antichess', 'Antichess');`,
  });
  try {
    assert.deepEqual(effectiveLookupVariants(dir), ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an idempotent canonical re-seed preserves lookup set semantics', () => {
  const dir = migrations({
    '0001_init.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO variants (code, name) VALUES
  ('standard', 'Standard'),
  ('atomic',   'Atomic');`,
    '0028_reseed.sql': `INSERT INTO variants (code, name) VALUES
  ('standard', 'Standard'),
  ('atomic',   'Atomic')
ON CONFLICT (code) DO NOTHING;`,
  });
  try {
    assert.deepEqual(effectiveLookupVariants(dir), ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations replay in the order the runner applies them, which is lexicographic', () => {
  // `pg/migrate.ts` sorts with a plain `.sort()`, so that is the order the database ends up in and
  // the order this must model. Zero-padded names make lexicographic and numeric order coincide, so
  // the filenames here are deliberately *not* padded: `10_` sorts before `9_`, and a guard that
  // sorted numerically instead would replay a database that never existed. The earlier version of
  // this test used `0009_`/`0010_`, which sort the same either way and so proved nothing about the
  // ordering it claimed to pin. Raised in the CodeRabbit review of PR #141.
  const dir = migrations({
    '9_late.sql': `INSERT INTO variants (code, name) VALUES ('nine', 'Nine');`,
    '10_early.sql': `INSERT INTO variants (code, name) VALUES ('ten', 'Ten');`,
  });
  try {
    assert.deepEqual(migrationFiles(dir), ['10_early.sql', '9_late.sql'], 'the runner order');
    assert.deepEqual(effectiveLookupVariants(dir), ['ten', 'nine']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The guard replays migrations in exactly the order the runner does.
 *
 * Pinned against the runner's own source rather than restated, so the two cannot drift apart
 * silently: a change to `migrate.ts`'s sort has to be made here too, or this fails. The whole guard
 * is worthless if it reads the migrations in a different order from the code it is guarding, and
 * nothing else would notice.
 *
 * The expression lives in `migrationFiles` now, which the runner and the readiness probe share, so
 * the chained `.map` that attaches each file's version is allowed after it. What is still pinned is
 * the property that matters: `.sort()` with no comparator, ordering by filename exactly as this
 * guard does.
 */
test('the guard replays migrations in exactly the order the runner does', () => {
  const runner = readFileSync('packages/persistence/src/pg/migrate.ts', 'utf8');
  assert.match(
    runner,
    /readdirSync\(dir\)\s*\.filter\(\(f\) => f\.endsWith\('\.sql'\)\)\s*\.sort\(\)\s*(?:;|\.map\()/,
    'migrate.ts still sorts migration files with a plain lexicographic .sort()',
  );
});

test('only statements that target `studies` decide its constraint', () => {
  // The file was previously tested as a whole, so any other table in it could move the answer — a
  // `variant` CHECK elsewhere would overwrite the studies one, and a `REFERENCES variants(code)`
  // elsewhere would clear it, silently dropping the mirror. Raised in the CodeRabbit review of
  // PR #141.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_other_table.sql': `CREATE TABLE puzzle_sets (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL REFERENCES variants(code)
);
ALTER TABLE studies ADD COLUMN tag TEXT;
CREATE TABLE bot_profiles (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL CHECK (variant IN ('standard'))
);`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.notEqual(found, null, 'the studies constraint must survive an unrelated table');
    assert.equal(found.file, '0022_study_variant.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a semicolon inside a string literal does not split a statement', () => {
  assert.deepEqual(
    splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`).map((s) => s.trim()),
    [`INSERT INTO t VALUES ('a;b')`, `SELECT 1`],
  );
});

test('a statement the guard cannot model fails loudly rather than reporting a stale schema', () => {
  const dir = migrations({
    '0001_init.sql': `INSERT INTO variants (code, name) VALUES ('standard', 'Standard');`,
    '0024_retire.sql': `DELETE FROM variants WHERE code = 'standard';`,
  });
  try {
    assert.throws(() => effectiveLookupVariants(dir), /does not model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the study constraint is the last one defined, so it can be replaced not edited', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_add_antichess.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_check
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.equal(found.file, '0023_add_antichess.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`ALTER TABLE IF EXISTS studies` is recognised, not skipped', () => {
  // Valid PostgreSQL, and a migration is exactly where the defensive form gets written. Skipping it
  // left the guard comparing against the constraint that statement had just replaced. Raised in the
  // CodeRabbit review of PR #141.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_defensive.sql': `ALTER TABLE IF EXISTS studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE IF EXISTS ONLY studies ADD CONSTRAINT studies_variant_check
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.equal(found.file, '0023_defensive.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a constraint is dropped by its exact name, whatever that name is', () => {
  // `DROP CONSTRAINT allowed_codes` is a perfectly ordinary way to remove a CHECK on
  // `studies.variant`. Matching names that merely contain "variant" missed it and left the guard
  // comparing against a constraint the schema no longer has. Raised in the CodeRabbit review of
  // PR #141.
  const named = `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CONSTRAINT allowed_codes CHECK (variant IN ('standard', 'atomic'));`;

  // Dropped and not replaced, so nothing downstream can paper over a missed clear: if the drop is
  // not recognised the constraint is still reported as live.
  const droppedOnly = migrations({
    '0022_study_variant.sql': named,
    '0023_drop.sql': `ALTER TABLE studies DROP CONSTRAINT allowed_codes;`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(droppedOnly), null);
  } finally {
    rmSync(droppedOnly, { recursive: true, force: true });
  }

  const replaced = migrations({
    '0022_study_variant.sql': named,
    '0023_drop.sql': `ALTER TABLE studies DROP CONSTRAINT allowed_codes;
ALTER TABLE studies ADD CONSTRAINT variant_codes
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(replaced);
    assert.equal(found.name, 'variant_codes');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(replaced, { recursive: true, force: true });
  }
});

test('dropping an unrelated constraint does not clear the tracked one', () => {
  // The other half of exact-name matching: a constraint whose name happens to contain "variant"
  // must not be mistaken for the one governing the column.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_unrelated.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_label_length;`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.notEqual(found, null, 'the governing constraint must survive an unrelated drop');
    assert.deepEqual(found.variants, ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unnamed CHECK is tracked under the name PostgreSQL gives it', () => {
  // Written without a name, the server calls it `studies_variant_check` — so that is the name a
  // later migration has to drop, and the name the guard has to be tracking.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir).name, 'studies_variant_check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renaming the governing constraint fails loudly rather than tracking a dead name', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_rename.sql': `ALTER TABLE studies
  RENAME CONSTRAINT studies_variant_check TO allowed_codes;`,
  });
  try {
    assert.throws(() => effectiveStudyVariantConstraint(dir), /RENAME CONSTRAINT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('converting the study column to a foreign key leaves no list to compare', () => {
  // The conversion recorded as a candidate in PROJECT_STATE. Once `studies.variant` derives from
  // `variants(code)` there is no second list, and the guard must not go on demanding one.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_study_variant_fk.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed migrations directory leaves studies.variant derived from foreign key with no CHECK', () => {
  assert.equal(effectiveStudyVariantConstraint(MIGRATIONS_DIR), null);
  assert.equal(effectiveStudyVariantForeignKey(MIGRATIONS_DIR), true);
});

test('dropping the CHECK without adding a foreign key leaves effectiveStudyVariantForeignKey false', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_drop_only.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir), null);
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks named foreign keys through drop and rename', () => {
  const dir = migrations({
    '0001_fk.sql': `ALTER TABLE studies ADD CONSTRAINT custom_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_rename.sql': `ALTER TABLE studies RENAME CONSTRAINT custom_fk TO renamed_fk;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping under the old name does nothing because it was renamed
    writeFileSync(join(dir, '0003_drop_old.sql'), `ALTER TABLE studies DROP CONSTRAINT custom_fk;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping under the new name clears active FK
    writeFileSync(join(dir, '0004_drop_new.sql'), `ALTER TABLE studies DROP CONSTRAINT renamed_fk;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks multiple foreign keys independently when one is dropped', () => {
  const dir = migrations({
    '0001_fk1.sql': `ALTER TABLE studies ADD CONSTRAINT fk_one FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_fk2.sql': `ALTER TABLE studies ADD CONSTRAINT fk_two FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping fk_one leaves fk_two active
    writeFileSync(join(dir, '0003_drop_one.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_one;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping fk_two clears all
    writeFileSync(join(dir, '0004_drop_two.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_two;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks multiple foreign keys added in a single comma-separated statement', () => {
  const dir = migrations({
    '0001_multi_add.sql': `ALTER TABLE studies
      ADD CONSTRAINT fk_alpha FOREIGN KEY (variant) REFERENCES variants(code),
      ADD CONSTRAINT fk_beta FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(join(dir, '0002_drop_alpha.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_alpha;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(join(dir, '0003_drop_beta.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_beta;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey clears active foreign keys when variant column is renamed (with or without COLUMN keyword)', () => {
  const dirWithColumn = migrations({
    '0001_inline.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_col.sql': `ALTER TABLE studies RENAME COLUMN variant TO old_variant;`,
    '0003_readd_unconstrained.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dirWithColumn), false);
  } finally {
    rmSync(dirWithColumn, { recursive: true, force: true });
  }

  const dirShorthand = migrations({
    '0001_inline.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_shorthand.sql': `ALTER TABLE studies RENAME variant TO old_variant;`,
    '0003_readd_unconstrained.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dirShorthand), false);
  } finally {
    rmSync(dirShorthand, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey recognizes double-quoted identifiers in table-level and inline foreign keys', () => {
  const dirTable = migrations({
    '0001_table_quoted.sql': `ALTER TABLE "studies" ADD CONSTRAINT "fk_quoted" FOREIGN KEY ("variant") REFERENCES "variants"("code");`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dirTable), true);
  } finally {
    rmSync(dirTable, { recursive: true, force: true });
  }

  const dirInline = migrations({
    '0001_inline_quoted.sql': `CREATE TABLE "studies" (
      "id" UUID PRIMARY KEY,
      "variant" TEXT NOT NULL REFERENCES "variants"("code")
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dirInline), true);
  } finally {
    rmSync(dirInline, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks multiple unnamed foreign keys with non-colliding names', () => {
  const dir = migrations({
    '0001_two_unnamed.sql': `ALTER TABLE studies
      ADD FOREIGN KEY (variant) REFERENCES variants(code),
      ADD FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping the first generated name studies_variant_fkey leaves the second active
    writeFileSync(join(dir, '0002_drop_first.sql'), `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping the second generated name studies_variant_fkey1 clears all
    writeFileSync(join(dir, '0003_drop_second.sql'), `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey1;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey reuses base unnamed constraint name in add-drop-add-drop sequence', () => {
  const dir = migrations({
    '0001_add_first.sql': `ALTER TABLE studies ADD FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // 0002 drops the first generated name studies_variant_fkey
    writeFileSync(join(dir, '0002_drop_first.sql'), `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
    // 0003 adds another unnamed FK which reuses the available base name studies_variant_fkey
    writeFileSync(join(dir, '0003_add_second.sql'), `ALTER TABLE studies ADD FOREIGN KEY (variant) REFERENCES variants(code);`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // 0004 drops studies_variant_fkey again
    writeFileSync(join(dir, '0004_drop_second.sql'), `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DROP TABLE studies clears constraint and foreign key state', () => {
  const dropDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_table.sql': `DROP TABLE studies;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropDir), false);
    assert.equal(effectiveStudyVariantConstraint(dropDir), null);
  } finally {
    rmSync(dropDir, { recursive: true, force: true });
  }
});

test('ALTER TABLE studies RENAME TO clears constraint and foreign key state', () => {
  const renameDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_table.sql': `ALTER TABLE studies RENAME TO old_studies;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(renameDir), false);
    assert.equal(effectiveStudyVariantConstraint(renameDir), null);
  } finally {
    rmSync(renameDir, { recursive: true, force: true });
  }
});

test('DROP TABLE variants CASCADE clears active studies foreign key', () => {
  const dropVariantsCascadeDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_variants.sql': `DROP TABLE variants CASCADE;`,
    '0003_recreate_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropVariantsCascadeDir), false);
  } finally {
    rmSync(dropVariantsCascadeDir, { recursive: true, force: true });
  }

  const cascadeRecreateDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_variants.sql': `DROP TABLE variants CASCADE;`,
    '0003_recreate_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);`,
    '0004_readd_fk.sql': `ALTER TABLE studies ADD FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0005_drop_fk.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`,
  });
  try {
    // Releasing the cascaded FK name allows the re-added FK to use base name studies_variant_fkey,
    // so dropping studies_variant_fkey properly clears it.
    assert.equal(effectiveStudyVariantForeignKey(cascadeRecreateDir), false);
  } finally {
    rmSync(cascadeRecreateDir, { recursive: true, force: true });
  }
});

test('DROP TABLE multi-table containing variants with CASCADE clears active studies foreign key', () => {
  const dropMultiVariantsCascadeDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_multi_cascade.sql': `DROP TABLE archive, variants CASCADE;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropMultiVariantsCascadeDir), false);
  } finally {
    rmSync(dropMultiVariantsCascadeDir, { recursive: true, force: true });
  }
});

test('DROP TABLE public.studies with schema qualifier clears state', () => {
  const dropPublicStudiesDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_public_studies.sql': `DROP TABLE public.studies;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (id UUID PRIMARY KEY, variant TEXT NOT NULL);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropPublicStudiesDir), false);
    assert.equal(effectiveStudyVariantConstraint(dropPublicStudiesDir), null);
  } finally {
    rmSync(dropPublicStudiesDir, { recursive: true, force: true });
  }
});

test('DROP TABLE multi-table containing studies clears state', () => {
  const dropMultiStudiesDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_multi_studies.sql': `DROP TABLE studies, studies_backup;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (id UUID PRIMARY KEY, variant TEXT NOT NULL);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropMultiStudiesDir), false);
    assert.equal(effectiveStudyVariantConstraint(dropMultiStudiesDir), null);
  } finally {
    rmSync(dropMultiStudiesDir, { recursive: true, force: true });
  }
});

test('DROP TABLE variants.archive CASCADE in another schema does not clear public.variants foreign keys', () => {
  const dropVariantsSchemaArchiveDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_other_schema.sql': `DROP TABLE variants.archive CASCADE;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropVariantsSchemaArchiveDir), true);
  } finally {
    rmSync(dropVariantsSchemaArchiveDir, { recursive: true, force: true });
  }
});

test('DROP TABLE "archived variants" CASCADE with quoted name does not clear public.variants foreign keys', () => {
  const dropQuotedVariantsNameDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_other_table.sql': `DROP TABLE "archived variants" CASCADE;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropQuotedVariantsNameDir), true);
  } finally {
    rmSync(dropQuotedVariantsNameDir, { recursive: true, force: true });
  }
});

test('DROP TABLE public.variants CASCADE with schema qualification clears active studies foreign key', () => {
  const dropPublicVariantsCascadeDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_public_variants.sql': `DROP TABLE public.variants CASCADE;`,
    '0003_recreate_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropPublicVariantsCascadeDir), false);
  } finally {
    rmSync(dropPublicVariantsCascadeDir, { recursive: true, force: true });
  }
});

test('DROP TABLE variants RESTRICT does not cascade to clear active studies foreign key', () => {
  const dropVariantsRestrictDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_variants_restrict.sql': `DROP TABLE variants RESTRICT;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropVariantsRestrictDir), true);
  } finally {
    rmSync(dropVariantsRestrictDir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey ignores string literals containing RENAME TO keyword', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_add_column_with_default.sql': `ALTER TABLE studies ADD COLUMN note TEXT DEFAULT 'RENAME TO archive';`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey distinguishes escaped quoted identifier from variant column', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      "archived""variant" TEXT NOT NULL REFERENCES variants(code),
      variant TEXT NOT NULL
    );`,
  });
  try {
    // "archived""variant" is a separate column from "variant", so studies.variant has no FK
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks occupied constraint namespace across constraint types', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
    // Unrelated constraint occupies the base name studies_variant_fkey
    '0002_occupy_name.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fkey CHECK (id IS NOT NULL);`,
    // Unnamed FK receives next free name studies_variant_fkey1
    '0003_add_unnamed_fk.sql': `ALTER TABLE studies ADD FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);

    // Dropping studies_variant_fkey drops the unrelated CHECK, leaving the FK studies_variant_fkey1 active
    writeFileSync(
      join(dir, '0004_drop_unrelated.sql'),
      `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`,
      'utf8',
    );
    assert.equal(effectiveStudyVariantForeignKey(dir), true);

    // Dropping studies_variant_fkey1 drops the FK
    writeFileSync(
      join(dir, '0005_drop_fk.sql'),
      `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey1;`,
      'utf8',
    );
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey recognizes inline column references on studies', () => {
  const dir = migrations({
    '0001_inline.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks explicit inline constraint names and clears on drop', () => {
  const dir = migrations({
    '0001_inline_named.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CONSTRAINT custom_inline_fk REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(
      join(dir, '0002_drop_inline.sql'),
      `ALTER TABLE studies DROP CONSTRAINT custom_inline_fk;`,
      'utf8',
    );
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey handles multiple DROP CONSTRAINT clauses in a single statement', () => {
  const dir = migrations({
    '0001_fk.sql': `ALTER TABLE studies ADD CONSTRAINT custom_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_multi_drop.sql': `ALTER TABLE studies DROP CONSTRAINT unrelated_constraint, DROP CONSTRAINT custom_fk;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey does not match subsequent column referencing variants', () => {
  const dir = migrations({
    '0001_distinct_columns.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL,
      source TEXT REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey does not match prefix column like archived_variant referencing variants', () => {
  const dir = migrations({
    '0001_archived_variant.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL,
      archived_variant TEXT REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantConstraint preserves active CHECK constraint when FK is added without dropping CHECK', () => {
  const dir = migrations({
    '0001_check.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard' CHECK (variant IN ('standard', 'atomic'));`,
    '0002_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    const check = effectiveStudyVariantConstraint(dir);
    assert.notEqual(check, null);
    assert.deepEqual(check.variants, ['standard', 'atomic']);
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectMirrors exposes whether effective studies.variant foreign key is present', () => {
  const committed = collectMirrors(MIGRATIONS_DIR);
  assert.equal(committed.studyConstraint, null);
  assert.equal(committed.hasStudyVariantFk, true);

  const dropOnlyDir = migrations({
    '0001_variants.sql': `INSERT INTO variants (code) VALUES ('standard');`,
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_drop_only.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
  });
  try {
    const dropOnly = collectMirrors(dropOnlyDir);
    assert.equal(dropOnly.studyConstraint, null);
    assert.equal(dropOnly.hasStudyVariantFk, false);
  } finally {
    rmSync(dropOnlyDir, { recursive: true, force: true });
  }
});

test('a renamed declaration fails loudly instead of checking nothing', () => {
  // The failure mode that makes a guard worse than no guard: it keeps passing having stopped
  // looking at anything.
  assert.throws(
    () => extractRegion({ ...ROOT, text: 'export type RuleSet =\n  | "standard";' }),
    /could not find its declaration/,
  );
});

test('disagreements name what is wrong, in both directions', () => {
  assert.deepEqual(disagreements(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(disagreements(['a', 'b'], ['a']), ['missing `b`']);
  assert.deepEqual(disagreements(['a'], ['a', 'z']), ['unknown `z`']);
  assert.deepEqual(disagreements(['a'], ['a', 'a']), ['duplicated `a`']);
});

test('every mirror the guard claims to read is really there', () => {
  // Pins the specs against the real tree, so a file move breaks this rather than the CI job.
  for (const spec of [ROOT, ...TS_MIRRORS]) {
    const found = extractRegion(spec);
    assert.ok(found.variants.length > 0, `${spec.label} yielded no variants`);
    assert.ok(found.variants.includes('standard'), `${spec.label} is missing 'standard'`);
  }
});

test('tokenizeSql correctly distinguishes string literals, escaped quotes, and punctuation', () => {
  const sql = `ALTER TABLE "public"."studies" ADD COLUMN note TEXT DEFAULT 'It''s a ''quoted'' string; not a stmt';`;
  const tokens = tokenizeSql(sql);

  assert.equal(tokens[0].value, 'alter');
  assert.equal(tokens[1].value, 'table');
  assert.equal(tokens[2].type, 'ident');
  assert.equal(tokens[2].value, 'public');
  assert.equal(tokens[3].value, '.');
  assert.equal(tokens[4].type, 'ident');
  assert.equal(tokens[4].value, 'studies');

  const stringToken = tokens.find((t) => t.type === 'string');
  assert.notEqual(stringToken, undefined);
  assert.equal(stringToken.value, "It's a 'quoted' string; not a stmt");

  const stmts = splitSqlStatements(tokens);
  assert.equal(stmts.length, 1, 'semicolon inside string literal must not split statement');
});

test('parseQualifiedTableTarget handles schema qualification and ONLY keyword', () => {
  const t1 = tokenizeSql('ONLY "public"."studies"');
  const ref1 = parseQualifiedTableTarget(t1, 0);
  assert.deepEqual(ref1, { schema: 'public', table: 'studies', nextIndex: 4 });

  const t2 = tokenizeSql('studies');
  const ref2 = parseQualifiedTableTarget(t2, 0);
  assert.deepEqual(ref2, { schema: 'public', table: 'studies', nextIndex: 1 });

  const t3 = tokenizeSql('variants.archive');
  const ref3 = parseQualifiedTableTarget(t3, 0);
  assert.deepEqual(ref3, { schema: 'variants', table: 'archive', nextIndex: 3 });
});

test('inline column definition containing both CHECK and REFERENCES records both constraints', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CONSTRAINT allowed_check CHECK (variant IN ('standard', 'atomic')) REFERENCES variants(code)
    );`,
    '0002_drop_check.sql': `ALTER TABLE studies DROP CONSTRAINT allowed_check;`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir), null);
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('column definition containing multiple inline CHECK constraints records all of them', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT check1 CHECK (variant IN ('standard', 'atomic'))
        CONSTRAINT check2 CHECK (variant IN ('standard', 'atomic', 'chess960'))
    );`,
  });
  try {
    const replayed = replayStudiesSchema(dir);
    assert.equal(replayed.checks.length, 2);
    assert.equal(replayed.checks[0].name, 'check1');
    assert.deepEqual(replayed.checks[0].variants, ['standard', 'atomic']);
    assert.equal(replayed.checks[1].name, 'check2');
    assert.deepEqual(replayed.checks[1].variants, ['standard', 'atomic', 'chess960']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renaming column variant preserves existing constraint names in namespace for new unnamed FKs', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_col.sql': `ALTER TABLE studies RENAME COLUMN variant TO old_variant;`,
    '0003_add_new_variant.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL REFERENCES variants(code);`,
    '0004_drop_new_fk.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey1;`,
  });
  try {
    // The renamed column kept studies_variant_fkey, so the new FK was assigned studies_variant_fkey1.
    // Dropping studies_variant_fkey1 clears the active FK on the new variant column.
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dropping column variant releases dependent constraint names from namespace', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_col.sql': `ALTER TABLE studies DROP COLUMN variant;`,
    '0003_readd_col.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL REFERENCES variants(code);`,
    '0004_drop_readded_fk.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_fkey;`,
  });
  try {
    // Dropping the variant column released studies_variant_fkey, so re-adding allows reusing studies_variant_fkey.
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CREATE TABLE IF NOT EXISTS studies skips constraints when table already exists', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL
    );`,
    '0002_conditional_recreate.sql': `CREATE TABLE IF NOT EXISTS studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    // The second CREATE TABLE IF NOT EXISTS is a no-op in PostgreSQL because studies already exists.
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER TABLE ADD COLUMN IF NOT EXISTS variant skips constraints when variant already exists', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
    '0002_conditional_add.sql': `ALTER TABLE studies ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL REFERENCES variants(code);`,
  });
  try {
    // The conditional column add is a no-op in PostgreSQL because variant already exists.
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compound CHECK predicate with suffix fails loudly rather than ignoring predicate', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'atomic') AND variant <> 'atomic')
    );`,
  });
  try {
    assert.throws(
      () => replayStudiesSchema(dir),
      /defines a compound or non-standard CHECK predicate on `studies.variant`/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER TABLE IF EXISTS studies skips actions when table does not exist', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL
    );`,
    '0002_drop.sql': `DROP TABLE studies;`,
    '0003_conditional_alter.sql': `ALTER TABLE IF EXISTS studies ADD COLUMN variant TEXT REFERENCES variants(code);`,
  });
  try {
    // ALTER TABLE IF EXISTS is a no-op in PostgreSQL because studies was dropped.
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported inline CHECK predicate shape fails loudly rather than being ignored', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant = ANY (ARRAY['standard', 'atomic']))
    );`,
  });
  try {
    assert.throws(
      () => replayStudiesSchema(dir),
      /defines an unsupported CHECK predicate shape on `studies.variant`/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported table-level CHECK predicate shape fails loudly rather than being ignored', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL,
      CONSTRAINT chk_custom CHECK (studies.variant IN ('standard', 'atomic'))
    );`,
  });
  try {
    assert.throws(
      () => replayStudiesSchema(dir),
      /defines an unsupported CHECK predicate shape on `studies.variant`/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operators or expressions inside IN-list fail loudly rather than extracting partial literals', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard' || 'chess960', 'atomic'))
    );`,
  });
  try {
    assert.throws(
      () => replayStudiesSchema(dir),
      /defines an unsupported CHECK predicate shape on `studies.variant`/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('table rename round-trip preserves foreign key constraint when renamed back to studies', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_away.sql': `ALTER TABLE studies RENAME TO studies_temp;`,
    '0003_rename_back.sql': `ALTER TABLE studies_temp RENAME TO studies;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('table rename round-trip preserves CHECK constraint when renamed back to studies', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'atomic'))
    );`,
    '0002_rename_away.sql': `ALTER TABLE studies RENAME TO studies_temp;`,
    '0003_rename_back.sql': `ALTER TABLE studies_temp RENAME TO studies;`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.equal(found?.file, '0001_initial.sql');
    assert.deepEqual(found?.variants, ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline column definition with REFERENCES and CHECK in reverse order records both', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL DEFAULT 'standard'
        REFERENCES variants(code)
        CHECK (variant IN ('standard', 'atomic'))
    );`,
  });
  try {
    const replayed = replayStudiesSchema(dir);
    assert.equal(replayed.checks.length, 1);
    assert.equal(replayed.checks[0].name, 'studies_variant_check');
    assert.deepEqual(replayed.checks[0].variants, ['standard', 'atomic']);
    assert.equal(replayed.hasForeignKey, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline column definition with explicit CONSTRAINT names on both CHECK and REFERENCES', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT chk_study_variant CHECK (variant IN ('standard', 'atomic'))
        CONSTRAINT fk_study_variant REFERENCES variants(code)
    );`,
  });
  try {
    const replayed = replayStudiesSchema(dir);
    assert.equal(replayed.checks.length, 1);
    assert.equal(replayed.checks[0].name, 'chk_study_variant');
    assert.deepEqual(replayed.checks[0].variants, ['standard', 'atomic']);
    assert.equal(replayed.hasForeignKey, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dropping only FK constraint leaves CHECK active when both defined on same column', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT chk_variant CHECK (variant IN ('standard', 'atomic'))
        CONSTRAINT fk_variant REFERENCES variants(code)
    );`,
    '0002_drop_fk.sql': `ALTER TABLE studies DROP CONSTRAINT fk_variant;`,
  });
  try {
    const replayed = replayStudiesSchema(dir);
    assert.notEqual(replayed.check, null);
    assert.equal(replayed.check?.name, 'chk_variant');
    assert.deepEqual(replayed.check?.variants, ['standard', 'atomic']);
    assert.equal(replayed.hasForeignKey, false);
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation succeeds when surviving FK provides integrity after CHECK drop', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT chk_v CHECK (variant IN ('standard', 'atomic'))
    );`,
    '0005_add_fk.sql': `ALTER TABLE studies ADD CONSTRAINT fk_v
  FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;`,
    '0006_drop_chk.sql': `ALTER TABLE studies DROP CONSTRAINT chk_v;`,
    '0007_validate_fk.sql': `ALTER TABLE studies VALIDATE CONSTRAINT fk_v;`,
  });
  try {
    const { failures, mirrors, studyConstraint, hasStudyVariantFk } = evaluateParity(dir);
    assert.deepEqual(failures, []);
    assert.equal(studyConstraint, null);
    assert.equal(hasStudyVariantFk, true);
    const lookupMirror = mirrors.find((m) => m.label.includes('variants'));
    assert.notEqual(lookupMirror, undefined);
    assert.deepEqual(disagreements(extractRegion(ROOT).variants, lookupMirror.variants), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation rejects a surviving studies CHECK even when its values match Variant', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');
ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;
ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0002_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT chk_v CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
        CONSTRAINT fk_v REFERENCES variants(code)
    );`,
    '0003_drop_fk.sql': `ALTER TABLE studies DROP CONSTRAINT fk_v;`,
  });
  try {
    const { failures, studyConstraint, hasStudyVariantFk } = evaluateParity(dir);
    assert.notEqual(studyConstraint, null);
    assert.equal(hasStudyVariantFk, false);
    assert.ok(
      failures.some((failure) => /retains obsolete CHECK constraint/.test(failure)),
      failures.join('\n'),
    );
    assert.ok(
      failures.some((failure) => /has no foreign key referencing `variants\(code\)`/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation detects seed and domain disagreement independently', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    const { failures } = evaluateParity(dir);
    assert.ok(
      failures.some((failure) => /variants.*lookup table.*missing `horde`/.test(failure)),
      failures.join('\n'),
    );
    assert.ok(
      !failures.some((failure) => /variants\.code.*missing `horde`/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation requires a validated variants domain CHECK matching Variant', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    const { failures, variantDomainConstraint } = evaluateParity(dir);
    assert.equal(variantDomainConstraint?.name, 'variants_code_check');
    assert.equal(variantDomainConstraint?.validated, false);
    assert.ok(
      failures.some((failure) => /variants\.code.*not validated/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation detects missing and unknown values in variants domain CHECK', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'antichess', 'racingkings')) NOT VALID;
ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0003_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    const { failures } = evaluateParity(dir);
    assert.ok(
      failures.some((failure) => /variants\.code.*missing `horde`.*unknown `antichess`/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation detects studies CHECK removal before variants domain validation', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
    );`,
    '0003_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0004_unsafe.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_fk FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;`,
    '0005_too_late.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;
ALTER TABLE studies VALIDATE CONSTRAINT studies_variant_fk;`,
  });
  try {
    const { failures, unsafeStudyConstraintTransition } = evaluateParity(dir);
    assert.equal(unsafeStudyConstraintTransition, true);
    assert.ok(
      failures.some((failure) => /before the variants domain CHECK was validated/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation permits staging the studies FK while its canonical CHECK remains active', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
    );`,
    '0003_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0004_stage_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;`,
    '0005_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0006_replace_check.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
    '0007_validate_fk.sql': `ALTER TABLE studies VALIDATE CONSTRAINT studies_variant_fk;`,
  });
  try {
    const { failures, unsafeStudyConstraintTransition } = evaluateParity(dir);
    assert.equal(unsafeStudyConstraintTransition, false);
    assert.deepEqual(failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation recognizes PostgreSQL FK options before trailing NOT VALID', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
    );`,
    '0005_stage_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code)
  MATCH FULL ON DELETE RESTRICT ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED NOT VALID;`,
    '0006_replace_check.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
    '0007_validate_fk.sql': `ALTER TABLE studies VALIDATE CONSTRAINT studies_variant_fk;`,
  });
  try {
    const { failures, studyForeignKeys } = evaluateParity(dir);
    assert.deepEqual(failures, []);
    assert.equal(studyForeignKeys[0]?.file, '0005_stage_fk.sql');
    assert.equal(studyForeignKeys[0]?.validatedFile, '0007_validate_fk.sql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation recognizes CHECK NO INHERIT before trailing NOT VALID', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NO INHERIT NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
    );`,
    '0005_stage_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;`,
    '0006_replace_check.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
    '0007_validate_fk.sql': `ALTER TABLE studies VALIDATE CONSTRAINT studies_variant_fk;`,
  });
  try {
    const { failures, variantDomainConstraint } = evaluateParity(dir);
    assert.deepEqual(failures, []);
    assert.equal(variantDomainConstraint?.addedNotValid, true);
    assert.equal(variantDomainConstraint?.validatedFile, '0003_validate_domain.sql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity replay fails closed on an unknown foreign-key suffix', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
CREATE TABLE studies (id UUID PRIMARY KEY, variant TEXT NOT NULL);`,
    '0002_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code) MATCH UNKNOWN NOT VALID;`,
  });
  try {
    assert.throws(
      () => replayStudiesSchema(dir),
      /unsupported suffix.*studies\.variant.*foreign key/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CREATE TABLE replay accepts a final table-level studies variant CHECK', () => {
  const dir = migrations({
    '0001_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL,
      CONSTRAINT studies_variant_check CHECK (variant IN ('standard'))
    );`,
  });
  try {
    assert.deepEqual(replayStudiesSchema(dir).check?.variants, ['standard']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity replay rejects NOT ENFORCED variant integrity constraints', () => {
  const checkDir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard')) NOT ENFORCED NOT VALID;`,
  });
  const fkDir = migrations({
    '0001_initial.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
CREATE TABLE studies (id UUID PRIMARY KEY, variant TEXT NOT NULL);`,
    '0002_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code) NOT ENFORCED NOT VALID;`,
  });
  const alteredStudyCheckDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (id UUID PRIMARY KEY, variant TEXT NOT NULL);`,
    '0002_check.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_check
  CHECK (variant IN ('standard')) NOT ENFORCED NOT VALID;`,
  });
  const tableStudyCheckDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL,
  CONSTRAINT studies_variant_check CHECK (variant IN ('standard')) NOT ENFORCED
);`,
  });
  const inlineStudyCheckDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL CHECK (variant IN ('standard')) NOT ENFORCED
);`,
  });
  const inlineStudyFkDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL REFERENCES variants(code)
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED NOT ENFORCED
);`,
  });
  try {
    assert.throws(() => replayStudiesSchema(checkDir), /NOT ENFORCED.*variants\.code.*protect writes/i);
    assert.throws(() => replayStudiesSchema(fkDir), /NOT ENFORCED.*studies\.variant.*protect writes/i);
    assert.throws(
      () => replayStudiesSchema(alteredStudyCheckDir),
      /NOT ENFORCED.*studies\.variant.*protect writes/i,
    );
    assert.throws(
      () => replayStudiesSchema(tableStudyCheckDir),
      /NOT ENFORCED.*studies\.variant.*protect writes/i,
    );
    assert.throws(
      () => replayStudiesSchema(inlineStudyCheckDir),
      /NOT ENFORCED.*studies\.variant.*protect writes/i,
    );
    assert.throws(
      () => replayStudiesSchema(inlineStudyFkDir),
      /NOT ENFORCED.*studies\.variant.*protect writes/i,
    );
  } finally {
    rmSync(checkDir, { recursive: true, force: true });
    rmSync(fkDir, { recursive: true, force: true });
    rmSync(alteredStudyCheckDir, { recursive: true, force: true });
    rmSync(tableStudyCheckDir, { recursive: true, force: true });
    rmSync(inlineStudyCheckDir, { recursive: true, force: true });
    rmSync(inlineStudyFkDir, { recursive: true, force: true });
  }
});

test('parity evaluation rejects a broad validated domain CHECK as transition authorization', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_broad_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_legacy_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings', 'antichess')) NOT VALID;
ALTER TABLE variants VALIDATE CONSTRAINT variants_code_legacy_check;`,
    '0003_canonical_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
    );`,
    '0005_unsafe.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_fk FOREIGN KEY (variant) REFERENCES variants(code) NOT VALID;`,
    '0006_too_late.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;
ALTER TABLE variants DROP CONSTRAINT variants_code_legacy_check;
ALTER TABLE studies VALIDATE CONSTRAINT studies_variant_fk;`,
  });
  try {
    const { failures, unsafeStudyConstraintTransition } = evaluateParity(dir);
    assert.equal(unsafeStudyConstraintTransition, true);
    assert.ok(
      failures.some((failure) => /before the variants domain CHECK was validated/.test(failure)),
      failures.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity evaluation flags failure when both CHECK and FK are removed from studies.variant', () => {
  const dir = migrations({
    '0001_variants.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
        CONSTRAINT chk_v CHECK (variant IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'))
        CONSTRAINT fk_v REFERENCES variants(code)
    );`,
    '0005_drop_both.sql': `ALTER TABLE studies DROP CONSTRAINT chk_v, DROP CONSTRAINT fk_v;`,
  });
  try {
    const { failures, studyConstraint, hasStudyVariantFk } = evaluateParity(dir);
    assert.equal(studyConstraint, null);
    assert.equal(hasStudyVariantFk, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /`studies\.variant` has no foreign key referencing `variants\(code\)`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quoted identifier case is preserved so renaming to "Studies" leaves effectiveStudyVariantForeignKey false', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_case.sql': `ALTER TABLE studies RENAME TO "Studies";`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
    assert.equal(effectiveStudyVariantConstraint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow table recreation and drop preserves original renamed table constraints on rename back', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_away.sql': `ALTER TABLE studies RENAME TO studies_backup;`,
    '0003_create_shadow.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      note TEXT
    );`,
    '0004_drop_shadow.sql': `DROP TABLE studies;`,
    '0005_rename_back.sql': `ALTER TABLE studies_backup RENAME TO studies;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creating or altering table in another schema does not overwrite public.studies constraints', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_archive_schema.sql': `CREATE TABLE archive.studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CHECK (variant IN ('standard', 'atomic'))
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    assert.equal(effectiveStudyVariantConstraint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER TABLE SET SCHEMA moving studies out of public leaves effectiveStudyVariantForeignKey false', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_move_schema.sql': `ALTER TABLE studies SET SCHEMA archive;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
    assert.equal(effectiveStudyVariantConstraint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER TABLE SET SCHEMA moving table into public restores effectiveStudyVariantForeignKey true', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_move_to_archive.sql': `ALTER TABLE studies SET SCHEMA archive;`,
    '0003_move_back_to_public.sql': `ALTER TABLE archive.studies SET SCHEMA public;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenizeSql and splitSqlStatements treat untagged dollar-quoted body with semicolons as one statement', () => {
  const sql = `DO $$
  BEGIN
    PERFORM 1;
    PERFORM 2;
  END
  $$;`;
  const tokens = tokenizeSql(sql);
  const statements = splitSqlStatements(tokens);
  assert.equal(statements.length, 1);
  assert.equal(tokens[1].type, 'string');
});

test('tokenizeSql and splitSqlStatements treat tagged dollar-quoted body with semicolons as one statement', () => {
  const sql = `DO $migration$
  BEGIN
    PERFORM 1;
    PERFORM 2;
  END
  $migration$;`;
  const tokens = tokenizeSql(sql);
  const statements = splitSqlStatements(tokens);
  assert.equal(statements.length, 1);
  assert.equal(tokens[1].type, 'string');
});

test('unknown harmless DO statement fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_harmless_do.sql': `DO $$
    BEGIN
      RAISE NOTICE 'hello';
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stored-function invocation inside DO statement fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_stored_proc.sql': `DO $$
    BEGIN
      PERFORM remove_variant_fk();
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-level DO statement with direct DDL fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_direct_ddl.sql': `DO $$
    BEGIN
      ALTER TABLE studies DROP CONSTRAINT studies_variant_fk;
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-level DO statement with DROP TABLE studies fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_procedural_drop.sql': `DO $$
    BEGIN
      DROP TABLE studies;
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-level DO statement with DROP TABLE variants CASCADE fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_procedural_cascade.sql': `DO $$
    BEGIN
      DROP TABLE variants CASCADE;
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-level DO statement with dynamic SQL EXECUTE fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_dynamic_ddl.sql': `DO $$
    BEGIN
      EXECUTE 'ALTER TABLE studies DROP CONSTRAINT studies_variant_fk';
    END
    $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tagged top-level DO statement fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_tagged_do.sql': `DO $migration$
    BEGIN
      PERFORM 1;
    END
    $migration$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Unicode-tagged top-level DO statement fails closed', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_unicode_do.sql': `DO $函数$
    BEGIN
      PERFORM 1;
    END
    $函数$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical 0021_engine_bots.sql migration matches allowlist fingerprint and passes replay', () => {
  const realFile = join(MIGRATIONS_DIR, '0021_engine_bots.sql');
  const rawSql = readFileSync(realFile, 'utf8');
  const canonicalSql = rawSql.replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(canonicalSql, 'utf8').digest('hex');
  const entry = KNOWN_HISTORICAL_PROCEDURAL_MIGRATIONS.get('0021_engine_bots.sql');
  assert.ok(entry);
  assert.equal(hash, entry.sha256);
  assert.equal(entry.expectedDoCount, 1);

  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0021_engine_bots.sql': rawSql,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical 0044_rating_pools.sql migration matches its allowlist fingerprint', () => {
  const rawSql = readFileSync(join(MIGRATIONS_DIR, '0044_rating_pools.sql'), 'utf8');
  const hash = createHash('sha256').update(rawSql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const entry = KNOWN_HISTORICAL_PROCEDURAL_MIGRATIONS.get('0044_rating_pools.sql');
  assert.ok(entry);
  assert.equal(hash, entry.sha256);
  assert.equal(entry.expectedDoCount, 1);
});

test('0021_engine_bots.sql with ONE modified byte is rejected', () => {
  const realFile = join(MIGRATIONS_DIR, '0021_engine_bots.sql');
  const rawSql = readFileSync(realFile, 'utf8');
  const modifiedSql = rawSql + ' '; // one changed byte
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0021_engine_bots.sql': modifiedSql,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0021_engine_bots.sql filename with different file content is rejected', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0021_engine_bots.sql': `DO $$ BEGIN PERFORM 1; END $$;`,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same safe DO content copied into a different migration filename is rejected', () => {
  const realFile = join(MIGRATIONS_DIR, '0021_engine_bots.sql');
  const rawSql = readFileSync(realFile, 'utf8');
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0030_copied_engine_bots.sql': rawSql,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new second DO added to allowlisted migration causes rejection via fingerprint and count mismatch', () => {
  const realFile = join(MIGRATIONS_DIR, '0021_engine_bots.sql');
  const rawSql = readFileSync(realFile, 'utf8');
  const twoDoSql = rawSql + '\nDO $$ BEGIN PERFORM 1; END $$;';
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0021_engine_bots.sql': twoDoSql,
  });
  try {
    assert.throws(() => replayStudiesSchema(dir), /contains an unsupported top-level PostgreSQL DO block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-DO dollar-quoted function body remains lexically atomic and is ignored by replay', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_func.sql': `CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
    BEGIN
      -- Semicolons inside function do not split top-level statements
      PERFORM 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dollar-quoted string requires exact matching tag and does not stop on mismatched inner tag', () => {
  const sql = `DO $outer$ body with $inner$ inner text $inner$ more body $outer$;`;
  const tokens = tokenizeSql(sql);
  assert.equal(tokens.length, 3); // DO, string, ;
  assert.equal(tokens[1].type, 'string');
  assert.equal(tokens[1].value, ' body with $inner$ inner text $inner$ more body ');
});

test('Unicode dollar tag with CJK characters is tokenized as one atomic string', () => {
  const sql = `$函数$\nSELECT 1;\nSELECT 2;\n$函数$;`;
  const tokens = tokenizeSql(sql);
  const statements = splitSqlStatements(tokens);
  assert.equal(statements.length, 1);
  assert.equal(tokens[0].type, 'string');
  assert.equal(tokens[0].value, '\nSELECT 1;\nSELECT 2;\n');
});

test('Unicode dollar tag with accented Latin characters is tokenized as one atomic string', () => {
  const sql = `$étiquette$\nSELECT 1;\n$étiquette$;`;
  const tokens = tokenizeSql(sql);
  const statements = splitSqlStatements(tokens);
  assert.equal(statements.length, 1);
  assert.equal(tokens[0].type, 'string');
  assert.equal(tokens[0].value, '\nSELECT 1;\n');
});

test('dollar tag starting with underscore and containing alphanumeric characters works', () => {
  const sql = `$_tag123$\nSELECT 1;\n$_tag123$;`;
  const tokens = tokenizeSql(sql);
  const statements = splitSqlStatements(tokens);
  assert.equal(statements.length, 1);
  assert.equal(tokens[0].type, 'string');
});

test('Unicode dollar tag requires exact matching tag and does not stop on different tag', () => {
  const sql = `$函数$\nSELECT 1;\n$different$\nSELECT 2;\n$函数$;`;
  const tokens = tokenizeSql(sql);
  assert.equal(tokens.length, 2); // string, ;
  assert.equal(tokens[0].type, 'string');
  assert.equal(tokens[0].value, '\nSELECT 1;\n$different$\nSELECT 2;\n');
});

test('unterminated Unicode-tagged dollar quote throws explicit error', () => {
  assert.throws(() => tokenizeSql('$函数$ SELECT 1;'), /unterminated dollar-quoted string/);
  assert.throws(() => tokenizeSql('$étiquette$ SELECT 1; $different$'), /unterminated dollar-quoted string/);
});

test('dollar tag starting with digit like $9bad$ is rejected by readDollarQuoteDelimiter', () => {
  assert.equal(readDollarQuoteDelimiter('$9bad$', 0), null);
  const tokens = tokenizeSql('$9bad$');
  assert.equal(tokens[0].type, 'punct');
  assert.equal(tokens[0].value, '$');
  assert.equal(tokens[1].type, 'punct');
  assert.equal(tokens[1].value, '9');
});

test('comment stripping and tokenizer recognize the exact same dollar delimiter set', () => {
  const codeWithComment = `$étiquette$\n-- this is not a comment line\nSELECT 1;\n$étiquette$;`;
  const stripped = stripComments(codeWithComment, 'sql');
  const tokens = tokenizeSql(stripped);
  assert.equal(tokens[0].type, 'string');
  assert.match(tokens[0].value, /-- this is not a comment line/);
});

test('unterminated dollar-quoted string throws explicit error', () => {
  assert.throws(() => tokenizeSql('DO $$ BEGIN PERFORM 1;'), /unterminated dollar-quoted string/);
  assert.throws(() => tokenizeSql('DO $tag$ BEGIN PERFORM 1; $different$'), /unterminated dollar-quoted string/);
});

test('ordinary single-quoted strings and positional parameters are not confused with dollar quotes', () => {
  const sql = `SELECT 'hello $world$', $1, $2 FROM t;`;
  const tokens = tokenizeSql(sql);
  assert.equal(tokens[0].value, 'select');
  assert.equal(tokens[1].type, 'string');
  assert.equal(tokens[1].value, 'hello $world$');
  assert.equal(tokens[3].type, 'punct');
  assert.equal(tokens[3].value, '$');
  assert.equal(tokens[4].type, 'punct');
  assert.equal(tokens[4].value, '1');
});

test('structured tableKey distinguishes quoted identifiers containing periods', () => {
  const key1 = tableKey({ schema: 'archive.x', table: 'studies' });
  const key2 = tableKey({ schema: 'archive', table: 'x.studies' });
  assert.notEqual(key1, key2);
  assert.equal(key1, '["archive.x","studies"]');
  assert.equal(key2, '["archive","x.studies"]');
});

test('structured tableKey distinguishes public.studies from a table named "public.studies" in public schema', () => {
  const canonical = tableKey({ schema: 'public', table: 'studies' });
  const literalDotted = tableKey({ schema: 'public', table: 'public.studies' });
  assert.notEqual(canonical, literalDotted);
  assert.equal(canonical, STUDIES_TABLE_KEY);
  assert.equal(literalDotted, '["public","public.studies"]');
});

test('end-to-end parity failure when colliding-under-old-model table has variant constraints but public.studies is unconstrained', () => {
  const dir = migrations({
    '0001_initial.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY);
INSERT INTO variants (code) VALUES
  ('standard'), ('chess960'), ('kingofthehill'), ('atomic'),
  ('crazyhouse'), ('threecheck'), ('horde'), ('racingkings');`,
    '0002_domain.sql': `ALTER TABLE variants ADD CONSTRAINT variants_code_check
  CHECK (code IN ('standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings')) NOT VALID;`,
    '0003_validate_domain.sql': `ALTER TABLE variants VALIDATE CONSTRAINT variants_code_check;`,
    '0004_unconstrained_studies.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
    '0005_colliding_archive.sql': `CREATE TABLE "public.studies" (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    const { failures, studyConstraint, hasStudyVariantFk } = evaluateParity(dir);
    assert.equal(studyConstraint, null);
    assert.equal(hasStudyVariantFk, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /`studies\.variant` has no foreign key referencing `variants\(code\)`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});












