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
   - Run via `npm test`, `npm run test:trusted-edge`, and `npm run test:web-delivery` in `services/gateway`.
   - Requires real Redis 7 (`REDIS_URL`) and Docker/Nginx (`REQUIRE_DOCKER=1`).
   - Genuinely executes command routing, lease ownership, edge proxy, and production cache/compression tests with `skipped = 0`.

5. **M6 Acceptance Suite (`m6-acceptance` CI job)**:
   - Run via `npm run e2e` in `packages/web`.
   - Requires Playwright Chromium and the in-memory backend harness.
   - Genuinely executes end-to-end user journeys with `skipped = 0`.
   - `scripts/playwright-zero-skip-reporter.mjs` evaluates every discovered `TestCase.outcome()` and overrides an otherwise-green Playwright result when the suite is empty, skipped, interrupted, or has an unexpected result. Discovery-only `--list` commands remain read-only and do not apply execution policy.

6. **Dedicated Live Provider Workflow (`.github/workflows/live-provider.yml`)**:
   - Third-party live OpenAI and Anthropic contract tests are separated into `test:live-provider` scripts.
   - Extracted live tests from `packages/ai-orchestrator/test/adapters.test.ts` into `packages/ai-orchestrator/test/adapters-live.integration.test.ts`.
   - Extracted live backup restore test from `scripts/test/backup-restore-drill.test.mjs` into `scripts/test/backup-restore-drill.integration.test.mjs`.
   - Live tests run strictly on demand via `workflow_dispatch`. OpenAI and Anthropic are selected and executed independently, so either single credential runs its complete provider contract; both credentials run both contracts, and no credentials fail the workflow. Test registration is controlled by `GAMBIT_LIVE_PROVIDER` without `skip` annotations.
   - They do not run in PR CI and are never marked as passed without at least one selected credential.

7. **Zero-Skip Enforcer (`scripts/run-zero-skip.mjs`)**:
   - Wraps test invocations, streams runner output in real time, parses TAP/spec skip counts, and fails with exit code 1 if any test is skipped.
   - Requires `totalTests > 0`: exits 1 with "No executed tests detected" when a process exits 0 with arbitrary text and no test summary, preventing false-green on misconfigured commands.
   - Windows platform laundering removed: no skip bypass based on `process.platform`.
   - ANSI control sequences are removed before parsing. Complete Node summaries must contain consistent tests/pass/fail/cancelled/skipped/todo accounting; plan-only TAP must contain one complete top-level plan with the matching number of test points. Partial, malformed, truncated, or contradictory output fails closed.
   - Parent termination signals are forwarded to the child process and temporary signal handlers are removed on every exit path.

8. **Topology Invariant Guard (`scripts/check-test-topology.mjs`)**:
   - Scans all 397 test files across 21 explicit suites to verify that every test file is mapped and no file is orphaned or unclassified, including `scripts/nginx-web-delivery-acceptance.mjs` imported from merged PR #56.
   - Enforced in `npm run check:test-topology` in `build-test` CI and `scripts/ci-local.mjs`.
   - Deployment-only exclusions are path-scoped to `deploy/helm` and `deploy/observability`; identically named directories under packages cannot hide test files. The Node fallback matcher supports globstar and the negative extglob used by package scripts.

9. **POSIX Suite Partition**:
   - Tests that require POSIX-only OS guarantees (SIGTERM process-tree teardown, `chmod`/permission bits) are extracted from cross-platform files into dedicated `*.posix.test.ts` / `*.posix.test.mjs` files.
   - Affected files: `packages/api/test/diagnostics/signature-b-correlate.posix.test.ts` (2 tests) and `deploy/load/test/run-evidence.posix.test.mjs` (1 test).
   - These suites run in dedicated `api-posix-unit` and `load-harness-posix` CI steps (Linux only) so they genuinely execute with `skipped = 0` on CI and are excluded from Windows runs without laundering.

10. **Live Provider Self-Contained Build**:
    - `test:live-provider` in `packages/ai-orchestrator` and `packages/ai-features` now unconditionally prepends `npm run build:test &&`, ensuring live integration test files are compiled before the runner is invoked.

## PR #56 Integration

PR #56 (`perf(web): harden production caching and compression`) was merged to `main` before this correction. PR #57 merges that exact mainline state without rewriting its published history. The imported Nginx configuration, hash-aware cache contract, gzip acceptance assertions, `packages/web` delivery trigger, and local/hosted gateway job parity are preserved. Its new `scripts/nginx-web-delivery-acceptance.mjs` file is now an explicit topology and test-count suite rather than an unclassified exception.

## Consequences

- Zero tests are skipped in PR CI: every executed test genuinely runs and asserts its specification against its required environment.
- Flaky or unconfigured external services cannot cause false-green skipped test reports.
- Developers and reviewers get immediate notification if a new test is unclassified or improperly self-skipped.
- POSIX-only tests execute genuinely on Linux CI without any skip laundering; they are excluded on Windows without polluting hermetic suite counts.
- False-green on arbitrary text output is eliminated by requiring a positive test count before accepting an exit-0 result.
