import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { ArenaDeadlineWorker } from '../src/tournament/arena-deadline-worker';
import { ArenaTournament } from '@chess-platform/tournament';
import { Pool } from 'pg';
import { createPgApiServer } from '../src/bootstrap';
import { JsonLogger, NullLogger } from '../src/ports/logger';
import { HttpError } from '../src/http/errors';
import { InMemoryEmailSender } from '../src/ports/email';
import { arenaFailureFields } from '../src/tournament/arena-diagnostics';
import { startHarness } from './helpers';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

test('Qodo correction: direct creation rejects invalid duration before persistence', async () => {
  const repo = new InMemoryTournamentsRepository();
  const service = new ArenaService(repo, new InMemoryGameLauncher({ next: () => 'game' }));
  for (const durationMs of [-1000, 0, Number.MAX_SAFE_INTEGER + 1, 1e300, 1.5, NaN, Infinity]) {
    await assert.rejects(service.create({ id: 'invalid-duration', name: 'invalid', variant: 'standard', timeControl: TC, durationMs }),
      (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === 'validation_failed');
    assert.equal(await repo.findById('invalid-duration'), null);
  }
  for (const durationMs of [1, 30 * 24 * 60 * 60 * 1000 + 1, Number.MAX_SAFE_INTEGER]) {
    const id = `valid-${durationMs}`;
    assert.equal((await service.create({ id, name: id, variant: 'standard', timeControl: TC, durationMs })).config.durationMs, durationMs);
    assert.ok(await repo.findById(id));
  }
});

test('Qodo correction: HTTP creation rejects invalid duration without a save', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const { token } = await h.makeUser('duration_director', ['user', 'tournament_director']);
  const save = h.tournamentRepo.save.bind(h.tournamentRepo);
  let saves = 0;
  h.tournamentRepo.save = async (...args) => { saves++; return save(...args); };
  for (const durationMs of [-1000, 0, Number.MAX_SAFE_INTEGER + 1, 1e300, 1.5]) {
    const response = await h.json('POST', '/v1/tournaments', { token,
      body: { name: 'duration', format: 'arena', variant: 'standard', timeControl: TC, durationMs } });
    assert.equal(response.status, 422, `duration ${durationMs}`);
    assert.equal(response.body.error.code, 'validation_failed');
    assert.equal(saves, 0, 'invalid input must never reach persistence');
  }
  const response = await h.json('POST', '/v1/tournaments', { token,
    body: { name: 'valid', format: 'arena', variant: 'standard', timeControl: TC, durationMs: 1000 } });
  assert.equal(response.status, 201);
  assert.equal(saves, 1);
});

test('Qodo correction: repair diagnostics classify inactive games without leaking errors', () => {
  for (const [error, expected] of [
    [new Error('Invalid inactive Arena games; operator repair required'), { errorCategory: 'invalid_snapshot', repairRequired: true }],
    [new Error('Invalid persisted Arena participants; operator repair required'), { errorCategory: 'invalid_snapshot', repairRequired: true }],
    [new Error('Ambiguous ended legacy Arena launch; operator repair required'), { errorCategory: 'legacy_launch_repair', repairRequired: true }],
    [Object.assign(new Error('private secret'), { code: 'ETIMEDOUT' }), { errorCategory: 'database_or_network', repairRequired: false, errorCode: 'ETIMEDOUT' }],
    [Object.assign(new Error('private secret'), { code: '23505' }), { errorCategory: 'database_or_network', repairRequired: false, errorCode: '23505' }],
    [Object.assign(new Error('unrelated private secret; operator repair required'), { code: 'unvetted secret' }), { errorCategory: 'unknown', repairRequired: false }],
  ] as const) assert.deepEqual(arenaFailureFields(error), expected);
});

test('review regression: an empty cycle watermark never becomes an unbounded scan', async () => {
  const r = await rig();
  r.repo.arenaWorkCeiling = async () => null;
  let scans = 0;
  r.repo.listArenaWorkAfter = async () => { scans++; return ['new']; };
  const worker = new ArenaDeadlineWorker(r.repo, r.service, { pageSize: 1 });
  assert.deepEqual(await worker.runPass(), { scanned: 0, failed: 0 });
  assert.equal(scans, 0);
});

test('review regression: continuous new work cannot prevent revisiting a newly due lower ID', async () => {
  const r = await rig();
  const work = [{ id: '0', sequence: 1, due: false }, { id: 'a', sequence: 2, due: true }, { id: 'c', sequence: 3, due: true }];
  r.repo.listArenaWorkAfter = async (after, limit, _signal?: AbortSignal, through?: string | null) =>
    work.filter(row => row.due && (!after || row.id > after) && (!through || row.sequence <= Number(through)))
      .map(row => row.id).sort().slice(0, limit);
  r.repo.arenaWorkCeiling = async () => String(work.at(-1)!.sequence);
  const seen: string[] = [];
  r.service.reconcile = async id => { seen.push(id); return r.service.load('arena'); };
  const worker = new ArenaDeadlineWorker(r.repo, r.service, { pageSize: 1 });
  await worker.runPass();
  work[0]!.due = true; // became due behind the current cursor
  for (const id of ['b', 'bb', 'bbb', 'bbbb']) { work.push({ id, sequence: work.length + 1, due: true }); await worker.runPass(); }
  assert.ok(seen.includes('0'), 'a finite scan cycle must return to newly due lower IDs');
});

test('review regression: stop cancels an in-flight pass and never starts the next Arena', async () => {
  const r = await rig();
  r.repo.listArenaWorkAfter = async () => ['first', 'second'];
  const seen: string[] = [];
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  r.service.reconcile = async (id: string, signal?: AbortSignal) => {
    seen.push(id);
    entered();
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      // Keep the RED bounded without making a retry or changing a test timeout.
      setImmediate(resolve);
    });
    return r.service.load('arena');
  };
  const worker = new ArenaDeadlineWorker(r.repo, r.service);
  const pass = worker.runPass();
  await ready;
  await worker.stop();
  await pass;
  assert.deepEqual(seen, ['first']);
});

async function rig(players = 2) {
  const repo = new InMemoryTournamentsRepository();
  let now = 1_000;
  repo.arenaClock = () => now;
  let sequence = 0;
  const launcher = new InMemoryGameLauncher({ next: () => `game-${++sequence}` });
  const service = new ArenaService(repo, launcher, () => now + 1_800_000);
  await service.create({ id: 'arena', name: 'Arena', variant: 'standard', durationMs: 100, timeControl: TC });
  for (let i = 0; i < players; i++) await service.register('arena', `player-${i}`);
  await service.start('arena');
  return { repo, launcher, service, at: (ms: number) => { now = ms; } };
}

test('opposite replica clocks cannot establish or expire the authoritative deadline', async () => {
  const repo = new InMemoryTournamentsRepository();
  let now = 1_000;
  (repo as InMemoryTournamentsRepository & { arenaClock: () => number }).arenaClock = () => now;
  let sequence = 0;
  const launcher = new InMemoryGameLauncher({ next: () => `game-${++sequence}` });
  const fast = new ArenaService(repo, launcher, () => now + 1_800_000);
  const slow = new ArenaService(repo, launcher, () => now - 1_800_000);
  await fast.create({ id: 'arena', name: 'Arena', variant: 'standard', durationMs: 100,
    timeControl: { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } });
  await Promise.all([fast.start('arena', 0), slow.start('arena', 99)]);
  assert.equal((await fast.load('arena')).toSnapshot().startedAtMs, 1_000);
  now = 1_099;
  assert.equal((await fast.getTournament('arena')).getState(), 'running');
  assert.equal((await slow.getTournament('arena')).getState(), 'running');
  now = 1_100;
  await Promise.all([fast.getTournament('arena'), slow.getTournament('arena')]);
  assert.equal((await fast.load('arena')).getState(), 'finished');
});

for (const delta of [-1, 0, 1]) {
  for (const outcome of ['white_win', '*'] as const) {
    test(`result/abandon ${outcome} at T${delta >= 0 ? '+' : ''}${delta} uses exact cutoff`, async () => {
      const r = await rig();
      const gameId = (await r.service.load('arena')).toSnapshot().gameLinks![0]![1];
      r.at(1_100 + delta);
      await r.service.recordCommittedOutcome('arena', gameId, outcome);
      const snapshot = (await r.service.load('arena')).toSnapshot();
      assert.equal(snapshot.state, delta < 0 ? 'running' : 'finished');
      assert.equal(r.launcher.launched.length, delta < 0 ? 2 : 1);
      if (outcome !== '*') assert.equal(Object.values(snapshot.playerStates).reduce((n, p) => n + p.gamesPlayed, 0), 2);
      await r.service.recordCommittedOutcome('arena', gameId, outcome);
      assert.deepEqual((await r.service.load('arena')).toSnapshot(), snapshot);
    });
  }
}

test('two results, reporter replay and settlement race converge without applying scores twice', async () => {
  const r = await rig(4);
  const links = (await r.service.load('arena')).toSnapshot().gameLinks!;
  r.at(1_100);
  await Promise.all([
    r.service.recordCommittedOutcome('arena', links[0]![1], 'white_win'),
    r.service.recordCommittedOutcome('arena', links[0]![1], 'white_win'),
    r.service.recordCommittedOutcome('arena', links[1]![1], 'black_win'),
    r.service.getTournament('arena'),
    new ArenaDeadlineWorker(r.repo, r.service).runPass(),
  ]);
  assert.equal((await r.service.load('arena')).getState(), 'finished');
  assert.deepEqual((await r.service.getStandings('arena')).map(p => p.gamesPlayed), [1, 1, 1, 1]);
  assert.equal(r.launcher.launched.length, 2);
});

test('failed launch leaves committed pre-deadline work recoverable after restart and deadline', async () => {
  const r = await rig(0);
  await r.service.register('arena', 'A');
  const failed = new ArenaService(r.repo, { launch: async () => { throw new Error('crash before launch'); } }, () => 0);
  const committed = await failed.register('arena', 'B');
  assert.equal(committed.toSnapshot().gameLinks!.length, 0);
  await assert.rejects(failed.reconcile('arena'), /crash before launch/);
  const authorized = (await r.service.load('arena')).toSnapshot();
  assert.equal(Object.keys(authorized.activeGames).length, 1);
  assert.equal(authorized.gameLinks!.length, 0);
  r.at(1_101);
  await new ArenaDeadlineWorker(r.repo, r.service).runPass();
  const recovered = (await r.service.load('arena')).toSnapshot();
  assert.equal(recovered.pairingSequence, authorized.pairingSequence);
  assert.equal(recovered.gameLinks!.length, 1);
  assert.equal(recovered.state, 'running');
});

test('worker rotates past corrupt Arena, coalesces passes and drains in-flight work on stop', async () => {
  const r = await rig(0);
  r.at(1_100);
  const bad = (await r.service.load('arena')).toSnapshot();
  const corrupt = { ...bad, config: { ...bad.config, id: 'aaa-corrupt' }, startedAtMs: undefined };
  await r.repo.save(corrupt, 0);
  const worker = new ArenaDeadlineWorker(r.repo, r.service, { pageSize: 1 });
  assert.deepEqual(await worker.runPass(), { scanned: 1, failed: 1 });
  assert.deepEqual(await worker.runPass(), { scanned: 1, failed: 0 });
  assert.equal((await r.service.load('arena')).getState(), 'finished');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = r.repo.listArenaWorkAfter.bind(r.repo);
  r.repo.listArenaWorkAfter = async (after, size) => { entered(); await barrier; return original(after, size); };
  const first = worker.runPass();
  assert.equal(worker.runPass(), first);
  await started;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  await first;
});

test('database-time failure does not fallback or mutate/launch', async () => {
  const r = await rig();
  const before = (await r.service.load('arena')).toSnapshot();
  r.repo.mutateArena = async () => { throw new Error('authority unavailable'); };
  r.repo.readArena = async () => { throw new Error('authority unavailable'); };
  await assert.rejects(r.service.getTournament('arena'), /authority unavailable/);
  await assert.rejects(r.service.register('arena', 'C'), /authority unavailable/);
  assert.deepEqual((await r.repo.findById('arena'))!.snapshot, before);
  assert.equal(r.launcher.launched.length, 1);
});

test('stale authorization retry reloads state before creating any external game', async () => {
  const r = await rig(0);
  const original = r.repo.mutateArena.bind(r.repo);
  const { VersionConflictError } = await import('@chess-platform/persistence');
  let attempts = 0;
  r.repo.mutateArena = async (...args) => {
    attempts++;
    if (attempts === 1) throw new VersionConflictError('arena', 1);
    return original(...args);
  };
  await r.service.register('arena', 'A');
  assert.ok(attempts >= 2);
  assert.equal(r.launcher.launched.length, 0);
  assert.equal((await r.service.load('arena')).toSnapshot().participants.length, 1);
});

test('pure domain preserves exact deadline across snapshot restore and active games', () => {
  for (const delta of [-1, 0, 1]) {
    const arena = new ArenaTournament({ id: 'x', name: 'X', format: 'arena', variant: 'standard', durationMs: 100, timeControl: TC });
    assert.equal(arena.isExpired(999_999), false);
    arena.register('A'); arena.register('B'); arena.start(1_000);
    const restored = ArenaTournament.restore(arena.toSnapshot());
    assert.equal(restored.pairAvailable(1_100 + delta).length, delta < 0 ? 1 : 0);
    if (delta < 0) {
      restored.settle(1_100);
      assert.equal(restored.getState(), 'running');
      restored.recordResult('a:1', 'white_win', 1_100);
      assert.equal(restored.getState(), 'finished');
      restored.settle(1_100);
      assert.equal(restored.getState(), 'finished');
    }
  }
});

test('worker polls idle/failure with bounded scheduling and stop cancels the next pass', async () => {
  const r = await rig(0);
  const scheduled: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const schedule = ((callback: () => void, delay: number) => {
    const entry = { callback, delay, cancelled: false };
    scheduled.push(entry);
    return entry;
  }) as unknown as typeof setTimeout;
  const cancel = ((entry: { cancelled: boolean }) => { entry.cancelled = true; }) as unknown as typeof clearTimeout;
  const worker = new ArenaDeadlineWorker(r.repo, r.service, { schedule, cancel, pollMs: 100 });
  await worker.stop(); // stop before any start/pass
  assert.equal(scheduled.length, 0);
  worker.start(); worker.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.delay, 0);
  r.repo.listArenaWorkAfter = async () => [];
  scheduled[0]!.callback();
  await worker.runPass();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(scheduled.at(-1)!.delay, 100);
  r.repo.listArenaWorkAfter = async () => { throw new Error('transient database failure'); };
  scheduled.at(-1)!.callback();
  await assert.rejects(worker.runPass(), /transient/);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(scheduled.at(-1)!.delay, 100);
  await worker.stop();
  assert.equal(scheduled.at(-1)!.cancelled, true);
});

test('stop drains a failed in-flight database pass without rejecting shutdown', async () => {
  const r = await rig(0);
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  r.repo.listArenaWorkAfter = () => new Promise((_resolve, failure) => { reject = failure; entered(); });
  const worker = new ArenaDeadlineWorker(r.repo, r.service);
  const pass = worker.runPass();
  const caught = assert.rejects(pass, /database failed/);
  await ready;
  const stopping = worker.stop();
  reject(new Error('database failed'));
  await stopping;
  await caught;
});

test('production API bootstrap starts autonomous Arena reconciliation and drains it on shutdown', { timeout: 5_000 }, async t => {
  const r = await rig(0);
  r.at(1_100);
  let finished!: () => void;
  const settlement = new Promise<void>(resolve => { finished = resolve; });
  const mutate = r.repo.mutateArena.bind(r.repo);
  r.repo.mutateArena = async (...args) => {
    const snapshot = await mutate(...args);
    if (snapshot?.state === 'finished') finished();
    return snapshot;
  };
  const pool = new Pool(); // lazy; the injected simulation repository performs no DB I/O
  const app = createPgApiServer({ pool, tournamentRepo: r.repo, gameLauncher: r.launcher,
    config: { accessTokenSecret: 'arena-test-secret-with-at-least-32-characters' }, logger: new NullLogger(), emailSender: new InMemoryEmailSender() });
  let http: Awaited<ReturnType<typeof app.server.listen>> | undefined;
  // Teardown also runs if the existing test timeout cancels a pending await.
  t.after(async () => {
    try {
      if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    } finally { await app.shutdownAnalysis(); await pool.end(); }
  });
  http = await app.server.listen(0, '127.0.0.1');
  await settlement;
  assert.equal((await r.service.load('arena')).getState(), 'finished');
});

test('review regression: repository failures remain internal errors and known unknown-game responses remain 404', async () => {
  const r = await rig();
  await assert.rejects(r.service.recordResultByGame('arena', 'missing', 'draw'),
    (error: unknown) => error instanceof HttpError && error.status === 404 && !error.message.includes('missing'));
  const unavailable = Object.assign(new Error('private connection details'), { code: 'ETIMEDOUT' });
  r.repo.mutateArena = async () => { throw unavailable; };
  (r.repo as unknown as { readArena: () => Promise<never> }).readArena = async () => { throw unavailable; };
  await assert.rejects(r.service.getTournament('arena'), (error: unknown) => error === unavailable && !(error instanceof HttpError));
  await assert.rejects(r.service.register('arena', 'C'), (error: unknown) => error === unavailable);
});

test('review regression: healthy active Arena reads do not acquire a mutation lock', async () => {
  const r = await rig();
  r.repo.mutateArena = async () => { throw new Error('unexpected spectator write lock'); };
  assert.equal((await r.service.getTournament('arena')).getState(), 'running');
  r.at(1_100);
  assert.equal((await r.service.getStandings('arena')).length, 2);
});

test('review regression: committed registration succeeds with durable pending work despite launch failure', async () => {
  const r = await rig(0);
  await r.service.register('arena', 'A');
  const failed = new ArenaService(r.repo, { launch: async () => { throw new Error('launcher unavailable'); } });
  let committed!: ArenaTournament;
  await assert.doesNotReject(async () => { committed = await failed.register('arena', 'B'); });
  assert.equal(committed.toSnapshot().participants.length, 2);
  assert.equal(Object.keys(committed.toSnapshot().activeGames).length, 1);
  assert.equal(committed.toSnapshot().gameLinks!.length, 0);
  assert.deepEqual(await r.repo.listArenaWorkAfter(null, 50), ['arena']);
  await new ArenaDeadlineWorker(r.repo, r.service).runPass();
  assert.equal((await r.service.load('arena')).toSnapshot().gameLinks!.length, 1);
});

test('review regression: sampled worker diagnostics preserve safe categories and codes without secrets', async () => {
  const r = await rig(0);
  r.at(1_100);
  const records: string[] = [];
  const logger = new JsonLogger({}, { sink: line => records.push(line) });
  const fault = Object.assign(new Error('postgres://private-secret/user-snapshot'), { code: 'ETIMEDOUT' });
  r.repo.mutateArena = async () => { throw fault; };
  await new ArenaDeadlineWorker(r.repo, r.service, { logger }).runPass();
  assert.equal(records.length, 1);
  const record = JSON.parse(records[0]!);
  assert.equal(record.operation, 'reconcile');
  assert.equal(record.errorCode, 'ETIMEDOUT');
  assert.equal(record.errorCategory, 'database_or_network');
  assert.ok(!records[0]!.includes('private-secret'));
  assert.equal(record.stack, undefined);
});
