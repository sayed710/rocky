/**
 * @packageDocumentation
 * The single writer that keeps `games` equal to the committed event log (ADR-0147).
 *
 * Work discovery: every `game_events` row carries the id of the transaction that wrote it. A batch
 * reads only rows written by transactions older than `pg_snapshot_xmin(pg_current_snapshot())`, all
 * of which have finished, in `(xact_id, game_id, seq)` order after a durable checkpoint. A
 * transaction still running at that moment has an id at or above the horizon, so its rows sort
 * after anything the checkpoint can pass and are read by a later batch; commit order therefore
 * never loses an event, which a `server_ts` or `seq` cursor cannot promise.
 *
 * Atomicity: a batch is one transaction that holds the checkpoint row `FOR UPDATE SKIP LOCKED`, so
 * one replica works at a time and the others see `busy`. Projection writes, failure records and the
 * advanced checkpoint commit together; a crash anywhere before COMMIT leaves all of them unchanged.
 *
 * Idempotency: each touched game is re-folded from its complete committed stream and written only
 * when the stored row is not newer (`games.last_seq <= EXCLUDED.last_seq`), so replay, overlap with
 * a rebuild, and stale work can never regress a row.
 */

import type { Pool, PoolClient } from 'pg';
import type { ResultString, Termination } from '@chess-platform/game';
import { upcast, type StoredEvent } from '../event-store';
import { projectGameStream, type GameProjection } from '../games-projection';
import { isCanonicalUuid } from './repositories';

const PROJECTION = 'games';
const ORIGIN = { xactId: '0', gameId: '00000000-0000-0000-0000-000000000000', seq: -1 } as const;
/** Failed streams are retried after 2^attempts seconds, never less often than hourly. */
const MAX_RETRY_DELAY_SECONDS = 3600;

/** A game whose projection became terminal in a committed batch. */
export interface ProjectedEnding {
  readonly gameId: string;
  readonly result: ResultString;
  readonly termination: Termination;
  readonly endedAt: Date;
}

/** A stream that could not be projected; it stays in `games_projection_failures` until one succeeds. */
export interface ProjectionFailure {
  readonly gameId: string;
  readonly error: string;
}

export interface GamesProjectionBatch {
  /** Another projector holds the checkpoint, so this call read and wrote nothing. */
  readonly busy: boolean;
  /** The event page was full: more committed work is probably waiting. */
  readonly more: boolean;
  /** The checkpoint was ahead of this cluster's transaction ids (e.g. a logical restore) and restarted from the origin. */
  readonly rewound: boolean;
  readonly projected: number;
  readonly failures: readonly ProjectionFailure[];
  readonly endings: readonly ProjectedEnding[];
}

export interface GamesProjectorOptions {
  /** Events read per batch (default 500). */
  readonly batchSize?: number;
  /** Previously failed streams retried per batch (default 20). */
  readonly retryLimit?: number;
}

interface Checkpoint {
  readonly xactId: string;
  readonly gameId: string;
  readonly seq: number;
}

interface StreamRow {
  seq: number;
  type: string;
  event_version: number;
  payload: unknown;
  server_ts: Date;
}

type GameOutcome =
  | { readonly ok: true; readonly ending: ProjectedEnding | null }
  | { readonly ok: false; readonly failure: ProjectionFailure };

export class PgGamesProjector {
  private readonly batchSize: number;
  private readonly retryLimit: number;

  constructor(private readonly pool: Pool, options: GamesProjectorOptions = {}) {
    this.batchSize = options.batchSize ?? 500;
    this.retryLimit = options.retryLimit ?? 20;
  }

  /** Project the next bounded page of committed events and due retries in one transaction. */
  async runBatch(): Promise<GamesProjectionBatch> {
    return this.inTransaction(async (client) => {
      // First statement, before this transaction owns an id, so the horizon is not capped by it.
      const horizon = (await client.query<{ horizon: string }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon',
      )).rows[0]!.horizon;
      const locked = await client.query<{ xact_id: string; game_id: string; seq: number }>(
        `SELECT xact_id::text AS xact_id, game_id, seq FROM projection_checkpoints
         WHERE projection = $1 FOR UPDATE SKIP LOCKED`,
        [PROJECTION],
      );
      const row = locked.rows[0];
      if (!row) return { busy: true, more: false, rewound: false, projected: 0, failures: [], endings: [] };

      // Within one cluster the checkpoint is always below the horizon. At or above it, the ids came
      // from another cluster's counter; replaying from the origin is idempotent and cannot skip.
      const rewound = BigInt(row.xact_id) >= BigInt(horizon);
      const cursor: Checkpoint = rewound ? ORIGIN : { xactId: row.xact_id, gameId: row.game_id, seq: row.seq };

      const page = await client.query<{ xact_id: string; game_id: string; seq: number }>(
        `SELECT xact_id::text AS xact_id, game_id, seq FROM game_events
         WHERE xact_id < $1::xid8 AND (xact_id, game_id, seq) > ($2::xid8, $3::uuid, $4::integer)
         ORDER BY xact_id, game_id, seq LIMIT $5`,
        [horizon, cursor.xactId, cursor.gameId, cursor.seq, this.batchSize],
      );
      const retries = await client.query<{ game_id: string }>(
        `SELECT game_id FROM games_projection_failures WHERE retry_at <= now() ORDER BY retry_at LIMIT $1`,
        [this.retryLimit],
      );

      const gameIds = [...new Set([...page.rows, ...retries.rows].map((r) => r.game_id))].sort();
      const result = await this.projectAll(client, gameIds);

      const last = page.rows.at(-1);
      const next: Checkpoint | null = last ? { xactId: last.xact_id, gameId: last.game_id, seq: last.seq } : rewound ? ORIGIN : null;
      if (next) {
        await client.query(
          `UPDATE projection_checkpoints SET xact_id = $2::xid8, game_id = $3, seq = $4, updated_at = now()
           WHERE projection = $1`,
          [PROJECTION, next.xactId, next.gameId, next.seq],
        );
      }
      return { busy: false, more: page.rows.length === this.batchSize, rewound, ...result };
    });
  }

  /**
   * Re-fold every stream in the log, independent of the checkpoint. Safe beside live projectors and
   * concurrent appends: each write is guarded by `last_seq`, and a live batch re-folds any game that
   * receives events afterwards.
   *
   * A game the live projector has yet to reach is left to it (`deferred`), so its ending is reported
   * by the batch that publishes wakes rather than absorbed silently here. Endings found here are
   * returned, not broadcast.
   */
  async rebuildAll(pageSize = 200): Promise<{
    projected: number; deferred: number; failures: ProjectionFailure[]; endings: ProjectedEnding[];
  }> {
    const total = { projected: 0, deferred: 0, failures: [] as ProjectionFailure[], endings: [] as ProjectedEnding[] };
    let after: string = ORIGIN.gameId;
    for (;;) {
      const ids = (await this.pool.query<{ game_id: string }>(
        `SELECT game_id FROM game_events WHERE seq = 0 AND game_id > $1::uuid ORDER BY game_id LIMIT $2`,
        [after, pageSize],
      )).rows.map((r) => r.game_id);
      if (ids.length === 0) return total;
      const page = await this.inTransaction(async (client) => {
        const live = await gamesAwaitingLiveBatch(client, ids);
        const result = await this.projectAll(client, ids.filter((id) => !live.has(id)));
        return { ...result, deferred: live.size };
      });
      total.projected += page.projected;
      total.deferred += page.deferred;
      total.failures.push(...page.failures);
      total.endings.push(...page.endings);
      after = ids.at(-1)!;
    }
  }

  private async projectAll(
    client: PoolClient,
    gameIds: readonly string[],
  ): Promise<{ projected: number; failures: ProjectionFailure[]; endings: ProjectedEnding[] }> {
    const failures: ProjectionFailure[] = [];
    const endings: ProjectedEnding[] = [];
    let projected = 0;
    for (const gameId of gameIds) {
      const outcome = await this.projectOne(client, gameId);
      if (!outcome.ok) {
        failures.push(outcome.failure);
        continue;
      }
      projected += 1;
      if (outcome.ending) endings.push(outcome.ending);
    }
    return { projected, failures, endings };
  }

  /** A savepoint confines one stream's failure; the failure itself is recorded in the same transaction. */
  private async projectOne(client: PoolClient, gameId: string): Promise<GameOutcome> {
    await client.query('SAVEPOINT project_game');
    try {
      const projection = projectGameStream(gameId, await loadStream(client, gameId));
      // The row lock makes "became terminal" true for exactly one committed writer.
      const before = await client.query<{ ended: boolean }>(
        'SELECT ended_at IS NOT NULL AS ended FROM games WHERE id = $1 FOR UPDATE',
        [gameId],
      );
      await upsertProjection(client, projection);
      await client.query('DELETE FROM games_projection_failures WHERE game_id = $1', [gameId]);
      await client.query('RELEASE SAVEPOINT project_game');
      const becameTerminal = projection.endedAt !== null && before.rows[0]?.ended !== true;
      return { ok: true, ending: becameTerminal ? endingOf(projection) : null };
    } catch (error) {
      // A broken connection fails here too, which aborts the whole batch before the checkpoint moves.
      await client.query('ROLLBACK TO SAVEPOINT project_game');
      await client.query('RELEASE SAVEPOINT project_game');
      const message = error instanceof Error ? error.message : String(error);
      await client.query(
        `INSERT INTO games_projection_failures (game_id, attempts, last_error, retry_at)
         VALUES ($1, 1, $2, now() + interval '2 seconds')
         ON CONFLICT (game_id) DO UPDATE SET
           attempts = games_projection_failures.attempts + 1,
           last_error = EXCLUDED.last_error,
           retry_at = now() + make_interval(secs => LEAST($3, power(2, games_projection_failures.attempts + 1)))`,
        [gameId, message, MAX_RETRY_DELAY_SECONDS],
      );
      return { ok: false, failure: { gameId, error: message } };
    }
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      // A connection that could not roll back must not return to the pool mid-transaction.
      client.release(broken);
    }
  }
}

/**
 * Games among `ids` with a committed event past the checkpoint that this cluster wrote (id below the
 * snapshot's xmax), i.e. events a live batch is certain to reach. Holding the checkpoint `FOR SHARE`
 * until commit keeps a live batch from moving it between this check and the caller's writes.
 */
async function gamesAwaitingLiveBatch(client: PoolClient, ids: readonly string[]): Promise<Set<string>> {
  const snapshot = (await client.query<{ xmin: string; xmax: string }>(
    `SELECT pg_snapshot_xmin(s)::text AS xmin, pg_snapshot_xmax(s)::text AS xmax FROM pg_current_snapshot() AS s`,
  )).rows[0]!;
  const row = (await client.query<{ xact_id: string; game_id: string; seq: number }>(
    `SELECT xact_id::text AS xact_id, game_id, seq FROM projection_checkpoints WHERE projection = $1 FOR SHARE`,
    [PROJECTION],
  )).rows[0]!;
  // Mirrors runBatch: a checkpoint from another cluster's ids will be replayed from the origin.
  const cursor = BigInt(row.xact_id) >= BigInt(snapshot.xmin) ? ORIGIN : { xactId: row.xact_id, gameId: row.game_id, seq: row.seq };
  const pending = await client.query<{ game_id: string }>(
    `SELECT DISTINCT game_id FROM game_events
     WHERE game_id = ANY($1::uuid[]) AND xact_id < $2::xid8
       AND (xact_id, game_id, seq) > ($3::xid8, $4::uuid, $5::integer)`,
    [ids, snapshot.xmax, cursor.xactId, cursor.gameId, cursor.seq],
  );
  return new Set(pending.rows.map((r) => r.game_id));
}

async function loadStream(client: PoolClient, gameId: string): Promise<StoredEvent[]> {
  const res = await client.query<StreamRow>(
    `SELECT seq, type, event_version, payload, server_ts FROM game_events WHERE game_id = $1 ORDER BY seq`,
    [gameId],
  );
  return res.rows.map((row) => ({
    gameId,
    seq: Number(row.seq),
    version: Number(row.event_version),
    event: upcast(row.type, Number(row.event_version), row.payload),
    serverTs: row.server_ts.getTime(),
  }));
}

/** Seats that are not registered accounts project as NULL rather than violating `games`' user FKs. */
async function upsertProjection(client: PoolClient, p: GameProjection): Promise<void> {
  await client.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, result, termination, ply_count, last_seq, started_at, ended_at)
     VALUES ($1, $2, $3, $4,
             (SELECT id FROM users WHERE id = $5::uuid), (SELECT id FROM users WHERE id = $6::uuid),
             $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       variant = EXCLUDED.variant, rated = EXCLUDED.rated, speed = EXCLUDED.speed,
       white_id = EXCLUDED.white_id, black_id = EXCLUDED.black_id,
       result = EXCLUDED.result, termination = EXCLUDED.termination,
       ply_count = EXCLUDED.ply_count, last_seq = EXCLUDED.last_seq,
       started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at
     WHERE games.last_seq <= EXCLUDED.last_seq`,
    [
      p.id, p.variant, p.rated, p.speed,
      isCanonicalUuid(p.white) ? p.white : null, isCanonicalUuid(p.black) ? p.black : null,
      p.result, p.termination, p.plyCount, p.lastSeq, p.startedAt, p.endedAt,
    ],
  );
}

function endingOf(p: GameProjection): ProjectedEnding {
  return { gameId: p.id, result: p.result!, termination: p.termination!, endedAt: p.endedAt! };
}

export interface GamesProjectionWorkerOptions {
  /** Delay between batches once caught up (default 1000 ms). */
  readonly idleMs?: number;
  /** Ceiling for the exponential delay after consecutive failed batches (default 30 s). */
  readonly maxBackoffMs?: number;
  /** Called after every committed batch; a throwing hook is reported, not fatal. */
  readonly onBatch?: (batch: GamesProjectionBatch) => void;
  readonly onError?: (error: unknown) => void;
}

/** Runs {@link PgGamesProjector.runBatch} continuously: back-to-back while behind, polling when idle, backing off on errors. */
export class GamesProjectionWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private consecutiveErrors = 0;

  constructor(
    private readonly projector: Pick<PgGamesProjector, 'runBatch'>,
    private readonly options: GamesProjectionWorkerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stop scheduling and wait for an in-flight batch to commit or roll back. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const idleMs = this.options.idleMs ?? 1000;
    let batch: GamesProjectionBatch;
    try {
      batch = await this.projector.runBatch();
    } catch (error) {
      // A broken database must not be polled in a tight loop.
      this.consecutiveErrors += 1;
      this.report(error);
      this.schedule(Math.min(this.options.maxBackoffMs ?? 30_000, idleMs * 2 ** this.consecutiveErrors));
      return;
    }
    this.consecutiveErrors = 0;
    try {
      this.options.onBatch?.(batch);
    } catch (error) {
      this.report(error);
    }
    this.schedule(batch.more ? 0 : idleMs);
  }

  private report(error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(error);
      else console.error('GamesProjectionWorker: batch failed', error);
    } catch {
      console.error('GamesProjectionWorker: error hook failed', error);
    }
  }
}
