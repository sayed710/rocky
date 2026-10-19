/**
 * Automatic insufficient-material draws (AUD-01). A draw is declared only when no sequence of
 * legal moves can produce checkmate (FIDE 5.2.2 / 6.9 dead position), never merely because
 * neither side can force mate. Bishops matter by square colour: two bishops on the same colour
 * can never mate, two on opposite colours can.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import type { Variant } from '../src/types';

function isInsufficient(fen: string, variant: Variant = 'standard'): boolean {
  const status = Position.fromFen(fen, variant).status();
  return status.over && status.reason === 'insufficient_material';
}

const DEAD: ReadonlyArray<[string, string]> = [
  ['K vs K', '4k3/8/8/8/8/8/8/4K3 w - - 0 1'],
  ['K+B vs K', '4k3/8/8/8/8/8/8/2B1K3 w - - 0 1'],
  ['K+N vs K', '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1'],
  ['K+B+B vs K, both bishops on dark squares', '4k3/8/8/8/8/4B3/8/2B1K3 w - - 0 1'],
  ['K+B vs K+B, same-coloured bishops', '4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1'],
  ['three bishops, both sides, all on dark squares', '4kb2/8/8/8/8/4B3/8/2B1K3 w - - 0 1'],
];

const MATE_POSSIBLE: ReadonlyArray<[string, string]> = [
  ['K+B+B vs K, opposite-coloured bishops', '4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1'],
  ['K+B vs K+B, opposite-coloured bishops', '4kb2/8/8/8/8/8/8/4KB2 w - - 0 1'],
  ['K+N vs K+N', '4kn2/8/8/8/8/8/8/1N2K3 w - - 0 1'],
  ['K+N+N vs K', '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1'],
  ['K+B vs K+N', '4kn2/8/8/8/8/8/8/2B1K3 w - - 0 1'],
  ['K+P vs K', '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'],
  ['K+R vs K', '4k3/8/8/8/8/8/8/R3K3 w - - 0 1'],
  ['K+Q vs K', '4k3/8/8/8/8/8/8/3QK3 w - - 0 1'],
];

for (const variant of ['standard', 'chess960'] as const) {
  for (const [name, fen] of DEAD) {
    test(`${variant}: ${name} is an automatic insufficient-material draw`, () => {
      assert.equal(isInsufficient(fen, variant), true);
    });
  }
  for (const [name, fen] of MATE_POSSIBLE) {
    test(`${variant}: ${name} is not drawn, because mate is still possible`, () => {
      assert.equal(Position.fromFen(fen, variant).status().over, false);
    });
  }
}

// Each material class above that stays ongoing really can be mated: these are legal checkmates
// with exactly that material, so declaring a draw there would end games that could still be won.
const MATES: ReadonlyArray<[string, string]> = [
  ['K+B vs K+B, opposite-coloured bishops (own bishop blocks g8)', '6bk/8/6K1/4B3/8/8/8/8 b - - 0 1'],
  ['K+N vs K+N (own knight blocks h7)', '7k/5K1n/6N1/8/8/8/8/8 b - - 0 1'],
  ['K+N+N vs K', '7k/5K2/5NN1/8/8/8/8/8 b - - 0 1'],
];

for (const [name, fen] of MATES) {
  test(`checkmate is reachable with ${name}`, () => {
    const status = Position.fromFen(fen).status();
    assert.ok(status.over);
    assert.equal(status.reason, 'checkmate');
  });
}

// Other variants keep their own endings: material alone never draws them during play.
for (const variant of ['kingofthehill', 'threecheck', 'racingkings'] as const) {
  test(`${variant}: a bare-kings position is not an insufficient-material draw`, () => {
    assert.equal(Position.fromFen('8/8/8/8/7k/8/8/K7 w - - 0 1', variant).status().over, false);
  });
}
