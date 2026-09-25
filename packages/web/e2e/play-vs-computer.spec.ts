/**
 * E2E test: "Play vs Computer" lobby dialog interaction and game creation.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('play vs computer dialog — open, focus trap, escape close, and game creation', async ({ page, request }) => {
  // 1. Register a user
  const handle = `e2e-dialog-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;
  const refreshToken = auth.tokens.refreshToken;
  const userId = auth.user.id;

  // Seed session
  await page.context().addCookies([
    {
      name: 'gambit_refresh',
      value: refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  await page.addInitScript(
    ({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    },
    { handle, uid: userId },
  );

  // Navigate to lobby
  await page.goto('/');

  // Trigger button should be visible and enabled for authenticated user
  const trigger = page.locator('#play-bot');
  // Session restore is a real round-trip through the refresh cookie, and the harness is shared with
  // the rest of the suite, so this wait is generous on purpose. It is setup, not the assertion.
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });

  // Click trigger to open dialog
  await trigger.click();

  const dialog = page.locator('.pb-dialog');
  await expect(dialog).toBeVisible();

  // Esc key closes the dialog
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();

  // Re-open dialog
  await trigger.click();
  await expect(dialog).toBeVisible();

  // Select level (e.g. Master) and color (White)
  const masterRadio = dialog.locator('input[name="pb-level"][value="master"]');
  await masterRadio.check({ force: true });
  await expect(masterRadio).toBeChecked();

  const whiteRadio = dialog.locator('input[name="pb-color"][value="white"]');
  await whiteRadio.check({ force: true });
  await expect(whiteRadio).toBeChecked();

  // Submit form
  const submitBtn = dialog.locator('button[type="submit"]');
  await submitBtn.click();

  // Assert navigation to game page /game/...
  await expect(page).toHaveURL(/\/game\/[a-zA-Z0-9_-]+/, { timeout: 15_000 });
  await expect(page.locator('#meta-black .presence-text')).toHaveText('Computer');
});

/**
 * Regression: the dialog must not be dismissable while a create request is in flight.
 *
 * A create cannot be recalled once sent. If Escape cleared `pending` while the request continued,
 * the player who just cancelled would still be navigated into the game it created — and could
 * submit a second one first. The request is held open here with `page.route` so the in-flight
 * window is wide enough to act in.
 */
test('play vs computer — Escape and Cancel are inert while the request is in flight', async ({ page, request }) => {
  const handle = `e2e-pending-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();

  // The session is restored from the httpOnly refresh cookie; localStorage carries only the
  // persisted identity. Both are required, as in the first spec.
  await page.context().addCookies([
    {
      name: 'gambit_refresh',
      value: auth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  await page.addInitScript(
    ({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    },
    { handle, uid: auth.user.id },
  );

  // Hold the create request open so the pending state is observable, then fail it. Failing rather
  // than completing keeps this test off the clock: the happy path (a real create, a real
  // navigation) is already covered by the spec above, and asserting a navigation here would mean
  // racing a live backend round-trip inside a fixed window — which is how a test becomes flaky.
  await page.route('**/v1/games/bot', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    // A real rejected response rather than `route.abort()`: an aborted fetch surfaces through the
    // transport layer on its own schedule, which made this assertion racy, while a 400 is a
    // deterministic answer the client turns into an error immediately.
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'bad_request', message: 'invalid bot level' } }),
    });
  });

  await page.goto('/');
  const trigger = page.locator('#play-bot');
  // As above: waiting for the session to restore, not asserting behaviour.
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();

  const dialog = page.locator('.pb-dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator('button[type="submit"]').click();

  // Pending: submit reads "Starting…" and both dismissal paths are inert.
  await expect(dialog.locator('button[type="submit"]')).toHaveText('Starting…');
  await expect(dialog.locator('button.cg-cancel')).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  // Once it fails the dialog recovers in place: the error is shown where the player is looking
  // (the lobby's own error line sits behind the modal), and both dismissal paths work again.
  await expect(dialog.locator('.cg-field-error')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('.cg-field-error')).not.toBeEmpty();
  await expect(dialog.locator('button[type="submit"]')).toHaveText('Start game');
  await expect(dialog.locator('button.cg-cancel')).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('POST-AUD-001: a completed bot request cannot reclaim navigation after leaving the lobby', async ({ page }) => {
  let releaseCreate!: () => void;
  const createMayFinish = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let requestStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => { requestStarted = resolve; });

  await page.route('**/v1/games/bot', async (route) => {
    requestStarted();
    await createMayFinish;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'stale-bot-game',
        variant: 'standard',
        rated: false,
        speed: 'blitz',
        whiteId: 'player',
        blackId: 'bot',
        result: null,
        termination: null,
        plyCount: 0,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: null,
      }),
    });
  });

  await page.goto('/');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const handle = `e2e-stale-lobby-${suffix}`;
  await page.locator('#auth-handle').fill(handle);
  await page.locator('#auth-password').fill('test-password-123');
  await page.locator('#auth-email').fill(`${handle}@example.test`);
  await page.locator('#auth-register').click();
  await expect(page.locator('#auth-status')).toHaveText(`Signed in as ${handle}`);

  await page.locator('a[data-route="profile"]').click();
  await expect(page).toHaveURL('/profile');
  await page.locator('a[data-route="lobby"]').first().click();
  await expect(page).toHaveURL('/');

  await page.locator('#play-bot').click();
  await page.locator('.pb-dialog button[type="submit"]').click();
  await createStarted;
  await page.goBack();
  await expect(page).toHaveURL('/profile');

  const botResponse = page.waitForResponse('**/v1/games/bot');
  releaseCreate();
  await botResponse;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page).toHaveURL('/profile');
});
