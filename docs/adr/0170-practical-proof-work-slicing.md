# ADR 0170: Practical Proof Work Slicing and Worker-Local Controller (Issue #124 Stage 2)

- **Status**: Proposed / Pure Proof & Local Controller Stage (Bounded Stage 2 of Issue #124)
- **Date**: 2026-11-02
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **Consulted**: Pi (`work/pi124e-witness-practical-review/final.txt`, `work/pi124e-candidate2-capability-review/final.txt`), OpenCode (`work/opencode124-integration-contract-coherence/final.txt`, `work/opencode124e-candidate2-work-review/final.txt`), Root Architecture (`outputs/issue124-witness-first-design.md`, `outputs/issue124e-candidate2-stopped-review.md`).
- **References**: Issue #124, [ADR 0169](0169-durable-adjudication-domain.md), [ADR 0168](0168-general-unwinnability-analysis-prototype.md), `packages/chess-core/src/witness-search.ts`, `packages/chess-core/src/cooperative-search.ts`, `packages/game/src/adjudication-requirements.ts`, `packages/game/src/adjudication-controller.ts`, `packages/game/src/adjudication-proof.ts`, `packages/game/src/adjudication-lifecycle.ts`.

## Context

Following the establishment of the durable adjudication domain lifecycle in `@chess-platform/game` ([ADR 0169](0169-durable-adjudication-domain.md)) and the exact unwinnability prototype in `@chess-platform/core` ([ADR 0168](0168-general-unwinnability-analysis-prototype.md)), Issue #124 required practical proof work-slicing and a strictly private evidence ownership model.

Reviews of earlier prototypes identified critical boundary defects:
1. **Unchecked Negative Mint Surface**: Exporting direct-module negative minting functions accepting provenance strings allowed callers to forge registered deadness or timeout impossibility on live winnable games.
2. **Hidden Batch Work and Inaccurate Counters**: Nominally small work budgets hid bulk move generation/scoring, zero-debit backtracks, whole-path reversals, and synchronous whole-witness replays during controller minting. Counters added cumulative snapshots repeatedly, and `scoringWork` was never updated.
3. **Cross-Job Starvation**: `stepAll(1)` repeatedly allocated work to the first active Map entry, starving subsequent unresolved jobs indefinitely.
4. **Context Aliasing and Premature Ready**: Unauthenticated, mutable repetition contexts allowed post-admission mutations to alter required roles; terminal-root creation operations advertised `ready` without settlement evidence bundles, crashing on settlement.
5. **Incomplete Canonical Verification**: Move verification checked only `from`, `to`, `piece`, and `promotion`, permitting tampered `captured`, `drop`, `castleRook`, or `flags` metadata to pass.

## Decision

Implement practical, interruptible 7-phase proof work-slicing in `@chess-platform/core` and private registry-owned authority in `@chess-platform/game`.

### 1. Private Mint Authority in Registry Lexical Module (`adjudication-proof.ts`)

- **Strict Boundary**: All minting authority resides exclusively within the private WeakMap registry module (`packages/game/src/adjudication-proof.ts`).
- **No Exported Unchecked Importers**: Functions accepting provenance strings (`mintVerifiedExactDeadHandle`, `mintVerifiedTimeoutImpossibleHandle`) and unverified helpers are not exported from ANY module. Barrel exclusion is recognized as insufficient; direct module imports are fully closed.
- **Controller Lexical Colocation**: `AdjudicationJobController` is defined within `adjudication-proof.ts` (re-exported by `adjudication-controller.ts`). Its minting methods (`#mintVerifiedWinnable`, `#mintVerifiedDead`, etc.) and internal session states are JavaScript `#private`. Outside callers cannot obtain the genuine registry callback.
- **Deeply Detached Views**: `getJob()` returns deeply frozen, defensive plain objects without live session references or mint methods. Literal, spread-cloned, JSON-serialized, and cross-operation handles strictly fail registry lookup in `getRegisteredEvidence()`.

### 2. Retained Search Machine & Incremental Ordering (`CooperativeWitnessSession`)

In `packages/chess-core/src/witness-search.ts`, search advances through explicit, individually debited phases:
1. **Prepare**: Debits 1 work unit to perform legal move generation for a frame; increments `legalGenerations`. Frame transitions to `scoring` phase.
2. **Score/order**: Retains a scoring cursor (`scoringIndex`), comparison insertion cursor (`insertCompareIndex`), a bounded 1-item-per-unit shifting cursor (`shiftWriteIndex > insertTargetIndex`), and incremental candidate selection cursor (`selectionIndex`). Debits 1 unit per candidate evaluated (`scoringWork++`, `candidateEvaluations++`), 1 unit per insertion comparison (`scoringWork++`), and 1 unit per rightward shift step (`scoringWork++`). Transitions to `selecting` where chosen candidate moves are frozen and transferred one move per charged step into `top.candidates`, avoiding `list.splice`, whole-array scans, or synchronous `map` passes behind a single unit. Transitions to `exploring` phase.
3. **Explore**: Debits 1 unit per candidate applied; increments `candidatesApplied`. Checks terminal checkmate, path-local cycle rejection, and attempt bounds. Pushes child frame.
4. **Backtrack / Attempt Transition**: Debits 1 unit per popped frame (`backtrackSteps++`) and 1 unit per attempt transition (`attemptsCompleted++`, `attemptsStarted++`). Zero-cost loops across frames and attempts are eliminated.
5. **Reconstruct**: When terminal checkmate is found, an indexed destination array of known length (`stackIndex + 1`) is allocated. Moves are written directly backward into `destination[writeIndex]` one pre-frozen move per charged step (`writeIndex--`), completely eliminating `unshift` and whole-path shifting. Mathematical paths are preserved; paths exceeding `MAX_WITNESS_LENGTH = 500` return pending `resource_limit` without claiming impossibility.
6. **Verify**: Retains an incremental verification cursor (`activeVerification`). Debits 1 unit per ply (`replayWork++`). Compares ALL canonical `Move` fields (`from`, `to`, `piece`, `captured`, `promotion`, `drop`, `castleRook`, `flags`) via `isCanonicalMoveMatch()`. Pre-frozen candidate witness is verified without redundant full-path mapping.
7. **Publish & Rotate**: Finalized results are top-level deeply frozen once upon discovery. Repeated `getStatus()` and `resume(0)` calls return the cached immutable result directly with zero work and zero copies, while caller inputs remain isolated and unfrozen. Controller tracks delta counters per slice and uses worker-local round-robin scheduling across admitted active jobs (`#jobCursor`) to service all active jobs fairly without starvation.

**Rejected ordering candidate**: a generic color-aware loser pawn-shield reduction ordering hint was tried as one measured candidate and rejected after independent paired measurement. Root-measured paired benchmark (same 376 queries, 3 modes, 2 budgets) REJECTED it: at 2500 work finder 55 vs 55 (2 gained/2 lost), composed 105 vs 105, exact 110 unchanged; at 10000 work finder 108 vs 109 (8 gained/7 lost) but opening directional success 1 to 0, composed 155 to 153 (2 gained/4 lost), opening 3 unchanged, exact 143 unchanged; required c2c4 controller work rose substantially. It was therefore removed and the accepted C9 core restored byte-exact; no weight tuning, schedule change, or alternate heuristic was attempted, and no 100k secondary measurement was run. Baseline practical coverage remains incomplete (ordinary-opening finder success is still low), with no activation or ordinary-opening success claim.

### 3. Exact-Lane Work Slicing (`CooperativeSearchSession.resumeWork`)

In `packages/chess-core/src/cooperative-search.ts`:
- Preserves legacy `resume(stepBudget: number)` node-expansion contract and detached mutable output behavior unchanged via `cloneWinnabilityResult()`.
- Adds `resumeWork(workBudget: number)` debiting leaf material checks, legal generation, edge transitions, and incremental parent-cursor reconstruction.
- Records exact graph distance (`depth: number`) in `VisitedRecord`. When checkmate is found, an indexed destination array of length `parentRecord.depth + 1` is pre-allocated; parent moves are written directly into `destination[writeIndex]` in forward order without `path.reverse()`.
- Top-level freezes all cached finalized outcomes (reachable, impossible, cancelled, unsupported admission, resource limit) and returns the cached instance directly in `resumeWork` and `getStatus`, ensuring repeat reads or zero-budget resumes perform zero graph work and zero allocations while protecting against status mutation. Session references on pending results remain shallowly unfrozen for capacity recovery.
- Mathematical exact reachability in core preserves paths > 500 moves; controller enforces transport boundaries honestly.

### 4. Context Ownership, Timeout Representability, Domain Completion & Terminal Settlement

In `packages/game/src/adjudication-proof.ts`:
- **Context Binding**: Validates supplied `Game` against complete prepared operation identity (gameId, variant, base FEN, base revision, rulesVersion, acceptance time, and deep intent match). Rejects altered rulesVersion, acceptance time, or intent under matching pending IDs; supports matching pre-Started or matching pending-operation games. Reconstructs owned repetition data directly from the validated `Game`; unauthenticated caller repetition maps without a genuine `Game` are strictly rejected.
- **Retained Domain Completion Cursor**: Replaces whole-path synchronous UCI conversion with a private retained completion cursor (`DomainCompletionCursor`). Debits work unit-by-unit before each 8-field move match, legal apply, and UCI conversion, followed by 1 work unit for terminal checkmate verification before minting genuine handles.
- **Accurate Work Ledger & Role Caching**: Tracks `exactWork` separately from `generationWork`, accounts domain completion separately as `completionWork`, and accounts timeout finder deltas into `generationWork`, `scoringWork`, and `replayWork`. Caches `requiredRoles` across 1-unit ticks while `baseOutcome` is unchanged. Constructor preflight, duplicate checks, and settlement verification remain bounded domain operations accounted outside the search work ledger.
- **Idempotent Job Creation**: Duplicate identical `createJob` submissions preserve active progress, execution counters, and handle associations without capacity refusal; conflicting operations under the same `operationId` throw `GameError`.
- **Oversized Candidate Lane Retirement**: Exact or finder candidates exceeding `MAX_WITNESS_LENGTH = 500` retire that specific search lane without terminating the entire job as `resource_limit`, keeping alternative runnable lanes eligible.
- **Terminal Root Evidence Honesty**: Non-checkmate terminal roots (e.g. fifty-move draws) mint genuine process-local `terminal_authorization` handles, settling cleanly with honestly empty recorded evidence (`evidence: {}`) rather than fabricating mathematical deadness (`base.status: 'dead'`).
- **Terminal-Root Creation Readiness**: Creation operations on terminal roots (checkmate or terminal draws) immediately mint verified authorization handles, populate `#jobHandles`, and advertise `ready`. `settleJob()` settles the terminal game cleanly without relaxing the accepted Stage 1 empty bundle guard.
- **Final Controller Job Settlement Binding**: `settleJob` strictly validates the owned `job.prepared` against the game's actual pending adjudication via `assertGameMatchesJobPrepared`, checking game ID, head eventSequence, base FEN, and deep prepared equality (rulesVersion, timestamp `at`, and intent) before consumption. Rejection leaves the original job in `'ready'` status and genuinely usable to settle the matching game.

### 5. Publication Array Integrity Qualification

- Redundant outer array copy removed from `#finishCompletion`, relying on a single necessary bounded private publication copy and array integrity seal (`Object.freeze([...outcome.witnessUci])`) inside lexical `mintHandle` (`deepFreezeOutcome`) outside the enforced search ledger: $O(\text{actual admitted UCI length}) \le 500$.
- Setup and constructor preflight, duplicate checks, and final recorded settlement replay (`verifyUciWitnessReplay` in `settlePrepared`) are explicitly qualified outside the search unit ledger without all-operations, hard-ms, or zero-initial-allocation claims.
- Native `Object.freeze(candidate)` is executed as an integrity seal on the admitted published witness array upon search completion in core.
- Length validation (`candidate.length <= maxWitness`) occurs BEFORE sealing: candidates exceeding the configured limit are rejected without freezing, leaving candidate arrays unsealed and search free to explore alternatives.
- Root explicit decision recognizes this publication freeze is outside the incremental search unit ledger with $O(\text{actual admitted length})$ integrity work, bounded by the configured `maxWitnessLength` ($\le 500$) in finder search, and by `parentRecord.depth + 1` in exact search (the discovered state chain length, uncapped by 500).
- Per-move clone and element freeze operations are charged 1 work unit per move during reconstruction.
- Repeated reads (`getStatus()`, `resume(0)`, `resumeWork(0)`) are zero-copy, returning the cached immutable result directly without repeating integrity work or allocations.

### 6. Clean Code & Architectural Invariants

Every changed or newly authored production function strictly adheres to:
- Parameter count <= 4 (100% compliance).
- Cyclomatic decision complexity <= 10 (100% compliance).
- Maximum block nesting <= 5 (100% compliance).
- Advisory length <= 20 lines.
- Zero `as any` type assertions.

## Status & Explicit Held Next Stages

- **Completed & Verified Locally**:
  - `@chess-platform/core`: 301/301 unit and contract tests passing (including 20 `witness-search` tests and 30 `cooperative-search` tests).
  - `@chess-platform/game`: 184/184 unit and contract tests passing (including 20 `adjudication-controller` tests).
  - Full TypeScript compilation and lint clean across `@chess-platform/core` and `@chess-platform/game` (`tsc -p tsconfig.json --noEmit` exit 0).
  - Clean code verified across all new/changed production functions with 0 hard violations (parameters <= 4, decision complexity <= 10, nesting <= 5, zero `as any`).
- **Explicitly Held & Pending**:
  - Production database migrations / SQL triggers (PG-F1/F2 remain untouched).
  - Long-running background worker scheduling / Redis/Postgres lease queuing.
  - Live authority WebSocket streaming and client presentation.
  - Universal FIDE completeness claims or live production activation.
