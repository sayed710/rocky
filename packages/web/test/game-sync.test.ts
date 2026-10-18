import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync, isStateRevision } from '../src/net/game-sync.js';
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
  assert.equal(sync.getState().connected, false, 'transport open awaits gateway authorization');
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
  factory.last.emit({ t: 'resumed', gameId: 'g1', missed: [], state: stateView(0, 'w') });
  assert.equal(sync.getState().lastReject?.message, 'Refused new move.', 'the older request resume cannot erase the new refusal');
  factory.last.emit({ t: 'move', gameId: 'g1', ply: 1, uci: 'g1f3', san: 'Nf3', by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {} });
  assert.equal(sync.getState().lastReject?.message, 'Refused new move.', 'a late older move cannot erase the new refusal');
});

test('a delayed older unknown preserves a newer refusal while ordinary errors still clear', () => {
  const { factory, sync } = setup(); sync.start(); factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  const old = sync.submitMove('g1f3'); assert.ok(old);
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  const newer = sync.submitMove('d2d4'); assert.ok(newer);
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: newer.clientSeq, code: 'illegal_move', message: 'New move refused.' });
  factory.last.emit({ t: 'outcomeUnknown', code: 'outcome_unknown', gameId: 'g1', ref: old.clientSeq, requestId: 'delayed-old', message: 'Old outcome unknown.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.match(sync.getState().lastReject?.message ?? '', /New move refused/);
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'delayed-old' });
  factory.last.emit({ t: 'resumed', gameId: 'g1', missed: [], state: stateView(0, 'w') });
  assert.equal(sync.getState().lastReject?.message, 'New move refused.');
  const next = sync.submitMove('e2e4'); assert.ok(next);
  assert.equal(sync.getState().lastReject, null);
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: next.clientSeq, code: 'illegal_move', message: 'Ordinary refusal.' });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w') });
  assert.equal(sync.getState().lastReject, null, 'a new gesture restores ordinary stale-error clearing');
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
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
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
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w') });
  factory.last.emit({ t: 'joined', gameId: 'g2', role: 'white', state: { ...stateView(0, 'w'), gameId: 'g2' } });
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

// ── Ordering regression tests (RZ-GAMESYNC-ORDERING-20261018-34) ───────────

test('regression: stale revisioned snapshot ply 2 -> 0 does not replace newer confirmed state', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Initial join at revision 0, ply 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  assert.equal(sync.getState().ply, 0);

  // Move 1 at revision 1, ply 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.getState().ply, 1);

  // Move 2 at revision 2, ply 2
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 59_000, b: 59_000 },
    serverTs: 2_000,
    legalMoves: { g1: ['f3'] },
  });
  assert.equal(sync.getState().ply, 2);
  assert.equal(sync.getState().moves.length, 2);

  // Stale snapshot arrives with revision 0, ply 0 (e.g. from delayed state broadcast or stale replica)
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Newer confirmed state at ply 2 must NOT be replaced by stale snapshot at ply 0
  assert.equal(sync.getState().ply, 2, 'stale snapshot must not roll back ply');
  assert.equal(sync.getState().moves.length, 2, 'stale snapshot must not erase confirmed moves');
});

test('regression: stale resumed snapshot does not reopen a terminal game', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Initial join at revision 0, ply 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1 at revision 1, ply 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });

  // Terminal ending at revision 2
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 2,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 2_000,
  });

  assert.equal(sync.getState().status?.over, true, 'game must be over');
  assert.deepEqual(sync.getState().legalMoves, {}, 'legal moves must be empty when over');

  // Stale resumed message arrives with older snapshot (revision 0, status not over)
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: { ...stateView(0, 'w', [], { e2: ['e4'] }), ready: null, stateRevision: 0 },
    missed: [],
  });

  // Terminal state must NOT be reopened
  assert.equal(sync.getState().status?.over, true, 'stale resumed snapshot must not reopen terminal game');
  assert.deepEqual(sync.getState().legalMoves, {}, 'stale resumed snapshot must not restore legal moves');
  assert.equal(sync.submitMove('e2e4'), null, 'command admission must be blocked on terminal game');
});

test('observed floor is newer than snapshot after live events (move and ready)', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Joined at revision 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });
  assert.equal(sync.stateRevision, 0);

  // Live ready event advances floor to revision 1
  factory.last.emit({
    t: 'ready',
    gameId: 'g1',
    stateRevision: 1,
    ready: { w: true, b: false },
    serverTs: 1_000,
  });
  assert.equal(sync.stateRevision, 1);
  assert.deepEqual(sync.getState().ready, { w: true, b: false });

  // Stale snapshot with revision 0 arriving after live ready must be rejected
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });
  assert.equal(sync.stateRevision, 1);
  assert.deepEqual(sync.getState().ready, { w: true, b: false }, 'readiness preserved against older snapshot');

  // Live move event advances floor to revision 2, ply 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 2_000,
    legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.stateRevision, 2);
  assert.equal(sync.getState().ply, 1);

  // Stale snapshot at revision 1 arriving after live move must be rejected
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: true, b: false }, stateRevision: 1 },
  });
  assert.equal(sync.stateRevision, 2);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().moves.length, 1);
});

test('dropping stale snapshot preserves pending move and outcomeUnknown notice', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 1 },
  });

  const pending = sync.submitMove('e2e4');
  assert.ok(pending);

  // Gateway emits outcomeUnknown for the move intent
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: pending.clientSeq,
    requestId: 'req-uncertain',
    message: 'Command outcome unknown.',
  });
  assert.deepEqual(sync.getState().pending, pending);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');

  // Stale snapshot arriving from a replica at revision 0
  // Dropping it MUST NOT clear pending move, pending action, or outcomeUnknown notice!
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Pending intent and uncertainty notice are intact
  assert.deepEqual(sync.getState().pending, pending, 'pending move must be preserved when snapshot dropped');
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'uncertainty notice must be preserved');

  // Exact confirmation receipt settles uncertainty
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'req-uncertain' });
  assert.equal(sync.getState().lastReject, null);
});

test('equal-revision joined reauthorizes connection without clearing uncertain commands or overwriting state', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1 played
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });

  // An action is submitted and outcome is uncertain
  assert.equal(sync.offerDraw(), true);
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: null,
    requestId: 'draw-req',
    action: 'offerDraw',
    message: 'Outcome unknown',
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.stateRevision, 1);

  // Connection drop
  factory.last.serverClose(1006, '', false);
  assert.equal(sync.getState().connected, false);

  // Reconnect opens socket #2
  scheduler.runNext();
  factory.last.open();
  assert.equal(sync.getState().connected, false, 'reopened socket awaits server join acknowledgment');

  // Server sends joined with EQUAL revision (stateRevision: 1)
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]), ready: null, stateRevision: 1 },
  });

  // Transport is reauthorized
  assert.equal(sync.getState().connected, true, 'equal-revision join must reauthorize connection');
  assert.equal(sync.getState().role, 'white');
  assert.equal(sync.getState().myColor, 'w');

  // But uncertain command is NOT claimed as completed
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'equal-revision join cannot settle uncertain commands');
  assert.equal(sync.stateRevision, 1);
});

test('equal-revision snapshot and duplicate live events are dropped without loops', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.stateRevision, 1);

  const sentBefore = factory.last.sent.length;

  // Duplicate move 1 broadcast with equal revision 1 arrives
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });

  // Duplicate must be dropped before ply gap logic — no resume request sent!
  assert.equal(factory.last.sent.length, sentBefore, 'duplicate move must not trigger resume broadcast loop');
  assert.equal(sync.getState().ply, 1);

  // Equal-revision state snapshot arrives
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(1, 'b', [{ ply: 1, uci: 'e2e4', san: 'e4', by: 'w' }]), ready: null, stateRevision: 1 },
  });
  assert.equal(sync.stateRevision, 1);

  // Equal-revision ended broadcast
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 1,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 2_000,
  });
  // Since floor is already 1, equal-revision ended is dropped
  assert.equal(sync.getState().status?.over, false);
});

test('newer same-ply terminal and draw transitions protect status, legalMoves, and command admission', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Initial join at revision 0, ply 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1: revision 1, ply 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });

  // Move 2: revision 2, ply 2 (black to move)
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 59_000, b: 59_000 },
    serverTs: 2_000,
    legalMoves: { g1: ['f3'] },
  });
  assert.equal(sync.getState().status?.over, false);
  assert.notDeepEqual(sync.getState().legalMoves, {});

  // At the SAME ply 2, an agreement draw occurs at revision 3
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 3,
    result: '1/2-1/2',
    termination: 'agreement',
    winner: null,
    serverTs: 3_000,
  });

  assert.equal(sync.stateRevision, 3);
  assert.deepEqual(sync.getState().status, {
    over: true,
    result: '1/2-1/2',
    termination: 'agreement',
    winner: null,
  });
  assert.deepEqual(sync.getState().legalMoves, {});
  assert.equal(sync.submitMove('g1f3'), null, 'submitMove must reject when game over');
  assert.equal(sync.offerDraw(), false, 'actions must reject when game over');
  assert.equal(sync.resign(), false, 'resign must reject when game over');

  // Stale snapshot arrives at ply 2 with revision 2 (before the draw was agreed)
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: {
      ...stateView(2, 'w', [
        { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
        { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
      ], { g1: ['f3'] }),
      ready: null,
      stateRevision: 2,
    },
  });

  // Terminal status, result, legalMoves, and command admission are completely protected!
  const finalStatus = sync.getState().status;
  assert.ok(finalStatus && finalStatus.over);
  assert.equal(finalStatus.result, '1/2-1/2');
  assert.deepEqual(sync.getState().legalMoves, {});
  assert.equal(sync.submitMove('g1f3'), null);
});

test('stale ended, move, and ready broadcasts are dropped and never trigger loops', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Joined at revision 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });

  // Advances to revision 5 through live events
  factory.last.emit({ t: 'ready', gameId: 'g1', stateRevision: 1, ready: { w: true, b: false }, serverTs: 1 });
  factory.last.emit({ t: 'ready', gameId: 'g1', stateRevision: 2, ready: { w: true, b: true }, serverTs: 2 });
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 3, ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 3, legalMoves: { e7: ['e5'] },
  });
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 4, ply: 2, uci: 'e7e5', san: 'e5',
    by: 'b', fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 4, legalMoves: { g1: ['f3'] },
  });
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 5, ply: 3, uci: 'g1f3', san: 'Nf3',
    by: 'w', fenHash: 'h3', clock: { w: 58_000, b: 59_000 }, serverTs: 5, legalMoves: { b8: ['c6'] },
  });
  assert.equal(sync.stateRevision, 5);
  assert.equal(sync.getState().ply, 3);

  const sentCount = factory.last.sent.length;

  // Stale move broadcast arrives with revision 2 (ply 1)
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 2, ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 3, legalMoves: {},
  });
  assert.equal(factory.last.sent.length, sentCount, 'stale move must not trigger resume loop');
  assert.equal(sync.getState().ply, 3);

  // Stale ready broadcast arrives with revision 1
  factory.last.emit({ t: 'ready', gameId: 'g1', stateRevision: 1, ready: { w: false, b: false }, serverTs: 1 });
  assert.deepEqual(sync.getState().ready, { w: true, b: true }, 'stale ready broadcast must not regress readiness');

  // Stale ended broadcast arrives with revision 4
  factory.last.emit({
    t: 'ended', gameId: 'g1', stateRevision: 4, result: '0-1', termination: 'timeout', winner: 'b', serverTs: 4,
  });
  assert.equal(sync.getState().status?.over, false, 'stale ended broadcast must not end game prematurely');
});

test('reconnect with stale join snapshot preserves known floor and state while reauthorizing', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();

  // Joined at revision 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1 at revision 1, ply 1
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 1, ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1_000, legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);

  // Connection dropped unexpectedly
  factory.last.serverClose(1006, '', false);
  assert.equal(sync.getState().connected, false);

  // Reconnect opens socket #2
  scheduler.runNext();
  factory.last.open();

  // Server replies to join with a stale cached snapshot at revision 0, ply 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Reauthorization succeeded
  assert.equal(sync.getState().connected, true, 'connection must be reauthorized');
  assert.equal(sync.getState().role, 'white');
  assert.equal(sync.getState().myColor, 'w');

  // Stale snapshot was rejected: known state is preserved!
  assert.equal(sync.stateRevision, 1, 'observed floor must remain at 1');
  assert.equal(sync.getState().ply, 1, 'ply must remain at 1');
  assert.equal(sync.getState().moves.length, 1, 'moves must remain at 1');
});

test('genuine reconnect preserves floor, pending move, and uncertainty notice across socket drop', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Advance to revision 1 with confirmed move
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });

  // Advance to revision 2 with Black's move
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 59_000, b: 59_000 },
    serverTs: 2_000,
    legalMoves: { g1: ['f3'] },
  });
  assert.equal(sync.stateRevision, 2);
  assert.equal(sync.getState().ply, 2);
  assert.equal(sync.getState().turn, 'w');

  // Submit a pending move and receive an outcomeUnknown notice
  const pending = sync.submitMove('g1f3');
  assert.ok(pending);
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: pending.clientSeq,
    requestId: 'req-reconnect-uncertain',
    message: 'Unknown move outcome.',
  });
  assert.deepEqual(sync.getState().pending, pending);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');

  // Genuine socket drop (e.g. 1006 abnormal closure)
  factory.last.serverClose(1006, '', false);
  assert.equal(sync.getState().connected, false);

  // Scheduler advances and reconnects socket #2
  scheduler.runNext();
  factory.last.open();

  // Reconnected socket delivers join response with stale cached snapshot at revision 1
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(1, 'b'), ready: null, stateRevision: 1 },
  });

  // Authorization is re-established
  assert.equal(sync.getState().connected, true, 'connection must be reauthorized on reconnect');
  assert.equal(sync.getState().role, 'white');
  assert.equal(sync.getState().myColor, 'w');

  // Revision floor, state, pending move, and uncertainty notice are all preserved!
  assert.equal(sync.stateRevision, 2, 'revision floor must be preserved across reconnect');
  assert.equal(sync.getState().ply, 2, 'ply must remain at 2');
  assert.deepEqual(sync.getState().pending, pending, 'pending move must be preserved across stale join snapshot');
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'uncertainty notice must remain visible');

  // Exact confirmation receipt settles the uncertainty without resending or claiming unproved state
  factory.last.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'req-reconnect-uncertain' });
  assert.equal(sync.getState().lastReject, null, 'exact receipt clears uncertainty notice');
});

test('pure legacy gateway behavior remains fully functional without revisions', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // All-legacy gateway emits frames without stateRevision
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: stateView(0, 'w'),
  });
  assert.equal(sync.stateRevision, null, 'stateRevisionFloor must be null for pure legacy');
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.getState().ply, 0);

  // Legacy move applies
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1_000, legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.getState().ply, 1);

  // Duplicate legacy move is dropped before ply gap
  const sentCount = factory.last.sent.length;
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1_000, legalMoves: { e7: ['e5'] },
  });
  assert.equal(factory.last.sent.length, sentCount, 'duplicate legacy move does not loop');

  // Legacy gap triggers resume
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 3, uci: 'g1f3', san: 'Nf3',
    by: 'w', fenHash: 'h3', clock: { w: 58_000, b: 59_000 }, serverTs: 2_000, legalMoves: {},
  });
  assert.equal(factory.last.sent.length, sentCount + 1, 'gap triggers resume');
  assert.deepEqual(JSON.parse(factory.last.sent.at(-1)!), { t: 'resume', gameId: 'g1', lastPly: 1 });

  // Legacy ended ends game
  factory.last.emit({
    t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 3_000,
  });
  assert.equal(sync.getState().status?.over, true);
});

test('revisioned to legacy mixed frames: failclosed policy rejects un-stamped frames once revisioned state observed', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  // Joined with revisioned state
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  assert.equal(sync.stateRevision, 0);

  // Move 1 with revision 1, ply 1
  factory.last.emit({
    t: 'move', gameId: 'g1', stateRevision: 1, ply: 1, uci: 'e2e4', san: 'e4',
    by: 'w', fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1_000, legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);

  // Now, un-stamped (legacy) frames arrive from an old proxy or downgraded server
  // 1. Un-stamped move: FAILCLOSED (dropped)
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 2, uci: 'e7e5', san: 'e5',
    by: 'b', fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2_000, legalMoves: {},
  });
  assert.equal(sync.getState().ply, 1, 'un-stamped move must be rejected in revisioned mode');

  // 2. Un-stamped ready: merges readiness monotonically (safe under R-03) without altering revision floor
  factory.last.emit({ t: 'ready', gameId: 'g1', ready: { w: true, b: true }, serverTs: 2_000 });
  assert.deepEqual(sync.getState().ready, { w: true, b: true }, 'monotonic readiness is merged');
  assert.equal(sync.stateRevision, 1, 'un-stamped ready must not alter revision floor');

  // 3. Un-stamped ended: FAILCLOSED (dropped)
  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'resignation', winner: 'w', serverTs: 2_000 });
  assert.equal(sync.getState().status?.over, false, 'un-stamped ended must be rejected in revisioned mode');

  // 4. Un-stamped state snapshot: FAILCLOSED (dropped)
  factory.last.emit({
    t: 'state', gameId: 'g1', state: stateView(2, 'w'),
  });
  assert.equal(sync.getState().ply, 1, 'un-stamped state snapshot must be rejected in revisioned mode');

  // 5. Un-stamped resumed snapshot: FAILCLOSED (dropped)
  factory.last.emit({
    t: 'resumed', gameId: 'g1', state: stateView(2, 'w'), missed: [],
  });
  assert.equal(sync.getState().ply, 1, 'un-stamped resumed snapshot must be rejected in revisioned mode');

  // 6. Un-stamped joined: preserves authorization/role but rejects data snapshot
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'black', state: stateView(0, 'w'),
  });
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.getState().role, 'black', 'role updated from joined authorization');
  assert.equal(sync.getState().myColor, 'b', 'color updated from joined authorization');
  assert.equal(sync.getState().ply, 1, 'un-stamped data snapshot must not roll back state');
  assert.equal(sync.stateRevision, 1, 'ordering floor never downgraded');
});

test('isStateRevision type guard correctly validates bounds and numeric types without as any', () => {
  for (const valid of [0, 1, 100, 2_147_483_647]) {
    assert.equal(isStateRevision(valid), true);
  }
  for (const invalid of [-1, 0.5, '1', null, undefined, {}, [], 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isStateRevision(invalid), false);
  }
});

test('regression Qodo 1: terminal broadcast with revision gap triggers recovery query and restores history on equal snapshot', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  // Move 1 at revision 1, ply 1
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: { e7: ['e5'] },
  });
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.stateRevision, 1);

  const sentBefore = factory.last.sent.length;

  // Terminal broadcast arrives at revision 3 (gap: 3 > 1 + 1, missed move 2)
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 3,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 3_000,
  });

  assert.equal(sync.getState().status?.over, true, 'game is marked over');
  assert.equal(sync.stateRevision, 3, 'floor advanced to terminal revision');

  // Verify bounded read-only recovery query was sent for the missing position
  const recoveryRequests = factory.last.sent.slice(sentBefore)
    .map((frame) => JSON.parse(frame) as { t: string; lastPly?: number })
    .filter((msg) => msg.t === 'resume');
  assert.equal(recoveryRequests.length, 1, 'exactly one resume request sent for positional gap');
  assert.equal(recoveryRequests[0]!.lastPly, 1, 'resume asks for history starting at observed ply 1');

  // Out-of-order move 2 arrives at revision 2, ply 2 after terminal broadcast
  const sentAfterEnded = factory.last.sent.length;
  factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 2,
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    by: 'b',
    fenHash: 'h2',
    clock: { w: 59_000, b: 59_000 },
    serverTs: 2_000,
    legalMoves: {},
  });

  // Late move must NOT reopen game, must NOT create loop, and must NOT change terminal status
  assert.equal(sync.getState().status?.over, true);
  assert.equal(factory.last.sent.length, sentAfterEnded, 'late move does not trigger additional resume loop');

  // Duplicate ended broadcast at revision 3 must be dropped without sending resume
  factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 3,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 3_000,
  });
  assert.equal(factory.last.sent.length, sentAfterEnded, 'duplicate ended does not trigger resume loop');

  // Server responds to resume with complete equal-head terminal snapshot at revision 3, ply 2
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: {
      ...stateView(2, 'w', [
        { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
        { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
      ]),
      status: { over: true, result: '1-0', termination: 'resignation', winner: 'w' },
      ready: null,
      stateRevision: 3,
    },
    missed: [],
  });

  // Equal-head terminal snapshot restores missing positional history
  assert.equal(sync.getState().ply, 2, 'ply restored to 2');
  assert.equal(sync.getState().moves.length, 2, 'moves restored');
  assert.equal(sync.getState().status?.over, true, 'terminal status preserved');
  assert.equal(factory.last.sent.length, sentAfterEnded, 'no loop on equal terminal snapshot');

  // Healthy ending control: revision 2 immediately follows revision 1 with no gap -> no resume sent
  const healthySetup = setup();
  healthySetup.sync.start();
  healthySetup.factory.last.open();
  healthySetup.factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  healthySetup.factory.last.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 1,
    ply: 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'h1',
    clock: { w: 59_000, b: 60_000 },
    serverTs: 1_000,
    legalMoves: {},
  });
  const healthySentBefore = healthySetup.factory.last.sent.length;
  healthySetup.factory.last.emit({
    t: 'ended',
    gameId: 'g1',
    stateRevision: 2,
    result: '1-0',
    termination: 'resignation',
    winner: 'w',
    serverTs: 2_000,
  });
  assert.equal(healthySetup.sync.getState().status?.over, true);
  assert.equal(healthySetup.factory.last.sent.length, healthySentBefore, 'healthy ending without gap sends no resume');
});

test('regression Qodo 2: equal-head snapshot reconciles original-seat readiness uncertainty', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });

  // Live ready arrives at revision 1
  factory.last.emit({
    t: 'ready',
    gameId: 'g1',
    stateRevision: 1,
    ready: { w: true, b: false },
    serverTs: 1_000,
  });
  assert.equal(sync.getState().ready?.w, true);
  assert.equal(sync.stateRevision, 1);

  // Late outcomeUnknown for the ready command arrives
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: null,
    requestId: 'ready-req-late',
    action: 'ready',
    readyColor: 'w',
    message: 'Unknown readiness.',
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');

  // Equal-revision snapshot confirms original-seat ready is true
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: true, b: false }, stateRevision: 1 },
  });
  assert.equal(sync.getState().lastReject, null, 'confirmed original-seat readiness resolves uncertainty notice');

  // Negative control 1: move uncertainty is NOT settled by equal snapshot
  const pending = sync.submitMove('e2e4');
  assert.ok(pending);
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: pending.clientSeq,
    requestId: 'move-uncertain-req',
    message: 'Unknown move.',
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');

  // Equal snapshot arrives
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: true, b: false }, stateRevision: 1 },
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'position snapshot alone must never settle move uncertainty');

  // Negative control 2: refusal received during uncertainty is preserved across equal snapshot
  factory.last.emit({
    t: 'reject',
    gameId: 'g1',
    ref: pending.clientSeq,
    code: 'illegal_move',
    message: 'Illegal move attempted.',
  });
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: true, b: false }, stateRevision: 1 },
  });
  assert.ok(sync.getState().lastReject?.message.includes('Illegal move attempted.'), 'refusal during uncertainty must be preserved');
});

test('regression Qodo 3: equal-head snapshot preserves monotonic readiness from unstamped or earlier ready', () => {
  const { factory, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });

  // Supported un-stamped ready broadcast sets white ready to true
  factory.last.emit({
    t: 'ready',
    gameId: 'g1',
    ready: { w: true, b: false },
    serverTs: 1_000,
  });
  assert.equal(sync.getState().ready?.w, true);

  // Equal snapshot with ready: { w: false, b: false } arrives (delayed or un-updated cache)
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
  });
  assert.equal(sync.getState().ready?.w, true, 'monotonic readiness must survive equal snapshot');

  // Also test resumed equal snapshot preserves readiness
  factory.last.emit({
    t: 'resumed',
    gameId: 'g1',
    state: { ...stateView(0, 'w'), ready: { w: false, b: false }, stateRevision: 0 },
    missed: [],
  });
  assert.equal(sync.getState().ready?.w, true, 'monotonic readiness must survive resumed equal snapshot');

  // Absent ready field in snapshot (legacy gateway) preserves known readiness
  factory.last.emit({
    t: 'state',
    gameId: 'g1',
    state: stateView(0, 'w'), // ready field is undefined
  });
  assert.equal(sync.getState().ready?.w, true, 'absent ready in snapshot preserves known state');
});

test('regression Greptile P2: equal-head reconnect clears ordinary command error while preserving uncertainty', () => {
  const { factory, scheduler, sync } = setup();
  sync.start();
  factory.last.open();

  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });

  const pending = sync.submitMove('e2e4');
  assert.ok(pending);

  // Server rejects with ordinary command error
  factory.last.emit({
    t: 'reject',
    gameId: 'g1',
    ref: pending.clientSeq,
    code: 'illegal_move',
    message: 'Bad move.',
  });
  assert.equal(sync.getState().lastReject?.t, 'reject');
  assert.equal(sync.getState().lastReject?.code, 'illegal_move');

  // Socket drop and reconnect
  factory.last.serverClose(1006, '', false);
  assert.equal(sync.getState().connected, false);

  scheduler.runNext();
  factory.last.open();

  // Reconnect delivers joined at equal revision 0
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.getState().lastReject, null, 'successful same-head reconnect clears ordinary obsolete error');

  // Control: equal-head reconnect with active outcomeUnknown preserves uncertainty notice
  const pending2 = sync.submitMove('d2d4');
  assert.ok(pending2);
  factory.last.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: pending2.clientSeq,
    requestId: 'req-reconnect-unc',
    message: 'Command outcome unknown.',
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');

  factory.last.serverClose(1006, '', false);
  scheduler.runNext();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown', 'unresolved outcomeUnknown preserved across reconnect');

  // Control: refusal received during uncertainty is preserved across reconnect
  factory.last.emit({
    t: 'reject',
    gameId: 'g1',
    ref: null,
    code: 'invalid_command',
    message: 'Cannot move while uncertain.',
  });
  factory.last.serverClose(1006, '', false);
  scheduler.runNext();
  factory.last.open();
  factory.last.emit({
    t: 'joined',
    gameId: 'g1',
    role: 'white',
    state: { ...stateView(0, 'w'), ready: null, stateRevision: 0 },
  });
  assert.ok(sync.getState().lastReject?.message.includes('Cannot move while uncertain.'), 'refusal received during uncertainty preserved across reconnect');
});
