import { isMessageKey } from '../i18n/catalog/index.js';
import type { I18nManager } from '../i18n/manager.js';

/** Known client-facing levels are localized; future server-owned labels keep their bytes. */
export function aiDifficultyLabel(value: string, i18n: I18nManager): string {
  const key = `ai.difficulty.${value}`;
  if (isMessageKey(key)) return i18n.t(key);
  const courseKey = `learning.difficulty.${value}`;
  return isMessageKey(courseKey) ? i18n.t(courseKey) : value;
}
