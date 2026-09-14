import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthController } from '../src/app/auth-controller.js';
import type { AuthSession } from '../src/app/auth-controller.js';
import { GambitClient } from '../src/api/client.js';
import type { AuthResponse, LoginRequest, RegisterRequest } from '../src/api/models.js';
import type { StoredSession, KeyValueStorage } from '../src/net/session.js';
import { MemoryTokenStore } from '../src/net/session.js';
import { json } from './support/fake-transport.js';

/** Provide isolated Web Storage semantics for each controller test. */
function makeFakeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

interface FakeSession {
  resets: number;
  generation: number;
  invalidate: (() => void) | null;
  resetCallback: (() => void) | null;
  adoptedCallback: ((session: StoredSession) => void) | null;
  reset(): void;
  dispose(): void;
  captureGeneration(): number;
  onInvalidated(handler: () => void): void;
  onReset(handler: () => void): void;
  onAdopted(handler: (session: StoredSession) => void): void;
}

/**
 * The fake exposes the invalidation, reset, and adoption handlers the controller registers,
 * so a test can fire the callbacks `SessionManager` would fire without driving real network/channel events.
 */
function makeFakeSession(): FakeSession {
  return {
    resets: 0,
    generation: 0,
    invalidate: null,
    resetCallback: null,
    adoptedCallback: null,
    reset(): void { this.resets++; this.generation++; },
    dispose(): void { this.generation++; },
    captureGeneration(): number { return this.generation; },
    onInvalidated(handler: () => void): void {
      this.invalidate = () => { this.generation++; handler(); };
    },
    onReset(handler: () => void): void {
      this.resetCallback = () => { this.generation++; handler(); };
    },
    onAdopted(handler: (session: StoredSession) => void): void {
      this.adoptedCallback = (session) => { this.generation++; handler(session); };
    },
  };
}

/** Compose a minimal Gambit client double with overridable controller dependencies. */
function makeFakeClient(overrides: Record<string, unknown> = {}) {
  return {
    session: makeFakeSession(),
    auth: {
      login: async () => ({
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-1', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-1', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      register: async () => ({
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-2', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      logout: async () => {},
      refresh: async () => ({
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-refreshed', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      ...overrides,
    },
  };
}

test('initial session is null and isAuthenticated is false', () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  assert.equal(ctrl.currentSession, null);
  assert.equal(ctrl.isAuthenticated(), false);
});

test('login creates a session with correct fields from AuthResponse', async () => {
  const client = makeFakeClient() as any;
  let sessions: (AuthSession | null)[] = [];
  let pending: boolean[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: (p) => { pending.push(p); },
      onError: () => {},
    },
  });
  const session = await ctrl.login('alice', 'pw');
  assert.ok(session);
  assert.equal(session!.handle, 'alice');
  assert.equal(session!.userId, 'u1');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.deepEqual(pending, [true, false]);
});

test('M12 inc 2: login does NOT persist the access token to storage', async () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  await ctrl.login('alice', 'pw');
  const raw = storage.getItem('gambit-session')!;
  const parsed = JSON.parse(raw);
  assert.equal(parsed.accessToken, undefined, 'accessToken must not be persisted');
  assert.equal(parsed.handle, 'alice');
  assert.equal(parsed.userId, 'u1');
});

test('register creates a session with correct fields', async () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  const session = await ctrl.register('bob', 'pw');
  assert.ok(session);
  assert.equal(session!.handle, 'bob');
  assert.equal(session!.userId, 'u2');
});

/**
 * Capture the exact body the controller hands `GambitClient.auth`, for one method.
 *
 * The assertion that matters for the optional registration email is the *shape* of that object,
 * not a serialization of it: `assert.deepEqual` under `node:assert/strict` already treats
 * `{ handle, password, email: undefined }` as different from `{ handle, password }`, and comparing
 * the key set on top says so in the language of the requirement. Comparing `JSON.stringify` output
 * instead would also fail on a harmless reordering of the literal, which is a test that breaks for
 * a reason the product does not care about.
 */
function captureAuthBody<T>(method: 'register' | 'login'): {
  readonly controller: AuthController;
  readonly bodies: readonly T[];
} {
  const bodies: T[] = [];
  const client = makeFakeClient({
    [method]: async (body: T) => {
      bodies.push(body);
      return {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-2', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      };
    },
  }) as unknown as GambitClient;
  const controller = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  return { controller, bodies };
}

test('register forwards a trimmed optional email', async () => {
  const { controller, bodies } = captureAuthBody<RegisterRequest>('register');

  await controller.register('bob', 'pw', '  bob@example.com  ');

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { handle: 'bob', password: 'pw', email: 'bob@example.com' });
});

test('register omits the email key entirely when no email is given or it is blank', async () => {
  const { controller, bodies } = captureAuthBody<RegisterRequest>('register');

  await controller.register('bob', 'pw');
  await controller.register('bob', 'pw', '   ');

  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body, { handle: 'bob', password: 'pw' });
    // Absent, not present-and-empty: the server treats a supplied address as one to verify, so an
    // `email: ''` or `email: null` reaching the wire is a different request from an email-less one.
    assert.deepEqual(Object.keys(body).sort(), ['handle', 'password']);
  }
});

test('sign-in is unaffected by the optional registration email and still sends only credentials', async () => {
  const { controller, bodies } = captureAuthBody<LoginRequest>('login');

  await controller.login('alice', 'pw');

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { handle: 'alice', password: 'pw' });
  assert.deepEqual(Object.keys(bodies[0]!).sort(), ['handle', 'password']);
});

test('logout clears session and calls onSessionChange(null)', async () => {
  const client = makeFakeClient() as any;
  let sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });
  await ctrl.login('alice', 'pw');
  await ctrl.logout();
  assert.equal(ctrl.currentSession, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(sessions[sessions.length - 1], null);
});

/**
 * Revoking the session this browser is using is allowed (ADR-0110), so "the session went away and
 * the user did not ask" is a state a user can now reach on purpose. `SessionManager` clears its own
 * store when a refresh fails, but this controller holds a separate snapshot and a persisted handle
 * hint: without this the header and account controls kept showing a signed-in user whose every
 * protected request answered 401.
 */
test('a session invalidated by a failed refresh stops the UI showing a signed-in user without re-calling client.session.reset()', async () => {
  const storage = makeFakeStorage();
  const fakeSession = makeFakeSession();
  const client = {
    ...makeFakeClient(),
    session: fakeSession,
  };
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(fakeSession.resets, 0);

  // Exactly what SessionManager does when a refresh fails.
  assert.ok(fakeSession.invalidate, 'the controller registered for invalidation');
  fakeSession.invalidate();

  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(ctrl.currentSession, null);
  assert.equal(sessions[sessions.length - 1], null, 'the UI was told to drop the session');
  assert.equal(storage.getItem('gambit-session'), null, 'the persisted hint went too');
  assert.equal(fakeSession.resets, 0, 'must not trigger client.session.reset() again on invalidation');
});

test('when session is reset on another tab (onReset), AuthController clears local state and storage without calling client.session.reset()', async () => {
  const storage = makeFakeStorage();
  const fakeSession = makeFakeSession();
  const client = {
    ...makeFakeClient(),
    session: fakeSession,
  };
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(storage.getItem('gambit-session') !== null, true);
  assert.equal(fakeSession.resets, 0);

  // Trigger the cross-tab reset callback
  assert.ok(fakeSession.resetCallback, 'the controller registered for onReset');
  fakeSession.resetCallback();

  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(ctrl.currentSession, null);
  assert.equal(sessions[sessions.length - 1], null, 'the UI was told to drop the session');
  assert.equal(storage.getItem('gambit-session'), null, 'the persisted state was cleared');
  assert.equal(fakeSession.resets, 0, 'must not trigger client.session.reset() again');
});

test('local login produces exactly one onSessionChange and one storage write', async () => {
  const storage = makeFakeStorage();
  let setItemCalls = 0;
  const instrumentedStorage: KeyValueStorage = {
    getItem: (k: string) => storage.getItem(k),
    setItem: (k: string, v: string) => {
      setItemCalls++;
      storage.setItem(k, v);
    },
    removeItem: (k: string) => storage.removeItem(k),
  };

  const sessions: (AuthSession | null)[] = [];
  const fakeSession = makeFakeSession();
  const client = {
    session: fakeSession,
    auth: {
      login: async () => {
        const res = {
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
          tokens: { accessToken: 'tok-1', tokenType: 'Bearer' as const, expiresIn: 900, refreshToken: 'ref-1', refreshExpiresAt: '2030-01-01T00:00:00Z' },
        };
        return res;
      },
    },
  };

  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage: instrumentedStorage,
  });

  const session = await ctrl.login('alice', 'pw');
  assert.ok(session);
  assert.equal(session.handle, 'alice');
  assert.equal(session.userId, 'u1');
  assert.equal(sessions.length, 1, 'must have exactly one onSessionChange notification');
  assert.equal(setItemCalls, 1, 'must have exactly one storage write');
});

test('peer reset wins over a late login response', async () => {
  let finish!: (response: AuthResponse) => void;
  const response = new Promise<AuthResponse>((resolve) => { finish = resolve; });
  const fakeSession = makeFakeSession();
  const client = { ...makeFakeClient({ login: async () => response }), session: fakeSession };
  const changes: (AuthSession | null)[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: () => {},
      onError: () => {},
    },
  });

  const pending = controller.login('alice', 'pw');
  fakeSession.resetCallback?.();
  finish({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'late', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });

  assert.equal(await pending, null);
  assert.equal(controller.currentSession, null);
  assert.deepEqual(changes, [null]);
});

test('login starts in the new controller generation after synchronizing a persisted logout', async () => {
  const storage = makeFakeStorage();
  const fakeSession = makeFakeSession();
  const client = { ...makeFakeClient(), session: fakeSession };
  const changes: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    storage,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: () => {},
      onError: () => {},
    },
  });
  const capture = fakeSession.captureGeneration.bind(fakeSession);
  let synchronized = false;
  fakeSession.captureGeneration = () => {
    if (!synchronized) {
      synchronized = true;
      fakeSession.resetCallback?.();
    }
    return capture();
  };

  const result = await ctrl.login('alice', 'pw');

  assert.deepEqual(result, { handle: 'alice', userId: 'u1' });
  assert.deepEqual(changes, [null, { handle: 'alice', userId: 'u1' }]);
});

test('dispose suppresses a late login result and callbacks', async () => {
  let finish!: (response: AuthResponse) => void;
  const response = new Promise<AuthResponse>((resolve) => { finish = resolve; });
  const client = makeFakeClient({ login: async () => response });
  const changes: (AuthSession | null)[] = [];
  const pendingStates: boolean[] = [];
  const errors: string[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: (pending) => { pendingStates.push(pending); },
      onError: (error) => { errors.push(error); },
    },
  });

  const pending = controller.login('alice', 'pw');
  controller.dispose();
  finish({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'late', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });

  assert.equal(await pending, null);
  assert.equal(controller.currentSession, null);
  assert.deepEqual(changes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(pendingStates, [true]);
});

test('a failed local login does not report over a newer peer adoption', async () => {
  let fail!: (error: Error) => void;
  const response = new Promise<AuthResponse>((_resolve, reject) => { fail = reject; });
  const client = makeFakeClient({ login: async () => response });
  const errors: string[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: (error) => { errors.push(error); } },
  });

  const pending = controller.login('alice', 'pw');
  client.session.adoptedCallback?.({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'peer', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
    accessTokenExpiresAt: 2000,
  });
  fail(new Error('obsolete network failure'));

  assert.equal(await pending, null);
  assert.deepEqual(controller.currentSession, { handle: 'bob', userId: 'u2' });
  assert.deepEqual(errors, []);
  controller.dispose();
});

test('dispose suppresses a late logout continuation and preserves newer persistence', async () => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));
  const client = makeFakeClient({ logout: async () => response });
  const changes: (AuthSession | null)[] = [];
  const pendingStates: boolean[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    storage,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: (pending) => { pendingStates.push(pending); },
      onError: () => {},
    },
  });

  const pending = controller.logout();
  controller.dispose();
  storage.setItem('gambit-session', JSON.stringify({ handle: 'bob', userId: 'u2' }));
  finish();
  await pending;

  assert.deepEqual(JSON.parse(storage.getItem('gambit-session')!), { handle: 'bob', userId: 'u2' });
  assert.deepEqual(changes, []);
  assert.deepEqual(pendingStates, [true]);
});

test('overlapping auth operations keep the UI pending until every operation settles', async () => {
  let finishFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { finishFirst = resolve; });
  let logoutCalls = 0;
  const client = makeFakeClient({
    logout: async () => {
      logoutCalls++;
      if (logoutCalls === 1) await firstResponse;
    },
  });
  const pendingStates: boolean[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: () => {},
      onPending: (pending) => { pendingStates.push(pending); },
      onError: () => {},
    },
  });

  const first = controller.logout();
  const second = controller.logout();
  await second;

  assert.deepEqual(pendingStates, [true], 'the first operation is still pending');
  finishFirst();
  await first;
  assert.deepEqual(pendingStates, [true, false]);
  controller.dispose();
});

test('peer reset during logout clears the pending state without repeating the reset', async () => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  const client = makeFakeClient({ logout: async () => response });
  const changes: (AuthSession | null)[] = [];
  const pendingStates: boolean[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: (pending) => { pendingStates.push(pending); },
      onError: () => {},
    },
  });

  await controller.login('alice', 'pw');
  changes.length = 0;
  pendingStates.length = 0;
  const pending = controller.logout();
  client.session.resetCallback?.();
  finish();
  await pending;

  assert.deepEqual(changes, [null]);
  assert.deepEqual(pendingStates, [true, false]);
  assert.equal(client.session.resets, 0, 'the controller must not turn a peer reset into local logout');
  controller.dispose();
});

test('a peer adoption that completes during logout remains the controller session', async () => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  const storage = makeFakeStorage();
  const client = makeFakeClient({ logout: async () => response });
  const changes: (AuthSession | null)[] = [];
  const controller = new AuthController({
    client: client as unknown as GambitClient,
    storage,
    callbacks: {
      onSessionChange: (session) => { changes.push(session); },
      onPending: () => {},
      onError: () => {},
    },
  });

  await controller.login('alice', 'pw');
  changes.length = 0;
  const pending = controller.logout();
  client.session.adoptedCallback?.({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
    tokens: { accessToken: 'peer', tokenType: 'Bearer' as const, expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
    accessTokenExpiresAt: 2000,
  });
  Object.assign(client.session, { isAuthenticated: true });
  finish();
  await pending;

  assert.deepEqual(controller.currentSession, { handle: 'bob', userId: 'u2' });
  assert.deepEqual(JSON.parse(storage.getItem('gambit-session')!), { handle: 'bob', userId: 'u2' });
  assert.deepEqual(changes, [{ handle: 'bob', userId: 'u2' }]);
  controller.dispose();
});

test('peer tab adoption updates AuthController with exactly one onSessionChange notification', async () => {
  const storage = makeFakeStorage();
  const sessions: (AuthSession | null)[] = [];
  const fakeSession = makeFakeSession();
  const client = {
    session: fakeSession,
    auth: {},
  };

  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });

  assert.equal(ctrl.isAuthenticated(), false);

  // Peer tab adopts
  assert.ok(fakeSession.adoptedCallback, 'controller registered onAdopted');
  fakeSession.adoptedCallback({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
    tokens: { accessToken: 'tok-peer', tokenType: 'Bearer' as const, expiresIn: 900, refreshToken: 'ref-peer', refreshExpiresAt: '2030-01-01T00:00:00Z' },
    accessTokenExpiresAt: 2000,
  });

  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(ctrl.currentSession?.handle, 'bob');
  assert.equal(ctrl.currentSession?.userId, 'u2');
  assert.equal(sessions.length, 1, 'peer adoption triggers exactly one onSessionChange');
  assert.deepEqual(sessions[0], { handle: 'bob', userId: 'u2' });
});

test('a duplicate peer adoption for the same user does not re-emit onSessionChange', async () => {
  const sessions: (AuthSession | null)[] = [];
  const fakeSession = makeFakeSession();
  const client = {
    session: fakeSession,
    auth: {
      login: async () => {
        const res = {
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
          tokens: { accessToken: 'tok-1', tokenType: 'Bearer' as const, expiresIn: 900, refreshToken: 'ref-1', refreshExpiresAt: '2030-01-01T00:00:00Z' },
        };
        // Simulate a peer-tab adoption racing the controller's own login continuation.
        fakeSession.adoptedCallback?.({
          user: res.user,
          tokens: res.tokens,
          accessTokenExpiresAt: 2000,
        });
        return res;
      },
    },
  };

  const ctrl = new AuthController({
    client: client as unknown as GambitClient,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });

  await ctrl.login('alice', 'pw');
  assert.equal(sessions.length, 1);

  // A later peer adoption repeats the same user with rotated credentials.
  fakeSession.adoptedCallback?.({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] as const },
    tokens: { accessToken: 'tok-refreshed', tokenType: 'Bearer' as const, expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
    accessTokenExpiresAt: 3000,
  });

  assert.equal(sessions.length, 1, 'must NOT emit another onSessionChange for the same-user peer adoption');
});

test('M12 inc 2: restore takes identity from cookie refresh, not storage', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  let session: AuthSession | null = null;
  const ctrl = new AuthController({
    client: makeFakeClient() as any,
    callbacks: { onSessionChange: (s) => { session = s; }, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.ok(restored);
  assert.equal(restored!.handle, 'alice');
  assert.equal(restored!.userId, 'u1');
  assert.equal(session, restored);
  assert.deepEqual(JSON.parse(storage.getItem('gambit-session')!), {
    handle: 'alice', userId: 'u1',
  });
});

test('M12 inc 2: restore returns null when storage is empty', async () => {
  const storage = makeFakeStorage();
  const ctrl = new AuthController({
    client: makeFakeClient() as any,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  assert.equal(await ctrl.restore(), null);
});

test('M12 inc 2: restore returns null when refresh fails (cookie expired)', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  const client = makeFakeClient({
    refresh: async () => { throw new Error('cookie expired'); },
  }) as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.equal(restored, null);
  // Persisted state should be cleared.
  assert.equal(storage.getItem('gambit-session'), null);
});

test('errors are reported via onError', async () => {
  const client = makeFakeClient({
    login: async () => { throw new Error('bad password'); },
  }) as any;
  let errors: string[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: (m) => { errors.push(m); } },
  });
  const result = await ctrl.login('alice', 'wrong');
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'bad password');
});


test('M12 inc 2: reload path — persisted {handle,userId} + refresh yields session + access token', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  let refreshCalled = false;
  let refreshResult: any = null;
  const client = makeFakeClient({
    refresh: async () => {
      refreshCalled = true;
      refreshResult = {
        user: { id: 'u3', handle: 'stored-user', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'fresh-from-cookie', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      };
      return refreshResult;
    },
  }) as any;
  // Add a mock session that tracks the current access token (like SessionManager does).
  let currentAccessToken: string | undefined;
  client.session = {
    get current() { return currentAccessToken ? { tokens: { accessToken: currentAccessToken } } : null; },
    adopt: (auth: any) => { currentAccessToken = auth.tokens.accessToken; },
    reset: () => { currentAccessToken = undefined; },
    onInvalidated: () => {},
    get isAuthenticated() { return currentAccessToken !== undefined; },
  };
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.ok(restored, 'restore should return a session');
  assert.equal(restored!.handle, 'stored-user');
  assert.equal(refreshCalled, true, 'refresh should have been called via cookie');
  // The refresh response should contain a valid access token.
  assert.ok(refreshResult?.tokens?.accessToken, 'refresh response should contain an access token');
  assert.equal(refreshResult.tokens.accessToken, 'fresh-from-cookie');
});

test('password reset clearance wins over an in-flight session restore', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));

  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshed = {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'late-token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  };
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    now: () => 1000,
    transport: {
      async send() {
        await refreshGate;
        return json(200, refreshed);
      },
    },
  });

  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (session) => { sessions.push(session); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });

  const restore = ctrl.restore();
  ctrl.clearLocalSession();
  releaseRefresh();

  assert.equal(await restore, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(client.session.current, null);
  assert.equal(storage.getItem('gambit-session'), null);
  assert.deepEqual(sessions, [null]);
  ctrl.dispose();
});

test('a cancelled restore continuation does not reset a subsequently adopted session', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));
  const user = { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] } as const;
  const tokens = { accessToken: 'restore', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' } as const;
  const tokenStore = new MemoryTokenStore();
  let ctrl!: AuthController;
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    now: () => 1000,
    transport: { send: async () => json(200, { user, tokens }) },
    tokenStore: {
      load: () => tokenStore.load(),
      clear: () => tokenStore.clear(),
      save(session) {
        tokenStore.save(session);
        if (session.tokens.accessToken === 'restore') {
          // Change the lifecycle after the API saves, before the controller resumes.
          queueMicrotask(() => {
            ctrl.clearLocalSession();
            client.session.adopt({ user, tokens: { ...tokens, accessToken: 'newer' } });
          });
        }
      },
    },
  });
  ctrl = new AuthController({
    client,
    storage,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });

  assert.equal(await ctrl.restore(), null);
  assert.equal(client.session.current?.tokens.accessToken, 'newer');
  ctrl.dispose();
});

test('dispose ignores future calls', async () => {
  const client = makeFakeClient() as any;
  let changes = 0;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => { changes++; }, onPending: () => {}, onError: () => {} },
  });
  ctrl.dispose();
  await ctrl.login('alice', 'pw');
  assert.equal(changes, 0);
  assert.equal(ctrl.isAuthenticated(), false);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`cancelled restore ${outcome} leaves the newer login intact`, async () => {
    const storage = makeFakeStorage();
    storage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const newer: AuthResponse = {
      user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
      tokens: { accessToken: 'newer-login', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
    };
    const client = new GambitClient({
      baseUrl: 'https://api.test',
      now: () => 1000,
      transport: {
        async send(request) {
          if (request.url.endsWith('/refresh')) {
            await gate;
            return outcome === 'success'
              ? json(200, { ...newer, tokens: { ...newer.tokens, accessToken: 'obsolete-restore' } })
              : json(401, { error: { code: 'unauthenticated', message: 'rotation lost', requestId: 'restore' } });
          }
          return json(200, newer);
        },
      },
    });
    const changes: (AuthSession | null)[] = [];
    const ctrl = new AuthController({
      client,
      storage,
      callbacks: { onSessionChange: (session) => { changes.push(session); }, onPending: () => {}, onError: () => {} },
    });

    const restoring = ctrl.restore();
    ctrl.clearLocalSession();
    const login = ctrl.login('bob', 'password');
    finish();

    assert.equal(await restoring, null, 'a cancelled operation must not adopt another operation\'s result');
    await login;
    assert.equal(client.session.current?.tokens.accessToken, 'newer-login');
    assert.deepEqual(ctrl.currentSession, { handle: 'bob', userId: 'u2' });
    assert.deepEqual(JSON.parse(storage.getItem('gambit-session')!), { handle: 'bob', userId: 'u2' });
    assert.deepEqual(changes, [null, { handle: 'bob', userId: 'u2' }]);
    ctrl.dispose();
  });
}

test('M2: isAuthenticated gates create-seek path', async () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  // Before login: not authenticated
  assert.equal(ctrl.isAuthenticated(), false);
  // After login: authenticated
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);
  // After logout: not authenticated
  await ctrl.logout();
  assert.equal(ctrl.isAuthenticated(), false);
});
