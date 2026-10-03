/**
 * @packageDocumentation
 * Postgres implementation of AntiCheatReportRepository.
 * Hand-written SQL; atomic transaction for saveBatch; (player_id, game_id) PK.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  AntiCheatReportRepository,
  StoredPlayerReport,
  PlayerCorrelationReport,
} from '@chess-platform/anti-cheat';
import { assertTerminalReportFence, lockTerminalReportFence, validateTerminalReportFence, type TerminalReportFence } from './terminal-report-fence';

interface AntiCheatReportDbRow {
  player_id: string;
  game_id: string;
  color: string;
  report: PlayerCorrelationReport;
  created_at: Date;
  updated_at: Date;
}

function toStoredPlayerReport(row: AntiCheatReportDbRow): StoredPlayerReport {
  return {
    gameId: row.game_id,
    playerId: row.player_id,
    color: row.color as 'white' | 'black',
    report: row.report,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore rollback failure */
  }
}

export class PgAntiCheatReportRepository implements AntiCheatReportRepository {
  constructor(private readonly pool: Pool, private readonly fence?: TerminalReportFence) {}

  async saveBatch(records: readonly StoredPlayerReport[]): Promise<void> {
    validateTerminalReportFence(this.fence, 'anti-cheat-analysis', records);
    if (records.length === 0) return;
    const client = await this.pool.connect();
    try {
      this.fence?.signal?.throwIfAborted();
      await client.query('BEGIN');
      if (this.fence) await lockTerminalReportFence(client, this.fence);
      for (const record of records) {
        this.fence?.signal?.throwIfAborted();
        await client.query(
          `INSERT INTO anti_cheat_reports (player_id, game_id, color, report, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (player_id, game_id)
           DO UPDATE SET color = EXCLUDED.color, report = EXCLUDED.report, updated_at = now()`,
          [
            record.playerId,
            record.gameId,
            record.color,
            JSON.stringify(record.report),
          ],
        );
      }
      if (this.fence) await assertTerminalReportFence(client, this.fence);
      this.fence?.signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listByPlayer(playerId: string): Promise<readonly StoredPlayerReport[]> {
    const res = await this.pool.query<AntiCheatReportDbRow>(
      `SELECT game_id, player_id, color, report, created_at, updated_at FROM anti_cheat_reports
       WHERE player_id = $1 ORDER BY created_at ASC, game_id ASC`,
      [playerId],
    );
    return res.rows.map(toStoredPlayerReport);
  }
}
