/**
 * Core types for Rookzen's internationalization and localization system.
 */

/**
 * Supported locale codes.
 * English and Arabic ship complete client-owned message catalogues.
 */
export type Locale = 'en' | 'ar';

/**
 * Text layout direction.
 */
export type Direction = 'ltr' | 'rtl';

/**
 * Metadata for a supported locale.
 */
export interface LocaleMetadata {
  readonly code: Locale;
  readonly name: string;
  readonly nativeName: string;
  readonly dir: Direction;
}

/**
 * Safe interpolation parameters: strings or numbers only.
 */
export type InterpolationParams = Readonly<Record<string, string | number>>;
