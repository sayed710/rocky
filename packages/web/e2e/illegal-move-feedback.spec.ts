import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

const REJECTED = 'That move isn’t legal.';

/** Register a player and sign `context` in as them. */
async function signIn(request: APIRequestContext, context: BrowserContext, prefix: string) {
  const handle = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registration = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
  });
  expect(registration.ok()).toBeTruthy();
  const auth = await registration.json();
  await context.addCookies([{
    name: 'gambit_refresh',
    value: auth.tokens.refreshToken,
    domain: 'localhost',
    path: '/v1/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
  }]);
  await context.addInitScript(({ userHandle, userId }) => {
    localStorage.setItem('gambit-session', JSON.stringify({ handle: userHandle, userId }));
  }, { userHandle: handle, userId: auth.user.id });
  return auth;
}

/** Every `move` frame the page sends over any WebSocket: the only way a move reaches the server. */
function recordMoveFrames(page: Page): string[] {
  const moves: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload)) as { t?: string; uci?: string };
      if (frame.t === 'move' && frame.uci) moves.push(frame.uci);
    });
  });
  return moves;
}

test('a keyboard player hears a rejected move, nothing is sent, and the next legal move commits', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    const white = await signIn(request, context, 'e2e-illegal-w');
    const blackHandle = `e2e-illegal-b-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const blackRegistration = await request.post('/v1/auth/register', {
      data: { handle: blackHandle, password: 'test-password-123', email: `${blackHandle}@example.test` },
    });
    expect(blackRegistration.ok()).toBeTruthy();
    const black = await blackRegistration.json();
    const gameResponse = await request.post('/e2e/games', { data: { whiteId: white.user.id, blackId: black.user.id } });
    expect(gameResponse.ok()).toBeTruthy();
    const game = await gameResponse.json();

    const page = await context.newPage();
    const sentMoves = recordMoveFrames(page);
    await page.goto(`/game/${game.gameId}`);
    const status = page.locator('#status');
    const feedback = page.locator('#move-feedback');
    const board = page.locator('.cb-board');
    await expect(status).toHaveText(/your move/i, { timeout: 15_000 });
    await expect(feedback).toHaveAttribute('role', 'status');
    await expect(feedback).toBeEmpty();

    // e2 -> e5: the pawn cannot go three squares.
    await board.locator('[data-square="e2"]').focus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect(board.locator('[data-square="e5"]')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(feedback).toHaveText(REJECTED);
    await expect(board.locator('[data-square="e5"]'), 'focus stays on the board').toBeFocused();
    await expect(board.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(board.locator('[data-square="e2"]')).toHaveAttribute('aria-label', 'e2, white pawn');
    await expect(board.locator('[data-square="e5"]')).toHaveAttribute('aria-label', 'e5, empty');
    await expect(status, 'the server-owned status is untouched').toHaveText(/your move/i);

    // The same attempt again must be a new live-region addition, or it is not announced twice.
    await feedback.locator('span').evaluate((node) => node.setAttribute('data-first', ''));
    await board.locator('[data-square="e2"]').focus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(feedback).toHaveText(REJECTED);
    await expect(feedback.locator('span')).toHaveCount(1);
    await expect(feedback.locator('span[data-first]')).toHaveCount(0);
    expect(sentMoves, 'a rejected gesture never reaches the network').toEqual([]);

    // The next legal move goes straight through.
    await board.locator('[data-square="e2"]').focus();
    await page.keyboard.press('Enter');
    await expect(feedback, 'a new selection clears the rejection').toBeEmpty();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await expect(status, 'the server accepted the move').toHaveText(/black to move/i, { timeout: 15_000 });
    await expect(board.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn');
    await expect(feedback).toBeEmpty();
    expect(sentMoves).toEqual(['e2e4']);

    // A spectator gets neither move capability nor rejection messages from the same gestures.
    const spectatorContext = await browser.newContext();
    try {
      const spectator = await spectatorContext.newPage();
      const spectatorMoves = recordMoveFrames(spectator);
      await spectator.goto(`/game/${game.gameId}`);
      await expect(spectator.locator('#meta-role')).toHaveText(/spectat/i, { timeout: 15_000 });
      const spectatorBoard = spectator.locator('.cb-board');
      await expect(spectatorBoard.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn');
      for (const [from, to] of [['e7', 'e4'], ['e7', 'e5']] as const) {
        await spectatorBoard.locator(`[data-square="${from}"]`).click();
        await spectatorBoard.locator(`[data-square="${to}"]`).click();
      }
      await expect(spectator.locator('#move-feedback')).toBeEmpty();
      expect(spectatorMoves).toEqual([]);
      await expect(spectatorBoard.locator('[data-square="e7"]')).toHaveAttribute('aria-label', 'e7, black pawn');
    } finally {
      await spectatorContext.close();
    }
  } finally {
    await context.close();
  }
});

test('a touch rejection at 390px in a right-to-left document fits without layout damage', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const auth = await signIn(request, context, 'e2e-illegal-touch');
    const gameResponse = await request.post('/e2e/games', {
      data: { whiteId: auth.user.id, botResignsAfterPlies: 10 },
      headers: { Authorization: `Bearer ${auth.tokens.accessToken}` },
    });
    expect(gameResponse.ok()).toBeTruthy();
    const game = await gameResponse.json();
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
    });

    const page = await context.newPage();
    const sentMoves = recordMoveFrames(page);
    await page.goto(`/game/${game.gameId}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#status')).toHaveText(/your move/i, { timeout: 15_000 });

    const board = page.locator('.cb-board');
    const feedback = page.locator('#move-feedback');
    await board.locator('[data-square="e2"]').tap();
    await board.locator('[data-square="e5"]').tap();
    await expect(feedback).toHaveText(REJECTED);
    expect(sentMoves).toEqual([]);

    const layout = await page.evaluate(() => {
      const box = document.getElementById('move-feedback')!.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        feedbackLeft: box.left,
        feedbackRight: box.right,
      };
    });
    expect(layout.documentWidth, 'no horizontal overflow').toBe(390);
    expect(layout.feedbackLeft).toBeGreaterThanOrEqual(0);
    expect(layout.feedbackRight).toBeLessThanOrEqual(390);
    const boardBox = await board.boundingBox();
    expect(boardBox?.width ?? 0).toBeGreaterThanOrEqual(350);

    await board.locator('[data-square="e2"]').tap();
    await board.locator('[data-square="e4"]').tap();
    await expect(board.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn', { timeout: 15_000 });
    await expect(feedback).toBeEmpty();
    expect(sentMoves).toEqual(['e2e4']);
  } finally {
    await context.close();
  }
});
