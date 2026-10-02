import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enMessages } from '../src/i18n/catalog/en.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const indexHtml = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');

describe('i18n static HTML copy and accessibility parity guard', () => {
  it('covers 100% of static aria-label attributes with data-i18n-aria-label', () => {
    const ariaMatches = [...indexHtml.matchAll(/<([a-zA-Z0-9-]+)[^>]*\saria-label="([^"]*)"[^>]*>/g)];
    assert.ok(ariaMatches.length > 50, `Expected substantial aria-label inventory, found ${ariaMatches.length}`);

    const missing: string[] = [];
    for (const match of ariaMatches) {
      const fullTag = match[0];
      const label = match[2] ?? '';
      if (!fullTag.includes('data-i18n-aria-label')) {
        missing.push(label);
      }
    }

    assert.deepEqual(missing, [], 'Every static element with aria-label must have data-i18n-aria-label');
  });

  it('guarantees exact parity between static HTML aria-label fallback copy and canonical catalog', () => {
    const ariaMatches = [
      ...indexHtml.matchAll(/data-i18n-aria-label="([^"]+)"[^>]*aria-label="([^"]+)"|aria-label="([^"]+)"[^>]*data-i18n-aria-label="([^"]+)"/g),
    ];

    for (const match of ariaMatches) {
      const key = (match[1] || match[4]) as keyof typeof enMessages;
      const htmlValue = match[2] || match[3];
      const catalogValue = enMessages[key];

      assert.strictEqual(
        catalogValue,
        htmlValue,
        `Aria-label mismatch for key "${key}": HTML has "${htmlValue}" but catalog has "${catalogValue}"`,
      );
    }
  });

  it('guarantees exact parity between static HTML placeholder fallback copy and canonical catalog', () => {
    const phMatches = [
      ...indexHtml.matchAll(/data-i18n-placeholder="([^"]+)"[^>]*placeholder="([^"]+)"|placeholder="([^"]+)"[^>]*data-i18n-placeholder="([^"]+)"/g),
    ];

    for (const match of phMatches) {
      const key = (match[1] || match[4]) as keyof typeof enMessages;
      const htmlValue = match[2] || match[3];
      const catalogValue = enMessages[key];

      assert.strictEqual(
        catalogValue,
        htmlValue,
        `Placeholder mismatch for key "${key}": HTML has "${htmlValue}" but catalog has "${catalogValue}"`,
      );
    }
  });

  it('guarantees exact parity between static HTML text fallback copy and canonical catalog', () => {
    const textMatches = [
      ...indexHtml.matchAll(/<([a-zA-Z0-9-]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g),
    ];

    for (const match of textMatches) {
      const key = match[2] as keyof typeof enMessages;
      const htmlValue = (match[3] ?? '').trim();
      const catalogValue = enMessages[key];

      assert.strictEqual(
        catalogValue,
        htmlValue,
        `Text mismatch for key "${key}": HTML has "${htmlValue}" but catalog has "${catalogValue}"`,
      );
    }
  });

  it('preserves exact composer screen-reader label Message distinct from placeholder', () => {
    assert.strictEqual(enMessages['community.messages.composerLabel'], 'Message');
    assert.strictEqual(enMessages['community.messages.writeMessage'], 'Write a message…');
  });
});
