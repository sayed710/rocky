/**
 * Engine bot difficulty levels metadata and resolution.
 *
 * Pure and DOM-free: exports the available bot difficulties for display in the
 * lobby dialog and provides string parsing with safe fallbacks.
 */
import type { BotLevel } from '../api/models.js';
import type { MessageKey } from '../i18n/catalog/index.js';

export interface BotLevelOption {
  readonly id: BotLevel;
  readonly labelKey: MessageKey;
  readonly blurbKey: MessageKey;
}

export const BOT_LEVELS: readonly BotLevelOption[] = [
  {
    id: 'novice',
    labelKey: 'bot.level.novice',
    blurbKey: 'bot.level.novice.blurb',
  },
  {
    id: 'club',
    labelKey: 'bot.level.club',
    blurbKey: 'bot.level.club.blurb',
  },
  {
    id: 'master',
    labelKey: 'bot.level.master',
    blurbKey: 'bot.level.master.blurb',
  },
];

export const DEFAULT_BOT_LEVEL: BotLevel = 'club';

export function parseBotLevel(raw: string | null): BotLevel {
  if (!raw) return DEFAULT_BOT_LEVEL;
  const match = BOT_LEVELS.find((opt) => opt.id === raw);
  return match ? match.id : DEFAULT_BOT_LEVEL;
}
