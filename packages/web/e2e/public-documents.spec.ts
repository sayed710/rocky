/**
 * Public document routes: /privacy, /terms, /fair-play and /about (ADR-0153).
 *
 * Static spec: runs against `vite preview` with no backend. Covers what only a browser can show —
 * direct deep links, SPA navigation through the real click handler, back/forward, focus placement,
 * keyboard order, the offline shell, and real right-to-left layout under an Arabic test catalog.
 *
 * Run with: npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import type {} from '../test/support/public-document-browser.js';

const DOCUMENTS = [
  { path: '/privacy', title: 'Privacy', pending: /authoritative Rookzen privacy policy has not been published yet/ },
  { path: '/terms', title: 'Terms', pending: /authoritative Rookzen terms have not been published yet/ },
  { path: '/fair-play', title: 'Fair Play', pending: /authoritative Rookzen fair play policy has not been published yet/ },
  { path: '/about', title: 'About Rookzen', pending: null },
] as const;

const REPOSITORY_URL = 'https://github.com/sayed710/rocky';
const SHA = '5d0a20e1a2a6d3f36645ae14cc0d631824b86b93';

test.beforeEach(async ({ page }) => {
  // The shell asks for capabilities on every route; answer so no request is left hanging.
  await page.route('**/v1/capabilities', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ capabilities: {} }) }),
  );
});

/** Follow an in-app link the way a visitor would, through the SPA click handler in main.ts. */
async function followInAppLink(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    const link = document.createElement('a');
    link.href = target;
    link.dataset['route'] = 'test';
    link.id = 'test-in-app-link';
    link.textContent = 'test link';
    document.body.prepend(link);
  }, href);
  await page.locator('#test-in-app-link').focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => document.getElementById('test-in-app-link')?.remove());
}

for (const doc of DOCUMENTS) {
  test(`direct load of ${doc.path} renders its article without an account`, async ({ page }) => {
    await page.goto(doc.path);
    const article = page.getByRole('article', { name: doc.title });
    await expect(article).toBeVisible();
    await expect(article.getByRole('heading', { level: 2, name: doc.title })).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1); // the topbar brand stays the page's only <h1>
    await expect(article.locator('h2')).toHaveCount(1);
    await expect(page).toHaveTitle(`${doc.title} · Rookzen`);
    await expect(page.locator('#not-found')).toBeHidden();
    await expect(page.locator('#auth')).toBeHidden();
    await expect(page.locator('#lobby')).toBeHidden();
    if (doc.pending) {
      await expect(article.getByRole('heading', { level: 3, name: 'Publication status' })).toBeVisible();
      await expect(article).toContainText(doc.pending);
      await expect(article).toContainText('This page is not the final published');
      await expect(article.locator('a')).toHaveCount(0);
    }
    // A direct load leaves focus where the browser put it.
    await expect(article.getByRole('heading', { level: 2 })).not.toBeFocused();
  });
}

test('extra segments and near-miss spellings still reach the existing 404 surface', async ({ page }) => {
  for (const path of ['/privacy/extra', '/About', '/fair_play', '/legal']) {
    await page.goto(path);
    await expect(page.locator('#not-found'), path).toBeVisible();
    await expect(page.locator('#public-document'), path).toBeHidden();
  }
});

test('/about separates the repository link from the build revision', async ({ page }) => {
  await page.goto('/about');
  const article = page.getByRole('article', { name: 'About Rookzen' });
  await expect(article).toContainText('AGPL-3.0-or-later');

  const repository = article.getByRole('link', { name: REPOSITORY_URL });
  await expect(repository).toHaveAttribute('href', REPOSITORY_URL);
  await expect(repository).not.toHaveAttribute('target', /.+/);
  await expect(repository).toHaveAttribute('rel', /noreferrer/);
  await expect(repository).toHaveCSS('direction', 'ltr');
  await expect(repository).toHaveCSS('text-decoration-line', 'underline');

  await expect(article.locator('dt')).toHaveText(['Source repository', 'Build revision']);
  const revisionLink = article.locator('a[data-source-link="revision"]');
  if (await revisionLink.count() === 0) {
    // The preview build was made without VITE_GIT_SHA: say so, and claim nothing.
    await expect(article).toContainText('This build does not record its source revision.');
    await expect(article.locator('code')).toHaveCount(0);
  } else {
    const sha = (await revisionLink.locator('code').textContent()) ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
    await expect(revisionLink).toHaveAttribute('href', `${REPOSITORY_URL}/commit/${sha}`);
  }
});

test('in-app navigation moves focus to the title without reloading the page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#lobby')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { spaMarker: boolean }).spaMarker = true; });

  await followInAppLink(page, '/about');

  await expect(page).toHaveURL(/\/about$/);
  const title = page.getByRole('heading', { level: 2, name: 'About Rookzen' });
  await expect(title).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { spaMarker?: boolean }).spaMarker)).toBe(true);
  await expect(page.locator('#lobby')).toBeHidden();

  // Tab from the title reaches the source link next: reading order and focus order agree.
  await page.keyboard.press('Tab');
  const repository = page.getByRole('link', { name: REPOSITORY_URL });
  await expect(repository).toBeFocused();
  const outline = await repository.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('back and forward move between a public document and the previous route', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#lobby')).toBeVisible();
  await followInAppLink(page, '/privacy');
  await expect(page.getByRole('article', { name: 'Privacy' })).toBeVisible();
  await followInAppLink(page, '/terms');
  await expect(page.getByRole('article', { name: 'Terms' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('article', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Privacy' })).toBeFocused();
  await expect(page).toHaveTitle('Privacy · Rookzen');

  await page.goBack();
  await expect(page.locator('#lobby')).toBeVisible();
  await expect(page.locator('#public-document')).toBeHidden();
  await expect(page.locator('#public-document article')).toHaveCount(0);
  await expect(page).toHaveTitle('Rookzen'); // the document title does not leak to other routes

  await page.goForward();
  await expect(page.getByRole('article', { name: 'Privacy' })).toBeVisible();
});

test('a public document reloads from the offline shell once the service worker controls the page', async ({ page, context }) => {
  await page.goto('/about');
  await expect(page.getByRole('article', { name: 'About Rookzen' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
  });
  // Visit once more online so the hashed bundle is in the runtime cache.
  await page.reload();
  await expect(page.getByRole('article', { name: 'About Rookzen' })).toBeVisible();

  await context.setOffline(true);
  try {
    await page.goto('/fair-play');
    await expect(page.getByRole('article', { name: 'Fair Play' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test.describe('right-to-left', () => {
  let bundle: string;
  test.beforeAll(async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        lib: {
          entry: fileURLToPath(new URL('../test/support/public-document-browser.ts', import.meta.url)),
          name: 'publicDocumentBrowser',
          formats: ['iife'],
        },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !('output' in output)) throw new Error('Missing browser test bundle');
    const chunk = output.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser test chunk');
    bundle = chunk.code;
  });

  async function mountArabic(page: Page, width: number, revision: string | null): Promise<void> {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
    await page.addStyleTag({ path: fileURLToPath(new URL('../src/style.css', import.meta.url)) });
    await page.addScriptTag({ content: bundle });
    await page.evaluate((sha) => window.publicDocumentBrowser.harness.mount('about', sha, 'ar'), revision);
  }

  for (const width of [1024, 390, 320]) {
    test(`Arabic /about mirrors its prose and keeps technical tokens LTR at ${width}px`, async ({ page }) => {
      await mountArabic(page, width, SHA);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar');

      const title = page.getByRole('heading', { level: 2, name: 'حول روك زن' });
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS('direction', 'rtl');

      const repository = page.locator('a[data-source-link="repository"]');
      const sha = page.locator('code');
      await expect(repository).toHaveCSS('direction', 'ltr');
      await expect(repository).toHaveCSS('unicode-bidi', 'isolate');
      await expect(sha).toHaveCSS('direction', 'ltr');
      await expect(sha).toHaveText(SHA);

      // The prose starts at the inline-start (right) edge; the label column sits right of its value.
      const article = await page.locator('article').boundingBox();
      const heading = await title.boundingBox();
      const label = await page.locator('dt').first().boundingBox();
      const value = await page.locator('dd').first().boundingBox();
      if (!article || !heading || !label || !value) throw new Error('missing layout boxes');
      expect(Math.abs((heading.x + heading.width) - (article.x + article.width))).toBeLessThanOrEqual(2);
      if (width > 480) expect(label.x).toBeGreaterThan(value.x);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'long URL and SHA must wrap, not widen the page').toBeLessThanOrEqual(0);

      // Focus order follows the document: title → repository link → commit link.
      await page.keyboard.press('Tab');
      await expect(repository).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('a[data-source-link="revision"]')).toBeFocused();
    });
  }

  test('switching to Arabic relocalizes in place and keeps focus on the title', async ({ page }) => {
    await page.setContent('<!doctype html><html lang="en"><body></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => window.publicDocumentBrowser.harness.mount('privacy', null, 'en'));
    const title = page.locator('h2');
    await expect(title).toHaveText('Privacy');
    await expect(title).toBeFocused();
    await page.evaluate(() => window.publicDocumentBrowser.harness.current!.setLocale('ar'));
    await expect(title).toHaveText('الخصوصية');
    await expect(title).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await page.title()).toBe('الخصوصية · روك زن');
  });
});
