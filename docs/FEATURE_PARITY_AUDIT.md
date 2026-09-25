# Gambit feature-parity audit

- Original audit date: 2026-07-19
- Original target: `main` at `9b7aad4`, plus the fixes listed below
- Original environment: production Docker Compose stack at `http://localhost:3000`
- Reconciled through: M14 Increment 48 and the audit P1 remediation

The original audit provenance and browser findings are retained below. Feature
rows and follow-up dispositions have been reconciled with later shipped work;
[`ROADMAP.md`](ROADMAP.md) and [`PROJECT_STATE.md`](PROJECT_STATE.md) remain the
canonical sources for current milestone and increment status.

This audit distinguishes four different meanings of “implemented”:

1. **Domain/library** — code and unit tests exist.
2. **Runtime/API** — the production Compose services expose and execute it.
3. **Web client** — the browser client has an adapter/controller for it.
4. **Visible UI** — a user can discover and use it on the website.

Having a package in the monorepo does not imply that it is a product feature.

## Feature matrix

| Feature | Domain/library | Runtime/API | Web client | Visible UI | Audit result |
|---|---:|---:|---:|---:|---|
| Chess rules, legal moves, terminal detection | Yes | Yes | Yes | Yes | Standard play verified through a real browser move; the variant selector exposes all eight implemented variants. |
| Server-authoritative clocks and event-sourced games | Yes | Yes | Yes | Yes | Real matched game returned authoritative clocks and position over `/ws`. |
| Click/drag, legal highlights, promotion, premove, board flip | Yes | Yes | Yes | Yes | Board renders 64 squares/32 pieces; `e2-e4` and server legal highlights verified. Promotion and premove remain covered by automated tests. |
| Resign, draw offer/accept/decline, abort, claim flag | Yes | Yes (WebSocket commands) | Yes | Yes | Actions are fully exposed in the game sidebar with proper state sync and confirmation flows. Resign and draw offer/accept flows are E2E-verified; others are covered at the component/unit level. |
| Presence, spectator role, reconnect/resume | Yes | Yes | Yes | Yes | Connection status, player metadata, live clocks, and spectator counts are exposed in the game UI. |
| Password register/login/logout | Yes | Yes | Yes | Yes | Visible and exercised; refresh cookie restores the session. |
| Session list/revocation | Yes | Yes | Yes | Yes | Shipped in M14 Increment 46. The Runtime/API column previously read `Yes` for *revocation* as well, which was wrong: `GET /v1/auth/sessions` existed but no route revoked a session — only `POST /v1/auth/logout`, which ends the caller's own session via its refresh token and cannot reach any other. `DELETE /v1/auth/sessions/:id` closes that gap, and the self-profile account-security panel lists active sessions with a per-row revoke control. |
| Password reset | Yes | Yes | Yes | Yes | Full SPA recovery UI at `/password-reset` with request and confirm forms, client validation, secret token URL stripping, and session clearance (ADR-0109). Outbound email delivery depends on deployment provider (`ConsoleEmailSender` default per ADR-0026). |
| Email verification | Yes | Yes | Yes | Yes | Shipped in M14 Increment 48 (ADR-0112). An optional email field on the registration form, and a public `/email-verify` route that consumes the link's token from the URL **fragment** (`#token=...`, which browsers never transmit; this increment moved `/password-reset` off its query-string transport too, because a query string reaches the web tier's access log before any script can run). The token is captured into route-local memory and cleared from the URL with `history.replaceState` before any background request, never rendered or logged, and released after a terminal outcome so it cannot be replayed. Covers success, invalid/expired/already-used, missing token, and one controlled retry on transient failure. No resend affordance, and verification status is not surfaced anywhere because no public model exposes it. Outbound delivery still depends on the deployment provider (`ConsoleEmailSender` default per ADR-0026), so opening a link from a real email client stays manual QA. Since M15 Increment 67 (ADR-0145) the registration email is required, and password sign-in needs it verified. |
| WebAuthn/passkeys | Yes | Yes | Yes | Yes | Current tree implements typed registration/login/list/delete wiring, an injectable native browser adapter, passkey sign-in, and self-profile management (ADR-0108). Automated browser-boundary tests cover the ceremony wiring; a deployed secure-context authenticator was not part of this older live audit. |
| Profiles, ratings and recent games | Yes | Yes | Yes | Yes | Profile session race fixed; `/profile` now loads the signed-in user correctly. |
| Leaderboard | Yes | Yes | Yes | Yes | `GET /v1/leaderboard/:variant` exposed as SPA page at `/leaderboard` with variant selector populated by an app-layer labels module, optional GraphQL handle resolution, shortId fallback, stale request protection, two-child row rendering, semantic loading/list behavior, and composite view disposal. |
| Seek creation, cancellation, acceptance and atomic game provisioning | Yes | Yes | Yes | Yes | Creation and acceptance are verified end-to-end with two users and real PostgreSQL provisioning. Cancellation is API-tested but has no end-to-end cancellation test. |
| Play against a bot | Yes | Yes | Yes | Yes | Engine bot service (`POST /v1/games/bot`) and Play vs Computer dialog shipped (ADR-0080, ADR-0081). |
| Engine/UCI analysis | Yes | Yes | N/A | No | Both halves of this row were stale. Compose has started an engine worker since ADR-0102 — `Dockerfile.gateway` installs Stockfish and the gateway hosts an `EngineManager` for the bot mover and anti-cheat. And `POST /v1/analysis` now exists (ADR-0113), served by a **separate** analysis pool in the API so user analysis cannot starve live bot moves: authenticated, per-user rate limited, with hard server-side limits and an unconditional wall-clock ceiling. No UI consumes it yet, which is what the Web column records. |
| AI provider orchestration | Yes | Yes | N/A | No | Composed in production as of ADR-0115: `createAiFromEnv` builds an `AiOrchestrator` from `AI_*` variables over the existing OpenAI-compatible and Anthropic adapters, with routing, failover, cache and grounding. Registered statically, so boot performs no provider network call. Reachable only through Move Explanation below — no general-purpose completion endpoint exists, which is what the Web column records. Real-provider tests remain key-gated; CI is hermetic. |
| Move explainer | Yes | Yes | N/A | Yes | `POST /v1/ai/move-explanation` (ADR-0115), consumed by an "Explain last move" control in the game sidebar (ADR-0117): authenticated, per-user rate limited, engine-grounded on the ADR-0113 pool. Model prose and the structured engine citation render as visibly separate evidence, and a game-ending move is reported as a result rather than an evaluation (ADR-0116). Limited to moves the client replayed itself — explaining arbitrary past moves is a later increment. |
| Puzzle generator | Yes | No | No | No | Library/test implementation only. |
| Mistake predictor | Yes | Yes | N/A | Yes | `POST /v1/analysis/mistake-prediction` (ADR-0118), consumed by an "Assess last move" control in the game sidebar. Classifies a move as ok/inaccuracy/mistake/blunder from the rules and one or two searches on the ADR-0113 pool — **no AI provider is on this path**, so it is available on any deployment with an engine, unlike Move Explainer above. Thresholds are server-owned and unreachable from a request. Productionising it fixed four correctness defects in the M8 library, the worst of which classified delivering checkmate as a blunder. Limited to moves the client replayed itself, same as Move Explainer. |
| Opening explorer | Yes | No | No | No | Bundled data and library exist; no endpoint/page. |
| Endgame trainer | Yes | No | No | No | Bundled data and library exist; no endpoint/page. |
| Coach, study partner and voice coach | Yes | No | No | No | Ports and hermetic tests exist; no browser speech adapters or product workflow. |
| Round-robin, Swiss and Arena tournaments | Yes | Yes | Yes | Yes | Full REST lifecycle, live view, tournament client adapter, and UI views shipped (ADR-0082). |
| Tournament live broadcast/commentary | Yes | Partial | No | No | Live boards/result reporter run; AI commentary is not composed into a production service. |
| PWA/offline shell | Yes | Yes | Yes | Yes | Manifest/service worker and offline-navigation acceptance test pass. |
| Light/dark theme | Yes | Yes | Yes | Yes | Fixed: explicit light preference now overrides a dark OS preference and updates icon/ARIA/theme-color. |
| Social features (teams, friends, chat, forums, achievements) | Yes | Partial | Yes | Yes when enabled | Domain and REST work shipped in M10; profile social controls, messages, teams/forums, and achievements UI shipped in later M14 web increments. Optional repositories remain capability-gated by deployment configuration. |
| Learning content, PGN import and collaborative studies | Yes | Partial | Yes | Yes when enabled | Courses/lessons and studies/PGN have durable adapters, REST contracts, typed clients, and visible web routes. Studies and learning repositories are opt-in in the production composition root. |
| Search | Yes | Yes | Yes | Yes | Keyword, semantic, and hybrid search, indexing/backfill, `GET /v1/search`, and the `/search` UI are shipped. |
| CORS, security headers, httpOnly refresh and rate limiting | Yes | Yes | N/A | Indirect | M12 controls cover the API; the served web document also emits anti-framing and related security headers after the audit P1 remediation. |
| Anti-cheat/bot detection/pen-test | Yes | Yes | No | No | M12 is closed: moderation APIs and background analysis workers are production-hostable, and the pen-test findings are recorded in [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). No moderator web UI is shipped. |
| Docker Compose | Yes | Yes | N/A | N/A | Full stack healthy after Dockerfile, healthcheck and WebSocket proxy fixes. |
| Kubernetes Helm | Yes | Packaging only | N/A | N/A | Chart exists; no live cluster deployment was part of this local audit. |
| Terraform, canary/blue-green, large load/chaos | No | No | N/A | N/A | Remaining M14 work. |
| OpenTelemetry, Prometheus, Grafana, SLOs | Yes | Partial | N/A | Operational assets | M13 is closed with tracing/export, Prometheus rules, Grafana dashboards, SLOs, runbooks, and drift validation. The primary Compose file does not start Prometheus or Grafana, and SLO targets remain explicitly unvalidated against production traffic. |

## Defects found and fixed during this audit

1. Light mode only removed `.dark`; on a dark-system browser all colour tokens
   stayed dark. The app now applies an explicit `.light` state, persists it,
   updates the action icon/label, and has a browser regression test.
2. `/profile` requested `/v1/users/me` before the asynchronous refresh-cookie
   restore finished, producing `no active session` for a signed-in user. The
   profile now waits for the authenticated session and also reacts to a later
   sign-in.
3. `Flip` and “Skip to board” appeared on routes with no board. They are now
   game-route-only controls.
4. Browser WebSocket upgrades through nginx were all rejected with HTTP 401.
   nginx forwarded `$host` (`localhost`) while the browser Origin was
   `localhost:3000`; it now forwards `$http_host` and preserves the port.
5. The official Compose smoke test had drifted from the API contract (old token
   path and old time-control body), only tested a direct gateway port, and did
   not provision a real matched game. It now registers two players, atomically
   accepts a seek, and joins the game through the same nginx `/ws` path and
   Origin policy used by browsers.
6. A malformed public game id caused PostgreSQL UUID error `22P02` and an HTTP
   500. `PgGamesRepository.findById` now treats malformed ids as not found; a
   real-Postgres regression test covers it.
7. The API and gateway runtime images were missing required workspace build and
   runtime dependencies; the Compose web healthcheck used a container-local
   hostname that failed on this image. The Dockerfiles/healthcheck were fixed.

## Verification performed on the original audit target

- Full monorepo production build, test, and strict TypeScript lint commands passed.
- Web unit, static/offline Playwright, and backend-gated Playwright suites passed;
  environment-gated cases were reported separately rather than counted as passes.
- Dedicated real-Postgres persistence and API suites passed.
- Compose smoke test through nginx `/ws`: passed.
- Manual real-browser acceptance: theme both ways, restored profile, seek
  creation, second-user acceptance, route to game, authenticated WebSocket,
  64-square board, legal `e2` destinations, and authoritative `e2-e4` update.

## Original follow-ups and current disposition

1. [Shipped] Add game metadata/presence to the UI to make a match manageable without hidden protocol calls. Game controls (resign, draw, abort, claim flag) are already implemented.
2. [Shipped] Add production bot service + `Play bot` (ADR-0080, ADR-0081).
3. [Shipped] Expose passkeys and password recovery through real pages and typed web clients (ADR-0108 and ADR-0109).
4. Compose an engine worker and AI feature API before advertising any AI
   feature; then build analysis, puzzles, openings/endgames, coach and voice UI.
5. Add a Compose-based browser acceptance job. The current backend Playwright
   tests use the e2e harness, which is why the production nginx 401 escaped.
6. [Partially shipped] Repeated-navigation controller, authentication, WebSocket,
   and connectivity cleanup landed in the audit P1 remediation. A dedicated
   user-facing not-found page remains open.
7. [Updated] M10 and M11 now have delivered domain, persistence, API, and web
   increments; M12 and M13 are closed. The deferred M14 scale items remain open
   in `ROADMAP.md`.
