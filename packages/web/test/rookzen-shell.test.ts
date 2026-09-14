import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { applyRouteSurface } from '../src/app/route-surface.js';
import { parseRoute, routeToPath } from '../src/app/router.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_TEMPLATE = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(resolve(PACKAGE_ROOT, 'src/style.css'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'public/manifest.webmanifest'), 'utf8'));
const SERVICE_WORKER = readFileSync(resolve(PACKAGE_ROOT, 'public/sw.js'), 'utf8');
const PRODUCT = readFileSync(resolve(PACKAGE_ROOT, 'PRODUCT.md'), 'utf8');
const DESIGN = readFileSync(resolve(PACKAGE_ROOT, 'DESIGN.md'), 'utf8');

/** Converts a six-digit sRGB hex color to its WCAG relative luminance in the range 0–1. */
function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Calculates the WCAG contrast ratio between two six-digit sRGB hex colors. */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test('shell: brand identity is Rookzen in title, manifest, and topbar brand link', () => {
  assert.ok(HTML_TEMPLATE.includes('<title>Rookzen</title>'), 'title should be Rookzen');
  assert.equal(MANIFEST.name, 'Rookzen');
  assert.equal(MANIFEST.short_name, 'Rookzen');
  assert.match(MANIFEST.description, /chess platform/i);
  assert.match(HTML_TEMPLATE, /<h1[^>]*class="[^"]*brand[^"]*"[^>]*>[\s\S]*?Rookzen[\s\S]*?<\/h1>/);
});

test('shell: topbar brand includes an inline rook emblem SVG', () => {
  assert.match(HTML_TEMPLATE, /class="brand-link"[\s\S]*?<svg[\s\S]*?class="brand-rook"/);
});

test('shell: primary play entry is visible in topbar nav', () => {
  assert.ok(
    HTML_TEMPLATE.includes('href="/" data-route="lobby">Play</a>'),
    'navigation must have a visible Play entry link to lobby',
  );
});

test('shell: approved Burgundy & Stone design tokens are defined in dark-first :root', () => {
  // Palette C tokens
  assert.match(CSS, /--bg\s*:\s*#242224/i, 'Dark neutral #242224 must be the primary dark background');
  assert.match(CSS, /--fg\s*:\s*#E9E4DE/i, 'Stone light #E9E4DE must be the primary text color');
  assert.match(CSS, /--accent\s*:\s*#934A54/i, 'Burgundy #934A54 must be defined as brand action accent');
  assert.match(CSS, /--sel\s*:\s*#C6A0A2/i, 'Dusty rose #C6A0A2 must be the selection/focus ring token on dark');
  assert.match(CSS, /--muted\s*:\s*#A6A6A7/i, 'Silver gray #A6A6A7 must be secondary/muted text token');
  assert.match(CSS, /--dark\s*:\s*#91888B/i, 'Dark stone board square derivative #91888B');
  assert.match(CSS, /--light\s*:\s*#E9E4DE/i, 'Stone light board square #E9E4DE');
});

test('shell: light theme defines proper stone & deep burgundy derivatives', () => {
  assert.match(CSS, /--light-bg\s*:\s*#F5F1ED/i, 'Light stone background derivative #F5F1ED');
  assert.match(CSS, /--light-fg\s*:\s*#242224/i, 'Dark neutral text on light #242224');
  assert.match(CSS, /--sel-deep\s*:\s*#83414B/i, 'Deep burgundy #83414B for light surfaces');
  assert.match(CSS, /--light-accent\s*:\s*#83414B/i, 'Deep burgundy #83414B as light accent');
  assert.match(CSS, /--light-accent-hover\s*:\s*#72373F/i, 'Deep burgundy #72373F as light accent hover');
});

test('shell: primary hover state meets WCAG AA >= 4.5:1 contrast in dark and explicit light themes', () => {
  // Dark theme root
  const darkHoverMatch = CSS.match(/--accent-hover\s*:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(darkHoverMatch, 'must define --accent-hover token in :root');
  const darkHoverHex = darkHoverMatch[1] ?? '';
  const textHex = '#E9E4DE';
  const darkRatio = contrastRatio(textHex, darkHoverHex);
  assert.ok(
    darkRatio >= 4.5,
    `Dark primary hover contrast with text ${textHex} on background ${darkHoverHex} must be >= 4.5:1 (got ${darkRatio.toFixed(2)}:1)`,
  );
  const darkRestMatch = CSS.match(/--accent\s*:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(darkRestMatch, 'must define --accent token in :root');
  const darkRestHex = darkRestMatch[1] ?? '';
  assert.notEqual(darkHoverHex.toLowerCase(), darkRestHex.toLowerCase(), 'dark hover must be visually distinct from rest');

  // Light theme tokens and mappings
  const lightRestMatch = CSS.match(/--light-accent\s*:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(lightRestMatch, 'must define --light-accent token in :root');
  const lightRestHex = lightRestMatch[1] ?? '';

  const lightHoverMatch = CSS.match(/--light-accent-hover\s*:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(lightHoverMatch, 'must define --light-accent-hover token in :root');
  const lightHoverHex = lightHoverMatch[1] ?? '';

  const lightRatio = contrastRatio(textHex, lightHoverHex);
  assert.ok(
    lightRatio >= 4.5,
    `Light primary hover contrast with text ${textHex} on background ${lightHoverHex} must be >= 4.5:1 (got ${lightRatio.toFixed(2)}:1)`,
  );
  assert.notEqual(lightHoverHex.toLowerCase(), lightRestHex.toLowerCase(), 'light hover must be visually distinct from rest');

  assert.match(
    CSS,
    /:root\.light[\s\S]*?--accent-hover:\s*var\(--light-accent-hover\);/,
    ':root.light entry point must assign --accent-hover',
  );
});

test('shell: CSS default remains dark regardless of the operating-system preference', () => {
  assert.doesNotMatch(
    CSS,
    /@media\s*\(prefers-color-scheme:\s*light\)/,
    'dark-first CSS must not switch unclassified documents to light before bootstrap runs',
  );
});

test('shell: index.html has explicit favicon links to Rookzen icon assets', () => {
  assert.match(HTML_TEMPLATE, /<link[^>]+rel="icon"[^>]+href="\/icon\.svg"/i, 'must link /icon.svg as primary favicon');
  assert.match(HTML_TEMPLATE, /<link[^>]+rel="alternate icon"[^>]+href="\/icon-192\.png"/i, 'must link /icon-192.png as fallback favicon');
  assert.match(HTML_TEMPLATE, /<link[^>]+rel="apple-touch-icon"[^>]+href="\/icon-192\.png"/i, 'must link /icon-192.png as apple-touch-icon');
});

test('shell: manifest raster PNG icon assets are updated to Rookzen brand colors', () => {
  const icon192Path = resolve(PACKAGE_ROOT, 'public/icon-192.png');
  const icon512Path = resolve(PACKAGE_ROOT, 'public/icon-512.png');
  const icon192 = readFileSync(icon192Path);
  const icon512 = readFileSync(icon512Path);

  assert.equal(icon192.readUInt32BE(16), 192, 'icon-192.png width must be 192');
  assert.equal(icon192.readUInt32BE(20), 192, 'icon-192.png height must be 192');
  assert.equal(icon512.readUInt32BE(16), 512, 'icon-512.png width must be 512');
  assert.equal(icon512.readUInt32BE(20), 512, 'icon-512.png height must be 512');

  const decodePixel = (buf: Buffer, targetX: number, targetY: number): [number, number, number, number] => {
    const width = buf.readUInt32BE(16);
    let pos = 8;
    const idatParts: Buffer[] = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      if (type === 'IDAT') idatParts.push(buf.subarray(pos + 8, pos + 8 + len));
      pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idatParts));
    const bpp = 4;
    const rowStride = 1 + width * bpp;
    const prevRow = Buffer.alloc(width * bpp);
    const currRow = Buffer.alloc(width * bpp);
    for (let y = 0; y <= targetY; y++) {
      const filter = raw[y * rowStride];
      const line = raw.subarray(y * rowStride + 1, (y + 1) * rowStride);
      for (let x = 0; x < width * bpp; x++) {
        const a: number = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
        const b: number = prevRow[x] ?? 0;
        const c: number = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
        let val: number = line[x] ?? 0;
        if (filter === 1) val = (val + a) & 0xff;
        else if (filter === 2) val = (val + b) & 0xff;
        else if (filter === 3) val = (val + Math.floor((a + b) / 2)) & 0xff;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          val = (val + pr) & 0xff;
        }
        currRow[x] = val;
      }
      if (y === targetY) {
        const offset = targetX * bpp;
        return [
          currRow[offset] ?? 0,
          currRow[offset + 1] ?? 0,
          currRow[offset + 2] ?? 0,
          currRow[offset + 3] ?? 0,
        ];
      }
      currRow.copy(prevRow);
    }
    throw new Error(`Pixel (${targetX}, ${targetY}) out of bounds`);
  };

  const bg512 = decodePixel(icon512, 256, 40);
  const center512 = decodePixel(icon512, 256, 256);

  // Stale Gambit colors: #161512 [22, 21, 18] and #bababa [186, 186, 186]
  assert.notDeepEqual(bg512, [22, 21, 18, 255], 'icon-512 background must not be stale Gambit #161512');
  assert.notDeepEqual(center512, [186, 186, 186, 255], 'icon-512 center must not be stale Gambit pawn #bababa');

  // Rookzen brand colors: #242224 [36, 34, 36] and #E9E4DE [233, 228, 222]
  assert.deepEqual(bg512, [36, 34, 36, 255], 'icon-512 background must be Rookzen dark neutral #242224');
  assert.deepEqual(center512, [233, 228, 222, 255], 'icon-512 center must be Rookzen stone #E9E4DE');
});

test('shell: install icons do not claim maskable safe-area support they do not provide', () => {
  const icons = MANIFEST.icons as Array<{ purpose?: string }>;
  assert.ok(icons.length > 0);
  for (const icon of icons) assert.equal(icon.purpose, 'any');
});

test('shell: the Rookzen asset deployment invalidates the old PWA cache and precaches its icons', () => {
  const version = SERVICE_WORKER.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'service worker must define a cache version');
  assert.notEqual(version, 'gambit-v3', 'the pre-Rookzen cache must be invalidated');
  for (const asset of ['/icon.svg', '/icon-192.png', '/icon-512.png']) {
    assert.match(SERVICE_WORKER, new RegExp(`['\"]${asset.replace('.', '\\.') }['\"]`));
  }
});

test('shell: learn subnavigation connects Courses, Endgame Trainer, and Studies', () => {
  assert.match(HTML_TEMPLATE, /<section id="courses"[\s\S]*?<nav class="subnav"/, 'courses has learn subnav');
  assert.match(HTML_TEMPLATE, /<section id="endgames"[\s\S]*?<nav class="subnav"/, 'endgames has learn subnav');
  assert.match(HTML_TEMPLATE, /<section id="studies"[\s\S]*?<nav class="subnav"/, 'studies has learn subnav');
});

test('shell: 404 not-found route has dedicated surface with return affordance', () => {
  assert.ok(HTML_TEMPLATE.includes('id="not-found"'), 'index.html must have #not-found surface');
  assert.match(HTML_TEMPLATE, /id="not-found"[\s\S]*?Page not found/);
  assert.match(HTML_TEMPLATE, /id="not-found"[\s\S]*?href="\/" data-route="lobby"/);
});

test('shell: learn subnavigation links meet the coarse-pointer target floor', () => {
  assert.match(
    CSS,
    /@media\s*\(pointer:\s*coarse\)[\s\S]*?\.subnav-link[\s\S]*?min-height:\s*44px/,
  );
});

test('shell: not-found route activates #not-found surface and hides game controls', () => {
  const elements = new Map<string, { hidden: boolean }>();
  const ids = ['lobby', 'game-main', 'not-found', 'courses', 'endgames', 'studies', 'flip', 'skip-board'];
  for (const id of ids) elements.set(id, { hidden: false });
  const bodyClasses = new Set<string>();

  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    body: {
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) bodyClasses.add(name);
          else bodyClasses.delete(name);
          return force;
        },
      },
    },
  } as unknown as Document;

  applyRouteSurface(doc, { name: 'not-found' });
  assert.equal(elements.get('not-found')?.hidden, false, '#not-found surface should be visible');
  assert.equal(elements.get('lobby')?.hidden, true, '#lobby should be hidden');
  assert.equal(elements.get('game-main')?.hidden, true, '#game-main should be hidden');
  assert.equal(elements.get('flip')?.hidden, true, 'flip button should be hidden');
});

test('shell: font-family includes Source Sans 3 candidate with safe fallbacks', () => {
  assert.match(CSS, /font-family\s*:[^;]*'Source Sans 3'/);
});

test('shell: authoritative web product and design contracts describe Rookzen Palette C', () => {
  assert.match(PRODUCT, /Rookzen/);
  assert.doesNotMatch(PRODUCT, /Gambit exists/);
  assert.match(DESIGN, /name:\s*Rookzen/);
  assert.match(DESIGN, /#934A54/i);
  assert.doesNotMatch(DESIGN, /Grandmaster Teal|#20b2aa/i);
});
