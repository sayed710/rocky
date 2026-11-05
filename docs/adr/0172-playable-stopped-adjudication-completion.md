# ADR 0172: Playable-Stopped Adjudication Completion Domain Contract (Issue #124 Stage R1)

- **Status**: Proposed / Bounded Scope (Issue #124 Stage R1)
- **Date**: 2026-11-03
- **Deciders**: Gemini (Author/Implementer), Root Technical Direction
- **References**: Issue #124, [ADR 0169](0169-durable-adjudication-domain.md), [ADR 0170](0170-practical-proof-work-slicing.md), [ADR 0171](0171-stopped-turn-clock-accounting-foundation.md), `packages/game/src/events.ts`, `packages/game/src/adjudication-completion.ts`, `packages/game/src/prepared-command.ts`, `packages/game/src/adjudication-lifecycle.ts`, `packages/game/src/game.ts`, `packages/game/src/adjudication-proof.ts`, `packages/game/src/stored-history.ts`, `packages/game/test/adjudication-release-domain.test.ts`.

## Context

Following the establishment of the pure stopped-turn clock accounting foundation ([ADR 0171](0171-stopped-turn-clock-accounting-foundation.md)), Issue #124 Stage R1 addresses the domain lifecycle integration of stopped adjudication completion within `@chess-platform/game`.

Under accepted legacy adjudication semantics ([ADR 0169](0169-durable-adjudication-domain.md)), resolving an adjudication immediately resumed clocks via `projectSurvivingObligations` or left unmanaged games exposed to direct command execution. However, for managed adjudication lifecycles under Issue #124, non-terminal adjudication completion at instant $R$ must leave the game playable with clocks stopped (`runningSince: null`, `turnStartedAt: null`), while allowing subsequent legal prepared commands to be admitted and executed without unfreezing clocks until an explicit future release ($S$).

Furthermore, the integration requires solving several strict boundary and integrity requirements:
1. **Explicit Policy Marker**: Games opting into managed adjudication clock accounting must be distinguished from legacy games via an explicit policy marker (`clockPolicy: 'observed-release-v1'`). Legacy games without this marker must preserve exact unmanaged and historical clock behaviors.
2. **Deterministic Completion Descriptor**: When an adjudication resolves, the `AdjudicationResolvedEvent` must carry an immutable, verifiable `clockCompletion` descriptor specifying whether the resolution resulted in a stopped or terminal clock state, linking originating operation sequence numbers, parent stop lineage, and completion head.
3. **Unified Completion Finalizer**: State transitions across all completion exits (zero-effect resolution, final move completion, final non-move settlement, and terminal game over) must route through a single authoritative finalizer that enforces consistent board state, clock state, and release obligations.
4. **Integer-Only Policy Admission vs Legacy Fractional Parity**: The foundation accounting module is strictly integer-safe ([ADR 0171](0171-stopped-turn-clock-accounting-foundation.md)). Preparation and admission under `observed-release-v1` must strictly reject fractional time controls, balances, or remainders BEFORE `AdjudicationStarted`, while legacy fractional balances and time controls continue to function without alteration when the policy marker is absent.
5. **Idle and Stopped Raw Bypass Defense**: Games with managed clock policies must be strictly guarded against raw/direct method mutations (`playMove`, `resign`, `offerDraw`, `markReady`, etc.) and raw event playback (`MovePlayed`, control events) in both ordinary and stored history (`FOLD_STORED`) paths, closing bypass vectors while preserving the narrow pre-#127 legacy stored exception.
6. **Deep Immutability & Ownership**: All stopped clock states and completion descriptors exposed through public snapshots (`clockAccountingSnapshot()`) must be deeply owned and frozen to prevent external tampering or cache pollution.

## Decision

Implement the Stage R1 domain contract across `@chess-platform/game` with full test coverage in `packages/game/test/adjudication-release-domain.test.ts` and helper extraction in `packages/game/src/adjudication-completion.ts`.

### 1. Explicit Policy Marker & Preparation Governance

- **Marker**: Defined `AdjudicationClockPolicy = 'observed-release-v1'` in `packages/game/src/events.ts`.
- **Preparation Admission**: `PreparedOperation` and preparation parameter interfaces accept an optional `clockPolicy`. When present, `clockPolicy` must strictly equal `'observed-release-v1'`; `null`, unknown strings, or policy downgrades are rejected with `GameError`.
- **Inheritance & Immutability**: If a game already has `clockPolicy === 'observed-release-v1'`, all subsequent preparations inherit the policy. Callers cannot strip or modify the active policy.
- **Integer Validation**: Before `AdjudicationStarted`, `validateIntegerPolicyInputs` verifies that time controls, balances, and remainders are non-negative safe integers. Fractional inputs (e.g., `1000.5`, `inc: 0.25`) are rejected with `GameError`. Legacy histories without policy bypass this validation, preserving full backward compatibility.

### 2. Deterministic Clock Completion Descriptor

- `AdjudicationResolvedEvent` includes an optional `clockCompletion?: AdjudicationClockCompletionDescriptor`.
- **Stopped Descriptor (`AdjudicationClockStoppedDescriptor`)**:
  - `policy: 'observed-release-v1'`
  - `kind: 'stopped'`
  - `stopId: string` (derived deterministically as `stop:${operationId}:${resolvedSeq}`)
  - `originatingOperationId: string`
  - `startedSeq: number` and `resolvedSeq: number`
  - `completionHead: number` (matching declared effect count)
  - `resultingSideToMove: Color` and `resultingPly: number`
  - `turnLineageId: string`
  - `parentStopId: string | null`
  - `runningSince: null`
- **Terminal Descriptor (`AdjudicationClockTerminalDescriptor`)**:
  - `policy: 'observed-release-v1'`
  - `kind: 'terminal'`
  - `originatingOperationId: string`
  - `startedSeq: number` and `resolvedSeq: number`
  - `completionHead: number`
  - `runningSince: null`
- **Plan Verification**: In `adjudication-lifecycle.ts`, `deriveResolutionPlan` constructs the expected descriptor deterministically from genuine planning evidence, and `validateRecordedResolution` asserts exact equality. Caller-supplied or forged descriptors are strictly rejected.

### 3. Unified Completion Finalizer across 4 Exits

Implemented `finalizeCompletion` in `packages/game/src/game.ts` covering all four completion pathways:
1. **Exit 1 (Zero Effects)**: Adjudication completes with empty effects. Retains prior board state, preserves turn lineage, freezes clock basis if unpaused, sets `stoppedClock`, and computes `releaseNeeded` based on whether active countdowns exist (`isChessClockApplicable(source, ply, tc) || noShowRemainderMs !== null`).
2. **Exit 2 (Final Move)**: Adjudication applies a legal move (`foldMove`). Charges mover's active thinking time up to admission instant $A$, adds increment once (if positive and increment kind), advances ply, resets next mover's active thinking to $E = 0$, sets `runningSince = null`, sets `turnStartedAt = null`, updates `stoppedClock`, and sets `releaseNeeded` based on clock countdown applicability.
3. **Exit 3 (Final Non-Move)**: Adjudication completes intermediate non-move effects (e.g. readiness changes, draw offers). Advances board and game status while keeping clocks stopped and setting `releaseNeeded` per countdown applicability.
4. **Exit 4 (Terminal Ending)**: Adjudication resolves into a game-ending condition (`reduceGameEnded`). Sets `phase = 'ended'`, clears `stoppedClock = null`, clears `releaseNeeded = false`, and attaches a terminal descriptor.

Before the final effect is applied, intermediate effects remain settling, blocked, and anchorless; `Move + GameEnded` prefixes never leave the game playable.

### 4. Idle and Stopped Raw Bypass Defense

- On managed games (`state.clockPolicy === 'observed-release-v1'`), raw mutation methods (`playMove`, `move`, `resign`, `offerDraw`, `acceptDraw`, `declineDraw`, `abort`, `markReady`) are rejected via `assertLifecyclePreconditions`.
- Raw `MovePlayed` and unmanaged control events arriving via ordinary command application or stored history (`FOLD_STORED`) are rejected when the game has an active clock policy.
- The pre-#127 atomic event replay exception (`admitPre127Atomic` in `stored-history.ts`) is explicitly guarded with `state.clockPolicy === null`, ensuring it applies exclusively to legacy pre-127 histories.

### 5. Deep Immutability, Deadlines & Static Retained Exhaustion

- Internal stopped clock basis (`GameStoppedClockState`) and public snapshots (`clockAccountingSnapshot()`) return deeply cloned, frozen records.
- Deadlines: `flagDeadline` returns `null` while stopped per F/R1 contract, preventing fake running deadlines or anchors. `noShowDeadline` and `timeoutDue` evaluate static eligibility without new active accrual.
- Static Retained Exhaustion: Aligned across preparation (`prepareFlagExpiry`), Started admission (`assertStartedMoveAdmission` and `assertStartedTimeoutAdmission`), and authoritative command arbitration (`prepareAuthoritativeCommand`). Already-exhausted managed turns reject move admission and cannot advance the board even with a valid proof job; direct finite clocks at ply 0 correctly prioritize static flag expiry over resignation while unstarted sourced countdowns and legacy unmarked games preserve their respective exemptions. Positive stopped balances never accrue new flags while stopped.

## Honest Scope and Non-Claims

1. **Domain Lifecycle Contract Only**: This implementation completes the in-memory domain lifecycle in `@chess-platform/game`. It does NOT implement the future release event ($S$), client clock sync, or database persistence.
2. **No Generic Backward Time**: Backward timestamps $T < S$ remain forbidden without explicit authorization from matching same-lineage stops.
3. **No S Event**: No `AdjudicationReleasedEvent` or $S$-event handling is introduced in this stage.
4. **No Universal FIDE Claim**: Does not claim universal FIDE operational completion.
5. **No Production Activation**: No production deployment, cluster activation, worker scheduling, or PR merge is authorized or claimed.
