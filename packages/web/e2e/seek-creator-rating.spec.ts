import { expect, test } from '@playwright/test';

for (const locale of ['en', 'ar'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`keyboard seek focus remains distinct from its filled button (${locale}, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 337 });
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('rookzen_locale_v1', locale);
        localStorage.setItem('gambit-theme', theme);
      }, { locale, theme });
      await page.route('**/v1/seeks**', async (route) => {
        await route.fulfill({ json: [{
          id: 'focus-seek', creatorId: 'other', creatorHandle: 'Opponent', creatorRating: 1500,
          variant: 'standard', speed: 'blitz', rated: true, color: 'white',
          timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
          minRating: null, maxRating: null, createdAt: '2026-10-06T00:00:00Z',
          gameId: null, acceptedAt: null,
        }] });
      });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      const row = page.locator('.seek-row[data-seek-id="focus-seek"]');
      await row.locator('.row-link').focus();
      await page.keyboard.press('Tab');
      const play = row.locator('.seek-accept');
      await expect(play).toBeFocused();
      const focus = await play.evaluate((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return {
          visible: button.matches(':focus-visible'),
          outline: style.outlineStyle, width: parseFloat(style.outlineWidth),
          separated: style.outlineColor !== style.backgroundColor || parseFloat(style.outlineOffset) >= 2,
          inViewport: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        };
      });
      expect(focus.visible).toBe(true);
      expect(focus.outline).toBe('solid');
      expect(focus.width).toBeGreaterThanOrEqual(2);
      expect(focus.separated).toBe(true);
      expect(focus.inViewport).toBe(true);
    });
  }
}

for (const width of [1440, 390, 320]) {
  test(`seek pool ratings remain readable and focus survives refresh in RTL at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    let blitzRating = 1842.4;
    let profileRequests = 0;
    await page.route('**/v1/users/*', async (route) => { profileRequests++; await route.abort(); });
    await page.route('**/v1/seeks**', async (route) => {
      await route.fulfill({ json: [
        { id: 'blitz', creatorId: 'creator', creatorHandle: 'حسين', creatorRating: blitzRating, variant: 'standard', speed: 'blitz', rated: true },
        { id: 'rapid', creatorId: 'creator', creatorHandle: 'حسين', creatorRating: 2137.6, variant: 'standard', speed: 'rapid', rated: false },
        { id: 'atomic', creatorId: 'other', creatorHandle: 'Alice', creatorRating: null, variant: 'atomic', speed: 'blitz', rated: false },
      ].map((row) => ({ ...row, timeControl: { initialMs: row.speed === 'rapid' ? 600_000 : 180_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }, color: 'random', minRating: 900, maxRating: 1900, createdAt: '2026-10-02T00:00:00Z', gameId: null, acceptedAt: null })) });
    });
    await page.goto('/');
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const blitz = page.locator('.seek-row[data-seek-id="blitz"]');
    const rapid = page.locator('.seek-row[data-seek-id="rapid"]');
    const atomic = page.locator('.seek-row[data-seek-id="atomic"]');
    await expect(blitz.locator('.seek-rating')).toHaveText('1842');
    await expect(blitz.locator('.seek-rating')).toHaveAttribute('dir', 'ltr');
    await expect(blitz.locator('.seek-rating')).toHaveAccessibleName('Rating in Standard · Blitz: 1842');
    await expect(blitz.getByRole('img', { name: 'Rating in Standard · Blitz: 1842' })).toHaveCount(1);
    await expect(blitz.locator('.row-link')).toHaveAttribute('dir', 'auto');
    await expect(blitz.locator('.row-link')).toHaveAttribute('href', '/profile/حسين');
    await expect(rapid.locator('.seek-rating')).toHaveText('2138');
    await expect(atomic.locator('.seek-rating')).toHaveText('Unrated');
    await expect(atomic.locator('.seek-rating')).toHaveAccessibleName('Rating in Atomic · Blitz: Unrated');
    await expect(rapid.locator('.seek-accept')).toHaveAccessibleName('Play — accept seek from حسين');
    await rapid.locator('.seek-accept').focus();
    blitzRating = 1888;
    await page.clock.runFor(10_000);
    await expect(blitz.locator('.seek-rating')).toHaveText('1888');
    await expect(rapid.locator('.seek-accept')).toBeFocused();
    await expect(rapid.locator('.seek-rating')).toHaveText('2138');
    expect(profileRequests).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const row of [blitz, rapid, atomic]) {
      await expect(row.locator('.seek-rating')).toBeVisible();
      await expect(row.locator('.seek-accept')).toBeVisible();
    }
  });
}
