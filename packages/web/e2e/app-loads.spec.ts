/**
 * Static e2e smoke test: the Rookzen app loads and the lobby is visible.
 *
 * `/` routes to the lobby view (see `bootstrap.ts`); the board only mounts
 * for `/game/{id}` routes, which is covered by the vs-bot/vs-human specs.
 *
 * This spec runs without backends (only needs vite preview).
 *
 * Run with: npm run e2e
 */
import { test, expect } from '@playwright/test';

test('app loads and lobby is visible', async ({ page }) => {
  await page.goto('/');
  const lobby = page.locator('#lobby');
  await expect(lobby).toBeVisible();
});

test('lobby is accessible via nav', async ({ page }) => {
  await page.goto('/');
  const lobbyLink = page.locator('a[href="/"]').first();
  await expect(lobbyLink).toBeVisible();
});

test('theme toggle button is present', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('#theme-toggle');
  await expect(toggle).toBeVisible();
});

test('theme toggle changes the actual colour scheme and exposes the next action', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  const toggle = page.locator('#theme-toggle');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(36, 34, 36)');

  await toggle.click();

  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 241, 237)');
});

test('dark-first default ignores a light OS preference and a saved choice survives reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#F5F1ED');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-label', 'Switch to dark theme');
});

test('unknown paths render the 404 surface without mounting the hidden board and recover by keyboard', async ({ page }) => {
  await page.goto('/missing-page');

  await expect(page.locator('#not-found')).toBeVisible();
  await expect(page.locator('#lobby')).toBeHidden();
  await expect(page.locator('#game-main')).toBeHidden();
  await expect(page.locator('#board .cb-sq')).toHaveCount(0);

  const returnToPlay = page.locator('.not-found-action');
  await returnToPlay.focus();
  await expect(returnToPlay).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/');
  await expect(page.locator('#lobby')).toBeVisible();
});

test('available learn subnavigation stays keyboard-visible, touch-sized, and single-line on mobile', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 280, height: 844 } });
  const page = await context.newPage();
  try {
    await page.route('**/v1/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: { learning: true, endgameTrainer: true, studies: true } }),
      });
    });
    await page.goto('/courses');
    await page.waitForLoadState('networkidle');
    const links = page.locator('#courses .subnav-link');
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(1);
    for (let index = 0; index < linkCount; index++) {
      const link = links.nth(index);
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await expect(link).toHaveCSS('flex-shrink', '0');
      await expect(link).toHaveCSS('white-space', 'nowrap');
    }
    expect(await page.locator('#courses .subnav').evaluate((nav) => nav.scrollWidth > nav.clientWidth)).toBe(true);
    await links.nth(1).focus();
    await expect(links.nth(1)).toBeFocused();
  } finally {
    await context.close();
  }
});

test('skip link is present for keyboard users', async ({ page }) => {
  await page.goto('/');
  const skipLink = page.locator('.skip-link');
  await expect(skipLink).toBeAttached();
});

for (const locale of ['en', 'ar'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`lobby failure text has readable contrast (${locale}, ${theme})`, async ({ page }) => {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rookzen_locale_v1', locale);
        localStorage.setItem('gambit-theme', theme);
      }, { locale, theme });
      await page.route('**/v1/seeks', async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unavailable"}' });
      });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      const error = page.locator('#lobby-error');
      await expect(error).toBeVisible();
      await expect(error).not.toBeEmpty();
      await expect(error).toHaveAttribute('role', 'alert');
      const ratio = await error.evaluate((element) => {
        const luminance = (color: string): number => {
          const values = color.match(/[\d.]+/g)!.map(Number);
          if (values.length === 4 && values[3] !== 1) throw new Error('expected opaque colour');
          const channels = values.slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
        };
        const ink = luminance(getComputedStyle(element).color);
        const background = luminance(getComputedStyle(document.body).backgroundColor);
        return (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
}
