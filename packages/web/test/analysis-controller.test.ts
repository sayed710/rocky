/**
 * Lifecycle guarantees of {@link AnalysisController}, tested against the controller directly.
 *
 * The mount tests drive the same code through the DOM, but they cannot reach these properties: the
 * view disables the run button while a request is pending, so a test clicking that button can never
 * produce the second concurrent call the guard exists to refuse. Removing the guard leaves every
 * DOM-level test green — verified by mutation — which is exactly why these live here, one level
 * below the control that hides them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisController, classifyFailure } from '../src/app/analysis-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { AnalysisResponse } from '../src/api/models.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function sampleResult(fen = FEN): AnalysisResponse {
  return {
    fen,
    variant: 'standard',
    applied: { depth: 16, movetimeMs: 1000, multiPv: 1 },
    lines: [
      { multipv: 1, evaluation: { type: 'cp', value: 25 }, moves: ['e2e4'], depth: 14, nodes: 1000, timeMs: 900 },
    ],
  };
}

/** A client stub that records calls and lets the test decide when each one settles. */
function stubClient() {
  const calls: { fen: string; variant: string; multiPv?: number; signal?: AbortSignal }[] = [];
  let settle: ((result: AnalysisResponse) => void) | null = null;
  let fail: ((err: unknown) => void) | null = null;

  const client = {
    analysis: {
      analyse(body: { fen: string; variant: string; multiPv?: number }, signal?: AbortSignal) {
        calls.push({ ...body, ...(signal !== undefined ? { signal } : {}) });
        return new Promise<AnalysisResponse>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
      },
    },
  } as unknown as GambitClient;

  return {
    client,
    calls,
    resolve: (result: AnalysisResponse = sampleResult()) => settle?.(result),
    reject: (err: unknown) => fail?.(err),
  };
}

function recorder() {
  const events: string[] = [];
  let lastResult: AnalysisResponse | null = null;
  return {
    events,
    get lastResult() {
      return lastResult;
    },
    callbacks: {
      onPhase: (phase: string) => events.push(`phase:${phase}`),
      onResult: (result: AnalysisResponse) => {
        lastResult = result;
        events.push('result');
      },
      onFailure: (failure: string) => events.push(`failure:${failure}`),
      onInvalidated: () => events.push('invalidated'),
    },
  };
}

function build(position: { fen: string; variant: string } | null = { fen: FEN, variant: 'standard' }) {
  const stub = stubClient();
  const rec = recorder();
  const controller = new AnalysisController({
    client: stub.client,
    callbacks: rec.callbacks,
    getPosition: () => position,
  });
  return { stub, rec, controller };
}

/**
 * The deduplication guarantee. Without the `pending` check this issues two searches, each occupying
 * an engine worker the server cannot reclaim when the browser loses interest — the whole reason the
 * controller coalesces instead of superseding.
 */
test('a second request while one is pending does not reach the network', async () => {
  const { stub, controller } = build();

  void controller.analyse(3);
  void controller.analyse(3);
  void controller.analyse(5);
  await Promise.resolve();

  assert.equal(stub.calls.length, 1, 'a pending request must absorb further requests');
  assert.equal(controller.isPending, true);

  stub.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(controller.isPending, false, 'pending clears once the request settles');

  // And a request after it settles does go out, so coalescing is not a one-shot latch.
  void controller.analyse(3);
  await Promise.resolve();
  assert.equal(stub.calls.length, 2);
});

/** The request carries what the caller chose, and nothing that could widen the server's limits. */
test('the request carries the position and the chosen line count only', async () => {
  const { stub, controller } = build();
  void controller.analyse(5);
  await Promise.resolve();

  const call = stub.calls[0];
  assert.ok(call);
  assert.equal(call.fen, FEN);
  assert.equal(call.variant, 'standard');
  assert.equal(call.multiPv, 5);
  assert.ok(call.signal, 'an abort signal must be attached so a superseded request stops');
  assert.equal(Object.prototype.hasOwnProperty.call(call, 'depth'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call, 'movetimeMs'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call, 'nodes'), false);
});

/**
 * The stale-result guarantee. A response that resolves after the board moved on describes a position
 * the player is no longer looking at, and must never paint over the newer state.
 */
test('a response that arrives after a position change is discarded', async () => {
  const { stub, rec, controller } = build();

  void controller.analyse(3);
  await Promise.resolve();

  controller.positionChanged('8/8/8/8/8/8/8/K6k w - - 0 1');
  assert.ok(rec.events.includes('invalidated'));

  stub.resolve();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rec.lastResult, null, 'a superseded response must not be rendered');
  assert.equal(rec.events.filter((e) => e === 'result').length, 0);
});

/** Disposal is the other half of the same guarantee, for the SPA-navigation case. */
test('a response that arrives after disposal is discarded and reports nothing', async () => {
  const { stub, rec, controller } = build();

  void controller.analyse(3);
  await Promise.resolve();
  const eventsAtDispose = rec.events.length;

  controller.dispose();
  stub.resolve();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rec.lastResult, null);
  assert.equal(rec.events.length, eventsAtDispose, 'no callback may fire after dispose');
});

/** A rejection arriving after disposal must not surface an error into a torn-down view either. */
test('a rejection after disposal reports nothing', async () => {
  const { stub, rec, controller } = build();
  void controller.analyse(3);
  await Promise.resolve();

  controller.dispose();
  stub.reject({ status: 503 });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rec.events.filter((e) => e.startsWith('failure:')).length, 0);
});

/**
 * Re-reporting the same position is the common case — a snapshot lands on every server frame — and
 * must not wipe a result the player is still reading.
 */
test('a position callback repeating the analysed FEN does not invalidate the result', async () => {
  const { stub, rec, controller } = build();

  void controller.analyse(3);
  await Promise.resolve();
  stub.resolve();
  await new Promise((r) => setTimeout(r, 0));

  controller.positionChanged(FEN);
  assert.equal(rec.events.includes('invalidated'), false);
});

/** Before any analysis has run there is nothing to invalidate, so a move must stay silent. */
test('a position change before the first analysis reports nothing', () => {
  const { rec, controller } = build();
  controller.positionChanged('8/8/8/8/8/8/8/K6k w - - 0 1');
  assert.deepEqual(rec.events, []);
});

/** With no position on the board yet, the control must not put a request on the wire. */
test('analysing with no position does not reach the network', async () => {
  const { stub, controller } = build(null);
  await controller.analyse(3);
  assert.equal(stub.calls.length, 0);
});

test('failures classify by status, not by message', () => {
  assert.equal(classifyFailure({ status: 429 }), 'rate-limited');
  assert.equal(classifyFailure({ status: 503 }), 'unavailable');
  assert.equal(classifyFailure({ status: 401 }), 'unauthenticated');
  assert.equal(classifyFailure({ status: 409, details: { reason: 'active_human_game' } }), 'active-game');
  assert.equal(classifyFailure({ status: 409, details: { reason: 'version_conflict' } }), 'failed');
  assert.equal(classifyFailure({ status: 422 }), 'rejected');
  assert.equal(classifyFailure({ status: 400 }), 'rejected');
  assert.equal(classifyFailure({ status: 500 }), 'failed');
  assert.equal(classifyFailure(new Error('boom')), 'failed');
  assert.equal(classifyFailure(null), 'failed');
});

/**
 * An unsupported variant is permanent, and has to be told apart from a rejected position.
 *
 * ADR-0113 registers only engines whose binary is configured, and the API image installs Stockfish
 * alone — so the deployment-wide `analysis` capability is `true` while Atomic and Crazyhouse answer
 * `422 unsupported variant` forever. Both arrive as 422, so classifying on status alone would leave
 * the control failing identically on every click. Raised in the Qodo review of PR #133.
 *
 * The discriminator is `details`, not the message, because the message is prose the server may reword.
 */
test('a 422 naming the variant is permanent, and a 422 naming the position is not', () => {
  assert.equal(
    classifyFailure({ status: 422, details: { variant: 'unsupported variant' } }),
    'unsupported-variant',
  );
  assert.equal(classifyFailure({ status: 422, details: { fen: 'invalid FEN' } }), 'rejected');
  // No details at all is the conservative case: retryable rather than permanently disabling a control.
  assert.equal(classifyFailure({ status: 422 }), 'rejected');
  assert.equal(classifyFailure({ status: 422, details: {} }), 'rejected');
});
