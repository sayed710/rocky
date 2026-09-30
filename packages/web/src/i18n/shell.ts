import type { I18n } from './manager.js';
import { isMessageKey } from './catalog/index.js';
import type { MessageKey } from './catalog/index.js';

export interface LocalizedShellHandle {
  dispose: () => void;
}

/**
 * Shell elements with static IDs whose template markup is verified by exact literal regexes.
 * Localizing them by ID allows them to be translated while preserving exact static markup assertions.
 */
const STATIC_HEADING_IDS: Readonly<Record<string, MessageKey>> = {
  'auth-heading': 'auth.heading',
  'email-verify-heading': 'emailVerification.heading',
  'password-reset-heading': 'passwordRecovery.heading',
};

/**
 * Updates DOM attributes and text content of shell elements matching data-i18n attributes.
 *
 * Supported attributes:
 * - `data-i18n="key"`: sets textContent
 * - `data-i18n-aria-label="key"`: sets aria-label
 * - `data-i18n-placeholder="key"`: sets placeholder
 * - `data-i18n-title="key"`: sets title
 * - `data-i18n-alt="key"`: sets alt
 */
export function localizeShell(doc: Document, i18n: I18n): LocalizedShellHandle {
  function update(): void {
    // 0. Static heading IDs
    for (const [id, key] of Object.entries(STATIC_HEADING_IDS)) {
      const el = typeof doc.getElementById === 'function'
        ? doc.getElementById(id)
        : (typeof doc.querySelector === 'function' ? doc.querySelector<HTMLElement>(`#${id}`) : null);
      if (el) {
        el.textContent = i18n.t(key);
      }
    }

    // 1. Text content
    const textEls = doc.querySelectorAll<HTMLElement>('[data-i18n]');
    for (const el of textEls) {
      const key = el.dataset.i18n;
      if (key && isMessageKey(key)) {
        el.textContent = i18n.t(key);
      }
    }

    // 2. Aria-label
    const ariaEls = doc.querySelectorAll<HTMLElement>('[data-i18n-aria-label]');
    for (const el of ariaEls) {
      const key = el.dataset.i18nAriaLabel;
      if (key && isMessageKey(key)) {
        el.setAttribute('aria-label', i18n.t(key));
      }
    }

    // 3. Placeholder
    const placeholderEls = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]');
    for (const el of placeholderEls) {
      const key = el.dataset.i18nPlaceholder;
      if (key && isMessageKey(key)) {
        el.setAttribute('placeholder', i18n.t(key));
      }
    }

    // 4. Title
    const titleEls = doc.querySelectorAll<HTMLElement>('[data-i18n-title]');
    for (const el of titleEls) {
      const key = el.dataset.i18nTitle;
      if (key && isMessageKey(key)) {
        el.setAttribute('title', i18n.t(key));
      }
    }

    // 5. Alt
    const altEls = doc.querySelectorAll<HTMLImageElement>('[data-i18n-alt]');
    for (const el of altEls) {
      const key = el.dataset.i18nAlt;
      if (key && isMessageKey(key)) {
        el.setAttribute('alt', i18n.t(key));
      }
    }
  }

  // Initial update
  update();

  // Re-run on locale change
  const unsub = i18n.onLocaleChange(() => {
    update();
  });

  return {
    dispose: unsub,
  };
}
