# ADR 0167: Frozen King and Pawn Dead Position Adjudication (AUD-03b)

- **Status**: Accepted
- **Date**: 2026-11-01
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **Consulted**: Pi (mathematical proof and reachable flood review), OpenCode (integration and event-sourcing review), Qodo review (pending for head)
- **References**: Issue #124, [ADR 0100](0100-variant-timeout-material.md), [ADR 0116](0116-terminal-position-semantics.md), [ADR 0136](0136-chess960-core-rules.md), [ADR 0166](0166-dead-position-compatibility-preparation.md), `packages/chess-core/src/dead-position.ts`, `packages/chess-core/src/position.ts`, `packages/chess-core/src/types.ts`, `packages/game/src/game.ts`, `packages/game/src/timeout-adjudication.ts`, `packages/api/src/analysis/terminal.ts`, `packages/realtime-gateway/src/authority.ts`, `packages/chess-core/test/dead-position.test.ts`, `packages/chess-core/test/dead-position-oracle.test.ts`, `packages/game/test/dead-position-replay.test.ts`, `packages/realtime-gateway/test/dead-position-authority.test.ts`, `packages/persistence/test/dead-position-emission.integration.test.ts`, `packages/persistence/migrations/0052_dead_position.sql`

## Context

FIDE Article 5.2.2 establishes that the game is drawn when a position is reached from which checkmate cannot occur by any possible series of legal moves (a dead position). Issue #124 tracks dead position detection and adjudication for the Gambit chess platform.

ADR 0166 (AUD-03a) completed backward-compatibility preparation across the platform (database dictionary migration `0052_dead_position.sql`, persistent event models, rating systems, PGN exports, API schemas, and localized frontend decoders) while freezing core adjudication and server emission.

Following the completed preparation, the platform owner explicitly authorized isolated source implementation and verification for the remaining Issue #124 fix. This narrowly overrides the previous source-stage hold for this specific worktree, while production deployment and live activation remain prohibited pending owner rollout authorization. Issue #124 remains open; broader dead position classes remain outside scope.

Key design reviews contributed essential structural insights:
1. **Pi Design Review**: In the motivating Issue #124 position (`8/1pk2p1p/pPp1pPpP/P1P1P1P1/5K2/8/8/8 b - - 0 1`), the Black king on c7 starts in check from the White pawn on b6. However, Black possesses the legal escape `c7d7`. A blanket rejection of positions with `inCheck === true` fails this canonical case. Furthermore, reachability analysis must seed the starting king square even if checked, ignore the opposing king as an obstacle or attacker to compute a conservative reachability superset, and rigorously prove through first-pawn-change contradiction that no pawn barrier can ever be breached.
2. **OpenCode Design Review**: Event sourcing integrity requires that historical games stored without `GameEnded` must not have synthetic endings fabricated upon replay in `Game.reduce` or `Game.fromEvents`. Newly created custom games starting in a dead position must emit explicit `[GameCreated, GameEnded]` events with durable authority persistence, best-effort PubSub publication, and command arbitration.

## Decision

Implement AUD-03b frozen King and Pawn dead-position adjudication through a pure sufficient certificate, integrated rules priority, durable Game event emission, and realtime command arbitration.

### 1. Pure Sufficient Certificate (`packages/chess-core/src/dead-position.ts`)

A dead position is mathematically proven if no sequence of legal moves can alter the blocked pawn structure or deliver checkmate. Rather than attempting full state-space exploration at runtime, `isFrozenDeadPosition(state)` implements a conservative sufficient certificate:

1. **Variant & Inventory Guards**:
   - Supported variants: `standard` and `chess960` only.
   - Exact piece counts: exactly 1 White king, 1 Black king, at least 1 pawn ($P \ge 1$), and 0 non-pawn pieces ($Q, R, B, N$).
   - Legal ranks: all pawns lie strictly on ranks 2 through 7 (no rank 1 or 8 pawns).
   - En passant & Castling: `epSquare === -1` (no pending en passant captures), no castling rights, and empty crazyhouse pockets.
2. **Pawn Gridlock Geometry**:
   - Forward squares: for every pawn, the single square directly in front is occupied by another pawn (of either color).
   - Mutual capture impossibility: no two opposing pawns occupy adjacent files with overlapping rank bounds that could permit a diagonal capture.
   - En passant conservation: no en passant capture is possible since all pawns are forward-blocked and no 2-square push square is active.
3. **Static Pawn Attack Masks**:
   - $A_w$: all squares diagonally attacked by White pawns.
   - $A_b$: all squares diagonally attacked by Black pawns.
4. **Conservative King Reachability Flood**:
   - For each king, explore reachable squares via Breadth-First Search (BFS) using standard 8-direction steps.
   - King-king interference is ignored during flood expansion (enemy king is not treated as an obstacle or attack source), producing a strictly conservative reachability superset.
   - If the starting square is attacked, it must be attacked exclusively by an enemy pawn, and the king must have at least one legal escape in the starting position.
   - All subsequent reachable steps must land on squares completely free from enemy pawn attacks ($A_{\text{enemy}}$).
   - **Absence of Dedicated Vacated-King Mutant**: Because the BFS expansion deliberately ignores enemy king squares as obstacles, kings are treated as transparent, overapproximating reachability without requiring a dedicated negative vacated-king mutant.
5. **Reachable Adjacency Rejection & First-Pawn-Change Contradiction**:
   - For each king, every reached square is evaluated against all adjacent enemy pawn squares. If any reachable square is adjacent to an enemy pawn that lacks static pawn defense (i.e. is not attacked/defended by another enemy pawn), the certificate fails closed (returns `false`).
   - **First-Pawn-Change Contradiction**: Any hypothetical initial move altering the pawn structure must be one of:
     a) A pawn push (impossible: every pawn is forward-blocked by another pawn).
     b) A pawn capture (impossible: pawn attack destinations contain no opposing pawns).
     c) A king capturing a defended enemy pawn (impossible: defended pawn squares are attacked by enemy pawns, making king capture illegal).
     d) A king capturing an unprotected enemy pawn (impossible: no reachable king square is adjacent to an unprotected enemy pawn).
   - Therefore, by induction, the pawn configuration is permanently immutable. Since pawns cannot move or be captured, no promotions can ever occur. Since only kings and immobilized pawns remain, checkmate cannot occur by any possible series of legal moves under FIDE Article 5.2.2. No broader territory penetration claims are made or required.

### 2. Core Status Priority (`packages/chess-core/src/position.ts`)

In `Position.status()`, the certificate is evaluated with strict rule precedence:
1. `variant_win` / `variant_draw`
2. `checkmate` / `stalemate` (a terminal mating or stalemate move takes immediate precedence)
3. `dead_position` (frozen king/pawn dead positions certified here, prior to the 50-move clock)
4. `fifty_move` (halfmoves >= 100 preserved before material evaluation outside the frozen class)
5. `insufficient_material` (bare kings or lone minor material draws retain their existing specific classification)

**Factual Guard**: Only the frozen King/Pawn certificate precedes `fifty_move`. Outside the frozen King/Pawn class, the original precedence of `fifty_move` before `insufficient_material` remains strictly preserved, ensuring that bare king positions reaching 100 halfmoves continue to be adjudicated as `fifty_move` draws.

Core `types.ts` is widened with `{ over: true; reason: 'dead_position' }` in `GameStatus`.

### 3. API Terminal Outcome Mapping (`packages/api/src/analysis/terminal.ts`)

In `packages/api/src/analysis/terminal.ts`:
- `fromStatus` maps `status.reason === 'dead_position'` to `{ reason: 'dead_position', result: '1/2-1/2' }`.
- `terminalOutcome(fen, variant)` directly queries `Position.status()`, making dead position detection available to API analysis endpoints and Move Explanation without running engine evaluations or consuming compute quota.

### 4. Game Lifecycle & Command Arbitration (`packages/game/src/game.ts`)

1. **Custom FEN Creation**: When `Game.create` receives a custom `initialFen` that is certified dead, it returns `[GameCreated, GameEnded]` with `termination: 'dead_position'` and `result: '1/2-1/2'`, providing durable event persistence from creation.
2. **Command Arbitration**: In `playMove`, `resign`, `offerDraw`, `acceptDraw`, `declineDraw`, `claimFlag`, `abort`, and `expireNoShow`, if the current position is dead, the command is intercepted and returns `GameEnded` (`termination: 'dead_position'`). This prevents spurious timeouts, resignations, or illegal continuation moves on ongoing dead prefixes.
3. **Timeout Evaluation (`canMate`)**: `canMate` evaluates a cheap certificate check and returns `false` if the position status is `dead_position`, correctly classifying any pending flag claim as a draw.
4. **Historical Replay Invariance**: `Game.reduce` and `Game.fromEvents` do not check `Position.status()` to fabricate endings. Historical games stored without a terminal event replay faithfully as ongoing games without synthetic revision drift.
5. **Frozen Solver Invariant**: `packages/game/src/timeout-adjudication.ts` (Issue #123 solver) remains strictly frozen and unmodified.

### 5. Realtime Gateway Authority (`packages/realtime-gateway/src/authority.ts`)

In `GameAuthority`:
- `createGame` inspects the events returned by `Game.create`. When a custom dead FEN emits `[GameCreated, GameEnded]`, the authority sets `persistedSeq: 1`, publishes the terminal `ended` broadcast to `gameChannel` and `gamesEndedChannel()`, and clears `legalMoves` to `{}`.
- **Durable Commit vs. Best-Effort Broadcast**: Event log appending (`store.append`) is durable and establishes canonical sequence ordering. Post-commit PubSub publications are best-effort client notifications wrapped in independent try/catch blocks; subscriber exceptions do not fail the commit or prevent remaining channel notifications. Asynchronous consumers (rating processing, bot analysis, anti-cheat) recover durably via the transactional PostgreSQL terminal-event inbox (`PgTerminalEventInbox`), distinguishing durable event/inbox persistence from best-effort pubsub broadcasts without implying an outbox delivery redesign or full D2 fix.
- Incoming commands on ongoing dead prefixes arbitrate directly to `dead_position` endings, preserving durable event persistence, inbox recovery, and best-effort client notifications.

## Validation & Evidence

1. **Independent Oracle State-Graph Verification (`packages/chess-core/test/dead-position-oracle.test.ts`)**:
   - In-tree oracle dynamically explores the complete legal state space over `(wk, bk, turn, castling, epSquare)` without detector calls or 50-move cutoff, certifying issue FEN and reflection as `PROVEN_DEAD` matching `isFrozenDeadPosition`.
   - Root external independent pre-detector graph exploration established **577 reachable states** and **2,336 legal transitions** for the issue FEN and its reflection as baseline evidence (stored in external root artifact `issue124b-root-fixed-pawn-oracle.json`). In-tree oracle tests verify exact closure (577 states, 2,336 transitions for issue FEN and reflection -> `PROVEN_DEAD`) matching `isFrozenDeadPosition`.
   - Pi counterexample detects pawn capture on move 1 (`PAWNS_CHANGED`).
   - Opened a-file push witness sequence (`c7d7, f4e3, a6a5`) detects a legal pawn move (`PAWNS_CHANGED`), witnessing an actual pawn push rather than any false b6 capture (as c5 continues to defend b6).
   - Bounded state cap halts with `INCONCLUSIVE`.
   - **Production Mutants vs. Domain Counterexamples**: Root's copied compiled production mutants (removing the variant guard and introducing input state mutation) are real code mutants killed by the corrected core unit tests. Changed-board oracle witnesses are structural domain counterexamples and oracle transitions, not production code mutations.
2. **Core Unit & Property Tests (`packages/chess-core/test/dead-position.test.ts`)**:
   - Focused unit tests covering positive controls, color/rank symmetry, checkmate/stalemate/fifty-move priority, bare kings material draw priority, multi-step king access, pawn pushes, chain roots, non-pawn pieces, en passant, Chess960 support, variant rejections outside catch blocks, exact input object immutability, and ROOT verified proof controls: geometric pawn capture isolating guard (`7k/8/8/4pp2/4PP2/8/8/K7 w - - 0 1`, legal `e4f5`), reachable chain root access (`8/8/8/2p5/1pP5/1P6/8/k6K b - - 0 1`, legal sequence `a1a2, h1g1, a2b3`), and checked target `c7d7` escape verification.
   - Redundant duplicate positive target assertion removed; absence of dedicated vacated-king mutant documented.
3. **Game & Replay Tests (`packages/game/test/dead-position-replay.test.ts`)**:
   - Verified synthetic replay invariance, absence of fabricated endings on historical streams, live custom creation durability, ongoing dead prefix command arbitration, and frozen solver checks.
   - Tested legacy runtime fixture replay (`c7d7 / Kd7 / timeout 0-1`) and legal predecessor move test (`8/1pk2p1p/p1p1pPpP/PPP1P1P1/5K2/8/8/8 w - - 0 1`, move `b5b6+`, emitting `MovePlayed` then `GameEnded` with distinct revisions).
4. **Realtime Gateway Tests (`packages/realtime-gateway/test/dead-position-authority.test.ts`)**:
   - Verified custom dead FEN creation durability, best-effort pubsub publication, and command arbitration under live authority, including throwing subscriber fault tolerance and exact publication counts (1 per channel, 2 total).
5. **API Tests & Contract Stability (`packages/api/test/terminal-positions.test.ts` & `packages/api/test/dead-position-compat.test.ts`)**:
   - Verified `fromStatus` and `terminalOutcome` mapping.
   - Verified `POST /v1/analysis` reports `dead_position` without engine search or compute charge.
   - Verified `MoveExplanationService` skips post-move search on moves into dead positions and rejects moves from dead positions with 422.
   - Zero drift in `packages/api/openapi.json`.
6. **Persistence Integration Tests (`packages/persistence/test/dead-position-emission.integration.test.ts`)**:
   - Verified custom dead position Game event emission into real PostgreSQL, confirmed by ROOT focused v3 execution (`outputs/issue124b-root-final-v3-receipt.json`, 1 PASS, 0 FAIL, 0 SKIP): `PostgresEventStore` appends `[GameCreated, GameEnded]`, `PgGamesProjector` projects `result: '1/2-1/2'` and `termination: 'dead_position'` with `last_seq === 1`, and `PgTerminalEventInbox` claims (asserting exact `lease.seq === 1`) and acknowledges the terminal work, with repetition from the original `null` cursor returning `undefined`.
7. **Codebase Hygiene & Root Verification**:
   - Zero instances of `as any` introduced across all packages.
   - Root independently verified production v2 executed suites across workspaces: `@chess-platform/core` 208 PASS (historical v2 count before deduplication), `@chess-platform/game` 138 PASS, `@chess-platform/realtime-gateway` 265 PASS, `@chess-platform/api` 1,311 PASS, `@chess-platform/persistence` unit 113 PASS, `@chess-platform/web` 1,767 PASS. Four whole local jobs were skipped in local runner (Postgres integration, standalone gateway Redis service, real Nginx, POSIX); root separately completed the full real PostgreSQL persistence suite (275 PASS, 0 skips) and API suite (109 PASS, 0 skips). Standalone gateway, Nginx, and POSIX checks remain outstanding for applicable remote CI.
   - Root focused v3 test gates completed (`outputs/issue124b-root-final-v3-receipt.json`): `@chess-platform/core` 207 PASS (after removing duplicate positive test), persistence test compilation and exact strengthened real PostgreSQL emission test 1 PASS. Exact root final gate evidence is bound in the PR.

## Production Status

Isolated source implementation, local unit/component test suites, and focused root v3 verification gates are complete on this branch. Exact immutable commit, external provider reviews, and remote GitHub Actions CI remain pending for pull request creation. Production deployment, migration 0052 application to production databases, and live cluster activation remain on strict HOLD pending explicit platform owner rollout authorization. The platform owner authorized isolated source implementation, testing, and PR creation only; Issue #124 remains open, and broader dead-position classes remain outside scope.
