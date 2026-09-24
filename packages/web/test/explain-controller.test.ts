/**
 * `ExplainController` currency rules, driven directly.
 *
 * The mount tests exercise this through the real client, whose transport honours `AbortSignal` and
 * therefore rejects an aborted request before the success path is reached. That hides the case this
 * file exists for: a response that has already been *received* and is only waiting on its microtask
 * resolves regardless of a later `abort()`. The client stub here ignores the signal on purpose, so
 * the guard being tested is the generation, not the transport.
 *
 * Found in the independent review of PR #135, which noted that `targetChanged` aborted without
 * bumping the generation while the sibling `AnalysisController` bumps for exactly this reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplainController } from '../src/app/explain-controller.js';
import { classifyRequestFailure } from '../src/app/move-request-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { MoveExplanationResponse } from '../src/api/models.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('move requests distinguish the fair-play conflict from other conflicts', () => {
  assert.equal(classifyRequestFailure({ status: 409, details: { reason: 'active_human_game' } }), 'active-game');
  assert.equal(classifyRequestFailure({ status: 409, details: { reason: 'different_conflict' } }), 'failed');
});

function response(move: string): MoveExplanationResponse {
  return {
    fen: FEN,
    variant: 'standard',
    move,
    explanation: `prose for ${move}`,
    citation: {
      moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -20, evalLabel: '-0.20' },
      evalKind: 'cp',
      evalValue: 35,
      evalLabel: '+0.35',
      bestMove: 'd2d4',
      bestLine: ['d2d4'],
      depth: 16,
    },
    providerId: 'p',
    model: 'm',
  };
}

/** A client whose in-flight request resolves when released, and which ignores the abort signal. */
function deferredClient(): {
  readonly client: GambitClient;
  release: (move: string) => void;
} {
  let settle: ((r: MoveExplanationResponse) => void) | null = null;
  const client = {
    explainMove: () =>
      new Promise<MoveExplanationResponse>((resolve) => {
        settle = resolve;
      }),
  } as unknown as GambitClient;
  return {
    client,
    release: (move: string) => settle?.(response(move)),
  };
}

test('a response released after the target changed is never reported', async () => {
  const { client, release } = deferredClient();
  let target = { fen: FEN, variant: 'standard', move: 'e2e4' };
  const results: MoveExplanationResponse[] = [];
  let invalidated = 0;

  const controller = new ExplainController({
    client,
    getTarget: () => target,
    callbacks: {
      onPhase: () => {},
      onResult: (r) => results.push(r),
      onFailure: () => {},
      onInvalidated: () => {
        invalidated += 1;
      },
    },
  });

  const pending = controller.explain();
  await Promise.resolve();

  // The board moves on before the answer comes back.
  target = { fen: FEN, variant: 'standard', move: 'd2d4' };
  controller.targetChanged();
  assert.equal(invalidated, 1, 'precondition: the panel was cleared');

  release('e2e4');
  await pending;

  assert.deepEqual(results, [], 'the superseded explanation is discarded, not rendered');
});

test('a response released after disposal is never reported', async () => {
  const { client, release } = deferredClient();
  const results: MoveExplanationResponse[] = [];

  const controller = new ExplainController({
    client,
    getTarget: () => ({ fen: FEN, variant: 'standard', move: 'e2e4' }),
    callbacks: {
      onPhase: () => {},
      onResult: (r) => results.push(r),
      onFailure: () => {},
      onInvalidated: () => {},
    },
  });

  const pending = controller.explain();
  await Promise.resolve();

  controller.dispose();
  release('e2e4');
  await pending;

  assert.deepEqual(results, []);
});

/** The ordinary path still reports, or the guards above would be indistinguishable from silence. */
test('a response released while its target is still current is reported', async () => {
  const { client, release } = deferredClient();
  const results: MoveExplanationResponse[] = [];

  const controller = new ExplainController({
    client,
    getTarget: () => ({ fen: FEN, variant: 'standard', move: 'e2e4' }),
    callbacks: {
      onPhase: () => {},
      onResult: (r) => results.push(r),
      onFailure: () => {},
      onInvalidated: () => {},
    },
  });

  const pending = controller.explain();
  await Promise.resolve();
  release('e2e4');
  await pending;

  assert.equal(results.length, 1);
  assert.equal(results[0]!.move, 'e2e4');
});
