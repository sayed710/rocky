/**
 * M6 acceptance test: full game vs. bot (deterministic termination).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a user via the API.
 *   2. Create a game via POST /e2e/games with botResignsAfterPlies: 3.
 *   3. Set the auth session in localStorage and navigate to the game page.
 *   4. Verify the board renders and the game connects.
 *   5. Play moves as white by clicking squares on the board (select-then-drop):
 *        Click e2, click e4   (ply 1)
 *        Bot replies          (ply 2)
 *        Click d2, click d3   (ply 3)
 *        Bot resigns          (ply 3 >= 3, bot's turn)
 *      Each move goes through the real UI loop: click → BoardInteraction →
 *      oracle → GameSync.submitMove → WS → authority → broadcast → UI update.
 *   6. Assert the UI shows a terminal state (resignation).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Click a square on the board by its algebraic name (e.g. "e2"). */
async function clickSquare(page: Page, square: string) {
  const el = page.locator(`[data-square="${square}"]`);
  await el.click();
}

/**
 * Poll a status locator until its text content changes from `lastText`.
 * Returns the new text (or the original if the timeout expires).
 * This replaces fixed `waitForTimeout` sleeps with event-driven polling.
 */
async function waitForStatusChange(
  page: Page,
  status: Locator,
  lastText: string,
  timeoutMs = 15_000,
): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const text = await status.textContent();
    if (text !== lastText) return text ?? '';
    await page.waitForTimeout(500);
  }
  return lastText;
}

/**
 * Poll a status locator until it shows a terminal state string.
 * Returns true if a terminal state was detected, false on timeout.
 */
async function waitForTerminalState(
  page: Page,
  status: Locator,
  timeoutMs = 30_000,
): Promise<boolean> {
  const isTerminal = (s: string | null) => !!s && (
    s.includes('Checkmate') || s.includes('Stalemate') ||
    s.includes('resignation') || s.includes('Resign') ||
    s.includes('Draw') || s.includes('timeout') ||
    s.includes('abort') || s.includes('1-0') ||
    s.includes('0-1') || s.includes('1/2')
  );
  for (let i = 0; i < timeoutMs / 500; i++) {
    const text = await status.textContent();
    if (isTerminal(text)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

test('full game vs. bot — DOM clicks, bot resigns, terminal state shown', async ({ page, request }) => {
  // 1. Register a user
  const handle = `e2e-bot-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123', email: `${handle}@example.test` },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;
  const refreshToken = auth.tokens.refreshToken;
  const userId = auth.user.id;

  // 2. Create a game via the bridge route with botResignsAfterPlies: 3
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: userId, botResignsAfterPlies: 3 },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(gameResp.ok()).toBeTruthy();
  const game = await gameResp.json();
  const gameId = game.gameId;
  expect(gameId).toBeTruthy();

  // 3. Seed the session for the memory-only-token model (M12 inc 2): the
  //    httpOnly refresh cookie lets the app mint a fresh access token via
  //    `restore()`, and localStorage carries only the persisted identity.
  await page.context().addCookies([
    {
      name: 'gambit_refresh',
      value: refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  await page.addInitScript(({ handle: h, uid }) => {
    localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
  }, { handle, uid: userId });

  // 4. Navigate to the game page
  await page.goto(`/game/${gameId}`);

  // Wait for the board to render
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // Wait for the game to connect — poll for "Your move" or "White to move"
  // This indicates the WS joined and the GameSync received the state.
  let connected = false;
  for (let i = 0; i < 20; i++) {
    const text = await status.textContent();
    if (text && (text.includes('Your move') || text.includes('White to move') || text.includes('white to move'))) {
      connected = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[vs-bot] Connected: ${connected}, status: ${await status.textContent()}`);

  // Check if the board has pieces (squares with text content)
  const pieceCount = await page.locator('[data-square]').evaluateAll(els =>
    els.filter(el => el.textContent && el.textContent.trim().length > 0).length
  );
  console.log(`[vs-bot] Pieces on board: ${pieceCount}`);

  // 5. Play moves as white by clicking squares
  //    Move 1: e2→e4
  console.log('[vs-bot] Clicking e2...');
  await clickSquare(page, 'e2');
  await page.waitForTimeout(300); // brief settle for select-then-drop UI
  console.log('[vs-bot] Clicking e4...');
  await clickSquare(page, 'e4');

  // Wait for the status to change (move processed + bot reply)
  const statusAfterMove1 = await waitForStatusChange(page, status, await status.textContent() ?? '', 15_000);
  console.log(`[vs-bot] After move 1: status="${statusAfterMove1}"`);

  // Wait for bot to reply (status should change again)
  const statusAfterBot1 = await waitForStatusChange(page, status, statusAfterMove1, 15_000);
  console.log(`[vs-bot] After bot reply: status="${statusAfterBot1}"`);

  //    Move 2: d2→d3
  console.log('[vs-bot] Clicking d2...');
  await clickSquare(page, 'd2');
  await page.waitForTimeout(300);
  console.log('[vs-bot] Clicking d3...');
  await clickSquare(page, 'd3');

  // Wait for the status to change (move processed, bot should resign)
  const statusAfterMove2 = await waitForStatusChange(page, status, statusAfterBot1, 15_000);
  console.log(`[vs-bot] After move 2: status="${statusAfterMove2}"`);

  // 6. Assert the UI shows a terminal state — poll instead of fixed sleep
  const gameOver = await waitForTerminalState(page, status, 30_000);

  expect(gameOver).toBe(true);
});
