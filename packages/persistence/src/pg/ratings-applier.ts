/**
 * @packageDocumentation
 * Applies every rated result to both players' variant × speed ratings exactly once, from the event
 * log (ADR-0150).
 *
 * Order: a rating depends on every earlier rating of both players, so a result must be applied in one
 * order that live processing and any replay agree on. The applier walks committed `GameEnded` rows in
 * `(xact_id, server_ts, game_id)` order and only below `pg_snapshot_xmin(pg_current_snapshot())`,
 * ADR-0147's committed prefix: a transaction still running has an id at or above that horizon, so no
 * ending can later appear before the position already passed. `server_ts` only separates endings
 * that share a transaction id; the append path writes one game per transaction, so in practice that
 * is the rows migration 0040 stamped with one id, which keep their original insert times.
 *
 * Exactly once: a game's two new ratings, its `rating_applications` row (primary key `game_id`) and
 * the advanced checkpoint commit in one transaction. The checkpoint row is held `FOR UPDATE SKIP
 * LOCKED`, so one applier works at a time and replicas see `busy`; the ledger additionally refuses a
 * second application whatever replays it (a rewound checkpoint, a restore).
 *
 * Nothing here reads the `games` projection or trusts a caller: eligibility is folded from the stream.
 */

import type { Pool, PoolClient } from 'pg';
import { rateGame, initialRating, type Glicko2Rating } from '../glicko2';
import { decideRating, type RateableGame } from '../rating-eligibility';
import { CorruptGameStreamError } from '../errors';
import { inTransaction, loadStream } from './games-projector';

const ORIGIN = { xactId: '0', serverTs: '-infinity', gameId: '00000000-0000-0000-0000-000000000000' } as const;

/** What happened to one ending. `blocked` is a block recorded by this batch; `already_blocked` is one found from before. */
export type RatingOutcome = 'applied' | 'already_applied' | 'ineligible' | 'blocked' | 'already_blocked';

/** An ending whose eligibility could not be proven; it is recorded and never rated automatically. */
export interface BlockedRating {
  readonly gameId: string;
  readonly error: string;
}

export interface RatingsBatch {
  /** Another applier holds the checkpoint, so this call read and wrote nothing. */
  readonly busy: boolean;
  /** The page was full: more committed endings are probably waiting. */
  readonly more: boolean;
  /** The checkpoint was ahead of this cluster's transaction ids (e.g. a logical restore) and restarted from the origin. */
  readonly rewound: boolean;
  readonly outcomes: Readonly<Record<RatingOutcome, number>>;
  /** Games this batch blocked; a block recorded earlier is counted as `already_blocked` and not listed. */
  readonly blocked: readonly BlockedRating[];
}

export interface RatingsApplierOptions {
  /** Endings read per batch (default 200). */
  readonly batchSize?: number;
}

interface Position {
  readonly xactId: string;
  readonly serverTs: string;
  readonly gameId: string;
}

export class PgRatingsApplier {
  private readonly batchSize: number;

  constructor(private readonly pool: Pool, options: RatingsApplierOptions = {}) {
    this.batchSize = options.batchSize ?? 200;
  }

  /** Age in seconds of the earliest visible ending still after the effective checkpoint. */
  async oldestPendingEndingAgeSeconds(): Promise<number> {
    const state = (await this.pool.query<{ xact_id: string; server_ts: string; game_id: string; horizon: string }>(
      `SELECT xact_id::text AS xact_id, server_ts::text AS server_ts, game_id,
              pg_snapshot_xmin(pg_current_snapshot())::text AS horizon FROM rating_checkpoint`,
    )).rows[0];
    if (!state) throw new Error('rating checkpoint is missing');
    const cursor: Position = BigInt(state.xact_id) >= BigInt(state.horizon)
      ? ORIGIN : { xactId: state.xact_id, serverTs: state.server_ts, gameId: state.game_id };
    // A single ordered index probe sees committed endings even when a long transaction holds the
    // apply horizon behind them. Count(*) would grow in cost with the very backlog being measured.
    const oldest = await this.pool.query<{ age: number }>(
      `SELECT GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - server_ts))::float8 AS age
       FROM game_events WHERE type = 'GameEnded'
         AND (xact_id, server_ts, game_id) > ($1::xid8, $2::timestamptz, $3::uuid)
       ORDER BY xact_id, server_ts, game_id LIMIT 1`,
      [cursor.xactId, cursor.serverTs, cursor.gameId],
    );
    return oldest.rows[0]?.age ?? 0;
  }

  /** Apply the next bounded page of committed endings, in order, in one transaction. */
  runBatch(): Promise<RatingsBatch> {
    return inTransaction(this.pool, async (client) => {
      // First statement, before this transaction owns an id, so the horizon is not capped by it.
      const snapshot = (await client.query<{ horizon: string; next_xid: string; max_ending_xid: string | null }>(
        `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
                pg_snapshot_xmax(pg_current_snapshot())::text AS next_xid,
                (SELECT xact_id::text FROM game_events WHERE type = 'GameEnded'
                 ORDER BY xact_id DESC LIMIT 1) AS max_ending_xid`,
      )).rows[0]!;
      const horizon = snapshot.horizon;
      // A logical restore can preserve event xid8 values above the destination's counter. Such
      // endings are invisible to the committed-prefix scan; continuing could rate new games first.
      if (snapshot.max_ending_xid !== null && BigInt(snapshot.max_ending_xid) >= BigInt(snapshot.next_xid)) {
        throw new Error('ratings stopped: logical restore has game endings beyond this cluster transaction counter; reconcile the restored event order before starting gateways');
      }
      // server_ts travels as text: a JavaScript Date would drop its microseconds and park the cursor
      // just below the row it had passed.
      const locked = await client.query<{ xact_id: string; server_ts: string; game_id: string }>(
        `SELECT xact_id::text AS xact_id, server_ts::text AS server_ts, game_id
         FROM rating_checkpoint FOR UPDATE SKIP LOCKED`,
      );
      const row = locked.rows[0];
      const outcomes: Record<RatingOutcome, number> = { applied: 0, already_applied: 0, ineligible: 0, blocked: 0, already_blocked: 0 };
      if (!row) return { busy: true, more: false, rewound: false, outcomes, blocked: [] };

      // Within one cluster the checkpoint is always below the horizon of any snapshot taken after it
      // committed. At or above it, the ids came from another cluster's counter; replaying from the
      // origin is safe because the ledger refuses every game already applied. The first horizon is
      // not that test: another applier can commit past it while this one waits for the row lock, so
      // the rewind is judged by a horizon read now. The page scan keeps the first horizon, and so
      // finds nothing to do in that case.
      const lockedHorizon = (await client.query<{ horizon: string }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon',
      )).rows[0]!.horizon;
      const rewound = BigInt(row.xact_id) >= BigInt(lockedHorizon);
      const cursor: Position = rewound ? ORIGIN : { xactId: row.xact_id, serverTs: row.server_ts, gameId: row.game_id };

      const page = await client.query<{ xact_id: string; server_ts: string; game_id: string }>(
        `SELECT xact_id::text AS xact_id, server_ts::text AS server_ts, game_id FROM game_events
         WHERE type = 'GameEnded' AND xact_id < $1::xid8
           AND (xact_id, server_ts, game_id) > ($2::xid8, $3::timestamptz, $4::uuid)
         ORDER BY xact_id, server_ts, game_id LIMIT $5`,
        [horizon, cursor.xactId, cursor.serverTs, cursor.gameId, this.batchSize],
      );

      const blocked: BlockedRating[] = [];
      for (const ending of page.rows) {
        const outcome = await rateOne(client, ending.game_id);
        outcomes[outcome.kind] += 1;
        if (outcome.kind === 'blocked') blocked.push({ gameId: ending.game_id, error: outcome.error });
      }

      const last = page.rows.at(-1);
      const next: Position | null = last
        ? { xactId: last.xact_id, serverTs: last.server_ts, gameId: last.game_id }
        : rewound ? ORIGIN : null;
      if (next) {
        await client.query(
          `UPDATE rating_checkpoint SET xact_id = $1::xid8, server_ts = $2::timestamptz, game_id = $3, updated_at = now()`,
          [next.xactId, next.serverTs, next.gameId],
        );
      }
      return { busy: false, more: page.rows.length === this.batchSize, rewound, outcomes, blocked };
    });
  }
}

type OneOutcome =
  | { readonly kind: Exclude<RatingOutcome, 'blocked'> }
  | { readonly kind: 'blocked'; readonly error: string };

async function rateOne(client: PoolClient, gameId: string): Promise<OneOutcome> {
  const priorBlock = await client.query('SELECT 1 FROM rating_blocked_games WHERE game_id = $1', [gameId]);
  if (priorBlock.rowCount) return { kind: 'already_blocked' };
  const priorIneligible = await client.query('SELECT 1 FROM rating_ineligible_games WHERE game_id = $1', [gameId]);
  if (priorIneligible.rowCount) return { kind: 'ineligible' };
  // The ledger is also a sticky decision. Rechecking today's account flags before it would
  // reclassify a previously rated game on rewind and collide with the durable application.
  const priorApplication = await client.query('SELECT 1 FROM rating_applications WHERE game_id = $1', [gameId]);
  if (priorApplication.rowCount) return { kind: 'already_applied' };
  // Loading is outside the block decision: an event version this gateway cannot upcast (a rolling
  // deploy) or any database or driver failure aborts the batch for retry instead of blocking a game.
  const stream = await loadStream(client, gameId);
  let decision: ReturnType<typeof decideRating>;
  try {
    decision = decideRating(gameId, stream);
    if (decision.kind === 'rate') await requireCatalogVariant(client, decision.game);
  } catch (error) {
    // Only a loaded stream proven unrateable makes a sticky block. Anything else, including a
    // rating-table error, is not evidence that the stream is bad; it aborts the batch.
    if (!(error instanceof CorruptGameStreamError)) throw error;
    const created = await client.query(
      'INSERT INTO rating_blocked_games (game_id, error) VALUES ($1, $2) ON CONFLICT (game_id) DO NOTHING',
      [gameId, error.message],
    );
    return created.rowCount ? { kind: 'blocked', error: error.message } : { kind: 'already_blocked' };
  }
  const applied = decision.kind === 'rate' ? await applyRatedGame(client, decision.game) : 'ineligible';
  const reason = decision.kind === 'ineligible' ? decision.reason
    : applied === 'missing_account' || applied === 'bot_account' ? applied : null;
  if (reason !== null) {
    await client.query('INSERT INTO rating_ineligible_games (game_id, reason) VALUES ($1, $2)', [gameId, reason]);
  }
  return { kind: applied === 'applied' || applied === 'already_applied' ? applied : 'ineligible' };
}

/**
 * `ratings.variant` references `variants(code)`, so an ending in any other variant would fail that
 * foreign key on every retry and stop every pool. The table is the catalog the key enforces, so the
 * check cannot drift from it. The payload is untyped at runtime: a non-string is never coerced, since
 * `String(['standard'])` would pass here while the driver writes the array itself.
 */
async function requireCatalogVariant(client: PoolClient, game: RateableGame): Promise<void> {
  const variant: unknown = game.variant;
  if (typeof variant !== 'string') {
    throw new CorruptGameStreamError(game.gameId, `variant ${JSON.stringify(variant)} is not a string`);
  }
  const known = await client.query('SELECT 1 FROM variants WHERE code = $1', [variant]);
  if (!known.rowCount) throw new CorruptGameStreamError(game.gameId, `unsupported variant ${JSON.stringify(variant)}`);
}

/** The result of {@link applyRatedGame}; the last two change nothing. */
export type ApplyRatingResult = 'applied' | 'already_applied' | 'bot_account' | 'missing_account';

/**
 * Apply one rateable game inside the caller's transaction: both pre-game ratings are read and locked,
 * both new ratings are computed from them, and the ledger row and both updates are written together.
 *
 * Rows are created (at the Glicko-2 defaults) and locked one at a time in player-id order, whatever
 * the colours, so two transactions sharing a player always lock in the same order and cannot
 * deadlock. The ledger insert is the exactly-once guard: a concurrent or repeated application of the
 * same game waits for it, then finds it and changes nothing.
 */
export async function applyRatedGame(client: PoolClient, game: RateableGame): Promise<ApplyRatingResult> {
  // KEY SHARE holds both accounts until commit, so a concurrent deletion waits instead of failing
  // the rating insert's foreign key (which would wrongly block the game as bad data).
  const accounts = await client.query<{ bot: boolean }>(
    `SELECT COALESCE(flags->>'bot', 'false') = 'true' AS bot FROM users
     WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`,
    [[game.white, game.black]],
  );
  if (accounts.rows.length < 2) return 'missing_account';
  if (accounts.rows.some((a) => a.bot)) return 'bot_account';

  await client.query('SAVEPOINT apply_rating');
  const before = new Map<string, Glicko2Rating>();
  for (const userId of [game.white, game.black].sort()) {
    before.set(userId, await lockRating(client, userId, game));
  }
  const white = before.get(game.white)!;
  const black = before.get(game.black)!;
  const after = rateGame(white, black, game.whiteScore);

  const claimed = await client.query(
    `INSERT INTO rating_applications (game_id, variant, speed, white_id, black_id, white_score,
       white_rating_before, white_rating_after, black_rating_before, black_rating_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (game_id) DO NOTHING`,
    [game.gameId, game.variant, game.speed, game.white, game.black, game.whiteScore,
      white.rating, after.white.rating, black.rating, after.black.rating],
  );
  if (claimed.rowCount === 0) {
    // Undo any default row created above, so an already-applied game leaves no trace.
    await client.query('ROLLBACK TO SAVEPOINT apply_rating');
    await client.query('RELEASE SAVEPOINT apply_rating');
    return 'already_applied';
  }
  await writeRating(client, game.white, game, after.white);
  await writeRating(client, game.black, game, after.black);
  await client.query('RELEASE SAVEPOINT apply_rating');
  return 'applied';
}

async function lockRating(client: PoolClient, userId: string, pool: RateableGame): Promise<Glicko2Rating> {
  const start = initialRating();
  await client.query(
    `INSERT INTO ratings (user_id, variant, speed, rating, rd, vol) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, variant, speed) DO NOTHING`,
    [userId, pool.variant, pool.speed, start.rating, start.rd, start.vol],
  );
  return (await client.query<Glicko2Rating>(
    'SELECT rating, rd, vol FROM ratings WHERE user_id = $1 AND variant = $2 AND speed = $3 FOR UPDATE',
    [userId, pool.variant, pool.speed],
  )).rows[0]!;
}

async function writeRating(client: PoolClient, userId: string, pool: RateableGame, next: Glicko2Rating): Promise<void> {
  await client.query(
    `UPDATE ratings SET rating = $4, rd = $5, vol = $6, updated_at = now()
     WHERE user_id = $1 AND variant = $2 AND speed = $3`,
    [userId, pool.variant, pool.speed, next.rating, next.rd, next.vol],
  );
}
