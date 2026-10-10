import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArenaService, DurableGameLauncher, InMemoryTournamentsRepository, TournamentResultReporter, TournamentService } from '@chess-platform/api';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { createReportingLauncher } from '../src/reporting-launcher.js';

for (const format of ['swiss', 'round_robin'] as const) {
  test(`${format}: production reporting launcher replaces a linked probed legacy abort`, async () => {
    const events = new InMemoryEventStore();
    const repo = new InMemoryTournamentsRepository();
    const durable = new DurableGameLauncher(events, { now: () => 1234 });
    const watched: string[] = [];
    const launcher = createReportingLauncher(durable, (_id, gameId) => watched.push(gameId));
    const service = new TournamentService(repo, launcher);
    const timeControl = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;
    await service.create({ id: format, name: format, format, rounds: 3, variant: 'standard', timeControl });
    for (const player of ['A', 'B', 'C', 'D']) await service.register(format, player);
    const domain = await service.load(format);
    domain.start();
    const pairing = domain.getRounds()[0]!.pairings[0]!;
    assert.ok(pairing.kind === 'game');
    const input = { tournamentId: format, matchId: '0-0', white: pairing.white,
      black: pairing.black, variant: 'standard', timeControl, attempt: 0 };
    const held = await durable.launch({ ...input, black: 'old-slot-holder' });
    let log = await events.load(held.gameId);
    await events.append(held.gameId, log.length - 1, Game.fromEvents(log.map(({ event }) => event)).abort(1500).events);
    const legacy = await durable.launch(input);
    domain.linkGame(0, 0, legacy.gameId); // Pre-upgrade link saved cursor zero despite probing.
    const stored = await repo.findById(format);
    await repo.save(domain.toSnapshot(), stored!.version);
    log = await events.load(legacy.gameId);
    await events.append(legacy.gameId, log.length - 1, Game.fromEvents(log.map(({ event }) => event)).abort(2000).events);
    const reporter = new TournamentResultReporter(new InMemoryPubSub(), repo, service,
      new ArenaService(repo, launcher, () => 1234), events, { scanIntervalMs: 0 });
    try { await reporter.start(); for (let scan = 0; scan < 10; scan++) await reporter.scan(); }
    finally { reporter.stop(); }
    const after = await service.load(format);
    const replacement = after.gameIdFor(0, 0)!;
    assert.notEqual(replacement, legacy.gameId);
    assert.equal(after.launchAttemptFor(0, 0), 2);
    assert.ok(watched.includes(replacement), 'replacement is watched through the production decorator');
    assert.ok(!(await events.load(replacement)).some(({ event }) => event.type === 'GameEnded'));
    assert.equal((await events.findActiveGamesByPlayer(input.white)).length, 1);
  });
}
