/**
 * E2E tests for the achievements section of the profile page.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('an awarded achievement renders as unlocked and moves the count', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const handle = `ach-${suffix}`;

  const registered = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-achievements-123', email: `${handle}@example.test` },
  });
  expect(registered.ok()).toBeTruthy();
  const { user } = await registered.json();

  // A fresh player: the whole catalogue is visible, nothing is unlocked. Asserting this first is
  // what makes the assertion after the award mean something — otherwise a section that always said
  // "Unlocked" would pass just as well.
  await page.goto(`/profile/${handle}`);
  await expect(page.locator('#achievements')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#achievements-count')).toHaveText(/^0 of \d+ · 0 points$/, {
    timeout: 15_000,
  });
  // Exact match on the name, not a substring: the catalogue also contains "Quick Victory", and a
  // substring filter resolves to both rows.
  const victoryRow = page
    .locator('#achievements-list .panel-row')
    .filter({ has: page.getByText('Victory', { exact: true }) });
  await expect(victoryRow).toContainText('0 / 1', { timeout: 15_000 });

  // `first-win` is worth 10 points against a target of 1, so one award unlocks it. The bridge route
  // calls the repository's real `award()`, so the unlock is granted by the production rule rather
  // than written directly into a fixture.
  const awarded = await request.post('/e2e/achievements', {
    data: { playerId: user.id, key: 'first-win' },
  });
  expect(awarded.ok()).toBeTruthy();
  expect((await awarded.json()).unlockedAt).not.toBeNull();

  await page.goto(`/profile/${handle}`);
  await expect(page.locator('#achievements-count')).toHaveText(/^1 of \d+ · 10 points$/, {
    timeout: 15_000,
  });
  await expect(
    page
      .locator('#achievements-list .panel-row')
      .filter({ has: page.getByText('Victory', { exact: true }) }),
  ).toContainText('Unlocked', { timeout: 15_000 });
});

test('partial progress renders as a fraction, not as an unlock', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const handle = `achp-${suffix}`;

  const registered = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-achievements-123', email: `${handle}@example.test` },
  });
  expect(registered.ok()).toBeTruthy();
  const { user } = await registered.json();

  // `games-10` counts to 10. Seven awards leave it short, which is the state the fraction exists
  // for — and the one where showing "Unlocked" would be a lie the unit tests cannot observe,
  // because only the wiring decides which player id the section asks about.
  const awarded = await request.post('/e2e/achievements', {
    data: { playerId: user.id, key: 'games-10', increment: 7 },
  });
  expect(awarded.ok()).toBeTruthy();
  expect((await awarded.json()).unlockedAt).toBeNull();

  await page.goto(`/profile/${handle}`);
  const row = page
    .locator('#achievements-list .panel-row')
    .filter({ has: page.getByText('Getting Started', { exact: true }) });
  await expect(row).toContainText('7 / 10', { timeout: 15_000 });
  // Still nothing unlocked, so the count must not have moved.
  await expect(page.locator('#achievements-count')).toHaveText(/^0 of \d+ · 0 points$/, {
    timeout: 15_000,
  });
});
