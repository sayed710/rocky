# ADR 0175: Durable Adjudication Worker (Issue #124)

- **Status**: Proposed / Bounded Scope (Issue #124). Not constructed by any service; no rollout authority.
- **Date**: 2026-11-05
- **References**: Issue #124, [ADR 0170](0170-practical-proof-work-slicing.md), [ADR 0173](0173-recorded-clock-release-domain.md), [ADR 0174](0174-durable-adjudication-persistence.md), `services/gateway/src/adjudication-worker.ts`, `services/gateway/test/adjudication-worker.test.ts`, `services/gateway/test/adjudication-worker.integration.test.ts`, `packages/persistence/src/pg/adjudication-store.ts`.

## Context

ADR 0174 makes an accepted adjudication a durable obligation with leases, permits and an
idempotent settlement and release. Nothing yet executes those obligations: a started operation
would stay proving until something claims it, runs its proof, settles it and, for an
observed-release stop, releases the clocks.

## Decision

`AdjudicationWorker` is that executor. It depends only on the store contract
(`AdjudicationWorkStore`, which `PgAdjudicationStore` satisfies) and a `publish` callback, and
holds no state correctness depends on. Each pass:

1. **Claim.** Proofs already held by this worker (`#inFlight`) go first, each for one more slice,
   in claim order. Newly claimable operations are read via `listClaimableAdjudications` only up to
   the controller's remaining free capacity (capacity 100 minus in-flight jobs), reserving slots
   during concurrent admission. Each is claimed at the listed generation with a fresh claim intent;
   an uncertain reply is retried once with the same intent, which recovers the committed lease. A
   conflict (another executor won) skips the operation. Duplicate operation IDs returned in a page
   are filtered and never claimed twice.
2. **Prove.** The proof runs in bounded slices (`sliceBudget`) outside every transaction, yielding
   to the event loop between slices and renewing the lease once half of it has elapsed. An exhausted
   timeout question is escalated while an effort tier remains, and only then is a question concluded
   unresolved (ADR 0174 section 7). Each operation gets at most `proofSliceMs` (default 200 ms) of
   proof per pass: an unfinished proof keeps its claim and its local job, and the next pass resumes it
   before claiming new work, so one long proof (an escalated timeout can take seconds) never holds up
   the other games. Proof jobs are initialized once for the held grant rather than reloading durable
   events on every slice. Leases are renewed before await, and next-pass delays and error backoffs
   are bounded by the earliest held lease safe window so held jobs waiting behind others never lapse.
3. **Settle.** The resolution instant is the one a retained evaluation already fixed, otherwise
   now. An uncertain settlement is retried once with the same grant; a completed operation then
   answers from the database. A conflict (superseded claim) drops the local proof job.
4. **Publish, then release.** The settlement is published before any release. `listReleasableStops`
   reads current stops with nothing proving, and each is released at now with the request id
   `stop:<operationId>`, so racing or retried releases of one stop collapse into one event.

Failures are logged and counted. A failed proof or settlement is retried once its lease lapses, at
a higher generation; a failed release is retried on the next pass. `stop()` halts a proof at its
next slice, awaits in-flight pass and renewal IO promises, then cancels and evicts remaining local
jobs from the controller.

Recovery and ordering:

- **Retained settlement.** When a settlement was evaluated but its write failed, the next claim in
  the same process settles that evaluation at its fixed instant without stepping the consumed job.
- **Job cleanup.** The local proof job is retained across time slices while held by this process.
  When an operation settles, fails, loses its lease to another executor, or when the worker stops,
  its local proof job is cancelled and evicted, preventing leaks in the controller's 100-job capacity.
  A waiting lane skips dropped jobs and never recreates them.
  A subsequent claim at a fresh generation initializes a fresh proof job.
- **Notices.** A failed notice to the owner is kept in a per-game FIFO queue. Changes for each game
  are drained in strict sequential order across retries and new notices; an earlier failed notice
  blocks subsequent notices and immediate clock releases for that game until delivered. Other games
  continue draining independently when one game's notice fails. Immediate clock release occurs only
  when that game's notice queue is empty, ensuring no notice debt is overwritten or silently discarded.
  A stop is never released while its game has an outstanding notice, and those games are excluded
  before the page limit so they cannot starve other stops. The worker that settled a stop releases
  it as soon as its notice queue is empty, with the same release request id, so a move that keeps the
  game going costs no extra clock pause. The release sweep, which picks up stops whose settler died or
  failed to release, takes a stop only once its settlement is `releaseGraceMs` old (database time,
  default 1 s), so the replica that settled it notifies first. Notices are a latency optimization, not
  the delivery guarantee: the owner publishes from the durable log, and an owner whose copy shows a game
  proving or stopped re-reads the log on its own (ADR 0176), which covers a process that died between
  commit and notice without any time-window scan.
- **Bounded Concurrency and Controller Capacity.** Operations run concurrently up to `concurrency`
  (default 4; positive safe integer <= 100). When `concurrency: 1`, held operations followed by fresh
  operations execute in strict sequential order. Total in-flight jobs in the worker are bounded by the
  controller's capacity of 100; when capacity is saturated, no durable claims are attempted, and
  pagination reports more work pending until slots free up. Slots are reserved during concurrent
  admission to prevent overclaiming.
- **Independent lease maintenance.** Background lease renewal is maintained independently per held job
  across the worker's bounded controller capacity. A slow or stalled database renewal on one held job
  does not block initiating due renewals for other held jobs or their subsequent renewal cycles while
  the first promise remains pending. Overlapping duplicate renewals for the same grant are prevented,
  and all active renewal IO promises are tracked in an owned set and awaited upon `stop()`, including
  for removed jobs and across previous cycles. Renewal failure paths (both `AdjudicationConflictError`
  and expired transient failures) are fenced by held-object identity, ensuring a late background renewal
  that outlives a previous cleanup cannot evict or drop a newly admitted replacement proof job for the same
  operation. When a renewal fails transiently while its lease remains live, retry spacing is bounded and
  lease-aware (scaling exponentially up to `leaseMs / 4`), eliminating tight 10ms retry loops across all
  renewal entrypoints while healthy jobs continue renewing on time and eventual loss cleanup is preserved.

Privileges: the worker's role needs what every `PgAdjudicationStore` call needs, SELECT, INSERT and
UPDATE on `game_adjudications` and `game_adjudication_releases` (and the event and queue tables it
already writes); the migrations grant nothing to PUBLIC, so a restricted runtime role must be
granted these explicitly when adjudication is enabled.

## Consequences

- Correctness stays in the database fence: racing workers on several replicas settle an operation
  exactly once, and a worker that dies mid-proof is replaced once its lease lapses (tested on real
  PostgreSQL).
- Rollout remains on HOLD (Issue #124): no service constructs the worker, and no flag enables it.
  Wiring it to the gateway's owner, so that `publish` reloads and broadcasts the game, is separate
  work.
- A pass runs up to `concurrency` (default 4) operations concurrently per process to overlap
  database round trips, while proof slices cooperatively yield to the event loop.
