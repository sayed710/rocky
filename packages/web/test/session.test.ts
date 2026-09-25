import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientRefreshFailure,
  MemoryTokenStore,
  NoSessionError,
  SessionManager,
  type SessionChannel,
} from '../src/net/session.js';
import {
  DecodeError,
  NetworkError,
  RequestAbortedError,
  TimeoutError,
  UnauthorizedError,
  httpErrorFrom,
} from '../src/net/errors.js';
import type { StoredSession } from '../src/net/session.js';
import type { KeyValueStorage } from '../src/net/session.js';
import type { AuthResponse } from '../src/api/models.js';

function authResponse(access = 'access-1', refresh = 'refresh-1', expiresIn = 3600): AuthResponse {
  return {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2020-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: access,
      tokenType: 'Bearer',
      expiresIn,
      refreshToken: refresh,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
}

function storedSession(): StoredSession {
  const a = authResponse();
  return { user: a.user, tokens: a.tokens, accessTokenExpiresAt: 123 };
}

function sharedBarrierStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test('MemoryTokenStore stores and clears', () => {
  const store = new MemoryTokenStore();
  assert.equal(store.load(), null);
  store.save(storedSession());
  assert.ok(store.load());
  store.clear();
  assert.equal(store.load(), null);
});

test('M12 inc 2: MemoryTokenStore never writes to any Web Storage', () => {
  // The token store is in-memory only — no setItem should ever be called.
  // This is the core XSS hardening: the access token is never in localStorage.
  const store = new MemoryTokenStore();
  const session = storedSession();
  store.save(session);
  assert.ok(store.load());
  assert.equal(store.load()!.tokens.accessToken, 'access-1');
  // No storage involved — clearing the store is purely in-memory.
  store.clear();
  assert.equal(store.load(), null);
});

test('M12 inc 2: after login, SessionManager holds access token in memory only', () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  mgr.adopt(authResponse('tok-A', 'ref-A', 3600));
  // The access token is available in memory.
  assert.equal(mgr.authorizationHeader(), 'Bearer tok-A');
  assert.equal(mgr.isAuthenticated, true);
  // But there is no storage to inspect — it's purely in the MemoryTokenStore.
  // On a "reload" (new SessionManager), the token is gone:
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  assert.equal(mgr2.isAuthenticated, false);
  assert.equal(mgr2.authorizationHeader(), undefined);
});

test('adopt computes access-token expiry from the injected clock', () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  const session = mgr.adopt(authResponse('a', 'r', 60));
  assert.equal(session.accessTokenExpiresAt, 1000 + 60 * 1000);
  assert.equal(mgr.isAuthenticated, true);
  assert.equal(mgr.authorizationHeader(), 'Bearer a');
});

test('cross-tab adoption never broadcasts the refresh token', () => {
  let posted: unknown;
  const channel: SessionChannel = {
    onmessage: null,
    postMessage(message) { posted = message; },
    close() {},
  };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });

  manager.adopt(authResponse('access-secret', 'refresh-secret'));

  assert.ok(posted && typeof posted === 'object');
  const message = posted as { auth: AuthResponse };
  assert.equal(message.auth.tokens.accessToken, 'access-secret');
  assert.equal(message.auth.tokens.refreshToken, undefined);
  assert.equal(manager.current?.tokens.refreshToken, 'refresh-secret', 'the originating tab retains its local token');
  manager.dispose();
});

test('local adoption does not invoke the peer-adoption callback', () => {
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  let adoptions = 0;
  manager.onAdopted(() => { adoptions += 1; });

  manager.adopt(authResponse());

  assert.equal(adoptions, 0);
  manager.dispose();
});

test('isAccessTokenExpired respects leeway', () => {
  let now = 0;
  const mgr = new SessionManager({
    refresh: async () => authResponse(),
    now: () => now,
    expiryLeewayMs: 1000,
  });
  mgr.adopt(authResponse('a', 'r', 10)); // expires at 10_000
  now = 8000;
  assert.equal(mgr.isAccessTokenExpired(), false);
  now = 9000; // inside the 1000ms leeway
  assert.equal(mgr.isAccessTokenExpired(), true);
});

test('validAccessToken refreshes proactively when expired', async () => {
  let now = 0;
  let refreshCalls = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      refreshCalls += 1;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => now,
    expiryLeewayMs: 0,
  });
  mgr.adopt(authResponse('stale', 'r1', 1)); // expires at 1000
  now = 5000;
  assert.equal(await mgr.validAccessToken(), 'fresh');
  assert.equal(refreshCalls, 1);
});

test('validAccessToken returns undefined without a session', async () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 0 });
  assert.equal(await mgr.validAccessToken(), undefined);
});

test('refreshNow coalesces concurrent callers (single-flight)', async () => {
  let refreshCalls = 0;
  let resolveRefresh: ((value: AuthResponse) => void) | undefined;
  const mgr = new SessionManager({
    refresh: () => {
      refreshCalls += 1;
      return new Promise<AuthResponse>((resolve) => {
        resolveRefresh = resolve;
      });
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  const p1 = mgr.refreshNow();
  const p2 = mgr.refreshNow();
  resolveRefresh?.(authResponse('b', 'r2', 3600));
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(refreshCalls, 1);
  assert.equal(s1.tokens.accessToken, 'b');
  assert.equal(s2.tokens.accessToken, 'b');
});

test('refreshNow clears the session and rethrows on failure', async () => {
  const mgr = new SessionManager({
    refresh: async () => {
      throw new Error('refresh boom');
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  await assert.rejects(mgr.refreshNow(), /refresh boom/);
  assert.equal(mgr.isAuthenticated, false);
});

/**
 * Clearing this manager's own store is not enough: whoever is rendering a signed-in user holds a
 * separate snapshot and has no other way to learn the session is gone.
 */
test('a failed refresh notifies the registered invalidation handler', async () => {
  const mgr = new SessionManager({
    refresh: async () => { throw new Error('session revoked'); },
    now: () => 0,
  });
  let notified = 0;
  mgr.onInvalidated(() => { notified++; });
  mgr.adopt(authResponse('a', 'r', 1));

  await assert.rejects(mgr.refreshNow(), /session revoked/);
  assert.equal(notified, 1, 'the holder of the duplicate state was told');
});

/** A sign-out is not an invalidation — the caller asked for it and already knows. */
test('a deliberate reset does not notify the invalidation handler', () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 0 });
  let notified = 0;
  mgr.onInvalidated(() => { notified++; });
  mgr.adopt(authResponse('a', 'r', 1));

  mgr.reset();
  assert.equal(notified, 0);
});

test('refreshNow without a session throws NoSessionError', async () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 0 });
  await assert.rejects(mgr.refreshNow(), NoSessionError);
});

test('M12 inc 2: refreshNow passes the refresh token to the refresh function', async () => {
  let receivedToken: string | undefined;
  const mgr = new SessionManager({
    refresh: async (token?: string) => {
      receivedToken = token;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'my-refresh', 1));
  await mgr.refreshNow();
  assert.equal(receivedToken, 'my-refresh');
});

test('M12 inc 2: refreshNow works without a refresh token (cookie-based)', async () => {
  // Simulate a restored session with no refresh token (cookie-based).
  let receivedToken: string | undefined;
  const mgr = new SessionManager({
    refresh: async (token?: string) => {
      receivedToken = token;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => 0,
  });
  // Adopt a session that has no refresh token (simulating cookie-based restore).
  mgr.adopt({
    user: authResponse().user,
    tokens: { accessToken: 'a', tokenType: 'Bearer', expiresIn: 1, refreshExpiresAt: '' },
  });
  await mgr.refreshNow();
  assert.equal(receivedToken, undefined, 'refresh function should receive undefined when no token');
});

interface MockChannel extends SessionChannel {
  peer: MockChannel | null;
}

/** Create two asynchronous in-memory channels connected as browser-tab peers. */
function createMockChannelPair(): [SessionChannel, SessionChannel] {
  const ch1: MockChannel = {
    peer: null,
    postMessage(data: unknown): void {
      const peer = this.peer;
      if (peer) {
        queueMicrotask(() => {
          peer.onmessage?.(new MessageEvent('message', { data }));
        });
      }
    },
    onmessage: null,
    close(): void {
      this.peer = null;
    },
  };

  const ch2: MockChannel = {
    peer: null,
    postMessage(data: unknown): void {
      const peer = this.peer;
      if (peer) {
        queueMicrotask(() => {
          peer.onmessage?.(new MessageEvent('message', { data }));
        });
      }
    },
    onmessage: null,
    close(): void {
      this.peer = null;
    },
  };

  ch1.peer = ch2;
  ch2.peer = ch1;
  return [ch1, ch2];
}

test('dispose detaches the channel handler before closing a custom channel', () => {
  const channel: SessionChannel = {
    onmessage: null,
    postMessage: () => {},
    close(): void {
      this.onmessage?.(new MessageEvent('message', {
        data: { type: 'session_adopted', auth: authResponse('queued-after-dispose') },
      }));
    },
  };
  const manager = new SessionManager({
    refresh: async () => authResponse(),
    now: () => 1000,
    channel,
  });

  manager.dispose();

  assert.equal(channel.onmessage, null);
  assert.equal(manager.current, null);
});

/** Hold cross-tab delivery until the test explicitly advances that boundary. */
function queuedChannels() {
  const toFirst: unknown[] = [];
  const toSecond: unknown[] = [];
  const first: SessionChannel = {
    onmessage: null,
    postMessage: (message) => { toSecond.push(message); },
    close: () => {},
  };
  const second: SessionChannel = {
    onmessage: null,
    postMessage: (message) => { toFirst.push(message); },
    close: () => {},
  };
  return {
    first,
    second,
    deliverFirst: () => {
      for (const data of toFirst.splice(0)) first.onmessage?.(new MessageEvent('message', { data }));
    },
    deliverSecond: () => {
      for (const data of toSecond.splice(0)) second.onmessage?.(new MessageEvent('message', { data }));
    },
  };
}

test('loser invalidation cannot cancel the winner refresh still waiting for its response', async () => {
  const channels = queuedChannels();
  let finish!: (auth: AuthResponse) => void;
  const winner = new SessionManager({
    refresh: () => new Promise((resolve) => { finish = resolve; }),
    now: () => 1000,
    channel: channels.first,
  });
  const loser = new SessionManager({
    refresh: async () => { throw new Error('rotation lost'); },
    now: () => 1000,
    channel: channels.second,
  });
  winner.adopt(authResponse('old', 'old-refresh', 1), false);
  loser.adopt(authResponse('old', 'old-refresh', 1), false);

  const pending = winner.refreshNow();
  await assert.rejects(loser.refreshNow(), /rotation lost/);
  channels.deliverFirst();
  finish(authResponse('winner', 'winner-refresh'));

  assert.equal((await pending).tokens.accessToken, 'winner');
  channels.deliverSecond();
  assert.equal(winner.current?.tokens.accessToken, 'winner');
  assert.equal(loser.current?.tokens.accessToken, 'winner');
  winner.dispose();
  loser.dispose();
});

test('delayed invalidation preserves a successor whose access token needs refreshing', async () => {
  const channels = queuedChannels();
  const winner = new SessionManager({ refresh: async () => authResponse('next'), now: () => 1000, channel: channels.first });
  const loser = new SessionManager({ refresh: async () => { throw new Error('lost'); }, now: () => 1000, channel: channels.second });
  winner.adopt(authResponse('successor', 'successor-refresh', 1), false);
  loser.adopt(authResponse('old', 'old-refresh', 1), false);

  await assert.rejects(loser.refreshNow(), /lost/);
  channels.deliverFirst();

  assert.equal(winner.current?.tokens.accessToken, 'successor');
  assert.equal((await winner.refreshNow()).tokens.accessToken, 'next');
  winner.dispose();
  loser.dispose();
});

test('an adoption queued before explicit logout cannot resurrect the logged-out peer', () => {
  const channels = queuedChannels();
  const first = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.first });
  const second = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.second });
  first.adopt(authResponse('old'), false);
  second.adopt(authResponse('old'), false);

  first.adopt(authResponse('queued-successor'));
  second.reset();
  channels.deliverSecond();
  channels.deliverFirst();

  assert.equal(second.current, null);
  assert.equal(first.current, null);
  first.dispose();
  second.dispose();
});

test('explicit logout beats a concurrent adoption despite asymmetric local revision counts', () => {
  const channels = queuedChannels();
  const first = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.first });
  const second = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.second });
  first.adopt(authResponse('first-1'), false);
  first.adopt(authResponse('first-2'), false);
  first.adopt(authResponse('first-3'), false);
  second.adopt(authResponse('second-1'), false);

  first.adopt(authResponse('concurrent-adoption'));
  second.reset();
  channels.deliverSecond();
  channels.deliverFirst();

  assert.equal(first.current, null);
  assert.equal(second.current, null);
  first.dispose();
  second.dispose();
});

test('a login causally after peer logout can authenticate both tabs again', () => {
  const channels = queuedChannels();
  const first = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.first });
  const second = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.second });
  first.adopt(authResponse('old'), false);
  second.adopt(authResponse('old'), false);

  first.adopt(authResponse('obsolete-adoption'));
  second.reset();
  channels.deliverFirst();
  first.adopt(authResponse('later-login'));
  channels.deliverSecond();

  assert.equal(first.current?.tokens.accessToken, 'later-login');
  assert.equal(second.current?.tokens.accessToken, 'later-login');
  first.dispose();
  second.dispose();
});

test('the tab that originated logout can later authenticate every peer again', () => {
  const channels = queuedChannels();
  const first = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.first });
  const second = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: channels.second });
  first.adopt(authResponse('first-old'), false);
  second.adopt(authResponse('second-old'), false);

  second.reset();
  channels.deliverFirst();
  second.adopt(authResponse('origin-later-login'));
  channels.deliverFirst();

  assert.equal(first.current?.tokens.accessToken, 'origin-later-login');
  assert.equal(second.current?.tokens.accessToken, 'origin-later-login');
  first.dispose();
  second.dispose();
});

test('a tab opened after logout can authenticate peers that retained the logout tombstone', () => {
  const barriers = sharedBarrierStorage();
  const channels = queuedChannels();
  const existing = new SessionManager({
    refresh: async () => authResponse(), now: () => 1000, channel: channels.first,
    barrierStorage: barriers, channelSource: 'existing',
  });
  existing.adopt(authResponse('old'), false);
  existing.reset();

  const fresh = new SessionManager({
    refresh: async () => authResponse(), now: () => 1000, channel: channels.second,
    barrierStorage: barriers, channelSource: 'fresh',
  });
  fresh.adopt(authResponse('fresh-login'), true, fresh.captureGeneration());
  channels.deliverFirst();

  assert.equal(existing.current?.tokens.accessToken, 'fresh-login');
  existing.dispose();
  fresh.dispose();
});

test('a delayed legacy adoption cannot cross a persisted logout barrier', () => {
  const storage = sharedBarrierStorage();
  const first: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const manager = new SessionManager({
    refresh: async () => authResponse('unused'),
    channel: first,
    channelSource: 'logout-source',
    barrierStorage: storage,
  });
  manager.adopt(authResponse('before-logout'));
  manager.reset();
  manager.dispose();

  const remountedChannel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const remounted = new SessionManager({
    refresh: async () => authResponse('unused'),
    channel: remountedChannel,
    channelSource: 'remounted-source',
    barrierStorage: storage,
  });
  remountedChannel.onmessage?.(new MessageEvent('message', { data: {
    type: 'session_adopted', auth: authResponse('legacy-stale'),
  } }));

  assert.equal(remounted.current, null);
});

for (const legacyRevision of [
  undefined,
  { clock: { legacy: 1 }, source: 'legacy', kind: 'logout' },
] as const) {
  test(`a ${legacyRevision ? 'barrierless-revision' : 'revisionless'} legacy logout survives remount`, () => {
    const storage = sharedBarrierStorage();
    const first: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
    const manager = new SessionManager({
      refresh: async () => authResponse(), channel: first, channelSource: 'first', barrierStorage: storage,
    });
    manager.adopt(authResponse('before'), false);
    first.onmessage?.(new MessageEvent('message', { data: {
      type: 'session_reset', cause: 'logout', ...(legacyRevision ? { revision: legacyRevision } : {}),
    } }));
    assert.equal(manager.current, null);
    manager.dispose();

    const second: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
    const remounted = new SessionManager({
      refresh: async () => authResponse(), channel: second, channelSource: 'second', barrierStorage: storage,
    });
    second.onmessage?.(new MessageEvent('message', { data: {
      type: 'session_adopted',
      auth: authResponse('delayed'),
      revision: {
        clock: { delayed: 1 }, source: 'delayed', kind: 'adoption',
        barrier: '0000000000000000:initial',
      },
    } }));

    assert.equal(remounted.current, null);
    remounted.dispose();
  });
}

test('an old-epoch invalidation cannot poison the current bounded clock', () => {
  const storage = sharedBarrierStorage();
  const posted: unknown[] = [];
  const channel: SessionChannel = {
    onmessage: null,
    postMessage: (message) => { posted.push(message); },
    close: () => {},
  };
  const manager = new SessionManager({
    refresh: async () => authResponse(), channel, channelSource: 'current', barrierStorage: storage,
  });
  manager.reset();
  manager.adopt(authResponse('current-token'));
  channel.onmessage?.(new MessageEvent('message', { data: {
    type: 'session_reset',
    cause: 'invalidation',
    token: 'different-token',
    revision: {
      clock: { poison: 999 }, source: 'poison', kind: 'invalidation',
      barrier: '0000000000000000:initial',
    },
  } }));
  manager.adopt(authResponse('next-token'));

  const latest = posted.at(-1) as { revision: { clock: Record<string, number> } };
  assert.equal(Object.prototype.hasOwnProperty.call(latest.revision.clock, 'poison'), false);
  assert.equal(manager.current?.tokens.accessToken, 'next-token');
  manager.dispose();
});

test('an authentication captured before a durable peer logout cannot publish after it', () => {
  const barriers = sharedBarrierStorage();
  const beforeLogout = new SessionManager({
    refresh: async () => authResponse(), now: () => 1000, channel: null,
    barrierStorage: barriers, channelSource: 'before',
  });
  const loggingOut = new SessionManager({
    refresh: async () => authResponse(), now: () => 1000, channel: null,
    barrierStorage: barriers, channelSource: 'logout',
  });
  const captured = beforeLogout.captureGeneration();

  loggingOut.reset();

  assert.throws(
    () => beforeLogout.adopt(authResponse('obsolete'), true, captured),
    NoSessionError,
  );
  assert.equal(beforeLogout.current, null);
  beforeLogout.dispose();
  loggingOut.dispose();
});

test('channel messages with malformed revisions cannot mutate session state', () => {
  const channel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });
  manager.adopt(authResponse('current'), false);
  const malformedRevision = { clock: {}, source: 'peer', kind: 'adoption' };

  channel.onmessage?.(new MessageEvent('message', {
    data: { type: 'session_adopted', auth: authResponse('untrusted'), revision: malformedRevision },
  }));
  channel.onmessage?.(new MessageEvent('message', {
    data: { type: 'session_reset', cause: 'logout', revision: malformedRevision },
  }));

  assert.equal(manager.current?.tokens.accessToken, 'current');
  manager.dispose();
});

test('an oversized revision clock is rejected without mutating session state', () => {
  const channel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });
  manager.adopt(authResponse('current'), false);
  const clock = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`peer-${index}`, 1]));

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_adopted',
      auth: authResponse('untrusted'),
      revision: { clock, source: 'peer-0', kind: 'adoption' },
    },
  }));

  assert.equal(manager.current?.tokens.accessToken, 'current');
  manager.dispose();
});

test('sequential peer revisions cannot make outbound clocks grow without bound', () => {
  let posted: unknown;
  const channel: SessionChannel = {
    onmessage: null,
    postMessage(message) { posted = message; },
    close: () => {},
  };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });

  for (let index = 0; index < 80; index += 1) {
    const source = `peer-${index.toString().padStart(3, '0')}`;
    channel.onmessage?.(new MessageEvent('message', {
      data: {
        type: 'session_adopted',
        auth: authResponse(`peer-access-${index}`),
        revision: {
          clock: { [source]: 1 },
          source,
          kind: 'adoption',
          cookieOrder: index + 1,
        },
      },
    }));
  }
  assert.equal(manager.current?.tokens.accessToken, 'peer-access-79', 'later peers remain synchronized after churn');
  manager.adopt(authResponse('local'));

  assert.ok(posted && typeof posted === 'object');
  const revision = (posted as { revision: { clock: Record<string, number> } }).revision;
  assert.ok(Object.keys(revision.clock).length <= 64);

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_reset',
      cause: 'logout',
      revision: { clock: { 'fresh-logout-peer': 1 }, source: 'fresh-logout-peer', kind: 'logout' },
    },
  }));
  assert.equal(manager.current, null, 'bounded metadata must not partition explicit logout');
  manager.dispose();
});

test('an evicted source cannot replay an older ordered adoption', () => {
  const channel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const manager = new SessionManager({
    refresh: async () => authResponse(), now: () => 1000, channel, channelSource: 'local',
  });
  const delayed = {
    type: 'session_adopted',
    auth: authResponse('old-evicted'),
    revision: { clock: { aaa: 1 }, source: 'aaa', kind: 'adoption' },
  };
  channel.onmessage?.(new MessageEvent('message', { data: delayed }));
  for (let index = 2; index <= 70; index += 1) {
    const source = `peer-${index.toString().padStart(3, '0')}`;
    channel.onmessage?.(new MessageEvent('message', { data: {
      type: 'session_adopted',
      auth: authResponse(`peer-${index}`),
      revision: { clock: { [source]: 1 }, source, kind: 'adoption' },
    } }));
  }
  manager.adopt(authResponse('newer-local'), true, undefined, 100);

  channel.onmessage?.(new MessageEvent('message', { data: delayed }));

  assert.equal(manager.current?.tokens.accessToken, 'newer-local');
  manager.dispose();
});

test('cookie-writing adoption order wins even when channel delivery is delayed', () => {
  const barriers = sharedBarrierStorage();
  const channels = queuedChannels();
  const first = new SessionManager({
    refresh: async () => authResponse(), channel: channels.first,
    channelSource: 'first', barrierStorage: barriers,
  });
  const second = new SessionManager({
    refresh: async () => authResponse(), channel: channels.second,
    channelSource: 'second', barrierStorage: barriers,
  });

  first.adopt(authResponse('first-cookie'), true, undefined, 1);
  second.adopt(authResponse('second-cookie'), true, undefined, 2);
  channels.deliverSecond();
  channels.deliverFirst();

  assert.equal(first.current?.tokens.accessToken, 'second-cookie');
  assert.equal(second.current?.tokens.accessToken, 'second-cookie');
  first.dispose();
  second.dispose();
});

test('a fresh tab with the newest cookie order updates a long-lived peer', () => {
  const barriers = sharedBarrierStorage();
  const channels = queuedChannels();
  const existing = new SessionManager({
    refresh: async () => authResponse(), channel: channels.first,
    channelSource: 'existing', barrierStorage: barriers,
  });
  for (let order = 1; order <= 10; order += 1) {
    existing.adopt(authResponse(`existing-${order}`), false, undefined, order);
  }
  const fresh = new SessionManager({
    refresh: async () => authResponse(), channel: channels.second,
    channelSource: 'fresh', barrierStorage: barriers,
  });

  fresh.adopt(authResponse('fresh-newest'), true, undefined, 100);
  channels.deliverFirst();

  assert.equal(existing.current?.tokens.accessToken, 'fresh-newest');
  existing.dispose();
  fresh.dispose();
});

test('prototype-like channel sources cannot corrupt the local revision counter', () => {
  let posted: unknown;
  const channel: SessionChannel = {
    onmessage: null,
    postMessage(message) { posted = message; },
    close: () => {},
  };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_adopted',
      auth: authResponse('untrusted'),
      revision: { clock: { constructor: 1 }, source: 'constructor', kind: 'adoption' },
    },
  }));
  manager.adopt(authResponse('local'));

  assert.ok(posted && typeof posted === 'object');
  const counter = Object.values((posted as { revision: { clock: Record<string, number> } }).revision.clock);
  assert.ok(counter.every((value) => Number.isSafeInteger(value) && value > 0));
  manager.dispose();
});

test('a peer cannot advance this tab\'s private revision source', () => {
  let posted: unknown;
  const channel: SessionChannel = {
    onmessage: null,
    postMessage(message) { posted = message; },
    close: () => {},
  };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });
  manager.adopt(authResponse('current'));
  const first = (posted as { revision: { source: string; clock: Record<string, number> } }).revision;

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_adopted',
      auth: authResponse('forged'),
      revision: { clock: { [first.source]: 100 }, source: first.source, kind: 'adoption' },
    },
  }));
  assert.equal(manager.current?.tokens.accessToken, 'current');

  manager.adopt(authResponse('next'));
  const next = (posted as { revision: { source: string; clock: Record<string, number> } }).revision;
  assert.equal(next.clock[first.source], 2);
  manager.dispose();
});

test('channel adoption rejects a nonnumeric or non-finite token lifetime', () => {
  const channel: SessionChannel = { onmessage: null, postMessage: () => {}, close: () => {} };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });
  manager.adopt(authResponse('current'), false);

  for (const expiresIn of ['900', Number.NaN, Number.POSITIVE_INFINITY]) {
    const candidate = authResponse('untrusted');
    channel.onmessage?.(new MessageEvent('message', {
      data: { type: 'session_adopted', auth: { ...candidate, tokens: { ...candidate.tokens, expiresIn } } },
    }));
    assert.equal(manager.current?.tokens.accessToken, 'current');
  }
  manager.dispose();
});

test('a revision whose kind contradicts its message cannot poison a later logout', () => {
  let posted: unknown;
  const channel: SessionChannel = {
    onmessage: null,
    postMessage: (message) => { posted = message; },
    close: () => {},
  };
  const manager = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel });
  manager.adopt(authResponse('current'), false);

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_reset',
      cause: 'logout',
      revision: { clock: { peer: 100 }, source: 'peer', kind: 'adoption' },
    },
  }));
  manager.adopt(authResponse('local-successor'));
  assert.ok(posted, 'local adoption should publish its revision');

  channel.onmessage?.(new MessageEvent('message', {
    data: {
      type: 'session_reset',
      cause: 'logout',
      revision: { clock: { peer: 2 }, source: 'peer', kind: 'logout' },
    },
  }));

  assert.equal(manager.current, null);
  manager.dispose();
});

test('two session managers synchronize adoption across tabs via channel', async () => {
  const [ch1, ch2] = createMockChannelPair();
  const mgr1 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch1 });
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch2 });

  let mgr2Adopted = false;
  mgr2.onAdopted(() => { mgr2Adopted = true; });

  mgr1.adopt(authResponse('tab1-token', 'r1', 3600));

  await new Promise<void>((r) => queueMicrotask(() => r()));

  assert.equal(mgr2.isAuthenticated, true);
  assert.equal(mgr2.authorizationHeader(), 'Bearer tab1-token');
  assert.equal(mgr2.current?.tokens.refreshToken, undefined, 'peer messages never transfer refresh credentials');
  assert.equal(mgr2Adopted, true);

  mgr1.dispose();
  mgr2.dispose();
});

test('concurrent refreshes from two tabs: loser adopts winner without destroying session', async () => {
  const [ch1, ch2] = createMockChannelPair();
  const mgr1 = new SessionManager({
    refresh: async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()));
      return authResponse('winner-token', 'r-winner', 3600);
    },
    now: () => 1000,
    channel: ch1,
  });
  const mgr2 = new SessionManager({
    refresh: async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()));
      await new Promise<void>((r) => queueMicrotask(() => r()));
      // Tab 2 loses race; server returns 401 because Tab 1 refreshed first
      throw new Error('401 Unauthorized: refresh token has been revoked');
    },
    now: () => 1000,
    channel: ch2,
  });

  // Both have the initial session before expiry
  mgr1.adopt(authResponse('old-token', 'r-old', 1), false);
  mgr2.adopt(authResponse('old-token', 'r-old', 1), false);

  let mgr2Invalidated = false;
  mgr2.onInvalidated(() => { mgr2Invalidated = true; });

  // Both tabs invoke refreshNow() concurrently
  const [s1, s2] = await Promise.all([
    mgr1.refreshNow(),
    mgr2.refreshNow(),
  ]);

  assert.equal(s1.tokens.accessToken, 'winner-token');
  assert.equal(s2.tokens.accessToken, 'winner-token', 'Tab 2 must recover by returning winner session');

  // Tab 2 now has the winner's token and is still authenticated
  assert.equal(mgr2.isAuthenticated, true);
  assert.equal(mgr2.current?.tokens.accessToken, 'winner-token');
  assert.equal(mgr2Invalidated, false, 'Tab 2 must not be invalidated when Tab 1 succeeded');

  mgr1.dispose();
  mgr2.dispose();
});

test('session reset synchronizes across tabs via channel', async () => {
  const [ch1, ch2] = createMockChannelPair();
  const mgr1 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch1 });
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch2 });

  let mgr2ResetFired = false;
  mgr2.onReset(() => {
    mgr2ResetFired = true;
  });

  mgr1.adopt(authResponse('tok', 'r', 3600), false);
  mgr2.adopt(authResponse('tok', 'r', 3600), false);
  assert.equal(mgr2.isAuthenticated, true);

  // Tab 1 logs out / resets
  mgr1.reset();

  await new Promise<void>((r) => queueMicrotask(() => r()));

  assert.equal(mgr2.isAuthenticated, false);
  assert.equal(mgr2ResetFired, true, 'mgr2.onReset must be notified when peer resets');

  mgr1.dispose();
  mgr2.dispose();
});

test('deferred refresh is invalidated when peer reset arrives before refresh resolves', async () => {
  const [ch1, ch2] = createMockChannelPair();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const mgr1 = new SessionManager({
    refresh: async () => {
      await refreshGate;
      return authResponse('new-tok', 'new-r', 3600);
    },
    now: () => 1000,
    channel: ch1,
  });
  const mgr2 = new SessionManager({
    refresh: async () => authResponse(),
    now: () => 1000,
    channel: ch2,
  });

  let mgr1Invalidated = false;
  mgr1.onInvalidated(() => {
    mgr1Invalidated = true;
  });

  mgr1.adopt(authResponse('old-tok', 'old-r', 3600), false);
  mgr2.adopt(authResponse('old-tok', 'old-r', 3600), false);
  assert.equal(mgr1.isAuthenticated, true);
  assert.equal(mgr2.isAuthenticated, true);

  // Tab 1 starts refreshNow() while the network call is deferred
  let refreshError: unknown = null;
  const refreshPromise = mgr1.refreshNow().catch((err: unknown) => {
    refreshError = err;
  });

  // Peer tab (Tab 2) logs out / resets session while Tab 1's refresh is still in flight
  mgr2.reset();

  // Allow message to be delivered from ch2 to ch1
  await new Promise<void>((r) => queueMicrotask(() => r()));

  // Tab 1 received session_reset
  assert.equal(mgr1.isAuthenticated, false);

  // Now the network response resolves on Tab 1
  releaseRefresh();
  await refreshPromise;

  // The in-flight refresh MUST NOT adopt the session or resurrect it
  assert.ok(refreshError instanceof NoSessionError, 'refreshNow must reject with NoSessionError');
  assert.equal(mgr1.isAuthenticated, false, 'Tab 1 must remain unauthenticated');
  assert.equal(mgr1.current, null, 'Tab 1 session store must remain empty');
  assert.equal(mgr1Invalidated, false, 'voluntary reset must not trigger involuntary invalidation handler');

  // Allow microtasks to ensure no channel message resurrected Tab 2
  await new Promise<void>((r) => queueMicrotask(() => r()));

  assert.equal(mgr2.isAuthenticated, false, 'Tab 2 must not be re-authenticated by peer refresh');
  assert.equal(mgr2.current, null);

  mgr1.dispose();
  mgr2.dispose();
});

test('synchronous throw in doRefresh clears refreshInFlight and allows subsequent retry', async () => {
  let attempts = 0;
  const mgr = new SessionManager({
    refresh: () => {
      attempts++;
      if (attempts === 1) {
        // Synchronous throw before returning a Promise
        throw new Error('sync error during refresh initialization');
      }
      return Promise.resolve(authResponse('token-retry', 'refresh-retry', 3600));
    },
    now: () => 1000,
  });

  mgr.adopt(authResponse('old-token', 'old-r', 3600));

  // First call throws synchronously inside doRefresh
  await assert.rejects(
    async () => mgr.refreshNow(),
    /sync error during refresh initialization/,
  );

  // Re-adopt to simulate having a session for the retry
  mgr.adopt(authResponse('retry-base', 'retry-r', 3600));

  // Second call must NOT return a stale cached rejected promise; it must invoke doRefresh again
  const refreshed = await mgr.refreshNow();
  assert.equal(attempts, 2, 'doRefresh should be invoked on retry');
  assert.equal(refreshed.tokens.accessToken, 'token-retry');
  assert.equal(mgr.current?.tokens.accessToken, 'token-retry');

  mgr.dispose();
});

test('loser tab refresh failure before adoption broadcast does NOT clear winner tab', async () => {
  // A controlled channel where delivery between peers can be delayed deterministically
  let ch1ToCh2Queue: unknown[] = [];
  let ch2ToCh1Queue: unknown[] = [];

  const ch1: SessionChannel = {
    postMessage(data: unknown): void {
      ch1ToCh2Queue.push(data);
    },
    onmessage: null,
    close(): void {},
  };

  const ch2: SessionChannel = {
    postMessage(data: unknown): void {
      ch2ToCh1Queue.push(data);
    },
    onmessage: null,
    close(): void {},
  };

  const mgr1 = new SessionManager({
    refresh: async () => authResponse('winner-token', 'r-winner', 3600),
    now: () => 1000,
    channel: ch1,
  });

  const mgr2 = new SessionManager({
    refresh: async () => {
      throw new Error('401 Unauthorized: refresh token has been revoked');
    },
    now: () => 1000,
    channel: ch2,
  });

  // Both tabs hold the same initial session
  mgr1.adopt(authResponse('old-token', 'r-old', 1), false);
  mgr2.adopt(authResponse('old-token', 'r-old', 1), false);

  // Tab 1 wins refresh and adopts valid successor
  const s1 = await mgr1.refreshNow();
  assert.equal(s1.tokens.accessToken, 'winner-token');
  assert.equal(mgr1.isAuthenticated, true);
  // ch1 queued a 'session_adopted' message for ch2, but ch2 has not processed it yet
  assert.equal(ch1ToCh2Queue.length, 1);

  // Tab 2 loses refresh BEFORE processing Tab 1's adoption broadcast
  await assert.rejects(
    async () => mgr2.refreshNow(),
    /401 Unauthorized/,
  );

  // Tab 2 followed failure reset path and posted 'session_reset' to ch2
  assert.equal(ch2ToCh1Queue.length, 1);

  // Deliver Tab 2's reset message to Tab 1 (Winner Tab)
  for (const msg of ch2ToCh1Queue) {
    ch1.onmessage?.(new MessageEvent('message', { data: msg }));
  }
  ch2ToCh1Queue = [];

  // CRITICAL INVARIANT: The winner tab must NOT have its valid successor session cleared by loser tab reset!
  assert.equal(mgr1.isAuthenticated, true, 'winner tab must remain authenticated');
  assert.equal(mgr1.current?.tokens.accessToken, 'winner-token', 'winner tab must retain winner token');

  // Now deliver Tab 1's adoption broadcast to Tab 2
  for (const msg of ch1ToCh2Queue) {
    ch2.onmessage?.(new MessageEvent('message', { data: msg }));
  }
  ch1ToCh2Queue = [];

  // Tab 2 recovers and adopts the winner session
  assert.equal(mgr2.isAuthenticated, true, 'loser tab adopts winner after broadcast is delivered');
  assert.equal(mgr2.current?.tokens.accessToken, 'winner-token');

  // Explicit logout MUST still synchronize across tabs
  mgr1.reset();
  assert.equal(ch1ToCh2Queue.length, 1);
  for (const msg of ch1ToCh2Queue) {
    ch2.onmessage?.(new MessageEvent('message', { data: msg }));
  }
  assert.equal(mgr2.isAuthenticated, false, 'explicit logout must synchronize across tabs');

  mgr1.dispose();
  mgr2.dispose();
});

test('asynchronous throw in doRefresh clears refreshInFlight and allows subsequent retry', async () => {
  let attempts = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      attempts++;
      await new Promise<void>((r) => queueMicrotask(r));
      if (attempts === 1) {
        throw new Error('async network error during refresh');
      }
      return authResponse('token-async-retry', 'refresh-retry', 3600);
    },
    now: () => 1000,
  });

  mgr.adopt(authResponse('old-token', 'old-r', 3600));

  // First call rejects asynchronously
  await assert.rejects(
    async () => mgr.refreshNow(),
    /async network error during refresh/,
  );

  // Re-adopt to simulate having a session for the retry
  mgr.adopt(authResponse('retry-base', 'retry-r', 3600));

  // Second call must NOT return a stale cached rejected promise; it must invoke doRefresh again
  const refreshed = await mgr.refreshNow();
  assert.equal(attempts, 2, 'doRefresh should be invoked on subsequent attempt');
  assert.equal(refreshed.tokens.accessToken, 'token-async-retry');
  assert.equal(mgr.current?.tokens.accessToken, 'token-async-retry');

  mgr.dispose();
});

test('in-flight refresh started before adopt() cannot overwrite the newly adopted session', async () => {
  let finishRefresh!: (auth: AuthResponse) => void;
  const refreshPromise = new Promise<AuthResponse>((resolve) => {
    finishRefresh = resolve;
  });

  const mgr = new SessionManager({
    refresh: async () => refreshPromise,
    now: () => 1000,
  });

  // Tab has initial session S1
  mgr.adopt(authResponse('s1-token', 's1-refresh', 3600), false);

  // Tab starts refreshNow() based on S1
  const refreshInFlight = mgr.refreshNow();

  // Concurrently, a peer tab broadcast or re-auth adopts S2
  mgr.adopt(authResponse('s2-token', 's2-refresh', 7200), false);
  assert.equal(mgr.current?.tokens.accessToken, 's2-token');

  // Now the delayed refresh based on S1 finishes with S1-successor
  finishRefresh(authResponse('s1-delayed-successor', 's1-delayed-r', 3600));

  // The in-flight refresh MUST reject with NoSessionError because sessionGeneration was bumped by adopt()
  await assert.rejects(
    async () => refreshInFlight,
    NoSessionError,
  );

  // CRITICAL: The adopted S2 session must NOT be overwritten by the delayed refresh!
  assert.equal(mgr.current?.tokens.accessToken, 's2-token', 'retained adopted session token');
  assert.equal(mgr.isAuthenticated, true);

  mgr.dispose();
});

// --- P0-5 remainder: a transient refresh failure must not sign the user out -------------------

/** A mock channel pair whose first end records every message it posts. */
function recordingChannelPair(): { posted: unknown[]; ch1: SessionChannel; ch2: SessionChannel } {
  const [ch1, ch2] = createMockChannelPair();
  const posted: unknown[] = [];
  const send = ch1.postMessage.bind(ch1);
  ch1.postMessage = (message: unknown): void => {
    posted.push(message);
    send(message);
  };
  return { posted, ch1, ch2 };
}

function flushChannel(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(() => r()));
}

test('refresh failures are classified transient only for transport failures, 429 and 5xx', () => {
  const transient = [
    new NetworkError(),
    new TimeoutError(10),
    httpErrorFrom(429, undefined),
    httpErrorFrom(500, undefined),
    httpErrorFrom(502, undefined),
    httpErrorFrom(503, undefined),
    httpErrorFrom(504, undefined),
  ];
  const definitive = [
    httpErrorFrom(400, undefined),
    httpErrorFrom(401, undefined),
    httpErrorFrom(403, undefined),
    new DecodeError('bad body', 200),
    new RequestAbortedError(),
    new NoSessionError(),
    new Error('unknown failure'),
    'not an error',
  ];
  for (const error of transient) assert.equal(isTransientRefreshFailure(error), true, String(error));
  for (const error of definitive) assert.equal(isTransientRefreshFailure(error), false, String(error));
});

test('a network refresh failure keeps the local session and does not invalidate it', async () => {
  const mgr = new SessionManager({ refresh: async () => { throw new NetworkError(); }, now: () => 0 });
  let invalidated = 0;
  mgr.onInvalidated(() => { invalidated++; });
  mgr.adopt(authResponse('a', 'r', 1));

  await assert.rejects(mgr.refreshNow(), NetworkError);
  assert.equal(mgr.current?.tokens.accessToken, 'a');
  assert.equal(invalidated, 0);
});

test('a 5xx refresh failure neither broadcasts nor signs out a peer tab', async () => {
  const { posted, ch1, ch2 } = recordingChannelPair();
  const mgr1 = new SessionManager({
    refresh: async () => { throw httpErrorFrom(503, undefined); },
    now: () => 1000,
    channel: ch1,
  });
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch2 });
  let peerReset = 0;
  mgr2.onReset(() => { peerReset++; });
  mgr1.adopt(authResponse('tok', 'r', 1), false);
  mgr2.adopt(authResponse('tok', 'r', 1), false);

  await assert.rejects(mgr1.refreshNow(), (error) => isTransientRefreshFailure(error));
  await flushChannel();

  assert.deepEqual(posted, []);
  assert.equal(mgr1.isAuthenticated, true);
  assert.equal(mgr2.isAuthenticated, true);
  assert.equal(peerReset, 0);
  mgr1.dispose();
  mgr2.dispose();
});

test('a 401 refresh rejection still clears the session and invalidates the peer exactly once', async () => {
  const { posted, ch1, ch2 } = recordingChannelPair();
  const mgr1 = new SessionManager({
    refresh: async () => { throw httpErrorFrom(401, undefined); },
    now: () => 1000,
    channel: ch1,
  });
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000, channel: ch2 });
  let invalidated = 0;
  let peerReset = 0;
  mgr1.onInvalidated(() => { invalidated++; });
  mgr2.onReset(() => { peerReset++; });
  // The peer learns the session from this tab, as a real second tab would.
  mgr1.adopt(authResponse('tok', 'r', 1));
  await flushChannel();
  assert.equal(mgr2.current?.tokens.accessToken, 'tok');
  posted.length = 0;

  // Concurrent callers coalesce, so one rejection yields one reset and one broadcast.
  const results = await Promise.allSettled([mgr1.refreshNow(), mgr1.refreshNow()]);
  await flushChannel();

  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.ok((result as PromiseRejectedResult).reason instanceof UnauthorizedError);
  }
  assert.equal(mgr1.isAuthenticated, false);
  assert.equal(invalidated, 1);
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { cause?: unknown }).cause, 'invalidation');
  assert.equal(mgr2.isAuthenticated, false, 'the peer held the same rejected session');
  assert.equal(peerReset, 1);
  mgr1.dispose();
  mgr2.dispose();
});

test('concurrent callers share one transient refresh failure without extra requests', async () => {
  let calls = 0;
  const mgr = new SessionManager({
    refresh: async () => { calls++; throw new NetworkError(); },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));

  const results = await Promise.allSettled([mgr.refreshNow(), mgr.refreshNow(), mgr.validAccessToken()]);

  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(mgr.current?.tokens.accessToken, 'a');
});

test('a refresh retried after a transient failure recovers the session', async () => {
  let clock = 0;
  let calls = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      calls++;
      if (calls === 1) throw httpErrorFrom(502, undefined);
      return authResponse('b', 'r2', 3600);
    },
    now: () => clock,
  });
  let invalidated = 0;
  mgr.onInvalidated(() => { invalidated++; });
  mgr.adopt(authResponse('a', 'r', 1));

  await assert.rejects(mgr.validAccessToken());
  clock += 1_000;
  assert.equal(await mgr.validAccessToken(), 'b');
  assert.equal(calls, 2);
  assert.equal(invalidated, 0);
});

test('an outage backs off refresh requests instead of sending one per call', async () => {
  let clock = 0;
  let calls = 0;
  let outage = true;
  const mgr = new SessionManager({
    refresh: async () => {
      calls++;
      if (outage) throw new NetworkError();
      return authResponse('b', 'r2', 3600);
    },
    now: () => clock,
  });
  mgr.adopt(authResponse('a', 'r', 1));

  await assert.rejects(mgr.refreshNow(), NetworkError);
  assert.equal(calls, 1);
  // Within the first 1s backoff every caller gets the cached failure without a request.
  clock = 999;
  await assert.rejects(mgr.validAccessToken(), NetworkError);
  await assert.rejects(mgr.refreshNow(), NetworkError);
  assert.equal(calls, 1);

  clock = 1_000;
  await assert.rejects(mgr.refreshNow(), NetworkError);
  assert.equal(calls, 2);
  // The second consecutive failure doubles the backoff to 2s.
  clock = 2_999;
  await assert.rejects(mgr.refreshNow(), NetworkError);
  assert.equal(calls, 2);

  outage = false;
  clock = 3_000;
  assert.equal((await mgr.refreshNow()).tokens.accessToken, 'b');
  assert.equal(calls, 3);
  assert.equal(mgr.current?.tokens.accessToken, 'b');
});

test('a Retry-After on a transient refresh failure extends the backoff up to the ceiling', async () => {
  let clock = 0;
  let calls = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      calls++;
      throw httpErrorFrom(503, undefined, { retryAfterMs: 600_000 });
    },
    now: () => clock,
  });
  mgr.adopt(authResponse('a', 'r', 1));

  await assert.rejects(mgr.refreshNow());
  clock = 29_999;
  await assert.rejects(mgr.refreshNow());
  assert.equal(calls, 1);
  clock = 30_000;
  await assert.rejects(mgr.refreshNow());
  assert.equal(calls, 2);
});

test('a new session or a sign-out clears the refresh backoff', async () => {
  let calls = 0;
  const mgr = new SessionManager({
    refresh: async () => { calls++; throw new NetworkError(); },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  await assert.rejects(mgr.refreshNow());

  mgr.adopt(authResponse('b', 'r2', 1));
  await assert.rejects(mgr.refreshNow());
  assert.equal(calls, 2, 'a newly adopted session may refresh at once');

  mgr.reset();
  mgr.adopt(authResponse('c', 'r3', 1));
  await assert.rejects(mgr.refreshNow());
  assert.equal(calls, 3, 'a sign-out discards the old backoff');
});

test('a 401 after a transient failure (a rotated or reused token) still invalidates exactly once', async () => {
  const { posted, ch1, ch2 } = recordingChannelPair();
  let clock = 0;
  let calls = 0;
  const mgr1 = new SessionManager({
    refresh: async () => {
      calls++;
      // The first attempt timed out after the server rotated the token; the retry presents the
      // old cookie and reuse detection rejects it.
      if (calls === 1) throw new TimeoutError(10_000);
      throw httpErrorFrom(401, undefined);
    },
    now: () => clock,
    channel: ch1,
  });
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => clock, channel: ch2 });
  let invalidated = 0;
  mgr1.onInvalidated(() => { invalidated++; });
  mgr1.adopt(authResponse('tok', 'r', 1));
  await flushChannel();
  posted.length = 0;

  await assert.rejects(mgr1.refreshNow(), TimeoutError);
  assert.equal(mgr1.isAuthenticated, true);
  clock = 1_000;
  await assert.rejects(mgr1.refreshNow(), UnauthorizedError);
  await flushChannel();

  assert.equal(mgr1.isAuthenticated, false);
  assert.equal(mgr2.isAuthenticated, false);
  assert.equal(invalidated, 1);
  assert.equal(posted.length, 1);
  mgr1.dispose();
  mgr2.dispose();
});

test('a peer logout persisted during a refresh backoff still clears this tab', async () => {
  const barriers = sharedBarrierStorage();
  let calls = 0;
  const cooling = new SessionManager({
    refresh: async () => { calls++; throw new NetworkError(); },
    now: () => 0, channel: null, barrierStorage: barriers, channelSource: 'cooling',
  });
  const peer = new SessionManager({
    refresh: async () => authResponse(), now: () => 0, channel: null,
    barrierStorage: barriers, channelSource: 'peer',
  });
  let resets = 0;
  cooling.onReset(() => { resets++; });
  cooling.adopt(authResponse('a', 'r', 1));
  await assert.rejects(cooling.refreshNow(), NetworkError);

  // The peer's logout message was missed; only the durable barrier records it.
  peer.reset();
  await assert.rejects(cooling.validAccessToken(), NoSessionError);
  assert.equal(cooling.isAuthenticated, false);
  assert.equal(resets, 1);
  assert.equal(calls, 1);
  cooling.dispose();
  peer.dispose();
});

test('ignoreBackoff sends one refresh attempt during a backoff', async () => {
  let calls = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      calls++;
      if (calls === 1) throw new NetworkError();
      return authResponse('b', 'r2', 3600);
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  await assert.rejects(mgr.refreshNow(), NetworkError);
  await assert.rejects(mgr.validAccessToken(), NetworkError);
  assert.equal(calls, 1);
  assert.equal(await mgr.validAccessToken(true), 'b');
  assert.equal(calls, 2);
});
