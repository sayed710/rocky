import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocaleStorage, DEFAULT_LOCALE_STORAGE_KEY } from '../src/i18n/storage.js';
import type { KeyValueStorage } from '../src/net/session.js';

class MemoryStorage implements KeyValueStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('i18n locale storage', () => {
  it('returns default locale when storage is empty', () => {
    const storage = new MemoryStorage();
    const localeStorage = new LocaleStorage({ storage });

    assert.equal(localeStorage.load(), 'en');
  });

  it('loads valid stored locale preference', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEFAULT_LOCALE_STORAGE_KEY, 'ar');
    const localeStorage = new LocaleStorage({ storage });

    assert.equal(localeStorage.load(), 'ar');
  });

  it('safely falls back to en on unsupported or corrupted stored value', () => {
    const storage = new MemoryStorage();
    const localeStorage = new LocaleStorage({ storage });

    storage.setItem(DEFAULT_LOCALE_STORAGE_KEY, 'fr');
    assert.equal(localeStorage.load(), 'en');

    storage.setItem(DEFAULT_LOCALE_STORAGE_KEY, '{corrupted:json');
    assert.equal(localeStorage.load(), 'en');

    storage.setItem(DEFAULT_LOCALE_STORAGE_KEY, '');
    assert.equal(localeStorage.load(), 'en');
  });

  it('saves valid locale to storage', () => {
    const storage = new MemoryStorage();
    const localeStorage = new LocaleStorage({ storage });

    localeStorage.save('ar');
    assert.equal(storage.getItem(DEFAULT_LOCALE_STORAGE_KEY), 'ar');
    assert.equal(localeStorage.load(), 'ar');

    localeStorage.save('en');
    assert.equal(storage.getItem(DEFAULT_LOCALE_STORAGE_KEY), 'en');
  });

  it('handles custom storage key', () => {
    const storage = new MemoryStorage();
    const customKey = 'custom-pref-locale';
    const localeStorage = new LocaleStorage({ storage, storageKey: customKey });

    localeStorage.save('ar');
    assert.equal(storage.getItem(customKey), 'ar');
    assert.equal(localeStorage.load(), 'ar');
  });

  it('clears stored locale and falls back to default', () => {
    const storage = new MemoryStorage();
    const localeStorage = new LocaleStorage({ storage });

    localeStorage.save('ar');
    assert.equal(localeStorage.load(), 'ar');

    localeStorage.clear();
    assert.equal(storage.getItem(DEFAULT_LOCALE_STORAGE_KEY), null);
    assert.equal(localeStorage.load(), 'en');
  });

  it('survives throwing storage without unhandled exception', () => {
    const brokenStorage: KeyValueStorage = {
      getItem() { throw new Error('QuotaExceeded or Private Browsing'); },
      setItem() { throw new Error('QuotaExceeded'); },
      removeItem() { throw new Error('QuotaExceeded'); },
    };

    const localeStorage = new LocaleStorage({ storage: brokenStorage });
    assert.equal(localeStorage.load(), 'en');
    assert.doesNotThrow(() => localeStorage.save('ar'));
    assert.doesNotThrow(() => localeStorage.clear());
  });
});
