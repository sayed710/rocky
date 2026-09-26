/**
 * @packageDocumentation
 * The queue of games waiting for their first move, by no-show deadline (ADR-0148).
 *
 * `pregame_deadlines` is maintained by a `game_events` trigger in the same transaction as every
 * append (migration 0042): a sourced creation enters it with `at + noShowAfterMs`, the first move or
 * any ending leaves it. It is therefore exactly as current as the log. The caller still re-decides
 * each candidate from the log before acting, and dismisses one the rule says will never expire.
 */

import type { Pool } from 'pg';

export interface NoShowCandidate {
  readonly gameId: string;
  readonly dueAt: Date;
}

/** A keyset position in `(due_at, game_id)` order. */
export interface NoShowCursor {
  readonly dueAt: Date;
  readonly gameId: string;
}

export interface NoShowCandidateQuery {
  /** Games whose deadline is at or before this instant are due. */
  readonly dueBy: Date;
  /** Resume strictly after this position; `null` starts from the earliest deadline. */
  readonly after: NoShowCursor | null;
  readonly limit: number;
}

export class PgNoShowCandidates {
  constructor(private readonly pool: Pool) {}

  /** One page of due games, earliest deadline first. */
  async due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]> {
    const after = query.after ?? { dueAt: new Date(0), gameId: '00000000-0000-0000-0000-000000000000' };
    const res = await this.pool.query<{ game_id: string; due_at: Date }>(
      `SELECT game_id, due_at FROM pregame_deadlines
       WHERE due_at <= $1 AND (due_at, game_id) > ($2::timestamptz, $3::uuid)
       ORDER BY due_at, game_id
       LIMIT $4`,
      [query.dueBy, after.dueAt, after.gameId, query.limit],
    );
    return res.rows.map((row) => ({ gameId: row.game_id, dueAt: row.due_at }));
  }

  /**
   * Remove a game the log shows will never expire: a tournament game whose players were both ready
   * before the deadline (readiness never reverts), or one that has already started or ended.
   */
  async dismiss(gameId: string): Promise<void> {
    await this.pool.query('DELETE FROM pregame_deadlines WHERE game_id = $1', [gameId]);
  }
}
