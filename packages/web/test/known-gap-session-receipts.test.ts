import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import { SessionManager } from '../src/net/session.js';
import type { StateView } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { adoptGameSession } from './support/game-session.js';

interface LedgerEntry {
  ply: number;
  uci: string;
  san: string;
  by: 'w' | 'b';
}

interface OutgoingPayload {
  t?: string;
  gameId?: string;
  requestId?: string;
  clientSeq?: number;
  uci?: string;
}

const FEN0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const FEN2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FEN3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

const fullLedger: LedgerEntry[] = [
  { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
  { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
  { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w' },
];

function createStateView(
  ply: number,
  fen: string,
  turn: 'w' | 'b',
  legalMoves: Record<string, string[]>,
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: 'h' + ply,
    ply,
    turn,
    clock: { w: 60000, b: 60000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves: fullLedger.slice(0, ply),
    legalMoves,
    chess960StartId: null,
    ready: { w: true, b: true },
    stateRevision: ply,
  };
}

function parseOutgoing(raw: string): OutgoingPayload {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return parsed as OutgoingPayload;
}

function countResumeFrames(socket: { sent: string[] }): number {
  return socket.sent.filter((raw) => parseOutgoing(raw).t === 'resume').length;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

test('known-gap recovery preserves command uncertainty across insufficient/full snapshots until explicit receipt while retaining separate refusal', async (t) => {
  const scheduler = new ManualScheduler();
  const factory = new FakeSocketFactory();
  const client = new WsClient({
    url: 'ws://localhost',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, {
    gameId: 'g1',
    token: 'u1-token',
    scheduler,
  });

  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  const socket1 = factory.sockets[0];
  assert.ok(socket1);
  socket1.open();
  await flushMicrotasks();

  const state0 = createStateView(0, FEN0, 'w', { e2: ['e4'] });
  socket1.emit({ t: 'joined', gameId: 'g1', role: 'white', state: state0 });

  assert.equal(sync.getState().ply, 0);
  assert.equal(sync.getState().role, 'white');
  assert.equal(sync.getState().myColor, 'w');
  assert.equal(sync.getState().lastReject, null);

  const pending = sync.submitMove('e2e4');
  assert.ok(pending);

  const moveFrameRaw = socket1.sent.find((raw) => parseOutgoing(raw).t === 'move');
  assert.ok(moveFrameRaw);
  const sentMove = parseOutgoing(moveFrameRaw);
  assert.equal(sentMove.uci, 'e2e4');
  assert.equal(sentMove.clientSeq, pending.clientSeq);

  socket1.emit({
    t: 'outcomeUnknown',
    code: 'outcome_unknown',
    gameId: 'g1',
    ref: pending.clientSeq,
    requestId: 'old-move',
    message: 'Unknown.',
  });

  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().lastReject?.code, 'outcome_unknown');
  assert.equal(sync.getState().lastReject?.message, 'Unknown.');

  socket1.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60000, b: 60000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: { b8: ['c6'] },
  });

  assert.equal(sync.getState().recovering, true);

  const insufficientState = createStateView(1, FEN1, 'b', { e7: ['e5'] });
  socket1.emit({ t: 'resumed', gameId: 'g1', state: insufficientState, missed: [] });

  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().lastReject?.code, 'outcome_unknown');
  assert.equal(sync.getState().lastReject?.message, 'Unknown.');

  const fullState = createStateView(3, FEN3, 'b', { b8: ['c6'] });
  socket1.emit({ t: 'resumed', gameId: 'g1', state: fullState, missed: [] });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().lastReject?.code, 'outcome_unknown');
  assert.equal(sync.getState().lastReject?.message, 'Unknown.');

  socket1.emit({
    t: 'reject',
    gameId: 'g1',
    ref: null,
    code: 'invalid_command',
    message: 'Separate refusal.',
  });

  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().lastReject?.code, 'outcome_unknown');
  assert.ok(sync.getState().lastReject?.message.includes('Unknown.'));
  assert.ok(sync.getState().lastReject?.message.includes('Separate refusal.'));

  socket1.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'wrong-id' });

  assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
  assert.equal(sync.getState().lastReject?.code, 'outcome_unknown');
  assert.ok(sync.getState().lastReject?.message.includes('Unknown.'));
  assert.ok(sync.getState().lastReject?.message.includes('Separate refusal.'));

  socket1.emit({ t: 'commandConfirmed', gameId: 'g1', requestId: 'old-move' });

  assert.equal(sync.getState().lastReject?.t, 'reject');
  assert.equal(sync.getState().lastReject?.code, 'invalid_command');
  assert.equal(sync.getState().lastReject?.message, 'Separate refusal.');

  const moveFrames = socket1.sent.filter((raw) => parseOutgoing(raw).t === 'move');
  assert.equal(moveFrames.length, 1);

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.stateRevision, 3);
  assert.deepEqual(sync.getState().moves, fullLedger.slice(0, 3));
  assert.equal(sync.getState().snapshot?.fen, FEN3);
  assert.equal(sync.getState().fenHash, 'h3');
  assert.equal(sync.getState().turn, 'b');
  assert.deepEqual(sync.getState().status, { over: false });
  assert.deepEqual(sync.getState().snapshot?.legalMoves, { b8: ['c6'] });
  assert.deepEqual(sync.getState().ready, { w: true, b: true });
});

test('session switch during recovery retains floor and budget across reconnect until exhaustion and manual networkOnline', async (t) => {
  const scheduler = new ManualScheduler();
  const factory = new FakeSocketFactory();
  const client = new WsClient({
    url: 'ws://localhost',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const session = new SessionManager({
    refresh: async (): Promise<never> => {
      throw new Error('Unexpected refresh');
    },
    now: () => 0,
    channel: null,
    barrierStorage: null,
  });

  adoptGameSession(session, 'token-1', 'u1');

  const sync = new GameSync(client, {
    gameId: 'g1',
    session,
    scheduler,
  });

  t.after(() => {
    sync.stop();
    client.close();
  });

  sync.start();
  const socket1 = factory.sockets[0];
  assert.ok(socket1);
  socket1.open();
  await flushMicrotasks();

  const prefix1 = createStateView(1, FEN1, 'b', { e7: ['e5'] });
  socket1.emit({ t: 'joined', gameId: 'g1', role: 'white', state: prefix1 });

  assert.equal(sync.getState().role, 'white');
  assert.equal(sync.getState().myColor, 'w');
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().snapshot?.fen, FEN1);
  assert.equal(sync.getState().fenHash, 'h1');
  assert.deepEqual(sync.getState().moves, fullLedger.slice(0, 1));

  socket1.emit({
    t: 'move',
    gameId: 'g1',
    stateRevision: 3,
    ply: 3,
    uci: 'g1f3',
    san: 'Nf3',
    by: 'w',
    clock: { w: 60000, b: 60000 },
    serverTs: 0,
    fenHash: 'h3',
    legalMoves: { b8: ['c6'] },
  });

  assert.equal(sync.getState().recovering, true);
  assert.equal(countResumeFrames(socket1), 1);

  adoptGameSession(session, 'new-token', 'u2');
  sync.sessionChanged('u2');

  assert.equal(sync.getState().role, null);
  assert.equal(sync.getState().myColor, null);
  assert.equal(sync.submitMove('e2e4'), null);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().snapshot?.gameId, 'g1');
  assert.equal(sync.getState().snapshot?.fen, FEN1);
  assert.equal(sync.getState().fenHash, 'h1');
  assert.deepEqual(sync.getState().moves, fullLedger.slice(0, 1));

  assert.equal(factory.sockets.length, 2);
  const socket2 = factory.sockets[1];
  assert.ok(socket2);
  socket2.open();
  await flushMicrotasks();

  const staleState0 = createStateView(0, FEN0, 'w', { e2: ['e4'] });
  socket2.emit({ t: 'joined', gameId: 'g1', role: 'black', state: staleState0 });

  assert.equal(sync.getState().role, 'black');
  assert.equal(sync.getState().myColor, 'b');
  assert.equal(sync.getState().connected, true);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);
  assert.equal(sync.getState().snapshot?.fen, FEN1);
  assert.equal(sync.getState().fenHash, 'h1');
  assert.deepEqual(sync.getState().moves, fullLedger.slice(0, 1));

  assert.equal(countResumeFrames(socket1), 1);
  assert.equal(countResumeFrames(socket2), 1);
  assert.equal(sync.getState().recovering, true);

  scheduler.runNext();
  assert.equal(scheduler.nextDelayMs, 2000);
  scheduler.runNext();
  scheduler.runNext();

  const attempts1 = countResumeFrames(socket1);
  const attempts2 = countResumeFrames(socket2);
  assert.equal(attempts1 + attempts2, 3);
  assert.equal(scheduler.pending, 0);
  assert.equal(sync.getState().recovering, true);
  assert.equal(sync.getState().recoveryAvailable, true);
  assert.equal(sync.stateRevision, 1);
  assert.equal(sync.getState().ply, 1);

  sync.networkOnline();

  assert.equal(sync.getState().recovering, true);
  assert.equal(countResumeFrames(socket1) + countResumeFrames(socket2), 4);

  const fullState = createStateView(3, FEN3, 'b', { b8: ['c6'] });
  socket2.emit({ t: 'resumed', gameId: 'g1', state: fullState, missed: [] });

  assert.equal(sync.getState().recovering, false);
  assert.equal(sync.getState().recoveryAvailable, false);
  assert.equal(sync.getState().ply, 3);
  assert.equal(sync.stateRevision, 3);
  assert.equal(sync.getState().snapshot?.fen, FEN3);
  assert.equal(sync.getState().fenHash, 'h3');
  assert.equal(sync.getState().turn, 'b');
  assert.deepEqual(sync.getState().moves, fullLedger.slice(0, 3));
  assert.deepEqual(sync.getState().snapshot?.legalMoves, { b8: ['c6'] });
  assert.deepEqual(sync.getState().ready, { w: true, b: true });
});