import type { Pool } from 'pg';
import {
  PLAYER_REPORT_TRANSITIONS,
  playerReportAuditMeta,
  refusePlayerReportTransition,
  type NewPlayerReport,
  type PlayerReportQuery,
  type PlayerReportRow,
  type PlayerReportsRepository,
  type PlayerReportTransition,
  type PlayerReportTransitionResult,
} from '../player-reports';

const COLUMNS = `id, reporter_id AS "reporterId", subject_id AS "subjectId", game_id AS "gameId", reason,
  detail, status, assigned_to AS "assignedTo", moderator_note AS "moderatorNote", version,
  created_at AS "createdAt", closed_at AS "closedAt"`;

/** Postgres-backed {@link PlayerReportsRepository}. */
export class PgPlayerReportsRepository implements PlayerReportsRepository {
  constructor(private readonly pool: Pool) {}

  async create(report: NewPlayerReport): Promise<PlayerReportRow> {
    const { rows } = await this.pool.query<PlayerReportRow>(
      `INSERT INTO player_reports (id, reporter_id, subject_id, game_id, reason, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [report.id, report.reporterId, report.subjectId, report.gameId, report.reason, report.detail, report.createdAt],
    );
    return rows[0]!;
  }

  async findById(id: string): Promise<PlayerReportRow | null> {
    const { rows } = await this.pool.query<PlayerReportRow>(`SELECT ${COLUMNS} FROM player_reports WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async list(query: PlayerReportQuery): Promise<readonly PlayerReportRow[]> {
    const { rows } = await this.pool.query<PlayerReportRow>(
      `SELECT ${COLUMNS} FROM player_reports
       WHERE status = $1 AND ($2::uuid IS NULL OR subject_id = $2) AND ($3::uuid IS NULL OR id > $3)
         AND subject_id <> $5 AND reporter_id <> $5
       ORDER BY id LIMIT $4`,
      [query.status, query.subjectId, query.after, query.limit, query.excludeParty],
    );
    return rows;
  }

  /** Lock the row, apply {@link refusePlayerReportTransition}, then write the change and its audit row together. */
  async transition(t: PlayerReportTransition): Promise<PlayerReportTransitionResult> {
    const { to } = PLAYER_REPORT_TRANSITIONS[t.action];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query<PlayerReportRow>(
        `SELECT ${COLUMNS} FROM player_reports WHERE id = $1 FOR UPDATE`, [t.id],
      )).rows[0];
      const refused = refusePlayerReportTransition(current, t);
      if (refused || !current) {
        await client.query('ROLLBACK');
        return refused ?? { kind: 'not_found' };
      }
      const closing = t.action !== 'claim';
      const report = (await client.query<PlayerReportRow>(
        `UPDATE player_reports
            SET status = $2,
                assigned_to = CASE WHEN $3 THEN assigned_to ELSE $4::uuid END,
                moderator_note = CASE WHEN $3 THEN $5 ELSE moderator_note END,
                closed_at = CASE WHEN $3 THEN $6::timestamptz ELSE NULL END,
                version = version + 1
          WHERE id = $1 AND version = $7
      RETURNING ${COLUMNS}`,
        [t.id, to, closing, t.actorId, t.note, t.at, t.expectedVersion],
      )).rows[0]!;
      await client.query(
        `INSERT INTO audit_log (id, actor_id, action, target, meta, request_id, trace_id, ip, user_agent, ts)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          t.audit.id, t.actorId, `player_reports.${t.action}`, t.id,
          JSON.stringify(playerReportAuditMeta(current, report)),
          t.audit.requestId, t.audit.traceId, t.audit.ip, t.audit.userAgent, t.at,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'applied', report };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
