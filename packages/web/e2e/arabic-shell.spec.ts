import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type { render } from '../test/support/arabic-browser.js';

type BrowserEvidence = ReturnType<typeof render>;
test.setTimeout(30_000);

const sizes = [1440, 1024, 768, 390, 320];
const routes = [
  { path: '/', surface: '#lobby', text: 'العب الشطرنج' },
  { path: '/profile', surface: '#profile', text: 'الإنجازات' },
  { path: '/courses', surface: '#courses', text: 'الدورات' },
  { path: '/about', surface: '#public-document', text: 'حول Rookzen' },
  { path: '/privacy', surface: '#public-document', text: 'الخصوصية' },
  { path: '/missing-arabic-page', surface: '#not-found', text: 'الصفحة غير موجودة' },
];
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/v1/capabilities' ? { capabilities: { learning: true, community: false, messaging: false, studies: false, search: false } } : [];
    await route.fulfill({ status: path.includes('/auth/') ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
});

for (const width of sizes) for (const route of routes) {
  test(`Arabic ${route.path} contains its content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
    await page.addInitScript(() => localStorage.setItem('rookzen_locale_v1', 'ar'));
    await page.goto(route.path);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const surface = page.locator(route.surface);
    await expect(surface).toBeVisible();
    await expect(surface).toContainText(route.text);
    await expect(page.locator('.nav a[data-route="lobby"]')).toHaveText('العب');
    await expect(page.locator('.nav a[data-route="teams"]')).toBeHidden();
    await expect(page.locator('#locale-select')).toHaveValue('ar');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const bounds = await surface.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  });
}

test('native selector preserves focus, locale on reload and SPA navigation; English restores', async ({ page }) => {
  await page.goto('/');
  const selector = page.locator('#locale-select');
  await expect(selector).toHaveAccessibleName('Language');
  await selector.focus();
  await selector.selectOption('ar');
  await expect(selector).toBeFocused();
  await expect(selector).toHaveAccessibleName('اللغة');
  await expect(page.locator('#auth-heading')).toHaveText('سجّل الدخول للعب');
  await page.reload();
  await expect(page.locator('#locale-select')).toHaveValue('ar');
  await page.locator('.nav a[data-route="courses"]').click();
  await expect(page.locator('#courses')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.locator('#locale-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('.nav a[data-route="lobby"]')).toHaveText('Play');
  await page.reload();
  await expect(page.locator('#locale-select')).toHaveValue('en');
});

test('unsupported stored locale safely renders English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rookzen_locale_v1', 'ar-SA'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#locale-select')).toHaveValue('en');
});

test('Arabic board names and keyboard geometry change in place without changing orientation', async ({ page }) => {
  await page.goto('/game/offline-arabic');
  const square = page.locator('[data-square="e2"]');
  await square.focus();
  const before = await page.locator('.cb-board [data-square]').evaluateAll((cells) => { const origin = cells[0]!.getBoundingClientRect(); return cells.map((cell) => ({ square: cell.getAttribute('data-square'), x: (cell.getBoundingClientRect().x - origin.x) / origin.width, y: (cell.getBoundingClientRect().y - origin.y) / origin.height })); });
  expect(before[0]!.square).toBe('a8');
  expect(before[7]!.square).toBe('h8');
  expect(before[7]!.x).toBeCloseTo(7, 1);
  expect(before[56]!.square).toBe('a1');
  expect(before[56]!.y).toBeCloseTo(7, 1);
  await page.locator('#locale-select').evaluate((select) => {
    (select as HTMLSelectElement).value = 'ar';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(square).toBeFocused();
  await expect(square).toHaveAttribute('aria-label', 'e2، بيدق أبيض');
  const after = await page.locator('.cb-board [data-square]').evaluateAll((cells) => { const origin = cells[0]!.getBoundingClientRect(); return cells.map((cell) => ({ square: cell.getAttribute('data-square'), x: (cell.getBoundingClientRect().x - origin.x) / origin.width, y: (cell.getBoundingClientRect().y - origin.y) / origin.height })); });
  // The shell may reposition the board column; every square's relative geometry stays identical.
  for (let i = 0; i < before.length; i++) {
    expect(after[i]!.square).toBe(before[i]!.square);
    expect(after[i]!.x - after[0]!.x).toBeCloseTo(before[i]!.x - before[0]!.x, 1);
    expect(after[i]!.y - after[0]!.y).toBeCloseTo(before[i]!.y - before[0]!.y, 1);
  }
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-square="f2"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(square).toBeFocused();
  await page.locator('#skip-board').focus();
  await expect(page.locator('#skip-board')).toHaveText('انتقل إلى الرقعة');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cb-board [tabindex="0"]')).toBeFocused();
});

test('mixed Arabic prose isolates SAN, UCI, FEN, handle, rating and hostile text without changing bytes', async ({ page }) => {
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, lib: { entry: fileURLToPath(new URL('../test/support/arabic-browser.ts', import.meta.url)), name: 'arabicBrowser', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing browser output');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser chunk');
  await page.goto('/');
  await page.addScriptTag({ content: chunk.code });
  const values = ['Nf3+', 'e2e4', '8/8/8/8/8/8/8/8 w - - 0 1', 'لاعب_Alice', '1820', '1/2-1/2', '+0.34', 'https://example.test/a', '<img src=x onerror=alert(1)>', '1. e4 e5 2. Nf3 Nc6', '755c6759023f4f222e005c0aa37eb18c49c2fabd', 'b013f563-d849-4d23-91d1-e9c4557d334f', '10+5', '05:00 – 05:00'];
  const evidence = await page.evaluate((tokens) => {
    const fn = (window as unknown as { arabicBrowser: { render: (tokens: string[]) => BrowserEvidence } }).arabicBrowser.render;
    return fn(tokens);
  }, values);
  expect(evidence.children.map((child) => child.text)).toEqual(values);
  for (const index of [0, 1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13]) {
    expect(evidence.children[index]!.dir).toBe('ltr');
    expect(evidence.children[index]!.isolation).toBe('isolate');
  }
  expect(evidence.children[3]!.dir).toBe('auto');
  expect(evidence.images).toBe(0);
  expect(evidence.text).toContain(values.join(' '));
  expect(evidence.result).toEqual({ text: 'نتيجتان: {result0} {toString} 1-0 و0-1', directions: ['ltr', 'ltr'] });
  expect(evidence.sessionTokens).toContainEqual({ text: '127.0.0.1', dir: 'ltr' });
  expect(evidence.sessionTokens).toContainEqual({ text: '2026-10-04', dir: 'ltr' });
  expect(evidence.achievement.text).toContain('External <img src=x onerror=alert(1)>');
  expect(evidence.achievement.text).toContain('Unmodified content');
  expect(evidence.achievement.images).toBe(0);
  expect(evidence.achievement.progressDir).toBe('ltr');
  expect(evidence.achievement.text).toContain('الخطوات الأولى');
  expect(evidence.achievement.text).not.toContain('First Moves');
  expect(evidence.tournament.liveText).toContain(' ضد ');
  expect(evidence.tournament.liveText).not.toContain(' vs ');
  expect(evidence.tournament.ltrTokens).toContain('1-0');
  expect(evidence.tournament.ltrTokens).toContain('5:00 - 4:00');
  expect(evidence.tournament.standingsText).toContain('كسر التعادل');
  expect(evidence.tournament.standingsText).toContain('فوز:');
  expect(evidence.study.visibility).toContain('غير مدرجة');
  expect(evidence.study.roles).toEqual(['المالك', 'مساهم', 'مشاهد']);
  expect(evidence.study.ids).toEqual(Array.from({ length: 3 }, () => ({ text: 'b013f563-d849-4d23-91d1-e9c4557d334f', dir: 'ltr' })));
  expect(evidence.ai.ltrTokens).toEqual(expect.arrayContaining(['e2e4', 'd2d4', '-0.20', '+0.35']));
  expect(evidence.ai.text).toContain('صعب');
  expect(evidence.ai.text).toContain('متقدم');
  expect(evidence.ai.text).not.toMatch(/Hard|advanced|faster mate|Win|stalemate/);
});
