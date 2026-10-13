# Rookzen — permanent open findings tracker

Verified status checkpoint: **2026-10-13 (Africa/Cairo)**. Repository: `sayed710/rocky`.
Fetched `origin/main`, GitHub `commits/main` and remote main agreed on
`9dda14b4775157d035201a9fee3e536b022543f7` (owner-merged #109). This is a dated
checkpoint, not a live dashboard or a claim that all defects have been found.

## Maintenance and evidence rules

- Keep stable IDs, including closed entries. Every state change records the observed
  baseline, date, durable source and verification scope; never delete a deferred risk
  merely because a related PR merged.
- **Confirmed defect** means executed failure at the named baseline. **Observed
  behavior / policy pending** means measured behavior without an approved bound.
  **Design limitation** means an explicitly bounded contract; **unresolved risk**
  means a remaining safety question. **Historical / revalidation needed** does not
  mean a current reproduction. Source inspection is distinct from runtime testing.
- Severity below is an audit recommendation, not owner-approved launch triage.
  Public multi-gateway correctness and capacity concerns are qualified separately.
  Historical P2/P3 items are not silently promoted to required launch work.
- Close only with a merged fix or documented owner disposition, linked acceptance
  evidence and exact reviewed/tested head. A policy acceptance records its scope and
  residual risk; it is not a technical repair. Superseded-head approval is historical.
- Intentional REDs, setup errors, interrupted runs, retries and path-skipped CI jobs
  receive no passing credit. A green suite does not disprove a separately recorded RED.
- At each subsequent increment: fetch/prune, verify GitHub/main and concurrent PR
  heads, inspect this ledger and the [audit index](README.md), revalidate affected
  findings, and update only evidence actually established. Owner alone decides merges.
  Assignment below describes the supplied work allocation, not permission to message
  another agent or implement later work.

## Evidence register

Permanent summaries of the recovered local reports are included in the entries below.
Their raw bundles are **not committed or publicly archived**; preserve/archive them
before treating reproducer availability as durable. GitHub code links establish the
source baseline, not proof that a runtime experiment ran. Hashes identify the reports
read for this checkpoint; they are not independent attestation of their conclusions.

| Key | Evidence and limits |
|---|---|
| E-R01 | Recovered `R01-verification-report.md`, 2026-10-12, baseline `84b3d9d253dffcedab601967d2814600f6234cf5`; SHA256 `1df756f3a35797330a5f3023b504f96290eb9a7e49eb984a449a622ecebfa1ba`. Two independent gateway instances in one Node process, real Redis 7.4.9 / PostgreSQL 16.14 / loopback WebSockets; selected EventLog and subscriber timing controlled. Six expected-invariant REDs on saved observations, including one conditional direct-claim diagnostic; not six production defects. Original separate external R-01 report was missing; this report established fresh D1–D4 evidence. No process kill, deployed partition or browser rendering certification. |
| E-DESIGN | Recovered `R01-remediation-design-gate.md`, 2026-10-12, same baseline; SHA256 `f2a41389be360e509dda4ad8569355737f66aa7ac934692138e594adb381be99`. Owner accepted D1–D4 for planning. Proposed sequence: D4 → D3 → revision → recovery → draw; F1/F2 separately staged. Independent Gemini review was static planning review, not implementation GREEN. Proposed API/file/migration names remain provisional. |
| E-R02 | Recovered `r02-evidence/REPORT.md`, 2026-10-13, baseline `dd7fec5751f1501e10659a66ed940d5c5b2ceacb`; SHA256 `f7bb80365fce7e6daf37ed0ebb30f716529dceb2e479277bb1282c9d3ef2cb6e`. Final `run-final.log` SHA256 `f88c1eb30a0a4336f9309e4411e8ec78e95c4f1e43150fbc8364a805559f7876`: **12 tests, 8 passing controls/characterizations, 4 intentional REDs, exit 1, zero skips/cancellations**. Production modules unchanged; real Redis/PG, controlled I/O, in-memory gateway transport/PubSub. Original separate R-02 report unavailable; owner selected supplied brief for reproduction. No full CI, heap/OOM measurement, deployed load, real DB outage or process partition. Services cleaned up; replay needs fresh isolated services. |
| E-MAIN | [Current source checkpoint](https://github.com/sayed710/rocky/tree/9dda14b4775157d035201a9fee3e536b022543f7), [PROJECT_STATE checkpoint](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/docs/PROJECT_STATE.md). PROJECT_STATE still contains pre-merge delivery checkpoints; GitHub merge records below supersede their pending-merge wording. This PR does not edit PROJECT_STATE. |

Raw provenance locations, for recovery only: E-R01/E-DESIGN were read from
`C:/Users/hp/.codex/visualizations/2026/10/12/01a130aa-cb4f-7f51-87e8-e6951f6c2a5e/r01-audit/`;
E-R02 from `C:/Users/hp/rocky-r02-red-20261013/r02-evidence/`.
These are not contributor-accessible links. The durable record is this summary plus
the pinned repository/PR evidence, with the raw-archive gap explicitly retained.

## Status index

| Stable ID | Classification / current state | Qualified relevance | Assignment |
|---|---|---|---|
| R-01-D4 | Completed fix: #108 merged | Historical P2 hydration correctness | Completed PR1; no active assignee |
| R-01-D3 | Completed queued-admission fix: #109 merged | Historical P1 obsolete queued execution | Completed PR2; residual risk below |
| R-01-REV | Pending contract groundwork | Prerequisite for multi-gateway recovery; no separate measured severity | Unassigned |
| R-01-D1 | Confirmed at historical baseline; pending, current source gap retained | Recommended P1 recovery correctness | Unassigned |
| R-01-D2 | Confirmed at historical baseline; pending, current source gap retained | Recommended P1 distributed draw behavior | Unassigned |
| R-01-LATE-APPEND | Accepted intermediate D3 limitation; unresolved production risk | Strong fence required before public multi-gateway production | Unassigned; owner policy |
| PG-F1 | Future schema / durable authority infrastructure | Production safety dependency; inactive alone | Unassigned |
| PG-F2 | Future mandatory all-writer enforcement | Production safety / rollout gate | Unassigned; owner enforcement choice |
| R-02-F1 | Observed terminal retention; policy pending | Reported P1 operational concern, no retirement SLA | Owner policy; implementation unassigned |
| R-02-F2 | Observed cumulative cache residency; policy pending | Reported P2 capacity concern, no measured heap leak | Owner policy; implementation unassigned |
| R-02-F3 | Confirmed defect on dd7fec5; separate remediation active, not closed | Reported P2 lifecycle correctness | Separate F3 agent; worktree branch verified below |
| R-02-F4 | Confirmed defect on dd7fec5; pending | Reported P3 metadata retention, bytes/frequency unmeasured | Unassigned |
| DEPLOY-107 | Implementation PR open; delivery gates pending | Recovery safety within deployment scope | Existing #107 implementer; no reassignment |
| HIST-WIN-WORKER | Historical failure; cause unknown | Diagnostic follow-up, not newly mandatory launch work | Unassigned |
| HIST-CHROMIUM | Historical failed invocations; cause unresolved | Preserve provenance; later passes do not prove repair | Unassigned |

## R-01-D4 — stable hydration and game-slot lifetime

- **State / evidence:** closed by [#108](https://github.com/sayed710/rocky/pull/108),
  merged 2026-10-12 19:46:54 UTC, merge `202eee3f833e479e43fcafb07f80e539b3361809`,
  reviewed head `0ee128cded68c62bc82eacdf26fe72485768ef0d`. E-R01 cold-read overwrite
  was reproduced on `84b3d9d`: held ply-0 read arrived after b1c3 committed seq 1,
  reset owner cache to ply 0, and legal Black e7e5 refused as `not_your_turn`.
- **Closure evidence:** [audit](R01_D4_STABLE_HYDRATION_2026-10-12.md),
  [ADR-0159](../adr/0159-stable-game-slot-hydration.md),
  [final delivery / independent exact-head review provenance](https://github.com/sayed710/rocky/pull/108#issuecomment-6130106441),
  [Greptile exact head](https://github.com/sayed710/rocky/pull/108#issuecomment-6129660659).
  Delivery records 110 authority tests / 15 hydration schedules, clean Linux real
  Redis/PG gateway 116/116 and root 4,111 tests; failed runs are disclosed separately.
- **Follow-up / dependency / boundary:** retain generation/disposal/load-failure and
  forced-reload regressions in later R-01/R-02 PRs. One process-local slot is not
  distributed freshness, fencing or a cache policy. Later slot changes require new
  integrated-head evidence. Assigned PR1 completed; no active assignee.

## R-01-D3 — execution-time queued ownership admission

- **State / evidence:** closed **within queued-admission scope** by
  [#109](https://github.com/sayed710/rocky/pull/109), merged 2026-10-13 10:34:38 UTC,
  merge `9dda14b4775157d035201a9fee3e536b022543f7`, reviewed head
  `2d36d5cef606119897e7341b1a8748d4a7a1f7d9`. Original RED: queued second move
  executed after lease reassignment, durable seqs `[0,1,2]`. GREEN leaves `[0,1]`,
  refuses queued work before mutation/append/broadcast/receipt, and allows the first
  already-admitted append to finish. Baseline and integrated fixes are distinguished
  in the [audit](R01_D3_OWNERSHIP_ADMISSION_2026-10-12.md).
- **Closure evidence:** [ADR-0160](../adr/0160-execution-time-ownership-admission.md),
  [final delivery, CI and independent exact-head provenance](https://github.com/sayed710/rocky/pull/109#issuecomment-6134157203),
  [Qodo engine completion for final head](https://github.com/sayed710/rocky/pull/109#issuecomment-6133977410),
  [Greptile](https://github.com/sayed710/rocky/pull/109#issuecomment-6132750798).
  Final delivery reports root 4,164, clean gateway 154/154, admission 20/20 and
  [CI 38317740098](https://github.com/sayed710/rocky/actions/runs/38317740098).
  These are linked historical fix results, not tests re-executed by this tracker.
- **Follow-up / dependency / boundary:** retain ticket/ABA/expiry/lease-I/O ordering,
  cross-game renewals, R-03 exact receipts and R-04 cleanup at future combined heads.
  Assigned PR2 completed; no active assignee. **R-01-LATE-APPEND remains open below.**

## R-01-REV — durable presentation revision contract

- **State / severity:** pending groundwork; no revision-specific runtime RED was
  previously executed. E-DESIGN proposes `stateRevision` from durable
  `game_events.seq`, distinct from ply, clock time, broadcast sequence, request ID
  and ownership epoch. On E-MAIN the server/client wire contracts still have no
  `stateRevision`: [server protocol](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/realtime-gateway/src/protocol.ts),
  [client protocol](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/web/src/net/ws-protocol.ts).
- **Follow-up / tests:** define snapshot head and per-event persisted revision,
  same-ply readiness/draw/end ordering, safe-integer validation, batch-prefix payloads,
  live/replay parity, no-op readiness, equal-revision membership acknowledgements,
  legacy/capability boundaries and R-03 receipt separation. Actual schema seq is
  INTEGER; no event payload/schema migration is needed for this proposed contract.
- **Dependencies / PR boundary:** start after fresh owner-merged #108/#109/#106;
  these are now satisfied on E-MAIN. Separate additive contract PR, then D1, then D2.
  Preserve R-04 authorization/socket generations. Do not implement recovery, cache
  policy or fencing in this increment. Assignment: unassigned; no existing revision PR
  found in the open-PR checkpoint. E-DESIGN is planning evidence, not a merged ADR.
- **Closure:** merged contract PR plus exact-head protocol, batch/replay and client
  fixture checks. Contract closure alone does **not** close D1/D2 or certify rollout.

## R-01-D1 — coherent durable recovery and stale snapshot rejection

- **State / severity:** E-R01 confirmed P1 candidate at `84b3d9d`; pending. Current
  source inspection on E-MAIN retains the mechanism; the old runtime harness was
  **not rerun after #109**. [Gateway](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/realtime-gateway/src/gateway.ts)
  resumes from local authority state/missed history; PubSub room fanout does not
  update that cache. [GameSync](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/web/src/net/game-sync.ts)
  applies snapshots without durable revision ordering. D4 local hydration repair is
  not proof that a warm non-owner cache is fresh.
- **Evidence:** owner and clients reached ply 2 / PG seq 2, non-owner cache stayed 0;
  resume returned ply 0 / missed `[]`, and production GameSync rolled back to 0.
  After resignation, resume/new join exposed the old live game. Held/lost callback
  schedules and an R-03 late exact receipt also recovered to stale state. This does
  not claim ordinary Redis TCP publisher reordering or duplicate durable commits.
- **Follow-up / tests:** reestablish RED on fresh main; join/resume must derive state
  and replay from one durable cut with an observed revision floor. Cover stale/equal
  frames, terminal reopening, SUBSCRIBE acknowledgement/read race, continuity loss,
  last-publication loss without later traffic, bounded probe capacity, auth/session
  cancellation and outcome-unknown receipt order without automatic resend.
- **Dependency / boundary / assignment:** R-01-REV first; separate read-only recovery
  path and client synchronization PR, coordinated with F3/F4 shared router/lifecycle
  files and R-04 barriers. Unassigned. Closure requires merged fix, real Redis/PG/WS
  on both nodes and mounted client evidence at exact integrated head; two-instance
  evidence alone does not certify two-process or deployed partition behavior.

## R-01-D2 — authoritative draw/non-move propagation

- **State / severity:** E-R01 confirmed P1 candidate at `84b3d9d`; pending, not rerun
  on E-MAIN. Current [authority](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/realtime-gateway/src/authority.ts)
  still omits draw offer/decline from `toBroadcast`; the gateway's zero-broadcast
  fallback reads local authority instead of the successful forwarded result.
- **Evidence:** after two moves, forwarded Black offer committed `DrawOffered` seq 3
  at unchanged ply 2; owner state was `drawOffer=b`. Requester's snapshot was ply 0 /
  `drawOffer=null`; opponent also saw no offer. Owner-originated analogue was source
  analysis only; decline and delayed-offer schedules were proposed, not executed.
- **Follow-up / tests:** fresh RED; publish revisioned authoritative non-move state
  to both rooms for owner and non-owner origins. Offer/decline at same ply must order,
  stale offers must not resurrect, and payloads must come from committed state.
- **Dependency / boundary / assignment / closure:** revision then coherent recovery;
  separate propagation PR, unassigned. Require merged fix, real two-node Redis/PG
  traces, same-ply client tests and exact-head review; do not use a local fallback
  snapshot or revision groundwork alone as closure evidence.

## R-01-LATE-APPEND — admitted obsolete writer can commit after takeover

- **State / relevance:** explicitly retained minimal-D3 design limitation and
  unresolved public multi-gateway safety risk. [ADR-0160 limits](../adr/0160-execution-time-ownership-admission.md)
  and #109 final delivery retain it. E-R01/E-DESIGN describe old owner admitted before
  pause, successor claimed/reloaded unchanged head, old append then finished before
  successor wrote. Expected-sequence validation protects event order, not ownership.
  This is not a newly proved corruption or exactly-once failure.
- **Follow-up / boundary:** owner selects strong ordering for already-admitted work;
  PG-F1/F2 must serialize durable grant activation and active append. Keep R-03 known
  non-commit versus lost-COMMIT acknowledgement/unknown distinctions, exact receipt
  identity and no replay. Unassigned. Successor recovery remains D1 work.
- **Closure:** owner-scoped risk acceptance may document an intermediate deployment
  limit, but technical fencing closure requires mandatory all-writer enforcement and
  real PG old-append/new-grant ordering tests. #109 merge does not close this risk.

## PG-F1 — durable grant/schema and fenced append infrastructure

- **State / relevance:** future, not implemented. E-DESIGN proposed PG-owned grant
  `{holder, epoch, grantId, leaseUntil}`; Redis is a routing mirror. E-MAIN
  [event store](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/persistence/src/pg/event-store.ts)
  still uses expected sequence rather than durable authority grant enforcement.
  Planning severity is safety-critical for intended public multi-gateway use;
  additive infrastructure alone supplies no active fence.
- **Follow-up / tests:** schema/security review, shared grant/append row-lock ordering,
  database-clock expiry after lock acquisition, opaque epoch transport, transaction
  context, typed proven rejection and initialization without event-log rewrites.
  Test old-before-grant versus grant-before-old append and concurrent acquisition.
- **Dependency / boundary / assignment / closure:** owner-authorized additive
  persistence PR; migration numbers in E-DESIGN are provisional. Unassigned.
  Require merged infrastructure, real PG integration and exact-head review; keep
  PG-F2 open until production binding/enforcement and rollout are verified.

## PG-F2 — runtime grants and mandatory enforcement for every writer

- **State / relevance:** future, not implemented; depends on PG-F1 and owner choice
  of DB enforcement/roles. Application-only optional fence parameters cannot prevent
  an old/fenceless binary writing. Separate production release gate, not D3 closure.
- **Evidence / scope:** E-DESIGN identifies [API durable launcher](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/packages/api/src/tournament/durable-launcher.ts)
  creation and direct legacy abort writers as well as gateway/engine/expiry paths.
  There is no approved blanket maintenance bypass. Role privileges, pooling and
  trigger/function approach remain decisions, not implemented guarantees.
- **Follow-up / tests:** bind immutable grants through all writers; enforce at DB
  boundary, including old binaries. Test stale/missing/forged context, creation,
  legitimate maintenance, COMMIT/ROLLBACK/client reuse and deployed pooling mode,
  delayed Redis mirror updates, two-process takeover and receipt uncertainty.
- **Boundary / assignment / closure:** separately authorized runtime/enforcement and
  rollout PR(s), unassigned. Drain old active writers before mandatory activation;
  rollback to unfenced writers must fail closed. Require merged enforcement, actual
  role/bypass tests and owner-approved rollout/deployed evidence. Coordinate with
  whichever Helm recovery logic is merged; #107 is not changed here.

## R-02-F1 — terminal leases and blocking consumer retention

- **State / severity:** runtime retention confirmed on dd7fec5 (E-R02); reported P1
  operational concern, **policy pending**, no approved timeout violation. Six normally
  resigned games with no rooms, subscribers, queued commands or pending authority
  work retained 6 owned entries, 6 loops and 6 blocking connections at 3.1/6.2/9.3s
  under a test-only 4s lease/1s renewal. Repeated renewals crossed original TTLs.
  This did not measure infinite duration or a full 15s BLPOP reissue cycle.
- **Current source / tests:** [ownership renewal](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/services/gateway/src/ownership.ts)
  still renews owned games without terminal/session policy. Recharacterize after
  #109's renewal changes. Controls showed explicit release, wrong-node compare/delete,
  live remote forwarding, admitted resignation completion, owner bot duties and
  temporary expiry-copy cleanup. Not every terminal path retains resources.
- **Dependency / boundary / assignment:** owner defines safe retirement eligibility,
  duties, grace and draining before implementation; unassigned. Separate ownership
  retirement PR after F3/F4 lifecycle coordination, not generic cache disposal.
- **Closure:** approved policy plus exact-head tests preserving admitted/unknown work,
  request identities/responses, live forwarding, bot/expiry duties and lease ownership;
  measured resource release at the chosen boundary. An invented timeout is insufficient.

## R-02-F2 — cumulative completed-game authority cache residency

- **State / severity:** E-R02 observed behavior on dd7fec5, reported P2 capacity concern;
  no approved entry/byte/age bound and **no measured heap leak**. Completed games
  accessed through spectator join/resume/disconnect grew records 5→10→20,
  retained events 15→30→60 and replay entries 10→20→40, with rooms/pending zero.
  Same-game repeated access did not multiply records. Drained eviction removed all
  20; reload restored one durable completed game and its replay.
- **Current evidence / follow-up:** E-MAIN authority has explicit `evict`, no automatic
  capacity policy in this inspected path. Delayed-disconnect and unauthorized joins
  retained a record but no room; this is not auth bypass. Measure representative
  residency/heap/load and cold replay cost only against an approved policy.
- **Dependency / boundary / assignment / closure:** owner selects bound/exemptions,
  including failed/disconnected cold joins. Separate cache PR, implementation
  unassigned; preserve D4 busy slots, live rooms, bots/background work and recovery.
  Require explicit policy and exact-head bound/eviction/replay tests; neither a claim
  of heap leakage nor successful manual eviction closes the policy question.

## R-02-F3 — consumer stop/restart instance identity race

- **State / severity:** confirmed on dd7fec5, reported P2; **three intentional REDs**,
  not passing CI. A stopped BLPOP connection's rejection arrives after B replaces
  its game ID; membership-only guards let A loop again. Five replacements left five
  untracked obsolete loops; real ioredis A reached `end` yet attempted BLPOP twice.
  B remained operational. Old sockets were closed: observed leakage is loop/promise/
  retry-timer/log activity, not extra live Redis sockets.
- **Current source / assignment:** E-MAIN [consumer](https://github.com/sayed710/rocky/blob/9dda14b4775157d035201a9fee3e536b022543f7/services/gateway/src/command-forwarder.ts)
  still guards with `blockingConns.has(gameId)` rather than instance identity.
  Separate F3 remediation agent assigned by owner; registered worktree
  `rocky-fix-r02-f3-consumer-20261013`, branch `fix/r02-f3-consumer-20261013` was at
  `9dda14b` during preflight. No F3 PR was open at that checkpoint. Registration
  proves allocation, not implementation completion; runtime RED not rerun here.
- **Follow-up / boundary / closure:** small instance-owned consumer lifecycle PR.
  Test no replacement, A/B delayed rejection, repeated replacement and real Redis;
  also stale success / `not_owner` callbacks must not affect B. Require merged fix,
  permanent RED→GREEN tests and exact-head review preserving D3, R-03 and R-04.

## R-02-F4 — abandoned claim/reload metadata after release

- **State / severity:** confirmed on dd7fec5, reported P3; **one intentional RED**.
  Twelve completed PG game IDs with controlled load failure then explicit release
  left `staleAfterClaim` and `claimGeneration` at 4→8→12 while `rehydrations`, owned
  games, slots and pending work were zero. First expected-zero assertion failed
  12≠0; the later generation assertion was not reached. Failure injection was at
  log I/O, not a real PG outage; byte impact/frequency were not measured.
- **Current source / follow-up:** E-MAIN router release hook still stops the consumer
  without retiring debt/generation entries; successful reload clears them. Reproduce
  after #109; preserve the positive control where obsolete completion cannot clear
  a later claim's debt. Retirement must be generation-aware.
- **Dependency / boundary / assignment / closure:** separate small router debt-retirement
  PR after/coordinated with F3; unassigned. Require merged fix, failed-load/release
  RED→GREEN across distinct IDs and old/new generation controls on exact head;
  do not fold F1/F2 policy into this repair.

## DEPLOY-107 — Helm rolling recovery and external-writer TOCTOU

- **State / severity:** [#107](https://github.com/sayed710/rocky/pull/107) is **OPEN** at
  `cf1bc030c63b97cb2b4a25b8581b4f514f054360`; deployment safety scope, separate from
  R-01. PR body describes verified pre-upgrade deployed rollback target, tri-state
  existence and guarded initial uninstall. Its validation/review table calls
  `aa08898` final, but current head is newer: those approvals are historical.
  The [current-head deployment ADR](https://github.com/sayed710/rocky/blob/cf1bc030c63b97cb2b4a25b8581b4f514f054360/docs/adr/0076-deploy-pipeline.md)
  adds run-marker attribution, fresh history/ownership rechecks, orphan inventory
  and history-window refusal; it also records bounded kind observations of Helm
  descriptions. These do not prove race-free external-writer recovery.
- **Review evidence:** PR body records repeated independent read-only GPT-6.1 Sol
  review including aa08898; model identity was runtime self-report. E-DESIGN also
  records review of the earlier PR scope. [Qodo comment](https://github.com/sayed710/rocky/pull/107#issuecomment-6108400343)
  and [older exact-head request](https://github.com/sayed710/rocky/pull/107#issuecomment-6111495407)
  are provenance, not sufficient independent exact-final-head approval. Stub Helm
  behavior tests plus real template/lint validation do not establish live-cluster recovery.
- **Retained limitation:** external Helm writers can act between a verified history/
  run-ownership snapshot and a later rollback/uninstall mutation (TOCTOU). Workflow
  concurrency does not serialize an external writer; even a fresh ownership recheck
  is not an atomic external-writer exclusion guarantee. Owner must define operational
  serialization/manual recovery constraints; do not claim that run checks eliminate it.
- **Follow-up / boundary / assignment / closure:** existing #107 implementer owns
  corrections; no reassignment. Require fresh source/test/CI/independent reviewer
  evidence naming the exact eventual final published head, current Qodo/Greptile
  findings and resolved threads, plus disclosed external-writer limits. Merge is
  owner-only; merging bounded recovery does not close external concurrency risk.

## HIST-WIN-WORKER — historical Windows worker / Signature B failures

- **State / relevance / evidence:** historical, cause unknown. [O10 audit](LAUNCH_O10_WINDOWS_SIGNATURE_B_VERIFICATION_2026-10-05.md)
  records three bounded readable runs on `5ee3441` with zero Signature B captures;
  O10's bounded verification closed, **not a root-cause repair**. It distinguishes
  API DB-backed execution from persistence suites not exercised. E-MAIN PROJECT_STATE
  and [R-01 D3 audit](R01_D3_OWNERSHIP_ADMISSION_2026-10-12.md) retain unsuccessful
  Windows invocations; unrelated #107 body also records whole-file API crashes before
  passing repeats. Similar symptoms alone do not establish a common cause.
- **Follow-up / dependency / boundary / assignment / closure:** unassigned diagnostic
  follow-up if it recurs, separate PR only after reproducible cause. Preserve exact
  SHA, Node/OS, exit status, diagnostic capture and suite coverage; no speculative
  worker/production fix. Closure of root cause requires causal reproduction and
  verified repair; non-observation or a later pass is insufficient. No automatic
  promotion to required launch work.

## HIST-CHROMIUM — preview crash and unsuccessful parallel browser runs

- **State / evidence:** D3 audit records a Windows preview crash/interrupted attempt
  and four-worker Chromium **283/285** with achievements/analysis assertion timeouts.
  Later unchanged serial run passed **285/285**, retries disabled; #109 final CI also
  passed 285. Consult the audit and [final delivery](https://github.com/sayed710/rocky/pull/109#issuecomment-6134157203)
  for baseline/head progression; no causal remediation was established. These failures
  are not evidence that the final suite failed, and later GREEN does not erase them.
- **Follow-up / dependency / boundary / assignment / closure:** unassigned; preserve
  exact invocation/concurrency/head and logs, capture preview exit/diagnostics on
  recurrence, then propose a focused diagnostic repair if causal evidence warrants.
  No invented browser/worker fix or new launch requirement. Root-cause closure needs
  reproducible attribution plus verification; retained failed runs receive no pass credit.

## Read-only recommendation — next revision-contract increment

Start with **R-01-REV**, after freshly verifying owner-merged main and active F3/F4
heads. #106 is merged at `dd7fec5`; #108/#109 satisfy the planned prerequisite order.
No implementation is authorized by this recommendation. Do not wait for #107 merely
to define presentation revisions; it is independent deployment work.

Suggested boundary: server/client wire schemas, durable seq stamping in authority
snapshots/live/replayed event frames, complete proposed non-move and synchronization/
capability schemas, validation and compiler-required fixtures. Preserve exact receipts,
R-04 session/auth/socket gates and same-revision valid joined acknowledgements. A
move-plus-ending batch must expose each event's own durable prefix, not final batch
state under an earlier stamp. Test first; retain legacy distinctions until an explicit
rollout decision. No schema migration, fencing, recovery algorithm, cache policy or
activation claim in this additive increment.

Expected files: `packages/realtime-gateway/src/{protocol,authority,index}.ts`,
`packages/web/src/net/ws-protocol.ts`, protocol/authority/game-sync/revision tests and
typed web fixtures (including #106's session helper). Reinventory on fresh main.
Client synchronization enforcement belongs to D1; changes to `game-sync.ts` should
remain bounded to what the finalized contract actually requires.

F3 directly edits `services/gateway/src/command-forwarder.ts`; F4 is expected to edit
that router and its lifecycle tests. A strict revision-only PR should avoid that file
and `ownership.ts`, so direct production overlap with F3 can be low. Shared integration
tests and `docs/PROJECT_STATE.md` are likely coordination surfaces. R-02-F1/F2 future cache
policy work can touch `authority.ts`, creating direct overlap; D1/D2 also share it.
Keep this tracker PR to its single new document and leave Codex 1's engineering-state
edits untouched. After any prerequisite merge, regenerate the semantic diff and run
integrated regressions/review; do not reuse approval from a different SHA.

## Deferred historical audits and remaining evidence debt

The [original Fable/Astra audit](FABLE_ASTRA_FULL_AUDIT.md),
[remediation ledger](FABLE_ASTRA_CURRENT_REMEDIATION_2026-10-05.md) and
[bounded engineering closure](FABLE_ASTRA_FINAL_CLOSURE_2026-10-05.md) remain distinct
dated records. Historical P0/required-P1 closure is not a statement that later R-01/R-02
defects cannot exist. Deferred P2/P3 recommendations keep their historical disposition;
opening a new launch requirement needs current evidence and owner triage.

Unresolved evidence debt: public archive of original R-01/R-02 raw bundles, original
external numbered reports, fresh runtime revalidation of D1/D2/F1–F4 after #109,
strong-fence enforcement/role/rollout proof, and exact-final-head #107 independent
review. Conditional direct-registry consumer freshness remains a component diagnostic
with production reachability unverified; it is not silently counted as another defect.
