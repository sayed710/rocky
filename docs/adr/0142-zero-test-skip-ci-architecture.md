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
   - Requires `totalTests > 0`: exits 1 with "No executed tests detected" when a process exits 0 with arbitrary text and no test summary, preventing false-green on misconfigured commands.
   - Windows platform laundering removed: no skip bypass based on `process.platform`.

8. **Topology Invariant Guard (`scripts/check-test-topology.mjs`)**:
   - Scans all 396 test files across the repository to verify that every test file is mapped to an explicit suite and no file is orphaned or unclassified.
   - Enforced in `npm run check:test-topology` in `build-test` CI and `scripts/ci-local.mjs`.

9. **POSIX Suite Partition**:
   - Tests that require POSIX-only OS guarantees (SIGTERM process-tree teardown, `chmod`/permission bits) are extracted from cross-platform files into dedicated `*.posix.test.ts` / `*.posix.test.mjs` files.
   - Affected files: `packages/api/test/diagnostics/signature-b-correlate.posix.test.ts` (2 tests) and `deploy/load/test/run-evidence.posix.test.mjs` (1 test).
   - These suites run in dedicated `api-posix-unit` and `load-harness-posix` CI steps (Linux only) so they genuinely execute with `skipped = 0` on CI and are excluded from Windows runs without laundering.

10. **Live Provider Self-Contained Build**:
    - `test:live-provider` in `packages/ai-orchestrator` and `packages/ai-features` now unconditionally prepends `npm run build:test &&`, ensuring live integration test files are compiled before the runner is invoked.

## Open PR Overlap

PR #57 (`gemini/ci-zero-skip-architecture`) shares **4 files** with open PR #56
(`gemini/web-delivery-cache-compression`):

| File | PR #57 change | PR #56 change |
|------|--------------|--------------|
| `.github/workflows/ci.yml` | Adds POSIX suite steps and zero-skip enforcement | Adds cache/compression middleware step |
| `docs/PROJECT_STATE.md` | Appends M15 Increment 59 entry | Appends its own increment entry |
| `scripts/ci-local.mjs` | Adds posix contract tests job | Adds gateway compression job |
| `services/gateway/package.json` | No direct change (topology reference only) | Adds compression middleware dependency |

**Resolution order**: PR #57 is foundational CI infrastructure. PR #56 must be
rebased onto the merge commit of PR #57 before it can land. The 4-file overlap
is documented here so reviewers can coordinate the rebase.

PR #55 (`fix/fair-play-live-game-containment`) has **zero file overlap** with PR #57.

## Consequences

- Zero tests are skipped in PR CI: every executed test genuinely runs and asserts its specification against its required environment.
- Flaky or unconfigured external services cannot cause false-green skipped test reports.
- Developers and reviewers get immediate notification if a new test is unclassified or improperly self-skipped.
- POSIX-only tests execute genuinely on Linux CI without any skip laundering; they are excluded on Windows without polluting hermetic suite counts.
- False-green on arbitrary text output is eliminated by requiring a positive test count before accepting an exit-0 result.
