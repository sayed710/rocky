/**
 * Typed API layer — the frontend's single entry point to the M4 REST contract.
 *
 * {@link GambitClient} composes the transport-level {@link HttpClient} with the
 * {@link SessionManager}. It:
 *   - exposes small, typed resource groups (`auth`, `users`, `games`) plus
 *     top-level `health()` / `leaderboard()`;
 *   - injects the bearer token on authenticated calls (refreshing proactively
 *     when the access token is near expiry);
 *   - recovers from a server-side 401 by refreshing once and replaying the
 *     request a single time, then surfacing the original error if that fails.
 *
 * M12 inc 2: refresh and logout now rely on the httpOnly refresh cookie
 * (`credentials: 'include'`) instead of putting the refresh token in the
 * request body. The access token stays in memory only. Login and register
 * also send `credentials: 'include'` so the browser accepts the Set-Cookie.
 * Non-browser API clients can still send the refresh token in the body
 * (the API accepts both).
 *
 * It is framework-independent and deliberately excludes lobby/matchmaking
 * (seeks) and live game streaming (WebSocket), which land in later increments.
 */
import { FetchTransport } from '../ports/http.js';
import type { HttpTransport } from '../ports/http.js';
import { HttpClient } from '../net/http-client.js';
import type { RequestSpec } from '../net/http-client.js';
import { UnauthorizedError } from '../net/errors.js';
import { isTransientRefreshFailure, NoSessionError, SessionManager } from '../net/session.js';
import type { TokenStore } from '../net/session.js';
import { DEFAULT_RETRY_POLICY } from '../net/retry.js';
import { SocialApi } from './social.js';
import { GraphQLApi } from './graphql.js';
import { AnalysisApi } from './analysis.js';
import { StudyPartnerApi } from './study-partner.js';
import type { RetryPolicy } from '../net/retry.js';
import type {
  AuthResponse,
  BotLevel,
  CreateBotGameRequest,
  CreateSeekRequest,
  GameSummary,
  Health,
  CapabilitiesResponse,
  LeaderboardEntry,
  LoginRequest,
  PasswordResetRequest,
  PasswordResetConfirmRequest,
  ConversationList,
  ConversationReadState,
  ConversationView,
  EmailVerifyRequest,
  MessageList,
  MessageView,
  RatingView,
  RegisterRequest,
  SeekView,
  SearchMode,
  SearchResults,
  SelfUser,
  SessionView,
  TournamentDetail,
  TournamentLive,
  TournamentRound,
  TournamentGameCommentary,
  TournamentRoundRecap,
  TournamentStanding,
  TournamentSummary,
  UserProfile,
  Variant,
  TeamList,
  TeamMemberList,
  TeamMembership,
  TeamView,
  TeamDetailView,
  JoinRequestList,
  JoinRequestView,
  ForumThread,
  ForumThreadList,
  ForumPost,
  ForumPostList,
  ForumThreadCreated,
  AchievementSummary,
  PlayerAchievementList,
  CourseDifficulty,
  CourseList,
  CourseView,
  LessonView,
  StepView,
  CourseProgressSummaryView,
  ProgressView,
  AttemptResultView,
  SubmitAttemptRequest,
  ChapterDetailView,
  ChapterList,
  ChapterView,
  CollaboratorList,
  StudyList,
  StudyView,
  TreeNodeView,
  PasskeyView,
  WebAuthnRegisterOptions,
  WebAuthnRegisterVerifyRequest,
  WebAuthnLoginOptionsRequest,
  WebAuthnLoginOptions,
  WebAuthnLoginVerifyRequest,
  MoveExplanationRequest,
  MoveExplanationResponse,
  MistakePredictionRequest,
  MistakePredictionResponse,
  GameReviewResponse,
} from './models.js';

/** A request spec plus whether it requires authentication. */
export type ExecSpec = RequestSpec & { readonly auth?: boolean | 'optional' };

/** The bound request executor handed to resource groups. */
export type Execute = <T>(spec: ExecSpec) => Promise<T>;

/** Serialize operations that can replace or clear the browser's shared refresh cookie. */
export interface AuthCookieCoordinator {
  run<T>(operation: (cookieOrder: number) => Promise<T>): Promise<T>;
}

const AUTH_COOKIE_LOCK_NAME = 'rookzen-auth-cookie';
const AUTH_COOKIE_ORDER_KEY = 'rookzen-auth-cookie-order';

class BrowserAuthCookieCoordinator implements AuthCookieCoordinator {
  private fallbackTail: Promise<void> = Promise.resolve();
  private fallbackOrder = 0;

  private nextOrder(): number {
    try {
      if (typeof window !== 'undefined') {
        const current = Number.parseInt(window.localStorage.getItem(AUTH_COOKIE_ORDER_KEY) ?? '0', 10);
        const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
        if (!Number.isSafeInteger(next)) throw new Error('auth cookie order exhausted');
        window.localStorage.setItem(AUTH_COOKIE_ORDER_KEY, String(next));
        return next;
      }
    } catch {
      // Restricted storage falls back to process-local ordering below.
    }
    this.fallbackOrder += 1;
    return this.fallbackOrder;
  }

  async run<T>(operation: (cookieOrder: number) => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(AUTH_COOKIE_LOCK_NAME, () => operation(this.nextOrder()));
    }

    // Tests, SSR, and older single-realm clients still need deterministic sequencing.
    const previous = this.fallbackTail;
    let release!: () => void;
    this.fallbackTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation(this.nextOrder());
    } finally {
      release();
    }
  }
}

const DEFAULT_AUTH_COOKIE_COORDINATOR = new BrowserAuthCookieCoordinator();

export interface GambitClientOptions {
  /** API origin, e.g. `https://api.gambit.example`. Empty string = same-origin. */
  readonly baseUrl: string;
  readonly transport?: HttpTransport;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly tokenStore?: TokenStore;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly rng?: () => number;
  /** Override the browser-wide refresh-cookie coordinator, primarily for deterministic tests. */
  readonly authCookieCoordinator?: AuthCookieCoordinator;
}

export class GambitClient {
  readonly session: SessionManager;
  readonly auth: AuthApi;
  readonly users: UsersApi;
  readonly games: GamesApi;
  readonly seeks: SeeksApi;
  readonly tournaments: TournamentsApi;
  readonly search: SearchApi;
  readonly messages: MessagesApi;
  readonly social: SocialApi;
  readonly teams: TeamsApi;
  readonly achievements: AchievementsApi;
  readonly learning: LearningApi;
  readonly studies: StudiesApi;
  readonly analysis: AnalysisApi;
  readonly studyPartner: StudyPartnerApi;
  /** The read layer (ADR-0073). Degrades to null answers when the flag is off. */
  readonly graphql: GraphQLApi;
  private readonly http: HttpClient;

  constructor(options: GambitClientOptions) {
    const authCookieCoordinator = options.authCookieCoordinator ?? DEFAULT_AUTH_COOKIE_COORDINATOR;
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      transport: options.transport ?? new FetchTransport(),
      retry: options.retry ?? DEFAULT_RETRY_POLICY,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.rng ? { rng: options.rng } : {}),
    });

    this.session = new SessionManager({
      // M12 inc 2: refresh relies on the httpOnly cookie (credentials: 'include').
      // The refresh token is NOT sent in the body for the browser flow.
      refresh: (_refreshToken, expectedGeneration) =>
        authCookieCoordinator.run(async (cookieOrder) => {
          if (expectedGeneration !== undefined) this.session.assertGeneration(expectedGeneration);
          const auth = await this.http.request<AuthResponse>({
            method: 'POST',
            path: '/v1/auth/refresh',
            credentials: 'include',
          });
          return { auth, cookieOrder };
        }),
      ...(options.tokenStore ? { store: options.tokenStore } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    this.auth = new AuthApi(this.execute, this.session, authCookieCoordinator);
    this.users = new UsersApi(this.execute);
    this.games = new GamesApi(this.execute);
    this.seeks = new SeeksApi(this.execute);
    this.tournaments = new TournamentsApi(this.execute);
    this.search = new SearchApi(this.execute);
    this.messages = new MessagesApi(this.execute);
    this.social = new SocialApi(this.execute);
    this.teams = new TeamsApi(this.execute);
    this.achievements = new AchievementsApi(this.execute);
    this.learning = new LearningApi(this.execute);
    this.studies = new StudiesApi(this.execute, options.baseUrl);
    this.analysis = new AnalysisApi(this.execute);
    this.studyPartner = new StudyPartnerApi(this.execute);
    this.graphql = new GraphQLApi(this.execute);
  }

  health(): Promise<Health> {
    return this.execute<Health>({ method: 'GET', path: '/v1/health' });
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.execute<CapabilitiesResponse>({ method: 'GET', path: '/v1/capabilities' });
  }

  leaderboard(variant: Variant, opts: { limit?: number } = {}): Promise<LeaderboardEntry[]> {
    return this.execute<LeaderboardEntry[]>({
      method: 'GET',
      path: `/v1/leaderboard/${encodeURIComponent(variant)}`,
      ...(opts.limit !== undefined ? { query: { limit: opts.limit } } : {}),
    });
  }

  explainMove(body: MoveExplanationRequest, signal?: AbortSignal): Promise<MoveExplanationResponse> {
    return this.analysis.explainMove(body, signal);
  }

  predictMistake(body: MistakePredictionRequest, signal?: AbortSignal): Promise<MistakePredictionResponse> {
    return this.analysis.predictMistake(body, signal);
  }

  /**
   * Execute a request, injecting auth when required and recovering from a
   * server-side 401 with a single refresh-and-replay.
   */
  private execute = async <T>(spec: ExecSpec, retried = false): Promise<T> => {
    const { auth = false, ...rest } = spec;
    const headers: Record<string, string> = { ...spec.headers };

    if (auth) {
      // A transient refresh failure rejects here even for optional auth: sending the request
      // anonymously would silently drop identity-dependent data (e.g. private studies) while the
      // user still appears signed in.
      const token = await this.session.validAccessToken();
      if (token === undefined) {
        if (auth === true) {
          throw new UnauthorizedError({
            status: 401,
            code: 'unauthenticated',
            message: 'no active session',
            retryable: false,
          });
        }
      } else {
        headers['authorization'] = `Bearer ${token}`;
      }
    }

    try {
      return await this.http.request<T>({ ...rest, headers });
    } catch (error) {
      if (auth && !retried && error instanceof UnauthorizedError && headers['authorization']) {
        try {
          await this.session.refreshNow();
        } catch (refreshError) {
          // A transient refresh failure kept the session; report the outage, not a sign-out 401.
          throw isTransientRefreshFailure(refreshError) ? refreshError : error;
        }
        return this.execute<T>(spec, true);
      }
      throw error;
    }
  };
}

export class AuthApi {
  private readonly execute: Execute;
  private readonly session: SessionManager;
  private readonly cookieCoordinator: AuthCookieCoordinator;
  constructor(execute: Execute, session: SessionManager, cookieCoordinator: AuthCookieCoordinator) {
    this.execute = execute;
    this.session = session;
    this.cookieCoordinator = cookieCoordinator;
  }

  /** Adopt an auth response, revoking its server session if a newer local transition won the race. */
  private async adoptOrRevokeStale(
    auth: AuthResponse,
    expectedGeneration: number,
    cookieOrder: number,
  ): Promise<void> {
    try {
      this.session.adopt(auth, true, expectedGeneration, cookieOrder);
    } catch (error) {
      if (error instanceof NoSessionError) {
        await this.revokeStaleAuth(auth);
      }
      throw error;
    }
  }

  /** Best-effort cleanup for credentials created by an obsolete authentication response. */
  private async revokeStaleAuth(auth: AuthResponse): Promise<void> {
    try {
      await this.execute<void>({
        method: 'POST',
        path: '/v1/auth/logout',
        headers: { authorization: `Bearer ${auth.tokens.accessToken}` },
        ...(auth.tokens.refreshToken
          ? { body: { refreshToken: auth.tokens.refreshToken } }
          : {}),
        // Cookie-changing auth requests are serialized, so this is still the obsolete cookie.
        credentials: 'include',
      });
    } catch {
      // The stale result must stay rejected even when its server-side cleanup is unavailable.
    }
  }

  /**
   * Register a new account and adopt the returned session locally.
   *
   * Sends `credentials: 'include'` so the browser accepts the `Set-Cookie`
   * response header for the httpOnly refresh cookie. The access token is stored
   * in-memory only via `SessionManager.adopt()` — never in `localStorage`.
   */
  async register(
    body: RegisterRequest,
    expectedGeneration = this.session.captureGeneration(),
  ): Promise<AuthResponse> {
    return this.cookieCoordinator.run(async (cookieOrder) => {
      this.session.assertGeneration(expectedGeneration);
      // M12 inc 2: send credentials so the browser accepts the Set-Cookie.
      const auth = await this.execute<AuthResponse>({
        method: 'POST',
        path: '/v1/auth/register',
        body,
        credentials: 'include',
      });
      await this.adoptOrRevokeStale(auth, expectedGeneration, cookieOrder);
      return auth;
    });
  }

  /**
   * Authenticate with handle and password and adopt the returned session locally.
   *
   * Sends `credentials: 'include'` so the browser accepts the `Set-Cookie`
   * response header for the httpOnly refresh cookie. The access token is stored
   * in-memory only via `SessionManager.adopt()` — never in `localStorage`.
   */
  async login(
    body: LoginRequest,
    expectedGeneration = this.session.captureGeneration(),
  ): Promise<AuthResponse> {
    return this.cookieCoordinator.run(async (cookieOrder) => {
      this.session.assertGeneration(expectedGeneration);
      // M12 inc 2: send credentials so the browser accepts the Set-Cookie.
      const auth = await this.execute<AuthResponse>({
        method: 'POST',
        path: '/v1/auth/login',
        body,
        credentials: 'include',
      });
      await this.adoptOrRevokeStale(auth, expectedGeneration, cookieOrder);
      return auth;
    });
  }

  /**
   * Force a token refresh now and return the fresh auth state.
   *
   * M12 inc 2: this is the reload-restore path — it must work when there is NO
   * in-memory session yet, using only the httpOnly refresh cookie. It therefore
   * uses `session.restore()` to send the cookie and guard adoption against
   * concurrent session changes. The session-based `refreshNow()`
   * remains the single-flight path used by 401-recovery, where a session exists.
   */
  async refresh(): Promise<AuthResponse> {
    return this.session.restore();
  }

  /**
   * Revoke the current refresh token server-side and clear the local session.
   *
   * M12 inc 2: sends `credentials: 'include'` so the httpOnly refresh cookie
   * is sent to the server. No refresh token in the body.
   */
  async logout(): Promise<void> {
    if (!this.session.isAuthenticated) return;
    // A required proactive refresh is itself a session transition. Complete it before capturing
    // the generation that this logout is allowed to clear.
    const loggingOut = this.session.current?.tokens.accessToken;
    let token: string | undefined;
    try {
      // An explicit sign-out makes one real refresh attempt even during a backoff, so a recovered
      // server can still revoke the refresh session. If the server stays unreachable only the
      // local session can be cleared.
      token = await this.session.validAccessToken(true);
    } catch (error) {
      // A failed refresh is only an invalidation internally, but the user's explicit action is a
      // durable logout boundary and must still converge across tabs — unless a newer login or peer
      // adoption replaced the session while the refresh was in flight.
      const current = this.session.current;
      if (!current || current.tokens.accessToken === loggingOut) this.session.reset();
      throw error;
    }
    if (token === undefined) {
      this.session.reset();
      return;
    }
    const expectedGeneration = this.session.captureGeneration();
    await this.cookieCoordinator.run(async () => {
      this.session.assertGeneration(expectedGeneration);
      const currentToken = this.session.current?.tokens.accessToken;
      if (!currentToken) throw new NoSessionError();
      // Publish the durable barrier before starting the request. This rejects a delayed peer
      // adoption from an auth operation that completed before this lock was acquired, while a
      // genuinely newer local transition can still supersede the logout after it starts.
      if (!this.session.resetIfGeneration(expectedGeneration)) throw new NoSessionError();
      await this.execute<void>({
        method: 'POST',
        path: '/v1/auth/logout',
        headers: { authorization: `Bearer ${currentToken}` },
        credentials: 'include',
      });
    });
  }

  sessions(): Promise<SessionView[]> {
    return this.execute<SessionView[]>({ method: 'GET', path: '/v1/auth/sessions', auth: true });
  }

  /**
   * Revoke one of the caller's own sessions. The server resolves the id only within this user's
   * sessions, so an id from anywhere else answers 404 rather than acting.
   */
  revokeSession(id: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/auth/sessions/${encodeURIComponent(id)}`,
      auth: true,
    });
  }

  requestPasswordReset(body: PasswordResetRequest): Promise<void> {
    return this.execute<void>({
      method: 'POST',
      path: '/v1/auth/password-reset/request',
      body,
    });
  }

  confirmPasswordReset(body: PasswordResetConfirmRequest): Promise<void> {
    return this.cookieCoordinator.run(async () => {
      await this.execute<void>({
        method: 'POST',
        path: '/v1/auth/password-reset/confirm',
        body,
        // The response clears the httpOnly refresh cookie. Include credentials so
        // browsers accept that Set-Cookie when the configured API is cross-origin.
        credentials: 'include',
      });
      // Password reset revokes every account session. Publish that durable reset before the
      // cookie lock is released so a queued authentication cannot miss the security boundary.
      this.session.reset();
    });
  }

  verifyEmail(body: EmailVerifyRequest): Promise<void> {
    return this.execute<void>({
      method: 'POST',
      path: '/v1/auth/email/verify',
      body,
    });
  }

  listPasskeys(): Promise<PasskeyView[]> {
    return this.execute<PasskeyView[]>({ method: 'GET', path: '/v1/auth/webauthn/passkeys', auth: true });
  }

  deletePasskey(id: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/auth/webauthn/passkeys/${encodeURIComponent(id)}`,
      auth: true,
    });
  }

  registerPasskeyOptions(): Promise<WebAuthnRegisterOptions> {
    return this.execute<WebAuthnRegisterOptions>({
      method: 'POST',
      path: '/v1/auth/webauthn/register/options',
      auth: true,
    });
  }

  verifyPasskeyRegister(body: WebAuthnRegisterVerifyRequest): Promise<PasskeyView> {
    return this.execute<PasskeyView>({
      method: 'POST',
      path: '/v1/auth/webauthn/register/verify',
      body,
      auth: true,
    });
  }

  loginPasskeyOptions(body: WebAuthnLoginOptionsRequest): Promise<WebAuthnLoginOptions> {
    return this.execute<WebAuthnLoginOptions>({
      method: 'POST',
      path: '/v1/auth/webauthn/login/options',
      body,
    });
  }

  /** Verify a passkey assertion and adopt it only if no newer session transition superseded the flow. */
  async verifyPasskeyLogin(
    body: WebAuthnLoginVerifyRequest,
    expectedGeneration = this.session.captureGeneration(),
  ): Promise<AuthResponse> {
    return this.cookieCoordinator.run(async (cookieOrder) => {
      this.session.assertGeneration(expectedGeneration);
      const auth = await this.execute<AuthResponse>({
        method: 'POST',
        path: '/v1/auth/webauthn/login/verify',
        body,
        credentials: 'include',
      });
      await this.adoptOrRevokeStale(auth, expectedGeneration, cookieOrder);
      return auth;
    });
  }
}

export class UsersApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  me(): Promise<SelfUser> {
    return this.execute<SelfUser>({ method: 'GET', path: '/v1/users/me', auth: true });
  }

  byHandle(handle: string): Promise<UserProfile> {
    return this.execute<UserProfile>({ method: 'GET', path: `/v1/users/${encodeURIComponent(handle)}` });
  }

  ratings(handle: string): Promise<RatingView[]> {
    return this.execute<RatingView[]>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(handle)}/ratings`,
    });
  }

  games(handle: string, opts: { limit?: number } = {}): Promise<GameSummary[]> {
    return this.execute<GameSummary[]>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(handle)}/games`,
      ...(opts.limit !== undefined ? { query: { limit: opts.limit } } : {}),
    });
  }
}

export class GamesApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  byId(id: string): Promise<GameSummary> {
    return this.execute<GameSummary>({ method: 'GET', path: `/v1/games/${encodeURIComponent(id)}` });
  }

  createVsBot(body: CreateBotGameRequest): Promise<GameSummary> {
    return this.execute<GameSummary>({ method: 'POST', path: '/v1/games/bot', body, auth: true });
  }

  /** Request the authenticated player's completed-game review with caller-owned cancellation. */
  review(id: string, signal?: AbortSignal): Promise<GameReviewResponse> {
    return this.execute<GameReviewResponse>({
      method: 'POST',
      path: `/v1/games/${encodeURIComponent(id)}/review`,
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

export class SeeksApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  list(): Promise<SeekView[]> {
    return this.execute<SeekView[]>({ method: 'GET', path: '/v1/seeks', auth: 'optional' });
  }

  create(body: CreateSeekRequest): Promise<SeekView> {
    return this.execute<SeekView>({ method: 'POST', path: '/v1/seeks', body, auth: true });
  }

  cancel(id: string): Promise<void> {
    return this.execute<void>({ method: 'DELETE', path: `/v1/seeks/${encodeURIComponent(id)}`, auth: true });
  }

  accept(id: string): Promise<SeekView> {
    return this.execute<SeekView>({ method: 'POST', path: `/v1/seeks/${encodeURIComponent(id)}/accept`, auth: true });
  }
}

export class TournamentsApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  list(limit?: number): Promise<TournamentSummary[]> {
    return this.execute<TournamentSummary[]>({
      method: 'GET',
      path: '/v1/tournaments',
      auth: 'optional',
      ...(limit !== undefined ? { query: { limit } } : {}),
    });
  }

  byId(id: string): Promise<TournamentDetail> {
    return this.execute<TournamentDetail>({
      method: 'GET',
      path: `/v1/tournaments/${encodeURIComponent(id)}`,
      auth: 'optional',
    });
  }

  standings(id: string): Promise<TournamentStanding[]> {
    return this.execute<TournamentStanding[]>({
      method: 'GET',
      path: `/v1/tournaments/${encodeURIComponent(id)}/standings`,
      auth: 'optional',
    });
  }

  /**
   * List the generated rounds of a tournament.
   *
   * GET /v1/tournaments/:id/rounds, auth: optional. Pairings only — the response carries no
   * results, so completeness is not derivable from it.
   *
   * @param id - the tournament.
   * @returns each generated round with its pairings.
   */
  rounds(id: string): Promise<TournamentRound[]> {
    return this.execute<TournamentRound[]>({
      method: 'GET',
      path: `/v1/tournaments/${encodeURIComponent(id)}/rounds`,
      auth: 'optional',
    });
  }

  /**
   * The active games of a tournament, plus its current standings.
   *
   * GET /v1/tournaments/:id/live, auth: optional. Finished games are deliberately absent.
   *
   * @param id - the tournament.
   * @returns the live boards and the standings.
   */
  live(id: string): Promise<TournamentLive> {
    return this.execute<TournamentLive>({
      method: 'GET',
      path: `/v1/tournaments/${encodeURIComponent(id)}/live`,
      auth: 'optional',
    });
  }

  /**
   * Commentate the decisive moment of a finished tournament game (M15 inc 22, ADR-0130).
   *
   * POST /v1/tournaments/:id/games/:gameId/commentary, auth: true.
   *
   * No body. Not "an empty object we happen to send" — no body at all: the server derives the
   * position, the players, the result and the round for itself, and refuses a request carrying any
   * of them rather than ignoring the field. `auth: true` and not `'optional'` like its neighbours
   * above, because reading a broadcast costs a query while generating a commentary costs an engine
   * search and a metered completion.
   *
   * No retry: one accepted call spends both.
   */
  gameCommentary(
    tournamentId: string,
    gameId: string,
    signal?: AbortSignal,
  ): Promise<TournamentGameCommentary> {
    return this.execute<TournamentGameCommentary>({
      method: 'POST',
      path: `/v1/tournaments/${encodeURIComponent(tournamentId)}/games/${encodeURIComponent(gameId)}/commentary`,
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Narrate a round every pairing of which has a result (M15 inc 22, ADR-0130).
   *
   * POST /v1/tournaments/:id/rounds/:roundIndex/recap, auth: true. No body, for the same reason.
   * A round still in progress is refused with 409 rather than described as though it were over.
   */
  roundRecap(
    tournamentId: string,
    roundIndex: number,
    signal?: AbortSignal,
  ): Promise<TournamentRoundRecap> {
    return this.execute<TournamentRoundRecap>({
      method: 'POST',
      path: `/v1/tournaments/${encodeURIComponent(tournamentId)}/rounds/${encodeURIComponent(String(roundIndex))}/recap`,
      auth: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

export class SearchApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  query(params: {
    q: string;
    mode?: SearchMode;
    limit?: number;
    offset?: number;
  }): Promise<SearchResults> {
    const searchParams = new URLSearchParams();
    searchParams.set('q', params.q);
    if (params.mode !== undefined) searchParams.set('mode', params.mode);
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

    return this.execute<SearchResults>({
      method: 'GET',
      path: `/v1/search?${searchParams.toString()}`,
      auth: 'optional',
    });
  }
}

export class MessagesApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  listConversations(opts?: { limit?: number; offset?: number }): Promise<ConversationList> {
    return this.execute<ConversationList>({
      method: 'GET',
      path: '/v1/messages/conversations',
      auth: true,
      ...(opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * Fetch one conversation. The thread header needs this: a `MessageView` carries only a
   * `senderId`, so a thread the caller alone has posted in has no way to name the other party.
   */
  conversation(conversationId: string): Promise<ConversationView> {
    return this.execute<ConversationView>({
      method: 'GET',
      path: `/v1/messages/conversations/${encodeURIComponent(conversationId)}`,
      auth: true,
    });
  }

  messages(conversationId: string, opts?: { limit?: number; offset?: number }): Promise<MessageList> {
    return this.execute<MessageList>({
      method: 'GET',
      path: `/v1/messages/conversations/${encodeURIComponent(conversationId)}/messages`,
      auth: true,
      ...(opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  send(conversationId: string, body: string): Promise<MessageView> {
    return this.execute<MessageView>({
      method: 'POST',
      path: `/v1/messages/conversations/${encodeURIComponent(conversationId)}/messages`,
      auth: true,
      body: { body },
    });
  }

  markRead(conversationId: string): Promise<ConversationReadState> {
    return this.execute<ConversationReadState>({
      method: 'POST',
      path: `/v1/messages/conversations/${encodeURIComponent(conversationId)}/read`,
      auth: true,
    });
  }

  openWith(playerId: string): Promise<ConversationView> {
    return this.execute<ConversationView>({
      method: 'POST',
      path: '/v1/messages/conversations',
      auth: true,
      body: { playerId },
    });
  }
}

export class TeamsApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  list(opts?: { search?: string; limit?: number; offset?: number }): Promise<TeamList> {
    return this.execute<TeamList>({
      method: 'GET',
      path: '/v1/teams',
      auth: 'optional',
      ...(opts?.search !== undefined || opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.search !== undefined ? { search: opts.search } : {}),
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  byId(idOrSlug: string): Promise<TeamDetailView> {
    return this.execute<TeamDetailView>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(idOrSlug)}`,
      auth: 'optional',
    });
  }

  members(id: string, opts?: { limit?: number; offset?: number }): Promise<TeamMemberList> {
    return this.execute<TeamMemberList>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(id)}/members`,
      auth: 'optional',
      ...(opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  join(id: string): Promise<TeamMembership> {
    return this.execute<TeamMembership>({
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(id)}/members`,
      auth: true,
    });
  }

  leave(id: string, playerId: string): Promise<void> {
    return this.execute<void>({
      method: 'DELETE',
      path: `/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(playerId)}`,
      auth: true,
    });
  }

  joinRequests(
    teamId: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<JoinRequestList> {
    return this.execute<JoinRequestList>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}/join-requests`,
      auth: true,
      ...(opts?.status !== undefined || opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.status !== undefined ? { status: opts.status } : {}),
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  respondToJoinRequest(
    teamId: string,
    requestId: string,
    status: 'accepted' | 'declined',
  ): Promise<JoinRequestView> {
    return this.execute<JoinRequestView>({
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/join-requests/${encodeURIComponent(requestId)}/respond`,
      auth: true,
      body: { status },
    });
  }

  // --- Forum (M14 inc 21) ---
  // Every forum route is nested under a team, so they live here rather than in a second class.

  threads(teamId: string, opts?: { limit?: number; offset?: number }): Promise<ForumThreadList> {
    return this.execute<ForumThreadList>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}/forum/threads`,
      auth: 'optional',
      ...(opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  thread(teamId: string, threadId: string): Promise<ForumThread> {
    return this.execute<ForumThread>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}/forum/threads/${encodeURIComponent(threadId)}`,
      auth: 'optional',
    });
  }

  createThread(teamId: string, title: string, body: string): Promise<ForumThreadCreated> {
    return this.execute<ForumThreadCreated>({
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/forum/threads`,
      body: { title, body },
      auth: true,
    });
  }

  posts(teamId: string, threadId: string, opts?: { limit?: number; offset?: number }): Promise<ForumPostList> {
    return this.execute<ForumPostList>({
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}/forum/threads/${encodeURIComponent(threadId)}/posts`,
      auth: 'optional',
      ...(opts?.limit !== undefined || opts?.offset !== undefined
        ? {
            query: {
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
            },
          }
        : {}),
    });
  }

  createPost(teamId: string, threadId: string, body: string): Promise<ForumPost> {
    return this.execute<ForumPost>({
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/forum/threads/${encodeURIComponent(threadId)}/posts`,
      body: { body },
      auth: true,
    });
  }
}

/**
 * Achievements (M14 inc 22).
 *
 * Both routes are public and keyed by player id, not by handle — unlike the rest of the profile
 * page, which is keyed by handle. No `auth` flag: the answer does not vary by viewer, so sending a
 * token would buy nothing and would make a signed-out profile render differently from a signed-in
 * one for no reason.
 *
 * The catalogue route `GET /v1/achievements` is deliberately not exposed. `forPlayer` already
 * returns every visible definition joined with progress, so a second call would add nothing this
 * app renders.
 */
/**
 * Every achievements route answers 503 when the deployment did not configure the achievements
 * repository (`checkAchievementsRepo` in `packages/api/src/routes.ts`). That is a setting, not an
 * outage, so the transport's default "503 is transient, retry it" would spend two more attempts per
 * endpoint to be told the same thing. Every other retryable failure still retries.
 */
const ACHIEVEMENTS_PERMANENT_STATUSES: readonly number[] = [503];

export class AchievementsApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  /**
   * Every visible achievement for a player, unlocked first (the API orders by `unlockedAt` DESC,
   * `key` ASC). Hidden achievements appear only once earned.
   *
   * No pagination argument: the catalogue is 14 entries against a server default page of 50, so a
   * page control today would be a lever with nothing on the end of it. It becomes a real question
   * when the catalogue passes 50.
   */
  forPlayer(playerId: string): Promise<PlayerAchievementList> {
    return this.execute<PlayerAchievementList>({
      method: 'GET',
      path: `/v1/players/${encodeURIComponent(playerId)}/achievements`,
      permanentStatuses: ACHIEVEMENTS_PERMANENT_STATUSES,
    });
  }

  summary(playerId: string): Promise<AchievementSummary> {
    return this.execute<AchievementSummary>({
      method: 'GET',
      path: `/v1/players/${encodeURIComponent(playerId)}/achievements/summary`,
      permanentStatuses: ACHIEVEMENTS_PERMANENT_STATUSES,
    });
  }
}

/**
 * Learning & Courses (M14 inc 23).
 *
 * Answers 503 when the deployment did not configure the learning repository.
 * `permanentStatuses: [503]` suppresses transport retries for 503 on learning endpoints.
 */
const LEARNING_PERMANENT_STATUSES: readonly number[] = [503];

export class LearningApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  listCourses(opts?: { search?: string; limit?: number; offset?: number; difficulty?: CourseDifficulty }): Promise<CourseList> {
    return this.execute<CourseList>({
      method: 'GET',
      path: '/v1/courses',
      auth: 'optional',
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
      ...(opts?.search !== undefined || opts?.limit !== undefined || opts?.offset !== undefined || opts?.difficulty !== undefined
        ? {
            query: {
              ...(opts.search !== undefined ? { search: opts.search } : {}),
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
              ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
            },
          }
        : {}),
    });
  }

  courseBySlug(slug: string): Promise<CourseView> {
    return this.execute<CourseView>({
      method: 'GET',
      path: `/v1/courses/slug/${encodeURIComponent(slug)}`,
      auth: 'optional',
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  lessons(courseId: string): Promise<readonly LessonView[]> {
    return this.execute<readonly LessonView[]>({
      method: 'GET',
      path: `/v1/courses/${encodeURIComponent(courseId)}/lessons`,
      auth: 'optional',
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  progress(courseId: string): Promise<CourseProgressSummaryView> {
    return this.execute<CourseProgressSummaryView>({
      method: 'GET',
      path: `/v1/courses/${encodeURIComponent(courseId)}/progress`,
      auth: true,
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  progressDetails(courseId: string): Promise<readonly ProgressView[]> {
    return this.execute<readonly ProgressView[]>({
      method: 'GET',
      path: `/v1/courses/${encodeURIComponent(courseId)}/progress/details`,
      auth: true,
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  lesson(lessonId: string): Promise<LessonView> {
    return this.execute<LessonView>({
      method: 'GET',
      path: `/v1/lessons/${encodeURIComponent(lessonId)}`,
      auth: 'optional',
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  steps(lessonId: string): Promise<readonly StepView[]> {
    return this.execute<readonly StepView[]>({
      method: 'GET',
      path: `/v1/lessons/${encodeURIComponent(lessonId)}/steps`,
      auth: 'optional',
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }

  attempt(stepId: string, body: SubmitAttemptRequest): Promise<AttemptResultView> {
    return this.execute<AttemptResultView>({
      method: 'POST',
      path: `/v1/steps/${encodeURIComponent(stepId)}/attempt`,
      auth: true,
      body,
      permanentStatuses: LEARNING_PERMANENT_STATUSES,
    });
  }
}

/**
 * Studies (M14 inc 24).
 *
 * Answers 503 when the deployment did not configure the studies repository.
 * `permanentStatuses: [503]` suppresses transport retries for 503 on studies endpoints.
 */
const STUDIES_PERMANENT_STATUSES: readonly number[] = [503];

export class StudiesApi {
  private readonly execute: Execute;
  private readonly baseUrl: string;
  constructor(execute: Execute, baseUrl: string = '') {
    this.execute = execute;
    this.baseUrl = baseUrl;
  }

  listStudies(opts?: { search?: string; limit?: number; offset?: number; ownerId?: string }): Promise<StudyList> {
    return this.execute<StudyList>({
      method: 'GET',
      path: '/v1/studies',
      auth: 'optional',
      permanentStatuses: STUDIES_PERMANENT_STATUSES,
      ...(opts?.search !== undefined || opts?.limit !== undefined || opts?.offset !== undefined || opts?.ownerId !== undefined
        ? {
            query: {
              ...(opts.search !== undefined ? { search: opts.search } : {}),
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
              ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
              ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
            },
          }
        : {}),
    });
  }

  study(id: string): Promise<StudyView> {
    return this.execute<StudyView>({
      method: 'GET',
      path: `/v1/studies/${encodeURIComponent(id)}`,
      auth: 'optional',
      permanentStatuses: STUDIES_PERMANENT_STATUSES,
    });
  }

  chapters(studyId: string): Promise<ChapterList> {
    return this.execute<ChapterList>({
      method: 'GET',
      path: `/v1/studies/${encodeURIComponent(studyId)}/chapters`,
      auth: 'optional',
      permanentStatuses: STUDIES_PERMANENT_STATUSES,
    });
  }

  chapterDetail(studyId: string, chapterId: string): Promise<ChapterDetailView> {
    return this.execute<ChapterDetailView>({
      method: 'GET',
      path: `/v1/studies/${encodeURIComponent(studyId)}/chapters/${encodeURIComponent(chapterId)}`,
      auth: 'optional',
      permanentStatuses: STUDIES_PERMANENT_STATUSES,
    });
  }

  collaborators(studyId: string): Promise<CollaboratorList> {
    return this.execute<CollaboratorList>({
      method: 'GET',
      path: `/v1/studies/${encodeURIComponent(studyId)}/collaborators`,
      auth: 'optional',
      permanentStatuses: STUDIES_PERMANENT_STATUSES,
    });
  }

  exportPgnUrl(studyId: string, chapterId?: string): string {
    const query = chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
    return `${this.baseUrl}/v1/studies/${encodeURIComponent(studyId)}/export.pgn${query}`;
  }
}
