# ADR 0171: Pure Stopped-Turn Clock Accounting Foundation (Issue #124 Stage 124f)

- **Status**: Proposed / Pure Foundation (Bounded Scope for Issue #124 Stage 124f)
- **Date**: 2026-11-02
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **References**: Issue #124, [ADR 0170](0170-practical-proof-work-slicing.md), [ADR 0169](0169-durable-adjudication-domain.md), `packages/game/src/adjudication-clock-accounting.ts`, `packages/game/test/adjudication-clock-accounting.test.ts`, `packages/game/src/clock.ts`, `packages/game/src/index.ts`.

## Context

Following the establishment of the durable adjudication domain lifecycle ([ADR 0169](0169-durable-adjudication-domain.md)) and practical proof slicing ([ADR 0170](0170-practical-proof-work-slicing.md)), Issue #124 requires explicit mathematical accounting for chess clocks during and after adjudication stops.

Under accepted legacy mechanics, adjudication completion at instant $R$ resumed the active chess clock immediately. For future non-terminal adjudication release ($S$) and held-move commands admitted while stopped, several mathematical boundary requirements were established:
1. **Pre-Turn Base Preservation vs Double-Debiting**: Subtracting cumulative elapsed active thinking $E$ from an already-frozen balance double-charges thinking time, whereas calculating thinking solely from release instant $T - S$ refunds pre-stop thinking. Clocks must retain immutable pre-turn balances $B$ and cumulative active thinking $E$.
2. **Delay and Increment Isolation**: Bronstein/US delay $D$ applies solely to `delay` time control kinds and must not be refreshed across repeated stops and releases within the same turn. Increment applies solely to `increment` time control kinds and only when the mover's post-charge balance is strictly positive; an exhausted balance ($\le 0$) flags, clamps to 0, and is never resurrected by increment.
3. **Narrow Retained-$T$ Authorization**: Commands admitted during suspension or in near-instant $T < S$ release races must not introduce broad backward-time permission. Backward timestamps $T < S$ must be strictly rejected unless bound to an authenticated matching same-lineage stop authorization.
4. **Independent No-Show Deadlines**: No-show forfeit countdowns are independent of chess clocks (including unlimited chess). Suspensions do not debit no-show remainder; moves completed while running debit actual running elapsed time from the remainder. Release establishes deadline $S + \text{remainder}$, zero remainder stays due, and absent remainder stays absent.
5. **No Legacy Bridge Representation**: Legacy `ClockState` cannot represent cumulative active thinking $E$ and consumed delay $D$ without context or negative anchors. Attempting to bridge displayed balances into legacy `ClockState` causes double-debiting on subsequent charges; snapshot needs are served by `getClockAccountingSnapshot`.
6. **Time Causality**: Transitions must retain observation bounds (`stoppedAt`) so subsequent releases cannot precede the last suspension or move completion.
7. **Durable Separation**: Pure accounting functions calculate deterministic state transitions but do not prove durable execution or committed persistence observations.

## Decision

Implement `packages/game/src/adjudication-clock-accounting.ts` as a pure, dependency-free domain accounting module in `@chess-platform/game`, with full unit test coverage in `packages/game/test/adjudication-clock-accounting.test.ts` and minimal package export in `packages/game/src/index.ts`.

### 1. Retained Turn Accounting Basis (`AdjudicationClockBasis`)

- Models immutable pre-turn balances `turnBaseBalances: { readonly w: number; readonly b: number }`.
- Models cumulative active thinking `elapsedThinkingMs: number`, excluding stopped intervals.
- Retains turn and ply identity (`sideToMove: Color`, `ply: number`).
- Tracks running anchor `runningSince: number | null` (`null` when stopped at $R$ or unstarted; timestamp $S$ after release).
- Enforces time causality via `stoppedAt: number | null`, preventing releases, queries, or moves from preceding previous stops, move completions, or anchorless releases.
- Retains stop lineage metadata (`stopId`, `originatingCompletionId`, `policy`).
- Retains independent `noShowRemainderMs: number | null`.
- Deep ownership: all nested balance structures are cloned and frozen on construction and query; caller objects are never mutated. All time parameters are injected; no `Date.now()` or global callbacks exist.

### 2. Pure Mathematical Accounting Rules

- **Stopped Balance**: $\max(0, B_{\text{mover}} - \max(0, E - D))$. Opponent balance is unchanged.
- **Active Thinking after Release $S$**:
  - For $T \ge S$, elapsed active delta is $T - S$; total active thinking is $E + (T - S)$.
  - For $T < S$, ordinary backward time is strictly rejected with `GameError`. Narrow authorization (`RetainedTimestampAuthorization`) permits $T < S$ only when matching the exact active `stopId` and retained timestamp, contributing 0 active elapsed time.
- **Remaining Delay**: $\max(0, D - E_{\text{total}})$. Delay $D$ applies solely when `tc.kind === 'delay'`. Because cumulative $E$ is retained across repeated pauses, remaining delay never refreshes across multiple stops or releases within the same turn.
- **Strict Zero Exhaustion and Flagging**: If post-charge balance $B_{\text{mover}} - \max(0, E_{\text{total}} - D) \le 0$, the mover has flagged, the balance is clamped to 0, and increment is never added.
- **Flag Deadline Predicate Parity**: Returns $S$ if the mover balance is already exhausted at turn start ($B_{\text{mover}} \le 0$), maintaining `hasFlaggedAt(now) === (now >= flagDeadline)` for all $now \ge S$.
- **Completed Move Transformation (`applyCompletedTurn`)**: Charges mover once, applies increment once (if strictly positive and increment kind), advances ply, resets opponent active thinking to $E = 0$, sets `runningSince = null`, sets `stoppedAt = now`, preserves managed `policy`, debits running elapsed time from `noShowRemainderMs` (both limited and unlimited), and outputs `moveTimeMs` equal to total active thinking.
- **Unlimited Time Controls**: Unlimited controls have no running chess anchor, charge 0, and never flag; independent no-show deadlines still debit running elapsed time and expire at $S + \text{remainder}$. Anchorless releases (unlimited without no-show obligations) preserve release instant $S$ in `stoppedAt` as an immutable causal floor, preventing backward time queries and transitions without charging stopped time.
- **Independent No-Show Deadlines**: Evaluates $S + \text{noShowRemainderMs}$. `isNoShowDueAt` enforces temporal admissibility matching `getClockAccountingSnapshot`. While stopped, remainder is preserved without charge. Zero remainder expires at $S$; absent remainder yields `null`. Unlimited chess without no-show obligations never gains a running anchor.

### 3. Numeric Guardrails and Arithmetic Overflow Protection

- All exported functions validate basis, time control kinds/fields, and `now` timestamp parameters BEFORE checking stopped or unlimited status.
- All integer inputs (timestamps, balances, elapsed thinking, plies, remainders) are validated as safe non-negative integers $\le \text{MAX_SAFE_TIMESTAMP_MS}$ ($8{,}640{,}000{,}000{,}000{,}000$).
- All derived additions ($E + \Delta$, $B_{\text{mover}} + \text{increment}$, $\text{ply} + 1$, $S + \text{noShowRemainderMs}$, and total allowance $D + B_{\text{mover}}$) explicitly check for arithmetic overflow and reject invalid sums with `GameError`.
- Clean code guard compliance: all 20+ production functions strictly maintain $\le 4$ parameters, cyclomatic complexity $\le 7 \le 10$, nesting depth $\le 2 \le 5$, and zero `as any` casts.

## Honest Scope and Non-Claims

1. **Pure Foundation Only**: This implementation delivers only the pure domain calculation module. It does NOT implement playable-stopped completion $R$, release $S$ domain lifecycle events, client rollout, or database persistence.
2. **Legacy Contract Invariance**: Existing legacy $R$-based clock resume behaviors in `packages/game/src/clock.ts` and `packages/game/src/game.ts` remain unchanged.
3. **No Activation**: No production deployment, cluster activation, worker scheduling, or PR merge is authorized or claimed.
