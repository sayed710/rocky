import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient, type Scheduler } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController } from '../src/app/game-controller.js';
import { createI18nManager } from '../src/i18n/index.js';
import { decodeServer, type LegalMoves, type StateView, type WsColor } from '../src/net/ws-protocol.js';
import { FakeSocket, FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import type { WebSocketFactory } from '../src/ports/ws.js';
import { GameAuthority, InMemoryPubSub } from '@chess-platform/realtime-gateway';

const PLY_FENS: Record<number, string> = {
  0: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  1: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  2: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
  3: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  4: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  5: 'r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq d3 0 3',
};

function setup() {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1', scheduler });
  return { factory, scheduler, client, sync };
}

function stateView(
  ply: number,
  turn: WsColor,
  stateRevision: number | null = null,
  moves: StateView['moves'] = [],
  legalMoves: LegalMoves = {},
  fen?: string,
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: fen ?? PLY_FENS[ply] ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves,
    chess960StartId: null,
    ready: null,
    ...(stateRevision !== null ? { stateRevision } : {}),
  };
}

test('known-gap recovery: duplicate gap bursts coalesce into one logical pending attempt across flight and backoff', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  assert.equal(sync.getState().connected, true);
  assert.equal(sync.stateRevision, 0);
  assert.equal(sync.getState().recovering, false);

  const sentBefore = factory.last.sent.length;

  // Burst 1: gap move at revision 2, ply 2 arrives (missed move 1 at ply 1)
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: { g1: ['f3'] },
  });

  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.stateRevision, 0, 'floor must not advance on unapplied gap frame');
  assert.equal(sync.getState().ply, 0);
  assert.equal(factory.last.sent.length, sentBefore + 1, 'exactly one resume sent for first gap');
  assert.deepEqual(JSON.parse(factory.last.sent.at(-1)!), { t: 'resume', gameId: 'g1', lastPly: 0 });

  // Burst 2: duplicate gap move frame arrives while attempt 0 is pending
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: { g1: ['f3'] },
  });

  assert.equal(factory.last.sent.length, sentBefore + 1, 'duplicate gap must not dispatch additional resume');

  // Burst 3: higher gap move frame arrives at revision 4, ply 3 while attempt 0 is pending
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 4,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    fenHash: 'h3',
    clock: { w: 58_000, b: 59_000 },
    serverTs: 2_000,
    legalMoves: {},
  });

  assert.equal(factory.last.sent.length, sentBefore + 1, 'burst coalesced: no extra resume sent');
  assert.equal(sync.stateRevision, 0, 'floor remains at 0');

  // Attempt 0 timeout (2000 ms) fires: ends logical attempt and arms backoff delay
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2_000);
  scheduler.runNext();

  // Backoff delay (1000 ms) is now pending
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1_000);

  // Burst 4: higher gap frame arrives during scheduled backoff
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 5,
    ply: 4,
    uci: 'b8c6',
    san: 'Nc6',
    by: 'b',
    fenHash: 'h4',
    clock: { w: 58_000, b: 58_000 },
    serverTs: 3_000,
    legalMoves: {},
  });

  assert.equal(factory.last.sent.length, sentBefore + 1, 'gap during backoff does not send premature resume');
  assert.equal(scheduler.pending, 1, 'backoff delay handle preserved');

  // Run backoff delay to trigger attempt 1
  scheduler.runNext();
  assert.equal(factory.last.sent.length, sentBefore + 2, 'second resume sent after backoff delay');

  // Server delivers full snapshot covering revision 5, ply 4
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(4, 'w', 5, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
      { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
      { ply: 4, uci: 'b8c6', san: 'Nc6', by: 'b' },
    ]),
    missed: [],
  });

  assert.equal(sync.stateRevision, 5, 'floor advanced to 5');
  assert.equal(sync.getState().ply, 4);
  assert.equal(sync.getState().recovering, false, 'recovering false on discharge');
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(scheduler.pending, 0, 'quiescent: all timers cleared');
});

test('known-gap recovery: insufficient snapshots and command rejects preserve flight and debt until timeout settlement', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Gap 1: target revision 4, ply 4
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 4,
    ply: 4,
    uci: 'b8c6',
    san: 'Nc6',
    by: 'b',
    fenHash: 'h4',
    clock: { w: 58_000, b: 58_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
  assert.equal(sync.getState().recovering, true);

  // Intermediate insufficient snapshot arrives (covers up to revision 2, ply 2)
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(2, 'w', 2, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    ]),
    missed: [],
  });

  // Partial progress applied without spending dispatch attempts or cancelling in-flight attempt
  assert.equal(sync.getState().ply, 2, 'ply updated to 2 from partial snapshot');
  assert.equal(sync.stateRevision, 2, 'floor updated to 2');
  assert.equal(sync.getState().recovering, true, 'recovering remains true');
  assert.equal(scheduler.pending, 1, 'timeout timer still ticking');
  assert.equal(scheduler.nextDelayMs, 2_000);

  // Unrelated command rejection arrives during recovery flight
  factory.last.emit({
    t: 'reject',
    gameId: 'g1',
    code: 'illegal_move',
    ref: 12,
    message: 'prior move illegal',
  });

  assert.equal(sync.getState().recovering, true, 'rejection does not terminate recovery');
  assert.equal(scheduler.pending, 1, 'timeout timer still active');

  // Attempt 0 timeout (2000 ms) fires
  scheduler.runNext();

  // Scheduler backoff delay fires for next attempt
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1_000);
  scheduler.runNext();

  // Second resume was sent querying from updated ply 2
  const resumes = factory.last.sent.map((f) => JSON.parse(f) as { t: string; lastPly?: number }).filter((m) => m.t === 'resume');
  assert.equal(resumes.length, 2);
  assert.equal(resumes[1]!.lastPly, 2, 'second resume queries from updated ply 2');

  // Server answers second resume with complete state at revision 4, ply 4
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(4, 'w', 4, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
      { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
      { ply: 4, uci: 'b8c6', san: 'Nc6', by: 'b' },
    ]),
    missed: [],
  });

  assert.equal(sync.getState().ply, 4);
  assert.equal(sync.stateRevision, 4);
  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(scheduler.pending, 0);
});

test('known-gap recovery: failure and timeout budget exhausts after exactly 3 attempts and reaches quiescence with explicit recoveryAvailable', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Trigger gap recovery (attempt 0)
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.getState().recoveryAvailable, false);

  // Attempt 0 timeout (2000 ms) fires
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2_000);
  scheduler.runNext();

  // Backoff delay for attempt 1 (1000 ms) fires
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1_000);
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 2);

  // Attempt 1 timeout (2000 ms) fires
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2_000);
  scheduler.runNext();

  // Backoff delay for attempt 2 (2000 ms) fires
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2_000);
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);

  // Attempt 2 timeout (2000 ms) fires
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2_000);
  scheduler.runNext();

  // Budget exhausted (3 attempts). Quiescence reached:
  assert.equal(scheduler.pending, 0, 'quiescent: zero pending scheduler timers');
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3, 'no further resume attempts sent');
  assert.equal(sync.getState().recovering, true, 'recovery debt retained through exhaustion');
  assert.equal(sync.getState().recoveryAvailable, true, 'recoveryAvailable exposed on exhaustion');
  assert.equal(sync.submitMove('e2e4'), null, 'gameplay submission remains gated on exhaustion');
  assert.equal(sync.resign(), false, 'action submission remains gated on exhaustion');

  // User triggers manual retry via retryRecovery()
  sync.retryRecovery();
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().recovering, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 4, 'manual retry initiates attempt');
});

test('known-gap recovery: stop, sessionChanged, and socket drop cancel active timers and fence obsolete callbacks', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Trigger gap recovery
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });
  assert.equal(scheduler.pending, 1);

  // Socket drop cancels recovery timers; WsClient schedules its own reconnect timer
  factory.last.serverClose(1006, '', false);
  assert.equal(scheduler.pending, 1, 'WsClient queues reconnect timer on shared scheduler');
  assert.equal(sync.getState().recovering, true, 'debt retained across socket drop');
  assert.equal(sync.stateRevision, 0, 'floor retained across socket drop');

  // Socket reconnects
  scheduler.runNext(); // reconnect backoff
  factory.last.open();

  // Fresh authorized join delivers complete state and satisfies retained target
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(2, 'w', 2, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    ]),
  });
  assert.equal(sync.getState().recovering, false, 'retained target satisfied by fresh authorized join');
  assert.equal(sync.getState().ply, 2);
  assert.equal(sync.stateRevision, 2);

  // Second gap recovery episode to test stop()
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 4,
    ply: 4,
    uci: 'b8c6',
    san: 'Nc6',
    by: 'b',
    fenHash: 'h4',
    clock: { w: 58_000, b: 58_000 },
    serverTs: 2_000,
    legalMoves: {},
  });
  assert.equal(scheduler.pending, 1);

  // stop() cancels recovery timers and unbinds from WsClient without closing shared client
  sync.stop();
  assert.equal(scheduler.pending, 0, 'stop clears recovery timer');
  assert.notEqual(client.state, 'closed', 'stop must not close shared WsClient');

  assert.equal(sync.getState().connected, false);

  // logoutRequested preserves floor monotonicity and resets authorization
  sync.logoutRequested();
  assert.equal(sync.stateRevision, 2, 'floor monotonic across logout');
  sync.sessionChanged('u-new');
  assert.equal(sync.stateRevision, 2, 'floor monotonic across session change');
});

test('known-gap recovery: synchronous listener reentrancy fences stop before continuation sends', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  let stopCount = 0;
  // Synchronous listener stops recovery upon observing recovery state
  sync.subscribe((state) => {
    if (state.recovering && state.connected) {
      stopCount++;
      sync.stop();
    }
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  const sentBefore = factory.last.sent.length;

  // Emit gap move
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(stopCount, 1, 'reentrant stop triggered exactly once on recovering transition');

  // Reentrancy check in dispatchGapRecovery prevented wire dispatch after stop()
  const resumes = factory.last.sent.slice(sentBefore).filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(resumes.length, 0, 'no resume sent when listener reentrantly calls stop');
  assert.equal(scheduler.pending, 0, 'no recovery timer scheduled after reentrant stop');
  assert.equal(sync.getState().connected, false, 'reentrant stop disconnected sync');

  // Teardown idempotency: calling stop() again while stopped is safe no-op
  sync.stop();
  assert.equal(sync.getState().connected, false);
});

test('known-gap recovery: synchronous stop before wire dispatch preserves full attempt budget upon restart', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  let shouldAbort = true;
  sync.subscribe((state) => {
    if (shouldAbort && state.recovering && state.connected) {
      shouldAbort = false;
      sync.stop();
    }
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Emit gap move: synchronous listener stops recovery before wire dispatch
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(sync.getState().connected, false);
  assert.equal(scheduler.pending, 0);

  // Restart sync on the same socket
  sync.start();
  sync.retryRecovery();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Re-join triggers recovery for the retained debt.
  // Because the aborted attempt was stopped before wire dispatch, all 3 attempts remain.
  // Attempt 1:
  const resumes1 = factory.last.sent.filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(resumes1.length, 1, 'attempt 1 sent on wire');
  assert.equal(sync.getState().recoveryAvailable, false);
  scheduler.runNext(); // timeout attempt 1 -> schedules backoff (delay 1000)

  // Backoff 1:
  scheduler.runNext(); // backoff fires -> triggers attempt 2
  const resumes2 = factory.last.sent.filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(resumes2.length, 2, 'attempt 2 sent on wire');
  assert.equal(sync.getState().recoveryAvailable, false);
  scheduler.runNext(); // timeout attempt 2 -> schedules backoff (delay 2000)

  // Backoff 2:
  scheduler.runNext(); // backoff fires -> triggers attempt 3
  const resumes3 = factory.last.sent.filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(resumes3.length, 3, 'attempt 3 sent on wire');
  assert.equal(sync.getState().recoveryAvailable, false);
  scheduler.runNext(); // timeout attempt 3 -> exhausts attempt budget!

  // Full budget of 3 attempts was available and consumed; now quiescent with recoveryAvailable: true
  assert.equal(sync.getState().recoveryAvailable, true, 'recoveryAvailable exposed after exactly 3 wire dispatches');
  assert.equal(sync.getState().recovering, true, 'debt retained');
  assert.equal(scheduler.pending, 0, 'quiescent after budget exhaustion');
});

test('known-gap recovery: cancelled timer callback invoked after manual retry does not mutate successor timer or state', (t) => {
  const factory = new FakeSocketFactory();
  const manualScheduler = new ManualScheduler();
  const capturedCallbacks: Array<() => void> = [];
  const capturingScheduler: Scheduler = {
    setTimeout(fn: () => void, ms: number): unknown {
      capturedCallbacks.push(fn);
      return manualScheduler.setTimeout(fn, ms);
    },
    clearTimeout(handle: unknown): void {
      manualScheduler.clearTimeout(handle);
    },
  };

  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler: capturingScheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1', scheduler: capturingScheduler });
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Gap move triggers attempt 1 and schedules recovery timeout
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(manualScheduler.pending, 1, 'attempt 1 timer scheduled');
  assert.equal(capturedCallbacks.length, 1, 'attempt 1 timeout callback captured');
  const obsoleteCallback = capturedCallbacks[0];
  assert.ok(obsoleteCallback !== undefined, 'attempt 1 timeout callback must be captured');
  assert.equal(typeof obsoleteCallback, 'function');

  // User triggers manual retry via retryRecovery() while connected with active debt
  sync.retryRecovery();

  // retryRecovery() invalidates previous recoveryEpoch, resets attempt budget, and schedules successor timeout
  assert.equal(manualScheduler.pending, 1, 'successor timeout scheduled in manualScheduler');
  assert.equal(capturedCallbacks.length, 2, 'successor timeout callback captured');

  // Stale callback from attempt 1 arrives after manual replacement; invoke it directly
  obsoleteCallback();

  // Fencing ensures the obsolete callback returns before mutating any state or clearing successor handle
  assert.equal(manualScheduler.pending, 1, 'successor timer remains intact in manualScheduler');
  assert.equal(sync.getState().recovering, true, 'recovering remains true');
  assert.equal(sync.getState().recoveryAvailable, false, 'recoveryAvailable remains false');

  // Successor timer runs cleanly and schedules backoff
  manualScheduler.runNext();
  assert.equal(manualScheduler.pending, 1, 'successor backoff delay scheduled normally');
});

test('known-gap recovery: reentrant listener replacement does not clear successor gapRecoveryPending', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  let replaced = false;
  sync.subscribe((state) => {
    if (!replaced && state.recovering && state.connected) {
      replaced = true;
      // Reentrant listener replaces recovery episode with fresh manual recovery
      sync.retryRecovery();
    }
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Emit gap move
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  // After the outer dispatch returns, the successor's recovery state must still be active
  assert.equal(sync.getState().recovering, true, 'recovering remains true');
  assert.equal(scheduler.pending, 1, 'successor timeout timer scheduled');

  // Triggering another gap frame while successor is in-flight must coalesce into the active attempt
  // rather than dispatching a duplicate resume (proving gapRecoveryPending remained true on successor)
  const sentBefore = factory.last.sent.length;
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 4,
    ply: 4,
    uci: 'g8f6',
    san: 'Nf6',
    by: 'b',
    fenHash: 'h4',
    clock: { w: 58_000, b: 58_000 },
    serverTs: 2_000,
    legalMoves: {},
  });

  const resumes = factory.last.sent.slice(sentBefore).filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(resumes.length, 0, 'burst gap coalesced without duplicate resume because successor was pending');
  assert.equal(scheduler.pending, 1, 'no extra timer scheduled');
});

test('known-gap recovery: transport send boundary error causing lifecycle stop does not arm stale timer', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  const socket = factory.last;
  let cancelDuringSend = true;
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string): void => {
    originalSend(data);
    const parsed = JSON.parse(data) as { t?: string };
    if (cancelDuringSend && parsed.t === 'resume') {
      cancelDuringSend = false;
      // Transport boundary synchronously triggers stop / lifecycle cancellation during send
      sync.stop();
    }
  };

  socket.open();
  socket.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Emit gap move to trigger gap recovery dispatch
  socket.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  // Because sync.stop() was called synchronously during client.send,
  // post-send recheck prevents arming a stale recovery timeout!
  assert.equal(scheduler.pending, 0, 'no stale recovery timer armed after send boundary cancellation');
  assert.equal(sync.getState().connected, false, 'sync is stopped');
});

test('known-gap recovery: transport send boundary triggering replacement does not clear successor timer', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  const socket = factory.last;
  let replaceDuringSend = true;
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string): void => {
    originalSend(data);
    const parsed = JSON.parse(data) as { t?: string };
    if (replaceDuringSend && parsed.t === 'resume') {
      replaceDuringSend = false;
      // Transport boundary synchronously triggers replacement via manual recovery
      sync.retryRecovery();
    }
  };

  socket.open();
  socket.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  // Emit gap move to trigger gap recovery dispatch
  socket.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  // The replacement dispatch scheduled a successor timeout.
  // The superseded initial send must NOT clear the successor timer or arm a second stale timer.
  assert.equal(scheduler.pending, 1, 'successor timer remains intact in scheduler');
  assert.equal(sync.getState().recovering, true);
});

test('known-gap recovery: malformed legacy snapshot with missing or nonnumeric ply does not falsely discharge known ply target', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  // Join all-legacy gateway (no stateRevision)
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', null),
  });

  // Gap move at ply 3
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    fenHash: 'h3',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(sync.getState().recovering, true);

  // Malformed legacy snapshot with NaN ply
  const nanSnapshot = Object.assign({}, stateView(0, 'w', null), { ply: NaN });
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: nanSnapshot,
    missed: [],
  });
  assert.equal(sync.getState().recovering, true, 'NaN ply must not discharge target');

  // Malformed legacy snapshot with string ply
  const stringSnapshot = Object.assign({}, stateView(0, 'w', null), { ply: '3' as unknown as number });
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stringSnapshot,
    missed: [],
  });
  assert.equal(sync.getState().recovering, true, 'string ply must not discharge target');

  // Valid legacy snapshot with integer ply 3
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', null, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
      { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
    ]),
    missed: [],
  });

  assert.equal(sync.getState().recovering, false, 'valid integer ply discharges legacy target');
  assert.equal(sync.getState().ply, 3);
  assert.equal(scheduler.pending, 0);
});

for (const invalidId of [-1, 960]) {
  test(`known-gap recovery: legacy resumed snapshot with out-of-range chess960StartId (${invalidId}) rejects discharge`, (t) => {
    const { factory, client, sync } = setup();
    t.after(() => {
      sync.stop();
      client.close();
    });

    sync.start();
    factory.last.open();
    factory.last.emit({
      t: 'joined',
      gameId: 'g1',
      role: 'white',
      state: stateView(0, 'w', null),
    });

    assert.equal(sync.getState().connected, true);
    assert.equal(sync.stateRevision, null);
    assert.equal(sync.getState().ply, 0);

    factory.last.emit({
      t: 'move',
      gameId: 'g1',
      ply: 2,
      uci: 'e7e5',
      san: 'e5',
      by: 'b',
      fenHash: 'h2',
      clock: { w: 60_000, b: 59_000 },
      serverTs: 1_000,
      legalMoves: { g1: ['f3'] },
    });

    assert.equal(sync.getState().recovering, true);
    assert.equal(sync.getState().ply, 0);

    const moves2: StateView['moves'] = [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    ];

    const invalidMsg = {
      t: 'resumed' as const,
      gameId: 'g1',
      state: { ...stateView(2, 'w', null, moves2), chess960StartId: invalidId },
      missed: [],
    };
    assert.ok(decodeServer(JSON.stringify(invalidMsg)) !== null, 'decoder accepts legacy frame');

    factory.last.emit(invalidMsg);

    assert.equal(sync.getState().recovering, true);
    assert.equal(sync.getState().ply, 0);
    assert.equal(sync.stateRevision, null);
  });
}

for (const validId of [0, 959, null, undefined]) {
  test(`known-gap recovery: legacy resumed snapshot with valid chess960StartId (${String(validId)}) discharges gap`, (t) => {
    const { factory, client, sync } = setup();
    t.after(() => {
      sync.stop();
      client.close();
    });

    sync.start();
    factory.last.open();
    factory.last.emit({
      t: 'joined',
      gameId: 'g1',
      role: 'white',
      state: stateView(0, 'w', null),
    });

    factory.last.emit({
      t: 'move',
      gameId: 'g1',
      ply: 2,
      uci: 'e7e5',
      san: 'e5',
      by: 'b',
      fenHash: 'h2',
      clock: { w: 60_000, b: 59_000 },
      serverTs: 1_000,
      legalMoves: { g1: ['f3'] },
    });
    assert.equal(sync.getState().recovering, true);

    const moves2: StateView['moves'] = [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    ];
    const validSnap = { ...stateView(2, 'w', null, moves2), chess960StartId: validId };

    factory.last.emit({
      t: 'resumed',
      gameId: 'g1',
      state: validSnap,
      missed: [],
    });

    assert.equal(sync.getState().recovering, false);
    assert.equal(sync.getState().ply, 2);
    assert.equal(sync.getState().snapshot?.chess960StartId, validId);
    assert.equal(sync.stateRevision, null);
  });
}

test('known-gap recovery: GameController gates board turn, actions, and presentations through exhaustion until complete restoration', (t) => {
  const { factory, scheduler, client, sync } = setup();
  const turns: boolean[] = [];
  const actionStates: Array<{ canAbort: boolean; isOver: boolean; drawOffer: string; recovering: boolean }> = [];
  const controller = new GameController({
    gameSync: sync,
    i18n: createI18nManager({ initialLocale: 'en' }),
    callbacks: {
      onPosition: () => {},
      onTurn: (myTurn) => turns.push(myTurn),
      onClock: () => {},
      onStatus: () => {},
      onActionState: (as) => actionStates.push({ canAbort: as.canAbort, isOver: as.isOver, drawOffer: as.drawOffer, recovering: as.recovering ?? false }),
    },
  });
  t.after(() => {
    controller.dispose();
    sync.stop();
    client.close();
  });

  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0),
  });

  assert.equal(turns.at(-1), true, 'white turn initially');
  assert.equal(actionStates.at(-1)?.canAbort, true);
  assert.equal(actionStates.at(-1)?.recovering, false);

  // Gap move arrives at revision 2, ply 2
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 60_000, b: 59_000 },
    serverTs: 1_000,
    legalMoves: {},
  });

  assert.equal(turns.at(-1), false, 'turn gated during recovery');
  assert.equal(actionStates.at(-1)?.canAbort, false, 'abort gated during recovery');
  assert.equal(actionStates.at(-1)?.recovering, true);
  assert.equal(controller.submitMove('e2e4'), null, 'submitMove rejected');
  assert.equal(controller.resign(), false, 'resign rejected');
  assert.equal(controller.offerDraw(), false, 'offerDraw rejected');
  assert.equal(controller.abort(), false, 'abort rejected');

  // Run through exhaustion
  scheduler.runNext(); // timeout 1
  scheduler.runNext(); // backoff 1
  scheduler.runNext(); // timeout 2
  scheduler.runNext(); // backoff 2
  scheduler.runNext(); // timeout 3

  assert.equal(sync.getState().recoveryAvailable, true);
  assert.equal(sync.getState().recovering, true);
  assert.equal(turns.at(-1), false, 'turn stays gated through exhaustion');
  assert.equal(controller.submitMove('e2e4'), null, 'submission stays gated at exhaustion');
  assert.equal(controller.resign(), false, 'resign stays gated at exhaustion');

  // Complete snapshot arrives
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(2, 'w', 2, [
      { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
      { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    ]),
    missed: [],
  });

  assert.equal(sync.getState().recovering, false);
  assert.equal(turns.at(-1), true, 'turn re-enabled after recovery');
  assert.equal(controller.fen, PLY_FENS[2], 'exact FEN projected');
  assert.deepEqual(controller.moveSequence, ['e2e4', 'e7e5'], 'exact move sequence restored');
});

test('known-gap recovery: ready broadcast with revision gap triggers recovery without advancing floor prematurely and merges cumulative readiness', (t) => {
  const { factory, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w', 0), ready: { w: false, b: false } },
  });

  // Ready broadcast arrives with revision gap (revision 2 > floor 0 + 1, e.g. intervening draw offer at seq 1)
  factory.last.emit({
    t: 'ready',
    gameId: 'g1',
    stateRevision: 2,
    ready: { w: true, b: false },
    serverTs: 1_000,
  });

  assert.equal(sync.stateRevision, 0, 'floor must not advance on ready broadcast with gap');
  assert.equal(sync.getState().ready?.w, true, 'readiness is merged monotonically');
  assert.equal(sync.getState().recovering, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
});

test('synthetic: causality schedule with seek-game readiness, prefix1 selected before append2, and liveness failure', async (t) => {
  const pubsub = new InMemoryPubSub();
  let serverClock = 1_000;
  const now = () => (serverClock += 10);
  const authority = new GameAuthority(pubsub, now);
  await authority.createGame({
    gameId: 'g-causality',
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    players: { white: 'alice', black: 'bob' },
    rated: false,
    source: 'seek',
    noShowAfterMs: 30_000,
  });

  await authority.apply('g-causality', 'alice', { kind: 'ready' }); // seq 1
  await authority.apply('g-causality', 'bob', { kind: 'ready' });   // seq 2
  await authority.apply('g-causality', 'alice', { kind: 'move', uci: 'e2e4' }); // seq 3, ply 1
  await authority.apply('g-causality', 'bob', { kind: 'move', uci: 'e7e5' });   // seq 4, ply 2

  const scheduler = new ManualScheduler();
  const factory = new FakeSocketFactory();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
  });
  const sync = new GameSync(client, { gameId: 'g-causality', token: 'token-alice', scheduler });
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();

  // Client joins at prefix 1 (ply 1, revision 3)
  factory.last.emit({
    t: 'joined',
    gameId: 'g-causality',
    role: 'white',
    state: { ...stateView(1, 'b', 3, [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]), gameId: 'g-causality' },
  });
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 3);

  // Read prefix1 from authority for recovery from ply 1 BEFORE append 2
  const readPrefix1 = await authority.readRecovery('g-causality', 1);
  assert.equal(readPrefix1.state.ply, 2);
  assert.equal(readPrefix1.state.stateRevision, 4);

  // Now append 2 occurs on server!
  await authority.apply('g-causality', 'alice', { kind: 'move', uci: 'g1f3' }); // seq 5, ply 3

  // Server broadcast for append 2 reaches client: ply 3, revision 5
  factory.last.emit({
    t: 'move',
    gameId: 'g-causality',
    stateRevision: 5,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    fenHash: 'h3',
    clock: { w: 58_000, b: 59_000 },
    serverTs: 3_000,
    legalMoves: { e5: ['e4'] },
  });

  // Gap detected! Client is at ply 1, received ply 3 / revision 5. Target is revision 5, ply 3.
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.submitMove('d2d4'), null, 'gameplay submission gated during recovery');

  // Resume request was sent for lastPly 1
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);

  // Old prefix1 (selected before append2) arrives at the client before newer intent reaches server
  factory.last.emit({
    t: 'resumed',
    gameId: 'g-causality',
    state: readPrefix1.state, // revision 4, ply 2
    missed: readPrefix1.missed,
  });

  // Prefix 1 was insufficient! Target is revision 5, ply 3.
  assert.equal(sync.getState().ply, 2, 'partial progress advanced to ply 2');
  assert.equal(sync.stateRevision, 4, 'floor advanced to revision 4');
  assert.equal(sync.getState().recovering, true, 'recovery remains incomplete');
  assert.equal(sync.submitMove('d2d4'), null, 'gameplay submission still gated');

  // Attempt 0 timeout (2000 ms)
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();

  // Backoff delay for retry attempt 1
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 2);

  // Attempt 1 times out (2000 ms)
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();

  // Backoff delay for retry attempt 2
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);

  // Attempt 2 times out (2000 ms)
  assert.equal(scheduler.pending, 1);
  scheduler.runNext();

  // All 3 attempts exhausted: quiescence and liveness failure established!
  assert.equal(scheduler.pending, 0, 'quiescent with 0 pending tasks');
  assert.equal(sync.getState().recovering, true, 'debt retained through exhaustion');
  assert.equal(sync.getState().recoveryAvailable, true, 'recoveryAvailable exposed on exhaustion');
  assert.equal(sync.getState().ply, 2, 'retains gapped ply 2');
  assert.equal(sync.submitMove('d2d4'), null, 'gameplay submission remains gated on exhaustion');

  // Manual retry recovery via retryRecovery
  sync.retryRecovery();
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().recovering, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 4);

  // Server responds with complete authoritative state at revision 5, ply 3
  const freshRead = await authority.readRecovery('g-causality', 2);
  assert.equal(freshRead.state.ply, 3);
  assert.equal(freshRead.state.stateRevision, 5);

  factory.last.emit({
    t: 'resumed',
    gameId: 'g-causality',
    state: freshRead.state,
    missed: freshRead.missed,
  });

  // Sufficient exact convergence!
  assert.equal(sync.getState().ply, 3, 'ply converged to 3');
  assert.equal(sync.stateRevision, 5, 'floor converged to revision 5');
  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().snapshot?.fen, freshRead.state.fen);
  assert.equal(sync.getState().snapshot?.fenHash, freshRead.state.fenHash);
  assert.equal(sync.getState().snapshot?.turn, freshRead.state.turn);
  assert.deepEqual(sync.getState().moves, freshRead.state.moves);
  assert.deepEqual(sync.getState().snapshot?.status, freshRead.state.status);
  assert.deepEqual(sync.getState().snapshot?.legalMoves, freshRead.state.legalMoves);
  assert.deepEqual(sync.getState().snapshot?.ready, freshRead.state.ready);
  assert.deepEqual(sync.getState().snapshot?.clock, freshRead.state.clock);
  assert.equal(sync.getState().snapshot?.turnStartedAt, freshRead.state.turnStartedAt);
});
test('exhaustion/late insufficient progress preserves retry', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0, []),
  });
  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);

  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);

  for (let i = 0; i < 5; i++) {
    scheduler.runNext();
  }
  assert.equal(scheduler.pending, 0);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);
  assert.equal(sync.getState().recoveryAvailable, true);

  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(1, 'b', 1, fullLedger.slice(0, 1)),
    missed: [],
  });

  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().snapshot?.ply, 1);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[1]);
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger.slice(0, 1));
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.getState().recoveryAvailable, true);
  assert.equal(scheduler.pending, 0);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);

  assert.equal(sync.submitMove('e7e5'), null);
  assert.equal(sync.resign(), false);
  assert.equal(sync.offerDraw(), false);
  assert.equal(sync.acceptDraw(), false);
  assert.equal(sync.declineDraw(), false);
  assert.equal(sync.claimFlag(), false);
  assert.equal(sync.abort(), false);

  sync.retryRecovery();
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().recovering, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 4);

  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', 3, fullLedger, legalMoves3),
    missed: [],
  });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[3]);
  assert.equal(sync.getState().snapshot?.fenHash, 'h3');
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger);
  assert.equal(sync.getState().snapshot?.ply, 3);
  assert.equal(sync.getState().snapshot?.turn, 'b');
  assert.deepEqual(sync.getState().snapshot?.status, { over: false });
  assert.deepEqual(sync.getState().snapshot?.legalMoves, legalMoves3);
});

test('nested legacy lower snapshot', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', null, []),
  });

  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);

  let armed = true;
  const unsubscribe = sync.subscribe((state) => {
    if (!armed) return;
    if (state.recovering && state.snapshot?.ply === 3) {
      armed = false;
      unsubscribe();
      factory.last.emit({
        t: 'resumed',
        gameId: 'g1',
        state: stateView(1, 'b', null, fullLedger.slice(0, 1)),
        missed: [],
      });
    }
  });

  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', null, fullLedger),
    missed: [],
  });

  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[1]);
  assert.equal(sync.getState().snapshot?.fenHash, 'h1');
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger.slice(0, 1));
  assert.equal(sync.getState().snapshot?.ply, 1);
  assert.equal(sync.getState().snapshot?.turn, 'b');
  assert.deepEqual(sync.getState().snapshot?.status, { over: false });
  assert.equal(sync.submitMove('e7e5'), null);

  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', null, fullLedger, legalMoves3),
    missed: [],
  });
  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[3]);
  assert.equal(sync.getState().snapshot?.fenHash, 'h3');
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger);
  assert.equal(sync.getState().snapshot?.ply, 3);
  assert.equal(sync.getState().snapshot?.turn, 'b');
  assert.deepEqual(sync.getState().snapshot?.status, { over: false });
  assert.deepEqual(sync.getState().snapshot?.legalMoves, legalMoves3);
});

test('retryRecovery initial notification logout', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0, []),
  });

  let armed = false;
  const unsubscribe = sync.subscribe(() => {
    if (!armed) return;
    armed = false;
    unsubscribe();
    sync.logoutRequested();
  });

  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);
  const initialResumes = factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length;
  assert.equal(initialResumes, 1);
  const socketCount = factory.sockets.length;

  armed = true;
  sync.retryRecovery();

  assert.ok(factory.last.closed);
  assert.equal(factory.sockets.length, socketCount);
  assert.equal(
    factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length,
    initialResumes,
  );
  assert.equal(scheduler.pending, 0);

  sync.stop();
  assert.doesNotThrow(() => sync.stop());
});

test('synchronous stop during sufficient rejoin-discharge prevents post-stop reconnect resume', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0, []),
  });

  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);

  const initialSocket = factory.last;
  initialSocket.serverClose();

  scheduler.runNext();
  assert.equal(factory.sockets.length, 2);
  const newSocket = factory.last;
  assert.notEqual(newSocket, initialSocket);

  let armed = true;
  const unsubscribe = sync.subscribe((state) => {
    if (!armed) return;
    if (!state.recovering) {
      armed = false;
      unsubscribe();
      sync.stop();
    }
  });

  newSocket.open();

  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  newSocket.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(3, 'b', 3, fullLedger, legalMoves3),
  });

  const newSocketResumes = newSocket.sent.filter((f) => JSON.parse(f).t === 'resume');
  assert.equal(newSocketResumes.length, 0);
  assert.equal(scheduler.pending, 0);
  assert.equal(newSocket.closed, null);
});

test('auto-online flight backoff exhaustion coalesces on connected transport until explicit retry', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger4: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
    { ply: 4, uci: 'b8c6', san: 'Nc6', by: 'b' },
  ];

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w', 0, []),
  });
  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.stateRevision, 0);

  // Move gap to ply 3 triggers recovery flight 1 with 2s timeout
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });

  assert.equal(sync.getState().recovering, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Repeated automatic online on connected transport is a no-op: retains single resume and active 2s timer
  sync.networkOnline();
  sync.networkOnline();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Attempt 1 timeout fires, transitioning to 1s backoff
  scheduler.runNext();
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1000);

  // Online during backoff coalesces: no extra resume and timer unchanged
  sync.networkOnline();
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1000);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);

  // Higher target move arrives during backoff: coalesces without resetting backoff timer
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 4,
    ply: 4,
    uci: 'b8c6',
    san: 'Nc6',
    by: 'b',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h4',
    legalMoves: {},
  });
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1000);

  // Backoff fires, sending resume 2 with 2s timeout
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 2);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Attempt 2 timeout fires, transitioning to 2s backoff
  scheduler.runNext();
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Attempt 2 backoff fires, sending resume 3 with 2s timeout
  scheduler.runNext();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Attempt 3 timeout fires: budget exhausted, 0 timers remaining, retry available
  scheduler.runNext();
  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);

  // Online after exhaustion on open transport preserves 3 resumes and recoveryAvailable true
  sync.networkOnline();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 3);
  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);

  // Explicit retryRecovery alone initiates the 4th resume
  sync.retryRecovery();
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 4);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().recovering, true);

  // Snapshot 3 arrives: insufficient because target was raised to revision 4, ply 4
  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', 3, fullLedger4.slice(0, 3), legalMoves3),
    missed: [],
  });
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.ply, 3);
  assert.equal(sync.getState().recoveryAvailable, false);

  // Coherent full 4 snapshot arrives, discharging debt and restoring exact projection
  const legalMoves4: LegalMoves = { f1: ['c4', 'b5', 'e2', 'd3'] };
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(4, 'w', 4, fullLedger4, legalMoves4),
    missed: [],
  });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().ply, 4);
  assert.equal(sync.stateRevision, 4);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[4]);
  assert.equal(sync.getState().snapshot?.fenHash, 'h4');
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger4);
  assert.equal(sync.getState().snapshot?.turn, 'w');
  assert.deepEqual(sync.getState().snapshot?.status, { over: false });
  assert.deepEqual(sync.getState().snapshot?.legalMoves, legalMoves4);
});

test('malformed rejoin retryable budget exhausts join retries and preserves gap debt budget', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];

  sync.start();
  factory.last.open();

  // Start accepted positive floor 1
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(1, 'b', 1, fullLedger.slice(0, 1)),
  });
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().recovering, false);

  // Debt 3/3 consumes resume 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);
  const socket1 = factory.last;
  assert.equal(socket1.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);

  // Capture complete state before bad join
  const snapshotBefore = sync.getState().snapshot;
  const movesBefore = snapshotBefore?.moves;
  const fenBefore = snapshotBefore?.fen;
  const hashBefore = snapshotBefore?.fenHash;
  const turnBefore = snapshotBefore?.turn;
  const statusBefore = snapshotBefore?.status;
  const readyBefore = snapshotBefore?.ready;
  const floorBefore = sync.stateRevision;
  const plyBefore = sync.getState().ply;

  // Drop and reconnect onto socket 2
  socket1.serverClose();
  scheduler.runNext();
  assert.equal(factory.sockets.length, 2);
  const socket2 = factory.last;
  assert.notEqual(socket2, socket1);

  socket2.open();
  const countJoins = (sock: FakeSocket): number =>
    sock.sent.filter((f) => JSON.parse(f).t === 'join').length;
  assert.equal(countJoins(socket2), 1);

  // Malformed joined reply with role: 'spectator' and truncated ledger
  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  socket2.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: stateView(3, 'b', 3, fullLedger.slice(0, 1), legalMoves3),
  });

  // Rejected without acceptance: connected false blocks privilege; all snapshot fields unchanged
  assert.equal(sync.getState().connected, false, 'connected false blocks privilege');
  assert.equal(sync.getState().ply, plyBefore);
  assert.equal(sync.stateRevision, floorBefore);
  assert.equal(sync.getState().snapshot?.fen, fenBefore);
  assert.equal(sync.getState().snapshot?.fenHash, hashBefore);
  assert.equal(sync.getState().snapshot?.turn, turnBefore);
  assert.deepEqual(sync.getState().snapshot?.status, statusBefore);
  assert.deepEqual(sync.getState().snapshot?.ready, readyBefore);
  assert.deepEqual(sync.getState().snapshot?.moves, movesBefore);
  assert.equal(sync.submitMove('e7e5'), null, 'submitMove blocked');
  assert.equal(sync.resign(), false, 'resign blocked');
  assert.equal(sync.offerDraw(), false, 'offerDraw blocked');
  assert.equal(sync.acceptDraw(), false, 'acceptDraw blocked');
  assert.equal(sync.declineDraw(), false, 'declineDraw blocked');
  assert.equal(sync.claimFlag(), false, 'claimFlag blocked');
  assert.equal(sync.abort(), false, 'abort blocked');
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1000);

  // Automatic online during 1s backoff leaves join count and timer unchanged
  sync.networkOnline();
  assert.equal(countJoins(socket2), 1);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 1000);

  // Advance 1s -> sends join 2 (bad) -> schedules 2s
  scheduler.runNext();
  assert.equal(countJoins(socket2), 2);
  socket2.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: stateView(3, 'b', 3, fullLedger.slice(0, 1), legalMoves3),
  });
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Automatic online during 2s backoff
  sync.networkOnline();
  assert.equal(countJoins(socket2), 2);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 2000);

  // Advance 2s -> sends join 3 (bad) -> schedules 4s
  scheduler.runNext();
  assert.equal(countJoins(socket2), 3);
  socket2.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: stateView(3, 'b', 3, fullLedger.slice(0, 1), legalMoves3),
  });
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 4000);

  // Automatic online during 4s backoff
  sync.networkOnline();
  assert.equal(countJoins(socket2), 3);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, 4000);

  // Advance 4s -> sends join 4 (bad) -> exhausts join retries
  scheduler.runNext();
  assert.equal(countJoins(socket2), 4);
  socket2.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: stateView(3, 'b', 3, fullLedger.slice(0, 1), legalMoves3),
  });

  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);

  // Automatic online during exhaustion does not send extra join
  sync.networkOnline();
  assert.equal(countJoins(socket2), 4);
  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);

  // Explicit retryRecovery dispatches join 5
  sync.retryRecovery();
  assert.equal(countJoins(socket2), 5);
  assert.equal(sync.getState().recoveryAvailable, false);

  // Valid insufficient joined floor 1 restores owned role; debt remains and gap budget retains prior socket 1 usage
  socket2.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(1, 'b', 1, fullLedger.slice(0, 1)),
  });
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().recovering, true);

  const countResumes = (sock: FakeSocket): number =>
    sock.sent.filter((f) => JSON.parse(f).t === 'resume').length;
  assert.equal(countResumes(socket2), 1, 'socket 2 sends initial resume on debt discovery');
  assert.equal(countResumes(socket1) + countResumes(socket2), 2, '2 cumulative resumes across sockets');

  // Run out remaining gap budget: timeout -> backoff -> cumulative resume 3 -> timeout -> exhaustion
  scheduler.runNext();
  scheduler.runNext();
  assert.equal(countResumes(socket2), 2);
  assert.equal(countResumes(socket1) + countResumes(socket2), 3);

  scheduler.runNext();
  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recoveryAvailable, true);

  // Authoritative snapshot resolves debt without move command replay
  socket2.emit({
    t: 'resumed',
    gameId: 'g1',
    state: stateView(3, 'b', 3, fullLedger, legalMoves3),
    missed: [],
  });
  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.fen, PLY_FENS[3]);
  assert.deepEqual(sync.getState().snapshot?.moves, fullLedger);
  assert.equal(socket2.sent.filter((f) => JSON.parse(f).t === 'move').length, 0);
});

test('duplicate unowned joined while connected leaves timer role and authorization unchanged', (t) => {
  const { factory, scheduler, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];

  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(1, 'b', 1, fullLedger.slice(0, 1)),
  });

  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60_000, b: 60_000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: {},
  });
  assert.equal(sync.getState().recovering, true);
  assert.equal(scheduler.pending, 1);
  const activeDelay = scheduler.nextDelayMs;

  // While connected and in active gap flight, duplicate unowned joined arrives
  const joinsBefore = factory.last.sent.filter((f) => JSON.parse(f).t === 'join').length;
  const resumesBefore = factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length;
  const roleBefore = sync.getState().role;
  const myColorBefore = sync.getState().myColor;
  assert.equal(roleBefore, 'white');
  assert.equal(myColorBefore, 'w');
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'spectator',
    state: stateView(3, 'b', 3, fullLedger.slice(0, 1)),
  });

  // Timer, role, and authorization unchanged; no phantom joins sent
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.nextDelayMs, activeDelay, 'timer unchanged');
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'join').length, joinsBefore, 'no phantom join');
  assert.equal(sync.getState().connected, true, 'connected remains true for owned session');
  assert.equal(sync.getState().role, roleBefore);
  assert.equal(sync.getState().myColor, myColorBefore);
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.resign(), false);
  assert.equal(sync.getState().ply, 1, 'ply unchanged');
  assert.equal(sync.stateRevision, 1, 'floor unchanged');
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, resumesBefore);
});

test('malformed join exhaustion reentrancy stop, logout, and manual successor', (t) => {
  const fullLedger: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
  ];
  const legalMoves3: LegalMoves = { b8: ['c6', 'a6'], g8: ['f6'] };
  const badJoinState = stateView(3, 'b', 3, fullLedger.slice(0, 1), legalMoves3);

  for (const action of ['stop', 'logout', 'manual'] as const) {
    const { factory, scheduler, client, sync } = setup();
    t.after(() => {
      sync.stop();
      client.close();
    });

    sync.start();
    factory.last.open();

    // Establish floor 1 / debt 3
    factory.last.emit({
      t: 'joined',
      gameId: 'g1',
      role: 'white',
      state: stateView(1, 'b', 1, fullLedger.slice(0, 1)),
    });
    factory.last.emit({
      t: 'move',
      gameId: 'g1',
      stateRevision: 3,
      ply: 3,
      uci: 'g1f3',
      san: 'Nf3',
      by: 'w',
      clock: { w: 60_000, b: 60_000 },
      serverTs: 0,
      fenHash: 'h3',
      legalMoves: {},
    });
    assert.equal(sync.getState().recovering, true);

    // Drop and open new socket
    factory.last.serverClose();
    scheduler.runNext();
    const socket2 = factory.last;
    socket2.open();

    const countJoins = (): number =>
      socket2.sent.filter((f) => JSON.parse(f).t === 'join').length;
    assert.equal(countJoins(), 1);

    let handledExhaustion = false;
    const unsubscribe = sync.subscribe((state) => {
      if (handledExhaustion) return;
      if (state.recoveryAvailable) {
        handledExhaustion = true;
        unsubscribe();

        if (action === 'stop') {
          sync.stop();
          assert.equal(socket2.closed, null, 'sync.stop must not close shared socket');
        } else if (action === 'logout') {
          sync.logoutRequested();
          assert.ok(socket2.closed, 'logout does close revoking privileges');
        } else {
          // Manual successor: DO NOT stop or logout first
          sync.retryRecovery();
          assert.equal(countJoins(), 5, 'retryRecovery dispatches join 5');

          // Synchronously deliver complete joined 3 BEFORE old failure handler returns
          socket2.emit({
            t: 'joined',
            gameId: 'g1',
            role: 'white',
            state: stateView(3, 'b', 3, fullLedger, legalMoves3),
          });

          assert.equal(sync.getState().ply, 3);
          assert.equal(sync.stateRevision, 3);
          assert.equal(sync.getState().recovering, false);
          assert.deepEqual(sync.getState().snapshot?.moves, fullLedger);
        }
      }
    });

    // Join 1 bad -> 1s delay
    socket2.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: badJoinState });
    scheduler.runNext();

    // Join 2 bad -> 2s delay
    socket2.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: badJoinState });
    scheduler.runNext();

    // Join 3 bad -> 4s delay
    socket2.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: badJoinState });
    scheduler.runNext();

    // Join 4 bad -> triggers exhaustion notification and subscriber action
    socket2.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: badJoinState });
    assert.ok(handledExhaustion);

    if (action === 'stop') {
      assert.equal(socket2.closed, null, 'socket stays open on stop');
      assert.equal(countJoins(), 4, 'no join 5 dispatched on stop');
      assert.equal(sync.getState().ply, 1, 'snapshot stays at floor 1');
      assert.equal(sync.stateRevision, 1, 'floor stays 1');
      assert.equal(scheduler.pending, 0, 'no timers after stop');
    } else if (action === 'logout') {
      assert.ok(socket2.closed, 'socket closed on logout');
      assert.equal(countJoins(), 4, 'no new join traffic after logout');
      assert.equal(scheduler.pending, 0, 'no timers after logout');
    } else {
      // Manual successor: old continuation did not schedule clobber timer / state
      assert.equal(scheduler.pending, 0, 'no competing timer from old continuation');
      assert.equal(sync.getState().ply, 3, 'clean full 3 preserved');
      assert.equal(sync.stateRevision, 3, 'clean revision 3 preserved');
      assert.equal(sync.getState().recovering, false);
      assert.deepEqual(sync.getState().snapshot?.moves, fullLedger);
      assert.equal(socket2.sent.filter((f) => JSON.parse(f).t === 'resume').length, 0, 'no extra resume');
      assert.equal(socket2.sent.filter((f) => JSON.parse(f).t === 'move').length, 0, 'no command replay');
    }
  }
});

test('synthetic policy: withheld offerDraw advances revision without ply, triggering known-gap recovery on next move', async (t) => {
  // Frame injection regression; not multinode gateway, PG, Redis, or network certification
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000);
  const tc = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };
  const init = await authority.createGame({ gameId: 'g1', timeControl: tc, players: { white: 'u1', black: 'u2' }, rated: false });

  const { factory, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();

  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: init });
  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.stateRevision, 0);

  // Move 1: white plays e2e4 -> stateRevision 1, ply 1
  const move1Res = await authority.apply('g1', 'u1', { kind: 'move', uci: 'e2e4' });
  assert.equal(move1Res.state.stateRevision, 1);
  assert.equal(move1Res.state.ply, 1);
  const bcast1 = move1Res.broadcasts[0];
  assert.ok(bcast1 !== undefined && bcast1.t === 'move');
  factory.last.emit(bcast1);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 1);
  const acceptedSnapshot = sync.getState().snapshot;
  assert.ok(acceptedSnapshot !== null);

  // offerDraw advances authority stateRevision to 2 while ply remains 1; assert broadcasts length 0
  const drawRes = await authority.apply('g1', 'u1', { kind: 'offerDraw' });
  assert.equal(drawRes.broadcasts.length, 0);
  assert.equal(drawRes.state.stateRevision, 2);
  assert.equal(drawRes.state.ply, 1);

  // Move 2: black plays e7e5 -> stateRevision 3, ply 2
  const move2Res = await authority.apply('g1', 'u2', { kind: 'move', uci: 'e7e5' });
  assert.equal(move2Res.state.stateRevision, 3);
  assert.equal(move2Res.state.ply, 2);

  const bcast2 = move2Res.broadcasts[0];
  assert.ok(bcast2 !== undefined && bcast2.t === 'move');
  factory.last.emit(bcast2);

  // Contiguous ply (1 -> 2) but revision jump (1 -> 3) triggers known-gap full recovery
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.resign(), false);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().snapshot, acceptedSnapshot);
  assert.deepEqual(sync.getState().snapshot?.moves, acceptedSnapshot.moves);
  assert.deepEqual(sync.getState().snapshot?.ready, acceptedSnapshot.ready);
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);

  const recovery = await authority.readRecovery('g1', 1);
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: recovery.state,
    missed: recovery.missed,
  });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().ply, 2);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.fen, recovery.state.fen);
  assert.equal(sync.getState().snapshot?.fenHash, recovery.state.fenHash);
  assert.equal(sync.getState().snapshot?.turn, recovery.state.turn);
  assert.deepEqual(sync.getState().snapshot?.moves, recovery.state.moves);
  assert.deepEqual(sync.getState().snapshot?.status, recovery.state.status);
  assert.deepEqual(sync.getState().snapshot?.drawOffer, recovery.state.drawOffer);
  assert.deepEqual(sync.getState().snapshot?.ready, recovery.state.ready);
  assert.equal(sync.getState().snapshot?.turnStartedAt, recovery.state.turnStartedAt);
  assert.deepEqual(sync.getState().snapshot?.clock, recovery.state.clock);
  assert.deepEqual(sync.getState().snapshot?.legalMoves, recovery.state.legalMoves);
});

test('synthetic policy: withheld ready broadcasts trigger gate on first move until full recovery', async (t) => {
  // Frame injection regression; not multinode gateway, PG, Redis, or network certification
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => 1_000);
  const tc = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };
  const init = await authority.createGame({
    gameId: 'g1',
    timeControl: tc,
    players: { white: 'u1', black: 'u2' },
    rated: false,
    source: 'seek',
    noShowAfterMs: 30_000,
  });
  assert.deepEqual(init.ready, { w: false, b: false });
  assert.equal(init.stateRevision, 0);

  const { factory, client, sync } = setup();
  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  factory.last.open();

  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: init });
  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.stateRevision, 0);
  assert.deepEqual(sync.getState().snapshot?.ready, { w: false, b: false });
  const acceptedSnapshot = sync.getState().snapshot;
  assert.ok(acceptedSnapshot !== null);

  // Authority records readiness advancing stateRevision to 1 and 2; verify broadcasts length and stateRevision
  const readyW = await authority.apply('g1', 'u1', { kind: 'ready' });
  assert.equal(readyW.state.stateRevision, 1);
  assert.equal(readyW.broadcasts.length, 1);
  assert.equal(Reflect.get(readyW.broadcasts[0]!, 'stateRevision'), 1);

  const readyB = await authority.apply('g1', 'u2', { kind: 'ready' });
  assert.equal(readyB.state.stateRevision, 2);
  assert.equal(readyB.broadcasts.length, 1);
  assert.equal(Reflect.get(readyB.broadcasts[0]!, 'stateRevision'), 2);
  assert.deepEqual(readyB.state.ready, { w: true, b: true });

  // First move at stateRevision 3, ply 1
  const move1 = await authority.apply('g1', 'u1', { kind: 'move', uci: 'e2e4' });
  assert.equal(move1.state.stateRevision, 3);
  assert.equal(move1.state.ply, 1);

  const bcastMove = move1.broadcasts[0];
  assert.ok(bcastMove !== undefined && bcastMove.t === 'move');
  factory.last.emit(bcastMove);

  // Client missing readiness revisions triggers recovery gate
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.resign(), false);
  assert.equal(sync.stateRevision, 0);
  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.getState().snapshot, acceptedSnapshot);
  assert.deepEqual(sync.getState().snapshot?.moves, acceptedSnapshot.moves);
  assert.deepEqual(sync.getState().snapshot?.ready, { w: false, b: false });
  assert.equal(factory.last.sent.filter((f) => JSON.parse(f).t === 'resume').length, 1);

  const recovery = await authority.readRecovery('g1', 0);
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: recovery.state,
    missed: recovery.missed,
  });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.fen, recovery.state.fen);
  assert.equal(sync.getState().snapshot?.fenHash, recovery.state.fenHash);
  assert.equal(sync.getState().snapshot?.turn, recovery.state.turn);
  assert.deepEqual(sync.getState().snapshot?.moves, recovery.state.moves);
  assert.deepEqual(sync.getState().snapshot?.status, recovery.state.status);
  assert.deepEqual(sync.getState().snapshot?.ready, { w: true, b: true });
  assert.deepEqual(sync.getState().snapshot?.drawOffer, recovery.state.drawOffer);
  assert.equal(sync.getState().snapshot?.turnStartedAt, recovery.state.turnStartedAt);
  assert.deepEqual(sync.getState().snapshot?.clock, recovery.state.clock);
  assert.deepEqual(sync.getState().snapshot?.legalMoves, recovery.state.legalMoves);
});
