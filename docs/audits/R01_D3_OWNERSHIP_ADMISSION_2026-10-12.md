# R-01 PR2: D3 execution-time ownership admission

## Preflight

Supplied worktree `C:/Users/hp/rocky-fix-r01-d3-admission` was clean on
`fix/r01-d3-ownership-admission-20261012`. Status, worktree/branch lists and fresh
fetch confirmed local HEAD/origin/main/GitHub main all at
`202eee3f833e479e43fcafb07f80e539b3361809`. PR #108 was MERGED on 2026-10-12
at 19:46:54 UTC. Historical R-01 audit and PR1 worktrees were read only.
Original verification/remediation-design reports remain authoritative for their
recorded baseline and limitations.

PR #106 remains OPEN at `d03298510b995a6018af6764f1053431267fce28`;
#107 remains OPEN at `cf1bc030c63b97cb2b4a25b8581b4f514f054360`.
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
