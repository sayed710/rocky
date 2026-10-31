# D1 recovery evidence and external server experiment — 15 October 2026

This archive publishes completed investigation work. It does **not** install the candidate in production source, close D1-A/D1-B, or certify a deployed database/Redis topology. The candidate is a review draft.

Pinned production baseline: `4ccf8f48869335e06ac1b1de467d2161869f8fd7` (main at investigation time). The inspection checkout remained clean at `dbf44d9a4207af6cf6096935693198a8a4954ff0`; source extraction explicitly used the pinned main commit.

## What was actually executed

| Experiment | Recorded result | Meaning |
|---|---|---|
| Baseline production modules with in-memory log/pubsub and fake socket seams | 15 cases:7 PASS,8 intended assertion failures; zero skips; child exit1 | Five server schedules and three client schedules reproduce stale recovery/rollback behavior. They are not eight independent defects. |
| External server candidate | 12 selected F/S cases PASS; zero skips; child exit0 | Warm join/resume recovery expectations pass for the copied server candidate. C01-C03 were excluded; no client fix is claimed. |

Baseline tests instantiate actual GameAuthority, RealtimeGateway, GameSync, WsClient and codec code. Cold-load controls distinguish committed durable data from warm-cache staleness. Draw/terminal revisions can advance without increasing ply; no new draw-broadcast contract is invented. Initial missing build dependencies were a setup failure, retained separately and not counted as behavioral RED.

The external candidate patch changes copied authority/gateway files to derive a recovery snapshot and history from one loaded prefix without replacing the resident command cache. It remains an experiment: full-log replay cost, cancellation/budgets, resident-cache reconciliation, broader lifecycle tests and real Redis/PostgreSQL behavior are unresolved.

## Contents and provenance

- `baseline/`: historical harness, source manifest, run metadata, TAP, observations and result record.
- `candidate/`: unapplied patch, candidate harness, design/result records, preparation manifest and actual run receipts.
- `reviews/`: independent original-agent source/harness reviews and proposed boundary controls. Reviews are not independent execution.

The [OpenCode collection summary](reviews/OPENCODE_PROVENANCE_AND_INTEGRATION_SUMMARY.md) distinguishes independently verified source bytes from recorded fingerprints, the final CLI transport failure and PR107 integration limits. The Gemini source-oracle `.txt` is a coordinator transcription of visible findings; the original desktop accessibility capture is not published.

Receipts are historical observations, not current CI. Absolute workstation paths, relative private session artifact prefixes (such as `.codex/visualizations/...`), and review-session metadata are replaced with `<ARTIFACT_ROOT>`, `<REPOSITORY>`, `<WORKSTATION>` or `<REVIEW_SESSION_ID>` in published text, build metadata, setup error receipts, and review logs. Recorded hashes still refer to original unredacted private artifacts, not these sanitized copies. Source code and the unapplied patch are copied without content changes. No credentials or conversation/session dumps are included. Compiled bundles, source maps and full copied production trees are omitted; the source manifest names the pinned Git blobs.

The harnesses are archived fixtures, **not a standalone runnable package or a default test-suite addition**. Their relative `frozen-src` imports require source extraction and the original bundling configuration. No portable runner is claimed. Review the patch as text; do not apply it as a production-ready fix.

## Review qualifications and unfinished work

- S03 is derivative of S02. C02 uses synthetic delivery ordering of genuine snapshots; C03 uses a synthetic resume envelope. These are not complete browser/network traces.
- C01 dynamically asks the server for its older stimulus. A server repair can remove that stimulus; a resulting pass would not prove client revision filtering. Client comparisons must preserve and assert a genuinely older response.
- F06 characterizes an inconsistent snapshot/history cut. It is not proof of a coherent production recovery response.
- The 12-case candidate execution preceded collection of all outstanding requested reviews. It is a bounded experiment, not satisfaction of the coordinator's review gate or independent candidate-code acceptance.
- Claude's busy-owner append, coherent concurrent-prefix and obsolete/revoked async-session controls are specified but unexecuted. No regression acceptance is inferred from their source-only expectations.
- Independent candidate-code review, semantic typecheck, full integrated gates, real Redis/PostgreSQL checks and production architecture decisions remain open. No service, database or deployment was used in these experiments.

PR107 deployment-guard work and PR114 inactive fencing work are separate. This evidence archive changes neither their source nor their acceptance gates. Owner alone merges.
