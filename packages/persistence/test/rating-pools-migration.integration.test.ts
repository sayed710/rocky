/** Migration 0044 moves ratings to variant × speed pools, and fails closed on legacy rows (ADR-0150). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    await assert.rejects(insert('classical', 1500, 100, 0), /ratings_vol_sane/);
    await assert.rejects(insert('classical', 1500, 100, 'Infinity'), /ratings_vol_sane/);
    await insert('classical', 10001, 1001, 1);
    await assert.rejects(pool.query(
      `INSERT INTO ratings (user_id, variant, rating, rd, vol) VALUES ($1, 'standard', 1500, 100, 0.06)`, [userId],
    ), /null value in column "speed"/);
  });
});

test('a blocked-game disposition requires all audit fields', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS_DIR);
    const gameId = randomUUID();
    await pool.query('INSERT INTO rating_blocked_games (game_id, error) VALUES ($1, $2)', [gameId, 'invalid stream']);
    await assert.rejects(pool.query(
      `UPDATE rating_blocked_games SET disposition = 'leave_blocked', disposition_at = now()
       WHERE game_id = $1`, [gameId],
    ), /rating_block_disposition_complete/);
    await assert.rejects(pool.query(
      `UPDATE rating_blocked_games SET disposition = 'leave_blocked', disposition_by = 'operator',
              disposition_reason = '  ', disposition_at = now() WHERE game_id = $1`, [gameId],
    ), /rating_block_disposition_complete/);
  });
});

test('a database already at published migration 0045 upgrades without changing prior checksums', { skip }, async () => {
  const published = [
    ['0044_rating_pools.sql', 'c411949ede62aacba512322847bd439687015ae0eac1a5a6da5b81331086de61'],
    ['0045_rating_order_index.sql', '8796c14ab2db3261cdfc77db81212bc04560f22a687529ae2d4905bc8e3eaf90'],
  ] as const;
  for (const [file, expected] of published) {
    const canonical = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(canonical).digest('hex'), expected, `${file} must keep its published checksum`);
  }
  const through45 = migrationsThrough(45);
  try {
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, through45.dir);
      const before = (await pool.query(
        'SELECT version, checksum FROM schema_migrations WHERE version IN (44, 45) ORDER BY version',
      )).rows;
      const userId = randomUUID();
      const blockedId = randomUUID();
      const priorSkippedId = randomUUID();
      const pendingId = randomUUID();
      await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [userId, `upgrade_${userId.slice(-12)}`]);
      await pool.query(`INSERT INTO ratings (user_id, variant, speed, rating, rd, vol)
        VALUES ($1, 'standard', 'blitz', 1500, 350, 0.06)`, [userId]);
      await pool.query('INSERT INTO rating_blocked_games (game_id, error) VALUES ($1, $2)', [blockedId, 'old block']);
      for (const gameId of [priorSkippedId, pendingId]) {
        await pool.query(`INSERT INTO game_events (game_id, seq, type, payload)
          VALUES ($1, 0, 'GameCreated', '{"type":"GameCreated"}'::jsonb),
                 ($1, 1, 'GameEnded', '{"type":"GameEnded"}'::jsonb)`, [gameId]);
        if (gameId === priorSkippedId) {
          await pool.query(`UPDATE rating_checkpoint SET (xact_id, server_ts, game_id) =
            (SELECT xact_id, server_ts, game_id FROM game_events WHERE game_id = $1 AND type = 'GameEnded')`, [gameId]);
        }
      }

      await migrate(pool, MIGRATIONS_DIR);
      assert.deepEqual((await pool.query(
        'SELECT version, checksum FROM schema_migrations WHERE version IN (44, 45) ORDER BY version',
      )).rows, before);
      await pool.query(`UPDATE ratings SET rating = 10001, rd = 1001, vol = 1
        WHERE user_id = $1 AND variant = 'standard' AND speed = 'blitz'`, [userId]);
      assert.equal((await pool.query('SELECT error FROM rating_blocked_games WHERE game_id = $1', [blockedId])).rows[0]?.error, 'old block');
      assert.equal((await pool.query('SELECT reason FROM rating_ineligible_games WHERE game_id = $1', [priorSkippedId])).rows[0]?.reason, 'pre_upgrade');
      assert.equal((await pool.query('SELECT 1 FROM rating_ineligible_games WHERE game_id = $1', [pendingId])).rowCount, 0);
      // During a rolling deploy an old applier can still advance the checkpoint after 0046.
      // Its newly skipped endings also need a durable decision before the new applier replays.
      await pool.query(`UPDATE rating_checkpoint SET (xact_id, server_ts, game_id) =
        (SELECT xact_id, server_ts, game_id FROM game_events WHERE game_id = $1 AND type = 'GameEnded')`, [pendingId]);
      assert.equal((await pool.query('SELECT reason FROM rating_ineligible_games WHERE game_id = $1', [pendingId])).rows[0]?.reason, 'pre_upgrade');
      await assert.rejects(pool.query(
        'INSERT INTO rating_ineligible_games (game_id, reason) VALUES ($1, $2)', [blockedId, 'casual'],
      ), /already has a rating decision/);
    });
  } finally {
    through45.cleanup();
  }
});
