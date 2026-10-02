import {
  PLAYER_REPORT_TRANSITIONS,
  refusePlayerReportTransition,
  type NewPlayerReport,
  type PlayerReportQuery,
  type PlayerReportRow,
  type PlayerReportsRepository,
  type PlayerReportTransition,
  type PlayerReportTransitionResult,
} from './player-reports';

/** The audit row a transition writes, handed to the caller's sink in the same synchronous step. */
export interface PlayerReportAuditEvent {
  readonly transition: PlayerReportTransition;
  readonly before: PlayerReportRow;
  readonly report: PlayerReportRow;
}

/** Deterministic repository for API tests; each transition is one synchronous step. */
export class InMemoryPlayerReportsRepository implements PlayerReportsRepository {
  private readonly rows = new Map<string, PlayerReportRow>();

  constructor(private readonly onAudit: (event: PlayerReportAuditEvent) => void = () => {}) {}

  async create(report: NewPlayerReport): Promise<PlayerReportRow> {
    const row: PlayerReportRow = {
      ...report, status: 'open', assignedTo: null, moderatorNote: null, version: 1, closedAt: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<PlayerReportRow | null> {
    return this.rows.get(id) ?? null;
  }

  async list(query: PlayerReportQuery): Promise<readonly PlayerReportRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === query.status
        && (query.subjectId === null || row.subjectId === query.subjectId)
        && row.subjectId !== query.excludeParty && row.reporterId !== query.excludeParty
        && (query.after === null || row.id > query.after))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, query.limit);
  }

  async transition(t: PlayerReportTransition): Promise<PlayerReportTransitionResult> {
    const { to } = PLAYER_REPORT_TRANSITIONS[t.action];
    const current = this.rows.get(t.id);
    const refused = refusePlayerReportTransition(current, t);
    if (refused || !current) return refused ?? { kind: 'not_found' };
    const closing = t.action !== 'claim';
    const report: PlayerReportRow = {
      ...current,
      status: to,
      assignedTo: closing ? current.assignedTo : t.actorId,
      moderatorNote: closing ? t.note : current.moderatorNote,
      closedAt: closing ? t.at : null,
      version: current.version + 1,
    };
    this.onAudit({ transition: t, before: current, report });
    this.rows.set(report.id, report);
    return { kind: 'applied', report };
  }
}
