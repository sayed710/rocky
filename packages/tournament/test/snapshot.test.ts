import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { Tournament } from '../src/tournament';
import { RoundRobinPairing } from '../src/round-robin';
import { SwissPairing } from '../src/swiss';
import type { RoundRobinConfig, SwissConfig } from '../src/config';

describe('Tournament Snapshot & Restore', () => {
  const rrConfig: RoundRobinConfig = {
    id: 't-rr',
    name: 'RR Test',
    format: 'round_robin',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }
  };

  const swissConfig: SwissConfig = {
    id: 't-swiss',
    name: 'Swiss Test',
    format: 'swiss',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rounds: 3
  };

  test('round_robin: round-trip snapshot and continue', () => {
    // 1. Setup two identical tournaments
    const tControl = new Tournament(rrConfig, new RoundRobinPairing());
    const tTest = new Tournament(rrConfig, new RoundRobinPairing());

    const players = ['A', 'B', 'C', 'D'];
    players.forEach(p => {
      tControl.register(p);
      tTest.register(p);
    });

    tControl.start();
    tTest.start();

    // 2. Play first round on both
    tControl.recordResult(0, 0, 'white_win');
    tControl.recordResult(0, 1, 'black_win');
    tTest.recordResult(0, 0, 'white_win');
    tTest.recordResult(0, 1, 'black_win');

    // 3. Snapshot tTest mid-flight
    const snap = tTest.toSnapshot();

    // 4. Restore into a new aggregate
    const tRestored = Tournament.restore(snap, new RoundRobinPairing());

    // 5. Play remaining rounds on control and restored
    const resolveRemaining = (t: Tournament) => {
      while (t.getState() === 'running') {
        const rounds = t.getRounds();
        const currentRound = rounds[rounds.length - 1];
        for (let i = 0; i < currentRound.pairings.length; i++) {
          if (currentRound.pairings[i].kind === 'game') {
            t.recordResult(currentRound.roundIndex, i, 'draw');
          }
        }
      }
    };

    resolveRemaining(tControl);
    resolveRemaining(tRestored);

    // 6. Assert identical final states
    assert.strictEqual(tRestored.getState(), 'finished');
    assert.deepStrictEqual(tRestored.getRounds(), tControl.getRounds());
    assert.deepStrictEqual(tRestored.standings(), tControl.standings());
  });

  test('swiss: round-trip snapshot and continue', () => {
    // 1. Setup two identical tournaments
    const tControl = new Tournament(swissConfig, new SwissPairing(3));
    const tTest = new Tournament(swissConfig, new SwissPairing(3));

    const players = ['P1', 'P2', 'P3', 'P4'];
    players.forEach(p => {
      tControl.register(p);
      tTest.register(p);
    });

    tControl.start();
    tTest.start();

    // 2. Play first round
    tControl.recordResult(0, 0, 'draw');
    tControl.recordResult(0, 1, 'draw');
    tTest.recordResult(0, 0, 'draw');
    tTest.recordResult(0, 1, 'draw');

    // 3. Snapshot tTest mid-flight (round 2 has now been generated)
    const snap = tTest.toSnapshot();

    // 4. Restore
    const tRestored = Tournament.restore(snap, new SwissPairing(3));

    // 5. Play remaining rounds
    const resolveRemaining = (t: Tournament) => {
      while (t.getState() === 'running') {
        const rounds = t.getRounds();
        const currentRound = rounds[rounds.length - 1];
        for (let i = 0; i < currentRound.pairings.length; i++) {
          if (currentRound.pairings[i].kind === 'game') {
            t.recordResult(currentRound.roundIndex, i, 'white_win');
          }
        }
      }
    };

    resolveRemaining(tControl);
    resolveRemaining(tRestored);

    // 6. Assert identical final states
    assert.strictEqual(tRestored.getState(), 'finished');
    assert.deepStrictEqual(tRestored.getRounds(), tControl.getRounds());
    assert.deepStrictEqual(tRestored.standings(), tControl.standings());
  });

  test('snapshot preserves withdrawal history and historical standings accurately', () => {
    const t = new Tournament(rrConfig, new RoundRobinPairing());
    const players = ['A', 'B', 'C', 'D'];
    players.forEach((p) => t.register(p));
    t.start();

    // Round 0: complete both games
    t.recordResult(0, 0, 'white_win');
    t.recordResult(0, 1, 'draw');

    // Round 1: player D withdraws
    t.withdraw('D');

    const snap = t.toSnapshot();
    assert.deepStrictEqual(snap.withdrawalRounds, [['D', 1]]);

    const restored = Tournament.restore(snap, new RoundRobinPairing());
    assert.strictEqual(restored.standingsAfterRound(0).find((s) => s.playerId === 'D')?.withdrawn, false);
    assert.strictEqual(restored.standingsAfterRound(1).find((s) => s.playerId === 'D')?.withdrawn, true);
    assert.strictEqual(restored.standings().find((s) => s.playerId === 'D')?.withdrawn, true);
  });
});
