import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

interface Registered {
  readonly handle: string;
  readonly user: { readonly id: string };
  readonly tokens: { readonly refreshToken: string };
}

async function register(request: APIRequestContext, prefix: string): Promise<Registered> {
  const handle = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registration = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
  });
  expect(registration.ok()).toBeTruthy();
  return { handle, ...(await registration.json()) };
}

async function signIn(context: BrowserContext, auth: Registered): Promise<void> {
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
  }, { userHandle: auth.handle, userId: auth.user.id });
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

/** Keyboard select `from`, then activate `to` (both by focusing the cell directly). */
async function keyboardMove(page: Page, board: Locator, from: string, to: string): Promise<void> {
  await board.locator(`[data-square="${from}"]`).focus();
  await page.keyboard.press('Enter');
  await board.locator(`[data-square="${to}"]`).focus();
  await page.keyboard.press('Enter');
}

/** Try every gesture kind on `from`→`to`: click, keyboard (Enter and Space), and drag. */
async function tryAllGestures(page: Page, board: Locator, from: string, to: string): Promise<void> {
  await board.locator(`[data-square="${from}"]`).click();
  await board.locator(`[data-square="${to}"]`).click();
  await keyboardMove(page, board, from, to);
  await board.locator(`[data-square="${from}"]`).focus();
  await page.keyboard.press('Space');
  await board.locator(`[data-square="${to}"]`).focus();
  await page.keyboard.press('Space');
  await board.locator(`[data-square="${from}"]`).dragTo(board.locator(`[data-square="${to}"]`));
}

async function expectUntouched(board: Locator, squares: Readonly<Record<string, string>>): Promise<void> {
  await expect(board.locator('[aria-selected="true"]')).toHaveCount(0);
  await expect(board.locator('[aria-description*="premove"]')).toHaveCount(0);
  for (const [sq, label] of Object.entries(squares)) {
    await expect(board.locator(`[data-square="${sq}"]`)).toHaveAttribute('aria-label', label);
  }
}

test('players move and premove only their own colour; a spectator moves nothing by any gesture', async ({ browser, request }) => {
  const white = await register(request, 'e2e-own-w');
  const black = await register(request, 'e2e-own-b');
  const gameResponse = await request.post('/e2e/games', { data: { whiteId: white.user.id, blackId: black.user.id } });
  expect(gameResponse.ok()).toBeTruthy();
  const game = await gameResponse.json();

  const whiteContext = await browser.newContext();
  const blackContext = await browser.newContext();
  const spectatorContext = await browser.newContext();
  try {
    await signIn(whiteContext, white);
    await signIn(blackContext, black);

    const whitePage = await whiteContext.newPage();
    const whiteMoves = recordMoveFrames(whitePage);
    await whitePage.goto(`/game/${game.gameId}`);
    const whiteBoard = whitePage.locator('.cb-board');
    const whiteStatus = whitePage.locator('#status');
    await expect(whiteStatus).toHaveText(/your move/i, { timeout: 15_000 });

    const blackPage = await blackContext.newPage();
    const blackMoves = recordMoveFrames(blackPage);
    await blackPage.goto(`/game/${game.gameId}`);
    const blackBoard = blackPage.locator('.cb-board');
    await expect(blackPage.locator('#meta-role')).toHaveText(/black/i, { timeout: 15_000 });

    // Black, off-turn: White is the side to move, but White's pieces are not Black's.
    await tryAllGestures(blackPage, blackBoard, 'e2', 'e4');
    await expectUntouched(blackBoard, { e2: 'e2, white pawn', e4: 'e4, empty' });
    await expect(blackPage.locator('#move-feedback')).toBeEmpty();
    expect(blackMoves).toEqual([]);

    // A spectator: every gesture on either colour does nothing, and is not called illegal.
    const spectator = await spectatorContext.newPage();
    const spectatorMoves = recordMoveFrames(spectator);
    await spectator.goto(`/game/${game.gameId}`);
    await expect(spectator.locator('#meta-role')).toHaveText(/spectat/i, { timeout: 15_000 });
    const spectatorBoard = spectator.locator('.cb-board');
    for (const [from, to] of [['e2', 'e4'], ['e7', 'e5']] as const) {
      await tryAllGestures(spectator, spectatorBoard, from, to);
    }
    await expectUntouched(spectatorBoard, { e2: 'e2, white pawn', e4: 'e4, empty', e7: 'e7, black pawn', e5: 'e5, empty' });
    await expect(spectator.locator('#move-feedback')).toBeEmpty();
    // Read-only, not dead: keyboard navigation still moves focus around the grid.
    await spectatorBoard.locator('[data-square="e2"]').focus();
    await spectator.keyboard.press('ArrowUp');
    await expect(spectatorBoard.locator('[data-square="e3"]')).toBeFocused();
    expect(spectatorMoves).toEqual([]);

    // White, on turn: Black's pieces are not selectable; the legal keyboard move commits.
    await whiteBoard.locator('[data-square="e7"]').click();
    await expect(whiteBoard.locator('[aria-selected="true"]')).toHaveCount(0);
    await keyboardMove(whitePage, whiteBoard, 'e2', 'e4');
    await expect(whiteStatus).toHaveText(/black to move/i, { timeout: 15_000 });
    expect(whiteMoves).toEqual(['e2e4']);

    // White, off-turn: Black is now the side to move, and still not White's to touch.
    await tryAllGestures(whitePage, whiteBoard, 'e7', 'e5');
    await expectUntouched(whiteBoard, { e7: 'e7, black pawn', e5: 'e5, empty' });
    // An own-colour premove still queues, and is not sent.
    await keyboardMove(whitePage, whiteBoard, 'd2', 'd4');
    await expect(whiteBoard.locator('[data-square="d4"]')).toHaveAttribute('aria-description', /premove/);
    expect(whiteMoves).toEqual(['e2e4']);

    // Black, on turn: White's pieces still are not Black's; Black's legal move commits.
    await expect(blackBoard.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn', { timeout: 15_000 });
    await blackBoard.locator('[data-square="d2"]').click();
    await expect(blackBoard.locator('[aria-selected="true"]')).toHaveCount(0);
    await keyboardMove(blackPage, blackBoard, 'e7', 'e5');
    await expect(blackBoard.locator('[data-square="e5"]')).toHaveAttribute('aria-label', 'e5, black pawn', { timeout: 15_000 });
    expect(blackMoves).toEqual(['e7e5']);

    // The spectator saw both moves arrive and is still read-only after the updates.
    await expect(spectatorBoard.locator('[data-square="e5"]')).toHaveAttribute('aria-label', 'e5, black pawn', { timeout: 15_000 });
    await tryAllGestures(spectator, spectatorBoard, 'g1', 'f3');
    await tryAllGestures(spectator, spectatorBoard, 'g8', 'f6');
    await expectUntouched(spectatorBoard, { g1: 'g1, white knight', f3: 'f3, empty', g8: 'g8, black knight', f6: 'f6, empty' });
    expect(spectatorMoves).toEqual([]);
  } finally {
    await spectatorContext.close();
    await blackContext.close();
    await whiteContext.close();
  }
});
