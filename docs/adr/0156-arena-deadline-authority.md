# ADR-0156: Database-authoritative Arena deadlines

Status: Accepted for implementation; deployment and PR review gates remain separate.

Date: 2026-10-03

## Problem

`ArenaService` previously supplied each process clock to settlement, pairing and
results, and launched games before saving the pairing snapshot. Opposite clock
skew could disagree about expiry; a lost snapshot CAS could leave an orphan game.
An idle expired Arena depended on reads. This closes the Arena clock follow-up in
[ADR-0152](0152-moderation-and-trust-operations.md), without changing scoring,
duration, joining, withdrawal, rematch avoidance, colors or the public API.

## Decision and transaction ownership

`TournamentsRepository.mutateArena` owns one short PostgreSQL transaction. It sets
`lock_timeout` to five seconds and locks exactly one tournament row before reading
`clock_timestamp()`. Transaction-start time would be stale after a lock wait.
Milliseconds use `floor(extract(epoch ...) * 1000)::bigint`, checked as JavaScript
safe integers. The callback is synchronous, deterministic domain work only. It
cannot change configuration, identity or an established start instant.

The first committed registration-to-running transition records the database time
as `ArenaSnapshot.startedAtMs`. Its absolute deadline is exactly that integer plus
the existing integer `durationMs`. Concurrent starts and response-loss retries
retain that same start. A new pairing additionally requires database time strictly
less than this deadline at the UPDATE that authorizes it. If calculation crosses
the boundary, the entire mutation rolls back and a bounded retry reloads the row
and samples time again. T-1 permits authorization; T and T+1 forbid it. Active
authorized games can finish later, and their final outcome settles an expired
Arena. Database/time failures propagate; production never consults the optional
simulation clock supplied to the in-memory adapter.

No transaction holds a lock while launching a game. Only one tournament row is
locked per decision, and no game/event/player lock is acquired inside it. Thus
the Arena path introduces no nested lock ordering or lease ownership. Other
tournaments can proceed concurrently. The generic snapshot save retains its CAS
for round-based tournaments; production Arena updates use the atomic boundary.

## Durable work and recovery

[Migration 0049](../../packages/persistence/migrations/0049_arena_deadlines.sql)
adds the arena_deadlines table, a trigger-maintained projection with at most one row per
running Arena (or invalid legacy Arena needing repair). It stores exact bigint
deadline milliseconds, a pending-launch flag and an invalid flag. Valid
registration and finished rows have no work entry. Backfill preserves snapshots
and versions, derives running deadlines only from provable integer durable data,
and retains invalid rows with NULL deadlines. It does not fabricate missing time.
Malformed snapshots fail closed in pure restoration, with repair evidence in the
queue and sampled worker logs. Operators must inspect and repair the underlying
snapshot; the queue is a projection, never independent policy authority.

Deadline and recovery branches have separate partial indexes, UNIONed into a
bounded keyset page. Active expired games remain due until resolved. Reads may
settle using the same atomic operation, but autonomous workers provide correctness
without reads. The worker uses the rotating-page and stop/drain pattern of
[ADR-0149](0149-autonomous-flag-expiry.md): one page of 50 per second, no concurrent
passes in one process, immediate startup catch-up, no busy loop, and a cursor that
passes poison rows. A failure does not consume any durable work. Stop cancels the
next poll and drains the bounded in-flight page, including failed scans.

Authorized pairings commit before external launch. Their pending work survives a
crash before launch, after game creation and before linking, or before a response.
The durable launcher still checks players, variant and time control and walks past
another pairing's slot. An already-ended committed Arena game returns a distinct
terminal outcome for reconciliation by pairing id; it is never linked as playable
and never replaced merely because linking was interrupted. Live game links are
written in another short transaction. Duplicate terminal recovery/reporters find
the pairing resolved and apply no second score. Post-deadline aborts remove the
pairing and settle when idle; they cannot authorize replacements. Round-based
launcher behavior is unchanged.

New active pairing entries persist `launchNamespace: committed-v1` with their
authorization; that namespace participates in both deterministic game identity
and Chess960 derivation. This isolates them from old launch-before-CAS orphan
slots. Unmarked legacy entries retain the original identity, and existing linked
games/reporters remain compatible. Unlinked legacy entries can recover a matching
live game, but a matching ended legacy slot is ambiguous: it may be an old CAS
loser's orphan. Recovery fails closed with operator-repair evidence instead of
scoring it or launching a replacement. Operators must establish the intended
authorization/outcome from durable evidence; an upgrade never invents provenance.

## Production topology and rollout

Every production API created by `createPgApiServer` runs a worker. Gateways run an
additional worker alongside `TOURNAMENT_REPORTER=1`. Both default Compose and Helm
enable that reporter; their existing migration-before-API startup remains in
place. Trust workers, search indexers and other services do not start Arena workers.
There is no new environment variable or Helm strategy change; polling defaults
are identical in both compositions. API and gateway shutdown drain the worker
before database closure. A bad Arena does not affect readiness.

**First rollout requires a maintenance/drain boundary:** stop legacy API and
gateway tournament writers/reporters before applying 0049, apply the migration,
then start upgraded replicas. A migration init container alone does not prevent
old replicas still running during a rolling deploy from writing decisions based
on local clocks. Do not mix old writers with upgraded replicas and claim the new
guarantee. Existing valid running Arenas retain their recorded legacy start; no
retroactive time policy is invented. Subsequent overlaps between upgraded workers
are safe. All merges and deployment decisions remain owner-controlled.

Observability uses unlabelled `arena_deadline_reconciliations_total` and
`arena_deadline_failures_total` counters, and at most one sampled failure log per
page. Logs include a tournament identifier and a repair-required boolean, without
snapshots, user details or arbitrary exception payloads. No identifier labels are
added to metrics. Polling delays settlement visibility, never pairing eligibility:
the database guard always enforces the exact cutoff.

## Evidence and limits

The initial skew regression compiled and failed before implementation (start was
0 instead of authoritative 1000). Pure domain and service tests cover exact
boundaries, active games, post-deadline outcomes, replay, scheduling and draining.
PostgreSQL tests use separate pools and real row locks. A controlled server-side
clock fixture provides deterministic T-1/T/T+1 and write-time crossing without
sleeps; another test uses actual `pg_catalog.clock_timestamp()` to verify the
production source. Migration tests exercise backfill, rerun and real index plans.
The mutation runner records compile-successful behavioral kills and byte-identical
source restoration in the audit evidence.

No Redis scheduler, client timestamp, timing grace or per-Arena process timer is
introduced. Database availability is required for decisions. Worker throughput is
bounded at 50 candidates per second per process; a large backlog takes multiple
passes. Invalid rows require operator repair and remain durable rather than being
silently treated as finished. General database clock management and game-owner
clock authority are outside this Arena change.
