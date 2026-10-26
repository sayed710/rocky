# Rocky D1-B — Known-gap client recovery audit

Date: 2026-10-26
Role: Gemini 3.8 Flash High / high effort, Sole Code Author for Rocky D1-B.
Scope: Bounded client-side known-gap recovery in `@chess-platform/web`.

## Design decisions and evidence boundaries

1. **Separate target from applied floor:** `targetRevision` and `targetPly` track required recovery
   milestones without advancing `stateRevisionFloor` on unapplied gap frames. `stateRevisionFloor`
   remains strictly monotonic non-decreasing for the immutable game across session and user changes.
2. **Attempt coalescing across flight and backoff:** Multiple gap frames in an episode raise the required target
   without dispatching redundant requests, without resetting backoff delay, and without resetting the attempt budget.
3. **Dispatch attempt accounting and timeout settlement:**
   - Attempt count tracks actual logical dispatches (up to `MAX_GAP_RECOVERY_ATTEMPTS = 3`).
   - Charging occurs strictly at the wire dispatch boundary (`client.send`), after rechecking lifecycle state and target existence following subscriber notifications; unsent listener-cancelled attempts do not consume retained budget.
   - Unsolicited snapshots, intermediate insufficient snapshots, and command rejections do not spend attempt budget.
   - An attempt settles immediately into bounded backoff or exhaustion if client.send returns false
     (charging the logical dispatch); successful sends remain pending until fixed timeout
     (`GAP_RECOVERY_TIMEOUT_MS = 2_000` ms) unless discharged by an accepted sufficient snapshot
     (unrelated command rejects and insufficient snapshots do not settle it; no physical database cancellation claim).
   - Backoff uses `GAP_RECOVERY_BASE_DELAY_MS = 1_000` ms binary exponential delay (`1_000` ms, `2_000` ms).
4. **Quiescence and manual retry:** Upon budget exhaustion, known-gap recovery timers clear, automatic gap
   dispatch ceases (separate heartbeat/reconnect/R03 traffic explicitly outside bound; no periodic freshness
   polling introduced), and `recoveryAvailable: true` is exposed alongside `recovering: true` (retaining durable debt).
   `networkOnline()` provides explicit user-driven retry: if debt remains, it calls `clearGapRecovery()` (`recoveryEpoch++`, cancelling active timers and resetting pending flag), resets `gapRecoveryAttempt = 0`, and dispatches fresh recovery.
5. **Gameplay and UI gating through exhaustion:** `canCommand()` blocks `submitMove()` and `sendAction()`.
   `GameController` gates `myTurn` and action affordances (`canAbort`, `drawOffer`, `canResign`) through exhaustion.
   `game-mount.ts` disables action buttons when `recovering: true`. No move or action is replayed automatically.
6. **Reentrancy, callback fencing, and teardown idempotency:**
   - `stop()` is idempotent (`if (!this.unsubscribe) return;`), preventing mutual recursion from synchronous subscriber notifications.
   - Synchronous listener callbacks are fenced using `recoveryEpoch` and `client.generation` before wire dispatch.
   - Timer and backoff callbacks verify handle ownership (`this.gapRecoveryHandle === myHandle`) and epoch fencing, exiting immediately before any state mutation or handle mutation if ownership or epoch differs.
   - Stale callback safety is verified via boundary scheduler capture tests rather than unbounded pending task drains.
7. **Safe integer validation:** Legacy snapshot discharge requires valid safe non-negative integer ply evidence
   (`Number.isSafeInteger(ply) && ply >= 0`) and structural completeness (moves array, string FEN, non-null status).
8. **Causality boundary:** Server-side intent suppression (`session.resumeReads`) ensures that a newer
   recovery intent suppresses older responses. The synthetic test demonstrates client-side partial progress
   and subsequent recovery exhaustion without claiming unexecuted gateway integration.
9. **Open limitation:** Silent final-publication loss without any subsequent frame or observed gap
   cannot be detected without an explicit reconnect or user gesture.

## Verification, execution history, and boundaries

### Candidate-v1 host verification (executed by coordinator)
- `npm run lint -w @chess-platform/web`: PASSED.
- Full web hermetic suite: 1,635 total, 1,633 passed, 2 failed (exit code 1).
  - Failure 1 (lifecycle): scheduler oracle conflict with `WsClient` reconnect timer on socket drop.
  - Failure 2 (causality): non-seek game authority fixture did not emit `PlayerReady` events.

### Candidate-v1 static reviews
- OpenCode candidate-v1 read-only review: identified 5 critical and 4 important findings (backoff bypass, attempt settlement, reentrancy fencing, malformed legacy ply, turn gate on exhaustion, scheduler oracle, causality setup, project state).
- Pi candidate-v1 read-only review: identified 8 prioritized findings (F1–F8) across patch structure, synchronous listener reentrancy, UI turn/action gating, duplicate gap coalescing, command reject attribution, causality test domain setup, lifecycle scheduler oracle, and presentation convergence evidence.

### Candidate-v3 host verification (executed by coordinator)
- Web lint: PASSED.
- Web test compilation failed before runtime:
  - `packages/web/test/known-gap-recovery.test.ts:446`: Call to non-existent method `ManualScheduler.runAll`.
  - `packages/web/test/known-gap-recovery.test.ts:584`: Passing possibly undefined property `as.recovering` (`boolean | undefined`) to `{ recovering?: boolean }` under `exactOptionalPropertyTypes`.

### Candidate-v4 host verification (executed by coordinator)
- Web test compilation: PASSED.
- Full web hermetic suite: 1,638 total, 1,637 passed, 1 failed, 0 skipped, 0 cancelled (exit code 1).
  - Failure: `known-gap recovery: synchronous listener reentrancy fences stop before continuation sends` failed due to `RangeError: Maximum call stack size exceeded` (synchronous listener called `sync.stop()` on every `state.recovering` update, while `stop()` published `{ connected: false }` with debt still active, causing mutual recursion).

### Historical native author execution status (Candidate-v4 correction)
- Historical Candidate-v4 status: this zero-terminal restriction applied to that V4 phase where Gemini as sole author operated via native file tools only and executed zero terminal commands. Later V6 author reported executing the web test suite (V6 had 1642 pass / 1643 and one fixture failure; not all tests passed), while coordinator retained and independently reran actual verification. Subsequent exact-text integration is current workflow because native tools hit broken hook; no hook/config changes.
- Commands status for this correction run:
  - `npm run build && npm run lint && npm test`: NOT RUN by author (coordinator executes verification on integrated candidate).
  - Git commands (`git status`, `git commit`, `git push`): NOT RUN by author (delegated coordinator workflow).
- Static inspection performed: author reviewed modified source files under zero-terminal constraint (verifying no `as any`, conformance to `exactOptionalPropertyTypes`, handle ownership fencing, wire dispatch boundary accounting, teardown idempotency, and boundary scheduler capture test). Compiler and test suite execution were NOT RUN by the author and remain subject to coordinator verification; static inspection alone cannot establish type correctness or contract adherence guarantees.

## Traceability matrix

| Requirement | Implementation Location | Test Verification |
|---|---|---|
| KG-01: Target separate from floor | `packages/web/src/net/game-sync.ts: targetRevision, targetPly` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: duplicate gap bursts...'` |
| KG-02: Coalescing flight & backoff | `packages/web/src/net/game-sync.ts: triggerGapRecovery()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: duplicate gap bursts...'` |
| KG-03: Bounded budget & timeout settlement | `packages/web/src/net/game-sync.ts: dispatchGapRecovery()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: failure and timeout budget...'`, `'...synchronous stop before wire dispatch preserves full attempt budget...'` |
| KG-04: Full snapshot & legacy ply | `packages/web/src/net/game-sync.ts: isSnapshotSufficient()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: malformed legacy snapshot...'` |
| KG-05: Gating through exhaustion | `packages/web/src/net/game-sync.ts: canCommand(), GameController: myTurn` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: GameController gates...'` |
| KG-06: Reentrancy & lifecycle fencing | `packages/web/src/net/game-sync.ts: recoveryEpoch, clearGapRecovery()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: synchronous listener reentrancy...'`, `'...cancelled timer callback invoked after manual retry...'`, `'...stop, sessionChanged, and socket drop...'` |
| KG-07: R-03 command uncertainty separation | `packages/web/src/net/game-sync.ts: outcomeUnknown, reconcileUncertainty()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: insufficient snapshots and command rejects...'` |
| KG-08: Conservative gap detection | `packages/web/src/net/game-sync.ts: recordGap(), applyMove(), applyEnded()` | `packages/web/test/known-gap-recovery.test.ts: 'known-gap recovery: ready broadcast with revision gap...'` |
| KG-09: Web package scope & no as any | `packages/web/src/net/game-sync.ts, packages/web/src/app/game-controller.ts, packages/web/src/app/game-mount.ts` | Static inspection: web package and docs only, zero protocol/server changes, zero as any |
| KG-10: Accurate documentation & project state | `docs/adr/0163-known-gap-client-recovery.md, docs/PROJECT_STATE.md` | Audit verification & header bump |
| KG-11: Causality & liveness schedule | `packages/web/src/net/game-sync.ts` | `packages/web/test/known-gap-recovery.test.ts: 'synthetic: causality schedule with seek-game readiness...'` |

## Verification Posture & Traceability Note (2026-10-26)

The older traceability table's KG meanings above are historical candidate mappings, NOT the canonical acceptance matrix; the canonical meanings remain the coordinator's unchanged KG01-KG11 manifest, and a corrected independently attributable final matrix is still required.

- V9 corrected retry availability, snapshot validation and notification fencing, actual mounted input/premove clearing.
- Coordinator executed 1648 web tests successfully before the validation refactor, and production lint passed after refactor.
- Pi performed an actual frozen production-only review and found no new actionable production findings; this is not full candidate acceptance.
- Later boundary test candidate remains unaccepted with compilation and fixture defects under correction.
- OpenCode's attempted further review hit provider usage quota; final all-scope review remains pending.
- No commit, push, new PR, Qodo/Graphite acceptance, merge or deployment. Silent unseen final-publication loss remains open.
- A concise truthful progress record is sufficient; final evidence will be appended only when verified.
- Current verification (2026-10-26): All 10-file bounded candidate achieved root build and lint exit 0; root `npm test` SUCCESS across all 19 hermetic workspaces with zero skips (web 1652/1652 pass, zero fails/skips; offline browser 232/232 pass, zero skips under isolated 1 worker).
- ADR claim guard passed for 164 ADRs. Topology guard inventoried 542 test files across 21 suites; CI parity and variant parity passed. Exact authority snapshot comparison and real regressions executed: send=false, malformed payloads, same-game positive floor, account, R03, and mounted input / premove clearing.
- Current boundary compilation blocker is resolved; older failure entries remain historical.
- Native separate read-only full-scope review found no remaining actionable production or test defects, requesting four documentation accuracy corrections only; these are currently being integrated with narrow doc review pending.
- Review status: Actual Pi V9 production-only review found no new findings; prior Pi and OpenCode V8 reviews were rejections, not final acceptance. Requested additional CLI review was quota-blocked; no fallback is represented as Pi/OpenCode, and neither quota reset nor final CLI result is claimed.
- Full backend browser was not run due to lean environment command denial; no Graphite settings inspection or clearance performed.
- Remaining gates: No commit, push, PR, CI run, Qodo/Graphite published head acceptance, merge, or deploy yet. Overall D1 is not closed and silent unseen final-publication loss remains open; all-project production readiness is not claimed. Narrow local handoff awaits doc review and owner-only merge.
