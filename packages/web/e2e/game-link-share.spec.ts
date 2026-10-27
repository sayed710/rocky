// E2E offline test for CopyGameLink UI using deterministic clipboard stub (no real OS/Safari clipboard permissions).
import { test, expect } from '@playwright/test';
import { DEFAULT_LOCALE_STORAGE_KEY } from '../src/i18n/storage.js';

const LOCALES = [
  { code: 'en', dir: 'ltr', buttonText: 'Copy game link', statusText: 'Game link copied to the clipboard.' },
  { code: 'ar', dir: 'rtl', buttonText: 'نسخ رابط المباراة', statusText: 'تم نسخ رابط المباراة إلى الحافظة.' },
] as const;

test.describe('CopyGameLink offline sharing', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/v1/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/capabilities')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ capabilities: {} }) });
        return;
      }
      if (url.includes('/auth')) {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
        return;
      }
      await route.fulfill({ status: 404 });
    });

    await page.addInitScript(() => {
      Object.defineProperty(window, '__copiedText', { value: '', writable: true, configurable: true });
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string) => {
            (window as unknown as Record<string, unknown>).__copiedText = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
  });

  for (const { code, dir, buttonText, statusText } of LOCALES) {
    test(`copies canonical link via keyboard in ${code} locale`, async ({ page }) => {
      await page.addInitScript(
        ({ key, locale }) => window.localStorage.setItem(key, locale),
        { key: DEFAULT_LOCALE_STORAGE_KEY, locale: code },
      );

      if (code === 'ar') {
        await page.setViewportSize({ width: 390, height: 844 });
      }

      await page.goto('/game/g1?token=test-fake-token-literal-value#share');
      await expect(page.locator('html')).toHaveAttribute('dir', dir);

      if (code === 'ar') {
        const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(hasOverflow).toBe(false);
      }

      const copyButton = page.locator('#game-link-copy');
      await expect(copyButton).toBeVisible();
      await expect(copyButton).toHaveText(buttonText);

      await copyButton.focus();
      await expect(copyButton).toBeFocused();
      await page.keyboard.press('Enter');

      const status = page.locator('#game-link-status');
      await expect(status).toBeVisible();
      await expect(status).not.toHaveAttribute('hidden');
      await expect(status).toHaveText(statusText);

      const origin = new URL(page.url()).origin;
      const copied = await page.evaluate(() => (window as unknown as Record<string, unknown>).__copiedText as string | undefined);
      expect(copied).toBe(`${origin}/game/g1`);
      if (code === 'ar') {
        expect(copied).not.toMatch(/[\u200E\u200F\u202A-\u202E]/);
      }
    });
  }
});
