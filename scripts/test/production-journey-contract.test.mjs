import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireComplete, requireEdge, requireFinished, requireRatings, ratingInPool } from '../lib/production-journey-contract.mjs';

const game = { id: 'game', whiteId: 'white', blackId: 'black', variant: 'standard', speed: 'blitz', rated: true, result: '0-1', termination: 'checkmate', plyCount: 4, endedAt: '2026-10-05T12:00:00Z' };
const application = { game_id: 'game', white_id: 'white', black_id: 'black', variant: 'standard', speed: 'blitz', white_score: 0, white_rating_before: 1500, black_rating_before: 1500, white_rating_after: 1350, black_rating_after: 1650 };

test('durable result rejects wrong game, participants, casual or incomplete projection', () => {
  requireFinished(game, 'game', 'white', 'black');
  for (const [key, value] of Object.entries({ id: 'other', whiteId: 'other', blackId: 'other', rated: false, speed: 'rapid', variant: 'atomic', result: null, termination: 'timeout', plyCount: 0, endedAt: null })) {
    assert.throws(() => requireFinished({ ...game, [key]: value }, 'game', 'white', 'black'), key);
  }
});

test('rating gate requires both directions, correct pool and one matching atomic application', () => {
  requireRatings([1500, 1500], [1350, 1650], [application], 'game', 'white', 'black');
  for (const after of [[1500, 1650], [1350, 1500], [1650, 1350]]) {
    const matchingLedger = { ...application, white_rating_after: after[0], black_rating_after: after[1] };
    assert.throws(() => requireRatings([1500, 1500], after, [matchingLedger], 'game', 'white', 'black'));
  }
  for (const applications of [[], [application, application], [{ ...application, game_id: 'other' }], [{ ...application, speed: 'rapid' }], [{ ...application, white_rating_after: 1499 }]]) {
    assert.throws(() => requireRatings([1500, 1500], [1350, 1650], applications, 'game', 'white', 'black'));
  }
  assert.equal(ratingInPool([]), 1500);
  assert.throws(() => ratingInPool([], true));
  assert.throws(() => ratingInPool([{ variant: 'standard', speed: 'rapid', rating: 1650 }], true));
});

test('same-host backend port, external origin and wrong upgrade path fail edge boundary', () => {
  const base = 'http://127.0.0.1:3000';
  requireEdge(`${base}/v1/health`, base);
  requireEdge('ws://127.0.0.1:3000/ws', base, true);
  for (const [url, websocket] of [['http://127.0.0.1:8080/v1/health', false], ['ws://127.0.0.1:4175/ws', true], ['ws://127.0.0.1:3000/internal', true], ['https://external.test/v1/games', false]]) {
    assert.throws(() => requireEdge(url, base, websocket));
  }
});

test('completion cannot succeed when any required journey stage, UI move or review is omitted', () => {
  const evidence = {
    baseURL: 'http://127.0.0.1:3000', gameId: 'game',
    stages: Object.fromEntries(['smoke', 'registered', 'matched', 'moves', 'terminal', 'durable', 'ratings', 'history', 'review', 'restart', 'replay', 'recovered'].map(stage => [stage, true])),
    moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], sockets: [['ws://127.0.0.1:3000/ws'], ['ws://127.0.0.1:3000/ws']], apiPaths: ['/v1/games/game/review'],
  };
  requireComplete(evidence);
  for (const stage of Object.keys(evidence.stages)) {
    assert.throws(() => requireComplete({ ...evidence, stages: { ...evidence.stages, [stage]: false } }), stage);
  }
  assert.throws(() => requireComplete({ ...evidence, moves: [] }));
  assert.throws(() => requireComplete({ ...evidence, sockets: [[], []] }));
  assert.throws(() => requireComplete({ ...evidence, apiPaths: ['/v1/games/other/review'] }));
});
