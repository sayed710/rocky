/**
 * The sign-in surface, measured in a real browser at the widths people actually use.
 *
 * `style-contract.test.ts` asserts the CSS says `auto-fit` and `minmax`; only a rendering engine
 * can say what that produces. These are the properties the layout exists to guarantee — equal
 * action widths, a deliberate stack instead of a ragged wrap, and nothing pushed off-screen — and
 * they are the ones that broke silently before, because every unit test stayed green while the
 * front door rendered three differently-sized buttons on two ragged rows.
 *
 * Static spec: `#auth` is the signed-out view of `/`, so this needs vite preview only.
 * Run with: npm run e2e
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * The two grids have different minimums — 12rem for the fields, 11rem for the actions — so they
 * reflow at different widths. 420px is in between, and it is there to prove they are independent:
 * a single shared breakpoint would have to pick one width and be wrong about the other.
 */
const VIEWPORTS = [
  { name: 'wide desktop', width: 1440, height: 900, pairsFields: true, pairsActions: true },
  { name: 'laptop', width: 1024, height: 768, pairsFields: true, pairsActions: true },
  { name: 'tablet', width: 768, height: 1024, pairsFields: true, pairsActions: true },
  { name: 'narrow', width: 420, height: 900, pairsFields: false, pairsActions: true },
  { name: 'mobile', width: 390, height: 844, pairsFields: false, pairsActions: false },
  { name: 'small mobile', width: 320, height: 640, pairsFields: false, pairsActions: false },
] as const;

const ACTIONS = ['#auth-submit', '#auth-register', '#auth-passkey'] as const;

/** The element's rendered bounds, failing loudly rather than returning null the caller would measure. */
async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no rendered bounds`);
  return box;
}

/** True when two boxes sit on the same visual row, tolerating sub-pixel layout. */
function sameRow(a: { y: number; height: number }, b: { y: number; height: number }): boolean {
  return Math.abs(a.y - b.y) < Math.min(a.height, b.height) / 2;
}

for (const viewport of VIEWPORTS) {
  test(`the sign-in form lays out without overflow at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.locator('#auth')).toBeVisible();

    // Nothing on the page may push the document wider than the window.
    expect(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({ documentWidth: viewport.width, viewportWidth: viewport.width });

    // The card itself stays inside the viewport, borders included.
    const card = await boxOf(page, '#auth');
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(viewport.width);

    // The two secondary actions come out the same width — the property `flex-wrap: wrap` could
    // not give them, because it sizes each button to its own label.
    const submit = await boxOf(page, '#auth-submit');
    const register = await boxOf(page, '#auth-register');
    const passkey = await boxOf(page, '#auth-passkey');
    expect(Math.abs(register.width - passkey.width)).toBeLessThan(1);

    // The default action takes the whole row, alone, with the other two beneath it.
    const actionRow = await boxOf(page, '#auth-form .auth-actions');
    expect(Math.abs(submit.width - actionRow.width)).toBeLessThan(1);
    expect(sameRow(submit, register)).toBe(false);
    expect(sameRow(register, passkey)).toBe(viewport.pairsActions);

    // No control is clipped: a wrapped label is fine, a cut-off one is not.
    for (const selector of [...ACTIONS, '#auth-handle', '#auth-password', '#auth-email']) {
      const overflow = await page.locator(selector).evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      expect(overflow, `${selector} is clipped at ${viewport.width}px`).toBeLessThanOrEqual(1);
    }

    // Fields pair where two 12rem tracks fit and stack where they do not.
    const handle = await boxOf(page, '.auth-field:has(#auth-handle)');
    const password = await boxOf(page, '.auth-field:has(#auth-password)');
    expect(sameRow(handle, password)).toBe(viewport.pairsFields);

    // The email always takes the whole row, never half of one. (The sign-in code row shares the
    // class but stays hidden until the server asks for a code, so it is not measured here.)
    const email = await boxOf(page, '.auth-field-full:has(#auth-email)');
    const form = await boxOf(page, '#auth-form');
    expect(sameRow(email, handle)).toBe(false);
    expect(Math.abs(email.width - form.width)).toBeLessThan(1);
  });
}

/**
 * The layout is written with grid line numbers and logical properties, never a physical edge, so
 * it mirrors rather than breaks when the document direction flips. The app ships `lang="en"` today
 * and has no locale switch; this pins the property now so an RTL locale does not arrive to find the
 * front door pinned to the left. `dir` is set before navigation so the first paint is RTL.
 */
test('the sign-in form mirrors under dir="rtl" without overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
  });
  await page.goto('/');
  await expect(page.locator('#auth')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  expect(await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))).toEqual({ documentWidth: 1440, viewportWidth: 1440 });

  // Mirrored, not merely unbroken: the first field in source order now starts on the right.
  const handle = await boxOf(page, '.auth-field:has(#auth-handle)');
  const password = await boxOf(page, '.auth-field:has(#auth-password)');
  expect(sameRow(handle, password)).toBe(true);
  expect(handle.x).toBeGreaterThan(password.x);

  const register = await boxOf(page, '#auth-register');
  const passkey = await boxOf(page, '#auth-passkey');
  expect(Math.abs(register.width - passkey.width)).toBeLessThan(1);
  expect(register.x).toBeGreaterThan(passkey.x);
});

/**
 * Layout must never be bought with accessibility. Every control stays reachable in source order,
 * shows a focus ring, and keeps its label — the failure mode of a two-column form is a tab order
 * that follows the visual grid instead of the DOM, or a label that got hidden to save a row.
 */
test('the two-column form keeps its labels, focus order and focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('#auth')).toBeVisible();

  for (const id of ['auth-handle', 'auth-password', 'auth-email']) {
    const label = page.locator(`label[for="${id}"]`);
    await expect(label).toBeVisible();
    await expect(label).not.toBeEmpty();
  }

  await page.locator('#auth-handle').focus();
  const order = ['auth-password', 'auth-email', 'auth-submit', 'auth-register', 'auth-passkey'];
  for (const id of order) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
  }

  // The focused control paints a visible outline rather than relying on the browser default.
  const outline = await page.locator('#auth-passkey').evaluate((el) => {
    (el as HTMLElement).focus();
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);
});

test('coarse pointers get usable auth and anchor-button targets with visible focus', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.locator('#auth')).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    expect(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({ documentWidth: 390, viewportWidth: 390 });

    for (const selector of ACTIONS) {
      expect((await boxOf(page, selector)).height, selector).toBeGreaterThanOrEqual(44);
    }
    expect((await boxOf(page, '#auth-forgot-password')).height).toBeGreaterThanOrEqual(44);

    const outline = await page.locator('#auth-forgot-password').evaluate((element) => {
      (element as HTMLElement).focus();
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline.style).not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);

    await page.locator('#study').evaluate((section) => {
      (section as HTMLElement).hidden = false;
      section.querySelector('#study-export-link')?.setAttribute('href', '/study.pgn');
    });
    const exportLink = page.locator('#study-export-link');
    await expect(exportLink).toBeVisible();
    expect((await boxOf(page, '#study-export-link')).height).toBeGreaterThanOrEqual(44);

    const exportOutline = await exportLink.evaluate((element) => {
      (element as HTMLElement).focus();
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(exportOutline.style).not.toBe('none');
    expect(Number.parseFloat(exportOutline.width)).toBeGreaterThanOrEqual(3);
  } finally {
    await context.close();
  }
});
