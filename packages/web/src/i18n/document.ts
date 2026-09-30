import type { Locale } from './types.js';
import { getLocaleDirection } from './metadata.js';

/**
 * Authoritatively applies language and direction attributes to the document root element.
 *
 * This function serves as the single authoritative updater for document-level
 * localization attributes, preventing different components from racing or desynchronizing.
 */
export function applyDocumentLocale(locale: Locale, doc?: Document): void {
  if (!doc?.documentElement) {
    return;
  }

  const dir = getLocaleDirection(locale);
  doc.documentElement.setAttribute('lang', locale);
  doc.documentElement.setAttribute('dir', dir);
}
