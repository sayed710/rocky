/** Safe operator inspection and disposition of sticky rating blocks against PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { migrate } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';
import { uuidv7 } from '../src/ids';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const migrations = join(process.cwd(), 'migrations');
const cli = join(process.cwd(), 'dist-test', 'src', 'pg', 'ratings-blocks-cli.js');

test('operator CLI lists, inspects and deliberately retains a blocked game without unblocking it', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, migrations);
    const gameId = uuidv7();
    await pool.query('INSERT INTO rating_blocked_games (game_id, error) VALUES ($1, $2)', [gameId, 'unknown termination']);
    const run = (...args: string[]): unknown => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connectionString }, encoding: 'utf8',
    }));

    const listed = run('list') as { games: { gameId: string }[] };
    assert.deepEqual(listed.games.map((game) => game.gameId), [gameId]);
    const detail = run('show', gameId) as { error: string; blockedAt: string; recovery: string };
    assert.equal(detail.error, 'unknown termination');
    assert.ok(detail.blockedAt);
    assert.match(detail.recovery, /entire.*pool/i);

    const decided = run('leave-blocked', gameId, 'review-operator', 'historical replay would reorder later games') as {
      disposition: string; dispositionBy: string; dispositionReason: string; dispositionAt: string;
    };
    assert.equal(decided.disposition, 'leave_blocked');
    assert.equal(decided.dispositionBy, 'review-operator');
    assert.equal(decided.dispositionReason, 'historical replay would reorder later games');
    assert.ok(decided.dispositionAt);
    assert.throws(() => run('leave-blocked', gameId, 'another-operator', 'retry'), /Command failed/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rating_blocked_games WHERE game_id = $1', [gameId])).rows[0]!.n, 1);
  });
});
