/**
 * Game actions test: resign and draw offer flows.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

test.describe('Game actions flow', () => {
  test('Player 1 plays a move, Player 2 resigns, both see checkmate status', async ({ browser, request }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
      const handle1 = `e2e-action1-${suffix}`;
      const handle2 = `e2e-action2-${suffix}`;
      const password = 'test-password-123';

      const reg1 = await request.post('/v1/auth/register', { data: { handle: handle1, password, email: `${handle1}@example.test` } });
      expect(reg1.ok()).toBeTruthy();
      const auth1 = await reg1.json();
      const reg2 = await request.post('/v1/auth/register', { data: { handle: handle2, password, email: `${handle2}@example.test` } });
      expect(reg2.ok()).toBeTruthy();
      const auth2 = await reg2.json();

      await ctx1.addCookies([{ name: 'gambit_refresh', value: auth1.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await ctx2.addCookies([{ name: 'gambit_refresh', value: auth2.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await page1.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle1, uid: auth1.user.id });
      await page2.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle2, uid: auth2.user.id });

      // Create game via e2e backdoor
      const gReq = await request.post('/e2e/games', {
        data: {
          whiteId: auth1.user.id,
          blackId: auth2.user.id,
        },
      });
      expect(gReq.ok()).toBeTruthy();
      const gRes = await gReq.json();
      const gameId = gRes.gameId;

      await page1.goto(`/game/${gameId}`);
      await page2.goto(`/game/${gameId}`);

      const status1 = page1.locator('#status');
      const status2 = page2.locator('#status');
      await expect(status1).toHaveText(/your move/i, { timeout: 15_000 });
      await expect(status2).toHaveText(/white to move/i, { timeout: 15_000 });

      // BoardView maps both axes with one square size, so a visually squashed board also makes
      // legal DOM clicks land on the wrong ranks.
      const boardBox = await page1.locator('.cb-board').boundingBox();
      if (boardBox === null) throw new Error('board has no rendered bounds');
      expect(Math.abs(boardBox.width - boardBox.height)).toBeLessThan(1);

      // Both should see game actions
      await expect(page1.locator('#game-actions')).toBeVisible();
      await expect(page2.locator('#game-actions')).toBeVisible();

      // White plays e4
      await page1.locator('[data-square="e2"]').click();
      await page1.locator('[data-square="e4"]').click();
      await expect(status2).toHaveText(/your move/i, { timeout: 10_000 });

      // Black resigns
      await page2.click('#action-resign');
      await expect(page2.locator('#confirm-resign')).toBeVisible();
      await page2.click('#confirm-resign-yes');
      await expect(status2).toBeFocused();

      // Both see checkmate
      await expect(status1).toHaveText(/Checkmate — White wins \(resignation\)|White wins by resignation/i, { timeout: 5000 });
      await expect(status2).toHaveText(/Checkmate — White wins \(resignation\)|White wins by resignation/i, { timeout: 5000 });

      // Actions are disabled
      await expect(page1.locator('#action-resign')).toBeDisabled();
      await expect(page2.locator('#action-resign')).toBeDisabled();

    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('Player 1 offers draw, Player 2 accepts', async ({ browser, request }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
      const handle1 = `e2e-action3-${suffix}`;
      const handle2 = `e2e-action4-${suffix}`;
      const password = 'test-password-123';

      const reg1 = await request.post('/v1/auth/register', { data: { handle: handle1, password, email: `${handle1}@example.test` } });
      expect(reg1.ok()).toBeTruthy();
      const auth1 = await reg1.json();
      const reg2 = await request.post('/v1/auth/register', { data: { handle: handle2, password, email: `${handle2}@example.test` } });
      expect(reg2.ok()).toBeTruthy();
      const auth2 = await reg2.json();

      await ctx1.addCookies([{ name: 'gambit_refresh', value: auth1.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await ctx2.addCookies([{ name: 'gambit_refresh', value: auth2.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await page1.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle1, uid: auth1.user.id });
      await page2.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle2, uid: auth2.user.id });

      // Create game via e2e backdoor
      const gReq = await request.post('/e2e/games', {
        data: {
          whiteId: auth1.user.id,
          blackId: auth2.user.id,
        },
      });
      expect(gReq.ok()).toBeTruthy();
      const gRes = await gReq.json();
      const gameId = gRes.gameId;

      await page1.goto(`/game/${gameId}`);
      await page2.goto(`/game/${gameId}`);

      const status1 = page1.locator('#status');
      await expect(status1).toHaveText(/your move/i, { timeout: 15_000 });

      // Player 1 offers a draw
      await page1.click('#action-offer-draw');

      // Player 1 sees "Draw offered" and disabled
      const btnOffer1 = page1.locator('#action-offer-draw');
      await expect(btnOffer1).toHaveText('Draw offered');
      await expect(btnOffer1).toBeDisabled();

      // Player 2 sees banner
      const banner2 = page2.locator('#draw-offer-received');
      await expect(banner2).toBeVisible();

      // Player 2 accepts
      await page2.click('#action-accept-draw');

      // Both see "Draw by agreement"
      await expect(page1.locator('#status')).toHaveText(/Draw by agreement/i, { timeout: 5000 });
      await expect(page2.locator('#status')).toHaveText(/Draw by agreement/i, { timeout: 5000 });

      // Banner is hidden
      await expect(banner2).toBeHidden();

    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('Confirmation focus and accessibility', async ({ browser, request }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
      const handle1 = `e2e-action5-${suffix}`;
      const handle2 = `e2e-action6-${suffix}`;
      const password = 'test-password-123';

      const reg1 = await request.post('/v1/auth/register', { data: { handle: handle1, password, email: `${handle1}@example.test` } });
      expect(reg1.ok()).toBeTruthy();
      const auth1 = await reg1.json();
      const reg2 = await request.post('/v1/auth/register', { data: { handle: handle2, password, email: `${handle2}@example.test` } });
      expect(reg2.ok()).toBeTruthy();
      const auth2 = await reg2.json();

      await ctx.addCookies([{ name: 'gambit_refresh', value: auth1.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await page.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle1, uid: auth1.user.id });

      const gReq = await request.post('/e2e/games', {
        data: { whiteId: auth1.user.id, blackId: auth2.user.id },
      });
      expect(gReq.ok()).toBeTruthy();
      const gRes = await gReq.json();
      const gameId = gRes.gameId;

      await page.goto(`/game/${gameId}`);
      await expect(page.locator('#status')).toHaveText(/your move/i, { timeout: 15_000 });

      // Click resign to open confirmation
      await page.click('#action-resign');
      await expect(page.locator('#confirm-resign')).toBeVisible();

      // Check focus and accessible names
      await expect(page.locator('#confirm-resign-yes')).toBeFocused();
      await expect(page.locator('#confirm-resign-yes')).toHaveAttribute('aria-label', 'Confirm resignation');
      await expect(page.locator('#confirm-resign-no')).toHaveAttribute('aria-label', 'Cancel resignation');

      // Cancel and verify focus returns
      await page.click('#confirm-resign-no');
      await expect(page.locator('#confirm-resign')).toBeHidden();
      await expect(page.locator('#action-resign')).toBeFocused();

      // Open abort confirmation
      await page.click('#action-abort');
      await expect(page.locator('#confirm-abort')).toBeVisible();
      await expect(page.locator('#confirm-abort-yes')).toBeFocused();
      await expect(page.locator('#confirm-abort-yes')).toHaveAttribute('aria-label', 'Confirm abort');

      // Cancel to return state to normal
      await page.click('#confirm-abort-no');
      await expect(page.locator('#confirm-abort')).toBeHidden();

    } finally {
      await ctx.close();
    }
  });
});
