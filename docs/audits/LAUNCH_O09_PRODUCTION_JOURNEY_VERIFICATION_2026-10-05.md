# Launch Preparation O09 — deployed game-to-review journey

Completion date: 2026-10-05 (Africa/Cairo). Audited base: `f822d3ea01120689f47db14ea3884f5af578ddc2`.

O09's production path is verified on the feature branch. Integration into main remains the owner's decision. This document does **not** certify O06 Kubernetes/CNI/Helm/TLS/email/passkeys, A06 manual accessibility or A07 physical-device/browser coverage. It is **not public-launch approval**.

## Reproduce

Prerequisites: Node >=22, npm, Docker with Linux/amd64 containers, Compose supporting `!reset`, and Playwright Chromium:

```sh
npm ci
npx playwright install --with-deps chromium
npm run acceptance:production-journey
```

The command builds the unchanged production Dockerfiles, starts normal Compose in a unique project, checks all six services plus Gateway `/ready` and public web/API readiness, executes the existing Compose smoke test, drives two independent Chromium contexts, restarts application components, verifies replay/recovery, and removes its own containers/network/volumes on success or failure. PostgreSQL survives until recovery assertions finish. A run-specific override removes only PostgreSQL/Redis operator port publications; it publishes no API/Gateway ports and never uses the chaos override. One available loopback web port is selected and retained across restart.

The global execution deadline is 20 minutes, subprocesses/readiness/browser actions have bounds, and cleanup has its own 60-second budget. Failure stage, observed durable state and container status are retained in ignored `test-results/production-journey/<run>/evidence.json`. No cookies, credentials, auth frames, storage state, traces, email-console logs or database dumps are retained. Generated password/email values are redacted from Playwright errors. Cleanup failure makes the command fail and cannot print PASSED.

The heavier launch gate is [O09 production browser journey](../../.github/workflows/production-journey.yml), using workflow_dispatch on the desired branch once the workflow exists on the default branch. GitHub rejected pre-merge dispatch with HTTP 404 because this is a new workflow; the documented local command is available immediately. It builds three images and runs six containers, so it is separate from mandatory per-PR suites. No existing CI gate was weakened. The workflow uploads sanitized evidence, runs contract tests with zero-skip enforcement and runs the five mutation controls.

## Actual deployment and journey

Environment: Windows host, Docker Desktop 4.93.0 Linux backend, Docker client/server 29.8.1, Compose 5.5.1, Node 24.15.0, Playwright 1.61.1, Chromium 149.0.7827.55. Local Compose intentionally uses HTTP and console email; this is its supported deployment contract, not production email/TLS certification.

Initial complete run: `o09-6444654b`, completed at `2026-10-05T18:02:38.119Z`, based on the audited SHA with implementation changes present. The subsequent [sanitized clean-head primary evidence](LAUNCH_O09_PRODUCTION_JOURNEY_RUN_2026-10-05.json) records run `o09-33484332`, exact source HEAD `031ae3cd81713a37db8c564b9a08929f175f9157`, dirty=false, public endpoint `http://127.0.0.1:8333`, completion `2026-10-05T18:07:49.441Z`, and every required stage including smoke=true. Later failure-diagnostic header redaction has separate regression coverage. **The exact final PR HEAD and matching final-head runtime/CI/review evidence are recorded in the PR's owner-handoff attestation**, avoiding a self-referential commit hash in this document.

Services exercised: production web/Nginx, API, Gateway, PostgreSQL, Redis, and normal trust-worker deployment. Projection and rating workers are existing always-on Gateway workers whenever DATABASE_URL is configured; trust-worker does not own either function. API runs migrations before Gateway starts. Browser HTTP goes through `/v1/` at Nginx; browser WebSockets go through the same public origin's `/ws`. The runner rejects published backend ports and captures both contexts' real socket URLs and assigned player roles.

1. Both fresh identities register through the site's form, without bootstrap inserts or seeded browser auth.
2. White creates **rated Standard, 5+0, white** through Create a game. Black sees and accepts that exact seek in the lobby. Both reach the same game; board orientation and assigned white/black role are checked.
3. Real board clicks play `f2f3 e7e5 g2g4 d8h4` (Fool's Mate). Each destination/source is checked in both boards. The browser's sent move frames must equal those four moves.
4. Both UIs show checkmate and `0-1`; Resign is hidden and Review is available. A further board gesture leaves the pawn in place and sends no new move.
5. Bounded product API polling proves the durable result and participants; rated classification and pool cannot silently skip rating verification.
6. Both browsers navigate through Profile, find the completed-game link, refresh history, follow the link and recover the terminal board. Visible summary checks include Standard, Blitz, `0-1`, four plies and the exact game target. Participant/rated identity is additionally checked against the public history API; opponent names and rated badges are not currently displayed in profile rows.
7. White clicks Review my game. The authenticated API returns the same completed game, white ownership, `0-1`, checkmate, complete analysis, and white's two moves. Two review rows render without a product error. Review is a panel on the normal game route, not a fabricated page. Local shipped Stockfish supplies analysis; no paid AI/provider is involved.

Authoritative moves and GameEnded live in PostgreSQL `game_events`. `PgGamesProjector` folds the committed stream into `games`; `PgRatingsApplier` independently consumes committed endings, validates eligibility, and applies both ratings with the unique per-game ledger atomically. Ratings deliberately do not depend on the games projection. History reads the projection; review reconstructs the completed event stream.

## Durable result and exactly-once proof

Clean-head complete game's ID: `01a10d3f-27ce-7000-90e4-d6015c151806`.

| Contract | Observed |
| --- | --- |
| White | `01a10d3e-ff4a-7000-9b0b-d8350e286b40` |
| Black | `01a10d3f-00a5-7000-847d-4761a4752e10` |
| Variant / rated / pool | standard / true / blitz |
| Result / termination / plies | 0-1 / checkmate / 4 |
| endedAt | 2026-10-05T18:06:53.936Z |
| White effective rating → API rating | 1500 → 1337.69 |
| Black effective rating → API rating | 1500 → 1662.31 |
| Full-precision application values | White 1337.6891060937023; Black 1662.3108939062977 |

Fresh accounts correctly have no rating row; their effective baseline is the documented 1500. The test does not hard-code the delta. It requires one row in Standard × Blitz, opposite expected directions, and one atomic ledger entry matching both players, pool, score and observed ratings. API values are compared using its established two-decimal presenter contract; the complete ledger is compared without rounding across recovery.

The runner stops web, API, Gateway and trust-worker, preserves PostgreSQL/Redis, and rewinds **only** `rating_checkpoint` to its documented same-cluster origin. It never inserts/changes final games, events, ratings or application rows. After healthy recovery it requires the production Gateway's internal metric `ratings_games_total{outcome="already_applied"} 1`, read by container exec without exposing metrics publicly. This proves replay actually encountered the old ending; ordinary restart alone would not prove replay. API ratings and the complete one-row ledger remain identical. Both histories, terminal game and local-engine review are reopened and verified again before cleanup.

## Defect, controls and verification

Current-main product defect: profile history rendered summaries as noninteractive divs, so users could not reopen a historical game to reach review. A focused mount test failed RED on the missing accessible link. The smallest fix changes each existing summary into an encoded native game-route anchor, preserving localized labels and bidi result handling. The regression and full profile suite pass GREEN (8 tests, zero skips). No backend, schema, authority, rating algorithm, edge policy or deployment production configuration changed.

Harness failures corrected during development: nonexistent auth selector; ambiguous shared submit selector; rendered label capitalization; API-versus-ledger numeric presentation; Docker ephemeral port changes on stop/start. Independent read-only review also caught shallow workflow checkout, misleading PASSED on cleanup failure, and Playwright error credential disclosure; all were corrected. Failed runs are not credited as successful certification.

`node scripts/production-journey-mutations.mjs` runs copies in an owned temporary directory, never modifying production source. All four mutants are killed: accepting a casual result, ignoring loser rating direction, allowing backend-port bypass, and omitting review requests. The original five-test contract is GREEN, including generated form values and case-insensitive/ANSI-bearing Cookie, Authorization and Set-Cookie diagnostic redaction. A surviving direction mutation exposed an overlapping fixture assertion; correcting the fixture made the intended direction failure independent of ledger mismatch. Negative contract controls also cover wrong game/participants, incomplete terminal projection, missing pool, duplicate applications, missing stages/moves and absent sockets.

Executed local validation: full `npm run build`, full `npm run lint`, `npm test` across all 19 hermetic workspaces with zero skips; profile mount 8/8; contract 5/5; initial script suite 319/319 with zero skips (before the additional credential-header test); four killed mutations and original GREEN; test-topology (490 files/21 suites), CI parity, ADR claims, observability, deploy gates, Docker build order, engine pins and variant parity all passed. The clean-head production browser journey includes the existing Compose smoke test. Existing trusted-edge/web-delivery suites remain mandatory CI gates and production edge wiring is unchanged. Final CI, Qodo, Greptile, unresolved-thread and exact-head fallback-review acceptance are attested in the PR, not inferred from local passes.

Greptile additionally identified inherited browser link styling and a deadline/cleanup race. History anchors now retain the shared theme row color and layout, with the existing focus-ring treatment; the browser journey verifies block layout, decoration and focus. Deadline expiry interrupts the browser and prevents further commands but awaits the bounded active journey before cleanup. Two lifecycle regressions verify that both fulfilled and rejected active work settle before cleanup becomes reachable, and that successful work clears its timer. These fixes require a fresh exact-head journey and reviewer attestation in the PR.

Qodo identified a startup port-allocation race: the initial listener released its port before image building. Port selection now occurs after building; startup retries only actual bind collisions, with at most three distinct selections within the global deadline, and keeps the successful endpoint across recovery. Regression tests prove collision recovery, exhaustion, and immediate failure for unrelated errors. Later exact-head validation includes nine contract/lifecycle tests and five killed mutations; original GREEN is required for both modules.

A subsequent Qodo review caught programmatic focus bypassing tab-order checks. History navigation now uses bounded real Tab presses, verifies the active link and custom focus ring, and opens the game with Enter. A run-local DOM negative control sets the link's tabindex to -1, requires keyboard reachability to fail, restores the attribute, and then requires normal keyboard navigation to succeed. It never alters persisted product state.

Limits: one Standard human game and local Compose deployment, two desktop Chromium contexts, no full variant/device/browser matrix, no public infrastructure or operator-policy certification. Cross-cluster rating restore is outside the documented same-cluster replay proof. O06/A06/A07, owner product/legal decisions and public-launch approval remain separate.
