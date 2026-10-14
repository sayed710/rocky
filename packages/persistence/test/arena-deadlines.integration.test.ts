import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArenaTournament } from '@chess-platform/tournament';
import { migrate, migrationFiles } from '../src/pg/migrate';
import { PgTournamentsRepository } from '../src/pg/repositories';
import { withTestDatabase } from '../src/test-support/database';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const migrations = resolve('migrations');
// These upgrade fixtures stop at 0048, not at latest minus one. Later additive
// migrations must run too; the 0049 data/projection assertions remain unchanged.
const arenaUpgradeMigrations = migrationFiles(migrations).filter(migration => migration.version >= 49).length;
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

// Insert raw legacy numeric spellings; JSON.stringify(number) would erase the
// very precision/underflow that the real PostgreSQL repository must materialize.
function counterSnapshot(id: string, numbers: Record<string, string>): string {
  const arena = new ArenaTournament({ id, name: 'counter parity', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
  arena.register('A'); arena.start(9_000_000_000_000);
  const snapshot = arena.toSnapshot();
  const state = Object.entries(snapshot.playerStates.A!).map(([field, value]) =>
    `${JSON.stringify(field)}:${numbers[field] ?? JSON.stringify(value)}`).join(',');
  return JSON.stringify(snapshot)
    .replace(`"playerStates":${JSON.stringify(snapshot.playerStates)}`, `"playerStates":{"A":{${state}}}`)
    .replace(`"playedAsWhite":${JSON.stringify(snapshot.playedAsWhite)}`, `"playedAsWhite":{"A":${numbers.playedAsWhite ?? '0'}}`)
    .replace(`"playedAsBlack":${JSON.stringify(snapshot.playedAsBlack)}`, `"playedAsBlack":{"A":${numbers.playedAsBlack ?? '0'}}`);
}

function timingSnapshot(id: string, startedAt: string, duration: string): string {
  return counterSnapshot(id, {})
    .replace('"startedAtMs":9000000000000', `"startedAtMs":${startedAt}`)
    .replace('"durationMs":100', `"durationMs":${duration}`);
}

test('timing projection matches repository JS materialization and canonical safe deadline sum', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const repo = new PgTournamentsRepository(pool);
    // Explicit expected JS results, proven through the real repository read.
    const cases = [
      ['integer', '9000000000000', '1', 9_000_000_000_000, 1, true],
      ['rounded-duration', '9000000000000', '1.00000000000000001', 9_000_000_000_000, 1, true],
      ['duration-underflow', '9000000000000', '1e-400', 9_000_000_000_000, 0, false],
      ['duration-negative-zero', '9000000000000', '-1e-400', 9_000_000_000_000, -0, false],
      ['duration-fractional', '9000000000000', '1.5', 9_000_000_000_000, 1.5, false],
      ['duration-negative', '9000000000000', '-1', 9_000_000_000_000, -1, false],
      ['duration-unsafe', '0', '9007199254740992', 0, Number.MAX_SAFE_INTEGER + 1, false],
      ['duration-overflow', '0', '1e400', 0, Infinity, false],
      ['rounded-start', '9000000000000.00001', '1', 9_000_000_000_000, 1, true],
      ['start-underflow', '1e-400', '100', 0, 100, true],
      ['start-negative-zero', '-1e-400', '100', -0, 100, true],
      ['start-fractional', '1.5', '100', 1.5, 100, false],
      ['start-negative', '-1', '100', -1, 100, false],
      ['start-unsafe', '9007199254740992', '1', Number.MAX_SAFE_INTEGER + 1, 1, false],
      ['start-overflow', '1e400', '1', Infinity, 1, false],
      ['safe-sum', '9007199254740989', '2', Number.MAX_SAFE_INTEGER - 2, 2, true],
      ['rounded-safe-sum', '9007199254740990.4', '1', Number.MAX_SAFE_INTEGER - 1, 1, true],
      ['sum-overflow', '9007199254740991', '1', Number.MAX_SAFE_INTEGER, 1, false],
    ] as const;
    for (const [name, start, duration, expectedStart, expectedDuration, valid] of cases) {
      const id = `timing-${name}`, raw = timingSnapshot(id, start, duration);
      await pool.query("INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,'arena','running',1,$2::jsonb,1)", [id, raw]);
      const read = (await repo.readArena(id))!, stored = read.snapshot;
      assert.ok(Object.is(stored.startedAtMs, expectedStart), `repository startedAt materialization: ${name}`);
      assert.ok(Object.is(stored.config.durationMs, expectedDuration), `repository duration materialization: ${name}`);
      const fresh = new ArenaTournament(stored.config);
      if (valid) { ArenaTournament.restore(stored); fresh.start(stored.startedAtMs!); }
      else {
        assert.throws(() => ArenaTournament.restore(stored), /Invalid persisted Arena deadline/);
        assert.throws(() => fresh.start(stored.startedAtMs!), /Invalid Arena start\/deadline/);
      }
      if (name === 'rounded-duration') assert.equal((await pool.query("SELECT snapshot->'config'->>'durationMs' AS spelling FROM tournaments WHERE id=$1", [id])).rows[0].spelling, duration);
      const deadline = stored.startedAtMs! + stored.config.durationMs;
      const row = (await pool.query('SELECT invalid,pending_launch,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', [id])).rows[0];
      assert.deepEqual(row, { invalid: !valid, pending_launch: false, deadline_ms: valid ? String(deadline) : null }, name);
      assert.equal((await repo.listArenaWorkAfter(null, 100)).includes(id), !valid || deadline <= read.nowMs, 'valid due work differs from invalid repair work');
      assert.equal((await pool.query('SELECT snapshot=$2::jsonb AS unchanged FROM tournaments WHERE id=$1', [id, raw])).rows[0].unchanged, true, 'projection must not normalize legacy timing');
    }
  });
});

test('0049 backfill retains JS-restorable legacy timing and exact converted deadline', { skip }, async () => {
  const earlier = await mkdtemp(join(process.cwd(), '.arena-migrations-'));
  try {
    for (const name of await readdir(migrations)) if (/^\d{4}_.*\.sql$/.test(name) && name < '0049') await copyFile(join(migrations, name), join(earlier, name));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, earlier);
      const id = 'legacy-timing-parity', raw = timingSnapshot(id, '9000000000000.00001', '1.00000000000000001');
      await pool.query("INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,'arena','running',1,$2::jsonb,1)", [id, raw]);
      const repo = new PgTournamentsRepository(pool);
      ArenaTournament.restore((await repo.readArena(id))!.snapshot);
      assert.equal(await migrate(pool, migrations), arenaUpgradeMigrations);
      assert.equal(await migrate(pool, migrations), 0);
      assert.deepEqual((await pool.query('SELECT invalid,pending_launch,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', [id])).rows[0], { invalid: false, pending_launch: false, deadline_ms: '9000000000001' });
      assert.deepEqual(await repo.listArenaWorkAfter(null, 50), []);
      assert.equal((await pool.query('SELECT snapshot=$2::jsonb AS unchanged FROM tournaments WHERE id=$1', [id, raw])).rows[0].unchanged, true);
    });
  } finally { await rm(earlier, { recursive: true, force: true }); }
});

test('participant counter projection matches repository JavaScript rounding and underflow', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const repo = new PgTournamentsRepository(pool);
    const fields = ['points', 'wins', 'draws', 'losses', 'consecutiveWins', 'gamesPlayed', 'playedAsWhite', 'playedAsBlack'];
    const all = (value: string) => Object.fromEntries(fields.map(field => [field, value]));
    const cases = [
      { name: 'integer', numbers: {}, valid: true, points: 0 },
      { name: 'rounded', numbers: { ...all('1.00000000000000001'), gamesPlayed: '3.00000000000000001' }, valid: true, points: 1 },
      { name: 'underflow', numbers: all('1e-400'), valid: true, points: 0 },
      { name: 'negative-underflow', numbers: all('-1e-400'), valid: true, points: -0 },
      { name: 'safe-limit', numbers: { points: '9007199254740991', playedAsWhite: '9007199254740991' }, valid: true, points: Number.MAX_SAFE_INTEGER },
      { name: 'fractional', numbers: { points: '1.5' }, valid: false, points: 1.5 },
      { name: 'negative', numbers: { points: '-1' }, valid: false, points: -1 },
      { name: 'unsafe', numbers: { points: '9007199254740992' }, valid: false, points: Number.MAX_SAFE_INTEGER + 1 },
      { name: 'overflow', numbers: { points: '1e400' }, valid: false, points: Infinity },
      { name: 'colour-fractional', numbers: { playedAsBlack: '1.5' }, valid: false, points: 0 },
      { name: 'inconsistent', numbers: { wins: '1.00000000000000001', gamesPlayed: '2.00000000000000001' }, valid: false, points: 0 },
    ];
    for (const fixture of cases) {
      const id = `counter-${fixture.name}`;
      await pool.query('INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,\'arena\',\'running\',1,$2::jsonb,1)', [id, counterSnapshot(id, fixture.numbers)]);
      const stored = (await repo.readArena(id))!.snapshot;
      assert.ok(Object.is(stored.playerStates.A!.points, fixture.points), `actual repository materialization: ${fixture.name}`);
      if (fixture.valid) ArenaTournament.restore(stored);
      else assert.throws(() => ArenaTournament.restore(stored), /Invalid persisted Arena player state/);
      if (fixture.name === 'rounded') {
        assert.equal(stored.playerStates.A!.gamesPlayed, 3);
        assert.equal(stored.playedAsWhite.A, 1); assert.equal(stored.playedAsBlack.A, 1);
        assert.equal((await pool.query("SELECT snapshot->'playerStates'->'A'->>'points' AS spelling FROM tournaments WHERE id=$1", [id])).rows[0].spelling, '1.00000000000000001');
      }
      const row = (await pool.query('SELECT invalid,pending_launch,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', [id])).rows[0];
      assert.deepEqual(row, { invalid: !fixture.valid, pending_launch: false, deadline_ms: fixture.valid ? '9000000000100' : null }, fixture.name);
      assert.equal((await repo.listArenaWorkAfter(null, 100)).includes(id), !fixture.valid, 'only domain-invalid counters are repair work');
      assert.equal((await pool.query('SELECT snapshot=$2::jsonb AS unchanged FROM tournaments WHERE id=$1', [id, counterSnapshot(id, fixture.numbers)])).rows[0].unchanged, true, 'projection must not normalize the snapshot');
    }
  });
});

test('0049 backfill preserves restorable legacy counter precision without normalization', { skip }, async () => {
  const earlier = await mkdtemp(join(process.cwd(), '.arena-migrations-'));
  try {
    for (const name of await readdir(migrations)) if (/^\d{4}_.*\.sql$/.test(name) && name < '0049') await copyFile(join(migrations, name), join(earlier, name));
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, earlier);
      const raw = counterSnapshot('legacy-counter-parity', { wins: '1.00000000000000001', gamesPlayed: '1.00000000000000001', playedAsWhite: '-1e-400', playedAsBlack: '1e-400' });
      await pool.query("INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ('legacy-counter-parity','legacy','arena','running',1,$1::jsonb,1)", [raw]);
      const repo = new PgTournamentsRepository(pool);
      ArenaTournament.restore((await repo.readArena('legacy-counter-parity'))!.snapshot);
      assert.equal(await migrate(pool, migrations), arenaUpgradeMigrations);
      assert.equal(await migrate(pool, migrations), 0);
      assert.deepEqual((await pool.query('SELECT invalid,pending_launch,deadline_ms FROM arena_deadlines WHERE tournament_id=\'legacy-counter-parity\'')).rows[0], { invalid: false, pending_launch: false, deadline_ms: '9000000000100' });
      assert.deepEqual(await repo.listArenaWorkAfter(null, 50), []);
      assert.equal((await pool.query("SELECT snapshot=$1::jsonb AS unchanged FROM tournaments WHERE id='legacy-counter-parity'", [raw])).rows[0].unchanged, true);
    });
  } finally { await rm(earlier, { recursive: true, force: true }); }
});

test('active pairing corruption is immediate repair even when linked before expiry', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const repo = new PgTournamentsRepository(pool);
    const arena = new ArenaTournament({ id: 'linked', name: 'future', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
    arena.register('A'); arena.register('B'); arena.start(9_000_000_000_000); arena.pairAvailable(9_000_000_000_000);
    arena.register('C');
    const original = arena.toSnapshot(), game = original.activeGames['a:1']!;
    const member = (id: string, value: unknown, sequence: unknown = 1) => ({ activeGames: { [id]: value }, pairingSequence: sequence, gameLinks: [[id, 'linked-game']] });
    const insert = async (id: string, change: Record<string, unknown>) => {
      const snapshot = { ...original, ...change, config: { ...original.config, id } };
      await pool.query('INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,\'arena\',\'running\',3,$2,1)', [id, JSON.stringify(snapshot)]);
      return snapshot;
    };
    // Preserve Number(id.slice(2)) compatibility instead of inventing canonical-ID policy.
    for (const [index, id] of ['a:1', 'a:01', 'a:+1', 'a:1e0', 'a:0x1', 'a:0o1', 'a:0b1', 'a:1.00000000000000001', 'a:\uFEFF1\u00A0'].entries()) {
      const key = `valid-linked-${index}`;
      ArenaTournament.restore(await insert(key, member(id, game)) as never);
      const row = (await pool.query('SELECT invalid,pending_launch FROM arena_deadlines WHERE tournament_id=$1', [key])).rows[0];
      assert.deepEqual(row, { invalid: false, pending_launch: false });
      assert.ok(!(await repo.listArenaWorkAfter(null, 100)).includes(key));
    }
    ArenaTournament.restore(await insert('valid-pending', { gameLinks: [] }) as never);
    assert.deepEqual((await pool.query('SELECT invalid,pending_launch FROM arena_deadlines WHERE tournament_id=$1', ['valid-pending'])).rows[0], { invalid: false, pending_launch: true });
    assert.ok((await repo.listArenaWorkAfter(null, 100)).includes('valid-pending'));
    const corruptions = [
      member('a:1', { ...game, black: game.white }), member('a:1', null), member('a:1', []), member('a:1', {}),
      member('a:1', { ...game, white: 1 }), member('a:1', { ...game, black: 'foreign' }),
      member('a:1', { ...game, launchNamespace: 'unsupported' }), member('a:1', { ...game, launchNamespace: null }),
      member('wrong:1', game), member('a:0', game), member('a:1.5', game), member('a:2', game),
      member('a:9007199254740992', game, Number.MAX_SAFE_INTEGER), member('a:1e100000', game), member('a:1e-100000', game), member('a:1_0', game),
      member('a:1', game, null), member('a:1', game, -1), member('a:1', game, 1.5), member('a:1', game, Number.MAX_SAFE_INTEGER + 1),
      { activeGames: { 'a:1': game, 'a:2': { white: game.white, black: 'C' } }, pairingSequence: 2, gameLinks: [['a:1', 'one'], ['a:2', 'two']] },
    ];
    for (const [index, change] of corruptions.entries()) {
      const key = `bad-pairing-${index}`;
      const snapshot = await insert(key, change);
      assert.throws(() => ArenaTournament.restore(snapshot as never), /Invalid persisted Arena/);
      const row = (await pool.query('SELECT invalid,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', [key])).rows[0];
      assert.deepEqual(row, { invalid: true, deadline_ms: null }, `pairing corruption ${index}`);
      assert.ok((await repo.listArenaWorkAfter(null, 100)).includes(key), 'linked corruption must be repair work without expiry');
    }
  });
});

test('Qodo correction: participant corruption is immediate repair work before future expiry', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrations);
    const repo = new PgTournamentsRepository(pool);
    const arena = new ArenaTournament({ id: 'healthy', name: 'future', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
    arena.register('A'); arena.start(9_000_000_000_000);
    const original = arena.toSnapshot();
    const corruptions = [
      { playerStates: {} }, { participants: null }, { participants: {} }, { participants: ['A', 'A'] },
      { participants: [17] }, { playerStates: [] }, { playerStates: { A: null } }, { playerStates: { A: 'state' } },
      { playerStates: { A: { ...original.playerStates.A, points: -1 } } },
      { playerStates: { A: { ...original.playerStates.A, wins: 1.5 } } },
      { playerStates: { A: { ...original.playerStates.A, draws: '0' } } },
      { playerStates: { A: { ...original.playerStates.A, gamesPlayed: 1 } } },
      { playerStates: { A: { ...original.playerStates.A, consecutiveWins: Number.MAX_SAFE_INTEGER + 1 } } },
      { playerStates: { A: { ...original.playerStates.A, onFire: null } } },
      { playedAsWhite: {} }, { playedAsBlack: { A: -1 } }, { lastOpponents: [] },
      { withdrawn: ['foreign'] }, { withdrawn: null },
    ];
    await repo.save(original, 0);
    for (const [index, corruption] of corruptions.entries()) {
      const id = `corrupt-${index}`;
      const snapshot = { ...original, ...corruption, config: { ...original.config, id } };
      assert.throws(() => ArenaTournament.restore(snapshot as never), /Invalid persisted Arena/);
      // Legacy corruption must bypass the normal repository's participant-count
      // derivation, which cannot represent a null participants container.
      await pool.query('INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ($1,$1,\'arena\',\'running\',1,$2,1)', [id, JSON.stringify(snapshot)]);
      const row = (await pool.query('SELECT invalid,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', [id])).rows[0];
      assert.equal(row.invalid, true, `corruption ${index} must surface immediately`);
      assert.equal(row.deadline_ms, null);
      assert.ok((await repo.listArenaWorkAfter(null, 100)).includes(id), 'worker scan encounters repair without expiry');
    }
    assert.ok(!(await repo.listArenaWorkAfter(null, 100)).includes('healthy'), 'healthy future Arena stays out of repair');
  });
});

test('Qodo correction: 0049 backfills malformed participant and linked pairing repair membership', { skip }, async () => {
  const earlier = await mkdtemp(join(process.cwd(), '.arena-migrations-'));
  try {
    for (const name of await readdir(migrations)) if (/^\d{4}_.*\.sql$/.test(name) && name < '0049') {
      await copyFile(join(migrations, name), join(earlier, name));
    }
    await withTestDatabase(async ({ pool }) => {
      await migrate(pool, earlier);
      const arena = new ArenaTournament({ id: 'legacy-participant', name: 'legacy', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 100 });
      arena.register('A'); arena.start(9_000_000_000_000);
      const snapshot = { ...arena.toSnapshot(), playerStates: {} };
      await new PgTournamentsRepository(pool).save(snapshot, 0);
      arena.register('B'); arena.pairAvailable(9_000_000_000_000);
      const paired = arena.toSnapshot();
      const corruptPairing = { ...paired, config: { ...paired.config, id: 'legacy-pairing' },
        activeGames: { 'a:1': { ...paired.activeGames['a:1']!, white: 'A', black: 'A' } }, gameLinks: [['a:1', 'linked']] };
      assert.throws(() => ArenaTournament.restore(corruptPairing as never), /Invalid persisted Arena pairing/);
      await new PgTournamentsRepository(pool).save(corruptPairing as never, 0);
      assert.equal(await migrate(pool, migrations), arenaUpgradeMigrations);
      assert.equal(await migrate(pool, migrations), 0);
      assert.equal((await pool.query('SELECT invalid FROM arena_deadlines WHERE tournament_id=$1', [arena.config.id])).rows[0].invalid, true);
      assert.equal((await pool.query('SELECT invalid,deadline_ms FROM arena_deadlines WHERE tournament_id=$1', ['legacy-pairing'])).rows[0].invalid, true);
      assert.deepEqual(await new PgTournamentsRepository(pool).listArenaWorkAfter(null, 50), ['legacy-pairing', arena.config.id]);
    });
  } finally { await rm(earlier, { recursive: true, force: true }); }
});

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
      assert.equal(await migrate(pool, migrations), arenaUpgradeMigrations);
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
