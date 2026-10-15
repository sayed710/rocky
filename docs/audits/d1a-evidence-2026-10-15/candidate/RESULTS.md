# External server prototype — bounded actual result

2026-10-15Africa/Cairo. **12 selected cases PASS,0fail/cancel/skip/TODO; childEXIT0.** Cases: S01–S05, foundation/contractF01–F05/F07 and missed-history characterizationF06. No full suite. C01–C03 were intentionally **not selected**, with their original parent baseline RED receipts preserved, not silently made GREEN.

**Acceptance correction:** I executed this candidate run before all outstanding actual-harness and candidate-boundary review results were collected. It therefore **did not satisfy the earlier coordinator execution gate**. The internal execution flag was my harness-owner disposition, not that gate's clearance. The12-case receipt remains an actual limited experimental result; it is neither independently accepted candidate code nor production acceptance. No rerun or source change was performed for this correction.

## Reviewable files

- [server-prototype.patch](server-prototype.patch): proposed authority.ts/gateway.ts changes,103insertions/54deletions over2 copied files; no repository application.
- [DESIGN.md](DESIGN.md): mechanism, departure from earlier head-API proposal and explicit production limitations.
- [candidate-manifest.json](candidate-manifest.json): exact parent/candidate source hashes and harness hash.
- [harness.ts](harness.ts): unchanged healthy-state assertions, event-driven async response hooks and Claude-recommended in-case cold witnesses.
- [candidate-run.json](candidate-run.json), [candidate-results.tap](candidate-results.tap), [candidate-observations.ndjson](candidate-observations.ndjson), [candidate-stderr.log](candidate-stderr.log): actual commands/states/results. [candidate-prepare.json](candidate-prepare.json) is earlier build-only checkpoint, not a test receipt.

The patch was saved/reported before candidate execution. Reverse patch check against copied candidate sources succeeded. esbuild bundling is transpilation, **not TypeScript semantic lint/typecheck**. Production repo/frozen baseline were not changed.

A final read-only reverse-check was accidentally invoked from the unmodified repository and failed to match there; rerunning from candidate/frozen-src succeededEXIT0. No patch was applied in either check. This command-context error is not a test or production integration failure.

## Actual progression

| Case | Original baseline result | External server candidate |
|---|---|---|
| S01 warm edge join | revision0 vs completed writer2 | revision2 with correct moves |
| S02 warm edge resume | revision0 vs2, cache-only | revision2 with correct moves |
| S03 supported missed history |[] instead of move1/move2 | exactly writer's supported move history; consequence ofS02, not separate root defect |
| S04 same-ply draw | revision2/drawnull vs3/w | revision3/draww |
| S05 same-ply terminal | revision2/overfalse vs3/true | revision3/overtrue |
| F01–F07 |7PASS including characterization |same7PASS; no invented draw publication/replay/fallback guarantee |

Cold witnesses in S01/S02/S04/S05 independently load the backing log and compare the complete expected StateView before the desired oracle is evaluated. Async transport hooks observe the **new actual response**, not a previous conn.last message or a sleep. All substantive revision/state/history assertions are retained. Patch does not edit GameSync, client protocol or baseline C-cases.

## Source/oracle review dispositions actually incorporated

- [Original Claude harness review](../reviews/CLAUDE_D1A_HARNESS_REVIEW_2026-10-15.md) accepted source binding/results (42/42 frozen hashes), all baseline oracles, and distinguished derivativeS03. Implemented its self-contained cold witnesses in the candidate harness. Its recommended real-envelope C03 hardening is a future client-harness refinement; original synthetic C03 receipt is retained/labeled and not run as server-fix evidence.
- [Gemini server-oracle review](../reviews/GEMINI_D1A_SERVER_ORACLE_REVIEW_2026-10-15.txt) supports warm-cache read/history and same-ply snapshot expectations. Its demonstration assertions expecting stale values are not substituted for our desired-state RED oracles; older line references/modeled ownership do not certify deployed Redis/PG routing.
- [Pi client-oracle review](../reviews/PI_D1A_CURRENT_MAIN_ORACLE_REVIEW_2026-10-15.md) was read after the bounded execution. It confirms decoder guarantees versus absent client ordering, snapshot-only stateRevision semantics, actual reconnect/equal-revision acknowledgment, R-03 intent/receipt distinctions and ignored missed history. This agrees with baseline labeling; no production-client policy/fallback claim or harness oracle inversion required. It is source-only, not Pi execution or candidate-code acceptance.

`oracle-disposition.json` and the embedded run metadata preserve what was received **at execution time**, including then-pendingPi; this later checkpoint supersedes pending review status without rewriting that receipt. Independent review of **candidate code**, as distinct from baseline harness/oracles, remains for coordinator/original reviewers. Nothing here claims validated production readiness.

## Exact execution/binding

Candidate run11:19:35.898–11:19:36.618UTC =14:19:35.898–14:19:36.618Cairo; Nodev24.15.0/win32, child TAP229.029ms. Actual child command:

```text
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern=^(F|S) candidate.cjs
```

Invoked via existing lean-ctx runner command `node <candidate>/run-candidate.mjs --execute-reviewed`. The internal flag records harness-owner disposition for already-authorized bounded experimentation; it does not imply independent approval of candidate code. Childexit0,signalnull,no spawn error. Full actual executable/paths in run metadata.

PatchSHA256: `656c953f5ec3cb0789defd354d0c2bb6badbf91ce9529cc042cfc21709108bd2`.
Executed bundleSHA256: `5d5c38220ff102dc10d4389d39be988cc3b60c60c64fbac1c18a3b02dcfc52ab`.
Build-only bundle hash differs because esbuild's emitted source comments depend on invocation working directory; executable receipt binds the actually executed bundle. Candidate source manifest remains the patch's identity, not the earlier bundle hash.

Baseline `harness.ts/run.mjs/run.json/source-manifest.json/raw-results.tap/raw-stderr.log/observations.ndjson/harness.cjs` hashes unchanged across candidate build/run; all42 parent frozen-source hashes unchanged. Inspection repo remains clean atdbf44d9; origin/main stays pinned4ccf8f48869335e06ac1b1de467d2161869f8fd7. Baseline8RED/7PASS and setup-failure archive are intact. Other worktrees untouched.

## Why this is not production acceptance

Full load/replay cost; double cold load; missing EventLog cancellation/total deadline; fail-closed rather than bounded retry when overtaken; detached reader does not refresh resident command cache; existing sendStateToRoom publication path unchanged; host/readiness/account/owner-race and realRedis/PG acceptance unexecuted. See DESIGN before considering repository code. Existing domain reducers, commit/receipt/clock paths remain textually unchanged, but the12-case run does not certify all R-03/R-04/D3/D4/F3/F4 regression behaviors.

**STOP:** concrete external patch plus honest bounded execution delivered. No production-source implementation, repository edits, DB/Redis/services/network/installs, new agents/worktrees/sessions, commit/push/bot/merge/deployment. Production architecture/API/resource decisions, independent candidate review and all normal final-head gates remain required. D1-B client filtering, D2 draw distribution, fencing and cache policy remain excluded.

## Delivery audit and actual-review reconciliation

Read [Pi actual-harness review](../reviews/PI_D1A_ACTUAL_HARNESS_REVIEW_2026-10-15.md), [Gemini actual server-harness review](../reviews/GEMINI_D1A_SERVER_HARNESS_REVIEW_2026-10-15.md) and [Claude candidate-boundary controls](../reviews/CLAUDE_D1A_CANDIDATE_BOUNDARY_CONTROLS_2026-10-15.md). These completed source/receipt reviews are distinct from the earlier oracle proposals. Reviewers did not execute our harness or accept the candidate implementation. Pi's actual-harness bundle did not include the complete extraction/manifest/observations, so its attribution remained supplied; Claude's earlier42/42 re-hash remains separate valid evidence.

- **Baseline server findings:** Gemini accepts actual F01–F04 controls and S01–S05 stale-response witnesses. S03 remains a history consequence ofS02, not an independent root cause. Same-ply snapshot state is required; no invented draw-broadcast requirement. Actual use of a tokenless spectator—not the verifier returningnull for an authenticated token—is what avoids readiness routing in this fixture.
- **C01 dynamic-stimulus trap:** Pi accepts the baseline client RED, but candidate server success could make C01's dynamically obtained resumed frame fresh. A resulting C01PASS would prove only elimination of that stale stimulus, not a client revision floor. We excludedC01–C03 from the candidate run and claim no client repair. Any future client comparison must capture a fixed/coherently older response and assert it is older before delivery. C02/C03 use genuine state bodies with injected ordering/envelopes, not a complete single-session browser/server trace.
- **F06 qualification:** its snapshot0 plus missed move1 is codec-valid but **an inconsistent recovery cut**. Its pass characterizes behavior for that input only, not a production-reachable coherent resume, implemented animation delivery or proof that all internal replay is absent. Original receipt preserved. A coherent replacement characterization would require a new authorized harness run; none was performed here.
- **F05/F07:** Pi accepts equal-revision reconnect membership and client exact-receipt/no-replay controls. F05 does not independently assert changed socket/generation identities or test stale-generation rejection. F07 injects a receipt, so it tests client handling, not end-to-end command execution/receipt generation. Current GameSync lacks client revision comparison; future D1-B desired assertions are not mislabeled #112 guarantees.
- **Three missing candidate boundaries:** Claude specifies(A) read while owner append is held before/after durable append, preserving slot integrity and exact single receipt; (B) commit after captured load prefix, preserving state/history coherence without an impossible latest-at-delivery claim; (C) delayed load after close/session replacement/token revocation with no obsolete response/room/readiness resurrection. **None is executed by the12-case run.** Exact-receiptF07 and reconnectF05 do not substitute for these server/owner concurrency controls. Their proposed cases require final oracle alignment with the draft's observed-floor/fail-closed policy before implementation/execution; no results inferred from specification text.

| Deliverable / acceptance | Completed and where | Remaining / GitHub status |
|---|---|---|
| Revision foundation | Owner-merged112 is on main4ccf8f48869335e06ac1b1de467d2161869f8fd7 | Does not implement recovery/client filtering |
| Current-main reproduction | External15-case raw receipts:8 behavioralRED/7PASS, with source hashes | Reviewed as bounded baseline evidence; F06 interpretation narrowed; not passingCI |
| Server prototype | External two-file patch and copied source, no repository application | **Not on GitHub**, no independent candidate-code acceptance or production implementation |
| Limited candidate execution | External12 selected casesPASS/EXIT0; source/receipts preserved | Ran before full earlier review gate was met; three owner/cut/lifecycle controls absent; no semantic typecheck/full suite/realPGRedis claim |
| Publication and integration | Coordinator's latest live checkpoint: main4cc,1077f,11429d unchanged | No publication authorized/performed;107's local corrections remain distinct. Mandatory remoteCI/QodoRequirements/exact-head review/thread gates stillHOLD |

**Correct completion statement:** external reproduction and reviewable prototype exist with preserved limited execution evidence. The requested work is **not fully completed as production/GitHub delivery**, and source acceptance/implementation/publication remainHOLD. This reconciliation changes only candidate RESULTS.md and DESIGN.md; all code, manifests, baseline/candidate raw receipts and test counts remain intact. No rerun, commit/push, service or new worker.
