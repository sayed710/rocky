import type { Locale, InterpolationParams } from './types.js';
import { DEFAULT_LOCALE, isSupportedLocale } from './metadata.js';
import { enMessages, type MessageKey, type MessagesCatalog } from './catalog/index.js';
import { interpolate } from './interpolate.js';
import { applyDocumentLocale } from './document.js';
import type { LocaleStorage } from './storage.js';

export interface I18nOptions {
  readonly initialLocale?: Locale | undefined;
  readonly storage?: LocaleStorage | undefined;
  readonly strict?: boolean | undefined;
  readonly doc?: Document | undefined;
  readonly catalogs?: Partial<Record<Locale, MessagesCatalog>> | undefined;
}

/**
 * Authoritative application-level locale manager.
 *
 * Guarantees:
 * - Deterministic message lookup and safe parameter interpolation.
 * - Missing keys in non-default locales fall back gracefully to canonical English.
 * - Strictly throws in strict mode when a required key is missing entirely (no silent bugs).
 * - Synchronizes with LocaleStorage and applies document-level lang/dir attributes.
 */
export type I18nManager = I18n;

export function createI18nManager(options?: I18nOptions): I18nManager {
  return new I18n(options);
}

export class I18n {
  private activeLocale: Locale;
  private readonly storage: LocaleStorage | undefined;
  private readonly strict: boolean;
  private doc: Document | undefined;
  private readonly catalogs = new Map<Locale, MessagesCatalog>();
  private readonly listeners = new Set<(locale: Locale) => void>();

  constructor(opts: I18nOptions = {}) {
    this.storage = opts.storage;
    this.strict = opts.strict ?? false;
    this.doc = opts.doc;
    this.catalogs.set('en', enMessages);
    if (opts.catalogs) {
      for (const [loc, cat] of Object.entries(opts.catalogs)) {
        if (cat && isSupportedLocale(loc)) {
          this.catalogs.set(loc, cat);
        }
      }
    }

    // Initial locale resolution: explicit initial > storage > default
    // Note: candidate must be supported AND have a registered catalog
    const stored = this.storage?.load();
    const candidate = opts.initialLocale ?? stored ?? DEFAULT_LOCALE;
    this.activeLocale = isSupportedLocale(candidate) && this.catalogs.has(candidate)
      ? candidate
      : DEFAULT_LOCALE;

    // Apply document attributes on initialization
    applyDocumentLocale(this.activeLocale, this.doc);
  }

  /** Current active locale. */
  get locale(): Locale {
    return this.activeLocale;
  }

  /** Target document owned by this manager. */
  get document(): Document | undefined {
    return this.doc;
  }

  /**
   * Sets or updates the target document for document-level localization.
   */
  setDocument(doc: Document | undefined): void {
    this.doc = doc;
    if (this.doc) {
      applyDocumentLocale(this.activeLocale, this.doc);
    }
  }

  /**
   * Registers a message catalog for a specific locale.
   */
  registerCatalog(locale: Locale, catalog: MessagesCatalog): void {
    this.catalogs.set(locale, catalog);
  }

  /**
   * Translates a message key into the active locale, performing parameter interpolation.
   *
   * @throws Error if key is missing and strict mode is enabled.
   */
  t(key: MessageKey, params?: InterpolationParams): string {
    const activeCatalog = this.catalogs.get(this.activeLocale);
    let template = activeCatalog ? activeCatalog[key] : undefined;

    // Fall back to canonical English catalog if missing in active catalog
    if (template === undefined && this.activeLocale !== DEFAULT_LOCALE) {
      const enCatalog = this.catalogs.get(DEFAULT_LOCALE);
      template = enCatalog ? enCatalog[key] : undefined;
    }

    if (template === undefined) {
      if (this.strict) {
        throw new Error(`Missing translation key: "${String(key)}" in locale "${this.activeLocale}"`);
      }
      return String(key);
    }

    return interpolate(template, params);
  }

  /**
   * Updates the active locale, persists to storage, updates document lang/dir,
   * and notifies all registered subscribers.
   */
  setLocale(locale: Locale): void {
    if (!isSupportedLocale(locale) || !this.catalogs.has(locale)) {
      return;
    }
    if (this.activeLocale === locale) {
      return;
    }

    this.activeLocale = locale;
    this.storage?.save(locale);
    applyDocumentLocale(locale, this.doc);

    for (const listener of this.listeners) {
      try {
        listener(locale);
      } catch (err) {
        console.error('[I18n] listener threw error:', err);
      }
    }
  }

  /**
   * Subscribes to locale changes. Returns an unsubscribe teardown function.
   */
  onLocaleChange(listener: (locale: Locale) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Factory function to create an I18n instance. */
export function createI18n(options?: I18nOptions): I18n {
  return new I18n(options);
}
