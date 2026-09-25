/**
 * Integration tests for the httpOnly refresh-token cookie (M12 inc 2).
 *
 * Coverage:
 *  - Login sets an httpOnly refresh cookie with the right attributes.
 *  - Refresh works using the cookie (no body token).
 *  - Refresh still works with a body token (API-client path).
 *  - Logout clears the cookie.
 *  - Secure flag reflects config.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness, verifyEmail } from './helpers.js';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../src/http/cookie.js';

/** Extract the Set-Cookie value from a Headers object (Node fetch). */
function getSetCookie(headers: Headers): string | null {
  // Node's fetch returns Headers; getSetCookie is available on the native Headers.
  const setCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookie && setCookie.length > 0) return setCookie[0]!;
  return headers.get('set-cookie');
}

/** Parse a Set-Cookie string into the cookie value and attribute map. */
function parseSetCookie(raw: string): { value: string; attrs: Record<string, string> } {
  const parts = raw.split(';').map((p) => p.trim());
  const [nameValue, ...rest] = parts;
  const eq = nameValue!.indexOf('=');
  const value = nameValue!.slice(eq + 1);
  const attrs: Record<string, string> = {};
  for (const part of rest) {
    const peq = part.indexOf('=');
    if (peq === -1) attrs[part.toLowerCase()] = 'true';
    else attrs[part.slice(0, peq).toLowerCase()] = part.slice(peq + 1);
  }
  return { value, attrs };
}

test('login sets an httpOnly refresh cookie with the right attributes', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'alice', password: 'passw0rd!!' },
    });
    // Register first so login succeeds.
    await h.json('POST', '/v1/auth/register', {
      body: { handle: 'alice', password: 'passw0rd!!', email: 'alice@example.test' },
    });
    await verifyEmail(h, 'alice@example.test');
    const loginRes = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'alice', password: 'passw0rd!!' },
    });
    assert.equal(loginRes.status, 200);

    const raw = getSetCookie(loginRes.headers);
    assert.ok(raw, 'Set-Cookie header must be present');
    const { value, attrs } = parseSetCookie(raw!);
    assert.ok(value, 'cookie must have a value');
    assert.ok(attrs['httponly'], 'must be HttpOnly');
    assert.equal(attrs['samesite'], 'Strict');
    assert.equal(attrs['path'], REFRESH_COOKIE_PATH);
    assert.equal(attrs['max-age'], '3600');
    // cookieSecure defaults to false in test harness (HTTP), so no Secure.
    assert.equal(attrs['secure'], undefined);
  } finally {
    await h.close();
  }
});

test('register sets an httpOnly refresh cookie', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'bob', password: 'passw0rd!!', email: 'bob@example.test' },
    });
    assert.equal(res.status, 201);
    const raw = getSetCookie(res.headers);
    assert.ok(raw, 'Set-Cookie header must be present after register');
    const { attrs } = parseSetCookie(raw!);
    assert.ok(attrs['httponly']);
    assert.equal(attrs['samesite'], 'Strict');
    assert.equal(attrs['path'], REFRESH_COOKIE_PATH);
  } finally {
    await h.close();
  }
});

test('refresh works using the cookie (no body token)', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'carol', password: 'passw0rd!!', email: 'carol@example.test' },
    });
    // Extract the refresh cookie from the register response.
    const raw = getSetCookie(reg.headers);
    assert.ok(raw);
    const { value: cookieValue } = parseSetCookie(raw!);
    // Refresh using only the cookie — no body token.
    const refreshRes = await h.json('POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookieValue}` },
    });
    assert.equal(refreshRes.status, 200);
    assert.ok(refreshRes.body.tokens.accessToken);
    // The response sets a new cookie (rotated token).
    const raw2 = getSetCookie(refreshRes.headers);
    assert.ok(raw2, 'refresh must set a new cookie');
  } finally {
    await h.close();
  }
});

test('refresh still works with a body token (API-client path)', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'dave', password: 'passw0rd!!', email: 'dave@example.test' },
    });
    const bodyToken = reg.body.tokens.refreshToken;
    // Refresh using the body — no cookie.
    const refreshRes = await h.json('POST', '/v1/auth/refresh', {
      body: { refreshToken: bodyToken },
    });
    assert.equal(refreshRes.status, 200);
    assert.ok(refreshRes.body.tokens.accessToken);
  } finally {
    await h.close();
  }
});

test('refresh prefers the cookie over the body token', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'erin', password: 'passw0rd!!', email: 'erin@example.test' },
    });
    const raw = getSetCookie(reg.headers);
    assert.ok(raw);
    const { value: cookieValue } = parseSetCookie(raw!);
    // Send both cookie and body, but the body token is invalid.
    // The cookie should be preferred, so refresh succeeds.
    const refreshRes = await h.json('POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookieValue}` },
      body: { refreshToken: 'invalid-body-token' },
    });
    assert.equal(refreshRes.status, 200);
  } finally {
    await h.close();
  }
});

test('logout clears the cookie', async () => {
  const h = await startHarness();
  try {
    const reg = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'frank', password: 'passw0rd!!', email: 'frank@example.test' },
    });
    const token = reg.body.tokens.accessToken;
    const raw = getSetCookie(reg.headers);
    assert.ok(raw);
    const { value: cookieValue } = parseSetCookie(raw!);

    const out = await h.json('POST', '/v1/auth/logout', {
      token,
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookieValue}` },
    });
    assert.equal(out.status, 204);
    // The logout response must clear the cookie.
    const clearRaw = getSetCookie(out.headers);
    assert.ok(clearRaw, 'logout must set a Set-Cookie header');
    const { attrs } = parseSetCookie(clearRaw!);
    assert.equal(attrs['max-age'], '0');
    assert.ok(attrs['httponly']);
    assert.equal(attrs['samesite'], 'Strict');
    assert.equal(attrs['path'], REFRESH_COOKIE_PATH);
    assert.equal(attrs['secure'], undefined);
  } finally {
    await h.close();
  }
});

test('refresh without cookie or body token is 400', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/refresh', {
      body: {},
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('Secure policy applies compatibly when setting and clearing the cookie', async () => {
  const h = await startHarness({ cookieSecure: true });
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'gail', password: 'passw0rd!!', email: 'gail@example.test' },
    });
    assert.equal(res.status, 201);
    const raw = getSetCookie(res.headers);
    assert.ok(raw);
    const { value, attrs } = parseSetCookie(raw!);
    assert.ok(attrs['secure'], 'Secure must be present when cookieSecure is true');
    assert.ok(attrs['httponly']);
    assert.equal(attrs['samesite'], 'Strict');
    assert.equal(attrs['path'], REFRESH_COOKIE_PATH);

    const logout = await h.json('POST', '/v1/auth/logout', {
      token: res.body.tokens.accessToken,
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${value}` },
    });
    assert.equal(logout.status, 204);

    const clearRaw = getSetCookie(logout.headers);
    assert.ok(clearRaw);
    const { attrs: clearAttrs } = parseSetCookie(clearRaw!);
    assert.equal(clearAttrs['max-age'], '0');
    assert.ok(clearAttrs['secure']);
    assert.ok(clearAttrs['httponly']);
    assert.equal(clearAttrs['samesite'], 'Strict');
    assert.equal(clearAttrs['path'], REFRESH_COOKIE_PATH);
  } finally {
    await h.close();
  }
});
