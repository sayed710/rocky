import type { Pool } from 'pg';
import { upcast, type TerminalEventWork, type TerminalEventInbox } from '../event-store';

interface TerminalRow {
  game_id: string;
  seq: number;
  event_version: number;
  payload: unknown;
  server_ts: Date;
}

/** PostgreSQL event rows are the work queue; receipts only suppress completed replays. */
export class PgTerminalEventInbox implements TerminalEventInbox {
  constructor(private readonly pool: Pool) {}

  async pendingAfter(
    consumer: string,
    after: { readonly gameId: string; readonly seq: number } | null,
    limit: number,
  ): Promise<TerminalEventWork[]> {
    const res = await this.pool.query<TerminalRow>(
      `SELECT ended.game_id, ended.seq, ended.event_version, ended.payload, ended.server_ts
       FROM game_events AS ended
       WHERE ended.type = 'GameEnded'
         AND ($2::uuid IS NULL OR (ended.game_id, ended.seq) > ($2::uuid, $3::integer))
         AND NOT EXISTS (
           SELECT 1 FROM terminal_event_receipts AS receipt
           WHERE receipt.consumer = $1 AND receipt.game_id = ended.game_id AND receipt.seq = ended.seq
         )
       ORDER BY ended.game_id, ended.seq LIMIT $4`,
      [consumer, after?.gameId ?? null, after?.seq ?? null, limit],
    );
    return res.rows.map((row) => {
      try {
        return { stored: {
          gameId: row.game_id,
          seq: Number(row.seq),
          version: Number(row.event_version),
          event: upcast('GameEnded', Number(row.event_version), row.payload),
          serverTs: row.server_ts.getTime(),
        } };
      } catch (error) {
        return { gameId: row.game_id, seq: Number(row.seq), decodeError: String(error) };
      }
    });
  }

  async acknowledge(consumer: string, gameId: string, seq: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO terminal_event_receipts (consumer, game_id, seq)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [consumer, gameId, seq],
    );
  }
}
