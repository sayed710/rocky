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
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/game/offline-arabic');
  const square = page.locator('[data-square="e2"]');
  await square.focus();
  expect((await page.locator('.cb-board').boundingBox())!.width).toBeGreaterThan(280);
  const before = await page.locator('.cb-board [data-square]').evaluateAll((cells) => { const origin = cells[0]!.getBoundingClientRect(); return cells.map((cell) => ({ square: cell.getAttribute('data-square'), x: (cell.getBoundingClientRect().x - origin.x) / origin.width, y: (cell.getBoundingClientRect().y - origin.y) / origin.height })); });
  expect(before[0]!.square).toBe('a8');
  expect(before[7]!.square).toBe('h8');
  expect(before[7]!.x).toBeCloseTo(7, 1);
  expect(before[56]!.square).toBe('a1');
  expect(before[56]!.y).toBeCloseTo(7, 1);
  if (process.env['ROOKZEN_CAPTURE_EVIDENCE']) await page.screenshot({ path: '../../docs/audits/arabic-rtl-evidence/guest-game-en-1280x600.png', fullPage: true });
  await page.locator('#locale-select').evaluate((select) => {
    (select as HTMLSelectElement).value = 'ar';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(square).toBeFocused();
  await expect(square).toHaveAttribute('aria-label', 'e2، بيدق أبيض');
  expect((await page.locator('.cb-board').boundingBox())!.width).toBeGreaterThan(280);
  const after = await page.locator('.cb-board [data-square]').evaluateAll((cells) => { const origin = cells[0]!.getBoundingClientRect(); return cells.map((cell) => ({ square: cell.getAttribute('data-square'), x: (cell.getBoundingClientRect().x - origin.x) / origin.width, y: (cell.getBoundingClientRect().y - origin.y) / origin.height })); });
  // The shell may reposition the board column; every square's relative geometry stays identical.
  for (let i = 0; i < before.length; i++) {
    expect(after[i]!.square).toBe(before[i]!.square);
    expect(after[i]!.x - after[0]!.x).toBeCloseTo(before[i]!.x - before[0]!.x, 1);
    expect(after[i]!.y - after[0]!.y).toBeCloseTo(before[i]!.y - before[0]!.y, 1);
  }
  if (process.env['ROOKZEN_CAPTURE_EVIDENCE']) await page.screenshot({ path: '../../docs/audits/arabic-rtl-evidence/guest-game-ar-1280x600.png', fullPage: true });
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
  expect(evidence.sessionName.action).toBe(`إلغاء الجلسة ${evidence.sessionName.visible}`);
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
  expect(evidence.ai.text).toContain('toString · 1/2-1/2');
  expect(evidence.ai.text).not.toMatch(/Hard|advanced|faster mate|Win|stalemate/);
});

import type { GameSummary, UserProfile } from '../src/api/models.js';

function makeGame(id: string, variant: GameSummary['variant'], whiteId: string, result: string | null = '1-0'): GameSummary {
  return {
    id,
    variant,
    rated: true,
    speed: 'blitz',
    whiteId,
    blackId: 'u-alice',
    result,
    termination: 'normal',
    plyCount: 20,
    startedAt: '2026-10-20T10:00:00Z',
    endedAt: '2026-10-20T10:05:00Z',
  };
}

const aliceProfile: UserProfile = {
  user: { id: 'u-alice', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
  ratings: [],
};

const reservedGameId = 'g/1?q=a&ل';
const aliceGames: readonly GameSummary[] = [
  makeGame(reservedGameId, 'standard', 'u-alice', '1-0'),
  makeGame('g-std', 'standard', 'u-alice', '1-0'),
  makeGame('g-atomic', 'atomic', 'u-bob', '0-1'),
  makeGame('g-c960', 'chess960', 'u-alice', '1/2-1/2'),
];

const canonicalVariants: readonly GameSummary['variant'][] = ['standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings'];

for (const journey of [{ lang: 'en', width: 768, height: 900, dir: 'ltr' }, { lang: 'ar', width: 320, height: 844, dir: 'rtl' }] as const) {
  test(`profile games filter journey (${journey.lang} ${journey.width}px)`, async ({ page }) => {
    let gamesRequests = 0;
    await page.setViewportSize({ width: journey.width, height: journey.height });
    await page.addInitScript((loc) => localStorage.setItem('rookzen_locale_v1', loc), journey.lang);

    await page.route('**/v1/users/alice**', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/v1/users/alice/games') {
        gamesRequests++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aliceGames) });
      } else if (pathname === '/v1/users/alice') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aliceProfile) });
      } else {
        await route.fallback();
      }
    });

    await page.goto('/profile/alice');
    await expect(page.locator('html')).toHaveAttribute('lang', journey.lang);
    await expect(page.locator('html')).toHaveAttribute('dir', journey.dir);

    const filterHost = page.locator('#profile-games-filter');
    const variantSelect = page.locator('#profile-games-variant');
    const resetButton = page.locator('button.profile-games-filter-reset');
    const filterStatus = page.locator('.profile-games-filter-status');
    const filterAnnouncer = page.locator('.profile-games-filter-announcement');
    const rows = page.locator('#profile-games a.game-row');

    await expect(filterHost).toBeVisible();
    await expect(variantSelect).toHaveValue('all');
    await expect(resetButton).toBeVisible();
    await expect(filterStatus).not.toHaveAttribute('aria-live', /polite|assertive/);
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 4 من 4' : 'Showing 4 of 4');
    await expect(filterAnnouncer).toHaveClass(/\bsr-only\b/);
    await expect(filterAnnouncer).toHaveAttribute('role', 'status');
    await expect(filterAnnouncer).toHaveAttribute('aria-live', 'polite');
    await expect(filterAnnouncer).toHaveText('');

    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute('href', `/game/${encodeURIComponent(reservedGameId)}`);
    await expect(rows.nth(1)).toHaveAttribute('href', '/game/g-std');
    await expect(rows.nth(2)).toHaveAttribute('href', '/game/g-atomic');
    await expect(rows.nth(3)).toHaveAttribute('href', '/game/g-c960');
    expect(gamesRequests).toBe(1);

    await variantSelect.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(variantSelect).toHaveValue('atomic');

    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '/game/g-atomic');
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 1 من 4' : 'Showing 1 of 4');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'الشطرنج الذري: عرض 1 من 4' : 'Atomic: Showing 1 of 4');
    await expect(variantSelect).toBeFocused();
    expect(gamesRequests).toBe(1);
    expect(page.url()).toContain('/profile/alice');
    expect(await page.evaluate(() => localStorage.getItem('rookzen_locale_v1'))).toBe(journey.lang);

    await variantSelect.selectOption('chess960');
    await expect(variantSelect).toHaveValue('chess960');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('href', '/game/g-c960');
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 1 من 4' : 'Showing 1 of 4');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'Chess960: عرض 1 من 4' : 'Chess960: Showing 1 of 4');
    await expect(variantSelect).toBeFocused();
    expect(gamesRequests).toBe(1);

    await variantSelect.selectOption('horde');
    await expect(variantSelect).toHaveValue('horde');
    await expect(rows).toHaveCount(0);
    await expect(page.locator('#profile-games a, #profile-games button')).toHaveCount(0);
    await expect(page.locator('#profile-games')).toContainText(journey.lang === 'ar' ? 'لم يتم العثور على مباريات' : 'No games');
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 0 من 4' : 'Showing 0 of 4');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'الحشد: عرض 0 من 4' : 'Horde: Showing 0 of 4');
    expect(gamesRequests).toBe(1);

    await variantSelect.selectOption('racingkings');
    await expect(variantSelect).toHaveValue('racingkings');
    await expect(rows).toHaveCount(0);
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 0 من 4' : 'Showing 0 of 4');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'سباق الملوك: عرض 0 من 4' : 'Racing Kings: Showing 0 of 4');
    expect(gamesRequests).toBe(1);

    await resetButton.focus();
    await resetButton.click();
    await expect(variantSelect).toBeFocused();
    await expect(variantSelect).toHaveValue('all');
    await expect(rows).toHaveCount(4);
    await expect(filterStatus).toHaveText(journey.lang === 'ar' ? 'عرض 4 من 4' : 'Showing 4 of 4');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'جميع الأنواع: عرض 4 من 4' : 'All variants: Showing 4 of 4');
    expect(gamesRequests).toBe(1);

    await variantSelect.selectOption('all');
    await expect(filterAnnouncer).toHaveText(journey.lang === 'ar' ? 'جميع الأنواع: عرض 4 من 4' : 'All variants: Showing 4 of 4');
    expect(gamesRequests).toBe(1);

    if (journey.width === 320) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await variantSelect.focus();
      await expect(variantSelect).toBeFocused();
    }
  });
}

test('profile games pending route, live locale switch and reload reset', async ({ page }) => {
  let resolveGames: () => void = () => {};
  const gamesGate = new Promise<void>((resolve) => { resolveGames = resolve; });

  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => localStorage.setItem('rookzen_locale_v1', 'en'));

  await page.route('**/v1/users/alice**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/v1/users/alice/games') {
      await gamesGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aliceGames) });
    } else if (pathname === '/v1/users/alice') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aliceProfile) });
    } else {
      await route.fallback();
    }
  });

  await page.goto('/profile/alice');
  const variantSelect = page.locator('#profile-games-variant');
  const filterStatus = page.locator('.profile-games-filter-status');
  const filterAnnouncer = page.locator('.profile-games-filter-announcement');
  const rows = page.locator('#profile-games a.game-row');

  await expect(filterStatus).not.toHaveText(/\b0\b/);
  await expect(variantSelect).toBeVisible();
  await variantSelect.selectOption('atomic');
  await expect(filterAnnouncer).toHaveText('');

  resolveGames();

  await expect(variantSelect).toHaveValue('atomic');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('href', '/game/g-atomic');
  await expect(filterAnnouncer).toHaveText('');

  await variantSelect.selectOption('chess960');
  await expect(variantSelect).toHaveValue('chess960');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('href', '/game/g-c960');
  await expect(filterAnnouncer).toHaveText('Chess960: Showing 1 of 4');

  await variantSelect.selectOption('atomic');
  await expect(variantSelect).toHaveValue('atomic');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('href', '/game/g-atomic');
  await expect(filterAnnouncer).toHaveText('Atomic: Showing 1 of 4');

  const selectHandle = await variantSelect.elementHandle();
  const enOptions = variantSelect.locator('option');
  await expect(enOptions).toHaveCount(9);
  const enLabels = await enOptions.allInnerTexts();
  expect(enLabels[0]).toMatch(/^(All|All variants)$/);
  expect(enLabels.slice(1)).toEqual(['Standard', 'Chess960', 'King of the Hill', 'Atomic', 'Crazyhouse', 'Three-check', 'Horde', 'Racing Kings']);
  for (let i = 0; i < canonicalVariants.length; i++) {
    await expect(enOptions.nth(i + 1)).toHaveAttribute('value', canonicalVariants[i]!);
  }

  const localeSelect = page.locator('#locale-select');
  await localeSelect.focus();
  await localeSelect.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(localeSelect).toBeFocused();
  await expect(variantSelect).toHaveValue('atomic');
  expect(await page.evaluate((el) => el === document.querySelector('#profile-games-variant'), selectHandle)).toBe(true);
  await expect(filterAnnouncer).toHaveText('الشطرنج الذري: عرض 1 من 4');
  await expect(filterStatus).toHaveText('عرض 1 من 4');

  const arOptions = variantSelect.locator('option');
  await expect(arOptions).toHaveCount(9);
  const arLabels = await arOptions.allInnerTexts();
  expect(arLabels[0]).toMatch(/^(الكل|جميع الأنواع)$/);
  expect(arLabels.slice(1)).toEqual(['الشطرنج التقليدي', 'Chess960', 'ملك التل', 'الشطرنج الذري', 'كريزي هاوس', 'الكش الثلاثي', 'الحشد', 'سباق الملوك']);
  for (let i = 0; i < canonicalVariants.length; i++) {
    await expect(arOptions.nth(i + 1)).toHaveAttribute('value', canonicalVariants[i]!);
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await localeSelect.focus();
  await localeSelect.selectOption('en');
  await expect(localeSelect).toBeFocused();
  await expect(variantSelect).toHaveValue('atomic');
  await expect(filterAnnouncer).toHaveText('Atomic: Showing 1 of 4');
  await expect(filterStatus).toHaveText('Showing 1 of 4');

  await page.reload();
  await expect(page.locator('#profile-games-variant')).toHaveValue('all');
  await expect(page.locator('#profile-games a.game-row')).toHaveCount(4);
  await expect(page.locator('.profile-games-filter-announcement')).toHaveText('');
});
