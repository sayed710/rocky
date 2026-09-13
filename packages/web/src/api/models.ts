/**
 * REST contract models — a hand-authored, framework-independent mirror of the
 * approved M4 API contract (`packages/api/openapi.json`).
 *
 * These are the request/response shapes the typed client (`api/client.ts`)
 * consumes. They are kept deliberately minimal and read-only. Fields whose
 * contract type admits null — spelled `"type": ["string", "null"]` since
 * ADR-0119 retired the OpenAPI 3.0 `nullable` keyword — are `T | null` here:
 * always present, possibly null. Fields that are truly optional in the request
 * body use `?`. The two are independent, and this file keeps them so.
 *
 * Scope note (M6 increment 3A): only the endpoints the networking foundation
 * needs are modeled — health, auth/session, users/profile, ratings,
 * leaderboard and game summaries. Lobby/matchmaking (seeks) and live game
 * streaming (WS) land with their own increments and are intentionally absent.
 *
 * M12 inc 2: `refreshToken` in `TokenPair` is now optional for the browser
 * flow — the browser never reads or stores it (it lives in an httpOnly
 * cookie). Non-browser API clients still receive it in the JSON body.
 * `RefreshRequest` is kept for API-client compatibility but the browser
 * flow no longer sends the token in the body (it relies on the cookie).
 */

/** Supported chess variants (matches the server's `variant` enum). */
export const VARIANTS = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * The variants the lobby offers, which is deliberately kept a separate list from `VARIANTS`.
 *
 * `chess960` was withheld by ADR-0099 because the variant was a name with nothing behind it, and is
 * offered again as of ADR-0137: the rules are real (ADR-0136), the server draws and records a
 * starting-position id at creation, and a game selected here starts from the arrangement the server
 * chose. The board renders whatever FEN the server sends, so nothing here needs to know what the 960
 * arrangements are — which is what makes offering it a one-line change rather than a feature.
 *
 * The two lists stay separate even now that they agree. `VARIANTS` mirrors what the server's enum
 * accepts; this names what a player may *pick*. Conflating them is why a variant with no
 * implementation behind it was selectable for so long, and re-deriving the distinction later is not
 * the same as never having lost it.
 *
 * Written out rather than derived as `[...VARIANTS]`. Subtracting from the contract list makes
 * offering the default, so a variant added to `VARIANTS` tomorrow becomes selectable the moment it is
 * named — precisely how a hollow variant came to be on the board. Naming what is offered means a new
 * variant has to be let in deliberately, and the test in `create-game-prefs.test.ts` fails until
 * someone does.
 */
export const OFFERED_VARIANTS: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/**
 * A seek's color preference (matches the server's `color` enum). `random` (the
 * default) lets pairing assign sides; `white`/`black` request that side.
 */
export const SEEK_COLORS = ['white', 'black', 'random'] as const;
export type SeekColor = (typeof SEEK_COLORS)[number];

/** Account roles (matches the server's `role` enum). */
export const USER_ROLES = ['user', 'coach', 'tournament_director', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Access + refresh token pair returned by the auth endpoints.
 *
 * `refreshToken` is optional: the API still returns it in the JSON body for
 * non-browser API clients, but the browser flow (M12 inc 2) never reads or
 * stores it — the refresh token lives in an httpOnly cookie set by the API.
 */
export interface TokenPair {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  readonly expiresIn: number;
  /**
   * Opaque refresh token. Present for non-browser API clients; the browser
   * never reads this (it uses the httpOnly cookie). See ADR-0012.
   */
  readonly refreshToken?: string;
  /** ISO-8601 timestamp. */
  readonly refreshExpiresAt: string;
}

/** The authenticated user's own account view. */
export interface SelfUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
  readonly roles: readonly UserRole[];
}

/** A public account view (no roles). */
export interface PublicUser {
  readonly id: string;
  readonly handle: string;
  readonly country: string | null;
  readonly createdAt: string;
}

export interface AuthResponse {
  readonly user: SelfUser;
  readonly tokens: TokenPair;
}

export interface RegisterRequest {
  readonly handle: string;
  readonly password: string;
  readonly email?: string | null;
}

export interface LoginRequest {
  readonly handle: string;
  readonly password: string;
}

export interface PasswordResetRequest {
  readonly handleOrEmail: string;
}

export interface PasswordResetConfirmRequest {
  readonly token: string;
  readonly newPassword: string;
}

export interface EmailVerifyRequest {
  readonly token: string;
}

/**
 * Refresh request body. Used by non-browser API clients that send the
 * refresh token in the JSON body. The browser flow omits the body and
 * relies on the httpOnly cookie (sent automatically with `credentials: 'include'`).
 */
export interface RefreshRequest {
  readonly refreshToken?: string;
}

/** A server-side session record (device/login). */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
  readonly createdIp: string | null;
  readonly createdUserAgent: string | null;
}

/** A per-variant rating (Glicko-2 style fields). */
export interface RatingView {
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: string | null;
}

export interface UserProfile {
  readonly user: PublicUser;
  readonly ratings: readonly RatingView[];
}

export interface LeaderboardEntry {
  readonly userId: string;
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
}

export interface GameSummary {
  readonly id: string;
  readonly variant: Variant;
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

export interface Health {
  readonly status: 'ok';
  readonly name: string;
  readonly version: string;
}

export interface SystemCapabilities {
  readonly learning: boolean;
  readonly studies: boolean;
  readonly achievements: boolean;
  readonly search: boolean;
  /**
   * Semantic and hybrid search modes (ADR-0132).
   *
   * The one flag here that must never be inferred from another. `GET /v1/search` serves three modes
   * from two dependency sets the server gates separately — keyword needs a search repository, the
   * other two need a vector repository *and* an embedding provider — so `search: true` says nothing
   * about them. A deployment with keyword search working and both other modes answering 503 is a
   * supported configuration, offered by the Helm chart as `search.semanticEnabled`.
   *
   * Optional because a server predating it omits the field, and a missing flag must read as off
   * rather than as permission. The cost of that rule here is two modes hidden on an older server
   * that could serve them; the alternative is two buttons that cannot.
   */
  readonly semanticSearch?: boolean;
  readonly social: boolean;
  readonly messaging: boolean;
  readonly community: boolean;
  readonly analysis: boolean;
  /**
   * Engine-grounded move explanation, and engine-grounded mistake prediction (ADR-0115, ADR-0118).
   *
   * These are a type-completeness fix, not a new capability: the API has emitted both since those
   * ADRs, and `capabilities-nav.ts` has had working `moveExplanationEnabled` and
   * `mistakePredictionEnabled` predicates all along — they read through `capabilityFlags()`, which
   * returns `Record<string, unknown>` and so never consulted this interface. ADR-0131 recorded the
   * omission as "very likely deliberate"; it was not, it simply had no consequence, which is why
   * nothing caught it. Optional for the same reason as every flag below.
   */
  readonly moveExplanation?: boolean;
  readonly mistakePrediction?: boolean;
  readonly puzzleGeneration?: boolean;
  /**
   * Bundled opening identification. Optional because a server predating it omits the field, and a
   * missing flag must read as off rather than as permission.
   *
   * There is no variant list beside it: the feature serves exactly `standard`. See ADR-0127.
   */
  readonly openingExplorer?: boolean;
  /**
   * Endgame trainer. Optional because a server predating it omits the field, and a
   * missing flag must read as off rather than as permission.
   */
  readonly endgameTrainer?: boolean;
  /**
   * Coaching over the other features (M15 inc 21, ADR-0129).
   *
   * Optional because a server predating it omits the field entirely, and a missing flag has to read
   * as off rather than as permission. True when *any* of the five features it composes is present,
   * so it says the endpoint will answer — not that every section will.
   */
  readonly coach?: boolean;
  /** Private durable Study Partner sessions over the production coaching path. */
  readonly studyPartner?: boolean;
  /**
   * Engine-cited commentary on finished tournament games, and narrative round recaps
   * (M15 inc 22, ADR-0130).
   *
   * Optional because a server predating it omits the field, and a missing flag must read as off
   * rather than as permission. Needs an engine and a provider, so it is false on a deployment that
   * has only one of them — do not infer it from `analysis` or from `coach`.
   */
  readonly tournamentCommentary?: boolean;
  /** Completed-game review for a participating player. */
  readonly gameReview?: boolean;
}

export interface CapabilitiesResponse {
  /**
   * Variants this deployment can analyse. The `analysis` flag is deployment-wide, but only engines
   * with a configured binary are registered server-side, so a deployment can report `analysis: true`
   * while serving a subset. Optional here because a server predating this field simply omits it.
   */
  readonly analysisVariants?: readonly string[];
  /** Variants served by fixed-policy puzzle generation; absent on older servers. */
  readonly puzzleVariants?: readonly string[];
  /** Variants served by fixed-policy completed-game review. */
  readonly gameReviewVariants?: readonly string[];
  readonly capabilities: SystemCapabilities;
}

/** A seek (open game offer) in the lobby. */
export interface SeekView {
  readonly id: string;
  readonly creatorId: string;
  /**
   * Human-readable handle of the seek creator. Allows the lobby UI to render opponent identity
   * directly without requiring an optional GraphQL read layer. Null for unresolvable/deleted users.
   */
  readonly creatorHandle: string | null;
  readonly variant: Variant;
  readonly speed: string;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: string;
  readonly gameId: string | null;
  readonly acceptedAt: string | null;
}

export interface CreateSeekRequest {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated?: boolean;
  /** Creator's color preference. Defaults to `random` server-side when omitted. */
  readonly color?: SeekColor;
  readonly minRating?: number | null;
  readonly maxRating?: number | null;
}

/** Engine bot difficulty, matching the server's bot catalogue. */
export type BotLevel = 'novice' | 'club' | 'master';

export interface CreateBotGameRequest {
  readonly level: BotLevel;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly color?: SeekColor;
}

/** Time control shape (mirrors the server's TimeControl schema). */
export interface TimeControl {
  readonly initialMs: number;
  readonly incrementMs: number;
  readonly delayMs: number;
  readonly kind: 'increment' | 'delay' | 'sudden_death' | 'unlimited';
}

/**
 * The wire shape of a server error body. Every non-2xx response the API returns
 * carries this envelope; the client parses it into a typed `HttpError`.
 */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: Record<string, unknown>;
  };
}

// --- Social graph (M10) -----------------------------------------------------

/** A paginated list as the social endpoints return it: a total plus one page. */
export interface SocialPage<T> {
  readonly total: number;
  readonly items: readonly T[];
}

export interface FollowEdge {
  readonly followerId: string;
  readonly followeeId: string;
  readonly followedAt: string;
}

/**
 * The states a friend request can hold. `ended` is reachable only from
 * `accepted` (a friendship being terminated), which is why it appears in a
 * request's status rather than in a separate model — see ADR-0066.
 */
export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'ended';

/** The actions a caller may take on a request; the server decides which are legal. */
export type FriendRequestAction = 'accept' | 'decline' | 'cancel';

export interface FriendRequest {
  readonly id: string;
  readonly requesterId: string;
  readonly addresseeId: string;
  readonly status: FriendRequestStatus;
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export interface BlockEdge {
  readonly blockerId: string;
  readonly blockedId: string;
  readonly blockedAt: string;
}

/**
 * A player as the read layer names them. The social REST endpoints return bare
 * ids — there is no id-to-handle lookup in REST, only `player(id:)` in GraphQL
 * — so a display name is available exactly when the read layer is reachable.
 */
export interface SocialPlayer {
  readonly id: string;
  readonly handle: string;
}

/** Followers and following for one player, resolved to display names. */
export interface SocialConnections {
  readonly followers: SocialPage<SocialPlayer>;
  readonly following: SocialPage<SocialPlayer>;
}

// --- Tournaments (M14 inc 15) -----------------------------------------------

export type TournamentFormat = 'round_robin' | 'swiss' | 'arena';
export type TournamentState = 'registration' | 'running' | 'finished';

export interface TournamentSummary {
  readonly id: string;
  readonly name: string;
  readonly format: TournamentFormat;
  readonly state: TournamentState;
  readonly participantCount: number;
}

export interface ArenaTournamentDetail {
  readonly id: string;
  readonly name: string;
  readonly format: 'arena';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly durationMs: number;
  readonly state: TournamentState;
  readonly participants: readonly string[];
  readonly startedAtMs?: number;
}

export interface SwissOrRoundRobinTournamentDetail {
  readonly id: string;
  readonly name: string;
  readonly format: 'swiss' | 'round_robin';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rounds?: number;
  readonly state: TournamentState;
  readonly participants: readonly string[];
  readonly roundsGenerated: number;
  readonly tiebreakOrder: readonly string[];
}

export type TournamentDetail = ArenaTournamentDetail | SwissOrRoundRobinTournamentDetail;

export interface ArenaStanding {
  readonly rank: number;
  readonly playerId: string;
  readonly points: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly gamesPlayed: number;
  readonly onFire: boolean;
}

export interface SwissOrRoundRobinStanding {
  readonly rank: number;
  readonly playerId: string;
  readonly points: number;
  readonly tiebreak: number;
  readonly buchholz: number;
  readonly medianBuchholz: number;
  readonly withdrawn: boolean;
}

export type TournamentStanding = ArenaStanding | SwissOrRoundRobinStanding;

export interface TournamentLiveBoard {
  readonly gameId: string;
  readonly white: string;
  readonly black: string;
  readonly ply: number;
  readonly turn: 'w' | 'b';
  readonly fen: string;
  readonly fenHash: string;
  readonly clock: {
    readonly w: number;
    readonly b: number;
  };
  readonly status:
    | { readonly over: false }
    | {
        readonly over: true;
        readonly result: string;
        readonly termination: string;
        readonly winner: 'w' | 'b' | null;
      };
}

export interface TournamentLive {
  readonly games: readonly TournamentLiveBoard[];
  readonly standings: readonly TournamentStanding[];
}

// --- Search (M14 inc 16) ----------------------------------------------------

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

/**
 * Everything the row needs, carried on the hit itself.
 *
 * Optional because a document indexed before the field existed still matches and is still returned;
 * the UI falls back to the id rather than dropping the row.
 */
export interface SearchDisplay {
  readonly type: 'game' | 'player' | 'tournament';
  readonly title: string;
  readonly subtitle?: string;
}

export interface SearchResult {
  readonly id: string;
  readonly score: number;
  readonly display?: SearchDisplay;
}

export interface SearchResults {
  readonly total: number;
  readonly results: readonly SearchResult[];
}

// --- Direct Messaging (M14 inc 18) -------------------------------------------

export interface ConversationView {
  readonly id: string;
  readonly participantA: string;
  readonly participantB: string;
  readonly createdAt: string;
  readonly lastMessageAt: string;
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

export interface ConversationSummary {
  readonly conversation: ConversationView;
  readonly unreadCount: number;
  readonly lastMessage: MessageView | null;
}

export interface ConversationList {
  readonly total: number;
  readonly items: readonly ConversationSummary[];
}

export interface MessageList {
  readonly total: number;
  readonly items: readonly MessageView[];
}

export interface ConversationReadState {
  readonly conversationId: string;
  readonly participantId: string;
  readonly lastReadAt: string;
}

// --- Teams (M14 inc 20) --------------------------------------------------------

export interface TeamView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'public' | 'private';
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * The team detail response. `viewerRole` is the viewer's own role, sent by the server because the
 * client cannot derive it: the member list is paginated and sorted owner → admin → member, so an
 * ordinary member of a large team is not on the page the client reads.
 */
export interface TeamDetailView extends TeamView {
  readonly viewerRole: 'owner' | 'admin' | 'member' | null;
}

export interface TeamList {
  readonly total: number;
  readonly items: readonly TeamView[];
}

export interface TeamMembership {
  readonly teamId: string;
  readonly playerId: string;
  readonly role: 'owner' | 'admin' | 'member';
  readonly joinedAt: string;
}

export interface TeamMemberList {
  readonly total: number;
  readonly items: readonly TeamMembership[];
}

export interface JoinRequestView {
  readonly id: string;
  readonly teamId: string;
  readonly playerId: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export interface JoinRequestList {
  readonly total: number;
  readonly items: readonly JoinRequestView[];
}

// --- Team forums (M14 inc 21) --------------------------------------------------

export interface ForumThread {
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

export interface ForumThreadList {
  readonly total: number;
  readonly items: readonly ForumThread[];
}

export interface ForumPost {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
}

export interface ForumPostList {
  readonly total: number;
  readonly items: readonly ForumPost[];
}

/** Creating a thread needs a title and an opening body, and returns both objects. */
export interface ForumThreadCreated {
  readonly thread: ForumThread;
  readonly firstPost: ForumPost;
}

// --- Achievements (M14 inc 22) ---------------------------------------------------

export type AchievementTier = 'bronze' | 'silver' | 'gold';

/**
 * One catalogue entry joined with this player's progress towards it.
 *
 * `target` is optional in the published contract and absent for one-shot achievements; the domain
 * reads an absent target as 1 (`packages/achievements/src/award.ts`), and so must anything here that
 * turns progress into a fraction.
 */
export interface PlayerAchievement {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: AchievementTier;
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
  readonly progress: number;
  readonly unlockedAt: string | null;
}

export interface PlayerAchievementList {
  readonly total: number;
  readonly items: readonly PlayerAchievement[];
}

export interface AchievementSummary {
  readonly unlockedCount: number;
  readonly pointsTotal: number;
}

// --- Learning & Courses (M14 inc 23) -------------------------------------------

export type CourseDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface CourseView {
  readonly id: string;
  readonly authorId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly difficulty: CourseDifficulty;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface CourseList {
  readonly total: number;
  readonly items: readonly CourseView[];
}

export interface LessonView {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly deletedAt?: string;
}

export interface TextStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'text';
  readonly prose: string;
  readonly deletedAt?: string;
}

export interface MoveStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'move';
  readonly fen: string;
  // expectedSan is omitted in the learner step view (ADR-0095) so the client cannot grade attempts locally
  readonly hint?: string;
  readonly deletedAt?: string;
}

export interface QuizStepView {
  readonly id: string;
  readonly lessonId: string;
  readonly orderIndex: number;
  readonly kind: 'quiz';
  readonly question: string;
  readonly options: readonly string[];
  // correctIndex is omitted in the learner step view (ADR-0095) so the client cannot grade attempts locally
  readonly deletedAt?: string;
}

export type StepView = TextStepView | MoveStepView | QuizStepView;

export interface CourseProgressSummaryView {
  readonly courseId: string;
  readonly playerId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
}

export interface ProgressView {
  readonly playerId: string;
  readonly courseId: string;
  readonly lessonId: string;
  readonly stepId: string;
  readonly completedAt?: string;
  readonly attempts: number;
}

export interface AttemptResultView {
  readonly stepId: string;
  readonly correct: boolean;
  readonly completedAt?: string;
  readonly attempts: number;
}

export interface SubmitAttemptRequest {
  readonly san?: string;
  readonly selectedIndex?: number;
}

// --- Studies (M14 inc 24) ------------------------------------------------------

export type StudyVisibility = 'public' | 'unlisted' | 'private';
export type StudyRole = 'owner' | 'contributor' | 'viewer';

export interface StudyView {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: StudyVisibility;
  readonly variant: Variant;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface StudyList {
  readonly total: number;
  readonly items: readonly StudyView[];
}

export interface ChapterView {
  readonly id: string;
  readonly studyId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly startingFen: string;
  readonly deletedAt?: string;
}

export interface ChapterList {
  readonly items: readonly ChapterView[];
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

export interface ChapterDetailView {
  readonly chapter: ChapterView;
  readonly tree: readonly TreeNodeView[];
}

export interface CollaboratorView {
  readonly studyId: string;
  readonly playerId: string;
  readonly role: StudyRole;
}

export interface CollaboratorList {
  readonly items: readonly CollaboratorView[];
}

// --- WebAuthn / Passkeys (M14 inc 44) ---------------------------------------

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string | null;
}

export interface WebAuthnRegisterOptions {
  readonly challenge: string;
  readonly rp: { readonly name: string; readonly id: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: string; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: string;
  readonly authenticatorSelection: { readonly userVerification: string; readonly residentKey: string };
}

export interface WebAuthnRegisterVerifyRequest {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
  };
}

export interface WebAuthnLoginOptionsRequest {
  readonly handle: string;
}

export interface WebAuthnLoginOptions {
  readonly challenge: string;
  readonly timeout: number;
  readonly rpId: string;
  readonly userVerification: string;
  readonly allowCredentials?: readonly {
    readonly type: string;
    readonly id: string;
    readonly transports?: readonly string[];
  }[];
}

export interface WebAuthnLoginVerifyRequest {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
}

// --- Engine Analysis (M15 inc 2) -------------------------------------------

// --- Opening Exploration (M15 inc 19, ADR-0127) -----------------------------

export interface OpeningExplorationRequest {
  readonly variant: string;
  /** UCI, from the standard starting position, ply 1 first. The server caps the length at 60. */
  readonly moves: readonly string[];
  /** Optional; when sent it must be the standard starting position, which is all the server serves. */
  readonly initialFen?: string;
}

/**
 * One book move out of the identified line.
 *
 * Carries no statistics, and must not grow one from this side either. The bundled dataset's
 * win-rate figures are illustrative rather than measured, so the server publishes no field for
 * them (ADR-0127) — rendering an invented number is the failure this shape exists to prevent.
 */
export interface OpeningContinuationView {
  readonly move: string;
  readonly san: string | null;
  readonly eco: string | null;
  readonly name: string | null;
}

export interface OpeningExplorationResponse {
  /** The sequence the server answered about, echoed so a late response can be recognised as stale. */
  readonly moves: readonly string[];
  readonly found: boolean;
  readonly eco: string | null;
  readonly name: string | null;
  readonly matchedMoves: number;
  readonly outOfBook: boolean;
  readonly continuations: readonly OpeningContinuationView[];
}

export interface AnalysisEvaluation {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

export interface AnalysisLine {
  readonly multipv: number;
  readonly evaluation: AnalysisEvaluation;
  readonly moves: readonly string[];
  readonly depth: number;
  readonly nodes: number;
  readonly timeMs: number;
}

export interface AppliedAnalysisLimits {
  readonly depth: number;
  readonly movetimeMs: number;
  readonly multiPv: number;
  readonly nodes?: number;
}

export interface TerminalOutcome {
  readonly reason: string;
  readonly result: string;
}

export interface AnalysisResponse {
  readonly fen: string;
  readonly variant: string;
  readonly applied: AppliedAnalysisLimits;
  readonly lines: readonly AnalysisLine[];
  /**
   * Present when the position is already decided, in which case `lines` is empty and no engine ran.
   */
  readonly terminal?: TerminalOutcome;
}

export interface AnalyzeRequest {
  readonly fen: string;
  readonly variant: string;
  readonly depth?: number;
  readonly nodes?: number;
  readonly movetimeMs?: number;
  readonly multiPv?: number;
}

// --- Puzzle Generation (M15 inc 17) ----------------------------------------

export type PuzzleEvidence =
  | { readonly kind: 'centipawn_gap'; readonly gapCp: number }
  | {
      readonly kind: 'mate';
      readonly relation: 'forces_mate' | 'avoids_mate' | 'faster_mate' | 'delays_mate';
      readonly distanceGap: number | null;
    };

export type PuzzleGenerationResponse =
  | {
      readonly kind: 'puzzle';
      readonly fen: string;
      readonly variant: string;
      readonly evidence: PuzzleEvidence;
      readonly bestMove: string;
      readonly comparisonMove: string;
      readonly bestEvaluation: AnalysisEvaluation;
      readonly comparisonEvaluation: AnalysisEvaluation;
      readonly depth: number;
      readonly solutionMove: string;
      readonly solutionLine: readonly string[];
      readonly difficulty: 'easy' | 'medium' | 'hard' | 'brilliant';
    }
  | {
      readonly kind: 'no_tactic';
      readonly fen: string;
      readonly variant: string;
      readonly evidence: PuzzleEvidence;
      readonly bestMove: string;
      readonly comparisonMove: string;
      readonly bestEvaluation: AnalysisEvaluation;
      readonly comparisonEvaluation: AnalysisEvaluation;
      readonly depth: number;
    }
  | {
      readonly kind: 'insufficient';
      readonly fen: string;
      readonly variant: string;
      readonly reason: string;
      readonly bestMove: string | null;
      readonly comparisonMove: string | null;
      readonly terminal?: { readonly reason: string; readonly result: string };
    };

export interface PuzzleGenerationRequest {
  readonly fen: string;
  readonly variant: string;
}

// --- Move Explanation (M15 inc 4) ------------------------------------------

export type MoveOutcome =
  | { readonly kind: 'evaluation'; readonly evalKind: 'cp' | 'mate'; readonly evalValue: number; readonly evalLabel: string }
  | { readonly kind: 'terminal'; readonly reason: string; readonly result: string };

export interface MoveExplanationCitation {
  readonly moveOutcome: MoveOutcome;
  readonly evalKind: 'cp' | 'mate';
  readonly evalValue: number;
  readonly evalLabel: string;
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

export interface MoveExplanationResponse {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  readonly citation: MoveExplanationCitation;
  readonly providerId: string;
  readonly model: string;
}

export interface MoveExplanationRequest {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
}

// --- Mistake Prediction (M15 inc 5) ----------------------------------------

export type MistakeClassification = 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

export type MistakeMoveOutcome =
  | {
      readonly kind: 'evaluation';
      readonly evalKind: 'cp' | 'mate';
      readonly evalValue: number;
      readonly evalLabel: string;
    }
  | {
      readonly kind: 'terminal';
      readonly reason: string;
      readonly result: '1-0' | '0-1' | '1/2-1/2';
      readonly label: string;
    };

export interface MistakePredictionResponse {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly classification: MistakeClassification;
  readonly before: {
    readonly evalKind: 'cp' | 'mate';
    readonly evalValue: number;
    readonly evalLabel: string;
  };
  readonly after: MistakeMoveOutcome;
  readonly centipawnLoss: number | null;
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

export interface MistakePredictionRequest {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
}

// --- Endgame Trainer (M15 inc 20) -------------------------------------------

export interface EndgameNextRequest {
  readonly type?: string;
  readonly difficulty?: string;
  readonly id?: string;
}

export interface EndgamePosition {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly fen: string;
  readonly sideToMove: 'w' | 'b' | string;
  readonly objective: 'mate' | 'win' | 'draw';
  readonly difficulty: string;
  readonly technique: string | null;
}

export type EndgameLoss =
  | { readonly kind: 'centipawns'; readonly value: number }
  | { readonly kind: 'decisive' };

export interface EndgameAttemptRequest {
  readonly id: string;
  readonly move: string;
}

/** Shared by both branches, so a verdict can be rendered before discriminating. */
interface EndgameAttemptCommon {
  readonly id: string;
  readonly move: string;
  readonly fenAfter: string;
  readonly classification: 'optimal' | 'acceptable' | 'throws_result';
  readonly goalPreserved: boolean;
}

/** The game continued, so the engine has an opinion about the position. */
export interface EndgameJudgedResult extends EndgameAttemptCommon {
  readonly kind: 'judged';
  readonly evalBefore: AnalysisEvaluation;
  readonly evalAfter: AnalysisEvaluation;
  readonly loss: EndgameLoss;
  readonly betterMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
  readonly mateDistanceAfter: number | null;
}

/**
 * The move ended the game, so there is a result rather than a score (ADR-0116).
 *
 * Not a rare branch: in a mate trainer the winning move is checkmate and the classic blunder is
 * stalemate. A separate shape rather than nulled-out fields, so this can never be rendered as an
 * evaluation of 0.00.
 */
export interface EndgameTerminalResult extends EndgameAttemptCommon {
  readonly kind: 'terminal';
  readonly terminal: { readonly reason: string; readonly result: string };
}

export type EndgameAttemptResult = EndgameJudgedResult | EndgameTerminalResult;

// --- Coaching (M15 inc 21, ADR-0129) ---------------------------------------

/**
 * Why a coaching section carries no value.
 *
 * `unsupported` and `unavailable` are different answers and the UI shows different words for them:
 * a feature this server never built will not appear because the reader tried again, while one that
 * failed on this request may well answer the next.
 */
export type CoachOmissionReason =
  | 'not_requested'
  | 'not_applicable'
  | 'unsupported'
  | 'unavailable'
  | 'cancelled';

/** Always one of the two shapes — never an absent key, never `null`. */
export type CoachSection<T> =
  | {
      readonly kind: 'present';
      readonly value: T;
    }
  | {
      readonly kind: 'omitted';
      readonly reason: CoachOmissionReason;
    };

/**
 * A tactic in the position, without the tactic.
 *
 * There is no solution field here and the server sends none: `/v1/analysis/puzzle` publishes the
 * solution because a caller studying their own position asked for it, but a coaching hint that hands
 * over the answer has stopped being a hint (ADR-0129 §3).
 */
export interface CoachPuzzle {
  readonly kind: 'puzzle';
  readonly fen: string;
  readonly variant: string;
  readonly difficulty: 'easy' | 'medium' | 'hard' | 'brilliant';
}

export interface CoachRequest {
  readonly fen: string;
  readonly variant: string;
  readonly move?: string;
  readonly moves?: readonly string[];
}

/** Each section reuses the model of the feature's own endpoint, because the server reuses its view. */
export interface CoachResponse {
  readonly fen: string;
  readonly variant: string;
  readonly move: string | null;
  readonly mistake: CoachSection<MistakePredictionResponse>;
  readonly explanation: CoachSection<MoveExplanationResponse>;
  readonly opening: CoachSection<OpeningExplorationResponse>;
  readonly puzzle: CoachSection<CoachPuzzle>;
  readonly endgame: CoachSection<EndgamePosition>;
  readonly featuresFired: readonly string[];
}

export type GameReviewClassification =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder' | 'missed_win';

/** A single assessed player move as returned by the game-review API. */
export interface GameReviewMove {
  readonly ply: number;
  readonly san: string;
  readonly move: string;
  readonly fenBefore: string;
  readonly assessment: MistakePredictionResponse;
  readonly classification: GameReviewClassification;
}

/**
 * The complete or partial game-review API response.
 *
 * Discriminated on `isPartial`: when false the review covers every player move; when true it was
 * capped at the server move limit and `cutoffReason` names the cause.
 */
export type GameReviewResponse = {
  readonly gameId: string;
  readonly variant: string;
  readonly playerColor: 'white' | 'black';
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly GameReviewMove[];
  readonly summary: Readonly<Record<GameReviewClassification, number>>;
  readonly totalPlayerMoves: number;
  readonly analyzedPlayerMoves: number;
} & (
  | { readonly isPartial: false; readonly cutoffReason?: never }
  | { readonly isPartial: true; readonly cutoffReason: 'move_limit' }
);

// --- Study Partner v1 -------------------------------------------------------

export type StudyPartnerExplanation = Omit<MoveExplanationResponse, 'providerId' | 'model'>;

export interface StudyPartnerCoaching {
  readonly version: 1;
  readonly fen: string;
  readonly variant: 'standard';
  readonly move: string;
  readonly mistake: CoachSection<MistakePredictionResponse>;
  readonly explanation: CoachSection<StudyPartnerExplanation>;
  readonly opening: CoachSection<OpeningExplorationResponse>;
  readonly puzzle: CoachSection<CoachPuzzle>;
  readonly endgame: CoachSection<EndgamePosition>;
}

export interface StudyPartnerTurn {
  readonly id: string;
  readonly turnNumber: number;
  readonly move: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly coaching: StudyPartnerCoaching;
  readonly sessionVersion: number;
  readonly createdAt: string;
}

export interface StudyPartnerSession {
  readonly id: string;
  readonly variant: 'standard';
  readonly initialFen: string;
  readonly currentFen: string;
  readonly status: 'active' | 'completed';
  readonly version: number;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly turns: readonly StudyPartnerTurn[];
}

export interface SubmitStudyPartnerTurnResponse {
  readonly turn: StudyPartnerTurn;
  readonly replayed: boolean;
}


// --- Tournament commentary (M15 inc 22, ADR-0130) --------------------------

/**
 * What the engine said about the position the final move was played from.
 *
 * Kept separate from the prose it accompanies so a reader — and this client — can tell a
 * measurement from a sentence. The server never publishes a citation it did not measure.
 */
export interface CommentaryCitation {
  readonly fen: string;
  readonly move: string;
  readonly evalKind: 'cp' | 'mate';
  readonly evalValue: number;
  readonly evalLabel: string;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

/**
 * Commentary on a finished tournament game.
 *
 * Every field but `commentary` is derived by the server from the tournament and the game log; the
 * request carries path ids and no body at all. `fen` is the position the final move was played
 * *from*, not the position it produced.
 */
export interface TournamentGameCommentary {
  readonly tournamentId: string;
  readonly gameId: string;
  /** Zero-based round index. */
  readonly round: number;
  /** Display handle, never an account id. */
  readonly white: string;
  /** Display handle, never an account id. */
  readonly black: string;
  readonly result: string;
  /**
   * What the tournament recorded for this pairing, or null while it has not recorded one.
   *
   * A different fact from `result`: the log says how the game ended, the aggregate says how the
   * tournament scored it, and a director can make them disagree. Render both when they do.
   */
  readonly tournamentResult: string | null;
  readonly termination: string;
  readonly ply: number;
  readonly fen: string;
  readonly variant: string;
  readonly finalMove: { readonly uci: string; readonly san: string };
  readonly citation: CommentaryCitation;
  /** Generated prose. Never the source of any fact above it. */
  readonly commentary: string;
  readonly providerId: string;
  readonly model: string;
}

/** The tournament's own result vocabulary, which is wider than a game result. */
export type RoundRecapResult =
  | 'white_win'
  | 'black_win'
  | 'draw'
  | 'double_forfeit'
  | 'bye'
  | 'void';

/** One pairing of a round, as the tournament recorded it. */
export interface RoundRecapPairing {
  readonly white: string;
  /** Null for a bye, which has no opponent. */
  readonly black: string | null;
  readonly result: RoundRecapResult;
}

/** One row of the standings as they stood at the end of the recapped round. */
export interface RoundRecapStanding {
  readonly rank: number;
  readonly player: string;
  readonly points: number;
}

/**
 * A narrative recap of a round every pairing of which has a result.
 *
 * `standings` is the table as it stood at the end of *this* round, not the current one, so a recap
 * of an earlier round stays true after later rounds are played.
 */
export interface TournamentRoundRecap {
  readonly tournamentId: string;
  /** Zero-based round index. */
  readonly round: number;
  readonly results: readonly RoundRecapPairing[];
  readonly standings: readonly RoundRecapStanding[];
  /**
   * How many of `results` the narrative was given.
   *
   * Byes, voids and double forfeits have no spelling in the narrator's match vocabulary, so they
   * are published but withheld from the prompt. When this is below `results.length` the prose
   * covers fewer games than the round contained, and the UI has to say so.
   */
  readonly pairingsNarrated: number;
  /** Generated prose. Never the source of any fact above it. */
  readonly narrative: string;
  readonly providerId: string;
  readonly model: string;
}


/** One pairing of a generated round. A bye has a player and no opponent. */
export type TournamentRoundPairing =
  | {
      readonly kind: 'game';
      readonly white: string;
      readonly black: string;
      /** Null until the game has been launched for this pairing. */
      readonly gameId: string | null;
    }
  | { readonly kind: 'bye'; readonly player: string };

/**
 * A generated round.
 *
 * Deliberately carries no results: `GET /v1/tournaments/:id/rounds` publishes pairings only, so a
 * client cannot tell from this whether a round is complete or a game is finished. That is the
 * server's question to answer, and it answers it with a 409.
 */
export interface TournamentRound {
  readonly roundIndex: number;
  readonly pairings: readonly TournamentRoundPairing[];
}
