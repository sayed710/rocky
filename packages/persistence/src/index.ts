/**
 * @packageDocumentation
 * `@chess-platform/persistence` — the durable data layer. The root entry point is
 * dependency-free (no `pg`): the {@link EventStore} contract, the in-memory
 * implementation, Glicko-2, UUIDv7, errors, and repository interfaces. The
 * Postgres-backed implementations are exposed via the `@chess-platform/persistence/pg`
 * subpath so consumers that only need the interfaces (e.g. the realtime gateway)
 * never pull in the driver.
 */

export * from './errors';
export * from './ids';
export * from './glicko2';
export * from './event-store';
export * from './repositories';
export * from './study-partner';
export * from './in-memory-study-partner';
export * from './search-backfill';

export * from './analysis-cache';
export * from './games-projection';
