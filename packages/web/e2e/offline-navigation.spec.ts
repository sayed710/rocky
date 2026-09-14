/**
 * Offline navigation check — verifies the Rookzen service worker provides its offline shell.
 *
 * This spec runs without backends (only needs vite preview).
 *
 * Run with: npm run e2e
 */
import { test, expect } from '@playwright/test';

test('offline navigation falls back to cached shell', async ({ page, context }) => {
  // Load the app online so the SW caches the shell.
  await page.goto('/');
  await expect(page.locator('#lobby')).toBeVisible();

  // Registration is asynchronous. Wait until this page is actually controlled;
  // otherwise Chromium can reject the navigation before the new worker sees it.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
  });

  // Go offline.
  await context.setOffline(true);

  // Navigate to a new page — should fall back to cached index.html.
  await page.goto('/game/test-offline');
  await expect(page.locator('h1')).toContainText('Rookzen');

  // Restore online.
  await context.setOffline(false);
});
