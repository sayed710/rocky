# ADR 0173: Recorded Clock Release Domain Contract (Issue #124 Stage K)

- **Status**: Proposed / Bounded Scope (Issue #124 Stage K)
- **Date**: 2026-11-03
- **Deciders**: Gemini (Author/Implementer), Root Technical Direction
- **References**: Issue #124, [ADR 0169](0169-durable-adjudication-domain.md), [ADR 0170](0170-practical-proof-work-slicing.md), [ADR 0171](0171-stopped-turn-clock-accounting-foundation.md), [ADR 0172](0172-playable-stopped-adjudication-completion.md), `packages/game/src/events.ts`, `packages/game/src/adjudication-release.ts`, `packages/game/src/adjudication-completion.ts`, `packages/game/src/prepared-command.ts`, `packages/game/src/adjudication-lifecycle.ts`, `packages/game/src/game.ts`, `packages/game/src/adjudication-proof.ts`, `packages/game/src/index.ts`, `packages/game/test/adjudication-srelease-domain.test.ts`.

## Context

Following the establishment of the pure stopped-turn clock accounting foundation ([ADR 0171](0171-stopped-turn-clock-accounting-foundation.md)) and the playable-stopped adjudication completion domain contract ([ADR 0172](0172-playable-stopped-adjudication-completion.md)), Issue #124 Stage K addresses the domain replay and accounting continuation of recorded adjudication clock release events (`AdjudicationClocksStarted`, denoted $S$) within `@chess-platform/game`.

Under Stage R1 semantics ([ADR 0172](0172-playable-stopped-adjudication-completion.md)), resolving an adjudication leaves the game playable with clocks stopped (`stoppedClock !== null`, `runningSince: null`, `turnStartedAt: null`). However, in a full distributed architecture, the authoritative server subsequently releases clocks at an observed future instant $S \ge R$, recording an `AdjudicationClocksStarted` event in the durable event stream.

Stage K requires establishing the deterministic historical replay and forward-time managed continuation contract under strict domain trust boundaries:
1. **Explicit Trust Boundary**: Deterministic historical replay, mathematical consistency, and domain continuation ONLY. Stage K provides **NO live S producer, NO observation that R was actually committed, NO retained-$T < S$ admission, and NO storage/worker/client/protocol integration or activation**.
2. **Replay-Only Folding Authority**: Reconstructed histories via `Game.fromEvents` and stored historical replay (`Game[FOLD_STORED]`) must accept recorded $S$ events honestly, but ordinary live `Game.prototype.withEvents([S])` has NO authority producer and MUST reject. Furthermore, reconstructing a game from history does not grant persistent replay authority to subsequently append live $S$ events.
3. **Structural S Contract & Standalone Batch Requirement**: $S$ must occupy a standalone append batch (`batch.length === 1`). Committing $R$, effects, and $S$ within a single submitted batch is rejected. Concatenated historical event streams replay as ordinary separate events without invented transactional boundaries.
4. **Distinct Released Accounting Record & Independent Anchors**: Clearing `stoppedClock` must not lose the underlying accounting basis or fallback to legacy wall-clock charging. The domain must transition into a distinct `releasedClock` state that preserves consumed-stop identity, lineage, and separate running anchors for finite chess countdown and pre-first-move no-show forfeit.
5. **Read-Only Retry Inspection & Receipt Ownership**: The domain must expose read-only inspection for release retries, returning immutable receipts for identical proposals, detecting conflicts on altered content, and rejecting new release requests against already-consumed stops.
6. **Strict Forward Causality ($A \ge S$)**: Continuation commands after $S$ cannot backdate prior to the release instant $S$. Backward timestamps $A < S$ are rejected strictly under the active causal floor.
7. **Clean-Code & Modularity Mandates**: All modified and newly authored functions adhere strictly to $\le 4$ parameters, $\le 10$ decision points, $\le 5$ nesting depth, and zero `as any` type bypasses.

## Decision

Implement the recorded clock release domain contract across `@chess-platform/game` with full domain test coverage in `packages/game/test/adjudication-srelease-domain.test.ts` and module extraction in `packages/game/src/adjudication-release.ts`.

### 1. Structural Event Contract (`AdjudicationClocksStartedEvent`)

Defined `AdjudicationClocksStartedEvent` in `packages/game/src/events.ts`:
- `type: 'AdjudicationClocksStarted'`
- `gameId: string`
- `clockPolicy: 'observed-release-v1'`
- `rulesVersion: string`
- `releaseRequestId: string` (non-empty immutable request correlation identity)
- `stopId: string` (exact identifier of the consumed stopped clock completion)
- `originatingOperationId: string`
- `originatingResolvedSeq: number`
- `completionHead: number`
- `expectedHead: number` (must match preceding aggregate `eventSequence`)
- `turnLineageId: string`
- `side: Color` (must match current side to move)
- `ply: number` (must match current game ply)
- `at: number` (injected safe integer epoch millisecond timestamp $S$)

`AdjudicationClocksStarted` is included in the `GameEvent` union, but explicitly excluded from `AdjudicationEffect`, preventing illegal inclusion inside settlement plans.

### 2. Replay-Only Invocation Context & Token Isolation

- **Token**: Defined an unexported module-scoped `REPLAY_TOKEN = Symbol('REPLAY_TOKEN')` in `packages/game/src/game.ts`.
- **History Reconstruction**: `Game.fromEvents` and `Game[FOLD_STORED]` pass `REPLAY_TOKEN` into `Game.reduce`.
- **Live Rejection**: Ordinary `Game.prototype.withEvents([S])` and `Game.prototype.withEvent(S)` pass no token; `Game.reduce` strictly rejects with `GameError: AdjudicationClocksStarted cannot be submitted directly via live Game.withEvents; replay/reconstruction route required`.
- **Reconstructed Instance Isolation**: Instances created via `Game.fromEvents` do NOT store persistent flags; calling `withEvents([S])` on reconstructed instances remains strictly forbidden.
- **Standalone Batch Validation**: `validateAdjudicationAppendBatch` enforces that any batch containing `AdjudicationClocksStarted` has `batch.length === 1` and delegates to pure standalone structural validation (`validateStandaloneRecordedReleaseBatch`) without appending or mutating state.

### 3. Distinct Released Clock State & Independent Running Anchors

Upon folding a recorded $S$ event via `reduceAdjudicationClocksStarted`:
- `stoppedClock` is set to `null`.
- `releasedClock` is populated with `GameReleasedClockState`:
  - `basis: AdjudicationClockBasis` (derived via `releaseClockBasis` if chess applies, or unstarted basis with `runningSince: null` if chess is unstarted)
  - `consumedStopId: string`
  - `originatingOperationId: string`, `originatingResolvedSeq: number`, `startedSeq: number`
  - `turnLineageId: string`, `parentStopId: string | null`, `completionHead: number`
  - `releaseRequestId: string`, `releaseSeq: number`, `releasedAt: number`
  - `isChessApplicable: boolean`
  - `noShowRunningSince: number | null` (independently arms no-show countdown if remainder exists)
- **Applicability Separation & Deadline Calculation**:
  - Direct finite at ply 0: chess clock countdown applies directly from release instant $S$. `game.flagDeadline` evaluates `releasedClock` first, exposing the running chess deadline at ply 0 rather than prematurely masking it behind an unmanaged ply-0 guard.
  - Sourced games pre-first-move: chess clock is UNSTARTED (`runningSince: null`, `isChessApplicable: false`), while no-show countdown runs independently (`noShowRunningSince: S`), avoiding false chess clocks.
  - Unlimited TC: chess never runs, no-show is independent.
  - Tournament with both players ready removes no-show remainder; seek games preserve no-show until the first move; first move clears no-show permanently.
  - If neither chess clock nor no-show is applicable, release is rejected.
  - Pre-fold deadline overflow checks (`assertReleaseDeadlinesValid`) validate that all applicable derived deadlines (both chess flag and no-show forfeit) fit within `MAX_SAFE_TIMESTAMP_MS` before folding $S$ into state, preventing lazy getter exceptions while admitting boundary cases where $S + \text{allowance} = \text{MAX\_SAFE\_TIMESTAMP\_MS}$.
  - Strict rules version lineage matching (`assertReleaseLineageMatch`) requires `event.rulesVersion === stopped.rulesVersion`, preventing metadata drift between in-memory state and the receipt ledger.

### 4. Read-Only Retry Inspection & Receipt Ownership

Implemented in `packages/game/src/adjudication-release.ts`:
- Proposal shape validation (`assertReleaseProposalShape`) rejects non-objects, `null`, arrays, primitives, and malformed field values up-front with domain `GameError`.
- `inspectReleaseRetry(game: Game, proposal: ReleaseProposalParams): ReleaseRetryInspection`:
  - Returns `{ kind: 'existing_match', receipt }` if `releaseRequestId` matches and all immutable properties match.
  - Returns `{ kind: 'conflict', reason }` if `releaseRequestId` matches but any property (including `rulesVersion`) differs.
  - Returns `{ kind: 'consumed_stop', reason }` if `proposal.stopId` was already consumed by a different request ID.
  - Returns `{ kind: 'not_released' }` if the request ID has not been recorded.
- `assertReleaseRetryValid(game: Game, proposal: ReleaseProposalParams): AdjudicationReleaseReceipt` enforces validity or throws descriptive `GameError`.
- Receipts are stored in `state.releaseReceipts` and preserved across subsequent stops, moves, and terminal endings, preventing request ID reuse across the game's lifetime.
- Public getters `game.releaseReceipts`, `game.getReleaseReceipt(id)`, and `game.isStopConsumed(stopId)` return deeply cloned, frozen records.

### 5. Forward-Time Continuation Commands after S

All managed paths adapt to resolve current origin from either `stoppedClock` or `releasedClock`:
- **Policy & Lineage Inheritance**: `resolveCommandPolicy` extracts `parentStopId` and `turnLineageId` from `game.stoppedClock ?? game.releasedClock`.
- **Central Preparation Causal Validation**: `assertPreparationCausalFloor` validates $A \ge S$ (or $A \ge \text{stoppedAt}$) across all preparation APIs (`prepareMove`, `prepareResign`, `prepareDrawOffer`, `prepareDrawAccept`, `prepareDrawDecline`, `prepareAbort`, `prepareReady`, `prepareFlagExpiry`, `prepareNoShowExpiry`, and `prepareAuthoritativeCommand`) before allocating jobs or minting prepared operations, while preserving unmanaged legacy fractional behavior and existing noops.
- **Started Causal Floor**: `getActiveCausalBasis` includes `state.releasedClock?.releasedAt`, independently rejecting continuation commands with $A < S$.
- **Preparation Expiry**: `prepareFlagExpiry` and `assertStartedTimeoutAdmission` verify flag conditions against `releasedClock.basis` using `hasFlaggedAt`.
- **Started Basis Derivation**: `deriveStartedBasis` invokes `freezeReleasedClockBasis(releasedClock, atA, tc)`, freezing active elapsed thinking at instant $A$.
- **Display Balances**: `reduceAdjudicationStarted` updates public `clock.remaining` from the frozen managed basis, ensuring that subsequent resolution at $R$ adds nothing to the charged turn.
- **Move Completion**: Final move applies active elapsed thinking time ($E_A$), adds increment once on successful completion, advances ply, resets opponent thinking time to $E = 0$, and stops clocks.

## Honest Scope and Non-Claims

1. **Replay & Domain Consistency Only**: This implementation delivers historical event folding and in-memory continuation math in `@chess-platform/game`. It does NOT provide a live $S$ producer.
2. **No Committed Observation Claim**: The domain does not attest to or observe whether $R$ was committed to durable storage; persistence layers must independently enforce committed boundaries.
3. **No Retained-$T < S$ Admission**: Backward timestamps prior to $S$ remain strictly forbidden on forward commands.
4. **No Protocol / Network / Worker Activation**: No worker jobs, storage adapters, client sync sockets, or gateway fanouts are activated.
5. **No Universal Production Claim**: Does not claim universal FIDE operational completion, production deployment, or branch merging.
