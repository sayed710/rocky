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
      const future = new ArenaTournament({ id: 'malformed-link', name: 'future', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
      future.register('A'); future.register('B'); future.start(9_000_000_000_000); future.pairAvailable(9_000_000_000_000);
      await repo.save({ ...future.toSnapshot(), gameLinks: [['a:1', null]] } as never, 0);
      const malformedLinks = [null, 'a:1', ['a:1'], ['a:1', 'game', 'extra'], ['foreign', 'game'], ['a:1', 17], ['a:1', {}]];
      for (const [index, link] of malformedLinks.entries()) {
        const id = `malformed-tuple-${index}`;
        await repo.save({ ...future.toSnapshot(), config: { ...future.config, id }, gameLinks: [link] } as never, 0);
      }
      await repo.save({ ...future.toSnapshot(), config: { ...future.config, id: 'duplicate-links' },
        gameLinks: [['a:1', 'game'], ['a:1', 'game']] } as never, 0);
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
      assert.equal(rows.length, 14);
      assert.equal(rows.find(row => row.tournament_id === 'running').deadline_ms, '1100');
      assert.equal(rows.filter(row => row.invalid).length, 13);
      assert.equal(rows.find(row => row.tournament_id === 'malformed-link').invalid, true, 'malformed link must not hide future recovery/repair work');
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
      assert.equal((await repo.listArenaWorkAfter(null, 50)).length, 14);
      await pool.query('DELETE FROM tournaments WHERE id = $1', ['running']);
      assert.equal((await pool.query('SELECT 1 FROM arena_deadlines WHERE tournament_id = $1', ['running'])).rowCount, 0);
    });
  } finally {
    // mkdtemp is rooted in this isolated workspace, never in a shared checkout.
    assert.ok(earlier.startsWith(process.cwd() + '.arena-migrations-') || earlier.startsWith(join(process.cwd(), '.arena-migrations-')));
    await rm(earlier, { recursive: true, force: true });
  }
});

test('production keyset query limits both branches before sorting a dense due backlog', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const arena = new ArenaTournament({ id: 'seed', name: 'seed', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
    arena.start(1_000);
    await pool.query(`INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version)
      SELECT 'due-' || lpad(i::text,4,'0'), 'due', 'arena', 'running', 0,
        jsonb_set($1::jsonb, '{config,id}', to_jsonb('due-' || lpad(i::text,4,'0'))), 1
      FROM generate_series(1,2000) i`, [JSON.stringify(arena.toSnapshot())]);
    await pool.query('ANALYZE arena_deadlines');
    let query = '';
    let parameters: unknown[] = [];
    const observed = new Proxy(pool, { get(target, property) {
      if (property === 'query') return (text: string, values: unknown[]) => {
        query = text; parameters = values;
        return target.query(text, values);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const repo = new PgTournamentsRepository(observed);
    for (const cursor of [null, 'due-1500']) {
      const ids = await repo.listArenaWorkAfter(cursor, 50, undefined, await repo.arenaWorkCeiling());
      assert.equal(ids.length, 50);
      assert.equal(ids[0], cursor ? 'due-1501' : 'due-0001');
      const plan = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, parameters)).rows[0]['QUERY PLAN'][0].Plan;
      const nodes: Record<string, unknown>[] = [];
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node['Plans'] ?? []) as Record<string, unknown>[]) walk(child);
      };
      walk(plan);
      const limits = nodes.filter(node => node['Node Type'] === 'Limit');
      assert.ok(limits.length >= 3, 'both UNION inputs and the output must be limited');
      assert.ok(nodes.filter(node => node['Node Type'] === 'Sort').every(node => Number(node['Actual Rows']) <= 100));
      assert.match(JSON.stringify(plan), /arena_deadlines_pkey/);
    }
    assert.equal(await repo.arenaWorkCeiling(), '2000');
  });
});
