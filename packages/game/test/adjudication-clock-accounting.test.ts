import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TimeControl } from '../src/clock';
import { GameError, MAX_SAFE_TIMESTAMP_MS } from '../src/clock';
import {
  applyCompletedTurn,
  computeActiveThinkingMs,
  computeDisplayBalances,
  computeFlagDeadline,
  computeNoShowDeadline,
  computeRemainingDelayMs,
  createAdjudicationClockBasis,
  freezeClockBasis,
  getClockAccountingSnapshot,
  hasFlaggedAt,
  isNoShowDueAt,
  releaseClockBasis,
  validateClockBasis,
  validateTimeControl,
  type AdjudicationClockBasis,
  type ApplyCompletedTurnOptions,
  type CreateAdjudicationClockBasisParams,
  type RetainedTimestampAuthorization,
  type StopLineage,
} from '../src/adjudication-clock-accounting';

describe('adjudication-clock-accounting: pure stopped-turn accounting foundation', () => {
  const tcDelay100: TimeControl = {
    initialMs: 1000,
    incrementMs: 0,
    delayMs: 100,
    kind: 'delay',
  };

  const tcInc50: TimeControl = {
    initialMs: 1000,
    incrementMs: 50,
    delayMs: 0,
    kind: 'increment',
  };

  const tcUnlimited: TimeControl = {
    initialMs: 0,
    incrementMs: 0,
    delayMs: 0,
    kind: 'unlimited',
  };

  const tcSuddenDeath: TimeControl = {
    initialMs: 1000,
    incrementMs: 0,
    delayMs: 0,
    kind: 'sudden_death',
  };

  describe('Design Brief Concrete Target Vectors (B1000, S5000)', () => {
    it('Vector 1: D100/E40/T4990 with retained-T authorization evaluates to balance 1000', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-lineage-1',
      });
      const auth: RetainedTimestampAuthorization = {
        stopId: 'stop-lineage-1',
        retainedTimestampMs: 4990,
      };

      const activeThinking = computeActiveThinkingMs(basis, 4990, tcDelay100, auth);
      assert.equal(activeThinking, 40);

      const balances = computeDisplayBalances(basis, 4990, tcDelay100, auth);
      assert.equal(balances.w, 1000);
      assert.equal(balances.b, 800);
    });

    it('Vector 2: D100/E100/T5000 evaluates to balance 1000', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 100,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const activeThinking = computeActiveThinkingMs(basis, 5000, tcDelay100);
      assert.equal(activeThinking, 100);

      const balances = computeDisplayBalances(basis, 5000, tcDelay100);
      assert.equal(balances.w, 1000);
      assert.equal(balances.b, 800);
    });

    it('Vector 3: D100/E160/T4990 with retained-T authorization evaluates to balance 940', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 160,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-lineage-1',
      });
      const auth: RetainedTimestampAuthorization = {
        stopId: 'stop-lineage-1',
        retainedTimestampMs: 4990,
      };

      const activeThinking = computeActiveThinkingMs(basis, 4990, tcDelay100, auth);
      assert.equal(activeThinking, 160);

      const balances = computeDisplayBalances(basis, 4990, tcDelay100, auth);
      assert.equal(balances.w, 940);
      assert.equal(balances.b, 800);
    });

    it('Vector 4: D100/E160/T5030 evaluates to balance 910', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 160,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const activeThinking = computeActiveThinkingMs(basis, 5030, tcDelay100);
      assert.equal(activeThinking, 190);

      const balances = computeDisplayBalances(basis, 5030, tcDelay100);
      assert.equal(balances.w, 910);
      assert.equal(balances.b, 800);
    });

    it('Vector 5: D100/E40/T5080 evaluates to balance 980 and remaining delay 0', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const activeThinking = computeActiveThinkingMs(basis, 5080, tcDelay100);
      assert.equal(activeThinking, 120);

      const balances = computeDisplayBalances(basis, 5080, tcDelay100);
      assert.equal(balances.w, 980);
      assert.equal(balances.b, 800);

      const remainingDelay = computeRemainingDelayMs(basis, 5080, tcDelay100);
      assert.equal(remainingDelay, 0);
    });

    it('Vector 6: D0/E160/T4990/increment50 evaluates to 840 before, 890 after completion', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 160,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-lineage-1',
      });
      const auth: RetainedTimestampAuthorization = {
        stopId: 'stop-lineage-1',
        retainedTimestampMs: 4990,
      };

      const balancesBefore = computeDisplayBalances(basis, 4990, tcInc50, auth);
      assert.equal(balancesBefore.w, 840);
      assert.equal(balancesBefore.b, 800);

      const completion = applyCompletedTurn(basis, 4990, tcInc50, { auth });
      assert.equal(completion.flagged, false);
      assert.equal(completion.moveTimeMs, 160);
      assert.equal(completion.chargedMs, 160);
      assert.equal(completion.nextBasis.turnBaseBalances.w, 890);
      assert.equal(completion.nextBasis.turnBaseBalances.b, 800);
      assert.equal(completion.nextBasis.sideToMove, 'b');
      assert.equal(completion.nextBasis.elapsedThinkingMs, 0);
      assert.equal(completion.nextBasis.runningSince, null);
      assert.equal(completion.nextBasis.stoppedAt, 4990);
    });

    it('Vector 7: Opponent B800/D100/E0/T5080 clock remains unchanged at 800', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const balances = computeDisplayBalances(basis, 5080, tcDelay100);
      assert.equal(balances.b, 800);
    });

    it('Vector 8: Repeated pause D100/E120 freezes at 980; next release + 30 active evaluates to 950', () => {
      const running1 = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
      });
      const frozen = freezeClockBasis(running1, 5080, tcDelay100);
      assert.equal(frozen.runningSince, null);
      assert.equal(frozen.stoppedAt, 5080);
      assert.equal(frozen.elapsedThinkingMs, 120);

      const frozenBalances = computeDisplayBalances(frozen, 5080, tcDelay100);
      assert.equal(frozenBalances.w, 980);
      assert.equal(computeRemainingDelayMs(frozen, 5080, tcDelay100), 0);

      const running2 = releaseClockBasis(frozen, 6000, tcDelay100);
      assert.equal(running2.runningSince, 6000);
      assert.equal(running2.stoppedAt, null);
      assert.equal(running2.elapsedThinkingMs, 120);
      assert.equal(running2.turnBaseBalances.w, 1000);

      const balances2 = computeDisplayBalances(running2, 6030, tcDelay100);
      assert.equal(balances2.w, 950);
      assert.equal(computeRemainingDelayMs(running2, 6030, tcDelay100), 0);
    });
  });

  describe('Fix 1: NoShow Remainder Accounts for Running Elapsed Time at Turn Completion', () => {
    it('S5000, remainder 600, move completed at T5100 retains 500 remainder (limited)', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        noShowRemainderMs: 600,
      });

      const completion = applyCompletedTurn(running, 5100, tcDelay100);
      assert.equal(completion.nextBasis.noShowRemainderMs, 500);

      // Subsequent release at 10000 has deadline 10500
      const nextRunning = releaseClockBasis(completion.nextBasis, 10_000, tcDelay100);
      assert.equal(computeNoShowDeadline(nextRunning), 10_500);
    });

    it('S5000, remainder 600, move completed at T5100 retains 500 remainder (unlimited)', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 0, b: 0 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        noShowRemainderMs: 600,
      });

      const completion = applyCompletedTurn(running, 5100, tcUnlimited);
      assert.equal(completion.nextBasis.noShowRemainderMs, 500);

      const nextRunning = releaseClockBasis(completion.nextBasis, 10_000, tcUnlimited);
      assert.equal(computeNoShowDeadline(nextRunning), 10_500);
    });

    it('Stopped command does not debit noShow remainder', () => {
      const stopped = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: null,
        stoppedAt: 5000,
        noShowRemainderMs: 600,
      });

      const completion = applyCompletedTurn(stopped, 5200, tcDelay100);
      assert.equal(completion.nextBasis.noShowRemainderMs, 600);
    });

    it('clearNoShow option explicitly removes remainder', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        noShowRemainderMs: 600,
      });

      const completion = applyCompletedTurn(running, 5100, tcDelay100, { clearNoShow: true });
      assert.equal(completion.nextBasis.noShowRemainderMs, null);
    });

    it('Zero remainder stays due (0)', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        noShowRemainderMs: 0,
      });

      const completion = applyCompletedTurn(running, 5100, tcDelay100);
      assert.equal(completion.nextBasis.noShowRemainderMs, 0);
    });
  });

  describe('Fix 3: Consistent Boundary Validation Before Early Return', () => {
    it('Stopped query rejects invalid or NaN timestamp', () => {
      const stopped = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: null,
      });

      assert.throws(
        () => computeDisplayBalances(stopped, NaN, tcDelay100),
        (err: unknown) => err instanceof GameError,
      );
      assert.throws(
        () => computeActiveThinkingMs(stopped, -1, tcDelay100),
        (err: unknown) => err instanceof GameError,
      );
      assert.throws(
        () => computeRemainingDelayMs(stopped, Number.POSITIVE_INFINITY, tcDelay100),
        (err: unknown) => err instanceof GameError,
      );
    });

    it('Rejects negative delay or negative increment on TimeControl', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        sideToMove: 'w',
      });
      const negDelay: TimeControl = {
        initialMs: 1000,
        incrementMs: 0,
        delayMs: -100,
        kind: 'delay',
      };
      const negInc: TimeControl = {
        initialMs: 1000,
        incrementMs: -50,
        delayMs: 0,
        kind: 'increment',
      };

      assert.throws(() => computeDisplayBalances(basis, 1000, negDelay), (err: unknown) => err instanceof GameError);
      assert.throws(() => computeDisplayBalances(basis, 1000, negInc), (err: unknown) => err instanceof GameError);
      assert.throws(() => validateTimeControl(negDelay), (err: unknown) => err instanceof GameError);
      assert.throws(() => validateTimeControl(negInc), (err: unknown) => err instanceof GameError);
    });

    it('Rejects invalid time control kind', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        sideToMove: 'w',
      });
      const badTc = {
        initialMs: 1000,
        incrementMs: 0,
        delayMs: 0,
        kind: 'unsupported_mode',
      } as unknown as TimeControl;

      assert.throws(() => computeDisplayBalances(basis, 1000, badTc), (err: unknown) => err instanceof GameError);
    });
  });

  describe('Fix 4: Deep Ownership and Mutation Isolation', () => {
    it('Structural basis return is deep owned and isolated from caller mutation', () => {
      const rawBalances = { w: 1000, b: 1000 };
      const basis = createAdjudicationClockBasis({
        initialBalances: rawBalances,
        sideToMove: 'w',
        runningSince: 5000,
      });

      // Caller mutates initial raw object
      rawBalances.w = 2;
      assert.equal(basis.turnBaseBalances.w, 1000);

      // Unlimited display does not alias internal basis turnBaseBalances
      const unlimitedBalances = computeDisplayBalances(basis, 5000, tcUnlimited);
      assert.equal(unlimitedBalances.w, 1000);
      assert.ok(Object.isFrozen(unlimitedBalances));

      // Snapshot balance is frozen and cloned
      const snap = getClockAccountingSnapshot(basis, 5000, tcDelay100);
      assert.ok(Object.isFrozen(snap.displayBalances));
    });

    it('Rejects mutable object values in lineage fields', () => {
      const badParams = {
        initialBalances: { w: 1000, b: 1000 },
        stopId: { bad: 'object' } as unknown as string,
      };
      assert.throws(() => createAdjudicationClockBasis(badParams), (err: unknown) => err instanceof GameError);
    });
  });

  describe('Fix 5: Complete Turn Preserves Managed Policy', () => {
    it('Preserves policy across completed turn for opponent new stopped turn', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        policy: 'observed-release-v1',
      });

      const completion = applyCompletedTurn(running, 5100, tcDelay100);
      assert.equal(completion.nextBasis.policy, 'observed-release-v1');
      assert.equal(completion.nextBasis.stopId, null);
      assert.equal(completion.nextBasis.originatingCompletionId, null);
    });

    it('Allows caller to update lineage metadata via nextLineage', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
        policy: 'policy-old',
      });

      const completion = applyCompletedTurn(running, 5100, tcDelay100, {
        nextLineage: { policy: 'policy-new', stopId: 'stop-next' },
      });
      assert.equal(completion.nextBasis.policy, 'policy-new');
      assert.equal(completion.nextBasis.stopId, 'stop-next');
    });
  });

  describe('Fix 6: Flag Deadline Predicate Parity and Allowance Sum Overflow', () => {
    it('Zero balance with delay: deadline returns S (5000) matching flag predicate', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 0, b: 1000 },
        elapsedThinkingMs: 0,
        sideToMove: 'w',
        runningSince: 5000,
      });

      assert.equal(computeFlagDeadline(basis, tcDelay100), 5000);
      assert.equal(hasFlaggedAt(basis, 5000, tcDelay100), true);
    });

    it('Bounded grid parity: hasFlaggedAt(now) === (now >= flagDeadline) for all now >= S', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
      });

      // Allowance: D(100) + B(1000) = 1100. Pre-turn thinking: 40. Remaining: 1060. Deadline: 5000 + 1060 = 6060.
      const dl = computeFlagDeadline(basis, tcDelay100);
      assert.equal(dl, 6060);

      const probePoints = [5000, 5500, 6059, 6060, 6061, 7000];
      for (const t of probePoints) {
        assert.equal(hasFlaggedAt(basis, t, tcDelay100), t >= dl!);
      }
    });

    it('Derived allowance sum rejects unsafe overflow even if individual operands are safe', () => {
      const hugeDelayTc: TimeControl = {
        initialMs: 1000,
        incrementMs: 0,
        delayMs: MAX_SAFE_TIMESTAMP_MS - 50,
        kind: 'delay',
      };
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 100, b: 1000 },
        sideToMove: 'w',
        runningSince: 5000,
      });

      assert.throws(
        () => computeFlagDeadline(basis, hugeDelayTc),
        (err: unknown) => err instanceof GameError && err.message.includes('overflow'),
      );
    });
  });

  describe('Fix 7: Time Causality Across Transitions', () => {
    it('Release timestamp cannot precede last stop observation (freeze)', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        sideToMove: 'w',
        runningSince: 5000,
      });
      const frozen = freezeClockBasis(running, 6000, tcDelay100);
      assert.equal(frozen.stoppedAt, 6000);

      // Releasing at 5000 (< 6000) must throw
      assert.throws(
        () => releaseClockBasis(frozen, 5000, tcDelay100),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop'),
      );

      // Releasing at 6000 or later succeeds
      const released = releaseClockBasis(frozen, 6000, tcDelay100);
      assert.equal(released.runningSince, 6000);
      assert.equal(released.stoppedAt, null);
    });

    it('Release timestamp cannot precede last move completion', () => {
      const running = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        sideToMove: 'w',
        runningSince: 5000,
      });
      const completion = applyCompletedTurn(running, 5500, tcDelay100);
      assert.equal(completion.nextBasis.stoppedAt, 5500);

      // Release at 5400 (< 5500) must throw
      assert.throws(
        () => releaseClockBasis(completion.nextBasis, 5400, tcDelay100),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop'),
      );
    });
  });

  describe('Delay and Increment Kind Isolation', () => {
    it('Delay applies ONLY to delay time control kind', () => {
      const tcIncWithDelayField: TimeControl = {
        initialMs: 1000,
        incrementMs: 0,
        delayMs: 100,
        kind: 'increment',
      };
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const balances = computeDisplayBalances(basis, 5000, tcIncWithDelayField);
      assert.equal(balances.w, 960);
      assert.equal(computeRemainingDelayMs(basis, 5000, tcIncWithDelayField), 0);
    });

    it('Increment applies ONLY to increment time control kind', () => {
      const tcDelayWithIncField: TimeControl = {
        initialMs: 1000,
        incrementMs: 50,
        delayMs: 100,
        kind: 'delay',
      };
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 160,
        sideToMove: 'w',
        runningSince: 5000,
      });

      const completion = applyCompletedTurn(basis, 5000, tcDelayWithIncField);
      assert.equal(completion.nextBasis.turnBaseBalances.w, 940);
    });
  });

  describe('Strict Zero / Exhaustion / Flagged Zero Never Resurrected', () => {
    it('Exact exhaustion: post-charge balance 0 is flagged, clamped to 0, increment never added', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 100, b: 1000 },
        elapsedThinkingMs: 100,
        sideToMove: 'w',
        runningSince: null,
      });

      const completion = applyCompletedTurn(basis, 1000, tcInc50);
      assert.equal(completion.flagged, true);
      assert.equal(completion.chargedMs, 100);
      assert.equal(completion.nextBasis.turnBaseBalances.w, 0);
    });

    it('Deficit exhaustion: post-charge balance < 0 is flagged, clamped to 0, increment never added', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 100, b: 1000 },
        elapsedThinkingMs: 150,
        sideToMove: 'w',
        runningSince: null,
      });

      const completion = applyCompletedTurn(basis, 1000, tcInc50);
      assert.equal(completion.flagged, true);
      assert.equal(completion.chargedMs, 150);
      assert.equal(completion.nextBasis.turnBaseBalances.w, 0);
    });

    it('Already zero: mover starting with 0 balance is flagged, clamped to 0, increment never added', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 0, b: 1000 },
        elapsedThinkingMs: 10,
        sideToMove: 'w',
        runningSince: null,
      });

      const completion = applyCompletedTurn(basis, 1000, tcInc50);
      assert.equal(completion.flagged, true);
      assert.equal(completion.nextBasis.turnBaseBalances.w, 0);
    });
  });

  describe('Retained-T Authorization for T < S Races', () => {
    it('Ordinary backward timestamp T < S without authorization throws GameError', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-abc',
      });

      assert.throws(
        () => computeDisplayBalances(basis, 4990, tcDelay100),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
    });

    it('Backward timestamp T < S with mismatched stopId throws GameError', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-abc',
      });
      const wrongAuth: RetainedTimestampAuthorization = {
        stopId: 'stop-OTHER',
        retainedTimestampMs: 4990,
      };

      assert.throws(
        () => computeDisplayBalances(basis, 4990, tcDelay100, wrongAuth),
        (err: unknown) => err instanceof GameError && err.message.includes('lineage'),
      );
    });

    it('Backward timestamp T < S with mismatched retainedTimestampMs throws GameError', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-abc',
      });
      const wrongAuth: RetainedTimestampAuthorization = {
        stopId: 'stop-abc',
        retainedTimestampMs: 4980,
      };

      assert.throws(
        () => computeDisplayBalances(basis, 4990, tcDelay100, wrongAuth),
        (err: unknown) => err instanceof GameError && err.message.includes('timestamp'),
      );
    });

    it('Matching authorization permits T < S and adds 0 active elapsed time', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        stopId: 'stop-abc',
      });
      const validAuth: RetainedTimestampAuthorization = {
        stopId: 'stop-abc',
        retainedTimestampMs: 4990,
      };

      const thinking = computeActiveThinkingMs(basis, 4990, tcDelay100, validAuth);
      assert.equal(thinking, 40);
    });
  });

  describe('Snapshot Inspection', () => {
    it('getClockAccountingSnapshot surfaces all accounting properties cleanly', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 1000 },
        elapsedThinkingMs: 40,
        sideToMove: 'w',
        runningSince: 5000,
        noShowRemainderMs: 300,
      });

      const snap = getClockAccountingSnapshot(basis, 5080, tcDelay100);
      assert.equal(snap.isRunning, true);
      assert.equal(snap.activeThinkingMs, 120);
      assert.equal(snap.remainingDelayMs, 0);
      assert.equal(snap.displayBalances.w, 980);
      assert.equal(snap.displayBalances.b, 1000);
      assert.equal(snap.flagDeadline, 6060);
      assert.equal(snap.noShowDeadline, 5300);
      assert.equal(snap.flagged, false);
      assert.ok(Object.isFrozen(snap));
      assert.ok(Object.isFrozen(snap.displayBalances));
    });
  });

  describe('Candidate 3 Boundary Controls and Validation Robustness', () => {
    it('Constructor rejects non-omitted invalid options', () => {
      const invalidDeltas: Array<Record<string, unknown>> = [
        { elapsedThinkingMs: '100' },
        { ply: {} },
        { sideToMove: 42 },
        { elapsedThinkingMs: null },
      ];
      for (const delta of invalidDeltas) {
        assert.throws(
          () =>
            createAdjudicationClockBasis({
              initialBalances: { w: 1000, b: 800 },
              stopId: 's',
              policy: 'observed-release-v1',
              ...(delta as unknown as Partial<CreateAdjudicationClockBasisParams>),
            }),
          (err: unknown) => err instanceof GameError,
        );
      }
    });

    it('Transitions reject malformed mutable lineage policy', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
      });
      const badLineage = { policy: { mutable: true } } as unknown as StopLineage;

      assert.throws(
        () => releaseClockBasis(basis, 5000, tcDelay100, badLineage),
        (err: unknown) => err instanceof GameError,
      );

      assert.throws(
        () => freezeClockBasis(basis, 5000, tcDelay100, badLineage),
        (err: unknown) => err instanceof GameError,
      );

      assert.throws(
        () => applyCompletedTurn(basis, 5000, tcDelay100, { nextLineage: badLineage }),
        (err: unknown) => err instanceof GameError,
      );
    });

    it('Transitions reject malformed apply options (non-boolean clearNoShow)', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
      });
      const badOptions = { clearNoShow: 'yes' } as unknown as ApplyCompletedTurnOptions;

      assert.throws(
        () => applyCompletedTurn(basis, 5000, tcDelay100, badOptions),
        (err: unknown) => err instanceof GameError,
      );
    });

    it('Direct validateClockBasis requires structural fields and rejects omitted runningSince', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
      });
      const plain = JSON.parse(JSON.stringify(basis)) as Record<string, unknown>;
      delete plain.runningSince;

      assert.throws(
        () => validateClockBasis(plain as unknown as AdjudicationClockBasis),
        (err: unknown) => err instanceof GameError,
      );

      assert.throws(
        () => computeActiveThinkingMs(plain as unknown as AdjudicationClockBasis, 2000, tcDelay100),
        (err: unknown) => err instanceof GameError,
      );
    });

    it('Unlimited running clock rejects backward query without matching authorization', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
        noShowRemainderMs: 600,
      });
      const running = releaseClockBasis(basis, 5000, tcUnlimited);

      assert.throws(
        () => computeDisplayBalances(running, 4999, tcUnlimited),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
      assert.throws(
        () => computeActiveThinkingMs(running, 4999, tcUnlimited),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
    });

    it('Non-delay running clock computeRemainingDelayMs checks backward queries', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
      });
      const running = releaseClockBasis(basis, 5000, tcInc50);

      assert.throws(
        () => computeRemainingDelayMs(running, 4999, tcInc50),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
    });

    it('Returned lineage values are isolated, self-validating, and caller mutation proof', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        stopId: 's',
        policy: 'observed-release-v1',
      });
      const released = releaseClockBasis(basis, 5000, tcDelay100, {
        policy: 'new-policy',
        stopId: 'new-stop',
      });
      validateClockBasis(released);
      assert.equal(released.policy, 'new-policy');
      assert.equal(released.stopId, 'new-stop');
      assert.ok(Object.isFrozen(released));

      const frozen = freezeClockBasis(released, 5050, tcDelay100);
      validateClockBasis(frozen);
      assert.equal(frozen.policy, 'new-policy');
      assert.ok(Object.isFrozen(frozen));

      const completion = applyCompletedTurn(frozen, 5050, tcDelay100);
      validateClockBasis(completion.nextBasis);
      assert.equal(completion.nextBasis.policy, 'new-policy');
      assert.ok(Object.isFrozen(completion.nextBasis));
    });
  });

  describe('Anchorless Release Causal Floor and isNoShowDueAt Consistency', () => {
    it('Anchorless release preserves latest observed release timestamp as causal floor', () => {
      const initial = createAdjudicationClockBasis({
        initialBalances: { w: 0, b: 0 },
        policy: 'observed-release-v1',
      });
      const frozen = freezeClockBasis(initial, 6000, tcUnlimited);
      const released = releaseClockBasis(frozen, 7000, tcUnlimited);

      // Running chess anchor remains null, observation preserved as stoppedAt
      assert.equal(released.runningSince, null);
      assert.equal(released.stoppedAt, 7000);
      assert.equal(released.policy, 'observed-release-v1');

      // Operations preceding observed release are strictly rejected
      assert.throws(
        () => computeDisplayBalances(released, 1000, tcUnlimited),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop observation'),
      );
      assert.throws(
        () => freezeClockBasis(released, 1000, tcUnlimited),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop observation'),
      );
      assert.throws(
        () => applyCompletedTurn(released, 1000, tcUnlimited),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop observation'),
      );
      assert.throws(
        () => isNoShowDueAt(released, 1000),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop observation'),
      );

      // Operations at or after observed release are valid
      const balances = computeDisplayBalances(released, 7000, tcUnlimited);
      assert.equal(balances.w, 0);
      assert.equal(balances.b, 0);
      assert.equal(hasFlaggedAt(released, 7000, tcUnlimited), false);

      const refrozen = freezeClockBasis(released, 7500, tcUnlimited);
      assert.equal(refrozen.stoppedAt, 7500);
      assert.equal(refrozen.policy, 'observed-release-v1');

      const completed = applyCompletedTurn(released, 7500, tcUnlimited);
      assert.equal(completed.nextBasis.stoppedAt, 7500);
      assert.equal(completed.nextBasis.policy, 'observed-release-v1');
      assert.equal(completed.flagged, false);
      assert.equal(completed.moveTimeMs, 0);
    });

    it('isNoShowDueAt enforces ordinary temporal policy matching getClockAccountingSnapshot', () => {
      const basis = createAdjudicationClockBasis({
        initialBalances: { w: 1000, b: 800 },
        noShowRemainderMs: 600,
        stopId: 'stop-ns',
        policy: 'observed-policy',
      });
      const running = releaseClockBasis(basis, 5000, tcDelay100);

      // Backwards query T < S rejected on isNoShowDueAt and snapshot alike
      assert.throws(
        () => isNoShowDueAt(running, 4990),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
      assert.throws(
        () => getClockAccountingSnapshot(running, 4990, tcDelay100),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );

      // At release anchor 5000: not yet due (deadline is 5600)
      assert.equal(isNoShowDueAt(running, 5000), false);
      assert.equal(isNoShowDueAt(running, 5599), false);
      assert.equal(isNoShowDueAt(running, 5600), true);
      assert.equal(isNoShowDueAt(running, 5700), true);
    });

    it('isNoShowDueAt handles zero, absent remainder, and unlimited noShow without exemption', () => {
      // Zero remainder
      const zeroBasis = releaseClockBasis(
        createAdjudicationClockBasis({
          initialBalances: { w: 1000, b: 800 },
          noShowRemainderMs: 0,
        }),
        5000,
        tcDelay100,
      );
      assert.throws(
        () => isNoShowDueAt(zeroBasis, 4990),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
      assert.equal(isNoShowDueAt(zeroBasis, 5000), true);

      // Absent remainder
      const absentBasis = releaseClockBasis(
        createAdjudicationClockBasis({
          initialBalances: { w: 1000, b: 800 },
          noShowRemainderMs: null,
        }),
        5000,
        tcDelay100,
      );
      assert.throws(
        () => isNoShowDueAt(absentBasis, 4990),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
      assert.equal(isNoShowDueAt(absentBasis, 5000), false);

      // Unlimited with noShow remainder
      const unlimRunning = releaseClockBasis(
        createAdjudicationClockBasis({
          initialBalances: { w: 0, b: 0 },
          noShowRemainderMs: 600,
        }),
        5000,
        tcUnlimited,
      );
      assert.throws(
        () => isNoShowDueAt(unlimRunning, 4990),
        (err: unknown) => err instanceof GameError && err.message.includes('precedes release anchor'),
      );
      assert.equal(isNoShowDueAt(unlimRunning, 5000), false);
      assert.equal(isNoShowDueAt(unlimRunning, 5600), true);

      // Stopped basis rejects queries preceding stop observation
      const stoppedBasis = freezeClockBasis(absentBasis, 6000, tcDelay100);
      assert.throws(
        () => isNoShowDueAt(stoppedBasis, 1000),
        (err: unknown) => err instanceof GameError && err.message.includes('precede last stop observation'),
      );
      assert.equal(isNoShowDueAt(stoppedBasis, 6000), false);
    });
  });
});
