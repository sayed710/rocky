import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { Tournament } from '../src/tournament';
import { RoundRobinPairing } from '../src/round-robin';
import type { RoundRobinConfig } from '../src/config';

describe('Tournament Aggregate (round-by-round)', () => {
  const config: RoundRobinConfig = {
    id: 't1',
    name: 'Test Tournament',
    format: 'round_robin',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }
  };

  test('state machine: registration -> running -> finished (round-by-round)', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    
    assert.strictEqual(t.getState(), 'registration');
    t.register('Alice');
    t.register('Bob');
    t.register('Charlie');

    t.start();
    assert.strictEqual(t.getState(), 'running');

    // N=3: 3 rounds total, but only round 0 is generated on start
    assert.throws(() => t.register('Dave'), /Cannot register after tournament has started/);
    assert.throws(() => t.start(), /Tournament already started/);

    // Initially only round 0 is visible
    assert.ok(t.getRounds().length >= 1, 'At least round 0 exists after start');

    // Resolve all rounds one at a time
    let totalGames = 0;
    while (t.getState() === 'running') {
      const rounds = t.getRounds();
      const currentRound = rounds[rounds.length - 1];
      for (let i = 0; i < currentRound.pairings.length; i++) {
        if (currentRound.pairings[i].kind === 'game') {
          t.recordResult(currentRound.roundIndex, i, 'white_win');
          totalGames++;
        }
      }
    }

    assert.strictEqual(t.getState(), 'finished');
    assert.strictEqual(t.getRounds().length, 3, '3 rounds total for 3 players');
    assert.strictEqual(totalGames, 3, '3 games total for 3 players');
  });

  test('rounds appear incrementally', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');

    t.start();

    // After start, only round 0 should exist
    assert.strictEqual(t.getRounds().length, 1);
    assert.strictEqual(t.getRounds()[0].roundIndex, 0);

    // Resolve round 0
    const r0 = t.getRounds()[0];
    for (let i = 0; i < r0.pairings.length; i++) {
      if (r0.pairings[i].kind === 'game') {
        t.recordResult(0, i, 'draw');
      }
    }

    // Round 1 should now be available
    assert.strictEqual(t.getRounds().length, 2);
    assert.strictEqual(t.getRounds()[1].roundIndex, 1);
  });

  test('rejects start with less than 2 players', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    assert.throws(() => t.start(), /Need at least 2 players/);
  });

  test('rejects recording results before start', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    t.register('Bob');
    assert.throws(() => t.recordResult(0, 0, 'draw'), /Cannot record result unless tournament is running/);
  });

  test('rejects recording results for unknown pairing', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('Alice');
    t.register('Bob');
    t.start();
    assert.throws(() => t.recordResult(99, 0, 'white_win'), /Unknown pairing/);
  });

  test('standings work during a running tournament', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    // Before any results, every player starts from zero — no points, games, or byes.
    const s = t.standings();
    assert.strictEqual(s.length, 2);
    assert.ok(
      s.every(entry => entry.points === 0 && entry.gamesPlayed === 0 && entry.byes === 0),
      'all standings should start at zero before any result is recorded'
    );
  });

  test('game linking and lookup', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C'); // A, B, C -> round robin has byes
    t.start();

    const rounds = t.getRounds();
    const r0 = rounds[0];
    
    // Find a game pairing and a bye pairing
    const gameIdx = r0.pairings.findIndex(p => p.kind === 'game');
    const byeIdx = r0.pairings.findIndex(p => p.kind === 'bye');
    
    // Link game
    t.linkGame(0, gameIdx, 'game-123');
    
    // Verify lookups
    assert.strictEqual(t.gameIdFor(0, gameIdx), 'game-123');
    assert.deepStrictEqual(t.pairingForGame('game-123'), { roundIndex: 0, pairingIndex: gameIdx });
    
    // Unknown lookups
    assert.strictEqual(t.gameIdFor(0, 99), undefined);
    assert.strictEqual(t.pairingForGame('game-999'), null);
    
    // Bye linking fails
    assert.throws(() => t.linkGame(0, byeIdx, 'game-bye'), /Cannot link game to a bye/);
    
    // Unknown pairing fails
    assert.throws(() => t.linkGame(99, 0, 'game-unknown'), /Unknown pairing/);
  });

  test('re-linking a match retires the old gameId from the reverse map', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    t.linkGame(0, 0, 'game-old');
    assert.deepStrictEqual(t.pairingForGame('game-old'), { roundIndex: 0, pairingIndex: 0 });

    // Re-link the same match to a new game (e.g. the first launch was abandoned).
    t.linkGame(0, 0, 'game-new');
    assert.strictEqual(t.gameIdFor(0, 0), 'game-new');
    assert.deepStrictEqual(t.pairingForGame('game-new'), { roundIndex: 0, pairingIndex: 0 });

    // The stale id must no longer resolve to a pairing or record a result.
    assert.strictEqual(t.pairingForGame('game-old'), null);
    assert.throws(() => t.recordResultByGame('game-old', 'white_win'), /Unknown game ID/);
  });

  test('abandonGame unlinks and bumps the launch attempt', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    assert.strictEqual(t.launchAttemptFor(0, 0), 0);
    t.linkGame(0, 0, 'game-a');

    // Abandon the (undecided) game: it unlinks and the attempt counter bumps.
    t.abandonGame('game-a');
    assert.strictEqual(t.gameIdFor(0, 0), undefined, 'abandoned game is unlinked');
    assert.strictEqual(t.pairingForGame('game-a'), null);
    assert.strictEqual(t.launchAttemptFor(0, 0), 1, 'attempt is bumped for a fresh launch');

    // A fresh game can now be linked to the same pairing.
    t.linkGame(0, 0, 'game-a2');
    assert.strictEqual(t.gameIdFor(0, 0), 'game-a2');

    // Abandoning unknown / decided games is rejected.
    assert.throws(() => t.abandonGame('game-nope'), /Unknown game ID/);
    t.recordResultByGame('game-a2', 'white_win');
    assert.throws(() => t.abandonGame('game-a2'), /already has a result/);
  });

  test('abandon attempt survives snapshot round-trip', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();
    t.linkGame(0, 0, 'game-a');
    t.abandonGame('game-a');

    const restored = Tournament.restore(t.toSnapshot(), new RoundRobinPairing());
    assert.strictEqual(restored.launchAttemptFor(0, 0), 1);
  });

  test('recordResultByGame works', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    t.linkGame(0, 0, 'game-1');
    t.recordResultByGame('game-1', 'white_win');
    
    assert.strictEqual(t.getState(), 'finished');
    const snap = t.toSnapshot();
    assert.strictEqual(snap.results[0][1], 'white_win');
  });

  test('recordResultByGame throws for unknown game', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    assert.throws(() => t.recordResultByGame('unknown-game', 'white_win'), /Unknown game ID/);
  });

  test('snapshot backwards compatibility and game links persistence', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();
    t.linkGame(0, 0, 'game-xyz');
    
    const snap = t.toSnapshot();
    assert.ok(snap.gameLinks);
    assert.strictEqual(snap.gameLinks[0][1], 'game-xyz');

    // Restore from snapshot with links
    const t2 = Tournament.restore(snap, new RoundRobinPairing());
    assert.strictEqual(t2.gameIdFor(0, 0), 'game-xyz');
    
    // Restore from snapshot WITHOUT links (simulating old data)
    const oldSnap = { ...snap, gameLinks: undefined };
    const t3 = Tournament.restore(oldSnap, new RoundRobinPairing());
    assert.strictEqual(t3.gameIdFor(0, 0), undefined);
    assert.strictEqual(t3.pairingForGame('game-xyz'), null);
  });

  test('withdraw during registration removes from participants', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.withdraw('A');
    assert.deepStrictEqual(t.getParticipants(), ['B']);
  });

  test('withdraw during running forfeits the withdrawing player\'s unfinished game', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.start();

    // Pick a player seated in a real game this round (not the bye) and withdraw
    // them; the game must be forfeited to their opponent.
    const round0 = t.getRounds()[0];
    const gameIdx = round0.pairings.findIndex((p) => p.kind === 'game');
    const gamePairing = round0.pairings[gameIdx];
    assert.ok(gamePairing.kind === 'game');
    const withdrawer = gamePairing.white;
    const opponent = gamePairing.black;

    t.withdraw(withdrawer);

    const snap = t.toSnapshot();
    assert.ok(snap.withdrawn?.includes(withdrawer));

    // The withdrawer was White, so the forfeit is recorded as a Black win.
    const forfeit = snap.results.find(([mid]) => mid === `0-${gameIdx}`);
    assert.strictEqual(forfeit?.[1], 'black_win');

    const standings = t.standings();
    assert.strictEqual(standings.find((s) => s.playerId === withdrawer)!.withdrawn, true);
    assert.ok(
      standings.find((s) => s.playerId === opponent)!.points >= 1,
      'opponent receives the forfeit point',
    );
  });

  test('withdraw leaves tournament finished if less than 2 active players', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.start();

    assert.strictEqual(t.getState(), 'running');
    t.withdraw('A');
    assert.strictEqual(t.getState(), 'finished', 'tournament finishes gracefully');
  });

  test('indexRound safety net: withdrawn players forfeit future round-robin games (incl. double forfeit)', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();

    // Round-robin keeps its fixed 4-player schedule for standings/history, so
    // the safety net in indexRound must auto-forfeit every future game a
    // withdrawn player is scheduled to appear in. A and B are scheduled to meet
    // each other, which exercises the double-forfeit branch.
    t.withdraw('A');
    t.withdraw('B');

    const snap = t.toSnapshot();
    const results = new Map(snap.results);
    const withdrawn = new Set(snap.withdrawn ?? []);

    let sawDoubleForfeit = false;
    for (const [mid, pairing] of snap.pairingsByMatchId) {
      if (pairing.p2 === null) continue; // bye, handled elsewhere
      const whiteOut = withdrawn.has(pairing.p1);
      const blackOut = withdrawn.has(pairing.p2);
      if (whiteOut && blackOut) {
        assert.strictEqual(results.get(mid), 'double_forfeit', `match ${mid} should be a double forfeit`);
        sawDoubleForfeit = true;
      } else if (whiteOut) {
        assert.strictEqual(results.get(mid), 'black_win', `match ${mid}: active Black wins by forfeit`);
      } else if (blackOut) {
        assert.strictEqual(results.get(mid), 'white_win', `match ${mid}: active White wins by forfeit`);
      }
    }
    assert.ok(sawDoubleForfeit, 'the A-vs-B pairing should trigger a double forfeit');

    // Withdrawn players never accrue points from forfeits.
    const standings = t.standings();
    assert.strictEqual(standings.find((s) => s.playerId === 'A')!.points, 0);
    assert.strictEqual(standings.find((s) => s.playerId === 'B')!.points, 0);
  });

  test('standingsAfterRound reports truthful historical withdrawal state', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();

    // Round 0: 4 players -> 2 games. Play them both.
    const r0 = t.getRounds()[0];
    for (let i = 0; i < r0.pairings.length; i++) {
      t.recordResult(0, i, 'white_win');
    }

    // Now round 1 has started. D withdraws during round 1.
    assert.strictEqual(t.getRounds().length, 2);
    assert.strictEqual(t.getRounds()[1].roundIndex, 1);

    t.withdraw('D');

    // A. Historical flag before withdrawal:
    // standingsAfterRound(0) must show D as NOT withdrawn (withdrawn === false)
    const standingsR0 = t.standingsAfterRound(0);
    const dStandingR0 = standingsR0.find((s) => s.playerId === 'D');
    assert.ok(dStandingR0, 'D exists in round 0 standings');
    assert.strictEqual(
      dStandingR0.withdrawn,
      false,
      'D was active at end of round 0 and must not be marked withdrawn in round 0 standings',
    );

    // B. Withdrawal round itself:
    const standingsR1 = t.standingsAfterRound(1);
    const dStandingR1 = standingsR1.find((s) => s.playerId === 'D');
    assert.ok(dStandingR1, 'D exists in round 1 standings');
    assert.strictEqual(
      dStandingR1.withdrawn,
      true,
      'D withdrew during round 1 and must be marked withdrawn in round 1 standings',
    );

    // C. Current standings unchanged:
    const currentStandings = t.standings();
    const dCurrent = currentStandings.find((s) => s.playerId === 'D');
    assert.strictEqual(dCurrent?.withdrawn, true, 'D is currently withdrawn');

    // D. Earlier results remain historical:
    assert.strictEqual(dStandingR0.gamesPlayed, 1);
    assert.strictEqual(dStandingR0.losses, 1);
    assert.strictEqual(dStandingR0.points, 0);

    // E. Snapshot round-trip:
    const snap = t.toSnapshot();
    const restored = Tournament.restore(snap, new RoundRobinPairing());

    const restoredR0 = restored.standingsAfterRound(0);
    assert.strictEqual(restoredR0.find((s) => s.playerId === 'D')?.withdrawn, false);

    const restoredR1 = restored.standingsAfterRound(1);
    assert.strictEqual(restoredR1.find((s) => s.playerId === 'D')?.withdrawn, true);

    const restoredCurrent = restored.standings();
    assert.strictEqual(restoredCurrent.find((s) => s.playerId === 'D')?.withdrawn, true);
  });

  test('withdraw is idempotent and retains initial withdrawal round', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();

    // D withdraws in round 0
    t.withdraw('D');
    t.withdraw('D');

    const snap = t.toSnapshot();
    assert.deepStrictEqual(snap.withdrawalRounds, [['D', 0]]);

    // Finish remaining game in round 0
    const r0 = t.getRounds()[0];
    for (let i = 0; i < r0.pairings.length; i++) {
      const matchId = `0-${i}`;
      if (!snap.results.some(([m]) => m === matchId)) {
        t.recordResult(0, i, 'draw');
      }
    }

    if (t.getState() === 'running') {
      // Repeated withdrawal in round 1
      t.withdraw('D');
      const snap2 = t.toSnapshot();
      assert.deepStrictEqual(snap2.withdrawalRounds, [['D', 0]]);
      assert.strictEqual(t.standingsAfterRound(0).find((s) => s.playerId === 'D')?.withdrawn, true);
    }
  });

  test('registration withdrawal does not create historical withdrawal records', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.withdraw('C');

    assert.deepStrictEqual(t.getParticipants(), ['A', 'B']);
    const snap = t.toSnapshot();
    assert.strictEqual(snap.withdrawn?.includes('C') ?? false, false);
    assert.strictEqual(snap.withdrawalRounds?.length ?? 0, 0);

    t.start();
    t.recordResult(0, 0, 'white_win');

    const standings = t.standingsAfterRound(0);
    assert.strictEqual(standings.some((s) => s.playerId === 'C'), false);
  });

  test('legacy snapshot restore without withdrawalRounds preserves legacy observable semantics', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();

    // Round 0
    t.recordResult(0, 0, 'white_win');
    t.recordResult(0, 1, 'draw');

    // Round 1
    t.withdraw('D');

    // Simulate a legacy snapshot that has `withdrawn: ['D']` but lacks `withdrawalRounds`
    const snap = t.toSnapshot();
    const legacySnap = {
      ...snap,
      withdrawalRounds: undefined
    };

    const restored = Tournament.restore(legacySnap, new RoundRobinPairing());
    const r0Standings = restored.standingsAfterRound(0);
    assert.strictEqual(
      r0Standings.find((s) => s.playerId === 'D')?.withdrawn,
      true,
      'Legacy snapshots without withdrawalRounds preserve legacy behavior where withdrawn was true across all rounds',
    );
    assert.strictEqual(restored.standings().find((s) => s.playerId === 'D')?.withdrawn, true);
  });

  test('withdrawal round is captured before forfeit causes synchronous round advancement', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();

    // In round 0, resolve the match not involving D first
    const r0 = t.getRounds()[0];
    const dPairingIdx = r0.pairings.findIndex(
      (p) => p.kind === 'game' && (p.white === 'D' || p.black === 'D'),
    );
    const otherPairingIdx = dPairingIdx === 0 ? 1 : 0;
    t.recordResult(0, otherPairingIdx, 'white_win');

    // Withdrawing D will forfeit the only remaining game in round 0,
    // immediately completing round 0 and causing tryAdvance() to generate round 1
    assert.strictEqual(t.getRounds().length, 1);
    t.withdraw('D');

    assert.strictEqual(t.getRounds().length, 2);
    assert.strictEqual(t.getRounds()[1].roundIndex, 1);

    const snap = t.toSnapshot();
    assert.deepStrictEqual(snap.withdrawalRounds, [['D', 0]]);
    assert.strictEqual(t.standingsAfterRound(0).find((s) => s.playerId === 'D')?.withdrawn, true);
  });

  test('snapshot withdrawalRounds is isolated from live aggregate mutations', () => {
    const t = new Tournament(config, new RoundRobinPairing());
    t.register('A');
    t.register('B');
    t.register('C');
    t.register('D');
    t.start();
    t.withdraw('D');

    const snap = t.toSnapshot();
    assert.ok(snap.withdrawalRounds);
    (snap.withdrawalRounds as unknown as [string, number][]).push(['MUTATED', 99]);

    const snap2 = t.toSnapshot();
    assert.deepStrictEqual(snap2.withdrawalRounds, [['D', 0]]);
  });
});
