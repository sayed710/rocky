/** Which endings change ratings: the owner-approved matrix of ADR-0150, decided from the stream alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_BOT_USER_IDS, type ResultString, type Termination } from '@chess-platform/game';
import { decideRating } from '../src/rating-eligibility';
import { PersistenceError } from '../src/errors';
import type { GameProjection } from '../src/games-projection';

const WHITE = '0190a000-0000-7000-8000-00000000000a';
const BLACK = '0190a000-0000-7000-8000-00000000000b';

function ended(result: ResultString, termination: Termination, over: Partial<GameProjection> = {}): GameProjection {
  return {
    id: '0190a000-0000-7000-8000-0000000000ff', variant: 'standard', rated: true, speed: 'blitz',
    white: WHITE, black: BLACK, startedAt: new Date(0), plyCount: 12, lastSeq: 13,
    result, termination, endedAt: new Date(1), ...over,
  };
}

const PLAYED: ReadonlyArray<[ResultString, Termination]> = [
  ['1-0', 'checkmate'], ['0-1', 'checkmate'], ['1-0', 'resignation'], ['0-1', 'resignation'],
  ['1-0', 'timeout'], ['0-1', 'timeout'], ['1/2-1/2', 'timeout'], ['1/2-1/2', 'stalemate'],
  ['1/2-1/2', 'agreement'], ['1/2-1/2', 'insufficient_material'], ['1/2-1/2', 'fifty_move'],
  ['1/2-1/2', 'threefold'], ['1-0', 'variant'], ['0-1', 'variant'], ['1/2-1/2', 'variant'],
];

test('every ending of real play in a rated human game is rated, with the white score it records', () => {
  for (const [result, termination] of PLAYED) {
    const decision = decideRating(ended(result, termination));
    assert.equal(decision.kind, 'rate', `${result} ${termination}`);
    if (decision.kind !== 'rate') continue;
    assert.equal(decision.game.whiteScore, result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5);
    assert.deepEqual(
      { variant: decision.game.variant, speed: decision.game.speed, white: decision.game.white, black: decision.game.black },
      { variant: 'standard', speed: 'blitz', white: WHITE, black: BLACK },
    );
  }
});

test('a casual game is never rated, however it ended', () => {
  for (const [result, termination] of PLAYED) {
    assert.deepEqual(decideRating(ended(result, termination, { rated: false })), { kind: 'ineligible', reason: 'casual' });
  }
});

test('aborts, seek no-shows and tournament forfeits or double forfeits are never rated', () => {
  const unplayed: ReadonlyArray<[ResultString, Termination]> = [
    ['*', 'aborted'], ['*', 'no_show'], ['1-0', 'no_show'], ['0-1', 'no_show'], ['1-0', 'aborted'],
  ];
  for (const [result, termination] of unplayed) {
    assert.deepEqual(decideRating(ended(result, termination)), { kind: 'ineligible', reason: 'no_result' }, `${result} ${termination}`);
  }
  assert.deepEqual(decideRating(ended('*', 'resignation')), { kind: 'ineligible', reason: 'no_result' });
});

test('a game with an engine bot or a non-account seat is never rated, even when stored as rated', () => {
  assert.deepEqual(decideRating(ended('1-0', 'checkmate', { black: ENGINE_BOT_USER_IDS.master })), { kind: 'ineligible', reason: 'not_human' });
  assert.deepEqual(decideRating(ended('0-1', 'resignation', { white: ENGINE_BOT_USER_IDS.novice })), { kind: 'ineligible', reason: 'not_human' });
  assert.deepEqual(decideRating(ended('1-0', 'checkmate', { white: 'harness-alice' })), { kind: 'ineligible', reason: 'not_human' });
});

test('an unlimited game rates in its variant\'s correspondence pool, never in a neighbouring speed', () => {
  const decision = decideRating(ended('1-0', 'resignation', { variant: 'crazyhouse', speed: 'correspondence' }));
  assert.equal(decision.kind, 'rate');
  if (decision.kind === 'rate') assert.deepEqual([decision.game.variant, decision.game.speed], ['crazyhouse', 'correspondence']);
});

test('an ending no authority could write fails closed instead of being rated or skipped', () => {
  assert.throws(() => decideRating(ended('1-0', 'checkmate', { white: BLACK })), PersistenceError);
  assert.throws(() => decideRating(ended('1-0', 'forfeit' as Termination)), PersistenceError);
  assert.throws(() => decideRating(ended('2-0' as ResultString, 'checkmate')), PersistenceError);
  assert.throws(() => decideRating(ended('1-0', 'checkmate', { result: null, termination: null })), PersistenceError);
  // Even a casual or aborted game with an impossible ending is reported, not quietly skipped.
  assert.throws(() => decideRating(ended('1-0', 'forfeit' as Termination, { rated: false })), PersistenceError);
});
