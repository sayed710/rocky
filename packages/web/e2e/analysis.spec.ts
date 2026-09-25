/**
 * E2E tests for the engine analysis panel in the game sidebar (M15 inc 2).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * These drive the real product path — capability gate, click, `POST /v1/analysis`, render — against
 * the harness's `AnalysisService`, which is backed by a deterministic provider rather than a real
 * engine. That is deliberate: a real Stockfish would make this suite depend on a binary CI does not
 * install for the Playwright job, and would return a different evaluation on every run, so nothing
 * here could assert what it rendered. The engine's actual behaviour is covered separately by
 * `packages/api/test/analysis-stockfish-smoke.test.ts`, against a real binary.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M15 acceptance gate');

const PASSWORD = 'test-password-analysis-123';

function refreshCookie(value: string) {
  return {
    name: 'gambit_refresh',
    value,
    domain: 'localhost',
    path: '/v1/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict' as const,
  };
}

/**
 * Register an account, seat it in a game against the bot, and authenticate the browser as it.
 *
 * Seeds the session by cookie rather than driving the sign-in form, exactly as `forum.spec.ts` and
 * `account-security-sessions.spec.ts` do — registering through the UI races the bootstrap that wires
 * the sign-in button, which is a flake with nothing to do with what this spec is testing.
 */
async function gameAsSignedInPlayer(
  request: APIRequestContext,
  context: BrowserContext,
  page: Page,
): Promise<{ gameId: string }> {
  const handle = `an-${randomUUID().replaceAll('-', '').slice(0, 8)}`;

  const registered = await request.post('/v1/auth/register', { data: { handle, password: PASSWORD, email: `${handle}@example.test` } });
  expect(registered.ok()).toBeTruthy();
  const auth = await registered.json();

  const created = await request.post('/e2e/games', {
    headers: { authorization: `Bearer ${auth.tokens.accessToken}` },
    data: { whiteId: auth.user.id },
  });
  expect(created.ok()).toBeTruthy();
  const { gameId } = await created.json();

  await context.addCookies([refreshCookie(auth.tokens.refreshToken)]);
  await page.addInitScript(
    ({ h, uid }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: h, userId: uid }));
    },
    { h: handle, uid: auth.user.id },
  );

  return { gameId };
}

test.describe('Engine analysis panel', () => {
  test('a signed-in player analyses the position and sees evaluated lines', async ({ page, context, request }) => {
    const { gameId } = await gameAsSignedInPlayer(request, context, page);

    await page.goto(`/game/${gameId}`);

    // The panel is capability-gated, so its visibility is itself the assertion that
    // `GET /v1/capabilities` reported analysis on and the gate opened.
    const panel = page.locator('#analysis');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const runButton = page.locator('#analysis-run');
    await expect(runButton).toBeEnabled({ timeout: 15_000 });

    await page.locator('#analysis-lines').selectOption('3');
    await runButton.click();

    // Three lines were asked for, so three rows must render — the assertion that MultiPV survives
    // the whole round trip rather than collapsing into one row.
    const rows = page.locator('#analysis-results .panel-row');
    await expect(rows).toHaveCount(3, { timeout: 15_000 });

    // Every row carries an evaluation and a principal variation. The eval is signed and the moves
    // are UCI, so this fails on an empty or half-rendered row rather than merely a missing one.
    for (let index = 0; index < 3; index += 1) {
      await expect(rows.nth(index).locator('.analysis-eval')).toHaveText(/^[+-]?\d+\.\d{2}$|^-?M\d+$/);
      await expect(rows.nth(index).locator('.analysis-moves')).toHaveText(/[a-h][1-8][a-h][1-8]/);
    }
  });

  /**
   * The distinction the panel must never blur: `applied` is what was requested and enforced,
   * `lines[].depth` is what the search actually reached. The harness provider returns a depth one
   * below the limit precisely so a spec can tell them apart.
   */
  test('reached depth and the applied limits are reported separately', async ({ page, context, request }) => {
    const { gameId } = await gameAsSignedInPlayer(request, context, page);
    await page.goto(`/game/${gameId}`);

    await expect(page.locator('#analysis')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#analysis-run')).toBeEnabled({ timeout: 15_000 });
    await page.locator('#analysis-run').click();

    const reached = page.locator('#analysis-reached');
    const limits = page.locator('#analysis-limits');
    await expect(reached).toBeVisible({ timeout: 15_000 });
    await expect(limits).toBeVisible();

    await expect(reached).toHaveText(/Reached depth \d+/);
    await expect(limits).toHaveText(/Limits: depth \d+/);

    const reachedDepth = Number(/Reached depth (\d+)/.exec((await reached.innerText()) ?? '')?.[1]);
    const limitDepth = Number(/Limits: depth (\d+)/.exec((await limits.innerText()) ?? '')?.[1]);
    expect(Number.isFinite(reachedDepth)).toBeTruthy();
    expect(Number.isFinite(limitDepth)).toBeTruthy();
    expect(reachedDepth).not.toBe(limitDepth);
  });

  /** Analysis is a read of the position; it must leave the game exactly as it found it. */
  test('analysing does not disturb the board or submit a move', async ({ page, context, request }) => {
    const { gameId } = await gameAsSignedInPlayer(request, context, page);
    await page.goto(`/game/${gameId}`);

    await expect(page.locator('#analysis')).toBeVisible({ timeout: 15_000 });

    // Baseline only once the game has actually settled. The run control enables when a position
    // exists, so waiting for it is waiting for the snapshot — read any earlier and the comparison
    // catches the game's own "Waiting…" → "Your move" transition rather than anything analysis did.
    await expect(page.locator('#analysis-run')).toBeEnabled({ timeout: 15_000 });
    const pieceCountBefore = await page.locator('.cb-piece').count();
    const statusBefore = await page.locator('#status').innerText();
    const lastMoveBefore = await page.locator('.cb-sq.cb-last').count();

    await page.locator('#analysis-run').click();
    await expect(page.locator('#analysis-results .panel-row').first()).toBeVisible({ timeout: 15_000 });

    // The engine's best line starts with a move. If any of it reached the board, the piece count or
    // the last-move highlight would move with it, and the status would follow a submitted move.
    expect(await page.locator('.cb-piece').count()).toBe(pieceCountBefore);
    expect(await page.locator('.cb-sq.cb-last').count()).toBe(lastMoveBefore);
    expect(await page.locator('#status').innerText()).toBe(statusBefore);
  });

  /** A signed-out visitor gets an explanation, never a control whose every request would 401. */
  test('a signed-out visitor is told to sign in rather than given a dead control', async ({ page }) => {
    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/game/does-not-matter');
    const panel = page.locator('#analysis');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#analysis-run')).toBeDisabled();
    await expect(page.locator('#analysis-note')).toHaveText('Sign in to analyse positions.');
  });
});
