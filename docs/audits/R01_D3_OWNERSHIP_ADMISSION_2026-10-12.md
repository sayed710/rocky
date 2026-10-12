# R-01 PR2: D3 execution-time ownership admission

## Preflight

Supplied worktree `C:/Users/hp/rocky-fix-r01-d3-admission` was clean on
`fix/r01-d3-ownership-admission-20261012`. Status, worktree/branch lists and fresh
fetch confirmed local HEAD/origin/main/GitHub main all at
`202eee3f833e479e43fcafb07f80e539b3361809`. PR #108 was MERGED on 2026-10-12
at 19:46:54 UTC. Historical R-01 audit and PR1 worktrees were read only.
Original verification/remediation-design reports remain authoritative for their
recorded baseline and limitations.

At initial preflight PR #106 was OPEN at `d03298510b995a6018af6764f1053431267fce28`;
#107 was OPEN at `cf1bc030c63b97cb2b4a25b8581b4f514f054360`.
#106 overlaps consumer cleanup; #107 has no D3 source overlap. Neither was merged
or cherry-picked. Future #106 integration must run its temporary expiry-copy
cleanup plus R-03/R-04 exact receipt, authentication, readiness and expiry
regressions on the integrated head.

## Executed baseline RED

Fresh disposable Redis 7 and pgvector PostgreSQL 16; two independent production
registry/router/consumer/authority instances in one Node process, production
PostgresEventStore and controlled EventLog append timing. The owner explicitly
allowed existing migrations solely to initialize disposable test databases.

1. Old owner acquires a real three-second lease and settles initial reload debt.
2. White b1c3 is admitted and pauses before its actual durable append.
3. Legal Black e7e5 is observed queued in the production stable slot while the
   old owner's local lease is still valid.
4. Actual Redis key expires; successor claims and loads durable ply 0.
5. Releasing the first append lets both old-owner moves commit.

Observed at unchanged merged PR1: `secondPly:2`, `durableSeqs:[0,1,2]`,
`successorPly:0`. Desired queued-command refusal assertion failed, exit 1.
This is executed failure, not inferred or manufactured evidence. The committed
real-service test repeats the same actual lease/append/queue schedule.

Primary harness/output and review provenance are preserved locally at
`C:/Users/hp/.codex/visualizations/2026/10/12/01a131ab-e72f-79a0-a478-35f103d194db/d3`.
Original historical audit artifacts were not changed.

## Repair and focused GREEN

[ADR-0160](../adr/0160-execution-time-ownership-admission.md) defines the minimal
policy. Immutable tickets survive hydration and queue waits. Registry identity
is separate from reload-debt generation; slot lifecycles are not reused. Owner
comparison is isolated, non-buffering, non-resending and bounded. Synchronous
final rechecks cover the promise-continuation gap and reload/freshness changes
without reentrant locking.

The RED schedule now leaves PostgreSQL at seqs `[0,1]`, returns `command_expired`
for the second intent and lets the already-admitted first finish at ply 1.
No obsolete domain advancement, append, move broadcast or success receipt occurs.
No command is silently rebound, forwarded or replayed.

Focused authority suite: 113 passed, zero failures/skips. Focused real-service,
ownership, R-03 and admission suite: 47 passed before the final early-refusal
tombstone test. Final focused R-03/admission run: 30/30, zero skips. Schedules
cover actual expiry, same-node reclaim, hydration generation changes, held real
Redis reply crossing local expiry, blackholed comparison TCP socket, first
forwarded takeover-debt settlement, generation/lifecycle/reload races, bounded
timeout releasing the slot, recreated-slot ABA, exact receipts and single-node
routing without Redis.

The new tombstone test initially failed TypeScript/runtime because of a missing
requestKey import. That setup failure is not passing evidence; the corrected
focused run completed successfully. Full clean-install and final-head/external
validation remain separate gates at this documentation checkpoint.

## Reviews and limits

Pre-fix Gemini 3.8 Flash High, effort high, agy 1.3.3 completed read-only against
the unchanged baseline: project `c4bd29a1-21c2-4a48-9026-eb908eddda4c`, conversation
`be1cf997-728f-4315-8327-b4a577e739e1`; no tracked edits. It confirmed the missing
in-lock local check and identified debt/identity separation, post-await checks,
ABA and reentrant-refresh risks. Later review provenance is recorded separately.

These are two instances in one process, not two deployed processes, actual
process kills, cluster partition or browser certification. Held-reply scheduling
controls the Redis adapter response seam. Blackhole verification uses an actual
TCP server accepting but never answering the isolated comparison socket.
Production node IDs must remain unique. One short-lived comparison connection
per local intent adds Redis round trips and connection overhead; public-scale
throughput is not certified here.

An already-admitted old owner can still append after takeover; the successor can
remain stale after that append. This PR does not provide PostgreSQL fencing,
D1 recovery or later repairs. No new production migration, deployment,
public-launch approval or owner merge was performed.

Unchanged root lockfile npm audit reports existing high-severity source-map-js
GHSA-68fv-2mgg-jv7q; independent gateway install reports zero vulnerabilities.
Dependency remediation is outside D3.

Full applicable local gates, post-fix/exact-head independent review, CI,
Qodo Bugs/Rules/Requirements zero, fresh exact-head Greptile and resolved review
threads are required before owner-ready delivery. Any new push invalidates older
exact-head approvals. Actual publication/final-head results are reported
separately; pending gates are not treated as passed.

## Owner-merged PR #106 integration checkpoint

The owner subsequently merged #106 at 20:22:59 UTC on 2026-10-12. Required fresh
status/worktree/branch/fetch checks verified origin/main and GitHub main at
`dd7fec5751f1501e10659a66ed940d5c5b2ceacb`. The full D3 candidate, including
previously uncommitted tests/docs, was preserved as checkpoint `c6dc537`;
existing evidence and a tracked patch were retained outside the worktree.

From a clean feature branch a normal merge produced
`0a9532b7d1729c4905a33d3ac7c0a9452c082554`, with no conflicts. PR #106's
UnownedForwardedRequest releaseExpiryCopy cleanup and both its deterministic
and actual Redis/PostgreSQL regressions are present. Web files are byte-identical
to merged main; there is no R-04 source modification in the D3 delta.

Before integration, full build/lint, all 19 hermetic workspaces, clean Linux
gateway 132/132, script tests 333/333 and eight repository guards passed.
Those are historical pre-integration results, not integrated-head approval.
The in-progress post-fix Gemini run was interrupted at the owner's integration
request after entering a background-task wait; retained partial logs receive no
review approval credit. Fresh integrated/exact-final-head reviews and all
mandatory validation are required. No force push, discarded work, main-branch
write, PR merge or production migration occurred.

## Integrated validation and final source-review correction

At the merged checkpoint the full build/lint and 19 hermetic workspaces passed
(4,164 tests); Linux gateway 141/141, focused regression matrix 75/75, authority
113/113, browser Chromium 285/285 with retries disabled, script tests 333/333,
load unit 86/86, real Nginx trusted-edge/web-delivery 20/20 and all eight guards
passed. All counted suites had zero failures and skips.

The first POSIX load invocation lacked the deploy folder in the gateway image;
the corrected invocation mounted that folder read-only and passed 1/1. The first
API POSIX container invocation lacked an init process and failed detached-worker
liveness verification (1 pass/1 fail); unchanged source with Docker --init passed
2/2. Failed invocations are retained and are not passing evidence. No unrelated
worker fix was made.

Integrated Gemini 3.8 Flash High/high effort, agy 1.3.3, read-only completed
20:32:23–20:38:41 UTC, project a624cea0-05e1-4003-9b32-3807b62d9ba3,
conversation d5bc9fe1-bfc7-4f27-ad06-3dbcea5c5584. It reported zero actionable
findings, with readOnlyViolation false. This checkpoint review is historical;
it is not approval for subsequent changes or the eventual published HEAD.

Final source inspection then reproduced an additional D3 ABA schedule: after
local expiry, a same-node SET NX reclaim creates the actual key but its reply
is held; periodic renewal refreshes the old local generation before that reply.
The deterministic test failed (old ticket current: true, expected false).
Expired tracking is now invalidated before claim I/O and before renewal; a late
renewal response crossing local expiry also cannot resurrect continuity. New
claims create new tickets and reload debt. Both schedules pass among the final
11 deterministic admission tests. The corrected full Linux Redis/PostgreSQL
gateway suite passes 143/143, zero skips. Fresh post-fix/exact-head review and
publication checks are required after this correction.

Corrected post-fix Gemini review completed read-only at 20:45:29–20:52:53 UTC,
project 73b4e941-2e21-4bb1-b185-a0f6419be3ad, conversation
73f721cd-5cc5-4b4e-a1df-7eb488e0d955: zero actionable findings,
readOnlyViolation false. Model/effort/agy version remained Gemini 3.8 Flash
High/high/1.3.3; no fallback. Final published-head review remains a separate gate.

Corrected full build/lint and workspace 4,164/4,164 passed; script unit 333/333,
eight guards, API PostgreSQL 109/109 and persistence PostgreSQL 210/210 passed,
all zero skips. Persistence's first run was 209/210 because its redaction test
requires a non-empty password but the disposable trust-auth URL omitted one;
the corrected full invocation supplied an explicit disposable test password.
The first script PostgreSQL invocation in the gateway image lacked pg_dump and
Docker; unchanged tests on the host using existing Docker tooling passed 2/2.

The first corrected browser run lost Vite preview with Windows exit 0xC0000409
and was interrupted, not credited. The next four-worker run finished 283/285;
achievements visibility and analysis enabled assertions timed out with pending
HTTP requests in the retained traces. A serial full run uses the original
assertions/timeouts and zero retries; its result is recorded separately.
No web or unrelated worker source fix was made for these environment failures.

The serial full Chromium run completed 285/285 (9.1 minutes), zero skips and
zero retries, using unchanged assertions and timeouts. This separate passing
run does not erase the retained failed invocations or establish their root cause.
Final publication, CI and external exact-head gates remain separate.

## Published review corrections (8406722 superseded)

The actual Qodo engine review at issuecomment-6132624361 reported three bugs:
per-intent connection overhead, stopping consumers at conservative local expiry,
and missing comparison diagnostics; rules zero. Two deterministic failures
confirmed the consumer/late-renewal availability issue. Ticket invalidation now
retains the consumer while Redis may still route to this node; a successful
renewal after expiry establishes new identity and reload debt. A real Redis/PG
held-renewal schedule proves a forwarded intent receives a definitive refusal
during the gap, and a new forwarded intent succeeds after renewal. Its initial
overloaded-eval wrapper failed TypeScript; after correction the compiled test
passed. That compilation failure is not passing evidence.

Bounded reason counters and comparison latency metrics now diagnose failure
without unbounded labels or raw errors. Per-intent connection isolation remains
a documented minimal-repair tradeoff; this is not public throughput certification
or the excluded R-02 cache-capacity work. Fresh Qodo reassessment is required.

Greptile at the same published SHA identified overlapping claim responses that
could preserve a generation installed by another pending claim, plus missing
barrier-test timeouts. The actual schedule admitted an obsolete queued move
and failed its expected-refusal assertion. Claim renewal replies now retain
identity only if the generation observed at dispatch is still the same and
locally valid. The 13 deterministic admission tests pass, and all newly scheduled
barrier tests have explicit bounded timeouts. Fresh full final-head gates remain
required. The first exact-head Gemini review (project
f1d51840-ea30-4147-83fe-8e26b834b39e, conversation
3212e0ad-ac14-4006-add5-c8c15442bd2d) reported zero findings at 8406722;
it is retained as historical evidence and is superseded by these corrections.

Renewed corrected build/lint and all 19 hermetic workspaces completed with
4,164 tests and zero skips. Service build/lint, 13 admission tests, and the clean
Linux full real-service gateway suite completed 146/146 with zero skips. ADR,
topology, CI-parity and observability guards passed. The new metrics use four
bounded reasons; tests assert timeout/error/mismatch counts and one duration
sample per attempted comparison. All external exact-head approval must be
renewed after the normal follow-up push.

## Lease-operation ordering correction (876a2b0 superseded)

Fresh Qodo at 876a2b0 found four additional concrete schedules: release deleting
a concurrent same-node claim, an absent generation hiding release from a late
renewal, older claim expiry overwriting newer renewal, and continuously valid
concurrent claims replacing each other's identity. All four newly controlled
tests failed before correction (Redis key missing despite completed claim;
ownedCount 1 after release; valid lease false after newer renewal; and a valid
queued gesture refused). A real Redis/PG schedule against a preserved 876a2b0
Linux image also failed with ownedCount 1 after actual Redis deletion. The test
used an injected local clock and held the real successful renewal reply; the
complete failed TAP run is retained. This is not fabricated baseline evidence.

Per-game claim/release/renewal I/O now shares a separate operation lane. A
synchronous release epoch invalidates pending replies even when both admission
generations are absent. A cancelled local claim is mapped to command_expired,
without automatic forwarding. Continuous valid claims keep identity; later
renewals cannot be overtaken by older claim acknowledgements. Dispatch timing
is captured after lane waiting. Idle lanes are removed; renewal ticks coalesce
the outstanding write. No authority-slot hydration is awaited from this lane.

All 19 deterministic admission schedules pass, including cancellation of a
claim gesture before hydration and shared outstanding renewals. Full local and
fresh published-head gates are being repeated. Greptile's 876a2b0 review was
clear (5/5); CI was green with final browser 285/285 and no reported retries,
but both are historical, not approval for this correction. The in-progress
second exact-head Gemini run was interrupted after Qodo's new findings and
receives no approval credit.

The corrected clean Linux full gateway suite passes 153/153, zero failures/skips,
including the same real late-renewal/release schedule. All 19 deterministic
admission tests pass. Renewed full root build/lint and all 19 hermetic workspaces
complete with 4,164 tests and zero skips; standalone service build/lint, ADR,
topology and observability checks pass. The combined diff remains 11 D3-focused
files with no web-source delta against merged main. Fresh published-head CI and
external reviews are required after the next normal push.
