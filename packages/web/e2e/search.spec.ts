/**
 * E2E tests for the Search UI.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('submitting header form navigates to /search?q=... without a full reload', async ({ page }) => {
  await page.goto('/');

  const input = page.locator('#search-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__spaMarker = 1;
  });

  await input.fill('alice');
  await input.press('Enter');

  await expect(page).toHaveURL(/\/search\?q=alice/, { timeout: 15_000 });
  const section = page.locator('#search');
  await expect(section).toBeVisible({ timeout: 15_000 });

  const survived = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__spaMarker === 1,
  );
  expect(survived).toBe(true);
});

test('deep link to /search?q=x renders search section', async ({ page }) => {
  await page.goto('/search?q=test');

  const section = page.locator('#search');
  await expect(section).toBeVisible({ timeout: 15_000 });

  const input = page.locator('#search-input');
  await expect(input).toHaveValue('test', { timeout: 15_000 });
});

test('Back after an SPA search returns to the previous page and re-renders it', async ({ page }) => {
  // The claim here is that our `popstate` handler re-bootstraps the previous route — that the lobby
  // is rendered again, not merely that the URL changed. Whether the browser re-uses the document on
  // Back is its own decision (bfcache, memory pressure), so this deliberately does not assert the
  // sentinel: that check belongs on submit, where the document surviving is a consequence of our
  // own `preventDefault`. Asserting it here made the test fail on the browser's choice, not ours.
  await page.goto('/');

  const input = page.locator('#search-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill('test');
  await input.press('Enter');

  await expect(page).toHaveURL(/\/search\?q=test/, { timeout: 15_000 });

  await page.goBack();

  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const lobby = page.locator('#lobby');
  await expect(lobby).toBeVisible({ timeout: 15_000 });
});

test('blank query shows prompt state rather than an error', async ({ page }) => {
  await page.goto('/search');

  const section = page.locator('#search');
  await expect(section).toBeVisible({ timeout: 15_000 });

  const results = page.locator('#search-results');
  await expect(results.locator('.empty')).toBeVisible({ timeout: 15_000 });

  const errorEl = page.locator('#search-error');
  await expect(errorEl).toBeEmpty({ timeout: 15_000 });
});

test('the header form pushes exactly one history entry after repeated SPA navigation', async ({ page }) => {
  // Regression: the form lives in the nav, which `bootstrap` never replaces, so binding its submit
  // handler per run stacked one listener per navigation. A single submit then pushed that many
  // history entries and one Back could not get out of the search page. Navigating first is what
  // makes the bug reachable — with one bootstrap run the stack is one deep and the bug is invisible.
  await page.goto('/');
  await page.locator('nav a[data-route="tournaments"]').click();
  await expect(page).toHaveURL(/\/tournaments$/, { timeout: 15_000 });
  await page.locator('nav a[data-route="lobby"]').click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  const input = page.locator('#search-input');
  await input.fill('alice');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=alice/, { timeout: 15_000 });

  // One entry pushed means one Back returns to the lobby.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.locator('#lobby')).toBeVisible({ timeout: 15_000 });
});

test('indexed player query returns a hit and renders the resolved handle', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const handle = `srch-${suffix}`;
  const password = 'test-password-search-123';

  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password, email: `${handle}@example.test` },
  });
  expect(regResp.ok()).toBeTruthy();
  const authData = await regResp.json();
  const userId = authData.user.id as string;

  const indexResp = await request.post('/e2e/search-index', {
    data: {
      players: [{ id: userId, handle }],
    },
  });
  expect(indexResp.ok()).toBeTruthy();
  const indexData = await indexResp.json();
  expect(indexData.indexed).toBe(1);

  await page.goto(`/search?q=${handle}`);

  const results = page.locator('#search-results');
  await expect(results.locator('.panel-row')).toBeVisible({ timeout: 15_000 });
  await expect(results).toContainText(handle, { timeout: 15_000 });
});

