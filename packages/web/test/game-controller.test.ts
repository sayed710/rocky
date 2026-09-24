import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { GameController } from '../src/app/game-controller.js';
import type { StateView, WsColor } from '../src/net/ws-protocol.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';
import { ENGINE_BOT_USER_IDS } from '@chess-platform/game';

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
  const positions: string[] = [];
  const turns: boolean[] = [];
  const clocks: Array<[number, number]> = [];
  const statuses: string[] = [];
  const colors: Array<WsColor | null> = [];
  const metadatas: Array<any> = [];
  const controller = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: (fen) => positions.push(fen),
      onTurn: (myTurn) => turns.push(myTurn),
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: (text) => statuses.push(text),
      onColor: (color) => colors.push(color),
      onMetadata: (metadata) => metadatas.push(metadata),
    },
  });
  return { factory, scheduler, client, sync, controller, positions, turns, clocks, statuses, colors, metadatas };
}

function stateView(
  ply: number,
  turn: WsColor,
  fen: string,
  moves: StateView['moves'] = [],
): StateView {
  return {
    gameId: 'g1',
    variant: 'standard',
    players: { white: 'u1', black: 'u2' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen,
    fenHash: `h${ply}`,
    ply,
    turn,
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves,
    legalMoves: {},
    chess960StartId: null,
  };
}

test('start emits current (pre-join) state — empty position, waiting status', () => {
  const { controller, positions, turns, clocks, statuses } = setup();
  controller.start();
  // No snapshot yet — no position emitted.
  assert.equal(positions.length, 0);
  // Turn is null → myTurn = false.
  assert.deepEqual(turns, [false]);
  // No clock yet.
  assert.equal(clocks.length, 0);
  // Status should be "Waiting…"
  assert.equal(statuses.at(-1), 'Waiting…');
  controller.stop();
});

test('snapshot populates position, turn, clock, and status', () => {
  const { factory, sync, controller, positions, turns, clocks, statuses } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(0, 'w', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });
  assert.equal(positions.at(-1), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(turns.at(-1), true); // white to move, we are white
  assert.deepEqual(clocks.at(-1), [60_000, 60_000]);
  assert.equal(statuses.at(-1), 'Your move');
  controller.stop();
  sync.stop();
});

test('move broadcast replays on top of snapshot FEN', () => {
  const { factory, sync, controller, positions } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', startFen) });

  // White plays e4 (UCI: e2e4)
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });

  // The FEN after 1.e4 should have the e-pawn on the 4th rank.
  const lastFen = positions.at(-1)!;
  const placement = lastFen.split(' ')[0]!;
  const ranks = placement.split('/');
  const rank4 = ranks[4]!; // 5th element (rank 4, 0-indexed from rank 8)
  assert.ok(rank4.includes('P'), `Rank 4 should contain a white pawn: ${rank4}`);
  // Turn should now be black — not our turn.
  controller.stop();
  sync.stop();
});

test('opponent move updates position and switches turn to our side', () => {
  const { factory, sync, controller, positions, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', startFen) });

  // White plays e4
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });

  // Black plays e5 (UCI: e7e5)
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2,
  legalMoves: {},
  });

  const lastFen = positions.at(-1)!;
  const placement = lastFen.split(' ')[0]!;
  const ranks = placement.split('/');
  // After 1.e4 e5: white pawn on rank 4, black pawn on rank 5 (index 3)
  const rank5 = ranks[3]!;
  assert.ok(rank5.includes('p'), `Rank 5 should contain a black pawn: ${rank5}`);
  // After black's move, it's white's turn again — our turn.
  assert.deepEqual(turns.at(-1), true);
  controller.stop();
  sync.stop();
});

test('game ended emits checkmate status', () => {
  const { factory, sync, controller, statuses } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  factory.last.emit({
    t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 5,
  });
  assert.equal(statuses.at(-1), 'Checkmate — White wins (1-0)');
  controller.stop();
  sync.stop();
});

test('submitMove forwards to GameSync', () => {
  const { factory, sync, controller } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });

  const pending = controller.submitMove('e2e4');
  assert.deepEqual(pending, { uci: 'e2e4', clientSeq: 1 });
  // Verify the move was sent over the socket.
  const sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.deepEqual(sent, { t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
  controller.stop();
  sync.stop();
});

test('spectator (myColor=null) gets "White to move" not "Your move"', () => {
  const { factory, sync, controller, statuses } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: stateView(0, 'w', 'startpos') });
  assert.equal(statuses.at(-1), 'White to move');
  controller.stop();
  sync.stop();
});

test('stop unsubscribes — no further callbacks after stop', () => {
  const { factory, sync, controller, positions } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  const countBefore = positions.length;
  controller.stop();
  // Emit another state change — should NOT produce a callback.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });
  assert.equal(positions.length, countBefore, 'no callbacks after stop');
  sync.stop();
});

test('fen getter returns the last projected FEN', () => {
  const { factory, sync, controller } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', fen) });
  assert.equal(controller.fen, fen);
  controller.stop();
  sync.stop();
});

test('onLastMove callback fires with from/to after a move broadcast', () => {
  const { factory, sync, controller } = setup();
  const lastMoves: Array<[string | null, string | null]> = [];
  // Replace callbacks to capture onLastMove
  controller.stop();
  const controller2 = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: () => {},
      onLastMove: (from, to) => lastMoves.push([from, to]),
    },
  });
  controller2.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(0, 'w', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });
  // No moves yet — onLastMove should fire with null, null
  assert.deepEqual(lastMoves.at(-1), [null, null]);

  // White plays e4
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });
  assert.deepEqual(lastMoves.at(-1), ['e2', 'e4']);

  // Black plays e5
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 2, uci: 'e7e5', san: 'e5', by: 'b',
    fenHash: 'h2', clock: { w: 59_000, b: 59_000 }, serverTs: 2,
  legalMoves: {},
  });
  assert.deepEqual(lastMoves.at(-1), ['e7', 'e5']);

  controller2.stop();
  sync.stop();
});

test('onLastMove is optional — controller works without it', () => {
  const { factory, sync, controller, positions } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(0, 'w', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  });
  // Should not throw even though onLastMove is not provided.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
  legalMoves: {},
  });
  assert.ok(positions.length > 0);
  controller.stop();
  sync.stop();
});

// ── C2: mid-game join does not double-apply pre-snapshot moves ─────────────

test('C2: joining mid-game replays only post-snapshot moves (no double-apply)', () => {
  const { factory, sync, controller, positions } = setup();
  controller.start();
  sync.start();
  factory.last.open();

  // Simulate joining a game at ply 2. The snapshot already has 2 moves applied
  // (1.e4 e5), with the correct FEN at ply 2. A ply-3 live broadcast follows.
  const snapshotFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const snapshotMoves: StateView['moves'] = [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w' },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b' },
  ];
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(2, 'w', snapshotFen, snapshotMoves),
  });

  // The position should be the snapshot FEN (no replay needed — moves are
  // pre-snapshot). Verify we got the correct position.
  assert.equal(positions.at(-1), snapshotFen);

  // Now a live ply-3 broadcast arrives: White plays Nf3.
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w',
    fenHash: 'h3', clock: { w: 59_000, b: 59_000 }, serverTs: 3,
    legalMoves: {},
  });

  // The projected FEN should be the snapshot + Nf3, NOT snapshot + e4 + e5 + Nf3.
  // If the bug were present, e4 and e5 would be re-applied on top of the snapshot
  // that already contains them, corrupting the position.
  const lastFen = positions.at(-1)!;
  const placement = lastFen.split(' ')[0]!;
  const ranks = placement.split('/');

  // After 1.e4 e5 2.Nf3, the knight should be on f3 (rank 3, index 5).
  const rank3 = ranks[5]!;
  assert.ok(rank3.includes('N'), `Rank 3 should contain a white knight: ${rank3}`);

  // The e-pawns should still be on e4 and e5 (not doubled or missing).
  const rank4 = ranks[4]!;
  assert.ok(rank4.includes('P'), `Rank 4 should contain the white e-pawn: ${rank4}`);
  const rank5 = ranks[3]!;
  assert.ok(rank5.includes('p'), `Rank 5 should contain the black e-pawn: ${rank5}`);

  // g1 should no longer have a knight (it moved to f3).
  // The starting position has 2 knights (b1 and g1); after Nf3, one is on f3
  // and one is still on b1 — so still 2 knights total, but g1 is empty.
  // Verify the knight is on f3 by checking rank 3.
  const rank3AfterNf3 = ranks[5]!;
  assert.ok(rank3AfterNf3.includes('N'), `Rank 3 should contain a white knight (Nf3): ${rank3AfterNf3}`);

  controller.stop();
  sync.stop();
});

// ── M2: promotion is propagated through the projection ────────────────────

test('M2: promotion move broadcasts render the promoted piece', () => {
  const { factory, sync, controller, positions } = setup();
  controller.start();
  sync.start();
  factory.last.open();

  // Use a position where a promotion is imminent: White pawn on e7, Black king on e8 area.
  // FEN: White pawn on e7, Black to move but we'll set up White to move for simplicity.
  // Actually, let's use a simpler setup: snapshot at a position where White has a pawn on a7.
  const prePromoFen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'white',
    state: stateView(0, 'w', prePromoFen, []),
  });

  // White promotes a7-a8 to queen (UCI: a7a8q).
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'a7a8q', san: 'a8=Q', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1,
    legalMoves: {},
  });

  const lastFen = positions.at(-1)!;
  const placement = lastFen.split(' ')[0]!;
  const ranks = placement.split('/');

  // After promotion, rank 8 (index 0) should contain a white queen 'Q'.
  const rank8 = ranks[0]!;
  assert.ok(rank8.includes('Q'), `Rank 8 should contain a promoted white queen: ${rank8}`);

  // The pawn should no longer be on a7 (rank 7, index 1).
  const rank7 = ranks[1]!;
  assert.ok(!rank7.includes('P'), `Rank 7 should NOT contain a white pawn: ${rank7}`);

  controller.stop();
  sync.stop();
});

// ── C3: controller derives color/turn from GameSyncState (no myColor option) ─

test('C3: onColor is emitted with the resolved color from the joined message', () => {
  const { factory, sync, controller, colors } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  assert.deepEqual(colors, ['w'], 'onColor should be called with "w" for white role');
  controller.stop();
  sync.stop();
});

test('C3: onColor emits null for spectators', () => {
  const { factory, sync, controller, colors } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: stateView(0, 'w', 'startpos') });
  assert.deepEqual(colors, [null], 'onColor should be called with null for spectator');
  controller.stop();
  sync.stop();
});

test('C3: onColor is emitted only once', () => {
  const { factory, sync, controller, colors } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });
  assert.equal(colors.length, 1, 'onColor should fire only once');
  controller.stop();
  sync.stop();
});

test('C3: myTurn is false before join (no color resolved yet)', () => {
  const { controller, turns } = setup();
  controller.start();
  // Pre-join: turn is null, myColor is null → myTurn = false.
  assert.deepEqual(turns, [false]);
  controller.stop();
});

test('C3: myTurn is true only after joined resolves myColor and it is our turn', () => {
  const { factory, sync, controller, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  // Join as white, white to move → myTurn = true.
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  assert.deepEqual(turns.at(-1), true, 'should be our turn after joining as white');
  controller.stop();
  sync.stop();
});

test('C3: myTurn is false when joined as black and white is to move', () => {
  const { factory, sync, controller, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  // Join as black, white to move → myTurn = false.
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'black', state: stateView(0, 'w', 'startpos') });
  assert.deepEqual(turns.at(-1), false, 'should not be our turn when white is to move and we are black');
  controller.stop();
  sync.stop();
});

test('C3: myTurn is false for spectators even when a side is to move', () => {
  const { factory, sync, controller, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: stateView(0, 'w', 'startpos') });
  assert.deepEqual(turns.at(-1), false, 'spectators never have myTurn = true');
  controller.stop();
  sync.stop();
});

// ── Review #02 item 3: turn change-detection fires on pending transitions ──

test('R2#3: submit → onTurn(false) fires even when turn is held constant', () => {
  const { factory, sync, controller, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  // Join as white, white to move → myTurn = true.
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  // Clear the turns array to isolate the submit transition.
  turns.length = 0;
  // Submit a move — pending is set, turn stays 'w', but myTurn should go false.
  sync.submitMove('e2e4');
  assert.deepEqual(turns, [false], 'onTurn(false) should fire when pending is set (turn held constant)');
  controller.stop();
  sync.stop();
});

test('R2#3: reject rollback → onTurn(true) fires even when turn is held constant', () => {
  const { factory, sync, controller, turns } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  // Submit a move → pending set → myTurn goes false.
  sync.submitMove('e2e4');
  turns.length = 0;
  // Server rejects the move → pending cleared → myTurn goes back to true.
  factory.last.emit({ t: 'reject', gameId: 'g1', ref: 1, code: 'illegal_move', message: 'nope' });
  assert.deepEqual(turns, [true], 'onTurn(true) should fire when pending is cleared by reject (turn held constant)');
  controller.stop();
  sync.stop();
});

// ── Game Actions ─────────────────────────────────────────────────────────────

test('action methods delegate to GameSync', () => {
  const { factory, sync, controller } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });

  controller.resign();
  let sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'resign');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });

  controller.abort();
  sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'abort');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });

  controller.offerDraw();
  sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'offerDraw');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });

  // For draw responses, the opponent must have offered a draw
  const receivedDrawState = { ...stateView(0, 'w', 'startpos'), drawOffer: 'b' as const };
  factory.last.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });

  controller.acceptDraw();
  sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'acceptDraw');
  factory.last.emit({ t: 'state', gameId: 'g1', state: receivedDrawState });

  controller.declineDraw();
  sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'declineDraw');
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });

  controller.claimFlag();
  sent = JSON.parse(factory.last.sent.at(-1)!);
  assert.equal(sent.t, 'claimFlag');

  controller.stop();
  sync.stop();
});

test('onActionState derives correctly for players and spectators', () => {
  const { factory, sync, controller } = setup();
  const actionStates: any[] = [];
  controller.stop();
  const controller2 = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: () => {},
      onActionState: (state) => actionStates.push(state),
    },
  });
  controller2.start();
  sync.start();
  factory.last.open();

  // Spectator
  const spectatorState = { ...stateView(0, 'w', 'startpos'), drawOffer: 'w' as const };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'spectator', state: spectatorState });
  assert.equal(actionStates.at(-1)!.isPlayer, false);
  assert.equal(actionStates.at(-1)!.isHumanGame, true);
  assert.equal(actionStates.at(-1)!.drawOffer, 'none');

  // Player
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });
  assert.equal(actionStates.at(-1)!.isPlayer, true);
  assert.equal(actionStates.at(-1)!.isHumanGame, true);
  assert.equal(actionStates.at(-1)!.canAbort, true);

  const botState = {
    ...stateView(0, 'w', 'startpos'),
    players: { white: 'u1', black: ENGINE_BOT_USER_IDS.novice },
  };
  factory.last.emit({ t: 'state', gameId: 'g1', state: botState });
  assert.equal(actionStates.at(-1)!.isHumanGame, false);

  // Ply >= 2 means no abort
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(2, 'w', 'startpos') });
  assert.equal(actionStates.at(-1)!.canAbort, false);

  // Draw offer sent
  const stateWithSentOffer = { ...stateView(2, 'w', 'startpos'), drawOffer: 'w' as const };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateWithSentOffer });
  assert.equal(actionStates.at(-1)!.drawOffer, 'sent');

  // Draw offer received
  const stateWithReceivedOffer = { ...stateView(2, 'w', 'startpos'), drawOffer: 'b' as const };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateWithReceivedOffer });
  assert.equal(actionStates.at(-1)!.drawOffer, 'received');

  controller2.stop();
  sync.stop();
});

test('actions are gated when pendingAction is set', () => {
  const { factory, sync, controller } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });

  // Clear sent history
  factory.last.sent.length = 0;

  // First action goes through
  controller.resign();
  assert.equal(JSON.parse(factory.last.sent.at(-1)!).t, 'resign');

  // Second action is blocked by pendingAction
  controller.offerDraw();
  assert.equal(factory.last.sent.length, 1, 'duplicate action should be prevented');

  // Resolve pending action
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', 'startpos') });

  // Now an action works
  controller.offerDraw();
  assert.equal(JSON.parse(factory.last.sent.at(-1)!).t, 'offerDraw');

  controller.stop();
  sync.stop();
});

test('stale errors are cleared on intended transitions', () => {
  const { factory, sync } = setup();
  let lastReject: string | null = null;
  const controller2 = new GameController({
    gameSync: sync,
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: () => {},
      onStatus: () => {},
      onActionState: (state) => { lastReject = state.lastReject; },
    },
  });
  controller2.start();
  sync.start();
  factory.last.open();
  const validFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', validFen) });

  // Cause an error
  factory.last.emit({ t: 'reject', gameId: 'g1', message: 'Illegal move', code: 'illegal', ref: null });
  assert.equal(lastReject, 'Illegal move');

  // Emit a state transition
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView(0, 'w', validFen) });
  assert.equal(lastReject, null);

  // Cause another error
  factory.last.emit({ t: 'reject', gameId: 'g1', message: 'Not your turn', code: 'not_turn', ref: null });
  assert.equal(lastReject, 'Not your turn');

  // Emit a move transition
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {}
  });
  assert.equal(lastReject, null);

  controller2.stop();
  sync.stop();
});

test('action methods return false when WsClient.send fails', () => {
  const { factory, sync, controller } = setup();
  controller.start();
  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView(0, 'w', 'startpos') });

  // Close socket so send fails
  factory.last.serverClose();

  const sent = controller.resign();
  assert.equal(sent, false);

  controller.stop();
  sync.stop();
});

test('onMetadata derives correctly and fires on changes', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();

  // 1. Initial state before join: connected=false, rest=null (emitted by controller.start())
  // 2. Open transitions to connected=true
  factory.last.open();

  assert.equal(metadatas.length, 2);
  assert.equal(metadatas[0].connected, false);
  assert.equal(metadatas[0].role, null);
  assert.equal(metadatas[1].connected, true);

  // 3. Join as spectator with presence
  const validFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const stateWithPresence = { ...stateView(0, 'w', validFen) };
  factory.last.emit({
    t: 'joined', gameId: 'g1', role: 'spectator', state: stateWithPresence
  });
  factory.last.emit({
    t: 'presence', gameId: 'g1', white: true, black: false, spectators: 1
  });

  assert.equal(metadatas.at(-1)!.role, 'spectator');
  assert.equal(metadatas.at(-1)!.myColor, null);
  assert.equal(metadatas.at(-1)!.variant, 'standard');
  assert.deepEqual(metadatas.at(-1)!.presence, { white: true, black: false, spectators: 1 });

  // 4. Move event without presence change should NOT fire onMetadata
  const lenBeforeMove = metadatas.length;
  factory.last.emit({
    t: 'move', gameId: 'g1', ply: 1, uci: 'e2e4', san: 'e4', by: 'w',
    fenHash: 'h1', clock: { w: 59_000, b: 60_000 }, serverTs: 1, legalMoves: {}
  });
  assert.equal(metadatas.length, lenBeforeMove, 'onMetadata should not fire when metadata state has not changed');

  // 5. Presence event
  factory.last.emit({ t: 'presence', gameId: 'g1', white: true, black: true, spectators: 2 });
  assert.deepEqual(metadatas.at(-1)!.presence, { white: true, black: true, spectators: 2 });

  controller.stop();
  sync.stop();
});

test('onMetadata deduplicates identical timeControl objects', () => {
  const { factory, sync, controller, metadatas } = setup();
  controller.start();
  sync.start();
  factory.last.open();

  const validFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const stateView1 = { ...stateView(0, 'w', validFen), timeControl: { initialMs: 60000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const } };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: stateView1 });
  
  const lenBefore = metadatas.length;

  const stateView2 = { ...stateView(0, 'w', validFen), timeControl: { initialMs: 60000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const } };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView2 });

  assert.equal(metadatas.length, lenBefore, 'Identical timeControl object should not trigger onMetadata');

  // Emit a state with a different time control
  const stateView3 = { ...stateView(0, 'w', validFen), timeControl: { initialMs: 120000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const } };
  factory.last.emit({ t: 'state', gameId: 'g1', state: stateView3 });

  assert.equal(metadatas.length, lenBefore + 1, 'Different timeControl object should trigger onMetadata');

  controller.stop();
  sync.stop();
});

// ── Live Clock Countdown ─────────────────────────────────────────────────────

test('live clock ticks White remaining down when White is to move', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let fakeNow = 1000;
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => fakeNow,
    rng: () => 0,
    heartbeatMs: 0,
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });

  const clocks: Array<[number, number]> = [];
  let timerFn: (() => void) | null = null;
  let timerCleared = false;

  const controller = new GameController({
    gameSync: sync,
    now: () => fakeNow,
    setInterval: (fn) => {
      timerFn = fn;
      return 123 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      timerCleared = true;
      timerFn = null;
    },
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();

  const sv: StateView = {
    ...stateView(0, 'w', 'startpos'),
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: 1000,
  };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: sv });

  assert.deepEqual(clocks.at(-1), [60_000, 60_000]);

  fakeNow = 1500;
  if (timerFn) (timerFn as () => void)();
  assert.deepEqual(clocks.at(-1), [59_500, 60_000]);

  // Sub-second tick within the same second (59s) is suppressed to avoid redundant DOM writes
  fakeNow = 2000;
  const countBefore = clocks.length;
  if (timerFn) (timerFn as () => void)();
  assert.equal(clocks.length, countBefore, 'sub-second tick within same second should be suppressed');

  // Next second boundary (58s) fires onClock
  fakeNow = 2500;
  if (timerFn) (timerFn as () => void)();
  assert.deepEqual(clocks.at(-1), [58_500, 60_000]);

  controller.stop();
  assert.equal(timerCleared, true);
  sync.stop();
});

test('countdown stops when game ends, and timer is cleared on stop', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let fakeNow = 1000;
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => fakeNow,
    rng: () => 0,
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const clocks: Array<[number, number]> = [];
  let timerFn: (() => void) | null = null;
  let timerCleared = false;

  const controller = new GameController({
    gameSync: sync,
    now: () => fakeNow,
    setInterval: (fn) => {
      timerFn = fn;
      return 123 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      timerCleared = true;
      timerFn = null;
    },
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();

  const sv: StateView = {
    ...stateView(0, 'w', 'startpos'),
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: 1000,
  };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: sv });
  assert.ok(timerFn !== null);

  factory.last.emit({ t: 'ended', gameId: 'g1', result: '1-0', termination: 'checkmate', winner: 'w', serverTs: 2000 });
  assert.equal(timerCleared, true);
  assert.equal(timerFn, null);

  controller.stop();
  sync.stop();
});

test('clock value never goes below zero once anchor is exhausted', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let fakeNow = 1000;
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => fakeNow,
    rng: () => 0,
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const clocks: Array<[number, number]> = [];
  let timerFn: (() => void) | null = null;

  const controller = new GameController({
    gameSync: sync,
    now: () => fakeNow,
    setInterval: (fn) => {
      timerFn = fn;
      return 123 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {},
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();

  const sv: StateView = {
    ...stateView(0, 'w', 'startpos'),
    clock: { w: 1000, b: 60_000 },
    turnStartedAt: 1000,
  };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: sv });

  fakeNow = 6000;
  if (timerFn) (timerFn as () => void)();
  assert.deepEqual(clocks.at(-1), [0, 60_000]);

  controller.stop();
  sync.stop();
});

test('snapshot with turnStartedAt null does not crash and does not tick', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let fakeNow = 1000;
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => fakeNow,
    rng: () => 0,
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });
  const clocks: Array<[number, number]> = [];
  let timerFn: (() => void) | null = null;

  const controller = new GameController({
    gameSync: sync,
    now: () => fakeNow,
    setInterval: (fn) => {
      timerFn = fn;
      return 123 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {},
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();

  const sv: StateView = {
    ...stateView(0, 'w', 'startpos'),
    clock: { w: 60_000, b: 60_000 },
    turnStartedAt: null,
  };
  factory.last.emit({ t: 'joined', gameId: 'g1', role: 'white', state: sv });

  assert.deepEqual(clocks.at(-1), [60_000, 60_000]);
  assert.equal(timerFn, null, 'timer should not start when turnStartedAt is null');

  controller.stop();
  sync.stop();
});

/**
 * The end of the chain the boundary coercion protects: even given a frame whose anchor is missing,
 * the clock face must stay a real time rather than `NaN:NaN`.
 */
test('a snapshot with no clock anchor renders the authoritative time, never NaN', () => {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  let fakeNow = 1000;
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => fakeNow,
    rng: () => 0,
    heartbeatMs: 0,
  });
  const sync = new GameSync(client, { gameId: 'g1', token: 'token-u1' });

  const clocks: Array<[number, number]> = [];
  let timerFn: (() => void) | null = null;
  const controller = new GameController({
    gameSync: sync,
    now: () => fakeNow,
    setInterval: (fn) => {
      timerFn = fn;
      return 123 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      timerFn = null;
    },
    callbacks: {
      onPosition: () => {},
      onTurn: () => {},
      onClock: (w, b) => clocks.push([w, b]),
      onStatus: () => {},
    },
  });

  controller.start();
  sync.start();
  factory.last.open();

  const withoutAnchor: Record<string, unknown> = { ...stateView(0, 'w', 'startpos') };
  delete withoutAnchor['turnStartedAt'];
  factory.last.emit(JSON.stringify({ t: 'joined', gameId: 'g1', role: 'white', state: withoutAnchor }));

  fakeNow = 9_000;
  if (timerFn) (timerFn as () => void)();

  for (const [w, b] of clocks) {
    assert.ok(Number.isFinite(w) && Number.isFinite(b), `onClock emitted a non-finite value: ${w}, ${b}`);
  }
  assert.deepEqual(clocks.at(-1), [60_000, 60_000], 'with no anchor the authoritative values stand');

  controller.stop();
  sync.stop();
});
