import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PgRatingsRepository } from '../src/pg/repositories';

test('exact rating batches use one query, exclude malformed IDs, and avoid queries for empty batches', async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const pool = { query: async (sql: string, values: readonly unknown[]) => {
    calls.push({ sql, values }); return { rows: [] };
  } } as unknown as Pool;
  const ratings = new PgRatingsRepository(pool);
  assert.deepEqual(await ratings.getMany([]), []);
  assert.deepEqual(await ratings.getMany([{ userId: 'invalid', variant: 'standard', speed: 'blitz' }]), []);
  assert.equal(calls.length, 0);
  const userId = '00000000-0000-0000-0000-000000000001';
  await ratings.getMany(Array.from({ length: 100 }, () => ({ userId, variant: 'standard', speed: 'blitz' })));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.values, [Array(100).fill(userId), Array(100).fill('standard'), Array(100).fill('blitz')]);
  assert.match(calls[0]!.sql, /r\.user_id = p\.user_id AND r\.variant = p\.variant AND r\.speed = p\.speed/);
});
