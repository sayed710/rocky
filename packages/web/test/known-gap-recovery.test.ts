import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient, type Scheduler } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController } from '../src/app/game-controller.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { LegalMoves, StateView, WsColor } from '../src/net/ws-protocol.js';
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

  // User triggers manual retry via networkOnline()
  sync.networkOnline();
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
  sync.networkOnline();
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

  // User triggers manual retry via networkOnline() while connected with active debt
  sync.networkOnline();

  // networkOnline() invalidates previous recoveryEpoch, resets attempt budget, and schedules successor timeout
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
      sync.networkOnline();
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
      sync.networkOnline();
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

  // Manual retry recovery via networkOnline
  sync.networkOnline();
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

  sync.networkOnline();
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

test('networkOnline initial notification logout', (t) => {
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
  sync.networkOnline();

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
