/**
 * @packageDocumentation
 * The dependency bundle wired into the API. Everything the services and routes
 * need arrives here explicitly (constructor injection) — there are no module-level
 * singletons, so the whole server can be constructed with in-memory fakes for
 * tests or Postgres-backed implementations in production without changing a line
 * of route or service code.
 */

import type {
  GamesRepository,
  RatingsRepository,
  SeekAcceptor,
  GameStarter,
  SeeksRepository,
  SessionsRepository,
  UsersRepository,
  TournamentsRepository,
  IdentityTokensRepository,
  WebAuthnCredentialsRepository,
  WebAuthnLoginChallengesRepository,
  StudyPartnerRepository,
  EventStore,
} from '@chess-platform/persistence';
import type { PasswordHasher } from './auth/password';
import type { AccessTokenService } from './auth/tokens';
import type { AuditRepository } from './ports/audit';
import type { Chess960StartSelector } from './ports/chess960';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import type { RateLimiter } from './ports/rate-limiter';
import type { ApiConfig } from './config';
import type { GameLauncher } from './tournament/launcher';
import type { AntiCheatReportRepository, BotBehaviorReportRepository } from '@chess-platform/anti-cheat';
import type { TournamentLiveView } from './tournament/live-view';
import type { EmailSender } from './ports/email';
import type { Logger } from './ports/logger';
import type { Metrics } from './ports/metrics';
import type { Tracer } from './ports/tracer';
import type { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import type { BotGameTimingSource } from './bot-detection/source';
import type { EmbeddingProvider, SearchRepository, SemanticSearchRepository } from '@chess-platform/search';
import type { SocialGraphRepository } from '@chess-platform/social';
import type { MessagingRepository } from '@chess-platform/messaging';
import type { CommunityRepository } from '@chess-platform/community';
import type { AnalysisService } from './analysis/service';

/** The full set of repositories the API consumes. */
export interface Repositories {
  readonly events: EventStore;
  readonly users: UsersRepository;
  readonly sessions: SessionsRepository;
  readonly ratings: RatingsRepository;
  readonly games: GamesRepository;
  readonly seeks: SeeksRepository;
  readonly audit: AuditRepository;
  readonly identityTokens: IdentityTokensRepository;
  readonly webauthnCredentials: WebAuthnCredentialsRepository;
  readonly webauthnLoginChallenges: WebAuthnLoginChallengesRepository;
  readonly seekAcceptor: SeekAcceptor;
  readonly gameStarter: GameStarter;
  readonly antiCheat: AntiCheatReportRepository;
  readonly botReports: BotBehaviorReportRepository;
  readonly studyPartner: StudyPartnerRepository;
}

/** Everything `createApiServer` needs to construct the service. */
export interface ApiDependencies {
  readonly repos: Repositories;
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Draws the starting arrangement for a new Chess960 game (ADR-0137). Optional so every existing
   * caller keeps compiling; `createApiServer` falls back to the CSPRNG-backed selector.
   */
  readonly chess960Starts?: Chess960StartSelector;
  readonly config: ApiConfig;
  readonly rateLimiter: RateLimiter;
  readonly tournamentRepo: TournamentsRepository;
  readonly gameLauncher: GameLauncher;
  readonly liveView: TournamentLiveView;
  readonly emailSender: EmailSender;
  readonly antiCheatAnalysis?: AntiCheatAnalysisService;
  readonly botTimingSource?: BotGameTimingSource;
  /** Optional search index (M11). When absent, `GET /v1/search` responds 503. */
  readonly searchRepository?: SearchRepository;
  /** Optional semantic/vector index (M11 inc 11). Absent => `mode=semantic|hybrid` responds 503. */
  readonly semanticSearchRepository?: SemanticSearchRepository;
  /** Embeds the query text for semantic/hybrid modes. Absent => `mode=semantic|hybrid` responds 503. */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Optional social graph repository (M10 inc 2). When absent, `/v1/social/*` responds 503. */
  readonly socialGraphRepository?: SocialGraphRepository;
  /** Optional messaging repository (M10 inc 3). When absent, `/v1/messages/*` responds 503. */
  readonly messagingRepository?: MessagingRepository;
  /** Optional community repository (M10 inc 4). When absent, `/v1/teams/*` and `/v1/forum/*` respond 503. */
  readonly communityRepository?: CommunityRepository;
  /** Optional achievements repository (M10 inc 5). When absent, `/v1/achievements` and `/v1/players/:id/achievements` respond 503. */
  readonly achievementsRepository?: import('@chess-platform/achievements').AchievementsRepository;
  /** Optional studies repository (M10 inc 6). When absent, `/v1/studies/*` responds 503. */
  readonly studiesRepository?: import('@chess-platform/studies').StudiesRepository;
  /** Optional learning repository (M10 inc 7). When absent, `/v1/courses/*` responds 503. */
  readonly learningRepository?: import('@chess-platform/learning').LearningRepository;
  /** Optional engine analysis (ADR-0113). When absent, `POST /v1/analysis` responds 503. */
  readonly analysis?: AnalysisService;
  /**
   * Optional Move Explanation (ADR-0115). When absent, `POST /v1/ai/move-explanation` responds 503.
   *
   * Present only when an AI provider *and* the analysis subsystem above are both configured, since
   * an explanation is grounded in engine output and there is nothing to ground it in otherwise.
   */
  readonly moveExplanation?: import('./ai/move-explanation-service').MoveExplanationService;
  /**
   * Optional Mistake Prediction (ADR-0118). When absent, `POST /v1/analysis/mistake-prediction`
   * responds 503.
   *
   * Present whenever the analysis subsystem above is — and only then. It needs no AI provider: the
   * verdict is a rules-and-engine fact, so this capability tracks the engine alone.
   */
  readonly mistakePrediction?: import('./analysis/mistake-prediction-service').MistakePredictionService;
  /**
   * Optional engine-only puzzle generation (ADR-0125). When absent,
   * `POST /v1/analysis/puzzle` responds 503. Bootstrap composes it whenever analysis is available
   * and can honor the fixed evidence policy.
   */
  readonly puzzleGeneration?: import('./analysis/puzzle-generation-service').PuzzleGenerationService;
  /**
   * Optional opening identification (ADR-0127). When absent, `POST /v1/openings/explore` responds
   * 503.
   *
   * Independent of every other optional feature here, and of the engine: the answer is a bundled
   * table lookup plus a legality replay, so a deployment with no engine binary and no AI provider
   * serves this in full. Optional anyway, because a build carrying an empty dataset can identify
   * nothing and must be able to say so.
   */
  readonly openingExploration?: import('./openings/opening-exploration-service').OpeningExplorationService;
  /**
   * Optional endgame training (ADR-0128). When absent, `POST /v1/endgames/*` responds 503.
   * Composed whenever the analysis subsystem is available and can satisfy the fixed limits policy
   * and the bundled database is not empty.
   */
  readonly endgameTraining?: import('./endgames/endgame-training-service').EndgameTrainingService;
  /**
   * Coaching over the other feature services (ADR-0129).
   *
   * Present when at least one of them is, since it owns no dependency of its own — it is the five
   * services this deployment already built, sequenced.
   */
  readonly coach?: import('./coach/coach-service').CoachService;
  /** Private, durable Study Partner sessions composed only over the production CoachService. */
  readonly studyPartner?: import('./study-partner/service').StudyPartnerService;
  /**
   * Tournament commentary (ADR-0130). When absent, both commentary routes respond 503.
   *
   * Needs an engine to cite and a provider to write with, so it is composed only when the analysis
   * subsystem and the AI subsystem are both configured.
   */
  readonly tournamentCommentary?: import('./commentary/tournament-commentary-service').TournamentCommentaryService;
  /** Optional completed-game review. Absent means `POST /v1/games/:id/review` responds 503. */
  readonly gameReview?: import('./game-review/service').GameReviewService;
  /**
   * Optional GraphQL read layer (M10 inc 8). When absent, `POST /v1/graphql` responds 503.
   *
   * The subsystem repositories it resolves against are the optional ones above — it adds no data
   * source of its own, and a subsystem that is switched off degrades to an error on its own fields
   * rather than failing the whole query.
   */
  readonly graphql?: import('./graphql').GraphQLOptions;
  /** Structured logger (M13). Defaults to a silent {@link NullLogger}. */
  readonly logger?: Logger;
  /** Metrics registry + scrape target (M13). Defaults to {@link InMemoryMetrics}. */
  readonly metrics?: Metrics;
  /** Distributed-tracing tracer (M13). Defaults to a silent {@link NullTracer}. */
  readonly tracer?: Tracer;
  /** Production dependency check used by the readiness endpoint. */
  readonly readiness?: () => Promise<void>;
}
/**
 * The keys of {@link ApiDependencies} a caller may leave out: every optional feature, plus the four
 * observability defaults.
 *
 * Derived, never written out. A new optional dependency joins this union the moment it is declared
 * above, which is what lets {@link OptionalDependencies} refuse an assembly that forgets it.
 *
 * `{} extends Pick<T, K>` is the test for "K is optional on T" — an empty object satisfies a
 * one-property type only when that property may be absent. It is used in preference to
 * `undefined extends T[K]`, which would also catch a *required* property whose type happens to
 * include `undefined`; there is no such property here today, and this way there need never be a
 * reason to check.
 */
export type OptionalDependencyKey = {
  [K in keyof ApiDependencies]-?: {} extends Pick<ApiDependencies, K> ? K : never;
}[keyof ApiDependencies];

/**
 * Every optional dependency, named — the shape a composition root assembles before spreading it
 * into an {@link ApiDependencies}.
 *
 * The mapped type runs over a union alias rather than `keyof ApiDependencies`, so it is
 * non-homomorphic and TypeScript does not carry `?` across it: each key becomes required while its
 * value type still admits `undefined`. Writing `analysis: undefined` is therefore fine and
 * omitting the key is `TS2741`.
 *
 * This exists because composing a feature and forgetting to put it in the bundle is invisible
 * otherwise: the build passes, every test passes, and the feature answers 503 in production from a
 * deployment that configured it correctly. See ADR-0131.
 */
export type OptionalDependencies = { [K in OptionalDependencyKey]: ApiDependencies[K] };
