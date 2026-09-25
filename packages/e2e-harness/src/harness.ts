/**
 * The backend harness: composes API (in-memory) + gateway (in-memory pub/sub)
 * + WebSocket server + random-move bot in a single process.
 *
 * This module wires the existing, tested packages together with zero external
 * infrastructure (no Postgres, no Redis). The API uses in-memory fakes from
 * `@chess-platform/api/fakes`; the gateway uses `InMemoryPubSub`; the WebSocket
 * server uses the `ws` package behind the gateway's `Connection` interface.
 *
 * A `BotPlayer` auto-joins any game where it is seated as a player and plays
 * random legal moves from the authoritative `StateView.legalMoves` map.
 *
 * ## Bridge route: `POST /e2e/games`
 *
 * The product API has no `POST /v1/games` endpoint (game creation is M7
 * matchmaking). The harness exposes a **test-only** bridge route,
 * `POST /e2e/games`, that creates a game in the authority and seats the bot.
 * This is clearly namespaced under `/e2e/` so it never leaks into the product
 * API surface. Body: `{ whiteId, blackId?, botResignsAfterPlies? }` (auth:
 * bearer token of a registered user; `blackId` defaults to the bot's user id).
 * Returns `{ gameId }`.
 *
 * `botResignsAfterPlies` is a determinism lever for e2e specs: if set, the bot
 * resigns on its turn once the game's ply count reaches the given value.
 *
 * ## Bridge route: `POST /e2e/search-index`
 *
 * The harness exposes a second **test-only** bridge route, `POST /e2e/search-index`,
 * to seed the in-memory search repository with documents projected from domain entities.
 * Namespaced under `/e2e/` so it never leaks into the product API surface.
 * Body: `{ players?: PlayerDocumentInput[], games?: GameDocumentInput[], tournaments?: TournamentDocumentInput[] }`.
 * Returns `{ indexed: number }`.
 *
 * ## Bridge route: `POST /e2e/achievements`
 *
 * Achievements are awarded in production by `AchievementsAwardWorker`, which reacts to
 * `games:ended` pub/sub events and reads finished games from Postgres. That worker is not wired
 * here, so a spec asserting on an unlocked badge would otherwise have to play a full game to move a
 * single counter. This third **test-only** bridge route calls the repository's real `award()` —
 * the same method the worker calls — so progress and unlock timing follow the production rules
 * rather than a fixture that hardcodes them.
 * ## Bridge route: `POST /e2e/studies`
 *
 * Seeds a public study with a PGN-imported chapter for E2E tests.
 * Body: `{ ownerId?, name?, description?, pgn? }`.
 * Returns `{ studyId, chapterId }`.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createApiServer,
  createInMemoryRepositories,
  resolveConfig,
  DEFAULT_RATE_LIMIT,
  ScryptPasswordHasher,
  AccessTokenService,
  systemClock,
  uuidv7Generator,
  InMemoryRateLimiter,
  InMemoryTournamentsRepository,
  TournamentService,
  ArenaService,
  TournamentResultReporter,
  ConsoleEmailSender,
  CorePositionReader,
  type ApiServer,
  type ApiDependencies,
  AnalysisService,
} from '@chess-platform/api';
import {
  GameAuthority,
  InMemoryPubSub,
  RealtimeGateway,
  type PubSub,
  type Connection,
  type ClientMessage,
  type ServerMessage,
  type TokenVerifier,
  encode,
  decode,
} from '@chess-platform/realtime-gateway';
import { InMemoryMessagingRepository } from '@chess-platform/messaging';
import { InMemorySocialGraphRepository } from '@chess-platform/social';
import { AchievementRuleError, InMemoryAchievementsRepository } from '@chess-platform/achievements';
import { LearningRuleError, InMemoryLearningRepository } from '@chess-platform/learning';
import { StudyRuleError, InMemoryStudiesRepository } from '@chess-platform/studies';
import { InMemoryCommunityRepository } from '@chess-platform/community';
import {
  InMemorySearchRepository,
  playerToDocument,
  gameToDocument,
  tournamentToDocument,
  type PlayerDocumentInput,
  type GameDocumentInput,
  type TournamentDocumentInput,
} from '@chess-platform/search';
import { FakeAnalysisProvider } from './fake-analysis-provider.js';
import { BotPlayer } from './bot.js';
import { AuthorityGameLauncher } from './launcher.js';
import { TournamentBroadcaster } from './broadcaster.js';
/** Options for the harness. */
export interface HarnessOptions {
  readonly apiPort?: number;
  readonly wsPort?: number;
  readonly apiHost?: string;
  readonly wsHost?: string;
}

/** The running harness. */
export interface Harness {
  readonly apiServer: ApiServer;
  readonly httpServer: Server;
  readonly wss: WebSocketServer;
  readonly gateway: RealtimeGateway;
  readonly pubsub: PubSub;
  readonly authority: GameAuthority;
  readonly bot: BotPlayer;
  readonly apiPort: number;
  readonly wsPort: number;
  readonly deps: ApiDependencies;
  /** Stop the harness and close all servers. */
  close(): Promise<void>;
}

/** A TokenVerifier backed by the API's AccessTokenService. */
class ApiTokenVerifier implements TokenVerifier {
  private readonly verifyFn: (token: string) => { readonly userId: string } | null;
  constructor(verifyFn: (token: string) => { readonly userId: string } | null) {
    this.verifyFn = verifyFn;
  }
  verify(token: string): { readonly userId: string } | null {
    return this.verifyFn(token);
  }
}

/** Body for the bridge route `POST /e2e/games`. */
interface BridgeGameBody {
  readonly whiteId: string;
  readonly blackId?: string;
  /** If set and the bot is a player, the bot resigns after this many plies. */
  readonly botResignsAfterPlies?: number;
}

/** Body for the bridge route `POST /e2e/achievements`. */
interface BridgeAwardBody {
  readonly playerId?: unknown;
  readonly key?: unknown;
  readonly increment?: unknown;
}

/** Body for the bridge route `POST /e2e/search-index`. */
interface BridgeSearchIndexBody {
  readonly players?: PlayerDocumentInput[];
  readonly games?: GameDocumentInput[];
  readonly tournaments?: TournamentDocumentInput[];
}

/**
 * Create and start the backend harness.
 */
export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const apiPort = options.apiPort ?? 4174;
  const wsPort = options.wsPort ?? 4175;
  const apiHost = options.apiHost ?? '127.0.0.1';
  const wsHost = options.wsHost ?? '127.0.0.1';

  // --- Gateway (in-memory pub/sub) ---
  const pubsub = new InMemoryPubSub();
  const clock = systemClock;
  const repos = createInMemoryRepositories(clock);
  // Match production wiring: API acceptance and the realtime authority share
  // one durable event log, so a newly matched game can hydrate on first join.
  const authority = new GameAuthority(pubsub, () => clock.now(), repos.events);

  // --- Tournament Realtime Bridge ---
  const ids = uuidv7Generator;
  const tournamentRepo = new InMemoryTournamentsRepository();
  let reporter: TournamentResultReporter;
  const broadcaster = new TournamentBroadcaster(authority, pubsub);
  const gameLauncher = new AuthorityGameLauncher(authority, (tid, gid) => {
    reporter.watch(tid, gid);
    broadcaster.track(tid, gid);
  });
  const reporterTournamentService = new TournamentService(tournamentRepo, gameLauncher);
  const reporterArenaService = new ArenaService(tournamentRepo, gameLauncher, () => systemClock.now());
  reporter = new TournamentResultReporter(pubsub, tournamentRepo, reporterTournamentService, reporterArenaService, repos.events);

  // --- API (in-memory) ---
  const config = resolveConfig({
    accessTokenSecret: 'e2e-harness-test-secret-at-least-32-bytes-long!!',
    // The e2e stack runs over plain HTTP (vite preview), so the refresh cookie
    // must not carry the `Secure` attribute or the browser would drop it.
    cookieSecure: false,
    // Product rate limits are covered by API integration tests. The shared e2e
    // harness must permit parallel specs and Playwright retries to create users.
    rateLimit: { ...DEFAULT_RATE_LIMIT, enabled: false },
  });
  const hasher = new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const rateLimiter = new InMemoryRateLimiter(clock);
  const emailSender = new ConsoleEmailSender();
  // Messaging and the social graph are both OPTIONAL in `ApiDependencies`, and an absent one makes
  // its routes answer 503. The DM UI needs both: `/v1/messages/*` obviously, and `/v1/social/*`
  // because the profile page only renders its action row once a relationship loads — which is where
  // the "Message" entry point lives. Passing the social graph to messaging as the block checker
  // mirrors `packages/api/test/helpers.ts`, so blocking is really enforced here rather than stubbed
  // to "never blocked".
  // The GraphQL read layer is optional too, and absent it 503s. The web app resolves every player
  // id to a handle through one batched `resolvePlayers` GraphQL call, so without this the messages,
  // tournaments and search views all silently fall back to rendering `shortId(...)` — and an e2e
  // spec asserting on a handle can never pass.
  const socialGraphRepository = new InMemorySocialGraphRepository();
  const messagingRepository = new InMemoryMessagingRepository(socialGraphRepository);
  const searchRepository = new InMemorySearchRepository();
  // The community repository is OPTIONAL, and an absent one makes `/v1/teams/*` routes answer 503.
  const communityRepository = new InMemoryCommunityRepository();
  // Same for achievements: `/v1/achievements` and `/v1/players/:id/achievements*` answer 503 without
  // it. The profile page reads the per-player list, so an absent repository would render the section
  // as an error rather than as an empty catalogue.
  const achievementsRepository = new InMemoryAchievementsRepository();
  const learningRepository = new InMemoryLearningRepository();
  const studiesRepository = new InMemoryStudiesRepository();
  // Engine analysis is OPTIONAL too (ADR-0113): absent, `POST /v1/analysis` answers 503 and
  // `GET /v1/capabilities` reports `analysis: false`, which makes the game sidebar's analysis panel
  // hide itself — so an e2e spec could only ever assert that the feature is missing.
  //
  // The provider is a deterministic double rather than a real engine on purpose. A real Stockfish
  // would make the whole Playwright suite depend on a binary CI does not install, and would return
  // a different evaluation on every run; the point of this harness is to exercise the *product*
  // path — request, contract, render, lifecycle — not the engine's judgement, which
  // `packages/api/test/analysis-stockfish-smoke.test.ts` covers against a real binary instead.
  const analysis = new AnalysisService({ provider: new FakeAnalysisProvider() });
  const deps: ApiDependencies = { repos, hasher, tokens, clock, ids, config, rateLimiter, tournamentRepo, gameLauncher, liveView: broadcaster, emailSender, messagingRepository, socialGraphRepository, searchRepository, communityRepository, achievementsRepository, learningRepository, studiesRepository, analysis, graphql: { introspection: false } };
  const apiServer = createApiServer(deps);

  const tokenVerifier = new ApiTokenVerifier((token: string) => {
    const identity = tokens.identify(token);
    return identity ? { userId: identity.userId } : null;
  });

  const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier, () => Date.now());

  // --- Bot ---
  const bot = new BotPlayer(authority, pubsub);

  // --- HTTP server with bridge route ---
  const bridgeHandler: import('node:http').RequestListener = (req, res) => {
    if (req.method === 'POST' && req.url === '/e2e/games') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
        try {
          const parsed = JSON.parse(body) as BridgeGameBody;
          const whiteId = parsed.whiteId;
          const blackId = parsed.blackId ?? bot.userId;

          if (!whiteId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'bad_request', message: 'whiteId is required' }));
            return;
          }

          const gameId = ids.next();

          // Await creation (now durable/write-through) before seating the bot
          // or responding, so a join cannot race ahead of the persisted game.
          await authority.createGame({
            gameId,
            variant: 'standard',
            timeControl: {
              initialMs: 300_000,
              incrementMs: 0,
              delayMs: 0,
              kind: 'sudden_death',
            },
            players: { white: whiteId, black: blackId },
            rated: false,
          });

          if (blackId === bot.userId || whiteId === bot.userId) {
            bot.registerGame(
              gameId,
              whiteId,
              blackId,
              parsed.botResignsAfterPlies ?? null,
            );
          }

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ gameId }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
        }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/e2e/achievements') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          try {
            let parsed: BridgeAwardBody;
            try {
              parsed = JSON.parse(body) as BridgeAwardBody;
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid JSON body' }));
              return;
            }

            if (!parsed || typeof parsed !== 'object') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Body must be an object' }));
              return;
            }
            if (typeof parsed.playerId !== 'string' || typeof parsed.key !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'playerId and key must be strings' }));
              return;
            }
            // Left undefined rather than defaulted here: `award` has its own default of 1, and a
            // second copy of that number is one more place for the two to drift apart.
            if (parsed.increment !== undefined && typeof parsed.increment !== 'number') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'increment must be a number' }));
              return;
            }

            let awarded;
            try {
              awarded = parsed.increment === undefined
                ? await achievementsRepository.award(parsed.playerId, parsed.key)
                : await achievementsRepository.award(parsed.playerId, parsed.key, parsed.increment);
            } catch (err) {
              // An unknown key or a fractional increment is a broken fixture, not a harness fault.
              // Answering 500 would send whoever is debugging it reading this file instead of their
              // own payload.
              if (err instanceof AchievementRuleError) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: err.code, message: err.message }));
                return;
              }
              throw err;
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              playerId: awarded.playerId,
              key: awarded.key,
              progress: awarded.progress,
              unlockedAt: awarded.unlockedAt ? awarded.unlockedAt.toISOString() : null,
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/e2e/search-index') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          try {
            let parsed: BridgeSearchIndexBody;
            try {
              parsed = JSON.parse(body) as BridgeSearchIndexBody;
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid JSON body' }));
              return;
            }

            if (!parsed || typeof parsed !== 'object') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Body must be an object' }));
              return;
            }

            const docs = [];

            if (parsed.players !== undefined) {
              if (!Array.isArray(parsed.players)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'bad_request', message: 'players must be an array' }));
                return;
              }
              for (const p of parsed.players) {
                // `country` is optional, but a non-string one reaches `.trim()` inside
                // `playerToDocument` and throws — which would surface as a 500 and send whoever is
                // debugging a fixture looking for a harness fault instead of their own payload.
                if (
                  !p ||
                  typeof p.id !== 'string' ||
                  typeof p.handle !== 'string' ||
                  (p.country !== undefined && typeof p.country !== 'string')
                ) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid player document input' }));
                  return;
                }
                docs.push(playerToDocument(p));
              }
            }

            if (parsed.games !== undefined) {
              if (!Array.isArray(parsed.games)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'bad_request', message: 'games must be an array' }));
                return;
              }
              for (const g of parsed.games) {
                if (
                  !g ||
                  typeof g.id !== 'string' ||
                  typeof g.whiteHandle !== 'string' ||
                  typeof g.blackHandle !== 'string' ||
                  typeof g.variant !== 'string' ||
                  typeof g.speed !== 'string' ||
                  typeof g.result !== 'string' ||
                  typeof g.rated !== 'boolean' ||
                  // Optional, and `.trim()`-ed by `gameToDocument` — same reason as `country`.
                  (g.eco !== undefined && typeof g.eco !== 'string')
                ) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid game document input' }));
                  return;
                }
                docs.push(gameToDocument(g));
              }
            }

            if (parsed.tournaments !== undefined) {
              if (!Array.isArray(parsed.tournaments)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'bad_request', message: 'tournaments must be an array' }));
                return;
              }
              for (const t of parsed.tournaments) {
                if (
                  !t ||
                  typeof t.id !== 'string' ||
                  typeof t.name !== 'string' ||
                  typeof t.format !== 'string' ||
                  typeof t.state !== 'string'
                ) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid tournament document input' }));
                  return;
                }
                docs.push(tournamentToDocument(t));
              }
            }

            // One rule covering both an absent body and present-but-empty arrays: a call that
            // indexes nothing is a broken fixture, and answering 201 to it hides the setup error
            // behind whatever assertion fails later. ADR-0086 states this contract.
            if (docs.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                code: 'bad_request',
                message: 'body must index at least one document (players, games or tournaments)',
              }));
              return;
            }

            await searchRepository.indexAll(docs);

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ indexed: docs.length }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/e2e/courses') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          try {
            let parsed: Record<string, unknown> = {};
            if (body.trim()) {
              try {
                parsed = JSON.parse(body) as Record<string, unknown>;
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid JSON body' }));
                return;
              }
            }

            if (!parsed || typeof parsed !== 'object') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Body must be an object' }));
              return;
            }

            const authorId = typeof parsed.authorId === 'string' ? parsed.authorId : ids.next();
            const slug = typeof parsed.slug === 'string' ? parsed.slug : `course-${ids.next()}`;
            const title = typeof parsed.title === 'string' ? parsed.title : 'Starter Tactics';
            const description = typeof parsed.description === 'string' ? parsed.description : 'Learn basic tactics.';
            const difficulty = (parsed.difficulty === 'beginner' || parsed.difficulty === 'intermediate' || parsed.difficulty === 'advanced')
              ? parsed.difficulty
              : 'beginner';

            const posReader = new CorePositionReader();

            let createdCourse;
            let createdLesson;
            let textStep;
            let moveStep;
            let quizStep;

            try {
              const courseId = ids.next();
              createdCourse = await learningRepository.createCourse(courseId, authorId, slug, title, description, difficulty, true);

              const lessonId = ids.next();
              createdLesson = await learningRepository.createLesson(lessonId, createdCourse.id, authorId, 'Basics');

              textStep = await learningRepository.createStep(
                ids.next(),
                createdLesson.id,
                authorId,
                { kind: 'text', prose: 'Welcome to this lesson! Learn basic tactical themes.' },
                posReader,
              );

              moveStep = await learningRepository.createStep(
                ids.next(),
                createdLesson.id,
                authorId,
                {
                  kind: 'move',
                  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                  expectedSan: 'e4',
                  hint: 'Advance your king pawn two squares.',
                },
                posReader,
              );

              quizStep = await learningRepository.createStep(
                ids.next(),
                createdLesson.id,
                authorId,
                {
                  kind: 'quiz',
                  question: 'Which piece moves diagonally?',
                  options: ['Rook', 'Bishop', 'Knight'],
                  correctIndex: 1,
                },
                posReader,
              );
            } catch (err) {
              if (err instanceof LearningRuleError) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: err.code, message: err.message }));
                return;
              }
              throw err;
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              courseId: createdCourse.id,
              slug: createdCourse.slug,
              lessonId: createdLesson.id,
              stepIds: [textStep.id, moveStep.id, quizStep.id],
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/e2e/studies') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          try {
            let parsed: Record<string, unknown> = {};
            if (body.trim()) {
              try {
                parsed = JSON.parse(body) as Record<string, unknown>;
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'bad_request', message: 'Invalid JSON body' }));
                return;
              }
            }

            if (!parsed || typeof parsed !== 'object') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 'bad_request', message: 'Body must be an object' }));
              return;
            }

            const ownerId = typeof parsed.ownerId === 'string' ? parsed.ownerId : ids.next();
            const name = typeof parsed.name === 'string' ? parsed.name : 'Ruy Lopez Masterclass';
            const description = typeof parsed.description === 'string' ? parsed.description : 'Detailed analysis of the Ruy Lopez opening.';
            const pgnText = typeof parsed.pgn === 'string'
              ? parsed.pgn
              : '[Event "Ruy Lopez Main Line"]\n[White "Kasparov"]\n[Black "Deep Blue"]\n\n1. e4 { King\'s pawn opening. } e5 2. Nf3 $1 Nc6 (2... Nf6 $2 3. Nxe5 d6) 3. Bb5 *';

            const posReader = new CorePositionReader();

            let createdStudy;
            let chapters;
            try {
              const studyId = ids.next();
              createdStudy = await studiesRepository.createStudy(studyId, ownerId, name, description, 'public');
              chapters = await studiesRepository.importPgn(createdStudy.id, ownerId, pgnText, posReader);
            } catch (err) {
              if (err instanceof StudyRuleError) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: err.code, message: err.message }));
                return;
              }
              throw err;
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              studyId: createdStudy.id,
              chapterId: chapters[0] ? chapters[0].id : null,
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
          }
        })();
      });
      return;
    }

    apiServer.handler(req, res);
  };

  const httpServer = createServer(bridgeHandler);

  // --- WebSocket server ---
  const wss = new WebSocketServer({ port: wsPort, host: wsHost });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      id: `ws-${crypto.randomUUID()}`,
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(encode(msg));
      },
      onMessage: (handler: (msg: ClientMessage) => void) => {
        ws.on('message', (data: Buffer) => {
          const msg = decode(data.toString());
          if (msg) handler(msg);
        });
      },
      onClose: (handler: () => void) => {
        ws.on('close', handler);
      },
      close: () => ws.close(),
    };
    gateway.handleConnection(conn);
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(apiPort, apiHost, () => {
      bot.start();
      // Resolve the actual bound ports: when 0 is requested the OS assigns an
      // ephemeral port, so the requested value would be a useless 0.
      const httpAddr = httpServer.address();
      const wssAddr = wss.address();
      const boundApiPort = typeof httpAddr === 'object' && httpAddr ? httpAddr.port : apiPort;
      const boundWsPort = typeof wssAddr === 'object' && wssAddr ? wssAddr.port : wsPort;
      resolve({
        apiServer,
        httpServer,
        wss,
        gateway,
        pubsub,
        authority,
        bot,
        apiPort: boundApiPort,
        wsPort: boundWsPort,
        deps,
        close: async () => {
          bot.stop();
          reporter.stop();
          await Promise.all([
            new Promise<void>((resolveClose) => {
              wss.close(() => resolveClose());
            }),
            new Promise<void>((resolveClose) => {
              httpServer.close(() => resolveClose());
            }),
          ]);
        },
      });
    });
    httpServer.on('error', reject);
  });
}
