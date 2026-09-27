import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRating, initialRating, rateGame } from '../src/glicko2';

// Glickman (2013), "Example of the Glicko-2 system": a 1500/200/0.06 player who
// beats 1400/30, loses to 1550/100 and 1700/300, with tau=0.5, ends at
// rating ~= 1464.06, RD ~= 151.52, vol ~= 0.05999.
test('reference worked example', () => {
  const res = updateRating(
    { rating: 1500, rd: 200, vol: 0.06 },
    [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ],
    0.5,
  );
  assert.ok(Math.abs(res.rating - 1464.06) < 0.5, `rating=${res.rating}`);
  assert.ok(Math.abs(res.rd - 151.52) < 0.5, `rd=${res.rd}`);
  assert.ok(Math.abs(res.vol - 0.05999) < 0.0005, `vol=${res.vol}`);
});

test('an empty rating period inflates RD only', () => {
  const r = updateRating({ rating: 1500, rd: 200, vol: 0.06 }, []);
  assert.equal(r.rating, 1500);
  assert.equal(r.vol, 0.06);
  assert.ok(r.rd > 200);
});

test('initialRating defaults match Glicko-2 conventions', () => {
  assert.deepEqual(initialRating(), { rating: 1500, rd: 350, vol: 0.06 });
});

test("rateGame updates each side against the other side's pre-game rating", () => {
  const white = { rating: 1600, rd: 120, vol: 0.06 };
  const black = { rating: 1450, rd: 200, vol: 0.06 };
  const rated = rateGame(white, black, 1);
  assert.deepEqual(rated.white, updateRating(white, [{ rating: 1450, rd: 200, score: 1 }]));
  assert.deepEqual(rated.black, updateRating(black, [{ rating: 1600, rd: 120, score: 0 }]));
  assert.ok(rated.white.rating > white.rating && rated.black.rating < black.rating);
});

test('rateGame scores a draw one half each way and is symmetric between equal players', () => {
  const rated = rateGame(initialRating(), initialRating(), 0.5);
  assert.deepEqual(rated.white, rated.black);
  assert.equal(rated.white.rating, 1500);
  assert.ok(rated.white.rd < 350);
});
