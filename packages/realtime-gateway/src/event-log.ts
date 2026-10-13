/**
 * @packageDocumentation
 * The durable event-log seam for the Game Authority.
 *
 * The authority owns live games in memory but persists every event to an
 * append-only log so a game survives a process restart (or eviction from the
 * hot cache) and can be reconstructed exactly via `Game.fromEvents`. This is
 * the same seam pattern the gateway uses for {@link ./pubsub.PubSub},
 * {@link ./transport}, and the token verifier (ADR-0004): a minimal port
 * defined here in the dependency-free domain, with the concrete Postgres
 * implementation wired in by the deployable service (`services/gateway`).
 *
 * The port is a structural subset of `@chess-platform/persistence`'s
 * `EventStore`, so that package's `InMemoryEventStore` and Postgres
 * `PgEventStore` satisfy {@link EventLog} directly — no adapter needed. Keeping
 * the port here (rather than importing `persistence`) preserves the dependency
 * rule: the realtime domain depends only on `core` + `game`.
 */

import type { GameEvent } from '@chess-platform/game';

/** PostgreSQL INTEGER, matching game_events.seq. */
export const MAX_STATE_REVISION = 2_147_483_647;

export function isStateRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STATE_REVISION;
}

/** Pre-append capacity check; -1 is permitted only for a new stream. */
export function nextEventHead(head: number, count: number): number {
  if ((head !== -1 && !isStateRevision(head)) || !Number.isSafeInteger(count) || count < 0 ||
      count > MAX_STATE_REVISION - head) {
    throw new Error('durable event sequence exhausted or invalid');
  }
  return head + count;
}

/** One persisted event with its per-game append sequence (0-based). */
export interface LoggedEvent {
  readonly seq: number;
  readonly event: GameEvent;
}

/**
 * Append-only, per-game event log keyed by an append sequence `seq`.
 * Implementations must:
 *  - reject an append whose `expectedSeq` != current head (optimistic concurrency);
 *  - require the very first event of a game to be `GameCreated`;
 *  - return events in ascending `seq` order from {@link load}.
 */
export interface EventLog {
  /**
   * Append `events` after `expectedSeq` (the caller's last known head; `-1` for a
   * brand-new game). Returns the new head seq. Rejects if the head has moved.
   */
  append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number>;
  /** Full ordered log for a game (feed straight into `Game.fromEvents`). */
  load(gameId: string): Promise<readonly LoggedEvent[]>;
  /** Whether any events exist for a game. */
  exists(gameId: string): Promise<boolean>;
}

/** Raised when an append's `expectedSeq` does not match the log head. */
export class EventLogConcurrencyError extends Error {
  /** Atomic append refused before committing any events; safe to re-evaluate. */
  readonly appendRejected = true;
  constructor(
    readonly gameId: string,
    readonly expectedSeq: number,
    readonly actualHead: number,
  ) {
    super(`event-log head moved for ${gameId}: expected ${expectedSeq}, was ${actualHead}`);
    this.name = 'EventLogConcurrencyError';
  }
}

/**
 * Process-local {@link EventLog} — the default for tests and single-node local
 * dev. Deterministic and synchronous under the hood; the Postgres store
 * (`@chess-platform/persistence`) is the durable production implementation.
 */
export class InMemoryEventLog implements EventLog {
  private readonly logs = new Map<string, LoggedEvent[]>();

  append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    const log = this.logs.get(gameId) ?? [];
    const head = log.length - 1;
    if (head !== expectedSeq) {
      return Promise.reject(new EventLogConcurrencyError(gameId, expectedSeq, head));
    }
    if (events.length === 0) return Promise.resolve(head);
    if (head === -1 && events[0]!.type !== 'GameCreated') {
      return Promise.reject(new Error('first logged event must be GameCreated'));
    }
    for (const event of events) {
      log.push({ seq: log.length, event: structuredClone(event) });
    }
    this.logs.set(gameId, log);
    return Promise.resolve(log.length - 1);
  }

  load(gameId: string): Promise<readonly LoggedEvent[]> {
    return Promise.resolve((this.logs.get(gameId) ?? []).map((e) => ({ ...e })));
  }

  exists(gameId: string): Promise<boolean> {
    return Promise.resolve((this.logs.get(gameId)?.length ?? 0) > 0);
  }
}
