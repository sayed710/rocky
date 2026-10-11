import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import type { LegalMoves, StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

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
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  return { factory, scheduler, client, sync };
}

function stateView(
  ply: number,
  turn: WsColor,
  moves: StateView['moves'] = [],
  legalMoves: LegalMoves = {},
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: 'startpos',
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
  };
}

test('start joins on open', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  assert.deepEqual(JSON.parse(factory.last.sent[0]!), { t: 'join', gameId: 'g1', token: 'token-u1' });
  assert.equal(sync.getState().connected, true);
});

test('unknown outcome preserves pending move and only requests state, never replays', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const pending = sync.submitMove('e2e4'); assert.ok(pending);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'req-1', message: 'Command outcome unknown.' });
  assert.deepEqual(sync.getState().pending, pending);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(JSON.parse(factory.last.sent.at(-1)!).t, 'resume');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.equal(sync.getState().pending, null, 'snapshot releases input without claiming the old command was cancelled');
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'unchanged snapshot cannot establish rejection');
  assert.equal(factory.last.sent.map((frame) => JSON.parse(frame) as { t: string }).filter((msg) => msg.t === 'move').length, 1);
  assert.ok(sync.submitMove('d2d4'), 'a new explicit gesture is allowed after reconciliation');
  const movesSent = factory.last.sent.map((frame) => JSON.parse(frame) as { t: string; uci?: string }).filter((msg) => msg.t === 'move');
  assert.deepEqual(movesSent.map((msg) => msg.uci), ['e2e4', 'd2d4'], 'the old intent is never replayed automatically');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]) });
  assert.equal(sync.getState().pending, null);
  assert.ok(sync.submitMove('e7e5') === null, 'authoritative turn still gates new manual input');
});

for (const confirmation of ['broadcast', 'snapshot'] as const) {
  test(`late ${confirmation} needs the exact request receipt to resolve uncertainty`, () => {
    const { factory, sync } = setup(); sync.start(); factory.last.open();
    factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
    const pending = sync.submitMove('e2e4'); assert.ok(pending);
    factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'late', message: 'Unknown.' });
    factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
    assert.equal(sync.getState().pending, null);
    assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
    if (confirmation === 'snapshot') {
      factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]) });
    } else {
      factory.last.emit({ t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {} });
    }
    assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'position alone is not a request receipt');
    factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'late' });
    assert.equal(sync.getState().lastReject, null);
    assert.equal(factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 1);
  });
}

test('a snapshot before the unknown response cannot hide the uncertainty notice', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const pending = sync.submitMove('e2e4'); assert.ok(pending);
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.equal(sync.getState().pending, null);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'late-notice', message: 'Unknown.' });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(JSON.parse(factory.last.sent.at(-1)!).t, 'resume');
  assert.equal(factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 1);
});

test('a late draw state resolves action uncertainty after input has been released', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  assert.equal(sync.offerDraw(), true);
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: 'draw-late', action: 'offerDraw', message: 'Unknown.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.equal(sync.getState().pendingAction, null);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'state', gameId: 'g1', state: { ...stateView(0, 'w'), drawOffer: 'w' } });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'draw-late' });
  assert.equal(sync.getState().lastReject, null);
  assert.equal(factory.last.sent.filter((frame) => JSON.parse(frame).t === 'offerDraw').length, 1);
});

test('a different move at the disputed ply cannot settle a still-live delayed request', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const pending = sync.submitMove('g1f3'); assert.ok(pending);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'other-device', message: 'Unknown.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(1, 'b', [{ ply: 1, uci: 'd2d4', san: 'd4', by: 'w' }]) });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().pending, null);
  assert.equal(factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 1);
});

test('actionless readiness uncertainty never inherits a pending draw offer', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: { ...stateView(0, 'w'), ready: { w: false, b: false } } });
  assert.equal(sync.offerDraw(), true);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: 'readiness', message: 'Unknown.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: { ...stateView(0, 'w'), drawOffer: 'w', ready: { w: false, b: false } } });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
});

test('readiness reconciliation must follow the original seat across a changed join role', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: { ...stateView(0, 'w'), ready: { w: false, b: true } } });
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: 'original-white', action: 'ready', readyColor: 'w', message: 'Unknown.' });
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'black', state: { ...stateView(0, 'w'), ready: { w: false, b: true } } });
  assert.equal(sync.getState().myColor, 'b');
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'the new seat cannot confirm the old readiness request');
  factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: false, b: true }, serverTs: 1 });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
  assert.equal(sync.getState().lastReject, null, 'the original seat can reconcile even after the role changes');
});

test('receipt ordering and unrelated confirmations cannot hide an unknown request', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const pending = sync.submitMove('g1f3'); assert.ok(pending);
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'already-confirmed' });
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'live', message: 'Unknown.' });
  factory.last.emit({ t: 'commandConfirmed', gameId: 'other-game', requestId: 'live' });
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'unrelated' });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'already-confirmed', message: 'Unknown.' });
  const notice = sync.getState().lastReject; assert.ok(notice?.t === 'outcomeUnknown');
  assert.equal(notice.requestId, 'live', 'a late notice for a confirmed request cannot replace another uncertainty');
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'live' });
  assert.equal(sync.getState().lastReject, null);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: pending.clientSeq, requestId: 'live', message: 'Unknown.' });
  assert.equal(sync.getState().lastReject, null, 'a late unknown frame cannot undo an exact confirmation');
});

test('a new gesture and its rejection cannot hide another request still awaiting its receipt', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const old = sync.submitMove('g1f3'); assert.ok(old);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: old.clientSeq, requestId: 'old-live', message: 'Unknown.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  const next = sync.submitMove('d2d4'); assert.ok(next);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: next.clientSeq, code: 'illegal_move', message: 'Refused new move.' });
  assert.equal(sync.getState().pending, null);
  const notice = sync.getState().lastReject; assert.ok(notice?.t === 'outcomeUnknown');
  assert.equal(notice.requestId, 'old-live');
  assert.match(notice.message, /Refused new move\./, 'show the new refusal alongside the older uncertainty');
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'old-live' });
  assert.equal(sync.getState().lastReject?.t, 'reject');
  assert.equal(sync.getState().lastReject?.message, 'Refused new move.');
});

for (const reversed of [false, true]) {
  test(`overlapping unknown requests reconcile independently with reversed responses=${reversed}`, () => {
    const { factory, sync } = setup(); sync.start(); factory.last.open();
    factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
    const first = sync.submitMove('g1f3'); assert.ok(first);
    factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
    const second = sync.submitMove('d2d4'); assert.ok(second);
    const requests = [{ id: 'first', ref: first.clientSeq }, { id: 'second', ref: second.clientSeq }];
    if (reversed) requests.reverse();
    for (const request of requests) factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: request.ref, requestId: request.id, message: 'Unknown.' });
    factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: requests[1]!.id });
    const remaining = sync.getState().lastReject; assert.ok(remaining?.t === 'outcomeUnknown');
    assert.equal(remaining.requestId, requests[0]!.id, 'confirming one request cannot hide the other');
    factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
    assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
    factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: requests[0]!.id });
    assert.equal(sync.getState().lastReject, null);
    assert.equal(factory.last.sent.filter((frame) => JSON.parse(frame).t === 'move').length, 2);
  });
}

test('bounded uncertainty history retains a conservative warning after overflow', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  for (let i = 0; i < 40; i++) factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: `overflow-${i}`, message: 'Unknown.' });
  for (let i = 0; i < 40; i++) factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: `overflow-${i}` });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.match(sync.getState().lastReject?.message ?? '', /Earlier command outcomes remain unknown/);
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'resign', winner: 'w', serverTs: 1 });
  assert.equal(sync.getState().lastReject, null);
  assert.equal(factory.last.sent.filter((frame) => ['move', 'offerDraw', 'ready'].includes(JSON.parse(frame).t)).length, 0);
});

test('a move outcome cannot erase an earlier original-seat readiness uncertainty', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: { ...stateView(0, 'w'), ready: { w: false, b: false } } });
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: 'ready-first', action: 'ready', readyColor: 'w', message: 'Unknown readiness.' });
  const move = sync.submitMove('g1f3'); assert.ok(move);
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: move.clientSeq, requestId: 'move-second', message: 'Unknown move.' });
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'move-second' });
  const notice = sync.getState().lastReject; assert.ok(notice?.t === 'outcomeUnknown');
  assert.equal(notice.requestId, 'ready-first');
  factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: false, b: true }, serverTs: 1 });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
  assert.equal(sync.getState().lastReject, null);
});

for (const confirmation of ['snapshot', 'broadcast'] as const) {
  test(`explicit readiness uncertainty reconciles only this seat's ${confirmation}`, () => {
    const { factory, sync } = setup(); sync.start(); factory.last.open();
    factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: { ...stateView(0, 'w'), ready: { w: false, b: false } } });
    factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: null, requestId: 'ready-result', action: 'ready', readyColor: 'w', message: 'Unknown.' });
    factory.last.emit({ t: 'ready', gameId: 'other-game', ready: { w: true, b: true }, serverTs: 1 });
    factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: false, b: true }, serverTs: 1 });
    assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
    if (confirmation === 'snapshot') factory.last.emit({ t: 'state', gameId: 'g1', state: { ...stateView(0, 'w'), ready: { w: true, b: true } } });
    else factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2 });
    assert.equal(sync.getState().lastReject, null);
    assert.equal(factory.last.sent.filter((frame) => ['move', 'offerDraw', 'ready'].includes(JSON.parse(frame).t)).length, 0);
  });
}

test('joined populates role, color and snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const s = sync.getState();
  assert.equal(s.role, 'white');
  assert.equal(s.myColor, 'w');
  assert.equal(s.ply, 0);
  assert.equal(s.turn, 'w');
  assert.equal(s.snapshot?.fen, 'startpos');
});

test('submitMove sends an incrementing clientSeq and a matching broadcast confirms it', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  const pending = sync.submitMove('e2e4');
  assert.deepEqual(pending, { uci: 'e2e4', clientSeq: 1 });
  const sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.deepEqual(sent, { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  assert.deepEqual(sync.getState().pending, { uci: 'e2e4', clientSeq: 1 });

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });
  const s = sync.getState();
  assert.equal(s.pending, null);
  assert.equal(s.ply, 1);
  assert.equal(s.turn, 'b');
  assert.equal(s.moves.length, 1);
  assert.deepEqual(s.clock, { w: 59_000, b: 60_000 });
});

test('game actions are blocked while a move is pending', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  assert.deepEqual(sync.submitMove('e2e4'), { uci: 'e2e4', clientSeq: 1 });
  const sentBeforeActions = factory.last.sent.length;

  assert.equal(sync.resign(), false);
  assert.equal(sync.offerDraw(), false);
  assert.equal(sync.acceptDraw(), false);
  assert.equal(sync.declineDraw(), false);
  assert.equal(sync.claimFlag(), false);
  assert.equal(sync.abort(), false);
  assert.equal(factory.last.sent.length, sentBeforeActions);
  assert.equal(sync.getState().pendingAction, null);
});

test('a reject rolls back the pending move and records the reason', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  sync.submitMove('e2e4');
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: 1, code: 'illegal_move', message: 'nope' });
  const s = sync.getState();
  assert.equal(s.pending, null);
  assert.equal(s.lastReject?.code, 'illegal_move');
});

test('an opponent move applies; a ply gap triggers a resume request', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h1', clock: { w: 60_000, b: 59_000 }, serverTs: 1,
  legalMoves: {},
  });
  assert.equal(sync.getState().ply, 1);

  const before = factory.last.sent.length;
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w',
    fenHash: 'h3', clock: { w: 59_000, b: 59_000 }, serverTs: 2,
  legalMoves: {},
  });
  assert.equal(sync.getState().ply, 1); // gap not applied
  assert.deepEqual(JSON.parse(factory.last.sent.at(-1)!), { t: 'resume', gameId: 'g1', lastPly: 1 });
  assert.equal(factory.last.sent.length, before + 1);
});

test('ended and presence update state', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({ t: 'presence', gameId: 'g1', white: true, black: true, spectators: 4 });
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  const s = sync.getState();
  assert.deepEqual(s.presence, { white: true, black: true, spectators: 4 });
  assert.deepEqual(s.status, { over: true, result: '1-0', termination: 'checkmate', winner: 'w' });
});

test('after an unexpected drop, reconnect sends join then resumes from the last ply', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h1', clock: { w: 60_000, b: 59_000 }, serverTs: 1,
  legalMoves: {},
  });
  assert.equal(sync.getState().ply, 1);

  factory.last.serverClose(1006, '', false);
  scheduler.runNext(); // reconnect opens socket #2
  factory.last.open();
  assert.deepEqual(JSON.parse(factory.last.sent[0]!), { t: 'join', gameId: 'g1', token: 'token-u1' });

  // Simulate server responding to join with the current authoritative state (ply 2)
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(2, 'w') });
  
  // GameSync should then request missed moves since ply 1
  assert.deepEqual(JSON.parse(factory.last.sent[1]!), { t: 'resume', gameId: 'g1', lastPly: 1 });
});

test('M5: stop unsubscribes but does NOT close the shared connection', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  assert.equal(sync.getState().connected, true);
  sync.stop();
  // M5: GameSync.stop() no longer closes the WsClient — the composition root
  // owns the connection. The socket should remain open.
  assert.ok(!factory.last.closed, 'socket should NOT be closed by GameSync.stop()');
});

// ── legalMoves surfacing (increment 3C-2B) ──────────────────────────────

test('legalMoves defaults to empty before a snapshot', () => {
  const { sync } = setup();
  assert.deepEqual(sync.getState().legalMoves, {});
});

test('legalMoves are populated from the authoritative snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'], g1: ['f3', 'h3'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);
});

test('legalMoves are refreshed by a live move broadcast (push-based)', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);

  // The broadcast carries the resulting position's legal moves for the new side to move.
  const postMoveLm: LegalMoves = { e7: ['e6', 'e5'] };
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
    legalMoves: postMoveLm,
  });
  assert.deepEqual(sync.getState().legalMoves, postMoveLm);
});

test('legalMoves are cleared when the game ends', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);

  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  assert.deepEqual(sync.getState().legalMoves, {});
});

test('legalMoves are refreshed by a resync snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3', 'e4'] }) });
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
    legalMoves: { e7: ['e6', 'e5'] },
  });
  assert.deepEqual(sync.getState().legalMoves, { e7: ['e6', 'e5'] });

  // Server sends a fresh snapshot (e.g. after a resync)
  const lm: LegalMoves = { e7: ['e6', 'e5'] };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(1, 'b', [], lm) });
  assert.deepEqual(sync.getState().legalMoves, lm);
});

// ── AuthoritativeMoveOracle adapter (increment 3C-2B) ───────────────────

test('AuthoritativeMoveOracle returns destinations from GameSync legalMoves', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  const lm: LegalMoves = { e2: ['e3', 'e4'], g1: ['f3', 'h3'] };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], lm) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  oracle.setPosition('startpos');
  assert.deepEqual([...oracle.destinations('e2')], ['e3', 'e4']);
  assert.deepEqual([...oracle.destinations('g1')], ['f3', 'h3']);
});

test('AuthoritativeMoveOracle returns empty for unknown squares', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  assert.deepEqual([...oracle.destinations('a1')], []);
});

test('AuthoritativeMoveOracle reflects push-based legalMoves after a move', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3', 'e4'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  assert.deepEqual([...oracle.destinations('e2')], ['e3', 'e4']);

  // After a move broadcast, the oracle reflects the new side's legal moves.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
    legalMoves: { e7: ['e6', 'e5'] },
  });
  assert.deepEqual([...oracle.destinations('e2')], []);
  assert.deepEqual([...oracle.destinations('e7')], ['e6', 'e5']);
});

test('AuthoritativeMoveOracle returns empty when game is over', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', [], { e2: ['e3'] }) });

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  assert.deepEqual([...oracle.destinations('e2')], []);
});

// ── M5: connection ownership ───────────────────────────────────────────────

test('M5: two GameSyncs on one client; stopping one leaves the other receiving', () => {
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
  const sync1 = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const sync2 = new GameSync(client, { gameId: 'g2', token: 'token-u1' });

  sync1.start();
  sync2.start();
  factory.last.open();

  // Both should be connected and receiving.
  assert.equal(sync1.getState().connected, true);
  assert.equal(sync2.getState().connected, true);

  // Stop sync1 — sync2 should still be connected.
  sync1.stop();
  assert.ok(!factory.last.closed, 'shared socket should still be open');
  assert.equal(sync2.getState().connected, true, 'sync2 should still be connected');

  sync2.stop();
});

// ── M6: submitMove gating ──────────────────────────────────────────────────

test('M6: submitMove returns null when game is over', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5 });
  const result = sync.submitMove('e2e4');
  assert.equal(result, null, 'should not submit when game is over');
  assert.equal(factory.last.sent.length, 1, 'no move message should be sent'); // only the join
});

test('M6: submitMove returns null when it is not our turn', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  // Join as black, white to move → not our turn.
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'black', state: stateView(0, 'w') });
  const result = sync.submitMove('e7e5');
  assert.equal(result, null, 'should not submit when it is not our turn');
});

test('M6: submitMove returns null when a move is already pending', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const first = sync.submitMove('e2e4');
  assert.ok(first, 'first submit should succeed');
  const second = sync.submitMove('d2d4');
  assert.equal(second, null, 'second submit while pending should return null');
});

/**
 * `decodeServer()` validates only the `t` discriminant and casts the rest, so a frame that omits
 * `turnStartedAt` — a gateway that predates ADR-0103, which a rolling deploy makes ordinary — hands
 * the app `undefined` where it declares `number | null`. `undefined !== null`, so the countdown
 * would accept it as an anchor and interpolate against it, producing NaN remaining and a `NaN:NaN`
 * clock face. The boundary coerces it instead, so nothing downstream has to re-check.
 */
test('a snapshot frame with no turnStartedAt lands as null, not undefined', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  const withoutAnchor: Record<string, unknown> = { ...stateView(0, 'w') };
  delete withoutAnchor['turnStartedAt'];
  // Emitted as a raw frame, the way the socket actually delivers one — no cast needed to express
  // "the server sent a shape our types promise but do not enforce".
  factory.last.emit(JSON.stringify({ t: 'joined', gameId: 'g1', role: 'white', state: withoutAnchor }));

  const anchor = sync.getState().turnStartedAt;
  assert.equal(anchor, null);
  assert.notEqual(anchor, undefined, 'undefined would pass the `!== null` guard and yield NaN');
});

/** The move path takes its anchor from `serverTs` and is exposed exactly the same way. */
test('a move broadcast whose serverTs is not a number does not become a clock anchor', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });

  factory.last.emit(JSON.stringify({
    t: 'move',
    gameId: 'g1',
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 'not-a-timestamp',
    legalMoves: {},
  }));

  assert.equal(sync.getState().ply, 1, 'the move itself still applies');
  assert.equal(sync.getState().turnStartedAt, null);
});
