import type { KeyValueStorage } from '../net/session.js';
import type { Locale } from './types.js';
import { DEFAULT_LOCALE, isSupportedLocale } from './metadata.js';

/** Default storage key for persisting explicit user locale preference. */
export const DEFAULT_LOCALE_STORAGE_KEY = 'rookzen_locale_v1';

/** Property access itself can throw in restricted browser contexts. */
export function resolveBrowserStorage(): KeyValueStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Options for initializing {@link LocaleStorage}. */
export interface LocaleStorageOptions {
  readonly storage?: KeyValueStorage | undefined;
  readonly storageKey?: string | undefined;
}

/**
 * Storage abstraction for persisting a future explicit user locale preference.
 *
 * Guarantees:
 * - Safe fallback to DEFAULT_LOCALE ('en') on missing, invalid, or corrupted values.
 * - Silent error handling if storage is restricted or throws (e.g. Safari private mode).
 * - Zero automatic navigator.language detection: preserves explicit user or default choice.
 */
export class LocaleStorage {
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;

  constructor(opts: LocaleStorageOptions = {}) {
    this.storage = opts.storage ?? resolveBrowserStorage();
    this.storageKey = opts.storageKey ?? DEFAULT_LOCALE_STORAGE_KEY;
  }

  /**
   * Loads the stored locale preference, validating it against supported locales.
   * Safely returns DEFAULT_LOCALE if absent, unsupported, or corrupted.
   */
  load(): Locale {
    if (!this.storage) {
      return DEFAULT_LOCALE;
    }
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw && isSupportedLocale(raw)) {
        return raw;
      }
    } catch {
      // Storage unavailable or blocked — safe fallback.
    }
    return DEFAULT_LOCALE;
  }

  /**
   * Persists an explicit locale choice.
   */
  save(locale: Locale): void {
    if (!this.storage || !isSupportedLocale(locale)) {
      return;
    }
    try {
      this.storage.setItem(this.storageKey, locale);
    } catch {
      // Storage quota or permission error — safe ignore.
    }
  }

  /**
   * Clears the stored preference.
   */
  clear(): void {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      // Storage error — safe ignore.
    }
  }
}
