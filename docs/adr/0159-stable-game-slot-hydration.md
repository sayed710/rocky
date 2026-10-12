# ADR-0159: Stable game slot during hydration and eviction

Date: 2026-10-12
Status: Accepted for R-01 PR1 by owner authorization; implementation pending manual merge.

## Context

On main `84b3d9d253dffcedab601967d2814600f6234cf5`, concurrent cold loads each
installed a GameRecord containing its own command lock. A delayed ply-0 read
could replace a record that had already committed White's b1c3, causing legal
Black e7e5 to be refused. Real disposable Redis/PostgreSQL reproduction confirmed
cache ply 0, durable ply 1 and `not_your_turn`.

## Decision

GameAuthority maintains one GameSlot per active lifecycle. The slot owns its
serialization tail and counts all queued/running operations. Its resident
GameRecord carries only aggregate state, persistence head and broadcast history.
Creation, cold loading, forced reload and application use this same queue.
Application selects the current record inside the queue.

Ordinary cold loads share a generation-specific promise. A forced takeover
reload always queues its own later read, never reuses an older cold snapshot.
Pending reloads prevent `hasFresh` from authorizing synchronous edge reads.
Failed reads propagate to overlapping callers through a separate reload-result
promise and remain retryable; missing durable history clears the resident and
never creates a new empty game. The serialization tail remains rejection-neutral.

Eviction increments the lifecycle generation and requests disposal. Delayed reads
must match both generation and slot identity before installation. Busy slots stay
until every queued operation drains, preserving one effective lock. A later load
in the current generation can cancel deferred disposal by installing fresh state.
Idle disposed or empty slots are removed; resident retention policy is unchanged.

ApplyOptions groups the existing optional `beforeExecute` and `requestId`.
Admission still follows hydration under the stable lock, before domain decisions
or persistence. Only successful authoritative execution publishes the exact
`commandConfirmed` identity. No forwarding deadline or uncertainty policy changes.

## Consequences and limits

The second cold join waits rather than advancing through a competing load.
Generation invalidation makes ordinary load callers retry the current lifecycle;
false means an actual missing durable log. An obsolete explicit forced reload can
return false. Successful creation restores residency even if eviction occurred
while its initial append was pending. Commands already queued can drain before
deferred eviction completes.
This is process-local serialization, not ownership fencing or a cache redesign.
R-01 D3 admission policy, revisions, recovery, draw propagation and PostgreSQL
ownership fencing remain separately authorized work.

Tests use controlled EventLog I/O, deterministic unit schedules and two gateway
instances in one process with real Redis/PostgreSQL. They do not establish
two-process crash, partition or public-production readiness.
