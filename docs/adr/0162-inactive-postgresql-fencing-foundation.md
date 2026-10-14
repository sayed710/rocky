# ADR-0162 — Inactive PostgreSQL writer-fencing foundation (PG-F1)

Date: 2026-10-14. Status: implementation candidate; owner approval to merge is separate.
Baseline: `4ccf8f48869335e06ac1b1de467d2161869f8fd7` (includes owner-merged #112).

## Context and scope

D3 rejects obsolete queued work, but an already-admitted legacy append may commit
after Redis takeover. Sequence CAS orders events; it does not authenticate the
writer. D4's slot is process-local. R-03 command identity/uncertainty, R-04
authorization, F3 consumer identity, F4 released-debt cleanup and ADR-0161
`stateRevision = game_events.seq` remain unchanged.

The owner approves only additive PG-F1 persistence infrastructure. The supplied
Pi architecture audit and subsequent owner decision package are design inputs,
not runtime proof. Their historical #112-open checkpoint is superseded by its
owner merge. PG-F1 does not change gateway, Redis, protocol, creation callers,
legacy `EventStore.append`, deployment, credentials, D1/D2 or retention policies.

## Schema and authority

Migration `0050_inactive_game_fencing.sql` adds private `game_fencing` objects:

- `grants`: permanent UUID game key, nonnegative BIGINT epoch, explicit active
  state, database-incarnation UUID, authenticated PostgreSQL login name, fresh
  process-incarnation UUID, SHA-256 capability verifier and finite database lease.
- `control`: singleton prepared/enforced-state metadata. Incarnation and maximum
  lease duration start **NULL**; enforcement starts false and cannot be enabled
  by this migration. There are no production lease-duration defaults.

Inactive holder fields are all NULL; active fields are all present with positive
epoch and a 32-byte verifier. Release clears the holder, never deletes the row or
resets its epoch. Expiry does not reset history. BIGINT exhaustion rejects;
transport uses canonical decimal strings, never lossy JavaScript numbers.
There is no FK/cascade from the asynchronous games projection to permanent grants.

Migration backfill inserts distinct existing event-stream IDs as inactive epoch
zero, with `ON CONFLICT DO NOTHING`. No event/projection data or prior migration
checksum is rewritten. Legacy creation remains operational and may create new,
unseeded streams. `seedGameFencing` is an explicitly privileged, idempotent
preparation operation; acquisition never silently creates missing grants.

## Transaction and lock contract

Protected operations require **READ COMMITTED**:

1. Lock the singleton control row **FOR SHARE**, checking namespace and preparation.
2. Lock the same per-game grant row **FOR UPDATE**.
3. Sample fresh `clock_timestamp()` after the grant lock wait.
4. Validate exact login, process, capability, epoch, namespace and live lease.
5. For append, read the durable event head after locking, reject missing/gapped
   streams or expected-head disagreement, validate INTEGER capacity and batch,
   then insert the complete contiguous batch.
6. Keep both locks until transaction COMMIT or ROLLBACK.

Acquisition additionally requires the expected epoch and an inactive, expired or
old-database-incarnation holder. It advances epoch and installs the new holder.
A retry with the same acquisition intent recovers only its original still-live
grant; it does not extend the lease or adopt a successor. Renewal cannot revive
an expired grant. Release/renewal reject stale identities.

**Ordering proof:** when old append locks first, successor activation waits until
that transaction ends. If old append commits, successor activates afterward and
can read that committed head; if it rolls back, successor sees the prior head.
When successor grant COMMIT comes first, old append subsequently observes the
new tuple and rejects before inserting. Thus an obsolete protected append cannot
COMMIT after successor grant COMMIT **when all participants use this boundary**.

This is not a wall-clock COMMIT deadline: a transaction admitted while live may
finish after lease expiry, before a successor can activate. Redis acquisition is
not PostgreSQL takeover. Caller-supplied transaction budgets bound operational
waiting without changing this proof; no production budgets are supplied here.

Creation is separate and create-only. `createOnClient(client, input)` leaves
COMMIT to the caller; its returned head is **staged**, not a receipt. A caller
must BEGIN, claim its seek if applicable, and retain all projection writes in
that transaction. Lock order is seek → ordered existing player-delivery locks →
control → new grant → initial events → synchronous projection. Existing-stream
operations never take player/seek locks after a grant. Standalone SQL creation
users must respect the same player-lock precondition; the TypeScript helper
uses existing `lockGameCreationPlayers`. No network, engine, Redis or publication
work belongs inside these database transactions.

## Independent interface and outcome semantics

`PostgresFencedEventStore` exposes acquisition, renewal, release, mandatory-grant
existing-stream append and caller-client creation. It is not an optional-token
extension of the legacy event store. `FencingAcquireIntent` generates a fresh
cryptographically random 32-byte capability once per acquisition intent.
`FencingGrant` preserves its immutable tuple with private secret storage;
JSON/custom inspection redact the capability. Deliberate SQL parameter access
is sensitive and must never be traced or logged.

`FenceRejectedError` proves a noncommitting failure. `FencedHeadConflictError`
preserves head-conflict classification and request identity. SQL rejection occurs
before COMMIT; an acknowledged rollback proves no committed batch. Opaque failure
with unestablished rollback is conservative uncertainty. COMMIT dispatch without
a trustworthy acknowledgment, or malformed committed-result acknowledgment,
raises `FencedOutcomeUnknownError` with the original request ID. No replay,
rebinding or automatic append retry is performed. Suspect owned clients are
destroyed; transport error events are observed as well as query rejection.

Composable callers must use `commitFencedTransaction`, handle uncertainty and
destroy suspect clients themselves. Reconnect, sequence/epoch or an ordinary
state read is not an exact command receipt. PG-F1 supplies no durable dedup ledger.

## Security and explicit preparation

New functions are SECURITY DEFINER, with fixed
`search_path = pg_catalog, public, pg_temp`; new object references are qualified,
and runtime functions contain no dynamic SQL. PUBLIC execution/schema/table
rights are revoked transactionally. Migration creates no roles and enrolls no
production runtime. Unprepared/unsafe roles fail closed even if the migrating
owner has implicit owner execution rights.

`prepareGameFencing` is a privileged, explicitly invoked installer artifact,
**never startup wiring**. It requires separately provisioned, distinct, trusted
NOLOGIN table/schema owner and minimal NOLOGIN function executor. It assigns
ownership and the executor's required table/helper privileges; it grants no
runtime EXECUTE and removes preexisting explicit/default-ACL execution on these
new functions when re-preparing. Unexpected private-table/column privileges
fail preparation rather than silently exposing verifiers. Legacy writer grants
are untouched. Runtime must not be superuser/table owner or able to SET ROLE
into either owner. Privileged installer credentials must not reach runtime.
Actual production roles/default ACLs have not been inspected or certified.

Existing event insert triggers require trusted `public` lookup and limited
`pregame_deadlines`/`flag_deadlines` mutation plus event reads. These dependencies
are preserved; neither trigger is disabled or rewritten. Bootstrap checks the
trusted public-schema precondition and fails rather than revoking legacy writer
privileges. Temporary shadowing cannot replace qualified new objects; public
precedes pg_temp for legacy trigger lookup.

Principal binding uses **SESSION_USER**, the authenticated physical login, not
SECURITY DEFINER's CURRENT_USER, caller input or a caller GUC. Shared credentials
do not distinguish mutually distrustful services; process UUID and possession
are additional requirements, not substitutes for authenticated principal binding.
PG-F2 needs separately authenticated service pools or an independently reviewed
authenticated mapping. SET ROLE under one shared login is not such a mapping.

Raw capabilities necessarily cross the database protocol. Before any enrollment,
operators must disable bound-value logging from login/session startup:
`log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0`.
The adapter checks these before sending secrets; SQL checks them too. Fixture
roles configure them before actual authentication. Installing settings inside a
secret-bearing function would be too late. SQL/error objects do not expose raw
parameters or hashes. Server administration, third-party proxies, packet capture
and deliberately enabled external instrumentation remain trusted boundaries.

## Database recovery namespace

Every grant/token includes a database-incarnation UUID. Protected transactions
hold control SHARE until commit; controlled bootstrap/rotation uses UPDATE, so
rotation cannot overtake an older protected transaction. Rotation preserves
per-game epochs but invalidates old tokens. Before reopening a history-rewound
restore, operators must isolate/drain old writers and assign a fresh UUID under
trusted credentials; bootstrap must not reuse a historical namespace. PG-F1
does not automate restore, prove primary isolation or inspect live backups.

## Evidence and limitations

Tests use disposable PostgreSQL and actual restricted authenticated logins.
Grant-lock barriers observe real PostgreSQL blocked backends; lease transitions
use database timestamps. Coverage includes both lock schedules, rollback,
identity/capability denials, post-wait expiry, atomic batches, creation rollback,
pool reuse, schema/role/PUBLIC denial, INTEGER/BIGINT bounds, upgrade/backfill and
legacy compatibility. A real PostgreSQL wire proxy drops or corrupts COMMIT
acknowledgments; an independent connection verifies the committed event sequence.
Final exact-head counts/reviews and publication gates belong in the PR evidence.

The unchanged real Redis/PG baseline passes its D3/D4 characterization. A separate
future-enforcement witness intentionally fails obsolete-admitted-write rejection.
That witness is not a passing PG-F1 gate and is not merged as a skipped regression.
Setup/compiler/fault-harness mistakes are separate from behavioral RED evidence.
The pre-implementation Gemini review required a corrected addendum: proposals
for runtime grants, arbitrary duration defaults and cascading epoch deletion
were rejected rather than incorporated.

## PG-F2 and cutover prerequisites

After owner merge, separately authorize every creation/mutation integration,
grant-before-hydration lifecycle, Redis disagreement handling, deployed principal
mapping, grant completeness audit, measured lease/timeouts, writer drain,
effective-role/default-ACL/COPY/view/helper bypass denial, and credential rollout.
Cutover removes all legacy insertion privileges and requires a fencing-compatible
rollback floor, restore/failover isolation and separate-process fault evidence.
Coordinate D1-A persistence seams and whichever #107 deployment logic merges;
PG-F1 changes neither. No maintenance bypass or active-owner stealing is introduced.

**PG-F1 is additive infrastructure only. Its merge does not establish active
writer fencing, close R-01-LATE-APPEND, or certify multi-gateway production safety.**
