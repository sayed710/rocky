/**
 * E2E tests for the Teams UI.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('a second player finds a public team, joins it, and appears in the member list', async ({ browser, request }) => {
  let ownerCtx: BrowserContext | undefined;
  let joinerCtx: BrowserContext | undefined;

  try {
    // Created inside the try so a throw mid-creation still reaches the finally cleanup, matching
    // game-presence.spec.ts and messages.spec.ts.
    ownerCtx = await browser.newContext();
    joinerCtx = await browser.newContext();
    const joinerPage = await joinerCtx.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const ownerHandle = `tm-o-${suffix}`;
    const joinerHandle = `tm-j-${suffix}`;
    const password = 'test-password-teams-123';

    const regOwner = await request.post('/v1/auth/register', { data: { handle: ownerHandle, password, email: `${ownerHandle}@example.test` } });
    expect(regOwner.ok()).toBeTruthy();
    const ownerAuth = await regOwner.json();

    const regJoiner = await request.post('/v1/auth/register', { data: { handle: joinerHandle, password, email: `${joinerHandle}@example.test` } });
    expect(regJoiner.ok()).toBeTruthy();
    const joinerAuth = await regJoiner.json();

    // The team name is unique per run: the harness index and repositories are shared across
    // parallel workers, so asserting on "the first row" would be a race against other specs.
    const teamName = `Team ${suffix}`;
    const createResp = await request.post('/v1/teams', {
      data: { name: teamName, slug: `team-${suffix}`, description: 'An e2e team', visibility: 'public' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(createResp.ok()).toBeTruthy();
    const team = await createResp.json();

    await joinerCtx.addCookies([{
      name: 'gambit_refresh',
      value: joinerAuth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    }]);
    await joinerPage.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: joinerHandle, uid: joinerAuth.user.id },
    );

    // 1. The team is discoverable in the list.
    await joinerPage.goto('/teams');
    await expect(joinerPage.locator('#teams')).toBeVisible({ timeout: 15_000 });
    const row = joinerPage.locator('#team-list .panel-row', { hasText: teamName });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // 2. Opening it shows the team and offers Join, because it is public and the viewer is not a
    //    member. The owner appears in the member list by handle, which only happens if the batched
    //    resolvePlayers hydration ran.
    await row.locator('a').click();
    await expect(joinerPage).toHaveURL(new RegExp(`/teams/team-${suffix}$`), { timeout: 15_000 });
    await expect(joinerPage.locator('#team-name')).toHaveText(teamName, { timeout: 15_000 });
    await expect(joinerPage.locator('#team-members')).toContainText(ownerHandle, { timeout: 15_000 });

    const joinButton = joinerPage.locator('#team-actions button', { hasText: 'Join team' });
    await expect(joinButton).toBeVisible({ timeout: 15_000 });

    // 3. Joining adds the viewer to the members and flips the offered action to Leave.
    await joinButton.click();
    await expect(joinerPage.locator('#team-members')).toContainText(joinerHandle, { timeout: 15_000 });
    await expect(joinerPage.locator('#team-actions button', { hasText: 'Leave team' })).toBeVisible({ timeout: 15_000 });

    // 4. The team id round-trips: the URL carries the slug, the member call needs the id.
    expect(team.slug).toBe(`team-${suffix}`);
  } finally {
    await ownerCtx?.close();
    await joinerCtx?.close();
  }
});

test('private team owner sees pending join request, accepts it, and requester appears in member list', async ({ browser, request }) => {
  let ownerCtx: BrowserContext | undefined;
  let reqCtx: BrowserContext | undefined;

  try {
    ownerCtx = await browser.newContext();
    reqCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const ownerHandle = `tm-mod-o-${suffix}`;
    const reqHandle = `tm-mod-r-${suffix}`;
    const password = 'test-password-teams-456';

    const regOwner = await request.post('/v1/auth/register', { data: { handle: ownerHandle, password, email: `${ownerHandle}@example.test` } });
    expect(regOwner.ok()).toBeTruthy();
    const ownerAuth = await regOwner.json();

    const regReq = await request.post('/v1/auth/register', { data: { handle: reqHandle, password, email: `${reqHandle}@example.test` } });
    expect(regReq.ok()).toBeTruthy();
    const reqAuth = await regReq.json();

    const teamSlug = `priv-team-${suffix}`;
    const createResp = await request.post('/v1/teams', {
      data: { name: `Priv Team ${suffix}`, slug: teamSlug, description: 'Private e2e team', visibility: 'public' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(createResp.ok()).toBeTruthy();
    const team = await createResp.json();

    // Create while visible, then make the team private. This models a legacy pending request and
    // keeps the moderation UI covered without bypassing the private-team existence boundary.
    const joinReqResp = await request.post(`/v1/teams/${team.id}/join-requests`, {
      headers: { Authorization: `Bearer ${reqAuth.tokens.accessToken}` },
    });
    expect(joinReqResp.ok()).toBeTruthy();
    const makePrivateResp = await request.patch(`/v1/teams/${team.id}`, {
      data: { visibility: 'private' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(makePrivateResp.ok()).toBeTruthy();

    await ownerCtx.addCookies([{
      name: 'gambit_refresh',
      value: ownerAuth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    }]);
    await ownerPage.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: ownerHandle, uid: ownerAuth.user.id },
    );

    // 1. Owner navigates to the team detail page
    await ownerPage.goto(`/teams/${teamSlug}`);
    await expect(ownerPage.locator('#team-name')).toHaveText(`Priv Team ${suffix}`, { timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests-heading')).toBeVisible({ timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests')).toBeVisible({ timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests')).toContainText(reqHandle, { timeout: 15_000 });

    // 2. Owner accepts the join request
    const acceptBtn = ownerPage.locator('#join-requests button', { hasText: 'Accept' });
    await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
    await acceptBtn.click();

    // 3. Queue loses the request, and requester appears in the Members list
    await expect(ownerPage.locator('#team-members')).toContainText(reqHandle, { timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests')).not.toContainText(reqHandle, { timeout: 15_000 });
  } finally {
    await ownerCtx?.close();
    await reqCtx?.close();
  }
});

/**
 * The failure path, which the happy-path test above cannot reach.
 *
 * `respondToJoinRequest` reports failure by returning false rather than throwing — the controller
 * catches and surfaces the error itself — so a queue that only repaints on success leaves every
 * button disabled and the moderator stuck. `createJoinRequestQueue` exists to prevent that, and its
 * unit tests pin the rule; nothing pinned that `bootstrap` still *uses* it. Verified: replacing the
 * factory call with an inline handler that never repaints on failure left all 455 web unit tests
 * green.
 *
 * 409 is the realistic trigger. The respond route answers it when the request is no longer pending,
 * which is what a second admin answering first looks like — routine on a moderation queue.
 */
test('a rejected join-request response leaves the queue interactive', async ({ browser, request }) => {
  let ownerCtx: BrowserContext | undefined;

  try {
    ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const ownerHandle = `tm-409-o-${suffix}`;
    const reqHandle = `tm-409-r-${suffix}`;
    const password = 'test-password-teams-456';

    const regOwner = await request.post('/v1/auth/register', { data: { handle: ownerHandle, password, email: `${ownerHandle}@example.test` } });
    expect(regOwner.ok()).toBeTruthy();
    const ownerAuth = await regOwner.json();

    const regReq = await request.post('/v1/auth/register', { data: { handle: reqHandle, password, email: `${reqHandle}@example.test` } });
    expect(regReq.ok()).toBeTruthy();
    const reqAuth = await regReq.json();

    const teamSlug = `priv-409-${suffix}`;
    const createResp = await request.post('/v1/teams', {
      data: { name: `Priv 409 ${suffix}`, slug: teamSlug, description: 'Private e2e team', visibility: 'public' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(createResp.ok()).toBeTruthy();
    const team = await createResp.json();

    const joinReqResp = await request.post(`/v1/teams/${team.id}/join-requests`, {
      headers: { Authorization: `Bearer ${reqAuth.tokens.accessToken}` },
    });
    expect(joinReqResp.ok()).toBeTruthy();
    const makePrivateResp = await request.patch(`/v1/teams/${team.id}`, {
      data: { visibility: 'private' },
      headers: { Authorization: `Bearer ${ownerAuth.tokens.accessToken}` },
    });
    expect(makePrivateResp.ok()).toBeTruthy();

    await ownerCtx.addCookies([{
      name: 'gambit_refresh',
      value: ownerAuth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    }]);
    await ownerPage.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: ownerHandle, uid: ownerAuth.user.id },
    );

    // Stands in for the admin who answered first. Only the respond call is intercepted, so the queue
    // still loads for real and the row under test is a genuine pending request.
    await ownerPage.route('**/join-requests/*/respond', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_transition', message: 'Join request is not pending' }),
      });
    });

    await ownerPage.goto(`/teams/${teamSlug}`);
    await expect(ownerPage.locator('#join-requests')).toContainText(reqHandle, { timeout: 15_000 });

    const acceptBtn = ownerPage.locator('#join-requests button', { hasText: 'Accept' });
    await acceptBtn.click();

    // The error is reported, and the queue is still usable: the row stays and its buttons come back
    // enabled, so the moderator can retry or decline instead of being stranded.
    await expect(ownerPage.locator('#team-error')).not.toBeEmpty({ timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests')).toContainText(reqHandle);
    await expect(acceptBtn).toBeEnabled({ timeout: 15_000 });
    await expect(ownerPage.locator('#join-requests button', { hasText: 'Decline' })).toBeEnabled();
  } finally {
    await ownerCtx?.close();
  }
});
