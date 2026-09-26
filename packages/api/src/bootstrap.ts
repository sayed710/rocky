/**
 * @packageDocumentation
 * `@chess-platform/api/pg` — the thin bootstrap layer that wires the API to real
 * Postgres-backed repositories. This is the only module that imports the `pg`
 * driver. It builds the {@link ApiDependencies} bundle (Postgres repositories +
 * scrypt hasher + HMAC token service + system clock + UUIDv7 ids) and hands it to
 * {@link createApiServer}, keeping all business logic driver-agnostic.
 */

import type { Pool } from 'pg';
import { uuidv7 } from '@chess-platform/persistence';
import type { EventStore, TournamentsRepository } from '@chess-platform/persistence';
import {
  createPool,
  PgGamesRepository,
  PostgresEventStore,
  PgRatingsRepository,
  PgSeeksRepository,
  PgSessionsRepository,
  PgTournamentsRepository,
  PgUsersRepository,
  PgIdentityTokensRepository,
  PgWebAuthnCredentialsRepository,
  PgWebAuthnLoginChallengesRepository,
  PgSeekAcceptor,
  PgGameStarter,
  PgAntiCheatReportRepository,
  PgBotBehaviorReportRepository,
  PgSearchRepository,
  PgSemanticSearchRepository,
  PgSocialGraphRepository,
  PgMessagingRepository,
  PgCommunityRepository,
  PgAchievementsRepository,
  PgStudiesRepository,
  PgLearningRepository,
  PgStudyPartnerRepository,
  missingMigrations,
} from '@chess-platform/persistence/pg';
import { HashingEmbeddingProvider, SEARCH_EMBEDDING_DIMENSIONS } from '@chess-platform/search';
import type { EmbeddingProvider, SearchRepository, SemanticSearchRepository } from '@chess-platform/search';
import type { SocialGraphRepository } from '@chess-platform/social';
import type { MessagingRepository } from '@chess-platform/messaging';
import type { CommunityRepository } from '@chess-platform/community';
import type { EmailSender } from './ports/email';
import { createEmailSenderFromEnv } from './email/composition';
import { JsonLogger } from './ports/logger';
import type { Logger, LogLevel } from './ports/logger';
import { InMemoryMetrics } from './ports/metrics';
import type { Metrics } from './ports/metrics';
import { RecordingTracer, resolveTracesSampler } from './ports/tracer';
import type { Tracer } from './ports/tracer';
import { LoggingSpanExporter, MultiSpanExporter, spanSinkFromExporter } from './ports/span-export';
import {
  OtlpJsonSpanExporter,
  FetchSpanTransport,
  resolveOtlpTracesEndpoint,
} from './ports/otlp-span-exporter';
import { BatchSpanProcessor } from './ports/batch-span-processor';
import { ScryptPasswordHasher } from './auth/password';

import type { PasswordHasher } from './auth/password';
import { AccessTokenService } from './auth/tokens';
import { resolveConfig } from './config';
import type { ApiConfigInput } from './config';
import type { ApiDependencies, OptionalDependencies, Repositories } from './deps';
import type { AuditEntry, AuditRepository } from './ports/audit';
import { cryptoChess960Start } from './ports/chess960';
import { systemClock } from './ports/clock';
import type { Clock } from './ports/clock';
import { uuidv7Generator } from './ports/ids';
import type { IdGenerator } from './ports/ids';
import { PgRateLimiter } from './ports/pg-rate-limiter';
import type { RateLimiter } from './ports/rate-limiter';
import { createApiServer } from './server';
import type { ApiServer, ApiServerOptions } from './server';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';
import { DurableGameLauncher } from './tournament/durable-launcher';
import { DurableTournamentLiveView } from './tournament/durable-live-view';
import { DurableFinishedGameArchive } from './tournament/durable-finished-game';
import type { FinishedGameArchive } from './tournament/finished-game';
import { DurableFinishedGameReviewArchive } from './game-review/finished-game-review';
import { createGameReview } from './game-review/composition';
import {
  createTournamentCommentary,
  RepositoryPlayerHandles,
  RepositoryTournamentLookup,
} from './commentary/composition';
import type { AnalysisProvider } from '@chess-platform/engine';
import { EngineBackedEvaluator } from '@chess-platform/anti-cheat/engine';
import { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import {
  analysisCacheSettingsFromEnv,
  createAnalysisFromEnv,
  createMistakePrediction,
  createPuzzleGeneration,
} from './analysis/composition';
import { createAnalysisCacheComposition } from './analysis/durable-cache';
import { createOpeningExploration } from './openings/composition';
import { createAiFromEnv, createMoveExplanation } from './ai/composition';
import { createEndgameTraining } from './endgames/composition';
import { createCoach } from './coach/composition';
import type { CoachFeatureFactory } from './coach/coach-service';
import { StudyPartnerService } from './study-partner/service';
import { EventStoreGameSource } from './anti-cheat/source';
import { EventStoreBotTimingSource } from './bot-detection/source';


/** Postgres-backed {@link AuditRepository} writing to the `audit_log` table. */
export class PgAuditRepository implements AuditRepository {
  constructor(
    private readonly pool: Pool,
    private readonly ids: IdGenerator = uuidv7Generator,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (id, actor_id, action, target, meta, request_id, trace_id, ip, user_agent, ts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        this.ids.next(),
        entry.actorId,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.meta ?? {}),
        entry.requestId ?? null,
        entry.traceId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        new Date(entry.at),
      ],
    );
  }
}

/** Construct the full Postgres-backed repository bundle from a pool. */
export function createPgRepositories(
  pool: Pool,
  ids: IdGenerator = uuidv7Generator,
  events: EventStore = new PostgresEventStore(pool),
): Repositories {
  return {
    events,
    users: new PgUsersRepository(pool),
    sessions: new PgSessionsRepository(pool),
    ratings: new PgRatingsRepository(pool),
    games: new PgGamesRepository(pool),
    seeks: new PgSeeksRepository(pool),
    audit: new PgAuditRepository(pool, ids),
    identityTokens: new PgIdentityTokensRepository(pool),
    webauthnCredentials: new PgWebAuthnCredentialsRepository(pool),
    webauthnLoginChallenges: new PgWebAuthnLoginChallengesRepository(pool),
    seekAcceptor: new PgSeekAcceptor(pool),
    gameStarter: new PgGameStarter(pool),
    antiCheat: new PgAntiCheatReportRepository(pool),
    botReports: new PgBotBehaviorReportRepository(pool),
    studyPartner: new PgStudyPartnerRepository(pool),
  };
}

/** Options for the Postgres bootstrap. */
export interface PgBootstrapOptions {
  /** An existing pool; when omitted one is created from `connectionString`/`DATABASE_URL`. */
  readonly pool?: Pool;
  readonly connectionString?: string;
  readonly config?: ApiConfigInput;
  readonly hasher?: PasswordHasher;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly rateLimiter?: RateLimiter;
  readonly server?: ApiServerOptions;
  readonly tournamentRepo?: TournamentsRepository;
  readonly gameLauncher?: GameLauncher;
  readonly liveView?: TournamentLiveView;
  /** Finished-game reader (ADR-0130). Defaults to the durable event-log adapter. */
  readonly finishedGames?: FinishedGameArchive;
  readonly emailSender?: EmailSender;
  /** Backs anti-cheat evaluation. Distinct from {@link PgBootstrapOptions.analysis}. */
  readonly analysisProvider?: AnalysisProvider;
  /** Engine analysis subsystem (ADR-0113). Defaults to {@link createAnalysisFromEnv}. */
  readonly analysis?: import('./analysis/composition').AnalysisComposition | undefined;
  /** AI subsystem behind Move Explanation (ADR-0115). Defaults to {@link createAiFromEnv}. */
  readonly ai?: import('./ai/composition').AiComposition | undefined;
  /** Opening identification (ADR-0127). Defaults to {@link createOpeningExploration}. */
  readonly openingExploration?:
    | import('./openings/opening-exploration-service').OpeningExplorationService
    | undefined;
  /** Endgame training (ADR-0128). Defaults to {@link createEndgameTraining}. */
  readonly endgameTraining?:
    | import('./endgames/endgame-training-service').EndgameTrainingService
    | undefined;
  readonly searchRepository?: SearchRepository;
  readonly semanticSearchRepository?: SemanticSearchRepository;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly socialGraphRepository?: SocialGraphRepository;
  readonly messagingRepository?: MessagingRepository;
  readonly communityRepository?: CommunityRepository;
  readonly achievementsRepository?: import('@chess-platform/achievements').AchievementsRepository;
  readonly studiesRepository?: import('@chess-platform/studies').StudiesRepository;
  readonly learningRepository?: import('@chess-platform/learning').LearningRepository;
  readonly graphql?: import('./graphql').GraphQLOptions;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly tracer?: Tracer;
}

/** Resolve the log level from `LOG_LEVEL`, defaulting to `info`. */
function resolveLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/**
 * Build the {@link ApiDependencies} bundle backed by Postgres.
 *
 * Returns `shutdownAnalysis` alongside the pool because the analysis subsystem owns engine
 * subprocesses (ADR-0113), and the event store owns a separate advisory-lock pool. Call it after
 * draining HTTP requests and before closing the main pool.
 */
export function createPgDependencies(options: PgBootstrapOptions = {}): {
  deps: ApiDependencies;
  pool: Pool;
  shutdownAnalysis: () => Promise<void>;
} {
  const pool =
    options.pool ??
    createPool(options.connectionString ? { connectionString: options.connectionString } : {});
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidv7Generator;
  const config = resolveConfig(options.config);
  const metrics = options.metrics ?? new InMemoryMetrics();
  const hasher = options.hasher ?? new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const rateLimiter = options.rateLimiter ?? new PgRateLimiter(pool);
  const tournamentRepo = options.tournamentRepo ?? new PgTournamentsRepository(pool);
  // Declared here rather than beside the tracer below, because the anti-cheat source now takes it:
  // a stored game that cannot be replayed is contained rather than thrown, and containment without a
  // log is indistinguishable from an ordinary miss (ADR-0137 §9).
  const logger = options.logger ?? new JsonLogger({ service: 'api' }, { level: resolveLogLevel() });

  const eventStore = new PostgresEventStore(pool);
  const gameLauncher = options.gameLauncher ?? new DurableGameLauncher(eventStore, clock, config.noShow.tournamentMs);
  const repos = createPgRepositories(pool, ids, eventStore);
  const antiCheatAnalysis = options.analysisProvider
    ? new AntiCheatAnalysisService(
        new EventStoreGameSource(eventStore, logger),
        (variant) => new EngineBackedEvaluator(options.analysisProvider!, variant),
        repos.antiCheat,
      )
    : undefined;

  // Engine analysis (ADR-0113) on its own dedicated pool, distinct from `options.analysisProvider`
  // above — that one backs anti-cheat evaluation and is a different workload with different limits.
  // Composes only when an engine binary is configured; otherwise `deps.analysis` stays undefined,
  // `GET /v1/capabilities` reports `analysis: false`, and the route answers 503.
  //
  // The cache tier (ADR-0138) is passed as a factory, not a value, so it is built only on the branch
  // where an engine exists — a deployment without one opens no cache pool and starts no sweeper. It
  // resolves its connection string exactly as the main pool above did, including the part that says
  // an injected `pool` is the caller taking over connection management: reaching past it to
  // `DATABASE_URL` would open a second, real pool underneath a caller that supplied its own — which
  // in a test suite means connecting to whatever database happens to be configured.
  // An empty string is "not supplied", exactly as the main pool above reads it. `??` alone would
  // keep it, so the pool would fall back to `DATABASE_URL` and connect while the cache pool threw
  // on a blank DSN — turning a bootstrap that used to work into a startup failure. The cache must
  // not be stricter about its connection string than the pool it sits beside.
  const suppliedConnectionString =
    options.connectionString !== undefined && options.connectionString !== ''
      ? options.connectionString
      : undefined;
  const cacheConnectionString =
    suppliedConnectionString ?? (options.pool === undefined ? process.env['DATABASE_URL'] : undefined);
  const analysisComposition =
    options.analysis ??
    createAnalysisFromEnv(process.env, () =>
      createAnalysisCacheComposition({
        settings: analysisCacheSettingsFromEnv(process.env),
        logger,
        metrics,
        ...(cacheConnectionString !== undefined
          ? { connectionString: cacheConnectionString }
          : {}),
      }),
    );

  // Move Explanation (ADR-0115) needs *both* halves: an AI provider to write the prose and the
  // analysis subsystem above to ground it. Either one missing composes nothing, which is the point
  // — an explanation with no engine behind it is exactly the unfounded verdict this feature exists
  // to prevent, so "AI configured but no engine" must not degrade into one.
  //
  // It borrows `analysisComposition.service` rather than building anything engine-shaped of its own,
  // so this adds no pool, no worker and no shutdown handle. See `ai/composition.ts` on why the AI
  // subsystem has no lifecycle to dispose.
  const aiComposition = options.ai ?? createAiFromEnv();
  const moveExplanation =
    aiComposition && analysisComposition
      ? createMoveExplanation(aiComposition, analysisComposition.service)
      : undefined;

  // Mistake Prediction (ADR-0118) needs only the analysis subsystem. Unlike Move Explanation it makes
  // no provider call at all — the classification is derived from the rules and the engine — so a
  // deployment with an engine and no AI configuration gets the whole feature rather than a degraded
  // one. It borrows the same `AnalysisService`, so this adds no pool, no worker and no shutdown
  // handle.
  const mistakePrediction = analysisComposition
    ? createMistakePrediction(analysisComposition.service)
    : undefined;
  const puzzleGeneration = analysisComposition
    ? createPuzzleGeneration(analysisComposition.service)
    : undefined;

  // Opening exploration (ADR-0127) is composed unconditionally: it borrows nothing from the
  // analysis subsystem and needs no provider, so it is available on a deployment that has neither.
  const openingExploration = options.openingExploration ?? createOpeningExploration();

  // Endgame training (ADR-0128) borrows the analysis subsystem.
  const endgameTraining = options.endgameTraining ?? (analysisComposition
    ? createEndgameTraining(analysisComposition.service)
    : undefined);

  // Coaching (ADR-0129) composes the five features above and owns nothing else.
  //
  // A factory rather than a fixed bundle because the three engine-backed services must be built
  // over the *request-scoped* analysis port: that is what de-duplicates the search two of them both
  // make of the same position, and what carries the request's cancellation signal into all of them.
  // They are stateless wrappers over a library object and a fixed policy — no I/O, no pool, no
  // handle — so building them per request is cheap.
  //
  // The two engineless services are passed straight through, deliberately. `explore` and
  // `identify` make no engine call at all, so there is nothing for a scoped port to de-duplicate or
  // cancel, and rebuilding them per request would re-read a bundled dataset for no gain. The
  // parameter is ignored for exactly that reason.
  const coachFeatures: CoachFeatureFactory = (analysis) => ({
    ...(analysis && aiComposition ? { moveExplanation: createMoveExplanation(aiComposition, analysis) } : {}),
    ...(analysis ? { mistakePrediction: createMistakePrediction(analysis) } : {}),
    ...(analysis ? { puzzleGeneration: createPuzzleGeneration(analysis) } : {}),
    ...(openingExploration ? { openingExploration } : {}),
    ...(endgameTraining ? { endgameTraining } : {}),
  });
  const coach = createCoach({
    ...(analysisComposition ? { analysis: analysisComposition.service } : {}),
    features: coachFeatures,
  });
  const studyPartner = coach
    ? new StudyPartnerService({ repository: repos.studyPartner, coach, clock, ids })
    : undefined;

  // Tournament commentary (ADR-0130) borrows the same analysis subsystem and the same AI
  // orchestrator, and owns three reads of its own: the tournament aggregate, the durable game log,
  // and the handle behind a player id. It adds no pool, no worker and no shutdown handle.
  const tournamentCommentary = createTournamentCommentary({
    ...(aiComposition ? { ai: aiComposition } : {}),
    ...(analysisComposition ? { analysis: analysisComposition.service } : {}),
    archive: options.finishedGames ?? new DurableFinishedGameArchive(eventStore),
    tournaments: new RepositoryTournamentLookup(tournamentRepo),
    players: new RepositoryPlayerHandles(repos.users),
  });
  const gameReview = analysisComposition
    ? createGameReview(analysisComposition.service, new DurableFinishedGameReviewArchive(eventStore))
    : undefined;

  const searchEnabled = process.env['SEARCH_ENABLED'] !== '0';
  const searchRepository = searchEnabled
    ? (options.searchRepository ?? new PgSearchRepository(pool))
    : undefined;

  const semanticSearchEnabled = searchEnabled && process.env['SEMANTIC_SEARCH_ENABLED'] !== '0';
  const semanticSearchRepository = semanticSearchEnabled
    ? (options.semanticSearchRepository ?? new PgSemanticSearchRepository(pool))
    : undefined;
  const embeddingProvider = semanticSearchEnabled
    ? (options.embeddingProvider ?? new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS))
    : undefined;

  const socialEnabled = process.env['SOCIAL_ENABLED'] !== '0';
  const socialGraphRepository = socialEnabled
    ? (options.socialGraphRepository ?? new PgSocialGraphRepository(pool))
    : undefined;

  const messagingEnabled = socialEnabled && process.env['MESSAGING_ENABLED'] !== '0';
  const messagingRepository = messagingEnabled && socialGraphRepository
    ? (options.messagingRepository ?? new PgMessagingRepository(pool, socialGraphRepository))
    : undefined;

  const communityEnabled = process.env['COMMUNITY_ENABLED'] !== '0';
  const communityRepository = communityEnabled
    ? (options.communityRepository ?? new PgCommunityRepository(pool))
    : undefined;

  // Opt-in, and the same flag the gateway worker reads. Defaulted on, the routes would come up
  // against any database that has not applied migration 0018 — a table that does not exist, behind
  // an endpoint that answers 200 until someone calls it. A 503 from an unconfigured subsystem is a
  // better answer than a 500 from a missing table.
  const achievementsEnabled = process.env['ACHIEVEMENTS_ENABLED'] === '1';
  const achievementsRepository = achievementsEnabled
    ? (options.achievementsRepository ?? new PgAchievementsRepository(pool))
    : undefined;

  const studiesEnabled = process.env['STUDIES_ENABLED'] === '1';
  const studiesRepository = studiesEnabled
    ? (options.studiesRepository ?? new PgStudiesRepository(pool))
    : undefined;

  const learningEnabled = process.env['LEARNING_ENABLED'] === '1';
  const learningRepository = learningEnabled
    ? (options.learningRepository ?? new PgLearningRepository(pool))
    : undefined;

  // The GraphQL layer owns no repository of its own — it reads through the optional ones above, so
  // enabling it while a subsystem is switched off yields errors on that subsystem's fields and
  // working answers everywhere else. Introspection is a second, separate opt-in (ADR-0073).
  const graphql = process.env['GRAPHQL_ENABLED'] === '1'
    ? (options.graphql ?? { introspection: process.env['GRAPHQL_INTROSPECTION'] === '1' })
    : undefined;

  const logExporter = new LoggingSpanExporter(logger);
  const otlpTracesUrl = resolveOtlpTracesEndpoint(
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  );
  const exporter = otlpTracesUrl
    ? new MultiSpanExporter([
        logExporter,
        new BatchSpanProcessor(
          new OtlpJsonSpanExporter(new FetchSpanTransport(otlpTracesUrl), {
            serviceName: 'api',
            scopeName: '@chess-platform/api',
            scopeVersion: '0.1.0',
          }),
          { metrics },
        ),
      ])
    : logExporter;
  // The Helm chart renders OTEL_TRACES_SAMPLER_ARG onto this Deployment (ADR-0062), so the API has
  // to honour it — otherwise the knob is documented, deployable, and silently ignored.
  const { sampler, warning: samplerWarning } = resolveTracesSampler(
    process.env['OTEL_TRACES_SAMPLER_ARG'],
  );
  if (samplerWarning) {
    logger.warn(samplerWarning);
  }
  const tracer =
    options.tracer ??
    new RecordingTracer({
      sink: spanSinkFromExporter(exporter),
      sampler,
    });

  // Every optional dependency, named in one place. `OptionalDependencies` makes each key
  // mandatory here, so composing a feature above and forgetting it below is a build failure rather
  // than a deployment that configured the feature and still answers 503. That is the production
  // half of the defect ADR-0131 closes; the forwarding half lives in `server.ts`.
  //
  // The conditional spreads this replaces (`...(coach ? { coach } : {})`) left a key absent rather
  // than `undefined`. Nothing distinguishes the two: the package does not set
  // `exactOptionalPropertyTypes`, and every consumer asks `!== undefined` rather than probing with
  // `in` or `Object.keys`.
  const optional: OptionalDependencies = {
    antiCheatAnalysis,
    botTimingSource: new EventStoreBotTimingSource(eventStore),
    // The production draw for a new Chess960 game's arrangement (ADR-0137). Named explicitly rather
    // than left to `createApiServer`'s default, so the deployed entropy source is visible here beside
    // every other composed dependency instead of only in the fallback.
    chess960Starts: cryptoChess960Start,
    searchRepository,
    semanticSearchRepository,
    embeddingProvider,
    socialGraphRepository,
    messagingRepository,
    communityRepository,
    achievementsRepository,
    studiesRepository,
    learningRepository,
    graphql,
    analysis: analysisComposition?.service,
    moveExplanation,
    mistakePrediction,
    puzzleGeneration,
    openingExploration,
    endgameTraining,
    coach,
    studyPartner,
    tournamentCommentary,
    gameReview,
    // Production observability (M13): structured logs to stdout, a scrape
    // registry backing GET /v1/metrics, and tracer emitting spans to logs.
    logger,
    metrics,
    tracer,
    /**
     * Ready means the database can answer, and that it holds the schema this build was written
     * against. `SELECT 1` alone proved only the first.
     *
     * The difference is not academic — it is the sign-in 500 this check was added for. A reachable
     * but un-migrated database has no `rate_limit_buckets` (migration 0004), so `POST /v1/auth/login`
     * dies with `undefined_table` in the rate limiter before it ever reaches a credential, and every
     * other rate-limited route with it. Under `SELECT 1` the probe called that instance ready:
     * measured against a real server, `GET /v1/ready` returned 200 on a database with no schema at
     * all and on one migrated to 3 of 27. That answer is what admits traffic to a Kubernetes pod and
     * what releases the gateway's and the search indexer's `wait-for-api` init containers, and the
     * chart's migrate init container is behind a toggle — so nothing else was standing between a
     * skipped migration and a fleet serving 500s.
     *
     * Failing here is deliberately the *safer* direction. A pod that stays NotReady keeps traffic on
     * whichever pods can serve it and stalls a bad rollout into a rollback; the alternative is
     * admitting traffic that is certain to fail. The reason is logged rather than returned, because
     * `/v1/ready` is public and how far behind a deployment's schema is, is not a stranger's business.
     */
    readiness: async () => {
      await pool.query('SELECT 1');
      const missing = await missingMigrations(pool);
      if (missing.length > 0) {
        logger.error('database schema is behind this build', {
          missingCount: missing.length,
          firstMissingVersion: missing[0],
        });
        throw new Error('database schema is not migrated');
      }
    },
  };

  const deps: ApiDependencies = {
    repos,
    hasher,
    tokens,
    clock,
    ids,
    config,
    rateLimiter,
    tournamentRepo,
    gameLauncher,
    liveView: options.liveView ?? new DurableTournamentLiveView(tournamentRepo, eventStore),
    emailSender: options.emailSender ?? createEmailSenderFromEnv(process.env, metrics),
    ...optional,
  };
  return {
    deps,
    pool,
    shutdownAnalysis: async () => {
      try {
        await analysisComposition?.shutdown();
      } finally {
        await eventStore.closePlayerLocks();
      }
    },
  };
}

/**
 * One-call production wiring: build Postgres dependencies and the API server.
 * Returns the server, the pool, and the analysis shutdown handle so the caller can close
 * everything on shutdown.
 */
export function createPgApiServer(options: PgBootstrapOptions = {}): {
  server: ApiServer;
  pool: Pool;
  shutdownAnalysis: () => Promise<void>;
} {
  const { deps, pool, shutdownAnalysis } = createPgDependencies(options);
  const server = createApiServer(deps, options.server);
  return { server, pool, shutdownAnalysis };
}

export { uuidv7 };
