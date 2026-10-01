import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { DurableGameLauncher, launchGameId } from '../src/tournament/durable-launcher';
import { DurableTournamentLiveView } from '../src/tournament/durable-live-view';
import type { LaunchInput } from '../src/tournament/launcher';

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
