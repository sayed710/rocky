/**
 * Test harness: constructs a fully in-memory API server on an ephemeral port and
 * exposes helpers for authenticated and anonymous requests. Uses a low scrypt
 * cost and a manual clock so tests are fast and deterministic.
 */

import { closeServer, listenOnFetchablePort } from './listen';
import type { Role } from '@chess-platform/persistence';
import { ScryptPasswordHasher } from '../src/auth/password';
import { AccessTokenService } from '../src/auth/tokens';
import { resolveConfig } from '../src/config';
import type { ApiConfigInput } from '../src/config';
import { createInMemoryRepositories, InMemoryTournamentsRepository } from '../src/fakes';
import type { InMemoryRepositories } from '../src/fakes';
import { StudyPartnerService } from '../src/study-partner/service';
import type { Chess960StartSelector } from '../src/ports/chess960';
import { ManualClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import type { RateLimiter } from '../src/ports/rate-limiter';
import { createApiServer } from '../src/server';
import type { ApiServer } from '../src/server';
import { InMemoryGameLauncher } from '../src/tournament/launcher';
import type { GameLauncher } from '../src/tournament/launcher';
import { InMemoryEmailSender } from '../src/ports/email';
import type { EmailSender } from '../src/ports/email';
import { InMemoryEventStore } from '@chess-platform/persistence';
import type { PositionEvaluator } from '@chess-platform/anti-cheat';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';
import type { Logger } from '../src/ports/logger';
import type { Tracer } from '../src/ports/tracer';
import {
  HashingEmbeddingProvider,
  InMemorySearchRepository,
  InMemorySemanticSearchRepository,
  SEARCH_EMBEDDING_DIMENSIONS,
} from '@chess-platform/search';
import { createOpeningExploration } from '../src/openings/composition';
import { createEndgameTraining } from '../src/endgames/composition';
import { createCoach } from '../src/coach/composition';
import { createMistakePrediction, createPuzzleGeneration } from '../src/analysis/composition';
import { InMemorySocialGraphRepository } from '@chess-platform/social';
import { InMemoryMessagingRepository } from '@chess-platform/messaging';
import { InMemoryCommunityRepository } from '@chess-platform/community';
import { InMemoryAchievementsRepository } from '@chess-platform/achievements';


export const TEST_SECRET = 'test-access-token-secret-0123456789abcdef';
export const START_MS = 1_700_000_000_000;

/** The loopback address every harness binds; also the host in its `baseUrl`. */
const HARNESS_HOST = '127.0.0.1';

export interface Harness {
  readonly server: ApiServer;
  readonly repos: InMemoryRepositories;
  readonly tournamentRepo: InMemoryTournamentsRepository;
  readonly antiCheatEventStore: InMemoryEventStore;
  readonly searchRepository?: InMemorySearchRepository;
  readonly semanticSearchRepository?: InMemorySemanticSearchRepository;
  readonly embeddingProvider?: HashingEmbeddingProvider;
  readonly socialGraphRepository?: InMemorySocialGraphRepository;
  readonly messagingRepository?: InMemoryMessagingRepository;
  readonly communityRepository?: InMemoryCommunityRepository;
  readonly achievementsRepository?: InMemoryAchievementsRepository;
  readonly studiesRepository?: import('@chess-platform/studies').StudiesRepository;
  readonly learningRepository?: import('@chess-platform/learning').LearningRepository;
  readonly analysis?: import('../src/analysis/service').AnalysisService;
  readonly moveExplanation?: import('../src/ai/move-explanation-service').MoveExplanationService;
  readonly mistakePrediction?: import('../src/analysis/mistake-prediction-service').MistakePredictionService;
  readonly puzzleGeneration?: import('../src/analysis/puzzle-generation-service').PuzzleGenerationService;
  readonly openingExploration?: import('../src/openings/opening-exploration-service').OpeningExplorationService;
  readonly endgameTraining?: import('../src/endgames/endgame-training-service').EndgameTrainingService;
  readonly gameReview?: import('../src/game-review/service').GameReviewService;
  readonly clock: ManualClock;
  readonly tokens: AccessTokenService;
  readonly emailSender: InMemoryEmailSender;
  readonly baseUrl: string;
  makeUser(handle: string, roles?: Role[]): Promise<{ userId: string; token: string }>;
  json(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

/** Extra server dependencies a test may override (beyond the config). */
export interface HarnessOptions {
  /** Replace tournament launches to test transport handling of durable game-creation failures. */
  readonly gameLauncher?: GameLauncher;
  /** Override outbound email delivery while retaining the in-memory sender for token inspection. */
  readonly emailSender?: EmailSender;
  /**
   * Force the Chess960 arrangement new games start from, instead of drawing one.
   *
   * Without this a Chess960 test can only assert that *some* id came back, which passes just as
   * happily when the id is ignored and the board is the traditional array. Naming the id is what lets
   * a test assert the exact board the server built.
   */
  readonly chess960Starts?: Chess960StartSelector;
  /** Readiness probe backing `/v1/ready`; default resolves (healthy). */
  readonly readiness?: () => Promise<void>;
  /** Replace the in-memory rate limiter, e.g. with one that faults. */
  readonly rateLimiter?: RateLimiter;
  /** Structured logger; inject a capturing one to assert on log output. */
  readonly logger?: Logger;
  /** Tracer; inject a capturing one to assert on span emission. */
  readonly tracer?: Tracer;
  /** Pass true to simulate a server constructed without an anti-cheat analysis service. */
  readonly withoutAntiCheatAnalysis?: boolean;
  /** Pass true to simulate a server constructed without search. */
  readonly withoutSearch?: boolean;
  /** Pass true to simulate a server constructed without semantic search. */
  readonly withoutSemanticSearch?: boolean;
  /** Pass true to simulate a server constructed without social graph repository. */
  readonly withoutSocial?: boolean;
  /** Pass true to simulate a server constructed without messaging repository. */
  readonly withoutMessaging?: boolean;
  /** Pass true to simulate a server constructed without community repository. */
  readonly withoutCommunity?: boolean;
  /** Pass true to simulate a server constructed without achievements repository. */
  readonly withoutAchievements?: boolean;
  /** Pass true to simulate a server constructed without studies repository. */
  readonly withoutStudies?: boolean;
  /** Pass true to simulate a server constructed without learning repository. */
  readonly withoutLearning?: boolean;
  /** Substitute the learning repository — e.g. a decorator that counts the calls a route makes. */
  readonly learningRepository?: import('@chess-platform/learning').LearningRepository;
  /** Pass true to simulate a server constructed with the GraphQL endpoint switched off. */
  readonly withoutGraphql?: boolean;
  /** Expose the gated `__schema` field. Off by default, as in production (ADR-0073). */
  readonly graphqlIntrospection?: boolean;
  /** Override the anti-cheat evaluator (e.g. to make it throw) for edge-case tests. */
  readonly antiCheatEvaluator?: PositionEvaluator;
  /** Inject an optional engine analysis service. */
  readonly analysis?: import('../src/analysis/service').AnalysisService;
  /** Inject an optional move explanation service. */
  readonly moveExplanation?: import('../src/ai/move-explanation-service').MoveExplanationService;
  /** Inject an optional mistake prediction service. */
  readonly mistakePrediction?: import('../src/analysis/mistake-prediction-service').MistakePredictionService;
  /** Inject an optional puzzle generation service. */
  readonly puzzleGeneration?: import('../src/analysis/puzzle-generation-service').PuzzleGenerationService;
  /**
   * Opening exploration is present by default, unlike the engine-backed features above.
   * Production composes it unconditionally — it needs no engine and no provider — so a harness that
   * omitted it would test a deployment that cannot exist. Pass `withoutOpeningExploration` for the
   * one that can: a build whose bundled dataset is empty.
   */
  readonly withoutOpeningExploration?: boolean;
  /** Substitute the service — e.g. one built over a different opening database. */
  readonly openingExploration?: import('../src/openings/opening-exploration-service').OpeningExplorationService;
  /** Pass true to simulate a server constructed without endgame training. */
  readonly withoutEndgameTraining?: boolean;
  /** Compose no Coach, so `POST /v1/coach` answers 503 and `capabilities.coach` is false. */
  readonly withoutCoach?: boolean;
  /** Inject an optional endgame training service. */
  readonly endgameTraining?: import('../src/endgames/endgame-training-service').EndgameTrainingService;
  /** Inject completed-game review as a whole, so tests control its durable source and assessments. */
  readonly gameReview?: import('../src/game-review/service').GameReviewService;
  /**
   * Inject tournament commentary (ADR-0130).
   *
   * Injected whole rather than composed from harness options, because its three reads — the
   * tournament aggregate, the durable game log, the handle behind a player id — are exactly what
   * its tests need to control. A harness that built it from a stub archive would be choosing the
   * fixtures on the tests' behalf.
   */
  readonly tournamentCommentary?: import('../src/commentary/tournament-commentary-service').TournamentCommentaryService;
}

/**
 * Start an API server over in-memory repositories and whatever doubles a test supplies.
 *
 * Optional feature services are injected whole rather than composed from the options, so a test
 * controls exactly what its subject depends on; anything not supplied is simply absent, which is a
 * real deployment shape rather than a test-only one.
 *
 * @param config - config overrides; the auth secrets and TTLs have working defaults.
 * @param harnessOptions - repositories to omit, and feature services to inject.
 * @returns the running harness: a JSON client, the repositories, the clock, and `close`.
 */
export async function startHarness(
  config: ApiConfigInput = {},
  harnessOptions: HarnessOptions = {},
): Promise<Harness> {
  const clock = new ManualClock(START_MS);
  const ids = uuidv7Generator;
  const resolved = resolveConfig({
    accessTokenSecret: TEST_SECRET,
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 3600,
    cookieSecure: false, // tests run over plain HTTP
    ...config,
  });
  const tokens = new AccessTokenService({
    secret: resolved.accessTokenSecret,
    ttlSec: resolved.accessTokenTtlSec,
    clock,
    ids,
  });
  const repos = createInMemoryRepositories(clock);
  const tournamentRepo = new InMemoryTournamentsRepository();
  const hasher = new ScryptPasswordHasher({ N: 1024 }); // low cost for test speed
  const rateLimiter = harnessOptions.rateLimiter ?? new InMemoryRateLimiter(clock);
  const gameLauncher = harnessOptions.gameLauncher ?? new InMemoryGameLauncher(ids);
  const liveView = { activeGames: () => [] };
  const emailSender = new InMemoryEmailSender();
  const fakeEvaluator: PositionEvaluator = {
    evaluate: (_fen, playedUci) => ({
      topMoves: [
        { uci: playedUci, cp: 30 },
        { uci: '0000', cp: 10 },
      ],
      playedCp: 30,
    }),
  };
  const antiCheatEventStore = new InMemoryEventStore();
  const antiCheatEvaluator = harnessOptions.antiCheatEvaluator ?? fakeEvaluator;
  const antiCheatAnalysis = harnessOptions.withoutAntiCheatAnalysis
    ? undefined
    : new AntiCheatAnalysisService(
        new EventStoreGameSource(antiCheatEventStore),
        () => antiCheatEvaluator,
        repos.antiCheat,
      );
  const searchRepository = harnessOptions.withoutSearch
    ? undefined
    : new InMemorySearchRepository();
  const semanticSearchRepository = harnessOptions.withoutSemanticSearch
    ? undefined
    : new InMemorySemanticSearchRepository();
  const embeddingProvider = harnessOptions.withoutSemanticSearch
    ? undefined
    : new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS);
  const socialGraphRepository = harnessOptions.withoutSocial
    ? undefined
    : new InMemorySocialGraphRepository();
  const messagingRepository = harnessOptions.withoutMessaging || !socialGraphRepository
    ? undefined
    : new InMemoryMessagingRepository(socialGraphRepository);
  const communityRepository = harnessOptions.withoutCommunity
    ? undefined
    : new InMemoryCommunityRepository();
  const achievementsRepository = harnessOptions.withoutAchievements
    ? undefined
    : new InMemoryAchievementsRepository();
  const studiesRepository = harnessOptions.withoutStudies
    ? undefined
    : repos.studies;
  const learningRepository = harnessOptions.withoutLearning
    ? undefined
    : (harnessOptions.learningRepository ?? repos.learning);
  const graphql = harnessOptions.withoutGraphql
    ? undefined
    : { introspection: harnessOptions.graphqlIntrospection === true };
  const openingExploration = harnessOptions.withoutOpeningExploration
    ? undefined
    : (harnessOptions.openingExploration ?? createOpeningExploration());
  const endgameTraining = harnessOptions.withoutEndgameTraining
    ? undefined
    : (harnessOptions.endgameTraining ?? (harnessOptions.analysis ? createEndgameTraining(harnessOptions.analysis) : undefined));
  // Coaching is composed the way production composes it: the engine-backed features are built over
  // whichever analysis port the Coach hands the factory, not taken from the harness options.
  //
  // Building them here rather than reusing `harnessOptions.*` matters. Those options exist so a test
  // can install a *stub* feature service, and a stub built over the shared analysis service would
  // defeat the request-scoped port entirely — the searches would bypass the de-duplication and the
  // cancellation signal, and the cost tests would be measuring the wrong object. An explicitly
  // supplied service still wins, so a test that wants a stub can still have one.
  const coach = harnessOptions.withoutCoach
    ? undefined
    : createCoach({
        ...(harnessOptions.analysis ? { analysis: harnessOptions.analysis } : {}),
        features: (analysis) => ({
          ...(harnessOptions.moveExplanation ? { moveExplanation: harnessOptions.moveExplanation } : {}),
          ...(analysis
            ? { mistakePrediction: harnessOptions.mistakePrediction ?? createMistakePrediction(analysis) }
            : {}),
          ...(analysis
            ? (() => {
                const puzzle = harnessOptions.puzzleGeneration ?? createPuzzleGeneration(analysis);
                return puzzle ? { puzzleGeneration: puzzle } : {};
              })()
            : {}),
          ...(openingExploration ? { openingExploration } : {}),
          ...(endgameTraining ? { endgameTraining } : {}),
        }),
      });
  const studyPartner = coach
    ? new StudyPartnerService({ repository: repos.studyPartner, coach, clock, ids })
    : undefined;
  const server = createApiServer({
    repos, hasher, tokens, clock, ids, rateLimiter, tournamentRepo, gameLauncher, liveView,
    emailSender: harnessOptions.emailSender ?? emailSender,
    config: resolved,
    botTimingSource: new EventStoreBotTimingSource(antiCheatEventStore),
    ...(antiCheatAnalysis ? { antiCheatAnalysis } : {}),
    ...(searchRepository ? { searchRepository } : {}),
    ...(semanticSearchRepository ? { semanticSearchRepository } : {}),
    ...(embeddingProvider ? { embeddingProvider } : {}),
    ...(socialGraphRepository ? { socialGraphRepository } : {}),
    ...(messagingRepository ? { messagingRepository } : {}),
    ...(communityRepository ? { communityRepository } : {}),
    ...(achievementsRepository ? { achievementsRepository } : {}),
    ...(studiesRepository ? { studiesRepository } : {}),
    ...(learningRepository ? { learningRepository } : {}),
    ...(graphql ? { graphql } : {}),
    ...(harnessOptions.analysis ? { analysis: harnessOptions.analysis } : {}),
    ...(harnessOptions.moveExplanation ? { moveExplanation: harnessOptions.moveExplanation } : {}),
    ...(harnessOptions.mistakePrediction ? { mistakePrediction: harnessOptions.mistakePrediction } : {}),
    ...(harnessOptions.puzzleGeneration ? { puzzleGeneration: harnessOptions.puzzleGeneration } : {}),
    ...(openingExploration ? { openingExploration } : {}),
    ...(endgameTraining ? { endgameTraining } : {}),
    ...(harnessOptions.gameReview ? { gameReview: harnessOptions.gameReview } : {}),
    ...(coach ? { coach } : {}),
    ...(studyPartner ? { studyPartner } : {}),
    ...(harnessOptions.tournamentCommentary
      ? { tournamentCommentary: harnessOptions.tournamentCommentary }
      : {}),
    ...(harnessOptions.chess960Starts ? { chess960Starts: harnessOptions.chess960Starts } : {}),
    ...(harnessOptions.readiness ? { readiness: harnessOptions.readiness } : {}),
    ...(harnessOptions.logger ? { logger: harnessOptions.logger } : {}),
    ...(harnessOptions.tracer ? { tracer: harnessOptions.tracer } : {}),
  });
  const { server: http, port } = await listenOnFetchablePort(
    (p, h) => server.listen(p, h),
    HARNESS_HOST,
  );
  const baseUrl = `http://${HARNESS_HOST}:${port}`;

  return {
    server,
    repos,
    tournamentRepo,
    antiCheatEventStore,
    searchRepository,
    semanticSearchRepository,
    embeddingProvider,
    socialGraphRepository,
    messagingRepository,
    communityRepository,
    achievementsRepository,
    studiesRepository,
    learningRepository,
    analysis: harnessOptions.analysis,
    moveExplanation: harnessOptions.moveExplanation,
    mistakePrediction: harnessOptions.mistakePrediction,
    puzzleGeneration: harnessOptions.puzzleGeneration,
    openingExploration,
    endgameTraining,
    gameReview: harnessOptions.gameReview,
    clock,
    tokens,
    emailSender,
    baseUrl,
    async makeUser(handle, roles = ['user']) {
      const user = await repos.users.create({ id: ids.next(), handle });
      for (const r of roles) await repos.users.addRole(user.id, r);
      const { token } = tokens.issue({ userId: user.id, handle, roles });
      return { userId: user.id, token };
    },
    async json(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
      Object.assign(headers, opts.headers ?? {});
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : undefined;
      return { status: res.status, body, headers: res.headers };
    },
    close: () => closeServer(http),
  };
}
