import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { DurableGameLauncher, launchGameId } from '../src/tournament/durable-launcher';
import { DurableTournamentLiveView } from '../src/tournament/durable-live-view';
import { TournamentService } from '../src/tournament/service';
import type { LaunchInput } from '../src/tournament/launcher';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { ArenaService } from '../src/tournament/arena.service';

const input: LaunchInput = {
  tournamentId: 't1',
  matchId: '0-0',
  white: 'alice',
  black: 'bob',
  variant: 'standard',
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'increment' },
  attempt: 0,
};

test('durable launcher creates one playable event log and is idempotent across instances', async () => {
  const events = new InMemoryEventStore();
  const clock = { now: () => 1234 };
  const first = new DurableGameLauncher(events, clock);
  const second = new DurableGameLauncher(events, clock);

  const [a, b] = await Promise.all([first.launch(input), second.launch(input)]);
  assert.equal(a.gameId, b.gameId);
  assert.equal(a.gameId, launchGameId(input));
  const log = await events.load(a.gameId);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.event.type, 'GameCreated');
});

test('durable live view reconstructs linked active games from the event log', async () => {
  const events = new InMemoryEventStore();
  const tournaments = new InMemoryTournamentsRepository();
  const launcher = new DurableGameLauncher(events, { now: () => 1234 });
  const { gameId } = await launcher.launch(input);
  await tournaments.save({
    config: {
      id: 't1', name: 'Test', format: 'round_robin', variant: 'standard',
      timeControl: input.timeControl as { initialMs: number; incrementMs: number; delayMs: number; kind: 'increment' },
    },
    state: 'running',
    participants: ['alice', 'bob'],
    rounds: [],
    results: [],
    pairingsByMatchId: [],
    gameLinks: [['0-0', gameId]],
  }, 0);

  const boards = await new DurableTournamentLiveView(tournaments, events).activeGames('t1');
  assert.equal(boards.length, 1);
  assert.equal(boards[0]!.gameId, gameId);
  assert.equal(boards[0]!.fenHash.length, 12);
});

/**
 * The launch identity names the pairing slot, not the players: two operations racing from one
 * tournament version can pair the same slot differently, and a game left by an operation that lost
 * its version CAS stays in the slot. A launch must neither link that game under other players nor
 * be refused (which would wedge the pairing): it takes the next attempt of the slot, and every
 * launcher computing the same pairing takes the same one.
 */
async function playersOf(events: InMemoryEventStore, gameId: string) {
  const created = (await events.load(gameId))[0]?.event;
  assert.ok(created?.type === 'GameCreated');
  return { white: created.players.white, black: created.players.black, variant: created.variant, timeControl: created.timeControl };
}

test('a slot held by a game of another pairing moves the launch to the next attempt, never to the wrong game', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1234 });
  const { gameId: held } = await launcher.launch(input);
  assert.deepEqual(await launcher.launch(input), { gameId: held }, 'the same pairing still converges');
  for (const [i, other] of [
    { ...input, white: 'carol' },
    { ...input, black: 'carol' },
    { ...input, white: 'bob', black: 'alice' },
    { ...input, variant: 'chess960' },
    { ...input, timeControl: { initialMs: 30_000, incrementMs: 0, delayMs: 0, kind: 'increment' } },
  ].entries()) {
    const { gameId } = await launcher.launch(other);
    assert.notEqual(gameId, held, JSON.stringify(other));
    assert.deepEqual(await playersOf(events, gameId), { white: other.white, black: other.black, variant: other.variant, timeControl: other.timeControl });
    // Each earlier pairing in this loop already holds an attempt, so this one takes the first free one.
    assert.equal(gameId, launchGameId({ ...other, attempt: other.attempt + i + 1 }), 'the first free attempt of the same slot');
    assert.deepEqual(await new DurableGameLauncher(events, { now: () => 9 }).launch(other), { gameId }, 'another replica converges on it');
  }
  assert.deepEqual(await playersOf(events, held), { white: 'alice', black: 'bob', variant: 'standard', timeControl: input.timeControl }, 'the held game is untouched');
});

test('two pairings racing for one slot each get their own game', async () => {
  const events = new InMemoryEventStore();
  const pairings = [{ ...input, matchId: 'a:7', white: 'ivan', black: 'pat' }, { ...input, matchId: 'a:7' }];
  const launched = await Promise.all(pairings.map((p) => new DurableGameLauncher(events, { now: () => 1 }).launch(p)));
  assert.notEqual(launched[0]!.gameId, launched[1]!.gameId);
  for (const [i, p] of pairings.entries()) {
    const stored = await playersOf(events, launched[i]!.gameId);
    assert.deepEqual([stored.white, stored.black], [p.white, p.black]);
  }
});

/**
 * A pairing's game can live past its nominal attempt (an earlier attempt was held), and an abandon
 * relaunches at the nominal attempt + 1. That can land on the pairing's own aborted game, which must
 * never be linked again: the pairing would wait forever on a game that has already ended.
 */
test('a launch never reuses an ended game, even one of the same pairing', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1234 });
  await launcher.launch({ ...input, white: 'carol' }); // holds attempt 0 of the slot
  const { gameId: first } = await launcher.launch(input); // so this pairing lands on attempt 1
  assert.equal(first, launchGameId({ ...input, attempt: 1 }));
  const stored = await events.load(first);
  const { events: ended } = Game.fromEvents(stored.map((e) => e.event)).abort(2000);
  await events.append(first, stored.length - 1, ended);

  const { gameId: relaunched } = await launcher.launch({ ...input, attempt: 1 }); // what abandonGame asks for next
  assert.notEqual(relaunched, first, 'the aborted game is not linked again');
  assert.equal(relaunched, launchGameId({ ...input, attempt: 2 }));
  assert.deepEqual(await new DurableGameLauncher(events, { now: () => 9 }).launch({ ...input, attempt: 1 }), { gameId: relaunched }, 'replicas converge on the fresh game');
});

/**
 * The same, end to end through the tournament service: the round's game lands on attempt 1 because
 * attempt 0 of its slot is held, the game is aborted, and the committed abort relaunches the pairing.
 * The relaunch must be a fresh, live game, not the aborted one linked again.
 */
test('an aborted tournament game is replaced by a fresh game even when its slot was probed', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1234 });
  const service = new TournamentService(new InMemoryTournamentsRepository(), launcher);
  await service.create({ id: 'probed', name: 'Probed', format: 'round_robin', variant: 'standard', timeControl: input.timeControl as never });
  await launcher.launch({ ...input, tournamentId: 'probed', matchId: '0-0', white: 'x', black: 'y' }); // holds attempt 0
  for (const player of ['alice', 'bob']) await service.register('probed', player);
  const started = await service.start('probed');
  const aborted = started.gameIdFor(0, 0)!;
  assert.ok(aborted);
  const stored = await events.load(aborted);
  const { events: ending } = Game.fromEvents(stored.map((e) => e.event)).abort(2000);
  await events.append(aborted, stored.length - 1, ending);

  const after = await service.recordCommittedOutcome('probed', aborted, '*');
  const replacement = after.gameIdFor(0, 0)!;
  assert.ok(replacement);
  assert.notEqual(replacement, aborted, 'the aborted game is not linked again');
  const log = await events.load(replacement);
  assert.ok(!log.some(({ event }) => event.type === 'GameEnded'), 'the replacement is a live game');
  const created = log[0]!.event;
  const pairing = after.getRounds()[0]!.pairings[0]!;
  assert.ok(created.type === 'GameCreated' && pairing.kind === 'game');
  assert.deepEqual([created.players.white, created.players.black], [pairing.white, pairing.black]);
});

for (const format of ['swiss', 'round_robin'] as const) {
  /** Simulate an upgrade after a committed round but before its legacy game link was saved. */
  async function legacyRound() {
    const events = new InMemoryEventStore();
    const repo = new InMemoryTournamentsRepository();
    const launcher = new DurableGameLauncher(events, { now: () => 1234 });
    const service = new TournamentService(repo, launcher);
    const timeControl = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;
    await service.create({ id: format, name: format, format, rounds: 3, variant: 'standard', timeControl });
    for (const player of ['A', 'B', 'C', 'D']) await service.register(format, player);
    const domain = await service.load(format);
    domain.start();
    const stored = await repo.findById(format);
    await repo.save(domain.toSnapshot(), stored!.version);
    const pairing = domain.getRounds()[0]!.pairings[0]!;
    assert.ok(pairing.kind === 'game');
    const launch = { tournamentId: format, matchId: '0-0', white: pairing.white,
      black: pairing.black, variant: 'standard', timeControl, attempt: 0 };
    return { events, repo, launcher, service, launch };
  }

  test(`${format}: upgrade recovers an unlinked matching live legacy game`, async () => {
    const rig = await legacyRound();
    const legacy = await rig.launcher.launch(rig.launch);
    const [recovered, replica] = await Promise.all([
      rig.service.reconcile(format),
      new TournamentService(rig.repo, new DurableGameLauncher(rig.events, { now: () => 1234 })).reconcile(format),
    ]);
    assert.equal(recovered.gameIdFor(0, 0), legacy.gameId);
    assert.equal(replica.gameIdFor(0, 0), legacy.gameId);
    assert.equal((await rig.events.findActiveGamesByPlayer(rig.launch.white)).length, 1,
      'recovery must not create a second active game for a pre-upgrade launch');
  });

  test(`${format}: a legacy game recovered from a probed slot advances from its actual attempt`, async () => {
    const rig = await legacyRound();
    await rig.launcher.launch({ ...rig.launch, black: 'speculative-player' });
    const legacy = await rig.launcher.launch(rig.launch);
    const recovered = await rig.service.reconcile(format);
    assert.equal(recovered.gameIdFor(0, 0), legacy.gameId);
    assert.equal(recovered.launchAttemptFor(0, 0), 1);
    const log = await rig.events.load(legacy.gameId);
    await rig.events.append(legacy.gameId, log.length - 1,
      Game.fromEvents(log.map(({ event }) => event)).abort(2000).events);
    const after = await rig.service.recordCommittedOutcome(format, legacy.gameId, '*');
    assert.equal(after.launchAttemptFor(0, 0), 2);
    assert.notEqual(after.gameIdFor(0, 0), legacy.gameId);
  });

  test(`${format}: upgrade refuses to forcibly retire a mismatched legacy game with moves`, async () => {
    const rig = await legacyRound();
    const legacy = await rig.launcher.launch({ ...rig.launch, black: 'speculative-player' });
    let log = await rig.events.load(legacy.gameId);
    const readyWhite = Game.fromEvents(log.map(({ event }) => event)).markReady('w', 1500);
    const readyBlack = readyWhite.game.markReady('b', 1500);
    await rig.events.append(legacy.gameId, log.length - 1, [...readyWhite.events, ...readyBlack.events]);
    log = await rig.events.load(legacy.gameId);
    for (const [move, at] of [['e2e4', 2000], ['e7e5', 3000]] as const) {
      const game = Game.fromEvents(log.map(({ event }) => event));
      const moved = game.playMove(move, at);
      await rig.events.append(legacy.gameId, log.length - 1, moved.events);
      log = await rig.events.load(legacy.gameId);
    }
    await assert.rejects(rig.service.reconcile(format), /cannot be safely retired; operator repair required/);
    assert.equal((await rig.service.load(format)).gameIdFor(0, 0), undefined);
    assert.ok(!log.some(({ event }) => event.type === 'GameEnded'));
  });

  test(`${format}: upgrade recovers the ending of a first legacy launch before its link`, async () => {
    const rig = await legacyRound();
    const legacy = await rig.launcher.launch(rig.launch);
    const stored = await rig.events.load(legacy.gameId);
    await rig.events.append(legacy.gameId, stored.length - 1,
      Game.fromEvents(stored.map(({ event }) => event)).resign('b', 2000).events);
    assert.equal((await rig.service.reconcile(format)).gameIdFor(0, 0), legacy.gameId);
  });

  test(`${format}: an ambiguous ended legacy attempt requires repair instead of duplicate scoring`, async () => {
    const rig = await legacyRound();
    const stored = await rig.repo.findById(format);
    assert.ok(stored);
    await rig.repo.save({ ...stored.snapshot, gameAttempts: [['0-0', 1]] }, stored.version);
    const legacy = await rig.launcher.launch({ ...rig.launch, attempt: 1 });
    const log = await rig.events.load(legacy.gameId);
    await rig.events.append(legacy.gameId, log.length - 1,
      Game.fromEvents(log.map(({ event }) => event)).abort(2000).events);
    await assert.rejects(rig.service.reconcile(format), /Ambiguous ended legacy round launch/);
    assert.equal((await rig.service.load(format)).gameIdFor(0, 0), undefined);
  });

  test(`${format}: upgrade retires a mismatched speculative legacy game before replacement`, async () => {
    const rig = await legacyRound();
    const speculative = await rig.launcher.launch({ ...rig.launch, black: 'speculative-player' });
    const [recovered, replica] = await Promise.all([
      rig.service.reconcile(format),
      new TournamentService(rig.repo, new DurableGameLauncher(rig.events, { now: () => 1234 })).reconcile(format),
    ]);
    assert.notEqual(recovered.gameIdFor(0, 0), speculative.gameId);
    assert.equal(replica.gameIdFor(0, 0), recovered.gameIdFor(0, 0));
    assert.ok((await rig.events.load(speculative.gameId)).some(({ event }) => event.type === 'GameEnded'),
      'unlinked mismatched launch must be retired before creating a replacement');
    assert.equal((await rig.events.findActiveGamesByPlayer(rig.launch.white)).length, 1);
  });

  test(`${format}: abandoning a committed game at a probed slot never relinks the aborted game`, async () => {
    const rig = await legacyRound();
    await rig.launcher.launch({ ...rig.launch, black: 'held-player', committedRoundPairing: true });
    const started = await rig.service.reconcile(format);
    const first = started.gameIdFor(0, 0)!;
    assert.equal(first, launchGameId({ ...rig.launch, committedRoundPairing: true, attempt: 1 }));
    const stored = await rig.events.load(first);
    await rig.events.append(first, stored.length - 1, Game.fromEvents(stored.map(({ event }) => event)).abort(2000).events);
    const reporter = new TournamentResultReporter(new InMemoryPubSub(), rig.repo, rig.service,
      new ArenaService(rig.repo, rig.launcher, () => 1000), rig.events, { scanIntervalMs: 0 });
    try { await reporter.start(); await reporter.scan(); await reporter.scan(); }
    finally { reporter.stop(); }
    const after = await rig.service.load(format);
    const replacement = after.gameIdFor(0, 0)!;
    assert.notEqual(replacement, first);
    assert.ok(!(await rig.events.load(replacement)).some(({ event }) => event.type === 'GameEnded'));
    await rig.service.recordCommittedOutcome(format, first, '*');
    assert.equal((await rig.service.reconcile(format)).gameIdFor(0, 0), replacement);
  });
}
