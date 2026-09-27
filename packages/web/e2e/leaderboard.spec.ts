import { test, expect } from '@playwright/test';

test.describe('Leaderboard view', () => {
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

    await page.route('**/v1/leaderboard/standard/blitz?limit=100', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { userId: 'u1', variant: 'standard', speed: 'blitz', rating: 1600, rd: 45 },
          { userId: 'u2', variant: 'standard', speed: 'blitz', rating: 1550, rd: 50 },
        ]),
      });
    });

    await page.route('**/v1/leaderboard/atomic/blitz?limit=100', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/v1/leaderboard/crazyhouse/blitz?limit=100', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      });
    });

    await page.route('**/graphql', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            p0: { id: 'u1', handle: 'alice' },
            p1: null,
          },
        }),
      });
    });
  });

  test('no pool is loaded until a time control is chosen', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/leaderboard/')) requested.push(request.url());
    });
    await page.goto('/leaderboard');
    const results = page.locator('#leaderboard-results');
    await expect(results).toHaveAttribute('role', 'status');
    await expect(results).toContainText('Choose a time control');
    await expect(page.locator('#leaderboard-speed-select')).toHaveValue('');
    await page.locator('#leaderboard-variant-select').selectOption('atomic');
    await expect(results).toContainText('Choose a time control');
    expect(requested).toEqual([]);

    await page.locator('#leaderboard-speed-select').selectOption('blitz');
    await expect(results).toContainText('No leaderboard entries');
    expect(requested.map((url) => new URL(url).pathname)).toEqual(['/v1/leaderboard/atomic/blitz']);
  });

  test('each pool label stays with a touch-sized selector at 320px', async ({ page }) => {
    await page.goto('/leaderboard');
    for (const id of ['leaderboard-variant-select', 'leaderboard-speed-select']) {
      const control = page.locator(`#${id}`);
      const label = page.locator(`label[for="${id}"]`);
      const [controlBox, labelBox] = await Promise.all([control.boundingBox(), label.boundingBox()]);
      expect(controlBox).not.toBeNull();
      expect(labelBox).not.toBeNull();
      expect(controlBox!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs((controlBox!.y + controlBox!.height / 2) - (labelBox!.y + labelBox!.height / 2))).toBeLessThan(16);
      expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(320);
    }
  });

  test('navigation loads standard blitz standings within a narrow viewport', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav a[data-route="leaderboard"]').click();
    await expect(page).toHaveURL(/\/leaderboard$/);
    await page.locator('#leaderboard-speed-select').selectOption('blitz');

    // Selector defaults to standard
    const select = page.locator('#leaderboard-variant-select');
    await expect(select).toHaveValue('standard');

    // The whole offered set, in order, rather than a few spot checks: naming three of eight let a
    // regression that dropped any of the other five pass. Chess960 is among them since ADR-0137 made
    // it creatable and so gave it ratings to rank; this list used to pin its *absence* (ADR-0099), a
    // decision that was never this page's to make. Raised in the CodeRabbit review of PR #12.
    const options = await select.locator('option').allInnerTexts();
    expect(options).toEqual([
      'Standard',
      'Chess960',
      'King of the Hill',
      'Atomic',
      'Crazyhouse',
      'Three-check',
      'Horde',
      'Racing Kings',
    ]);

    // Wait for results to render
    const results = page.locator('#leaderboard-results');
    await expect(results).toHaveAttribute('role', 'list');

    // Loading status should be outside the list and hidden when done
    const loading = page.locator('#leaderboard-loading');
    await expect(loading).toBeHidden();

    // Check rows
    const rows = results.locator('.panel-row');
    await expect(rows).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(rows.nth(i)).toHaveAttribute('role', 'listitem');
      // Must have exactly two children: row-main and count
      await expect(rows.nth(i).locator('xpath=./*')).toHaveCount(2);
    }

    // Check first row content
    const row1 = rows.nth(0);
    await expect(row1.locator('.leaderboard-rank')).toHaveText('#1');
    const link = row1.locator('a.row-link');
    await expect(link).toHaveText('alice');
    await expect(link).toHaveAttribute('href', '/profile/alice');
    await expect(row1.locator('.count')).toContainText('1600 (±45)');

    // Check second row fallback
    const row2 = rows.nth(1);
    await expect(row2.locator('.leaderboard-rank')).toHaveText('#2');
    await expect(row2.locator('.leaderboard-player-unresolved')).toHaveText('u2');
    await expect(row2.locator('.count')).toContainText('1550 (±50)');

    const sectionBox = await page.locator('#leaderboard').boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(320);
  });

  test('loading is announced outside the standings list', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/v1/leaderboard/standard/blitz?limit=100', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/leaderboard');
    await page.locator('#leaderboard-speed-select').selectOption('blitz');
    const loading = page.locator('#leaderboard-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText('Loading…');
    await expect(page.locator('#leaderboard-results .panel-row')).toHaveCount(0);

    release();
    await expect(loading).toBeHidden();
    await expect(page.locator('#leaderboard-results')).toHaveAttribute('role', 'status');
  });

  test('in-place variant switch to empty state', async ({ page }) => {
    await page.goto('/leaderboard');
    await page.locator('#leaderboard-speed-select').selectOption('blitz');
    await expect(page.locator('#leaderboard-results .panel-row')).toHaveCount(2);

    const select = page.locator('#leaderboard-variant-select');
    await select.selectOption('atomic');

    // URL should NOT change to /leaderboard/atomic
    await expect(page).toHaveURL(/\/leaderboard$/);

    const results = page.locator('#leaderboard-results');
    await expect(results).toHaveAttribute('role', 'status');
    await expect(results).toContainText('No leaderboard entries');
  });

  test('error state handling', async ({ page }) => {
    await page.goto('/leaderboard');
    await page.locator('#leaderboard-speed-select').selectOption('blitz');
    const select = page.locator('#leaderboard-variant-select');
    await select.selectOption('crazyhouse');

    const error = page.locator('#leaderboard-error');
    await expect(error).toBeVisible();
  });
});
