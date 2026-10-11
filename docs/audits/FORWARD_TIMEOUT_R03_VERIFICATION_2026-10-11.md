# R-03: forwarded command expiry and uncertain acknowledgements

This is a separate correctness audit against main
`c4462c1725b108e18d6bd35a4e9306dc11be8f02` (merged PR #103). It does not reopen
historical Fable + Astra closure or deferred findings. The owner approved option
1: unstarted queued commands expire; admitted execution with an unconfirmed
durable outcome is **unknown**, never a confirmed rejection/cancellation, and
is never automatically replayed. Only the owner may merge.

## Original failure and correction

The [preflight record](FORWARD_TIMEOUT_R03_PREFLIGHT_2026-10-11.md) preserves the
original deterministic RED. On original production router/consumer/authority,
simulated Redis response timeout left a resignation queued; delayed consumption
appended seq=1 `GameEnded` for Black's win by resignation. One original test
failed at the unchanged-event-log assertion; the committed/lost-ack replay
control passed. This was simulated Redis and InMemoryEventLog evidence, not
PostgreSQL or real Redis evidence. The transport helper was subsequently updated
for the new wire lifecycle; original RED belongs to the initial regression
version, not the modern helper reverted in isolation.

The old envelope had no lifetime, consumer checked no expiry, and timeout
takeover reapplied the same intent independently of the original envelope.
Request UUIDs identified reply queues but did not deduplicate execution.

Current implementation:

- `services/gateway/src/forwarded-request.ts` contains atomic Lua transitions.
  Enqueue records the exact server-generated envelope and a deadline using
  **Redis TIME**; gateway wall-clock skew is irrelevant. The effective duration
  retains the prior BLPOP rounding (at least one second, rounded up to seconds).
- `GameAuthority.apply` has an optional admission guard. It runs inside the
  existing per-game lock, after stale-log refresh and before domain decisions or
  append. Local commands do not perform a Redis admission round trip.
- Admission verifies the exact payload, request status, deadline and current
  Redis owner. Only `queued` before its deadline can become `started`.
  Cancellation atomically expires only queued work and removes its envelope.
  Whichever transition wins determines the timeout contract.
- An obsolete consumer requeues only still-unstarted, unexpired work under the
  same identity/deadline and stops itself. Admitted execution is never requeued.
  Timeout no longer performs local takeover execution. A subsequent new request
  can claim/reload via the normal ownership path.
- An executor records its result only under its admission token. A lost response
  can be reconciled from that retained result. Failed response publication
  cannot overwrite a successful result with a failure. Atomic response push/TTL
  prevents abandoned response keys from losing their expiry.
- Enqueue alone uses a dedicated connected client with offline queuing,
  automatic unfulfilled-command resend, reconnect retries and per-request retries
  disabled. The shared ownership client's indefinite recovery must never resend
  an enqueue after its request tombstone expires and recreate its deadline.
  This same socket waits for the response, keeping one socket per normal forward.
  Connection/command I/O and the separate settlement connection have bounded
  effective-timeout budgets; failed reconciliation reports unknown. Request
  failures retain tracing/counters instead of unstructured ioredis stderr.
  The response client has one second of I/O grace beyond Redis's BLPOP timeout;
  it does not extend the Redis execution deadline. Failure before enqueue is
  even invoked is a definite undispatched refusal, preserving safe readiness
  retry. Once dispatch begins, missing metadata still means unknown.
- `started`, missing or unreconcilable state reports unknown. Opaque persistence
  failures are distinct from proven atomic append rejection. The latter is
  marked by EventLog/persistence concurrency errors and retains the existing
  readiness retry; unknown readiness commits are not retried automatically.
  Confirmed pre-admission expiry also permits a bounded new readiness attempt;
  the expired identity itself is never replayed.
- Public `outcomeUnknown` is a separate message with request/correlation ID and
  move reference, not a `reject` frame. The browser never resends its pending
  intent. A snapshot releases its optimistic input gate, while an unchanged
  snapshot retains the uncertainty notice; a new explicit gesture is a new
  request, not automatic replay or proof of cancellation.
  Successful forwarded execution publishes `commandConfirmed` through existing
  per-game pub/sub with the exact request ID. A bounded 32-ID receipt history
  handles reordered confirmation/unknown frames without replay. Similar moves
  or draw state cannot identify a request; they never clear its notice. A new
  gesture also retains it. Explicit readiness correlation can additionally
  resolve from the player's monotonic durable ready seat; terminal game state
  safely ends further gameplay. Missing/lost receipts leave uncertainty visible
  while the snapshot releases input. This adds no durable client ledger.

## In-flight and lost-acknowledgement contract

Admission, not durable COMMIT completion, is the execution boundary. A request
waiting on loading or the game lock remains unstarted and can expire. Once
admitted it can finish after the response deadline: reporting unknown never
rolls back, cancels or replaces an authoritative durable outcome. PostgreSQL
sequence checks and event replay remain unchanged.

Redis results are retained for 30 seconds after admission/completion; queued
records retain their deadline plus 30 seconds. Missing state never authorizes
execution and is never recreated from a delivered envelope, including after
retention expiry. This preserves admission safety while limiting reconciliation
history. Idle queues have bounded TTL, new requests never shorten a live queue's
retention, and each enqueue prunes up to 128 abandoned/expired head entries.
Active forwarding cancellations also remove their own envelopes.

Forwarded identity is stable across dequeue, handoff, duplicates and settlement.
It is not a durable client idempotency token. Local uncertainty IDs correlate
the notification; they do not introduce local request deduplication. Existing
move `clientSeq` protects the session, not cross-session retries. No general
exactly-once guarantee across new request IDs or destructive Redis rollback is
claimed. Autonomous expiry passes retain their existing durable-log/domain
re-evaluation; they do not recover/replay a timed-out envelope.

## Independent review and corrections

All runs used the genuine installed agy-delegate relay, agy 1.3.3,
`gemini-3.8-flash-high`, high effort, read-only. No model fallback occurred.

- Pre-fix conversation `e6778f70-34de-4228-b0d8-07b838f8960c` confirmed the defect.
  Codex challenged evidence overclaims, duplicate-attempt versus commit claims,
  session `clientSeq`, unsafe legacy fallback, lease-margin limits and dequeue-only
  deadlines. Gemini accepted all six corrections. Its first fingerprint was
  contaminated by concurrent Codex additions; resumed discussion proved no
  working-tree changes. Details are preserved in the preflight note.
- First post-fix attempt failed with a real network connection error and yielded
  no usable review. It was not counted as acceptance or model quota failure.
- Post-fix conversation `58382fa4-c39f-4b38-879c-9c9bfd380449` found the permanent
  UI gate and local false-rejection path. Both were corrected and regressed.
  The resumed discussion verified these and the ownership handoff correction,
  and reported no remaining R-03 blocker/requirement gap. It accepted Codex's
  scope challenges: unsupported Redis Cluster migration and general R-01 resume
  freshness are not part of this fix. Both completed snapshots were unchanged
  (`readOnlyViolation=false`).
- Subsequent validation caught an introduced readiness regression: 92/93 passed,
  the concurrent-seats readiness test failed because a definite sequence conflict
  had been classified as unknown. The explicit append-rejection marker restored
  safe retries; 94/94 passed, including lost readiness/local commit acknowledgement
  and separate uncertainty-wire regressions. This later correction requires the
  fresh final committed-head review; earlier sign-off is not evidence for it.

Raw relay artifacts are under `C:/Users/hp/AppData/Local/Temp/rocky-r03-*`.
Exact final-commit review and subsequent CI/bot evidence are recorded against the
published PR head, without rewriting historical review claims here.

PR #105's first head `362e363` received genuine Gemini final review, but its
validation table mixed earlier counts with a failed reviewer loopback run.
Codex challenged those unsupported claims; none are adopted as executed
evidence. The head is superseded by later corrections. Qodo's initial explicit
zero-count response was also superseded by its line-level findings: retain move
correlation beyond snapshot release, display late uncertainty, and retry only
definitely expired readiness. Greptile independently found the stale notice and
a P1 automatic ioredis enqueue resend after metadata retention. All were accepted
and corrected with regressions; exact-head reviews and CI must be refreshed.
Gemini's subsequent code-only review of `6ad3cb6` found draw-action correlation,
disputed-ply notice, unbounded response I/O, extra normal-path socket churn and
unstructured error emission edge cases. These were addressed with retained
action correlation, positive durable-ply reconciliation, bounded isolated I/O,
socket reuse and request error handling. The code-only review makes no execution
claims; its head is superseded and final recheck/CI must be refreshed again.
The later real Qodo engine review (requested with `/agentic_review`, rather than
chatting with `@qodo`) found actionless readiness miscorrelation, unresolved
readiness, definite pre-dispatch failure classified unknown and the client timer
racing Redis's empty BLPOP reply. All were corrected and regressed. Greptile
overturned Gemini's disputed-ply suggestion: an unstarted queued UCI can remain
live and execute on a later turn after owner-local moves. A deterministic
production-path regression proves `g1f3` executes at ply 3 after `d2d4,d7d5`,
before the original deadline, following lost enqueue acknowledgement/failed
settlement. Consequently even position similarity is not request confirmation;
the final client uses an exact successful request receipt. Earlier Gemini
sign-offs and zero-count chat responses are superseded, not final acceptance.
New test validation also caught a wrong event-kind assertion (`MoveMade` rather
than `MovePlayed`) and an unnarrowed TypeScript union; both test mistakes were
corrected before clean compilation and green regressions, not treated as flakes.
The independent code-only review of `d3a779f` reported zero findings; a subsequent
Codex regression nevertheless exposed readiness correlation using the current
role after a changed join (35 passed, one failed). The notification now carries
the original server-known `readyColor`; snapshots and broadcasts reconcile that
seat even after the client's role changes. Missing seat metadata remains unknown.
This changes R-03 correlation only, leaving R-04 authentication to its owner.
That review is superseded; a fresh published-head review is required.
Qodo's real engine review of `b791e30` then found two valid client gaps that
Gemini's zero-findings review missed: overlapping unknown requests overwrite
each other, and retaining an older warning hides a newer definite refusal.
Four assertions reproduced these failures (35/39 passed). Client uncertainty is
now retained independently by request ID, with action/seat metadata per entry;
each receipt or positive readiness state settles only the relevant entries.
The existing UI message combines the remaining warning with the latest refusal.
No controller/authentication change is needed. Clean compilation and **40/40**
GameSync tests pass, including both response orders and readiness/move overlap.
Both accepted findings and all prior sign-offs require fresh final-head reviews.
Unresolved identities are capped at 32. Overflow retains an aggregate warning
until terminal game state instead of silently forgetting possible executions;
it does not fabricate an exact receipt or trigger replay. The bounded receipt
cache likewise does not promise durable client request history.
Greptile's exact `648b6cb` review identified another valid follow-through gap:
the `resume` response after confirming an older request erased the newer
refusal. The extended correct-wire regression failed (39/40 passed). Snapshot
and late move reconciliation now retain the refusal until a new user command
or terminal state, while each unknown identity remains independent. The extended
GameSync suite passes **40/40**. Earlier exact-head reviews are superseded.

## Validation

- Full build and lint passed. Fresh hermetic run: **4,048 tests**, 19 workspace
  summaries, zero failures/skips/cancellations; counts anchored to complete
  `ℹ tests` lines, not substrings in test names.
- After incorporating merged main PRs #102/#104, the committed first PR head
  passed full build/lint, **4,079** hermetic tests, **333** script tests, and all
  eight guards, with zero failures/skips/cancellations. Its real-Redis/PG gateway,
  persistence integration and browser acceptance CI jobs passed. Those results
  do not substitute for fresh CI on the subsequent corrective head.
- Corrective focused regressions: forwarding/tracing **20/20**, realtime
  **95/95**, client GameSync **28/28**. Final-head evidence is tracked in PR #105.
- That corrective committed head passed **4,083** local hermetic tests with zero
  failures/skips/cancellations. Subsequent edge-case regressions pass
  forwarding/tracing **22/22**, realtime **95/95**, and GameSync **30/30**.
  Current-head full affected-suite, build/lint and CI evidence is tracked in
  PR #105; no prior head is substituted for final readiness.
- Latest receipt/readiness/dispatch regressions pass forwarding/tracing
  **25/25**, realtime **95/95**, GameSync **35/35** after clean compilation.
- At `d3a779f`, full build/lint and **4,090** hermetic tests across all 19
  workspaces passed with zero failures/skips. After the original-seat correction,
  fresh full build/lint, eight guards, forwarding/tracing **25/25**, realtime
  **95/95**, and GameSync **36/36** pass. The subsequent full run and final CI
  remain tracked in PR #105; the earlier head is not substituted for final gates.
- At `b791e30`, the full run completed: **4,091** hermetic tests across all 19
  workspaces, including web **1,528/1,528**, with zero failures/skips. Real Redis/PG
  gateway, persistence, engine and browser acceptance CI passed on that head.
  These results are historical after the overlapping-outcome correction, whose
  web build/lint and **40/40** focused GameSync tests pass; final CI is refreshed.
- At `648b6cb`, **4,095** hermetic tests across all 19 workspaces passed,
  including web **1,532/1,532**, with zero failures/skips. The final refusal-text
  retention correction preserves these test counts; fresh execution and final
  CI/reviews are recorded in PR #105 rather than substituted from this head.
- Focused forwarding/tracing: **19/19**, including original safety assertion,
  lock wait, admission cutoff, append/timeout race, retained results, lost enqueue,
  finish/response failures, duplicate/retention safety, legacy rejection, load
  failure cancellation and ownership handoff. Client synchronization: **25/25**.
  Realtime package: **94/94**, including existing readiness, no-show and flag races.
- Eight repository guards and **324/324** script tests passed before the final
  documentation update; documentation guards are rechecked before publication.
- Added real-Redis tests cover delayed resignation, append/timeout race and
  duplicate delivery, queue retention/pruning and obsolete-owner handoff.
  Added actual PostgreSQL/Redis regression proves expired resignation leaves
  the event log unchanged; existing two-replica no-show/flag integration workflows
  exercise the production path. All compile locally, but local execution is
  unavailable because Docker Desktop's Linux engine is unavailable. **The complete
  zero-skip gateway CI and PostgreSQL CI must pass; mocks do not replace them.**

## Rollout and operational limits

The deployed client uses standalone `ioredis.Redis` against one authoritative
Redis endpoint; Redis Cluster is not supported by these scripts. Admission
requires Redis availability; opaque transport failures report unknown. Do not
restore an older Redis snapshot while gateways are active: lease/request-state
rollback is outside the existing coordination guarantees. Missing/evicted state
fails closed; restored stale queued state is not equivalent to missing state.

Deploy the web build that recognizes `outcomeUnknown` and `commandConfirmed`, refresh existing clients,
and coordinate replacement/drain of all old gateway owners. New traffic uses
`game:cmd:v2:{gameId}`, so old consumers cannot ignore new metadata and execute
it. New consumers reject unversioned envelopes and never import old queue
backlogs. Mixed releases can refuse commands while an old lease remains; there
is no transparent mixed-release availability guarantee. Once every old process
has stopped, quarantine/expire abandoned legacy queues; never replay them as
new requests. Old binaries cannot retroactively gain this safety contract.

General non-owner state freshness (R-01), cache eviction (R-02) and client token
rejoin (R-04) remain separate. An unchanged/stale resume snapshot is not a
negative command receipt. The uncertainty notice never says the request was
cancelled. Redis result retention is bounded; subsequent game events/replay are
authoritative even when a per-request acknowledgement can no longer be recovered.

## Delivery and coordinated state entry

Concurrent R-04 work owns reconnect authentication. R-03's minimal shared
`game-sync.ts` edits handle the new uncertainty message, preserve its notice
during inconclusive snapshot/move reconciliation, and release pending input
without replay. Its `game-sync.test.ts` addition exercises only that contract.
No token, join or reconnect authentication logic is changed. Read-only inspection
of the R-04 worktree found no current diff in either shared file; future edits
around joined/resumed snapshot handling remain an integration risk. Preserve
these R-03 semantics when combining the PRs and rerun both regression suites.
The attempted authorized thread coordination message was rejected because the
R-04 thread already had an active writer; no changes were made to its worktree.
Later R-04 source edits produced one concrete conflict in a normalized temporary
three-way merge: R-03's conditional `lastReject` versus R-04's `lastReject: null`
and `connected: true`. Keep the conditional uncertainty notice and `connected:
true` together when integrating. The test file merged cleanly. Subsequent R-03
receipt-correlation corrections do not add authentication behavior. Neither
combined patch was applied to a source tree; owner integration must rerun both
suites against their final heads.
After retaining multiple unknown outcomes, the corresponding R-03 snapshot-tail
assignment is `lastReject: this.commandNotice()`. Integration must retain this
derived notice together with R-04's `connected: true`; the dependency remains
outcome handling, with no token/session/reconnect implementation in R-03.

One focused implementation PR; no main push, force push, merge or deployment.
Final readiness requires applicable CI green, Qodo bugs/rules/actionable gaps=0,
Greptile review of the exact final head with no actionable findings, fresh
independent final-commit review, and unresolved review threads=0. Any missing
gate means **NOT READY FOR MERGE**. Inspect valid CodeRabbit feedback if available;
rate limitation does not substitute for the mandatory reviewers.

`docs/PROJECT_STATE.md` is intentionally unchanged while concurrent PRs are open.
Proposed append-only integration entry:

> 2026-10-11: Separate R-03 forwarding fix uses Redis-time admission/cancellation
> under the authority lock, preserves durable outcomes, reports explicit
> uncertainty and prohibits timeout replay. Original delayed-resignation RED
> and focused concurrency/lost-ack controls are verified; local build/lint,
> full hermetic tests and guards pass. Published-head distributed CI and review
> gates are tracked in the implementation PR. Requires coordinated v2 gateway/web
> rollout; no general exactly-once or Redis rollback guarantee. R-01/R-02/R-04,
> historical audit closure and owner merge/launch decisions remain separate.
