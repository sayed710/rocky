import type { PlayerReportRow } from '@chess-platform/persistence';

/** What a reporter gets back: their own submission, never moderation state or the moderator's note. */
export interface PlayerReportReceiptView {
  readonly id: string;
  readonly subjectId: string;
  readonly gameId: string | null;
  readonly reason: PlayerReportRow['reason'];
  readonly detail: string | null;
  readonly createdAt: string;
}

/** A queue row: who, about whom, why and where it stands — no report text, no note. */
export interface ModerationReportSummaryView {
  readonly id: string;
  readonly reporterId: string;
  readonly subjectId: string;
  readonly gameId: string | null;
  readonly reason: PlayerReportRow['reason'];
  readonly status: PlayerReportRow['status'];
  readonly assignedTo: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** The audited detail view, for moderators only. */
export interface ModerationReportView extends ModerationReportSummaryView {
  readonly detail: string | null;
  readonly moderatorNote: string | null;
}

export function playerReportReceiptView(r: PlayerReportRow): PlayerReportReceiptView {
  return { id: r.id, subjectId: r.subjectId, gameId: r.gameId, reason: r.reason, detail: r.detail, createdAt: r.createdAt.toISOString() };
}

export function moderationReportSummaryView(r: PlayerReportRow): ModerationReportSummaryView {
  return {
    id: r.id, reporterId: r.reporterId, subjectId: r.subjectId, gameId: r.gameId, reason: r.reason,
    status: r.status, assignedTo: r.assignedTo, version: r.version,
    createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null,
  };
}

export function moderationReportView(r: PlayerReportRow): ModerationReportView {
  return { ...moderationReportSummaryView(r), detail: r.detail, moderatorNote: r.moderatorNote };
}
