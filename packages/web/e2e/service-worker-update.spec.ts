/** Real Cache Storage deployment acceptance, serving the production build on an isolated origin. */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('deployment refreshes mutable runtime assets while preserving immutable and offline assets', async ({ browser }) => {
  let revision = 'A';
  let workerRevision = 'A';
  let missingAssets = false;
  const requests = new Map<string, number>();
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const html = await readFile(`${dist}index.html`, 'utf8');
  const hashed = html.match(/\/assets\/index-[A-Za-z0-9_-]{8}\.js/)![0];
  const mutable = ['/locale-init.js', '/piece/cburnett/wK.svg'];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path.startsWith('/v1/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ revision }));
      return;
    }
    try {
      // Production Nginx location / falls back to index.html, including a missing public file.
      if (missingAssets && mutable.includes(path)) {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(html);
        return;
      }
      const file = path === '/' || !path.includes('.') ? '/index.html' : path;
      let bytes = await readFile(`${dist}${file.slice(1)}`);
      const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', file.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      // Change actual reachable public files at their existing URLs, without altering their behavior.
      if (mutable.includes(file) || file === '/icon.svg') {
        bytes = Buffer.concat([bytes, Buffer.from(file.endsWith('.js') ? `\n/* build ${revision} */` : `\n<!-- build ${revision} -->`)]);
      }
      // A worker-byte deployment change forces real install/activate, retaining its cache name/policy.
      if (file === '/sw.js') bytes = Buffer.concat([bytes, Buffer.from(`\n/* deployment ${workerRevision} */`)]);
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    });
    const fetchText = (path: string) => page.evaluate(async (url) => (await fetch(url)).text(), path);
    for (const path of mutable) expect(await fetchText(path)).toContain('build A');
    const immutableA = await fetchText(hashed);
    expect(await fetchText('/v1/update-proof')).toContain('A');
    await expect.poll(() => page.evaluate(async (paths) => {
      return Promise.all(paths.map(async (path) => !!(await caches.match(path))));
    }, [...mutable, hashed])).toEqual([true, true, true]);
    revision = 'B';
    workerRevision = 'B';
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const changed = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      await registration!.update();
      await changed;
    });
    // App-shell refresh is a separate control: it succeeds even against the original broken worker.
    expect(await fetchText('/icon.svg')).toContain('build B');
    await page.reload();
    for (const path of mutable) {
      // Soft assertions let the RED run expose both stale locale bootstrap and piece bytes.
      expect.soft(await fetchText(path)).toContain('build B');
    }
    const immutableRequests = requests.get(hashed);
    expect(await fetchText(hashed)).toBe(immutableA);
    expect(requests.get(hashed)).toBe(immutableRequests);
    expect(await fetchText('/v1/update-proof')).toContain('B');
    expect(await page.evaluate(async () => !!(await caches.match('/v1/update-proof')))).toBe(false);
    // Normal asset-only deployment: worker bytes/name do not change, so no install refresh occurs.
    revision = 'C';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await page.reload();
    for (const path of [...mutable, '/icon.svg']) expect(await fetchText(path)).toContain('build C');
    missingAssets = true;
    for (const path of mutable) expect.soft(await fetchText(path)).toContain('build C');
    // Successful SPA fallback HTML must neither reach an asset consumer nor poison its cache.
    for (const path of mutable) {
      expect.soft(await page.evaluate(async (url) => (await caches.match(url))!.text(), path)).toContain('build C');
    }
    await context.setOffline(true);
    for (const path of mutable) expect(await fetchText(path)).toContain('build C');
    expect(await fetchText(hashed)).toBe(immutableA);
    await page.goto(`http://127.0.0.1:${address.port}/about`);
    await expect(page.locator('h1')).toContainText('Rookzen');
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
