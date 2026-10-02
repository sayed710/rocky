import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PgRatingsRepository } from '../src/pg/repositories';
import { migrate, migrationsDir } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';

test('PostgreSQL batch reads preserve complete pool keys, deduplicate, and omit absent/deleted users', {
  skip: process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set',
}, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const userId = randomUUID();
    const otherId = randomUUID();
    for (const id of [userId, otherId]) await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [id, `batch_${id.slice(-12)}`]);
    for (const [id, variant, speed, rating] of [
      [userId, 'standard', 'blitz', 1842], [userId, 'standard', 'rapid', 2138],
      [userId, 'atomic', 'blitz', 1293], [otherId, 'atomic', 'rapid', 2777],
    ]) await pool.query('INSERT INTO ratings (user_id, variant, speed, rating, rd, vol) VALUES ($1, $2, $3, $4, 80, 0.06)', [id, variant, speed, rating]);
    const ratings = new PgRatingsRepository(pool);
    const keys = [
      { userId, variant: 'standard', speed: 'blitz' },
      { userId, variant: 'standard', speed: 'rapid' },
      { userId, variant: 'atomic', speed: 'blitz' },
      { userId, variant: 'atomic', speed: 'rapid' },
      { userId: otherId, variant: 'standard', speed: 'blitz' },
    ] as const;
    const result = await ratings.getMany([...keys, keys[0]]);
    assert.deepEqual(result.map((r) => [r.userId, r.variant, r.speed, r.rating]).sort(), [
      [userId, 'standard', 'blitz', 1842], [userId, 'standard', 'rapid', 2138], [userId, 'atomic', 'blitz', 1293],
    ].sort());
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    assert.deepEqual(await ratings.getMany(keys), []);
  });
});
