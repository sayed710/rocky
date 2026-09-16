import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameEvent } from '@chess-platform/game';
import { InMemoryEventStore } from '../src/event-store';
import { ConcurrencyError, PersistenceError } from '../src/errors';

const created: GameEvent = {
  type: 'GameCreated',
  gameId: 'g1',
  variant: 'standard',
  initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  players: { white: 'a', black: 'b' },
  rated: false,
  at: 1,
};
const move1: GameEvent = {
  type: 'MovePlayed', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
  moveTimeMs: 500, remaining: { w: 59_500, b: 60_000 }, at: 2,
};
const move2: GameEvent = {
  type: 'MovePlayed', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
  moveTimeMs: 500, remaining: { w: 59_500, b: 59_500 }, at: 3,
};

test('a new game must start with GameCreated', async () => {
  const s = new InMemoryEventStore(() => 1);
  await assert.rejects(s.append('g1', -1, [move1]), PersistenceError);
});

test('append then load preserves order, version and timestamp; head seq is returned', async () => {
  const s = new InMemoryEventStore(() => 7);
  assert.equal(await s.append('g1', -1, [created]), 0);
  assert.equal(await s.append('g1', 0, [move1, move2]), 2);
  const log = await s.load('g1');
  assert.deepEqual(log.map((e) => e.seq), [0, 1, 2]);
  assert.equal(log[0]!.version, 1);
  assert.equal(log[0]!.serverTs, 7);
  assert.equal(log[0]!.event.type, 'GameCreated');
});

test('optimistic concurrency: a stale expectedSeq is rejected', async () => {
  const s = new InMemoryEventStore();
  await s.append('g1', -1, [created]);
  await assert.rejects(s.append('g1', -1, [move1]), ConcurrencyError);
});

test('loadSince returns only events after the cursor', async () => {
  const s = new InMemoryEventStore();
  await s.append('g1', -1, [created]);
  await s.append('g1', 0, [move1, move2]);
  assert.deepEqual((await s.loadSince('g1', 0)).map((e) => e.seq), [1, 2]);
});

test('exists reflects whether a game has any events', async () => {
  const s = new InMemoryEventStore();
  assert.equal(await s.exists('g1'), false);
  await s.append('g1', -1, [created]);
  assert.equal(await s.exists('g1'), true);
});

test('findActiveGamesByPlayer derives participation from GameCreated through GameEnded', async () => {
  const s = new InMemoryEventStore();
  const active = { ...created, gameId: 'active', players: { white: 'target', black: 'other' } };
  const finished = { ...created, gameId: 'finished', players: { white: 'other', black: 'target' } };
  const unrelated = { ...created, gameId: 'unrelated', players: { white: 'third', black: 'fourth' } };
  await s.append('active', -1, [active]);
  await s.append('finished', -1, [finished]);
  await s.append('finished', 0, [{
    type: 'GameEnded',
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    at: 2,
  }]);
  await s.append('unrelated', -1, [unrelated]);

  assert.deepEqual(await s.findActiveGamesByPlayer('target'), [{
    gameId: 'active',
    players: { white: 'target', black: 'other' },
  }]);
  assert.deepEqual(await s.findActiveGamesByPlayer('missing'), []);
});

test('stored events are isolated from later caller mutation', async () => {
  const s = new InMemoryEventStore();
  await s.append('g1', -1, [created]);
  const log = await s.load('g1');
  (log[0] as { seq: number }).seq = 99;
  assert.equal((await s.load('g1'))[0]!.seq, 0);
});
