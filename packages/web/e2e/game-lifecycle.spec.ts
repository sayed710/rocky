import { test, expect, type WebSocket } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

test('leaving a game closes its WebSocket before another game route mounts', async ({ browser, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const whiteHandle = `e2e-life-w-${suffix}`;
  const blackHandle = `e2e-life-b-${suffix}`;
  const password = 'test-password-123';
  const whiteRegistration = await request.post('/v1/auth/register', {
    data: { handle: whiteHandle, password, email: `${whiteHandle}@example.test` },
  });
  const blackRegistration = await request.post('/v1/auth/register', {
    data: { handle: blackHandle, password, email: `${blackHandle}@example.test` },
  });
  expect(whiteRegistration.ok()).toBeTruthy();
  expect(blackRegistration.ok()).toBeTruthy();
  const whiteAuth = await whiteRegistration.json();
  const blackAuth = await blackRegistration.json();
  const gameResponse = await request.post('/e2e/games', {
    data: { whiteId: whiteAuth.user.id, blackId: blackAuth.user.id },
  });
  expect(gameResponse.ok()).toBeTruthy();
  const { gameId } = await gameResponse.json();

  const context = await browser.newContext();
  try {
    await context.addCookies([{
      name: 'gambit_refresh',
      value: whiteAuth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    }]);
    const page = await context.newPage();
    await page.addInitScript(({ handle, userId }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle, userId }));
    }, { handle: whiteHandle, userId: whiteAuth.user.id });
    const sockets: WebSocket[] = [];
    page.on('websocket', (socket) => sockets.push(socket));

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('#meta-connection')).toHaveText('Connected');
    await expect.poll(() => sockets.length).toBe(1);
    await page.locator('nav a[data-route="lobby"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => sockets[0]!.isClosed()).toBe(true);

    await page.goBack();
    await expect(page.locator('#meta-connection')).toHaveText('Connected');
    await expect.poll(() => sockets.length).toBe(2);
    await page.locator('nav a[data-route="lobby"]').click();
    await expect.poll(() => sockets[1]!.isClosed()).toBe(true);
  } finally {
    await context.close();
  }
});
