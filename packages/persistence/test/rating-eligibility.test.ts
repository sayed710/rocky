/** Which endings change ratings: the owner-approved matrix of ADR-0150, decided from the stream alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_BOT_USER_IDS, type GameEvent, type ResultString, type Termination } from '@chess-platform/game';
import { decideRating } from '../src/rating-eligibility';
import { PersistenceError } from '../src/errors';
import type { StoredEvent } from '../src/event-store';

const ID = '0190a000-0000-7000-8000-0000000000ff';
const WHITE = '0190a000-0000-7000-8000-00000000000a';
const BLACK = '0190a000-0000-7000-8000-00000000000b';
const BLITZ = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 };
const WINNER: Record<string, 'w' | 'b' | null> = { '1-0': 'w', '0-1': 'b', '1/2-1/2': null, '*': null };

/** A two-event stream: a creation (with overrides) and an ending whose winner matches its result unless overridden. */
function stream(
  result: string,
  termination: string,
  created: Record<string, unknown> = {},
  ending: Record<string, unknown> = {},
): StoredEvent[] {
  const events = [
    { type: 'GameCreated', gameId: ID, variant: 'standard', timeControl: BLITZ, players: { white: WHITE, black: BLACK }, rated: true, at: 0, ...created },
    { type: 'GameEnded', result, termination, winner: WINNER[result] ?? null, at: 1, ...ending },
  ];
  return events.map((event, seq) => ({ gameId: ID, seq, version: 1, event: event as unknown as GameEvent, serverTs: seq }));
}

const decide = (...args: Parameters<typeof stream>) => decideRating(ID, stream(...args));

const PLAYED: ReadonlyArray<[ResultString, Termination]> = [
  ['1-0', 'checkmate'], ['0-1', 'checkmate'], ['1-0', 'resignation'], ['0-1', 'resignation'],
  ['1-0', 'timeout'], ['0-1', 'timeout'], ['1/2-1/2', 'stalemate'], ['1/2-1/2', 'agreement'],
  ['1/2-1/2', 'insufficient_material'], ['1/2-1/2', 'fifty_move'], ['1/2-1/2', 'threefold'],
  ['1-0', 'variant'], ['0-1', 'variant'], ['1/2-1/2', 'variant'],
];

test('every ending of real play in a rated human game is rated, with the white score it records', () => {
  for (const [result, termination] of PLAYED) {
    const decision = decide(result, termination);
    assert.equal(decision.kind, 'rate', `${result} ${termination}`);
    if (decision.kind !== 'rate') continue;
    assert.equal(decision.game.whiteScore, result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5);
    assert.deepEqual(
      { gameId: decision.game.gameId, variant: decision.game.variant, speed: decision.game.speed, white: decision.game.white, black: decision.game.black },
      { gameId: ID, variant: 'standard', speed: 'blitz', white: WHITE, black: BLACK },
    );
  }
});

test('a casual game is never rated, however it ended', () => {
  for (const [result, termination] of PLAYED) {
    assert.deepEqual(decide(result, termination, { rated: false }), { kind: 'ineligible', reason: 'casual' });
  }
});

test('aborts, seek no-shows and tournament forfeits or double forfeits are never rated', () => {
  const unplayed: ReadonlyArray<[ResultString, Termination]> = [['*', 'aborted'], ['*', 'no_show'], ['1-0', 'no_show'], ['0-1', 'no_show']];
  for (const [result, termination] of unplayed) {
    assert.deepEqual(decide(result, termination), { kind: 'ineligible', reason: 'no_result' }, `${result} ${termination}`);
  }
});

test('a game with an engine bot or a non-account seat is never rated, even when stored as rated', () => {
  const seats = (white: string, black: string) => ({ players: { white, black } });
  assert.deepEqual(decide('1-0', 'checkmate', seats(WHITE, ENGINE_BOT_USER_IDS.master)), { kind: 'ineligible', reason: 'not_human' });
  assert.deepEqual(decide('0-1', 'resignation', seats(ENGINE_BOT_USER_IDS.novice, BLACK)), { kind: 'ineligible', reason: 'not_human' });
  assert.deepEqual(decide('1-0', 'checkmate', seats('harness-alice', BLACK)), { kind: 'ineligible', reason: 'not_human' });
});

test('an unlimited game rates in its variant\'s correspondence pool, never in a neighbouring speed', () => {
  const decision = decide('1-0', 'resignation', { variant: 'crazyhouse', timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 } });
  assert.equal(decision.kind, 'rate');
  if (decision.kind === 'rate') assert.deepEqual([decision.game.variant, decision.game.speed], ['crazyhouse', 'correspondence']);
});

test('an ending no authority could write fails closed instead of being rated or skipped', () => {
  const corrupt: ReadonlyArray<[string, Parameters<typeof stream>]> = [
    ['self-pairing', ['1-0', 'checkmate', { players: { white: WHITE, black: WHITE } }]],
    ['unknown termination', ['1-0', 'forfeit']],
    ['unknown result', ['2-0', 'checkmate']],
    ['decisive stalemate', ['1-0', 'stalemate']],
    ['decisive agreement', ['0-1', 'agreement']],
    ['drawn checkmate', ['1/2-1/2', 'checkmate']],
    ['drawn resignation', ['1/2-1/2', 'resignation']],
    ['scoreless resignation', ['*', 'resignation']],
    ['decisive abort', ['1-0', 'aborted']],
    ['winner contradicting the result', ['1-0', 'checkmate', {}, { winner: 'b' }]],
    ['winner on a draw', ['1/2-1/2', 'agreement', {}, { winner: 'w' }]],
    ['missing winner', ['1-0', 'resignation', {}, { winner: undefined }]],
    ['missing rated flag', ['1-0', 'checkmate', { rated: undefined }]],
    ['non-boolean rated flag', ['1-0', 'checkmate', { rated: 'true' }]],
    ['unknown time control kind', ['1-0', 'checkmate', { timeControl: { ...BLITZ, kind: 'hourglass' } }]],
    // Even a casual game with an impossible ending is reported, not quietly skipped.
    ['casual game with an impossible ending', ['1-0', 'stalemate', { rated: false }]],
  ];
  for (const [label, args] of corrupt) {
    assert.throws(() => decide(...args), PersistenceError, label);
  }
  const unfinished = stream('1-0', 'checkmate').slice(0, 1);
  assert.throws(() => decideRating(ID, unfinished), PersistenceError, 'a stream that has not ended');
});
