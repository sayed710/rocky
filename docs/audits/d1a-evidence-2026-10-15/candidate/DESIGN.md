# External D1-A server prototype — draft, not repository implementation

Review [server-prototype.patch](server-prototype.patch) and exact copied candidate sources under frozen-src. Baseline42 source files, harness and receipts in the parent directory remain unchanged. Only this candidate's authority.ts/gateway.ts differ. No candidate test execution yet; original Pi client-oracle review still pending at preparation checkpoint.

## Concrete change

GameAuthority.readRecovery uses **existing EventLog.load** once and existing rebuildRecord/viewOf/broadcast slicing to derive one actual committed prefix. It does not install a cache record, advance a cached revision, enqueue behind its own slot, refresh/take ownership, publish events or confirm a request. It captures existing slot identity/generation, rejects superseded/disposed/reloading or locally overtaken completion, and returns a synchronous publication guard. Existing apply/admission/CAS/commit/error/clock/reducer paths are untouched.

Gateway join/resume no longer certify hasFresh as durable truth. Existing ensureLoaded preserves cold resident prerequisites for readiness/host callbacks; the subsequent detached read provides fresh state/history without replacing a busy warm authority. Join checks credentials before I/O and again before seat adoption; role comes from returned players. Per-session/per-game read intent and exact resume membership suppress obsolete success/failure. A room-lifetime observed revision floor rejects response below already-seen state-bearing frames/snapshots; no client cursor field or persistent global cache. Supported state/history comes from one record, not two later public getters.

Readiness stays on existing routed command path after publication, with its original known-rejection retries/idempotence; no read-held command lock. R-03 exact receipt flow and R-04 client/session/socket code are unchanged. Read failure emits existing invalid_command/unknown_game; it is not mutation uncertainty. The generic failed-resume/UI limitation documented in the main plan remains.

## Deliberate draft tradeoff versus earlier planning

Earlier plans proposed a new lightweight readHead interface, primary head/load/recheck and lane installation. This external alternative **does not silently approve or implement that proposal**: latest assignment requests a minimal full-prefix reader using already-existing load. Thus no EventLog/EventStore change, new Postgres API/schema/SQL, ownership adapter or PG-F1 overlap. Owner/coordinator must decide whether the full-load availability/cost model is acceptable before any repository implementation. The same primary-consistent load assumption remains; in-memory execution cannot certify production PG routing/MVCC.

## Honest limits / production acceptance still blocked

- Full log read and replay on every recovery is O(history), including existing supported-prefix legal-map work; no lightweight hot optimization, benchmark or capacity claim. Cold ensureLoaded plus detached read can load twice.
- Current EventLog has no cancellation/total-deadline contract. No unapproved timeout number, abandonment-only Promise.race or synthetic claim of bounded database work. This prototype fails once when an observed/local floor overtakes the candidate; it has no reconciliation retry/budget policy. A production read cancellation/budget decision remains required.
- A load is one observed cut; a later append can be absent. Numeric stateRevision does not prove permanent freshness, exact command identity, same-number restore-content identity or writer authority. Real Redis/PG concurrency and least-privilege evidence remain unexecuted.
- A detached read avoids replacing busy-owner slots, but does **not reconcile** the resident aggregate to its returned prefix. A later command against a lagging local cache retains the existing CAS/reload/rejection behavior; no ordinary command auto-retry. Production stale-slot reconciliation/host-hook policy is unresolved, not declared completeD1-A.
- Room floor handles join/resume publications and observed stamped frames. Existing sendStateToRoom for simple/draw commands remains unchanged, so this draft does not certify monotonicity of every server publication or fix D2 fanout. No cache/lifecycle retirement policy.
- Superseded reads are suppressed; detached I/O itself is not cancellable. Existing in-flight readiness/host command behavior is retained, not newly certified across all account/session races. Focused candidate guard/role/readiness/owner-race tests are still needed before promotion.
- No server-oracle assertion is changed to expect stale success. Candidate harness differs only for event-driven async response waiting and Claude-recommended independent per-case cold witnesses. Source checks are not test execution. Server S03 is a consequence of S02, not a new root defect. Client C01–C03 remain the parent's actual baseline REDs; candidate run selects only F/S cases and must not claim client filtering implemented.

## Review status / execution boundary

Read original Claude harness review and Gemini server-oracle review. Claude validates baseline binding/results and recommends per-case cold witnesses plus a more faithful clientC03; witness hardening is in the candidate harness. ClientC03 baseline is preserved and excluded from candidate execution; no baseline receipts/hashes rewritten. Candidate C02 synthetic ordering remains labeled client-only. Gemini's inversion-style demonstration examples are not adopted; desired-state assertions remain the oracles.

Save patch first for original reviewer examination. Candidate execution awaits actual outstanding oracle-review disposition and required harness corrections, then only bounded serverS01–S05 and foundation controls; no full suite. No source-ready/GREEN/final-head/CI claim yet. Repo source, frozen parent source, baseline rawresults and other agents' worktrees are unchanged. No commit/push/bot/merge, installs/services/network/credentials or new sessions/workers.

### Later execution checkpoint

The preceding preparation statuses are historical. Original Claude harness review and Gemini server oracle were incorporated before a bounded12-case F/S execution, which passedEXIT0; baseline/C-case receipts stayed unchanged. Pi's client-oracle review subsequently arrived and agrees with the stated split; no client production fix/policy claim. See RESULTS.md for raw receipt links and exact limitations. Independent candidate-code review and production acceptance remain pending; full suite and Redis/PG were not run.

### Actual-review reconciliation and corrected acceptance boundary

The bounded run occurred **before all outstanding actual-harness/candidate-boundary results were collected** and did **not satisfy the earlier coordinator execution gate**. Incorporating earlier oracle proposals or setting an internal reviewed flag did not clear that gate. Preserve the factual12PASS receipt while withdrawing any implication that the gate or independent candidate-code acceptance was satisfied.

Pi's actual-harness review accepts baseline client REDs but warns that C01's dynamic server response ceases to test a client floor if the server is fixed. C-cases remain excluded; future client comparison needs a fixed older stimulus with an explicit older-revision precondition. F06 is specifically an **inconsistent-input** characterization (snapshot0/history1), not coherent recovery/animation proof. F05/F07 are limited membership/receipt-handling controls, not server concurrency or exact execution proofs.

Gemini accepts actual server S01–S05/F01–F04 baseline oracles. Claude's additional owner-append, concurrent-load-prefix and closed/replaced/revoked-session boundary controls are **proposals not executed**. The draft's non-mutating cache behavior, observed-floor rejection and readiness/host lifecycle claims therefore remain unaccepted candidate boundaries; final control oracles must respect those distinctions rather than assume universal server acceptance or latest-at-receipt.

External draft only: nothing from this candidate is committed/pushed/onGitHub. Latest coordinator main4cc/1077f/11429d unchanged. Actual-reproduction evidence is complete for its stated baseline scope; production correctness/delivery, independent candidate-code review, resource/API decisions and mandatory remote gates remainHOLD. No reruns or candidate/production source changes in this reconciliation; see RESULTS.md completion matrix.
