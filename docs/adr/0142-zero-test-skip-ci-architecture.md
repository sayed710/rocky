# ADR-0142: Zero Test-Skip CI Architecture and Environment-Gated Suite Partitioning

## Context

The repository previously relied on self-skipping guards (`const skip = ...`) across various packages when external services or API credentials were not provisioned. This produced dozens of skipped tests during PR CI runs:
- `packages/persistence` skipped 21 PostgreSQL integration test files (48 tests) during hermetic `npm test` in the `build-test` job.
- `packages/api` skipped 7 PostgreSQL integration test files (39 tests) and 3 engine smoke test files when run without `DATABASE_URL` or engine binaries.
- `packages/ai-orchestrator` had 2 live completion tests embedded in `test/adapters.test.ts` that skipped without `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- `packages/ai-features` had 16 live provider integration tests across 9 files that skipped without API keys.
- `scripts/test/backup-restore-drill.test.mjs` contained a live database restore drill test that skipped when `DATABASE_URL` was not set.

This pattern violated the owner's strict quality gate: **for every test suite executed in CI, `failed = 0` and `skipped = 0`**. A test must only be invoked in a suite that provides its required execution environment.

## Decision

We establish an explicit, partitioned test architecture across all packages, guarded by programmatic zero-skip enforcement and static topology validation:

1. **Hermetic Unit Test Suites (`build-test` CI job)**:
   - Run via `npm test` across all workspaces and `npm run test:scripts`.
   - Purely hermetic: zero external network, zero external databases, zero live engine binaries.
   - Every single executed test must pass with `skipped = 0`.

2. **PostgreSQL Integration Test Suites (`postgres-integration` CI job)**:
   - Run via `npm run test:integration:postgres --workspace @chess-platform/persistence`, `npm run test:integration:postgres --workspace @chess-platform/api`, and `npm run test:scripts:integration`.
   - Requires real PostgreSQL with `vector` extension (`DATABASE_URL`).
   - Genuinely executes all database persistence, concurrency, and backup drill tests with `skipped = 0`.

3. **Engine Smoke Test Suite (`analysis-smoke` CI job)**:
   - Run via `npm run test:analysis-smoke --workspace @chess-platform/api`.
   - Requires pinned Stockfish 16, Fairy-Stockfish 14, and real PostgreSQL.
   - Genuinely executes production composition tests with `skipped = 0`.

4. **Gateway Service Suites (`gateway-service` CI job)**:
   - Run via `npm test` and `npm run test:trusted-edge` in `services/gateway`.
   - Requires real Redis 7 (`REDIS_URL`) and Docker/Nginx (`REQUIRE_DOCKER=1`).
   - Genuinely executes command routing, lease ownership, and edge proxy tests with `skipped = 0`.

5. **M6 Acceptance Suite (`m6-acceptance` CI job)**:
   - Run via `npm run e2e` in `packages/web`.
   - Requires Playwright Chromium and the in-memory backend harness.
   - Genuinely executes end-to-end user journeys with `skipped = 0`.

6. **Dedicated Live Provider Workflow (`.github/workflows/live-provider.yml`)**:
   - Third-party live OpenAI and Anthropic contract tests are separated into `test:live-provider` scripts.
   - Extracted live tests from `packages/ai-orchestrator/test/adapters.test.ts` into `packages/ai-orchestrator/test/adapters-live.integration.test.ts`.
   - Extracted live backup restore test from `scripts/test/backup-restore-drill.test.mjs` into `scripts/test/backup-restore-drill.integration.test.mjs`.
   - Live tests run strictly on demand via `workflow_dispatch` with verified repository secrets. They do not run in PR CI and are never marked as passed without credentials.

7. **Zero-Skip Enforcer (`scripts/run-zero-skip.mjs`)**:
   - Wraps test invocations, streams runner output in real time, parses TAP/spec skip counts, and fails with exit code 1 if any test is skipped.

8. **Topology Invariant Guard (`scripts/check-test-topology.mjs`)**:
   - Scans all 390+ test files across the repository to verify that every test file is mapped to an explicit suite and no file is orphaned or unclassified.
   - Enforced in `npm run check:test-topology` in `build-test` CI and `scripts/ci-local.mjs`.

## Consequences

- Zero tests are skipped in PR CI: every executed test genuinely runs and asserts its specification against its required environment.
- Flaky or unconfigured external services cannot cause false-green skipped test reports.
- Developers and reviewers get immediate notification if a new test is unclassified or improperly self-skipped.
