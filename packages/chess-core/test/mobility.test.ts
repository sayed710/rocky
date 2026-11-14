import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position, computeMobility } from '../src';
import { sq0x88To64, sq64To0x88, type OriginalPiece } from '../src/mobility';

test('square index bijection between 0x88 and 0..63', () => {
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const sq64 = sq0x88To64(sq);
    assert.ok(sq64 >= 0 && sq64 < 64);
    assert.equal(sq64To0x88(sq64), sq);
  }
});

test('mobility saturation on locked pawn structure (Line 14)', () => {
  // Line 14: 2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mob = computeMobility(pos.snapshot());
  if (!mob) throw new Error('Expected mobility solution');
  assert.equal(mob.saturated, true);
  assert.ok(mob.steps > 0);

  // All 8 pawns must be completely steady (never move, never cleared)
  for (let i = 0; i < mob.pieces.length; i++) {
    const p: OriginalPiece = mob.pieces[i];
    if (p.type === 'p') {
      assert.equal(mob.isCleared(p.id), false, `Pawn on sq ${p.sq64} should not be cleared`);
      const reg = mob.region(p.id);
      assert.deepEqual(reg, [p.sq64], `Pawn on sq ${p.sq64} can only reach its own square`);
    }
  }

  // White king and Black king regions must be disjoint
  const whiteKing = mob.pieces.find((p) => p.type === 'k' && p.color === 'w')!;
  const blackKing = mob.pieces.find((p) => p.type === 'k' && p.color === 'b')!;
  assert.ok(whiteKing && blackKing);

  const wkRegion = mob.region(whiteKing.id);
  const bkRegion = mob.region(blackKing.id);

  for (const s of wkRegion) {
    assert.ok(!bkRegion.includes(s), `Square ${s} should not be in both king regions`);
    const r = s >> 3;
    assert.ok(r <= 3, `White king should not penetrate past rank 4 (rank index <= 3), got rank ${r}`);
  }

  for (const s of bkRegion) {
    const r = s >> 3;
    assert.ok(r >= 4, `Black king should not penetrate below rank 5 (rank index >= 4), got rank ${r}`);
  }
});

test('piece clearance: a movable piece becomes cleared (C_P = 1)', () => {
  const pos = Position.fromFen('4k3/8/8/8/8/8/8/4K1N1 w - - 0 1');
  const mob = computeMobility(pos.snapshot());
  if (!mob) throw new Error('Expected mobility solution');
  assert.equal(mob.saturated, true);

  const knight = mob.pieces.find((p) => p.type === 'n')!;
  assert.equal(mob.isCleared(knight.id), true, 'Knight with legal moves is cleared');
  assert.ok(mob.region(knight.id).length > 1, 'Knight reaches multiple squares');
});

test('piece clearance: a captured piece becomes cleared (C_P = 1) via opponent capture isolation', () => {
  // Black pawn on a7 is surrounded by friendly black pawns on a6 and b6 (and b7).
  // At step 0, pawn on a7 is uncleared and on starting square [a7].
  // In step 1, pawn on a7 has not reached any other square (region is still strictly [a7]).
  // White knight on c6 reaches a7, setting C_P = 1 purely through Rule 3 Condition 2 (opponent capture),
  // proving clearance occurs without the piece having moved away from its origin.
  const pos = Position.fromFen('7k/pp6/ppN5/8/8/8/8/7K w - - 0 1');
  const mob0 = computeMobility(pos.snapshot(), 0)!;
  const mob1 = computeMobility(pos.snapshot(), 1)!;

  const p0 = mob0.pieces.find((p) => p.type === 'p' && p.color === 'b' && p.sq64 === ((6 << 3) | 0))!;
  const p1 = mob1.pieces.find((p) => p.type === 'p' && p.color === 'b' && p.sq64 === ((6 << 3) | 0))!;

  assert.equal(mob0.isCleared(p0.id), false, 'Initially uncleared at step 0');
  assert.deepEqual(mob0.region(p0.id), [p0.sq64], 'Pawn starts on its own square');

  // At step 1, pawn has still not moved to any other square (region strictly [a7])
  assert.deepEqual(mob1.region(p1.id), [p1.sq64], 'Pawn on a7 has not moved away at step 1');
  // Yet pawn is cleared solely by opponent knight reaching a7 (Rule 3 Condition 2)
  assert.equal(mob1.isCleared(p1.id), true, 'Black pawn capturable by knight is cleared by capture');
});

test('king attackers (Rule 5): king cannot move into direct enemy pawn attack without clearance', () => {
  // In Line 14, Black pawn on d5 is uncleared and attacks e4. White king cannot step onto e4.
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mob = computeMobility(pos.snapshot());
  if (!mob) throw new Error('Expected mobility solution');
  assert.equal(mob.saturated, true);

  const whiteKing = mob.pieces.find((p) => p.type === 'k' && p.color === 'w')!;
  const blackPawnD5 = mob.pieces.find((p) => p.type === 'p' && p.color === 'b' && p.sq64 === ((4 << 3) | 3))!;
  assert.equal(mob.isCleared(blackPawnD5.id), false, 'Black pawn on d5 is uncleared');

  // e4 square is 0..63 index: (3 << 3) | 4 = 28
  const e4_sq64 = (3 << 3) | 4;
  assert.ok(!mob.region(whiteKing.id).includes(e4_sq64), 'White king cannot reach e4 while pawn on d5 is uncleared');
});

test('not self-capture (Rule 6): piece cannot occupy square of uncleared friendly piece', () => {
  // In Line 14, White pawn on d4 is uncleared. Friendly White king and bishop cannot occupy d4.
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mob = computeMobility(pos.snapshot());
  if (!mob) throw new Error('Expected mobility solution');
  assert.equal(mob.saturated, true);

  const whitePawnD4 = mob.pieces.find((p) => p.type === 'p' && p.color === 'w' && p.sq64 === ((3 << 3) | 3))!;
  assert.equal(mob.isCleared(whitePawnD4.id), false);

  const whiteKing = mob.pieces.find((p) => p.type === 'k' && p.color === 'w')!;
  const whiteBishop = mob.pieces.find((p) => p.type === 'b' && p.color === 'w')!;
  const d4_sq64 = (3 << 3) | 3;

  assert.ok(!mob.region(whiteKing.id).includes(d4_sq64), 'White king cannot occupy d4 while friendly pawn is uncleared');
  assert.ok(!mob.region(whiteBishop.id).includes(d4_sq64), 'White bishop cannot occupy d4 while friendly pawn is uncleared');
});

test('pawn promotion: pawn reaching promotion rank expands reachable region conservatively', () => {
  // White pawn on e7 with open path to e8
  const pos = Position.fromFen('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1');
  const mob = computeMobility(pos.snapshot());
  if (!mob) throw new Error('Expected mobility solution');
  assert.equal(mob.saturated, true);

  const whitePawn = mob.pieces.find((p) => p.type === 'p' && p.color === 'w')!;
  const reg = mob.region(whitePawn.id);
  assert.ok(reg.length > 2, 'Pawn that can promote expands reachability');
});

test('step budget halts iteration deterministically when budget is exceeded', () => {
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mobBudget1 = computeMobility(pos.snapshot(), 1);
  if (!mobBudget1) throw new Error('Expected mobility solution');
  assert.equal(mobBudget1.saturated, false);
  assert.equal(mobBudget1.steps, 1);
});

test('budget 0 performs zero iterations and returns unsaturated solution', () => {
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mob0 = computeMobility(pos.snapshot(), 0);
  assert.ok(mob0 !== null, 'Budget 0 returns solution object');
  assert.equal(mob0.saturated, false, 'Budget 0 must be unsaturated');
  assert.equal(mob0.steps, 0, 'Budget 0 must have exactly 0 steps');
});

test('invalid step budgets (NaN, Infinity, negative, fractional) return null', () => {
  const snap = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1').snapshot();
  assert.equal(computeMobility(snap, Number.NaN), null, 'NaN budget returns null');
  assert.equal(computeMobility(snap, Number.POSITIVE_INFINITY), null, 'Infinity budget returns null');
  assert.equal(computeMobility(snap, -1), null, 'Negative budget returns null');
  assert.equal(computeMobility(snap, 1.5), null, 'Fractional budget returns null');
});

test('Lemma 8 rights/EP domain guards: castling rights and en passant decline mobility calculation', () => {
  const posCastling = Position.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(computeMobility(posCastling.snapshot()), null, 'Castling rights must decline mobility calculation');

  const posEp = Position.fromFen('4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1');
  assert.equal(computeMobility(posEp.snapshot()), null, 'Active en passant must decline mobility calculation');
});

test('returned region immutability: mutating returned region arrays does not alter internal caches', () => {
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const mob = computeMobility(pos.snapshot())!;
  const reg1 = mob.region(0);
  const origLen = reg1.length;
  // Mutate returned array
  (reg1 as number[]).length = 0;
  const reg2 = mob.region(0);
  assert.equal(reg2.length, origLen, 'Internal region cache must be protected against caller mutation');
});

test('unsupported variants and non-admitted states return null', () => {
  const pos = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'atomic');
  assert.equal(computeMobility(pos.snapshot()), null);

  const snap = Position.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').snapshot();
  snap.pockets.w.push('q');
  assert.equal(computeMobility(snap), null);
});
