import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, minimumBoardWidth: 350 },
  { name: 'compact desktop', width: 762, height: 698, minimumBoardWidth: 400 },
] as const;

async function squareBox(page: Page, square: string) {
  const box = await page.locator(`.cb-sq[data-square="${square}"]`).boundingBox();
  if (box === null) throw new Error(`Square ${square} has no rendered bounds`);
  return box;
}

test('the game board stays square and usable across constrained viewports', async ({ browser, request }) => {
  for (const viewport of VIEWPORTS) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const handle = `e2e-board-${suffix}`;
    const registration = await request.post('/v1/auth/register', {
      data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
    });
    expect(registration.ok()).toBeTruthy();
    const auth = await registration.json();

    const gameResponse = await request.post('/e2e/games', {
      data: { whiteId: auth.user.id, botResignsAfterPlies: 10 },
      headers: { Authorization: `Bearer ${auth.tokens.accessToken}` },
    });
    expect(gameResponse.ok()).toBeTruthy();
    const game = await gameResponse.json();

    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    try {
      const page = await context.newPage();
      await context.addCookies([{
        name: 'gambit_refresh',
        value: auth.tokens.refreshToken,
        domain: 'localhost',
        path: '/v1/auth',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      }]);
      await page.addInitScript(({ userHandle, userId }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle: userHandle, userId }));
      }, { userHandle: handle, userId: auth.user.id });

      await page.goto(`/game/${game.gameId}`);
      const board = page.locator('.cb-board');
      await expect(board).toBeVisible();

      const box = await board.boundingBox();
      if (box === null) throw new Error(`${viewport.name} board has no rendered bounds`);
      expect(box.width).toBeGreaterThanOrEqual(viewport.minimumBoardWidth);
      expect(Math.abs(box.width - box.height)).toBeLessThan(1);
      expect(await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }))).toEqual({ documentWidth: viewport.width, viewportWidth: viewport.width });
    } finally {
      await context.close();
    }
  }
});

/** Assert all corner axes for a player perspective independently of document direction. */
async function expectPerspective(page: Page, perspective: 'White' | 'Black') {
  const a8 = await squareBox(page, 'a8');
  const h8 = await squareBox(page, 'h8');
  const a1 = await squareBox(page, 'a1');
  const h1 = await squareBox(page, 'h1');
  const [leftTop, rightTop, leftBottom, rightBottom] = perspective === 'White'
    ? [a8, h8, a1, h1] as const
    : [h1, a1, h8, a8] as const;
  expect(leftTop.x, `${perspective}: top files run left to right`).toBeLessThan(rightTop.x);
  expect(leftBottom.x, `${perspective}: bottom files run left to right`).toBeLessThan(rightBottom.x);
  expect(leftTop.y, `${perspective}: left ranks run top to bottom`).toBeLessThan(leftBottom.y);
  expect(rightTop.y, `${perspective}: right ranks run top to bottom`).toBeLessThan(rightBottom.y);
}

test('active game board preserves standard White and Black orientation and prevents horizontal overflow under dir="rtl"', async ({ browser, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const whiteHandle = `e2e-white-${suffix}`;
  const blackHandle = `e2e-black-${suffix}`;
  const password = 'test-password-123';

  const regWhite = await request.post('/v1/auth/register', {
    data: { handle: whiteHandle, password, email: `${whiteHandle}@example.test` },
  });
  expect(regWhite.ok()).toBeTruthy();
  const authWhite = await regWhite.json();

  const regBlack = await request.post('/v1/auth/register', {
    data: { handle: blackHandle, password, email: `${blackHandle}@example.test` },
  });
  expect(regBlack.ok()).toBeTruthy();
  const authBlack = await regBlack.json();

  const gameResponse = await request.post('/e2e/games', {
    data: { whiteId: authWhite.user.id, blackId: authBlack.user.id },
    headers: { Authorization: `Bearer ${authWhite.tokens.accessToken}` },
  });
  expect(gameResponse.ok()).toBeTruthy();
  const game = await gameResponse.json();

  // One context per registered role: resizing reuses its rotated refresh session.
  for (const player of [
    { role: 'White', handle: whiteHandle, auth: authWhite },
    { role: 'Black', handle: blackHandle, auth: authBlack },
  ] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await context.addCookies([{
        name: 'gambit_refresh',
        value: player.auth.tokens.refreshToken,
        domain: 'localhost',
        path: '/v1/auth',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      }]);
      const page = await context.newPage();
      await page.addInitScript(({ userHandle, userId }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle: userHandle, userId }));
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.setAttribute('dir', 'rtl');
        });
      }, { userHandle: player.handle, userId: player.auth.user.id });

      await page.goto(`/game/${game.gameId}`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('#meta-connection')).toHaveText('Connected');
      await expect(page.locator('#meta-role')).toHaveText(`Playing as ${player.role}`);

      for (const viewport of [
        { name: 'desktop', width: 1440, height: 900 },
        ...VIEWPORTS,
      ]) {
        await test.step(`${player.role} at ${viewport.width}x${viewport.height}`, async () => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await expect(page.locator('#meta-role')).toHaveText(`Playing as ${player.role}`);
          await expect(page.locator('#meta-connection')).toHaveText('Connected');
          const metrics = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            scrollLeft: document.documentElement.scrollLeft,
          }));
          expect(metrics.viewportWidth).toBe(viewport.width);
          expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
          expect(metrics.scrollLeft).toBe(0);
          const boardBox = await page.locator('#board').boundingBox();
          if (boardBox === null) throw new Error(`${player.role} ${viewport.name}: board has no bounds`);
          expect(boardBox.width).toBeGreaterThan(300);
          expect(Math.abs(boardBox.width - boardBox.height)).toBeLessThan(1);
          expect(boardBox.x).toBeGreaterThanOrEqual(0);
          expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(viewport.width + 1);

          await expectPerspective(page, player.role);
          const flip = page.locator('#flip');
          await expect(flip).toBeVisible();
          await flip.click();
          await expectPerspective(page, player.role === 'White' ? 'Black' : 'White');
          await flip.click();
          await expectPerspective(page, player.role);
        });
      }
    } finally {
      await context.close();
    }
  }
});
