/**
 * DOM entry for the composition root: build the application graph, mount the
 * active route view, and return the wired handles. It is invoked from
 * `main.ts` and delegates bounded DOM concerns to focused app-layer modules.
 * Keeping DOM composition separate from {@link createApp} lets the object
 * graph be composed and tested with no DOM present.
 *
 * Routing: reads the URL pathname via {@link parseRoute}, applies top-level
 * surface visibility, and dispatches into the focused route mounts.
 *
 * Theme toggle and auth controller are always wired across all routes.
 */
import { createApp } from './composition.js';
import type { App, AppDependencies } from './composition.js';
import { applyNavCapabilities } from './capabilities-nav.js';
import { resolveConfig } from './config.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import type { GameController } from './game-controller.js';
import { mountGame } from './game-mount.js';
import type { LobbyController } from './lobby-controller.js';
import { mountLobby } from './lobby-mount.js';
import type { ProfileController } from './profile-controller.js';
import { mountProfile } from './profile-mount.js';
import type { TournamentController } from './tournament-controller.js';
import type { MountedTournamentCommentary } from './competition-mounts.js';
import {
  mountLeaderboard,
  mountTournamentDetail,
  mountTournamentCommentary,
  mountTournamentList,
} from './competition-mounts.js';
import {
  renderEmpty,
  formatClock,
  formatTimeControl,
} from './render-helpers.js';
import type { EmptyStateOptions } from './render-helpers.js';
import type { SearchController } from './search-controller.js';
import { mountSearch } from './search-mount.js';
import type { LearningController } from './learning-controller.js';
import { mountCourseDetail, mountCourseList, mountLesson } from './learning-mounts.js';
import { mountEndgames } from './endgame-mount.js';
import type { MountedEndgames } from './endgame-mount.js';
import type { StudiesController } from './studies-controller.js';
import { mountStudiesList, mountStudyChapter, mountStudyDetail } from './studies-mounts.js';
import { mountConversation, mountMessagesInbox } from './messaging-mounts.js';
import { mountTeamDetail, mountTeamList } from './team-mounts.js';
import { mountForum, mountForumThread } from './forum-mounts.js';
import type { ForumController } from './forum-controller.js';
import type { TeamsController } from './teams-controller.js';
import type { MessagesController } from './messages-controller.js';
import { ThemeToggle } from './theme-toggle.js';
import { AuthController } from './auth-controller.js';
import type { AuthSession } from './auth-controller.js';
import { mountPasswordRecovery } from './password-recovery-mount.js';
import { mountEmailVerification } from './email-verification-mount.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';
import { parseRoute } from './router.js';
import { applyRouteSurface } from './route-surface.js';

export { renderEmpty, formatClock, formatTimeControl };
export type { EmptyStateOptions };

/** Disposables returned by bootstrap, torn down on SPA route navigation. */
export interface BootstrappedDisposables {
  readonly app: App;
  readonly controller: GameController | null;
  readonly board: MountedBoard | null;
  readonly lobby: LobbyController | null;
  readonly profile: ProfileController | null;
  readonly leaderboard: { dispose: () => void } | null;
  readonly tournament: TournamentController | null;
  readonly tournamentCommentary: MountedTournamentCommentary | null;
  readonly search: SearchController | null;
  readonly messages: MessagesController | null;
  readonly teams: TeamsController | null;
  readonly forum: ForumController | null;
  readonly learning: LearningController | null;
  readonly endgames: MountedEndgames | null;
  readonly studies: StudiesController | null;
  readonly passkeys: { dispose: () => void } | null;
  readonly passwordReset: { dispose: () => void } | null;
  readonly emailVerification: { dispose: () => void } | null;
  readonly connectivity: { dispose: () => void } | null;
  readonly analysis: { dispose: () => void } | null;
}

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped extends BootstrappedDisposables {
  readonly auth: AuthController;
  readonly theme: ThemeToggle;
}

/** Key of disposables returned by bootstrap. Driven by BootstrappedDisposables for structural teardown exhaustiveness. */
export type DisposableKey = keyof BootstrappedDisposables;

type ActiveBootstrappedDisposables = Partial<Omit<BootstrappedDisposables, 'app'>>;

function createBootstrapped(
  app: App,
  auth: AuthController,
  theme: ThemeToggle,
  activeDisposables: ActiveBootstrappedDisposables,
): Bootstrapped {
  return {
    app,
    controller: null,
    board: null,
    lobby: null,
    profile: null,
    leaderboard: null,
    tournament: null,
    tournamentCommentary: null,
    search: null,
    messages: null,
    teams: null,
    forum: null,
    learning: null,
    endgames: null,
    studies: null,
    passkeys: null,
    passwordReset: null,
    emailVerification: null,
    connectivity: null,
    analysis: null,
    auth,
    theme,
    ...activeDisposables,
  };
}

/**
 * Extract a game ID from a URL-like path. Only `/game/{id}` is accepted.
 * Returns `null` when no game ID is found.
 */
export function extractGameId(pathname: string): string | null {
  const route = parseRoute(pathname);
  return route.name === 'game' ? route.gameId : null;
}

/** Injectable seams for the bootstrap. Omit any to use browser defaults. */
export interface BootstrapDependencies extends Partial<AppDependencies> {
  /** Override the game ID (takes precedence over URL extraction). */
  readonly gameId?: string;
  /** Override the access token (for authenticated join). */
  readonly token?: string;
  /** Override native WebAuthn ceremonies for tests or alternate browser hosts. */
  readonly webauthnAdapter?: WebAuthnAdapter;
}

/**
 * Capture a secret recovery token from the URL **fragment** and strip it from the location bar
 * before any application composition or background request runs.
 *
 * The fragment, not the query string, is what carries these tokens. A query string is part of the
 * request line: `/email-verify?token=...` reaches the web tier on the very first navigation, before
 * a single line of this bundle has parsed, and a reverse proxy logging `$request` keeps a live
 * credential in its access log. No amount of client-side stripping retracts a request already made.
 * A fragment is never transmitted — browsers keep it out of the request line and out of `Referer` —
 * so the secret arrives here without having touched the server at all.
 *
 * `replaceState` still earns its place afterwards, for what the fragment *does* reach: the location
 * bar, the history entry, and anything the visitor could copy out of either.
 */
function captureAndStripToken(routePath: string): string | null {
  if (typeof location === 'undefined') return null;
  const fragment = location.hash;
  if (!fragment || fragment.length <= 1) return null;

  const token = new URLSearchParams(fragment.slice(1)).get('token');
  if (!token) return null;

  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    history.replaceState(null, '', routePath);
  }
  return token;
}

/**
 * Compose the app and mount views against the given document. The route is
 * determined from the URL pathname (or `deps.gameId` override).
 */
export function bootstrap(
  doc: Document,
  deps?: BootstrapDependencies,
): Bootstrapped {
  // Capture recovery tokens out of the fragment and clear the location bar BEFORE any network call
  // or app composition. The fragment never reached the server; this clears the browser's copy.
  const rawUrl = typeof location !== 'undefined' ? location.pathname + (location.search ?? '') : '/';
  const route = parseRoute(rawUrl);
  const showPasswordReset = route.name === 'password-reset';
  const showEmailVerify = route.name === 'email-verify';
  const activeResetToken = showPasswordReset ? captureAndStripToken('/password-reset') : null;
  const activeVerificationToken = showEmailVerify ? captureAndStripToken('/email-verify') : null;
  const hideAuthSection = showPasswordReset || showEmailVerify || route.name === 'not-found';

  const config = deps?.config ?? resolveConfig();
  const appDeps: AppDependencies = {
    config,
    ...(deps?.httpTransport !== undefined ? { httpTransport: deps.httpTransport } : {}),
    ...(deps?.wsFactory !== undefined ? { wsFactory: deps.wsFactory } : {}),
    ...(deps?.tokenStore !== undefined ? { tokenStore: deps.tokenStore } : {}),
    ...(deps?.storage !== undefined ? { storage: deps.storage } : {}),
  };
  const app = createApp(appDeps);

  // --- Capabilities-driven navigation ---
  void applyNavCapabilities(doc, app.api);

  // --- Theme toggle (always wired) ---
  const themeButtonEl = doc.getElementById('theme-toggle');
  const theme = new ThemeToggle({
    callbacks: {
      onTheme: (t) => {
        doc.documentElement.classList.toggle('dark', t === 'dark');
        doc.documentElement.classList.toggle('light', t === 'light');
        if (themeButtonEl) {
          const next = t === 'dark' ? 'light' : 'dark';
          themeButtonEl.textContent = t === 'dark' ? '☀️' : '🌙';
          themeButtonEl.setAttribute('aria-label', `Switch to ${next} theme`);
          themeButtonEl.setAttribute('title', `Switch to ${next} theme`);
        }
        if ('querySelector' in doc && typeof doc.querySelector === 'function') {
          const themeColor = doc.querySelector('meta[name="theme-color"]');
          themeColor?.setAttribute('content', t === 'dark' ? '#242224' : '#F5F1ED');
        }
      },
    },
    ...(deps?.storage !== undefined ? { storage: deps.storage } : typeof localStorage !== 'undefined' ? { storage: localStorage } : {}),
  });
  theme.emit();

  // --- Auth controller (always wired) ---
  const authErrorEl = doc.getElementById('auth-error');
  const authFormEl = doc.getElementById('auth-form');
  const authHandleEl = doc.getElementById('auth-handle') as HTMLInputElement | null;
  const authPasswordEl = doc.getElementById('auth-password') as HTMLInputElement | null;
  const authEmailEl = doc.getElementById('auth-email') as HTMLInputElement | null;
  const authSubmitEl = doc.getElementById('auth-submit');
  const authRegisterEl = doc.getElementById('auth-register');
  const authPasskeyEl = doc.getElementById('auth-passkey');
  const authLogoutEl = doc.getElementById('auth-logout');
  const authStatusEl = doc.getElementById('auth-status');
  const authSectionEl = doc.getElementById('auth');

  let selfProfileSessionHandler: ((session: AuthSession | null) => void) | null = null;
  let setCreateGameAuthenticated: ((authenticated: boolean) => void) | null = null;
  let setPlayBotAuthenticated: ((authenticated: boolean) => void) | null = null;
  let lobbySessionHandler: (() => void) | null = null;
  let gameSessionHandler: ((session: AuthSession | null) => void) | null = null;
  let endgameSessionHandler: (() => void) | null = null;
  let commentarySessionHandler: ((signedIn: boolean) => void) | null = null;
  const auth = new AuthController({
    client: app.api,
    ...(deps?.webauthnAdapter !== undefined ? { webauthnAdapter: deps.webauthnAdapter } : {}),
    callbacks: {
      onSessionChange: (session) => {
        if (authStatusEl) {
          authStatusEl.textContent = session ? `Signed in as ${session.handle}` : 'Not signed in';
        }
        // Show/hide the sign-in surface vs the logout button. The section is what hides, not just
        // the form inside it: hiding only the form left a signed-in visitor looking at an empty box.
        if (authSectionEl) authSectionEl.hidden = session !== null || hideAuthSection;
        if (authLogoutEl) authLogoutEl.hidden = session === null;
        const playBotBtn = doc.getElementById('play-bot');
        if (playBotBtn instanceof HTMLButtonElement) {
          playBotBtn.disabled = session === null;
          playBotBtn.title = session === null ? 'Sign in to play the computer' : '';
        }
        setCreateGameAuthenticated?.(session !== null);
        setPlayBotAuthenticated?.(session !== null);
        lobbySessionHandler?.();
        selfProfileSessionHandler?.(session);
        gameSessionHandler?.(session);
        endgameSessionHandler?.();
        commentarySessionHandler?.(session !== null);
      },
      onPending: (pending) => {
        if (authSubmitEl instanceof HTMLButtonElement) {
          authSubmitEl.disabled = pending;
        }
        if (authRegisterEl instanceof HTMLButtonElement) {
          authRegisterEl.disabled = pending;
        }
        if (authPasskeyEl instanceof HTMLButtonElement) {
          authPasskeyEl.disabled = pending;
        }
      },
      onError: (msg) => {
        if (authErrorEl) authErrorEl.textContent = msg;
      },
    },
    ...(deps?.storage !== undefined ? { storage: deps.storage } : typeof localStorage !== 'undefined' ? { storage: localStorage } : {}),
  });

  // Wire auth form submit (sign in). Bound on the form so pressing Enter in the password field signs in.
  const submitSignIn = (): void => {
    if (authHandleEl && typeof authHandleEl.reportValidity === 'function' && !authHandleEl.reportValidity()) {
      return;
    }
    if (authPasswordEl && typeof authPasswordEl.reportValidity === 'function' && !authPasswordEl.reportValidity()) {
      return;
    }
    const handle = authHandleEl?.value ?? '';
    const password = authPasswordEl?.value ?? '';
    if (handle && password) {
      void auth.login(handle, password);
    }
  };
  if (authFormEl instanceof HTMLFormElement) {
    authFormEl.onsubmit = (e): void => {
      e.preventDefault();
      submitSignIn();
    };
  }

  // Static auth controls survive SPA re-bootstrap, so property assignment keeps these bindings
  // idempotent. The register button is type="button", so trigger native form validation explicitly.
  if (authRegisterEl instanceof HTMLButtonElement) {
    authRegisterEl.onclick = () => {
      if (authFormEl instanceof HTMLFormElement && !authFormEl.reportValidity()) {
        return;
      }
      const handle = authHandleEl?.value ?? '';
      const password = authPasswordEl?.value ?? '';
      if (handle && password) {
        void auth.register(handle, password, authEmailEl?.value ?? '');
      }
    };
  }

  if (authPasskeyEl instanceof HTMLButtonElement) {
    authPasskeyEl.onclick = () => {
      const handle = authHandleEl?.value ?? '';
      void auth.loginWithPasskey(handle);
    };
  }

  if (authLogoutEl instanceof HTMLButtonElement) {
    authLogoutEl.onclick = () => {
      void auth.logout();
    };
  }

  // Restore any persisted session. Kept as a promise so downstream mounts can wait
  // for the access token asynchronously via httpOnly refresh cookie.
  const restorePromise = auth.restore();

  // --- Determine route & game params ---
  const gameId = deps?.gameId ?? (route.name === 'game' ? route.gameId : null);
  const token = deps?.token ?? app.api.session.current?.tokens.accessToken;

  // Set initial auth section visibility from already-known route and auth state
  if (authSectionEl) authSectionEl.hidden = auth.currentSession !== null || hideAuthSection;
  if (authLogoutEl) authLogoutEl.hidden = auth.currentSession === null;

  applyRouteSurface(doc, route);

  // The not-found page is a complete route surface. Keep the global shell controllers alive, but
  // do not fall through to the legacy standalone-board fallback hidden inside #game-main.
  if (route.name === 'not-found') {
    return createBootstrapped(app, auth, theme, {});
  }

  // --- Game view ---
  const boardEl = doc.getElementById('board');
  if (boardEl && gameId) {
    const mountedGame = mountGame({
      doc,
      boardEl,
      gameId,
      createGameSync: app.createGameSync,
      createGameOracle: app.createGameOracle,
      getAccessToken: () => app.api.session.current?.tokens.accessToken,
      client: app.api,
      ...(token !== undefined ? { token } : {}),
      ...(auth.currentSession !== null ? { initialSessionId: auth.currentSession.userId } : {}),
      restorePromise,
    });
    gameSessionHandler = mountedGame.onSessionChange;
    return createBootstrapped(app, auth, theme, mountedGame);
  }

  // --- Lobby view ---
  const lobbyEl = doc.getElementById('lobby');
  if (lobbyEl && route.name === 'lobby') {
    const mountedLobby = mountLobby({
      doc,
      client: app.api,
      isAuthenticated: () => auth.isAuthenticated(),
      ...(deps?.storage !== undefined ? { storage: deps.storage } : {}),
    });
    setCreateGameAuthenticated = mountedLobby.setCreateGameAuthenticated;
    setPlayBotAuthenticated = mountedLobby.setPlayBotAuthenticated;
    lobbySessionHandler = mountedLobby.onSessionChange;

    return createBootstrapped(app, auth, theme, { lobby: mountedLobby.lobby });
  }

  // --- Profile view ---
  const profileEl = doc.getElementById('profile');
  if (profileEl && route.name === 'profile') {
    const mountedProfile = mountProfile({
      doc,
      client: app.api,
      handle: route.handle ?? null,
      getCurrentSession: () => auth.currentSession,
      restorePromise,
      ...(deps?.webauthnAdapter !== undefined ? { webauthnAdapter: deps.webauthnAdapter } : {}),
    });
    selfProfileSessionHandler = mountedProfile.onSessionChange;

    return createBootstrapped(app, auth, theme, {
      profile: mountedProfile.profile,
      passkeys: mountedProfile.passkeys,
    });
  }

  // --- Leaderboard view ---
  const leaderboardEl = doc.getElementById('leaderboard');
  if (leaderboardEl && route.name === 'leaderboard') {
    return createBootstrapped(app, auth, theme, {
      leaderboard: mountLeaderboard(doc, app.api),
    });
  }

  // --- Tournaments list view ---
  const tournamentsEl = doc.getElementById('tournaments');
  if (tournamentsEl && route.name === 'tournaments') {
    return createBootstrapped(app, auth, theme, {
      tournament: mountTournamentList(doc, app.api),
    });
  }

  // --- Single tournament detail view ---
  const tournamentEl = doc.getElementById('tournament');
  if (tournamentEl && route.name === 'tournament') {
    return createBootstrapped(app, auth, theme, {
      tournament: mountTournamentDetail(doc, app.api, route.id),
      tournamentCommentary: (() => {
        const commentary = mountTournamentCommentary(doc, app.api, route.id);
        // Registered here rather than inside the mount, because the session callback is owned by
        // the AuthController above and this is the only place that holds both.
        commentarySessionHandler = (signedIn) => commentary.sessionChanged(signedIn);
        return commentary;
      })(),
    });
  }

  // --- Search view ---
  const searchEl = doc.getElementById('search');
  if (searchEl && route.name === 'search') {
    return createBootstrapped(app, auth, theme, { search: mountSearch(doc, app.api) });
  }

  // --- Messages Inbox view (/messages) ---
  const messagesEl = doc.getElementById('messages');
  if (messagesEl && route.name === 'messages') {
    return createBootstrapped(app, auth, theme, {
      messages: mountMessagesInbox({
        doc,
        client: app.api,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Conversation Thread view (/messages/:id) ---
  const conversationEl = doc.getElementById('conversation');
  if (conversationEl && route.name === 'conversation') {
    return createBootstrapped(app, auth, theme, {
      messages: mountConversation({
        doc,
        client: app.api,
        conversationId: route.id,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Teams list view (/teams) ---
  const teamsEl = doc.getElementById('teams');
  if (teamsEl && route.name === 'teams') {
    return createBootstrapped(app, auth, theme, { teams: mountTeamList(doc, app.api) });
  }

  // --- Team detail view (/teams/:slug) ---
  const teamEl = doc.getElementById('team');
  if (teamEl && route.name === 'team') {
    return createBootstrapped(app, auth, theme, {
      teams: mountTeamDetail({
        doc,
        client: app.api,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Forum thread list (/teams/:slug/forum) ---
  const forumEl = doc.getElementById('forum');
  if (forumEl && route.name === 'forum') {
    return createBootstrapped(app, auth, theme, {
      forum: mountForum({
        doc,
        client: app.api,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Forum thread (/teams/:slug/forum/:threadId) ---
  const threadEl = doc.getElementById('thread');
  if (threadEl && route.name === 'thread') {
    return createBootstrapped(app, auth, theme, {
      forum: mountForumThread({
        doc,
        client: app.api,
        slug: route.slug,
        threadId: route.threadId,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  /** Mount the trainer and route authentication transitions into it. */
  const mountEndgamesRoute = (): MountedEndgames => {
    const mounted = mountEndgames({
      doc,
      client: app.api,
      isAuthenticated: () => auth.currentSession !== null,
    });
    endgameSessionHandler = mounted.onSessionChange;
    return mounted;
  };

  // --- Endgame trainer (/endgames) ---
  const endgamesEl = doc.getElementById('endgames');
  if (endgamesEl && route.name === 'endgames') {
    return createBootstrapped(app, auth, theme, {
      endgames: mountEndgamesRoute(),
    });
  }

  // --- Courses list view (/courses) ---
  const coursesEl = doc.getElementById('courses');
  if (coursesEl && route.name === 'courses') {
    return createBootstrapped(app, auth, theme, {
      learning: mountCourseList({ doc, client: app.api, surface: coursesEl }),
    });
  }

  // --- Course detail view (/courses/:slug) ---
  const courseEl = doc.getElementById('course');
  if (courseEl && route.name === 'course') {
    return createBootstrapped(app, auth, theme, {
      learning: mountCourseDetail({
        doc,
        client: app.api,
        surface: courseEl,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Lesson detail view (/lessons/:id) ---
  const lessonEl = doc.getElementById('lesson');
  if (lessonEl && route.name === 'lesson') {
    return createBootstrapped(app, auth, theme, {
      learning: mountLesson({
        doc,
        client: app.api,
        surface: lessonEl,
        lessonId: route.id,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Studies list view (/studies) ---
  const studiesEl = doc.getElementById('studies');
  if (studiesEl && route.name === 'studies') {
    return createBootstrapped(app, auth, theme, {
      studies: mountStudiesList({ doc, client: app.api, surface: studiesEl }),
    });
  }

  // --- Study detail view (/studies/:id) ---
  const studyEl = doc.getElementById('study');
  if (studyEl && route.name === 'study') {
    return createBootstrapped(app, auth, theme, {
      studies: mountStudyDetail({
        doc,
        client: app.api,
        surface: studyEl,
        studyId: route.id,
      }),
    });
  }

  // --- Study chapter detail view (/studies/:id/chapters/:chapterId) ---
  const studyChapterEl = doc.getElementById('study-chapter');
  if (studyChapterEl && route.name === 'study-chapter') {
    const mountedChapter = mountStudyChapter({
      doc,
      client: app.api,
      surface: studyChapterEl,
      studyId: route.id,
      chapterId: route.chapterId,
    });
    return createBootstrapped(app, auth, theme, mountedChapter);
  }

  // --- Password reset view ---
  if (showPasswordReset) {
    return createBootstrapped(app, auth, theme, {
      passwordReset: mountPasswordRecovery({
        doc,
        client: app.api,
        resetToken: activeResetToken,
        onSessionInvalidated: () => auth.clearLocalSession(),
      }),
    });
  }

  // --- Email verification view ---
  if (showEmailVerify) {
    return createBootstrapped(app, auth, theme, {
      emailVerification: mountEmailVerification({
        doc,
        client: app.api,
        verificationToken: activeVerificationToken,
      }),
    });
  }

  // --- Standalone fallback board ---
  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return createBootstrapped(app, auth, theme, { board });
}
