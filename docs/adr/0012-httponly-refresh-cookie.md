# ADR-0012: httpOnly refresh-token cookie

- **Status:** Accepted
- **Date:** 2026-07-15
- **Supersedes:** None
- **Builds on:** [ADR-0011 (CORS + security headers)](0011-cors-security-headers.md)

## Context

The Gambit web client (M6) persisted the entire session — including the
long-lived refresh token — to `localStorage`. This created an **XSS
exfiltration risk**: any injected script could read `localStorage` and steal
the refresh token, gaining persistent access to the user's account even after
the access token expired.

The access token (short-lived, ~15 min) was also stored in `localStorage`
via the `WebStorageTokenStore`, though its short lifetime limited the exposure window.

M12 increment 1 (ADR-0011) added a credentials-aware CORS allowlist that
reflects exact origins and supports `allowCredentials: true`. This enables
the browser to send and receive cookies for cross-origin API requests, which
is the foundation for the httpOnly cookie approach.

## Decision

Move the refresh token from `localStorage` to an **`httpOnly` cookie** set by
the API on login/refresh. The short-lived access token stays **in memory only**
(never persisted to `localStorage` or a cookie).

### Cookie attributes

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| `HttpOnly` | yes | **XSS mitigation:** JavaScript cannot read the cookie, so an injected script cannot exfiltrate the refresh token. |
| `SameSite=Strict` | yes | **CSRF mitigation:** the cookie is not sent on cross-site requests (top-level navigations or embedded subrequests). Combined with the credentials-aware CORS allowlist from ADR-0011 (never `*`), this provides defense-in-depth against CSRF. |
| `Secure` | configurable | Default `true` (production). Trusted compositions may set `ApiConfig.cookieSecure=false`; the runtime accepts `REFRESH_COOKIE_SECURE=false` only with `NODE_ENV=development` for local HTTP. |
| `Path=/v1/auth` | yes | **CSRF surface reduction:** the cookie is scoped to auth routes only, so it is not sent on other API requests (e.g. game moves, seek creation). |
| `Max-Age=<ttl>` | refresh-token TTL | Matches the refresh-token lifetime (default 30 days). |

### Token storage summary

| Token | Location | Readable by JS? | Persisted across reloads? |
|-------|----------|-----------------|--------------------------|
| Access token (short-lived) | In memory only | Yes (but short-lived) | **No** — repopulated via refresh on reload |
| Refresh token (long-lived) | httpOnly cookie; API-compatible JSON responses can also expose a transient in-memory copy | Cookie: **No**; JSON copy: yes | Yes via cookie; the JSON copy is not persisted |

### API changes

1. **Login and register** set the refresh token as an `httpOnly` cookie via
   `Set-Cookie`.
2. **POST /v1/auth/refresh** and **POST /v1/auth/logout** accept the refresh
   token from **either the cookie or the JSON body**, preferring the cookie.
   This keeps non-browser API clients (CLI tools, server-to-server) working
   without modification.
3. **Logout** (and refresh-reuse/theft revocation) clears the cookie
   (`Set-Cookie: ...; Max-Age=0`).
4. The refresh token is **still returned in the JSON response body** for
   non-browser API clients. The shared browser client parses that response and may retain the
   compatibility copy in memory, but never persists it or uses it for cookie-based refresh.

### Web changes

1. `SessionManager` (`net/session.ts`) no longer persists **any** token to
   storage. The `WebStorageTokenStore` class has been removed entirely. Only
   `MemoryTokenStore` is used — the access token lives in memory only and is
   repopulated on reload via the httpOnly refresh cookie.
2. `AuthController` (`app/auth-controller.ts`) no longer persists the access
   token. Only `{handle, userId}` is stored. On reload, `restore()` calls
   `client.auth.refresh()` which uses the httpOnly cookie to get a fresh access
   token.
3. `GambitClient` (`api/client.ts`) sends `credentials: 'include'` on login,
   register, refresh, and logout so the browser sends/receives the cookie.
   The refresh token is **not** sent in the request body for the browser flow.
4. `TokenPair.refreshToken` in `api/models.ts` is optional (`?: string`) so
   cookie-only responses and non-browser-compatible JSON responses share one model.

### CSRF stance

The cookie is auto-sent by the browser, which introduces a CSRF consideration.
We mitigate this with:

1. **`SameSite=Strict`** — the cookie is not sent on cross-site requests at all
   (not even top-level navigations from another origin). This is the strongest
   SameSite setting.
2. **Credentials-aware CORS allowlist** (ADR-0011) — the API reflects exact
   origins and never emits `*`. Only explicitly allowed origins can make
   credentialed requests. A wildcard entry would silently never match.
3. **`Path=/v1/auth`** — the cookie is scoped to auth routes only, reducing the
   surface where the cookie is auto-sent.

We do **not** weaken CORS to `*`.

### Non-browser API clients

Non-browser clients (CLI tools, server-to-server integrations) that cannot use
cookies continue to work by sending the refresh token in the JSON body. The API
accepts both:

- **Cookie path (browser):** `POST /v1/auth/refresh` with `Cookie:
  gambit_refresh=...` (sent automatically by the browser with
  `credentials: 'include'`).
- **Body path (non-browser):** `POST /v1/auth/refresh` with
  `{"refreshToken": "..."}` in the JSON body.

The cookie is preferred when both are present.

## Consequences

- **Positive:** The durable refresh credential is no longer persisted in JavaScript-readable
  storage; the httpOnly cookie itself cannot be exfiltrated by injected script.
- **Positive:** The access token is no longer persisted to `localStorage`,
  eliminating the XSS-exfiltration vector for the access token as well. On
  reload, a fresh access token is obtained via the httpOnly refresh cookie.
- **Positive:** Non-browser API clients continue to work without modification.
- **Negative:** Cross-origin deployments must configure CORS with explicit
  origins and `allowCredentials: true` (already supported by ADR-0011).
- **Negative:** Local development over plain HTTP must set `cookieSecure: false`
  so the browser accepts the cookie.
- **Residual:** Login and refresh responses still include the refresh token in
  the JSON body for non-browser API clients. The shared browser client parses that payload and can
  retain the copy in memory, where injected script could read it; it is never persisted, and the
  browser's refresh requests use the cookie exclusively. Removing this residual exposure requires
  a response contract that distinguishes browser and non-browser clients.

## Implementation

- Cookie helpers: `packages/api/src/http/cookie.ts` (dependency-free, Node
  built-ins only).
- Config: `ApiConfig.cookieSecure` (default `true`, resolved in
  `resolveConfig`). The production entrypoint also accepts the exact environment
  strings `REFRESH_COOKIE_SECURE=true|false`; `false` fails startup unless
  `NODE_ENV=development`. The local Compose stack additionally binds all published
  ports to `127.0.0.1`, so its non-Secure development cookie is not exposed off-host.
- Routes: `packages/api/src/routes.ts` (set/read/clear cookie on auth routes).
- Web: `packages/web/src/net/session.ts` (removed `WebStorageTokenStore`),
  `packages/web/src/app/composition.ts` (always uses `MemoryTokenStore`),
  `packages/web/src/api/client.ts`, `packages/web/src/app/auth-controller.ts`,
  `packages/web/src/api/models.ts`.
- Tests: `packages/api/test/cookie.test.ts`, `packages/api/test/cookie-auth.test.ts`,
  updated `packages/web/test/session.test.ts`, `packages/web/test/api-client.test.ts`,
  `packages/web/test/auth-controller.test.ts`.
