# ZadLoop R-06: withdrawal launch recovery

R-06 is a P1 from the separate Claude Opus 5.5 / GPT-6.1 Sol adversarial audit of `e43d4f1d3a66aff6ccebc4f46f7f6e92a309a09e`, supplied by the owner in chat. The original report is not a repository artifact. Historical Fable/Astra closure is separate and unchanged.

## Root cause and reproduction

`Tournament.withdraw` can forfeit the last unresolved pairing and advance the round. The service saved this new round without reconciling launches. The reporter scanned existing game links only, so unresolved pairings without links could remain stalled indefinitely. Two Codex regression tests reproduced the failure on the original implementation, one for Swiss and one for round-robin, with the assertion “next round must have a launched game”.

## Repair

Round service mutations first commit domain decisions through the existing version CAS. A separate reconciliation reads committed pairings, creates games through the idempotent launcher, and saves their links with CAS retries. A failed decision CAS creates no game. Reporter startup and periodic scans recover missing round links, including obligations saved before a launch outage.

New round launches use the deterministic `round-committed-v1` namespace. Existing linked games stay linked under their original identities. Recovery of a newly created game whose link write failed returns the same game even when it has ended; the reporter consumes its durable ending after the link commits. The actual slot reached by probing is saved in the existing `gameAttempts` field, so an abort advances beyond it and creates one replacement. No tournament snapshot schema or database migration is required.

Upgrade recovery first prefers an existing committed game, then checks legacy slots against the committed players, variant and time control. Compatible live legacy games are recovered without creating a duplicate. A matching ending is recoverable while the attempt is zero, proving that no prior abandon was committed. Mismatched unlinked speculative games are retired through the existing game abort rules before replacement. Legacy nonzero endings lack sufficient abandon provenance; mismatched games beyond the abort boundary cannot be safely retired. Both cases fail closed with an operator-repair error instead of inventing scoring or forcibly ending played games.

Launch errors may be returned after the domain mutation has committed. That committed obligation survives for reporter recovery; callers must not interpret a launch error as rollback. Typed player-lock exhaustion still returns the established 503. Arena code, authorization and registration UI are unchanged.

## Executed regression evidence

Ten new tests cover both formats: round-completing withdrawal, rejection of all decision CAS retries without speculative game creation, barrier-forced concurrent withdrawal and committed outcome, concurrent/repeated reconciliation, two reporter restarts with ten scans each after launch outage, and recovery of a committed abort after game creation but before link persistence. The recovery/concurrency tests use the production `DurableGameLauncher` with in-memory event and tournament repositories and assert each launch matches a pairing already durably stored. They do not claim PostgreSQL integration evidence.

Qodo's initial-head review found upgrade duplication and reuse of an aborted probed slot. Both were reproduced in Swiss and round-robin tests before correction. Fourteen additional cases now cover compatible legacy recovery across replicas, actual legacy slot persistence, safe refusal to retire a played mismatch, first-launch ending recovery, refusal of ambiguous legacy endings, concurrent retirement of speculative mismatches, and real reporter consumption of a probed-slot abort.

## Independent review

The actual installed `agy-delegate` relay ran Gemini 3.8 Flash High at high effort in read-only mode. Pre-fix conversation `b3fe9931-c309-4135-9fb6-9e1497df9515` confirmed the launch and reporter gaps. Codex rejected its P0 rating and recommendation to reconcile inside a speculative callback, and independently reproduced both failures. Subsequent review evidence is recorded in the PR delivery report; no review is inferred from a requested run. No quota fallback was used.

## Draft append-only PROJECT_STATE entry for coordinated integration

Do not apply during the concurrent remediation wave. Append only after owner-coordinated integration, replacing pending fields with verified integration evidence:

> ZadLoop R-06 — round withdrawal launch recovery: withdrawal-driven round transitions commit before launching games; reporter scans recover missing links; deterministic committed-round launch identities and CAS retries converge across replicas and restarts, including an ending before link persistence. Swiss and round-robin regression coverage added. PR and final-head gate evidence: pending delivery report. Owner merge and current-main integration verification remain separate.

## Initial-head local validation

Full build and lint passed. The full hermetic orchestrator completed all 19 workspaces: 4,026 tests, zero failures, zero skips. Guard-script tests passed 324/324. Build-order, ADR-claim, CI-parity, variant-parity, engine-pin-parity and test-topology guards passed. OpenAPI regeneration had zero content drift. The gateway built from a clean dependency install; local Linux runtime execution was unavailable because Docker Desktop startup failed on an inaccessible existing secrets-engine socket. No Docker socket or configuration changes were made. PostgreSQL/Redis/engine/browser CI and exact-head remote reviews remain separate gates in the delivery report.

Post-fix Gemini conversation `8985bb4b-0a42-4e6b-9492-58f1767917c0` approved the commit-first patch with no blocking findings and reported executed targeted tests. Its optional extra-read observation was retained: the reporter reloads durable links before processing outcomes. The relay marked `readOnlyViolation: true` because the review overlapped Codex corrections to the test constructor and OpenAPI generation; this run is not claimed as clean-tree evidence. Final exact-head review is dispatched only after committing a clean tree, without concurrent writers or generator runs.

## Corrected-patch verification

Both Qodo bugs reproduced before correction in both formats. A full rerun then exposed the retirement race using the event store's `ConcurrencyError`, distinct from tournament snapshot `VersionConflictError`; the typed reload retry was corrected and the concurrent-replica tests passed. The subsequent full build and lint passed, and all 19 hermetic workspaces completed: 4,040 tests, zero failures, zero skips. The 30 focused durable/R-06 tests passed. OpenAPI remained unchanged; the ADR-claim and topology guards were repeated successfully. The earlier 324 guard-script tests and other unchanged parity guards remain applicable.

Fresh Gemini 3.8 Flash High / high-effort post-fix conversation `a266151e-0562-40d1-bdc2-5b7710813444` reviewed the corrected worktree with no actionable blocking or non-blocking findings. It executed the 30 focused tests, 77 domain tests, and relevant API/Arena/variant/commentary tests. The relay verified `readOnlyViolation: false`. Optional event-load and logging optimizations were deferred from this correctness repair. The initial exact-head attempt on `e175b93` was interrupted after Qodo's findings and is not counted as completed evidence. The final committed exact-head review and fresh PR gates are recorded in the delivery report.
