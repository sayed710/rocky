/**
 * Real Baseline RED test suite for current production `canMate`.
 *
 * Demonstrates the exact FIDE 6.9 defect in production packages/game/src/game.ts:
 * 1. Wrong draws (32 of 40 historical errors): lone minor against enabling enemy material
 *    returns false (insufficient material draw) instead of true (timeout win).
 * 2. Wrong wins (8 of 40 historical errors): same-color bishop collections
 *    return true (timeout win) instead of false (insufficient material draw).
 *
 * THIS TEST RUNS DIRECTLY AGAINST PRODUCTION canMate AND IS INTENTIONALLY RED
 * UNTIL PRODUCTION LOGIC IS AUTHORIZED AND IMPLEMENTED.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMate } from '../src';

test('RED 1.1: KN vs KR corner mate witness must be true (production returns false)', () => {
  // White Ka3, Nc2. Black ka1, rb1. Black flags. White has legal mate.
  const fen = '8/8/8/8/8/K7/2N5/kr6 b - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    true,
    'FIDE 6.9: White can mate Black with knight when Black rook blocks King in corner',
  );
});

test('RED 1.2: KB vs opposite-color KB must be true (production returns false)', () => {
  // White Kh6, Be5 (light). Black Kh8, Bg8 (dark). Black bishop blocks King.
  const fen = '6bk/8/6K1/4B3/8/8/8/8 b - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    true,
    'FIDE 6.9: White can mate Black with bishop when opposite-color bishop blocks corner',
  );
});

test('RED 1.3: KN vs KN helper block must be true (production returns false)', () => {
  // White Kf7, Ng6. Black Kh8, Nh7. Black knight blocks King.
  const fen = '7k/5K1n/6N1/8/8/8/8/8 b - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    true,
    'FIDE 6.9: White can mate Black with knight when Black knight blocks corner',
  );
});

test('RED 1.4: KB vs KN helper block must be true (production returns false)', () => {
  // White Kc7, Bb7. Black Ka8, Na7. Black knight blocks corner.
  const fen = 'k7/nBK5/8/8/8/8/8/8 b - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    true,
    'FIDE 6.9: White can mate Black with bishop when Black knight blocks corner',
  );
});

test('RED 2.1: Two same-color light bishops (f1, d3) vs bare King must be false (production returns true)', () => {
  // White Ke1, Bf1, Bd3 (both on light squares). Black Ke8.
  // Neither bishop can ever attack a dark square; checkmate is legally impossible.
  const fen = '4k3/8/8/8/8/3B4/8/4KB2 w - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    false,
    'FIDE 6.9: Same-color bishops cannot mate bare King; must draw',
  );
});

test('RED 2.2: Two same-color light bishops vs same-color light bishop (b5) must be false (production returns true)', () => {
  // White Ke1, Bf1, Bd3. Black Ke8, Bb5. All three bishops are on light squares.
  const fen = '4k3/8/8/1b6/8/3B4/8/4KB2 w - - 0 1';
  assert.equal(
    canMate(fen, 'w', 'standard'),
    false,
    'FIDE 6.9: All bishops on same square color with no P/N cannot mate; must draw',
  );
});
