import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import type { LaunchInput } from '../src/tournament/launcher';

/** Deterministic id generator so we can assert on the exact ids handed out. */
function counterIds(): { next(): string } {
  let n = 0;
  return { next: () => `game-${n++}` };
}

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    tournamentId: 't1',
    matchId: '0-0',
    white: 'A',
    black: 'B',
    variant: 'standard',
    timeControl: { kind: 'sudden_death', initialMs: 300000, incrementMs: 0, delayMs: 0 },
    attempt: 0,
    ...over,
  };
}

test('InMemoryGameLauncher is idempotent per (tournamentId, matchId, attempt)', async () => {
  const launcher = new InMemoryGameLauncher(counterIds());

  const first = await launcher.launch(input());
  const again = await launcher.launch(input({ white: 'X', black: 'Y' })); // same key, different payload

  assert.equal(first.gameId, 'game-0');
  assert.equal(again.gameId, 'game-0', 'relaunching the same pairing returns the original gameId');
  assert.equal(launcher.launched.length, 1, 'the game is only launched once');
});

test('InMemoryGameLauncher gives distinct games to distinct pairings', async () => {
  const launcher = new InMemoryGameLauncher(counterIds());

  const a = await launcher.launch(input({ matchId: '0-0' }));
  const b = await launcher.launch(input({ matchId: '0-1' }));
  const c = await launcher.launch(input({ tournamentId: 't2', matchId: '0-0' }));

  assert.equal(a.gameId, 'game-0');
  assert.equal(b.gameId, 'game-1');
  assert.equal(c.gameId, 'game-2');
  assert.equal(launcher.launched.length, 3);
});

test('InMemoryGameLauncher treats a bumped attempt as a fresh game', async () => {
  const launcher = new InMemoryGameLauncher(counterIds());

  const first = await launcher.launch(input({ attempt: 0 }));
  const replay = await launcher.launch(input({ attempt: 1 })); // same pairing, next attempt

  assert.equal(first.gameId, 'game-0');
  assert.equal(replay.gameId, 'game-1', 'a new attempt launches a distinct game');
  assert.equal(launcher.launched.length, 2);
});

test('InMemoryGameLauncher isolates committed Arena namespace from legacy slots', async () => {
  const launcher = new InMemoryGameLauncher(counterIds());
  const legacy = await launcher.launch(input({ matchId: 'a:1' }));
  const committed = input({ matchId: 'a:1', arenaLaunchNamespace: 'committed-v1', committedArenaPairing: true });
  const fresh = await launcher.launch(committed);
  assert.notEqual(fresh.gameId, legacy.gameId);
  assert.deepEqual(await launcher.launch(committed), fresh);
  assert.equal(launcher.launched.length, 2);
});
