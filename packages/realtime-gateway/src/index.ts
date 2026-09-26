/**
 * @packageDocumentation
 * `@chess-platform/realtime-gateway` — the real-time edge for the platform.
 *
 * Composition:
 * - {@link GameAuthority} owns live game state and validates commands via the
 *   perft-verified engine (server-authoritative).
 * - {@link RealtimeGateway} binds client {@link Connection}s to {@link Room}s
 *   and the authority, speaking the wire {@link protocol}.
 * - {@link PubSub} fans authoritative broadcasts across gateway nodes;
 *   {@link InMemoryPubSub} for one process, a Redis adapter in production.
 * - {@link CommandRouter} routes game commands to the owning node (local or
 *   forwarded); {@link LocalCommandRouter} for single-node, a Redis-backed
 *   router in multi-node production (ADR-0010).
 * - {@link Connection} abstracts the socket; {@link InMemoryConnection} drives
 *   deterministic tests, a `ws` adapter serves real clients.
 *
 * Everything here is dependency-free and unit-tested; the WebSocket and Redis
 * bindings are documented seams implemented in the deployable service.
 */

export * from './protocol';
export * from './latency';
export { GameAuthority, AuthorityError, fenHash } from './authority';
export type { Command, AuthorityErrorCode, ApplyResult } from './authority';
export { InMemoryPubSub, RedisPubSub, gameChannel, gamesEndedChannel, gamesProjectedEndedChannel, tournamentChannel } from './pubsub';
export type { PubSub, Unsubscribe, RedisLike } from './pubsub';
export { InMemoryEventLog, EventLogConcurrencyError } from './event-log';
export type { EventLog, LoggedEvent } from './event-log';
export { InMemoryConnection } from './transport';
export type { Connection } from './transport';
export { Room } from './room';
export { RealtimeGateway } from './gateway';
export { LocalCommandRouter } from './command-router';
export type { CommandRouter } from './command-router';
