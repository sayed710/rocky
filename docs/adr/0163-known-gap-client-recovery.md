# ADR-0163: Known-gap client recovery (D1-B)

Date: 2026-10-26
Status: Owner-delegated implementation candidate; review and verification pending.
Baseline: `de59e52dbd85720ab75a0ef6e34f5c955a1d2f97` following PR #118 merge and PR #119 server recovery.

## Context and scope

`ADR-0161` established the durable `stateRevision` foundation (`game_events.seq` integer bounds),
and PR #118 implemented client-side state ordering and failclosed rejection of un-stamped frames
in `packages/web/src/net/game-sync.ts`. PR #119 introduced server-side coherent recovery in
`packages/realtime-gateway/src/gateway.ts`.

However, prior to D1-B, client-side recovery on observing gap frames was naive:
1. A gap frame triggered immediate un-coalesced `resume` messages, creating redundant socket traffic
   under bursts of out-of-order broadcasts.
2. Recovery was unbounded: missing server responses or repeating failures lacked a timeout or backoff
   budget, risking unbounded retries without exposing recovery exhaustion to the user interface.
3. Recovery target state was conflated with `stateRevisionFloor`: observing an unapplied gap frame
   risked either prematurely advancing the applied ordering floor or losing track of the true required
   catch-up target.
4. Partial progress from intermediate snapshots was not distinguished from complete target discharge.
5. An incomplete recovery state did not gate gameplay submission, permitting players to submit moves
   or actions against a known-incomplete local board projection.

This increment delivers bounded, coalesced client core recovery (D1-B) within `packages/web`,
with server foundation dependency in `ADR-0164`. Companion lifecycle, boundary, and cross-node
GameSync integration tests (not shipped in core PR C) are now supplied in the composite TOP PR #130
layer across `packages/web/test/known-gap-boundaries.test.ts`,
`packages/web/test/known-gap-session-receipts.test.ts`, and `packages/web/test/draw-state-fanout.test.ts`.

## Decisions

### 1. Separate target retention and floor monotonicity
The client retains known required recovery targets (`targetRevision` and `targetPly`) strictly
separately from `stateRevisionFloor` and `state.ply`.
- `stateRevisionFloor` advances only when an authoritative frame or snapshot is actually accepted
  and applied to local state. Observing an unapplied gap frame (e.g. out-of-order move or ready)
  records the required target but NEVER advances `stateRevisionFloor`.
- `stateRevisionFloor` is strictly monotonic non-decreasing for the lifetime of the immutable game
  synchronizer. It is never reset or decreased across user authentication changes, credential refreshes,
  or reconnects.

### 2. Coalescing and bounded retry budget across flight and backoff
Known-gap recovery is coalesced into one logical pending attempt across flight and backoff:
- If a gap frame arrives while a recovery attempt is already in flight or backoff delay is running,
  the target (`targetRevision`, `targetPly`) is raised to the maximum observed requirement without
  dispatching duplicate wire requests, without resetting the delay timer, and without resetting the
  fixed attempt budget.
- The recovery episode is bounded by a fixed budget of `MAX_GAP_RECOVERY_ATTEMPTS = 3` logical dispatches.
  Attempt charging occurs strictly at the actual wire dispatch boundary (`client.send`), after rechecking
  lifecycle state and target existence following subscriber notifications. If a synchronous listener cancels
  or stops recovery before transmission, the unsent attempt does not consume retained attempt budget.
- Each logical attempt is governed by a conservative timeout of `GAP_RECOVERY_TIMEOUT_MS = 2_000` ms
  via the injected `Scheduler`. Timer expiration concludes a logical attempt; it cannot cancel an
  in-flight server database read.
- Settlement semantics: if client.send returns false, the logical dispatch is charged, then immediately
  enters bounded backoff or exhaustion; successful sends remain pending until timeout or an accepted
  sufficient snapshot discharges the flight. Intermediate insufficient snapshots and unrelated command
  rejections do not settle it, preserving flight and debt without spending attempt budget or prematurely
  triggering backoff (no physical database cancellation claim).
- Retries use binary exponential backoff with a base delay of `GAP_RECOVERY_BASE_DELAY_MS = 1_000` ms
  (`1_000` ms, `2_000` ms).
- Upon budget exhaustion (3 attempts), the client enters quiescence: known-gap recovery timers clear,
  no automatic gap-recovery traffic occurs (shared WsClient heartbeats/reconnect lifecycle and separate
  R03 read requests remain possible; no periodic freshness polling introduced), and `recoveryAvailable: true`
  is exposed in `GameSyncState` alongside `recovering: true` (retaining the durable incomplete recovery state).
- Budget retention and reset rules:
  - Retained across transport disconnect/rejoin, socket drop, and stop/start: the attempt budget
    (`gapRecoveryAttempt`) is retained across transient transport drops/reconnects for the same GameSync
    instance to prevent reconnect loops from bypassing the 3-attempt ceiling.
  - Retained across logout and sessionChanged: same-game target and floor remain monotonic, and the attempt
    budget is retained.
  - Reset on successful discharge: an accepted sufficient snapshot discharges the target and resets
    `gapRecoveryAttempt = 0`.
  - Reset on explicit manual retry: `retryRecovery()` invalidates manual replacement by invoking
    `clearGapRecovery()` (`recoveryEpoch++`, cancelling active timers and resetting pending flag),
    resets `gapRecoveryAttempt = 0`, and restarts recovery if debt remains (or resets auth/join attempts if
    disconnected). Automatic `networkOnline()` is a no-op on already-open sockets, preserving in-flight gap
    episodes, backoff, and attempt budgets. Owned disconnected malformed recovery joins clear `awaitingJoin` and settle into
    existing bounded join retries with base delays of 1s/2s/4s (respecting `SessionManager.refreshRetryDelayMs` cooldown max),
    providing an initial join plus 3 automatic retries before exposing manual retry availability, separate from the 3 logical
    gap recovery resume budget; malformed connected duplicate joined frames are ignored without timer, role, or state changes.

### 3. Discharge condition and partial progress
Only an ACCEPTED full snapshot (`snapshotFreshness` returning `'newer'` or `'equal'`) with sufficient
revision (`stateRevision >= targetRevision`) and sufficient safe integer non-negative ply
(`typeof view.ply === 'number' && Number.isSafeInteger(view.ply) && view.ply >= 0 && view.ply >= targetPly`)
can discharge the target.
- Stale snapshots (`snapshotFreshness === 'stale'`) and malformed legacy frames (missing or non-safe-integer ply)
  are rejected and cannot discharge the target.
- Full structural completeness is required (moves array, string FEN, non-null status).
- An accepted snapshot that provides partial progress (advances ply or revision, but falls short of
  `targetRevision` or `targetPly`) updates local state but does NOT claim completeness: the target
  remains active, and the client proceeds with bounded retry for the remaining gap without consuming
  extra attempt budget.
- Terminal monotonicity (`status.over` cannot be undone) and equal-head terminal history repair
  are preserved.

### 4. Gameplay submission and UI gating through exhaustion
While known-gap recovery debt is active (`recovering === true`), gameplay submission and UI affordances
are strictly gated through exhaustion:
- `canCommand()` returns `false`, causing `submitMove()` to return `null` and `sendAction()`
  (`resign`, `offerDraw`, `acceptDraw`, `declineDraw`, `claimFlag`, `abort`) to return `false`.
- In `GameController`, `myTurn` is derived as `false` when `state.recovering` is `true` (turn projection, but `myTurn === false` alone permits off-turn premoves); actual gesture admission on game mount uses `syncBoardOwnership` with `board.setInputEnabled(owner !== null && !recovering)`,
  preserving ownership and disabling gestures/clearing selections and premoves through flight, backoff, and exhaustion (existing disable path dismisses promotion); callback-only tests do not prove mounted behavior.
- `GameActionState` projects `canAbort: false` and `drawOffer: 'none'` during recovery; action submission
  affordances (`canResign`, `canAbort`, etc.) remain disabled in `GameController` and `game-mount.ts`
  until sufficient recovery.
- Incomplete recovery never grants new roles or privileges.
- The client NEVER replays moves or actions automatically upon recovery completion.

### 5. Lifecycle and session fencing
When `stop()`, `logoutRequested()`, or socket state changes away from `'open'` occur:
- Active recovery timers are cancelled, and callbacks/continuations are fenced by incrementing `recoveryEpoch`.
- Fenced callbacks exit immediately before invoking any state patch or mutating any timer handle.
- Teardown idempotency: `stop()` checks active subscription status (`if (!this.unsubscribe) return;`), ensuring
  reentrant teardown invocations from synchronous subscriber notifications are safe no-ops and avoid mutual recursion.
- Synchronous listener reentrancy is fenced: `dispatchGapRecovery` captures operation and lifecycle
  identity (`recoveryEpoch`, `client.generation`) before notifying subscribers and rechecks lifecycle/target
  existence before transmitting wire frames.
- Timer callbacks verify handle ownership (`this.gapRecoveryHandle === myHandle`) and epoch fencing
  (`epoch === this.recoveryEpoch && socket === this.client.generation`) before mutating state or clearing handles;
  an obsolete or superseded callback returns immediately before any mutation and cannot clear successor handles
  or trigger successor backoff.
- Retained same-game targets survive connection and session replacement; a fresh authorized `joined`
  message can satisfy and discharge the retained target.
- `stop()` unsubscribes from the client without closing the shared `WsClient`.

### 6. Conservative gap detection
Revision gaps are detected across received event frames:
- `ready`: If stamped with `stateRevision > stateRevisionFloor + 1`, a revision gap is recorded
  (accounting for intervening pregame draw or lifecycle events) without advancing `stateRevisionFloor`.
  Monotonic readiness is still merged. Stamped-stale ready frames continue to be dropped. Legacy
  un-stamped ready frames merge readiness via boolean OR without altering revision tracking.
- `move`: If `ply !== state.ply + 1` or `stateRevision > stateRevisionFloor + 1`, the move is dropped
  as an unapplied gap frame, `targetRevision` and `targetPly` are recorded, and recovery is triggered.
- `ended`: If `stateRevision > stateRevisionFloor + 1`, terminal status is applied immediately to
  preserve terminal monotonicity, `stateRevisionFloor` advances to the terminal sequence, and
  `targetRevision` is recorded to recover missing positional history.

### 7. R-03 command receipt independence
Existing R-03 command uncertainty (`outcomeUnknown` and `commandConfirmed`) semantics remain separate.
Matching board FEN, UCI, draw state, or state revisions never proves an uncertain command outcome;
only exact `requestId` receipts or terminal/original-seat readiness exceptions resolve uncertainty.
Uncorrelated command rejections received during recovery do not abort recovery or debit recovery budget.

## Boundaries and open limitations

- **Confined to web client:** No protocol, server, database, persistence, fencing, deployment,
  or authentication configuration changes are made.
- **Client core scope and layer dependencies:** Confined to client core recovery components
  (`game-sync.ts`, `game-controller.ts`, `game-mount.ts`, and core unit suites). It depends on the server
  foundation in `ADR-0164`. While core PR C intentionally excludes companion lifecycle, boundary, and
  cross-node GameSync integration suites, those tests are now supplied in the composite TOP PR #130 branch
  (`packages/web/test/known-gap-boundaries.test.ts`, `packages/web/test/known-gap-session-receipts.test.ts`,
  and `packages/web/test/draw-state-fanout.test.ts`).
- **Silent final-publication loss:** If the final broadcast of a game is lost silently by the network
  and no subsequent frame or user action creates an observable gap, client-side gap detection cannot
  discover the lost frame until an explicit user action (e.g. reload or reconnect) queries the gateway.
  This remains an explicit open limitation.

## References

- [ADR-0161: Durable state revision foundation](0161-durable-state-revision-foundation.md)
- [ADR-0164: Committed draw-state fanout](0164-committed-draw-state-fanout.md)
- [GameSync implementation](../../packages/web/src/net/game-sync.ts)
- [GameController implementation](../../packages/web/src/app/game-controller.ts)
