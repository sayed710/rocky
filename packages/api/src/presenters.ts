/**
 * @packageDocumentation
 * Presenters map internal row types to the stable public JSON shapes returned by
 * the API. Keeping serialization in one place means the wire contract (and the
 * OpenAPI schemas that describe it) never drifts from what handlers emit, and no
 * sensitive column (password/refresh hashes, raw email) is ever exposed.
 */

import type {
  GameSummaryRow,
  RatingRow,
  Role,
  SeekRow,
  SessionRow,
  UserRow,
} from '@chess-platform/persistence';
import type {
  PlayerCorrelationReport,
  GameCorrelationReport,
  PlayerAggregateReport,
  StoredPlayerReport,
  Suspicion,
  BotAggregateReport,
  StoredBotReport,
  GameBotReport,
  BotBehaviorReport,
} from '@chess-platform/anti-cheat';

import { classifySpeed } from '@chess-platform/game';
import { VARIANTS } from './domain.js';
import type { GameReviewClassification, GameReviewSummary } from './game-review/classification.js';

/** Public user view (safe for any caller). */
export interface PublicUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    country: user.country,
    createdAt: user.createdAt.toISOString(),
  };
}

/** The caller's own account view, including granted roles. */
export interface SelfUser extends PublicUser {
  readonly roles: readonly Role[];
}

export function selfUser(user: UserRow, roles: readonly Role[]): SelfUser {
  return { ...publicUser(user), roles: [...roles] };
}

/** A rating on the public 1500-centered scale. */
export interface RatingView {
  readonly variant: string;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: string | null;
}

export function ratingView(row: RatingRow): RatingView {
  return {
    variant: row.variant,
    rating: round2(row.rating),
    rd: round2(row.rd),
    vol: round4(row.vol),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A leaderboard entry pairs a user handle with a rating. */
export interface LeaderboardEntry {
  readonly userId: string;
  readonly variant: string;
  readonly rating: number;
  readonly rd: number;
}

export function leaderboardEntry(row: RatingRow): LeaderboardEntry {
  return { userId: row.userId, variant: row.variant, rating: round2(row.rating), rd: round2(row.rd) };
}

/** A session view for the account-security screen. */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
  /**
   * Where the session was signed in from. Nothing populates the `last*` fields today, so these are
   * what the account-security screen can actually identify a session by; they are always present
   * for a session created through a real request.
   */
  readonly createdIp: string | null;
  readonly createdUserAgent: string | null;
}

export function sessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastIp: row.lastIp,
    lastUserAgent: row.lastUserAgent,
    createdIp: row.createdIp,
    createdUserAgent: row.createdUserAgent,
  };
}

/** A lobby seek view, enriched with the derived speed bucket and creator display identity. */
export interface SeekView {
  readonly id: string;
  readonly creatorId: string;
  /**
   * Human-readable handle of the seek creator. Allows the lobby UI to render opponent identity
   * without relying on an optional GraphQL read layer. Null for unresolvable/deleted users.
   */
  readonly creatorHandle: string | null;
  readonly variant: string;
  readonly speed: string;
  readonly timeControl: SeekRow['timeControl'];
  readonly rated: boolean;
  readonly color: SeekRow['color'];
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: string;
  readonly gameId: string | null;
  readonly acceptedAt: string | null;
}

/**
 * Presenter projecting a database SeekRow into a JSON-serializable SeekView.
 *
 * @param row - The seek persistence row to project
 * @returns Serialized seek view for HTTP responses
 */
export function seekView(row: SeekRow): SeekView {
  return {
    id: row.id,
    creatorId: row.creatorId,
    creatorHandle: row.creatorHandle ?? null,
    variant: row.variant,
    speed: classifySpeed(row.timeControl),
    timeControl: row.timeControl,
    rated: row.rated,
    color: row.color,
    minRating: row.minRating,
    maxRating: row.maxRating,
    createdAt: row.createdAt.toISOString(),
    gameId: row.gameId,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}

/** A finished/ongoing game summary view. */
export interface GameSummaryView {
  readonly id: string;
  readonly variant: string;
  readonly rated: boolean;
  readonly speed: string;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly result: string | null;
  readonly termination: string | null;
  readonly plyCount: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export function gameSummaryView(row: GameSummaryRow): GameSummaryView {
  return {
    id: row.id,
    variant: row.variant,
    rated: row.rated,
    speed: row.speed,
    whiteId: row.whiteId,
    blackId: row.blackId,
    result: row.result,
    termination: row.termination,
    plyCount: row.plyCount,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

/** View of an account-level aggregated anti-cheat report. */
export interface AntiCheatAggregateView {
  readonly playerId: string;
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  readonly pooledSampleSize: number;
  readonly pooledTRateSampleCount: number;
  readonly acpl: number;
  readonly acplCapped: number;
  readonly t1Rate: number;
  readonly t3Rate: number;
  readonly lowConfidence: boolean;
  readonly flaggedGameIds: string[];
}

export function antiCheatAggregateView(
  playerId: string,
  r: PlayerAggregateReport,
): AntiCheatAggregateView {
  return {
    playerId,
    suspicion: r.suspicion,
    gamesAnalyzed: r.gamesAnalyzed,
    pooledSampleSize: r.pooledSampleSize,
    pooledTRateSampleCount: r.pooledTRateSampleCount,
    acpl: r.acpl,
    acplCapped: r.acplCapped,
    t1Rate: r.t1Rate,
    t3Rate: r.t3Rate,
    lowConfidence: r.lowConfidence,
    flaggedGameIds: [...r.flaggedGameIds],
  };
}

/** View of a per-game stored player anti-cheat report. */
export interface AntiCheatGameReportView {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: PlayerCorrelationReport;
}

export function antiCheatGameReportView(
  s: StoredPlayerReport,
): AntiCheatGameReportView {
  return {
    gameId: s.gameId,
    playerId: s.playerId,
    color: s.color,
    report: s.report,
  };
}

export interface AntiCheatGameAnalysisView {
  readonly white: PlayerCorrelationReport;
  readonly black: PlayerCorrelationReport;
}

export function antiCheatGameAnalysisView(
  report: GameCorrelationReport,
): AntiCheatGameAnalysisView {
  return {
    white: report.white,
    black: report.black,
  };
}

/** View of an account-level aggregated bot-detection report. */
export interface BotAggregateView {
  readonly playerId: string;
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  readonly pooledSampleSize: number;
  readonly pooledMeanMs: number;
  readonly pooledStdevMs: number;
  readonly pooledCoefficientOfVariation: number;
  readonly pooledInstantMoves: number;
  readonly pooledInstantFraction: number;
  readonly lowConfidence: boolean;
  readonly flaggedGameIds: string[];
}

export function botAggregateView(
  playerId: string,
  r: BotAggregateReport,
): BotAggregateView {
  return {
    playerId,
    suspicion: r.suspicion,
    gamesAnalyzed: r.gamesAnalyzed,
    pooledSampleSize: r.pooledSampleSize,
    pooledMeanMs: r.pooledMeanMs,
    pooledStdevMs: r.pooledStdevMs,
    pooledCoefficientOfVariation: r.pooledCoefficientOfVariation,
    pooledInstantMoves: r.pooledInstantMoves,
    pooledInstantFraction: r.pooledInstantFraction,
    lowConfidence: r.lowConfidence,
    flaggedGameIds: [...r.flaggedGameIds],
  };
}

/** View of a per-game stored player bot behavior report. */
export interface BotGameReportView {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: BotBehaviorReport;
}

export function botGameReportView(
  s: StoredBotReport,
): BotGameReportView {
  return {
    gameId: s.gameId,
    playerId: s.playerId,
    color: s.color,
    report: s.report,
  };
}

export interface BotGameAnalysisView {
  readonly white: BotBehaviorReport;
  readonly black: BotBehaviorReport;
}

export function botGameAnalysisView(
  r: GameBotReport,
): BotGameAnalysisView {
  return {
    white: r.white,
    black: r.black,
  };
}


function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface FollowEdgeView {
  readonly followerId: string;
  readonly followeeId: string;
  readonly followedAt: string;
}

export function followEdgeView(edge: import('@chess-platform/social').FollowEdge): FollowEdgeView {
  return {
    followerId: edge.followerId,
    followeeId: edge.followeeId,
    followedAt: edge.followedAt.toISOString(),
  };
}

export interface FriendRequestView {
  readonly id: string;
  readonly requesterId: string;
  readonly addresseeId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export function friendRequestView(req: import('@chess-platform/social').FriendRequest): FriendRequestView {
  return {
    id: req.id,
    requesterId: req.requesterId,
    addresseeId: req.addresseeId,
    status: req.status,
    createdAt: req.createdAt.toISOString(),
    respondedAt: req.respondedAt ? req.respondedAt.toISOString() : null,
  };
}

export interface BlockEdgeView {
  readonly blockerId: string;
  readonly blockedId: string;
  readonly blockedAt: string;
}

export function blockEdgeView(edge: import('@chess-platform/social').BlockEdge): BlockEdgeView {
  return {
    blockerId: edge.blockerId,
    blockedId: edge.blockedId,
    blockedAt: edge.blockedAt.toISOString(),
  };
}

export interface ConversationView {
  readonly id: string;
  readonly participantA: string;
  readonly participantB: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
}

export function conversationView(c: import('@chess-platform/messaging').Conversation): ConversationView {
  return {
    id: c.id,
    participantA: c.participantA,
    participantB: c.participantB,
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export function messageView(m: import('@chess-platform/messaging').Message): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    sentAt: m.sentAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
  };
}

export interface ConversationSummaryView {
  readonly conversation: ConversationView;
  readonly unreadCount: number;
  readonly lastMessage: MessageView | null;
}

export function conversationSummaryView(
  s: import('@chess-platform/messaging').ConversationSummary
): ConversationSummaryView {
  return {
    conversation: conversationView(s.conversation),
    unreadCount: s.unreadCount,
    lastMessage: s.lastMessage ? messageView(s.lastMessage) : null,
  };
}

export interface ConversationReadStateView {
  readonly conversationId: string;
  readonly participantId: string;
  readonly lastReadAt: string;
}

export function conversationReadStateView(
  r: import('@chess-platform/messaging').ConversationReadState
): ConversationReadStateView {
  return {
    conversationId: r.conversationId,
    participantId: r.participantId,
    lastReadAt: r.lastReadAt.toISOString(),
  };
}

export interface TeamView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export function teamView(t: import('@chess-platform/community').Team): TeamView {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    visibility: t.visibility,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

export interface TeamDetailView extends TeamView {
  readonly viewerRole: 'owner' | 'admin' | 'member' | null;
}

/**
 * The team plus the viewer's own role in it.
 *
 * The client used to answer "what may I do here" by searching the member list it had already
 * fetched, which is wrong in a way that only shows up on large teams: that list is paginated and
 * sorted owner → admin → member, so an ordinary member of a 60-person team is not on the page the
 * client reads, and the UI offers them a Join button for a team they are already in. Membership is a
 * fact about the viewer, not something to infer from a page of other people.
 */
export function teamDetailView(
  t: import('@chess-platform/community').Team,
  viewerRole: 'owner' | 'admin' | 'member' | null
): TeamDetailView {
  return { ...teamView(t), viewerRole };
}

export interface MembershipView {
  readonly teamId: string;
  readonly playerId: string;
  readonly role: string;
  readonly joinedAt: string;
}

export function membershipView(m: import('@chess-platform/community').Membership): MembershipView {
  return {
    teamId: m.teamId,
    playerId: m.playerId,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  };
}

export interface JoinRequestView {
  readonly id: string;
  readonly teamId: string;
  readonly playerId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export function joinRequestView(j: import('@chess-platform/community').JoinRequest): JoinRequestView {
  return {
    id: j.id,
    teamId: j.teamId,
    playerId: j.playerId,
    status: j.status,
    createdAt: j.createdAt.toISOString(),
    respondedAt: j.respondedAt ? j.respondedAt.toISOString() : null,
  };
}

export interface ForumThreadView {
  readonly id: string;
  readonly teamId: string;
  readonly authorId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastPostAt: string;
  readonly locked: boolean;
  readonly pinned: boolean;
  readonly deletedAt: string | null;
}

export function forumThreadView(th: import('@chess-platform/community').ForumThread): ForumThreadView {
  return {
    id: th.id,
    teamId: th.teamId,
    authorId: th.authorId,
    title: th.title,
    createdAt: th.createdAt.toISOString(),
    lastPostAt: th.lastPostAt.toISOString(),
    locked: th.locked,
    pinned: th.pinned,
    deletedAt: th.deletedAt ? th.deletedAt.toISOString() : null,
  };
}

export interface ForumPostView {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export function forumPostView(p: import('@chess-platform/community').ForumPost): ForumPostView {
  return {
    id: p.id,
    threadId: p.threadId,
    authorId: p.authorId,
    body: p.body,
    createdAt: p.createdAt.toISOString(),
    editedAt: p.editedAt ? p.editedAt.toISOString() : null,
    deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
  };
}

export interface AchievementDefinitionView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
}

export function achievementDefinitionView(def: import('@chess-platform/achievements').AchievementDefinition): AchievementDefinitionView {
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    category: def.category,
    tier: def.tier,
    points: def.points,
    hidden: def.hidden,
    ...(def.target !== undefined ? { target: def.target } : {}),
  };
}

export interface PlayerAchievementViewPresenter {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
  readonly progress: number;
  readonly unlockedAt: string | null;
}

export function playerAchievementView(item: import('@chess-platform/achievements').PlayerAchievementView): PlayerAchievementViewPresenter {
  return {
    key: item.key,
    name: item.name,
    description: item.description,
    category: item.category,
    tier: item.tier,
    points: item.points,
    hidden: item.hidden,
    ...(item.target !== undefined ? { target: item.target } : {}),
    progress: item.progress,
    unlockedAt: item.unlockedAt ? item.unlockedAt.toISOString() : null,
  };
}

export interface AchievementSummaryView {
  readonly unlockedCount: number;
  readonly pointsTotal: number;
}

export function achievementSummaryView(summary: import('@chess-platform/achievements').AchievementSummary): AchievementSummaryView {
  return {
    unlockedCount: summary.unlockedCount,
    pointsTotal: summary.pointsTotal,
  };
}

export interface StudyView {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: string;
  readonly variant: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export function studyView(s: import('@chess-platform/studies').Study): StudyView {
  return {
    id: s.id,
    ownerId: s.ownerId,
    name: s.name,
    description: s.description,
    visibility: s.visibility,
    variant: s.variant,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface CollaboratorView {
  readonly studyId: string;
  readonly playerId: string;
  readonly role: string;
}

export function collaboratorView(c: import('@chess-platform/studies').Collaborator): CollaboratorView {
  return {
    studyId: c.studyId,
    playerId: c.playerId,
    role: c.role,
  };
}

export interface ChapterView {
  readonly id: string;
  readonly studyId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly startingFen: string;
  readonly deletedAt?: string;
}

export function chapterView(c: import('@chess-platform/studies').Chapter): ChapterView {
  return {
    id: c.id,
    studyId: c.studyId,
    name: c.name,
    orderIndex: c.orderIndex,
    startingFen: c.startingFen,
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
  };
}

export interface TreeNodeView {
  readonly id: string;
  readonly chapterId: string;
  readonly parentId: string | null;
  readonly san: string;
  readonly fenAfter: string;
  readonly comment?: string;
  readonly nags: readonly number[];
  readonly orderIndex: number;
}

export function treeNodeView(n: import('@chess-platform/studies').TreeNode): TreeNodeView {
  return {
    id: n.id,
    chapterId: n.chapterId,
    parentId: n.parentId,
    san: n.san,
    fenAfter: n.fenAfter,
    ...(n.comment !== undefined ? { comment: n.comment } : {}),
    nags: [...n.nags],
    orderIndex: n.orderIndex,
  };
}

export interface ChapterDetailView {
  readonly chapter: ChapterView;
  readonly tree: readonly TreeNodeView[];
}

export function chapterDetailView(detail: {
  chapter: import('@chess-platform/studies').Chapter;
  tree: readonly import('@chess-platform/studies').TreeNode[];
}): ChapterDetailView {
  return {
    chapter: chapterView(detail.chapter),
    tree: detail.tree.map(treeNodeView),
  };
}

export interface CourseView {
  readonly id: string;
  readonly authorId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly difficulty: string;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export function courseView(c: import('@chess-platform/learning').Course): CourseView {
  return {
    id: c.id,
    authorId: c.authorId,
    slug: c.slug,
    title: c.title,
    description: c.description,
    difficulty: c.difficulty,
    published: c.published,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
  };
}

export interface LessonView {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly deletedAt?: string;
}

export function lessonView(l: import('@chess-platform/learning').Lesson): LessonView {
  return {
    id: l.id,
    courseId: l.courseId,
    title: l.title,
    orderIndex: l.orderIndex,
    ...(l.deletedAt ? { deletedAt: l.deletedAt.toISOString() } : {}),
  };
}

export interface StepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text' | 'move' | 'quiz';
  readonly prose?: string;
  readonly fen?: string;
  readonly expectedSan?: string;
  readonly hint?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly correctIndex?: number;
  readonly deletedAt?: string;
}

export function stepView(s: import('@chess-platform/learning').LessonStep): StepView {
  return {
    id: s.id,
    lessonId: s.lessonId,
    orderIndex: s.orderIndex,
    kind: s.kind,
    ...(s.kind === 'text' ? { prose: s.prose } : {}),
    ...(s.kind === 'move' ? { fen: s.fen, expectedSan: s.expectedSan, ...(s.hint ? { hint: s.hint } : {}) } : {}),
    ...(s.kind === 'quiz' ? { question: s.question, options: [...s.options], correctIndex: s.correctIndex } : {}),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface LearnerStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text' | 'move' | 'quiz';
  readonly prose?: string;
  readonly fen?: string;
  readonly hint?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly deletedAt?: string;
}

export function learnerStepView(s: import('@chess-platform/learning').LessonStep): LearnerStepView {
  return {
    id: s.id,
    lessonId: s.lessonId,
    orderIndex: s.orderIndex,
    kind: s.kind,
    ...(s.kind === 'text' ? { prose: s.prose } : {}),
    ...(s.kind === 'move' ? { fen: s.fen, ...(s.hint ? { hint: s.hint } : {}) } : {}),
    ...(s.kind === 'quiz' ? { question: s.question, options: [...s.options] } : {}),
    ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
  };
}

export interface ProgressView {
  readonly playerId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly stepId: string;
  readonly completedAt?: string;
  readonly attempts: number;
}

export function progressView(p: import('@chess-platform/learning').Progress): ProgressView {
  return {
    playerId: p.playerId,
    courseId: p.courseId,
    lessonId: p.lessonId,
    stepId: p.stepId,
    attempts: p.attempts,
    ...(p.completedAt ? { completedAt: p.completedAt.toISOString() } : {}),
  };
}

export interface CourseProgressSummaryView {
  readonly courseId: string;
  readonly playerId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
}

export function courseProgressSummaryView(
  s: import('@chess-platform/learning').CourseProgressSummary
): CourseProgressSummaryView {
  return {
    courseId: s.courseId,
    playerId: s.playerId,
    totalSteps: s.totalSteps,
    completedSteps: s.completedSteps,
  };
}

export interface AttemptResultView {
  readonly stepId: string;
  readonly correct: boolean;
  readonly completedAt?: string;
  readonly attempts: number;
}

export function attemptResultView(r: import('@chess-platform/learning').AttemptResult): AttemptResultView {
  return {
    stepId: r.stepId,
    correct: r.correct,
    attempts: r.attempts,
    ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
  };
}

export interface CapabilitiesFlags {
  readonly learning: boolean;
  readonly studies: boolean;
  readonly achievements: boolean;
  readonly search: boolean;
  /**
   * Semantic and hybrid search modes (ADR-0132; the modes themselves are ADR-0060).
   *
   * Independent of {@link CapabilitiesFlags.search}, and the one flag here that a client must not
   * infer from another. `GET /v1/search` serves three modes from two different dependency sets:
   * keyword needs the search repository, while semantic and hybrid need a vector repository *and* an
   * embedding provider, which the composition root gates on `SEMANTIC_SEARCH_ENABLED` rather than on
   * `SEARCH_ENABLED`. The Helm chart offers that as `search.semanticEnabled`, so a deployment with
   * working keyword search and both other modes answering 503 is a supported configuration, not a
   * misconfiguration — and before this flag existed it was one the wire could not describe.
   */
  readonly semanticSearch: boolean;
  readonly social: boolean;
  readonly messaging: boolean;
  readonly community: boolean;
  readonly analysis: boolean;
  /**
   * Engine-grounded move explanation (ADR-0115).
   *
   * Implies `analysis`, and cannot be true without it: an explanation is grounded in engine output,
   * so the composition root builds the feature only when both an AI provider and the analysis
   * subsystem are configured. The variants it can serve are therefore exactly `analysisVariants` —
   * a second list would be the same list, kept in a second place, free to drift.
   */
  readonly moveExplanation: boolean;
  /**
   * Engine-grounded mistake prediction (ADR-0118).
   *
   * Implies `analysis` and is implied *by* it: the verdict is a rules-and-engine fact with no
   * provider call anywhere on its path, so this is true on exactly the deployments that can analyse.
   * It is still published as its own flag rather than left for a client to infer from `analysis`,
   * because a client that infers a capability is a client that keeps working after the inference
   * stops being true. The variants it can serve are `analysisVariants`.
   */
  readonly mistakePrediction: boolean;
  /** Fixed-policy, engine-only tactic discovery (ADR-0125). */
  readonly puzzleGeneration: boolean;
  /**
   * Bundled opening identification (ADR-0127).
   *
   * Alone among the feature flags here it does not imply `analysis`, and is not implied by it: the
   * answer is a table lookup and a legality replay, so it is true on a deployment with no engine
   * binary and false on one whose bundled dataset is empty however good its engine is. There is no
   * variant list beside it because there is nothing to list — the feature serves exactly
   * `standard`, and a one-element array would invite a client to treat it as a set that could grow
   * without the server saying so.
   */
  readonly openingExplorer: boolean;
  /** Curated endgame training positions and attempt evaluation (ADR-0128). */
  readonly endgameTrainer: boolean;
  /**
   * Coaching that orchestrates the other feature flags above (ADR-0129).
   *
   * True when *any* of `moveExplanation`, `mistakePrediction`, `puzzleGeneration`,
   * `openingExplorer` or `endgameTrainer` is, because the Coach owns no dependency of its own and
   * reports each section's availability individually inside the response. So this is not a promise
   * that every section will answer — it is the narrower claim that at least one can, which is the
   * only claim a single boolean can honestly make about five features. A client that needs to know
   * which sections to expect reads the five flags, not this one.
   */
  readonly coach: boolean;
  /** Private durable Study Partner sessions over the production coaching policy. */
  readonly studyPartner: boolean;
  /**
   * Engine-cited commentary on finished tournament games, and narrative round recaps (ADR-0130).
   *
   * Implies both `analysis` and `moveExplanation`, and for the same reason each of those implies
   * what it does: the feature needs an engine to cite and a provider to write with, and composes to
   * `undefined` when either is missing. There is no partial mode — a recap with no provider is not
   * a shorter recap, it is silence — so one flag covers both routes.
   */
  readonly tournamentCommentary: boolean;
  /** Private, fixed-policy review of a completed game for one of its players. */
  readonly gameReview: boolean;
}

/**
 * The variants this deployment can actually analyse.
 *
 * The `analysis` flag alone is deployment-wide, and ADR-0113 registers only engines whose binary is
 * configured — so an image carrying Stockfish alone reports `analysis: true` while answering 422 for
 * Atomic, Crazyhouse, King of the Hill, Three-Check, Horde and Racing Kings. A client that knew only
 * the flag offered a control that could never work on six of the eight variants. Raised in the Qodo
 * review of PR #133 (ADR-0114 Decision 7).
 *
 * Answered without warming a pool: `EngineManager.supportsVariant` falls back to each registered
 * plugin's declared variants when cold (ADR-0102), so advertising this costs no engine process.
 *
 * Empty when analysis is off, so a client never has to read the flag and the list to know it cannot
 * analyse anything.
 */
export type AnalysisVariants = readonly string[];

export interface CapabilitiesView {
  readonly capabilities: CapabilitiesFlags;
  readonly analysisVariants: AnalysisVariants;
  /** Kept feature-specific so clients never infer future puzzle support from generic analysis. */
  readonly puzzleVariants: AnalysisVariants;
  /** Kept feature-specific because Review's exact MultiPV-2 policy can narrow generic analysis. */
  readonly gameReviewVariants: AnalysisVariants;
}

/**
 * What this deployment can actually serve, read off the dependencies it was built with.
 *
 * The parameter is the real `ApiDependencies`, not a structural type restating the seven property
 * names. Restating them compiles just as well and is a second copy of the configuration wearing a
 * disguise: rename `learningRepository` in `deps.ts` and a structural parameter keeps matching
 * nothing, so this reports `learning: false` forever, on a deployment that has learning switched
 * on, and no test fails. Naming the real type makes that rename a compile error.
 */
export function capabilitiesView(
  deps: Pick<
    import('./deps.js').ApiDependencies,
    | 'learningRepository'
    | 'studiesRepository'
    | 'achievementsRepository'
    | 'searchRepository'
    | 'semanticSearchRepository'
    | 'embeddingProvider'
    | 'socialGraphRepository'
    | 'messagingRepository'
    | 'communityRepository'
    | 'analysis'
    | 'moveExplanation'
    | 'mistakePrediction'
    | 'puzzleGeneration'
    | 'openingExploration'
    | 'endgameTraining'
    | 'coach'
    | 'studyPartner'
    | 'tournamentCommentary'
    | 'gameReview'
  >,
): CapabilitiesView {
  const puzzleVariants = deps.puzzleGeneration
    ? VARIANTS.filter((variant) => deps.puzzleGeneration?.supportsVariant(variant) === true)
    : [];
  const gameReviewVariants = deps.gameReview
    ? VARIANTS.filter((variant) => deps.gameReview?.supportsVariant(variant) === true)
    : [];
  return {
    capabilities: {
      learning: deps.learningRepository !== undefined,
      studies: deps.studiesRepository !== undefined,
      achievements: deps.achievementsRepository !== undefined,
      search: deps.searchRepository !== undefined,
      // Both, and in the same order the route reads them (`routes.ts`, the semantic branch of
      // `GET /v1/search`): the two are composed and decomposed together, but the flag is a claim
      // about what that branch will do, so it is built from what that branch actually requires.
      semanticSearch:
        deps.semanticSearchRepository !== undefined && deps.embeddingProvider !== undefined,
      social: deps.socialGraphRepository !== undefined,
      messaging: deps.messagingRepository !== undefined,
      community: deps.communityRepository !== undefined,
      analysis: deps.analysis !== undefined,
      moveExplanation: deps.moveExplanation !== undefined,
      mistakePrediction: deps.mistakePrediction !== undefined,
      puzzleGeneration: puzzleVariants.length > 0,
      openingExplorer: deps.openingExploration !== undefined,
      endgameTrainer: deps.endgameTraining !== undefined,
      coach: deps.coach !== undefined,
      studyPartner: deps.studyPartner !== undefined,
      tournamentCommentary: deps.tournamentCommentary !== undefined,
      gameReview: gameReviewVariants.length > 0,
    },
    analysisVariants: deps.analysis
      ? VARIANTS.filter((variant) => deps.analysis?.supportsVariant(variant) === true)
      : [],
    puzzleVariants,
    gameReviewVariants,
  };
}

/**
 * Optional dependencies that are deliberately **not** published as capabilities.
 *
 * Exported as a type so the parity test can read this list rather than restate it; it emits no
 * runtime value. Each name is a decision, and the decision is the point — see
 * {@link EveryOptionalDependencyIsClassified} below.
 *
 * - `logger`, `metrics`, `tracer`, `readiness` are infrastructure. A visitor has no control whose
 *   availability they describe, and `GET /v1/metrics` and `GET /v1/ready` are operator surfaces.
 * - `antiCheatAnalysis` and `botTimingSource` back moderator routes. They are absent here because
 *   this document is public and unauthenticated; publishing them would tell every caller which
 *   deployments can detect them. If a moderator UI ever needs to know, it needs an authenticated
 *   capabilities surface, not a new key on this one.
 * - `graphql` is genuinely optional to the client and already degrades on its own:
 *   `packages/web/src/api/graphql.ts` latches `available` from the first 503 and returns `null`
 *   thereafter, so callers fall back to `shortId` and no control is offered that cannot work. That
 *   is the same fail-closed outcome a flag would buy, reached without one.
 * - `chess960Starts` is optional to the *bundle*, not to the deployment: `createApiServer` defaults
 *   it to the CSPRNG selector, so it is never absent at runtime and there is no state in which
 *   Chess960 creation is unavailable for want of it. A flag would publish `true` unconditionally,
 *   which tells a client nothing and invites the belief that it might one day be `false`. What a
 *   client should read to learn whether Chess960 can be created is the `variant` enum on the creation
 *   requests, which already says so.
 */
export type NotAPublishedCapability =
  | 'logger'
  | 'metrics'
  | 'tracer'
  | 'readiness'
  | 'antiCheatAnalysis'
  | 'botTimingSource'
  | 'graphql'
  | 'chess960Starts';

/**
 * Every optional dependency is either a published capability or explicitly not one.
 *
 * ADR-0131 made the *forwarding* of optional dependencies exhaustive at compile time, and recorded
 * this file as the remaining gap: a new optional feature never added to `capabilitiesView` is
 * invisible to `GET /v1/capabilities`, and nothing complains. That entry called the fix blocked on
 * "deciding which optional dependencies are user-facing capabilities, which is a judgement call
 * rather than a derivation". The framing was the mistake. The judgement cannot be derived — but
 * *skipping* it can be made impossible, which is the property actually wanted.
 *
 * So the capability source set is read off the presenter's own parameter rather than restated:
 * `Parameters<typeof capabilitiesView>[0]` cannot drift from the function, because it *is* the
 * function's parameter. That is the lesson ADR-0131 §6a paid for — an assertion that names a type
 * separately guards the name, not the code.
 *
 * Add an optional dependency and this stops being `never`, so the initialiser fails with
 * `TS2322` until someone either gives it a flag or writes it into
 * {@link NotAPublishedCapability} above. The hand-written half is acceptable for the same reason
 * `ConstructedHere` was in ADR-0131 §1b: it is **fail-loud**. Drop a name from it and this breaks
 * immediately, rather than quietly covering one key fewer.
 *
 * The reverse direction needs no assertion. A flag with nothing computing it is already `TS2741` on
 * the returned object literal, because {@link CapabilitiesFlags} is the declared return type.
 */
type EveryOptionalDependencyIsClassified =
  Exclude<
    import('./deps.js').OptionalDependencyKey,
    keyof Parameters<typeof capabilitiesView>[0] | NotAPublishedCapability
  > extends never
    ? true
    : never;

// Not exported: an exported `const` is emitted into the JavaScript and becomes public runtime API,
// which is how a compile-time assertion shipped as a value in ADR-0131 and had to be taken back out.
// `void` satisfies `noUnusedLocals` without that.
const everyOptionalDependencyIsClassified: EveryOptionalDependencyIsClassified = true;
void everyOptionalDependencyIsClassified;

/**
 * The service outcome is already the public shape: it is the projection, built in the service so
 * that dropping the bundled statistics is a property of the only path to the wire rather than a
 * step a second caller could skip. See `openings/opening-exploration-service.ts`.
 */
export type OpeningExplorationView =
  import('./openings/opening-exploration-service.js').OpeningExplorationOutcome;

/**
 * Copy the service outcome onto the wire shape.
 *
 * A copy rather than a pass-through so the published field list is written out in one place a
 * reviewer can read against the schema; the statistics were already dropped upstream.
 *
 * @param outcome - what the service concluded.
 * @returns the response body, carrying no opening statistics.
 */
export function openingExplorationView(
  outcome: import('./openings/opening-exploration-service.js').OpeningExplorationOutcome,
): OpeningExplorationView {
  return {
    moves: [...outcome.moves],
    found: outcome.found,
    eco: outcome.eco,
    name: outcome.name,
    matchedMoves: outcome.matchedMoves,
    outOfBook: outcome.outOfBook,
    continuations: outcome.continuations.map((continuation) => ({
      move: continuation.move,
      san: continuation.san,
      eco: continuation.eco,
      name: continuation.name,
    })),
  };
}

/** The service outcome is already the intentionally minimal, JSON-safe public shape. */
export type PuzzleGenerationView = import('./analysis/puzzle-generation-service.js').PuzzleGenerationOutcome;

export function puzzleGenerationView(
  outcome: import('./analysis/puzzle-generation-service.js').PuzzleGenerationOutcome,
): PuzzleGenerationView {
  if (outcome.kind === 'insufficient') {
    return {
      kind: 'insufficient',
      fen: outcome.fen,
      variant: outcome.variant,
      reason: outcome.reason,
      bestMove: outcome.bestMove,
      comparisonMove: outcome.comparisonMove,
      ...(outcome.terminal ? { terminal: outcome.terminal } : {}),
    };
  }
  const common = {
    fen: outcome.fen,
    variant: outcome.variant,
    evidence: outcome.evidence,
    bestMove: outcome.bestMove,
    comparisonMove: outcome.comparisonMove,
    bestEvaluation: outcome.bestEvaluation,
    comparisonEvaluation: outcome.comparisonEvaluation,
    depth: outcome.depth,
  };
  if (outcome.kind === 'no_tactic') return { kind: 'no_tactic', ...common };
  return {
    kind: 'puzzle',
    ...common,
    solutionMove: outcome.solutionMove,
    solutionLine: [...outcome.solutionLine],
    difficulty: outcome.difficulty,
  };
}

export interface EndgameLossViewCentipawns {
  readonly kind: 'centipawns';
  readonly value: number;
}

export interface EndgameLossViewDecisive {
  readonly kind: 'decisive';
}

export type EndgameLossView = EndgameLossViewCentipawns | EndgameLossViewDecisive;

export interface EndgameNextView {
  readonly id: string;
  readonly type: import('@chess-platform/ai-features').EndgameType;
  readonly name: string;
  readonly fen: string;
  readonly sideToMove: 'w' | 'b';
  readonly objective: 'mate' | 'win' | 'draw';
  readonly difficulty: import('@chess-platform/ai-features').EndgameDifficulty;
  readonly technique: string | null;
}

/**
 * The training position as the learner may see it.
 *
 * @param outcome - the service's already-projected position.
 * @returns the response body. Deliberately carries no solution, no evaluation and no authored mate
 * distance: the service withheld them, and this restates the field list where a reviewer can read
 * it against the schema (ADR-0128).
 */
export function endgameNextView(
  outcome: import('./endgames/endgame-training-service.js').EndgameNextOutcome,
): EndgameNextView {
  return {
    id: outcome.id,
    type: outcome.type,
    name: outcome.name,
    fen: outcome.fen,
    sideToMove: outcome.sideToMove,
    objective: outcome.objective,
    difficulty: outcome.difficulty,
    technique: outcome.technique,
  };
}

export interface EndgameEvaluationView {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

/** Common to both branches, so a client can render the verdict before discriminating. */
interface EndgameAttemptCommonView {
  readonly id: string;
  readonly move: string;
  readonly fenAfter: string;
  readonly classification: 'optimal' | 'acceptable' | 'throws_result';
  readonly goalPreserved: boolean;
}

export interface EndgameJudgedView extends EndgameAttemptCommonView {
  readonly kind: 'judged';
  readonly evalBefore: EndgameEvaluationView;
  readonly evalAfter: EndgameEvaluationView;
  readonly loss: EndgameLossView;
  readonly betterMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
  readonly mateDistanceAfter: number | null;
}

/**
 * The move ended the game, so there is no evaluation and no better move to offer — the position has
 * a result instead of a score (ADR-0116). A separate branch rather than nulled-out fields, so a
 * client cannot render a decided game as an evaluation of 0.00.
 */
export interface EndgameTerminalView extends EndgameAttemptCommonView {
  readonly kind: 'terminal';
  readonly terminal: { readonly reason: string; readonly result: string };
}

export type EndgameAttemptView = EndgameJudgedView | EndgameTerminalView;

/**
 * The verdict on a learner's move.
 *
 * @param outcome - the service's judgement, already JSON-safe.
 * @returns the response body, discriminated on `kind`: a move that ended the game carries a result
 * and no evaluation, because a decided position has no score to report (ADR-0116).
 */
export function endgameAttemptView(
  outcome: import('./endgames/endgame-training-service.js').EndgameAttemptOutcome,
): EndgameAttemptView {
  const common = {
    id: outcome.id,
    move: outcome.move,
    fenAfter: outcome.fenAfter,
    classification: outcome.classification,
    goalPreserved: outcome.goalPreserved,
  };
  if (outcome.kind === 'terminal') {
    return { kind: 'terminal', ...common, terminal: outcome.terminal };
  }
  return {
    kind: 'judged',
    ...common,
    evalBefore: {
      type: outcome.evalBefore.type,
      value: outcome.evalBefore.value,
    },
    evalAfter: {
      type: outcome.evalAfter.type,
      value: outcome.evalAfter.value,
    },
    loss: outcome.loss,
    betterMove: outcome.betterMove,
    bestLine: [...outcome.bestLine],
    depth: outcome.depth,
    mateDistanceAfter: outcome.mateDistanceAfter,
  };
}

export interface AnalysisEvaluationView {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

export interface AnalysisLineView {
  readonly multipv: number;
  readonly evaluation: AnalysisEvaluationView;
  readonly moves: readonly string[];
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
}

export interface AppliedAnalysisLimitsView {
  readonly depth: number;
  readonly movetimeMs: number;
  readonly multiPv: number;
  readonly nodes?: number;
}

export interface TerminalOutcomeView {
  readonly reason: string;
  readonly result: string;
}

export interface AnalysisResponseView {
  readonly fen: string;
  readonly variant: string;
  readonly applied: AppliedAnalysisLimitsView;
  readonly lines: readonly AnalysisLineView[];
  /**
   * Present when the position is already decided, in which case `lines` is empty and no engine ran.
   *
   * A client seeing this must render the result rather than an evaluation: there is no score for a
   * finished game, and the placeholder the engine emits for one reads as dead level (ADR-0116).
   */
  readonly terminal?: TerminalOutcomeView;
}

export function analysisView(outcome: import('./analysis/service.js').AnalysisOutcome): AnalysisResponseView {
  return {
    fen: outcome.fen,
    variant: outcome.variant,
    applied: {
      depth: outcome.applied.depth,
      movetimeMs: outcome.applied.movetimeMs,
      multiPv: outcome.applied.multiPv,
      ...(outcome.applied.nodes !== undefined ? { nodes: outcome.applied.nodes } : {}),
    },
    lines: outcome.lines.map((line) => ({
      multipv: line.multipv,
      evaluation: {
        type: line.evaluation.type,
        value: line.evaluation.value,
      },
      moves: [...line.principalVariation],
      depth: line.depth,
      nodes: line.nodes,
      timeMs: line.timeMs,
    })),
    ...(outcome.terminal
      ? { terminal: { reason: outcome.terminal.reason, result: outcome.terminal.result } }
      : {}),
  };
}

/**
 * What the requested move achieved: an evaluation, or a finished game.
 *
 * Tagged with `kind` so a client never has to infer which it got. The alternative — an evaluation
 * carrying a sentinel — is what produced `+0.00` for checkmate (ADR-0116).
 */
export type MoveOutcomeView =
  | {
      readonly kind: 'evaluation';
      readonly evalKind: 'cp' | 'mate';
      readonly evalValue: number;
      readonly evalLabel: string;
    }
  | {
      readonly kind: 'terminal';
      readonly reason: string;
      readonly result: string;
    };

export interface MoveExplanationCitationView {
  readonly moveOutcome: MoveOutcomeView;
  readonly evalKind: 'cp' | 'mate';
  readonly evalValue: number;
  readonly evalLabel: string;
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

export interface MoveExplanationView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  readonly citation: MoveExplanationCitationView;
  readonly providerId: string;
  readonly model: string;
}

/**
 * What the assessed move achieved, mover-relative (ADR-0118).
 *
 * Re-exported from the service rather than restated here. The other views in this file restate their
 * shapes because they widen a domain type to something wire-shaped — but this one is already exactly
 * the wire shape, and a second copy of a discriminated union is a second copy free to drift by one
 * member. It carries a `label` where {@link MoveOutcomeView} does not, because a terminal result here
 * has no prose beside it to say what happened.
 */
export type { MistakeMoveOutcomeView } from './analysis/mistake-prediction-service.js';

export interface MistakePredictionView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly classification: 'ok' | 'inaccuracy' | 'mistake' | 'blunder';
  readonly before: {
    readonly evalKind: 'cp' | 'mate';
    readonly evalValue: number;
    readonly evalLabel: string;
  };
  readonly after: import('./analysis/mistake-prediction-service.js').MistakeMoveOutcomeView;
  /** `null` when the transition has no centipawn measure — never `Infinity`, never a stand-in. */
  readonly centipawnLoss: number | null;
  /** `null` when the engine reported no line. Equal to `move` when the player found it. */
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

/**
 * Present one engine-backed mistake prediction through the public wire contract.
 *
 * Explicit `null` values are preserved, while `bestLine` is copied so the response does not share
 * the source outcome's analysis array.
 */
export function mistakePredictionView(
  outcome: import('./analysis/mistake-prediction-service.js').MistakePredictionOutcome,
): MistakePredictionView {
  return {
    fen: outcome.fen,
    variant: outcome.variant,
    move: outcome.move,
    classification: outcome.classification,
    before: {
      evalKind: outcome.before.evalKind,
      evalValue: outcome.before.evalValue,
      evalLabel: outcome.before.evalLabel,
    },
    after: outcome.after,
    centipawnLoss: outcome.centipawnLoss,
    bestMove: outcome.bestMove,
    bestLine: [...outcome.bestLine],
    depth: outcome.depth,
  };
}

/**
 * Stable wire representation of a completed-game review.
 *
 * Move counts cover only the requesting player's moves. A partial response contains the analyzed
 * prefix and requires the `move_limit` cutoff reason; a complete response cannot expose one.
 */
export type GameReviewView = {
  readonly gameId: string;
  readonly variant: string;
  readonly playerColor: 'white' | 'black';
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly {
    readonly ply: number;
    readonly san: string;
    readonly move: string;
    readonly fenBefore: string;
    readonly assessment: MistakePredictionView;
    readonly classification: GameReviewClassification;
  }[];
  readonly summary: GameReviewSummary;
  readonly totalPlayerMoves: number;
  readonly analyzedPlayerMoves: number;
} & (
  | { readonly isPartial: false; readonly cutoffReason?: never }
  | { readonly isPartial: true; readonly cutoffReason: 'move_limit' }
);

/** Present the private service outcome through the stable public Game Review contract. */
export function gameReviewView(
  outcome: import('./game-review/service.js').GameReviewOutcome,
): GameReviewView {
  const base = {
    gameId: outcome.gameId,
    variant: outcome.variant,
    playerColor: outcome.playerColor,
    result: outcome.result,
    termination: outcome.termination,
    moves: outcome.moves.map((move) => ({
      ply: move.ply,
      san: move.san,
      move: move.move,
      fenBefore: move.fenBefore,
      assessment: mistakePredictionView(move.assessment),
      classification: move.classification,
    })),
    summary: { ...outcome.summary },
    totalPlayerMoves: outcome.totalPlayerMoves,
    analyzedPlayerMoves: outcome.analyzedPlayerMoves,
  };

  return outcome.isPartial
    ? { ...base, isPartial: true, cutoffReason: outcome.cutoffReason }
    : { ...base, isPartial: false };
}

export function moveExplanationView(
  outcome: import('./ai/move-explanation-service.js').MoveExplanationOutcome,
): MoveExplanationView {
  return {
    fen: outcome.fen,
    variant: outcome.variant,
    move: outcome.move,
    explanation: outcome.explanation,
    citation: {
      moveOutcome: outcome.citation.moveOutcome,
      evalKind: outcome.citation.evalKind,
      evalValue: outcome.citation.evalValue,
      evalLabel: outcome.citation.evalLabel,
      bestMove: outcome.citation.bestMove,
      bestLine: [...outcome.citation.bestLine],
      depth: outcome.citation.depth,
    },
    providerId: outcome.providerId,
    model: outcome.model,
  };
}

/**
 * What the Coach says about a tactic in the position.
 *
 * There is no `solutionMove` and no `solutionLine`, and their absence is the contract rather than an
 * oversight. `/v1/puzzles/generate` publishes both, because a caller asking "is my position a
 * tactic, and what is it" is studying their own position. A coaching hint that hands over the tactic
 * has stopped being a hint, which is the ADR-0095 defect in a different costume — so the Coach says
 * only that a tactic is there and how hard it is.
 */
export interface CoachPuzzleView {
  readonly kind: 'puzzle';
  readonly fen: string;
  readonly variant: string;
  readonly difficulty: import('@chess-platform/ai-features').PuzzleDifficulty;
}

/**
 * One section of a coaching response.
 *
 * Always one of the two shapes, never an absent key and never `null`: a client that gets nothing back
 * for a section should be able to say *why* it got nothing, and "the engine is down" and "your move
 * was already the best one" are not the same message to show a learner.
 */
export type CoachSectionView<T> =
  | {
      readonly kind: 'present';
      readonly value: T;
    }
  | {
      readonly kind: 'omitted';
      readonly reason: import('./coach/coach-service.js').CoachOmissionReason;
    };

export interface CoachView {
  readonly fen: string;
  readonly variant: string;
  readonly move: string | null;
  readonly mistake: CoachSectionView<MistakePredictionView>;
  readonly explanation: CoachSectionView<MoveExplanationView>;
  readonly opening: CoachSectionView<OpeningExplorationView>;
  readonly puzzle: CoachSectionView<CoachPuzzleView>;
  readonly endgame: CoachSectionView<EndgameNextView>;
  readonly featuresFired: readonly string[];
}

/**
 * The coaching response.
 *
 * Four of the five sections are rendered by the *existing* presenter for that feature, and that is
 * the mechanism by which the Coach cannot publish more than each feature's own route does: there is
 * no second projection here to drift from the first, so a field withheld at `/v1/endgames/next` is
 * withheld here by construction rather than by a rule someone has to remember.
 *
 * The puzzle section is the deliberate exception. It is projected field by field from the already
 * narrowed `CoachPuzzleOutcome` and never through `puzzleGenerationView`, which publishes the
 * solution.
 *
 * @param outcome - the orchestrator's result.
 * @returns the response body, with every object built explicitly and nothing spread.
 */
export function coachView(
  outcome: import('./coach/coach-service.js').CoachOutcome,
): CoachView {
  const mistake: CoachSectionView<MistakePredictionView> =
    outcome.mistake.kind === 'present'
      ? { kind: 'present', value: mistakePredictionView(outcome.mistake.value) }
      : { kind: 'omitted', reason: outcome.mistake.reason };

  const explanation: CoachSectionView<MoveExplanationView> =
    outcome.explanation.kind === 'present'
      ? { kind: 'present', value: moveExplanationView(outcome.explanation.value) }
      : { kind: 'omitted', reason: outcome.explanation.reason };

  const opening: CoachSectionView<OpeningExplorationView> =
    outcome.opening.kind === 'present'
      ? { kind: 'present', value: openingExplorationView(outcome.opening.value) }
      : { kind: 'omitted', reason: outcome.opening.reason };

  const puzzle: CoachSectionView<CoachPuzzleView> =
    outcome.puzzle.kind === 'present'
      ? {
          kind: 'present',
          value: {
            kind: 'puzzle',
            fen: outcome.puzzle.value.fen,
            variant: outcome.puzzle.value.variant,
            difficulty: outcome.puzzle.value.difficulty,
          },
        }
      : { kind: 'omitted', reason: outcome.puzzle.reason };

  const endgame: CoachSectionView<EndgameNextView> =
    outcome.endgame.kind === 'present'
      ? { kind: 'present', value: endgameNextView(outcome.endgame.value) }
      : { kind: 'omitted', reason: outcome.endgame.reason };

  return {
    fen: outcome.fen,
    variant: outcome.variant,
    move: outcome.move,
    mistake,
    explanation,
    opening,
    puzzle,
    endgame,
    featuresFired: [...outcome.featuresFired],
  };
}

/**
 * Wire shape for commentary on a finished tournament game (ADR-0130).
 *
 * Field-by-field rather than a spread of the outcome, which is the rule ADR-0129 §3 set for the
 * Coach's puzzle section and for the same reason: a spread publishes whatever the service type
 * grows next, and the value of a projection is that adding a field to the service is not the same
 * act as publishing it.
 */
export interface TournamentGameCommentaryView {
  readonly tournamentId: string;
  readonly gameId: string;
  readonly round: number;
  readonly white: string;
  readonly black: string;
  readonly result: string;
  readonly tournamentResult: string | null;
  readonly termination: string;
  readonly ply: number;
  readonly fen: string;
  readonly variant: string;
  readonly finalMove: { readonly uci: string; readonly san: string };
  readonly citation: {
    readonly fen: string;
    readonly move: string;
    readonly evalKind: 'cp' | 'mate';
    readonly evalValue: number;
    readonly evalLabel: string;
    readonly bestLine: readonly string[];
    readonly depth: number;
  };
  readonly commentary: string;
  readonly providerId: string;
  readonly model: string;
}

/**
 * Project a game commentary onto the wire.
 *
 * @param outcome - what the commentary service produced.
 * @returns the public view.
 */
export function tournamentGameCommentaryView(
  outcome: import('./commentary/tournament-commentary-service.js').GameCommentaryOutcome,
): TournamentGameCommentaryView {
  return {
    tournamentId: outcome.tournamentId,
    gameId: outcome.gameId,
    round: outcome.round,
    white: outcome.white,
    black: outcome.black,
    result: outcome.result,
    tournamentResult: outcome.tournamentResult,
    termination: outcome.termination,
    ply: outcome.ply,
    fen: outcome.fen,
    variant: outcome.variant,
    finalMove: { uci: outcome.finalMove.uci, san: outcome.finalMove.san },
    citation: {
      fen: outcome.citation.fen,
      move: outcome.citation.move,
      evalKind: outcome.citation.evalKind,
      evalValue: outcome.citation.evalValue,
      evalLabel: outcome.citation.evalLabel,
      bestLine: [...outcome.citation.bestLine],
      depth: outcome.citation.depth,
    },
    commentary: outcome.commentary,
    providerId: outcome.providerId,
    model: outcome.model,
  };
}

/** Wire shape for a narrative round recap (ADR-0130). */
export interface TournamentRoundRecapView {
  readonly tournamentId: string;
  readonly round: number;
  readonly results: readonly {
    readonly white: string;
    readonly black: string | null;
    readonly result: string;
  }[];
  readonly standings: readonly {
    readonly rank: number;
    readonly player: string;
    readonly points: number;
  }[];
  readonly pairingsNarrated: number;
  readonly narrative: string;
  readonly providerId: string;
  readonly model: string;
}

/**
 * Project a round recap onto the wire.
 *
 * @param outcome - what the commentary service produced.
 * @returns the public view.
 */
export function tournamentRoundRecapView(
  outcome: import('./commentary/tournament-commentary-service.js').RoundRecapOutcome,
): TournamentRoundRecapView {
  return {
    tournamentId: outcome.tournamentId,
    round: outcome.round,
    results: outcome.results.map((entry) => ({
      white: entry.white,
      black: entry.black,
      result: entry.result,
    })),
    standings: outcome.standings.map((row) => ({
      rank: row.rank,
      player: row.player,
      points: row.points,
    })),
    pairingsNarrated: outcome.pairingsNarrated,
    narrative: outcome.narrative,
    providerId: outcome.providerId,
    model: outcome.model,
  };
}
