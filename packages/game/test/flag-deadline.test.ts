/**
 * The in-play flag deadline (ADR-0149): `flagDeadline` is the first instant `hasFlagged` holds, the
 * game exposes it only once a move has started the clock, and `timeoutDue` records exactly the ending
 * `claimFlag` does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Variant } from '@chess-platform/core';
import { Game, flagDeadline, hasFlagged, initClock, type GameEvent, type TimeControl } from '../src';

const T0 = 1_700_000_000_000;
const SUDDEN: TimeControl = { kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 };
const FISCHER: TimeControl = { kind: 'increment', initialMs: 60_000, incrementMs: 2_000, delayMs: 0 };
const DELAY: TimeControl = { kind: 'delay', initialMs: 60_000, incrementMs: 0, delayMs: 5_000 };
const UNLIMITED: TimeControl = { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 };

function play(game: Game, uci: string, at: number): Game {
  return game.playMove(uci, at).game;
}

function create(tc: TimeControl, opts: { source?: 'seek'; variant?: Variant; fen?: string } = {}): Game {
  let game = Game.create({
    gameId: 'g', timeControl: tc, players: { white: 'w', black: 'b' }, at: T0,
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.fen ? { initialFen: opts.fen } : {}),
    ...(opts.source ? { source: opts.source, noShowAfterMs: 60_000 } : {}),
  }).game;
  if (opts.source) {
    game = game.markReady('w', T0).game;
    game = game.markReady('b', T0).game;
  }
  return game;
}

test('flagDeadline is the first instant hasFlagged holds, for every clock kind and remaining time', () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (const tc of [SUDDEN, FISCHER, DELAY]) {
    for (let i = 0; i < 500; i += 1) {
      const tsa = T0 + rand(1_000_000);
      const remaining = rand(4) === 0 ? 0 : rand(600_000) + 1;
      const clock = { remaining: { w: remaining, b: 10 }, turnStartedAt: tsa };
      const deadline = flagDeadline(clock, 'w', tc)!;
      assert.equal(hasFlagged(clock, 'w', deadline, tc), true, `${tc.kind} flags at ${deadline}`);
      if (deadline > tsa) assert.equal(hasFlagged(clock, 'w', deadline - 1, tc), false, `${tc.kind} not before`);
    }
  }
  assert.equal(flagDeadline(initClock(SUDDEN, null), 'w', SUDDEN), null, 'no anchor, no deadline');
  assert.equal(flagDeadline(initClock(UNLIMITED, T0), 'w', UNLIMITED), null, 'unlimited never flags');
});

test('sudden death: the first move starts the opponent at its own remaining time', () => {
  const game = play(create(SUDDEN), 'e2e4', T0 + 1_000);
  // Black's clock runs from White's move with its full minute.
  assert.equal(game.flagDeadline, T0 + 1_000 + 60_000);
  assert.equal(game.timeoutDue(T0 + 60_999), false);
  assert.equal(game.timeoutDue(T0 + 61_000), true);
});

test('Fischer increment: the deadline after a move includes the increment the mover earned', () => {
  let game = play(create(FISCHER), 'e2e4', T0 + 1_000); // White: 60 000 - 1 000 + 2 000 = 61 000
  game = play(game, 'e7e5', T0 + 11_000); // Black spends 10 000 of 60 000, earns 2 000: 52 000
  assert.deepEqual(game.snapshot().clock.remaining, { w: 61_000, b: 52_000 });
  assert.equal(game.flagDeadline, T0 + 11_000 + 61_000, 'White to move, from Black\'s move');
  game = play(game, 'g1f3', T0 + 21_000); // White spends 10 000: 61 000 - 10 000 + 2 000
  assert.equal(game.flagDeadline, T0 + 21_000 + 52_000, 'the next deadline replaces the previous one');
});

test('delay: nothing is charged within the delay, so the deadline is later by exactly the delay', () => {
  let game = play(create(DELAY), 'e2e4', T0 + 1_000);
  assert.equal(game.flagDeadline, T0 + 1_000 + 5_000 + 60_000);
  game = play(game, 'e7e5', T0 + 1_000 + 3_000); // within the delay: Black keeps all 60 000
  assert.equal(game.snapshot().clock.remaining.b, 60_000);
  assert.equal(game.flagDeadline, T0 + 4_000 + 5_000 + game.snapshot().clock.remaining.w);
  assert.equal(game.timeoutDue(game.flagDeadline! - 1), false);
  assert.equal(game.timeoutDue(game.flagDeadline!), true);
});

test('a sourced game has no deadline before its first move, and the first move anchors the clock', () => {
  const ready = create(SUDDEN, { source: 'seek' });
  assert.equal(ready.flagDeadline, null);
  assert.equal(ready.timeoutDue(T0 + 10_000_000), false, 'no in-play flag before the first move');
  const moved = play(ready, 'e2e4', T0 + 30_000);
  assert.equal(moved.snapshot().clock.remaining.w, 60_000, 'the first move consumed no time');
  assert.equal(moved.flagDeadline, T0 + 30_000 + 60_000);
});

test('a game without a source is out of scope until its first move, then flags like any other', () => {
  const fresh = create(SUDDEN);
  assert.equal(fresh.flagDeadline, null);
  assert.equal(fresh.timeoutDue(T0 + 10_000_000), false, 'the original lifecycle is untouched');
  assert.equal(play(fresh, 'e2e4', T0 + 5_000).flagDeadline, T0 + 5_000 + 60_000);
});

test('unlimited games and ended games never have a deadline', () => {
  const unlimited = play(create(UNLIMITED), 'e2e4', T0 + 5_000);
  assert.equal(unlimited.flagDeadline, null);
  assert.equal(unlimited.timeoutDue(Number.MAX_SAFE_INTEGER), false);
  const resigned = play(create(SUDDEN), 'e2e4', T0).resign('b', T0 + 1).game;
  assert.equal(resigned.flagDeadline, null);
  assert.equal(resigned.timeoutDue(T0 + 10_000_000), false);
});

test('a move one millisecond before the deadline is played; at the deadline the timeout wins', () => {
  const game = play(create(SUDDEN), 'e2e4', T0);
  const deadline = game.flagDeadline!;
  const early = game.playMove('e7e5', deadline - 1);
  assert.equal(early.events[0]!.type, 'MovePlayed');
  assert.equal(early.game.status.over, false);
  const late = game.playMove('e7e5', deadline);
  assert.deepEqual(late.events, [{ type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w', at: deadline }]);
});

test('timeout on insufficient mating material is a draw, exactly as claimFlag records it, in every variant', () => {
  // White (to move after Black's reply) flags; Black has only a king or a single knight.
  const cases: Array<{ variant: Variant; fen: string; move: string; result: string }> = [
    { variant: 'standard', fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', move: 'a1a2', result: '1/2-1/2' },
    { variant: 'standard', fen: '4k3/8/8/8/8/8/1n6/R3K3 w - - 0 1', move: 'a1a3', result: '1/2-1/2' },
    { variant: 'standard', fen: '4k3/8/8/8/8/8/1q6/R3K3 w - - 0 1', move: 'a1a3', result: '0-1' },
    { variant: 'chess960', fen: '', move: '', result: '0-1' },
    { variant: 'kingofthehill', fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', move: 'a1a2', result: '0-1' },
    { variant: 'threecheck', fen: '4k3/8/8/8/8/8/8/R3K3 w - - 3+3 0 1', move: 'a1a2', result: '1/2-1/2' },
    { variant: 'atomic', fen: '4k3/8/8/8/8/8/1n6/R3K3 w - - 0 1', move: 'a1a3', result: '0-1' },
    { variant: 'crazyhouse', fen: '4k3/8/8/8/8/8/8/R3K3[] w - - 0 1', move: 'a1a2', result: '0-1' },
    { variant: 'racingkings', fen: '8/8/8/8/8/8/k1K5/r7 w - - 0 1', move: 'c2d3', result: '0-1' },
    { variant: 'horde', fen: '4k3/8/8/8/8/8/PPPPPPPP/8 w - - 0 1', move: 'a2a3', result: '0-1' },
  ];
  for (const c of cases) {
    let start: Game;
    let whiteMove = c.move;
    let blackMove = 'e8d8';
    if (c.variant === 'chess960') {
      start = Game.create({ gameId: 'g', variant: 'chess960', chess960StartId: 518, timeControl: SUDDEN, players: { white: 'w', black: 'b' }, at: T0 }).game;
      whiteMove = 'e2e4';
      blackMove = 'e7e5';
    } else {
      start = create(SUDDEN, { variant: c.variant, fen: c.fen });
    }
    if (c.variant === 'racingkings') blackMove = 'a2b3';
    const game = play(play(start, whiteMove, T0 + 1_000), blackMove, T0 + 2_000);
    const deadline = game.flagDeadline!;
    assert.equal(game.timeoutDue(deadline), true, c.variant);
    const claimed = game.claimFlag(deadline);
    assert.equal((claimed.events[0] as Extract<GameEvent, { type: 'GameEnded' }>).result, c.result, `${c.variant} ${c.fen}`);
    assert.deepEqual(game.playMove(whiteMove === 'e2e4' ? 'g1f3' : whiteMove, deadline).events, claimed.events, 'a late move records the same ending');
  }
});

test('replay rebuilds the same deadline, because the stored move carries the charged time', () => {
  const r1 = create(FISCHER).playMove('e2e4', T0 + 1_234);
  const r2 = r1.game.playMove('e7e5', T0 + 7_777);
  const events = [
    ...Game.create({ gameId: 'g', timeControl: FISCHER, players: { white: 'w', black: 'b' }, at: T0 }).events,
    ...r1.events,
    ...r2.events,
  ];
  const replayed = Game.fromEvents(events);
  assert.equal(replayed.flagDeadline, r2.game.flagDeadline);
  const move = r2.events[0] as Extract<GameEvent, { type: 'MovePlayed' }>;
  assert.equal(replayed.flagDeadline, move.at + move.remaining.w, 'the stored remaining time is what the queue reads');
});
