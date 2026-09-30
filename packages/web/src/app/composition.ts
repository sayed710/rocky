/**
 * Application composition root.
 *
 * This is the single place where the web app's object graph is assembled. It
 * wires the REST stack (`GambitClient`, which itself composes `HttpClient` +
 * `SessionManager`) and the realtime stack (`WsClient` plus a `GameSync`
 * factory) from their injectable seams. Everything is built by dependency
 * injection: the concrete browser adapters (`fetch`, `WebSocket`, `localStorage`)
 * are the defaults, and tests inject fakes instead.
 *
 * Deliberately out of scope here: opening any connection, driving gameplay
 * synchronization, touching the DOM, or importing the UI. The root only builds
 * and returns the wired services; connecting `GameSync`/`WsClient` to the board
 * lands in a later increment.
 */
import { GambitClient } from '../api/client.js';
import type { GambitClientOptions } from '../api/client.js';
import { WsClient } from '../net/ws-client.js';
import { GameSync } from '../net/game-sync.js';
import type { GameSyncOptions } from '../net/game-sync.js';
import { AuthoritativeMoveOracle } from '../net/authoritative-oracle.js';
import { MemoryTokenStore } from '../net/session.js';
import type { KeyValueStorage, TokenStore } from '../net/session.js';
import type { HttpTransport } from '../ports/http.js';
import type { WebSocketFactory } from '../ports/ws.js';
import type { AppConfig } from './config.js';
import { createI18n, I18n, LocaleStorage } from '../i18n/index.js';

/** Injectable seams for the composition root. Omit any to use browser defaults. */
export interface AppDependencies {
  readonly config: AppConfig;
  /** HTTP transport seam; defaults to the platform `fetch` adapter. */
  readonly httpTransport?: HttpTransport | undefined;
  /** WebSocket factory seam; defaults to the browser `WebSocket` adapter. */
  readonly wsFactory?: WebSocketFactory | undefined;
  /** Explicit token store; takes precedence over {@link AppDependencies.storage}. */
  readonly tokenStore?: TokenStore | undefined;
  /** Web Storage used to persist the session; defaults to `localStorage`. */
  readonly storage?: KeyValueStorage | undefined;
  /** Injected i18n manager for localized messaging. */
  readonly i18n?: I18n | undefined;
}

/** The wired application services produced by {@link createApp}. */
export interface App {
  readonly config: AppConfig;
  /** Typed REST client (auth/session, users/profile, ratings, leaderboard, games). */
  readonly api: GambitClient;
  /** Realtime client (connection lifecycle, reconnect, heartbeat). Not yet connected. */
  readonly ws: WsClient;
  /** Injected or default internationalization manager. */
  readonly i18n: I18n;
  /** Release the app-owned realtime connection and its timers. */
  dispose(): void;
  /** Build a per-game synchronization layer over the shared realtime client. */
  createGameSync(options: GameSyncOptions): GameSync;
  /**
   * Build a `LegalMoveOracle` backed by the authoritive `legalMoves` map in
   * a {@link GameSyncs}'s state. The oracle reads the map live via a getter, so
   * it stays in sync as the `GameSync` processes server snapshots and move
   * broadcasts. Wire this into `mountBoard` so the board's legal-move
   * highhlights reflect the server's authoritative state.
   */
  createGameOracle(gameSync: GameSync): AuthoritativeMoveOracle;
}

/**
 * Pick the session store. Tokens are ALWAYS kept in memory only (never persisted to
 * Web Storage) per ADR-0012 — the access token must not be exfiltrable via XSS.
 * An explicit store can still be injected for testing.
 */
function resolveTokenStore(deps: AppDependencies): TokenStore {
  if (deps.tokenStore !== undefined) return deps.tokenStore;
  return new MemoryTokenStore();
}

/** Assemble the application object graph from its (optionally injected) seams. */
export function createApp(deps: AppDependencies): App {
  const clientOptions: GambitClientOptions = {
    baseUrl: deps.config.apiBaseUrl,
    tokenStore: resolveTokenStore(deps),
    ...(deps.httpTransport !== undefined ? { transport: deps.httpTransport } : {}),
  };
  const api = new GambitClient(clientOptions);

  const ws = new WsClient({
    url: deps.config.wsUrl,
    ...(deps.wsFactory !== undefined ? { factory: deps.wsFactory } : {}),
  });

  const i18n = deps.i18n ?? createI18n({
    storage: deps.storage ? new LocaleStorage({ storage: deps.storage }) : undefined,
  });

  return {
    config: deps.config,
    api,
    ws,
    i18n,
    dispose: (): void => ws.close(1000, 'app-disposed'),
    createGameSync: (options: GameSyncOptions): GameSync => new GameSync(ws, options),
    createGameOracle: (gameSync: GameSync): AuthoritativeMoveOracle =>
      new AuthoritativeMoveOracle({
        getLegalMoves: () => gameSync.getState().legalMoves,
      }),
  };
}
