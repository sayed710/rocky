/** Stable user identities reserved for the platform's first-party engine opponents. */
export const ENGINE_BOT_USER_IDS = {
  novice: '00000000-0000-7000-8000-000000000001',
  club: '00000000-0000-7000-8000-000000000002',
  master: '00000000-0000-7000-8000-000000000003',
} as const;

const ENGINE_BOT_IDS = new Set<string>(Object.values(ENGINE_BOT_USER_IDS));

/** Recognize only the reserved first-party opponent IDs, never arbitrary bot-like handles. */
export function isEngineBotUserId(userId: string): boolean {
  return ENGINE_BOT_IDS.has(userId);
}

/** First-party engine opponents do not turn a game into human-vs-human play. */
export function isHumanGamePlayers(players: { readonly white: string; readonly black: string }): boolean {
  return !isEngineBotUserId(players.white) && !isEngineBotUserId(players.black);
}
