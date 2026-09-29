/**
 * RTL Layout Reliability & Internationalization Regression Suite.
 *
 * Verifies that forcing document direction to RTL (`dir="rtl"`):
 * 1. Produces ZERO horizontal document overflow (document.scrollWidth <= window.innerWidth).
 * 2. Does not cause off-canvas blank views or positioning shifts outside the viewport.
 * 3. Keeps the accessible skip-link within viewport bounds at inline-start when focused,
 *    without off-screen coordinate overflow when unfocused.
 * 4. Strictly decouples chessboard orientation and algebraic coordinates from document direction,
 *    preserving standard chess geometry and navigation in both LTR and RTL.
 * 5. Maintains layout containment, visibility, and control reachability across all 4 key viewports:
 *    Desktop (1440px, 1024px) and Mobile (390px, 320px).
 */
import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440 desktop', width: 1440, height: 900 },
  { name: '1024 laptop', width: 1024, height: 768 },
  { name: '390 mobile', width: 390, height: 844 },
  { name: '320 small mobile', width: 320, height: 640 },
] as const;

const ROUTES = [
  { path: '/', name: 'lobby' },
  { path: '/game/test-rtl-game', name: 'game' },
  { path: '/profile', name: 'profile' },
  { path: '/messages', name: 'messages' },
  { path: '/leaderboard', name: 'leaderboard' },
  { path: '/search', name: 'search' },
] as const;

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no rendered bounds`);
  return box;
}

test.describe('RTL Layout Reliability — Document Overflow & Structural Containment', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no horizontal overflow under dir="rtl" for ${route.name} at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript(() => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.setAttribute('dir', 'rtl');
          });
        });
        await page.goto(route.path);
        await page.waitForLoadState('domcontentloaded');

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
        await page.goto('/game/test-rtl-game');
        await page.waitForLoadState('domcontentloaded');

        // Unfocused skip link must NOT cause horizontal overflow
        const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(docWidth).toBeLessThanOrEqual(viewport.width);

        const skipLink = page.locator('#skip-board');
        await expect(skipLink).toBeAttached();

        // Focus skip link
        await skipLink.focus();
        await expect(skipLink).toBeVisible();

        const box = await boxOf(page, '#skip-board');
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);

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
          };
        });
        expect(styles.bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(styles.color).not.toBe('rgba(0, 0, 0, 0)');
        expect(Number.parseInt(styles.zIndex, 10)).toBeGreaterThanOrEqual(30);
      });
    }
  }
});

test.describe('RTL Layout Reliability — Chessboard Geometry & Orientation Invariance', () => {
  for (const dir of ['ltr', 'rtl'] as const) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      test(`board orientation is decoupled from document direction (${dir} @ ${viewport.name})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript((direction) => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.setAttribute('dir', direction);
          });
        }, dir);
        await page.goto('/game/test-rtl-game');
        await page.waitForLoadState('domcontentloaded');

        const board = page.locator('#board');
        await expect(board).toBeVisible();

        // White perspective default:
        // Square a8 is file 0, rank 7 (top-left)
        // Square h8 is file 7, rank 7 (top-right)
        // Square a1 is file 0, rank 0 (bottom-left)
        // Square h1 is file 7, rank 0 (bottom-right)
        const sqA8 = await boxOf(page, '.cb-sq[data-square="a8"]');
        const sqH8 = await boxOf(page, '.cb-sq[data-square="h8"]');
        const sqA1 = await boxOf(page, '.cb-sq[data-square="a1"]');
        const sqH1 = await boxOf(page, '.cb-sq[data-square="h1"]');

        // File 'a' MUST be to the left of File 'h' in both LTR and RTL
        expect(sqA8.x, `a8 must be to the left of h8 under ${dir}`).toBeLessThan(sqH8.x);
        expect(sqA1.x, `a1 must be to the left of h1 under ${dir}`).toBeLessThan(sqH1.x);

        // Rank 8 must be above Rank 1
        expect(sqA8.y).toBeLessThan(sqA1.y);
        expect(sqH8.y).toBeLessThan(sqH1.y);

        // Bottom-right square (h1) must be light square
        const h1Classes = await page.locator('.cb-sq[data-square="h1"]').getAttribute('class');
        expect(h1Classes).toContain('cb-light');

        // Bottom-left square (a1) must be dark square
        const a1Classes = await page.locator('.cb-sq[data-square="a1"]').getAttribute('class');
        expect(a1Classes).toContain('cb-dark');

        // The board itself must be completely contained within the viewport
        const boardBox = await boxOf(page, '#board');
        expect(boardBox.x).toBeGreaterThanOrEqual(0);
        expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(viewport.width + 1);
      });
    }
  }
});
