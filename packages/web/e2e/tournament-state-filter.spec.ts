import { test, expect } from '@playwright/test';

test.describe('Tournament state filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 });

    await page.route('**/v1/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          capabilities: {
            learning: true,
            studies: true,
            achievements: true,
            search: true,
            social: true,
            messaging: true,
            community: true,
          },
        }),
      });
    });

    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('filters mixed list with keyboard, encodes safe links, and restores order', async ({ page }) => {
    const tournamentFixtures = [
      {
        id: 't-reg-1',
        name: 'Spring Open',
        format: 'swiss',
        state: 'registration',
        participantCount: 12,
      },
      {
        id: 't 2026/rapid',
        name: '<img src=x onerror=alert(1)>',
        format: 'arena',
        state: 'running',
        participantCount: 8,
      },
      {
        id: 't-fin-3',
        name: 'Winter Classic',
        format: 'round_robin',
        state: 'finished',
        participantCount: 16,
      },
    ];

    let requestCount = 0;
    await page.route('**/v1/tournaments', async (route) => {
      requestCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(tournamentFixtures),
      });
    });

    await page.goto('/tournaments');

    const filter = page.locator('#tournament-state-filter');
    const label = page.locator('label[for="tournament-state-filter"]');
    await expect(filter).toBeVisible();
    await expect(label).toBeVisible();

    const filterBox = await filter.boundingBox();
    expect(filterBox).not.toBeNull();
    expect(filterBox!.height).toBeGreaterThanOrEqual(44);

    await expect(filter).toHaveValue('all');
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 3 of 3 loaded tournaments');
    await expect(page.locator('#tournament-list')).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#tournament-list img[src="x"]')).toHaveCount(0);

    const safeLink = page.locator('#tournament-list a').filter({ hasText: '<img src=x onerror=alert(1)>' });
    await expect(safeLink).toBeVisible();
    await expect(safeLink).toHaveAttribute('href', '/tournaments/t%202026%2Frapid');

    await filter.focus();
    await expect(filter).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('running');
    await expect(filter).toBeFocused();

    await expect(safeLink).toBeVisible();
    await expect(page.locator('#tournament-list').getByText('Spring Open')).not.toBeVisible();
    await expect(page.locator('#tournament-list').getByText('Winter Classic')).not.toBeVisible();
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 1 of 3 loaded tournaments');
    expect(requestCount).toBe(1);

    await filter.selectOption('all');
    await expect(filter).toHaveValue('all');
    await expect(page.locator('#tournament-list').getByText('Spring Open')).toBeVisible();
    await expect(safeLink).toBeVisible();
    await expect(page.locator('#tournament-list').getByText('Winter Classic')).toBeVisible();
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 3 of 3 loaded tournaments');

    const restoredText = await page.locator('#tournament-list').innerText();
    const regPos = restoredText.indexOf('Spring Open');
    const runPos = restoredText.indexOf('<img src=x onerror=alert(1)>');
    const finPos = restoredText.indexOf('Winter Classic');
    expect(regPos).toBeGreaterThan(-1);
    expect(runPos).toBeGreaterThan(regPos);
    expect(finPos).toBeGreaterThan(runPos);
    expect(requestCount).toBe(1);
  });

  test('distinguishes filtered empty from true empty and retains state across Arabic locale switch', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/v1/tournaments', async (route) => {
      requestCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 't-reg-1', name: 'Spring Open', format: 'swiss', state: 'registration', participantCount: 12 },
          { id: 't-run-2', name: 'Summer Arena', format: 'arena', state: 'running', participantCount: 8 },
        ]),
      });
    });

    await page.goto('/tournaments');
    const filter = page.locator('#tournament-state-filter');
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 2 of 2 loaded tournaments');

    await filter.focus();
    await filter.selectOption('finished');
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('finished');
    await expect(page.locator('#tournament-list')).toContainText('No matching tournaments');
    await expect(page.locator('#tournament-list')).toContainText('No loaded tournaments match the selected state.');
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 0 of 2 loaded tournaments');
    await expect(filter).toBeVisible();
    expect(requestCount).toBe(1);

    await filter.selectOption('running');
    await expect(filter).toHaveValue('running');
    await expect(page.locator('#tournament-list')).toContainText('Summer Arena');
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 1 of 2 loaded tournaments');
    expect(requestCount).toBe(1);

    await filter.focus();
    await expect(filter).toBeFocused();
    await page.locator('#locale-select').evaluate((el) => {
      const selectEl = el as HTMLSelectElement;
      selectEl.value = 'ar';
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('running');
    await expect(page.locator('#tournament-list')).toContainText('Summer Arena');
    await expect(page.locator('#tournaments-status')).toHaveText('عرض 1 من أصل 2 من البطولات المحملة');
    await expect(filter.locator('option[value="registration"]')).toHaveText('التسجيل');
    await expect(filter.locator('option[value="running"]')).toHaveText('جارية');
    await expect(filter.locator('option[value="finished"]')).toHaveText('منتهية');
    expect(requestCount).toBe(1);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(hasOverflow).toBe(false);

    const filterBox = await filter.boundingBox();
    expect(filterBox).not.toBeNull();
    expect(filterBox!.height).toBeGreaterThanOrEqual(44);

    await filter.selectOption('finished');
    await expect(filter).toHaveValue('finished');
    await expect(page.locator('#tournament-list')).toContainText('لا توجد بطولات مطابقة');
    await expect(page.locator('#tournaments-status')).toHaveText('عرض 0 من أصل 2 من البطولات المحملة');
    expect(requestCount).toBe(1);

    await page.route('**/v1/tournaments', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.reload();
    await expect(page.locator('#tournament-list')).toContainText('لا توجد بطولات متاحة');
    await page.locator('#locale-select').selectOption('en');
    await expect(page.locator('#tournament-list')).toContainText('No tournaments available');
  });

  test('projects filter chosen during deferred loading and preserves error alert on 500 failure', async ({ page }) => {
    let resolveTournaments!: (value: unknown) => void;
    const tournamentsPromise = new Promise((resolve) => {
      resolveTournaments = resolve;
    });

    await page.route('**/v1/tournaments', async (route) => {
      const data = await tournamentsPromise;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    });

    await page.goto('/tournaments');
    await expect(page.locator('#tournament-list')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#tournaments-status')).toHaveText('');

    const filter = page.locator('#tournament-state-filter');
    await filter.selectOption('running');
    await expect(filter).toHaveValue('running');
    await expect(page.locator('#tournament-list')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#tournaments-status')).toHaveText('');

    resolveTournaments([
      { id: 't-live-1', name: 'Open Arena Live', format: 'arena', state: 'running', participantCount: 14 },
      { id: 't-reg-2', name: 'Upcoming Swiss', format: 'swiss', state: 'registration', participantCount: 6 },
      { id: 't-fin-3', name: 'Completed Cup', format: 'round_robin', state: 'finished', participantCount: 10 },
    ]);

    await expect(page.locator('#tournament-list')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#tournaments-status')).toHaveText('Showing 1 of 3 loaded tournaments');
    await expect(page.locator('#tournament-list')).toContainText('Open Arena Live');
    await expect(page.locator('#tournament-list')).not.toContainText('Upcoming Swiss');
    await expect(page.locator('#tournament-list')).not.toContainText('Completed Cup');

    await page.route('**/v1/tournaments', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'Tournament list failed' } }),
      });
    });

    await page.reload();
    await expect(page.locator('#tournaments-error')).toBeVisible();
    await expect(page.locator('#tournaments-error')).toContainText('Tournament list failed');
    await expect(page.locator('#tournaments-status')).toHaveText('');
    await expect(page.locator('#tournament-list')).toBeEmpty();

    await filter.selectOption('running');
    await expect(page.locator('#tournaments-error')).toBeVisible();
    await expect(page.locator('#tournaments-error')).toContainText('Tournament list failed');
    await expect(page.locator('#tournaments-status')).toHaveText('');
    await expect(page.locator('#tournament-list')).toBeEmpty();

    await page.locator('#locale-select').selectOption('ar');
    await expect(page.locator('#tournaments-error')).toBeVisible();
    await expect(page.locator('#tournaments-error')).toContainText('Tournament list failed');
    await expect(page.locator('#tournaments-status')).toHaveText('');
    await expect(page.locator('#tournament-list')).toBeEmpty();
  });
});
