/**
 * @packageDocumentation
 * API configuration. Values are plain data with safe defaults; the only required
 * field is the access-token signing secret. {@link resolveConfig} fills defaults
 * and can read the secret from the environment for the bootstrap path.
 */

import type { CorsConfig } from './http/security';
import { resolveTrustProxyEnv, validateTrustProxy, type TrustProxy } from './http/client-ip';

/** Trusted proxy contract type re-exported for API server configuration. */
export type { TrustProxy };

/** Fully-resolved API configuration. */
export interface ApiConfig {
  /** HMAC secret for access tokens (≥32 bytes). Never logged. */
  readonly accessTokenSecret: string;
  /** Access-token lifetime in seconds (default 15 minutes). */
  readonly accessTokenTtlSec: number;
  /** Refresh-token lifetime in seconds (default 30 days). */
  readonly refreshTokenTtlSec: number;
  /** Maximum accepted request body in bytes. */
  readonly maxBodyBytes: number;
  /**
   * Trusted proxy contract for client IP resolution:
   * - `false` (default): direct connection (no proxy trusted, uses `socket.remoteAddress`).
   * - `true`: 1 trusted proxy hop (e.g. Docker Compose behind `web` nginx).
   * - `number`: positive hop count (e.g. 2 for ingress-nginx -> `web` in Helm).
   */
  readonly trustProxy: TrustProxy;
  /**
   * CORS policy. Safe default: no allowed origins (no cross-origin access).
   * Set `allowedOrigins` explicitly per deployment environment.
   *
   * @see docs/adr/0011-cors-security-headers.md
   */
  readonly cors: CorsConfig;
  /**
   * Emit `Strict-Transport-Security`. Disable in local/dev environments
   * where TLS is not terminated. Default: `true`.
   *
   * @see docs/adr/0011-cors-security-headers.md
   */
  readonly enableHsts: boolean;
  /**
   * Emit the `Secure` attribute on the refresh-token cookie. Default `true`.
   * Set `false` for local/dev over plain HTTP so the browser accepts the cookie.
   *
   * @see docs/adr/0012-httponly-refresh-cookie.md
   */
  readonly cookieSecure: boolean;
  /**
   * Rate limiting configuration for sensitive endpoints.
   */
  readonly rateLimit: RateLimitConfig;
  /**
   * WebAuthn / Passkeys configuration.
   */
  readonly webauthn: {
    readonly rpId: string;
    readonly origins: readonly string[];
  };
}

export interface RateLimitEndpointConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly login: {
    /** Every attempt from one address, charged before the password is checked. */
    readonly perIp: RateLimitEndpointConfig;
    /** Failed attempts against one handle from one address. Exhausting it refuses that address. */
    readonly perHandleIp: RateLimitEndpointConfig;
    /**
     * Failed attempts against one handle from all addresses together, before a password alone
     * stops being enough. It never refuses anyone: past it, sign-in also needs a passkey or a
     * code sent to the account's verified email, which extra addresses do not supply.
     */
    readonly perHandleBeforeStepUp: RateLimitEndpointConfig;
  };
  readonly register: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly refresh: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly passwordResetRequest: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly emailVerificationRequest: {
    readonly perIp: RateLimitEndpointConfig;
    readonly perUser: RateLimitEndpointConfig;
  };
  /**
   * The session-less verification re-send. Per IP only: a per-handle bucket would let anyone stop
   * the owner getting a new link; the account's own 10-minute re-send cooldown bounds its inbox.
   */
  readonly emailVerificationResend: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly webauthnLogin: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly webauthnRegister: {
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly seekCreation: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly analysis: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly moveExplanation: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly mistakePrediction: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly puzzleGeneration: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly openingExploration: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly endgameTraining: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly coach: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly tournamentCommentary: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
  readonly gameReview: {
    readonly perUser: RateLimitEndpointConfig;
    readonly perIp: RateLimitEndpointConfig;
  };
}

export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** The safe CORS default: no cross-origin access. */
export const DEFAULT_CORS: CorsConfig = {
  allowedOrigins: [],
  allowCredentials: false,
};

/** Default rate limiting configuration. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  login: {
    perIp: { maxRequests: 10, windowMs: 5 * 60 * 1000 }, // 10 / 5 min
    // One address gets the old per-handle budget of guesses against each handle.
    perHandleIp: { maxRequests: 5, windowMs: 15 * 60 * 1000 }, // 5 failures / 15 min
    perHandleBeforeStepUp: { maxRequests: 10, windowMs: 15 * 60 * 1000 }, // 10 failures / 15 min
  },
  register: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  refresh: {
    perIp: { maxRequests: 60, windowMs: 5 * 60 * 1000 }, // 60 / 5 min
  },
  passwordResetRequest: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  emailVerificationRequest: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
    perUser: { maxRequests: 3, windowMs: 60 * 60 * 1000 }, // 3 / 60 min
  },
  emailVerificationResend: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  // Per IP only. Asking for a challenge proves nothing and guessing a passkey signature is not
  // feasible, so a per-handle bucket here protected nothing and only let anyone lock a handle out.
  webauthnLogin: {
    perIp: { maxRequests: 10, windowMs: 5 * 60 * 1000 }, // 10 / 5 min
  },
  webauthnRegister: {
    perIp: { maxRequests: 5, windowMs: 60 * 60 * 1000 }, // 5 / 60 min
  },
  // The account quota bounds create/cancel floods without penalizing ordinary lobby retries.
  // The wider IP quota allows multiple players behind a shared NAT to seek independently.
  seekCreation: {
    perUser: { maxRequests: 20, windowMs: 5 * 60 * 1000 }, // 20 / 5 min
    perIp: { maxRequests: 200, windowMs: 5 * 60 * 1000 }, // 200 / 5 min
  },
  // Analysis is a CPU-amplification surface, so it is limited more tightly than a read endpoint.
  analysis: {
    perUser: { maxRequests: 30, windowMs: 60 * 1000 }, // 30 / min
    perIp: { maxRequests: 60, windowMs: 60 * 1000 }, // 60 / min
  },
  // Move explanation costs an engine search *and* a paid completion, so it is limited well below
  // analysis. The per-user limit is the one that matters: the per-IP limit is deliberately not a
  // multiple of it, because a shared NAT or a university network puts many legitimate accounts
  // behind one address, and an IP-only ceiling would ration them collectively.
  moveExplanation: {
    perUser: { maxRequests: 10, windowMs: 60 * 1000 }, // 10 / min
    perIp: { maxRequests: 30, windowMs: 60 * 1000 }, // 30 / min
  },
  // Mistake prediction costs up to two engine searches and no provider call, so it sits between the
  // two above: tighter than a single analysis because an accepted request can be two of them, and
  // looser than move explanation because there is no money in it. Its own bucket rather than a share
  // of the analysis one — a user assessing moves must not be able to exhaust their own ability to
  // analyse a position, and the two limits describe different costs.
  mistakePrediction: {
    perUser: { maxRequests: 20, windowMs: 60 * 1000 }, // 20 / min
    perIp: { maxRequests: 40, windowMs: 60 * 1000 }, // 40 / min
  },
  // One fixed three-line MultiPV search, with no provider call. Its own bucket prevents puzzle
  // discovery from consuming ordinary analysis quota.
  puzzleGeneration: {
    perUser: { maxRequests: 20, windowMs: 60 * 1000 }, // 20 / min
    perIp: { maxRequests: 40, windowMs: 60 * 1000 }, // 40 / min
  },
  // Opening exploration acquires no engine, so this is an ordinary bucket rather than an
  // expensive-work quota: the cost is replaying at most `MAX_EXPLORED_PLIES` moves through the
  // rules and scanning a bundled table. Still its own bucket rather than a share of `analysis` —
  // identifying an opening must not consume the quota a player needs to analyse a position, and
  // charging a cheap request against an expensive ceiling would misprice both.
  openingExploration: {
    perUser: { maxRequests: 60, windowMs: 60 * 1000 }, // 60 / min
    perIp: { maxRequests: 120, windowMs: 60 * 1000 }, // 120 / min
  },
  // Endgame training costs up to two engine searches and no provider call, identical to mistake
  // prediction. Its own bucket prevents training attempts from consuming ordinary analysis quota.
  endgameTraining: {
    perUser: { maxRequests: 20, windowMs: 60 * 1000 }, // 20 / min
    perIp: { maxRequests: 40, windowMs: 60 * 1000 }, // 40 / min
  },
  // Coaching is the most expensive request this API serves, so it gets the smallest budget.
  //
  // One accepted call costs at most four engine searches — the position at MultiPV 1, the position
  // after the played move at MultiPV 1, the position after the engine's preferred move at MultiPV 1,
  // and the position again at MultiPV 3 for tactic discovery — plus one provider call. The
  // MultiPV 1 search of the position is issued twice, by two different feature services, and
  // `RequestScopedAnalysis` collapses it; without that de-duplication the same request would be five
  // searches.
  //
  // `mistakePrediction` and `endgameTraining` cost two searches and no provider call, and are set
  // at 20/min. Eight is that budget scaled by the ratio of the work, not a number chosen by feel:
  // four searches is twice two, and the provider call is the part with a bill attached. The per-user
  // limit is the one that binds; the per-IP limit is twice it so that a shared NAT is not treated as
  // a single abuser, matching every other bucket in this file.
  coach: {
    perUser: { maxRequests: 8, windowMs: 60 * 1000 }, // 8 / min
    perIp: { maxRequests: 16, windowMs: 60 * 1000 }, // 16 / min
  },
  // Tournament commentary costs at most one engine search and one provider call — exactly move
  // explanation's bill — so it gets exactly move explanation's budget. The number is copied because
  // the cost is the same, not because the feature feels similar: a round recap runs no search at
  // all, and a game commentary runs one MultiPV 1 search of a position that a finished game has
  // already settled.
  //
  // Both routes share the bucket. They are two questions about one tournament and a caller who has
  // spent their minute on recaps has spent the provider budget the commentaries would have used;
  // splitting them would publish two ceilings for one bill.
  tournamentCommentary: {
    perUser: { maxRequests: 10, windowMs: 60 * 1000 }, // 10 / min
    perIp: { maxRequests: 30, windowMs: 60 * 1000 }, // 30 / min
  },
  // A review can run up to eighty fixed-policy searches (two for each of forty player moves), so
  // its own low-volume bucket prevents one account from monopolising the shared engine pool.
  gameReview: {
    perUser: { maxRequests: 2, windowMs: 10 * 60 * 1000 }, // 2 / 10 min
    perIp: { maxRequests: 6, windowMs: 10 * 60 * 1000 }, // 6 / 10 min
  },
};

/** Partial config as accepted from callers. */
export type ApiConfigInput = Partial<ApiConfig>;

/**
 * Enforce the {@link CorsConfig} invariants (see ADR-0011). The CORS middleware
 * reflects exact origins and never emits `*`, so a wildcard entry would silently
 * never match; and credentials without any allowed origin is a misconfiguration.
 * Failing fast here turns both footguns into a clear startup error.
 */
function validateCors(cors: CorsConfig): void {
  if (cors.allowedOrigins.includes('*')) {
    throw new Error(
      "resolveConfig: cors.allowedOrigins must not contain '*' — the API reflects " +
        "exact origins (never a wildcard). List explicit origins instead.",
    );
  }
  if (cors.allowCredentials && cors.allowedOrigins.length === 0) {
    throw new Error(
      'resolveConfig: cors.allowCredentials is true but cors.allowedOrigins is empty — ' +
        'no origin could ever use credentials. Add explicit origins or disable credentials.',
    );
  }
}

/**
 * Resolve the runtime refresh-cookie transport policy.
 *
 * Insecure cookies require two explicit signals: the cookie setting itself and
 * the established development environment. This keeps a missing setting safe
 * and turns a production typo into a startup failure instead of a downgrade.
 * Programmatic `ApiConfigInput.cookieSecure` remains authoritative for trusted
 * compositions such as the in-memory test harness.
 */
function resolveRefreshCookieSecure(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (configured !== undefined) return configured;

  const setting = env['REFRESH_COOKIE_SECURE'];
  if (setting === undefined || setting === 'true') return true;
  if (setting !== 'false') {
    throw new Error('resolveConfig: REFRESH_COOKIE_SECURE must be either "true" or "false"');
  }
  if (env['NODE_ENV'] !== 'development') {
    throw new Error(
      'resolveConfig: REFRESH_COOKIE_SECURE=false is allowed only when NODE_ENV=development',
    );
  }
  return false;
}

/**
 * Resolve a full {@link ApiConfig} from partial input, applying defaults. The
 * access-token secret falls back to `ACCESS_TOKEN_SECRET` in the environment.
 * Throws if no secret can be resolved or the CORS config is invalid.
 */
export function resolveConfig(
  input: ApiConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const accessTokenSecret = input.accessTokenSecret ?? env['ACCESS_TOKEN_SECRET'] ?? '';
  if (!accessTokenSecret) {
    throw new Error(
      'resolveConfig: accessTokenSecret is required (set it directly or via ACCESS_TOKEN_SECRET)',
    );
  }
  const cors = input.cors ?? DEFAULT_CORS;
  validateCors(cors);
  const trustProxy = input.trustProxy ?? resolveTrustProxyEnv(env['TRUST_PROXY']);
  validateTrustProxy(trustProxy);
  return {
    accessTokenSecret,
    accessTokenTtlSec: input.accessTokenTtlSec ?? DEFAULT_ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: input.refreshTokenTtlSec ?? DEFAULT_REFRESH_TOKEN_TTL_SEC,
    maxBodyBytes: input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    trustProxy,
    cors,
    enableHsts: input.enableHsts ?? true,
    cookieSecure: resolveRefreshCookieSecure(input.cookieSecure, env),
    rateLimit: input.rateLimit ?? DEFAULT_RATE_LIMIT,
    webauthn: input.webauthn ?? {
      rpId: env['WEBAUTHN_RP_ID'] ?? 'localhost',
      origins: (env['WEBAUTHN_ORIGINS'] ?? 'http://localhost:3000').split(','),
    },
  };
}
