# Running Gambit Locally

This guide covers the **local runnable stack** (introduced in M14 Increment 1): a single
`docker compose up` command that brings the entire platform live with real
Postgres, a real API, a real WebSocket gateway, and the web frontend.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (v2+)
- Postgres and nginx run inside containers — no local install needed
- [Node.js](https://nodejs.org/) 22+ on the host for dependency installation,
  builds, tests (including `test:counts`), or `scripts/smoke-test.mjs` outside
  containers. The smoke script uses the built-in `fetch` and `WebSocket` globals.

## Quick start

```bash
# 1. Copy the env template (optional — defaults work for local dev)
cp .env.example .env

# 2. Start the full stack
docker compose up --build

# 3. Open the browser
open http://localhost:3000
```

That's it. You can register a user, and the platform is live.

> **If the API image fails to build, or starts and immediately exits with `MODULE_NOT_FOUND`:** run
> `npm run check:build-order`. The container images build and copy their packages from lists that
> are maintained by hand, and those lists went stale once already — see ADR-0065. That check catches
> it in seconds and runs in CI, but it is the first thing to try if the stack will not come up.

## What runs

| Service | Container | Published host port | Description |
|---|---|---|---|
| **Postgres + pgvector** | `postgres` | `localhost:5432` | `pgvector/pgvector:pg16`, with the schema auto-migrated on API startup |
| **Redis** | `redis` | `localhost:6379` | Redis 7 durable pub/sub service for multi-node gateway fanout |
| **API** | `api` | not published | REST API (`@chess-platform/api`) reachable through the web edge at `localhost:3000/v1` |
| **Gateway** | `gateway` | not published | WebSocket gateway reached through the web edge at `localhost:3000/ws` |
| **Web** | `web` | `localhost:3000` | Vite-built SPA served by nginx, proxying `/v1` → API and `/ws` → gateway |

## How it works

### Postgres + migrations

The `postgres` service uses `pgvector/pgvector:pg16`, which supplies PostgreSQL
16 plus the vector extension required by the search migrations. The API
container runs `npm run migrate --workspace @chess-platform/persistence` before
starting the server, so the schema is applied automatically on first boot. The
`schema_migrations` table tracks applied migrations with checksums, so
re-starts are idempotent.

### API service

The API uses `packages/api/src/scripts/serve.ts`, which calls
`createPgApiServer()` from `bootstrap.ts` — the real, Postgres-backed
composition root. Config is entirely via environment variables:

- `DATABASE_URL` — Postgres connection string
- `ACCESS_TOKEN_SECRET` — HMAC signing secret (shared with the gateway)
- `PORT` — listen port (default 8080)
- `REFRESH_COOKIE_SECURE` — defaults to `true`; the local Compose stack explicitly sets `false`
  with `NODE_ENV=development` so browsers can use the refresh cookie over localhost HTTP. Compose
  binds every published port to `127.0.0.1`, keeping that non-TLS exception off the network.

Health check: `GET /v1/health` returns `{ status: "ok" }`.

### Gateway service

The gateway runs `services/gateway/src/serve.ts`, which creates a WebSocket
server wrapping the `RealtimeGateway`. Token verification uses the same
`ACCESS_TOKEN_SECRET` as the API — the gateway constructs its own
`AccessTokenService` to verify tokens locally (stateless HMAC, no API
round-trip). This is the `TokenVerifier` port from ADR-0004.

The gateway persists game events to the shared Postgres event store, so games
survive gateway restarts and rehydrate exactly. With `REDIS_URL` set (the Compose
default), Redis pub/sub fans authoritative broadcasts across gateway nodes;
without it, the gateway falls back to `InMemoryPubSub` for single-node use.
See ADR-0007 (local stack/durability) and ADR-0008 (Redis fanout).

The gateway health endpoint listens on container port 4176 (the WebSocket port
plus one) and is used by the Compose healthcheck. That port is not published to
the host by the primary Compose file.

**Play vs Computer** needs two things, and without either the lobby still offers the mode while the
opponent never moves: `ENGINE_BOT=1`, and an engine binary at `STOCKFISH_PATH`. The gateway image
ships a pinned Stockfish 16 at `/usr/local/bin/stockfish`, and both Compose and the Helm chart
(`gateway.engineBot.enabled`, default `true`) set `ENGINE_BOT`, so either gives you a working
opponent. With `ENGINE_BOT` unset nothing is logged; with it set but `STOCKFISH_PATH` unset the
gateway logs `ENGINE_BOT requires an engine binary (set STOCKFISH_PATH)` at startup; with a path to
a missing binary each bot move fails with `[EngineBotMover] Bot move failed`. Confirm with:

```bash
docker compose logs gateway | grep "EngineBotMover is enabled"
```

**On an arm64 workstation** (Apple Silicon, ARM Linux) the `api` and `gateway` services build as
`linux/amd64` under emulation, which Compose is configured for. Stockfish release `sf_16` publishes
no arm64 build, so the alternative would be no engine at all. Expect the first build and the engine
itself to be slower than native; everything works, and nothing about the published production images
changes — they have always been amd64. Docker Desktop users on Apple Silicon should enable Rosetta
(*Settings → General → Use Rosetta for x86/amd64 emulation*), which makes the difference small.

### Web service

The web container builds the SPA with `vite build` and serves the static output
via nginx. Nginx proxies:
- `/v1/*` → `api:8080` (REST API)
- `/ws` → `gateway:4175` (WebSocket, with upgrade headers)

The frontend's `resolveConfig()` derives API and WS URLs from the page origin,
so it works automatically when served from the same host.

### Front-end dev server

For UI work you can run Vite directly instead of rebuilding the container:

```bash
npm run dev --workspace @chess-platform/web   # http://127.0.0.1:5173
```

Because `resolveConfig()` uses the page origin, the app calls `/v1/...` on the dev server itself,
so the dev server proxies `/v1` and `/ws` to a backend you are already running — by default direct
test ports (`api` on 8080, `gateway` on 4175). Expose those ports with the explicit chaos/developer
override rather than weakening the normal Compose edge boundary:

```bash
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d postgres redis api gateway
```

Point elsewhere with `GAMBIT_DEV_API_URL` / `GAMBIT_DEV_WS_URL`. Without the proxy every API call
returns 404 from Vite — registering an account answers `HTTP 404`, which looks like a broken backend
rather than a missing proxy.

## Smoke test

A smoke test script is provided at `scripts/smoke-test.mjs`. It verifies the
full stack end-to-end:

```bash
# Start the stack first
docker compose up -d --build

# Run the smoke test
node scripts/smoke-test.mjs
```

The script:
1. Waits for all health checks to pass
2. Registers a user over the real REST API
3. Creates a seek
4. Opens a WebSocket connection to the gateway with the auth token
5. Confirms the WS connection is accepted

## Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `ACCESS_TOKEN_SECRET` | `dev-secret-...` | Yes (≥32 bytes) | HMAC secret shared between API and gateway |
| `POSTGRES_PASSWORD` | `gambit_dev` | No | Postgres password |
| `DATABASE_URL` | derived from `POSTGRES_PASSWORD` | No | Postgres connection string for the API container; Compose builds this automatically — do not set it yourself |
| `PORT` | `8080` | No | API host port in the explicit chaos/developer override; not published by the normal stack |
| `GATEWAY_PORT` | `4175` | No | Gateway host port in the explicit chaos/developer override; not published by the normal stack |
| `WEB_PORT` | `3000` | No | Web frontend host port |
| `ENGINE_BOT` | `1` in Compose and Helm (`gateway.engineBot.enabled`) | No | Set to `"0"` (Helm: `gateway.engineBot.enabled=false`) to disable the autonomous engine bot mover in the gateway (ADR-0080) |
| `STOCKFISH_PATH` | `/usr/local/bin/stockfish` in the gateway image | Required if `ENGINE_BOT=1` outside the image | Path to the Stockfish UCI executable binary |
| `EMAIL_PROVIDER` | `console` in Compose | Yes | `console` is explicit development-only; production requires `resend` |
| `RESEND_API_KEY` | none | Production | Resend credential; inject through a secret manager and never log it |
| `EMAIL_FROM` | none | Production | One plain sender address |
| `PUBLIC_WEB_ORIGIN` | none | Production | Trusted HTTPS origin for reset/verification fragment links |
| `EMAIL_TIMEOUT_MS` | `5000` | No | Provider timeout, integer 100–30000 ms |
| `REFRESH_COOKIE_SECURE` | `true` (`false` in Compose) | No | Exact boolean string controlling the refresh cookie's `Secure` attribute. `false` is accepted only with `NODE_ENV=development`. |


**Never commit real secrets.** The `.env.example` has development defaults only.

## Stopping

```bash
docker compose down          # stop containers
docker compose down -v       # stop + delete the Postgres data volume
```

## Host build, tests and live counts

For tests outside Docker, use Node.js 22+ and run these commands **from the repository root**:

```bash
npm ci                           # root workspace dependencies, from package-lock.json
npm run build                    # public packages/*/dist outputs, in dependency order
npm ci --prefix services/gateway # standalone dependencies, from its own package-lock.json
npm run test:counts              # execute and count workspace + gateway service tests
```

Root workspaces are `packages/*`. Root `npm ci` does not install `services/gateway`,
and root `npm run build` does not compile it. The service deliberately has its own
dependency tree and lockfile; its `file:../../packages/...` dependencies link to local
workspace packages, whose public JavaScript and type entries point at `dist/`.
Installing those links does not build their targets. Workspace tests compile into
`dist-test/`, which does not replace the public `dist/` build.

`test:counts` runs the workspace tests and `npm test --prefix services/gateway`.
It does not install dependencies or run production builds. For separate checks after
the setup above:

```bash
npm test                                # root workspace tests
npm run lint                            # root workspace typecheck
npm test --prefix services/gateway       # compiles and tests gateway dist-test/
npm run build --prefix services/gateway  # compiles gateway dist/ for npm start
```

A gateway production build is not a prerequisite for its test command. Redis-backed
tests skip when `REDIS_URL` is unset, but their static `ioredis` imports still require
the gateway dependencies at compilation and module-loading time. Skips are reported
separately and do not prove the Redis integration. With a test Redis instance available
at `REDIS_URL`, `npm run test:gateway-redis` runs the gateway build and test suite.

If `gateway-service: ERROR` includes `Cannot find module 'ioredis'`, run the separate
gateway install above. Missing `@chess-platform/...` modules or type declarations on
a fresh checkout require the root install and build as well. A root build alone cannot
supply `ioredis`. Rerunning root `npm ci` in a prepared checkout retains gateway
dependencies and existing build outputs, so that is not equivalent to a fresh clone.
Docker prepares dependencies inside its images; it does not prepare host `node_modules`.

## Running the CI checks locally

`npm run ci:local` runs what `.github/workflows/ci.yml` runs — build, typecheck, test, and the
check scripts — on your machine. It exists for when Actions is unavailable (an outage, an exhausted
minutes quota, a fork without Actions, no network), and `npm run check:ci-parity` fails the build
if the runner and the workflow ever disagree, so it stays a preview of CI rather than a second
suite of its own.

Complete the [host setup above](#host-build-tests-and-live-counts) first. The local
runner executes builds and checks, but assumes dependencies are already installed;
it performs neither the root install nor the separate gateway install.

```bash
npm run ci:local --quick     # everything that needs no services
```

The two service-backed jobs need a real Postgres and Redis, the same way CI gives them containers:

```bash
docker compose up -d postgres redis

# One-time: a disposable database. These suites assume they are alone in it, so a second run
# against a dirty database fails on rows the first one inserted — which looks exactly like a
# regression and is not one. The runner insists the name contain `test` and never drops anything
# itself.
docker exec shatarang-postgres-1 psql -U gambit -d postgres \
  -c "CREATE ROLE chess LOGIN PASSWORD 'chess' SUPERUSER" -c "CREATE DATABASE chess_test OWNER chess"

DATABASE_URL=postgres://chess:chess@localhost:5432/chess_test \
REDIS_URL=redis://localhost:6379 \
  npm run ci:local
```

A job that cannot run is reported as `SKIPPED` with the reason, and the closing summary says how
many did not run. Skipped is never counted as passed. Two jobs stay CI-only by decision — the
Playwright e2e run and the Lighthouse a11y audit — and the runner names them every time. See
ADR-0105.

## Architecture notes

- **Durable authority + multi-node fanout:** The gateway persists the
  authoritative game event log in Postgres, so game state survives gateway
  restarts and rehydrates on demand. Redis pub/sub, enabled via `REDIS_URL`,
  fans broadcasts across gateway replicas; omitting `REDIS_URL` selects the
  in-memory single-node fallback. Sharded authority remains a later M14 step.
- **No secrets in the repo:** All secrets come from environment variables.
  The `.env.example` has development-only defaults.
- **Multi-stage Dockerfiles:** Each Dockerfile builds in a full Node image and
  runs a lean runtime image, keeping image sizes reasonable.
- **Health-gated startup:** Compose uses `depends_on` with `condition:
  service_healthy` so services start in order: Postgres → API → gateway → web.
