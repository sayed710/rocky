/** Migration 0044 moves ratings to variant × speed pools, and fails closed on legacy rows (ADR-0150). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrationFiles, migrationsDir } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS_DIR = migrationsDir();

function migrationsThrough(version: number): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `rating-pools-${version}-`));
  for (const migration of migrationFiles(MIGRATIONS_DIR)) {
    if (migration.version <= version) copyFileSync(join(MIGRATIONS_DIR, migration.file), join(dir, migration.file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a legacy variant-only rating row stops the migration, is kept intact, and nothing is guessed', { skip }, async () => {
  const before = migrationsThrough(43);
  try {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, before.dir);
      const userId = randomUUID();
      await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [userId, `legacy_${userId.slice(-12)}`]);
      await pool.query(`INSERT INTO ratings (user_id, variant, rating, rd, vol) VALUES ($1, 'standard', 1712.5, 80, 0.06)`, [userId]);

      await assert.rejects(migrate(pool, MIGRATIONS_DIR), /1 legacy variant-only rating row\(s\) exist[\s\S]*explicit handling is required/);
      // Rolled back whole: the row is untouched, no speed column appeared, and it was copied nowhere.
      assert.deepEqual(
        (await pool.query('SELECT user_id, variant, rating, rd, vol FROM ratings')).rows,
        [{ user_id: userId, variant: 'standard', rating: 1712.5, rd: 80, vol: 0.06 }],
      );
      assert.equal((await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'ratings' AND column_name = 'speed'`,
      )).rowCount, 0);

      // After the operator empties the table, the same migration succeeds.
      await pool.query('DELETE FROM ratings');
      await migrate(pool, MIGRATIONS_DIR);
      assert.equal((await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'ratings' AND column_name = 'speed'`,
      )).rowCount, 1);
    });
  } finally {
    before.cleanup();
  }
});

test('the pooled table enforces one row per player and pool, a real speed, and finite, sane values', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS_DIR);
    const userId = randomUUID();
    await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [userId, `pool_${userId.slice(-12)}`]);
    const insert = (speed: string, rating: number | string, rd: number | string = 100, vol: number | string = 0.06) => pool.query(
      'INSERT INTO ratings (user_id, variant, speed, rating, rd, vol) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, 'standard', speed, rating, rd, vol],
    );
    await insert('blitz', 1500);
    await insert('rapid', 1600); // same variant, another speed: another pool
    await assert.rejects(insert('blitz', 1400), /ratings_pkey/);
    await assert.rejects(insert('hyperbullet', 1500), /ratings_speed_check/);
    await assert.rejects(insert('classical', 'NaN'), /ratings_rating_sane/);
    await assert.rejects(insert('classical', 'Infinity'), /ratings_rating_sane/);
    await assert.rejects(insert('classical', 1500, 0), /ratings_rd_sane/);
    await assert.rejects(insert('classical', 1500, 'NaN'), /ratings_rd_sane/);
    await assert.rejects(insert('classical', 1500, 100, 1), /ratings_vol_sane/);
    await assert.rejects(pool.query(
      `INSERT INTO ratings (user_id, variant, rating, rd, vol) VALUES ($1, 'standard', 1500, 100, 0.06)`, [userId],
    ), /null value in column "speed"/);
  });
});
