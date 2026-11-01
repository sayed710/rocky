# ADR 0166: Dead Position Compatibility Preparation (AUD-03a)

- **Status**: Accepted
- **Date**: 2026-11-01
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **Consulted**: OpenCode (independent design review for baseline scope; candidate review quota-failed before run), Qodo review (pending for this unpublished candidate; prior PR #142 context only)
- **References**: Issue #124, [ADR 0100](0100-variant-timeout-material.md), [ADR 0136](0136-chess960-core-rules-and-castling.md), [ADR 0148](0148-pregame-readiness-lifecycle.md), [ADR 0161](0161-durable-state-revision-foundation.md), `packages/persistence/migrations/0052_dead_position.sql`, `packages/game/src/events.ts`, `packages/persistence/src/rating-eligibility.ts`, `packages/persistence/src/pg/terminal-event-inbox.ts`, `packages/api/src/game-export/finished-game-pgn.ts`, `packages/api/src/analysis/terminal.ts`, `packages/api/src/study-partner/coaching.ts`, `packages/api/openapi.json`, `packages/web/src/net/ws-protocol.ts`, `packages/web/src/net/game-sync.ts`, `packages/web/src/app/game-controller.ts`, `packages/web/src/app/endgame-view.ts`, `packages/web/src/app/explain-view.ts`, `packages/web/src/i18n/catalog/en.ts`, `packages/web/src/i18n/catalog/ar.ts`

## Context

FIDE Article 5.2.2 establishes that the game is drawn when a position is reached from which checkmate cannot occur by any possible series of legal moves (a dead position). Issue #124 tracks support for structural dead positions in the platform.

Because a new termination code introduces cross-cutting compatibility requirements across database constraints, persistent event logs, rating systems, PGN exports, public OpenAPI contracts, WebSocket real-time protocols, and frontend client bundles, the platform owner approved a strictly staged two-phase rollout:
1. **AUD-03a (This ADR)**: Backward-compatibility preparation only. Define database schema, widen consumer decoders and readers, implement strict client ingress validation, provide English and Arabic localization, and test synthetic stored replays. Strictly NO live detector, NO status adjudication, and NO production database execution.
2. **AUD-03b (Strict HOLD)**: Live dead position detection and server emission. Source-stage AUD-03b implementation as well as emission remains on strict HOLD until AUD-03a merge AND separately owner-approved, verified rollout across production database, backend services, and active client bundles.

## Decision

Implement AUD-03a compatibility preparation under strict boundary isolation and frozen producer invariants.

### 1. Additive Database Dictionary Migration (`0052_dead_position.sql`)
- Add versioned migration `packages/persistence/migrations/0052_dead_position.sql` executing `INSERT INTO terminations(code, is_draw) VALUES ('dead_position', true);`.
- Immutable prior migrations 0001..0051 and migration runner integrity checks remain untouched.
- The `is_draw` column in the dictionary table is informational; the actual database constraint enforcing termination validity is the foreign key `games_termination_fkey` on the `games.termination` column.
- The migration is written to source SQL only; no execution against production or local shared databases occurs during this task.

### 2. Multi-Stage Deployment & Rollout Sequencing
Activation of dead position handling requires a four-phase sequence:
1. **Phase 1: Database Migration**: Migration 0052 is applied to production PostgreSQL under explicit operator approval.
2. **Phase 2: Backend Readers & Web Deployment**: Services and frontend bundles with prepared decoders are deployed to production.
3. **Phase 3: Verified Client Rollout**: Verify active client bundles through telemetry rather than relying on an arbitrary cache TTL (e.g., 48-72 hours). Old cached browser bundles behave asymmetrically (compiled legacy revisioned decoders reject new frames, while unrevisioned decoders structurally admit unknown strings).
4. **Phase 4: AUD-03b Authorization**: Live adjudication and emission remain on strict HOLD until Phases 1–3 are complete and verified.

### 3. Rollback Asymmetry & Schema Limitations
- **Database Rollback**: The additive dictionary row `('dead_position', true)` remains safely inert in PostgreSQL if backend application code is rolled back. No automated destructive rollback SQL or historical log rewriting is executed.
- **Reader Asymmetry**: If new events with `dead_position` were persisted to disk, rolling back to an older backend application release would cause legacy event decoders to fail closed on those rows. Therefore, live emission cannot be enabled until the prepared release is permanently established.

### 4. Prepared Consumers and Reader Boundaries
- **Game Events (`@chess-platform/game`)**: Widened `Termination` union to include `dead_position`. `Game.fromEvents` and `replayStoredHistory` cleanly replay synthetic stored events without altering live gameplay.
- **Rating Eligibility (`@chess-platform/persistence`)**: Added `dead_position` to `RESULTS_BY_TERMINATION` with standard draw outcome (`DRAW`, score 0.5 for rated human games; casual and engine bot exclusions preserved). Decisive (`1-0`, `0-1`), abort (`*`), or non-null winner combinations are rejected as corrupt.
- **Terminal Event Inbox (`@chess-platform/persistence`)**: Added `dead_position: ['1/2-1/2']` to valid inbox terminations. Contradictory outcomes fail closed with `decodeError`.
- **Finished Game PGN Export (`@chess-platform/api`)**: Added `dead_position: DRAW` to `RESULTS_BY_TERMINATION`, correctly formatting `1/2-1/2` and rejecting contradictions.
- **API Terminal Reason & Coaching (`@chess-platform/api`)**: Widened prepared `TerminalReason` union and updated `describeTerminal` (`'dead position — drawn'`). Preserved unchanged `fromStatus` mapping from core `GameStatus` (no impossible branches). Updated `storedStudyPartnerCoaching` to accept `dead_position` strictly with result `1/2-1/2`.
- **OpenAPI Contracts (`packages/api/openapi.json`)**: Regenerated schema with intentional additive enum value; confirmed stable on second regeneration pass with zero unexpected drift.

### 5. Client Ingress Trust Boundary & WebSocket Protocol (`@chess-platform/web`)
- **Strict Ingress Defense**: `ws-protocol.ts` and `GameSync.handleMessage` enforce that `dead_position` is accepted ONLY as draw (`result === '1/2-1/2'` and `winner === null`) across revisioned and unrevisioned `ended` events, snapshot statuses (`joined`, `state`, `resumed`), and `resumed.missed` replay logs.
- **Early Dropping Before State Mutation**: Any invalid frame containing `dead_position` with decisive results or non-null winner is dropped immediately at ingress before uncertainty clearing, state revision floor updates, pending intent clearance, or state mutation. Preserves separate pending move, pending action (`offerDraw`), and command uncertainty (`outcomeUnknown`) notices across corrupt deliveries.
- **Localization & Copy Parity**: Controller `statusText` (`'Draw — dead position ({result})'` / `'تعادل — وضعية ميتة ({result})'`), explain view (`'Dead position — draw'` / `'تعادل لوضعية ميتة'`), and endgame view (`'Dead position — draw · 1/2-1/2'` / `'تعادل لوضعية ميتة · 1/2-1/2'`) maintain 100% catalog key and parameter parity across English and Arabic, strictly distinct from insufficient material copy.

### 6. Frozen Producer Invariants
The 14 core producer files remain completely frozen with zero modifications:
- `packages/chess-core/src/board.ts`
- `packages/chess-core/src/castling.ts`
- `packages/chess-core/src/check-counters.ts`
- `packages/chess-core/src/chess960.ts`
- `packages/chess-core/src/fen-error.ts`
- `packages/chess-core/src/fen.ts`
- `packages/chess-core/src/index.ts`
- `packages/chess-core/src/movegen.ts`
- `packages/chess-core/src/position-validator.ts`
- `packages/chess-core/src/position.ts`
- `packages/chess-core/src/repetition.ts`
- `packages/chess-core/src/types.ts`
- `packages/game/src/game.ts`
- `packages/game/src/timeout-adjudication.ts`

Live gameplay, clock flagging, and timeout adjudication never emit `dead_position`. Broader classes of dead positions remain OPEN.
