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

  for (const viewport of VIEWPORTS) {
    // 1. Verify White player perspective under dir="rtl"
    {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        await context.addCookies([{
          name: 'gambit_refresh',
          value: authWhite.tokens.refreshToken,
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
        }, { userHandle: whiteHandle, userId: authWhite.user.id });

        await page.goto(`/game/${game.gameId}`);
        await expect(page.locator('#meta-connection')).toHaveText('Connected');
        await expect(page.locator('#meta-role')).toHaveText('Playing as White');

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          scrollLeft: document.documentElement.scrollLeft,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.scrollLeft).toBe(0);

        // White perspective geometry: file 'a' left of file 'h', rank 8 above rank 1
        const sqA8 = await squareBox(page, 'a8');
        const sqH8 = await squareBox(page, 'h8');
        const sqA1 = await squareBox(page, 'a1');
        const sqH1 = await squareBox(page, 'h1');

        expect(sqA8.x, 'White perspective: a8 must be left of h8 under RTL').toBeLessThan(sqH8.x);
        expect(sqA1.x, 'White perspective: a1 must be left of h1 under RTL').toBeLessThan(sqH1.x);
        expect(sqA8.y, 'White perspective: a8 must be above a1 under RTL').toBeLessThan(sqA1.y);
        expect(sqH8.y, 'White perspective: h8 must be above h1 under RTL').toBeLessThan(sqH1.y);

        // Flip to Black perspective
        const flipBtn = page.locator('#flip');
        await expect(flipBtn).toBeVisible();
        await flipBtn.click();

        const sqA8Flipped = await squareBox(page, 'a8');
        const sqH8Flipped = await squareBox(page, 'h8');
        const sqA1Flipped = await squareBox(page, 'a1');
        const sqH1Flipped = await squareBox(page, 'h1');

        expect(sqH8Flipped.x, 'Flipped to Black: h8 must be left of a8 under RTL').toBeLessThan(sqA8Flipped.x);
        expect(sqH1Flipped.x, 'Flipped to Black: h1 must be left of a1 under RTL').toBeLessThan(sqA1Flipped.x);
        expect(sqA1Flipped.y, 'Flipped to Black: a1 must be above a8 under RTL').toBeLessThan(sqA8Flipped.y);
        expect(sqH1Flipped.y, 'Flipped to Black: h1 must be above h8 under RTL').toBeLessThan(sqH8Flipped.y);

        // Flip back to White perspective
        await flipBtn.click();
        const sqA1Restored = await squareBox(page, 'a1');
        const sqH1Restored = await squareBox(page, 'h1');
        expect(sqA1Restored.x, 'Restored to White: a1 must be left of h1 under RTL').toBeLessThan(sqH1Restored.x);
      } finally {
        await context.close();
      }
    }

    // 2. Verify Black player perspective under dir="rtl"
    {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        await context.addCookies([{
          name: 'gambit_refresh',
          value: authBlack.tokens.refreshToken,
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
        }, { userHandle: blackHandle, userId: authBlack.user.id });

        await page.goto(`/game/${game.gameId}`);
        await expect(page.locator('#meta-connection')).toHaveText('Connected');
        await expect(page.locator('#meta-role')).toHaveText('Playing as Black');

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          scrollLeft: document.documentElement.scrollLeft,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.scrollLeft).toBe(0);

        // Black player perspective geometry: file 'h' left of file 'a', rank 1 above rank 8
        const sqA8 = await squareBox(page, 'a8');
        const sqH8 = await squareBox(page, 'h8');
        const sqA1 = await squareBox(page, 'a1');
        const sqH1 = await squareBox(page, 'h1');

        expect(sqH8.x, 'Black perspective: h8 must be left of a8 under RTL').toBeLessThan(sqA8.x);
        expect(sqH1.x, 'Black perspective: h1 must be left of a1 under RTL').toBeLessThan(sqA1.x);
        expect(sqA1.y, 'Black perspective: a1 must be above a8 under RTL').toBeLessThan(sqA8.y);
        expect(sqH1.y, 'Black perspective: h1 must be above h8 under RTL').toBeLessThan(sqH8.y);

        // Flip to White perspective
        const flipBtn = page.locator('#flip');
        await expect(flipBtn).toBeVisible();
        await flipBtn.click();

        const sqA8Flipped = await squareBox(page, 'a8');
        const sqH8Flipped = await squareBox(page, 'h8');
        const sqA1Flipped = await squareBox(page, 'a1');
        const sqH1Flipped = await squareBox(page, 'h1');

        expect(sqA8Flipped.x, 'Flipped to White: a8 must be left of h8 under RTL').toBeLessThan(sqH8Flipped.x);
        expect(sqA1Flipped.x, 'Flipped to White: a1 must be left of h1 under RTL').toBeLessThan(sqH1Flipped.x);
        expect(sqA8Flipped.y, 'Flipped to White: a8 must be above a1 under RTL').toBeLessThan(sqA1Flipped.y);
        expect(sqH8Flipped.y, 'Flipped to White: h8 must be above h1 under RTL').toBeLessThan(sqH1Flipped.y);

        // Flip back to Black perspective
        await flipBtn.click();
        const sqA1Restored = await squareBox(page, 'a1');
        const sqH1Restored = await squareBox(page, 'h1');
        expect(sqH1Restored.x, 'Restored to Black: h1 must be left of a1 under RTL').toBeLessThan(sqA1Restored.x);
      } finally {
        await context.close();
      }
    }
  }
});

