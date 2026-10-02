/**
 * Game actions test: resign and draw offer flows.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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

      // White leaves a live confirmation open while Black ends the game.
      await page1.click('#action-resign');
      await expect(page1.locator('#confirm-resign-yes')).toBeFocused();

      // Black resigns
      await page2.click('#action-resign');
      await expect(page2.locator('#confirm-resign')).toBeVisible();
      await page2.click('#confirm-resign-yes');
      await expect(status2).toBeFocused();

      // Both see checkmate
      await expect(status1).toHaveText(/Checkmate — White wins \(resignation\)|White wins by resignation/i, { timeout: 5000 });
      await expect(status2).toHaveText(/Checkmate — White wins \(resignation\)|White wins by resignation/i, { timeout: 5000 });

      // The terminal view removes live actions while retaining the authoritative result.
      await expect(page1.locator('#game-actions')).toBeHidden();
      await expect(page2.locator('#game-actions')).toBeHidden();
      await expect(page1.locator('#confirm-resign')).toBeHidden();
      await expect(status1).toBeFocused();
      await expect(page1.getByRole('group', { name: 'Game actions' })).toHaveCount(0);
      await expect(page1.getByRole('button', { name: 'Resign' })).toHaveCount(0);
      await page1.reload();
      await expect(status1).toHaveText(/Checkmate — White wins \(resignation\)|White wins by resignation/i, { timeout: 15_000 });
      await expect(page1.locator('#game-actions')).toBeHidden();

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
      await expect(page1.locator('#game-actions')).toBeHidden();
      await expect(page2.locator('#game-actions')).toBeHidden();

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

  test('a finished game downloads exactly the server PGN, for players and anonymous spectators', async ({ browser, request }) => {
    const ctx1 = await browser.newContext({ acceptDownloads: true });
    const ctx2 = await browser.newContext();
    // An anonymous spectator on a phone-sized, coarse-pointer screen with the document forced to RTL.
    const ctx3 = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
      const handle1 = `e2e-pgn1-${suffix}`;
      const handle2 = `e2e-pgn2-${suffix}`;
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
      await page3.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
      });

      const gReq = await request.post('/e2e/games', { data: { whiteId: auth1.user.id, blackId: auth2.user.id } });
      expect(gReq.ok()).toBeTruthy();
      const gameId: string = (await gReq.json()).gameId;

      await page1.goto(`/game/${gameId}`);
      await page2.goto(`/game/${gameId}`);
      await page3.goto(`/game/${gameId}`);
      const status1 = page1.locator('#status');
      await expect(status1).toHaveText(/your move/i, { timeout: 15_000 });
      await expect(page2.locator('#status')).toHaveText(/white to move/i, { timeout: 15_000 });
      await expect(page3.locator('#status')).toHaveText(/white to move/i, { timeout: 15_000 });

      // A live game offers no PGN control at all, to players or spectators, and the API refuses it.
      const download1 = page1.getByRole('button', { name: 'Download PGN' });
      const download3 = page3.getByRole('button', { name: 'Download PGN' });
      await expect(download1).toHaveCount(0);
      await expect(download3).toHaveCount(0);
      expect((await request.get(`/v1/games/${gameId}/export.pgn`)).status()).toBe(409);

      await page1.locator('[data-square="e2"]').click();
      await page1.locator('[data-square="e4"]').click();
      await expect(page2.locator('#status')).toHaveText(/your move/i, { timeout: 10_000 });
      await page2.click('#action-resign');
      await page2.click('#confirm-resign-yes');
      await expect(status1).toHaveText(/White wins by resignation|White wins \(resignation\)/i, { timeout: 10_000 });

      // The server's document: one request, read as raw bytes.
      const served = await request.get(`/v1/games/${gameId}/export.pgn`);
      expect(served.status()).toBe(200);
      expect(served.headers()['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
      expect(served.headers()['content-disposition']).toBe(`attachment; filename="game-${gameId}.pgn"`);
      expect(served.headers()['x-content-type-options']).toBe('nosniff');
      const servedBytes = await served.body();
      const servedText = servedBytes.toString('utf8');
      expect(servedText).not.toContain('<');
      expect(servedText).toContain(`[White "${handle1}"]`);
      expect(servedText).toContain(`[Black "${handle2}"]`);
      expect(servedText).toContain('[Result "1-0"]');
      expect(servedText.endsWith('\n\n1. e4 1-0\n')).toBe(true);

      // Keyboard activation saves exactly those bytes under the id filename, and focus stays put.
      await expect(download1).toBeVisible();
      await download1.focus();
      const [saved1] = await Promise.all([page1.waitForEvent('download'), page1.keyboard.press('Enter')]);
      expect(saved1.suggestedFilename()).toBe(`game-${gameId}.pgn`);
      const savedBytes1 = await readFile(await saved1.path());
      expect(Buffer.compare(savedBytes1, servedBytes)).toBe(0);
      await expect(download1).toBeFocused();
      await expect(page1.locator('#game-pgn-status')).toHaveText('PGN download started.');
      await expect(page1).toHaveURL(new RegExp(`/game/${gameId}$`));

      // The anonymous RTL spectator gets the same public document, with a 44px coarse-pointer target
      // and no horizontal overflow.
      await expect(page3.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(download3).toBeVisible({ timeout: 10_000 });
      const box = await download3.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(await page3.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const [saved3] = await Promise.all([page3.waitForEvent('download'), download3.tap()]);
      expect(saved3.suggestedFilename()).toBe(`game-${gameId}.pgn`);
      expect(Buffer.compare(await readFile(await saved3.path()), servedBytes)).toBe(0);

      // A refused request is a perceivable alert, and nothing is saved.
      await page1.route('**/v1/games/*/export.pgn', (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'game not found' } }) }));
      let unexpectedDownload = false;
      page1.on('download', () => { unexpectedDownload = true; });
      await download1.click();
      const alert = page1.getByRole('alert').filter({ hasText: 'The PGN file could not be downloaded. Please try again.' });
      await expect(alert).toBeVisible();
      expect(unexpectedDownload).toBe(false);
    } finally {
      await ctx1.close();
      await ctx2.close();
      await ctx3.close();
    }
  });
});
