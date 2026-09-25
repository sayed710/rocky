import { test, expect } from '@playwright/test';

test.describe('Email verification web UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/v1/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: {} }),
      });
    });

    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('token secret hygiene: the token never reaches the wire at all, and never lands in the URL, Referer or DOM', async ({ page }) => {
    const apiReferrers: string[] = [];
    const apiUrls: string[] = [];
    const distinctiveToken = 'super-secret-token-verify-999';

    // Every request the page makes, not just the API calls the route handler intercepts — the
    // document navigation included. That is the assertion this flow exists to satisfy: the token
    // travels in the fragment, which browsers never transmit, so it must be absent from the very
    // first request line. When the token rode the query string this listener saw it on the
    // navigation request, before any script could run, and no client-side stripping could undo it.
    const everyRequestUrl: string[] = [];
    page.on('request', (req) => everyRequestUrl.push(req.url()));

    await page.route('**/v1/**', async (route) => {
      const req = route.request();
      apiUrls.push(req.url());
      const ref = req.headers()['referer'];
      if (ref) apiReferrers.push(ref);
      if (req.url().includes('/v1/auth/email/verify')) {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: {} }),
      });
    });

    await page.goto(`/email-verify#token=${distinctiveToken}`);

    // URL becomes /email-verify, page.url() does not contain token
    await expect(page).toHaveURL(/\/email-verify$/);
    expect(page.url()).not.toContain(distinctiveToken);

    // Status region shows verified
    await expect(page.locator('#email-verify-status')).toHaveText('Your email address is verified.');

    // Check Referer and URLs of all requests. The count assertions keep both loops from passing
    // vacuously: a run that recorded no requests would otherwise "prove" nothing leaked.
    expect(apiUrls.length).toBeGreaterThan(0);
    expect(apiReferrers.length).toBeGreaterThan(0);
    for (const ref of apiReferrers) {
      expect(ref).not.toContain(distinctiveToken);
    }
    for (const url of apiUrls) {
      expect(url).not.toContain(distinctiveToken);
    }

    // The whole point of the fragment transport: no request the browser made — document navigation,
    // asset, or API call — carried the token.
    expect(everyRequestUrl.length).toBeGreaterThan(0);
    const navigationRequests = everyRequestUrl.filter((u) => u.includes('/email-verify'));
    expect(navigationRequests.length).toBeGreaterThan(0);
    for (const url of everyRequestUrl) {
      expect(url).not.toContain(distinctiveToken);
    }

    // page.content() does not contain token
    const content = await page.content();
    expect(content).not.toContain(distinctiveToken);
  });

  test('success: issues one verify request with body, displays verified status, hides retry, leaves error empty', async ({ page }) => {
    let verifyCalls = 0;
    let verifyBody: unknown = null;
    const distinctiveToken = 'token-success-abc-123';

    await page.route('**/v1/auth/email/verify', async (route) => {
      verifyCalls++;
      verifyBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/email-verify#token=${distinctiveToken}`);

    await expect(page.locator('#email-verify-status')).toHaveText('Your email address is verified.');
    await expect(page.locator('#email-verify-retry')).toBeHidden();
    await expect(page.locator('#email-verify-error')).toHaveText('');

    expect(verifyCalls).toBe(1);
    expect(verifyBody).toEqual({ token: distinctiveToken });

    // No replay after success: triggering retry control programmatically issues no further request
    await page.locator('#email-verify-retry').evaluate((btn: HTMLButtonElement) => btn.click());
    expect(verifyCalls).toBe(1);
  });

  test('401 response: shows invalid/expired copy, retry stays hidden, no replay', async ({ page }) => {
    let verifyCalls = 0;
    await page.route('**/v1/auth/email/verify', async (route) => {
      verifyCalls++;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Invalid or expired', code: 'UNAUTHORIZED' } }),
      });
    });

    await page.goto('/email-verify#token=invalid-tok');

    await expect(page.locator('#email-verify-error')).toHaveText(
      'This verification link is invalid, has expired, or has already been used.',
    );
    await expect(page.locator('#email-verify-retry')).toBeHidden();
    await expect(page.locator('#email-verify-status')).toHaveText('');
    expect(verifyCalls).toBe(1);

    // Programmatic retry issues no second request
    await page.locator('#email-verify-retry').evaluate((btn: HTMLButtonElement) => btn.click());
    expect(verifyCalls).toBe(1);
  });

  test('transient 500 then retry: retry button appears and clicking it verifies successfully', async ({ page }) => {
    let verifyCalls = 0;
    await page.route('**/v1/auth/email/verify', async (route) => {
      verifyCalls++;
      if (verifyCalls === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Server down', code: 'SERVER_ERROR' } }),
        });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto('/email-verify#token=retry-token-555');

    const retryBtn = page.locator('#email-verify-retry');
    await expect(page.locator('#email-verify-error')).toHaveText(
      'We could not verify your email address right now. Please try again.',
    );
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();

    await expect(page.locator('#email-verify-status')).toHaveText('Your email address is verified.');
    await expect(retryBtn).toBeHidden();
    expect(verifyCalls).toBe(2);
  });

  test('missing token: shows missing link copy and issues NO verify request', async ({ page }) => {
    let verifyCalls = 0;
    await page.route('**/v1/auth/email/verify', async (route) => {
      verifyCalls++;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto('/email-verify');

    await expect(page.locator('#email-verify-error')).toHaveText(
      'This page needs a verification link. Open the link in the verification email we sent you.',
    );
    await expect(page.locator('#email-verify-retry')).toBeHidden();
    expect(verifyCalls).toBe(0);
  });

  test('signed-in visitor keeps session after email verification without logout or session loss', async ({ page }) => {
    let logoutCalls = 0;
    await page.route('**/v1/auth/logout', async (route) => {
      logoutCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('**/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
          tokens: { accessToken: 'tok-123', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
        }),
      });
    });

    await page.route('**/v1/auth/email/verify', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });

    // Seed session in localStorage before navigation
    await page.addInitScript(() => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));
    });

    await page.goto('/email-verify#token=verify-tok-777');

    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toHaveText('Signed in as alice');
    await expect(page.locator('#auth-logout')).toBeVisible();

    await expect(page.locator('#email-verify-status')).toHaveText('Your email address is verified.');

    const storedSession = await page.evaluate(() => localStorage.getItem('gambit-session'));
    expect(storedSession).not.toBeNull();
    expect(JSON.parse(storedSession!)).toEqual({ handle: 'alice', userId: 'u1' });
    expect(logoutCalls).toBe(0);
  });

  test('#auth is hidden on /email-verify, and Continue to the lobby link navigates to / and shows #auth', async ({ page }) => {
    await page.route('**/v1/auth/email/verify', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto('/email-verify#token=nav-tok');

    await expect(page.locator('#email-verify')).toBeVisible();
    await expect(page.locator('#auth')).toBeHidden();

    const backLink = page.locator('#email-verify-back-link');
    await expect(backLink).toBeVisible();
    await backLink.click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#auth')).toBeVisible();
    await expect(page.locator('#email-verify')).toBeHidden();
  });

  test('sign-in is not gated by the email field, and registration sends a trimmed email and requires one', async ({ page }) => {
    let loginBody: unknown = null;
    let registerBody: unknown = null;
    let logoutCalls = 0;

    // Routed explicitly. Without it the sign-out clicks below reach a backend that is not running,
    // and the test passes only because `AuthController.logout` clears local state in a `finally`
    // whatever the server said — i.e. it would prove the failure path, not the intended sequence,
    // and it emitted a real proxy ECONNREFUSED on every run.
    await page.route('**/v1/auth/logout', async (route) => {
      logoutCalls++;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.route('**/v1/auth/login', async (route) => {
      loginBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
          tokens: { accessToken: 'tok-1', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
        }),
      });
    });

    await page.route('**/v1/auth/register', async (route) => {
      registerBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
          tokens: { accessToken: 'tok-2', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
        }),
      });
    });

    await page.goto('/');

    const handleInput = page.locator('#auth-handle');
    const passInput = page.locator('#auth-password');
    const emailInput = page.locator('#auth-email');
    const submitBtn = page.locator('#auth-submit');
    const registerBtn = page.locator('#auth-register');

    await expect(emailInput).toBeVisible();

    // 1. Sign-in with malformed email still succeeds (sign-in is not gated by email field)
    await handleInput.fill('alice');
    await passInput.fill('hunter2');
    await emailInput.fill('not-an-email');
    await submitBtn.click();

    await expect(page.locator('#auth-status')).toHaveText('Signed in as alice');
    expect(loginBody).toEqual({ handle: 'alice', password: 'hunter2' });

    // Log out to test registration
    await page.locator('#auth-logout').click();
    await expect(page.locator('#auth-status')).toHaveText('Not signed in');
    expect(logoutCalls).toBe(1);

    // 2. Register with valid email sends trimmed email
    await handleInput.fill('bob');
    await passInput.fill('hunter2');
    await emailInput.fill('  bob@example.com  ');
    await registerBtn.click();

    await expect(page.locator('#auth-status')).toHaveText('Signed in as bob');
    expect(registerBody).toEqual({ handle: 'bob', password: 'hunter2', email: 'bob@example.com' });

    // Log out
    await page.locator('#auth-logout').click();
    await expect(page.locator('#auth-status')).toHaveText('Not signed in');
    expect(logoutCalls).toBe(2);

    // 3. Register with an empty email sends nothing: a password account needs an email it can
    //    verify (audit P1-1), so the form says so instead of creating one.
    registerBody = null;
    await handleInput.fill('charlie');
    await passInput.fill('hunter2');
    await emailInput.fill('');
    await registerBtn.click();

    await expect(page.locator('#auth-error')).toHaveText('An email address is required to create an account.');
    await expect(page.locator('#auth-status')).toHaveText('Not signed in');
    expect(registerBody).toBeNull();
  });

  test('responsive mobile layout at 390x844: #email-verify has no horizontal overflow and retry button min-height >= 44px', async ({ page }) => {
    await page.route('**/v1/auth/email/verify', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Error' } }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/email-verify#token=mobile-token');

    const section = page.locator('#email-verify');
    await expect(section).toBeVisible();

    const box = await section.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    const retryBtn = page.locator('#email-verify-retry');
    await expect(retryBtn).toBeVisible();
    const retryBox = await retryBtn.boundingBox();
    expect(retryBox).not.toBeNull();
    expect(retryBox!.height).toBeGreaterThanOrEqual(44);
  });
});
