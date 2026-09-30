import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { I18n, createI18n } from '../src/i18n/manager.js';
import { LocaleStorage } from '../src/i18n/storage.js';
import type { KeyValueStorage } from '../src/net/session.js';
import type { MessageKey, MessagesCatalog } from '../src/i18n/catalog/index.js';
import type { Locale } from '../src/i18n/types.js';

class MemoryStorage implements KeyValueStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
}

describe('i18n manager', () => {
  it('initializes with default locale en', () => {
    const i18n = createI18n();
    assert.equal(i18n.locale, 'en');
  });

  it('translates known English message keys', () => {
    const i18n = createI18n();
    assert.equal(i18n.t('shell.brand'), 'Rookzen');
    assert.equal(i18n.t('nav.play'), 'Play');
    assert.equal(i18n.t('game.status.yourMove'), 'Your move.');
  });

  it('translates with safe parameter interpolation', () => {
    const i18n = createI18n();
    const result = i18n.t('lobby.challengeAria', { creator: 'Alice' });
    assert.equal(result, 'Accept seek from Alice');
  });

  it('throws on missing or invalid translation key in strict mode without silent fallback', () => {
    const i18n = createI18n({ strict: true });
    assert.throws(
      () => i18n.t('nonexistent.key' as MessageKey),
      /Missing translation key: "nonexistent\.key"/,
    );
  });

  it('falls back safely to raw key in default production mode (strict: false)', () => {
    const i18n = createI18n();
    const result = i18n.t('nonexistent.key' as MessageKey);
    assert.equal(result, 'nonexistent.key');
  });

  it('rejects activating ar in production when no Arabic catalog is registered, remaining en', () => {
    const i18n = createI18n();
    assert.equal(i18n.locale, 'en');
    i18n.setLocale('ar');
    assert.equal(i18n.locale, 'en');
  });

  it('setLocale changes active locale and notifies subscribers when catalog is registered', () => {
    const i18n = createI18n();
    i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);

    let notifiedLocale: string | null = null;
    const unsub = i18n.onLocaleChange((newLocale: Locale) => {
      notifiedLocale = newLocale;
    });

    i18n.setLocale('ar');
    assert.equal(i18n.locale, 'ar');
    assert.equal(notifiedLocale, 'ar');

    unsub();
    i18n.setLocale('en');
    assert.equal(i18n.locale, 'en');
    assert.equal(notifiedLocale, 'ar'); // unsubscribed, not notified
  });

  it('falls back to English when a key is not present in another locale catalog', () => {
    const i18n = createI18n();
    const partialAr = {
      'shell.brand': 'روك زن',
    };
    i18n.registerCatalog('ar', partialAr as unknown as MessagesCatalog);

    i18n.setLocale('ar');
    // Key present in ar
    assert.equal(i18n.t('shell.brand'), 'روك زن');
    // Key absent in ar falls back to en
    assert.equal(i18n.t('shell.skipBoard'), 'Skip to board');
  });

  it('persists locale changes when storage is provided and catalog is available', () => {
    const storage = new MemoryStorage();
    const localeStorage = new LocaleStorage({ storage });
    const i18n = createI18n({ storage: localeStorage });
    i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);

    assert.equal(i18n.locale, 'en');
    i18n.setLocale('ar');
    assert.equal(i18n.locale, 'ar');
    assert.equal(localeStorage.load(), 'ar');
  });

  it('updates target Document html attributes on locale change', () => {
    const fakeDoc = {
      documentElement: {
        lang: 'en',
        dir: 'ltr',
        setAttribute(k: string, v: string) {
          if (k === 'lang') this.lang = v;
          if (k === 'dir') this.dir = v;
        },
      },
    } as unknown as Document;

    const i18n = createI18n({ doc: fakeDoc });
    i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);
    i18n.setLocale('ar');

    assert.equal(fakeDoc.documentElement.lang, 'ar');
    assert.equal(fakeDoc.documentElement.dir, 'rtl');
  });
});
