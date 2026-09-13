import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToPath, navigate } from '../src/app/router.js';
import type { Route, HistoryLike } from '../src/app/router.js';

test('parseRoute: root path → lobby', () => {
  assert.deepEqual(parseRoute('/'), { name: 'lobby' });
  assert.deepEqual(parseRoute(''), { name: 'lobby' });
});

test('parseRoute: /game/{id} → game route', () => {
  const r = parseRoute('/game/abc123');
  assert.equal(r.name, 'game');
  if (r.name === 'game') assert.equal(r.gameId, 'abc123');
});

test('parseRoute: /profile → profile with null handle', () => {
  const r = parseRoute('/profile');
  assert.equal(r.name, 'profile');
  if (r.name === 'profile') assert.equal(r.handle, null);
});

test('parseRoute: /profile/{handle} → profile with handle', () => {
  const r = parseRoute('/profile/alice');
  assert.equal(r.name, 'profile');
  if (r.name === 'profile') assert.equal(r.handle, 'alice');
});

test('parseRoute: unknown path → not-found', () => {
  assert.equal(parseRoute('/unknown').name, 'not-found');
  assert.equal(parseRoute('/foo/bar/baz').name, 'not-found');
  assert.equal(parseRoute('/leaderboard/atomic').name, 'not-found');
});

test('parseRoute: supported routes reject unsupported extra segments', () => {
  for (const pathname of [
    '/game/g1/extra',
    '/profile/alice/extra',
    '/tournaments/t1/extra',
    '/search/extra',
    '/messages/c1/extra',
    '/courses/openings/extra',
    '/lessons/l1/extra',
  ]) {
    assert.deepEqual(parseRoute(pathname), { name: 'not-found' }, pathname);
  }
});

test('routeToPath: lobby → /', () => {
  assert.equal(routeToPath({ name: 'lobby' }), '/');
});

test('routeToPath: game → /game/{id}', () => {
  assert.equal(routeToPath({ name: 'game', gameId: 'g1' }), '/game/g1');
});

test('routeToPath: profile without handle → /profile', () => {
  assert.equal(routeToPath({ name: 'profile', handle: null }), '/profile');
});

test('routeToPath: profile with handle → /profile/{handle}', () => {
  assert.equal(routeToPath({ name: 'profile', handle: 'alice' }), '/profile/alice');
});

test('routeToPath: not-found → /not-found', () => {
  assert.equal(routeToPath({ name: 'not-found' }), '/not-found');
});

test('navigate calls pushState with the correct URL', () => {
  const calls: string[] = [];
  const fakeHistory: HistoryLike = {
    pushState: (data, title, url) => { calls.push(url); },
  };
  navigate({ name: 'game', gameId: 'g42' }, fakeHistory);
  assert.deepEqual(calls, ['/game/g42']);
  navigate({ name: 'lobby' }, fakeHistory);
  assert.deepEqual(calls, ['/game/g42', '/']);
});

test('round-trip: parseRoute(routeToPath(route)) is stable for all route shapes', () => {
  const routes: Route[] = [
    { name: 'lobby' },
    { name: 'game', gameId: 'abc' },
    { name: 'profile', handle: null },
    { name: 'profile', handle: 'bob' },
    { name: 'not-found' },
  ];
  for (const r of routes) {
    const path = routeToPath(r);
    const parsed = parseRoute(path);
    assert.equal(parsed.name, r.name, `round-trip failed for ${r.name} via ${path}`);
  }
});

// C1 regression: navigate with no injected history should use globalThis.history.
test('C1 regression: navigate without injected history uses globalThis.history', () => {
  const calls: string[] = [];
  const original = (globalThis as any).history;
  (globalThis as any).history = {
    pushState: (data: unknown, title: string, url: string) => { calls.push(url); },
  };
  try {
    navigate({ name: 'lobby' });
    assert.deepEqual(calls, ['/']);
  } finally {
    (globalThis as any).history = original;
  }
});

test('parses the teams list and team detail routes', () => {
  assert.deepEqual(parseRoute('/teams'), { name: 'teams' });
  assert.deepEqual(parseRoute('/teams/city-chess'), { name: 'team', slug: 'city-chess' });
  // Slugs arrive percent-encoded in the path and must be decoded once, not left escaped.
  assert.deepEqual(parseRoute('/teams/city%20chess'), { name: 'team', slug: 'city chess' });
});

test('serializes the teams routes back to their paths', () => {
  assert.equal(routeToPath({ name: 'teams' }), '/teams');
  assert.equal(routeToPath({ name: 'team', slug: 'city-chess' }), '/teams/city-chess');
});

test('parses the forum and thread routes nested under a team', () => {
  assert.deepEqual(parseRoute('/teams/city-chess/forum'), { name: 'forum', slug: 'city-chess' });
  assert.deepEqual(parseRoute('/teams/city-chess/forum/th-1'), {
    name: 'thread', slug: 'city-chess', threadId: 'th-1',
  });
  // Anything else under a team slug is not a route we serve, and must not fall through to the team.
  assert.deepEqual(parseRoute('/teams/city-chess/nonsense'), { name: 'not-found' });
});

test('serializes the forum routes back to their paths', () => {
  assert.equal(routeToPath({ name: 'forum', slug: 'city-chess' }), '/teams/city-chess/forum');
  assert.equal(routeToPath({ name: 'thread', slug: 'city-chess', threadId: 'th-1' }), '/teams/city-chess/forum/th-1');
});

test('parses /password-reset route', () => {
  assert.deepEqual(parseRoute('/password-reset'), { name: 'password-reset' });
  assert.deepEqual(parseRoute('/password-reset?token=abc-123'), { name: 'password-reset' });
});

test('serializes /password-reset route back to path', () => {
  assert.equal(routeToPath({ name: 'password-reset' }), '/password-reset');
});

test('parses /email-verify route and rejects extra segments', () => {
  assert.deepEqual(parseRoute('/email-verify'), { name: 'email-verify' });
  assert.deepEqual(parseRoute('/email-verify?token=x'), { name: 'email-verify' });
  assert.deepEqual(parseRoute('/email-verify/extra'), { name: 'not-found' });
});

test('serializes /email-verify route back to path', () => {
  assert.equal(routeToPath({ name: 'email-verify' }), '/email-verify');
});
