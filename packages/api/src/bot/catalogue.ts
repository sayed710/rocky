/**
 * @packageDocumentation
 * The engine bot catalogue: single source of truth for bot accounts, levels, and playing strengths.
 */

import type { StrengthSpec } from '@chess-platform/engine';
import { ENGINE_BOT_USER_IDS } from '@chess-platform/game';

export type BotLevel = 'novice' | 'club' | 'master';

export interface BotAccount {
  readonly level: BotLevel;
  readonly userId: string;
  readonly handle: string;
  readonly strength: StrengthSpec;
}

export const BOT_ACCOUNTS: readonly BotAccount[] = [
  {
    level: 'novice',
    userId: ENGINE_BOT_USER_IDS.novice,
    handle: 'gambit-novice',
    strength: { elo: 1350 },
  },
  {
    level: 'club',
    userId: ENGINE_BOT_USER_IDS.club,
    handle: 'gambit-club',
    strength: { elo: 1750 },
  },
  {
    level: 'master',
    userId: ENGINE_BOT_USER_IDS.master,
    handle: 'gambit-master',
    strength: { elo: 2200 },
  },
];

export function botAccountByLevel(level: string): BotAccount | undefined {
  return BOT_ACCOUNTS.find((bot) => bot.level === level);
}

export function botAccountByUserId(userId: string): BotAccount | undefined {
  return BOT_ACCOUNTS.find((bot) => bot.userId === userId);
}
