/**
 * Core types for Rookzen's internationalization and localization system.
 */

/**
 * Supported locale codes.
 * Currently 'en' is the active runtime production locale.
 * 'ar' is supported architecturally in the metadata and bidi subsystem.
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
