import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate, PgTournamentsRepository, PostgresEventStore } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { ArenaTournament } from '@chess-platform/tournament';
import { VersionConflictError } from '@chess-platform/persistence';
import { ArenaService } from '../src/tournament/arena.service';
import { ArenaDeadlineWorker } from '../src/tournament/arena-deadline-worker';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { TournamentService } from '../src/tournament/service';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;
const players = ['00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-00000000000b',
  '00000000-0000-7000-8000-00000000000c', '00000000-0000-7000-8000-00000000000d'];

/** Only these test pools resolve clock_timestamp/statement_timestamp to a controlled
 * PostgreSQL function. Both replicas still query the database over separate connections;
 * no application clock/repository method is mocked. No sleeps or timing tolerances. */
async function fixture(run: (r: {
  a: ArenaService; b: ArenaService; ra: PgTournamentsRepository; rb: PgTournamentsRepository;
  pool: Pool; events: PostgresEventStore; launcher: DurableGameLauncher; at: (ms: number) => Promise<void>;
}) => Promise<void>) {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    await pool.query(`CREATE SCHEMA arena_clock;
      CREATE TABLE arena_clock.time (ms bigint NOT NULL);
      INSERT INTO arena_clock.time VALUES (1000);
      CREATE FUNCTION arena_clock.clock_timestamp() RETURNS timestamptz LANGUAGE SQL AS
        'SELECT timestamptz ''epoch'' + ms * interval ''1 millisecond'' FROM arena_clock.time';
      CREATE FUNCTION arena_clock.statement_timestamp() RETURNS timestamptz LANGUAGE SQL AS
        'SELECT arena_clock.clock_timestamp()';`);
    const pa = new Pool({ connectionString, options: '-c search_path=arena_clock,public,pg_catalog' });
    const pb = new Pool({ connectionString, options: '-c search_path=arena_clock,public,pg_catalog' });
    try {
      const ra = new PgTournamentsRepository(pa), rb = new PgTournamentsRepository(pb);
      const events = new PostgresEventStore(pool);
      const launcher = new DurableGameLauncher(events, { now: () => 1_000 });
      const a = new ArenaService(ra, launcher, () => 1_801_000);
      const b = new ArenaService(rb, new DurableGameLauncher(events, { now: () => 1_000 }), () => -1_799_000);
      await run({ a, b, ra, rb, pool, events, launcher,
        at: async ms => { await pool.query('UPDATE arena_clock.time SET ms = $1', [ms]); } });
    } finally { await pa.end(); await pb.end(); }
  });
}

async function create(a: ArenaService, id = 'arena', count = 2) {
  await a.create({ id, name: id, variant: 'standard', timeControl: TC, durationMs: 100 });
  for (const player of players.slice(0, count)) await a.register(id, player);
}

test('production PostgreSQL clock establishes start independently of process clocks', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const repo = new PgTournamentsRepository(pool);
    const arena = new ArenaService(repo, { launch: async () => { throw new Error('unexpected launch'); } }, () => -1);
    await arena.create({ id: 'idle', name: 'idle', variant: 'standard', timeControl: TC, durationMs: 3_600_000 });
    const lower = Number((await pool.query('SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint AS ms')).rows[0].ms);
    await arena.start('idle', 0);
    const upper = Number((await pool.query('SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint AS ms')).rows[0].ms);
    const snapshot = (await arena.load('idle')).toSnapshot();
    assert.ok(snapshot.startedAtMs! >= lower && snapshot.startedAtMs! <= upper);
    const deadline = (await pool.query('SELECT deadline_ms FROM arena_deadlines')).rows[0].deadline_ms;
    assert.equal(Number(deadline), snapshot.startedAtMs! + 3_600_000);
  });
});

test('opposite-clock replicas and workers cannot finish idle Arena before T', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 0); await Promise.all([r.a.start('arena'), r.b.start('arena')]);
  await r.at(1_099);
  assert.equal((await r.a.getTournament('arena')).getState(), 'running');
  assert.equal((await r.b.getTournament('arena')).getState(), 'running');
  assert.deepEqual(await new ArenaDeadlineWorker(r.ra, r.a).runPass(), { scanned: 0, failed: 0 });
  await r.at(1_100);
  await Promise.all([new ArenaDeadlineWorker(r.ra, r.a).runPass(), new ArenaDeadlineWorker(r.rb, r.b).runPass()]);
  assert.equal((await r.b.load('arena')).getState(), 'finished');
  assert.equal((await r.rb.findById('arena'))!.version, 3);
}));

test('real database time failure never falls back to fast or slow process time', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 0); await r.a.start('arena');
  const before = await r.ra.findById('arena');
  await r.pool.query(`CREATE OR REPLACE FUNCTION arena_clock.clock_timestamp() RETURNS timestamptz LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'authority clock unavailable'; END; $$;`);
  await assert.rejects(r.a.getTournament('arena'), /authority clock unavailable/);
  await assert.rejects(r.b.register('arena', players[0]!), /authority clock unavailable/);
  assert.deepEqual(await r.rb.findById('arena'), before);
  assert.equal((await r.pool.query('SELECT count(*)::int AS n FROM arena_deadlines')).rows[0].n, 1);
  await r.pool.query(`CREATE OR REPLACE FUNCTION arena_clock.clock_timestamp() RETURNS timestamptz LANGUAGE SQL AS
    'SELECT NULL::timestamptz';`);
  await assert.rejects(r.a.getTournament('arena'), /database time/);
  assert.deepEqual(await r.rb.findById('arena'), before);
}));

test('lost response after authoritative start commit recovers the same deadline and one game', { skip }, async () => fixture(async r => {
  await create(r.a);
  const mutate = r.ra.mutateArena.bind(r.ra);
  let interrupted = false;
  r.ra.mutateArena = async (...args) => {
    const snapshot = await mutate(...args);
    if (!interrupted) { interrupted = true; throw new Error('response lost after tournament commit'); }
    return snapshot;
  };
  await assert.rejects(r.a.start('arena'), /response lost/);
  assert.equal((await r.b.load('arena')).toSnapshot().startedAtMs, 1_000);
  await r.at(1_101);
  await r.b.start('arena', 777);
  const recovered = (await r.b.load('arena')).toSnapshot();
  assert.equal(recovered.startedAtMs, 1_000);
  assert.equal(recovered.pairingSequence, 1);
  assert.equal(recovered.gameLinks!.length, 1);
  assert.equal((await r.pool.query("SELECT count(*)::int AS n FROM game_events WHERE type = 'GameCreated'")).rows[0].n, 1);
}));

test('malformed row/snapshot and active-game state retain evidence and cannot falsely finish', { skip }, async () => fixture(async r => {
  await create(r.a, 'healthy', 0); await r.a.start('healthy');
  const snapshot = (await r.a.load('healthy')).toSnapshot();
  const bad = { ...snapshot, config: { ...snapshot.config, id: 'aaa-bad' }, activeGames: null };
  await r.pool.query("INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ('aaa-bad','bad','arena','running',0,$1,1)", [JSON.stringify(bad)]);
  const mismatched = { ...snapshot, config: { ...snapshot.config, id: 'aaa-mismatch' } };
  await r.pool.query("INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version) VALUES ('aaa-mismatch','bad','arena','registration',0,$1,1)", [JSON.stringify(mismatched)]);
  await r.at(1_100);
  assert.deepEqual(await new ArenaDeadlineWorker(r.ra, r.a).runPass(), { scanned: 3, failed: 2 });
  const stored = await r.rb.findById('aaa-bad');
  assert.equal(stored!.version, 1); assert.equal(stored!.snapshot.state, 'running');
  assert.equal((await r.pool.query("SELECT invalid FROM arena_deadlines WHERE tournament_id = 'aaa-bad'")).rows[0].invalid, true);
  const mismatch = (await r.rb.findById('aaa-mismatch'))!;
  assert.equal(mismatch.version, 1);
  assert.equal((await r.pool.query("SELECT state FROM tournaments WHERE id = 'aaa-mismatch'")).rows[0].state, 'registration');
  assert.equal((await r.pool.query("SELECT invalid FROM arena_deadlines WHERE tournament_id = 'aaa-mismatch'")).rows[0].invalid, true);
  assert.equal((await r.b.load('healthy')).getState(), 'finished');
}));

for (const delta of [-1, 0, 1]) {
  for (const outcome of ['white_win', '*'] as const) {
    test(`real two-replica result/abandon at T${delta} converges`, { skip }, async () => fixture(async r => {
      await create(r.a);
      await Promise.all([r.a.start('arena', 0), r.b.start('arena', 9_999)]);
      const start = (await r.a.load('arena')).toSnapshot();
      assert.equal(start.startedAtMs, 1_000);
      assert.equal(start.gameLinks!.length, 1);
      await r.at(1_100 + delta);
      await r.b.start('arena', 99_999);
      assert.equal((await r.a.load('arena')).toSnapshot().startedAtMs, 1_000, 'response-loss retry never restarts the Arena');
      const gameId = start.gameLinks![0]![1];
      await Promise.all([r.a.recordCommittedOutcome('arena', gameId, outcome),
        r.b.recordCommittedOutcome('arena', gameId, outcome),
        new ArenaDeadlineWorker(r.rb, r.b).runPass()]);
      const snapshot = (await r.a.load('arena')).toSnapshot();
      assert.deepEqual((await r.b.load('arena')).toSnapshot(), snapshot);
      assert.equal(snapshot.state, delta < 0 ? 'running' : 'finished');
      assert.equal(snapshot.pairingSequence, delta < 0 ? 2 : 1);
      assert.equal((await r.pool.query('SELECT count(*)::int AS n FROM game_events WHERE type = $1', ['GameCreated'])).rows[0].n,
        delta < 0 ? 2 : 1);
      assert.equal((await r.pool.query('SELECT count(*)::int AS n FROM arena_deadlines')).rows[0].n, delta < 0 ? 1 : 0);
    }));
  }
}

test('two PostgreSQL workers settle once, skip poison rows and catch up after restart', { skip }, async () => fixture(async r => {
  for (const id of ['healthy-a', 'healthy-b']) { await create(r.a, id, 0); await r.a.start(id); }
  await r.pool.query(`INSERT INTO tournaments (id,name,format,state,participant_count,snapshot,version)
    VALUES ('aaa-poison','bad','arena','running',0,'{"config":{"id":"aaa-poison","format":"arena","durationMs":100},"state":"running"}',1)`);
  await r.at(1_100);
  const wa = new ArenaDeadlineWorker(r.ra, r.a, { pageSize: 1 });
  const wb = new ArenaDeadlineWorker(r.rb, r.b, { pageSize: 1 });
  for (let i = 0; i < 3; i++) await Promise.all([wa.runPass(), wb.runPass()]);
  for (const id of ['healthy-a', 'healthy-b']) {
    assert.equal((await r.a.load(id)).getState(), 'finished');
    assert.equal((await r.ra.findById(id))!.version, 3, 'one start and exactly one settlement');
  }
  const rows = (await r.pool.query('SELECT * FROM arena_deadlines')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invalid, true);
  assert.deepEqual(await new ArenaDeadlineWorker(r.ra, r.a).runPass(), { scanned: 1, failed: 1 });
  await create(r.a, 'healthy-c', 0); await r.a.start('healthy-c');
  await r.at(1_200);
  assert.deepEqual(await new ArenaDeadlineWorker(r.ra, r.a).runPass(), { scanned: 2, failed: 1 });
  assert.equal((await r.a.load('healthy-c')).getState(), 'finished');
}));

test('write-time deadline guard rolls back late authorization and retries with fresh database time', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 0); await r.a.start('arena');
  await r.a.register('arena', players[0]!);
  await r.pool.query(`CREATE SEQUENCE arena_clock.ticks START WITH 1099;
    CREATE OR REPLACE FUNCTION arena_clock.clock_timestamp() RETURNS timestamptz LANGUAGE SQL AS
      'SELECT timestamptz ''epoch'' + nextval(''arena_clock.ticks'') * interval ''1 millisecond''';`);
  await r.b.register('arena', players[1]!);
  const snapshot = (await r.a.load('arena')).toSnapshot();
  assert.equal(snapshot.state, 'finished');
  assert.equal(snapshot.pairingSequence, 0, 'authorization sampled before deadline must still be refused when its write is late');
  assert.equal(snapshot.participants.length, 2, 'registration is preserved by the fresh retry');
  assert.equal((await r.pool.query("SELECT count(*)::int AS n FROM game_events WHERE type = 'GameCreated'")).rows[0].n, 0);
}));

test('two different results race worker settlement and survive service replay', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 4); await r.a.start('arena');
  const links = (await r.a.load('arena')).toSnapshot().gameLinks!;
  await r.at(1_100);
  await Promise.all([r.a.recordCommittedOutcome('arena', links[0]![1], 'white_win'),
    r.b.recordCommittedOutcome('arena', links[1]![1], 'black_win'),
    new ArenaDeadlineWorker(r.ra, r.a).runPass()]);
  const snapshot = (await r.b.load('arena')).toSnapshot();
  assert.equal(snapshot.state, 'finished');
  assert.deepEqual(Object.values(snapshot.playerStates).map(s => s.gamesPlayed), [1, 1, 1, 1]);
  await r.b.recordCommittedOutcome('arena', links[0]![1], 'white_win');
  assert.deepEqual((await r.a.load('arena')).toSnapshot(), snapshot);
}));

test('row lock wait crosses deadline; time is read after acquisition and stale saves fail', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 0); await r.a.start('arena');
  await r.a.register('arena', players[0]!);
  const stale = (await r.ra.findById('arena'))!;
  const lock = await r.pool.connect();
  await lock.query('BEGIN');
  await lock.query("SELECT id FROM tournaments WHERE id = 'arena' FOR UPDATE");
  try {
    const waiting = r.b.register('arena', players[1]!);
    // Observe a real blocked second connection, without sleeping or guessing elapsed time.
    let blocked = false;
    for (let probe = 0; probe < 200 && !blocked; probe++) {
      blocked = (await r.pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%tournaments%FOR UPDATE%') AS blocked")).rows[0].blocked;
    }
    assert.equal(blocked, true);
    await r.at(1_100);
    await lock.query('COMMIT');
    await waiting;
    assert.equal((await r.a.load('arena')).toSnapshot().pairingSequence, 0);
    await assert.rejects(r.ra.save(stale.snapshot, stale.version), VersionConflictError);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
}));

test('rollback before commit preserves due work for restarted worker', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 0); await r.a.start('arena');
  const before = (await r.ra.findById('arena'))!;
  await r.at(1_100);
  await assert.rejects(r.ra.mutateArena('arena', (snapshot, now) => {
    const arena = ArenaTournament.restore(snapshot); arena.settle(now);
    throw new Error('crash before commit');
  }), /crash before commit/);
  assert.deepEqual(await r.ra.findById('arena'), before);
  assert.deepEqual(await r.ra.listArenaWorkAfter(null, 50), ['arena']);
  await new ArenaDeadlineWorker(r.rb, r.b).runPass();
  assert.equal((await r.b.load('arena')).getState(), 'finished');
  assert.deepEqual(await r.ra.listArenaWorkAfter(null, 50), []);
}));

test('committed results survive reporter restart and race expiry worker on separate connections', { skip }, async () => fixture(async r => {
  await create(r.a, 'arena', 4); await r.a.start('arena');
  const links = (await r.a.load('arena')).toSnapshot().gameLinks!;
  for (const [index, [, gameId]] of links.entries()) {
    const stored = await r.events.load(gameId);
    await r.events.append(gameId, stored.at(-1)!.seq, [{ type: 'GameEnded', at: 1_100,
      result: index === 0 ? '1-0' : '0-1', termination: 'resignation', winner: index === 0 ? 'w' : 'b' }]);
  }
  await r.at(1_100);
  const reporter = () => new TournamentResultReporter(new InMemoryPubSub(), r.rb,
    new TournamentService(r.rb, r.launcher), r.b, r.events, { scanIntervalMs: 0 });
  const first = reporter();
  await Promise.all([first.scan(), new ArenaDeadlineWorker(r.ra, r.a).runPass()]);
  first.stop();
  const snapshot = (await r.a.load('arena')).toSnapshot();
  assert.equal(snapshot.state, 'finished');
  assert.deepEqual(Object.values(snapshot.playerStates).map(p => p.gamesPlayed), [1, 1, 1, 1]);
  const restarted = reporter(); await restarted.start(); restarted.stop();
  assert.deepEqual((await r.b.load('arena')).toSnapshot(), snapshot);
}));

for (const result of ['*', '1-0'] as const) test(`committed pairing survives crash after game creation and terminal ${result} before link recovery`, { skip }, async () => fixture(async r => {
  await create(r.a);
  const crashing = new ArenaService(r.ra, { launch: async input => {
    await r.launcher.launch(input); throw new Error('response lost after game commit');
  } }, () => -1);
  await assert.rejects(crashing.start('arena'), /response lost/);
  const authorized = (await r.a.load('arena')).toSnapshot();
  assert.equal(authorized.startedAtMs, 1_000);
  assert.equal(authorized.gameLinks!.length, 0);
  const rows = (await r.pool.query("SELECT game_id FROM game_events WHERE type = 'GameCreated'")).rows;
  assert.equal(rows.length, 1);
  const gameId = rows[0].game_id;
  const stored = await r.events.load(gameId);
  await r.events.append(gameId, stored.at(-1)!.seq, [{ type: 'GameEnded', at: 1_101, result,
    termination: result === '*' ? 'aborted' : 'resignation', winner: result === '*' ? null : 'w' }]);
  await r.at(1_101);
  await new ArenaDeadlineWorker(r.rb, r.b).runPass();
  assert.equal((await r.b.load('arena')).toSnapshot().gameLinks!.length, 0, 'ended recovery never relinks as playable');
  const reporter = new TournamentResultReporter(new InMemoryPubSub(), r.ra, new TournamentService(r.ra, r.launcher), r.a, r.events, { scanIntervalMs: 0 });
  await reporter.scan(); reporter.stop();
  assert.equal((await r.a.load('arena')).getState(), 'finished');
  assert.deepEqual(Object.values((await r.a.load('arena')).toSnapshot().playerStates).map(p => p.gamesPlayed),
    result === '*' ? [0, 0] : [1, 1]);
  assert.equal((await r.pool.query("SELECT count(*)::int AS n FROM game_events WHERE type = 'GameCreated'")).rows[0].n, 1);
}));

for (const ended of [false, true]) test(`legacy unlinked pairing ${ended ? 'refuses ambiguous ended slot' : 'recovers live slot and counts reporter result'}`, { skip }, async () => fixture(async r => {
  await create(r.a);
  const stored = (await r.ra.findById('arena'))!;
  const legacy = ArenaTournament.restore(stored.snapshot as ReturnType<ArenaTournament['toSnapshot']>);
  legacy.start(1_000); legacy.pairAvailable(1_000);
  const snapshot = legacy.toSnapshot();
  const pairing = snapshot.activeGames['a:1']!;
  const { gameId } = await r.launcher.launch({ tournamentId: 'arena', matchId: 'a:1',
    white: pairing.white, black: pairing.black, variant: 'standard', timeControl: TC, attempt: 0 });
  if (ended) {
    const events = await r.events.load(gameId);
    await r.events.append(gameId, events.at(-1)!.seq, [{ type: 'GameEnded', at: 1_100,
      result: '1-0', termination: 'resignation', winner: 'w' }]);
  }
  // A legacy authorization has no namespace; no upgraded process may infer one.
  await r.ra.save({ ...snapshot, activeGames: { 'a:1': { white: pairing.white, black: pairing.black } } }, stored.version);
  const before = (await r.ra.findById('arena'))!;
  await r.at(1_100);
  assert.deepEqual(await new ArenaDeadlineWorker(r.rb, r.b).runPass(), { scanned: 1, failed: ended ? 1 : 0 });
  if (ended) {
    assert.deepEqual(await r.ra.findById('arena'), before, 'ambiguous legacy outcome never changes authorization or score');
    await assert.rejects(r.b.reconcile('arena'), /operator repair required/);
  } else {
    assert.equal((await r.b.load('arena')).gameIdFor('a:1'), gameId);
    const events = await r.events.load(gameId);
    await r.events.append(gameId, events.at(-1)!.seq, [{ type: 'GameEnded', at: 1_101,
      result: '1-0', termination: 'resignation', winner: 'w' }]);
    const reporter = new TournamentResultReporter(new InMemoryPubSub(), r.ra,
      new TournamentService(r.ra, r.launcher), r.a, r.events, { scanIntervalMs: 0 });
    await reporter.scan(); reporter.stop();
    const final = (await r.a.load('arena')).toSnapshot();
    assert.equal(final.state, 'finished');
    assert.deepEqual(Object.values(final.playerStates).map(p => p.gamesPlayed), [1, 1]);
  }
  assert.equal((await r.pool.query("SELECT count(*)::int AS n FROM game_events WHERE type = 'GameCreated'")).rows[0].n, 1);
}));

test('new committed authorization cannot consume a legacy ended orphan in the same slot', { skip }, async () => fixture(async r => {
  await create(r.a);
  const old = ArenaTournament.restore((await r.ra.findById('arena'))!.snapshot as ReturnType<ArenaTournament['toSnapshot']>);
  old.start(1_000); old.pairAvailable(1_000);
  const p = old.toSnapshot().activeGames['a:1']!;
  const orphan = await r.launcher.launch({ tournamentId: 'arena', matchId: 'a:1', white: p.white, black: p.black,
    variant: 'standard', timeControl: TC, attempt: 0 });
  const events = await r.events.load(orphan.gameId);
  await r.events.append(orphan.gameId, events.at(-1)!.seq, [{ type: 'GameEnded', at: 1_000,
    result: '1-0', termination: 'resignation', winner: 'w' }]);
  // Simulate the old launch-before-CAS loser: no tournament authorization was committed.
  await r.a.start('arena');
  const current = (await r.b.load('arena')).toSnapshot();
  assert.equal(current.pairingSequence, 1);
  assert.deepEqual(Object.values(current.playerStates).map(player => player.gamesPlayed), [0, 0]);
  assert.notEqual(current.gameLinks![0]![1], orphan.gameId);
  assert.equal((await r.pool.query("SELECT count(*)::int AS n FROM game_events WHERE type = 'GameCreated'")).rows[0].n, 2);
}));
