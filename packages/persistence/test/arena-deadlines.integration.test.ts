import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArenaTournament } from '@chess-platform/tournament';
import { migrate } from '../src/pg/migrate';
import { PgTournamentsRepository } from '../src/pg/repositories';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const migrations = resolve('migrations');
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

test('0049 backfills proven deadlines, preserves invalid evidence, reruns nothing, and uses work indexes', { skip }, async () => {
  const earlier = await mkdtemp(join(process.cwd(), '.arena-migrations-'));
  try {
    for (const name of await readdir(migrations)) if (/^\d{4}_.*\.sql$/.test(name) && name < '0049') {
      await copyFile(join(migrations, name), join(earlier, name));
    }
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, earlier);
      const repo = new PgTournamentsRepository(pool);
      for (const [id, state] of [['registration', 'registration'], ['running', 'running'], ['finished', 'finished']] as const) {
        const arena = new ArenaTournament({ id, name: id, format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
        if (state !== 'registration') arena.start(1_000);
        if (state === 'finished') arena.settle(1_100);
        await repo.save(arena.toSnapshot(), 0);
      }
      const original = (await repo.findById('running'))!.snapshot;
      for (const [id, override] of [
        ['missing-start', { startedAtMs: null }],
        ['fractional-start', { startedAtMs: 1.5 }],
        ['missing-games', { activeGames: null }],
        ['overflow', { startedAtMs: 9007199254740991 }],
      ] as const) {
        const bad = { ...original, ...override, config: { ...original.config, id } };
        await pool.query('INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,\'arena\',\'running\',0,$2,1)', [id, JSON.stringify(bad)]);
      }
      assert.equal(await migrate(pool, migrations), 1);
      assert.equal(await migrate(pool, migrations), 0);
      assert.deepEqual((await repo.findById('running'))!.snapshot, original);
      const rows = (await pool.query('SELECT * FROM arena_deadlines ORDER BY tournament_id')).rows;
      assert.equal(rows.length, 5);
      assert.equal(rows.find(row => row.tournament_id === 'running').deadline_ms, '1100');
      assert.equal(rows.filter(row => row.invalid).length, 4);
      assert.ok(rows.filter(row => row.invalid).every(row => row.deadline_ms === null));
      // Real planner proof: large mostly-future backlog with just one due Arena.
      await pool.query(`INSERT INTO arena_deadlines (tournament_id, deadline_ms, pending_launch, invalid)
        SELECT id, 9000000000000, false, false FROM tournaments WHERE false`);
      await pool.query(`INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version)
        SELECT 'future-' || i, 'future', 'arena', 'running', 0,
          jsonb_set(jsonb_set($1::jsonb, '{config,id}', to_jsonb('future-' || i)), '{startedAtMs}', '9000000000000'::jsonb), 1
        FROM generate_series(1,2000) i`, [JSON.stringify(original)]);
      await pool.query('ANALYZE arena_deadlines');
      const plan = (await pool.query(`EXPLAIN (FORMAT JSON) SELECT tournament_id FROM arena_deadlines
        WHERE NOT invalid AND deadline_ms <= 1100`)).rows[0]['QUERY PLAN'];
      assert.match(JSON.stringify(plan), /arena_deadlines_due_idx/);
      const workPlan = (await pool.query(`EXPLAIN (FORMAT JSON) SELECT tournament_id FROM (
        SELECT tournament_id FROM arena_deadlines WHERE invalid OR pending_launch UNION
        SELECT tournament_id FROM arena_deadlines WHERE NOT invalid AND deadline_ms <=
          floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
        ) work ORDER BY tournament_id LIMIT 50`)).rows[0]['QUERY PLAN'];
      assert.match(JSON.stringify(workPlan), /arena_deadlines_due_idx/);
      assert.match(JSON.stringify(workPlan), /arena_deadlines_recovery_idx/);
      assert.equal((await repo.listArenaWorkAfter(null, 50)).length, 5);
      await pool.query('DELETE FROM tournaments WHERE id = $1', ['running']);
      assert.equal((await pool.query('SELECT 1 FROM arena_deadlines WHERE tournament_id = $1', ['running'])).rowCount, 0);
    });
  } finally {
    // mkdtemp is rooted in this isolated workspace, never in a shared checkout.
    assert.ok(earlier.startsWith(process.cwd() + '.arena-migrations-') || earlier.startsWith(join(process.cwd(), '.arena-migrations-')));
    await rm(earlier, { recursive: true, force: true });
  }
});
