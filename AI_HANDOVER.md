# AI Handover — Gambit

> Quickstart for any engineer or AI agent continuing this project **from GitHub alone**.
> The detailed, living handover is [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — read it
> next. This file provides the 60-second orientation and enduring architectural guardrails.

## What this is

*Gambit* — an AGPL-3.0-or-later open-source chess platform (targeting feature parity with
Lichess and Chess.com, plus a first-class AI layer), built as an npm-workspaces monorepo
(`packages/*`), with deployable services (`services/gateway`) wired alongside. It maintains
a strict boundary between **strict-TypeScript, zero-external-dependency domain packages**
(rules, game authority, tournaments, social, search, learning) and **infrastructure adapters**
(`pg`, `ioredis`, `ws`, external AI SDKs) wired at application entry points. All package suites
execute via the built-in `node --test` runner.

## Where things are

- `docs/ARCHITECTURE.md` — target system architecture and core design principles.
- `docs/ROADMAP.md` — milestone definitions and acceptance criteria.
- `docs/PROJECT_STATE.md` — the **authoritative living handover**: active increment progress
  (including M15 hardening), architectural decisions, active defect tracking, and exact next steps.
  Updated after every increment.
- `docs/DATABASE.md` + `docs/adr/*` — approved data contracts and Architecture Decision Records.
- `docs/RUNNING.md` — local development stack (`docker compose up`).
- `docs/DEPLOYING.md` — Kubernetes / Helm deployment architecture (`deploy/helm/gambit`).
- `packages/*` — domain packages and service libraries (root npm workspaces).
- `services/gateway` — deployable realtime WebSocket gateway binary (wiring Postgres event log,
  Redis pub/sub, and connection management; standalone service outside root workspaces).

## Architecture & Milestone Overview

Milestone progress spans foundational core engines through active production hardening:

- **Foundations (M1–M9)**:
  - Rules engine (`@chess-platform/core` with perft verification across all eight supported variants, including standard chess).
  - Event-sourced game aggregate and deterministic clock model (`@chess-platform/game`).
  - Realtime edge gateway with token authentication and pub/sub ports (`@chess-platform/realtime-gateway`).
  - PostgreSQL persistence, event store, and Glicko-2 ratings (`@chess-platform/persistence`).
  - Stateless REST API, identity, and RBAC (`@chess-platform/api`).
  - Provider-agnostic UCI engine bridge (`@chess-platform/engine`, with pools for Stockfish and Fairy-Stockfish, persistent Postgres analysis cache seam, and priority scheduling; remote distributed engine workers remain deferred).
  - Playable web client with Playwright e2e and accessibility standards (`@chess-platform/web`).
  - Pluggable AI routing, caching, and evaluation features (`@chess-platform/ai-orchestrator`, `@chess-platform/ai-features`).
  - Tournaments (round-robin, Swiss, Arena), game launcher, and live broadcast (`@chess-platform/tournament`).
- **Feature & Platform Expansions (M10–M14)**:
  - **M10 (Social & learning)**: Social graph, 1:1 messaging, teams/communities, forums, achievements, collaborative studies, interactive lessons, and read-only GraphQL read layer.
  - **M11 (Search)**: Keyword search, full-text Postgres indexing, live game indexing worker, natural-language normalization, pgvector semantic search (HNSW cosine similarity), and hybrid search (RRF).
  - **M12 (Security & anti-cheat)**: CORS, security headers, httpOnly cookies, durable rate limiting, pure-domain engine-correlation anti-cheat scoring, behavioral bot detection, gateway hosting, and STRIDE pen-test audit (closed).
  - **M13 (Observability & SRE)**: Dependency-free structured logger, metrics (Prometheus `/v1/metrics`), W3C `traceparent` propagation, OTLP tracing pipeline with batch processor and self-instrumentation, alert rules, Grafana dashboards, runbooks, and SLO definitions (closed).
  - **M14 (Deployment & scale)**: Local multi-service Compose stack, multi-node gateway scaling with Redis ownership and command forwarding (ADR-0010), Helm chart with kubeconform CI validation (ADR-0009), External Secrets Operator integration (ADR-0044), blue/green and canary delivery (ADR-0075), automated deploy gates (ADR-0076), load and chaos test baselines (ADR-0065, ADR-0077, ADR-0078, ADR-0111), and comprehensive web UI surfaces for account security (WebAuthn passkeys, session visibility/revocation, password recovery, email verification).
- **Active Milestone — M15 (Productionization & Hardening)**:
  - M15 is active production hardening, reliability, integration correctness, test/database isolation, and unresolved-defect closure.
  - See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) for the active increment log, current defects, and immediate next steps.

## Test Verification & CI

- **Suite execution**: Run `npm test` across all root workspaces via `node --test`.
- **Live metrics**: After the host setup below, `npm run test:counts` aggregates test and skip counts across root workspace packages and the standalone gateway service. Skipped integration tests are not passes; consult [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) for measured validation status and active defects.
- **Hermetic defaults**: Unit and domain suites run offline without external infrastructure. Integration suites gate on environment variables: `DATABASE_URL` (PostgreSQL persistence), `REDIS_URL` (gateway Redis integration and scaling), and provider API keys (live AI features).
- **Continuous Integration (`.github/workflows`)**:
  - Multi-version Node matrix (Node 22 / 24) with strict typechecking, linting, and ADR claim validation (`npm run check:adr-claims`).
  - Path-filtered workflows for efficient change detection (`changes` job).
  - Real PostgreSQL integration suite for schema migrations, persistence repositories, and API pg-security tests (`postgres-integration`).
  - Real UCI engine analysis smoke testing with pinned Stockfish and Fairy-Stockfish binaries (`analysis-smoke`).
  - End-to-end acceptance testing with Playwright browser tests and Lighthouse accessibility scoring (`m6-acceptance`).
  - Production Docker container image build and template verification (`docker-images`).
  - Helm chart linting and kubeconform schema validation against Kubernetes schemas (`helm`).
  - Parity and hygiene guards: CI parity (`check:ci-parity`), variant parity (`check:variant-parity`), engine pin parity (`check:engine-pin-parity`), and observability drift (`check:observability`).
  - Workflow triggers: on-demand deployment (`deploy.yml`) on workflow dispatch or published release, on-demand chaos engineering (`chaos.yml`) on workflow dispatch, and release container image publishing (`release.yml`) on version-tag pushes (`v*`).

## Build & Run

```bash
npm ci                           # install root workspace dependencies from the root lockfile
npm run build                    # build root workspace packages in dependency order
npm ci --prefix services/gateway # install the standalone service from its own lockfile
npm test                         # execute root workspace package test suites
npm run lint                     # strict typecheck across root workspaces
npm run test:counts              # execute and count workspace + gateway service tests
```

- **Build order**: Run **`npm run build` before `lint` or `test` on a fresh clone** — downstream packages resolve upstream types from built `dist/`.
- **Standalone gateway**: Root `npm ci` and `npm run build` exclude `services/gateway`. Its separate install is required before `test:counts` or direct gateway tests, even without `REDIS_URL`. The test command compiles its own `dist-test/`; a gateway production build is only needed for its `dist/` output. See [`docs/RUNNING.md`](docs/RUNNING.md#host-build-tests-and-live-counts) for host setup and troubleshooting.
- **Local full stack**: `docker compose up --build` (see [`docs/RUNNING.md`](docs/RUNNING.md)).
- **Helm chart validation**: `bash scripts/helm-snapshot-test.sh` (or lint with test secrets: `helm lint deploy/helm/gambit --set secrets.accessTokenSecret=test-only-access-token-secret-32-bytes-minimum --set secrets.postgresPassword=test-only-postgres-password --set config.nodeEnv=development --set email.provider=console`).

## Working Method (Do Not Skip)

Every increment: **build to explicit acceptance criteria with tests → self-critique loop → multi-perspective review (distributed-systems, performance, security, chess-server maintainer) → refactor → document → commit → push.**

- **Validation gate**: Advance only when clean — run `npm run build && npm run lint && npm test` before reporting done.
- **Architectural gates**: Decisions that introduce a durable or shared contract require an Architecture Decision Record (ADR) approved under `docs/adr/` before implementation.
- **Documentation hygiene**: Update documentation (`README.md`, `docs/ROADMAP.md`, `docs/PROJECT_STATE.md`) at every milestone checkpoint.

## Enduring Guardrails

- **Gateway horizontal scaling requires Redis.** Since M14 inc 5 (ADR-0010) the gateway is safe to scale (single-owner authority + Redis command forwarding; Helm chart defaults to `gateway.replicas: 2`), but ONLY with `REDIS_URL` set — never scale beyond 1 replica without Redis command routing.
- **Strict package boundaries and dependency-free domain core.** Keep domain packages (`core`, `game`, `tournament`, `social`, `messaging`, `community`, `achievements`, `studies`, `learning`, `search`, `anti-cheat`) strictly free of external runtime dependencies; native/infra code (`pg`, `ioredis`, `ws`, AI SDKs) enters only via documented ports (`EventLog`, `PubSub`/`RedisLike`, `TokenVerifier`, `EngineTransport`, repositories) wired in application bootstrap or package `/pg`-style subpaths — never in domain code. Pure domains must not read wall clocks directly (`Date.now()`); inject time/clock as a parameter.
- **No placeholders or mock shortcuts.** No stubs, TODO implementations, or temporary hacks in production paths — production quality only.
- **GitHub-authoritative workflow.** Keep GitHub authoritative: document changes in the repository, commit, and push so any engineer or AI agent continuing the work has full context without conversation history.

## Tracked Tech Debt & Deferred Work

Only actionable, genuinely open architectural debt is tracked here:

- **Tournament reporter refinements (ADR-0025)**:
  - Event-log catch-up for committed terminal outcomes is addressed by M15 Increment 65 (ADR-0144); search and achievements remain projection-dependent follow-ups.
  - Dedicated single-replica reporter Deployment (currently hosted across gateway replicas with optimistic-concurrency CAS on tournament saves).
  - Arena withdrawal is permanent by design (pause/rejoin requires an explicit domain decision and ADR).
- **Scale & Infrastructure (M14 deferred)**:
  - Terraform IaC for cloud provisioning.
  - 100k-user cluster load testing (workstation-bounded k6 and chaos baselines are implemented).
- **Active defects and investigations**:
  - For active defects and investigations (including Node test runner Signature B diagnostic tracking, isolated fresh-database suite dependencies, and gateway test tooling caveats), consult [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) as the single authoritative source of truth.

For full project state, increment details, and the immediate next task, see [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).
