/**
 * @packageDocumentation
 * Player reports: authenticated intake and a small moderator triage queue (ADR-0152).
 *
 * A report is a request for human review, never a verdict. Nothing here bans, scores or resolves a
 * player, and engine evidence never closes a report: only a moderator transition does.
 */

export const PLAYER_REPORT_REASONS = ['cheating', 'harassment', 'spam', 'other'] as const;
export type PlayerReportReason = (typeof PLAYER_REPORT_REASONS)[number];

export const PLAYER_REPORT_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'] as const;
export type PlayerReportStatus = (typeof PLAYER_REPORT_STATUSES)[number];

/** `claim` takes an open report; `resolve` and `dismiss` close one under review. */
export const PLAYER_REPORT_ACTIONS = ['claim', 'resolve', 'dismiss'] as const;
export type PlayerReportAction = (typeof PLAYER_REPORT_ACTIONS)[number];

export const PLAYER_REPORT_DETAIL_MAX = 1000;
export const PLAYER_REPORT_NOTE_MAX = 2000;

export interface PlayerReportRow {
  readonly id: string;
  readonly reporterId: string;
  readonly subjectId: string;
  readonly gameId: string | null;
  readonly reason: PlayerReportReason;
  readonly detail: string | null;
  readonly status: PlayerReportStatus;
  readonly assignedTo: string | null;
  readonly moderatorNote: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface NewPlayerReport {
  readonly id: string;
  readonly reporterId: string;
  readonly subjectId: string;
  readonly gameId: string | null;
  readonly reason: PlayerReportReason;
  readonly detail: string | null;
  readonly createdAt: Date;
}

/**
 * The audit row a transition writes in the same transaction as the state change, so a decision can
 * never exist without its trail. Identifiers and the state change only — never detail or note text.
 */
export interface PlayerReportAuditRecord {
  readonly id: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface PlayerReportTransition {
  readonly id: string;
  readonly action: PlayerReportAction;
  readonly actorId: string;
  /** Admins may close a report another moderator claimed; moderators only their own. */
  readonly actorIsAdmin: boolean;
  readonly expectedVersion: number;
  readonly note: string | null;
  readonly at: Date;
  readonly audit: PlayerReportAuditRecord;
}

export type PlayerReportTransitionResult =
  | { readonly kind: 'applied'; readonly report: PlayerReportRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict'; readonly current: PlayerReportRow }
  | { readonly kind: 'invalid_transition'; readonly current: PlayerReportRow }
  | { readonly kind: 'not_assignee'; readonly current: PlayerReportRow }
  /** The actor filed the report or is its subject: nobody triages a report they are party to. */
  | { readonly kind: 'conflict_of_interest' };

export interface PlayerReportQuery {
  readonly status: PlayerReportStatus;
  readonly subjectId: string | null;
  /** Leave out reports this player filed or is the subject of: the moderator reading the queue. */
  readonly excludeParty: string;
  /** Keyset cursor: return reports with an id greater than this one. */
  readonly after: string | null;
  readonly limit: number;
}

export interface PlayerReportsRepository {
  create(report: NewPlayerReport): Promise<PlayerReportRow>;
  findById(id: string): Promise<PlayerReportRow | null>;
  /** Oldest first, by id. */
  list(query: PlayerReportQuery): Promise<readonly PlayerReportRow[]>;
  transition(transition: PlayerReportTransition): Promise<PlayerReportTransitionResult>;
}

/** Source and target status of each action; the single definition both implementations use. */
export const PLAYER_REPORT_TRANSITIONS: Readonly<Record<PlayerReportAction, { from: PlayerReportStatus; to: PlayerReportStatus }>> = {
  claim: { from: 'open', to: 'reviewing' },
  resolve: { from: 'reviewing', to: 'resolved' },
  dismiss: { from: 'reviewing', to: 'dismissed' },
};

/**
 * The audit metadata of a transition: identifiers and the state change, never report or note text.
 * `previousAssignee` makes an admin closing someone else's claim visible as such.
 */
export function playerReportAuditMeta(before: PlayerReportRow, after: PlayerReportRow): Record<string, unknown> {
  return {
    subjectId: after.subjectId, from: before.status, to: after.status, version: after.version,
    previousAssignee: before.assignedTo,
  };
}

/**
 * Why a transition is refused, or `undefined` when it may proceed. The single rule both
 * implementations apply, in this order: a party to the report is always refused; a stale version
 * is reported before the state, so a retry of a decision already made answers the same every time.
 */
export function refusePlayerReportTransition(
  current: PlayerReportRow | undefined,
  t: PlayerReportTransition,
): Exclude<PlayerReportTransitionResult, { kind: 'applied' }> | undefined {
  if (!current) return { kind: 'not_found' };
  if (t.actorId === current.subjectId || t.actorId === current.reporterId) return { kind: 'conflict_of_interest' };
  if (current.version !== t.expectedVersion) return { kind: 'version_conflict', current };
  if (current.status !== PLAYER_REPORT_TRANSITIONS[t.action].from) return { kind: 'invalid_transition', current };
  if (t.action !== 'claim' && current.assignedTo !== t.actorId && !t.actorIsAdmin) return { kind: 'not_assignee', current };
  return undefined;
}
