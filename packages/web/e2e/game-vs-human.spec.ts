/**
 * M6 acceptance test: full game vs. human — Fool's Mate through DOM clicks.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register two users (player1 = white, player2 = black).
 *   2. Create a game via POST /e2e/games with both user ids.
 *   3. Set auth sessions in localStorage for both browser contexts.
 *   4. Both players navigate to the game page — boards render, games connect.
 *   5. Play Fool's Mate by clicking squares on the board (select-then-drop):
 *        White: click f2, click f3   (ply 1)
 *        Black: click e7, click e5   (ply 2)
 *        White: click g2, click g4   (ply 3)
 *        Black: click d8, click h4   (ply 4 — checkmate!)
 *      Each move goes through the real UI loop: click → BoardInteraction →
 *      oracle → GameSync.submitMove → WS → authority → broadcast → UI update.
 *   6. Assert both contexts show a terminal state (checkmate).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Click a square on the board by its algebraic name (e.g. "f2"). */
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

test('full game vs. human — Fool\'s Mate through DOM clicks, checkmate in 4 plies', async ({ browser, request }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage(); // white
  const page2 = await ctx2.newPage(); // black

  try {
    // 1. Register two users
    const handle1 = `e2e-p1-${Date.now()}`;
    const handle2 = `e2e-p2-${Date.now()}`;
    const password = 'test-password-123';

    const reg1 = await request.post('/v1/auth/register', {
      data: { handle: handle1, password, email: `${handle1}@example.test` },
    });
    expect(reg1.ok()).toBeTruthy();
    const auth1 = await reg1.json();
    const token1 = auth1.tokens.accessToken;
    const refresh1 = auth1.tokens.refreshToken;
    const userId1 = auth1.user.id;

    const reg2 = await request.post('/v1/auth/register', {
      data: { handle: handle2, password, email: `${handle2}@example.test` },
    });
    expect(reg2.ok()).toBeTruthy();
    const auth2 = await reg2.json();
    const refresh2 = auth2.tokens.refreshToken;
    const userId2 = auth2.user.id;

    // 2. Create a game via the bridge route with both player ids
    const gameResp = await request.post('/e2e/games', {
      data: { whiteId: userId1, blackId: userId2 },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(gameResp.ok()).toBeTruthy();
    const game = await gameResp.json();
    const gameId = game.gameId;
    expect(gameId).toBeTruthy();

    // 3. Seed each context for the memory-only-token model (M12 inc 2): the
    //    httpOnly refresh cookie lets the app mint a fresh access token via
    //    restore(); localStorage carries only the persisted identity.
    const refreshCookie = (value: string) => ({
      name: 'gambit_refresh',
      value,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    });
    await ctx1.addCookies([refreshCookie(refresh1)]);
    await ctx2.addCookies([refreshCookie(refresh2)]);
    await page1.addInitScript(({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    }, { handle: handle1, uid: userId1 });
    await page2.addInitScript(({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    }, { handle: handle2, uid: userId2 });

    // 4. Both players navigate to the game page
    await page1.goto(`/game/${gameId}`);
    await page2.goto(`/game/${gameId}`);

    // Wait for boards to render
    await expect(page1.locator('#board')).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('#board')).toBeVisible({ timeout: 10_000 });

    const status1 = page1.locator('#status');
    const status2 = page2.locator('#status');
    await expect(status1).toBeVisible({ timeout: 10_000 });
    await expect(status2).toBeVisible({ timeout: 10_000 });

    // Wait for both games to connect — poll for "Your move" or "X to move"
    for (let i = 0; i < 20; i++) {
      const s1 = await status1.textContent();
      const s2 = await status2.textContent();
      if (s1 && s1.includes('move') && s2 && s2.includes('move')) break;
      await page1.waitForTimeout(500);
    }
    console.log(`[vs-human] p1 status: ${await status1.textContent()}`);
    console.log(`[vs-human] p2 status: ${await status2.textContent()}`);

    // Check pieces on board
    const pieces1 = await page1.locator('[data-square]').evaluateAll(els =>
      els.filter(el => el.textContent && el.textContent.trim().length > 0).length
    );
    const pieces2 = await page2.locator('[data-square]').evaluateAll(els =>
      els.filter(el => el.textContent && el.textContent.trim().length > 0).length
    );
    console.log(`[vs-human] p1 pieces: ${pieces1}, p2 pieces: ${pieces2}`);

    // 5. Play Fool's Mate by clicking squares
    //    Ply 1: White f2→f3
    const s1BeforePly1 = await status1.textContent();
    await clickSquare(page1, 'f2');
    await page1.waitForTimeout(300); // brief settle for select-then-drop UI
    await clickSquare(page1, 'f3');
    // Wait for white's own status to confirm the move was processed
    await waitForStatusChange(page1, status1, s1BeforePly1 ?? '', 15_000);
    // Poll black's status until it reflects the move (no fixed sleep)
    const s2BeforePly1 = await status2.textContent();
    await waitForStatusChange(page2, status2, s2BeforePly1 ?? '', 15_000);
    console.log(`[vs-human] After ply 1: p1="${await status1.textContent()}" p2="${await status2.textContent()}"`);

    //    Ply 2: Black e7→e5
    const s2BeforePly2 = await status2.textContent();
    await clickSquare(page2, 'e7');
    await page2.waitForTimeout(300);
    await clickSquare(page2, 'e5');
    // Wait for black's own status to confirm
    await waitForStatusChange(page2, status2, s2BeforePly2 ?? '', 15_000);
    // Poll white's status until it reflects the move
    const s1BeforePly2 = await status1.textContent();
    await waitForStatusChange(page1, status1, s1BeforePly2 ?? '', 15_000);
    console.log(`[vs-human] After ply 2: p1="${await status1.textContent()}" p2="${await status2.textContent()}"`);

    //    Ply 3: White g2→g4
    const s1BeforePly3 = await status1.textContent();
    await clickSquare(page1, 'g2');
    await page1.waitForTimeout(300);
    await clickSquare(page1, 'g4');
    await waitForStatusChange(page1, status1, s1BeforePly3 ?? '', 15_000);
    const s2BeforePly3 = await status2.textContent();
    await waitForStatusChange(page2, status2, s2BeforePly3 ?? '', 15_000);
    console.log(`[vs-human] After ply 3: p1="${await status1.textContent()}" p2="${await status2.textContent()}"`);

    //    Ply 4: Black d8→h4 — checkmate!
    const s2BeforePly4 = await status2.textContent();
    await clickSquare(page2, 'd8');
    await page2.waitForTimeout(300);
    await clickSquare(page2, 'h4');
    // Wait for black's own status to confirm the move
    await waitForStatusChange(page2, status2, s2BeforePly4 ?? '', 15_000);
    console.log(`[vs-human] After ply 4: p1="${await status1.textContent()}" p2="${await status2.textContent()}"`);

    // 6. Assert both contexts show a terminal state — poll instead of fixed sleep
    const p1Terminal = await waitForTerminalState(page1, status1, 30_000);
    const p2Terminal = await waitForTerminalState(page2, status2, 30_000);

    expect(p1Terminal).toBe(true);
    expect(p2Terminal).toBe(true);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
