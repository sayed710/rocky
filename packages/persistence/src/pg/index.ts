/**
 * @packageDocumentation
 * `@chess-platform/persistence/pg` — Postgres-backed implementations. Importing
 * this subpath pulls in the `pg` driver; the root package entry stays driver-free.
 */

export * from './pool';
export * from './migrate';
export * from './event-store';
export * from './terminal-event-inbox';
export * from './games-projector';
export * from './repositories';
export * from './anti-cheat';
export * from './bot-reports';
export * from './search';
export * from './semantic-search';
export * from './search-helpers';
export * from './search-backfill';
export * from './social';
export * from './messaging';
export * from './community';
export * from './achievements';
export * from './achievements-game-source';
export * from './studies';
export * from './learning';
export * from './study-partner';
export * from './analysis-cache';
