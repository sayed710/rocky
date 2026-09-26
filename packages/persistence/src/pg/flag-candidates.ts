/**
 * @packageDocumentation
 * The queue of games whose chess clock is running, by the instant the side to move flags (ADR-0149).
 *
 * `flag_deadlines` is maintained by a `game_events` trigger in the same transaction as every append
 * (migration 0043): each move replaces the game's row with the new side to move's deadline and an
 * ending removes it, so it is exactly as current as the log. The domain stays the rule: the worker
 * re-decides every candidate from the log, and corrects or dismisses a row the log disagrees with.
 * Both corrections are guarded by the log head the worker read, so neither can touch a row a newer
 * move wrote.
 */

import type { Pool } from 'pg';
import type { DeadlineCandidate, DeadlineCandidateQuery } from './no-show-candidates';

export class PgFlagCandidates {
  constructor(private readonly pool: Pool) {}

  /** One page of due games, earliest deadline first, in the same shape as the no-show queue. */
  async due(query: DeadlineCandidateQuery): Promise<DeadlineCandidate[]> {
    const after = query.after ?? { dueAt: new Date(-8_640_000_000_000_000), gameId: '00000000-0000-0000-0000-000000000000' };
    const res = await this.pool.query<{ game_id: string; due_ms: string }>(
      `SELECT game_id, due_ms FROM flag_deadlines
       WHERE due_ms <= $1 AND (due_ms, game_id) > ($2::bigint, $3::uuid)
       ORDER BY due_ms, game_id
       LIMIT $4`,
      [query.dueBy.getTime(), after.dueAt.getTime(), after.gameId, query.limit],
    );
    return res.rows.map((row) => ({ gameId: row.game_id, dueAt: new Date(Number(row.due_ms)) }));
  }

  /** Move a game's deadline to what the log says, unless a move after `headSeq` has replaced it. */
  async reschedule(gameId: string, headSeq: number, dueMs: number): Promise<void> {
    await this.pool.query(
      'UPDATE flag_deadlines SET due_ms = $3 WHERE game_id = $1 AND seq <= $2 AND due_ms <> $3',
      [gameId, headSeq, dueMs],
    );
  }

  /** Remove a game whose log shows no clock that can flag, unless a move after `headSeq` wrote it. */
  async dismiss(gameId: string, headSeq: number): Promise<void> {
    await this.pool.query('DELETE FROM flag_deadlines WHERE game_id = $1 AND seq <= $2', [gameId, headSeq]);
  }
}
