/**
 * @packageDocumentation
 * Head-fenced no-show candidates queue queries and dismissals (Issue #124 Stage M).
 *
 * Separate, unwired source from the live PgNoShowCandidates class.
 * Requires mandatory loadedHead parameter for dismissal and rescheduling, preventing
 * stale workers from dismissing newer rows or recreating absent ones.
 */

import type { Pool } from 'pg';
import type { NoShowCandidate, NoShowCandidateQuery } from './no-show-candidates';

export class PgFencedNoShowCandidates {
  constructor(private readonly pool: Pool) {}

  /** One page of due games, earliest deadline first. */
  async due(query: NoShowCandidateQuery): Promise<NoShowCandidate[]> {
    const after = query.after ?? {
      dueAt: new Date(0),
      gameId: '00000000-0000-0000-0000-000000000000',
    };
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
   * Remove a game waiting for its first move only if the row's establishing sequence
   * does not exceed loadedHead. Does not touch newer rows.
   */
  async dismiss(gameId: string, loadedHead: number): Promise<void> {
    if (!Number.isSafeInteger(loadedHead) || loadedHead < 0) {
      throw new RangeError(`loadedHead must be a non-negative safe integer, got ${String(loadedHead)}`);
    }
    await this.pool.query(
      'DELETE FROM pregame_deadlines WHERE game_id = $1 AND seq <= $2',
      [gameId, loadedHead],
    );
  }

  /**
   * Reschedule deadline only if the row exists and sequence does not exceed loadedHead.
   * Stale correction cannot recreate an absent row.
   */
  async reschedule(gameId: string, loadedHead: number, dueAt: Date): Promise<void> {
    if (!Number.isSafeInteger(loadedHead) || loadedHead < 0) {
      throw new RangeError(`loadedHead must be a non-negative safe integer, got ${String(loadedHead)}`);
    }
    await this.pool.query(
      'UPDATE pregame_deadlines SET due_at = $3, seq = $2 WHERE game_id = $1 AND seq <= $2',
      [gameId, loadedHead, dueAt],
    );
  }
}
