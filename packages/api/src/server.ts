/**
 * @packageDocumentation
 * The composition root. {@link createApiServer} takes an explicit dependency
 * bundle (repositories, password hasher, token service, clock, id generator,
 * config) and returns a ready-to-serve handler plus helpers. It performs the
 * only wiring in the package: constructing the {@link AuthService}, building the
 * route table, and adapting the router to a Node `http` listener with a
 * bearer-token authenticator. Nothing here reads globals — a test wires fakes,
 * production wires Postgres, and the code in between is identical.
 */

import { createServer, type RequestListener, type Server } from 'node:http';
import { AuthService } from './auth/service';
import type { ApiDependencies } from './deps';
import { HttpError } from './http/errors';
import type { Identity } from './http/context';
import { Router } from './http/router';
import { withSecurity } from './http/security';
import { buildRouter, type RouteDeps } from './routes';
import { cryptoChess960Start } from './ports/chess960';
import { NullLogger } from './ports/logger';
import { InMemoryMetrics } from './ports/metrics';
import { NullTracer } from './ports/tracer';
import type { OpenApiDocument, OpenApiInfo } from './openapi/spec';
import { buildOpenApiDocument } from './openapi/spec';

/** Options that shape the served metadata (title/version/servers). */
export interface ApiServerOptions {
  readonly info?: Partial<OpenApiInfo>;
}

/** The constructed API surface. */
export interface ApiServer {
  /** Node `http` request listener. */
  readonly handler: RequestListener;
  /** The route table (useful for tests and tooling). */
  readonly router: Router;
  /** The identity service (exposed for advanced composition). */
  readonly auth: AuthService;
  /** Build (and return) the OpenAPI document for this server. */
  openapiDocument(): OpenApiDocument;
  /** Start an HTTP server on `port`; resolves once listening. */
  listen(port: number, host?: string): Promise<Server>;
}

const DEFAULT_INFO: OpenApiInfo = {
  title: 'Gambit API',
  version: '0.1.0',
  description: 'Gambit REST API — identity, sessions, seeks, ratings, and games.',
};

/**
 * The keys {@link createApiServer} hands straight to the router — derived from the two bundles
 * rather than written out.
 *
 * Every optional feature the router takes is optional in {@link ApiDependencies} too, so a
 * forwarding literal that simply forgets one compiles cleanly and that feature answers 503 from a
 * server which composed it correctly everywhere else. Increment 22 shipped exactly that omission
 * for `tournamentCommentary`, and it is the same defect class as the `main.ts` disposal list
 * ADR-0092 closed. See ADR-0131.
 *
 * `Extract` yields a union alias rather than `keyof ApiDependencies`, which makes the mapped type
 * below **non-homomorphic**: TypeScript does not carry `?` across it, so every key becomes required
 * while its value type still admits `undefined`. `analysis: deps.analysis` therefore still
 * typechecks on a deployment with no engine — but dropping the line is a build failure.
 *
 * This type is not what makes that true. `RouteDeps` declares each feature `key: T | undefined`
 * rather than `key?: T`, so the requirement is in {@link buildRouter}'s own signature and deleting
 * the annotation on `forwarded` does not disarm it — the omission just moves its error from the
 * literal (`TS2741`) to the call (`TS2345`). What this type adds is reporting the omission where the
 * fix is rather than one frame away.
 */
export type ForwardedKey = Extract<keyof ApiDependencies, keyof RouteDeps>;

/**
 * The forwarded bundle: every {@link ForwardedKey} named, `undefined` accepted as a value.
 *
 * Absent and present-but-`undefined` are interchangeable here — the package does not set
 * `exactOptionalPropertyTypes`, and nothing downstream probes these bundles with `in` or
 * `Object.keys`; every consumer asks `!== undefined`.
 */
export type ForwardedDeps = { [K in ForwardedKey]: ApiDependencies[K] };

/**
 * The only keys `RouteDeps` declares that {@link ApiDependencies} does not supply: this function
 * constructs both of them.
 */
type ConstructedHere = 'auth' | 'info';

/**
 * `true` only while every router dependency is suppliable from the bundle.
 *
 * `ForwardedKey` is an intersection, so it cannot see a key added to `RouteDeps` alone — that key
 * would never be forwarded and its route would answer 503 for good, with the compiler silent. This
 * assertion is the other half of the guard: add such a key and `Exclude` stops being `never`, so the
 * initialiser below fails with `TS2322`.
 *
 * The two-name list above is the one hand-written thing left here, and unlike an exclusion list it
 * fails loudly: drop a name from it and this assertion breaks immediately.
 */
type EveryRouterDependencyIsSuppliable =
  Exclude<keyof RouteDeps, keyof ApiDependencies | ConstructedHere> extends never ? true : never;

/**
 * Evaluated for its type, not its value. See {@link EveryRouterDependencyIsSuppliable}.
 *
 * Deliberately **not** exported. An earlier version was, purely to satisfy `noUnusedLocals`, and
 * `index.ts` re-exports `./server` — so a compile-time assertion became a runtime export in the
 * package's public API — the emitted JS carried it as a named runtime export — which
 * a consumer could import and whose later removal would then be a breaking change. Raised by Qodo on
 * PR #154, and a fair catch on a PR whose own ADR documents failing to notice exported surface.
 *
 * The `void` below is what keeps `noUnusedLocals` quiet without exporting anything.
 */
const everyRouterDependencyIsSuppliable: EveryRouterDependencyIsSuppliable = true;
void everyRouterDependencyIsSuppliable;

/** Wire the API from an explicit dependency bundle. */
export function createApiServer(deps: ApiDependencies, options: ApiServerOptions = {}): ApiServer {
  const info: OpenApiInfo = { ...DEFAULT_INFO, ...options.info };

  // Observability (M13): one metrics registry is shared between the per-request
  // recorder (RouterRuntime) and the /v1/metrics render route so both see the
  // same series. Logger defaults to silent; production roots inject a JsonLogger.
  // Tracer defaults to silent NullTracer; production roots inject a RecordingTracer.
  const logger = deps.logger ?? new NullLogger();
  const metrics = deps.metrics ?? new InMemoryMetrics();
  const tracer = deps.tracer ?? new NullTracer();

  const auth = new AuthService({
    repos: deps.repos,
    hasher: deps.hasher,
    tokens: deps.tokens,
    clock: deps.clock,
    ids: deps.ids,
    refreshTtlSec: deps.config.refreshTokenTtlSec,
    emailSender: deps.emailSender,
    webauthn: deps.config.webauthn,

  });

  // Named one key at a time deliberately. `ForwardedDeps` makes every one of them mandatory, so a
  // feature added to both bundles and forgotten here fails the build rather than answering 503 —
  // which is the whole point of the type. Do not collapse this into `...deps`: that would also
  // hand the router the password hasher and the token service, which no route has any business
  // reaching.
  const forwarded: ForwardedDeps = {
    repos: deps.repos,
    clock: deps.clock,
    ids: deps.ids,
    chess960Starts: deps.chess960Starts,
    config: deps.config,
    rateLimiter: deps.rateLimiter,
    tournamentRepo: deps.tournamentRepo,
    gameLauncher: deps.gameLauncher,
    liveView: deps.liveView,
    metrics: deps.metrics,
    readiness: deps.readiness,
    antiCheatAnalysis: deps.antiCheatAnalysis,
    botTimingSource: deps.botTimingSource,
    searchRepository: deps.searchRepository,
    semanticSearchRepository: deps.semanticSearchRepository,
    embeddingProvider: deps.embeddingProvider,
    socialGraphRepository: deps.socialGraphRepository,
    messagingRepository: deps.messagingRepository,
    communityRepository: deps.communityRepository,
    achievementsRepository: deps.achievementsRepository,
    studiesRepository: deps.studiesRepository,
    learningRepository: deps.learningRepository,
    graphql: deps.graphql,
    analysis: deps.analysis,
    moveExplanation: deps.moveExplanation,
    mistakePrediction: deps.mistakePrediction,
    puzzleGeneration: deps.puzzleGeneration,
    openingExploration: deps.openingExploration,
    endgameTraining: deps.endgameTraining,
    coach: deps.coach,
    studyPartner: deps.studyPartner,
    tournamentCommentary: deps.tournamentCommentary,
    gameReview: deps.gameReview,
  };

  const router = buildRouter({
    ...forwarded,
    // The router builds neither of these, and the bundle carries neither.
    auth,
    info,
    // These follow the spread so the resolved values win over the raw ones `forwarded` carries:
    // the router requires them, and the bundle leaves them optional. Ordering is load-bearing —
    // above the spread they would be overwritten by the `undefined` this defaults away, and the
    // compiler says so, because `RouteDeps` declares them required.
    metrics,
    readiness: deps.readiness ?? (() => Promise.resolve()),
    chess960Starts: deps.chess960Starts ?? cryptoChess960Start,
  });

  const authenticate = (authorization: string | undefined): Identity | null => {
    if (!authorization) return null;
    const match = /^Bearer (.+)$/i.exec(authorization.trim());
    if (!match) throw HttpError.unauthorized('malformed Authorization header');
    const identity = deps.tokens.identify(match[1]!);
    if (!identity) throw HttpError.unauthorized('invalid or expired access token');
    return identity;
  };

  const routerListener = router.toListener({
    authenticate,
    maxBodyBytes: deps.config.maxBodyBytes,
    trustProxy: deps.config.trustProxy,
    newRequestId: () => deps.ids.next(),
    logger,
    metrics,
    tracer,
  });

  // Wrap the router listener with security headers and CORS enforcement.
  // Security headers and CORS preflight short-circuit happen before the router
  // is invoked, so they apply to every response including 404/405/422/500.
  const handler = withSecurity(routerListener, {
    cors: deps.config.cors,
    enableHsts: deps.config.enableHsts,
  });

  return {
    handler,
    router,
    auth,
    openapiDocument: () => buildOpenApiDocument(router, info),
    listen: (port: number, host?: string): Promise<Server> =>
      new Promise((resolve, reject) => {
        const server = createServer(handler);
        // A bind failure arrives as an `error` event rather than through the
        // callback, so without this listener the promise would never settle and
        // the event — having no handler at all — would take the process down
        // with it. It is removed once listening, deliberately: a later server
        // error keeps whatever semantics it had before rather than being
        // quietly swallowed by a `reject` on an already-settled promise.
        const rejectOnBindFailure = (error: Error): void => reject(error);
        server.once('error', rejectOnBindFailure);
        server.listen(port, host, () => {
          server.removeListener('error', rejectOnBindFailure);
          resolve(server);
        });
      }),
  };
}
