import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

async function geometry(page: Page) {
  return page.locator('.cb-board [data-square]').evaluateAll((cells) => {
    const origin = cells[0]!.getBoundingClientRect();
    return cells.map((cell) => { const box = cell.getBoundingClientRect(); return { square: cell.getAttribute('data-square'), x: (box.x - origin.x) / origin.width, y: (box.y - origin.y) / origin.height }; });
  });
}

test('EN/AR live game, lobby/create game and profile remain contained at all release widths', async ({ browser, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const handle = `ar-live-${suffix}`;
  const registration = await request.post('/v1/auth/register', { data: { handle, password: 'test-password-123', email: `${handle}@example.test` } });
  expect(registration.ok()).toBe(true);
  const auth = await registration.json();
  const opponentResponse = await request.post('/v1/auth/register', { data: { handle: `ar-opp-${suffix}`, password: 'test-password-123', email: `ar-opp-${suffix}@example.test` } });
  expect(opponentResponse.ok()).toBe(true);
  const opponent = await opponentResponse.json();
  const gameResponse = await request.post('/e2e/games', { data: { whiteId: auth.user.id, blackId: opponent.user.id } });
  expect(gameResponse.ok()).toBe(true);
  const game = await gameResponse.json();
  const context = await browser.newContext();
  const opponentContext = await browser.newContext();
  try {
    await context.addCookies([{ name: 'gambit_refresh', value: auth.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
    await context.addInitScript(({ handle, userId }) => localStorage.setItem('gambit-session', JSON.stringify({ handle, userId })), { handle, userId: auth.user.id });
    const page = await context.newPage();
    await opponentContext.addCookies([{ name: 'gambit_refresh', value: opponent.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
    await opponentContext.addInitScript(({ handle, userId }) => localStorage.setItem('gambit-session', JSON.stringify({ handle, userId })), { handle: opponent.user.handle, userId: opponent.user.id });
    const opponentPage = await opponentContext.newPage();
    await opponentPage.goto(`/game/${game.gameId}`);
    await expect(opponentPage.locator('#auth-status')).toContainText(opponent.user.handle);
    await page.goto(`/game/${game.gameId}`);
    const navigate = async (path: string) => {
      await page.evaluate((url) => {
        history.pushState(null, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, path);
    };
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
      if (width !== 1440) await navigate(`/game/${game.gameId}`);
      await expect(page.locator('#auth-status')).toContainText(handle);
      await expect(page.locator('.cb-board [data-square]')).toHaveCount(64);
      await page.locator('#locale-select').selectOption('en');
      await expect(page.locator('#status')).toHaveText(/your move/i);
      const before = await geometry(page);
      expect(before[0]!.square).toBe('a8');
      expect(before[7]!.square).toBe('h8');
      expect(before[7]!.x).toBeCloseTo(7, 1);
      expect(before[56]!.square).toBe('a1');
      expect(before[56]!.y).toBeCloseTo(7, 1);
      await page.locator('#locale-select').focus();
      await page.locator('#locale-select').selectOption('ar');
      await expect(page.locator('#locale-select')).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const after = await geometry(page);
      after.forEach((cell, i) => {
        expect(cell.square).toBe(before[i]!.square);
        expect(cell.x).toBeCloseTo(before[i]!.x, 1);
        expect(cell.y).toBeCloseTo(before[i]!.y, 1);
      });
      const boardBox = await page.locator('.cb-board').boundingBox();
      expect(boardBox!.width).toBeGreaterThan(width < 768 ? width - 40 : 280);
      expect(boardBox!.x).toBeGreaterThanOrEqual(-1);
      expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.locator('#action-offer-draw')).toHaveText('عرض التعادل');
      const clock = page.locator('#clock');
      await expect(clock).toHaveAttribute('dir', 'ltr');
      await expect(clock).toHaveText(/\d+:\d{2} – \d+:\d{2}/);
      await expect(page.locator('#auth-status bdi')).toHaveText(handle);
      if (process.env['ROOKZEN_CAPTURE_EVIDENCE'] && [1440, 390].includes(width)) {
        for (const locale of ['en', 'ar']) {
          await page.locator('#locale-select').selectOption(locale);
          await page.screenshot({ path: `../../docs/audits/arabic-rtl-evidence/live-game-${locale}-${width}.png`, fullPage: true });
        }
      }
      await navigate('/');
      await expect(page.locator('#create-seek')).toBeEnabled();
      await page.locator('#create-seek').click();
      await expect(page.locator('#create-game-form')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (process.env['ROOKZEN_CAPTURE_EVIDENCE'] && [1440, 390].includes(width)) {
        for (const locale of ['en', 'ar']) {
          await page.locator('#locale-select').selectOption(locale);
          await expect(page.locator('#create-game-form')).toBeVisible();
          await page.screenshot({ path: `../../docs/audits/arabic-rtl-evidence/lobby-${locale}-${width}.png`, fullPage: true });
        }
      }
      await navigate('/profile');
      await expect(page.locator('#profile')).toBeVisible();
      await expect(page.locator('#auth-status')).toContainText(handle);
      await expect(page.locator('#profile-handle')).toHaveText(handle);
      await expect(page.locator('#profile-ratings')).not.toBeEmpty();
      await expect(page.locator('#profile-games')).not.toBeEmpty();
      await expect(page.locator('#sessions-list')).not.toBeEmpty();
      await expect(page.locator('#achievements-list')).toContainText('الخطوات الأولى');
      await expect(page.locator('#achievements-list')).toContainText('برونزي');
      await expect(page.locator('#achievements-list')).not.toContainText('First Moves');
      await expect(page.locator('#achievements-list .achievement-standing bdi[dir="ltr"]').first()).toHaveText('0 / 1');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (process.env['ROOKZEN_CAPTURE_EVIDENCE'] && [1440, 390].includes(width)) {
        for (const locale of ['en', 'ar']) {
          await page.locator('#locale-select').selectOption(locale);
          await page.screenshot({ path: `../../docs/audits/arabic-rtl-evidence/profile-${locale}-${width}.png`, fullPage: true });
        }
      }
      await page.locator('#locale-select').selectOption('ar');
    }
  } finally { await context.close(); await opponentContext.close(); }
});
