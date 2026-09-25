/**
 * E2E tests for the team forum UI.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('a member starts a thread and a second member replies to it', async ({ browser, request }) => {
  let ownerCtx: BrowserContext | undefined;
  let joinerCtx: BrowserContext | undefined;

  try {
    // Created inside the try so a throw mid-creation still reaches the finally cleanup.
    ownerCtx = await browser.newContext();
    joinerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const joinerPage = await joinerCtx.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const ownerHandle = `fm-o-${suffix}`;
    const joinerHandle = `fm-j-${suffix}`;
    const password = 'test-password-forum-123';

    const regOwner = await request.post('/v1/auth/register', { data: { handle: ownerHandle, password, email: `${ownerHandle}@example.test` } });
    expect(regOwner.ok()).toBeTruthy();
    const ownerAuth = await regOwner.json();
    const regJoiner = await request.post('/v1/auth/register', { data: { handle: joinerHandle, password, email: `${joinerHandle}@example.test` } });
    expect(regJoiner.ok()).toBeTruthy();
    const joinerAuth = await regJoiner.json();

    // Unique per run: the harness is shared across parallel workers, so asserting on "the first
    // row" would race other specs.
    const slug = `forum-${suffix}`;
    const createTeam = await request.post('/v1/teams', {
      data: { name: `Forum ${suffix}`, slug, description: 'e2e forum team', visibility: 'public' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(createTeam.ok()).toBeTruthy();
    const team = await createTeam.json();

    // The second player joins so both are members; only members may post.
    const join = await request.post(`/v1/teams/${team.id}/members`, {
      headers: { Authorization: `Bearer ${joinerAuth.tokens.accessToken}` },
    });
    expect(join.ok()).toBeTruthy();

    const cookie = (value: string) => ({
      name: 'gambit_refresh',
      value,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    });
    await ownerCtx.addCookies([cookie(ownerAuth.tokens.refreshToken)]);
    await joinerCtx.addCookies([cookie(joinerAuth.tokens.refreshToken)]);
    await ownerPage.addInitScript(
      ({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); },
      { handle: ownerHandle, uid: ownerAuth.user.id },
    );
    await joinerPage.addInitScript(
      ({ handle, uid }) => { localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid })); },
      { handle: joinerHandle, uid: joinerAuth.user.id },
    );

    // 1. Reach the forum the way a real user does — through the link on the team page. Navigating
    //    straight to the URL would have passed while that link pointed at the teams list, which is
    //    exactly the state this shipped in until review caught it.
    const title = `Opening ${suffix}`;
    await ownerPage.goto(`/teams/${slug}`);
    await expect(ownerPage.locator('#team-name')).toHaveText(`Forum ${suffix}`, { timeout: 15_000 });
    // Assert the href itself, not just where a click lands. That is the exact defect — it shipped
    // as a literal "/teams" — and it fails deterministically the moment the href is not built from
    // the loaded team, without depending on a navigation completing under load.
    await expect(ownerPage.locator('#team-forum-link')).toHaveAttribute(
      'href',
      `/teams/${slug}/forum`,
      { timeout: 15_000 },
    );
    await ownerPage.locator('#team-forum-link').click();

    await expect(ownerPage).toHaveURL(new RegExp(`/teams/${slug}/forum$`), { timeout: 15_000 });
    await expect(ownerPage.locator('#forum')).toBeVisible({ timeout: 15_000 });
    await expect(ownerPage.locator('#thread-form')).toBeVisible({ timeout: 15_000 });
    await ownerPage.locator('#thread-title-input').fill(title);
    await ownerPage.locator('#thread-body-input').fill('First post body');
    await ownerPage.locator('#thread-submit').click();

    const row = ownerPage.locator('#thread-list .panel-row', { hasText: title });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // The author renders by handle, which only happens if the batched resolvePlayers ran.
    await expect(row).toContainText(ownerHandle, { timeout: 15_000 });
    // The composer empties only after the thread lands.
    await expect(ownerPage.locator('#thread-title-input')).toHaveValue('', { timeout: 15_000 });

    // 2. The other member opens it and replies.
    await joinerPage.goto(`/teams/${slug}/forum`);
    const joinerRow = joinerPage.locator('#thread-list .panel-row', { hasText: title });
    await expect(joinerRow).toBeVisible({ timeout: 15_000 });
    await joinerRow.locator('a').click();

    await expect(joinerPage).toHaveURL(/\/forum\/[a-zA-Z0-9-]+$/, { timeout: 15_000 });
    await expect(joinerPage.locator('#thread-title')).toHaveText(title, { timeout: 15_000 });
    await expect(joinerPage.locator('#thread-posts')).toContainText('First post body', { timeout: 15_000 });

    const reply = `Reply ${suffix}`;
    await expect(joinerPage.locator('#reply-form')).toBeVisible({ timeout: 15_000 });
    await joinerPage.locator('#reply-input').fill(reply);
    await joinerPage.locator('#reply-submit').click();
    await expect(joinerPage.locator('#thread-posts')).toContainText(reply, { timeout: 15_000 });

    // 3. Both posts are visible to the thread's author too.
    await ownerPage.goto(`/teams/${slug}/forum`);
    await ownerPage.locator('#thread-list .panel-row', { hasText: title }).locator('a').click();
    await expect(ownerPage.locator('#thread-posts')).toContainText(reply, { timeout: 15_000 });
  } finally {
    await ownerCtx?.close();
    await joinerCtx?.close();
  }
});
