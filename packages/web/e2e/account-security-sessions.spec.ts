import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * Account security: active sessions (M14 inc 46).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Runs against the real e2e harness API, so the list, the DELETE and the reload afterwards are all
 * genuine round trips. A mocked list would not show what the increment is for: that a user can see
 * a real session and end it.
 *
 * Sessions are created through the API and the browser is authenticated by seeding the refresh
 * cookie and the session hint, exactly as `forum.spec.ts` and `teams.spec.ts` do. Registering
 * through the UI instead raced the bootstrap that wires the register button, which made an earlier
 * version of this spec intermittently fail on "Not signed in" before reaching any session assertion.
 */
test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

const PASSWORD = 'test-password-sessions-123';

function refreshCookie(value: string) {
  return {
    name: 'gambit_refresh',
    value,
    domain: 'localhost',
    path: '/v1/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict' as const,
  };
}

/**
 * Register an account and sign it in a second time, so it genuinely has two sessions, then
 * authenticate `page` as that account.
 */
async function accountWithTwoSessions(
  request: APIRequestContext,
  context: BrowserContext,
  page: Page,
): Promise<{ handle: string }> {
  const handle = `sess-${randomUUID().replaceAll('-', '').slice(0, 8)}`;

  const registered = await request.post('/v1/auth/register', { data: { handle, password: PASSWORD, email: `${handle}@example.test` } });
  expect(registered.ok()).toBeTruthy();
  const auth = await registered.json();

  // Password sign-in needs a verified email (audit P1-1). Follow the verification email the harness
  // recorded, as the owner would.
  const outbox = await request.get(`/e2e/outbox?to=${encodeURIComponent(`${handle}@example.test`)}`);
  expect(outbox.ok()).toBeTruthy();
  const verification = ((await outbox.json()) as { type: string; token: string }[])
    .find((message) => message.type === 'email_verify');
  expect(verification).toBeTruthy();
  const verified = await request.post('/v1/auth/email/verify', { data: { token: verification!.token } });
  expect(verified.status()).toBe(204);

  // A second sign-in creates a second session server-side, so the list has something to choose
  // between and revoking one leaves the account reachable.
  const second = await request.post('/v1/auth/login', { data: { handle, password: PASSWORD } });
  expect(second.ok()).toBeTruthy();

  await context.addCookies([refreshCookie(auth.tokens.refreshToken)]);
  await page.addInitScript(
    ({ h, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid })); },
    { h: handle, uid: auth.user.id },
  );
  return { handle };
}

test.describe('Account security — active sessions', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('the profile lists active sessions and revoking one removes it from the list', async ({ page, context, request }) => {
    await accountWithTwoSessions(request, context, page);

    await page.goto('/profile');
    const list = page.locator('#sessions-list');
    await expect(page.locator('#passkeys-self')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#sessions-count')).toHaveText('(2)', { timeout: 15_000 });

    const revokeButtons = list.getByRole('button', { name: /Revoke/ });
    await expect(revokeButtons).toHaveCount(2);

    await revokeButtons.first().click();

    // The list is re-read from the server, so the revoked row leaves rather than being hidden.
    await expect(page.locator('#sessions-count')).toHaveText('(1)', { timeout: 15_000 });
    await expect(list.getByRole('button', { name: /Revoke/ })).toHaveCount(1);
    await expect(page.locator('#sessions-note')).toHaveText('Session revoked.');
    await expect(page.locator('#sessions-error')).toHaveText('');
  });

  test('a session row never renders placeholder text for absent fields', async ({ page, context, request }) => {
    await accountWithTwoSessions(request, context, page);
    await page.goto('/profile');
    await expect(page.locator('#sessions-count')).toHaveText('(2)', { timeout: 15_000 });

    const text = await page.locator('#sessions-list').innerText();
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    // The row joins its parts with a separator; an absent part must not leave one behind.
    expect(text).not.toContain('· ·');
  });

  /**
   * The absence-of-placeholders test above passes just as happily when every row degrades to a bare
   * "Unknown device", which is what shipped before the row read the session's created metadata —
   * a list of identical, unidentifiable rows on the screen whose whole job is telling them apart.
   * This asserts the row actually says something, against real rows from the real API.
   */
  test('a session row identifies the session it belongs to', async ({ page, context, request }) => {
    await accountWithTwoSessions(request, context, page);
    await page.goto('/profile');
    await expect(page.locator('#sessions-count')).toHaveText('(2)', { timeout: 15_000 });

    // Before the row read the session's created metadata, every row was the single string
    // "Unknown device" — no address, no date. Asserting the address and the date on *every* row is
    // what that regression fails, and unlike a device name it does not depend on which client
    // happened to create the session: the API records both for any request that reaches it.
    const rows = await page.locator('#sessions-list .panel-row').allInnerTexts();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(row).toMatch(/last seen \d{4}-\d{2}-\d{2}/);
    }
  });

  /**
   * The user is identifying these sessions, never resuming them, so nothing that could authenticate
   * one has any reason to reach the page.
   */
  test('no token material is exposed in the sessions UI', async ({ page, context, request }) => {
    await accountWithTwoSessions(request, context, page);
    await page.goto('/profile');
    await expect(page.locator('#sessions-count')).toHaveText('(2)', { timeout: 15_000 });

    const html = await page.locator('#passkeys-self').innerHTML();
    expect(html.toLowerCase()).not.toContain('refresh');
    expect(html.toLowerCase()).not.toContain('bearer');
    expect(html).not.toContain('accessToken');
  });

  test('the sessions section is not shown on another player\'s profile', async ({ page, context, request }) => {
    const { handle } = await accountWithTwoSessions(request, context, page);

    // Account-security controls have no meaning on someone else's profile.
    await page.goto(`/profile/${handle}`);
    await expect(page.locator('#profile-handle')).toContainText(handle, { timeout: 15_000 });
    await expect(page.locator('#passkeys-self')).toBeHidden();
  });
});
