/**
 * @packageDocumentation
 * Postgres-backed {@link EventStore}. Appends are transactional and rely on the
 * `(game_id, seq)` primary key for optimistic concurrency: a losing race becomes
 * a unique-violation surfaced as {@link ConcurrencyError}.
 */

import { Pool, type PoolClient } from 'pg';
import type { GameEvent } from '@chess-platform/game';
import {
  CURRENT_EVENT_VERSION,
  upcast,
  type EventStore,
  type ActiveGameRecord,
  type StoredEvent,
  humanGamePlayerIds,
} from '../event-store';
import { ConcurrencyError, PersistenceError } from '../errors';

interface EventRow {
  game_id: string;
  seq: number;
  type: string;
  event_version: number;
  payload: unknown;
  server_ts: Date;
}

interface ActiveGameRow {
  game_id: string;
  event_version: number;
  payload: unknown;
}

const UNIQUE_VIOLATION = '23505';
const LOCK_NOT_AVAILABLE = '55P03';

/** A short advisory-lock wait expired; the caller must retry after rolling back its transaction. */
export class PlayerLockBusyError extends PersistenceError {}

/** Never let game-creation waiters monopolize the query pool while assistance holds a player lock. */
export async function retryPlayerLockContention<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof PlayerLockBusyError) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

function toStored(row: EventRow): StoredEvent {
  return {
    gameId: row.game_id,
    seq: Number(row.seq),
    version: Number(row.event_version),
    event: upcast(row.type, Number(row.event_version), row.payload),
    serverTs: row.server_ts.getTime(),
  };
}

export class PostgresEventStore implements EventStore {
  private playerLockPool: Pool | null = null;
  private playerLockPoolClosing: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  /** Close the independent advisory-lock pool after all request handlers have drained. */
  async closePlayerLocks(): Promise<void> {
    if (!this.playerLockPoolClosing) {
      this.playerLockPoolClosing = this.playerLockPool?.end() ?? Promise.resolve();
    }
    await this.playerLockPoolClosing;
  }

  /** Lock holders must never consume the query pool needed by eligibility and handler reads. */
  private lockPool(): Pool {
    if (this.playerLockPoolClosing) throw new PersistenceError('player lock pool is closed');
    if (!this.playerLockPool) {
      this.playerLockPool = new Pool({
        ...this.pool.options,
        // pg deliberately makes this option non-enumerable, so object spread alone drops it.
        password: this.pool.options.password,
        max: 5,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
      });
    }
    return this.playerLockPool;
  }

  private async headSeq(client: PoolClient, gameId: string): Promise<number> {
    const res = await client.query<{ head: string }>(
      'SELECT COALESCE(MAX(seq), -1)::text AS head FROM game_events WHERE game_id = $1',
      [gameId],
    );
    return parseInt(res.rows[0]!.head, 10);
  }

  /** Append one game stream atomically, coordinating human creation with player delivery locks. */
  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    return retryPlayerLockContention(() => this.appendOnce(gameId, expectedSeq, events));
  }

  private async appendOnce(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    if (events.length === 0) return expectedSeq;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      if (expectedSeq === -1) await lockGameCreationPlayers(client, events);
      const head = await this.headSeq(client, gameId);
      if (head !== expectedSeq) throw new ConcurrencyError(gameId, expectedSeq, head);
      if (head === -1 && events[0]!.type !== 'GameCreated') {
        throw new PersistenceError('first stored event must be GameCreated');
      }
      let seq = head;
      for (const event of events) {
        seq += 1;
        await client.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)],
        );
      }
      await client.query('COMMIT');
      committed = true;
      return seq;
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback failure */
        }
      }
      if (isUniqueViolation(err)) throw new ConcurrencyError(gameId, expectedSeq);
      throw err;
    } finally {
      client.release();
    }
  }

  async load(gameId: string): Promise<StoredEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT game_id, seq, type, event_version, payload, server_ts
       FROM game_events WHERE game_id = $1 ORDER BY seq ASC`,
      [gameId],
    );
    return res.rows.map(toStored);
  }

  async loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT game_id, seq, type, event_version, payload, server_ts
       FROM game_events WHERE game_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [gameId, afterSeq],
    );
    return res.rows.map(toStored);
  }

  async exists(gameId: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM game_events WHERE game_id = $1 LIMIT 1',
      [gameId],
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  /** Read active participation from durable creation and ending events, not projections. */
  async findActiveGamesByPlayer(userId: string): Promise<ActiveGameRecord[]> {
    const res = await this.pool.query<ActiveGameRow>(
      `SELECT created.game_id, created.event_version, created.payload
       FROM game_events AS created
       WHERE created.seq = 0
         AND created.type = 'GameCreated'
         AND (
           created.payload->'players' @> jsonb_build_object('white', $1::text)
           OR created.payload->'players' @> jsonb_build_object('black', $1::text)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM game_events AS ended
           WHERE ended.game_id = created.game_id
             AND ended.type = 'GameEnded'
         )
       ORDER BY created.server_ts DESC, created.game_id DESC`,
      [userId],
    );
    return res.rows.map((row) => {
      const event = upcast('GameCreated', Number(row.event_version), row.payload);
      if (event.type !== 'GameCreated') {
        throw new PersistenceError(`game ${row.game_id} starts with a non-GameCreated payload`);
      }
      return { gameId: row.game_id, players: { ...event.players } };
    });
  }

  /** Hold a session advisory lock through response commitment without occupying the query pool. */
  async acquirePlayerLock(userId: string): Promise<() => Promise<void>> {
    const client = await this.lockPool().connect();
    try {
      await client.query(
        `SELECT pg_advisory_lock(hashtextextended('rocky:active-human-game:' || $1, 0))`,
        [userId],
      );
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('failed to acquire player lock'));
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended('rocky:active-human-game:' || $1, 0))`,
          [userId],
        );
        client.release();
      } catch (error) {
        client.release(error instanceof Error ? error : new Error('failed to release player lock'));
      }
    };
  }
}

/** Serialize human-game creation against assistance response commitment for both participants. */
export async function lockGameCreationPlayers(
  client: PoolClient,
  events: readonly GameEvent[],
): Promise<void> {
  const players = humanGamePlayerIds(events);
  if (players.length === 0) return;
  await client.query("SET LOCAL lock_timeout = '500ms'");
  for (const playerId of players) {
    try {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('rocky:active-human-game:' || $1, 0))`,
        [playerId],
      );
    } catch (error) {
      // PostgreSQL aborts the transaction on timeout; each caller rolls it back before retrying.
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        throw new PlayerLockBusyError('player lock contention');
      }
      throw error;
    }
  }
  // Later writes in this transaction should not inherit the short advisory-lock timeout.
  await client.query('SET LOCAL lock_timeout = DEFAULT');
}
