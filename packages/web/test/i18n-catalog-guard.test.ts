import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enMessages, isMessageKey } from '../src/i18n/catalog/index.js';
import type { MessageKey } from '../src/i18n/catalog/index.js';
import { interpolate } from '../src/i18n/interpolate.js';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  LOCALE_METADATA,
  resolveLocale,
  getLocaleDirection,
  isRtl,
} from '../src/i18n/metadata.js';
import { isChessNotation, createLtrElement, wrapLtrHtml, applyLtrIsolation } from '../src/i18n/bidi.js';

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function createFakeElement(tagName: string): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    attributes: {},
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
  };
}

test('i18n catalog guard: every message key has non-empty string content', () => {
  const keys = Object.keys(enMessages) as MessageKey[];
  assert.ok(keys.length >= 100, `expected at least 100 catalog keys, found ${keys.length}`);

  for (const key of keys) {
    const message = enMessages[key];
    assert.equal(typeof message, 'string', `key "${key}" must be a string`);
    assert.ok(message.trim().length > 0, `key "${key}" must not be empty or whitespace-only`);
    // Ensure key follows dot notation namespace pattern
    assert.match(key, /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/, `key "${key}" must follow valid namespacing`);
  }
});

test('i18n catalog guard: isMessageKey correctly distinguishes valid keys from invalid strings', () => {
  assert.equal(isMessageKey('shell.title'), true);
  assert.equal(isMessageKey('nav.play'), true);
  assert.equal(isMessageKey('game.actions.offerDraw'), true);

  assert.equal(isMessageKey(''), false);
  assert.equal(isMessageKey('unknown.key'), false);
  assert.equal(isMessageKey('shell.nonexistent'), false);
  assert.equal(isMessageKey('toString'), false);
  assert.equal(isMessageKey('__proto__'), false);
});

test('i18n catalog guard: parameterized messages interpolate correctly and safely', () => {
  const keys = Object.keys(enMessages) as MessageKey[];
  const placeholderRegex = /\{([a-zA-Z0-9_]+)\}/g;

  for (const key of keys) {
    const raw = enMessages[key];
    const matches = [...raw.matchAll(placeholderRegex)];
    if (matches.length > 0) {
      const mockParams: Record<string, string | number> = {};
      for (const match of matches) {
        const paramName = match[1]!;
        mockParams[paramName] = 'TEST_VAL';
      }
      const result = interpolate(raw, mockParams);
      assert.ok(!result.includes('{'), `key "${key}" still contains unreplaced placeholder in: ${result}`);
      assert.ok(result.includes('TEST_VAL'), `key "${key}" did not include interpolated value`);
    }
  }
});

test('i18n catalog guard: supported locales integrity and fallback guarantees', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'ar']);

  for (const locale of SUPPORTED_LOCALES) {
    const meta = LOCALE_METADATA[locale];
    assert.ok(meta, `metadata must exist for supported locale "${locale}"`);
    assert.equal(meta.code, locale);
    assert.ok(meta.name.length > 0);
    assert.ok(meta.nativeName.length > 0);
    assert.ok(meta.dir === 'ltr' || meta.dir === 'rtl');
  }

  // RTL metadata check
  assert.equal(getLocaleDirection('en'), 'ltr');
  assert.equal(getLocaleDirection('ar'), 'rtl');
  assert.equal(isRtl('en'), false);
  assert.equal(isRtl('ar'), true);

  // Resolution fallbacks
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('EN'), 'en');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('en_GB'), 'en');
  assert.equal(resolveLocale('ar'), 'ar');
  assert.equal(resolveLocale('AR'), 'ar');
  assert.equal(resolveLocale('ar-SA'), 'ar');
  assert.equal(resolveLocale('fr'), 'en'); // unsupported fallback
  assert.equal(resolveLocale(null), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(resolveLocale(''), 'en');
});

test('i18n catalog guard: bidi isolation protects chess notation without mutating text values', () => {
  const fakeDoc = {
    createElement(tag: string) {
      return createFakeElement(tag);
    },
  };

  const testNotation = '1. e4 e5 2. Nf3 Nc6';
  const el = createLtrElement(fakeDoc as unknown as Document, 'span', testNotation, 'test-class');

  assert.equal(el.textContent, testNotation, 'text content must remain completely unmodified');
  assert.equal(el.getAttribute('dir'), 'ltr', 'must set dir="ltr"');
  assert.ok(el.className.includes('test-class'));
  assert.ok(el.className.includes('bidi-ltr'));

  // wrapLtrHtml produces safe bdi markup
  const html = wrapLtrHtml('Nf3+');
  assert.equal(html, '<bdi dir="ltr" class="bidi-ltr">Nf3+</bdi>');

  // In-place isolation
  const target = createFakeElement('div');
  target.textContent = '2800 (±15)';
  applyLtrIsolation(target as unknown as HTMLElement);
  assert.equal(target.getAttribute('dir'), 'ltr');
  assert.ok(target.className.includes('bidi-ltr'));
  assert.equal(target.textContent, '2800 (±15)');
});

test('i18n catalog guard: chess notation classification patterns', () => {
  // Positive chess notation matches
  assert.equal(isChessNotation('e4'), true);
  assert.equal(isChessNotation('Nf3'), true);
  assert.equal(isChessNotation('O-O'), true);
  assert.equal(isChessNotation('O-O-O'), true);
  assert.equal(isChessNotation('e7e8q'), true);
  assert.equal(isChessNotation('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), true);
  assert.equal(isChessNotation('10:00'), true);
  assert.equal(isChessNotation('3+2'), true);
  assert.equal(isChessNotation('+0.45'), true);
  assert.equal(isChessNotation('-1.20'), true);
  assert.equal(isChessNotation('#+3'), true);
  assert.equal(isChessNotation('2450 (±25)'), true);

  // Negative chess notation matches
  assert.equal(isChessNotation('Play Chess'), false);
  assert.equal(isChessNotation('Analyse'), false);
  assert.equal(isChessNotation('Tournament standings'), false);
});
