import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { ArenaDeadlineWorker } from '../src/tournament/arena-deadline-worker';
import { ArenaTournament } from '@chess-platform/tournament';
import { Pool } from 'pg';
import { createPgApiServer } from '../src/bootstrap';
import { NullLogger } from '../src/ports/logger';
import { InMemoryEmailSender } from '../src/ports/email';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

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
  await assert.rejects(failed.register('arena', 'B'), /crash before launch/);
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
  r.repo.listArenaWorkAfter = () => new Promise((_resolve, failure) => { reject = failure; });
  const worker = new ArenaDeadlineWorker(r.repo, r.service);
  const pass = worker.runPass();
  const caught = assert.rejects(pass, /database failed/);
  const stopping = worker.stop();
  reject(new Error('database failed'));
  await stopping;
  await caught;
});

test('production API bootstrap starts autonomous Arena reconciliation and drains it on shutdown', { timeout: 5_000 }, async () => {
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
  try {
    await settlement;
    assert.equal((await r.service.load('arena')).getState(), 'finished');
  } finally { await app.shutdownAnalysis(); await pool.end(); }
});
