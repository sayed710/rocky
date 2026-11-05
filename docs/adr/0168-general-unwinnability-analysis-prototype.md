# ADR 0168: General Unwinnability Analysis and Cooperative Helpmate Search Prototype

- **Status**: Proposed / Prototype (Isolated Development Slice toward Issue #124)
- **Date**: 2026-11-01
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **Consulted**: Pi (independent algorithm cross-review and draft inspection); Miguel Ambrona (cited research author, not a consulted human in this session)
- **References**: Issue #124, [ADR 0167](0167-frozen-kp-dead-position-adjudication.md), [ADR 0166](0166-dead-position-compatibility-preparation.md), `packages/chess-core/src/unwinnability-types.ts`, `packages/chess-core/src/proof-admission.ts`, `packages/chess-core/src/mobility.ts`, `packages/chess-core/src/semi-static.ts`, `packages/chess-core/src/cooperative-search.ts`, `packages/chess-core/src/unwinnability.ts`, `packages/chess-core/src/index.ts`, `packages/chess-core/src/dead-position.ts`, `packages/chess-core/src/position.ts`, `packages/chess-core/test/proof-admission.test.ts`, `packages/chess-core/test/mobility.test.ts`, `packages/chess-core/test/semi-static.test.ts`, `packages/chess-core/test/cooperative-search.test.ts`, `packages/chess-core/test/unwinnability.test.ts`

## Context

FIDE Article 5.2.2 establishes that a game is drawn when a position is reached from which checkmate cannot occur by any possible series of legal moves (a dead position). ADR 0167 implemented an initial bounded sufficient certificate for frozen King and Pawn positions (`isFrozenDeadPosition`), leaving broader dead-position classes (bishops behind locked walls, movable-but-futile pawns, and forced transitions) unresolved.

The platform owner directed an isolated development slice toward the complete Issue #124 goal: a general paper-traceable unwinnability proof engine and resumable exact cooperative graph analysis, kept strictly isolated from live adjudication until measured, reviewed, and authorized.

Independent algorithm cross-review by Pi (`work/pi124-primary-algorithm-crossreview/final.txt`), early-draft audit (`work/pi124c-draft-proof-review/final.txt`), and root direction established the requirements for proof integrity, mathematical domain boundaries, and allowance accounting. The foundational mathematical basis is Miguel Ambrona's published research:
> Published conference article: Miguel Ambrona, "A Practical Algorithm for Chess Unwinnability", *11th International Conference on Fun with Algorithms (FUN 2022)*, LIPIcs Vol. 226, pp. 2:1–2:20, DOI: [10.4230/LIPIcs.FUN.2022.2](https://doi.org/10.4230/LIPIcs.FUN.2022.2).
> Verified author full 25-page version: [https://chasolver.org/FUN22-full.pdf](https://chasolver.org/FUN22-full.pdf) (pinned SHA256: `502eebe3bfd5892de47c6bb8debdd5e75a6387856bb0d74e8052b3bd9ddbdf8d`).
> Upstream reference implementation: `chasolver` commit `3484c7e65247003fac8705a9290dc2b5d0978b94` (MIT License, Copyright (c) 2021-2026 Miguel Ambrona).

## Decision

Implement an isolated, pure TypeScript prototype in `@chess-platform/core` without modifying any live adjudication behavior (`isFrozenDeadPosition`, `Position.status()`, `Game`, and `authority` remain completely unchanged).

### 1. Mathematical Contract & Rule Model

Under FIDE 5.2.2, a position $S$ is dead if and only if neither player can deliver checkmate by any possible series of legal moves:
$$\text{IsDeadPosition}(S) \iff (\text{Winnability}(S, \text{White}) = \text{Impossible}) \land (\text{Winnability}(S, \text{Black}) = \text{Impossible})$$

Each single-color query distinguishes three discrete outcomes:
1. `reachable`: an exact legal move sequence from the query root delivers checkmate for the intended winner (`witness: readonly Move[]`).
2. `impossible`: checkmate is mathematically excluded via a complete semi-static certificate, raw closed-graph exhaustion, or material-lemma-assisted closure (`provenance: 'static_certificate' | 'closed_graph' | 'closed_graph_material_pruned'`).
3. `pending`: computation limits or resource bounds were reached without complete closure (`reason: 'budget_exhausted' | 'resource_limit' | 'unsupported_variant' | 'unsupported_state' | 'cancelled'`), accompanied by an optional resumable search session (when initialized from admitted input).

Whole-position deadness evaluates both colors independently:
- `isDead: true`: both White and Black are provably impossible (`DeadPositionTrueResult`).
- `isDead: false`: at least one color is reachable with a replayed legal checkmate witness (`DeadPositionFalseResult`).
- `isDead: 'pending'`: neither is reachable, and at least one is pending (`DeadPositionPendingResult`). Pending is never conflated with false.

### 2. Proof Integrity & Boundary Hardening

Following early-draft review and concrete root reproductions, the engine enforces strict proof integrity boundaries:

1. **Deep State Ownership**: The session constructor creates an independent defensive snapshot (`cloneState`) of the caller-provided `PositionState` before generating canonical keys or enqueueing states. Root state is kept in private storage (`ownedRoot`), and public inspection returns a clone. Returned witness arrays and results are defensively cloned so that consumer mutations cannot poison subsequent or repeated inquiries.
2. **Position-Bound Mobility & Lemma 8 Domain Enforcement**: External `MobilitySolution` objects cannot be injected into `isStaticallyUnwinnable`. Mobility is computed internally from the target state. Furthermore, `computeMobility` enforces Lemma 8 domain requirements: active castling rights or en passant squares decline computation (returning `null`), as Lemma 8 over-approximation applies strictly to rights-free and en-passant-free domains. Returned piece and region caches return defensive slices.
3. **Explicit Admitted-State Boundary (`packages/chess-core/src/proof-admission.ts`)**: All proof entry points validate inputs against an orthodox admitted-state boundary:
   - Variant must be `standard` or `chess960`;
   - Pockets must be strictly empty;
   - Check counters must be exactly zero (not undefined, negative, or NaN);
   - 0x88 board representation with exactly 1 White king and 1 Black king;
   - Exact piece membership: only standard chess piece characters (`p,n,b,r,q,k,P,N,B,R,Q,K`) or null;
   - Kings must not be adjacent;
   - Side not to move cannot be in check;
   - No pawns on rank 1 or rank 8;
   - Castling rights: valid held rook files against king/rook back-rank occupancy and side ordering (`k > kingFile`, `q < kingFile`, no duplicate files; standard requires king on e1/e8 and traditional h/a rook files);
   - En passant square: either -1 or a finite integer consistent with side to move, empty target, opponent double-moved pawn, and empty double-push origin;
   - Clock metadata: safe integers `halfmoves >= 0` and `fullmoves >= 1` before legal move generation.
   Unsupported variants yield `pending` with `reason: 'unsupported_variant'`. Non-admitted payloads yield `pending` with `reason: 'unsupported_state'` (or `false` in static checks), never an erroneous impossibility claim. Semantic validation catches only `FenError`, rethrowing unexpected engine/type errors. Malformed constructor inputs set `this.ownedRoot = null` and transition cleanly to `pending` without throwing `TypeError`.
4. **Finite Work Allowances & Explicit Zero Behavior**: Work allowances must be finite non-negative integers. Non-finite values (`NaN`, `Infinity`, negative numbers, fractions) return pending immediately without running unbounded search. An allowance of 0 halts before static or search work, ensuring no unbudgeted search expansion occurs, while admission validation and terminal-root checkmate checks still execute.
5. **Retained-State Capacity & Cancellation Semantics**: Sessions enforce a validated finite positive integer state memory cap (`maxRetainedStates`). Reaching the capacity limit yields a distinct `pending` status with `reason: 'resource_limit'`. Sessions support monotone capacity expansion via `session.setCapacity(newMaxStates)`. Mid-node expansion state is preserved via a node edge cursor (`currentEdges` and `currentEdgeIndex`): pausing mid-expansion preserves the unvisited edges without advancing `queueHead` prematurely, allowing subsequent resumption to complete the exact identical state graph as an uncapped run. Calling `cancel()` transitions the session to `pending` with `reason: 'cancelled'`, and empty-queue traversal after cancellation can never manufacture an impossible result.
6. **Provenance Accuracy (Raw vs. Material-Assisted Closure)**: Distinguishes raw all-edge closed graph exhaustion (`provenance: 'closed_graph'`) from traversals pruned by qualified pawn-free material lemmas (`provenance: 'closed_graph_material_pruned'`). The count of material discharges is explicitly tracked and reported (`materialDischarges`).
7. **Terminal Target Mate Precedence**: Terminal checkmate for the intended winner at the root position is evaluated before static analysis or search work in both the wrapper and the session. Even with an allowance of 0 or static-only configuration, an already-checkmated root returns `reachable` with an empty witness `[]`.
8. **Clean Public Boundary & Typed Results**: Minimal public API surface in `@chess-platform/core`: internal geometric converters (`sq0x88To64`, `sq64To0x88`) and material unwinnability checkers (`isPawnFreeMaterialUnwinnable`) are kept internal and imported directly by test modules; duplicate getters (`getRoot`) are eliminated in favor of getter `root: PositionState | null`. `DeadPositionFalseResult` is strongly discriminated by `winner: 'w' | 'b'`, strictly binding winner color to `WinnabilityReachableResult`.

### 3. Paper-to-Code Mapping

#### A. Mobility Saturation (`packages/chess-core/src/mobility.ts`)
Implements Ambrona FUN 2022 Figures 6 & 7:
- **State variables**:
  - $M_{P \to s} \in \{0, 1\}$: Piece $P$ on initial square $P.\text{sq}$ can potentially reach square $s$. Initialized to 1 for $s = P.\text{sq}$, 0 elsewhere.
  - $C_P \in \{0, 1\}$: Piece $P$ can be cleared from its origin square $P.\text{sq}$ (by moving away or being captured).
  - $R_s^c \in \{0, 1\}$: Square $s$ can be reached by a non-king piece of color $c$.
- **Deduction rules (Figure 6)**:
  - *Rule 1 (Non-Pawn Move)*: $M_{P \to s} \implies \bigvee_{u \in \text{pred}_P(s)} M_{P \to u}$. Slider predecessors use adjacent squares (paper page 10).
  - *Rule 2 (Pawn Move)*: Push requires clearance indicator $F_s^{P.\text{color}}$; diagonal capture requires opponent reachability $R_s^{\neg P.\text{color}}$; promotion conservatively broadens reachable regions to the entire board.
  - *Rule 3 (Clearance)*: $C_P \implies (\bigvee_{s \neq P.\text{sq}} M_{P \to s}) \lor (\bigvee_{P', P'.\text{color} \neq P.\text{color}} M_{P' \to P.\text{sq}})$.
  - *Rule 4 (Reachability)*: $R_s^c \implies \bigvee_{P.\text{color} = c \land P.\text{type} \neq K} M_{P \to s}$.
  - *Rule 5 (King Direct Attackers)*: $M_{K \to s} \implies \bigwedge_{P' \in \text{pos}.\text{attackers}(s), P'.\text{color} \neq K.\text{color}} C_{P'}$. Direct attackers are restricted to capture-predecessor geometry on square $s$ (paper page 10, page 13 footnote 6).
  - *Rule 6 (Not Self-Capture)*: $M_{P \to P'.\text{sq}} \implies C_{P'}$. Friendly pieces must be cleared before an ally can occupy their initial square.
- **Implementation**: Flat `Uint8Array` buffers indexed by `(pieceId * 64) + sq64`. Lemma 8 guarantees admissible over-approximation.

#### B. Semi-Static Mating Exclusion (`packages/chess-core/src/semi-static.ts`)
Implements Ambrona FUN 2022 Figure 8:
- **Guards (Step 1)**: Declines certificate if active en passant exists (`epSquare !== -1`), if either player retains any castling right, or if unsupported variants/pockets/check-counters are present.
- **Intruder Confinement (Steps 4-6)**: Intruders are winner-colored pieces that can reach the loser's king region $\text{region}(K_{\neg c})$. If any intruder is not a bishop, or if intruders contain bishops on different square colors, the certificate declines.
- **Flight Square Coverage (Step 10)**: For every candidate mating square $s \in \text{region}(K_{\neg c})$ that can be attacked by the winner:
  - Counts $\text{blockers}(s)$: loser non-king pieces that can reach $\Plus(s)$.
  - Counts $\text{assistants}(s)$: winner pieces that can attack $\Plus(s)$.
  - Where $\Plus(s)$ represents the orthogonally adjacent squares (Footnote 9: at most 4 squares).
  - If $|\text{blockers}(s)| + |\text{assistants}(s)| \ge |\Plus(s)|$, checkmate cannot be ruled out statically; declines.
- **Theorem 12 Soundness**: When all conditions hold, returns `true` (provably unwinnable for player $c$).

#### C. Exact Resumable Cooperative Search (`packages/chess-core/src/cooperative-search.ts`)
Implements cooperative legal-transition exploration (Ambrona Figures 5 & 9):
- **Clock-Free Canonical Key**: Serializes board placement, turn, full rook-file castling rights, and en passant square. Explicitly excludes halfmove and fullmove counters, preventing circular 50-move/repetition truncation.
- **Pure Legal Generation**: Calls `generateLegalMoves`, `applyMove`, and `inCheck`. Never calls `Position.prototype.status()`.
- **Target Mate**: If the opponent is in check and has zero legal moves, checkmate is delivered; terminates immediately and returns the full root-to-mate witness.
- **Pawn-Free Material Pruning**: Prunes dead leaves using exact hypotheses from Lemmas 5 & 6 (paper page 7):
  - *Lemma 5*: Winner has just a single knight; opponent has no knights, bishops, or rooks. Strictly pawn-free.
  - *Lemma 6*: Winner has just bishops of one square color; opponent has no knights and no bishops of opposite color. Strictly pawn-free.
  - *Bare King*: Winner has zero mating material on a pawn-free board.
- **Resumability**: `CooperativeSearchSession.resume(stepBudget)` advances the frontier deterministically without mutating root state or poisoning subsequent continuations.

### 4. Verification Evidence & Empirical Test Results

All `@chess-platform/core` tests pass locally (273 passing tests, 0 failures, 66 unwinnability-focused tests across 5 test suites: `proof-admission.test.ts`, `mobility.test.ts`, `semi-static.test.ts`, `cooperative-search.test.ts`, `unwinnability.test.ts`):
1. **Corpus Line 14** (`2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1`):
   - Proven unwinnable for both White and Black via `UnwinnableStatic` with 0 search states explored.
   - Evaluates `isDead: true` (`provenance: 'static_certificate'`).
2. **Corpus Line 15** (`Bb1k1b2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 w - - 0 1`):
   - Futile pawn advance `g4g5`.
   - Explores full closed graph of exactly 220 discovered and fully expanded states with zero mates (matching independent python-chess oracle baseline in `outputs/research124/independent-graph-baseline.json`).
   - Evaluates `isDead: true` (`provenance: 'closed_graph'`, `materialDischarges: 0`).
3. **Corpus Line 26** (`Bb2kb2/bKp1p1p1/1pP1P1P1/1P6/p5P1/P7/8/8 b - - 0 1`):
   - Forced sequence; explores full closed graph of exactly 220 states with zero mates.
   - Evaluates `isDead: true` (`provenance: 'closed_graph'`).
4. **Corpus Line 46** (`8/8/8/8/2b5/1kB5/1B6/BKB5 w - - 0 1`):
   - Black delivers checkmate: witness verified via shared canonical witness replay (`assertCanonicalWitnessReplay`) checking exact move properties (`from`, `to`, `piece`, `captured`, `flags`, `promotion`, `castleRook`) and executing with direct `applyMove`.
   - White winnability within budget 1000 remains pending without false impossibility claim (matching root independent python-chess baseline in `outputs/research124/independent-graph-line46-white.json` showing White pending after 100,000 states).
   - Evaluates `isDead: false` (`reason: 'winnable'`, `winner: 'b'`).
5. **Corpus Line 137 (Family C Residual Search)** (`1k6/1P5p/BP3p2/1P6/8/8/5PKP/8 b - - 0 1`):
   - Semi-static certificate is inconclusive.
   - Cooperative search explores residual closed graph of exactly 3343 states (matching independent python-chess baseline in `outputs/research124/independent-graph-residual137.json`).
6. **Active En Passant Checkmate (Line 1360)** (`R7/5k2/5B2/3PpPP1/8/4K3/8/8 w - e6 0 1`):
   - Static certificate declines because `epSquare !== -1`.
   - Cooperative search discovers immediate checkmate `d5e6#`.
   - Verified exact move flags (`MoveFlag.EnPassant | MoveFlag.Capture`), captured pawn removal from e5, origin d5 vacancy, and shared canonical witness replay.
7. **Forced Sequence & Promotion Branching (Line 393)** (`5r1k/6P1/7K/5q2/8/8/8/8 b - - 0 1`):
   - Forced sequence `h8g8`, then White's 4 promotion branches (`g7f8{q,r,b,n}`).
   - Verified all 4 branches against root python-chess baseline: Q/R branches feature two legal capture replies (`f5f8` and `g8f8`); N/B branches discharge Lemmas 5 & 6.
   - White evaluated as provably impossible across all branches.
8. **Already-Checkmated Root Precedence (Line 145)** (`k6R/1p6/pK6/P7/8/1P6/8/8 b - - 0 1`):
   - Evaluates `reachable` with empty witness `[]` under budget 0.
9. **Genuine Standard and Chess960 Castling Checkmate Controls**:
   - Standard chess: `4rkr1/4p1p1/6P1/8/8/8/8/4K2R w K - 0 1` finds 1-move checkmate via `O-O#` (`flags: 8`, `castleRook: 7`), verified via canonical replay.
   - Chess960: `4rkr1/4p1p1/6P1/8/8/8/8/2K4R w H - 0 1` (Chess960) finds 1-move checkmate via `O-O#` from c1/h1 to g1/f1 (`flags: 8`, `from: 2`, `to: 6`, `castleRook: 7`), verified via canonical replay.
10. **Regression Controls for All Reproduced Review Defects**:
    - Caller root mutation: mutating caller board, nested castling rights, checkCount, and pockets after session construction does not alter internal proof.
    - Fabricated mobility isolation: external mobility cannot be injected; internal calculation protects against forged certificates even through typed JS-compatible calls.
    - Returned witness/result mutation: mutating returned witness arrays or move-record fields (`from: 999`) does not alter subsequent `getStatus()` results.
    - Sibling witness independence: `result.witness` and `result.black.witness` are independent arrays with independent move objects; mutating one does not mutate the other.
    - Non-finite work allowances: `NaN`, `Infinity`, negative, and 0 allowances halt cleanly as pending without unbounded execution.
    - Retained capacity pause mid-continuation: session pauses at exact capacity limit with `resource_limit`, and `setCapacity` resumes on the same session to discover the complete witness.
    - Result aggregation: directional impossible + other pending evaluates to whole-position `isDead: 'pending'`.
    - Input admission: unknown pieces, bad castling rights (wrong side ordering, absent rook, wrong color, non-traditional standard files), fractional/negative clocks, and malformed objects reject safely into `unsupported_state` (or `false` in static checks) without throwing `TypeError`.
    - Engine error isolation: catches only `FenError` around semantic validation, rethrowing unexpected errors.

### 5. Prototype Boundaries & Remaining Work

This prototype is strictly isolated from production behavior:
- `Position.prototype.status()`, `isFrozenDeadPosition()`, `Game`, `authority`, schemas, migrations, services, and live workflows remain completely untouched.
- Full live integration requires:
  1. Performance benchmarking across larger corpus batches;
  2. Authority-side asynchronous analysis integration or in-process background worker;
  3. FIDE-compliant clock fairness (ensuring solver latency is not billed to player thinking time);
  4. Durable pending-analysis persistence across restarts;
  5. Explicit platform policy for unresolved budget-exhausted cases.
