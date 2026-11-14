import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Position,
  cloneState,
  isStaticallyUnwinnable,
} from '../src';

test('semi-static certificate proves Line 14 unwinnable for both White and Black', () => {
  // Line 14: 2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1');
  const whiteUnwinnable = isStaticallyUnwinnable(pos.snapshot(), 'w');
  const blackUnwinnable = isStaticallyUnwinnable(pos.snapshot(), 'b');

  assert.equal(whiteUnwinnable, true, 'White is provably unwinnable in Line 14');
  assert.equal(blackUnwinnable, true, 'Black is provably unwinnable in Line 14');
});

test('en passant guard: declines certificate when en passant square is active', () => {
  // Same locked pawn structure, but synthetic epSquare set
  const pos = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - e3 0 1');
  assert.equal(isStaticallyUnwinnable(pos.snapshot(), 'w'), false);
  assert.equal(isStaticallyUnwinnable(pos.snapshot(), 'b'), false);
});

test('castling rights guard: declines certificate when either player retains castling rights', () => {
  const posWithCastling = Position.fromFen('2b1k2r/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w k - 0 1');
  assert.equal(isStaticallyUnwinnable(posWithCastling.snapshot(), 'w'), false);
  assert.equal(isStaticallyUnwinnable(posWithCastling.snapshot(), 'b'), false);
});

test('non-bishop intruder guard: declines certificate if a non-bishop can reach enemy king region', () => {
  // Knight on b1 that has open passage into enemy territory
  const posWithKnight = Position.fromFen('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1');
  assert.equal(isStaticallyUnwinnable(posWithKnight.snapshot(), 'w'), false);
});

test('opposite-colored bishop intruders: declines certificate if intruders occupy both square colors', () => {
  // Two white bishops: c1 (dark square: rank 0, file 2) and f1 (light square: rank 0, file 5)
  // Both bishops can penetrate into open board territory containing black king
  const posWithTwoBishops = Position.fromFen('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1');
  assert.equal(isStaticallyUnwinnable(posWithTwoBishops.snapshot(), 'w'), false);
});

test('unrelated solution isolation: isStaticallyUnwinnable ignores external mobility and computes internally', () => {
  // Line 46: Black mate is reachable
  const reachable = Position.fromFen('8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1');
  // Semi-static certificate on reachable position must decline (return false)
  const isUnwinnable = isStaticallyUnwinnable(reachable.snapshot(), 'b');
  assert.equal(isUnwinnable, false, 'Reachable position must decline static unwinnability');
});

test('unsupported variants and invalid states decline certificate', () => {
  const posAtomic = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1', 'atomic');
  assert.equal(isStaticallyUnwinnable(posAtomic.snapshot(), 'w'), false);

  const posCrazyhouse = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1', 'crazyhouse');
  assert.equal(isStaticallyUnwinnable(posCrazyhouse.snapshot(), 'w'), false);

  const snapWithPocket = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1').snapshot();
  snapWithPocket.pockets.w.push('q');
  assert.equal(isStaticallyUnwinnable(snapWithPocket, 'w'), false);
});

test('invalid input states (unknown piece, castling NaN/99, fractional EP) decline certificate', () => {
  const base = Position.fromFen('2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1').snapshot();

  // Unknown piece 'X'
  const snapUnknownPiece = cloneState(base);
  (snapUnknownPiece.board as unknown as string[])[0] = 'X';
  assert.equal(isStaticallyUnwinnable(snapUnknownPiece, 'w'), false);

  // Castling NaN
  const snapCastlingNaN = cloneState(base);
  (snapCastlingNaN.castling.w as unknown as { k: number }).k = Number.NaN;
  assert.equal(isStaticallyUnwinnable(snapCastlingNaN, 'w'), false);

  // Castling out of range: 99
  const snapCastling99 = cloneState(base);
  snapCastling99.castling.w.k = 99;
  assert.equal(isStaticallyUnwinnable(snapCastling99, 'w'), false);

  // Fractional EP square: 3.5
  const snapFracEp = cloneState(base);
  (snapFracEp as unknown as { epSquare: number }).epSquare = 3.5;
  assert.equal(isStaticallyUnwinnable(snapFracEp, 'w'), false);
});
