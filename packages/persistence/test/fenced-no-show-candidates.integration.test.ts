/**
 * @packageDocumentation
 * Real PostgreSQL integration tests for PgFencedNoShowCandidates (Issue #124 Stage M).
 *
 * Verifies observable database state and contracts:
 * 1. Reschedule with newer loadedHead advances sequence even when deadline is equal-valued.
 * 2. Stale old head dismissal cannot delete a newer row.
 * 3. Stale old head reschedule cannot overwrite deadline or regress sequence of a newer row.
 * 4. Absent row reschedule remains absent (no resurrection).
 * 5. Reschedule with newer different deadline updates due_at and stamps sequence.
 * 6. Keyset pagination and ordering for due query.
 * 7. Mandatory invalid loadedHead rejection contracts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate, migrationsDir } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';
import { PgFencedNoShowCandidates } from '../src/pg/fenced-no-show-candidates';

test('newer head with equal deadline stamps seq and prevents stale dismissal', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const gameId = randomUUID();
    const dueAt = new Date('2026-11-03T18:00:00.000Z');

    // Initial row established at sequence 4
    await pool.query(
      'INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)',
      [gameId, dueAt, 4],
    );

    // Reschedule with equal-valued deadline but newer loadedHead 8
    await candidates.reschedule(gameId, 8, dueAt);

    // Verify observable DB state: seq must advance to 8
    const updatedRows = (await pool.query<{ game_id: string; due_at: Date; seq: number }>(
      'SELECT game_id, due_at, seq FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rows;
    assert.equal(updatedRows.length, 1);
    assert.equal(updatedRows[0]!.seq, 8, 'seq must be stamped with newer loadedHead 8');
    assert.equal(updatedRows[0]!.due_at.toISOString(), dueAt.toISOString());

    // Stale worker at old head 4 attempts dismissal: must not delete the replacement row
    await candidates.dismiss(gameId, 4);

    const afterStaleDismiss = (await pool.query<{ game_id: string; seq: number }>(
      'SELECT game_id, seq FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rows;
    assert.equal(afterStaleDismiss.length, 1, 'stale old head dismissal cannot delete row with seq 8');
    assert.equal(afterStaleDismiss[0]!.seq, 8);

    // Dismissal at or above loadedHead 8 successfully deletes the row
    await candidates.dismiss(gameId, 8);

    const afterValidDismiss = (await pool.query(
      'SELECT 1 FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rowCount;
    assert.equal(afterValidDismiss, 0, 'current loadedHead dismissal deletes row');
  });
});

test('stale old head dismissal cannot delete newer row', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const gameId = randomUUID();
    const dueAt = new Date('2026-11-03T18:00:00.000Z');

    // Row established at sequence 10
    await pool.query(
      'INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)',
      [gameId, dueAt, 10],
    );

    // Dismissal attempt with stale head 5
    await candidates.dismiss(gameId, 5);

    const rows = (await pool.query<{ game_id: string; seq: number }>(
      'SELECT game_id, seq FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.seq, 10, 'row remains intact when loadedHead < row.seq');

    // Dismissal attempt with exact head 10 deletes
    await candidates.dismiss(gameId, 10);

    const remaining = (await pool.query(
      'SELECT 1 FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rowCount;
    assert.equal(remaining, 0);
  });
});

test('stale old head reschedule cannot modify newer row or regress sequence', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const gameId = randomUUID();
    const newerDueAt = new Date('2026-11-03T19:00:00.000Z');
    const staleDueAt = new Date('2026-11-03T17:00:00.000Z');

    // Row established at sequence 10 with newer deadline
    await pool.query(
      'INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)',
      [gameId, newerDueAt, 10],
    );

    // Stale worker at head 5 attempts reschedule
    await candidates.reschedule(gameId, 5, staleDueAt);

    // Verify row state in DB: unmodified
    const rows = (await pool.query<{ game_id: string; due_at: Date; seq: number }>(
      'SELECT game_id, due_at, seq FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.seq, 10, 'seq must not regress');
    assert.equal(rows[0]!.due_at.toISOString(), newerDueAt.toISOString(), 'due_at must not change');
  });
});

test('absent row reschedule remains absent and never resurrects', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const absentGameId = randomUUID();
    const dueAt = new Date('2026-11-03T18:00:00.000Z');

    const before = (await pool.query(
      'SELECT 1 FROM pregame_deadlines WHERE game_id = $1',
      [absentGameId],
    )).rowCount;
    assert.equal(before, 0);

    // Attempt reschedule on non-existent row
    await candidates.reschedule(absentGameId, 8, dueAt);

    const after = (await pool.query(
      'SELECT 1 FROM pregame_deadlines WHERE game_id = $1',
      [absentGameId],
    )).rowCount;
    assert.equal(after, 0, 'absent row must not be resurrected');
  });
});

test('reschedule with newer different deadline updates due_at and stamps sequence', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const gameId = randomUUID();
    const initialDueAt = new Date('2026-11-03T18:00:00.000Z');
    const updatedDueAt = new Date('2026-11-03T18:10:00.000Z');

    // Row established at sequence 2
    await pool.query(
      'INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)',
      [gameId, initialDueAt, 2],
    );

    // Reschedule with newer loadedHead 6 and differing deadline
    await candidates.reschedule(gameId, 6, updatedDueAt);

    const rows = (await pool.query<{ game_id: string; due_at: Date; seq: number }>(
      'SELECT game_id, due_at, seq FROM pregame_deadlines WHERE game_id = $1',
      [gameId],
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.seq, 6, 'seq must advance to 6');
    assert.equal(rows[0]!.due_at.toISOString(), updatedDueAt.toISOString(), 'due_at must be updated');
  });
});

test('due query observes candidates keyset-ordered by deadline', async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const candidates = new PgFencedNoShowCandidates(pool);

    const g1 = randomUUID();
    const g2 = randomUUID();
    const d1 = new Date('2026-11-03T18:00:00.000Z');
    const d2 = new Date('2026-11-03T18:05:00.000Z');

    await pool.query('INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)', [g1, d1, 1]);
    await pool.query('INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES ($1, $2, $3)', [g2, d2, 2]);

    const page1 = await candidates.due({ dueBy: d1, after: null, limit: 10 });
    assert.equal(page1.length, 1);
    assert.equal(page1[0]!.gameId, g1);

    const pageAll = await candidates.due({ dueBy: d2, after: null, limit: 10 });
    assert.equal(pageAll.length, 2);
    assert.equal(pageAll[0]!.gameId, g1);
    assert.equal(pageAll[1]!.gameId, g2);

    await candidates.dismiss(g1, 1);

    const pageRemaining = await candidates.due({ dueBy: d2, after: null, limit: 10 });
    assert.equal(pageRemaining.length, 1);
    assert.equal(pageRemaining[0]!.gameId, g2);
  });
});

test('mandatory invalid loadedHead rejection contracts', async () => {
  await withTestDatabase(async ({ pool }) => {
    const candidates = new PgFencedNoShowCandidates(pool);
    const gameId = randomUUID();
    const dueAt = new Date();

    await assert.rejects(() => candidates.dismiss(gameId, -1), RangeError);
    await assert.rejects(() => candidates.dismiss(gameId, 1.5), RangeError);
    await assert.rejects(() => candidates.dismiss(gameId, Number.NaN), RangeError);
    await assert.rejects(() => candidates.dismiss(gameId, Number.MAX_SAFE_INTEGER + 1), RangeError);

    await assert.rejects(() => candidates.reschedule(gameId, -1, dueAt), RangeError);
    await assert.rejects(() => candidates.reschedule(gameId, 1.5, dueAt), RangeError);
    await assert.rejects(() => candidates.reschedule(gameId, Number.NaN, dueAt), RangeError);
    await assert.rejects(() => candidates.reschedule(gameId, Number.MAX_SAFE_INTEGER + 1, dueAt), RangeError);
  });
});
