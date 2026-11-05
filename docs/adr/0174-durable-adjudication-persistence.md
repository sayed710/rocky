# ADR 0174: Durable Adjudication Persistence (Issue #124 Stage M)

- **Status**: Proposed / Bounded Scope (Issue #124 Stage M). Unwired; no rollout authority.
- **Date**: 2026-11-05
- **References**: Issue #124, [ADR 0169](0169-durable-adjudication-domain.md), [ADR 0170](0170-practical-proof-work-slicing.md), [ADR 0172](0172-playable-stopped-adjudication-completion.md), [ADR 0173](0173-recorded-clock-release-domain.md), `packages/persistence/migrations/0053_adjudication_persistence.sql`, `packages/persistence/src/pg/adjudication-store.ts`, `packages/persistence/src/pg/adjudication-operations.ts`, `packages/persistence/src/pg/fenced-no-show-candidates.ts`, `packages/persistence/test/adjudication-persistence.integration.test.ts`, `packages/persistence/test/adjudication-start.integration.test.ts`.

## Context

ADR 0169–0173 define the adjudication domain in `@chess-platform/game`: an admitted command is
suspended by `AdjudicationStarted`, proof work runs in resumable slices, and settlement appends
`AdjudicationResolved` plus its effects. Stage M makes that durable in PostgreSQL. Three earlier
drafts preserved alternative attempts (Start slice, an SQL classifier prototype and a queue identity
fix); the classifier prototype failed its build and review and is not used here. Review of the Start
slice against the real PostgreSQL suite found that it broke existing behavior: roles without a grant
on the new table could not append any event, the guard rewrote `xact_id` (defeating logical-restore
detection in the ratings applier), duplicate creations reported a new error instead of the unique
violation callers map to a version conflict, and a completed operation's suppressed queues were
never restored.

## Decision

### 1. Obligation table and permits

`game_adjudications` holds one row per operation: the exact Started envelope, the domain-derived
acceptance accounting, the lease (generation, claim id, executor, SHA-256 of a 32-byte capability,
expiry), a START permit bound to the inserting transaction, a SETTLEMENT permit bound to one
transaction and one exact batch consumed in order, the completion receipt and, for a stopped
completion, the stopped clock and the single current stop. Rows are never deleted; completed rows
are immutable except for clearing a current stop.

### 2. Legacy compatibility

- Games with no obligation row keep their exact pre-0053 append and commit behavior. The only new
  refusal for them is appending a lifecycle event (`AdjudicationStarted`, `AdjudicationResolved`,
  `AdjudicationClocksStarted`) without a permit; no released code emits those.
- Every trigger function is `SECURITY DEFINER`, so a role holding only its existing `game_events`
  privileges (including column-level INSERT) keeps working, needs no grant on the new table, and
  cannot skip a check by lacking one. Behavior never branches on the caller's privileges.
- Every new routine sets `search_path = pg_catalog, pg_temp` and schema-qualifies every object it
  uses. With `public` on the path, a role holding CREATE on `public` (the default before
  PostgreSQL 15) could plant a better-matching overload, for example `hashtextextended(text,
  integer)`, and have it run as the function owner; a real-PostgreSQL test plants such overloads and
  a shadowing temp table and checks that none runs. For the same reason the flag-deadline arithmetic
  of 0043 is restated as `adjudication_flag_due` rather than calling `flag_deadline_ms`, which
  resolves its objects through the caller's path; tests compare the two and the domain. The store's
  own fence query is schema-qualified with exact argument types. `TRUNCATE` of the obligation table
  is refused like `DELETE`.
- Least privilege: the migration leaves the SECURITY DEFINER routines owned by the migration role,
  which owns the event tables. A trusted installer then runs `prepareAdjudicationGuard` (in
  `packages/persistence/src/pg/adjudication-preparation.ts`, mirroring PG-F1's `prepareGameFencing`)
  to transfer them to a dedicated NOLOGIN role that has no role attributes, no members, no
  membership in any other role (direct or indirect, so it cannot inherit the table owner's rights)
  and no owned objects, and holds only SELECT on `game_events`, SELECT/UPDATE on `game_adjudications`, and
  SELECT/INSERT/DELETE on the queue and mark tables. As that role, DDL, trigger disabling,
  TRUNCATE, event writes, unrelated reads and CREATE in `public` are all refused (tested).
  Preparation is atomic and idempotent and refuses unsafe owners without changing anything. It
  requires a superuser installer, as PG-F1's does: PostgreSQL lets anyone else transfer a function
  only to an owner the installer can SET ROLE to and that has CREATE on the schema, both of which
  the owner rules forbid; a non-superuser installer is refused before anything changes.
- `xact_id` is never rewritten, the 0042 queue trigger is not redefined (legacy creation queues with
  `pregame_deadlines.seq` at its default 0), and an append at an occupied position is left to the
  primary key so stale writers still receive `23505`. Legacy appends take no new advisory lock.

### 3. Validation

Immediate guards refuse unpermitted events while proving or stopped, forged lifecycle events, any
event after a settlement in its own transaction, identity changes, generation reuse, and a claim or
settlement in the transaction that inserted Started. A deferred validator re-reads the whole managed
game at COMMIT from the tables (never a queued row snapshot beyond its game id) and checks exact
Started and settlement payloads and versions, permit consumption, receipt fields, operation ordering,
lifecycle event counts, stop rules and queue suppression. Queue tables carry a deferred check so no
writer can commit a deadline for a proving or stopped game.

The whole-game validation runs once per (transaction, game): the first deferred firing at COMMIT
already sees the final state and records a mark in `adjudication_validation_marks`, a table with no
PUBLIC privileges that only the SECURITY DEFINER functions write (a client-settable setting would
let any writer skip validation). Every immediate guard removes the mark on any later change, so
`SET CONSTRAINTS ... IMMEDIATE` cannot be used to skip it either. Event-by-event
suffix verification runs only for operations settled in the current transaction; earlier completed
rows were verified at their own COMMIT and are immutable, so they are re-checked only for ordering,
lifecycle counts and stop rules.

### 4. Queue restoration

When an operation completes and leaves the game running (no stop, no ending), a trigger replaces the
game's queue rows with what the log implies, using the same arithmetic as 0042/0043: the no-show
deadline while no move exists (its `seq` set to the completion so an older fenced worker cannot
touch it) or the flag deadline of the latest move. The deferred validator checks that result in the
completing transaction.

### 5. Store contract

`PgAdjudicationStore` runs short READ COMMITTED transactions under the game's advisory fence; proof
and settlement evaluation run outside every transaction and lock through a private controller.
Recovery after an uncertain outcome:

- Start: an identical retry returns `proving` or `completed` with the recorded receipt.
- Claim: callers create an intent with `PgAdjudicationStore.newClaimIntent()` and reuse it; the same
  intent recovers the committed grant, any other intent conflicts. Every claim takes a strictly
  greater generation.
- Renew: bounded to `extensionMs` past database now and never shortened, so retries do not stack.
- Settle: a completed operation answers from the database when the grant is the one that completed
  it, including after a restart that lost the retained evaluation. Before any evaluation, a short
  fenced read confirms the grant is the current live claim, so an expired or superseded claimant
  cannot consume the proof job or fix the resolution instant. A retained evaluation is bound to the
  operation and resolution instant, not to a claim: a successor reads the instant with
  `retainedResolutionAt()` and settles without re-running the consumed job. Observing the operation
  completed (by any grant) drops the retained evaluation.

`PgFencedNoShowCandidates.reschedule` records the loaded head even when the due time is unchanged, so
a stale worker cannot dismiss a newer establishment.

### 6. Release of a managed stop (migration 0054)

`Game.prepareClockRelease` is the one authoritative producer of `AdjudicationClocksStarted`: it
derives the event from the stop the game records and folds it through the replay reducer, so a live
release and its replay cannot disagree. `PgAdjudicationStore.releaseClocks` writes, in one fenced
transaction, a RELEASE permit (`game_adjudication_releases`: current stop, exact event, next
position, and the flag and no-show deadlines the released domain computes), the event, and exactly
those queue rows. The event guard admits that event alone and ends the stop; afterwards a managed
observed-release game refuses every unpermitted event until it ends, so each later command is an
adjudication again. The deferred validator checks every release against its permit and stop and,
in the releasing transaction, the queues against the recorded deadlines. Release is idempotent by
request id, including after a lost COMMIT reply. Migrations run before `prepareAdjudicationGuard`
(or it is re-run), because `CREATE OR REPLACE` needs the routines owned by the migration role.

### 7. Exhausted proofs: fewer, continued, then the flag rule

A proof question that exhausts its search (`resource_limit`) would otherwise leave the game proving
forever. Three measures keep that rare and never let exhaustion alone decide a result:

- **A finder that finds.** Before its depth-first attempts, the witness finder runs guided
  cooperative playouts (the winner tries every move for mate and heads for the loser's king; the loser
  runs its king to a corner, crowds it and never takes the winner's material). They only propose a
  witness: the same independent legal replay verifies it, so soundness is unchanged. They are sliced
  per work unit and seeded from the position, so a position always explores the same playouts. And a
  side with nothing but its king and no pawns of its own can never mate, whatever pawns the other side
  has (the bare-king lemma no longer needs a pawn-free board), so the exact search closes those at
  the root. On positions from 30 seeded games (measured, see the PR), the share of move proofs that
  exhausted fell from 52% to 0.2% and their median time from 1.4 s to 14 ms; flag proofs from 43% to
  1.5%.
- **Continuation.** An exhausted timeout question is escalated before anything else
  (`AdjudicationJobController.escalate`): a fresh finder with more and longer playouts (400 x 200
  plies, then 2000 x 300), while the exact search keeps what it explored at its default capacity, so
  an escalated job needs no more memory than a fresh one (the gateway runs in 512 MiB).
  `concludeUnresolved` refuses a timeout question while a tier remains. With escalation, 0.4% of flag
  proofs stayed unresolved in the same sample, and each of those positions is in fact winnable.
- **The flag rule.** A question still unresolved after every tier is recorded as
  `{ status: 'unresolved', reason: 'resource_limit' }`. An unresolved dead-position question is
  treated as not dead (the command applies and play continues; no result is declared). An
  unresolved timeout question settles by exactly the rule the platform applies without proofs
  (`Game.claimFlag`): a loss on time unless the winner cannot mate (`canMate`, which already declares
  a draw only on proven impossibility), matching FIDE 6.9, under which a fallen flag loses unless it
  is established that the opponent cannot mate. Replay accepts exactly that recorded shape.

## Consequences

- Rollout remains on HOLD (Issue #124): nothing constructs the store, no worker or client is wired,
  and no migration is applied to production by this change. Applying 0053 requires the migration
  owner to own the new SECURITY DEFINER functions; existing runtime grants are unchanged.
- A transaction touching a managed game pays for one whole-game validation at COMMIT, with
  event-level checks only for what it settled; legacy games pay one indexed existence check per
  insert.
- Broader dead-position classes remain open in Issue #124; this ADR claims no FIDE 5.2.2 coverage.
