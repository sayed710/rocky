import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { RetryPolicy } from '../src/net/retry.js';
import { RequestAbortedError, UnauthorizedError } from '../src/net/errors.js';
import { NoSessionError } from '../src/net/session.js';
import type { HttpRequest, HttpTransport } from '../src/ports/http.js';
import { abortableHang, FakeTransport, empty, json } from './support/fake-transport.js';
import type { AuthResponse, GameReviewResponse, SelfUser } from '../src/api/models.js';

const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' };
const selfUser: SelfUser = {
  id: 'u1',
  handle: 'alice',
  country: null,
  createdAt: '2020-01-01T00:00:00Z',
  roles: ['user'],
};

function auth(access: string, refresh = 'r', expiresIn = 3600): AuthResponse {
  return {
    user: selfUser,
    tokens: {
      accessToken: access,
      tokenType: 'Bearer',
      expiresIn,
      refreshToken: refresh,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
}

function make(transport: HttpTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: NO_RETRY,
    sleep: async () => {},
    now: () => 1000,
  });
}

test('health hits the unauthenticated endpoint', async () => {
  const t = new FakeTransport(() => json(200, { status: 'ok', name: 'gambit', version: '0.1.0' }));
  const health = await make(t).health();
  assert.equal(health.status, 'ok');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/health');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
});

test('login adopts the session and later authed calls send the bearer token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, selfUser),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  assert.equal(c.session.isAuthenticated, true);
  const me = await c.users.me();
  assert.equal(me.handle, 'alice');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('M12 inc 2: login sends credentials:include', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  assert.equal(t.calls[0]!.credentials, 'include');
});

test('M12 inc 2: register sends credentials:include', async () => {
  const t = new FakeTransport(() => json(201, auth('tok-R')));
  const c = make(t);
  await c.auth.register({ handle: 'newbie', password: 'password1' });
  assert.equal(t.calls[0]!.credentials, 'include');
});

test('authed call without a session fails fast before any request', async () => {
  const t = new FakeTransport();
  await assert.rejects(make(t).users.me(), UnauthorizedError);
  assert.equal(t.calls.length, 0);
});

test('a server 401 triggers one refresh and replays with the new token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(401, { error: { code: 'unauthenticated', message: 'expired', requestId: 'r' } }),
    () => json(200, auth('tok-B', 'r2')),
    () => json(200, selfUser),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const me = await c.users.me();
  assert.equal(me.handle, 'alice');
  assert.equal(t.calls.length, 4);
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  // M12 inc 2: refresh sends credentials:include and no body token.
  assert.equal(t.calls[2]!.url, 'https://api.test/v1/auth/refresh');
  assert.equal(t.calls[2]!.credentials, 'include');
  assert.equal(t.calls[2]!.body, undefined);
  assert.equal(t.calls[3]!.headers['authorization'], 'Bearer tok-B');
});

test('a failed refresh surfaces the original 401 and clears the session', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(401, { error: { code: 'unauthenticated', message: 'expired', requestId: 'r' } }),
    () => json(401, { error: { code: 'invalid_grant', message: 'bad refresh', requestId: 'r2' } }),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  await assert.rejects(c.users.me(), UnauthorizedError);
  assert.equal(c.session.isAuthenticated, false);
});

test('read endpoints encode query params and path segments', async () => {
  const t = new FakeTransport(
    () => json(200, []),
    () => json(200, []),
    () => json(200, { id: 'g1' }),
  );
  const c = make(t);
  await c.leaderboard('standard', { limit: 5 });
  await c.users.games('bob', { limit: 3 });
  await c.games.byId('g 1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/leaderboard/standard?limit=5');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/users/bob/games?limit=3');
  assert.equal(t.calls[2]!.url, 'https://api.test/v1/games/g%201');
});

test('M12 inc 2: logout sends credentials:include and no body token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A', 'refresh-Z')),
    () => empty(204),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  await c.auth.logout();
  assert.equal(c.session.isAuthenticated, false);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/logout');
  assert.equal(t.calls[1]!.credentials, 'include');
  assert.equal(t.calls[1]!.body, undefined);
});

test('M12 inc 2: logout without a session is a no-op', async () => {
  const t = new FakeTransport();
  const c = make(t);
  await c.auth.logout();
  assert.equal(t.calls.length, 0);
});

test('register adopts the session', async () => {
  const t = new FakeTransport(() => json(201, auth('tok-R')));
  const c = make(t);
  const res = await c.auth.register({ handle: 'newbie', password: 'password1' });
  assert.equal(res.tokens.accessToken, 'tok-R');
  assert.equal(c.session.isAuthenticated, true);
});

for (const transition of ['reset', 'adopt', 'dispose'] as const) {
  test(`cookie restore discards its response after ${transition}`, async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const c = make({
      async send() {
        await gate;
        return json(200, auth('obsolete-restore'));
      },
    });

    const restore = c.auth.refresh();
    if (transition === 'reset') c.session.reset();
    if (transition === 'adopt') c.session.adopt(auth('newer-login'));
    if (transition === 'dispose') c.session.dispose();
    finish();

    await assert.rejects(restore, NoSessionError);
    assert.equal(c.session.current?.tokens.accessToken, transition === 'adopt' ? 'newer-login' : undefined);
    c.session.dispose();
  });
}

test('games.createVsBot posts to /v1/games/bot with auth and returns summary', async () => {
  const summary = {
    id: 'game-bot-1',
    variant: 'standard',
    rated: false,
    speed: 'blitz',
    whiteId: 'u1',
    blackId: 'bot-1',
    result: null,
    termination: null,
    plyCount: 0,
    startedAt: '2026-08-03T00:00:00Z',
    endedAt: null,
  };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, summary),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });

  const req = {
    level: 'club' as const,
    variant: 'standard' as const,
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const },
    color: 'random' as const,
  };
  const res = await c.games.createVsBot(req);
  assert.equal(res.id, 'game-bot-1');
  assert.equal(res.rated, false);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/games/bot');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), req);
});

test('games.review posts to the completed-game review endpoint with authentication', async () => {
  const review: GameReviewResponse = {
    gameId: 'game 1', variant: 'standard', playerColor: 'white', result: '1-0', termination: 'resignation',
    moves: [], summary: {
      brilliant: 0, great: 0, best: 1, excellent: 1, good: 0, book: 0,
      inaccuracy: 1, mistake: 0, miss: 0, blunder: 0, missed_win: 0,
    },
    isPartial: false,
    totalPlayerMoves: 0,
    analyzedPlayerMoves: 0,
  };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, review),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });

  const result = await c.games.review('game 1');
  assert.equal(result.summary.inaccuracy, 1);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/games/game%201/review');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('games.review cancellation reaches the in-flight transport request', async () => {
  const hangingTransport = abortableHang();
  let callIndex = 0;
  const captured: { reviewRequest?: HttpRequest } = {};
  const transport: HttpTransport = {
    send(request) {
      if (callIndex++ === 0) return Promise.resolve(json(200, auth('tok-A')));
      captured.reviewRequest = request;
      return hangingTransport.send(request);
    },
  };
  const c = make(transport);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const cancellation = new AbortController();

  const pendingReview = c.games.review('game 1', cancellation.signal);
  await Promise.resolve();
  cancellation.abort();

  await assert.rejects(pendingReview, RequestAbortedError);
  assert.equal(captured.reviewRequest?.signal?.aborted, true);
});

test('tournaments.list fetches /v1/tournaments with auth:optional', async () => {
  const summary = { id: 't1', name: 'Weekly Arena', format: 'arena', state: 'running', participantCount: 10 };
  const t = new FakeTransport(() => json(200, [summary]));
  const c = make(t);
  const list = await c.tournaments.list(5);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 't1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/tournaments?limit=5');
  assert.equal(t.calls[0]!.method, 'GET');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
});

test('tournaments.byId fetches /v1/tournaments/:id with auth:optional and encodes id', async () => {
  const detail = {
    id: 't 1',
    name: 'Swiss Open',
    format: 'swiss',
    variant: 'standard',
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    state: 'registration',
    participants: ['p1', 'p2'],
    roundsGenerated: 0,
    tiebreakOrder: ['buchholz'],
  };
  const t = new FakeTransport(() => json(200, detail));
  const c = make(t);
  const res = await c.tournaments.byId('t 1');
  assert.equal(res.id, 't 1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/tournaments/t%201');
  assert.equal(t.calls[0]!.method, 'GET');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
});

test('tournaments.standings fetches /v1/tournaments/:id/standings', async () => {
  const standings = [{ rank: 1, playerId: 'p1', points: 3, wins: 3, draws: 0, losses: 0, gamesPlayed: 3, onFire: true }];
  const t = new FakeTransport(() => json(200, standings));
  const c = make(t);
  const res = await c.tournaments.standings('t1');
  assert.equal(res.length, 1);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/tournaments/t1/standings');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('tournaments.live fetches /v1/tournaments/:id/live', async () => {
  const live = { games: [], standings: [] };
  const t = new FakeTransport(() => json(200, live));
  const c = make(t);
  const res = await c.tournaments.live('t1');
  assert.deepEqual(res, live);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/tournaments/t1/live');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('search.query fetches /v1/search with default params and auth:optional', async () => {
  const resData = { total: 1, results: [{ id: 'player:p1', score: 0.9 }] };
  const t = new FakeTransport(() => json(200, resData));
  const c = make(t);
  const res = await c.search.query({ q: 'alice' });
  assert.equal(res.total, 1);
  assert.equal(res.results[0]!.id, 'player:p1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/search?q=alice');
  assert.equal(t.calls[0]!.method, 'GET');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
});

test('search.query encodes mode, limit, and offset when specified', async () => {
  const resData = { total: 0, results: [] };
  const t = new FakeTransport(() => json(200, resData));
  const c = make(t);
  await c.search.query({ q: 'bob', mode: 'semantic', limit: 10, offset: 20 });
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/search?q=bob&mode=semantic&limit=10&offset=20');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('messages.listConversations requires auth and handles query params', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, list),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.messages.listConversations({ limit: 10, offset: 0 });
  assert.deepEqual(res, list);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/messages/conversations?limit=10&offset=0');
  assert.equal(t.calls[1]!.method, 'GET');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('messages.messages requires auth and encodes conversationId', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, list),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.messages.messages('c 123');
  assert.deepEqual(res, list);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/messages/conversations/c%20123/messages');
  assert.equal(t.calls[1]!.method, 'GET');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('messages.send posts message body with auth', async () => {
  const msgView = {
    id: 'm1',
    conversationId: 'c1',
    senderId: 'u1',
    body: 'hello',
    sentAt: '2026-08-04T00:00:00Z',
    editedAt: null,
    deletedAt: null,
  };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(201, msgView),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.messages.send('c1', 'hello');
  assert.equal(res.id, 'm1');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/messages/conversations/c1/messages');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), { body: 'hello' });
});

test('messages.markRead posts to read endpoint with auth', async () => {
  const readState = { conversationId: 'c1', participantId: 'u1', lastReadAt: '2026-08-04T00:00:00Z' };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, readState),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.messages.markRead('c1');
  assert.deepEqual(res, readState);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/messages/conversations/c1/read');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('messages.openWith posts playerId with auth', async () => {
  const conv = {
    id: 'c1',
    participantA: 'u1',
    participantB: 'u2',
    createdAt: '2026-08-04T00:00:00Z',
    lastMessageAt: '2026-08-04T00:00:00Z',
  };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, conv),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.messages.openWith('u2');
  assert.equal(res.id, 'c1');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/messages/conversations');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), { playerId: 'u2' });
});





test('teams.list sends no query string when called with no options', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(() => json(200, list));
  const c = make(t);
  const res = await c.teams.list();
  assert.deepEqual(res, list);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('teams.list sends search and pagination only when provided', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(() => json(200, list), () => json(200, list));
  const c = make(t);
  await c.teams.list({ search: 'chess club' });
  // The client percent-encodes the space rather than using the form-style plus. Both are legal in
  // a query string; this pins which one it actually emits.
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams?search=chess%20club');
  await c.teams.list({ limit: 10, offset: 20 });
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams?limit=10&offset=20');
});

test('teams.byId encodes a slug that would otherwise break the path', async () => {
  const team = { id: 't1', slug: 'a b', name: 'A B', description: '', visibility: 'public', createdBy: 'u1', createdAt: '2026-08-04T00:00:00Z' };
  const t = new FakeTransport(() => json(200, team));
  const c = make(t);
  const res = await c.teams.byId('a b');
  assert.deepEqual(res, team);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams/a%20b');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('teams.members builds the members path', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(() => json(200, list));
  const c = make(t);
  const res = await c.teams.members('t1', { limit: 5 });
  assert.deepEqual(res, list);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams/t1/members?limit=5');
  assert.equal(t.calls[0]!.method, 'GET');
});

test('teams.join posts to the members path with auth', async () => {
  const membership = { teamId: 't1', playerId: 'u1', role: 'member', joinedAt: '2026-08-04T00:00:00Z' };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(201, membership),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.teams.join('t1');
  assert.deepEqual(res, membership);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t1/members');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('teams.leave deletes the member path with auth and resolves with no value', async () => {
  // The shared HTTP client returns undefined for a 204 or an empty body
  // (packages/web/src/net/http-client.ts). A client that tried to parse the empty body would
  // throw on every successful leave, so this asserts the resolved value, not just the call.
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => ({ status: 204, headers: {}, body: '' }),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.teams.leave('t1', 'u2');
  assert.equal(res, undefined);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t1/members/u2');
  assert.equal(t.calls[1]!.method, 'DELETE');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('teams.threads builds the forum path and sends pagination only when given', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(() => json(200, list), () => json(200, list));
  const c = make(t);
  await c.teams.threads('t1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams/t1/forum/threads');
  await c.teams.threads('t1', { limit: 5, offset: 10 });
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t1/forum/threads?limit=5&offset=10');
});

test('teams.thread and teams.posts encode both path segments', async () => {
  const t = new FakeTransport(() => json(200, {}), () => json(200, { total: 0, items: [] }));
  const c = make(t);
  await c.teams.thread('t 1', 'th 2');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/teams/t%201/forum/threads/th%202');
  await c.teams.posts('t 1', 'th 2');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t%201/forum/threads/th%202/posts');
});

test('teams.createThread posts a title and body with auth', async () => {
  const created = { thread: {}, firstPost: {} };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(201, created),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.teams.createThread('t1', 'Title', 'Body');
  assert.deepEqual(res, created);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t1/forum/threads');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), { title: 'Title', body: 'Body' });
});

test('teams.createPost posts a body to the thread with auth', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(201, {}),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  await c.teams.createPost('t1', 'th1', 'A reply');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/teams/t1/forum/threads/th1/posts');
  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), { body: 'A reply' });
});

test('achievements.forPlayer builds the player-scoped path and sends no token', async () => {
  const list = { total: 0, items: [] };
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, list),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const res = await c.achievements.forPlayer('u 1');
  assert.deepEqual(res, list);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/players/u%201/achievements');
  assert.equal(t.calls[1]!.method, 'GET');
  // The route is public and its answer does not vary by viewer. Signed in above precisely so this
  // asserts the token is withheld by design rather than absent by accident.
  assert.equal(t.calls[1]!.headers['authorization'], undefined);
});

test('achievements.summary builds the summary path', async () => {
  const summary = { unlockedCount: 3, pointsTotal: 45 };
  const t = new FakeTransport(() => json(200, summary));
  const c = make(t);
  const res = await c.achievements.summary('u1');
  assert.deepEqual(res, summary);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/players/u1/achievements/summary');
  assert.equal(t.calls[0]!.method, 'GET');
});
