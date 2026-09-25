import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

test.describe('Game presence flow', () => {
  test('Presence updates for players and spectators with reconnect recovery', async ({ browser, request }) => {
    // 1. Setup 2 users and create a game
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const handle1 = `e2e-pres1-${suffix}`;
    const handle2 = `e2e-pres2-${suffix}`;
    const password = 'test-password-123';

    const reg1 = await request.post('/v1/auth/register', { data: { handle: handle1, password, email: `${handle1}@example.test` } });
    expect(reg1.ok()).toBeTruthy();
    const auth1 = await reg1.json();
    const reg2 = await request.post('/v1/auth/register', { data: { handle: handle2, password, email: `${handle2}@example.test` } });
    expect(reg2.ok()).toBeTruthy();
    const auth2 = await reg2.json();

    const gReq = await request.post('/e2e/games', {
      data: { whiteId: auth1.user.id, blackId: auth2.user.id },
    });
    expect(gReq.ok()).toBeTruthy();
    const gRes = await gReq.json();
    const gameId = gRes.gameId;

    let p1Ctx: BrowserContext | undefined;
    let p2Ctx: BrowserContext | undefined;
    let specCtx: BrowserContext | undefined;

    try {
      // Create inside the try so a throw mid-creation still hits the finally cleanup.
      p1Ctx = await browser.newContext();
      p2Ctx = await browser.newContext();
      specCtx = await browser.newContext();

      await p1Ctx.addCookies([{ name: 'gambit_refresh', value: auth1.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await p2Ctx.addCookies([{ name: 'gambit_refresh', value: auth2.tokens.refreshToken, domain: 'localhost', path: '/v1/auth', httpOnly: true, secure: false, sameSite: 'Strict' }]);

      const p1Page = await p1Ctx.newPage();
      const p2Page = await p2Ctx.newPage();
      const specPage = await specCtx.newPage();

      await p1Page.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle1, uid: auth1.user.id });
      await p2Page.addInitScript(({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); }, { handle: handle2, uid: auth2.user.id });

      // 3. Both players connect
      await p1Page.goto(`/game/${gameId}`);
      await p2Page.goto(`/game/${gameId}`);

      // Wait for basic connection to succeed
      await expect(p1Page.locator('#meta-connection')).toHaveText('Connected');
      await expect(p2Page.locator('#meta-connection')).toHaveText('Connected');

      // Verify roles
      await expect(p1Page.locator('#meta-role')).toHaveText('Playing as White');
      await expect(p2Page.locator('#meta-role')).toHaveText('Playing as Black');

      // 4. Verify both appear online to Player 1
      const p1WhiteName = p1Page.locator('#meta-white-name');
      const p1WhiteStatus = p1Page.locator('#meta-white .presence-text');
      const p1WhiteDot = p1Page.locator('#meta-white .presence-dot');

      const p1BlackName = p1Page.locator('#meta-black-name');
      const p1BlackStatus = p1Page.locator('#meta-black .presence-text');
      const p1BlackDot = p1Page.locator('#meta-black .presence-dot');

      await expect(p1WhiteName).toHaveText('White (You)');
      await expect(p1WhiteStatus).toHaveText('Online');
      await expect(p1WhiteDot).toHaveClass(/presence-dot online/);

      await expect(p1BlackName).toHaveText('Black');
      await expect(p1BlackStatus).toHaveText('Online');
      await expect(p1BlackDot).toHaveClass(/presence-dot online/);

      // Verify both appear online to Player 2
      const p2WhiteName = p2Page.locator('#meta-white-name');
      const p2WhiteStatus = p2Page.locator('#meta-white .presence-text');
      const p2WhiteDot = p2Page.locator('#meta-white .presence-dot');

      const p2BlackName = p2Page.locator('#meta-black-name');
      const p2BlackStatus = p2Page.locator('#meta-black .presence-text');
      const p2BlackDot = p2Page.locator('#meta-black .presence-dot');

      await expect(p2WhiteName).toHaveText('White');
      await expect(p2WhiteStatus).toHaveText('Online');
      await expect(p2WhiteDot).toHaveClass(/presence-dot online/);

      await expect(p2BlackName).toHaveText('Black (You)');
      await expect(p2BlackStatus).toHaveText('Online');
      await expect(p2BlackDot).toHaveClass(/presence-dot online/);

      // 5. Connect spectator and verify count
      await specPage.goto(`/game/${gameId}`);
      await expect(specPage.locator('#meta-connection')).toHaveText('Connected');
      await expect(specPage.locator('#meta-role')).toHaveText('Spectating');

      // All pages should see 1 spectator
      await expect(p1Page.locator('#meta-spectators')).toHaveText('1');
      await expect(p2Page.locator('#meta-spectators')).toHaveText('1');
      await expect(specPage.locator('#meta-spectators')).toHaveText('1');

      // Spectator sees both players online but neither as "You"
      await expect(specPage.locator('#meta-white-name')).toHaveText('White');
      await expect(specPage.locator('#meta-black-name')).toHaveText('Black');
      await expect(specPage.locator('#meta-white .presence-text')).toHaveText('Online');
      await expect(specPage.locator('#meta-black .presence-text')).toHaveText('Online');

      // 6. Test Reconnect Recovery.
      // setOffline emulates a network drop for new requests; Chromium keeps the
      // existing WebSocket open, so it is the app's ping/pong heartbeat detecting
      // the silent link that drives the Reconnecting… → Connected recovery below.
      await p2Ctx.setOffline(true);
      await expect(p2Page.locator('#meta-connection')).toHaveText('Reconnecting…');
      // Role remains intact during reconnect
      await expect(p2Page.locator('#meta-role')).toHaveText('Playing as Black');
      // Presence values become Unknown
      await expect(p2WhiteStatus).toHaveText('Unknown');
      await expect(p2WhiteDot).toHaveClass(/presence-dot offline/); // fallback styling
      await expect(p2BlackStatus).toHaveText('Unknown');
      await expect(p2Page.locator('#meta-spectators')).toHaveText('—');

      // Player 1 sees Player 2 go offline
      await expect(p1BlackStatus).toHaveText('Offline');
      await expect(p1BlackDot).toHaveClass(/presence-dot offline/);

      // Restore connection
      await p2Ctx.setOffline(false);
      // Wait for recovery
      await expect(p2Page.locator('#meta-connection')).toHaveText('Connected');
      await expect(p2WhiteStatus).toHaveText('Online');
      await expect(p2WhiteDot).toHaveClass(/presence-dot online/);
      await expect(p2BlackStatus).toHaveText('Online');
      await expect(p2Page.locator('#meta-spectators')).toHaveText('1');

      // Player 1 sees Player 2 return
      await expect(p1BlackStatus).toHaveText('Online');
      await expect(p1BlackDot).toHaveClass(/presence-dot online/);

      // 7. Close spectator and verify count decreases
      await specCtx.close();
      await expect(p1Page.locator('#meta-spectators')).toHaveText('0');
      await expect(p2Page.locator('#meta-spectators')).toHaveText('0');

    } finally {
      await Promise.allSettled([
        p1Ctx?.close(),
        p2Ctx?.close(),
        specCtx?.close()
      ]);
    }
  });
});
