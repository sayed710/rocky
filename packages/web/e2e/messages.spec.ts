/**
 * E2E tests for the Direct Messaging UI.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('direct messaging flow: User A messages User B from profile and User B sees it', async ({ browser, request }) => {
  let ctxA: BrowserContext | undefined;
  let ctxB: BrowserContext | undefined;

  try {
    // Created inside the try so a throw mid-creation still hits the finally cleanup, matching
    // `game-presence.spec.ts`. Allocating them above it leaks the first context if the second
    // throws.
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const handleA = `dm-a-${suffix}`;
    const handleB = `dm-b-${suffix}`;
    const password = 'test-password-dm-123';

    const regA = await request.post('/v1/auth/register', { data: { handle: handleA, password, email: `${handleA}@example.test` } });
    expect(regA.ok()).toBeTruthy();
    const authA = await regA.json();

    const regB = await request.post('/v1/auth/register', { data: { handle: handleB, password, email: `${handleB}@example.test` } });
    expect(regB.ok()).toBeTruthy();
    const authB = await regB.json();

    const refreshCookie = (value: string) => ({
      name: 'gambit_refresh',
      value,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict' as const,
    });

    await ctxA.addCookies([refreshCookie(authA.tokens.refreshToken)]);
    await ctxB.addCookies([refreshCookie(authB.tokens.refreshToken)]);

    await pageA.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: handleA, uid: authA.user.id },
    );

    await pageB.addInitScript(
      ({ handle, uid }) => {
        localStorage.setItem('gambit-session', JSON.stringify({ handle, userId: uid }));
      },
      { handle: handleB, uid: authB.user.id },
    );

    // 1. User A visits User B's profile
    await pageA.goto(`/profile/${handleB}`);
    await expect(pageA.locator('#profile-handle')).toContainText(handleB, { timeout: 15_000 });

    // User A sees the "Message" button on User B's profile
    const messageBtn = pageA.locator('#social-actions button', { hasText: 'Message' });
    await expect(messageBtn).toBeVisible({ timeout: 15_000 });

    // Click "Message"
    await messageBtn.click();

    // User A is navigated to /messages/:id (conversation view)
    await expect(pageA).toHaveURL(/\/messages\/[a-zA-Z0-9-]+$/, { timeout: 15_000 });
    const conversationSection = pageA.locator('#conversation');
    await expect(conversationSection).toBeVisible({ timeout: 15_000 });

    // User A sends a message
    const composerInput = pageA.locator('#composer-input');
    await expect(composerInput).toBeVisible({ timeout: 15_000 });
    await composerInput.fill('Hello from User A!');
    await pageA.locator('#composer-submit').click();

    // User A sees the sent message in the thread
    const sentMsg = pageA.locator('#conversation-thread .message-item', { hasText: 'Hello from User A!' });
    await expect(sentMsg).toBeVisible({ timeout: 15_000 });

    // The header names the OTHER participant. At this moment the thread contains only A's own
    // message, which is where naming the thread after "whoever posted" gets it wrong: it labelled
    // the conversation with the viewer's own handle. Assert both halves — B is named, A is not.
    await expect(pageA.locator('#conversation-participant')).toHaveText(
      `Conversation with ${handleB}`,
      { timeout: 15_000 },
    );

    // The composer is emptied once the send lands, and keeps the text when it does not.
    await expect(composerInput).toHaveValue('', { timeout: 15_000 });

    // 2. User B navigates to /messages (inbox)
    await pageB.goto('/messages');
    const messagesSection = pageB.locator('#messages');
    await expect(messagesSection).toBeVisible({ timeout: 15_000 });

    const inbox = pageB.locator('#messages-inbox');
    await expect(inbox).toBeVisible({ timeout: 15_000 });

    // User B sees the conversation row in inbox
    const convRow = inbox.locator('.panel-row', { hasText: handleA });
    await expect(convRow).toBeVisible({ timeout: 15_000 });

    // Click the conversation row/link
    await convRow.locator('a.row-link').click();

    // User B is navigated to the thread and sees User A's message
    await expect(pageB).toHaveURL(/\/messages\/[a-zA-Z0-9-]+$/, { timeout: 15_000 });
    const receivedMsg = pageB.locator('#conversation-thread .message-item', { hasText: 'Hello from User A!' });
    await expect(receivedMsg).toBeVisible({ timeout: 15_000 });

    // Deep-linking to /messages while signed in is already covered above: step 2's `goto` is this
    // page's FIRST navigation, so there is no in-memory session and the inbox load has to wait for
    // `auth.restore()` to settle. That is exactly the "no active session" defect, and this assertion
    // is what fails without the deferral in `bootstrap.ts`.
    //
    // A `goto` followed immediately by `reload()` was tried here and is deliberately not used:
    // refresh tokens ROTATE and reuse is rejected (`POST /v1/auth/refresh` — 401 on
    // "Invalid/expired/reused"). Two app boots back to back race the first boot's `Set-Cookie`
    // against the second boot's refresh, so under suite contention the second presents an
    // already-rotated token and gets 401. That flake is the test's own doing, not the app's.
  } finally {
    await ctxA?.close();
    await ctxB?.close();
  }
});
