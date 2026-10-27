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

function makeSeek(id: string, variant: string, creatorHandle = 'Opponent', creatorRating: number | null = 1500) {
  return {
    id, creatorId: `creator-${id}`, creatorHandle, creatorRating,
    variant, speed: 'blitz', rated: true, color: 'random',
    timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    minRating: null, maxRating: null, createdAt: '2026-10-06T00:00:00Z', gameId: null, acceptedAt: null,
  };
}

type LobbyFilterProbeWindow = Window & {
  lobbyFilterProbe?: {
    node: Element;
    mutations: number;
    observer: MutationObserver;
  };
};

for (const { locale, width } of [{ locale: 'en', width: 768 }, { locale: 'ar', width: 320 }] as const) {
  test(`lobby opponent variant filtering lifecycle (${locale}, ${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install();
    await page.addInitScript(({ locale }) => {
      localStorage.setItem('rookzen_locale_v1', locale);
    }, { locale });

    let seeksReqs = 0;
    let gqlReqs = 0;
    let seeks = [makeSeek('seek-std', 'standard', 'Alice'), makeSeek('seek-atomic', 'atomic', 'Bob'), makeSeek('seek-960', 'chess960', 'Charlie')];
    await page.route('**/v1/seeks**', async (route) => { seeksReqs++; await route.fulfill({ json: seeks }); });
    await page.route(/graphql/i, async (route) => { gqlReqs++; await route.abort(); });
    await page.route('**/v1/users/*', async (route) => { await route.abort(); });

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const filterToolbar = page.locator('#seek-filter');
    const filterSelect = page.locator('#lobby-variant-filter');
    const seekList = page.locator('#seek-list');
    const status = page.locator('#seek-filter .seek-filter-status');
    const announcer = page.locator('#seek-filter .seek-filter-announcement');

    await expect(filterToolbar.locator('#lobby-variant-filter')).toHaveCount(1);
    await expect(seekList.locator('#lobby-variant-filter')).toHaveCount(0);
    await expect(status).not.toHaveAttribute('role', 'status');
    await expect(status).not.toHaveAttribute('aria-live');
    await expect(announcer).toHaveClass(/sr-only/);
    await expect(announcer).toHaveAttribute('role', 'status');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');
    await expect(announcer).toHaveText('');

    await page.evaluate(() => {
      type ProbeWin = Window & {
        lobbyFilterProbe?: { node: Element; mutations: number; observer: MutationObserver };
      };
      const el = document.querySelector('#seek-filter .seek-filter-announcement');
      if (!el) throw new Error('Missing announcer #seek-filter .seek-filter-announcement');
      const probe = {
        node: el,
        mutations: 0,
        observer: new MutationObserver((records) => {
          probe.mutations += records.length;
        }),
      };
      probe.observer.observe(el, { childList: true, characterData: true, subtree: true });
      (window as unknown as ProbeWin).lobbyFilterProbe = probe;
    });

    const getAnnouncerMutations = () =>
      page.evaluate(() => {
        const probe = (window as unknown as LobbyFilterProbeWindow).lobbyFilterProbe;
        if (!probe) throw new Error('lobbyFilterProbe is missing on window');
        return probe.mutations;
      });

    expect(await filterSelect.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value))).toEqual([
      'all', 'standard', 'chess960', 'kingofthehill', 'atomic', 'crazyhouse', 'threecheck', 'horde', 'racingkings',
    ]);
    await expect(filterSelect).toHaveAccessibleName(locale === 'ar' ? 'تصفية حسب النوع' : 'Filter by variant');
    await expect(page.locator('.seek-row')).toHaveCount(3);

    const snapshot = async () => ({
      seeks: seeksReqs, gql: gqlReqs, url: page.url(),
      hist: await page.evaluate(() => window.history.length),
      store: await page.evaluate(() => JSON.stringify(window.localStorage)),
    });

    const snap1 = await snapshot();
    await filterSelect.focus();
    await expect(filterSelect).toBeFocused();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(filterSelect).toHaveValue('atomic');
    expect(await snapshot()).toEqual(snap1);

    await expect.poll(getAnnouncerMutations).toBeGreaterThan(0);
    const expectedAtomicCount = locale === 'ar'
      ? 'عرض 1 من أصل 3 من عروض الخصوم المحملة'
      : 'Showing 1 of 3 loaded opponent offers';
    await expect(status).toHaveText(expectedAtomicCount);
    await expect(announcer).toHaveText(expectedAtomicCount);
    await expect(announcer).toHaveText((await status.textContent()) ?? '');
    const snapMut1 = await getAnnouncerMutations();

    await expect(page.locator('.seek-row')).toHaveCount(1);
    await expect(page.locator('.seek-row[data-seek-id="seek-atomic"]')).toBeVisible();

    const selectHandle = await filterSelect.elementHandle();
    await filterSelect.focus();
    seeks = [makeSeek('seek-std-2', 'standard', 'Dave'), makeSeek('seek-atomic', 'atomic', 'Bob'), makeSeek('seek-atomic-2', 'atomic', 'Eve')];
    const prevSeeks = seeksReqs;
    await page.clock.runFor(10_000);
    await expect.poll(() => seeksReqs).toBeGreaterThan(prevSeeks);

    await expect(page.locator('.seek-row')).toHaveCount(2);
    await expect(page.locator('.seek-row[data-seek-id="seek-atomic"]')).toBeVisible();
    await expect(page.locator('.seek-row[data-seek-id="seek-atomic-2"]')).toBeVisible();
    expect(await page.evaluate(([a, b]) => a === b, [await filterSelect.elementHandle(), selectHandle])).toBe(true);
    await expect(filterSelect).toBeFocused();
    const expectedCount2of3 = locale === 'ar'
      ? 'عرض 2 من أصل 3 من عروض الخصوم المحملة'
      : 'Showing 2 of 3 loaded opponent offers';
    await expect(status).toHaveText(expectedCount2of3);
    await expect(announcer).toHaveText(expectedAtomicCount);
    expect(await getAnnouncerMutations()).toBe(snapMut1);

    const snap2 = await snapshot();
    await filterSelect.selectOption('horde');
    await expect(filterSelect).toHaveValue('horde');
    expect(await snapshot()).toEqual(snap2);

    const expectedEmpty = locale === 'ar'
      ? 'لا توجد تحديات خصوم محملة تطابق النوع المحدد.'
      : 'No loaded opponent challenges match the selected variant.';
    await expect.poll(getAnnouncerMutations).toBeGreaterThan(snapMut1);
    const snapMut2 = await getAnnouncerMutations();
    await expect(page.locator('.seek-row')).toHaveCount(0);
    await expect(status).toHaveText(expectedEmpty);
    await expect(status).toBeVisible();
    await expect(announcer).toHaveText(expectedEmpty);
    await expect(seekList.locator('.seek-filter-reset')).toHaveCount(0);

    const resetBtn = page.locator('#seek-filter .seek-filter-reset');
    await expect(resetBtn).toBeVisible();

    const snap3 = await snapshot();
    await resetBtn.click();
    expect(await snapshot()).toEqual(snap3);
    await expect.poll(getAnnouncerMutations).toBeGreaterThan(snapMut2);
    const snapMut3 = await getAnnouncerMutations();
    const expectedAllCount3 = locale === 'ar'
      ? 'عرض 3 من عروض الخصوم المحملة'
      : 'Showing 3 loaded opponent offers';
    await expect(status).toHaveText(expectedAllCount3);
    await expect(announcer).toHaveText(expectedAllCount3);

    await expect(filterSelect).toHaveValue('all');
    await expect(filterSelect).toBeFocused();
    await expect(page.locator('.seek-row')).toHaveCount(3);
    await expect(page.locator('.seek-row').nth(0)).toHaveAttribute('data-seek-id', 'seek-std-2');
    await expect(page.locator('.seek-row').nth(1)).toHaveAttribute('data-seek-id', 'seek-atomic');
    await expect(page.locator('.seek-row').nth(2)).toHaveAttribute('data-seek-id', 'seek-atomic-2');

    seeks = [
      makeSeek('seek-std-2', 'standard', 'Dave'),
      makeSeek('seek-atomic', 'atomic', 'Bob'),
      makeSeek('seek-atomic-2', 'atomic', 'Eve'),
      makeSeek('seek-extra', 'chess960', 'Grace'),
    ];
    const prevPoll4Seeks = seeksReqs;
    await page.clock.runFor(10_000);
    await expect.poll(() => seeksReqs).toBeGreaterThan(prevPoll4Seeks);
    await expect(page.locator('.seek-row')).toHaveCount(4);
    const expectedAllCount4 = locale === 'ar'
      ? 'عرض 4 من عروض الخصوم المحملة'
      : 'Showing 4 loaded opponent offers';
    await expect(status).toHaveText(expectedAllCount4);
    await expect(announcer).toHaveText(expectedAllCount3);
    expect(await getAnnouncerMutations()).toBe(snapMut3);

    seeks = [];
    const prevEmptySeeks = seeksReqs;
    await page.clock.runFor(10_000);
    await expect.poll(() => seeksReqs).toBeGreaterThan(prevEmptySeeks);
    await expect(page.locator('.seek-row')).toHaveCount(0);
    await expect(seekList).toHaveAttribute('role', 'status');
    await expect(seekList.locator('.empty')).toBeVisible();
    await expect.poll(getAnnouncerMutations).toBeGreaterThan(snapMut3);
    await expect(announcer).toHaveText('');
    const snapEmptyMut = await getAnnouncerMutations();

    const prevRepeatEmptySeeks = seeksReqs;
    await page.clock.runFor(10_000);
    await expect.poll(() => seeksReqs).toBeGreaterThan(prevRepeatEmptySeeks);
    expect(await getAnnouncerMutations()).toBe(snapEmptyMut);
    await expect(announcer).toHaveText('');
    await expect(page.locator('.seek-row')).toHaveCount(0);
    await expect(seekList).toHaveAttribute('role', 'status');
    await expect(seekList.locator('.empty')).toBeVisible();
    await expect(status).not.toHaveText(expectedEmpty);
    expect(await page.evaluate(() => (window as unknown as LobbyFilterProbeWindow).lobbyFilterProbe?.node === document.querySelector('#seek-filter .seek-filter-announcement'))).toBe(true);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('lobby variant filter survives live EN->AR->EN locale switching', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('rookzen_locale_v1', 'en'); });

  const seeks = [makeSeek('seek-std', 'standard', 'Alice'), makeSeek('seek-atomic', 'atomic', 'Bob')];
  await page.route('**/v1/seeks**', async (route) => { await route.fulfill({ json: seeks }); });
  await page.route(/graphql/i, async (route) => { await route.abort(); });
  await page.route('**/v1/users/*', async (route) => { await route.abort(); });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  const filterSelect = page.locator('#lobby-variant-filter');
  const localeSelect = page.locator('select#locale-select');
  await expect(filterSelect).toBeVisible();
  await expect(localeSelect).toBeVisible();

  await filterSelect.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(filterSelect).toHaveValue('atomic');
  expect(await page.evaluate(() => localStorage.getItem('rookzen_locale_v1'))).toBe('en');

  const filterHandle = await filterSelect.elementHandle();
  const optionHandles = await filterSelect.locator('option').elementHandles();
  const enOptions = await filterSelect.locator('option').allTextContents();
  expect(enOptions).toEqual([
    'All variants', 'Standard', 'Chess960', 'King of the Hill', 'Atomic',
    'Crazyhouse', 'Three-check', 'Horde', 'Racing Kings',
  ]);
  await expect(filterSelect).toHaveAccessibleName('Filter by variant');

  await localeSelect.focus();
  await localeSelect.selectOption('ar');
  await expect(localeSelect).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await page.evaluate(() => localStorage.getItem('rookzen_locale_v1'))).toBe('ar');

  expect(await page.evaluate(([a, b]) => a === b, [await filterSelect.elementHandle(), filterHandle])).toBe(true);
  expect(await page.evaluate(([curr, prev]) => curr.every((el, i) => el === prev[i]), [await filterSelect.locator('option').elementHandles(), optionHandles])).toBe(true);
  await expect(filterSelect).toHaveValue('atomic');
  await expect(page.locator('.seek-row')).toHaveCount(1);
  await expect(page.locator('.seek-row[data-seek-id="seek-atomic"]')).toBeVisible();
  const arOptions = await filterSelect.locator('option').allTextContents();
  expect(arOptions).toEqual([
    'جميع الأنواع', 'الشطرنج التقليدي', 'Chess960', 'ملك التل', 'الشطرنج الذري',
    'كريزي هاوس', 'الكش الثلاثي', 'الحشد', 'سباق الملوك',
  ]);
  await expect(filterSelect).toHaveAccessibleName('تصفية حسب النوع');

  await localeSelect.selectOption('en');
  await expect(localeSelect).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => localStorage.getItem('rookzen_locale_v1'))).toBe('en');

  expect(await page.evaluate(([a, b]) => a === b, [await filterSelect.elementHandle(), filterHandle])).toBe(true);
  expect(await page.evaluate(([curr, prev]) => curr.every((el, i) => el === prev[i]), [await filterSelect.locator('option').elementHandles(), optionHandles])).toBe(true);
  await expect(filterSelect).toHaveValue('atomic');
  await expect(page.locator('.seek-row')).toHaveCount(1);
  await expect(page.locator('.seek-row[data-seek-id="seek-atomic"]')).toBeVisible();
  expect(await filterSelect.locator('option').allTextContents()).toEqual(enOptions);
  await expect(filterSelect).toHaveAccessibleName('Filter by variant');
});
