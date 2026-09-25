/**
 * Production TournamentResultReporter coverage (ADR-0025): startup
 * rehydration, discovery of games launched by other processes via `scan()`
 * (what the periodic timer calls), aborted-game relaunch, and stop().
 * Hermetic: in-memory PubSub + repositories, no timers (scanIntervalMs: 0).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryPubSub, gameChannel } from '@chess-platform/realtime-gateway';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { Game } from '@chess-platform/game';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { TournamentService } from '../src/tournament/service';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { uuidv7Generator } from '../src/ports/ids';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;

interface Rig {
  pubsub: InMemoryPubSub;
  repo: InMemoryTournamentsRepository;
  events: InMemoryEventStore;
  arenaService: ArenaService;
  tournamentService: TournamentService;
  reporter: TournamentResultReporter;
}

function makeRig(scanIntervalMs = 0): Rig {
  const pubsub = new InMemoryPubSub();
  const repo = new InMemoryTournamentsRepository();
  const events = new InMemoryEventStore();
  const launcher = new InMemoryGameLauncher(uuidv7Generator);
  const arenaService = new ArenaService(repo, launcher, () => 1_000);
  const tournamentService = new TournamentService(repo, launcher);
  const reporter = new TournamentResultReporter(pubsub, repo, tournamentService, arenaService, events, {
    scanIntervalMs,
  });
  return { pubsub, repo, events, arenaService, tournamentService, reporter };
}

async function seedGame(rig: Rig, gameId: string): Promise<void> {
  const { events } = Game.create({
    gameId, variant: 'standard', timeControl: TC,
    players: { white: 'p1', black: 'p2' }, rated: true, at: 1_000,
  });
  await rig.events.append(gameId, -1, events);
}

async function makeRunningArena(rig: Rig, id: string): Promise<string> {
  await rig.arenaService.create({ id, name: id, variant: 'standard', timeControl: TC, durationMs: 3_600_000 });
  await rig.arenaService.register(id, 'p1');
  await rig.arenaService.register(id, 'p2');
  await rig.arenaService.start(id, 1_000);
  const stored = await rig.repo.findById(id);
  const links = (stored!.snapshot.gameLinks ?? []) as [string, string][];
  assert.equal(links.length, 1);
  await seedGame(rig, links[0]![1]);
  return links[0]![1];
}

async function endGame(rig: Rig, gameId: string, result: '1-0' | '0-1' | '1/2-1/2' | '*'): Promise<void> {
  const ending = {
    type: 'GameEnded' as const,
    result,
    termination: result === '*' ? 'aborted' as const : 'resignation' as const,
    winner: result === '1-0' ? 'w' as const : result === '0-1' ? 'b' as const : null,
    at: 1_000,
  };
  await rig.events.append(gameId, 0, [ending]);
  rig.pubsub.publish(gameChannel(gameId), {
    t: 'ended',
    gameId,
    result,
    termination: result === '*' ? 'aborted' : 'resignation',
    winner: result === '1-0' ? 'w' : result === '0-1' ? 'b' : null,
    serverTs: 1_000,
  });
}

/** The reporter records asynchronously off the PubSub callback. */
function settleAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('TournamentResultReporter (production)', () => {
  it('keeps the retry timer when the startup database scan fails', async () => {
    const rig = makeRig(1);
    const original = rig.repo.listRecoverableIdsAfter.bind(rig.repo);
    let attempts = 0;
    let retried!: () => void;
    const retriedPromise = new Promise<void>((resolve) => { retried = resolve; });
    rig.repo.listRecoverableIdsAfter = async (afterId, limit) => {
      attempts += 1;
      if (attempts === 1) throw new Error('injected transient database failure');
      retried();
      return original(afterId, limit);
    };
    try {
      await assert.rejects(rig.reporter.start(), /injected transient database failure/);
      await Promise.race([
        retriedPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('periodic retry did not run')), 1_000)),
      ]);
      assert.ok(attempts >= 2);
    } finally {
      rig.reporter.stop();
    }
  });

  it('rehydrates in-flight games at startup and records their results', async () => {
    const rig = makeRig();
    // The tournament was started by "another process" BEFORE this reporter
    // existed — only the stored snapshot knows about the game.
    const gameId = await makeRunningArena(rig, 'boot-arena');

    await rig.reporter.start();
    await endGame(rig, gameId, '1-0');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('boot-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 1).length, 2);
    assert.equal(standings.filter((s) => s.wins === 1).length, 1);
    rig.reporter.stop();
  });

  it('discovers games launched after startup via scan()', async () => {
    const rig = makeRig();
    await rig.reporter.start(); // nothing running yet

    // An API replica starts a tournament AFTER the reporter booted; the
    // launcher callback never fires in this process.
    const gameId = await makeRunningArena(rig, 'late-arena');
    await rig.reporter.scan(); // what the periodic timer does

    await endGame(rig, gameId, '0-1');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('late-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 1).length, 2);
    rig.reporter.stop();
  });

  it('relaunches an aborted game and watches the replacement', async () => {
    const rig = makeRig();
    const gameId = await makeRunningArena(rig, 'abort-arena');
    await rig.reporter.start();

    await endGame(rig, gameId, '*');
    await settleAsync();

    // Abandon put both players back in the pool; reconcile launched a fresh
    // game under a new id.
    const stored = await rig.repo.findById('abort-arena');
    const links = (stored!.snapshot.gameLinks ?? []) as [string, string][];
    assert.equal(links.length, 1);
    const replacement = links[0]![1];
    assert.notEqual(replacement, gameId);
    await seedGame(rig, replacement);

    // After a scan, the replacement is watched too: its result records.
    await rig.reporter.scan();
    await endGame(rig, replacement, '1/2-1/2');
    await settleAsync();
    const standings = await rig.arenaService.getStandings('abort-arena');
    assert.equal(standings.filter((s) => s.draws === 1).length, 2);
    rig.reporter.stop();
  });

  it('stop() unsubscribes everything: later broadcasts record nothing', async () => {
    const rig = makeRig();
    const gameId = await makeRunningArena(rig, 'stop-arena');
    await rig.reporter.start();
    rig.reporter.stop();

    await endGame(rig, gameId, '1-0');
    await settleAsync();

    const standings = await rig.arenaService.getStandings('stop-arena');
    assert.equal(standings.filter((s) => s.gamesPlayed === 0).length, 2);
  });

  it('does not reload historical decided round games after a process restart', async () => {
    const rig = makeRig();
    const id = 'historical-rounds';
    await rig.tournamentService.create({ id, name: id, format: 'round_robin', variant: 'standard', timeControl: TC });
    for (const player of ['p1', 'p2', 'p3', 'p4']) await rig.tournamentService.register(id, player);
    await rig.tournamentService.start(id);
    const links = (await rig.tournamentService.load(id)).toSnapshot().gameLinks ?? [];
    assert.equal(links.length, 2, 'the round must remain running after one result');
    for (const [, gameId] of links) await seedGame(rig, gameId);
    await endGame(rig, links[0]![1], '1-0');
    await rig.reporter.start();
    assert.equal((await rig.tournamentService.load(id)).resultFor(0, 0), 'white_win');
    rig.reporter.stop();

    const originalLoad = rig.events.load.bind(rig.events);
    let decidedGameLoads = 0;
    rig.events.load = async (gameId) => {
      if (gameId === links[0]![1]) decidedGameLoads += 1;
      return originalLoad(gameId);
    };
    const restarted = new TournamentResultReporter(
      rig.pubsub, rig.repo, rig.tournamentService, rig.arenaService, rig.events,
      { scanIntervalMs: 0 },
    );
    await restarted.start();
    assert.equal(decidedGameLoads, 0, 'durable result state, not the bounded cache, excludes historical games');
    restarted.stop();
  });

  it('releases a subscription when another reporter has already resolved its game', async () => {
    const rig = makeRig();
    const id = 'other-reporter-arena';
    const gameId = await makeRunningArena(rig, id);
    await rig.reporter.start();
    assert.equal(rig.pubsub.subscriberCount(gameChannel(gameId)), 1);
    await rig.arenaService.recordCommittedOutcome(id, gameId, 'white_win');
    await rig.reporter.scan();
    assert.equal(rig.pubsub.subscriberCount(gameChannel(gameId)), 0);
    rig.reporter.stop();
  });
});
