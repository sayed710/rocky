/**
 * @packageDocumentation
 * The durable event store: an append-only log of {@link GameEvent}s ordered by a
 * per-game append sequence `seq` (0-based), from which any game is reconstructed
 * exactly via `Game.fromEvents`. See docs/DATABASE.md §3.
 *
 * This module is dependency-free (no `pg`): it defines the {@link EventStore}
 * contract, an {@link InMemoryEventStore} for tests/dev, and the schema-evolution
 * upcaster registry. The Postgres implementation lives in `./pg/event-store`.
 */

import { isHumanGamePlayers, type GameEvent } from '@chess-platform/game';
import { ConcurrencyError, PersistenceError } from './errors';

/** Current event payload schema version written for new events. */
export const CURRENT_EVENT_VERSION = 1;

/** A single persisted event with its storage metadata. */
export interface StoredEvent {
  readonly gameId: string;
  readonly seq: number;
  readonly version: number;
  readonly event: GameEvent;
  readonly serverTs: number;
}

/** A game whose durable stream has started and has not emitted `GameEnded`. */
export interface ActiveGameRecord {
  readonly gameId: string;
  readonly players: {
    readonly white: string;
    readonly black: string;
  };
}

/**
 * Durable, append-only game event log. Implementations must:
 *  - reject an append whose `expectedSeq` != current head (optimistic concurrency);
 *  - require the very first stored event of a game to be `GameCreated`;
 *  - return events in ascending `seq` order from {@link load}/{@link loadSince}.
 */
export interface EventStore {
  /**
   * Append `events` after `expectedSeq` (the caller's last known head; `-1` for a
   * brand-new game). Atomic. Returns the new head seq. Throws {@link ConcurrencyError}
   * if the head has moved.
   */
  append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number>;
  /** Full ordered log for a game (feed straight into `Game.fromEvents`). */
  load(gameId: string): Promise<StoredEvent[]>;
  /** Events with `seq > afterSeq` (resume / spectator catch-up). */
  loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** Whether any events exist for a game. */
  exists(gameId: string): Promise<boolean>;
  /** Active games in which `userId` occupies either seat, derived from the durable event log. */
  findActiveGamesByPlayer(userId: string): Promise<ActiveGameRecord[]>;
  /**
   * Acquire the per-player coordination lock shared with human-game creation.
   *
   * Assistance delivery holds this lock from its final eligibility check until the HTTP response
   * is committed, closing the last check/write race. The returned release function is idempotent.
   */
  acquirePlayerLock(userId: string): Promise<() => Promise<void>>;
}

/** Human participants whose game creation must coordinate with assistance delivery. */
export function humanGamePlayerIds(events: readonly GameEvent[]): readonly string[] {
  const created = events[0];
  if (
    created?.type !== 'GameCreated'
    || !isHumanGamePlayers(created.players)
  ) {
    return [];
  }
  return [...new Set([created.players.white, created.players.black])].sort();
}

// --- Schema evolution (upcasters) -----------------------------------------

/** Maps a stored payload written at some version to the current in-memory shape. */
export type Upcaster = (payload: unknown) => GameEvent;

const upcasters = new Map<string, Upcaster>();

const key = (type: string, version: number): string => `${type}@${version}`;

/** Register an upcaster for a legacy `(type, version)` payload. */
export function registerUpcaster(type: string, version: number, fn: Upcaster): void {
  upcasters.set(key(type, version), fn);
}

/**
 * Normalize a stored payload to the current {@link GameEvent} shape. Rows at
 * {@link CURRENT_EVENT_VERSION} pass through as-is; older versions require a
 * registered upcaster.
 */
export function upcast(type: string, version: number, payload: unknown): GameEvent {
  const fn = upcasters.get(key(type, version));
  if (fn) return fn(payload);
  if (version === CURRENT_EVENT_VERSION) return payload as GameEvent;
  throw new PersistenceError(`no upcaster registered for event ${key(type, version)}`);
}

// --- In-memory implementation ---------------------------------------------

/** Deterministic, process-local {@link EventStore} for tests and local dev. */
export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, StoredEvent[]>();
  private readonly playerLocks = new Map<string, PlayerMutex>();

  /** `now` is injectable so tests can assert deterministic timestamps. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Serialize human game creation with assistance delivery in the process-local implementation. */
  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    const releases: Array<() => Promise<void>> = [];
    try {
      if (expectedSeq === -1) {
        for (const playerId of humanGamePlayerIds(events)) {
          releases.push(await this.acquirePlayerLock(playerId));
        }
      }
      const log = this.logs.get(gameId) ?? [];
      const head = log.length - 1;
      if (head !== expectedSeq) throw new ConcurrencyError(gameId, expectedSeq, head);
      if (events.length === 0) return head;
      if (head === -1 && events[0]!.type !== 'GameCreated') {
        throw new PersistenceError('first stored event must be GameCreated');
      }
      const ts = this.now();
      for (const event of events) {
        log.push({
          gameId,
          seq: log.length,
          version: CURRENT_EVENT_VERSION,
          event: structuredClone(event),
          serverTs: ts,
        });
      }
      this.logs.set(gameId, log);
      return log.length - 1;
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  load(gameId: string): Promise<StoredEvent[]> {
    return Promise.resolve((this.logs.get(gameId) ?? []).map((e) => ({ ...e })));
  }

  loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]> {
    return Promise.resolve(
      (this.logs.get(gameId) ?? []).filter((e) => e.seq > afterSeq).map((e) => ({ ...e })),
    );
  }

  exists(gameId: string): Promise<boolean> {
    return Promise.resolve((this.logs.get(gameId)?.length ?? 0) > 0);
  }

  /** Return games with a creation event but no durable ending event for this player. */
  findActiveGamesByPlayer(userId: string): Promise<ActiveGameRecord[]> {
    const active: ActiveGameRecord[] = [];
    for (const [gameId, log] of this.logs) {
      const created = log[0]?.event;
      if (created?.type !== 'GameCreated') continue;
      if (created.players.white !== userId && created.players.black !== userId) continue;
      if (log.some(({ event }) => event.type === 'GameEnded')) continue;
      active.push({ gameId, players: { ...created.players } });
    }
    return Promise.resolve(active);
  }

  /** Acquire an idempotently releasable player mutex shared with human-game creation. */
  acquirePlayerLock(userId: string): Promise<() => Promise<void>> {
    let lock = this.playerLocks.get(userId);
    if (!lock) {
      lock = new PlayerMutex();
      this.playerLocks.set(userId, lock);
    }
    return lock.acquire().then((release) => async () => {
      await release();
      if (lock.idle && this.playerLocks.get(userId) === lock) this.playerLocks.delete(userId);
    });
  }

  /** Test/local-dev transaction compensation used by the in-memory seek acceptor. */
  _removeGame(gameId: string): void {
    this.logs.delete(gameId);
  }
}

/** FIFO mutex used by the deterministic in-memory implementation. */
class PlayerMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  get idle(): boolean {
    return !this.locked && this.waiters.length === 0;
  }

  /** Queue contenders in arrival order and transfer ownership only on release. */
  acquire(): Promise<() => Promise<void>> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.locked = true;
        let released = false;
        resolve(async () => {
          if (released) return;
          released = true;
          const next = this.waiters.shift();
          if (next) next();
          else this.locked = false;
        });
      };
      if (this.locked) this.waiters.push(grant);
      else grant();
    });
  }
}
