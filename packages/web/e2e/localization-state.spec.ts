import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type {} from '../test/support/localization-browser.js';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: fileURLToPath(new URL('../test/support/localization-browser.ts', import.meta.url)), name: 'localization', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing browser test bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser test chunk');
  bundle = chunk.code;
});

for (const kind of ['move', 'text', 'quiz'] as const) {
  test(`lesson ${kind}: locale switch keeps pending actions disabled and unlocks current controls`, async ({ page }) => {
    await page.setContent('<html lang="en"><body></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.evaluate((value) => window.localization.harness.mount(value), kind);
    if (kind === 'move') {
      await page.locator('input').fill('Nf3');
      await page.locator('input').press('Enter');
    } else {
      await page.locator('#step-list button').first().click();
    }
    await expect(page.locator('.step-block')).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => window.localization.harness.current!.setLocale('ar'));
    for (const button of await page.locator('#step-list button').all()) await expect(button).toBeDisabled();
    if (kind === 'move') await expect(page.locator('input')).toBeDisabled();
    // Synthetic dispatch bypasses disabled controls and tests action-layer request identity.
    await page.locator(kind === 'move' ? 'form' : '#step-list button').first().dispatchEvent(kind === 'move' ? 'submit' : 'click');
    expect(await page.evaluate(() => window.localization.harness.current!.calls())).toBe(1);
    await page.evaluate(() => window.localization.harness.current!.resolve());
    await expect(page.locator('.step-block')).toHaveAttribute('aria-busy', 'false');
    for (const button of await page.locator('#step-list button').all()) await expect(button).toBeEnabled();
    if (kind === 'move') { await expect(page.locator('input')).toBeEnabled(); await expect(page.locator('input')).toHaveValue('Nf3'); }
    await page.evaluate(() => window.localization.harness.current!.dispose());
  });
}

test('lesson draft retains keyboard focus, selection and localized accessible name', async ({ page }) => {
  await page.setContent('<html lang="en"><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.localization.harness.mount('move'));
  const input = page.locator('input');
  await input.fill('Nf3');
  await input.evaluate((el) => (el as HTMLInputElement).setSelectionRange(1, 2, 'backward'));
  await page.evaluate(() => window.localization.harness.current!.setLocale('ar'));
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Nf3');
  expect(await input.evaluate((el) => { const field = el as HTMLInputElement; return [field.selectionStart, field.selectionEnd, field.selectionDirection]; })).toEqual([1, 2, 'backward']);
  await expect(page.getByRole('textbox', { name: 'AR SAN move' })).toBeVisible();
  await page.evaluate(() => window.localization.harness.current!.dispose());
});

test('disposed lesson cannot receive pending result or locale update', async ({ page }) => {
  await page.setContent('<html lang="en"><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.localization.harness.mount('text'));
  await page.locator('button').click();
  await page.evaluate(() => window.localization.harness.current!.dispose());
  const before = await page.locator('#lesson').textContent();
  await page.evaluate(async () => {
    window.localization.harness.current!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.localization.harness.current!.setLocale('ar');
  });
  expect(await page.locator('#lesson').textContent()).toBe(before);
  await expect(page.locator('button')).toBeDisabled();
});
