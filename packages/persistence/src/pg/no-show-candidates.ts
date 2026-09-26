/**
 * @packageDocumentation
 * Finds games that may have passed their pregame no-show deadline (ADR-0148).
 *
 * Reads the `games` projection (ADR-0147), not the event log: `games_pregame_pending_idx` holds only
 * sourced games with no result and no move, so a scan stays proportional to the games actually
 * waiting rather than to history. The projection may lag the log, which is safe in both directions:
 * a game it still lists may already have moved or ended, and the caller re-decides every candidate
 * from the durable event log before acting. A game it has not listed yet is found on a later scan.
 */

import type { Pool } from 'pg';
import type { GameSource } from '@chess-platform/game';

export interface NoShowCandidate {
  readonly gameId: string;
  readonly source: GameSource;
  readonly startedAt: Date;
}

/** A keyset position in `(started_at, id)` order. */
export interface NoShowCursor {
  readonly startedAt: Date;
  readonly gameId: string;
}

export interface NoShowCandidateQuery {
  /** Seek games created at or before this instant are due. */
  readonly seekDueBy: Date;
  /** Tournament games created at or before this instant are due. */
  readonly tournamentDueBy: Date;
  /** Resume strictly after this position; `null` starts from the oldest. */
  readonly after: NoShowCursor | null;
  readonly limit: number;
}

export class PgNoShowCandidates {
  constructor(private readonly pool: Pool) {}

  /** One page of possibly-due pregame games, oldest first. */
  async due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]> {
    const after = query.after ?? { startedAt: new Date(0), gameId: '00000000-0000-0000-0000-000000000000' };
    const res = await this.pool.query<{ id: string; source: GameSource; started_at: Date }>(
      `SELECT id, source, started_at FROM games
       WHERE source IS NOT NULL AND result IS NULL AND ply_count = 0
         AND started_at <= GREATEST($1::timestamptz, $2::timestamptz)
         AND ((source = 'seek' AND started_at <= $1) OR (source = 'tournament' AND started_at <= $2))
         AND (started_at, id) > ($3::timestamptz, $4::uuid)
       ORDER BY started_at, id
       LIMIT $5`,
      [query.seekDueBy, query.tournamentDueBy, after.startedAt, after.gameId, query.limit],
    );
    return res.rows.map((row) => ({ gameId: row.id, source: row.source, startedAt: row.started_at }));
  }
}
