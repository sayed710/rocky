# D1-A current-main hermetic reproduction — actual results

Executed2026-10-15, Africa/Cairo. **15 cases:6 foundation/contract controls PASS,1 limitation characterization PASS,8 behavioral REDs. Zero behavioral setup failures, cancelled, skipped or TODO.** Node test child exits1 because the desired recovery invariants fail; this is not GREEN CI. No remediation implemented.

## Exact baseline, source and commands

- Fresh fetch-prune and GitHub main both verified `4ccf8f48869335e06ac1b1de467d2161869f8fd7` before preparation and again after execution. Owner-merged revision foundation112 is present.
- Existing isolated inspection checkout: <REPOSITORY>, branch feat/r01-state-revision-foundation, localHEAD `dbf44d9a4207af6cf6096935693198a8a4954ff0`, clean before/after; deleted upstream. No switch/reset/rebase/new worktree or project. Current source was extracted by pinned Git object, not mistaken for checkoutHEAD.
- [source-manifest.json](source-manifest.json) records42 original source files, exact Git blob IDs, SHA256 and sizes. [build-metafile.json](build-metafile.json) records actual bundled inputs, all restricted to this artifact directory. Core/game aliases resolve to pinned extracted source, never checkout-built dist. Extracted sources verified unchanged after run.
- Runtime: Nodev24.15.0, npm11.12.1 observed in preflight, Windows/win32x64; existing esbuild0.25.12. No installs, database, Redis, services, real WebSocket/network, credentials or production writes. Git/GitHub reads were mandatory baseline preflight only.
- Preparation saved [ORACLE_PROPOSAL.md](ORACLE_PROPOSAL.md), [harness.ts](harness.ts), runner, frozen sources and prepare receipt before behavioral execution; path was reported for original independent reviewers. Oracle review results have not been received/claimed here.

From the existing inspection checkout:

```powershell
node <ARTIFACT_ROOT>/D1A_CURRENT_MAIN_REPRO_2026-10-15/run.mjs --prepare-only
node <ARTIFACT_ROOT>/D1A_CURRENT_MAIN_REPRO_2026-10-15/run.mjs
```

Commands were routed through the installed lean-ctx CLI. Runner's actual child invocation: Node `--test --test-concurrency=1 --test-reporter=tap harness.cjs`. [run.json](run.json) captures full executable/command paths, UTC start/end, runtime, before/after checkout/main state, hashes and child exit/signal. Successful behavioral invocation ran14:08:01.788–14:08:07.332Cairo including extraction/build; child TAP duration211.4784ms. Childexit1, signalnull, no spawn error; outer tool also returned1. No sleep/timing-based schedule assertions or retries.

Current harnessSHA256 `d06dcf767b194a89677f81ff4f9998d246616b43b8f3ec9532a7f3a31df99339`.
BundleSHA256 `b16317a8b0b80883c5fc68f89b3e9e0d583676fa1086eb6a071477883005f5ce`.
RunnerSHA256 `98101bcbbd68aacdbe1de926698504996522e2db0cbe6c0a5979eb3582e66ae6`.
These hashes bind the files used/read during this recorded run; they do not certify remote CI or an unexecuted platform.

## Actual observed failures

| ID / boundary | Deterministic schedule / expected invariant | Actual baseline observation |
|---|---|---|
| S01 server join | Passive edge loads0; writer completes moves1/2 before spectator joins edge; return current snapshot2 | joined revision0/ply0 versus log/writer2/ply2; locally hasFresh=true, zero additional edge loads |
| S02 server resume | Edge already joined0; writer completes moves1/2; resume lastPly0 | resumed snapshot0/ply0 instead of2/ply2, zero additional edge loads, despite broadcasts being available on shared pubsub |
| S03 server history | Same completed two moves before resume; history should contain existing move broadcasts1/2 | missed[] instead of the writer's two correctly stamped moves. No complete-draw-replay requirement imposed |
| S04 server same-ply draw | Edge refreshed at revision2/ply2; writer offers draw at3/ply2 before resume | resumed2/drawOffernull instead of3/drawOfferw; missed remains only two old moves |
| S05 server terminal | Edge at2/ply2; writer resigns at3/ply2 before resume | resumed2/status.overfalse instead of3/overtrue; returned existing history omits the ended frame, with two earlier moves only |
| C01 client rollback | Real full snapshot2 then actual warm-edge resumed0, decoded and delivered on valid active socket | GameSync snapshot revision2→0, ply2→0, move list lost |
| C02 client same-ply | Real full draw snapshot3 then older full state2 at sameply2 | drawOfferw→null, full snapshot revision3→2 |
| C03 client terminal | Real terminal full snapshot3 then older live resumed snapshot2 | status.overtrue→false, full snapshot revision3→2 |

All fixtures were legal production domain commands and actual production-derived StateViews. Revision-mode decoder acceptance is asserted before feeding frames to actual WsClient/GameSync; fake sockets/scheduler supply transport only. Prepare assertions establish actual newer writer/log state before the desired oracle fails. No incorrect test oracle was inverted to label stale behavior passing.

## Actual passing controls and characterization

| ID | Executed evidence |
|---|---|
| F01 foundation | Actual event sequences/snapshot revisions0..5; plies0,1,2,2,2,2; draw offer/decline emit zero broadcasts as currently designed |
| F02 foundation | Fifty-move move+end batch emits own-prefix revisions1/2, nonempty legal map only at intermediate move; final terminal snapshot2 has empty legal map; eviction/reload preserves exact supported frames |
| F03 protocol | Creation0 valid; negative/fractional/string/null/overflow revisions rejected; legacy absent stamp accepted by default decoder and rejected in revision-only mode. No new legacy recovery guarantee claimed |
| F04 cold recovery | Cold authority loads the same completed log: exact terminal snapshot4 and supported move/move/ended history; draw omission from broadcast list expected |
| F05 membership | Valid reconnect at equal revision2 accepts joined/rolewhite/myColorw and connected acknowledgment while preserving durable snapshot. Socket generation/reconnect path used; no arbitrary bypass of GameSync private methods |
| F06 characterization | resumed with old snapshot0 plus a valid missed move1 leaves client ply0. PASS documents that GameSync ignores missed for application/animation; it is not replay delivery or safety closure |
| F07 R-03 control | Equal and newer nonterminal snapshots do not settle ordinary exact uncertain request; unrelated receipt does not settle it; matching commandConfirmed does; only one original move request sent. Existing terminal/ready intent settlement contract was not altered |

## Scope, setup history and limits

The seam uses production InMemoryEventLog append/load plus writer/passive-edge authorities sharing one log and actual InMemoryPubSub. “Completed/committed prefix” here means completed append according to that in-memory EventLog contract, **not physical PostgreSQL durability**. The passive reader models a non-writer gateway; there is no Redis registry, lease/takeover, Postgres isolation/fencing or real multi-process proof. Pubsub delivery is not falsely assumed to update authority aggregates. Spectator joins avoid readiness/routing/ownership changes. No concurrent append after verification is tested or forbidden by these oracles.

Server S-cases reproduce D1-A freshness gaps; client C-cases identify deferred D1-B stale filtering/terminal monotonicity obligations. They are not a license to expand D1-A production scope. Same-ply draw **snapshot** recovery differs from D2 draw fanout, which remains excluded. Current foundations pass without being mislabeled as complete recovery.

One initial **preparation setup failure**, not RED: esbuild could not resolve latency subpath and api/models source omitted from the first extraction configuration. Preserved raw metadata in [prepare-setup-failure-01.json](prepare-setup-failure-01.json). Added exact pinned source/alias to the runner only; no production change. Subsequent [prepare.json](prepare.json) passes before tests and reports NOT_RUN_PREPARE_ONLY. Behavioral run has no setup failures. This was one behavioral execution, not repeated RED/GREEN implementation validation.

Raw evidence: [raw-results.tap](raw-results.tap), [raw-stderr.log](raw-stderr.log), [observations.ndjson](observations.ndjson), [run.json](run.json), source manifest/metafile and frozen source tree. Observations preserve full messages, expected states, post-client states, load counts and assertion errors; independent reviewers can challenge the exact source/oracles. Production repo clean/current main unchanged after execution. Other agents' worktrees—including107's authorized local diff—were not changed.

**STOP:** executable current-main evidence delivered. No D1-A/D1-B production implementation, database/services, installs, commits/push/bots/merge/deployment or new agents/sessions. All existing publication gates and owner merge authority remain; intentional RED is not passing CI. Recommended next engineering boundary remains owner-approved D1-A read freshness first, with client monotonicity separately scoped asD1-B. No claim that no other defects exist.
