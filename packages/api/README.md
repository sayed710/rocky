# `@chess-platform/api`

The stateless REST + identity service for Gambit. It consumes
`@chess-platform/persistence` (repositories, Glicko-2, UUIDv7) and the domain
packages (`@chess-platform/game`, `@chess-platform/core`), and exposes a typed,
dependency-free HTTP API with a published OpenAPI 3.1 contract.

## Design

- **Node built-in HTTP + a typed router.** No web framework. Routes couple their
  OpenAPI contract, auth policy, and handler in one place; handlers receive a
  `RequestContext` and return a `HandlerResult` (they never touch the socket).
- **Dependency injection via `createApiServer(deps)`.** Repositories, the
  password hasher, the token service, the clock, and the id generator all arrive
  explicitly — no module-level singletons. Tests wire in-memory fakes; production
  wires Postgres. The code in between is identical.
- **Provider-agnostic identity.**
  - `PasswordHasher` abstraction with a built-in **scrypt** default
    (`ScryptPasswordHasher`). The stored hash is a self-describing string, so
    swapping in argon2id or a KMS is a one-line injection with no data migration.
  - **HMAC-SHA256 (HS256) access tokens** — self-contained, verified with no
    database round-trip, so the service scales horizontally.
  - **Opaque refresh tokens**, stored only as a SHA-256 hash, **single-use with
    rotation**. A near-simultaneous replay inside the bounded grace window is
    rejected without revoking the successor; replay outside that window is
    treated as theft and revokes every active session chain for the account.
- **RBAC** (`user`, `coach`, `tournament_director`, `moderator`, `admin`)
  enforced declaratively per route and re-checked in handlers where ownership
  matters (e.g. seek cancellation).
- **Minimal dependencies.** Everything is `node:crypto` / `node:http`; the root
  entry pulls in no third-party runtime dependency. Postgres wiring is isolated
  behind the `@chess-platform/api/pg` subpath.

## API surface (v1)

The route table in [`src/routes.ts`](src/routes.ts) is the implementation source
of truth. It generates the committed [`openapi.json`](openapi.json), which is
also served at `GET /v1/openapi.json`; use that contract for the exact current
methods, paths, authentication policies, request bodies, and response schemas.

The published surface is organized into these families:

- service metadata, health/readiness, capabilities, metrics, and OpenAPI;
- password, refresh-token, email-verification, password-recovery, and WebAuthn
  identity flows;
- users, roles, ratings, leaderboards, seeks, games, and tournaments;
- keyword/semantic search and the read-only GraphQL layer;
- social graph, direct messaging, teams/forums, and achievements;
- collaborative studies/PGN and courses/lessons/progress; and
- moderation endpoints for anti-cheat and bot-detection reports and analysis.

## Quick start (in-memory, no database)

Set `ACCESS_TOKEN_SECRET` to a development secret of at least 32 bytes before
running this example. No database is required.

```ts
import {
  createApiServer, createInMemoryRepositories, resolveConfig,
  ScryptPasswordHasher, AccessTokenService, systemClock, uuidv7Generator,
  InMemoryRateLimiter, InMemoryGameLauncher, ConsoleEmailSender,
} from '@chess-platform/api';

const clock = systemClock;
const ids = uuidv7Generator;
const config = resolveConfig({ accessTokenSecret: process.env.ACCESS_TOKEN_SECRET! });
const tokens = new AccessTokenService({
  secret: config.accessTokenSecret, ttlSec: config.accessTokenTtlSec, clock, ids,
});
const repos = createInMemoryRepositories(clock);

const server = createApiServer({
  repos,
  hasher: new ScryptPasswordHasher(),
  tokens, clock, ids, config,
  rateLimiter: new InMemoryRateLimiter(clock),
  tournamentRepo: repos.tournaments,
  gameLauncher: new InMemoryGameLauncher(ids),
  liveView: { activeGames: () => [] },
  emailSender: new ConsoleEmailSender(),
  studiesRepository: repos.studies,
  learningRepository: repos.learning,
});

await server.listen(8080);
```

## Production (Postgres)

Requires `ACCESS_TOKEN_SECRET`, `DATABASE_URL`, and a valid production email configuration:
`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_WEB_ORIGIN`. There is no
production console fallback. `PUBLIC_WEB_ORIGIN` is the trusted HTTPS origin used for reset and
verification fragment links; it is never derived from request headers.

```ts
import { createPgApiServer } from '@chess-platform/api/pg';

const { server, pool } = createPgApiServer();
await server.listen(Number(process.env.PORT ?? 8080));
// pool.end() on shutdown
```

Or run the bundled entrypoint: `npm run serve`.

**Migrate first.** Neither of these applies migrations — only the container image does, from
`Dockerfile.api`'s `CMD`, and Kubernetes from the chart's `migrate` init container. Started by hand
against a database that has never been migrated, the API boots and answers `GET /v1/health`, and
then every request that touches the schema fails: `POST /v1/auth/login` rate-limits before it
authenticates, so it dies on `rate_limit_buckets` (migration 0004) with a 500 that says nothing
about the cause. `GET /v1/ready` is the one that will tell you — it returns 503 until the schema
matches this build. Run the canonical runner first:

```bash
DATABASE_URL=... npm run migrate --workspace @chess-platform/persistence
```

## Build, test, publish spec

```bash
cd packages/api
npm install
npm run build      # tsc -> dist/
npm test           # compiles + runs the suite via node --test
npm run openapi    # regenerates ./openapi.json from the live route table
```

The suite covers auth flows, the authorization matrix, token/scrypt units,
router edge cases, resource families, and OpenAPI self-consistency. Run the
commands above for the current result.
