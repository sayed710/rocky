import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardInteraction } from '../src/core/interaction.js';
import type { Color } from '../src/core/board.js';
import { StaticMoveOracle } from '../src/ports/move-oracle.js';

/**
 * Board ownership in the interaction core: a player moves only their own colour, a spectator or a
 * not-yet-resolved role moves nothing, and a change of owner leaves nothing of the old one behind.
 * Legality still comes only from the oracle; ownership is just the piece colour on the square.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const START_BLACK = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
// White pawn on e7 with Black to move: White's off-turn promotion premove.
const PROMO_B = '4k3/4P3/8/8/8/8/8/4K3 b - - 0 1';
const PROMO_W = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
// Chess960 start position 700 (cleared queenside), Black to move.
const SP700_BLACK = 'rbqknnbr/1ppppp2/p5pp/8/2P5/2Q5/PPBPPPPP/R2KNNBR b KQkq - 0 4';

function oracle(): StaticMoveOracle {
  return new StaticMoveOracle({
    [START]: { e2: ['e3', 'e4'], g1: ['f3', 'h3'] },
    [START_BLACK]: { e7: ['e6', 'e5'], g8: ['f6', 'h6'] },
    [PROMO_B]: { e8: ['d8', 'f8'] },
    [PROMO_W]: { e7: ['e8'] },
    [SP700_BLACK]: { b7: ['b6', 'b5'] },
  });
}

function make(fen: string, playerColor: Color | null, myTurn: boolean): BoardInteraction {
  const bi = new BoardInteraction({ oracle: oracle(), playerColor, myTurn });
  bi.setPosition(fen);
  return bi;
}

/** Every gesture a spectator could try, for one origin/destination pair. */
function tryEverything(bi: BoardInteraction, from: string, to: string): string[] {
  const kinds = [bi.tap(from as never).kind, bi.tap(to as never).kind];
  kinds.push(bi.dragStart(from as never).kind, bi.drop(from as never, to as never).kind);
  return kinds;
}

test('ownership: a spectator selects, drags, drops and premoves nothing on either turn', () => {
  for (const [fen, myTurn] of [[START, true], [START, false], [START_BLACK, false]] as const) {
    const bi = make(fen, null, myTurn);
    for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']] as const) {
      assert.deepEqual(tryEverything(bi, from, to), ['none', 'none', 'none', 'none'], `${fen} ${from}-${to}`);
    }
    assert.equal(bi.highlights().selected, null);
    assert.equal(bi.hasPremove, false);
    assert.equal(bi.awaitingPromotion, false);
    assert.equal(bi.applyPremove().kind, 'none');
  }
});

test('ownership: an unresolved role fails closed until a colour arrives', () => {
  const bi = make(START, null, true);
  assert.equal(bi.tap('e2').kind, 'none');
  assert.equal(bi.dragStart('e2').kind, 'none');
  bi.setPlayerColor('white');
  assert.equal(bi.tap('e2').kind, 'select');
  assert.deepEqual(bi.tap('e4'), { kind: 'move', move: { from: 'e2', to: 'e4' } });
});

test('ownership: the White player selects only White, on and off turn', () => {
  const on = make(START, 'white', true);
  assert.equal(on.tap('e7').kind, 'none');
  assert.equal(on.dragStart('e7').kind, 'none');
  assert.equal(on.tap('e2').kind, 'select');

  const off = make(START_BLACK, 'white', false);
  assert.equal(off.tap('e7').kind, 'none', 'Black is to move, but Black is not ours');
  assert.equal(off.dragStart('g8').kind, 'none');
  assert.equal(off.drop('e7', 'e5').kind, 'none', 'a drop from an opponent piece is not a premove');
  assert.equal(off.hasPremove, false);
  assert.equal(off.tap('d2').kind, 'select');
});

test('ownership: the Black player selects only Black, on and off turn', () => {
  const on = make(START_BLACK, 'black', true);
  assert.equal(on.tap('e2').kind, 'none');
  assert.equal(on.tap('e7').kind, 'select');
  assert.deepEqual(on.tap('e5'), { kind: 'move', move: { from: 'e7', to: 'e5' } });

  const off = make(START, 'black', false);
  assert.equal(off.tap('e2').kind, 'none', 'White is to move, but White is not ours');
  assert.equal(off.dragStart('g1').kind, 'none');
  assert.equal(off.drop('e2', 'e4').kind, 'none');
  assert.equal(off.hasPremove, false);
});

test('ownership: an own-colour premove queues off-turn and applies when the turn arrives', () => {
  const bi = make(START_BLACK, 'white', false);
  assert.equal(bi.tap('e2').kind, 'select');
  assert.deepEqual(bi.tap('e4'), { kind: 'premove', premove: { from: 'e2', to: 'e4' } });
  bi.setPosition(START);
  bi.setTurn(true);
  assert.deepEqual(bi.applyPremove(), { kind: 'move', move: { from: 'e2', to: 'e4' } });
});

test('ownership: own-piece reselection and an own promotion premove still work', () => {
  const bi = make(START_BLACK, 'white', false);
  bi.tap('e2');
  assert.deepEqual(bi.tap('g1'), { kind: 'select', square: 'g1' }, 'reselect another own piece');

  const promo = make(PROMO_B, 'white', false);
  promo.tap('e7');
  assert.deepEqual(promo.tap('e8'), { kind: 'promotion', from: 'e7', to: 'e8', premove: true });
  assert.deepEqual(promo.resolvePromotion('n'), { kind: 'premove', premove: { from: 'e7', to: 'e8', promotion: 'n' } });
});

test('ownership: a real player still gets the illegal-move result for an on-turn miss', () => {
  const bi = make(START, 'white', true);
  bi.tap('e2');
  assert.deepEqual(bi.tap('e5'), { kind: 'illegal', from: 'e2', to: 'e5' });
});

test('ownership: a finished board stays inert whatever the owner', () => {
  const bi = make(START, 'white', true);
  bi.setInputEnabled(false);
  assert.equal(bi.tap('e2').kind, 'none');
  bi.setPlayerColor('black');
  bi.setPlayerColor('white');
  assert.equal(bi.tap('e2').kind, 'none');
});

test('ownership: a change of owner clears a stale selection', () => {
  const bi = make(START, 'white', true);
  bi.tap('e2');
  bi.setPlayerColor(null);
  assert.equal(bi.highlights().selected, null);
  assert.deepEqual([...bi.highlights().legal], []);
  assert.equal(bi.tap('e4').kind, 'none', 'nothing left to complete');
});

test('ownership: a change of owner clears a pending promotion', () => {
  const bi = make(PROMO_W, 'white', true);
  bi.tap('e7');
  assert.equal(bi.tap('e8').kind, 'promotion');
  bi.setPlayerColor(null);
  assert.equal(bi.awaitingPromotion, false);
  assert.equal(bi.resolvePromotion('q').kind, 'none', 'the old promotion cannot be completed');
});

test('ownership: a change of owner clears a stale premove', () => {
  for (const next of [null, 'black'] as const) {
    const bi = make(START_BLACK, 'white', false);
    bi.tap('e2');
    bi.tap('e4');
    assert.equal(bi.hasPremove, true);
    bi.setPlayerColor(next);
    assert.equal(bi.hasPremove, false, `cleared on change to ${next}`);
    assert.deepEqual([...bi.highlights().premove], []);
  }
});

test('ownership: re-asserting the same owner keeps the selection and premove', () => {
  const bi = make(START_BLACK, 'white', false);
  bi.tap('e2');
  bi.tap('e4');
  bi.tap('g1');
  bi.setPlayerColor('white');
  assert.equal(bi.hasPremove, true);
  assert.equal(bi.highlights().selected, 'g1');
});

test('ownership: a Chess960 position follows the same boundary', () => {
  const bi = make(SP700_BLACK, 'white', false);
  assert.equal(bi.tap('b7').kind, 'none', 'Black is to move, but Black is not ours');
  assert.equal(bi.tap('d1').kind, 'select', "White's king on d1 is ours");
  const black = make(SP700_BLACK, 'black', true);
  assert.equal(black.tap('d1').kind, 'none');
  black.tap('b7');
  assert.deepEqual(black.tap('b5'), { kind: 'move', move: { from: 'b7', to: 'b5' } });
});

test('ownership: a standalone board without players still moves the side to move', () => {
  const bi = new BoardInteraction({ oracle: oracle() });
  bi.setPosition(START_BLACK);
  assert.equal(bi.tap('e7').kind, 'select');
  assert.deepEqual(bi.tap('e5'), { kind: 'move', move: { from: 'e7', to: 'e5' } });
});
