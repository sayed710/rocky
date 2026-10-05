import assert from 'node:assert/strict';

/** Playwright request errors include auth headers; diagnostics must never retain them. */
export function redactDiagnostic(message, sensitive = []) {
  const plain = String(message).replace(/\u001b\[[0-9;]*m/g, '');
  const withoutHeaders = plain.replace(/\b(?:cookie|set-cookie|authorization)\s*:[^\r\n]*/gi, '[REDACTED HEADER]');
  return sensitive.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), withoutHeaders);
}

/** Refuse backend bypasses, including differing ports on the same host. */
export function requireEdge(url, base, websocket = false) {
  const actual = new URL(url);
  const edge = new URL(base);
  assert.equal(actual.host, edge.host, 'Traffic bypassed the public edge');
  assert.equal(actual.protocol, websocket ? 'ws:' : edge.protocol, 'Wrong edge protocol');
  if (websocket) assert.equal(actual.pathname, '/ws', 'Wrong WebSocket edge path');
}

/** Assert the durable product contract, rather than a browser-only ending. */
export function requireFinished(game, id, whiteId, blackId) {
  assert.equal(game.id, id);
  assert.equal(game.whiteId, whiteId);
  assert.equal(game.blackId, blackId);
  assert.equal(game.variant, 'standard');
  assert.equal(game.speed, 'blitz');
  assert.equal(game.rated, true);
  assert.equal(game.result, '0-1');
  assert.equal(game.termination, 'checkmate');
  assert.equal(game.plyCount, 4);
  assert.ok(Number.isFinite(Date.parse(game.endedAt)), 'Missing durable ending');
}

/** Fresh accounts use the documented effective baseline until the first pool row exists. */
export function ratingInPool(rows, requireRow = false) {
  assert.ok(Array.isArray(rows));
  const pool = rows.filter(row => row.variant === 'standard' && row.speed === 'blitz');
  assert.equal(pool.length, requireRow ? 1 : 0, 'Unexpected rating pool rows');
  if (!requireRow) return 1500;
  assert.ok(Number.isFinite(pool[0].rating));
  return pool[0].rating;
}

/** Check directions and the atomic ledger against both API observations. */
export function requireRatings(before, after, applications, id, whiteId, blackId) {
  assert.ok(after[0] < before[0], 'Loser rating did not decrease');
  assert.ok(after[1] > before[1], 'Winner rating did not increase');
  assert.equal(applications.length, 1, 'Game must have exactly one rating application');
  const row = applications[0];
  assert.equal(row.game_id, id);
  assert.equal(row.white_id, whiteId);
  assert.equal(row.black_id, blackId);
  assert.equal(row.variant, 'standard');
  assert.equal(row.speed, 'blitz');
  assert.equal(row.white_score, 0);
  assert.deepEqual([row.white_rating_before, row.black_rating_before], before);
  // API ratingView rounds to two decimals; the durable ledger retains full precision.
  assert.deepEqual([row.white_rating_after, row.black_rating_after].map(value => Math.round(value * 100) / 100), after);
}

/** A successful process must have executed every required stage with real edge traffic. */
export function requireComplete(evidence) {
  for (const stage of ['smoke', 'registered', 'matched', 'moves', 'terminal', 'durable', 'ratings', 'history', 'review', 'restart', 'replay', 'recovered']) {
    assert.equal(evidence.stages[stage], true, `Required stage did not execute: ${stage}`);
  }
  assert.deepEqual(evidence.moves, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(evidence.sockets.length, 2, 'Both browser players must use WebSockets');
  for (const urls of evidence.sockets) {
    assert.ok(urls.length > 0);
    for (const url of urls) requireEdge(url, evidence.baseURL, true);
  }
  assert.ok(evidence.apiPaths.includes(`/v1/games/${evidence.gameId}/review`), 'Review was not requested');
}
