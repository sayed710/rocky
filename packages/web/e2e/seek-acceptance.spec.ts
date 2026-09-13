/**
 * M6 acceptance test: atomic matching flow (Seek acceptance).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register two users (player1, player2).
 *   2. player1 logs in, clicks "Create a game", submits the seek.
 *   3. player2 logs in, sees the open seek in the lobby, clicks "Play".
 *   4. Both players are routed to the same game (/game/:id).
 *   5. Boards render and games connect.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('atomic matching flow: Player A creates a seek, Player B accepts', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage(); // creator
  const page2 = await ctx2.newPage(); // acceptor

  try {
    // 1. Register two users
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const handle1 = `e2e-seek1-${suffix}`;
    const handle2 = `e2e-seek2-${suffix}`;
    const password = 'test-password-123';

    const reg1 = await page1.request.post('/v1/auth/register', {
      data: { handle: handle1, password },
    });
    if (!reg1.ok()) {
      console.error(`Registration 1 failed: ${await reg1.text()}`);
    }
    expect(reg1.ok()).toBeTruthy();
    const auth1 = await reg1.json();
    const userId1 = auth1.user.id;

    const reg2 = await page2.request.post('/v1/auth/register', {
      data: { handle: handle2, password },
    });
    if (!reg2.ok()) {
      console.error(`Registration 2 failed: ${await reg2.text()}`);
    }
    expect(reg2.ok()).toBeTruthy();
    const auth2 = await reg2.json();
    const userId2 = auth2.user.id;

    // Registration through each page-owned request context preserves the server-issued
    // HttpOnly refresh cookie in the corresponding browser context.
    await page1.addInitScript(({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    }, { handle: handle1, uid: userId1 });
    await page2.addInitScript(({ handle: h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    }, { handle: handle2, uid: userId2 });

    // 2. Both players go to Lobby
    await page1.goto('/');
    await page2.goto('/');

    // Wait for authentication resolution
    await expect(page1.locator('#auth-logout')).toBeVisible({ timeout: 5_000 });
    await expect(page2.locator('#auth-logout')).toBeVisible({ timeout: 5_000 });

    // 3. Player 1 creates a seek
    await page1.click('#create-seek'); // Open panel
    // It should be expanded
    await expect(page1.locator('#create-game-form')).toBeVisible();
    await page1.click('.cg-submit'); // Submit seek

    // Player 1 should see their own seek in the lobby, waiting for opponent
    await expect(page1.locator('.seek-row-own')).toBeVisible({ timeout: 5_000 });
    await expect(page1.locator('.seek-waiting')).toContainText('Waiting for an opponent');
    const seekId = await page1.locator('.seek-row-own').getAttribute('data-seek-id');
    expect(seekId).toBeTruthy();

    // 4. Player 2 should see Player 1's seek and accept it
    // Lobby polling runs every 10 seconds, so allow one complete refresh cycle
    // and target this test's seek rather than any stale row from a retry.
    const opponentRow = page2.locator(`.seek-row[data-seek-id="${seekId}"]`);
    await expect(opponentRow).toBeVisible({ timeout: 15_000 });
    const opponentLink = opponentRow.locator('a.row-link');
    await expect(opponentLink).toHaveText(handle1);
    await expect(opponentLink).toHaveAttribute('href', `/profile/${handle1}`);
    await expect(opponentLink).toHaveAttribute('data-route', 'profile');

    const acceptBtn = opponentRow.locator('.seek-accept');
    await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
    await expect(acceptBtn).toHaveAccessibleName(`Play — accept seek from ${handle1}`);
    await acceptBtn.click();

    // 5. Both should be automatically routed to the game page
    await page1.waitForURL(/\/game\/.+/, { timeout: 10_000 });
    await page2.waitForURL(/\/game\/.+/, { timeout: 10_000 });

    const url1 = page1.url();
    const url2 = page2.url();
    expect(url1).toEqual(url2);

    // Wait for boards to render
    await expect(page1.locator('#board')).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('#board')).toBeVisible({ timeout: 10_000 });

    // Check status to ensure game connects
    const status1 = page1.locator('#status');
    const status2 = page2.locator('#status');
    await expect(status1).toBeVisible({ timeout: 10_000 });
    await expect(status2).toBeVisible({ timeout: 10_000 });

    await expect(status1).toHaveText(/your move|white to move/i, { timeout: 10_000 });
    await expect(status2).toHaveText(/your move|white to move/i, { timeout: 10_000 });

    const creatorMovesFirst = /your move/i.test(await status1.innerText());
    const whitePage = creatorMovesFirst ? page1 : page2;
    const blackPage = creatorMovesFirst ? page2 : page1;

    await whitePage.locator('[data-square="e2"]').click();
    await whitePage.locator('[data-square="e4"]').click();

    await expect(whitePage.locator('#status')).toHaveText(/black to move/i, { timeout: 5_000 });
    await expect(blackPage.locator('#status')).toHaveText(/your move/i, { timeout: 5_000 });

  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
