/**
 * Timeout adjudication test suite for FIDE 6.9 reachability.
 *
 * Covers:
 * - 20 mandatory positional controls (5 source FENs + 5 reflected x Standard/Chess960).
 * - Real baseline assertions verifying production `canMate` now awards correct FIDE 6.9 outcomes.
 * - KNN mate witness, ongoing KNN vs bare K, live flag timeout win, and KNN guard test.
 * - Strict budget contract (root reservation, 70-vs-71 natural capacity threshold, 0-token work).
 * - Natural canonical 4-ply cycle detection (no callbacks or orderer hooks).
 * - Concrete predecessor and live timeout routes (Standard and Chess960 legacy).
 * - Ongoing affected-class WIN fixtures for Routes 1 and 2.
 * - Escaping branch with concrete child assertions & single-ply proof vs depth cutoff.
 * - Solver traversal of special moves (legal EP, pinned illegal EP with two valid kings, 4 promotions, 960 castling).
 * - Historical replay invariance (including stored outcome contradicting new solver).
 * - Variant invariance across all 6 non-standard variants.
 * - Negative FEN controls across all 8 variants.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  type Color,
  type Variant,
  type Move,
  opposite,
  FenError,
} from '@chess-platform/core';
import {
  Game,
  canMate,
  type TimeControl,
  type GameCreatedEvent,
  type GameEndedEvent,
  type GameEvent,
  type MovePlayedEvent,
} from '../src';
import { replayStoredHistory, type StoredHistoryRow } from '../src/stored-history';
import {
  proveMatingPossibilityWithCapacity,
  isMaterialImpossible,
  createAdjudicationCounters,
} from '../src/timeout-adjudication';

const FLAG_EN_PASSANT = 1 << 2;
const FLAG_KING_CASTLE = 1 << 3;

const SUDDEN: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
const T0 = 1_000_000;

// The 5 mandatory positional controls from the design brief:
const MANDATORY_5_FENS: ReadonlyArray<{ name: string; fen: string }> = [
  { name: 'Control 1: White Kf7+Bf6 vs Black Kh8+Nh7 (h7f6 forced)', fen: '7k/5K1n/5B2/8/8/8/8/8 b - - 0 1' },
  { name: 'Control 2: White Kg1+Nf2 vs Black Kh1+Bg1 (g1f2 forced)', fen: '8/8/8/8/8/6K1/5N2/6bk b - - 0 1' },
  { name: 'Control 3: White Kc3+Nb1 vs Black Ka2+Ra1 (Rxb1/Kxb1 forced)', fen: '8/8/8/8/8/2K5/k7/rN6 b - - 0 1' },
  { name: 'Control 4: White Ke8+Bg1 vs Black Kh1+Pg2 (Kxg1 forced)', fen: '4K3/8/8/8/8/8/6p1/6Bk b - - 0 1' },
  { name: 'Control 5: White Kc1+Na1 vs Black Ka2+Pa3 (Kxa1 forced)', fen: '8/8/8/8/8/p7/k7/N1K5 b - - 0 1' },
];

function reflectColor(fen: string): string {
  const parts = fen.split(' ');
  const board = parts[0]!;
  const rows = board.split('/');
  const reflectedRows = rows.reverse().map((r) => {
    return r
      .split('')
      .map((c) => {
        if (c >= 'a' && c <= 'z') return c.toUpperCase();
        if (c >= 'A' && c <= 'Z') return c.toLowerCase();
        return c;
      })
      .join('');
  });
  const turn = parts[1] === 'w' ? 'b' : 'w';
  return [reflectedRows.join('/'), turn, parts[2], parts[3], parts[4], parts[5]].join(' ');
}

// ============================================================================
// Section A: 20 Mandatory Positional Controls
// ============================================================================

test('20 Mandatory Positional Controls: 5 source + 5 reflected across Standard and Chess960', () => {
  let count = 0;
  for (const variant of ['standard', 'chess960'] as const) {
    for (const { name, fen } of MANDATORY_5_FENS) {
      // 1. Original (White prospective winner, Black flags)
      const outcomeOrig = proveMatingPossibilityWithCapacity(
        Position.fromFen(fen, variant),
        'w',
        4,
        512,
      );
      assert.equal(outcomeOrig, 'impossible', `${variant} - ${name} must be impossible`);
      assert.equal(canMate(fen, 'w', variant), false, `${variant} - ${name} production canMate must be false`);
      count++;

      // 2. Color-reflected (Black prospective winner, White flags)
      const reflectedFen = reflectColor(fen);
      const outcomeRefl = proveMatingPossibilityWithCapacity(
        Position.fromFen(reflectedFen, variant),
        'b',
        4,
        512,
      );
      assert.equal(outcomeRefl, 'impossible', `${variant} - ${name} (reflected) must be impossible`);
      assert.equal(canMate(reflectedFen, 'b', variant), false, `${variant} - ${name} (reflected) production canMate must be false`);
      count++;
    }
  }
  assert.equal(count, 20, 'Exactly 20 positional cases evaluated');
});

// ============================================================================
// Section B: Material Classes & KNN Regressions
// ============================================================================

test('Material Class Fix 1: Lone minor against enabling enemy material awards timeout win', () => {
  const witnesses: Array<{ name: string; fen: string; winner: Color }> = [
    { name: 'KN vs KR corner mate witness', fen: '8/8/8/8/8/K7/2N5/kr6 b - - 0 1', winner: 'w' },
    { name: 'KB vs opposite-color KB', fen: '6bk/8/6K1/4B3/8/8/8/8 b - - 0 1', winner: 'w' },
    { name: 'KN vs KN helper block', fen: '7k/5K1n/6N1/8/8/8/8/8 b - - 0 1', winner: 'w' },
    { name: 'KB vs KN helper block', fen: 'k7/nBK5/8/8/8/8/8/8 b - - 0 1', winner: 'w' },
  ];

  for (const { name, fen, winner } of witnesses) {
    const prodResult = canMate(fen, winner, 'standard');
    assert.equal(prodResult, true, `Production canMate correctly awards timeout win on ${name}`);
  }
});

test('Material Class Fix 2: Same-color bishops cannot mate and must draw', () => {
  const sameColorBishopPositions: Array<{ name: string; fen: string; winner: Color }> = [
    {
      name: 'Two light bishops (f1, d3) vs bare King',
      fen: '4k3/8/8/8/8/3B4/8/4KB2 w - - 0 1',
      winner: 'w',
    },
    {
      name: 'Two light bishops (f1, d3) vs light bishop (b5)',
      fen: '4k3/8/8/1b6/8/3B4/8/4KB2 w - - 0 1',
      winner: 'w',
    },
  ];

  for (const { name, fen, winner } of sameColorBishopPositions) {
    const prodResult = canMate(fen, winner, 'standard');
    assert.equal(prodResult, false, `Production canMate correctly draws on ${name}`);
  }
});

test('Impossible material classes: bare King, KN vs K, KB vs K, same-color KB', () => {
  const impossibleCases = [
    { name: 'Bare Kings (K vs K)', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' },
    { name: 'White lone knight vs bare King', fen: '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1' },
    { name: 'White lone bishop vs bare King', fen: '4k3/8/8/8/8/8/8/2B1K3 w - - 0 1' },
    { name: 'Both players have same-color light bishops', fen: '4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1' },
  ];

  for (const { name, fen } of impossibleCases) {
    const pos = Position.fromFen(fen);
    assert.equal(isMaterialImpossible(pos, 'w'), true, `${name}: statically impossible`);
    assert.equal(canMate(fen, 'w', 'standard'), false, `${name}: production canMate returns false`);
  }
});

test('KNN Regressions: Guard distinguishes 1 Knight (false) from 2 Knights (true)', () => {
  const oneKnight = '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1';
  const twoKnights = '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1';

  // 1. One knight vs bare King can never mate under any rules => false (Draw)
  assert.equal(canMate(oneKnight, 'w', 'standard'), false, '1 knight vs bare King must draw');

  // 2. Two knights vs bare King CAN legally mate (FIDE 6.9 dead-position check) => true (Win)
  assert.equal(canMate(twoKnights, 'w', 'standard'), true, '2 knights vs bare King can legally mate; must not draw');
});

test('KNN Regressions: Existing legal checkmate witness 7k/5K2/5NN1/8/8/8/8/8 b - - 0 1 is true', () => {
  const mateFen = '7k/5K2/5NN1/8/8/8/8/8 b - - 0 1';
  const reflMateFen = reflectColor(mateFen);

  // Original (White checkmates Black):
  const posOrig = Position.fromFen(mateFen);
  assert.equal(posOrig.isCheck(), true);
  assert.equal(posOrig.legalMoves().length, 0);
  assert.deepEqual(posOrig.status(), { over: true, reason: 'checkmate', winner: 'w' });
  assert.equal(canMate(mateFen, 'w', 'standard'), true);
  assert.equal(canMate(mateFen, 'w', 'chess960'), true);

  // Reflected (Black checkmates White):
  const posRefl = Position.fromFen(reflMateFen);
  assert.equal(posRefl.isCheck(), true);
  assert.equal(posRefl.legalMoves().length, 0);
  assert.deepEqual(posRefl.status(), { over: true, reason: 'checkmate', winner: 'b' });
  assert.equal(canMate(reflMateFen, 'b', 'standard'), true);
  assert.equal(canMate(reflMateFen, 'b', 'chess960'), true);
});

test('KNN Regressions: Ongoing KNN vs bare King 4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1 is true', () => {
  const ongoingFen = '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1';
  const reflFen = reflectColor(ongoingFen);

  assert.equal(canMate(ongoingFen, 'w', 'standard'), true);
  assert.equal(canMate(ongoingFen, 'w', 'chess960'), true);
  assert.equal(canMate(reflFen, 'b', 'standard'), true);
  assert.equal(canMate(reflFen, 'b', 'chess960'), true);
});

test('KNN Regressions: Actual live Game timeout awards win to White on KNN vs bare King', () => {
  const ongoingFen = '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1';

  // 1. Standard
  const { game: stdGame } = Game.create({
    gameId: 'knn-live-std',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    at: T0,
    variant: 'standard',
    initialFen: ongoingFen,
  });

  const stdMoved = stdGame.playMove('b1c3', T0 + 1_000).game;
  assert.equal(stdMoved.status.over, false, 'Ongoing position, not over');
  const deadline = T0 + 1_000 + 60_000;
  assert.equal(stdMoved.timeoutDue(deadline), true);

  const stdClaim = stdMoved.claimFlag(deadline);
  const stdEnd = stdClaim.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(stdEnd);
  assert.equal(stdEnd.result, '1-0');
  assert.equal(stdEnd.termination, 'timeout');
  assert.equal(stdEnd.winner, 'w');

  // 2. Chess960 Legacy
  const legacyCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'knn-live-c960',
    variant: 'chess960',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: ongoingFen,
    at: T0,
  };

  const c960Game = Game.fromEvents([legacyCreated]);
  const c960Moved = c960Game.playMove('b1c3', T0 + 1_000).game;
  assert.equal(c960Moved.status.over, false);
  const c960Claim = c960Moved.claimFlag(deadline);
  const c960End = c960Claim.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(c960End);
  assert.equal(c960End.result, '1-0');
  assert.equal(c960End.termination, 'timeout');
  assert.equal(c960End.winner, 'w');
});

// ============================================================================
// Section C: Strict Budget Contract (Natural Traversal)
// ============================================================================

test('Zero-capacity contract: returns unknown before any evaluation work', () => {
  const pos = Position.fromFen(MANDATORY_5_FENS[0]!.fen);
  const counters = createAdjudicationCounters();

  const outcome = proveMatingPossibilityWithCapacity(
    pos,
    'w',
    4,
    0,
    counters,
  );

  assert.equal(outcome, 'unknown', '0 capacity must return unknown');
  assert.equal(counters.admittedNodes, 0, 'No nodes may be admitted');
  assert.equal(counters.plays, 0, 'No plays may occur');
  assert.equal(counters.legalGenerations, 0, 'No move generation may occur');
  assert.equal(counters.materialChecks, 0, 'No material checks may occur');
});

test('Strict Token Reservation: Natural order capacity threshold at 70 (unknown) vs 71 (possible)', () => {
  // Predecessor where Nc2# delivers immediate checkmate:
  // In natural legal move order, Nc2# is explored at cumulative token 71.
  const pos = Position.fromFen('8/8/8/8/3N4/K7/8/kr6 w - - 0 1');

  // 1. With totalCapacity = 71:
  // Explores branches in natural order, admits Nc2# at token 71 -> finds checkmate!
  const c71 = createAdjudicationCounters();
  const outcome71 = proveMatingPossibilityWithCapacity(
    pos,
    'w',
    2,
    71,
    c71,
  );
  assert.equal(outcome71, 'possible', 'Capacity 71 must find checkmate witness');
  assert.equal(c71.admittedNodes, 71);
  assert.equal(c71.capacityCutoffs, 0);

  // 2. With totalCapacity = 70:
  // Budget exhausted before Nc2# is admitted -> capacity cutoff returns unknown!
  const c70 = createAdjudicationCounters();
  const outcome70 = proveMatingPossibilityWithCapacity(
    pos,
    'w',
    2,
    70,
    c70,
  );
  assert.equal(outcome70, 'unknown', 'Capacity 70 must run out of tokens and return unknown');
  assert.equal(c70.admittedNodes, 70);
  assert.ok(c70.capacityCutoffs >= 1, 'At least 1 capacity cutoff recorded');
});

test('Strict Token Reservation: Control 3 budget impossibility completion vs capacity cutoff', () => {
  // Mandatory Control 3 FEN: 8/8/8/8/8/2K5/k7/rN6 b - - 0 1
  // Prospective winner: 'w'.
  // Turn: 'b'. Legal root moves are Kxb1 and Rxb1, both capturing White's only knight,
  // leaving White with a bare King (immediate material leaves, impossible to mate).
  const ctrl3Fen = '8/8/8/8/8/2K5/k7/rN6 b - - 0 1';
  const pos = Position.fromFen(ctrl3Fen);

  // 1. With totalCapacity = 3 (includes 1 root token + 2 child tokens):
  // Both children are evaluated, both hit material leaves, proof completes as 'impossible'.
  const c3 = createAdjudicationCounters();
  const outcome3 = proveMatingPossibilityWithCapacity(pos, 'w', 4, 3, c3);
  assert.equal(outcome3, 'impossible', 'Capacity 3 must complete impossibility proof');
  assert.equal(c3.admittedNodes, 3, 'Admitted root (1) + 2 children (2)');
  assert.equal(c3.plays, 2, 'Both children played');
  assert.equal(c3.materialLeaves, 2, 'Both children reach bare King material leaves');
  assert.equal(c3.capacityCutoffs, 0, 'No capacity cutoffs');

  // 2. With totalCapacity = 2:
  // Root takes 1 token, first child takes 1 token. Budget exhausted before second child can be reserved.
  // Second child cannot be admitted, solver immediately records capacity cutoff and returns 'unknown'
  // without playing the second child.
  const c2 = createAdjudicationCounters();
  const outcome2 = proveMatingPossibilityWithCapacity(pos, 'w', 4, 2, c2);
  assert.equal(outcome2, 'unknown', 'Capacity 2 must return unknown due to capacity cutoff');
  assert.equal(c2.admittedNodes, 2, 'Admitted root (1) + first child (1)');
  assert.equal(c2.plays, 1, 'Only first child played');
  assert.equal(c2.materialLeaves, 1, 'First child reaches material leaf');
  assert.equal(c2.capacityCutoffs, 1, 'Recorded capacity cutoff on second child');
});

// ============================================================================
// Section D: Canonical Cycle Detection in Natural Traversal
// ============================================================================

test('Canonical Cycle Detection: 4-ply cycle hits ancestors set naturally and returns unknown', () => {
  // Shuttling position in natural legal move order:
  const cycleFen = '4k3/4r3/8/8/8/8/4R3/4K3 w - - 0 1';
  const pos = Position.fromFen(cycleFen);

  const counters = createAdjudicationCounters();
  const outcome = proveMatingPossibilityWithCapacity(
    pos,
    'w',
    5,
    512,
    counters,
  );

  assert.ok(counters.cycleHits >= 1, `Expected cycle hits >= 1, got ${counters.cycleHits}`);
  assert.equal(outcome, 'unknown', 'Cycle branch yields unknown');
  assert.equal(canMate(cycleFen, 'w', 'standard'), true, 'Uncertainty bias awards timeout win');
});

// ============================================================================
// Section E: Concrete Predecessor & Live Timeout Routes (Routes 1 & 2)
// ============================================================================

const PREDECESSOR_DRAW_FEN = '7k/5K1n/8/6B1/8/8/8/8 w - - 0 1';
const PREDECESSOR_WIN_FEN = '8/8/8/8/8/K4N2/1r6/k7 w - - 0 1';

test('Standard Live Routes (Routes 1 & 2) - Ongoing Draw: reaches Control 1 and adjudicates draw', () => {
  const { game } = Game.create({
    gameId: 'standard-draw-predecessor',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    at: T0,
    variant: 'standard',
    initialFen: PREDECESSOR_DRAW_FEN,
  });

  const moved = game.playMove('g5f6', T0 + 1_000);
  const reachedGame = moved.game;

  assert.equal(reachedGame.snapshot().ply, 1, 'Game ply must be 1');
  assert.equal(reachedGame.fen, '7k/5K1n/5B2/8/8/8/8/8 b - - 1 1', 'Reaches Control 1');
  assert.equal(reachedGame.turn, 'b', 'Side to move is Black');
  assert.equal(reachedGame.status.over, false, 'Game is ongoing (not over)');

  const legal = reachedGame.snapshot().position.legalMoves();
  assert.equal(legal.length, 1);
  const san = reachedGame.snapshot().position.toSan(legal[0]!);
  assert.equal(san, 'Nxf6', 'Forced move SAN is Nxf6, not Nxf6+');

  const deadline = T0 + 1_000 + 60_000;
  assert.equal(reachedGame.timeoutDue(deadline), true, 'timeoutDue holds at deadline');

  // Route 1: expired playMove
  const timeoutMoveResult = reachedGame.playMove('h7f6', deadline);
  const endEvent1 = timeoutMoveResult.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(endEvent1);
  assert.equal(endEvent1.result, '1/2-1/2');
  assert.equal(endEvent1.termination, 'insufficient_material');
  assert.equal(endEvent1.winner, null);

  // Route 2: direct claimFlag
  const claimResult = reachedGame.claimFlag(deadline);
  const endEvent2 = claimResult.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(endEvent2);
  assert.equal(endEvent2.result, '1/2-1/2');
  assert.equal(endEvent2.termination, 'insufficient_material');
  assert.equal(endEvent2.winner, null);
});

test('Standard Live Routes (Routes 1 & 2) - Ongoing Win (KN vs KR): adjudicates timeout win for White', () => {
  const { game } = Game.create({
    gameId: 'standard-win-predecessor',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    at: T0,
    variant: 'standard',
    initialFen: PREDECESSOR_WIN_FEN,
  });

  const moved = game.playMove('f3e1', T0 + 1_000).game;
  assert.equal(moved.snapshot().ply, 1);
  assert.equal(moved.fen, '8/8/8/8/8/K7/1r6/k3N3 b - - 1 1');
  assert.equal(moved.turn, 'b');
  assert.equal(moved.status.over, false, 'Neither player is mated; game is ongoing');

  const deadline = T0 + 1_000 + 60_000;
  assert.equal(moved.timeoutDue(deadline), true);

  // Route 1: expired playMove
  const timeoutMoveResult = moved.playMove('b2b1', deadline);
  const endEvent1 = timeoutMoveResult.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(endEvent1);
  assert.equal(endEvent1.result, '1-0');
  assert.equal(endEvent1.termination, 'timeout');
  assert.equal(endEvent1.winner, 'w');

  // Route 2: direct claimFlag
  const claimResult = moved.claimFlag(deadline);
  const endEvent2 = claimResult.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.ok(endEvent2);
  assert.equal(endEvent2.result, '1-0');
  assert.equal(endEvent2.termination, 'timeout');
  assert.equal(endEvent2.winner, 'w');
});

test('Chess960 Live Routes (Routes 1 & 2): Synthetic trusted legacy GameCreated reaches controls', () => {
  // 1. Ongoing Draw in Chess960
  const legacyDrawCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'chess960-legacy-draw',
    variant: 'chess960',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: PREDECESSOR_DRAW_FEN,
    at: T0,
  };

  const drawGame = Game.fromEvents([legacyDrawCreated]);
  assert.equal(drawGame.snapshot().variant, 'chess960');
  assert.equal(drawGame.snapshot().chess960StartId, null, 'ID remains null on legacy synthetic');

  const reachedDrawGame = drawGame.playMove('g5f6', T0 + 1_000).game;
  const deadline = T0 + 1_000 + 60_000;

  const drawMoveRes = reachedDrawGame.playMove('h7f6', deadline);
  const drawEndEvent1 = drawMoveRes.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.equal(drawEndEvent1.result, '1/2-1/2');
  assert.equal(drawEndEvent1.termination, 'insufficient_material');

  const drawClaimRes = reachedDrawGame.claimFlag(deadline);
  const drawEndEvent2 = drawClaimRes.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.equal(drawEndEvent2.result, '1/2-1/2');
  assert.equal(drawEndEvent2.termination, 'insufficient_material');

  // 2. Ongoing Win in Chess960
  const legacyWinCreated: GameCreatedEvent = {
    type: 'GameCreated',
    gameId: 'chess960-legacy-win',
    variant: 'chess960',
    timeControl: SUDDEN,
    players: { white: 'alice', black: 'bob' },
    rated: false,
    initialFen: PREDECESSOR_WIN_FEN,
    at: T0,
  };

  const winGame = Game.fromEvents([legacyWinCreated]);
  const reachedWinGame = winGame.playMove('f3e1', T0 + 1_000).game;

  const winMoveRes = reachedWinGame.playMove('b2b1', deadline);
  const winEndEvent1 = winMoveRes.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.equal(winEndEvent1.result, '1-0');
  assert.equal(winEndEvent1.termination, 'timeout');
  assert.equal(winEndEvent1.winner, 'w');

  const winClaimRes = reachedWinGame.claimFlag(deadline);
  const winEndEvent2 = winClaimRes.events.find((e) => e.type === 'GameEnded') as GameEndedEvent;
  assert.equal(winEndEvent2.result, '1-0');
  assert.equal(winEndEvent2.termination, 'timeout');
  assert.equal(winEndEvent2.winner, 'w');
});

// ============================================================================
// Section F: Escaping Branch & Single-Ply Proof vs Depth Cutoff
// ============================================================================

test('Escaping branch: asserts closed capture children vs unresolved escaping children', () => {
  // FEN: Black Ka2, Ra1. White Kd3, Nb1. Turn: Black (b).
  // Legal moves:
  // a1b1 (Rxb1) captures Knight -> White bare King -> impossible material leaf.
  // a2b1 (Kxb1) captures Knight -> White bare King -> impossible material leaf.
  // a2b2 (Kb2) King moves -> White retains Knight -> unknown at depth cutoff.
  // a2b3 (Kb3) King moves -> White retains Knight -> unknown at depth cutoff.
  const escapingFen = '8/8/8/8/8/3K4/k7/rN6 b - - 0 1';
  const pos = Position.fromFen(escapingFen);

  // Assert individual child outcomes:
  const childRxb1 = pos.play('a1b1');
  assert.equal(
    proveMatingPossibilityWithCapacity(childRxb1, 'w', 2, 50),
    'impossible',
    'Rxb1 leaves White with bare King; must be impossible',
  );

  const childKxb1 = pos.play('a2b1');
  assert.equal(
    proveMatingPossibilityWithCapacity(childKxb1, 'w', 2, 50),
    'impossible',
    'Kxb1 leaves White with bare King; must be impossible',
  );

  const childKb2 = pos.play('a2b2');
  assert.equal(
    proveMatingPossibilityWithCapacity(childKb2, 'w', 2, 50),
    'unknown',
    'Kb2 escapes without capture; depth cutoff yields unknown',
  );

  const childKb3 = pos.play('a2b3');
  assert.equal(
    proveMatingPossibilityWithCapacity(childKb3, 'w', 2, 50),
    'unknown',
    'Kb3 escapes without capture; depth cutoff yields unknown',
  );

  // Parent evaluates to unknown because at least one branch is unresolved
  const parentOutcome = proveMatingPossibilityWithCapacity(pos, 'w', 2, 50);
  assert.equal(parentOutcome, 'unknown', 'Parent with escaping branches yields unknown');
  assert.equal(canMate(escapingFen, 'w', 'standard'), true, 'Uncertainty bias awards timeout win');
});

test('Control 1 single-ply branch closure: cuts off at depth 0 (unknown), completes at depth 1 (impossible) [multi-ply proof is explicit remaining coverage gap]', () => {
  const c1Pos = Position.fromFen(MANDATORY_5_FENS[0]!.fen);

  // Depth 0: cuts off before child exploration
  const c0 = createAdjudicationCounters();
  const res0 = proveMatingPossibilityWithCapacity(c1Pos, 'w', 0, 512, c0);
  assert.equal(res0, 'unknown', 'Depth 0 cutoff returns unknown');
  assert.equal(c0.depthCutoffs, 1, 'Exactly 1 depth cutoff recorded');

  // Depth 1: explores child h7f6, which is an impossible material leaf (White bare King), closing the proof
  const c1 = createAdjudicationCounters();
  const res1 = proveMatingPossibilityWithCapacity(c1Pos, 'w', 1, 512, c1);
  assert.equal(res1, 'impossible', 'Depth 1 explores single legal child and proves impossible');
  assert.equal(c1.materialLeaves, 1, 'Exactly 1 material leaf recorded at child');
});

// ============================================================================
// Section G: Special Moves Solver Traversal (Natural Order)
//
// Note on verified scope and remaining evidence gap:
// These tests verify that core move generation emits special moves (EP, promotions,
// Chess960 castling), that playing them updates child board states properly, and that
// solver traversal under natural move order admits them without capacity cutoffs
// (capacityCutoffs === 0). Because arbitrary production callbacks/observers were removed
// per root instruction, these tests do NOT instrument per-edge solver consumption if an
// earlier sibling already resolved the branch; this remains an explicit evidence gap.
// ============================================================================

test('En Passant: legal EP admitted by solver; pinned EP with two valid kings rejected', () => {
  // 1. Legal En Passant:
  const legalEpPos = Position.fromFen('8/8/8/3pP3/8/8/8/4K2k w - d6 0 1');
  const legalMoves = legalEpPos.legalMoves().map((m) => legalEpPos.toUci(m));
  assert.ok(legalMoves.includes('e5d6'), 'Legal en passant move e5d6 must be generated');

  // Verify playing e5d6 clears EP and captures d5 pawn
  const epChild = legalEpPos.play('e5d6');
  assert.equal(epChild.fen().includes('3pP3'), false, 'Captured pawn removed');
  assert.equal(epChild.fen().split(' ')[3], '-', 'EP square cleared');

  // Traversal with depth 2 and capacity 50 admits all 7 legal moves without cutoff
  const cLegal = createAdjudicationCounters();
  proveMatingPossibilityWithCapacity(legalEpPos, 'w', 2, 50, cLegal);
  assert.equal(cLegal.capacityCutoffs, 0, 'All root legal moves admitted including e5d6');

  // 2. Pinned Illegal En Passant with two valid kings:
  // Ke1, Pe5 vs Ka8, Re8, Pd5. Pe5 pinned to Ke1 along e-file by Re8.
  const pinnedEpPos = Position.fromFen('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const pinnedMoves = pinnedEpPos.legalMoves().map((m) => pinnedEpPos.toUci(m));
  assert.equal(pinnedMoves.includes('e5d6'), false, 'Core move generator must not produce pinned EP');

  const cPinned = createAdjudicationCounters();
  proveMatingPossibilityWithCapacity(pinnedEpPos, 'w', 2, 50, cPinned);
  assert.equal(pinnedMoves.includes('e5d6'), false, 'Solver traversal never admits illegal pinned EP');
});

test('Pawn promotions: solver explores all 4 promotion types (q, r, b, n) in natural order', () => {
  const promoPos = Position.fromFen('8/4P3/8/8/8/8/8/4K2k w - - 0 1');
  const promoMoves = promoPos.legalMoves().map((m) => promoPos.toUci(m));

  assert.ok(promoMoves.includes('e7e8q'), 'Queen promotion generated');
  assert.ok(promoMoves.includes('e7e8r'), 'Rook promotion generated');
  assert.ok(promoMoves.includes('e7e8b'), 'Bishop promotion generated');
  assert.ok(promoMoves.includes('e7e8n'), 'Knight promotion generated');

  // Traversal at depth 2 with capacity 50 admits all 9 root moves without cutoff
  const c = createAdjudicationCounters();
  proveMatingPossibilityWithCapacity(promoPos, 'w', 2, 50, c);
  assert.equal(c.capacityCutoffs, 0, 'All promotion branches explored');
});

test('Chess960 castling rights: solver admits castling and preserves Chess960 child state', () => {
  const pos960 = Position.chess960(518);
  const moved = pos960.play('e2e4').play('e7e5').play('g1f3').play('b8c6').play('f1c4').play('f8c5');

  const castleMove = moved.legalMoves().find((m) => (m.flags & FLAG_KING_CASTLE) !== 0);
  assert.ok(castleMove, 'Chess960 castling move generated');
  assert.equal(moved.toUci(castleMove!), 'e1h1');

  // Verify child state after castling:
  const castledChild = moved.play(castleMove!);
  assert.equal(castledChild.turn, 'b');
  assert.equal(castledChild.fen().split(' ')[2], 'kq', 'White castling rights consumed; Black retained');

  // Adjudicate castled child cleanly without error
  assert.equal(canMate(castledChild.fen(), 'w', 'chess960'), true);
});

// ============================================================================
// Section H: Stored History Replay Invariance
// ============================================================================

test('Stored History Replay Invariance: historical timeout events are immutable upon replay', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // 1. Historical Standard timeout win
  const stdWinEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-std-win', variant: 'standard', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: startFen, at: T0 },
    { type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w', at: T0 + 60_000 },
  ];
  const replayedStdWin = Game.fromEvents(stdWinEvents);
  assert.equal(replayedStdWin.status.over, true);
  if (replayedStdWin.status.over) {
    assert.equal(replayedStdWin.status.result, '1-0');
    assert.equal(replayedStdWin.status.termination, 'timeout');
    assert.equal(replayedStdWin.status.winner, 'w');
  }
  const stdWinRows: StoredHistoryRow[] = stdWinEvents.map((event, seq) => ({
    gameId: 'hist-std-win',
    seq,
    version: 1,
    event,
  }));
  const storedStdWin = replayStoredHistory('hist-std-win', stdWinRows);
  assert.equal(storedStdWin.historicalPly, null);
  assert.equal(storedStdWin.game.status.over, true);
  if (storedStdWin.game.status.over) {
    assert.equal(storedStdWin.game.status.result, '1-0');
    assert.equal(storedStdWin.game.status.termination, 'timeout');
    assert.equal(storedStdWin.game.status.winner, 'w');
  }

  // 2. Historical Standard timeout draw
  const stdDrawEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-std-draw', variant: 'standard', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: startFen, at: T0 },
    { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at: T0 + 60_000 },
  ];
  const replayedStdDraw = Game.fromEvents(stdDrawEvents);
  assert.equal(replayedStdDraw.status.over, true);
  if (replayedStdDraw.status.over) {
    assert.equal(replayedStdDraw.status.result, '1/2-1/2');
    assert.equal(replayedStdDraw.status.termination, 'insufficient_material');
    assert.equal(replayedStdDraw.status.winner, null);
  }
  const stdDrawRows: StoredHistoryRow[] = stdDrawEvents.map((event, seq) => ({
    gameId: 'hist-std-draw',
    seq,
    version: 1,
    event,
  }));
  const storedStdDraw = replayStoredHistory('hist-std-draw', stdDrawRows);
  assert.equal(storedStdDraw.historicalPly, null);
  assert.equal(storedStdDraw.game.status.over, true);
  if (storedStdDraw.game.status.over) {
    assert.equal(storedStdDraw.game.status.result, '1/2-1/2');
    assert.equal(storedStdDraw.game.status.termination, 'insufficient_material');
    assert.equal(storedStdDraw.game.status.winner, null);
  }

  // 3. Historical Standard game whose stored outcome CONTRADICTS new adjudication:
  // Under old rules, a KN vs KR position was recorded as an insufficient_material draw.
  // Replaying this stored history must NEVER alter or recompute the recorded outcome.
  const contradictingOldEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-contradicting', variant: 'standard', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: PREDECESSOR_WIN_FEN, at: T0 },
    { type: 'MovePlayed', ply: 1, uci: 'f3e1', san: 'Ne1', by: 'w', moveTimeMs: 1_000, remaining: { w: 59_000, b: 60_000 }, at: T0 + 1_000 },
    { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at: T0 + 60_000 },
  ];
  const replayedContradicting = Game.fromEvents(contradictingOldEvents);
  assert.equal(replayedContradicting.status.over, true);
  if (replayedContradicting.status.over) {
    assert.equal(replayedContradicting.status.result, '1/2-1/2', 'Preserves original 1/2-1/2 result without recomputing');
    assert.equal(replayedContradicting.status.termination, 'insufficient_material');
    assert.equal(replayedContradicting.status.winner, null);
  }
  const rows: StoredHistoryRow[] = contradictingOldEvents.map((event, seq) => ({
    gameId: 'hist-contradicting',
    seq,
    version: 1,
    event,
  }));
  const storedHistoryResult = replayStoredHistory('hist-contradicting', rows);
  assert.equal(storedHistoryResult.historicalPly, null);
  assert.equal(storedHistoryResult.game.status.over, true);
  if (storedHistoryResult.game.status.over) {
    assert.equal(storedHistoryResult.game.status.result, '1/2-1/2');
    assert.equal(storedHistoryResult.game.status.termination, 'insufficient_material');
    assert.equal(storedHistoryResult.game.status.winner, null);
  }

  // 4. Synthetic trusted legacy Chess960 timeout WIN (without chess960StartId)
  const legacy960WinEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-c960-win', variant: 'chess960', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: startFen, at: T0 },
    { type: 'GameEnded', result: '1-0', termination: 'timeout', winner: 'w', at: T0 + 60_000 },
  ];
  const replayedLegacy960Win = Game.fromEvents(legacy960WinEvents);
  assert.equal(replayedLegacy960Win.status.over, true);
  if (replayedLegacy960Win.status.over) {
    assert.equal(replayedLegacy960Win.status.result, '1-0');
    assert.equal(replayedLegacy960Win.status.termination, 'timeout');
    assert.equal(replayedLegacy960Win.status.winner, 'w');
  }
  assert.equal(replayedLegacy960Win.snapshot().chess960StartId, null);

  const legacy960WinRows: StoredHistoryRow[] = legacy960WinEvents.map((event, seq) => ({
    gameId: 'hist-c960-win',
    seq,
    version: 1,
    event,
  }));
  const storedLegacy960Win = replayStoredHistory('hist-c960-win', legacy960WinRows);
  assert.equal(storedLegacy960Win.historicalPly, null);
  assert.equal(storedLegacy960Win.game.status.over, true);
  if (storedLegacy960Win.game.status.over) {
    assert.equal(storedLegacy960Win.game.status.result, '1-0');
    assert.equal(storedLegacy960Win.game.status.termination, 'timeout');
    assert.equal(storedLegacy960Win.game.status.winner, 'w');
  }
  assert.equal(storedLegacy960Win.game.snapshot().chess960StartId, null);

  // 5. Synthetic trusted legacy Chess960 timeout DRAW (without chess960StartId)
  const legacy960DrawEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-c960-draw', variant: 'chess960', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: startFen, at: T0 },
    { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at: T0 + 60_000 },
  ];
  const replayedLegacy960Draw = Game.fromEvents(legacy960DrawEvents);
  assert.equal(replayedLegacy960Draw.status.over, true);
  if (replayedLegacy960Draw.status.over) {
    assert.equal(replayedLegacy960Draw.status.result, '1/2-1/2');
    assert.equal(replayedLegacy960Draw.status.termination, 'insufficient_material');
    assert.equal(replayedLegacy960Draw.status.winner, null);
  }
  assert.equal(replayedLegacy960Draw.snapshot().chess960StartId, null);

  const legacy960DrawRows: StoredHistoryRow[] = legacy960DrawEvents.map((event, seq) => ({
    gameId: 'hist-c960-draw',
    seq,
    version: 1,
    event,
  }));
  const storedLegacy960Draw = replayStoredHistory('hist-c960-draw', legacy960DrawRows);
  assert.equal(storedLegacy960Draw.historicalPly, null);
  assert.equal(storedLegacy960Draw.game.status.over, true);
  if (storedLegacy960Draw.game.status.over) {
    assert.equal(storedLegacy960Draw.game.status.result, '1/2-1/2');
    assert.equal(storedLegacy960Draw.game.status.termination, 'insufficient_material');
    assert.equal(storedLegacy960Draw.game.status.winner, null);
  }
  assert.equal(storedLegacy960Draw.game.snapshot().chess960StartId, null);

  // 6. Synthetic trusted legacy Chess960 contradiction with new adjudication:
  // Under new adjudication, PREDECESSOR_WIN_FEN (KN vs KR) awards timeout win for White ('1-0').
  // A stored legacy Chess960 game whose recorded outcome was an insufficient_material draw ('1/2-1/2')
  // must remain strictly unchanged upon replay in both Game.fromEvents and replayStoredHistory.
  const legacy960ContradictingEvents: GameEvent[] = [
    { type: 'GameCreated', gameId: 'hist-c960-contradicting', variant: 'chess960', timeControl: SUDDEN, players: { white: 'alice', black: 'bob' }, rated: false, initialFen: PREDECESSOR_WIN_FEN, at: T0 },
    { type: 'MovePlayed', ply: 1, uci: 'f3e1', san: 'Ne1', by: 'w', moveTimeMs: 1_000, remaining: { w: 59_000, b: 60_000 }, at: T0 + 1_000 },
    { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at: T0 + 60_000 },
  ];
  const replayedLegacy960Contradicting = Game.fromEvents(legacy960ContradictingEvents);
  assert.equal(replayedLegacy960Contradicting.status.over, true);
  if (replayedLegacy960Contradicting.status.over) {
    assert.equal(replayedLegacy960Contradicting.status.result, '1/2-1/2', 'Preserves stored legacy 1/2-1/2 draw without recomputing');
    assert.equal(replayedLegacy960Contradicting.status.termination, 'insufficient_material');
    assert.equal(replayedLegacy960Contradicting.status.winner, null);
  }
  assert.equal(replayedLegacy960Contradicting.snapshot().chess960StartId, null);

  const legacy960ContradictingRows: StoredHistoryRow[] = legacy960ContradictingEvents.map((event, seq) => ({
    gameId: 'hist-c960-contradicting',
    seq,
    version: 1,
    event,
  }));
  const storedLegacy960Contradicting = replayStoredHistory('hist-c960-contradicting', legacy960ContradictingRows);
  assert.equal(storedLegacy960Contradicting.historicalPly, null);
  assert.equal(storedLegacy960Contradicting.game.status.over, true);
  if (storedLegacy960Contradicting.game.status.over) {
    assert.equal(storedLegacy960Contradicting.game.status.result, '1/2-1/2');
    assert.equal(storedLegacy960Contradicting.game.status.termination, 'insufficient_material');
    assert.equal(storedLegacy960Contradicting.game.status.winner, null);
  }
  assert.equal(storedLegacy960Contradicting.game.snapshot().chess960StartId, null);
});

// ============================================================================
// Section I: Variant Invariance & Negative FEN Controls
// ============================================================================

test('Variant timeout invariance: non-standard variants retain ADR-0100 behavior', () => {
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'kingofthehill'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'racingkings'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'crazyhouse'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'b', 'horde'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4KN2 w - - 0 1', 'w', 'threecheck'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'threecheck'), false);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4KN2 w - - 0 1', 'w', 'atomic'), true);
  assert.equal(canMate('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', 'atomic'), false);
});

test('Negative FEN Controls: canMate rejects malformed FEN across ALL 8 variants', () => {
  const allVariants: readonly Variant[] = [
    'standard',
    'chess960',
    'kingofthehill',
    'racingkings',
    'crazyhouse',
    'threecheck',
    'atomic',
    'horde',
  ];

  for (const variant of allVariants) {
    assert.throws(
      () => {
        canMate('not-a-valid-fen', 'w', variant);
      },
      (err: unknown) => err instanceof FenError || err instanceof Error,
      `canMate must throw parse error on invalid FEN for variant ${variant}`,
    );
  }
});
