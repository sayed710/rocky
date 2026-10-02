import type { Direction, Locale, LocaleMetadata } from './types.js';

/** Default runtime locale for Rookzen. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Complete list of supported locales in Rookzen architecture. */
export const SUPPORTED_LOCALES: readonly Locale[] = Object.freeze(['en', 'ar']);

/** Metadata for each supported locale. */
export const LOCALE_METADATA: Readonly<Record<Locale, LocaleMetadata>> = Object.freeze({
  en: Object.freeze({
    code: 'en',
    name: 'English',
    nativeName: 'English',
    dir: 'ltr',
  }),
  ar: Object.freeze({
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    dir: 'rtl',
  }),
});

/**
 * Type guard for {@link Locale}. Validates whether an unknown value is a supported locale.
 * Strictly avoids `as any`.
 */
export function isSupportedLocale(candidate: unknown): candidate is Locale {
  if (typeof candidate !== 'string') {
    return false;
  }
  return SUPPORTED_LOCALES.includes(candidate as Locale);
}

/**
 * Normalizes an arbitrary locale or language tag candidate (e.g. 'en-US', 'AR', 'ar_EG')
 * to a supported {@link Locale}, falling back safely to {@link DEFAULT_LOCALE} ('en').
 *
 * Guaranteed to never return an invalid or unsupported locale.
 */
export function resolveLocale(candidate?: unknown): Locale {
  if (typeof candidate !== 'string') {
    return DEFAULT_LOCALE;
  }

  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return DEFAULT_LOCALE;
  }

  // Exact match first
  if (isSupportedLocale(trimmed)) {
    return trimmed;
  }

  // Language subtag prefix (e.g., 'en-US' -> 'en', 'ar_SA' -> 'ar')
  const baseTag = trimmed.split(/[-_]/)[0];
  if (baseTag && isSupportedLocale(baseTag)) {
    return baseTag;
  }

  return DEFAULT_LOCALE;
}

/**
 * Returns the layout direction for a supported locale.
 */
export function getLocaleDirection(locale: Locale): Direction {
  return LOCALE_METADATA[locale]?.dir ?? 'ltr';
}

/**
 * Returns true if the locale is a right-to-left language.
 */
export function isRtl(locale: Locale): boolean {
  return getLocaleDirection(locale) === 'rtl';
}
