import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaTournament } from '../src/arena';
import type { Variant } from '@chess-platform/core';

const config = { id: 'arena', name: 'Arena', format: 'arena' as const, variant: 'standard' as const,
  durationMs: 100, timeControl: { kind: 'increment' as const, initialMs: 60_000, incrementMs: 0, delayMs: 0 } };

for (const variant of ['standard', 'chess960', 'atomic', 'crazyhouse', 'horde', 'kingofthehill', 'racingkings', 'threecheck'] as const satisfies readonly Variant[]) {
  test(`exact restored deadline and post-deadline scoring: ${variant}`, () => {
    for (const delta of [-1, 0, 1]) {
      const arena = new ArenaTournament({ ...config, variant });
      assert.equal(arena.isExpired(Number.MAX_SAFE_INTEGER), false);
      arena.register('A'); arena.register('B'); arena.start(1_000);
      const restored = ArenaTournament.restore(arena.toSnapshot());
      const pairings = restored.pairAvailable(1_100 + delta);
      assert.equal(pairings.length, delta < 0 ? 1 : 0);
      if (delta < 0) {
        restored.settle(1_100); assert.equal(restored.getState(), 'running');
        restored.recordResult(pairings[0]!.pairingId, 'white_win', 1_101);
        assert.equal(restored.getState(), 'finished');
        assert.equal(restored.standings()[0]!.points, 2);
        assert.equal(restored.standings()[0]!.gamesPlayed, 1);
        restored.settle(1_101); assert.equal(restored.getState(), 'finished');
      }
    }
  });
}

test('invalid time arithmetic and corrupt persisted player/game state fail closed', () => {
  for (const now of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new ArenaTournament(config).start(now), /Invalid Arena/);
  }
  const arena = new ArenaTournament(config);
  arena.register('A'); arena.register('B'); arena.start(1_000);
  for (const change of [
    { startedAtMs: undefined }, { activeGames: null },
    { playerStates: { A: {}, B: {} } }, { playedAsWhite: {} },
    { activeGames: { 'a:1': { white: 'A', black: 'B' } }, pairingSequence: 0 },
  ]) {
    assert.throws(() => ArenaTournament.restore({ ...arena.toSnapshot(), ...change } as never), /operator repair required/);
  }
});

test('Arena game links cannot replace a live game or steal another pairing game', () => {
  const arena = new ArenaTournament(config);
  for (const player of ['A', 'B', 'C', 'D']) arena.register(player);
  arena.start(1_000); arena.pairAvailable(1_000);
  arena.linkGame('a:1', 'game-one');
  assert.throws(() => arena.linkGame('a:1', 'game-two'), /already linked/);
  assert.throws(() => arena.linkGame('a:2', 'game-one'), /another pairing/);
  arena.linkGame('a:1', 'game-one'); // same link is idempotent
});

test('new Arena authorization persists a namespace while legacy entries remain unmarked', () => {
  const arena = new ArenaTournament(config);
  arena.register('A'); arena.register('B'); arena.start(1_000); arena.pairAvailable(1_000);
  const snapshot = arena.toSnapshot();
  assert.equal(snapshot.activeGames['a:1']!.launchNamespace, 'committed-v1');
  assert.deepEqual(ArenaTournament.restore(snapshot).toSnapshot(), snapshot);
  const legacy = { ...snapshot, activeGames: { 'a:1': { white: 'A', black: 'B' } } };
  assert.deepEqual(ArenaTournament.restore(legacy).toSnapshot().activeGames, legacy.activeGames);
  assert.throws(() => ArenaTournament.restore({ ...snapshot,
    activeGames: { 'a:1': { white: 'A', black: 'B', launchNamespace: 'unknown' } } } as never), /operator repair required/);
});
