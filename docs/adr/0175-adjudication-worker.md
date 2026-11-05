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

1. **Claim.** `listClaimableAdjudications` reads proving operations with no live lease, oldest
   first. Each is claimed at the listed generation with a fresh claim intent; an uncertain reply is
   retried once with the same intent, which recovers the committed lease. A conflict (another
   executor won) skips the operation.
2. **Prove.** The proof runs in bounded slices (`sliceBudget`) outside every transaction, yielding
   to the event loop between slices and renewing the lease once half of it has elapsed. A question
   that exhausts its resource limit is concluded as unresolved (ADR 0174 section 7), which never
   declares a dead position.
3. **Settle.** The resolution instant is the one a retained evaluation already fixed, otherwise
   now. An uncertain settlement is retried once with the same grant; a completed operation then
   answers from the database. A conflict (superseded claim) drops the local proof job.
4. **Publish, then release.** The settlement is published before any release. `listReleasableStops`
   reads current stops with nothing proving, and each is released at now with the request id
   `stop:<operationId>`, so racing or retried releases of one stop collapse into one event.

Failures are logged and counted. A failed proof or settlement is retried once its lease lapses, at
a higher generation; a failed release is retried on the next pass. `stop()` halts a proof at its
next slice and waits for the pass.

Recovery and ordering:

- **Retained settlement.** When a settlement was evaluated but its write failed, the next claim in
  the same process settles that evaluation at its fixed instant without stepping the consumed job.
- **Job cleanup.** The local proof job is cancelled and evicted after every claim, whatever the
  outcome, so lost or superseded claims cannot fill the controller's bounded capacity.
- **Notices.** A failed notice to the owner is kept per game and retried at the start of every pass
  while the process runs; a stop is never released while its game has one outstanding, and those
  games are excluded before the page limit so they cannot starve other stops. A stop is also
  released only once its settlement is `releaseGraceMs` old (database time, default 1 s), so the
  replica that settled it notifies first. Notices are a latency optimization, not the delivery
  guarantee: the owner publishes from the durable log, and an owner whose copy shows a game proving
  or stopped re-reads the log on its own (ADR 0176), which covers a process that died between
  commit and notice without any time-window scan.

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
- A pass runs one proof at a time per process; throughput scales with replicas, not threads.
