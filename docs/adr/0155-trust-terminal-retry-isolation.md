# ADR-0155 — Durable retry isolation for trust terminal analysis

**Status:** Proposed for owner review
**Date:** 2026-10-02
**Extends:** ADR-0144, ADR-0152

## Context

At `origin/main` `f9144a2`, the two trust consumers derive work from committed
`GameEnded` events and write per-consumer receipts only after successful report
upserts. Forward and reverse keyset scans prevent starvation, but every scan
retries poison work and rolling-update overlap can repeat expensive engine work.
Anti-cheat walks all game plies, with up to two engine searches per ply. Depth 18
and the engine's inactivity watchdog do not bound total game-analysis duration.
The Helm 300-second termination grace is a shutdown budget, not an analysis limit.

## Decision

Migration **0048** adds `terminal_event_retries`, keyed by
`(consumer, game_id, seq)`, with failure count, next retry time, lease token and
expiry. Consumers are constrained to `bot-analysis` and `anti-cheat-analysis`.
The event FK has the same `NO ACTION` deletion behavior as receipts; the existing
append-only event trigger remains authoritative. State contains no error text,
event payload or engine output. Counts are nonnegative, dates finite, and lease
token/expiry must appear together. A partial due index covers released retries.
Success removes the scheduling row, so state is bounded by unfinished actual
terminal events times the two known consumers. There is no backfill of attempts.

Persistence claims **one** event at a time. A short READ COMMITTED transaction
locks the eligible event with `FOR UPDATE SKIP LOCKED`, then atomically inserts
or updates scheduling state with due/expiry predicates and a fresh receipt
check. Completion locks that same event. Its fresh second statement closes the
snapshot race with a receipt committed while a candidate was being selected.
Each transaction releases locks before returning to the consumer. Bot and
anti-cheat claims briefly serialize on this event lock, but their durable
ownership, receipts and retry schedules are independent throughout analysis.
SQL values are parameterized; only the internal scan direction changes SQL.
Claim/update statements have five-second lock and statement timeouts.

Ownership lasts **300,000 ms** from the successful claim or renewal. The
reconciler renews after **60,000 ms**, repeating after each successful renewal.
Renewal failure, ownership loss or a **10,000 ms** renewal-response timeout aborts
the consumer's signal. Anti-cheat passes it to both engine search paths; the
engine manager removes queued work or sends UCI `stop` for active work. No
subsequent ply starts with an aborted signal. Both sources check cancellation
before loading and immediately after the load, before replay or analysis. A late
database response cannot start analysis after ownership loss. The existing event
store read is not physically cancelled or given a new timeout here: a permanently
stalled read can still delay consumer settlement and graceful shutdown, although
the durable lease expires and another process can recover it. This renews long legitimate work
without assuming an unsupported whole-game maximum. The worker waits for the
current consumer to settle and starts no replacement concurrently in that
process. Shutdown retains renewals while the current game finishes. A killed
worker leaves work recoverable at its last durable lease expiry, without cleanup.

All renewal, failure and success writes require the current **unexpired fencing
token**. Reclaim replaces that token. Stale and repeated completions/failures are
no-ops, so a duplicate failure cannot increment twice, and an old owner cannot
acknowledge its replacement's work. A claim alone or crash increments nothing.
Successful acknowledgement writes the receipt and deletes retry state in one
transaction; both roll back if receipt writing fails. Receipts remain the
authoritative suppression predicate, including previously completed history.

Trust-worker report upserts also carry the claim and cancellation signal.
Their short transaction validates the consumer and batch game, locks the event
then current retry row, and checks token, expiry and absence of a receipt.
It rechecks ownership and cancellation immediately before commit. Replacement
claims cannot cross that locked write boundary; a delayed stale batch or a batch
that expires during writing rolls back instead of overwriting replacement results.
Fenced report transactions use five-second lock, statement and idle-transaction
timeouts. Analysis runs before these locks; existing unleased repository callers
and domain report interfaces retain their contract.

Failure increments `failures` exactly once, saturating at PostgreSQL's signed
integer maximum, **2,147,483,647**. For failure number `n >= 1`, delay is:

`min(21,600,000 ms, 120,000 ms × 2^min(n−1, 8))`

This gives 2, 4, 8, 16, 32, 64, 128, 256 minutes, then **6 hours** indefinitely.
Exponent clamping precedes arithmetic. Date arithmetic rejects an invalid clock
or a deadline outside the shared JS/PostgreSQL range. Production eligibility and
lease time come from PostgreSQL; deterministic tests inject time. No random
jitter, permanent dead letter, failure limit or new runtime setting is added.
An unavailable retry write leaves the original lease for bounded recovery.

The reconciler retains its forward cursor and reverse sweep, processing at most
**1,000 forward items and 100 reverse items** per scan. One-item claims preserve
the old ten-by-100 work budget without leasing an engine backlog before it can
start. Both scans filter due times and active leases. A reverse sweep restarts
at the current forward cursor after exhausting older due work, rediscovering
newly committed or newly due lower-ID work while newer work stays busy. Redis
only calls that same scan. Decode corruption uses the same claim/failure path.
Current-version endings are checked for result, known termination, winner and
integer timestamp before dispatch; a malformed abort cannot bypass analysis into
a success receipt.
Stop checks both before and after each awaited claim.

## Operations and scope

Failure logs contain consumer, game ID, sequence, coarse failure class, recorded
failure number and next retry timestamp. A closed whitelist of PostgreSQL,
engine and socket failure codes distinguishes known causes, including missing
schema and query timeouts. Unknown codes are null; arbitrary names, routines,
messages and stacks are excluded, including startup and scan failures. Raw exception text is excluded from
the reconciler's default logger, trust-worker failure logger and source replay
logger. Replay errors use a fixed class because exception text can embed stored
FENs. Readiness still
checks database connectivity only; historical poison work does not fail it.
The trust worker exposes health/readiness but no deployable metrics endpoint or
metrics exporter. This increment uses structured logs and adds no telemetry
subsystem. Retry state has no public API or admin UI.

Compose and Helm keep the dedicated process and singleton production topology.
There are no new environment flags or values. Helm uses `Recreate`: during an
upgrade, Kubernetes waits for the old revision's pods to terminate before creating
the replacement. This enforces legacy/new separation on the first upgrade;
pre-0048 workers do not acquire leases. Apply migration 0048 before upgraded
workers start, and drain any legacy workers deployed outside this Deployment.
The worker serves no client traffic, and its rollout gap loses no committed
endings; unfinished leased work becomes eligible at expiry. Recreate does not
prevent overlap after manual pod deletion or in separately started processes,
so fenced leases still protect overlapping upgraded instances. Existing report
upserts tolerate replay if analysis succeeded but the process died before its
receipt committed.

Moderation thresholds, engine depth/nodes/MultiPV, sanctions and D-13/D-14 policy
remain outside this increment. Finished-game PGN work is independent.

## Evidence

`terminal-event-inbox.integration.test.ts` uses simultaneous calls on genuinely
separate PostgreSQL pools for claims, failure recording and completion races.
An advisory/commit barrier proves a candidate from an earlier MVCC snapshot is
rejected after the receipt commits, rather than merely testing active leases.
It advances time through active/expired leases, multiple due deadlines and the
cap; checks stale fencing, crash recovery, renewal, atomic rollback, retry-row
cleanup, corruption and the 0047 upgrade preserving reports/receipts/checksums.
Current-version decoding requires a string termination before membership checks.
An unfinished `*` result is valid only for `aborted` or `no_show` with no winner,
matching the game authority; malformed endings enter retry rather than acquiring
a success receipt through the abort shortcut. The regression also preserves both
valid abort forms.
The deterministic in-memory inbox enforces the same contract. Reconciler tests
cover 1,000 failures, 2,500 healthy endings behind poison, continuously busy
forward scans, due reverse rediscovery, duplicate wakeups, restart, renewal
failure/timeout and stop. The deployed entrypoint test includes poison work while
remaining ready and verifies payload text does not appear in logs.

Final validation, mutation and exact-head review results are recorded in the
increment entry and PR handoff; this design record does not imply those gates
have run or approve the owner-controlled merge.
