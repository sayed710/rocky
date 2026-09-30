/**
 * RTL Layout Reliability & Internationalization Regression Suite (Static/Offline).
 *
 * Verifies that forcing document direction to RTL (`dir="rtl"`):
 * 1. Produces ZERO horizontal document overflow (document.scrollWidth <= window.innerWidth)
 *    across all key routes when asynchronously fetched route content has settled.
 * 2. Does not cause off-canvas blank views or positioning shifts outside the viewport.
 * 3. Keeps the accessible skip-link within viewport bounds at inline-start when focused,
 *    without off-screen coordinate overflow when unfocused.
 * 4. Strictly decouples chessboard orientation and algebraic coordinates from document direction,
 *    preserving standard chess geometry in both LTR and RTL.
 * 5. Maintains layout containment, visibility, and control reachability across all 4 key viewports:
 *    Desktop (1440px, 1024px) and Mobile (390px, 320px).
 *
 * Note: Authoritative active-game synchronized board layout and White/Black perspectives
 * are exercised with the backend test harness in `game-responsive.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440 desktop', width: 1440, height: 900 },
  { name: '1024 laptop', width: 1024, height: 768 },
  { name: '390 mobile', width: 390, height: 844 },
  { name: '320 small mobile', width: 320, height: 640 },
] as const;

interface RouteFixture {
  name: string;
  path: string;
  setup?: (page: Page) => Promise<void>;
  readySelector: string;
  surfaceSelector: string;
}

const ROUTES: readonly RouteFixture[] = [
  {
    name: 'lobby',
    path: '/',
    setup: async (page: Page) => {
      await page.route('**/v1/seeks', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });
    },
    readySelector: '#create-game',
    surfaceSelector: '#lobby',
  },
  {
    name: 'leaderboard',
    path: '/leaderboard',
    setup: async (page: Page) => {
      await page.route('**/v1/leaderboard/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { userId: 'u1', variant: 'standard', rating: 1600, rd: 45 },
            { userId: 'u2', variant: 'standard', rating: 1550, rd: 50 },
            { userId: 'u3', variant: 'standard', rating: 1500, rd: 55 },
          ]),
        });
      });
    },
    readySelector: '#leaderboard-results .panel-row',
    surfaceSelector: '#leaderboard',
  },
  {
    name: 'search',
    path: '/search?q=chess',
    setup: async (page: Page) => {
      await page.route('**/v1/search**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            total: 2,
            results: [
              {
                id: '1',
                score: 1,
                display: { type: 'player', title: 'Grandmaster Alice', subtitle: 'Rating 2400' },
              },
              {
                id: '2',
                score: 1,
                display: { type: 'tournament', title: 'Grandmaster Openings', subtitle: 'Study by Bob' },
              },
            ],
          }),
        });
      });
    },
    readySelector: '#search-results .panel-row',
    surfaceSelector: '#search',
  },
  {
    name: 'password-reset',
    path: '/password-reset',
    readySelector: '#password-reset-request-form',
    surfaceSelector: '#password-reset',
  },
  {
    name: 'email-verify',
    path: '/email-verify',
    readySelector: '#email-verify-back-link',
    surfaceSelector: '#email-verify',
  },
  {
    name: 'offline-board',
    path: '/game/test-offline-board',
    readySelector: '.cb-board',
    surfaceSelector: '#game-main',
  },
] as const;

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no rendered bounds`);
  return box;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        capabilities: {
          learning: true,
          studies: true,
          achievements: true,
          search: true,
          semanticSearch: false,
          social: true,
          messaging: true,
          community: true,
        },
      }),
    });
  });
  await page.route('**/v1/graphql', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });
});

test.describe('RTL Layout Reliability — Settled Route Containment', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no horizontal overflow under dir="rtl" for ${route.name} at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        if (route.setup) {
          await route.setup(page);
        }
        await page.addInitScript(() => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.setAttribute('dir', 'rtl');
          });
        });
        await page.goto(route.path);

        // Wait for route-specific content/surface to settle asynchronously
        const readyEl = page.locator(route.readySelector).first();
        await expect(readyEl).toBeVisible();

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          scrollLeft: document.documentElement.scrollLeft,
        }));

        expect(metrics.scrollWidth, `Route ${route.name} overflows document width at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width);
        expect(metrics.scrollLeft).toBe(0);

        // Header / topbar must remain contained within viewport bounds
        const topbar = await boxOf(page, '.topbar');
        expect(topbar.x).toBeGreaterThanOrEqual(0);
        expect(topbar.x + topbar.width).toBeLessThanOrEqual(viewport.width + 1);

        // App main landmark must remain visible and contained within viewport
        const main = await boxOf(page, '#app-main');
        expect(main.x).toBeGreaterThanOrEqual(0);
        expect(main.x + main.width).toBeLessThanOrEqual(viewport.width + 1);

        // Route-specific surface container must be visible and contained
        const surface = await boxOf(page, route.surfaceSelector);
        expect(surface.x).toBeGreaterThanOrEqual(0);
        expect(surface.x + surface.width).toBeLessThanOrEqual(viewport.width + 1);
      });
    }
  }
});

test.describe('RTL Layout Reliability — Accessible Skip Link', () => {
  for (const dir of ['ltr', 'rtl'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`skip-link does not cause overflow unfocused and aligns at inline-start when focused (${dir} @ ${viewport.name})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript((direction) => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.setAttribute('dir', direction);
          });
        }, dir);
        await page.goto('/game/test-offline-board');
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.locator('.cb-board')).toBeVisible();

        // Unfocused skip link must NOT cause horizontal overflow
        const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(docWidth).toBeLessThanOrEqual(viewport.width);

        const skipLink = page.locator('#skip-board');
        await expect(skipLink).toBeAttached();
        await expect(skipLink).not.toHaveAttribute('hidden');
        await expect(skipLink).not.toBeFocused();
        const hiddenStyles = await skipLink.evaluate((el) => {
          const s = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            clip: s.clip,
            overflow: s.overflow,
            width: box.width,
            height: box.height,
          };
        });
        expect(hiddenStyles).toEqual({
          clip: 'rect(0px, 0px, 0px, 0px)',
          overflow: 'hidden',
          width: 1,
          height: 1,
        });

        // The link is the first keyboard stop after the game route has mounted.
        await page.keyboard.press('Tab');
        await expect(skipLink).toBeFocused();
        await expect(skipLink).toBeVisible();

        const box = await boxOf(page, '#skip-board');
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeLessThanOrEqual(20);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.width).toBeGreaterThan(20);
        expect(box.height).toBeGreaterThan(20);

        if (dir === 'ltr') {
          // In LTR, inline start is on the left
          expect(box.x).toBeLessThanOrEqual(20);
        } else {
          // In RTL, inline start is on the right
          expect(box.x + box.width).toBeGreaterThanOrEqual(viewport.width - 20);
        }

        // Must have visible background and readable text
        const styles = await skipLink.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            bg: s.backgroundColor,
            color: s.color,
            zIndex: s.zIndex,
            clip: s.clip,
            clipPath: s.clipPath,
            overflow: s.overflow,
          };
        });
        expect(styles.clip, 'Focused skip link must remove the zero-area clip').toBe('auto');
        expect(styles.clipPath).toBe('none');
        expect(styles.overflow).toBe('visible');
        expect(styles.bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(styles.color).not.toBe('rgba(0, 0, 0, 0)');
        expect(Number.parseInt(styles.zIndex, 10)).toBeGreaterThanOrEqual(30);
        expect(await skipLink.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ));
        }), 'Focused skip link must be exposed to hit testing').toBe(true);

        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/#board$/);
        // Native fragment navigation establishes the sequential focus starting point;
        // the non-focusable board container need not become document.activeElement.
        await page.keyboard.press('Tab');
        await expect(page.locator('#board .cb-sq[tabindex="0"]')).toBeFocused();
        await expect(page.locator('#board .cb-sq[tabindex="0"]')).toHaveAttribute('data-square', 'a8');
      });
    }
  }
});

test.describe('RTL Layout Reliability — Static/Offline Board Starting Geometry & Flip Invariance', () => {
  for (const dir of ['ltr', 'rtl'] as const) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      test(`static board starting position and flip orientation are invariant to document direction (${dir} @ ${viewport.name})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript((direction) => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.setAttribute('dir', direction);
          });
        }, dir);
        await page.goto('/game/test-offline-board');
        await expect(page.locator('.cb-board')).toBeVisible();

        // 1. Initial White perspective default
        const sqA8 = await boxOf(page, '.cb-sq[data-square="a8"]');
        const sqH8 = await boxOf(page, '.cb-sq[data-square="h8"]');
        const sqA1 = await boxOf(page, '.cb-sq[data-square="a1"]');
        const sqH1 = await boxOf(page, '.cb-sq[data-square="h1"]');

        // File 'a' MUST be to the left of File 'h' in both LTR and RTL
        expect(sqA8.x, `a8 must be to the left of h8 under ${dir}`).toBeLessThan(sqH8.x);
        expect(sqA1.x, `a1 must be to the left of h1 under ${dir}`).toBeLessThan(sqH1.x);

        // Rank 8 must be above Rank 1
        expect(sqA8.y, `a8 must be above a1 under ${dir}`).toBeLessThan(sqA1.y);
        expect(sqH8.y, `h8 must be above h1 under ${dir}`).toBeLessThan(sqH1.y);

        // Bottom-right square (h1) must be light square
        const h1Classes = await page.locator('.cb-sq[data-square="h1"]').getAttribute('class');
        expect(h1Classes).toContain('cb-light');

        // Bottom-left square (a1) must be dark square
        const a1Classes = await page.locator('.cb-sq[data-square="a1"]').getAttribute('class');
        expect(a1Classes).toContain('cb-dark');

        // 2. Click #flip button: orientation becomes Black perspective
        const flipBtn = page.locator('#flip');
        await expect(flipBtn).toBeVisible();
        await flipBtn.click();

        const sqA8Flipped = await boxOf(page, '.cb-sq[data-square="a8"]');
        const sqH8Flipped = await boxOf(page, '.cb-sq[data-square="h8"]');
        const sqA1Flipped = await boxOf(page, '.cb-sq[data-square="a1"]');
        const sqH1Flipped = await boxOf(page, '.cb-sq[data-square="h1"]');

        // When flipped to Black: file 'h' must be left of file 'a'
        expect(sqH8Flipped.x, `h8 must be to the left of a8 when flipped to Black under ${dir}`).toBeLessThan(sqA8Flipped.x);
        expect(sqH1Flipped.x, `h1 must be to the left of a1 when flipped to Black under ${dir}`).toBeLessThan(sqA1Flipped.x);

        // When flipped to Black: rank 1 must be above rank 8
        expect(sqA1Flipped.y, `a1 must be above a8 when flipped to Black under ${dir}`).toBeLessThan(sqA8Flipped.y);
        expect(sqH1Flipped.y, `h1 must be above h8 when flipped to Black under ${dir}`).toBeLessThan(sqH8Flipped.y);

        // 3. Click #flip again: returns to White perspective
        await flipBtn.click();
        const sqA1Restored = await boxOf(page, '.cb-sq[data-square="a1"]');
        const sqH1Restored = await boxOf(page, '.cb-sq[data-square="h1"]');
        expect(sqA1Restored.x, `a1 must be left of h1 after flipping back to White under ${dir}`).toBeLessThan(sqH1Restored.x);
        expect(sqA1Restored.y, `a1 must be below a8 after flipping back to White under ${dir}`).toBeGreaterThan(sqA8.y);

        // The board itself must be completely contained within the viewport
        const boardBox = await boxOf(page, '#board');
        expect(boardBox.x).toBeGreaterThanOrEqual(0);
        expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(viewport.width + 1);
      });
    }
  }
});
