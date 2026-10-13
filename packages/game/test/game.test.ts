import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, repetitionKey, canMate } from '../src/game';
import { Position } from '@chess-platform/core';
import type { GameEvent } from '../src/events';
import type { TimeControl } from '../src/clock';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

function newGame() {
  return Game.create({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });
}

test('a fresh game is ongoing with White to move', () => {
  const { game } = newGame();
  assert.equal(game.status.over, false);
  assert.equal(game.turn, 'w');
});

test('incremental event prefixes agree with full replay without mutating the resident game', () => {
  const created = Game.create({ gameId: 'prefix', timeControl: TC, at: 0,
    players: { white: 'alice', black: 'bob' }, initialFen: '4k2r/8/8/8/8/8/8/R3K3 w - - 99 1' });
  const before = created.game.snapshot();
  const result = created.game.playMove('a1a2', 1_000);
  assert.deepEqual(result.events.map(event => event.type), ['MovePlayed', 'GameEnded']);
  let prefix = created.game;
  for (let i = 0; i < result.events.length; i++) {
    prefix = prefix.withEvents([result.events[i]!]);
    const replay = Game.fromEvents([...created.events, ...result.events.slice(0, i + 1)]);
    assert.deepEqual(prefix.snapshot(), replay.snapshot());
    assert.equal(prefix.status.over, i === result.events.length - 1);
  }
  assert.equal(created.game.snapshot(), before);
  assert.equal(created.game.status.over, false);
  assert.deepEqual(prefix.snapshot(), result.game.snapshot());
});

test('playing moves advances the game and records SAN', () => {
  let { game } = newGame();
  let t = 1_000;
  for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
    ({ game } = game.playMove(uci, (t += 2_000)));
  }
  const snap = game.snapshot();
  assert.equal(snap.ply, 3);
  assert.deepEqual(snap.moves.map((m) => m.san), ['e4', 'e5', 'Nf3']);
  assert.equal(game.turn, 'b');
});

test('scholar\'s mate ends the game as checkmate 1-0', () => {
  let { game } = newGame();
  let t = 0;
  const line = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  let allEvents: GameEvent[] = [];
  for (const uci of line) {
    const res = game.playMove(uci, (t += 1_000));
    game = res.game;
    allEvents = allEvents.concat(res.events);
  }
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'checkmate');
    assert.equal(game.status.result, '1-0');
  }
  // A GameEnded event was emitted alongside the final move.
  assert.ok(allEvents.some((e) => e.type === 'GameEnded'));
});

test('event sourcing: a game reconstructs exactly from its event log', () => {
  let { game, events } = newGame();
  const log: GameEvent[] = [...events];
  let t = 0;
  for (const uci of ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3']) {
    const res = game.playMove(uci, (t += 4_000));
    game = res.game;
    log.push(...res.events);
  }
  const rebuilt = Game.fromEvents(log);
  assert.equal(rebuilt.fen, game.fen);
  assert.equal(rebuilt.snapshot().ply, game.snapshot().ply);
  assert.deepEqual(rebuilt.snapshot().clock.remaining, game.snapshot().clock.remaining);
  assert.deepEqual(
    rebuilt.snapshot().moves.map((m) => m.san),
    game.snapshot().moves.map((m) => m.san),
  );
});

test('resignation ends the game for the opponent', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.resign('b', 2_000));
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.result, '1-0');
    assert.equal(game.status.termination, 'resignation');
    assert.equal(game.status.winner, 'w');
  }
});

test('draw offer then accept ends in agreement', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.offerDraw('w', 1_500));
  ({ game } = game.acceptDraw('b', 2_000));
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.termination, 'agreement');
  }
});

test('cannot accept your own draw offer', () => {
  let { game } = newGame();
  ({ game } = game.offerDraw('w', 1_000));
  assert.throws(() => game.acceptDraw('w', 2_000), /No draw offer/);
});

test('illegal move is rejected', () => {
  const { game } = newGame();
  assert.throws(() => game.playMove('e2e5', 1_000), /Illegal move|No legal move/);
});

test('flagging on the clock ends the game by timeout', () => {
  const short: TimeControl = { initialMs: 5_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
  let { game } = Game.create({
    gameId: 'g2', timeControl: short, players: { white: 'a', black: 'b' }, at: 0,
  });
  ({ game } = game.playMove('e2e4', 1_000)); // white used 1s
  // Black tries to move 10s later -> flagged.
  const res = game.playMove('e7e5', 11_000);
  game = res.game;
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'timeout');
    assert.equal(game.status.result, '1-0');
  }
});

test('abort is allowed early and forbidden after both move', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.playMove('e7e5', 2_000));
  assert.throws(() => game.abort(3_000), /no longer be aborted/);
});

test('scale: reconstruct many games from their logs quickly', () => {
  const N = 2_000;
  const line = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6'];
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    let { game, events } = Game.create({
      gameId: `sim-${i}`, timeControl: TC, players: { white: 'x', black: 'y' }, at: 0,
    });
    const log: GameEvent[] = [...events];
    let t = 0;
    for (const uci of line) {
      const res = game.playMove(uci, (t += 1_000));
      game = res.game;
      log.push(...res.events);
    }
    const rebuilt = Game.fromEvents(log);
    assert.equal(rebuilt.fen, game.fen);
  }
  const ms = Date.now() - start;
  // Informational: ensures the aggregate is fast enough for high concurrency.
  console.log(`reconstructed ${N} games in ${ms}ms (${(ms / N).toFixed(3)}ms/game)`);
  assert.ok(ms < 20_000);
});

// ── Threefold repetition ───────────────────────────────────────────────────

test('M3 (acceptance): threefold repetition ends the game as a draw', () => {
  let { game } = newGame();
  let t = 1_000;
  // 1.Nf3 Nf6 2.Ng1 Ng8 3.Nf3 Nf6 4.Ng1 Ng8
  // After 4...Ng8 the starting position has appeared 3 times.
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    const result = game.playMove(uci, (t += 2_000));
    game = result.game;
  }
  assert.equal(game.status.over, true, 'game should be over after threefold repetition');
  if (game.status.over) {
    assert.equal(game.status.termination, 'threefold');
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.winner, null);
  }
});

test('threefold: fake en-passant square normalises to dash', () => {
  // After 1.e4, the FEN carries ep square e3, but no black pawn is adjacent
  // to the e4 pawn, so no legal en-passant capture exists. The position must
  // be equivalent to the same position with ep "-".
  const fenWithFakeEp = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const fenNoEp = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const posWithFakeEp = Position.fromFen(fenWithFakeEp);
  const posNoEp = Position.fromFen(fenNoEp);
  assert.equal(
    repetitionKey(posWithFakeEp.snapshot()),
    repetitionKey(posNoEp.snapshot()),
    'positions with a non-legal ep square must normalise to "-"',
  );
});

test('threefold: genuine legal en-passant makes positions different', () => {
  // After 1.e4 d5 2.e5 f5, White's e5 pawn can capture f6 en-passant.
  // The FEN has ep square f6, and the en-passant capture IS legal.
  const fenWithLegalEp = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
  const fenNoEp = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3';
  const posWithEp = Position.fromFen(fenWithLegalEp);
  const posNoEp = Position.fromFen(fenNoEp);
  assert.notEqual(
    repetitionKey(posWithEp.snapshot()),
    repetitionKey(posNoEp.snapshot()),
    'positions with a genuinely legal en-passant must have different repetition keys',
  );
});

test('threefold: castling-rights difference is NOT a repeat', () => {
  // If White plays Ra1-a2-a1, the Q-side castling right is lost.
  // The piece placement returns to the original, but castling rights differ.
  const fenWithCastling = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const fenWithoutQCastling = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1';
  const posWithCastling = Position.fromFen(fenWithCastling);
  const posWithoutQCastling = Position.fromFen(fenWithoutQCastling);
  assert.notEqual(
    repetitionKey(posWithCastling.snapshot()),
    repetitionKey(posWithoutQCastling.snapshot()),
    'positions with different castling rights must have different repetition keys',
  );
});

test('threefold: regression — e5 ep square does not block repetition', () => {
  let { game } = newGame();
  let t = 1_000;
  // 1.Nf3 e5 2.Ng1 Nf6 3.Nf3 Ng8 4.Ng1 Nf6 5.Nf3 Ng8
  // The position after e5 appears three times (after moves 1, 3, 5
  // of the sequence). The first occurrence carries ep square e6,
  // but no white pawn can capture en-passant, so it normalises to "-".
  const moves = [
    'g1f3', 'e7e5', 'f3g1', 'g8f6',
    'g1f3', 'f6g8', 'f3g1', 'g8f6',
    'g1f3', 'f6g8',
  ];
  for (const uci of moves) {
    const result = game.playMove(uci, (t += 2_000));
    game = result.game;
  }
  assert.equal(game.status.over, true, 'game should be over after threefold repetition');
  if (game.status.over) {
    assert.equal(game.status.termination, 'threefold');
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.winner, null);
  }
});

test('threefold: event-sourcing invariant — fromEvents reconstructs the same draw', () => {
  let { game, events } = newGame();
  const log: GameEvent[] = [...events];
  let t = 1_000;
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    const res = game.playMove(uci, (t += 2_000));
    game = res.game;
    log.push(...res.events);
  }
  const rebuilt = Game.fromEvents(log);
  // The rebuilt game must have the same status (byte-identical object).
  assert.deepEqual(rebuilt.status, game.status);
  assert.equal(rebuilt.status.over, true);
  if (rebuilt.status.over) {
    assert.equal(rebuilt.status.termination, 'threefold');
    assert.equal(rebuilt.status.result, '1/2-1/2');
    assert.equal(rebuilt.status.winner, null);
  }
  // Repetition history must also match.
  assert.deepEqual(rebuilt.snapshot().repetition, game.snapshot().repetition);
});

test('threefold: a game that ends by threefold rejects further commands', () => {
  let { game } = newGame();
  let t = 1_000;
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    ({ game } = game.playMove(uci, (t += 2_000)));
  }
  assert.equal(game.status.over, true);
  // Further moves are rejected.
  assert.throws(() => game.playMove('g1f3', (t += 2_000)), /already over/);
  // Resignation is rejected.
  assert.throws(() => game.resign('w', (t += 1_000)), /already over/);
  // Draw offer is rejected.
  assert.throws(() => game.offerDraw('w', (t += 1_000)), /already over/);
});

/**
 * Timeout material rules were the standard ones in every variant, which is the wrong question
 * wherever checkmate is not the win condition. The tracked follow-up sat under Milestone 2 as
 * "per-variant timeout material rules"; the cost is a player who was winning being handed a draw
 * because their opponent ran out of time.
 *
 * King of the Hill is the sharpest case and needs no exotic position: a king alone is exactly the
 * piece the win condition wants, and it was being told it could not win.
 */
test('a lone king wins on time in King of the Hill, where walking to the centre is the win condition', () => {
  const short: TimeControl = { initialMs: 5_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
  // White has only a king; Black has a king and a rook and is to move.
  let { game } = Game.create({
    gameId: 'koth-flag',
    timeControl: short,
    players: { white: 'a', black: 'b' },
    variant: 'kingofthehill',
    initialFen: '3rk3/8/8/8/8/8/8/4K3 b - - 0 1',
    at: 0,
  });

  const res = game.claimFlag(11_000);
  game = res.game;
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'timeout', 'a bare king can still reach the hill, so this is a win');
    assert.equal(game.status.result, '1-0');
  }
});

test('a lone king still draws on time in standard chess, where it genuinely cannot mate', () => {
  const short: TimeControl = { initialMs: 5_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
  let { game } = Game.create({
    gameId: 'std-flag',
    timeControl: short,
    players: { white: 'a', black: 'b' },
    initialFen: '3rk3/8/8/8/8/8/8/4K3 b - - 0 1',
    at: 0,
  });

  const res = game.claimFlag(11_000);
  game = res.game;
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'insufficient_material');
    assert.equal(game.status.result, '1/2-1/2');
  }
});

/**
 * Crazyhouse is the case the board cannot show. A player holding a queen is one drop from mate, and
 * `parseFen` was being called without the variant, so the pocket was never even consulted.
 *
 * The bare-king case is the one this test originally got wrong, asserting a draw. A king captures
 * like any other piece, so even with an empty pocket it can take something and drop it back —
 * there is no material state in Crazyhouse from which winning is impossible. Caught in the review of
 * PR #97.
 */
test('no material state in Crazyhouse rules out a win on timeout', () => {
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3[Q] w - - 0 1', 'w', 'crazyhouse'), true);
  assert.equal(
    canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'crazyhouse'),
    true,
    'a bare king can still capture and drop what it takes',
  );
});

/**
 * Three-check and Atomic win by checking and by exploding, not by mating, so the two-minor threshold
 * that standard chess uses does not apply: a single knight is enough in both.
 */
test('one minor piece is enough on timeout in Three-check and Atomic, but a bare king is not', () => {
  for (const variant of ['threecheck', 'atomic'] as const) {
    assert.equal(canMate('4k3/8/8/8/8/8/8/4KN2 w - - 0 1', 'w', variant), true, `${variant}: K+N can still win`);
    assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', variant), false, `${variant}: a bare king cannot`);
  }
  // The same K+N is correctly a draw in standard chess, which is the rule being varied from.
  assert.equal(canMate('4k3/8/8/8/8/8/8/4KN2 w - - 0 1', 'w', 'standard'), false);
});

/**
 * Horde alongside Crazyhouse: Black wins by capturing every white piece, and a king captures on its
 * own, so a bare black king is not a material state that rules the win out either.
 *
 * The contrast with Three-check and Atomic is the point, and it is not arbitrary. A king's capture
 * makes progress toward the win in Crazyhouse and Horde; in Three-check it cannot, because capturing
 * never turns a king into something that gives check, and in Atomic the king may not capture at all
 * without exploding itself. So those two stay strict while these two do not.
 */
test('a bare king can still win on time in Horde, but not in Three-check or Atomic', () => {
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'b', 'horde'), true, 'a black king captures pawns on its own');

  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'threecheck'), false, 'a king can never give check');
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'atomic'), false, 'an atomic king may not capture at all');
});
