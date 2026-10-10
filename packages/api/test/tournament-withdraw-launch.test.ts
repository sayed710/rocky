import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { TournamentService } from '../src/tournament/service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { uuidv7Generator } from '../src/ports/ids';
import { InMemoryEventStore, VersionConflictError, isArenaSnapshot } from '@chess-platform/persistence';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import type { LaunchInput } from '../src/tournament/launcher';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { ArenaService } from '../src/tournament/arena.service';
import { Game } from '@chess-platform/game';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

/** Real durable launcher with an assertion that every launch has a committed pairing. */
async function durableRig(format: 'swiss' | 'round_robin') {
  const repo = new InMemoryTournamentsRepository();
  const events = new InMemoryEventStore();
  const durable = new DurableGameLauncher(events, { now: () => 1000 });
  const gameIds = new Set<string>();
  let failLaunch = false;
  const launcher = { launch: async (input: LaunchInput) => {
    const stored = await repo.findById(format);
    assert.ok(stored && !isArenaSnapshot(stored.snapshot));
    const [round, index] = input.matchId.split('-').map(Number);
    const pairing = stored.snapshot.rounds[round!]!.pairings[index!];
    assert.ok(pairing?.kind === 'game');
    assert.deepEqual([pairing.white, pairing.black], [input.white, input.black], 'launch must follow committed pairing');
    if (failLaunch) throw new Error('Injected launch outage');
    const result = await durable.launch(input);
    gameIds.add(result.gameId);
    return result;
  } };
  const service = new TournamentService(repo, launcher);
  const reporter = () => new TournamentResultReporter(new InMemoryPubSub(), repo, service,
    new ArenaService(repo, launcher, () => 1000), events, { scanIntervalMs: 0 });
  await service.create({ id: format, name: format, format, rounds: 3, variant: 'standard', timeControl: TC });
  for (const player of ['A', 'B', 'C', 'D']) await service.register(format, player);
  const started = await service.start(format);
  const last = started.getRounds()[0]!.pairings[1]!;
  assert.ok(last.kind === 'game');
  return { repo, events, service, reporter, gameIds, last,
    outage: (value: boolean) => { failLaunch = value; } };
}

/** Assert only undecided games are launched, and each live slot has exactly one game. */
async function assertNextRound(rig: Awaited<ReturnType<typeof durableRig>>, format: string) {
  const current = await rig.service.load(format);
  assert.ok(current.getRounds()[1]);
  let live = 0;
  for (const [index, pairing] of current.getRounds()[1]!.pairings.entries()) {
    if (pairing.kind === 'game' && current.resultFor(1, index) === undefined) {
      live++;
      assert.ok(current.gameIdFor(1, index));
    } else assert.equal(current.gameIdFor(1, index), undefined);
  }
  assert.ok(live > 0);
  assert.equal(rig.gameIds.size, 2 + live, 'no duplicate launches or auto-forfeit games');
}

for (const format of ['swiss', 'round_robin'] as const) {
  test(`${format}: a rejected withdrawal CAS never launches its speculative round`, async () => {
    const rig = await durableRig(format);
    await rig.service.recordResult(format, { roundIndex: 0, pairingIndex: 0, result: 'draw' });
    rig.repo.save = async () => { throw new VersionConflictError(format, 1); };
    await assert.rejects(rig.service.withdraw(format, rig.last.white), /Concurrent update/);
    assert.equal(rig.gameIds.size, 2);
    assert.equal((await rig.service.load(format)).getRounds().length, 1);
  });

  test(`${format}: concurrent withdrawal and committed result converge with repeated reconciliation`, async () => {
    const rig = await durableRig(format);
    const first = (await rig.service.load(format)).gameIdFor(0, 0)!;
    const save = rig.repo.save.bind(rig.repo);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let conflicts = 0;
    rig.repo.save = async (snapshot, version) => {
      if (arrived < 2) {
        arrived++;
        if (arrived === 2) release();
        await barrier;
      }
      try { await save(snapshot, version); }
      catch (error) { if (error instanceof VersionConflictError) conflicts++; throw error; }
    };
    await Promise.all([
      rig.service.withdraw(format, rig.last.white),
      rig.service.recordCommittedOutcome(format, first, 'draw'),
    ]);
    assert.ok(conflicts > 0, 'exercise real CAS retry');
    await Promise.all([rig.service.reconcile(format), rig.service.reconcile(format)]);
    await rig.service.recordCommittedOutcome(format, first, 'draw');
    await assertNextRound(rig, format);
  });

  test(`${format}: recovered reporter launches a committed round after outage, exactly once`, async () => {
    const rig = await durableRig(format);
    await rig.service.recordResult(format, { roundIndex: 0, pairingIndex: 0, result: 'draw' });
    rig.outage(true);
    await assert.rejects(rig.service.withdraw(format, rig.last.white), /Injected launch outage/);
    const committed = await rig.service.load(format);
    assert.ok(committed.getRounds()[1], 'round obligation survives launch failure');
    rig.outage(false);
    for (let restart = 0; restart < 2; restart++) {
      const reporter = rig.reporter();
      try { await reporter.start(); for (let scan = 0; scan < 10; scan++) await reporter.scan(); }
      finally { reporter.stop(); }
    }
    await assertNextRound(rig, format);
  });

  test(`${format}: an ended game created before a lost link is recovered without duplicate launch`, async () => {
    const rig = await durableRig(format);
    await rig.service.recordResult(format, { roundIndex: 0, pairingIndex: 0, result: 'draw' });
    const save = rig.repo.save.bind(rig.repo);
    rig.repo.save = async (snapshot, version) => {
      if ((snapshot.gameLinks ?? []).some(([slot]) => slot.startsWith('1-'))) throw new Error('Injected link outage');
      await save(snapshot, version);
    };
    await assert.rejects(rig.service.withdraw(format, rig.last.white), /Injected link outage/);
    const recoveryId = [...rig.gameIds][2]!;
    assert.ok(recoveryId);
    const log = await rig.events.load(recoveryId);
    const ending = Game.fromEvents(log.map(({ event }) => event)).abort(2000).events;
    await rig.events.append(recoveryId, log.length - 1, ending);
    rig.repo.save = save;
    await Promise.all([rig.service.reconcile(format), rig.service.reconcile(format)]);
    assert.equal(rig.gameIds.size, 3, 'ended original is recovered, not replaced before its outcome is consumed');
    assert.ok((await rig.service.load(format)).pairingForGame(recoveryId));
    const reporter = rig.reporter();
    try { await reporter.start(); await reporter.scan(); await reporter.scan(); }
    finally { reporter.stop(); }
    const after = await rig.service.load(format);
    assert.equal(after.pairingForGame(recoveryId), null, 'committed abort unlinks original once');
    assert.equal(rig.gameIds.size, 4, 'exactly one replacement for the committed abort');
    await rig.service.reconcile(format);
    assert.equal(rig.gameIds.size, 4);
  });

  test(`${format}: withdrawal completing a round launches every undecided next-round game`, async () => {
    const repo = new InMemoryTournamentsRepository();
    const launcher = new InMemoryGameLauncher(uuidv7Generator);
    const service = new TournamentService(repo, launcher);
    await service.create({ id: format, name: format, format, rounds: 3, variant: 'standard', timeControl: TC });
    for (const player of ['A', 'B', 'C', 'D']) await service.register(format, player);
    const started = await service.start(format);
    const round = started.getRounds()[0]!;
    const last = round.pairings[1]!;
    assert.equal(last.kind, 'game');
    if (last.kind !== 'game') throw new Error('Expected game');
    await service.recordResult(format, { roundIndex: 0, pairingIndex: 0, result: 'draw' });
    await service.withdraw(format, last.white);
    const after = await service.load(format);
    const next = after.getRounds()[1]!;
    assert.ok(next);
    let playable = 0;
    next.pairings.forEach((pairing, index) => {
      if (pairing.kind === 'game' && after.resultFor(1, index) === undefined) {
        playable++;
        assert.ok(after.gameIdFor(1, index), 'next round must have a launched game');
      } else {
        assert.equal(after.gameIdFor(1, index), undefined);
      }
    });
    assert.ok(playable > 0);
  });
}
