import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  LOCALE_METADATA,
  isSupportedLocale,
  resolveLocale,
  getLocaleDirection,
  isRtl,
} from '../src/i18n/metadata.js';
import type { Locale } from '../src/i18n/types.js';

describe('i18n metadata & normalization', () => {
  it('exposes en as the default locale', () => {
    assert.equal(DEFAULT_LOCALE, 'en');
  });

  it('exposes supported locales including en and ar', () => {
    assert.deepEqual(SUPPORTED_LOCALES, ['en', 'ar']);
  });

  it('provides metadata for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const meta = LOCALE_METADATA[locale];
      assert.ok(meta, `missing metadata for ${locale}`);
      assert.equal(meta.code, locale);
      assert.ok(meta.name.length > 0);
      assert.ok(meta.nativeName.length > 0);
    }
    assert.equal(LOCALE_METADATA['en'].dir, 'ltr');
    assert.equal(LOCALE_METADATA['ar'].dir, 'rtl');
  });

  it('isSupportedLocale type guard validates correctly without throwing', () => {
    assert.equal(isSupportedLocale('en'), true);
    assert.equal(isSupportedLocale('ar'), true);
    assert.equal(isSupportedLocale('fr'), false);
    assert.equal(isSupportedLocale(''), false);
    assert.equal(isSupportedLocale(null), false);
    assert.equal(isSupportedLocale(undefined), false);
    assert.equal(isSupportedLocale(123), false);
    assert.equal(isSupportedLocale({}), false);
  });

  it('resolveLocale normalizes language tags with safe fallback to English', () => {
    assert.equal(resolveLocale('en'), 'en');
    assert.equal(resolveLocale('EN'), 'en');
    assert.equal(resolveLocale('en-US'), 'en');
    assert.equal(resolveLocale('en_GB'), 'en');
    assert.equal(resolveLocale('ar'), 'ar');
    assert.equal(resolveLocale('AR'), 'ar');
    assert.equal(resolveLocale('ar-EG'), 'ar');
    assert.equal(resolveLocale('ar_SA'), 'ar');

    // Unknown or invalid inputs safely fall back to en
    assert.equal(resolveLocale('de'), 'en');
    assert.equal(resolveLocale(''), 'en');
    assert.equal(resolveLocale(null), 'en');
    assert.equal(resolveLocale(undefined), 'en');
    assert.equal(resolveLocale(42), 'en');
    assert.equal(resolveLocale(['invalid']), 'en');
  });

  it('getLocaleDirection reports correct direction for supported locales', () => {
    assert.equal(getLocaleDirection('en'), 'ltr');
    assert.equal(getLocaleDirection('ar'), 'rtl');
  });

  it('isRtl returns true only for rtl locales', () => {
    assert.equal(isRtl('en'), false);
    assert.equal(isRtl('ar'), true);
  });
});
