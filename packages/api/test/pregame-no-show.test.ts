/**
 * Which creation paths get the pregame lifecycle, and how a tournament records a no-show (ADR-0148).
 * Hermetic: in-memory stores; the endings are produced by the real domain, not written by hand.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryPubSub, gameChannel } from '@chess-platform/realtime-gateway';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { Game, type GameEvent } from '@chess-platform/game';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { ArenaService } from '../src/tournament/arena.service';
import { TournamentService } from '../src/tournament/service';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import { TournamentResultReporter, tournamentOutcome } from '../src/tournament/reporter';
import { startHarness } from './helpers';

const TC = { kind: 'increment', initialMs: 60_000, incrementMs: 0, delayMs: 0 } as const;
const TOURNAMENT_DEADLINE_MS = 300_000;

interface Rig {
  readonly pubsub: InMemoryPubSub;
  readonly repo: InMemoryTournamentsRepository;
  readonly events: InMemoryEventStore;
  readonly tournaments: TournamentService;
  readonly arenas: ArenaService;
  readonly reporter: TournamentResultReporter;
}

function rig(): Rig {
  const pubsub = new InMemoryPubSub();
  const repo = new InMemoryTournamentsRepository();
  const events = new InMemoryEventStore();
  // The production launcher, so the linked games carry the source the no-show rule reads.
  const launcher = new DurableGameLauncher(events, { now: () => 1_000 });
  const tournaments = new TournamentService(repo, launcher);
  const arenas = new ArenaService(repo, launcher, () => 1_000);
  const reporter = new TournamentResultReporter(pubsub, repo, tournaments, arenas, events, { scanIntervalMs: 0 });
  return { pubsub, repo, events, tournaments, arenas, reporter };
}

/** Mark the given seats ready, then let the no-show deadline expire the game, as the owner would. */
async function noShow(r: Rig, gameId: string, ready: readonly ('w' | 'b')[]): Promise<GameEvent> {
  const stored = await r.events.load(gameId);
  let game = Game.fromEvents(stored.map((e) => e.event));
  let head = stored.at(-1)!.seq;
  for (const color of ready) {
    const step = game.markReady(color, 2_000);
    head = await r.events.append(gameId, head, step.events);
    game = step.game;
  }
  const ended = game.expireNoShow(TOURNAMENT_DEADLINE_MS, 1_000 + TOURNAMENT_DEADLINE_MS);
  await r.events.append(gameId, head, ended.events);
  const ending = ended.events[0]!;
  if (ending.type !== 'GameEnded') throw new Error('unreachable');
  r.pubsub.publish(gameChannel(gameId), {
    t: 'ended', gameId, result: ending.result, termination: ending.termination, winner: ending.winner, serverTs: ending.at,
  });
  return ending;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function roundRobin(r: Rig, id: string): Promise<string> {
  await r.tournaments.create({ id, name: id, format: 'round_robin', variant: 'standard', timeControl: TC });
  for (const player of ['p1', 'p2']) await r.tournaments.register(id, player);
  await r.tournaments.start(id);
  const links = (await r.tournaments.load(id)).toSnapshot().gameLinks ?? [];
  assert.equal(links.length, 1);
  return links[0]![1];
}

describe('pregame no-show in tournaments', () => {
  it('maps only a winnerless no-show to a double forfeit; a plain abort stays a relaunch', () => {
    assert.equal(tournamentOutcome({ result: '*', termination: 'no_show' }), 'double_forfeit');
    assert.equal(tournamentOutcome({ result: '1-0', termination: 'no_show' }), 'white_win');
    assert.equal(tournamentOutcome({ result: '0-1', termination: 'no_show' }), 'black_win');
    assert.equal(tournamentOutcome({ result: '*', termination: 'aborted' }), '*');
  });

  it('the durable launcher stamps tournament games with their source', async () => {
    const r = rig();
    const gameId = await roundRobin(r, 'source-rr');
    const created = (await r.events.load(gameId))[0]!.event;
    assert.ok(created.type === 'GameCreated' && created.source === 'tournament');
    assert.equal(Game.fromEvents([created]).snapshot().clock.turnStartedAt, null);
  });

  for (const [ready, expected] of [[['w'], 'white_win'], [['b'], 'black_win']] as const) {
    it(`a round game with only ${ready[0] === 'w' ? 'White' : 'Black'} ready is recorded as ${expected}, with no relaunch`, async () => {
      const r = rig();
      const gameId = await roundRobin(r, `one-ready-${expected}`);
      await r.reporter.start();
      await noShow(r, gameId, ready);
      await settle();
      const t = await r.tournaments.load(`one-ready-${expected}`);
      assert.equal(t.resultFor(0, 0), expected);
      assert.equal(t.launchAttemptFor(0, 0), 0, 'no replacement game was launched');
      assert.equal(t.gameIdFor(0, 0), gameId);
      r.reporter.stop();
    });
  }

  it('a round game with neither player ready is a double forfeit, never relaunched, and recovers after a restart', async () => {
    const r = rig();
    const id = 'double-forfeit-rr';
    const gameId = await roundRobin(r, id);
    // The ending commits while no reporter is running; startup recovery must find it.
    await noShow(r, gameId, []);
    await r.reporter.start();
    let t = await r.tournaments.load(id);
    assert.equal(t.resultFor(0, 0), 'double_forfeit');
    assert.equal(t.launchAttemptFor(0, 0), 0, 'the aborted-game relaunch did not run');
    assert.equal(t.gameIdFor(0, 0), gameId);
    const standings = t.standings();
    assert.deepEqual(standings.map((s) => [s.points, s.losses]), [[0, 1], [0, 1]]);
    r.reporter.stop();

    // A second reporter replaying the same committed ending changes nothing.
    const replay = new TournamentResultReporter(r.pubsub, r.repo, r.tournaments, r.arenas, r.events, { scanIntervalMs: 0 });
    await replay.start();
    await r.tournaments.recordCommittedOutcome(id, gameId, 'double_forfeit');
    t = await r.tournaments.load(id);
    assert.equal(t.resultFor(0, 0), 'double_forfeit');
    assert.equal(t.launchAttemptFor(0, 0), 0);
    replay.stop();
  });

  it('an arena records a no-show double forfeit as a loss for both instead of abandoning the pairing', async () => {
    const r = rig();
    const id = 'double-forfeit-arena';
    await r.arenas.create({ id, name: id, variant: 'standard', timeControl: TC, durationMs: 3_600_000 });
    await r.arenas.register(id, 'p1');
    await r.arenas.register(id, 'p2');
    await r.arenas.start(id, 1_000);
    const links = ((await r.repo.findById(id))!.snapshot.gameLinks ?? []) as [string, string][];
    await r.reporter.start();
    await noShow(r, links[0]![1], []);
    await settle();
    const standings = await r.arenas.getStandings(id);
    assert.deepEqual(standings.map((s) => [s.gamesPlayed, s.losses, s.points]), [[1, 1, 0], [1, 1, 0]]);
    r.reporter.stop();
  });
});

describe('pregame lifecycle by creation path', () => {
  const tc = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } as const;

  it('an accepted seek is a seek game; a bot game keeps the original lifecycle', async () => {
    const h = await startHarness();
    try {
      const creator = await h.makeUser('noshow-creator', ['user']);
      const acceptor = await h.makeUser('noshow-acceptor', ['user']);
      const seek = await h.json('POST', '/v1/seeks', { token: creator.token, body: { variant: 'standard', timeControl: tc } });
      const accepted = await h.json('POST', `/v1/seeks/${seek.body.id}/accept`, { token: acceptor.token });
      assert.equal(accepted.status, 200);
      const seekCreated = (await h.repos.events.load(accepted.body.gameId))[0]!.event;
      assert.ok(seekCreated.type === 'GameCreated' && seekCreated.source === 'seek');

      const bot = await h.json('POST', '/v1/games/bot', { token: creator.token, body: { level: 'novice', variant: 'standard', timeControl: tc } });
      assert.equal(bot.status, 200);
      const botCreated = (await h.repos.events.load(bot.body.id))[0]!.event;
      assert.ok(botCreated.type === 'GameCreated' && !('source' in botCreated), 'no readiness or no-show for bot games');
    } finally {
      await h.close();
    }
  });
});
