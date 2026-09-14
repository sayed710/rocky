import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AuthService } from '../src/auth/service';
import { ScryptPasswordHasher } from '../src/auth/password';
import { AccessTokenService } from '../src/auth/tokens';
import { createInMemoryRepositories } from '../src/fakes';
import { InMemoryEmailSender } from '../src/ports/email';
import { ManualClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';
import { START_MS, TEST_SECRET, startHarness } from './helpers';

/** Construct the auth service at a chosen refresh-collision grace boundary. */
function authServiceWithGrace(refreshGracePeriodMs: number): AuthService {
  const clock = new ManualClock(START_MS);
  return new AuthService({
    repos: createInMemoryRepositories(clock),
    hasher: new ScryptPasswordHasher({ N: 1024 }),
    tokens: new AccessTokenService({ secret: TEST_SECRET, ttlSec: 900, clock, ids: uuidv7Generator }),
    clock,
    ids: uuidv7Generator,
    refreshTtlSec: 3_600,
    emailSender: new InMemoryEmailSender(),
    webauthn: { rpId: 'localhost', origins: ['http://localhost'] },
    refreshGracePeriodMs,
  });
}

test('refresh grace configuration rejects values that could disable reuse detection', () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
    assert.throws(() => authServiceWithGrace(invalid), RangeError);
  }
  assert.doesNotThrow(() => authServiceWithGrace(0));
  assert.doesNotThrow(() => authServiceWithGrace(60_000));
});

test('register issues tokens and grants the base user role', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'alice', password: 'hunter2hunter2' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.handle, 'alice');
    assert.deepEqual(res.body.user.roles, ['user']);
    assert.equal(res.body.tokens.tokenType, 'Bearer');
    assert.ok(res.body.tokens.accessToken);
    assert.ok(res.body.tokens.refreshToken);
    assert.equal(res.body.tokens.expiresIn, 900);
    // Password is stored hashed, never in plaintext.
    const stored = await h.repos.users.getPasswordHash(res.body.user.id);
    assert.ok(stored && stored.startsWith('scrypt$'));
    assert.equal(h.repos.audit.withAction('auth.register').length, 1);
  } finally {
    await h.close();
  }
});

test('duplicate handle is rejected with 409 (case-insensitive)', async () => {
  const h = await startHarness();
  try {
    await h.json('POST', '/v1/auth/register', { body: { handle: 'Bob', password: 'password123' } });
    const dup = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'bob', password: 'password123' },
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'conflict');
  } finally {
    await h.close();
  }
});

test('concurrent registration creates one complete account and returns one conflict', async () => {
  const h = await startHarness();
  try {
    const requests = ['RaceUser', 'raceuser'].map((handle) =>
      h.json('POST', '/v1/auth/register', {
        body: { handle, password: 'password123' },
      }));
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const user = await h.repos.users.findByHandle('RACEUSER');
    assert.ok(user);
    assert.ok(await h.repos.users.getPasswordHash(user.id));
    assert.deepEqual(await h.repos.users.rolesOf(user.id), ['user']);
  } finally {
    await h.close();
  }
});

test('invalid registration input is a 422 with details', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'a', password: 'short' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(res.body.error.requestId);
  } finally {
    await h.close();
  }
});

test('login succeeds with correct password and fails otherwise', async () => {
  const h = await startHarness();
  try {
    await h.json('POST', '/v1/auth/register', { body: { handle: 'carol', password: 'passw0rd!!' } });
    const ok = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'carol', password: 'passw0rd!!' },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.tokens.accessToken);

    const bad = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'carol', password: 'wrong-password' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'unauthorized');
  } finally {
    await h.close();
  }
});

test('a login verified before password reset cannot create a surviving session afterwards', async () => {
  const h = await startHarness();
  try {
    const registered = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'reset-race', password: 'old-passw0rd!!' },
    });
    const userId = registered.body.user.id as string;
    const originalCreate = h.repos.sessions.create.bind(h.repos.sessions);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    h.repos.sessions.create = async (session) => {
      markCreateStarted();
      await createGate;
      return originalCreate(session);
    };

    const pendingLogin = h.json('POST', '/v1/auth/login', {
      body: { handle: 'reset-race', password: 'old-passw0rd!!' },
    });
    await createStarted;
    const hasher = new ScryptPasswordHasher({ N: 1024 });
    await h.repos.users.setPassword(userId, await hasher.hash('new-passw0rd!!'));
    await h.repos.sessions.revokeAllForUser(userId, new Date(h.clock.now()));
    releaseCreate();

    const result = await pendingLogin;
    assert.equal(result.status, 401);
    const sessions = await h.repos.sessions.listForUser(userId);
    assert.ok(sessions.every((session) => session.revokedAt !== null));
  } finally {
    await h.close();
  }
});

test('login for an unknown handle is 401 (no user enumeration)', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'ghost', password: 'whatever12' },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('the access token authorizes /v1/users/me', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'dave', password: 'passw0rd!!' },
    });
    const me = await h.json('GET', '/v1/users/me', { token: reg.body.tokens.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.handle, 'dave');
  } finally {
    await h.close();
  }
});

test('refresh rotates the token and revokes the old session', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'erin', password: 'passw0rd!!' },
    });
    const first = reg.body.tokens.refreshToken;
    const rot = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: first } });
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.tokens.refreshToken, first);
    assert.ok(rot.body.tokens.accessToken);

    // The old refresh token no longer works.
    const reused = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: first } });
    assert.equal(reused.status, 401);
  } finally {
    await h.close();
  }
});

test('two concurrent refreshes consume a token at most once', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'refresh-race', password: 'passw0rd!!' },
    });
    const refreshToken = reg.body.tokens.refreshToken;
    const responses = await Promise.all([
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  } finally {
    await h.close();
  }
});

test('two concurrent refreshes from the same token family leave the winner successor chain alive', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'refresh-race-survives', password: 'passw0rd!!' },
    });
    const refreshToken = reg.body.tokens.refreshToken;
    const responses = await Promise.all([
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
      h.json('POST', '/v1/auth/refresh', { body: { refreshToken } }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    const winner = responses.find((r) => r.status === 200);
    assert.ok(winner);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 0, 'concurrent refresh must not trigger false reuse detection');

    const successorRefresh = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: winner.body.tokens.refreshToken },
    });
    assert.equal(successorRefresh.status, 200, 'winner successor token must survive and be refreshable');
  } finally {
    await h.close();
  }
});

test('a refresh collision delayed beyond the grace period triggers reuse detection', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'delayed-refresh-race', password: 'passw0rd!!' },
    });
    const refreshToken = reg.body.tokens.refreshToken;
    const rotate = h.repos.sessions.rotate.bind(h.repos.sessions);
    let releaseFirstRotate!: () => void;
    const firstRotateGate = new Promise<void>((resolve) => { releaseFirstRotate = resolve; });
    let markFirstRotateStarted!: () => void;
    const firstRotateStarted = new Promise<void>((resolve) => { markFirstRotateStarted = resolve; });
    let rotateCalls = 0;
    h.repos.sessions.rotate = async (refreshHash, replacement, at) => {
      rotateCalls += 1;
      if (rotateCalls === 1) {
        markFirstRotateStarted();
        await firstRotateGate;
      }
      return rotate(refreshHash, replacement, at);
    };

    const delayed = h.json('POST', '/v1/auth/refresh', { body: { refreshToken } });
    await firstRotateStarted;
    const winner = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken } });
    assert.equal(winner.status, 200);

    h.clock.advance(15_000);
    releaseFirstRotate();
    const replay = await delayed;
    assert.equal(replay.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1, 'delayed collision is reuse');

    const afterBurn = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: winner.body.tokens.refreshToken },
    });
    assert.equal(afterBurn.status, 401, 'the winner successor is burned after delayed reuse');
  } finally {
    await h.close();
  }
});

test('replaying a rotated token within the grace period returns 401 without burning the chain', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'grace-user', password: 'passw0rd!!' },
    });
    const t0 = reg.body.tokens.refreshToken;
    const r1 = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(r1.status, 200);
    const t1 = r1.body.tokens.refreshToken;

    // Advance by 5s (within 10s grace window).
    h.clock.advance(5_000);
    const retry = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(retry.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 0, 'must not burn inside grace window');

    // The legitimate successor token t1 is STILL VALID and not burned.
    const validRefresh = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t1 } });
    assert.equal(validRefresh.status, 200);
  } finally {
    await h.close();
  }
});

test('reusing a rotated refresh token burns the whole session chain', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'frank', password: 'passw0rd!!' },
    });
    const t0 = reg.body.tokens.refreshToken;
    const r1 = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    const t1 = r1.body.tokens.refreshToken; // current, still valid

    // Attacker replays the already-rotated t0 after the grace period → theft detected.
    h.clock.advance(15_000);
    const theft = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(theft.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1);

    // The legitimate current token is now also revoked (chain burned).
    const afterBurn = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t1 } });
    assert.equal(afterBurn.status, 401);
  } finally {
    await h.close();
  }
});

test('clock rollback when replaying a rotated token triggers reuse detection', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'clock-skew-user', password: 'passw0rd!!' },
    });
    const t0 = reg.body.tokens.refreshToken;
    const r1 = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(r1.status, 200);
    const t1 = r1.body.tokens.refreshToken;

    // Simulate clock rollback: clock moves backwards by 10s (now < rotatedAt, elapsed < 0)
    h.clock.advance(-10_000);

    const replay = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t0 } });
    assert.equal(replay.status, 401);
    assert.equal(
      h.repos.audit.withAction('auth.refresh.reuse').length,
      1,
      'negative elapsed time must NOT suppress reuse detection',
    );

    // The current token must be revoked (whole chain burned)
    const afterBurn = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: t1 } });
    assert.equal(afterBurn.status, 401);
  } finally {
    await h.close();
  }
});

test('expired refresh tokens are rejected', async () => {
  const h = await startHarness({ refreshTokenTtlSec: 60 });
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'gail', password: 'passw0rd!!' },
    });
    h.clock.advance(61_000);
    const res = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: reg.body.tokens.refreshToken },
    });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('logout revokes the session; listing sessions reflects it', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'hank', password: 'passw0rd!!' },
    });
    const token = reg.body.tokens.accessToken;
    const refresh = reg.body.tokens.refreshToken;

    const list1 = await h.json('GET', '/v1/auth/sessions', { token });
    assert.equal(list1.status, 200);
    assert.equal(list1.body.length, 1);
    assert.equal(list1.body[0].revokedAt, null);

    const out = await h.json('POST', '/v1/auth/logout', { token, body: { refreshToken: refresh } });
    assert.equal(out.status, 204);

    const list2 = await h.json('GET', '/v1/auth/sessions', { token });
    assert.equal(list2.body[0].revokedAt !== null, true);

    const afterLogout = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: refresh } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await h.close();
  }
});

test('logout of a rotated token revokes its live successor chain', async () => {
  const h = await startHarness();
  try {
    const registered = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'logout-race', password: 'passw0rd!!' },
    });
    const originalRefresh = registered.body.tokens.refreshToken;
    const rotated = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: originalRefresh },
    });
    assert.equal(rotated.status, 200);

    const out = await h.json('POST', '/v1/auth/logout', {
      token: rotated.body.tokens.accessToken,
      body: { refreshToken: originalRefresh },
    });
    assert.equal(out.status, 204);

    const successor = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: rotated.body.tokens.refreshToken },
    });
    assert.equal(successor.status, 401);
  } finally {
    await h.close();
  }
});

test('missing/expired access tokens are rejected on protected routes', async () => {
  const h = await startHarness();
  try {
    const anon = await h.json('GET', '/v1/users/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get('www-authenticate'), 'Bearer');

    const bad = await h.json('GET', '/v1/users/me', { token: 'not-a-real-token' });
    assert.equal(bad.status, 401);
  } finally {
    await h.close();
  }
});

// --- Session revocation (M14 inc 46) ---------------------------------------

test('a user can revoke one of their own sessions, and the refresh token dies with it', async () => {
  const h = await startHarness();
  try {
    // Two sessions for the same user: register, then log in again.
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'sonia', password: 'passw0rd!!' },
    });
    const token = reg.body.tokens.accessToken;
    const firstRefresh = reg.body.tokens.refreshToken;

    const second = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'sonia', password: 'passw0rd!!' },
    });
    const secondRefresh = second.body.tokens.refreshToken;

    const before = await h.json('GET', '/v1/auth/sessions', { token });
    assert.equal(before.body.length, 2);
    // Pin which row is which rather than taking whichever the list happens to order first: the
    // whole point of this test is the *order* the two refreshes are attempted in, so the token
    // belonging to the revoked session has to be known, not guessed.
    const byNewest = [...before.body].sort(
      (x: { createdAt: string }, y: { createdAt: string }) =>
        Date.parse(y.createdAt) - Date.parse(x.createdAt),
    );
    const victim = byNewest[0]; // the second sign-in, holding secondRefresh

    const del = await h.json('DELETE', `/v1/auth/sessions/${victim.id}`, { token });
    assert.equal(del.status, 204);

    const after = await h.json('GET', '/v1/auth/sessions', { token });
    const revoked = after.body.find((s: { id: string }) => s.id === victim.id);
    assert.notEqual(revoked.revokedAt, null, 'the targeted session is revoked');
    assert.equal(h.repos.audit.withAction('auth.session.revoke').length, 1);

    // The revoked browser then does what any client does when its access token runs out: it
    // refreshes. That must fail, and it must not take the surviving session down with it — treating
    // a deliberately revoked row as token reuse would burn the whole account here, which is exactly
    // what revoking a single session promises not to do. Order matters: the surviving session is
    // checked *after* the revoked one has tried.
    const revokedRetry = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: secondRefresh },
    });
    assert.equal(revokedRetry.status, 401, 'the revoked session cannot mint another token');

    const survivor = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: firstRefresh },
    });
    assert.equal(survivor.status, 200, 'revoking one session must not invalidate the other');
    assert.equal(
      h.repos.audit.withAction('auth.refresh.reuse').length,
      0,
      'a deliberate revocation is not token theft',
    );
  } finally {
    await h.close();
  }
});

/**
 * The route resolves the path id only within the caller's own session list, so another user's id is
 * simply absent from the set. Reported as 404 rather than 403 on purpose: telling the caller "that
 * exists but is not yours" would make this an oracle for live session ids across the platform.
 */
test('a user cannot revoke another user\'s session, and is not told it exists', async () => {
  const h = await startHarness();
  try {
    const mallory = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'mallory', password: 'passw0rd!!' },
    });
    const victim = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'victim', password: 'passw0rd!!' },
    });

    const victimSessions = await h.json('GET', '/v1/auth/sessions', {
      token: victim.body.tokens.accessToken,
    });
    const victimSessionId = victimSessions.body[0].id;

    const attack = await h.json('DELETE', `/v1/auth/sessions/${victimSessionId}`, {
      token: mallory.body.tokens.accessToken,
    });
    assert.equal(attack.status, 404);
    assert.equal(attack.body.error.code, 'not_found');

    // The victim's session is untouched and still refreshes.
    const still = await h.json('GET', '/v1/auth/sessions', {
      token: victim.body.tokens.accessToken,
    });
    assert.equal(still.body[0].revokedAt, null);
    assert.equal(h.repos.audit.withAction('auth.session.revoke').length, 0);
  } finally {
    await h.close();
  }
});

test('revoking an unknown session id is a 404', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'nadia', password: 'passw0rd!!' },
    });
    const res = await h.json('DELETE', '/v1/auth/sessions/does-not-exist', {
      token: reg.body.tokens.accessToken,
    });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

/**
 * Revoking twice succeeds twice. The caller asked for that session to be dead and it is dead, so
 * there is nothing to report — and it means two simultaneous revocations of the same id both win
 * rather than one losing a race.
 */
test('revoking an already-revoked session succeeds and does not audit twice', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'ivan', password: 'passw0rd!!' },
    });
    const token = reg.body.tokens.accessToken;
    const list = await h.json('GET', '/v1/auth/sessions', { token });
    const id = list.body[0].id;

    const first = await h.json('DELETE', `/v1/auth/sessions/${id}`, { token });
    const second = await h.json('DELETE', `/v1/auth/sessions/${id}`, { token });
    assert.equal(first.status, 204);
    assert.equal(second.status, 204, 'idempotent: the desired end state already holds');
    assert.equal(h.repos.audit.withAction('auth.session.revoke').length, 1, 'audited once, not twice');
  } finally {
    await h.close();
  }
});

/**
 * The sequential case above cannot reach the read-then-write race that made this necessary: an
 * `if (revokedAt) return` in the service followed by an unconditional update lets two in-flight
 * requests both observe an active row and both audit one revocation. Only concurrent calls show it.
 */
test('simultaneous revocations of the same session audit it once', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'wanda', password: 'passw0rd!!' },
    });
    const token = reg.body.tokens.accessToken;
    const list = await h.json('GET', '/v1/auth/sessions', { token });
    const id = list.body[0].id;

    const results = await Promise.all([
      h.json('DELETE', `/v1/auth/sessions/${id}`, { token }),
      h.json('DELETE', `/v1/auth/sessions/${id}`, { token }),
      h.json('DELETE', `/v1/auth/sessions/${id}`, { token }),
    ]);

    assert.deepEqual(results.map((r) => r.status), [204, 204, 204], 'every caller gets its end state');
    assert.equal(
      h.repos.audit.withAction('auth.session.revoke').length,
      1,
      'one revocation happened, so one record describes it',
    );
  } finally {
    await h.close();
  }
});

/**
 * A session is a chain of rows, not one row: every refresh retires the current row and inserts a
 * successor. Revoking only the row the caller named would leave the successor refreshing, which is
 * the outcome of a refresh landing mid-revocation. Reached deterministically here by rotating first.
 */
test('revoking a session also ends the session it was rotated into', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'oscar', password: 'passw0rd!!' },
    });
    const originalId = (await h.json('GET', '/v1/auth/sessions', { token: reg.body.tokens.accessToken }))
      .body[0].id;

    // Refresh, so the original row is retired and a successor holds the account.
    const rotated = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: reg.body.tokens.refreshToken },
    });
    assert.equal(rotated.status, 200);
    const token = rotated.body.tokens.accessToken;

    const del = await h.json('DELETE', `/v1/auth/sessions/${originalId}`, { token });
    assert.equal(del.status, 204);

    const retry = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: rotated.body.tokens.refreshToken },
    });
    assert.equal(retry.status, 401, 'the successor is no longer a working refresh capability');
  } finally {
    await h.close();
  }
});

/**
 * The reuse detection the rotation scheme exists for still has to fire. Distinguishing a stolen
 * token from a deliberately revoked one must not turn into accepting both.
 */
test('replaying a rotated-away refresh token still burns the account', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'trudy', password: 'passw0rd!!' },
    });
    const stolen = reg.body.tokens.refreshToken;

    // The real client refreshes, so `stolen` is now a token that has already been exchanged.
    const legitimate = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    assert.equal(legitimate.status, 200);

    h.clock.advance(15_000);
    const replay = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    assert.equal(replay.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1, 'recorded as reuse');

    const afterBurn = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: legitimate.body.tokens.refreshToken },
    });
    assert.equal(afterBurn.status, 401, 'the live successor is burned with the rest of the chain');
  } finally {
    await h.close();
  }
});

/**
 * After two refreshes the *direct* successor of a stolen token has itself been rotated away, so
 * asking only "is this row's successor live" answers no and lets the replay pass as an ordinary
 * expired session. Liveness has to be asked of the whole descending chain.
 */
test('a stolen refresh token is detected however many rotations have happened since', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'peggy', password: 'passw0rd!!' },
    });
    const stolen = reg.body.tokens.refreshToken;

    const second = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    assert.equal(second.status, 200);
    const third = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: second.body.tokens.refreshToken },
    });
    assert.equal(third.status, 200);

    h.clock.advance(15_000);
    const replay = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    assert.equal(replay.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1, 'still recorded as reuse');

    const afterBurn = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: third.body.tokens.refreshToken },
    });
    assert.equal(afterBurn.status, 401, 'the account was burned two rotations later');
  } finally {
    await h.close();
  }
});

test('refresh reuse detection is independent of repository session ordering', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'ordering', password: 'passw0rd!!' },
    });
    const stolen = reg.body.tokens.refreshToken;
    const second = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    const third = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: second.body.tokens.refreshToken },
    });
    assert.equal(third.status, 200);

    const listForUser = h.repos.sessions.listForUser.bind(h.repos.sessions);
    h.repos.sessions.listForUser = async (userId: string) => (await listForUser(userId)).reverse();

    h.clock.advance(15_000);
    const replay = await h.json('POST', '/v1/auth/refresh', { body: { refreshToken: stolen } });
    assert.equal(replay.status, 401);
    assert.equal(h.repos.audit.withAction('auth.refresh.reuse').length, 1);

    const afterBurn = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: third.body.tokens.refreshToken },
    });
    assert.equal(afterBurn.status, 401, 'the live descendant is revoked for any repository ordering');
  } finally {
    await h.close();
  }
});

test('session revocation requires authentication', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('DELETE', '/v1/auth/sessions/anything');
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});
