/**
 * Atomic legality (#127). A capture explodes the capturer and every adjacent non-pawn, so:
 * - a king can never capture (it would explode itself), even when the blast also takes the enemy king;
 * - no move may destroy the mover's own king, whatever else it destroys;
 * - kings standing next to each other ("connected") cannot be in check, because neither may capture.
 * The reference is python-chess `AtomicBoard`; `fixtures/atomic-reference.json` holds its legal-move
 * sets ([fen, "uci ..."] rows) from seeded random and king-steered walks plus targeted positions.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyMove, findKing, generateLegalMoves, generatePseudoLegal, isSquareAttacked, inCheck } from '../src/movegen';
import { Position } from '../src/position';
import { opposite } from '../src/board';
import type { Color, PositionState, Variant } from '../src/types';

const legalUcis = (p: Position) => p.legalMoves().map((m) => p.toUci(m)).sort();
const kingCount = (s: PositionState) => (findKing(s, 'w') === -1 ? 0 : 1) + (findKing(s, 'b') === -1 ? 0 : 1);

function playLine(ucis: string): Position {
  let p = Position.initial('atomic');
  for (const u of ucis.split(' ')) p = p.play(u);
  return p;
}

test('atomic: a king may not capture next to the enemy king (the #127 line)', () => {
  const p = playLine('e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5');
  const legal = legalUcis(p);
  assert.ok(!legal.includes('d4e5'), 'Kxe5 would explode both kings and must not be generated');
  assert.throws(() => p.play('d4e5'), /Illegal move/);
  // The kings may stand connected: d5 and c5 touch the black king on d6.
  assert.ok(legal.includes('d4d5'));
  assert.ok(legal.includes('d4c5'));
});

test('atomic: a king never captures, near the enemy king or not', () => {
  for (const fen of ['8/8/8/8/3p4/3K4/8/7k w - - 0 1', '8/8/3k4/3p4/3K4/8/8/8 w - - 0 1', '8/8/8/3k4/2pK4/8/8/8 w - - 0 1']) {
    const p = Position.fromFen(fen, 'atomic');
    for (const m of p.legalMoves()) {
      assert.ok(!(m.piece === 'K' && m.captured), `${fen}: king capture ${p.toUci(m)} generated`);
    }
  }
});

test('atomic: a capture that explodes both kings is illegal', () => {
  // Nf4xd5 explodes d4 (white king) and d6 (black king).
  const p = Position.fromFen('8/8/3k4/3n4/3K1N2/8/8/8 w - - 0 1', 'atomic');
  assert.ok(!legalUcis(p).includes('f4d5'));
  assert.throws(() => p.play('f4d5'), /Illegal move/);
});

test('atomic: a capture that explodes only the enemy king is legal and wins', () => {
  const p = Position.fromFen('8/8/3k4/3n4/5N2/8/8/K7 w - - 0 1', 'atomic');
  const after = p.play('f4d5');
  assert.deepEqual(after.status(), { over: true, reason: 'variant_win', winner: 'w' });
});

test('atomic: connected kings are never in check, and a king may walk into connection', () => {
  const connected = Position.fromFen('8/8/8/3k4/3K4/8/8/3r4 w - - 0 1', 'atomic');
  assert.equal(connected.isCheck(), false, 'the rook on d1 cannot check a king connected to its own king');
  assert.ok(connected.legalMoves().length > 0, 'connected kings: not checkmated');
  // The rook on a5 attacks c5, d5 and e5, but each of them touches the black king on d6.
  const into = Position.fromFen('8/8/3k4/r7/3K4/8/8/8 w - - 0 1', 'atomic');
  const intoLegal = legalUcis(into);
  for (const u of ['d4c5', 'd4d5', 'd4e5']) assert.ok(intoLegal.includes(u), `${u} connects the kings and is legal`);
});

test('atomic: castling through squares next to the enemy king is allowed', () => {
  const p = Position.fromFen('8/8/8/8/8/8/5k2/R3K2R w KQ - 0 1', 'atomic');
  assert.ok(legalUcis(p).includes('e1g1'), 'every square on the king path touches the black king');
});

test('atomic: chess-core legal moves equal python-chess on the reference fixture', () => {
  const rows = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'atomic-reference.json'), 'utf8'),
  ) as [string, string][];
  assert.ok(rows.length > 3000, 'fixture present');
  let connected = 0;
  const diffs: string[] = [];
  for (const [fen, ref] of rows) {
    const p = Position.fromFen(fen, 'atomic');
    const s = p.snapshot();
    const wk = findKing(s, 'w');
    const bk = findKing(s, 'b');
    if (Math.max(Math.abs((wk & 7) - (bk & 7)), Math.abs((wk >> 4) - (bk >> 4))) === 1) connected++;
    const mine = legalUcis(p).join(' ');
    if (mine !== ref) diffs.push(`${fen}\n  core: ${mine}\n  ref:  ${ref}`);
  }
  assert.ok(connected > 1000, `fixture must exercise connected kings (got ${connected})`);
  assert.equal(diffs.length, 0, `${diffs.length} positions differ, first:\n${diffs.slice(0, 3).join('\n')}`);
});

// --- The replay-compatibility invariant (#127 Design B) --------------------------------------------
// Frozen copy of the pre-#127 atomic legality predicate. Do not "fix" it: it documents what the old
// engine accepted, which is what the stored-history replay boundary has to account for.
function oldAtomicLegalAfter(after: PositionState, us: Color): boolean {
  const them = opposite(us);
  const myKing = findKing(after, us);
  if (findKing(after, them) === -1) return true;
  if (myKing === -1) return false;
  return !isSquareAttacked(after, myKing, them);
}

function assertOnlyKinglessMovesLost(state: PositionState, where: string): void {
  const now = new Set(generateLegalMoves(state).map((m) => `${m.from}-${m.to}-${m.promotion ?? ''}`));
  for (const move of generatePseudoLegal(state)) {
    const after = applyMove(state, move);
    if (!oldAtomicLegalAfter(after, state.turn)) continue;
    if (now.has(`${move.from}-${move.to}-${move.promotion ?? ''}`)) continue;
    assert.equal(kingCount(after), 0, `${where}: a move the old engine accepted and the new one rejects left a king`);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('atomic invariant: every move the old engine accepted and the new rejects leaves zero kings (fixture + seeded play)', () => {
  const rows = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'atomic-reference.json'), 'utf8'),
  ) as [string, string][];
  for (const [fen] of rows) assertOnlyKinglessMovesLost(Position.fromFen(fen, 'atomic').snapshot(), fen);
  const rand = mulberry32(127);
  for (let g = 0; g < 150; g++) {
    let p = Position.initial('atomic');
    for (let ply = 0; ply < 120 && !p.status().over; ply++) {
      assertOnlyKinglessMovesLost(p.snapshot(), `game ${g} ply ${ply}`);
      const moves = p.legalMoves();
      p = p.play(moves[Math.floor(rand() * moves.length)]!);
    }
  }
});

test('atomic invariant: the new check relation is a subset of the old attack relation (exhaustive, two kings + one attacker)', () => {
  // Scoped evidence only: every placement of both kings and one non-king attacker of either colour.
  // It is not a proof for arbitrary multi-piece positions; the fixture and seeded-play tests cover those.
  const squares: number[] = [];
  for (let sq = 0; sq < 128; sq++) if ((sq & 0x88) === 0) squares.push(sq);
  const base = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'atomic').snapshot();
  const board = base.board.map(() => null) as PositionState['board'];
  const state: PositionState = { ...base, board };
  let checked = 0;
  for (const wk of squares) {
    board[wk] = 'K';
    for (const bk of squares) {
      if (bk === wk) continue;
      board[bk] = 'k';
      for (const piece of ['Q', 'R', 'B', 'N', 'P', 'q', 'r', 'b', 'n', 'p'] as const) {
        for (const sq of squares) {
          if (sq === wk || sq === bk) continue;
          if ((piece === 'P' || piece === 'p') && ((sq >> 4) === 0 || (sq >> 4) === 7)) continue;
          board[sq] = piece;
          for (const color of ['w', 'b'] as const) {
            const k = color === 'w' ? wk : bk;
            if (inCheck(state, color)) assert.ok(isSquareAttacked(state, k, opposite(color)));
            checked++;
          }
          board[sq] = null;
        }
      }
      board[bk] = null;
    }
    board[wk] = null;
  }
  assert.equal(checked, 4_749_696, 'every placement of both kings and one attacker, for both sides');
});

test('non-atomic variants keep the old check relation exactly', () => {
  const variants: Variant[] = ['standard', 'chess960', 'crazyhouse', 'threecheck', 'kingofthehill'];
  // Connected kings are impossible in legal non-atomic play, but `inCheck` must stay the plain
  // attack test for every variant other than atomic (horde and racing kings use the same code path).
  for (const variant of variants) {
    const s = Position.fromFen('8/8/8/3k4/3K4/8/8/3r4 w - - 0 1', variant).snapshot();
    assert.equal(inCheck(s, 'w'), true, variant);
  }
});
