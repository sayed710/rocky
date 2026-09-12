/**
 * @packageDocumentation
 * The route table. Each route couples its OpenAPI contract, its auth policy, and
 * its handler, so the served behavior and the published spec come from one
 * definition. Handlers stay thin: validate input, call a service/repository,
 * present the result. All collaborators arrive via {@link RouteDeps} — no globals.
 */

import type { Variant } from '@chess-platform/core';
import { FenError } from '@chess-platform/core';
import { coreFenValidator } from './analysis/fen-validator.js';
import type { TiebreakKey } from '@chess-platform/tournament';
import { type RatingRow, type TournamentsRepository } from '@chess-platform/persistence';
import { AuthService } from './auth/service';
import type { RequestMeta } from './auth/service';
import { EMAIL_ADDRESS_PATTERN } from './email/address.js';
import type { Repositories } from './deps';
import { Game, classifySpeed } from '@chess-platform/game';
import { parseRole, parseSeekColor, parseTimeControl, parseUuid, parseVariant, parseCreatableVariant, VARIANTS, CREATABLE_VARIANTS, HANDLE_PATTERN, UUID_PATTERN } from './domain';
import { BOT_ACCOUNTS, botAccountByLevel } from './bot/catalogue';
import { HttpError } from './http/errors';
import { json, noContent } from './http/context';
import type { RequestContext } from './http/context';
import { Router } from './http/router';
import type { AuthPolicy } from './http/router';
import {
  buildRefreshCookie,
  clearRefreshCookie,
  parseCookies,
  REFRESH_COOKIE_NAME,
} from './http/cookie';
import { strictObject, oneOf, optBoolean, optInt, optString, parseLimit, reqBoolean, reqString } from './http/validate';
import type { RateLimiter, RateLimitRequest } from './ports/rate-limiter';
import type { Metrics } from './ports/metrics';
import type { ApiConfig } from './config';
import type { Chess960StartSelector } from './ports/chess960';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import { aggregatePlayer, BotDetectionService } from '@chess-platform/anti-cheat';
import { NoEngineForVariantError } from '@chess-platform/engine';
import { SocialRuleError, type FriendRequestAction } from '@chess-platform/social';
import { MessagingRuleError } from '@chess-platform/messaging';
import { CommunityRuleError } from '@chess-platform/community';
import { AchievementRuleError } from '@chess-platform/achievements';
import { StudyRuleError, MAX_PGN_BYTES } from '@chess-platform/studies';
import { LearningRuleError } from '@chess-platform/learning';
import { CorePositionReader } from './studies/position-reader';
import {
  antiCheatAggregateView,
  antiCheatGameReportView,
  antiCheatGameAnalysisView,
  blockEdgeView,
  botAggregateView,
  botGameReportView,
  botGameAnalysisView,
  conversationReadStateView,
  conversationSummaryView,
  conversationView,
  followEdgeView,
  forumPostView,
  forumThreadView,
  friendRequestView,
  gameSummaryView,
  joinRequestView,
  leaderboardEntry,
  membershipView,
  messageView,
  publicUser,
  ratingView,
  seekView,
  selfUser,
  sessionView,
  teamView,
  teamDetailView,
  achievementDefinitionView,
  playerAchievementView,
  achievementSummaryView,
  studyView,
  collaboratorView,
  chapterView,
  treeNodeView,
  chapterDetailView,
  courseView,
  lessonView,
  stepView,
  learnerStepView,
  progressView,
  courseProgressSummaryView,
  attemptResultView,
  capabilitiesView,
  analysisView,
  moveExplanationView,
  openingExplorationView,
  mistakePredictionView,
  gameReviewView,
  puzzleGenerationView,
  endgameNextView,
  endgameAttemptView,
  coachView,
  tournamentGameCommentaryView,
  tournamentRoundRecapView,
} from './presenters';
import { DEFAULT_ANALYSIS_LIMITS } from './analysis/limits';
import { TournamentService } from './tournament/service';
import { ArenaService } from './tournament/arena.service';
import { summaryView, tournamentView, roundView, standingView, arenaTournamentView, arenaStandingView } from './tournament/presenters';
import { createLiveTournamentHandler } from './tournament/live';
import { buildOpenApiDocument } from './openapi/spec';
import type { OpenApiDocument, OpenApiInfo } from './openapi/spec';
import type { RouteDoc } from './openapi/types';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';
import type { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import type { BotGameTimingSource } from './bot-detection/source';
import { BotAnalysisService } from './bot-detection/analysis-service';
import { createGraphQLHandler } from './graphql';
import {
  studyPartnerSessionView,
  submitStudyPartnerTurnView,
} from './study-partner/presenters';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  STUDY_PARTNER_IDEMPOTENCY_KEY_PATTERN,
} from './study-partner/service';
import {
  parseNaturalQuery,
  type EmbeddingProvider,
  type SearchQuery,
  type SearchRepository,
  type SemanticSearchRepository,
} from '@chess-platform/search';

/**
 * Collaborators the route handlers need.
 *
 * Every optional feature below is declared `key: T | undefined` rather than `key?: T`. The value is
 * exactly as optional either way — a deployment that composed nothing passes `undefined` — but the
 * *key* is mandatory, so a `buildRouter({ ... })` call that forgets one cannot compile.
 *
 * That is deliberate and it is the whole guard (ADR-0131). Writing them `?:` put the requirement in
 * a type annotation at the call site instead, which someone can delete without a word from the
 * compiler; putting it in this signature means the only way to drop a feature is to drop its
 * declaration here, which is the one edit nobody makes by accident.
 */
export interface RouteDeps {
  readonly auth: AuthService;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Draws the starting arrangement for a new Chess960 game (ADR-0137). */
  readonly chess960Starts: Chess960StartSelector;
  readonly info: OpenApiInfo;
  readonly rateLimiter: RateLimiter;
  readonly config: ApiConfig;
  readonly tournamentRepo: TournamentsRepository;
  readonly gameLauncher: GameLauncher;
  readonly liveView: TournamentLiveView;
  readonly metrics: Metrics;
  readonly readiness: () => Promise<void>;
  readonly antiCheatAnalysis: AntiCheatAnalysisService | undefined;
  readonly botTimingSource: BotGameTimingSource | undefined;
  readonly searchRepository: SearchRepository | undefined;
  readonly semanticSearchRepository: SemanticSearchRepository | undefined;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly socialGraphRepository: import('@chess-platform/social').SocialGraphRepository | undefined;
  readonly messagingRepository: import('@chess-platform/messaging').MessagingRepository | undefined;
  readonly communityRepository: import('@chess-platform/community').CommunityRepository | undefined;
  readonly achievementsRepository: import('@chess-platform/achievements').AchievementsRepository | undefined;
  readonly studiesRepository: import('@chess-platform/studies').StudiesRepository | undefined;
  readonly learningRepository: import('@chess-platform/learning').LearningRepository | undefined;
  readonly graphql: import('./graphql').GraphQLOptions | undefined;
  /** Optional engine analysis (ADR-0113). When absent, `POST /v1/analysis` responds 503. */
  readonly analysis: import('./analysis/service').AnalysisService | undefined;
  /** Optional Move Explanation (ADR-0115). When absent, `POST /v1/ai/move-explanation` responds 503. */
  readonly moveExplanation: import('./ai/move-explanation-service').MoveExplanationService | undefined;
  /**
   * Optional Mistake Prediction (ADR-0118). When absent, `POST /v1/analysis/mistake-prediction`
   * responds 503. Tracks the analysis subsystem alone — no AI provider is involved.
   */
  readonly mistakePrediction: import('./analysis/mistake-prediction-service').MistakePredictionService | undefined;
  /** Optional puzzle generation (ADR-0125). When absent, `POST /v1/analysis/puzzle` responds 503. */
  readonly puzzleGeneration: import('./analysis/puzzle-generation-service').PuzzleGenerationService | undefined;
  /**
   * Optional opening identification (ADR-0127). When absent, `POST /v1/openings/explore` responds
   * 503. Independent of the analysis subsystem — it borrows no engine and no provider.
   */
  readonly openingExploration: import('./openings/opening-exploration-service').OpeningExplorationService | undefined;
  /**
   * Optional endgame training (ADR-0128). When absent, `POST /v1/endgames/*` responds 503.
   * Borrows the analysis subsystem; composes no AI provider.
   */
  readonly endgameTraining: import('./endgames/endgame-training-service').EndgameTrainingService | undefined;
  /**
   * Optional Coach orchestrator (ADR-0129). Absent means `POST /v1/coach` answers 503.
   *
   * Composed from the five feature services above rather than beside them, so it is present exactly
   * when at least one of them is.
   */
  readonly coach: import('./coach/coach-service').CoachService | undefined;
  /** Private durable Study Partner sessions over the production CoachService. */
  readonly studyPartner: import('./study-partner/service').StudyPartnerService | undefined;
  /**
   * Tournament commentary (ADR-0130). When absent, both commentary routes respond 503.
   *
   * Needs an engine to cite and a provider to write with, so it is composed only when the analysis
   * subsystem and the AI subsystem are both configured.
   */
  readonly tournamentCommentary: import('./commentary/tournament-commentary-service').TournamentCommentaryService | undefined;
  /** Optional completed-game review. Never operates on a live board. */
  readonly gameReview: import('./game-review/service').GameReviewService | undefined;
}

/** Narrows without a cast, so the request array reaches the service as the type it was checked to be. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const PUBLIC: AuthPolicy = { required: false };
const AUTHED: AuthPolicy = { required: true };
const ADMIN: AuthPolicy = { required: true, anyRole: ['admin'] };
const MODERATION: AuthPolicy = { required: true, anyRole: ['moderator', 'admin'] };

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

/** Build the fully-wired router. */
export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  const { auth, repos, clock, ids, chess960Starts, info, rateLimiter, config } = deps;
  const botService = new BotDetectionService(repos.botReports);
  const botAnalysis = deps.botTimingSource
    ? new BotAnalysisService(deps.botTimingSource, repos.botReports)
    : undefined;



  /**
   * Admit a request against every bucket that guards it, or refuse it having charged none.
   *
   * This is the only caller of `rateLimiter.admit` in the file, and routes reach the limiter
   * only through it. That is deliberate: the defect this replaced was six routes each calling
   * the limiter twice in sequence, charging the first bucket before learning that the second
   * refused. Handing every bucket over in one call is what lets the limiter decide before it
   * commits; a second `await admit(...)` in the same handler would be two independent
   * decisions again and would reintroduce exactly that bug. `rate-limit-structure.test.ts`
   * fails if one appears.
   *
   * `retryAfterSeconds` is whatever the limiter reports, which for a multi-bucket refusal is
   * the longest wait among the buckets that refused rather than the first one it looked at.
   *
   * A limiter that *faults* — rather than refusing — propagates, and the request fails closed
   * with a 500. That is deliberate: this call is the only thing between the caller and real
   * engine or provider work, and a limiter whose answer is unknown must not be read as a yes.
   * The Postgres multi-bucket path opens a transaction and checks out a pooled client, so the
   * five migrated routes have more ways to fault than the single statement they replaced;
   * `/v1/auth/refresh` keeps that single statement and its exposure is unchanged. Raised in the
   * CodeRabbit review of PR #137.
   */
  const admit = async (buckets: readonly RateLimitRequest[]): Promise<void> => {
    if (!config.rateLimit.enabled) return;
    const result = await rateLimiter.admit(buckets);
    if (!result.allowed) throw HttpError.rateLimited(result.retryAfterSeconds);
  };

  const cookieOpts = { secure: config.cookieSecure };
  const refreshTokenTtlSec = config.refreshTokenTtlSec;

  let cachedSpec: OpenApiDocument | null = null;

  // --- Meta ----------------------------------------------------------------
  router.get(
    '/v1/health',
    doc({ summary: 'Liveness probe', tags: ['meta'], responses: { 200: ['Health', 'Service is up'] } }),
    PUBLIC,
    () => json(200, { status: 'ok', name: info.title, version: info.version }),
  );

  router.get(
    '/v1/ready',
    doc({
      summary: 'Readiness probe',
      tags: ['meta'],
      responses: { 200: ['Health', 'Dependencies are ready'], 503: ['Error', 'Dependency unavailable'] },
    }),
    PUBLIC,
    async () => {
      try {
        await deps.readiness();
      } catch {
        throw HttpError.unavailable('service dependencies are unavailable');
      }
      return json(200, { status: 'ok', name: info.title, version: info.version });
    },
  );

  router.get(
    '/v1/capabilities',
    doc({
      summary: 'System capabilities',
      tags: ['meta'],
      responses: { 200: ['Capabilities', 'Subsystem capability flags'] },
    }),
    PUBLIC,
    () => json(200, capabilitiesView(deps)),
  );

  router.get(
    '/v1/openapi.json',
    doc({
      summary: 'OpenAPI specification',
      tags: ['meta'],
      responses: { 200: [undefined, 'The OpenAPI 3.1 document'] },
    }),
    PUBLIC,
    () => {
      cachedSpec ??= buildOpenApiDocument(router, info);
      return json(200, cachedSpec);
    },
  );

  router.get(
    '/v1/metrics',
    doc({
      summary: 'Prometheus metrics exposition',
      tags: ['meta'],
      responses: { 200: [undefined, 'Prometheus text exposition (v0.0.4)'] },
    }),
    PUBLIC,
    () => ({
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      body: deps.metrics.render(),
    }),
  );

  // --- Auth ----------------------------------------------------------------
  router.post(
    '/v1/auth/register',
    doc({
      summary: 'Register a new account',
      tags: ['auth'],
      requestSchema: 'RegisterRequest',
      responses: { 201: ['AuthResponse', 'Account created'], 409: ['Error', 'Handle taken'] },
    }),
    PUBLIC,
    async (ctx) => {
      await admit([
        { key: `register:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.register.perIp },
      ]);

      const body = strictObject(ctx.body, ['handle', 'password', 'email']);
      const handle = reqString(body, 'handle', { trim: true, pattern: HANDLE_PATTERN });
      // Engine bot handles are seeded by migration 0021 and must stay unclaimable: a human holding
      // one turns that migration into a unique violation that blocks the deploy. `handle` is CITEXT
      // in the schema, so the reservation is case-insensitive here too.
      if (BOT_ACCOUNTS.some((bot) => bot.handle.toLowerCase() === handle.toLowerCase())) {
        throw HttpError.conflict('handle is reserved');
      }
      const password = reqString(body, 'password', { min: 8, max: 1024 });
      const email = optString(body, 'email', { max: 320, trim: true, pattern: EMAIL_ADDRESS_PATTERN });
      const result = await auth.register({ handle, password, email: email ?? null }, meta(ctx));
      return json(201, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/login',
    doc({
      summary: 'Log in with a password',
      tags: ['auth'],
      requestSchema: 'LoginRequest',
      responses: { 200: ['AuthResponse', 'Authenticated'], 401: ['Error', 'Invalid credentials'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handle', 'password']);
      const handle = reqString(body, 'handle', { trim: true });
      const password = reqString(body, 'password');

      await admit([
        { key: `login:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.login.perIp },
        { key: `login:handle:${handle.toLowerCase()}`, limit: config.rateLimit.login.perHandle },
      ]);

      const result = await auth.login({ handle, password }, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/refresh',
    doc({
      summary: 'Rotate a refresh token',
      tags: ['auth'],
      requestSchema: 'RefreshRequest',
      responses: { 200: ['AuthResponse', 'New credentials'], 401: ['Error', 'Invalid/expired/reused'] },
    }),
    PUBLIC,
    async (ctx) => {
      await admit([
        { key: `refresh:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.refresh.perIp },
      ]);

      // Prefer the cookie; fall back to the JSON body for non-browser API clients.
      const refreshToken = resolveRefreshToken(ctx);
      if (!refreshToken) {
        throw HttpError.badRequest('refreshToken is required (cookie or body)');
      }
      const result = await auth.refresh(refreshToken, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  router.post(
    '/v1/auth/logout',
    doc({
      summary: 'Revoke the presented refresh token',
      tags: ['auth'],
      security: 'bearer',
      requestSchema: 'RefreshRequest',
      responses: { 204: [undefined, 'Logged out'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      // Prefer the cookie; fall back to the JSON body for non-browser API clients.
      const refreshToken = resolveRefreshToken(ctx);
      if (!refreshToken) {
        throw HttpError.badRequest('refreshToken is required (cookie or body)');
      }
      await auth.logout(refreshToken, meta(ctx), identity.userId);
      return {
        status: 204,
        headers: { 'Set-Cookie': clearRefreshCookie(cookieOpts) },
      };
    },
  );

  router.get(
    '/v1/auth/sessions',
    doc({
      summary: "List the caller's sessions",
      tags: ['auth'],
      security: 'bearer',
      responses: { 200: ['SessionList', 'Sessions, most recent first'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const sessions = await auth.listSessions(identity.userId);
      return json(200, sessions.map(sessionView));
    },
  );

  router.delete(
    '/v1/auth/sessions/:id',
    doc({
      summary: "Revoke one of the caller's sessions",
      tags: ['auth'],
      security: 'bearer',
      params: [pathParam('id', 'Session id, as returned by GET /v1/auth/sessions')],
      responses: {
        204: [undefined, 'Session revoked, or was already revoked'],
        404: ['Error', 'No such session belonging to the caller'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      // The user id comes from the verified token, never from the request, so the id in the path is
      // only ever resolved against this caller's own sessions. See AuthService.revokeSession.
      await auth.revokeSession(identity.userId, ctx.params['id']!, meta(ctx));
      return noContent();
    },
  );

  router.post(
    '/v1/auth/password-reset/request',
    doc({
      summary: 'Request a password reset',
      tags: ['auth'],
      requestSchema: 'PasswordResetRequest',
      responses: { 202: [undefined, 'Accepted'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handleOrEmail']);
      const handleOrEmail = reqString(body, 'handleOrEmail', { trim: true });

      await admit([
        {
          key: `password-reset:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.passwordResetRequest.perIp,
        },
        {
          key: `password-reset:target:${handleOrEmail.toLowerCase()}`,
          limit: config.rateLimit.passwordResetRequest.perTarget,
        },
      ]);

      await auth.requestPasswordReset(handleOrEmail, meta(ctx));
      return { status: 202 };
    },
  );

  router.post(
    '/v1/auth/password-reset/confirm',
    doc({
      summary: 'Confirm a password reset',
      tags: ['auth'],
      requestSchema: 'PasswordResetConfirmRequest',
      responses: { 204: [undefined, 'Password reset'], 401: ['Error', 'Invalid or expired token'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['token', 'newPassword']);
      const token = reqString(body, 'token');
      const newPassword = reqString(body, 'newPassword', { min: 8, max: 1024 });

      await auth.confirmPasswordReset(token, newPassword, meta(ctx));
      // Clear refresh cookie since sessions are revoked
      return {
        status: 204,
        headers: { 'Set-Cookie': clearRefreshCookie(cookieOpts) },
      };
    },
  );

  router.post(
    '/v1/auth/email/verify',
    doc({
      summary: 'Verify an email address',
      tags: ['auth'],
      requestSchema: 'EmailVerifyRequest',
      responses: { 204: [undefined, 'Email verified'], 401: ['Error', 'Invalid or expired token'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['token']);
      const token = reqString(body, 'token');

      await auth.verifyEmail(token, meta(ctx));
      return noContent();
    },
  );

  router.post(
    '/v1/auth/email/verification/request',
    doc({
      summary: "Replace and resend the caller's email-verification token",
      tags: ['auth'],
      security: 'bearer',
      responses: {
        202: [undefined, 'Accepted'],
        401: ['Error', 'Authentication required'],
        429: ['Error', 'Rate limit exceeded', {
          'Retry-After': {
            description: 'Seconds until the rejected rate-limit bucket admits another request',
            schema: { type: 'integer', minimum: 0 },
          },
        }],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      await admit([
        {
          key: `email-verification:user:${identity.userId}`,
          limit: config.rateLimit.emailVerificationRequest.perUser,
        },
        {
          key: `email-verification:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.emailVerificationRequest.perIp,
        },
      ]);
      await auth.requestEmailVerification(identity.userId, meta(ctx));
      return { status: 202 };
    },
  );

  // --- WebAuthn / Passkeys -------------------------------------------------
  router.get(
    '/v1/auth/webauthn/passkeys',
    doc({
      summary: 'List passkeys',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      responses: { 200: ['PasskeyList', 'Passkeys'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const list = await auth.listPasskeys(identity.userId);
      return json(200, list.map(c => ({
        id: c.id.toString('base64url'),
        name: c.name,
        createdAt: c.createdAt.toISOString(),
        lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
      })));
    },
  );

  router.delete(
    '/v1/auth/webauthn/passkeys/:id',
    doc({
      summary: 'Delete a passkey',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      params: [pathParam('id', 'Base64URL encoded credential ID')],
      responses: { 204: [undefined, 'Deleted'], 404: ['Error', 'Not found'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      // convert base64url back to hex for internal use
      const idHex = Buffer.from(ctx.params['id']!, 'base64url').toString('hex');
      await auth.deletePasskey(identity.userId, idHex, meta(ctx));
      return noContent();
    },
  );

  router.post(
    '/v1/auth/webauthn/register/options',
    doc({
      summary: 'Get WebAuthn registration options',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      responses: { 200: ['WebAuthnRegisterOptions', 'Options'] },
    }),
    AUTHED,
    async (ctx) => {
      await admit([
        {
          key: `webauthn-register:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.webauthnRegister.perIp,
        },
      ]);

      const identity = requireAuth(ctx);
      const options = await auth.generateWebAuthnRegisterOptions(identity.userId);
      return json(200, options);
    },
  );

  router.post(
    '/v1/auth/webauthn/register/verify',
    doc({
      summary: 'Verify WebAuthn registration',
      tags: ['auth', 'webauthn'],
      security: 'bearer',
      requestSchema: 'WebAuthnRegisterVerifyRequest',
      responses: { 200: ['PasskeyView', 'Registered'], 400: ['Error', 'Validation Error'] },
    }),
    AUTHED,
    async (ctx) => {
      await admit([
        {
          key: `webauthn-register:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.webauthnRegister.perIp,
        },
      ]);

      const identity = requireAuth(ctx);
      const result = await auth.verifyWebAuthnRegister(identity.userId, ctx.body, meta(ctx));
      return json(200, result);
    },
  );

  router.post(
    '/v1/auth/webauthn/login/options',
    doc({
      summary: 'Get WebAuthn login options',
      tags: ['auth', 'webauthn'],
      requestSchema: 'WebAuthnLoginOptionsRequest',
      responses: { 200: ['WebAuthnLoginOptions', 'Options'] },
    }),
    PUBLIC,
    async (ctx) => {
      const body = strictObject(ctx.body, ['handle']);
      const handle = reqString(body, 'handle', { trim: true });

      await admit([
        { key: `webauthn-login:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.webauthnLogin.perIp },
        {
          key: `webauthn-login:handle:${handle.toLowerCase()}`,
          limit: config.rateLimit.webauthnLogin.perHandle,
        },
      ]);

      const options = await auth.generateWebAuthnLoginOptions(handle);
      return json(200, options);
    },
  );

  router.post(
    '/v1/auth/webauthn/login/verify',
    doc({
      summary: 'Verify WebAuthn login',
      tags: ['auth', 'webauthn'],
      requestSchema: 'WebAuthnLoginVerifyRequest',
      responses: { 200: ['AuthResponse', 'Authenticated'], 401: ['Error', 'Invalid credentials'] },
    }),
    PUBLIC,
    async (ctx) => {
      await admit([
        { key: `webauthn-login:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.webauthnLogin.perIp },
      ]);

      const result = await auth.verifyWebAuthnLogin(ctx.body, meta(ctx));
      return json(200, {
        user: selfUser(result.user, result.roles),
        tokens: result.tokens,
      }, {
        'Set-Cookie': buildRefreshCookie(result.tokens.refreshToken, refreshTokenTtlSec, cookieOpts),
      });
    },
  );

  // --- Users ---------------------------------------------------------------
  router.get(
    '/v1/users/me',
    doc({
      summary: 'Get the authenticated account',
      tags: ['users'],
      security: 'bearer',
      responses: { 200: ['SelfUser', 'The caller'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const user = await repos.users.findById(identity.userId);
      if (!user) throw HttpError.notFound('account not found');
      const roles = await repos.users.rolesOf(user.id);
      return json(200, selfUser(user, roles));
    },
  );

  router.get(
    '/v1/users/:handle',
    doc({
      summary: 'Get a public profile with ratings',
      tags: ['users'],
      params: [pathParam('handle', 'User handle')],
      responses: { 200: ['UserProfile', 'Profile'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const ratings = await allRatings(repos, user.id);
      return json(200, { user: publicUser(user), ratings: ratings.map(ratingView) });
    },
  );

  router.get(
    '/v1/users/:handle/ratings',
    doc({
      summary: "Get a user's ratings across variants",
      tags: ['users', 'ratings'],
      params: [pathParam('handle', 'User handle')],
      responses: { 200: ['RatingList', 'Ratings'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const ratings = await allRatings(repos, user.id);
      return json(200, ratings.map(ratingView));
    },
  );

  router.get(
    '/v1/users/:handle/games',
    doc({
      summary: "Get a user's recent games",
      tags: ['users', 'games'],
      params: [pathParam('handle', 'User handle'), limitParam()],
      responses: { 200: ['GameList', 'Recent games'], 404: ['Error', 'No such user'] },
    }),
    PUBLIC,
    async (ctx) => {
      const user = await findUserByHandle(repos, ctx.params['handle']!);
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const games = await repos.games.recentForUser(user.id, limit);
      return json(200, games.map(gameSummaryView));
    },
  );

  router.post(
    '/v1/users/:userId/roles',
    doc({
      summary: 'Grant a role to a user (admin only)',
      tags: ['users', 'admin'],
      security: 'bearer',
      params: [pathParam('userId', 'Target user id')],
      requestSchema: 'GrantRoleRequest',
      responses: { 204: [undefined, 'Role granted'], 404: ['Error', 'No such user'] },
    }),
    ADMIN,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const body = strictObject(ctx.body, ['role']);
      const role = parseRole(reqString(body, 'role'));
      const targetId = ctx.params['userId']!;
      const target = await repos.users.findById(targetId);
      if (!target) throw HttpError.notFound('user not found');
      await repos.users.addRole(targetId, role);
      await repos.audit.record({
        actorId: actor.userId,
        action: 'roles.grant',
        target: targetId,
        meta: { role },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      return noContent();
    },
  );

  // --- Moderation / Anti-Cheat ---------------------------------------------
  router.get(
    '/v1/moderation/anti-cheat/players/:playerId',
    doc({
      summary: 'View anti-cheat aggregate report for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      tags: ['moderation', 'anti-cheat'],
      responses: {
        200: ['AntiCheatAggregateView', 'Aggregated report'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      // Audit the access attempt before reading report data, so a moderator
      // can never see a report without a guaranteed audit row for it (ADR-0033).
      await repos.audit.record({
        actorId: actor.userId,
        action: 'anti_cheat.aggregate.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const stored = await repos.antiCheat.listByPlayer(playerId);
      const report = aggregatePlayer(stored.map((r) => ({ gameId: r.gameId, report: r.report })));
      return json(200, antiCheatAggregateView(playerId, report));
    },
  );

  router.get(
    '/v1/moderation/anti-cheat/players/:playerId/games',
    doc({
      summary: 'List per-game anti-cheat reports for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)'), limitParam()],
      tags: ['moderation', 'anti-cheat'],
      responses: {
        200: ['AntiCheatGameReportList', 'List of per-game reports'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      // Audit the access attempt before reading report data, so a moderator
      // can never see a report without a guaranteed audit row for it (ADR-0033).
      await repos.audit.record({
        actorId: actor.userId,
        action: 'anti_cheat.games.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const stored = await repos.antiCheat.listByPlayer(playerId);
      return json(200, stored.slice(0, limit).map(antiCheatGameReportView));
    },
  );

  router.post(
    '/v1/moderation/anti-cheat/games/:gameId/analyze',
    doc({
      summary: 'Trigger anti-cheat analysis for a finished game',
      security: 'bearer',
      params: [pathParam('gameId', 'Target game ID (UUID)')],
      tags: ['moderation', 'anti-cheat'],
      requestSchema: 'AnalyzeGameRequest',
      requestBodyRequired: false,
      responses: {
        200: ['AntiCheatGameAnalysisView', 'Per-player reports'],
        404: ['Error', 'No finished game'],
        422: ['Error', 'Malformed id or depth'],
        503: ['Error', 'Engine not configured or unavailable for the variant'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const gameId = parseUuid(ctx.params['gameId']!, 'gameId');
      const body = strictObject(ctx.body ?? {}, ['depth']);
      const depth = optInt(body, 'depth', { min: 8, max: 30 });
      if (!deps.antiCheatAnalysis) {
        throw HttpError.unavailable('anti-cheat analysis engine is not configured');
      }
      await repos.audit.record({
        actorId: actor.userId,
        action: 'anti_cheat.analyze',
        target: gameId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      let report;
      try {
        report = await deps.antiCheatAnalysis.analyzeAndStore(gameId, { depth });
      } catch (err) {
        // No engine is registered for the game's variant — a configuration gap,
        // not a client error. Degrade to 503 instead of a 500.
        if (err instanceof NoEngineForVariantError) {
          throw HttpError.unavailable('anti-cheat analysis engine is unavailable for this variant');
        }
        throw err;
      }
      if (!report) {
        throw HttpError.notFound('no finished game with that id');
      }
      return json(200, antiCheatGameAnalysisView(report));
    },
  );

  // --- Moderation / Bot Detection ------------------------------------------
  router.get(
    '/v1/moderation/bot-detection/players/:playerId',
    doc({
      summary: 'View bot detection aggregate report for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      tags: ['moderation', 'bot-detection'],
      responses: {
        200: ['BotAggregateView', 'Aggregated bot detection report'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      await repos.audit.record({
        actorId: actor.userId,
        action: 'bot_detection.aggregate.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const report = await botService.aggregatePlayer(playerId);
      return json(200, botAggregateView(playerId, report));
    },
  );

  router.get(
    '/v1/moderation/bot-detection/players/:playerId/games',
    doc({
      summary: 'List per-game bot detection reports for a player',
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)'), limitParam()],
      tags: ['moderation', 'bot-detection'],
      responses: {
        200: ['BotGameReportList', 'List of per-game bot detection reports'],
        422: ['Error', 'Malformed player ID'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      await repos.audit.record({
        actorId: actor.userId,
        action: 'bot_detection.games.view',
        target: playerId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      const stored = await repos.botReports.listByPlayer(playerId);
      return json(200, stored.slice(0, limit).map(botGameReportView));
    },
  );

  router.post(
    '/v1/moderation/bot-detection/games/:gameId/analyze',
    doc({
      summary: 'Trigger bot detection analysis for a finished game',
      security: 'bearer',
      params: [pathParam('gameId', 'Target game ID (UUID)')],
      tags: ['moderation', 'bot-detection'],
      responses: {
        200: ['BotGameAnalysisView', 'Per-player bot reports'],
        404: ['Error', 'No finished game'],
        422: ['Error', 'Malformed id'],
        503: ['Error', 'Bot detection timing source is not configured'],
      },
    }),
    MODERATION,
    async (ctx) => {
      const actor = requireAuth(ctx);
      const gameId = parseUuid(ctx.params['gameId']!, 'gameId');
      await repos.audit.record({
        actorId: actor.userId,
        action: 'bot_detection.analyze',
        target: gameId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        at: clock.now(),
      });
      if (!botAnalysis) {
        throw HttpError.unavailable('bot-detection timing source is not configured');
      }
      const report = await botAnalysis.analyzeAndStore(gameId);
      if (!report) {
        throw HttpError.notFound('no finished game with that id');
      }
      return json(200, botGameAnalysisView(report));
    },

  );

  // --- Ratings / leaderboard ----------------------------------------------

  router.get(
    '/v1/leaderboard/:variant',
    doc({
      summary: 'Top players for a variant',
      tags: ['ratings'],
      params: [pathParam('variant', 'Variant code'), limitParam()],
      responses: { 200: ['LeaderboardList', 'Leaderboard'], 422: ['Error', 'Bad variant'] },
    }),
    PUBLIC,
    async (ctx) => {
      const variant = parseVariant(ctx.params['variant']!);
      const limit = parseLimit(ctx.query, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT);
      const rows = await repos.ratings.leaderboard(variant, limit);
      return json(200, rows.map(leaderboardEntry));
    },
  );

  // --- Search --------------------------------------------------------------
  router.get(
    '/v1/search',
    doc({
      summary: 'Search',
      tags: ['search'],
      params: [
        {
          name: 'q',
          in: 'query',
          required: true,
          description: 'Search query (non-blank)',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'mode',
          in: 'query',
          required: false,
          description: 'Search mode (keyword, semantic, hybrid)',
          schema: {
            type: 'string',
            enum: ['keyword', 'semantic', 'hybrid'],
            default: 'keyword',
          },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Maximum results to return',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
          },
        },
        {
          name: 'offset',
          in: 'query',
          required: false,
          description: 'Number of results to skip',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
      ],
      responses: {
        200: ['SearchResults', 'Ranked search results'],
        422: ['Error', 'Invalid query'],
        503: ['Error', 'Search or semantic search is not configured'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      // Each mode resolves its own collaborators before parsing `q`, so an unconfigured backend
      // still answers 503 rather than 422 — the order this route has always had. Binding them to
      // locals is also what lets the calls below stay assertion-free under strict null checks.
      const mode = parseSearchMode(ctx.query);

      if (mode === 'keyword') {
        const repository = deps.searchRepository;
        if (!repository) {
          throw HttpError.unavailable('search is not configured');
        }
        const { query, limit, offset } = parseSearchParams(ctx.query);
        const page = await repository.query(query, { limit, offset });
        return json(200, { total: page.total, results: page.results });
      }

      const semanticRepository = deps.semanticSearchRepository;
      const embeddingProvider = deps.embeddingProvider;
      if (!semanticRepository || !embeddingProvider) {
        throw HttpError.unavailable('semantic search is not configured');
      }

      const { q, query, limit, offset } = parseSearchParams(ctx.query);

      // Filters (e.g. `variant:blitz`) are hard constraints, not relevance signals — the repository
      // applies them separately. Hashing their tokens into the query vector would only add noise, so
      // the embedding is built from terms and phrases alone. A query of nothing BUT filters would
      // leave that empty, so fall back to the raw text rather than embedding an empty string.
      const relevanceText = [...query.terms, ...query.phrases].join(' ');
      const vector = await embeddingProvider.embed(relevanceText !== '' ? relevanceText : q.trim());

      const page =
        mode === 'semantic'
          ? await semanticRepository.querySemantic(vector, {
              limit,
              offset,
              filters: query.filters,
            })
          : // queryHybrid merges query.filters into both branches itself — passing them again here
            // would apply them twice.
            await semanticRepository.queryHybrid(query, vector, { limit, offset });

      return json(200, { total: page.total, results: page.results });
    },
  );

  // --- Seeks / lobby -------------------------------------------------------
  router.get(
    '/v1/seeks',
    doc({
      summary: 'List open seeks',
      tags: ['seeks'],
      params: [limitParam()],
      responses: { 200: ['SeekList', 'Open seeks'] },
    }),
    PUBLIC,
    async (ctx) => {
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      
      if (Math.random() < 0.1) {
        repos.seeks.cleanup(new Date(clock.now())).catch(() => {});
      }

      const seeks = await repos.seeks.listOpen(limit, ctx.auth?.userId);
      // Fallback: If any seek lacks creatorHandle (e.g. custom or legacy repository), batch-resolve from users
      const missingCreatorIds = [...new Set(seeks.filter((s) => !s.creatorHandle).map((s) => s.creatorId))];
      if (missingCreatorIds.length > 0) {
        const users = await repos.users.findByIds(missingCreatorIds);
        const userMap = new Map(users.map((u) => [u.id, u.handle]));
        const enrichedSeeks = seeks.map((s) => s.creatorHandle ? s : { ...s, creatorHandle: userMap.get(s.creatorId) ?? null });
        return json(200, enrichedSeeks.map(seekView));
      }
      return json(200, seeks.map(seekView));
    },
  );

  router.post(
    '/v1/seeks',
    doc({
      summary: 'Create a seek',
      tags: ['seeks'],
      security: 'bearer',
      requestSchema: 'CreateSeekRequest',
      responses: { 201: ['SeekView', 'Seek created'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const body = strictObject(ctx.body, ['variant', 'timeControl', 'rated', 'color', 'minRating', 'maxRating']);
      const variant = parseCreatableVariant(reqString(body, 'variant'));
      const timeControl = parseTimeControl(body['timeControl']);
      const rated = body['rated'] === undefined ? true : body['rated'] === true;
      const color = body['color'] === undefined ? 'random' : parseSeekColor(reqString(body, 'color'));
      const minRating = optInt(body, 'minRating', { min: 0, max: 4000 });
      const maxRating = optInt(body, 'maxRating', { min: 0, max: 4000 });
      if (minRating !== undefined && maxRating !== undefined && minRating > maxRating) {
        throw HttpError.validation('minRating cannot exceed maxRating', {
          minRating: 'must be <= maxRating',
        });
      }
      const seek = await repos.seeks.create({
        id: ids.next(),
        creatorId: identity.userId,
        creatorHandle: identity.handle,
        variant,
        timeControl,
        rated,
        color,
        minRating: minRating ?? null,
        maxRating: maxRating ?? null,
      });
      return json(201, seekView({ ...seek, creatorHandle: seek.creatorHandle ?? identity.handle }));
    },
  );

  router.delete(
    '/v1/seeks/:id',
    doc({
      summary: 'Cancel a seek (owner or moderator)',
      tags: ['seeks'],
      security: 'bearer',
      params: [pathParam('id', 'Seek id')],
      responses: { 204: [undefined, 'Cancelled'], 403: ['Error', 'Not owner'], 404: ['Error', 'No such seek'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const seek = await repos.seeks.findById(ctx.params['id']!);
      if (!seek) throw HttpError.notFound('seek not found');
      const privileged = identity.roles.includes('moderator') || identity.roles.includes('admin');
      if (seek.creatorId !== identity.userId && !privileged) {
        throw HttpError.forbidden('only the creator or a moderator can cancel this seek');
      }
      const removed = await repos.seeks.remove(seek.id);
      if (!removed) throw HttpError.notFound('seek not found or already accepted');
      return noContent();
    },
  );

  router.post(
    '/v1/seeks/:id/accept',
    doc({
      summary: 'Accept an open seek',
      tags: ['seeks'],
      security: 'bearer',
      params: [pathParam('id', 'Seek id')],
      responses: {
        200: ['SeekView', 'Seek matched and game created'],
        400: ['Error', 'Cannot accept own seek'],
        403: ['Error', 'Rating requirements not met'],
        404: ['Error', 'Seek not found or already accepted'],
        409: ['Error', 'Seek is for a variant this server cannot start a game with'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const seek = await repos.seeks.findById(ctx.params['id']!);
      if (!seek || seek.gameId !== null) {
        throw HttpError.notFound('seek not found or already accepted');
      }
      if (seek.creatorId === identity.userId) throw HttpError.badRequest('cannot accept own seek');

      // Before the rating checks, deliberately. This variant comes from a stored row rather than from
      // the request, so validating seek *creation* does not cover it.
      //
      // ADR-0123 added this for `chess960` seeks stranded by its refusal, and ADR-0136 §"Phase B"
      // listed removing it among the steps to restoring the variant. **Kept, with its reason
      // rewritten**, because the guard it produced is broader than the case that motivated it and
      // that case is not the reachable one. `seek.variant` is typed `Variant`, but it is read from a
      // database column — and `scripts/check-variant-parity.mjs` exists precisely because the type
      // system does not span the SQL. A value this code cannot honour therefore reaches here as a
      // well-typed string, and without this check `Game.create` would fall through to the standard
      // board and write a `GameCreated` carrying a variant nothing implements, into an append-only
      // store. That is the durable falsehood ADR-0123 was written to prevent, so deleting its guard
      // on the grounds that chess960 no longer needs it would re-open the hole by a different door.
      //
      // Order matters where two guards both apply: a stranded seek can also carry rating limits, and
      // answering 403 "rating too low" would name a condition the acceptor might go and fix, for a
      // seek that can never start a game whatever their rating. The unfixable reason has to win.
      //
      // 409 rather than 422 because the request is well formed — it is the seek that cannot be
      // honoured.
      if (!CREATABLE_VARIANTS.includes(seek.variant)) {
        throw HttpError.conflict(
          `this seek is for '${seek.variant}', which cannot start a game; it needs to be cancelled and recreated`,
        );
      }

      if (seek.minRating !== null || seek.maxRating !== null) {
        const ratingRow = await repos.ratings.get(identity.userId, seek.variant);
        const currentRating = ratingRow ? ratingRow.rating : 1500;
        if (seek.minRating !== null && currentRating < seek.minRating) {
          throw HttpError.forbidden('rating too low for this seek');
        }
        if (seek.maxRating !== null && currentRating > seek.maxRating) {
          throw HttpError.forbidden('rating too high for this seek');
        }
      }

      let whiteId: string;
      let blackId: string;
      if (seek.color === 'white') {
        whiteId = seek.creatorId;
        blackId = identity.userId;
      } else if (seek.color === 'black') {
        whiteId = identity.userId;
        blackId = seek.creatorId;
      } else {
        if (Math.random() < 0.5) {
          whiteId = seek.creatorId;
          blackId = identity.userId;
        } else {
          whiteId = identity.userId;
          blackId = seek.creatorId;
        }
      }

      const gameId = ids.next();
      const startedAt = clock.now();
      // The arrangement is drawn *here*, at acceptance, and not when the seek was posted.
      //
      // A seek is an offer that may never be taken up, and most are not; drawing at creation would
      // mint a start position for every abandoned seek and, worse, publish it in `SeekView` where an
      // opponent could see the board before deciding to accept. Acceptance is the first moment a
      // game certainly exists, which makes it the moment the game's start is decided.
      //
      // Exactly once per game, including under a concurrent accept: `seekAcceptor.accept` claims the
      // seek row and writes the events in one transaction, so a loser's draw is discarded along with
      // the rest of its attempt rather than reaching the log. Two acceptors cannot produce two starts
      // for one game because they cannot produce one game between them.
      const { events } = Game.create({
        gameId,
        variant: seek.variant,
        timeControl: seek.timeControl,
        players: { white: whiteId, black: blackId },
        rated: seek.rated,
        at: startedAt,
        ...(seek.variant === 'chess960' ? { chess960StartId: chess960Starts.next() } : {}),
      });

      const updatedSeek = await repos.seekAcceptor.accept(seek.id, gameId, events, {
        id: gameId,
        variant: seek.variant,
        rated: seek.rated,
        speed: classifySpeed(seek.timeControl),
        whiteId,
        blackId,
        startedAt: new Date(startedAt),
      });

      if (!updatedSeek) throw HttpError.notFound('seek not found or already accepted');
      const creatorHandle = updatedSeek.creatorHandle ?? seek.creatorHandle ?? (await repos.users.findById(seek.creatorId))?.handle ?? null;
      return json(200, seekView({ ...updatedSeek, creatorHandle }));
    },
  );

  // --- Games ---------------------------------------------------------------
  router.post(
    '/v1/games/bot',
    doc({
      summary: 'Start a game against an engine bot',
      tags: ['games'],
      security: 'bearer',
      requestSchema: 'CreateBotGameRequest',
      responses: {
        200: ['GameSummary', 'Game created against engine bot'],
        400: ['Error', 'Unknown bot level'],
        409: ['Error', 'Game id conflict'],
        422: ['Error', 'Validation error'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const body = strictObject(ctx.body, ['level', 'variant', 'timeControl', 'color']);
      const levelStr = reqString(body, 'level');
      const botAcc = botAccountByLevel(levelStr);
      if (!botAcc) {
        const validLevels = BOT_ACCOUNTS.map((b) => b.level).join(', ');
        throw HttpError.badRequest(`invalid bot level: "${levelStr}". Valid levels: ${validLevels}`);
      }

      const variant = parseCreatableVariant(reqString(body, 'variant'));
      const timeControl = parseTimeControl(body['timeControl']);
      const colorPref = body['color'] !== undefined ? parseSeekColor(reqString(body, 'color')) : 'random';

      const gameId = ids.next();
      const startedAt = clock.now();

      let humanIsWhite: boolean;
      if (colorPref === 'white') {
        humanIsWhite = true;
      } else if (colorPref === 'black') {
        humanIsWhite = false;
      } else {
        // Derive the side from the generated game id rather than Math.random(), so a test with an
        // injected IdGenerator can assert which side the human gets. Summed over the whole id
        // because `IdGenerator.next()` promises only a string: parsing one character as hex yields
        // NaN for any other id shape, and NaN % 2 === 0 is false, which would silently hand every
        // human the same colour instead of failing.
        let checksum = 0;
        for (let i = 0; i < gameId.length; i += 1) checksum += gameId.charCodeAt(i);
        humanIsWhite = checksum % 2 === 0;
      }

      const whiteId = humanIsWhite ? identity.userId : botAcc.userId;
      const blackId = humanIsWhite ? botAcc.userId : identity.userId;

      // Bot games are unrated: a game against a calibrated engine must not move a human's rating
      // (no anti-abuse story for engine rating updates, and adding a flag would be speculative).
      const rated = false;

      const { events } = Game.create({
        gameId,
        variant,
        timeControl,
        players: { white: whiteId, black: blackId },
        rated,
        at: startedAt,
        ...(variant === 'chess960' ? { chess960StartId: chess960Starts.next() } : {}),
      });

      const started = await repos.gameStarter.start(gameId, events, {
        id: gameId,
        variant,
        rated,
        speed: classifySpeed(timeControl),
        whiteId,
        blackId,
        startedAt: new Date(startedAt),
      });

      if (!started) {
        throw HttpError.conflict('game already exists');
      }

      const gameSummary = await repos.games.findById(gameId);
      if (!gameSummary) {
        throw new HttpError(500, 'internal', 'failed to load created game');
      }

      return json(200, gameSummaryView(gameSummary));
    },
  );

  router.get(
    '/v1/games/:id',
    doc({
      summary: 'Get a game summary',
      tags: ['games'],
      params: [pathParam('id', 'Game id')],
      responses: { 200: ['GameSummary', 'Game'], 404: ['Error', 'No such game'] },
    }),
    PUBLIC,
    async (ctx) => {
      const game = await repos.games.findById(ctx.params['id']!);
      if (!game) throw HttpError.notFound('game not found');
      return json(200, gameSummaryView(game));
    },
  );

  router.post(
    '/v1/games/:id/review',
    doc({
      summary: 'Review a player\'s completed game with fixed-policy engine assessments',
      tags: ['games', 'analysis'],
      security: 'bearer',
      params: [pathParam('id', 'Game id')],
      responses: {
        200: ['GameReviewResponse', 'The authenticated player\'s completed-game review'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'No completed game belonging to the player'],
        422: ['Error', 'The request carried a body, or the game uses an unsupported variant, has no moves, or exceeds the instant-review limit'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Game review is not configured, cancelled, or the engine is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.gameReview;
      if (!service) throw HttpError.unavailable('game review is not configured');
      noBody(ctx);
      const gameId = parseUuid(ctx.params['id']!, 'id');
      const charge = (): Promise<void> => admit([
        { key: `game-review:user:${identity.userId}`, limit: config.rateLimit.gameReview.perUser },
        { key: `game-review:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.gameReview.perIp },
      ]);
      const outcome = await service.review({ gameId, userId: identity.userId, signal: ctx.signal }, charge);
      return json(200, gameReviewView(outcome));
    },
  );

  // --- Analysis -------------------------------------------------------------
  router.post(
    '/v1/analysis',
    doc({
      summary: 'Analyze a position with the engine',
      tags: ['analysis'],
      security: 'bearer',
      requestSchema: 'AnalyzeRequest',
      responses: {
        200: ['AnalysisResponse', 'Engine analysis lines for the position'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid position, variant or limits'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Analysis is not configured, or the engine is saturated or unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.analysis;
      if (!service) throw HttpError.unavailable('analysis is not configured');

      const body = strictObject(ctx.body, ['fen', 'variant', 'depth', 'nodes', 'movetimeMs', 'multiPv']);
      const fen = reqString(body, 'fen', { min: 1, max: 200, trim: true });
      const variant = parseVariant(reqString(body, 'variant'));
      const depth = optInt(body, 'depth', { min: 1, max: DEFAULT_ANALYSIS_LIMITS.maxDepth });
      const nodes = optInt(body, 'nodes', { min: 1, max: DEFAULT_ANALYSIS_LIMITS.maxNodes });
      const movetimeMs = optInt(body, 'movetimeMs', { min: 1, max: DEFAULT_ANALYSIS_LIMITS.maxTimeMs });
      const multiPv = optInt(body, 'multiPv', { min: 1, max: DEFAULT_ANALYSIS_LIMITS.maxMultiPv });

      // Charged after the body is known to be well-formed, which is the ordering the Qodo review
      // of PR #134 established for the two endpoints that came later — this one predates it and
      // never got the same treatment. Spending quota above the parsing meant a stream of
      // malformed FENs or an out-of-range `multiPv`, none of which reach an engine, emptied a
      // user's budget and, through the shared per-IP bucket, their neighbours' too.
      await admit([
        { key: `analysis:user:${identity.userId}`, limit: config.rateLimit.analysis.perUser },
        { key: `analysis:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.analysis.perIp },
      ]);

      const outcome = await service.analyze({
        fen,
        variant,
        ...(depth !== undefined ? { depth } : {}),
        ...(nodes !== undefined ? { nodes } : {}),
        ...(movetimeMs !== undefined ? { movetimeMs } : {}),
        ...(multiPv !== undefined ? { multiPv } : {}),
      });

      return json(200, analysisView(outcome));
    },
  );

  // --- Puzzle Generation ---------------------------------------------------
  router.post(
    '/v1/analysis/puzzle',
    doc({
      summary: 'Find a tactic in an exact position using fixed engine policy',
      tags: ['analysis'],
      security: 'bearer',
      requestSchema: 'PuzzleGenerationRequest',
      responses: {
        200: ['PuzzleGenerationResponse', 'Puzzle, no-tactic conclusion, or insufficient evidence'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid position or unsupported variant'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Puzzle generation is not configured, or the engine is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.puzzleGeneration;
      if (!service) throw HttpError.unavailable('puzzle generation is not configured');

      // Search limits, MultiPV and the tactic threshold are server-owned policy.
      const body = strictObject(ctx.body, ['fen', 'variant']);
      const fen = reqString(body, 'fen', { min: 1, max: 200, trim: true });
      const variant = parseVariant(reqString(body, 'variant'));
      const charge = (): Promise<void> => admit([
        {
          key: `puzzle-generation:user:${identity.userId}`,
          limit: config.rateLimit.puzzleGeneration.perUser,
        },
        {
          key: `puzzle-generation:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.puzzleGeneration.perIp,
        },
      ]);

      const outcome = await service.generate({ fen, variant }, charge);
      return json(200, puzzleGenerationView(outcome));
    },
  );

  // --- Opening Exploration ---------------------------------------------------
  //
  // Under `/v1/openings/` and not `/v1/analysis/`, because that prefix is a claim about what serves
  // the request and no engine does: the answer is a bundled table lookup plus a legality replay.
  // A deployment with no engine binary configured answers this in full.
  router.post(
    '/v1/openings/explore',
    doc({
      summary: 'Identify the opening for a move sequence from the standard starting position',
      tags: ['openings'],
      security: 'bearer',
      requestSchema: 'OpeningExplorationRequest',
      responses: {
        200: ['OpeningExplorationResponse', 'The identified opening, or a clean no-match result'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Unsupported variant or starting position, or a malformed, illegal or over-long move sequence'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Opening exploration is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.openingExploration;
      if (!service) throw HttpError.unavailable('opening exploration is not configured');

      const body = strictObject(ctx.body, ['variant', 'moves', 'initialFen']);
      const variant = reqString(body, 'variant', { min: 1, max: 32, trim: true });
      const initialFen = optString(body, 'initialFen', { min: 1, max: 200, trim: true });
      const rawMoves = body['moves'];
      if (!isStringArray(rawMoves)) {
        throw HttpError.validation('"moves" is required', { moves: 'must be an array of strings' });
      }

      // Charged once the body is a body, and before the service does anything with it. The engine
      // routes defer their charge until work is about to begin because the quota they spend is an
      // expensive-work quota; this is an ordinary bucket over an ordinary request, so it covers the
      // whole of it. A body that is not even the right shape is still refused for free above.
      await admit([
        {
          key: `opening-exploration:user:${identity.userId}`,
          limit: config.rateLimit.openingExploration.perUser,
        },
        {
          key: `opening-exploration:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.openingExploration.perIp,
        },
      ]);

      const outcome = await service.explore({
        variant,
        moves: rawMoves,
        ...(initialFen === undefined ? {} : { initialFen }),
      });
      return json(200, openingExplorationView(outcome));
    },
  );

  // --- Mistake Prediction ----------------------------------------------------
  //
  // Under `/v1/analysis/` and not `/v1/ai/`, because the prefix is a claim about what serves the
  // request and no AI provider does. The verdict is derived from the rules and one or two engine
  // searches; a deployment with an engine and no provider configured serves this endpoint in full.
  router.post(
    '/v1/analysis/mistake-prediction',
    doc({
      summary: 'Classify a candidate move as ok, inaccuracy, mistake or blunder',
      tags: ['analysis'],
      security: 'bearer',
      requestSchema: 'MistakePredictionRequest',
      responses: {
        200: ['MistakePredictionResponse', 'Engine-derived verdict for the move'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid position, variant, move, illegal move, or a decided position'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Analysis is not configured, or the engine is saturated or unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.mistakePrediction;
      if (!service) throw HttpError.unavailable('mistake prediction is not configured');

      // Only a position and a move. No thresholds, no depth, no movetime, no MultiPV: what counts as
      // a blunder is server-owned policy, and a request that could widen it would be declaring its
      // own verdict. There is no provider, model, temperature or token field either, because nothing
      // on this path calls one.
      const body = strictObject(ctx.body, ['fen', 'variant', 'move']);
      const fen = reqString(body, 'fen', { min: 1, max: 200, trim: true });
      const variant = parseVariant(reqString(body, 'variant'));
      const move = reqString(body, 'move', { min: 2, max: 6, trim: true });

      // Charged after the request is known to be real, not on arrival — the ordering PR #134's Qodo
      // review established. An accepted request costs one or two engine searches; a malformed FEN or
      // an illegal move costs nothing and must therefore spend nothing, or a stream of them would
      // empty a user's budget and, through the shared per-IP bucket, their neighbours' too.
      const charge = (): Promise<void> => admit([
        {
          key: `mistake-prediction:user:${identity.userId}`,
          limit: config.rateLimit.mistakePrediction.perUser,
        },
        {
          key: `mistake-prediction:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.mistakePrediction.perIp,
        },
      ]);

      const outcome = await service.predict({ fen, variant, move }, charge);

      return json(200, mistakePredictionView(outcome));
    },
  );

  // --- Endgame Training (ADR-0128) -------------------------------------------
  //
  // Standard chess only: `endgame-trainer.ts` hardcodes `variant: 'chess'` and the dataset is
  // standard positions. Neither route accepts a `variant`.
  router.post(
    '/v1/endgames/next',
    doc({
      summary: 'Select a training endgame position matching optional criteria',
      tags: ['endgames'],
      security: 'bearer',
      requestSchema: 'EndgameNextRequest',
      responses: {
        200: ['EndgameNextResponse', 'The selected training position without solution or evaluation'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid filters or no matching position'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Endgame training is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.endgameTraining;
      if (!service) throw HttpError.unavailable('endgame training is not configured');

      const body = strictObject(ctx.body, ['type', 'difficulty', 'id']);
      const type = optString(body, 'type', { min: 1, max: 32, trim: true });
      const difficulty = optString(body, 'difficulty', { min: 1, max: 32, trim: true });
      const id = optString(body, 'id', { min: 1, max: 64, trim: true });

      await admit([
        {
          key: `endgame-training:user:${identity.userId}`,
          limit: config.rateLimit.endgameTraining.perUser,
        },
        {
          key: `endgame-training:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.endgameTraining.perIp,
        },
      ]);

      const outcome = service.next({
        ...(type !== undefined ? { type } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(id !== undefined ? { id } : {}),
      });

      return json(200, endgameNextView(outcome));
    },
  );

  router.post(
    '/v1/endgames/attempt',
    doc({
      summary: 'Judge a learner move in a training endgame position',
      tags: ['endgames'],
      security: 'bearer',
      requestSchema: 'EndgameAttemptRequest',
      responses: {
        200: ['EndgameAttemptResponse', 'Move evaluation, classification, and resulting position'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Unknown endgame id, or malformed/illegal move'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Endgame training is not configured or engine is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.endgameTraining;
      if (!service) throw HttpError.unavailable('endgame training is not configured');

      // The client never sends the entry, the FEN or the goal — the server looks the entry up by id.
      const body = strictObject(ctx.body, ['id', 'move']);
      const id = reqString(body, 'id', { min: 1, max: 64, trim: true });
      const move = reqString(body, 'move', { min: 4, max: 5, trim: true });

      const charge = (): Promise<void> =>
        admit([
          {
            key: `endgame-training:user:${identity.userId}`,
            limit: config.rateLimit.endgameTraining.perUser,
          },
          {
            key: `endgame-training:ip:${ctx.ip ?? 'unknown'}`,
            limit: config.rateLimit.endgameTraining.perIp,
          },
        ]);

      const outcome = await service.attempt({ id, move }, charge);
      return json(200, endgameAttemptView(outcome));
    },
  );

  // --- Coach (ADR-0129) ------------------------------------------------------
  //
  // One request, five sections, each answered by the feature service that already owns that
  // question. This route adds no chess knowledge of its own; what it adds is the sequencing, the
  // single quota that covers all of it, and the cancellation signal that stops the rest of the work
  // when the caller goes away.
  router.post(
    '/v1/coach',
    doc({
      summary: 'Coach a position across mistake, explanation, opening, tactic and endgame analysis',
      tags: ['coach'],
      security: 'bearer',
      requestSchema: 'CoachRequest',
      responses: {
        200: ['CoachResponse', 'Every section, each either present or explicitly omitted with a reason'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid FEN, variant, move, or an over-long move sequence'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Coaching is not configured, or no feature could answer'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.coach;
      if (!service) throw HttpError.unavailable('coaching is not configured');

      // The position, the variant, the move played, and the sequence that reached it. Nothing else,
      // and the omissions are the point: no depth, movetime, multiPv, threshold, provider, model,
      // temperature or token field, because each of those would let a caller decide how much of a
      // shared engine and a metered provider to spend on itself. `strictObject` refuses anything
      // outside this list rather than ignoring it, so a client that tries finds out.
      const body = strictObject(ctx.body, ['fen', 'variant', 'move', 'moves']);
      const fen = reqString(body, 'fen', { min: 1, max: 200, trim: true });
      const variant = parseVariant(reqString(body, 'variant'));
      const move = optString(body, 'move', { min: 2, max: 6, trim: true });
      let moves: readonly string[] | undefined;
      if (body['moves'] !== undefined) {
        const rawMoves = body['moves'];
        // Bounded per element as well as in length. `isStringArray` only proves the entries are
        // strings, and the array cap alone leaves 60 unbounded ones — the schema already promises
        // `minLength: 2, maxLength: 6`, and a body that satisfies the overall size limit could
        // otherwise carry 60 very long strings into the replay. `optString` bounds the single
        // `move` field this way already; this is the same rule for the array.
        if (!isStringArray(rawMoves) || rawMoves.some((m) => m.length < 2 || m.length > 6)) {
          throw HttpError.validation('moves must be an array of UCI moves', {
            moves: 'each entry must be a string of 2 to 6 characters',
          });
        }
        moves = rawMoves;
      }

      // One `admit`, both buckets, and deferred until the service says the request is real.
      //
      // Both halves matter. One call because two would be two independent decisions, charging the
      // first bucket before learning the second refused — the defect the `admit` helper exists to
      // prevent. Deferred because an accepted request costs up to four engine searches and a
      // provider call, while a malformed FEN costs nothing: charging on arrival would let a stream
      // of junk empty a user's budget and, through the shared per-IP bucket, their neighbours' too.
      const charge = (): Promise<void> =>
        admit([
          {
            key: `coach:user:${identity.userId}`,
            limit: config.rateLimit.coach.perUser,
          },
          {
            key: `coach:ip:${ctx.ip ?? 'unknown'}`,
            limit: config.rateLimit.coach.perIp,
          },
        ]);

      const outcome = await service.coach(
        {
          fen,
          variant,
          ...(move !== undefined ? { move } : {}),
          ...(moves !== undefined ? { moves } : {}),
          signal: ctx.signal,
        },
        charge,
      );

      return json(200, coachView(outcome));
    },
  );

  // --- Study Partner v1 -----------------------------------------------------
  router.post(
    '/v1/study-partner/sessions',
    doc({
      summary: 'Create a private server-authoritative Study Partner session',
      tags: ['study-partner'],
      security: 'bearer',
      requestSchema: 'CreateStudyPartnerSessionRequest',
      responses: {
        201: ['StudyPartnerSession', 'Session created'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid variant, FEN, or body'],
        503: ['Error', 'Study Partner is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const actorId = requireAuth(ctx).userId;
      const service = deps.studyPartner;
      if (!service) throw HttpError.unavailable('study partner is not configured');
      const body = strictObject(ctx.body, ['variant', 'initialFen']);
      const variant = parseVariant(reqString(body, 'variant'));
      const initialFen = reqString(body, 'initialFen', { min: 1, max: 200, trim: true });
      return json(201, studyPartnerSessionView(await service.create(actorId, variant, initialFen)));
    },
  );

  router.get(
    '/v1/study-partner/sessions/:id',
    doc({
      summary: 'Read or resume an owned Study Partner session',
      tags: ['study-partner'],
      security: 'bearer',
      params: [pathParam('id', 'Study Partner session ID (UUID)')],
      responses: {
        200: ['StudyPartnerSession', 'Owned session and its bounded turn history'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Session missing or not owned by the caller'],
        422: ['Error', 'Malformed session ID'],
        503: ['Error', 'Study Partner is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const actorId = requireAuth(ctx).userId;
      const service = deps.studyPartner;
      if (!service) throw HttpError.unavailable('study partner is not configured');
      const sessionId = parseUuid(ctx.params['id']!, 'id');
      return json(200, studyPartnerSessionView(await service.get(actorId, sessionId)));
    },
  );

  router.post(
    '/v1/study-partner/sessions/:id/turns',
    doc({
      summary: 'Append one authoritative move and its production coaching result',
      tags: ['study-partner'],
      security: 'bearer',
      params: [
        pathParam('id', 'Study Partner session ID (UUID)'),
        headerParam(
          'Idempotency-Key',
          'Unique turn intent key retained for the life of the session',
          {
            type: 'string',
            minLength: 1,
            maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
            pattern: STUDY_PARTNER_IDEMPOTENCY_KEY_PATTERN,
          },
        ),
      ],
      requestSchema: 'SubmitStudyPartnerTurnRequest',
      responses: {
        200: ['SubmitStudyPartnerTurnResponse', 'Turn committed or a completed request replayed'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Session missing or not owned by the caller'],
        409: ['Error', 'Version conflict, completed session, failed key, or turn in progress'],
        422: ['Error', 'Invalid move, key, body, or turn limit reached'],
        429: ['Error', 'Coach rate limit exceeded'],
        503: ['Error', 'Study Partner or coaching dependency unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.studyPartner;
      if (!service) throw HttpError.unavailable('study partner is not configured');
      const sessionId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['move', 'expectedVersion']);
      const move = reqString(body, 'move', { min: 2, max: 6, trim: true });
      const expectedVersion = optInt(body, 'expectedVersion', { min: 0 });
      if (expectedVersion === undefined) {
        throw HttpError.validation('"expectedVersion" is required', {
          expectedVersion: 'must be a non-negative integer',
        });
      }
      const idempotencyKey = studyPartnerIdempotencyKey(ctx);
      const charge = (): Promise<void> => admit([
        { key: `coach:user:${identity.userId}`, limit: config.rateLimit.coach.perUser },
        { key: `coach:ip:${ctx.ip ?? 'unknown'}`, limit: config.rateLimit.coach.perIp },
      ]);
      const result = await service.submitTurn({
        ownerId: identity.userId,
        sessionId,
        move,
        expectedVersion,
        idempotencyKey,
        signal: ctx.signal,
        charge,
      });
      return json(200, submitStudyPartnerTurnView(result));
    },
  );

  router.post(
    '/v1/study-partner/sessions/:id/end',
    doc({
      summary: 'Idempotently complete an owned Study Partner session',
      tags: ['study-partner'],
      security: 'bearer',
      params: [pathParam('id', 'Study Partner session ID (UUID)')],
      requestSchema: 'EndStudyPartnerSessionRequest',
      responses: {
        200: ['StudyPartnerSession', 'Session completed, or its existing completion returned'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Session missing or not owned by the caller'],
        409: ['Error', 'Version conflict or a turn is in progress'],
        422: ['Error', 'Malformed session ID or body'],
        503: ['Error', 'Study Partner is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const actorId = requireAuth(ctx).userId;
      const service = deps.studyPartner;
      if (!service) throw HttpError.unavailable('study partner is not configured');
      const sessionId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['expectedVersion']);
      const expectedVersion = optInt(body, 'expectedVersion', { min: 0 });
      if (expectedVersion === undefined) {
        throw HttpError.validation('"expectedVersion" is required', {
          expectedVersion: 'must be a non-negative integer',
        });
      }
      return json(200, studyPartnerSessionView(await service.end(actorId, sessionId, expectedVersion)));
    },
  );

  router.delete(
    '/v1/study-partner/sessions/:id',
    doc({
      summary: 'Permanently delete an owned Study Partner session and its turns',
      tags: ['study-partner'],
      security: 'bearer',
      params: [pathParam('id', 'Study Partner session ID (UUID)')],
      responses: {
        204: [undefined, 'Session and turns deleted'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Session missing or not owned by the caller'],
        409: ['Error', 'A turn is active or inside the one-hour accepted-work protection window'],
        422: ['Error', 'Malformed session ID'],
        503: ['Error', 'Study Partner is not configured'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const actorId = requireAuth(ctx).userId;
      const service = deps.studyPartner;
      if (!service) throw HttpError.unavailable('study partner is not configured');
      const sessionId = parseUuid(ctx.params['id']!, 'id');
      await service.delete(actorId, sessionId);
      return noContent();
    },
  );


  // --- Move Explanation ------------------------------------------------------
  router.post(
    '/v1/ai/move-explanation',
    doc({
      summary: 'Explain a move in a position with engine grounding',
      tags: ['ai'],
      security: 'bearer',
      requestSchema: 'MoveExplanationRequest',
      responses: {
        200: ['MoveExplanationResponse', 'Engine-grounded move explanation'],
        401: ['Error', 'Authentication required'],
        422: ['Error', 'Invalid position, variant, move, or illegal move'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Move explanation is not configured, or the provider is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = deps.moveExplanation;
      if (!service) throw HttpError.unavailable('move explanation is not configured');

      const body = strictObject(ctx.body, ['fen', 'variant', 'move']);
      const fen = reqString(body, 'fen', { min: 1, max: 200, trim: true });
      const variant = parseVariant(reqString(body, 'variant'));
      const move = reqString(body, 'move', { min: 2, max: 6, trim: true });

      // Charged after the request is known to be real, not on arrival.
      //
      // The quota here is deliberately low (10/min) because each accepted request costs two engine
      // searches and a paid completion. Spending it at the top of the handler let a stream of
      // malformed FENs or illegal moves — none of which reach an engine — empty a user's budget, and
      // with the shared per-IP bucket, their neighbours' too. `explain` runs this once validation
      // and legality pass and before any of the expensive work. Raised in the Qodo review of PR #134.
      const charge = (): Promise<void> => admit([
        {
          key: `move-explanation:user:${identity.userId}`,
          limit: config.rateLimit.moveExplanation.perUser,
        },
        {
          key: `move-explanation:ip:${ctx.ip ?? 'unknown'}`,
          limit: config.rateLimit.moveExplanation.perIp,
        },
      ]);

      const outcome = await service.explain({ fen, variant, move }, charge);

      return json(200, moveExplanationView(outcome));
    },
  );

  // --- Tournaments ---------------------------------------------------------
  const tournamentService = new TournamentService(deps.tournamentRepo, deps.gameLauncher);
  const arenaService = new ArenaService(deps.tournamentRepo, deps.gameLauncher, () => deps.clock.now());

  router.post(
    '/v1/tournaments',
    doc({
      summary: 'Create a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      requestSchema: 'CreateTournamentRequest',
      responses: { 201: ['TournamentAnyView', 'Tournament created'], 403: ['Error', 'Forbidden'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can create tournaments');
      }
      const body = strictObject(ctx.body, ['name', 'format', 'variant', 'timeControl', 'rounds', 'durationMs', 'tiebreakOrder']);
      const format = oneOf(reqString(body, 'format'), ['round_robin', 'swiss', 'arena'], 'format');
      const variant = parseCreatableVariant(reqString(body, 'variant'));
      const timeControl = parseTimeControl(body['timeControl']);

      if (format === 'arena') {
        const durationMs = optInt(body, 'durationMs');
        if (!durationMs) throw HttpError.validation('durationMs is required for arena format');
        const t = await arenaService.create({
          id: ids.next(),
          name: reqString(body, 'name', { trim: true }),
          variant,
          timeControl,
          durationMs,
        });
        return json(201, arenaTournamentView(t));
      } else {
        const rounds = format === 'swiss' ? optInt(body, 'rounds') : undefined;
        const rawTiebreak = body['tiebreakOrder'];
        let tiebreakOrder: readonly TiebreakKey[] | undefined;
        if (rawTiebreak !== undefined) {
          if (!Array.isArray(rawTiebreak)) {
            throw HttpError.validation('tiebreakOrder must be an array', { tiebreakOrder: rawTiebreak });
          }
          tiebreakOrder = rawTiebreak.map((k) =>
            oneOf(String(k), ['sonneborn_berger', 'buchholz', 'median_buchholz'], 'tiebreakOrder'),
          );
        }
        const t = await tournamentService.create({
          id: ids.next(),
          name: reqString(body, 'name', { trim: true }),
          format: format as 'round_robin' | 'swiss',
          variant,
          timeControl,
          rounds,
          tiebreakOrder,
        });
        return json(201, tournamentView(t));
      }
    },
  );

  router.get(
    '/v1/tournaments',
    doc({
      summary: 'List tournaments',
      tags: ['tournaments'],
      params: [limitParam()],
      responses: { 200: ['TournamentSummaryList', 'Tournaments'] },
    }),
    PUBLIC,
    async (ctx) => {
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const list = await deps.tournamentRepo.list(limit);
      return json(200, list.map(summaryView));
    },
  );

  router.get(
    '/v1/tournaments/:id',
    doc({
      summary: 'Get tournament details',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentAnyView', 'Tournament'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.getTournament(ctx.params['id']!);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/participants',
    doc({
      summary: 'Register for a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id')],
      requestSchema: 'RegisterParticipantRequest',
      responses: { 200: ['TournamentAnyView', 'Registered'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const isDirector = identity.roles.includes('tournament_director');
      let targetId = identity.userId;

      if (ctx.body && typeof ctx.body === 'object' && 'playerId' in ctx.body) {
        if (!isDirector) {
          throw HttpError.forbidden('only tournament directors can register other players');
        }
        targetId = reqString(ctx.body as Record<string, unknown>, 'playerId');
      }

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.register(ctx.params['id']!, targetId);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.register(ctx.params['id']!, targetId);
      return json(200, tournamentView(t));
    },
  );

  router.delete(
    '/v1/tournaments/:id/participants/:playerId',
    doc({
      summary: 'Withdraw from a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('playerId', 'Target user id')],
      responses: { 200: ['TournamentAnyView', 'Withdrawn'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const targetId = ctx.params['playerId']!;
      const isSelf = targetId === identity.userId;
      const isDirector = identity.roles.includes('tournament_director');

      if (!isSelf && !isDirector) {
        throw HttpError.forbidden('cannot withdraw other players unless you are a director');
      }

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.withdraw(ctx.params['id']!, targetId);
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.withdraw(ctx.params['id']!, targetId);
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/start',
    doc({
      summary: 'Start a tournament',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentAnyView', 'Started'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can start tournaments');
      }
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.start(ctx.params['id']!, deps.clock.now());
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.start(ctx.params['id']!);
      return json(200, tournamentView(t));
    },
  );

  router.get(
    '/v1/tournaments/:id/rounds',
    doc({
      summary: 'List generated rounds',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['RoundList', 'Rounds'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, t.getRounds().map(round => roundView(round, t)));
    },
  );

  router.post(
    '/v1/tournaments/:id/rounds/:roundIndex/results',
    doc({
      summary: 'Record a game result',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('roundIndex', 'Round index')],
      requestSchema: 'RecordResultRequest',
      responses: { 200: ['TournamentAnyView', 'Result recorded'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can record results');
      }
      const roundIndex = parseInt(ctx.params['roundIndex']!, 10);
      if (isNaN(roundIndex)) throw HttpError.validation('Invalid roundIndex', { roundIndex: 'must be an integer' });

      const body = strictObject(ctx.body, ['pairingIndex', 'result']);
      const pairingIndex = optInt(body, 'pairingIndex');
      if (pairingIndex === undefined) throw HttpError.validation('pairingIndex is required', {});
      const result = oneOf(reqString(body, 'result'), ['white_win', 'black_win', 'draw'], 'result');

      const t = await tournamentService.recordResult(ctx.params['id']!, {
        roundIndex,
        pairingIndex,
        result: result as 'white_win' | 'black_win' | 'draw',
      });
      return json(200, tournamentView(t));
    },
  );

  router.post(
    '/v1/tournaments/:id/games/:gameId/result',
    doc({
      summary: 'Record a game result by game id',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('gameId', 'Game id')],
      requestSchema: 'RecordResultByGameRequest',
      responses: { 200: ['TournamentAnyView', 'Result recorded'], 403: ['Error', 'Forbidden'], 404: ['Error', 'Not found'], 409: ['Error', 'Conflict'], 422: ['Error', 'Validation error'] },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      if (!identity.roles.includes('tournament_director')) {
        throw HttpError.forbidden('only tournament directors can record results');
      }

      const body = strictObject(ctx.body, ['result']);
      const result = oneOf(reqString(body, 'result'), ['white_win', 'black_win', 'draw'], 'result');

      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const t = await arenaService.recordResultByGame(
          ctx.params['id']!,
          ctx.params['gameId']!,
          result as 'white_win' | 'black_win' | 'draw'
        );
        return json(200, arenaTournamentView(t));
      }
      const t = await tournamentService.recordResultByGame(
        ctx.params['id']!,
        ctx.params['gameId']!,
        result as 'white_win' | 'black_win' | 'draw'
      );
      return json(200, tournamentView(t));
    },
  );

  router.get(
    '/v1/tournaments/:id/standings',
    doc({
      summary: 'Get tournament standings',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['StandingAnyList', 'Standings'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    async (ctx) => {
      const stored = await deps.tournamentRepo.findById(ctx.params['id']!);
      const snap = stored?.snapshot;
      if (!snap) throw HttpError.notFound('tournament not found');
      if (snap.config.format === 'arena') {
        const standings = await arenaService.getStandings(ctx.params['id']!);
        return json(200, standings.map((s, i) => arenaStandingView(s, i)));
      }
      const t = await tournamentService.load(ctx.params['id']!);
      return json(200, t.standings().map(standingView));
    },
  );

  router.get(
    '/v1/tournaments/:id/live',
    doc({
      summary: 'Get live active games and standings',
      tags: ['tournaments'],
      params: [pathParam('id', 'Tournament id')],
      responses: { 200: ['TournamentLiveResponse', 'Live tournament data'], 404: ['Error', 'Not found'] },
    }),
    PUBLIC,
    createLiveTournamentHandler(deps),
  );

  // --- Tournament commentary (ADR-0130) --------------------------------------
  //
  // Both routes take path identifiers and an empty body. That is the feature's whole security
  // posture in one sentence: the caller names a tournament, a game or a round, and every fact that
  // reaches an engine, a prompt or the response is read by the server from the tournament aggregate
  // and the durable game log. There is no field through which a caller could describe a game that
  // was never played, name a player who did not play it, or decide how much of a metered provider
  // and a shared engine their request spends.
  //
  // AUTHED for a reason worth stating: `GET /v1/tournaments/:id/live` is PUBLIC because reading a
  // broadcast costs a database query, while generating a commentary costs a search and a completion
  // with a bill attached. Public visibility of a tournament does not make anonymous callers
  // entitled to spend money on it, and no route in this API that reaches an engine or a provider is
  // reachable without an account.
  /**
   * @returns the commentary service, or 503 on a deployment that composed none.
   */
  const commentaryService = () => {
    const service = deps.tournamentCommentary;
    if (!service) throw HttpError.unavailable('tournament commentary is not configured');
    return service;
  };

  /**
   * Refuse any request body at all.
   *
   * `undefined` is the only body these routes accept, and that is stricter than it first looks:
   * `strictObject(ctx.body, [])` refuses unknown *fields*, so it would have admitted `{}`, and an
   * explicit JSON `null` is a body too. Both then produced a 200 from routes whose documented
   * response for a request body is 422 — a contract that said one thing and did another. Raised in
   * the CodeRabbit review of PR #153.
   *
   * A caller who sends nothing is fine: an empty POST body parses to `undefined`. Nothing is being
   * taken away from a caller who has a fact to send, because there is no fact these routes accept.
   *
   * @param ctx - the request.
   * @throws HttpError 422 when anything at all was sent.
   */
  const noBody = (ctx: RequestContext): void => {
    if (ctx.body === undefined) return;
    throw HttpError.validation('this endpoint takes no request body', {
      body: 'must be absent; every fact in the response is derived by the server',
    });
  };

  router.post(
    '/v1/tournaments/:id/games/:gameId/commentary',
    doc({
      summary: 'Commentate the decisive moment of a finished tournament game',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('gameId', 'Game id, as linked by the tournament')],
      responses: {
        200: ['TournamentGameCommentaryResponse', 'Server-derived facts, an engine citation, and the narrative'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Tournament not found, or the game is not part of it'],
        409: ['Error', 'The tournament is an arena, or the game is unfinished or has no moves'],
        422: ['Error', 'The request carried a body'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Commentary is not configured, or the engine or provider is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = commentaryService();
      noBody(ctx);

      // Deferred until the service has established that the tournament, the game and its finished
      // state are all real. Enumerating game ids costs nothing that way, and a caller cannot empty
      // their own budget — or, through the shared per-IP bucket, their neighbours' — with requests
      // that were never going to reach an engine.
      /** @returns a promise that rejects with 429 when either bucket refuses. */
      const charge = (): Promise<void> =>
        admit([
          {
            key: `tournament-commentary:user:${identity.userId}`,
            limit: config.rateLimit.tournamentCommentary.perUser,
          },
          {
            key: `tournament-commentary:ip:${ctx.ip ?? 'unknown'}`,
            limit: config.rateLimit.tournamentCommentary.perIp,
          },
        ]);

      const outcome = await service.commentateGame(
        {
          tournamentId: ctx.params['id']!,
          gameId: ctx.params['gameId']!,
          signal: ctx.signal,
        },
        charge,
      );
      return json(200, tournamentGameCommentaryView(outcome));
    },
  );

  router.post(
    '/v1/tournaments/:id/rounds/:roundIndex/recap',
    doc({
      summary: 'Narrate a round every pairing of which has a result',
      tags: ['tournaments'],
      security: 'bearer',
      params: [pathParam('id', 'Tournament id'), pathParam('roundIndex', 'Zero-based round index')],
      responses: {
        200: ['TournamentRoundRecapResponse', 'The round results, the standings after it, and the narrative'],
        401: ['Error', 'Authentication required'],
        404: ['Error', 'Tournament or round not found'],
        409: ['Error', 'The tournament is an arena, or the round is not complete'],
        422: ['Error', 'Invalid round index, or the request carried a body'],
        429: ['Error', 'Rate limit exceeded'],
        503: ['Error', 'Commentary is not configured, or the provider is unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const identity = requireAuth(ctx);
      const service = commentaryService();
      noBody(ctx);

      // Matched before it is parsed, because `Number.parseInt` truncates: it reads "1.5" as 1 and
      // "1abc" as 1, so a caller asking for a round that does not exist would silently be answered
      // about one that does. Found by the route tests for this increment.
      const rawRound = ctx.params['roundIndex']!;
      if (!/^[0-9]{1,4}$/.test(rawRound)) {
        throw HttpError.validation('Invalid roundIndex', { roundIndex: 'must be a non-negative integer' });
      }
      const roundIndex = Number.parseInt(rawRound, 10);

      /** @returns a promise that rejects with 429 when either bucket refuses. */
      const charge = (): Promise<void> =>
        admit([
          {
            key: `tournament-commentary:user:${identity.userId}`,
            limit: config.rateLimit.tournamentCommentary.perUser,
          },
          {
            key: `tournament-commentary:ip:${ctx.ip ?? 'unknown'}`,
            limit: config.rateLimit.tournamentCommentary.perIp,
          },
        ]);

      const outcome = await service.recapRound(
        { tournamentId: ctx.params['id']!, round: roundIndex, signal: ctx.signal },
        charge,
      );
      return json(200, tournamentRoundRecapView(outcome));
    },
  );

  // --- Social Graph --------------------------------------------------------
  function checkSocialRepo() {
    if (!deps.socialGraphRepository) {
      throw HttpError.unavailable('social graph repository is not configured');
    }
    return deps.socialGraphRepository;
  }

  // 1. POST /v1/social/follows/:playerId
  router.post(
    '/v1/social/follows/:playerId',
    doc({
      summary: 'Follow a player',
      tags: ['social'],
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        200: ['FollowEdgeView', 'Follow edge created or existing'],
        403: ['Error', 'Blocked'],
        422: ['Error', 'Self relation or malformed ID'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      try {
        const edge = await repo.follow(actorId, targetId, new Date(clock.now()));
        return json(200, followEdgeView(edge));
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 2. DELETE /v1/social/follows/:playerId
  router.delete(
    '/v1/social/follows/:playerId',
    doc({
      summary: 'Unfollow a player',
      tags: ['social'],
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        204: [undefined, 'Unfollowed'],
        422: ['Error', 'Self relation or malformed ID'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      try {
        await repo.unfollow(actorId, targetId);
        return noContent();
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 3. GET /v1/social/players/:playerId/followers
  router.get(
    '/v1/social/players/:playerId/followers',
    doc({
      summary: "List a player's followers",
      tags: ['social'],
      params: [pathParam('playerId', 'Target player ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['FollowEdgeList', 'Page of follower edges'],
        422: ['Error', 'Malformed ID or pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkSocialRepo();
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listFollowers(targetId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(followEdgeView),
      });
    },
  );

  // 4. GET /v1/social/players/:playerId/following
  router.get(
    '/v1/social/players/:playerId/following',
    doc({
      summary: 'List players followed by a player',
      tags: ['social'],
      params: [pathParam('playerId', 'Target player ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['FollowEdgeList', 'Page of following edges'],
        422: ['Error', 'Malformed ID or pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkSocialRepo();
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listFollowing(targetId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(followEdgeView),
      });
    },
  );

  // 5. POST /v1/social/friend-requests
  router.post(
    '/v1/social/friend-requests',
    doc({
      summary: 'Send a friend request',
      tags: ['social'],
      security: 'bearer',
      requestSchema: 'SendFriendRequestRequest',
      responses: {
        201: ['FriendRequestView', 'Friend request created'],
        403: ['Error', 'Blocked'],
        409: ['Error', 'Conflict or already exists'],
        422: ['Error', 'Self relation or malformed ID'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const body = strictObject(ctx.body, ['addresseeId']);
      const addresseeId = parseUuid(reqString(body, 'addresseeId'), 'addresseeId');
      const id = ids.next();
      try {
        const req = await repo.sendFriendRequest(id, actorId, addresseeId, new Date(clock.now()));
        return json(201, friendRequestView(req));
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 6. POST /v1/social/friend-requests/:id/respond
  router.post(
    '/v1/social/friend-requests/:id/respond',
    doc({
      summary: 'Respond to a friend request',
      tags: ['social'],
      security: 'bearer',
      params: [pathParam('id', 'Friend request ID (UUID)')],
      requestSchema: 'RespondFriendRequestRequest',
      responses: {
        200: ['FriendRequestView', 'Friend request updated'],
        403: ['Error', 'Not authorized for this request action'],
        404: ['Error', 'Friend request not found'],
        409: ['Error', 'Invalid transition'],
        422: ['Error', 'Malformed ID or action'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const reqId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['action']);
      const action = oneOf(reqString(body, 'action'), ['accept', 'decline', 'cancel'], 'action') as FriendRequestAction;
      try {
        const req = await repo.respondToFriendRequest(reqId, action, actorId, new Date(clock.now()));
        return json(200, friendRequestView(req));
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 7. GET /v1/social/friend-requests/incoming
  router.get(
    '/v1/social/friend-requests/incoming',
    doc({
      summary: "List caller's incoming pending friend requests",
      tags: ['social'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['FriendRequestList', 'Page of incoming friend requests'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listIncomingRequests(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(friendRequestView),
      });
    },
  );

  // 8. GET /v1/social/friend-requests/outgoing
  router.get(
    '/v1/social/friend-requests/outgoing',
    doc({
      summary: "List caller's outgoing pending friend requests",
      tags: ['social'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['FriendRequestList', 'Page of outgoing friend requests'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listOutgoingRequests(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(friendRequestView),
      });
    },
  );

  // 9. GET /v1/social/friends
  router.get(
    '/v1/social/friends',
    doc({
      summary: "List caller's friends",
      tags: ['social'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['FriendList', 'Page of friend player IDs'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listFriends(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: [...page.items],
      });
    },
  );

  // 10. POST /v1/social/blocks/:playerId
  router.post(
    '/v1/social/blocks/:playerId',
    doc({
      summary: 'Block a player',
      tags: ['social'],
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        200: ['BlockEdgeView', 'Block edge created or existing'],
        422: ['Error', 'Self relation or malformed ID'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      try {
        const edge = await repo.block(actorId, targetId, new Date(clock.now()));
        return json(200, blockEdgeView(edge));
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 11. DELETE /v1/social/blocks/:playerId
  router.delete(
    '/v1/social/blocks/:playerId',
    doc({
      summary: 'Unblock a player',
      tags: ['social'],
      security: 'bearer',
      params: [pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        204: [undefined, 'Unblocked'],
        422: ['Error', 'Self relation or malformed ID'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const targetId = parseUuid(ctx.params['playerId']!, 'playerId');
      try {
        await repo.unblock(actorId, targetId);
        return noContent();
      } catch (err) {
        mapSocialError(err);
      }
    },
  );

  // 12. GET /v1/social/blocks
  router.get(
    '/v1/social/blocks',
    doc({
      summary: "List caller's blocked players",
      tags: ['social'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['BlockEdgeList', 'Page of block edges'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Social service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkSocialRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listBlocked(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(blockEdgeView),
      });
    },
  );

  // --- Direct Messaging -----------------------------------------------------
  function checkMessagingRepo() {
    if (!deps.messagingRepository) {
      throw HttpError.unavailable('messaging repository is not configured');
    }
    return deps.messagingRepository;
  }

  // 1. GET /v1/messages/conversations
  router.get(
    '/v1/messages/conversations',
    doc({
      summary: "List caller's conversations",
      tags: ['messaging'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['ConversationList', 'Paginated caller conversations'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const page = await repo.listConversations(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(conversationSummaryView),
      });
    },
  );

  // 2. GET /v1/messages/conversations/:id
  router.get(
    '/v1/messages/conversations/:id',
    doc({
      summary: 'Get conversation by ID',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Conversation ID (UUID)')],
      responses: {
        200: ['ConversationView', 'Conversation details'],
        404: ['Error', 'Not found'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const convId = parseUuid(ctx.params['id']!, 'id');
      try {
        const conv = await repo.getConversation(convId, actorId);
        return json(200, conversationView(conv));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 3. POST /v1/messages/conversations
  router.post(
    '/v1/messages/conversations',
    doc({
      summary: 'Open or fetch conversation with a player',
      tags: ['messaging'],
      security: 'bearer',
      requestSchema: 'CreateConversationRequest',
      responses: {
        200: ['ConversationView', 'Existing or newly created conversation'],
        403: ['Error', 'Blocked'],
        404: ['Error', 'No such player'],
        422: ['Error', 'Self conversation or malformed input'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const body = strictObject(ctx.body, ['playerId']);
      const targetId = parseUuid(reqString(body, 'playerId'), 'playerId');
      // `parseUuid` proved the shape, not that anyone is behind it. The Postgres adapter would
      // catch this on the users foreign key, but the in-memory adapter has no users to key
      // against and would happily open a conversation with nobody — so the check belongs here,
      // where the answer is the same whichever adapter is wired in.
      if (!(await repos.users.findById(targetId))) throw HttpError.notFound('user not found');
      try {
        const conv = await repo.getOrCreateConversation(ids.next(), actorId, targetId, new Date(clock.now()));
        return json(200, conversationView(conv));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 4. GET /v1/messages/conversations/:id/messages
  router.get(
    '/v1/messages/conversations/:id/messages',
    doc({
      summary: 'List messages in a conversation thread',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Conversation ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['MessageList', 'Paginated thread messages'],
        404: ['Error', 'Not found'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const convId = parseUuid(ctx.params['id']!, 'id');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      try {
        const page = await repo.listMessages(convId, actorId, { limit, offset });
        return json(200, {
          total: page.total,
          items: page.items.map(messageView),
        });
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 5. POST /v1/messages/conversations/:id/messages
  router.post(
    '/v1/messages/conversations/:id/messages',
    doc({
      summary: 'Send a direct message in a conversation',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Conversation ID (UUID)')],
      requestSchema: 'SendMessageRequest',
      responses: {
        201: ['MessageView', 'Sent message'],
        403: ['Error', 'Blocked or not authorized'],
        404: ['Error', 'Not found'],
        422: ['Error', 'Invalid body'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const convId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['body']);
      const messageText = reqString(body, 'body');
      const msgId = ids.next();
      try {
        const msg = await repo.sendMessage(msgId, convId, actorId, messageText, new Date(clock.now()));
        return json(201, messageView(msg));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 6. PATCH /v1/messages/messages/:id
  router.patch(
    '/v1/messages/messages/:id',
    doc({
      summary: 'Edit own message body',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Message ID (UUID)')],
      requestSchema: 'EditMessageRequest',
      responses: {
        200: ['MessageView', 'Edited message'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Not found'],
        409: ['Error', 'Deleted message cannot be edited'],
        422: ['Error', 'Invalid body'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const msgId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['body']);
      const messageText = reqString(body, 'body');
      try {
        const msg = await repo.editMessage(msgId, actorId, messageText, new Date(clock.now()));
        return json(200, messageView(msg));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );


  // 7. DELETE /v1/messages/messages/:id
  router.delete(
    '/v1/messages/messages/:id',
    doc({
      summary: 'Tombstone own message',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Message ID (UUID)')],
      responses: {
        200: ['MessageView', 'Tombstoned message'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Not found'],
        409: ['Error', 'Already deleted'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const msgId = parseUuid(ctx.params['id']!, 'id');
      try {
        const msg = await repo.deleteMessage(msgId, actorId, new Date(clock.now()));
        return json(200, messageView(msg));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 8. POST /v1/messages/conversations/:id/read
  router.post(
    '/v1/messages/conversations/:id/read',
    doc({
      summary: 'Mark conversation read',
      tags: ['messaging'],
      security: 'bearer',
      params: [pathParam('id', 'Conversation ID (UUID)')],
      responses: {
        200: ['ConversationReadStateView', 'Updated read state'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Not found'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const convId = parseUuid(ctx.params['id']!, 'id');
      try {
        const readState = await repo.markAsRead(convId, actorId, new Date(clock.now()));
        return json(200, conversationReadStateView(readState));
      } catch (err) {
        mapMessagingError(err);
      }
    },
  );

  // 9. GET /v1/messages/unread-count
  router.get(
    '/v1/messages/unread-count',
    doc({
      summary: "Get caller's total unread count across all conversations",
      tags: ['messaging'],
      security: 'bearer',
      responses: {
        200: ['UnreadCountView', 'Total unread count'],
        503: ['Error', 'Messaging service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkMessagingRepo();
      const actorId = requireAuth(ctx).userId;
      const count = await repo.getUnreadCount(actorId);
      return json(200, { unreadCount: count });
    },
  );

  // --- Teams & Forums -------------------------------------------------------
  function checkCommunityRepo() {
    if (!deps.communityRepository) {
      throw HttpError.unavailable('community repository is not configured');
    }
    return deps.communityRepository;
  }

  async function requirePlayerExists(playerId: string): Promise<void> {
    const user = await deps.repos.users.findById(playerId);
    if (!user) {
      throw HttpError.notFound(`Player '${playerId}' not found`);
    }
  }

  // 1. POST /v1/teams
  router.post(
    '/v1/teams',
    doc({
      summary: 'Create a team',
      tags: ['community'],
      security: 'bearer',
      responses: {
        201: ['TeamView', 'Team created successfully'],
        400: ['Error', 'Malformed request body'],
        409: ['Error', 'Slug already taken'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const body = strictObject(ctx.body, ['slug', 'name', 'description', 'visibility']);
      const slug = reqString(body, 'slug');
      const name = reqString(body, 'name');
      const description = optString(body, 'description') ?? '';
      const visibility = oneOf(reqString(body, 'visibility'), ['public', 'private'] as const, 'visibility');

      const teamId = deps.ids.next();
      try {
        const team = await repo.createTeam(teamId, slug, name, description, visibility, actorId, new Date(deps.clock.now()));
        return json(201, teamView(team));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 2. GET /v1/teams
  router.get(
    '/v1/teams',
    doc({
      summary: 'List or search teams',
      tags: ['community'],
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['TeamList', 'Paginated teams list'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const search = ctx.query.get('search') ?? undefined;

      try {
        const page = await repo.listTeams(actorId, { limit, offset, search });
        return json(200, {
          total: page.total,
          items: page.items.map(teamView),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 3. GET /v1/teams/:id
  router.get(
    '/v1/teams/:id',
    doc({
      summary: 'Get team by ID or slug',
      tags: ['community'],
      params: [pathParam('id', 'Team ID (UUID) or slug')],
      responses: {
        200: ['TeamDetailView', 'Team details, including the role of the viewer'],
        404: ['Error', 'Team not found or not visible'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const idOrSlug = ctx.params['id']!;

      try {
        // Decide which lookup to run BEFORE running one. Trying `getTeam` first and falling back on
        // `not_found` reads as harmless, but it only works against the in-memory adapter, where an
        // id is just a string. Postgres compares against a `uuid` column, so a slug does not miss —
        // it raises `invalid input syntax for type uuid`, which is not a domain error, so the
        // fallback is never reached and the request 500s. The two adapters disagreed and only one
        // of them was under test.
        const team = UUID_PATTERN.test(idOrSlug)
          ? await repo.getTeam(idOrSlug, actorId)
          : await repo.getTeamBySlug(idOrSlug, actorId);
        // One lookup, and only for a signed-in caller. The client cannot work this out from the
        // member list: that list is paginated and sorted owner → admin → member, so on a large team
        // the viewer is often not on the page it reads.
        const membership = actorId ? await repo.getMembership(team.id, actorId, actorId) : null;
        return json(200, teamDetailView(team, membership?.role ?? null));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 4. PATCH /v1/teams/:id
  router.patch(
    '/v1/teams/:id',
    doc({
      summary: 'Update team details',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)')],
      responses: {
        200: ['TeamView', 'Team updated'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Team not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['name', 'description', 'visibility']);
      const name = optString(body, 'name');
      const description = optString(body, 'description');
      const visibility = body['visibility'] !== undefined ? oneOf(reqString(body, 'visibility'), ['public', 'private'] as const, 'visibility') : undefined;

      try {
        const updated = await repo.updateTeam(teamId, actorId, { name, description, visibility }, new Date(deps.clock.now()));
        return json(200, teamView(updated));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 5. GET /v1/teams/:id/members
  router.get(
    '/v1/teams/:id/members',
    doc({
      summary: 'List team members',
      tags: ['community'],
      params: [pathParam('id', 'Team ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['MemberList', 'Paginated team members'],
        404: ['Error', 'Team not found or not visible'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      try {
        const page = await repo.listMembers(teamId, actorId, { limit, offset });
        return json(200, {
          total: page.total,
          items: page.items.map(membershipView),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 6. POST /v1/teams/:id/members
  router.post(
    '/v1/teams/:id/members',
    doc({
      summary: 'Join a public team directly',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)')],
      responses: {
        201: ['MembershipView', 'Joined team successfully'],
        403: ['Error', 'Private teams require join request'],
        404: ['Error', 'Team not found'],
        409: ['Error', 'Already a member'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');

      try {
        const mem = await repo.joinTeam(teamId, actorId, new Date(deps.clock.now()));
        return json(201, membershipView(mem));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 7. DELETE /v1/teams/:id/members/:playerId
  router.delete(
    '/v1/teams/:id/members/:playerId',
    doc({
      summary: 'Leave team or remove member',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        204: [undefined, 'Member left or removed successfully'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Team or player not found'],
        409: ['Error', 'Owner cannot leave without transferring ownership'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const targetPlayerId = parseUuid(ctx.params['playerId']!, 'playerId');

      if (targetPlayerId !== actorId) {
        await requirePlayerExists(targetPlayerId);
      }

      try {
        await repo.leaveOrRemoveMember(teamId, actorId, targetPlayerId);
        return noContent();
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 8. PATCH /v1/teams/:id/members/:playerId
  router.patch(
    '/v1/teams/:id/members/:playerId',
    doc({
      summary: 'Update member role',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('playerId', 'Target player ID (UUID)')],
      responses: {
        200: ['MembershipView', 'Role updated'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Team or member not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const targetPlayerId = parseUuid(ctx.params['playerId']!, 'playerId');
      const body = strictObject(ctx.body, ['role']);
      const newRole = oneOf(reqString(body, 'role'), ['admin', 'member'] as const, 'role');

      await requirePlayerExists(targetPlayerId);

      try {
        const mem = await repo.updateMemberRole(teamId, actorId, targetPlayerId, newRole);
        return json(200, membershipView(mem));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 9. POST /v1/teams/:id/transfer-ownership
  router.post(
    '/v1/teams/:id/transfer-ownership',
    doc({
      summary: 'Transfer team ownership',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)')],
      responses: {
        200: ['OwnershipTransferView', 'Ownership transferred'],
        403: ['Error', 'Only owner can transfer ownership'],
        404: ['Error', 'Team or target member not found'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['newOwnerId']);
      const newOwnerId = reqString(body, 'newOwnerId');

      await requirePlayerExists(newOwnerId);

      try {
        const res = await repo.transferOwnership(teamId, actorId, newOwnerId);
        return json(200, {
          oldOwner: membershipView(res.oldOwner),
          newOwner: membershipView(res.newOwner),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 10. POST /v1/teams/:id/join-requests
  router.post(
    '/v1/teams/:id/join-requests',
    doc({
      summary: 'Request to join a visible team',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)')],
      responses: {
        201: ['JoinRequestView', 'Join request submitted'],
        404: ['Error', 'Team not found'],
        409: ['Error', 'Already a member or request pending'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const requestId = deps.ids.next();

      try {
        const req = await repo.createJoinRequest(requestId, teamId, actorId, new Date(deps.clock.now()));
        return json(201, joinRequestView(req));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 10a. GET /v1/me/join-requests
  router.get(
    '/v1/me/join-requests',
    doc({
      summary: 'List my pending team join requests',
      tags: ['community'],
      security: 'bearer',
      params: [limitParam(), offsetParam()],
      responses: {
        200: ['JoinRequestList', 'Paginated pending join requests owned by the caller'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      const page = await repo.listOutgoingJoinRequests(actorId, { limit, offset });
      return json(200, {
        total: page.total,
        items: page.items.map(joinRequestView),
      });
    },
  );

  // 11. GET /v1/teams/:id/join-requests
  router.get(
    '/v1/teams/:id/join-requests',
    doc({
      summary: 'List join requests for team',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), statusParam(), limitParam(), offsetParam()],
      responses: {
        200: ['JoinRequestList', 'Paginated join requests'],
        403: ['Error', 'Only admins and owners can view join requests'],
        404: ['Error', 'Team not found'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      // `has` not truthiness: `?status=` is a status the caller supplied and got wrong, so it is a
      // 422 like any other bad value. Treating empty as absent silently returns the unfiltered list.
      const status = ctx.query.has('status')
        ? oneOf(ctx.query.get('status') ?? '', ['pending', 'accepted', 'declined', 'cancelled'] as const, 'status')
        : undefined;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      try {
        const page = await repo.listJoinRequests(teamId, actorId, { limit, offset, status });
        return json(200, {
          total: page.total,
          items: page.items.map(joinRequestView),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 12. POST /v1/teams/:id/join-requests/:reqId/respond
  router.post(
    '/v1/teams/:id/join-requests/:reqId/respond',
    doc({
      summary: 'Respond to join request',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('reqId', 'Join request ID (UUID)')],
      responses: {
        200: ['JoinRequestView', 'Join request updated'],
        403: ['Error', 'Only admins and owners can respond to join requests'],
        404: ['Error', 'Join request not found'],
        409: ['Error', 'Join request is not pending'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const reqId = parseUuid(ctx.params['reqId']!, 'reqId');
      const body = strictObject(ctx.body, ['status']);
      const status = oneOf(reqString(body, 'status'), ['accepted', 'declined'] as const, 'status');

      try {
        const req = await repo.respondToJoinRequest(reqId, actorId, status, new Date(deps.clock.now()));
        return json(200, joinRequestView(req));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 13. DELETE /v1/teams/:id/join-requests/:reqId
  router.delete(
    '/v1/teams/:id/join-requests/:reqId',
    doc({
      summary: 'Cancel join request',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('reqId', 'Join request ID (UUID)')],
      responses: {
        200: ['JoinRequestView', 'Join request cancelled'],
        404: ['Error', 'Join request not found or not owned by caller'],
        409: ['Error', 'Join request is not pending'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const reqId = parseUuid(ctx.params['reqId']!, 'reqId');

      try {
        const req = await repo.cancelJoinRequest(reqId, actorId, new Date(deps.clock.now()));
        return json(200, joinRequestView(req));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 14. GET /v1/teams/:id/forum/threads
  router.get(
    '/v1/teams/:id/forum/threads',
    doc({
      summary: 'List forum threads in a team',
      tags: ['community'],
      params: [pathParam('id', 'Team ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['ForumThreadList', 'Paginated forum threads'],
        404: ['Error', 'Team not found or not visible'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      try {
        const page = await repo.listThreads(teamId, actorId, { limit, offset });
        return json(200, {
          total: page.total,
          items: page.items.map(forumThreadView),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 15. POST /v1/teams/:id/forum/threads
  router.post(
    '/v1/teams/:id/forum/threads',
    doc({
      summary: 'Create a new forum thread',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)')],
      responses: {
        201: ['ForumThreadCreateView', 'Thread created successfully'],
        403: ['Error', 'Only team members can create threads'],
        404: ['Error', 'Team not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const teamId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['title', 'body']);
      const title = reqString(body, 'title');
      const postBody = reqString(body, 'body');

      const threadId = deps.ids.next();
      const firstPostId = deps.ids.next();

      try {
        const res = await repo.createThread(threadId, teamId, actorId, title, postBody, firstPostId, new Date(deps.clock.now()));
        return json(201, {
          thread: forumThreadView(res.thread),
          firstPost: forumPostView(res.post),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 16. GET /v1/teams/:id/forum/threads/:threadId
  router.get(
    '/v1/teams/:id/forum/threads/:threadId',
    doc({
      summary: 'Get forum thread by ID',
      tags: ['community'],
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('threadId', 'Thread ID (UUID)')],
      responses: {
        200: ['ForumThreadView', 'Forum thread details'],
        404: ['Error', 'Thread not found or not visible'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const threadId = parseUuid(ctx.params['threadId']!, 'threadId');

      try {
        const thread = await repo.getThread(threadId, actorId);
        return json(200, forumThreadView(thread));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 17. PATCH /v1/teams/:id/forum/threads/:threadId
  router.patch(
    '/v1/teams/:id/forum/threads/:threadId',
    doc({
      summary: 'Update forum thread (title, locked, pinned)',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('threadId', 'Thread ID (UUID)')],
      responses: {
        200: ['ForumThreadView', 'Thread updated'],
        403: ['Error', 'Not authorized to update thread'],
        404: ['Error', 'Thread not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const threadId = parseUuid(ctx.params['threadId']!, 'threadId');
      const body = strictObject(ctx.body, ['title', 'locked', 'pinned']);
      const title = optString(body, 'title');
      const locked = body['locked'] !== undefined ? reqBoolean(body, 'locked') : undefined;
      const pinned = body['pinned'] !== undefined ? reqBoolean(body, 'pinned') : undefined;

      try {
        const thread = await repo.updateThread(threadId, actorId, { title, locked, pinned }, new Date(deps.clock.now()));
        return json(200, forumThreadView(thread));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 18. DELETE /v1/teams/:id/forum/threads/:threadId
  router.delete(
    '/v1/teams/:id/forum/threads/:threadId',
    doc({
      summary: 'Delete forum thread',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('threadId', 'Thread ID (UUID)')],
      responses: {
        200: ['ForumThreadView', 'Thread tombstoned'],
        403: ['Error', 'Not authorized to delete thread'],
        404: ['Error', 'Thread not found'],
        409: ['Error', 'Thread already deleted'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const threadId = parseUuid(ctx.params['threadId']!, 'threadId');

      try {
        const thread = await repo.deleteThread(threadId, actorId, new Date(deps.clock.now()));
        return json(200, forumThreadView(thread));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 19. GET /v1/teams/:id/forum/threads/:threadId/posts
  router.get(
    '/v1/teams/:id/forum/threads/:threadId/posts',
    doc({
      summary: 'List posts in a forum thread',
      tags: ['community'],
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('threadId', 'Thread ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['ForumPostList', 'Paginated posts'],
        404: ['Error', 'Thread not found or not visible'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = ctx.auth?.userId;
      const threadId = parseUuid(ctx.params['threadId']!, 'threadId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      try {
        const page = await repo.listPosts(threadId, actorId, { limit, offset });
        return json(200, {
          total: page.total,
          items: page.items.map(forumPostView),
        });
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 20. POST /v1/teams/:id/forum/threads/:threadId/posts
  router.post(
    '/v1/teams/:id/forum/threads/:threadId/posts',
    doc({
      summary: 'Create a post in a forum thread',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('id', 'Team ID (UUID)'), pathParam('threadId', 'Thread ID (UUID)')],
      responses: {
        201: ['ForumPostView', 'Post created'],
        403: ['Error', 'Only members can post or thread is locked'],
        404: ['Error', 'Thread not found'],
        409: ['Error', 'Thread is deleted'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const threadId = parseUuid(ctx.params['threadId']!, 'threadId');
      const body = strictObject(ctx.body, ['body']);
      const postBody = reqString(body, 'body');
      const postId = deps.ids.next();

      try {
        const post = await repo.createPost(postId, threadId, actorId, postBody, new Date(deps.clock.now()));
        return json(201, forumPostView(post));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 21. PATCH /v1/forum/posts/:postId
  router.patch(
    '/v1/forum/posts/:postId',
    doc({
      summary: 'Edit a forum post',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('postId', 'Post ID (UUID)')],
      responses: {
        200: ['ForumPostView', 'Post edited'],
        403: ['Error', 'Only post author can edit'],
        404: ['Error', 'Post not found'],
        409: ['Error', 'Post is deleted'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const postId = parseUuid(ctx.params['postId']!, 'postId');
      const body = strictObject(ctx.body, ['body']);
      const postBody = reqString(body, 'body');

      try {
        const post = await repo.editPost(postId, actorId, postBody, new Date(deps.clock.now()));
        return json(200, forumPostView(post));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // 22. DELETE /v1/forum/posts/:postId
  router.delete(
    '/v1/forum/posts/:postId',
    doc({
      summary: 'Delete a forum post (tombstone)',
      tags: ['community'],
      security: 'bearer',
      params: [pathParam('postId', 'Post ID (UUID)')],
      responses: {
        200: ['ForumPostView', 'Post tombstoned'],
        403: ['Error', 'Not authorized to delete post'],
        404: ['Error', 'Post not found'],
        409: ['Error', 'Post already deleted'],
        503: ['Error', 'Community service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkCommunityRepo();
      const actorId = requireAuth(ctx).userId;
      const postId = parseUuid(ctx.params['postId']!, 'postId');

      try {
        const post = await repo.deletePost(postId, actorId, new Date(deps.clock.now()));
        return json(200, forumPostView(post));
      } catch (err) {
        mapCommunityError(err);
      }
    },
  );

  // --- Achievements ---------------------------------------------------------
  function checkAchievementsRepo() {
    if (!deps.achievementsRepository) {
      throw HttpError.unavailable('achievements repository is not configured');
    }
    return deps.achievementsRepository;
  }

  // 1. GET /v1/achievements
  router.get(
    '/v1/achievements',
    doc({
      summary: 'List static achievement catalogue',
      tags: ['achievements'],
      responses: {
        200: ['AchievementDefinitionList', 'Public achievement definitions'],
        503: ['Error', 'Achievements service unavailable'],
      },
    }),
    PUBLIC,
    async () => {
      const repo = checkAchievementsRepo();
      const catalogue = repo.getCatalogue();
      return json(200, {
        items: catalogue
          .filter((def: import('@chess-platform/achievements').AchievementDefinition) => !def.hidden)
          .map(achievementDefinitionView),
      });
    },
  );

  // 2. GET /v1/players/:playerId/achievements
  router.get(
    '/v1/players/:playerId/achievements',
    doc({
      summary: 'List player achievements with progress',
      tags: ['achievements'],
      params: [pathParam('playerId', 'Player ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['PlayerAchievementList', 'Paginated player achievements'],
        404: ['Error', 'Player not found'],
        422: ['Error', 'Malformed pagination params'],
        503: ['Error', 'Achievements service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkAchievementsRepo();
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      await requirePlayerExists(playerId);

      try {
        const page = await repo.listPlayerAchievements(playerId, { limit, offset });
        return json(200, {
          total: page.total,
          items: page.items.map(playerAchievementView),
        });
      } catch (err) {
        mapAchievementError(err);
      }
    },
  );

  // 3. GET /v1/players/:playerId/achievements/summary
  router.get(
    '/v1/players/:playerId/achievements/summary',
    doc({
      summary: 'Get player achievement summary',
      tags: ['achievements'],
      params: [pathParam('playerId', 'Player ID (UUID)')],
      responses: {
        200: ['AchievementSummaryView', 'Player achievement summary'],
        404: ['Error', 'Player not found'],
        503: ['Error', 'Achievements service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkAchievementsRepo();
      const playerId = parseUuid(ctx.params['playerId']!, 'playerId');

      await requirePlayerExists(playerId);

      try {
        const summary = await repo.getSummary(playerId);
        return json(200, achievementSummaryView(summary));
      } catch (err) {
        mapAchievementError(err);
      }
    },
  );

  // --- Studies & PGN --------------------------------------------------------
  function checkStudiesRepo() {
    if (!deps.studiesRepository) {
      throw HttpError.unavailable('studies repository is not configured');
    }
    return deps.studiesRepository;
  }

  const studiesPositionReader = new CorePositionReader();

  // 1. POST /v1/studies
  router.post(
    '/v1/studies',
    doc({
      summary: 'Create a study',
      tags: ['studies'],
      security: 'bearer',
      responses: {
        201: ['StudyView', 'Study created successfully'],
        400: ['Error', 'Malformed request body'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const body = strictObject(ctx.body, ['id', 'name', 'description', 'visibility', 'variant']);
      const rawId = optString(body, 'id');
      const studyId = rawId !== undefined ? parseUuid(rawId, 'id') : deps.ids.next();
      const name = reqString(body, 'name');
      const description = optString(body, 'description') ?? '';
      const visibility = oneOf(reqString(body, 'visibility'), ['public', 'unlisted', 'private'] as const, 'visibility');
      const variant = parseVariant(optString(body, 'variant') ?? 'standard');

      try {
        const study = await repo.createStudy(
          studyId,
          actorId,
          name,
          description,
          visibility,
          undefined,
          { variant },
        );
        return json(201, studyView(study));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 2. GET /v1/studies
  router.get(
    '/v1/studies',
    doc({
      summary: 'List studies',
      tags: ['studies'],
      params: [
        limitParam(),
        offsetParam(),
        { name: 'search', in: 'query', required: false, schema: { type: 'string' }, description: 'Search term for name or description' },
        { name: 'ownerId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Filter by owner ID' },
      ],
      responses: {
        200: ['StudyPage', 'Page of studies'],
        404: ['Error', 'Owner not found'],
        422: ['Error', 'Malformed query parameter'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const search = ctx.query.get('search') ?? undefined;
      const rawOwnerId = ctx.query.get('ownerId') ?? undefined;

      let ownerId: string | undefined = undefined;
      if (rawOwnerId) {
        ownerId = parseUuid(rawOwnerId, 'ownerId');
        await requirePlayerExists(ownerId);
      }

      try {
        const page = await repo.listStudies(actorId, { limit, offset, search, ownerId });
        return json(200, { total: page.total, items: page.items.map(studyView) });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 3. GET /v1/studies/:id
  router.get(
    '/v1/studies/:id',
    doc({
      summary: 'Get study by ID',
      tags: ['studies'],
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['StudyView', 'Study details'],
        404: ['Error', 'Study not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      try {
        const study = await repo.getStudy(studyId, actorId);
        return json(200, studyView(study));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 4. PATCH /v1/studies/:id
  router.patch(
    '/v1/studies/:id',
    doc({
      summary: 'Update study',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['StudyView', 'Updated study details'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study not found'],
        409: ['Error', 'Study already deleted'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['name', 'description', 'visibility']);

      const name = optString(body, 'name');
      const description = optString(body, 'description');
      const rawVis = optString(body, 'visibility');
      const visibility = rawVis !== undefined ? oneOf(rawVis, ['public', 'unlisted', 'private'] as const, 'visibility') : undefined;

      try {
        const study = await repo.updateStudy(studyId, actorId, { name, description, visibility });
        return json(200, studyView(study));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 5. DELETE /v1/studies/:id
  router.delete(
    '/v1/studies/:id',
    doc({
      summary: 'Delete study',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['StudyView', 'Tombstoned study'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study not found'],
        409: ['Error', 'Study already deleted'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      try {
        const study = await repo.deleteStudy(studyId, actorId);
        return json(200, studyView(study));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 6. POST /v1/studies/:id/collaborators
  router.post(
    '/v1/studies/:id/collaborators',
    doc({
      summary: 'Add a collaborator',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        201: ['CollaboratorView', 'Collaborator added successfully'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or player not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['playerId', 'role']);

      const playerId = parseUuid(reqString(body, 'playerId'), 'playerId');
      await requirePlayerExists(playerId);

      const role = oneOf(reqString(body, 'role'), ['owner', 'contributor', 'viewer'] as const, 'role');

      try {
        const collaborator = await repo.addCollaborator(studyId, actorId, playerId, role);
        return json(201, collaboratorView(collaborator));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 7. GET /v1/studies/:id/collaborators
  router.get(
    '/v1/studies/:id/collaborators',
    doc({
      summary: 'List study collaborators',
      tags: ['studies'],
      params: [pathParam('id', 'Study ID (UUID)'), limitParam(), offsetParam()],
      responses: {
        200: ['CollaboratorPage', 'Page of collaborators'],
        404: ['Error', 'Study not found'],
        422: ['Error', 'Malformed ID or query parameter'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);

      try {
        const page = await repo.listCollaborators(studyId, actorId, { limit, offset });
        return json(200, { total: page.total, items: page.items.map(collaboratorView) });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 8. PATCH /v1/studies/:id/collaborators/:playerId
  router.patch(
    '/v1/studies/:id/collaborators/:playerId',
    doc({
      summary: 'Update collaborator role',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('playerId', 'Player ID (UUID)')],
      responses: {
        200: ['CollaboratorView', 'Updated collaborator'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or collaborator not found'],
        409: ['Error', 'Invalid role transition'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const targetPlayerId = parseUuid(ctx.params['playerId']!, 'playerId');

      await requirePlayerExists(targetPlayerId);

      const body = strictObject(ctx.body, ['role', 'newRole']);
      const rawRole = optString(body, 'role') ?? optString(body, 'newRole');
      if (!rawRole) {
        throw HttpError.validation('Role is required', { role: 'required' });
      }
      const newRole = oneOf(rawRole, ['owner', 'contributor', 'viewer'] as const, 'role');

      try {
        const collaborator = await repo.updateCollaboratorRole(studyId, actorId, targetPlayerId, newRole);
        return json(200, collaboratorView(collaborator));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 9. DELETE /v1/studies/:id/collaborators/:playerId
  router.delete(
    '/v1/studies/:id/collaborators/:playerId',
    doc({
      summary: 'Remove collaborator',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('playerId', 'Player ID (UUID)')],
      responses: {
        204: [undefined, 'Collaborator removed successfully'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or collaborator not found'],
        409: ['Error', 'Cannot remove owner'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const targetPlayerId = parseUuid(ctx.params['playerId']!, 'playerId');

      await requirePlayerExists(targetPlayerId);

      try {
        await repo.removeCollaborator(studyId, actorId, targetPlayerId);
        return noContent();
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 10. POST /v1/studies/:id/transfer-ownership
  router.post(
    '/v1/studies/:id/transfer-ownership',
    doc({
      summary: 'Transfer study ownership',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['StudyOwnershipTransferView', 'Ownership transferred successfully'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or target owner not found'],
        409: ['Error', 'Invalid transition'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['newOwnerId']);

      const newOwnerId = parseUuid(reqString(body, 'newOwnerId'), 'newOwnerId');
      await requirePlayerExists(newOwnerId);

      try {
        const res = await repo.transferOwnership(studyId, actorId, newOwnerId);
        return json(200, {
          oldOwner: collaboratorView(res.oldOwner),
          newOwner: collaboratorView(res.newOwner),
          study: studyView(res.study),
        });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 11. POST /v1/studies/:id/chapters
  router.post(
    '/v1/studies/:id/chapters',
    doc({
      summary: 'Create a chapter',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        201: ['ChapterView', 'Chapter created successfully'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      const body = strictObject(ctx.body, ['id', 'name', 'startingFen']);
      const rawId = optString(body, 'id');
      const chapterId = rawId !== undefined ? parseUuid(rawId, 'id') : deps.ids.next();
      const name = reqString(body, 'name');
      const startingFen = optString(body, 'startingFen');
      // Validate before it is stored, rather than on the first append. A chapter created with a
      // FEN this server cannot read is unusable from the moment it exists, and rejecting it here
      // is the difference between a 422 on the request that caused it and a 500 much later.
      // The study owns the rule set for every chapter, so validate the FEN under that persisted
      // variant before storing it. Parsing a Three-Check counter as standard shifts both clocks.
      //
      // `coreFenValidator` rather than a bare `parseFen`, because parsing only proves the string
      // decodes. It accepts an empty board and a position with no black king — shapes that are not
      // chess positions, would be persisted unchanged, and would accept moves. The shared
      // validator adds the structural allowlist and the king-count check, and is the same one the
      // analysis boundary uses, so studies do not grow a second opinion about what a position is.
      // Raised in the Qodo review of PR #140.
      if (startingFen !== undefined) {
        const study = await repo.getStudy(studyId, actorId).catch((err: unknown) => mapStudyError(err));
        try {
          coreFenValidator.validate(startingFen, study.variant);
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : 'unparseable';
          throw HttpError.validation(`startingFen is not a valid FEN: ${detail}`, {
            startingFen: 'invalid FEN',
          });
        }
      }

      try {
        const chapter = await repo.createChapter(chapterId, studyId, actorId, name, startingFen);
        return json(201, chapterView(chapter));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 12. GET /v1/studies/:id/chapters
  router.get(
    '/v1/studies/:id/chapters',
    doc({
      summary: 'List study chapters',
      tags: ['studies'],
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['ChapterList', 'List of active chapters'],
        404: ['Error', 'Study not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      try {
        const chapters = await repo.listChapters(studyId, actorId);
        return json(200, { items: chapters.map(chapterView) });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 13. GET /v1/studies/:id/chapters/:chapterId
  router.get(
    '/v1/studies/:id/chapters/:chapterId',
    doc({
      summary: 'Get chapter and move tree',
      tags: ['studies'],
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('chapterId', 'Chapter ID (UUID)')],
      responses: {
        200: ['ChapterDetailView', 'Chapter details with move tree'],
        404: ['Error', 'Study or chapter not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const chapterId = parseUuid(ctx.params['chapterId']!, 'chapterId');

      try {
        const detail = await repo.getChapter(chapterId, actorId);
        if (detail.chapter.studyId !== studyId) {
          throw HttpError.notFound(`Chapter '${chapterId}' not found in study '${studyId}'`);
        }
        return json(200, chapterDetailView(detail));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 14. PATCH /v1/studies/:id/chapters/:chapterId
  router.patch(
    '/v1/studies/:id/chapters/:chapterId',
    doc({
      summary: 'Update chapter',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('chapterId', 'Chapter ID (UUID)')],
      responses: {
        200: ['ChapterView', 'Updated chapter'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or chapter not found'],
        409: ['Error', 'Chapter already deleted'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const chapterId = parseUuid(ctx.params['chapterId']!, 'chapterId');

      const body = strictObject(ctx.body, ['name']);
      const name = optString(body, 'name');

      try {
        const chapter = await repo.updateChapter(chapterId, actorId, { name });
        if (chapter.studyId !== studyId) {
          throw HttpError.notFound(`Chapter '${chapterId}' not found in study '${studyId}'`);
        }
        return json(200, chapterView(chapter));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 15. DELETE /v1/studies/:id/chapters/:chapterId
  router.delete(
    '/v1/studies/:id/chapters/:chapterId',
    doc({
      summary: 'Delete chapter',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('chapterId', 'Chapter ID (UUID)')],
      responses: {
        200: ['ChapterView', 'Tombstoned chapter'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or chapter not found'],
        409: ['Error', 'Chapter already deleted'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const chapterId = parseUuid(ctx.params['chapterId']!, 'chapterId');

      try {
        const chapter = await repo.deleteChapter(chapterId, actorId);
        if (chapter.studyId !== studyId) {
          throw HttpError.notFound(`Chapter '${chapterId}' not found in study '${studyId}'`);
        }
        return json(200, chapterView(chapter));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 16. PUT /v1/studies/:id/chapters/reorder
  router.put(
    '/v1/studies/:id/chapters/reorder',
    doc({
      summary: 'Reorder chapters within a study',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['ChapterList', 'Reordered chapters list'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      const body = strictObject(ctx.body, ['chapterIds']);
      const rawIds = body['chapterIds'];
      if (!Array.isArray(rawIds)) {
        throw HttpError.validation('"chapterIds" must be an array', { chapterIds: 'invalid' });
      }
      const chapterIds = rawIds.map((cId) => parseUuid(String(cId), 'chapterId'));

      try {
        const chapters = await repo.reorderChapters(studyId, actorId, chapterIds);
        return json(200, { items: chapters.map(chapterView) });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 17. POST /v1/studies/:id/chapters/:chapterId/nodes
  router.post(
    '/v1/studies/:id/chapters/:chapterId/nodes',
    doc({
      summary: 'Append a move node to a chapter',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('chapterId', 'Chapter ID (UUID)')],
      responses: {
        201: ['TreeNodeView', 'Appended node'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study, chapter or parent node not found'],
        422: ['Error', 'Validation error or illegal move'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const chapterId = parseUuid(ctx.params['chapterId']!, 'chapterId');

      // `nodeId` is deliberately NOT accepted. The port lets an id be supplied so an import can
      // mint them in a batch, but taking one from a request would let a caller name a node that
      // already exists — which in the in-memory adapter is a `Map#set` straight over the top of
      // someone else's move. Server-generated means generated by the server.
      const body = strictObject(ctx.body, ['parentId', 'san', 'comment', 'nags']);
      const rawParentId = body['parentId'];
      const parentId = rawParentId !== null && rawParentId !== undefined
        ? parseUuid(String(rawParentId), 'parentId')
        : null;
      const san = reqString(body, 'san');
      const comment = optString(body, 'comment');
      const nags = parseNags(body['nags']);

      try {
        const node = await repo.appendNode(chapterId, actorId, parentId, san, studiesPositionReader, {
          comment,
          nags,
        });
        if (node.chapterId !== chapterId) {
          throw HttpError.notFound(`Chapter '${chapterId}' not found in study '${studyId}'`);
        }
        return json(201, treeNodeView(node));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 18. PATCH /v1/studies/:id/nodes/:nodeId
  router.patch(
    '/v1/studies/:id/nodes/:nodeId',
    doc({
      summary: 'Annotate a tree node',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('nodeId', 'Node ID (UUID)')],
      responses: {
        200: ['TreeNodeView', 'Annotated node'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or node not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      parseUuid(ctx.params['id']!, 'id');
      const nodeId = parseUuid(ctx.params['nodeId']!, 'nodeId');

      const body = strictObject(ctx.body, ['comment', 'nags']);
      const comment = optString(body, 'comment');
      const nags = parseNags(body['nags']);

      try {
        const node = await repo.annotateNode(nodeId, actorId, { comment, nags });
        return json(200, treeNodeView(node));
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 19. DELETE /v1/studies/:id/nodes/:nodeId
  router.delete(
    '/v1/studies/:id/nodes/:nodeId',
    doc({
      summary: 'Delete a tree node and its subtree',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)'), pathParam('nodeId', 'Node ID (UUID)')],
      responses: {
        204: [undefined, 'Node deleted successfully'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study or node not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      parseUuid(ctx.params['id']!, 'id');
      const nodeId = parseUuid(ctx.params['nodeId']!, 'nodeId');

      try {
        await repo.deleteNode(nodeId, actorId);
        return noContent();
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 20. POST /v1/studies/:id/import
  router.post(
    '/v1/studies/:id/import',
    doc({
      summary: 'Import PGN into study',
      tags: ['studies'],
      security: 'bearer',
      params: [pathParam('id', 'Study ID (UUID)')],
      responses: {
        200: ['ChapterList', 'Imported chapters'],
        403: ['Error', 'Insufficient permissions'],
        404: ['Error', 'Study not found'],
        413: ['Error', 'PGN payload exceeds maximum size limit'],
        422: ['Error', 'Validation error or invalid PGN/move'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = requireAuth(ctx).userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');

      const body = strictObject(ctx.body, ['pgn']);
      const pgnString = reqString(body, 'pgn');

      // NON-NEGOTIABLE: Enforce MAX_PGN_BYTES at the route before reaching parser!
      if (Buffer.byteLength(pgnString, 'utf8') > MAX_PGN_BYTES) {
        throw HttpError.payloadTooLarge(`PGN exceeds max limit of ${MAX_PGN_BYTES} bytes`);
      }

      try {
        const chapters = await repo.importPgn(studyId, actorId, pgnString, studiesPositionReader);
        return json(200, { items: chapters.map(chapterView) });
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // 21. GET /v1/studies/:id/export.pgn
  router.get(
    '/v1/studies/:id/export.pgn',
    doc({
      summary: 'Export study or chapter as PGN',
      tags: ['studies'],
      params: [
        pathParam('id', 'Study ID (UUID)'),
        { name: 'chapterId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Optional chapter ID' },
      ],
      responses: {
        200: ['PgnExport', 'Exported PGN text'],
        404: ['Error', 'Study or chapter not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Studies service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkStudiesRepo();
      const actorId = ctx.auth?.userId;
      const studyId = parseUuid(ctx.params['id']!, 'id');
      const rawChapterId = ctx.query.get('chapterId') ?? undefined;
      const chapterId = rawChapterId ? parseUuid(rawChapterId, 'chapterId') : undefined;

      try {
        const pgnText = await repo.exportPgn(studyId, actorId, chapterId);
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/x-chess-pgn; charset=utf-8',
            'Content-Disposition': `attachment; filename="study-${studyId}.pgn"`,
          },
          body: pgnText,
        };
      } catch (err) {
        mapStudyError(err);
      }
    },
  );

  // --- Learning & Courses ----------------------------------------------------
  function checkLearningRepo() {
    if (!deps.learningRepository) {
      throw HttpError.unavailable('learning repository is not configured');
    }
    return deps.learningRepository;
  }

  const learningPositionReader = new CorePositionReader();

  // 1. POST /v1/courses
  router.post(
    '/v1/courses',
    doc({
      summary: 'Create a course',
      tags: ['courses'],
      security: 'bearer',
      responses: {
        201: ['CourseView', 'Course created successfully'],
        400: ['Error', 'Malformed request body'],
        409: ['Error', 'Duplicate slug'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const body = strictObject(ctx.body, ['slug', 'title', 'description', 'difficulty', 'published']);
      const slug = reqString(body, 'slug');
      const title = reqString(body, 'title');
      const description = optString(body, 'description') ?? '';
      const difficulty = oneOf(reqString(body, 'difficulty'), ['beginner', 'intermediate', 'advanced'] as const, 'difficulty');
      const published = optBoolean(body, 'published', false);

      const courseId = deps.ids.next();

      try {
        const course = await repo.createCourse(courseId, actorId, slug, title, description, difficulty, published);
        return json(201, courseView(course));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 2. GET /v1/courses
  router.get(
    '/v1/courses',
    doc({
      summary: 'List courses',
      tags: ['courses'],
      params: [
        limitParam(),
        offsetParam(),
        { name: 'search', in: 'query', required: false, schema: { type: 'string' }, description: 'Search term for title or description' },
        { name: 'authorId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Filter by author ID' },
        { name: 'difficulty', in: 'query', required: false, schema: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] }, description: 'Filter by difficulty' },
      ],
      responses: {
        200: ['CoursePage', 'Page of courses'],
        404: ['Error', 'Author not found'],
        422: ['Error', 'Malformed query parameter'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const limit = parseLimit(ctx.query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = parseOffset(ctx.query);
      const search = ctx.query.get('search') ?? undefined;
      const rawAuthorId = ctx.query.get('authorId') ?? undefined;
      const authorId = rawAuthorId ? parseUuid(rawAuthorId, 'authorId') : undefined;
      if (authorId) {
        const user = await deps.repos.users.findById(authorId);
        if (!user) throw HttpError.notFound('author not found');
      }

      const rawDifficulty = ctx.query.get('difficulty') ?? undefined;
      const difficulty = rawDifficulty ? oneOf(rawDifficulty, ['beginner', 'intermediate', 'advanced'] as const, 'difficulty') : undefined;

      try {
        const page = await repo.listCourses(actorId, { limit, offset, search, authorId, difficulty });
        return json(200, {
          total: page.total,
          items: page.items.map(courseView),
        });
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 3. GET /v1/courses/slug/:slug
  router.get(
    '/v1/courses/slug/:slug',
    doc({
      summary: 'Get course by slug',
      tags: ['courses'],
      params: [{ name: 'slug', in: 'path', required: true, description: 'Course slug', schema: { type: 'string' } }],
      responses: {
        200: ['CourseView', 'Course details'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Invalid slug'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const slug = ctx.params['slug']!;

      try {
        const course = await repo.getCourseBySlug(slug, actorId);
        return json(200, courseView(course));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 4. GET /v1/courses/:id
  router.get(
    '/v1/courses/:id',
    doc({
      summary: 'Get course by ID',
      tags: ['courses'],
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseView', 'Course details'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const course = await repo.getCourse(courseId, actorId);
        return json(200, courseView(course));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 5. PATCH /v1/courses/:id
  router.patch(
    '/v1/courses/:id',
    doc({
      summary: 'Update course',
      tags: ['courses'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseView', 'Updated course'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        409: ['Error', 'Duplicate slug'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['slug', 'title', 'description', 'difficulty', 'published']);

      const slug = optString(body, 'slug');
      const title = optString(body, 'title');
      const description = optString(body, 'description');
      const rawDifficulty = optString(body, 'difficulty');
      const difficulty = rawDifficulty !== undefined ? oneOf(rawDifficulty, ['beginner', 'intermediate', 'advanced'] as const, 'difficulty') : undefined;
      const published = body['published'] !== undefined ? reqBoolean(body, 'published') : undefined;

      try {
        const updated = await repo.updateCourse(courseId, actorId, {
          ...(slug !== undefined ? { slug } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(difficulty !== undefined ? { difficulty } : {}),
          ...(published !== undefined ? { published } : {}),
        });
        return json(200, courseView(updated));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 6. DELETE /v1/courses/:id
  router.delete(
    '/v1/courses/:id',
    doc({
      summary: 'Delete course',
      tags: ['courses'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseView', 'Deleted course tombstone'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        409: ['Error', 'Already deleted'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const deleted = await repo.deleteCourse(courseId, actorId);
        return json(200, courseView(deleted));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 7. POST /v1/courses/:id/publish
  router.post(
    '/v1/courses/:id/publish',
    doc({
      summary: 'Publish course',
      tags: ['courses'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseView', 'Published course'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const updated = await repo.updateCourse(courseId, actorId, { published: true });
        return json(200, courseView(updated));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 8. POST /v1/courses/:id/unpublish
  router.post(
    '/v1/courses/:id/unpublish',
    doc({
      summary: 'Unpublish course',
      tags: ['courses'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseView', 'Unpublished course'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const updated = await repo.updateCourse(courseId, actorId, { published: false });
        return json(200, courseView(updated));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 9. POST /v1/courses/:id/lessons
  router.post(
    '/v1/courses/:id/lessons',
    doc({
      summary: 'Create a lesson in a course',
      tags: ['lessons'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        201: ['LessonView', 'Lesson created successfully'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['title']);
      const title = reqString(body, 'title');
      const lessonId = deps.ids.next();

      try {
        const lesson = await repo.createLesson(lessonId, courseId, actorId, title);
        return json(201, lessonView(lesson));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 10. GET /v1/courses/:id/lessons
  router.get(
    '/v1/courses/:id/lessons',
    doc({
      summary: 'List lessons in a course',
      tags: ['lessons'],
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['LessonList', 'List of lessons'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const lessons = await repo.listLessons(courseId, actorId);
        return json(200, lessons.map(lessonView));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 11. GET /v1/lessons/:id
  router.get(
    '/v1/lessons/:id',
    doc({
      summary: 'Get lesson by ID',
      tags: ['lessons'],
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        200: ['LessonView', 'Lesson details'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');

      try {
        const lesson = await repo.getLesson(lessonId, actorId);
        return json(200, lessonView(lesson));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 12. PATCH /v1/lessons/:id
  router.patch(
    '/v1/lessons/:id',
    doc({
      summary: 'Update lesson',
      tags: ['lessons'],
      security: 'bearer',
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        200: ['LessonView', 'Updated lesson'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['title']);
      const title = optString(body, 'title');

      try {
        const updated = await repo.updateLesson(lessonId, actorId, {
          ...(title !== undefined ? { title } : {}),
        });
        return json(200, lessonView(updated));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 13. POST /v1/courses/:id/lessons/reorder
  router.post(
    '/v1/courses/:id/lessons/reorder',
    doc({
      summary: 'Reorder lessons in a course',
      tags: ['lessons'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['LessonList', 'Reordered lessons list'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['lessonIds']);
      const rawIds = body['lessonIds'];
      if (!Array.isArray(rawIds)) {
        throw HttpError.validation('"lessonIds" must be an array of strings', { lessonIds: 'invalid' });
      }
      const lessonIds = rawIds.map((item, idx) => {
        if (typeof item !== 'string') throw HttpError.validation(`lessonIds[${idx}] must be a string`, { lessonIds: 'invalid' });
        return parseUuid(item, `lessonIds[${idx}]`);
      });

      try {
        const reordered = await repo.reorderLessons(courseId, actorId, lessonIds);
        return json(200, reordered.map(lessonView));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 14. DELETE /v1/lessons/:id
  router.delete(
    '/v1/lessons/:id',
    doc({
      summary: 'Delete lesson',
      tags: ['lessons'],
      security: 'bearer',
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        200: ['LessonView', 'Deleted lesson tombstone'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');

      try {
        const deleted = await repo.deleteLesson(lessonId, actorId);
        return json(200, lessonView(deleted));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 15. POST /v1/lessons/:id/steps
  router.post(
    '/v1/lessons/:id/steps',
    doc({
      summary: 'Create a step in a lesson',
      tags: ['steps'],
      security: 'bearer',
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        201: ['StepView', 'Step created successfully'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Validation or move legality error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, [
        'kind',
        'prose',
        'fen',
        'expectedSan',
        'hint',
        'question',
        'options',
        'correctIndex',
      ]);
      const kind = oneOf(reqString(body, 'kind'), ['text', 'move', 'quiz'] as const, 'kind');
      const stepId = deps.ids.next();

      try {
        if (kind === 'text') {
          const prose = reqString(body, 'prose');
          const step = await repo.createStep(stepId, lessonId, actorId, { kind: 'text', prose }, learningPositionReader);
          return json(201, stepView(step));
        } else if (kind === 'move') {
          const fen = reqString(body, 'fen');
          const expectedSan = reqString(body, 'expectedSan');
          const hint = optString(body, 'hint');
          const step = await repo.createStep(stepId, lessonId, actorId, { kind: 'move', fen, expectedSan, hint }, learningPositionReader);
          return json(201, stepView(step));
        } else {
          const question = reqString(body, 'question');
          const rawOpts = body['options'];
          if (!Array.isArray(rawOpts)) {
            throw HttpError.validation('"options" must be an array of strings', { options: 'invalid' });
          }
          const options = rawOpts.map((o, idx) => {
            if (typeof o !== 'string') throw HttpError.validation(`options[${idx}] must be a string`, { options: 'invalid' });
            return o;
          });
          const rawIdx = body['correctIndex'];
          if (typeof rawIdx !== 'number' || !Number.isInteger(rawIdx)) {
            throw HttpError.validation('"correctIndex" must be an integer', { correctIndex: 'invalid' });
          }
          const step = await repo.createStep(stepId, lessonId, actorId, { kind: 'quiz', question, options, correctIndex: rawIdx }, learningPositionReader);
          return json(201, stepView(step));
        }
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 16. GET /v1/lessons/:id/steps
  router.get(
    '/v1/lessons/:id/steps',
    doc({
      summary: 'List steps in a lesson',
      tags: ['steps'],
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        200: ['LearnerStepList', 'List of steps'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');

      try {
        // The course comes back from the read that already loaded it: `listSteps` resolves
        // lesson → course to enforce visibility either way, and re-resolving it here to find the
        // author doubled the query count on the route a lesson page calls (ADR-0095 §4).
        const { steps, course } = await repo.listStepsWithCourse(lessonId, actorId);
        const isAuthor = actorId !== undefined && course.authorId === actorId;
        return json(200, steps.map((s) => (isAuthor ? stepView(s) : learnerStepView(s))));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 17. GET /v1/steps/:id
  router.get(
    '/v1/steps/:id',
    doc({
      summary: 'Get step by ID',
      tags: ['steps'],
      params: [pathParam('id', 'Step ID (UUID)')],
      responses: {
        200: ['LearnerStepView', 'Step details'],
        404: ['Error', 'Step not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    PUBLIC,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = ctx.auth?.userId;
      const stepId = parseUuid(ctx.params['id']!, 'id');

      try {
        const { step, course } = await repo.getStepWithCourse(stepId, actorId);
        const isAuthor = actorId !== undefined && course.authorId === actorId;
        return json(200, isAuthor ? stepView(step) : learnerStepView(step));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 18. PATCH /v1/steps/:id
  router.patch(
    '/v1/steps/:id',
    doc({
      summary: 'Update step',
      tags: ['steps'],
      security: 'bearer',
      params: [pathParam('id', 'Step ID (UUID)')],
      responses: {
        200: ['StepView', 'Updated step'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Step not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const stepId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, [
        'prose',
        'fen',
        'expectedSan',
        'hint',
        'question',
        'options',
        'correctIndex',
      ]);

      const prose = optString(body, 'prose');
      const fen = optString(body, 'fen');
      const expectedSan = optString(body, 'expectedSan');
      const hint = optString(body, 'hint');
      const question = optString(body, 'question');

      let options: string[] | undefined = undefined;
      if (body['options'] !== undefined) {
        if (!Array.isArray(body['options'])) {
          throw HttpError.validation('"options" must be an array of strings', { options: 'invalid' });
        }
        options = (body['options'] as unknown[]).map((o, idx) => {
          if (typeof o !== 'string') throw HttpError.validation(`options[${idx}] must be a string`, { options: 'invalid' });
          return o;
        });
      }

      let correctIndex: number | undefined = undefined;
      if (body['correctIndex'] !== undefined) {
        const rawIdx = body['correctIndex'];
        if (typeof rawIdx !== 'number' || !Number.isInteger(rawIdx)) {
          throw HttpError.validation('"correctIndex" must be an integer', { correctIndex: 'invalid' });
        }
        correctIndex = rawIdx;
      }

      try {
        const updated = await repo.updateStep(
          stepId,
          actorId,
          {
            ...(prose !== undefined ? { prose } : {}),
            ...(fen !== undefined ? { fen } : {}),
            ...(expectedSan !== undefined ? { expectedSan } : {}),
            ...(hint !== undefined ? { hint } : {}),
            ...(question !== undefined ? { question } : {}),
            ...(options !== undefined ? { options } : {}),
            ...(correctIndex !== undefined ? { correctIndex } : {}),
          },
          learningPositionReader
        );
        return json(200, stepView(updated));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 19. POST /v1/lessons/:id/steps/reorder
  router.post(
    '/v1/lessons/:id/steps/reorder',
    doc({
      summary: 'Reorder steps in a lesson',
      tags: ['steps'],
      security: 'bearer',
      params: [pathParam('id', 'Lesson ID (UUID)')],
      responses: {
        200: ['StepList', 'Reordered steps list'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Lesson not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const lessonId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['stepIds']);
      const rawIds = body['stepIds'];
      if (!Array.isArray(rawIds)) {
        throw HttpError.validation('"stepIds" must be an array of strings', { stepIds: 'invalid' });
      }
      const stepIds = rawIds.map((item, idx) => {
        if (typeof item !== 'string') throw HttpError.validation(`stepIds[${idx}] must be a string`, { stepIds: 'invalid' });
        return parseUuid(item, `stepIds[${idx}]`);
      });

      try {
        const reordered = await repo.reorderSteps(lessonId, actorId, stepIds);
        return json(200, reordered.map(stepView));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 20. DELETE /v1/steps/:id
  router.delete(
    '/v1/steps/:id',
    doc({
      summary: 'Delete step',
      tags: ['steps'],
      security: 'bearer',
      params: [pathParam('id', 'Step ID (UUID)')],
      responses: {
        200: ['StepView', 'Deleted step tombstone'],
        403: ['Error', 'Not authorized'],
        404: ['Error', 'Step not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const actorId = requireAuth(ctx).userId;
      const stepId = parseUuid(ctx.params['id']!, 'id');

      try {
        const deleted = await repo.deleteStep(stepId, actorId);
        return json(200, stepView(deleted));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 21. POST /v1/steps/:id/attempt
  router.post(
    '/v1/steps/:id/attempt',
    doc({
      summary: 'Submit a step attempt',
      tags: ['progress'],
      security: 'bearer',
      params: [pathParam('id', 'Step ID (UUID)')],
      responses: {
        200: ['AttemptResultView', 'Attempt evaluated successfully'],
        404: ['Error', 'Step not found'],
        422: ['Error', 'Validation error'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const playerId = requireAuth(ctx).userId;
      const stepId = parseUuid(ctx.params['id']!, 'id');
      const body = strictObject(ctx.body, ['san', 'selectedIndex']);

      const san = optString(body, 'san');
      let selectedIndex: number | undefined = undefined;
      if (body['selectedIndex'] !== undefined) {
        const rawIdx = body['selectedIndex'];
        if (typeof rawIdx !== 'number' || !Number.isInteger(rawIdx)) {
          throw HttpError.validation('"selectedIndex" must be an integer', { selectedIndex: 'invalid' });
        }
        selectedIndex = rawIdx;
      }

      try {
        const result = await repo.submitAttempt(playerId, stepId, {
          ...(san !== undefined ? { san } : {}),
          ...(selectedIndex !== undefined ? { selectedIndex } : {}),
        });
        return json(200, attemptResultView(result));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 22. GET /v1/courses/:id/progress
  router.get(
    '/v1/courses/:id/progress',
    doc({
      summary: 'Read own course progress summary',
      tags: ['progress'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['CourseProgressSummaryView', 'Course progress summary'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const playerId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const summary = await repo.getProgressSummary(playerId, courseId);
        return json(200, courseProgressSummaryView(summary));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // 23. GET /v1/courses/:id/progress/details
  router.get(
    '/v1/courses/:id/progress/details',
    doc({
      summary: 'List own step progress rows for a course',
      tags: ['progress'],
      security: 'bearer',
      params: [pathParam('id', 'Course ID (UUID)')],
      responses: {
        200: ['ProgressList', 'List of step progress rows'],
        404: ['Error', 'Course not found'],
        422: ['Error', 'Malformed ID'],
        503: ['Error', 'Learning service unavailable'],
      },
    }),
    AUTHED,
    async (ctx) => {
      const repo = checkLearningRepo();
      const playerId = requireAuth(ctx).userId;
      const courseId = parseUuid(ctx.params['id']!, 'id');

      try {
        const list = await repo.listProgress(playerId, courseId);
        return json(200, list.map(progressView));
      } catch (err) {
        mapLearningError(err);
      }
    },
  );

  // --- GraphQL read layer ----------------------------------------------------
  // One endpoint for the nested reads REST answers badly: a player with their followers, teams,
  // achievements and studies in a single round trip. Read-only — every write stays on the REST
  // routes above, where each one has its own authorization review. See ADR-0073.
  const graphqlHandler = deps.graphql
    ? createGraphQLHandler({
        users: deps.repos.users,
        repos: {
          ...(deps.socialGraphRepository ? { social: deps.socialGraphRepository } : {}),
          ...(deps.communityRepository ? { community: deps.communityRepository } : {}),
          ...(deps.studiesRepository ? { studies: deps.studiesRepository } : {}),
          ...(deps.learningRepository ? { learning: deps.learningRepository } : {}),
          ...(deps.achievementsRepository ? { achievements: deps.achievementsRepository } : {}),
          ...(deps.searchRepository ? { search: deps.searchRepository } : {}),
        },
        options: deps.graphql,
      })
    : undefined;

  router.post(
    '/v1/graphql',
    doc({
      summary: 'Execute a read-only GraphQL query',
      tags: ['graphql'],
      requestSchema: 'GraphQLRequest',
      responses: {
        200: [undefined, 'Query result, with per-field errors when a field could not be resolved'],
        400: ['Error', 'Malformed query, or a depth/complexity/alias limit was exceeded'],
        503: ['Error', 'GraphQL endpoint is not enabled'],
      },
    }),
    // Anonymous callers are allowed: the schema exposes public data, and every resolver passes the
    // actor (null included) to a repository that already knows what an anonymous caller may see.
    PUBLIC,
    async (ctx) => {
      if (!graphqlHandler) {
        throw HttpError.unavailable('graphql endpoint is not enabled');
      }
      return graphqlHandler(ctx);
    },
  );

  return router;

}

// --- helpers ---------------------------------------------------------------

function parseOffset(query: URLSearchParams): number {
  const raw = query.get('offset');
  if (raw === null) return 0;
  if (raw.trim() === '') {
    throw HttpError.validation('"offset" must be a non-negative integer', { offset: 'invalid' });
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw HttpError.validation('"offset" must be a non-negative integer', { offset: 'invalid' });
  }
  return n;
}

/** The NAG range the PGN standard defines: `$0` through `$255`. */
const MAX_NAG = 255;

/**
 * Parses the `nags` array from a request body.
 *
 * `Array.map(Number)` is not parsing. It turns `"abc"` into `NaN`, `[]` into `0`, and `1e400` into
 * `Infinity`, and every one of those reaches an `INTEGER[]` column and comes back as an opaque
 * driver error — a 500 for input the caller could have been told about. NAGs are a closed set of
 * small integers, so the check is cheap and the rejection is specific.
 */
function parseNags(raw: unknown): readonly number[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw HttpError.validation('"nags" must be an array of integers', { nags: 'invalid' });
  }
  return raw.map((entry) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > MAX_NAG) {
      throw HttpError.validation(`"nags" entries must be integers between 0 and ${MAX_NAG}`, {
        nags: 'invalid',
      });
    }
    return entry;
  });
}

function mapStudyError(err: unknown): never {
  // A study can already hold a starting FEN this server will not parse — one stored before the
  // codec learned to refuse Three-Check counters read without their variant, for instance. Left
  // unmapped that surfaces as a 500 on every later append, which reads as "the server is broken"
  // about a chapter whose data is simply unusable. Raised in the Qodo review of PR #140.
  if (err instanceof FenError) {
    // "position", not "chapter position": this mapper is shared by every study route, including
    // PGN import, where naming a chapter would be wrong. Raised in the CodeRabbit review of PR #140.
    throw HttpError.validation(`position is not a valid FEN: ${err.message}`);
  }
  if (err instanceof StudyRuleError) {
    switch (err.code) {
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'not_authorized':
        throw HttpError.forbidden(err.message);
      case 'invalid_input':
        throw HttpError.validation(err.message);
      case 'invalid_transition':
        throw HttpError.conflict(err.message);
      case 'invalid_move':
        throw HttpError.validation(err.message);
      case 'too_large':
        throw HttpError.payloadTooLarge(err.message);
    }
  }
  throw err;
}

function mapSocialError(err: unknown): never {
  if (err instanceof SocialRuleError) {
    switch (err.code) {
      case 'self_relation':
        throw HttpError.validation(err.message, { actor: 'self_relation' });
      case 'blocked':
        throw HttpError.forbidden(err.message);
      case 'already_exists':
        throw HttpError.conflict(err.message);
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'invalid_transition':
        throw HttpError.conflict(err.message);
      case 'not_authorized':
        throw HttpError.forbidden(err.message);
    }
  }
  throw err;
}

function mapMessagingError(err: unknown): never {
  if (err instanceof MessagingRuleError) {
    switch (err.code) {
      case 'self_conversation':
        throw HttpError.validation(err.message, { actor: 'self_conversation' });
      case 'blocked':
        throw HttpError.forbidden(err.message);
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'not_authorized':
        throw HttpError.forbidden(err.message);
      case 'invalid_body':
        throw HttpError.validation(err.message, { body: 'invalid' });
      case 'invalid_transition':
        throw HttpError.conflict(err.message);
    }
  }
  throw err;
}

function mapCommunityError(err: unknown): never {
  if (err instanceof CommunityRuleError) {
    switch (err.code) {
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'not_authorized':
        throw HttpError.forbidden(err.message);
      case 'invalid_slug':
        throw HttpError.validation(err.message, { slug: 'invalid' });
      case 'slug_taken':
        throw HttpError.conflict(err.message);
      case 'invalid_input':
        throw HttpError.validation(err.message);
      case 'already_member':
        throw HttpError.conflict(err.message);
      case 'already_requested':
        throw HttpError.conflict(err.message);
      case 'cannot_leave_as_owner':
        throw HttpError.conflict(err.message);
      case 'invalid_role_transition':
        throw HttpError.forbidden(err.message);
      case 'invalid_transition':
        throw HttpError.conflict(err.message);
    }
  }
  throw err;
}

function mapAchievementError(err: unknown): never {
  if (err instanceof AchievementRuleError) {
    switch (err.code) {
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'unknown_achievement':
      case 'invalid_progress':
        throw HttpError.validation(err.message);
    }
  }
  throw err;
}

function mapLearningError(err: unknown): never {
  if (err instanceof LearningRuleError) {
    switch (err.code) {
      case 'not_found':
        throw HttpError.notFound(err.message);
      case 'not_authorized':
        throw HttpError.forbidden(err.message);
      case 'invalid_input':
        throw HttpError.validation(err.message);
      case 'invalid_transition':
        throw HttpError.conflict(err.message);
      case 'duplicate_slug':
        throw HttpError.conflict(err.message);
      case 'invalid_move':
        throw HttpError.validation(err.message);
    }
  }
  throw err;
}



/**
 * Resolve the refresh token from the request, preferring the httpOnly cookie
 * over the JSON body. This keeps browser clients (cookie) and non-browser API
 * clients (body) both working.
 */
function resolveRefreshToken(ctx: RequestContext): string | undefined {
  const cookies = parseCookies(headerString(ctx.headers['cookie']));
  const fromCookie = cookies[REFRESH_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  // Fall back to the JSON body for non-browser API clients.
  if (ctx.body !== undefined && typeof ctx.body === 'object') {
    const body = ctx.body as Record<string, unknown>;
    const raw = body['refreshToken'];
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

/** Safely extract a single string from a header that may be a string or array. */
function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function meta(ctx: RequestContext): RequestMeta {
  const traceId = ctx.headers['x-trace-id'];
  return {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    traceId: typeof traceId === 'string' ? traceId : null,
  };
}

function requireAuth(ctx: RequestContext): NonNullable<RequestContext['auth']> {
  if (!ctx.auth) throw HttpError.unauthorized();
  return ctx.auth;
}

async function findUserByHandle(repos: Repositories, handle: string) {
  const user = await repos.users.findByHandle(handle);
  if (!user) throw HttpError.notFound('user not found');
  return user;
}

async function allRatings(repos: Repositories, userId: string): Promise<RatingRow[]> {
  const rows = await Promise.all(VARIANTS.map((v: Variant) => repos.ratings.get(userId, v)));
  return rows.filter((r): r is RatingRow => r !== null);
}

interface DocSpec {
  summary: string;
  tags: string[];
  description?: string;
  security?: 'bearer';
  requestSchema?: string;
  requestBodyRequired?: boolean;
  params?: RouteDoc['params'];
  responses: Record<number, [string | undefined, string, RouteDoc['responses'][number]['headers']?]>;
}

function doc(spec: DocSpec): RouteDoc {
  const responses: Record<number, RouteDoc['responses'][number]> = {};
  for (const [status, [schema, description, headers]] of Object.entries(spec.responses)) {
    responses[Number(status)] = {
      description,
      ...(schema ? { schema } : {}),
      ...(headers ? { headers } : {}),
    };
  }
  return {
    summary: spec.summary,
    tags: spec.tags,
    security: spec.security ?? 'none',
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.requestSchema ? { requestSchema: spec.requestSchema } : {}),
    ...(spec.requestBodyRequired !== undefined ? { requestBodyRequired: spec.requestBodyRequired } : {}),
    ...(spec.params ? { params: spec.params } : {}),
    responses,
  };
}

function pathParam(name: string, description: string): NonNullable<RouteDoc['params']>[number] {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function headerParam(
  name: string,
  description: string,
  schema: NonNullable<RouteDoc['params']>[number]['schema'],
): NonNullable<RouteDoc['params']>[number] {
  return { name, in: 'header', required: true, description, schema };
}

function studyPartnerIdempotencyKey(ctx: RequestContext): string {
  const value = ctx.headers['idempotency-key'];
  if (typeof value !== 'string' || !new RegExp(STUDY_PARTNER_IDEMPOTENCY_KEY_PATTERN).test(value)) {
    throw HttpError.validation('Idempotency-Key header is required and malformed', {
      idempotencyKey: 'use 1 to 128 letters, digits, dots, underscores, colons, or hyphens',
    });
  }
  return value;
}

function statusParam(): NonNullable<RouteDoc['params']>[number] {
  return {
    name: 'status',
    in: 'query',
    required: false,
    description: 'Filter by join request status.',
    schema: { type: 'string', enum: ['pending', 'accepted', 'declined', 'cancelled'] },
  };
}

function limitParam(): NonNullable<RouteDoc['params']>[number] {
  return {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Maximum number of results.',
    schema: { type: 'integer', minimum: 1 },
  };
}

function offsetParam(): NonNullable<RouteDoc['params']>[number] {
  return {
    name: 'offset',
    in: 'query',
    required: false,
    description: 'Number of results to skip.',
    schema: { type: 'integer', minimum: 0, default: 0 },
  };
}

/** The `q`/`limit`/`offset` parsing every `/v1/search` mode shares, so no mode can drift from it. */
function parseSearchParams(search: URLSearchParams): {
  q: string;
  query: SearchQuery;
  limit: number;
  offset: number;
} {
  const q = search.get('q');
  if (q === null || q.trim() === '') {
    throw HttpError.validation('"q" is required', { q: 'required' });
  }
  return {
    q,
    query: parseNaturalQuery(q),
    limit: parseLimit(search, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
    offset: parseOffset(search),
  };
}

function parseSearchMode(query: URLSearchParams): 'keyword' | 'semantic' | 'hybrid' {
  const raw = query.get('mode');
  if (raw === null || raw.trim() === '') return 'keyword';
  if (raw === 'keyword' || raw === 'semantic' || raw === 'hybrid') {
    return raw;
  }
  throw HttpError.validation('"mode" must be one of keyword, semantic, hybrid', { mode: 'invalid' });
}

