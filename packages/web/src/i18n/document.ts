import type { Locale } from './types.js';
import { getLocaleDirection } from './metadata.js';

/**
 * Authoritatively applies language and direction attributes to the document root element.
 *
 * This function serves as the single authoritative updater for document-level
 * localization attributes, preventing different components from racing or desynchronizing.
 */
export function applyDocumentLocale(locale: Locale, doc?: Document): void {
  const targetDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!targetDoc?.documentElement) {
    return;
  }

  const dir = getLocaleDirection(locale);
  targetDoc.documentElement.setAttribute('lang', locale);
  targetDoc.documentElement.setAttribute('dir', dir);
}
