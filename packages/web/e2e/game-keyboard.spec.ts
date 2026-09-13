import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

test('the board supports roving focus, compatible Space activation, and keyboard move entry', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const password = 'test-password-123';
  const whiteHandle = `e2e-keyboard-w-${suffix}`;
  const blackHandle = `e2e-keyboard-b-${suffix}`;
  const whiteRegistration = await request.post('/v1/auth/register', {
    data: { handle: whiteHandle, password },
  });
  const blackRegistration = await request.post('/v1/auth/register', {
    data: { handle: blackHandle, password },
  });
  expect(whiteRegistration.ok()).toBeTruthy();
  expect(blackRegistration.ok()).toBeTruthy();
  const white = await whiteRegistration.json();
  const black = await blackRegistration.json();

  const gameResponse = await request.post('/e2e/games', {
    data: { whiteId: white.user.id, blackId: black.user.id },
  });
  expect(gameResponse.ok()).toBeTruthy();
  const game = await gameResponse.json();

  await page.context().addCookies([{
    name: 'gambit_refresh',
    value: white.tokens.refreshToken,
    domain: 'localhost',
    path: '/v1/auth',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
  }]);
  await page.addInitScript(({ handle, userId }) => {
    localStorage.setItem('gambit-session', JSON.stringify({ handle, userId }));
  }, { handle: whiteHandle, userId: white.user.id });

  await page.goto(`/game/${game.gameId}`);
  await expect(page.locator('#status')).toHaveText(/your move/i, { timeout: 15_000 });

  const board = page.locator('.cb-board');
  await expect(board.locator('[tabindex="0"]')).toHaveAttribute('data-square', 'a8');
  await board.locator('[data-square="a8"]').focus();
  await page.keyboard.press('ArrowUp');
  await expect(board.locator('[data-square="a8"]')).toBeFocused();

  await board.locator('[data-square="e2"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(board.locator('[data-square="f2"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(board.locator('[data-square="e2"]')).toBeFocused();

  for (const { key, code, selected } of [
    { key: 'Unidentified', code: 'Space', selected: 'true' },
    { key: 'Spacebar', code: '', selected: 'false' },
  ]) {
    await board.locator('[data-square="e2"]').evaluate((cell, keyboardEvent) => {
      cell.dispatchEvent(new KeyboardEvent('keydown', {
        ...keyboardEvent,
        bubbles: true,
        cancelable: true,
      }));
    }, { key, code });
    await expect(board.locator('[data-square="e2"]')).toHaveAttribute('aria-selected', selected);
  }

  await page.keyboard.press('Enter');
  await expect(board.locator('[data-square="e2"]')).toHaveAttribute('aria-selected', 'true');
  await expect(board.locator('[data-square="e2"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(board.locator('[data-square="e4"]')).toBeFocused();
  await page.keyboard.press('Space');

  await expect(board.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn');
  await expect(board.locator('[data-square="e2"]')).toHaveAttribute('aria-label', 'e2, empty');
  await expect(board.locator('[tabindex="0"]')).toHaveCount(1);

  await page.locator('#flip').click();
  await board.locator('[data-square="e2"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(board.locator('[data-square="d2"]')).toBeFocused();
});
