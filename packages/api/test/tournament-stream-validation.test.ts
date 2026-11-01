import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '@chess-platform/game';
import type { TimeControl } from '@chess-platform/game';
import { CorruptGameStreamError, InMemoryEventStore, isArenaSnapshot } from '@chess-platform/persistence';
import { InMemoryTournamentsRepository } from '../src/fakes';
import { DurableGameLauncher } from '../src/tournament/durable-launcher';
import { TournamentService } from '../src/tournament/service';
import { ArenaService } from '../src/tournament/arena.service';
import { TournamentResultReporter } from '../src/tournament/reporter';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import type { LaunchInput } from '../src/tournament/launcher';

const TC: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'increment' };

const input: LaunchInput = {
  tournamentId: 't-validate',
  matchId: '0-0',
  white: 'alice',
  black: 'bob',
  variant: 'standard',
  timeControl: TC,
  attempt: 0,
  committedRoundPairing: true,
};

test('DurableGameLauncher.existing validates complete stream with projectGameStream, rejecting duplicate endings', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const { gameId } = await launcher.launch(input);

  // End the game via abort
  const stored = await events.load(gameId);
  const ended = Game.fromEvents(stored.map((e) => e.event)).abort(2000);
  await events.append(gameId, stored.length - 1, ended.events);

  // Manually append a duplicate ending to simulate a corrupt/poison stream
  const afterEnded = await events.load(gameId);
  await events.append(gameId, afterEnded.length - 1, [{
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 3000,
  }]);

  // Re-probing the slot via launcher must fail closed via projectGameStream instead of blindly .finding the first ending
  await assert.rejects(
    () => launcher.launch(input),
    (err: unknown) => err instanceof CorruptGameStreamError,
  );
});

test('DurableGameLauncher.existing validates complete stream, rejecting events after GameEnded', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const { gameId } = await launcher.launch(input);

  const stored = await events.load(gameId);
  const ended = Game.fromEvents(stored.map((e) => e.event)).abort(2000);
  await events.append(gameId, stored.length - 1, ended.events);

  // Append a move after GameEnded
  const afterEnded = await events.load(gameId);
  await events.append(gameId, afterEnded.length - 1, [{
    type: 'MovePlayed',
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    moveTimeMs: 100,
    remaining: { w: 59_900, b: 60_000 },
    at: 2500,
  }]);

  await assert.rejects(
    () => launcher.launch(input),
    (err: unknown) => err instanceof CorruptGameStreamError,
  );
});

test('DurableGameLauncher.existing accepts valid active prefixes and valid ended games', async () => {
  const events = new InMemoryEventStore();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const { gameId } = await launcher.launch(input);

  // Active prefix (no ending) is valid and recognized
  const activeLaunch = await launcher.launch(input);
  assert.equal(activeLaunch.gameId, gameId);
  assert.equal(activeLaunch.terminalOutcome, undefined);

  // Normal valid ending is recognized
  const stored = await events.load(gameId);
  const ended = Game.fromEvents(stored.map((e) => e.event)).abort(2000);
  await events.append(gameId, stored.length - 1, ended.events);

  const endedLaunch = await launcher.launch(input);
  assert.equal(endedLaunch.gameId, gameId);
  assert.equal(endedLaunch.terminalOutcome, '*');
});

test('TournamentResultReporter preserves active prefixes without recording results and preserves legitimate finished results', async () => {
  const events = new InMemoryEventStore();
  const repo = new InMemoryTournamentsRepository();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const service = new TournamentService(repo, launcher);
  const arenaService = new ArenaService(repo, launcher, () => 1000);
  const pubsub = new InMemoryPubSub();
  const reporter = new TournamentResultReporter(pubsub, repo, service, arenaService, events, { scanIntervalMs: 0 });

  await service.create({
    id: 't-legit',
    name: 'Legit Tournament',
    format: 'round_robin',
    variant: 'standard',
    timeControl: TC,
  });
  await service.register('t-legit', 'alice');
  await service.register('t-legit', 'bob');
  const started = await service.start('t-legit');
  const gameId = started.gameIdFor(0, 0)!;
  assert.ok(gameId);

  // 1. Valid active prefix (ongoing game): scan does not record any outcome
  const preScanActiveRows = structuredClone(await events.load(gameId));
  await reporter.scan();
  const ongoingSnap = await repo.findById('t-legit');
  assert.ok(ongoingSnap && !isArenaSnapshot(ongoingSnap.snapshot));
  assert.equal(ongoingSnap.snapshot.results.length, 0);
  assert.deepEqual(await events.load(gameId), preScanActiveRows);

  // 2. Legitimately end the game (Alice resigns -> black win)
  const stored = await events.load(gameId);
  const storeCountBeforeEnding = stored.length;
  const ended = Game.fromEvents(stored.map((e) => e.event)).resign('w', 2000);
  await events.append(gameId, storeCountBeforeEnding - 1, ended.events);

  const preScanEndedRows = structuredClone(await events.load(gameId));
  assert.equal(preScanEndedRows.length, storeCountBeforeEnding + ended.events.length);

  // 3. Scan reconciles the legitimate outcome into the tournament snapshot
  await reporter.scan();
  const endedSnap = await repo.findById('t-legit');
  assert.ok(endedSnap && !isArenaSnapshot(endedSnap.snapshot));
  assert.equal(endedSnap.snapshot.results.length, 1);
  assert.deepEqual(endedSnap.snapshot.results[0], ['0-0', 'black_win']);

  // 4. Verify complete store rows remain identical and no unexpected store appends occurred
  const postScanEndedRows = await events.load(gameId);
  assert.deepEqual(postScanEndedRows, preScanEndedRows);
});

test('TournamentResultReporter rejects duplicate endings and refuses to commit results or mutate store', async () => {
  const events = new InMemoryEventStore();
  const repo = new InMemoryTournamentsRepository();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const service = new TournamentService(repo, launcher);
  const arenaService = new ArenaService(repo, launcher, () => 1000);
  const pubsub = new InMemoryPubSub();
  const reporter = new TournamentResultReporter(pubsub, repo, service, arenaService, events, { scanIntervalMs: 0 });

  await service.create({
    id: 't-dup-ending',
    name: 'Duplicate Ending Tournament',
    format: 'round_robin',
    variant: 'standard',
    timeControl: TC,
  });
  await service.register('t-dup-ending', 'alice');
  await service.register('t-dup-ending', 'bob');
  const started = await service.start('t-dup-ending');
  const gameId = started.gameIdFor(0, 0)!;
  assert.ok(gameId);

  // Legitimate ending
  const stored = await events.load(gameId);
  const ended = Game.fromEvents(stored.map((e) => e.event)).resign('w', 2000);
  await events.append(gameId, stored.length - 1, ended.events);

  // Append duplicate ending to create corrupt stream
  const afterEnded = await events.load(gameId);
  await events.append(gameId, afterEnded.length - 1, [{
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 3000,
  }]);

  // Capture independently deep-cloned complete pre-scan rows
  const preScanRows = structuredClone(await events.load(gameId));

  // Scan catches CorruptGameStreamError; tournament results remain empty
  await reporter.scan();
  const snap = await repo.findById('t-dup-ending');
  assert.ok(snap && !isArenaSnapshot(snap.snapshot));
  assert.equal(snap.snapshot.results.length, 0);

  // Complete store rows must not have been appended, mutated, or rewritten
  const postScanRows = await events.load(gameId);
  assert.deepEqual(postScanRows, preScanRows);
});

test('TournamentResultReporter rejects post-terminal events and refuses to commit results or mutate store', async () => {
  const events = new InMemoryEventStore();
  const repo = new InMemoryTournamentsRepository();
  const launcher = new DurableGameLauncher(events, { now: () => 1000 });
  const service = new TournamentService(repo, launcher);
  const arenaService = new ArenaService(repo, launcher, () => 1000);
  const pubsub = new InMemoryPubSub();
  const reporter = new TournamentResultReporter(pubsub, repo, service, arenaService, events, { scanIntervalMs: 0 });

  await service.create({
    id: 't-post-terminal',
    name: 'Post Terminal Tournament',
    format: 'round_robin',
    variant: 'standard',
    timeControl: TC,
  });
  await service.register('t-post-terminal', 'alice');
  await service.register('t-post-terminal', 'bob');
  const started = await service.start('t-post-terminal');
  const gameId = started.gameIdFor(0, 0)!;
  assert.ok(gameId);

  // End the game
  const stored = await events.load(gameId);
  const ended = Game.fromEvents(stored.map((e) => e.event)).resign('w', 2000);
  await events.append(gameId, stored.length - 1, ended.events);

  // Append corrupt move after GameEnded
  const afterEnded = await events.load(gameId);
  await events.append(gameId, afterEnded.length - 1, [{
    type: 'MovePlayed',
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    moveTimeMs: 100,
    remaining: { w: 60_000, b: 59_900 },
    at: 2500,
  }]);

  // Capture independently deep-cloned complete pre-scan rows
  const preScanRows = structuredClone(await events.load(gameId));

  // Scan catches CorruptGameStreamError; tournament results remain empty
  await reporter.scan();
  const snap = await repo.findById('t-post-terminal');
  assert.ok(snap && !isArenaSnapshot(snap.snapshot));
  assert.equal(snap.snapshot.results.length, 0);

  // Complete store rows must not have been appended, mutated, or rewritten
  const postScanRows = await events.load(gameId);
  assert.deepEqual(postScanRows, preScanRows);
});
