/**
 * @packageDocumentation
 * `@chess-platform/game` — the event-sourced game authority domain. Built on
 * `@chess-platform/core`; owns clocks, legality (server-authoritative), and the
 * durable event log from which any game is reconstructed.
 */

export * from './clock';
export * from './events';
export { ENGINE_BOT_USER_IDS, isEngineBotUserId } from './bot-accounts';
export { Game, GameError, canMate } from './game';
export type { GameState, GameStatus, CreateGameParams } from './game';
