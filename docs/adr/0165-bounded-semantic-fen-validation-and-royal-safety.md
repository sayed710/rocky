# ADR 0165: Bounded Variant-Aware Untrusted FEN Ingress Validation and Royal Defense-in-Depth

- **Status**: Accepted
- **Date**: 2026-11-01
- **Deciders**: Gemini (Sole Project Author for Scope), Root Technical Direction
- **Consulted**: OpenCode (independent read-only audit), Qodo reviews of PR #132 and PR #140
- **References**: Rocky Issue #125, [ADR 0113](0113-analysis-endpoint.md), [ADR 0071](0071-pgn-and-studies.md), [ADR 0003](0003-legal-moves-contract.md), `packages/chess-core/src/position-validator.ts`, `packages/api/src/analysis/fen-validator.ts`, `packages/api/src/studies/position-reader.ts`

## Context

Untrusted FEN strings enter the platform through multiple HTTP caller boundaries: engine analysis, puzzle generation, mistake prediction, coaching, move explanation, study-partner session creation, study chapters, lesson authoring steps, and PGN study import.

Prior to Issue #125:
1. `parseFen` and `Position.fromFen` in `@chess-platform/core` performed syntax decoding only. Positions with missing or duplicate kings, adjacent kings, or the side not to move in check decoded without error.
2. `CoreFenValidator` in `@chess-platform/api` (introduced in ADR 0113) composed `structuralFenValidator` (length and character allowlist) with `parseFen` and an ad-hoc king-count check. It did not validate royal adjacency, variant check semantics, or Crazyhouse pockets.
3. In `Position.legalMoves()` and `Position.play()`, defense-in-depth was incomplete: moves capturing an opposing royal king were generated when starting from an illegal check state (e.g., `e1e8` capturing the Black king when Black was already in check on White's turn), and Crazyhouse drop generation permitted dropping kings if a king entered a pocket.
4. Horde studies and PGN imports without a `[FEN]` tag defaulted to `DEFAULT_STARTING_FEN` (standard chess with a White king), immediately failing under strict Horde rules (White has 0 kings).
5. In Atomic chess, a legal move can explode an enemy king and end the game, producing a 1-king terminal position. Ingress validation must strictly require both kings for newly submitted positions without breaking the ability to store, view, and export legally derived terminal winning leaf positions.

## Decision

Implement a bounded, variant-aware semantic position validator and royal defense-in-depth without modifying low-level parsing or breaking historical compatibility.

### 1. Decoding Contract Remains Syntax-Only (`parseFen` / `Position.fromFen`)
The decoding contract of `parseFen` and `Position.fromFen` remains permissive and unchanged. Low-level board decoders do not reject historical positions, corrupt historical game logs, or derived terminal states.

### 2. Bounded Semantic Validator (`validatePositionSemantics` / `validateFen`)
A shared, dependency-free validator (`validatePositionSemantics`) is introduced in `@chess-platform/core` and composed by `validateFen(fen, variant)`:
- **Royal Counts**:
  - Horde: exactly 0 White kings and 1 Black king.
  - All other 7 variants: exactly 1 White king and 1 Black king.
- **Royal Non-Adjacency**:
  - Kings cannot be adjacent in any variant except Atomic (where connected kings are legal and cannot be checked) and Horde (where White has no king).
- **Check Semantics**:
  - Racing Kings: neither king may be in check.
  - Horde: White has no king and is never in check; Black cannot be in check when it is White's turn.
  - Standard, Chess960, Threecheck, Crazyhouse, King of the Hill, Atomic: the side not to move cannot be in check (side to move may legitimately be checked or checkmated).
- **Crazyhouse Pockets**:
  - Neither pocket may contain a king (`'k'`).
  - Non-Crazyhouse variants must have empty pockets.
- **No Retrograde Reachability Claim**:
  The validator explicitly bounds its assertions to basic royal safety, adjacency, check rules, and pockets. It does **not** assert full historical reachability (e.g., impossible pawn counts, backwards pawn moves, unreachable double-checks, or retrograde move proofs).

### 3. Royal Defense-in-Depth (`legalMoves`, `Position.play`, `applyMove`)
- **King Capture Prevention**: `generateLegalMoves` filters out any move that captures an opposing royal king (`state.variant !== 'atomic' && move.captured && typeOf(move.captured) === 'k'`). `Position.play` (both string UCI and `Move` object) resolves exclusively against `legalMoves()` and rejects opposing king captures with `IllegalMoveError`.
- **Chess960 Castling**: King-takes-own-rook castling notation is preserved and unaffected.
- **Crazyhouse Drop Defense**: `generateDrops` skips `'k'`. `applyMove` prevents crazyhouse pocketing of captured kings.
- **Low-Level `applyMove` Role**: `applyMove` remains an internal state transition function without global strict legality gating, preserving compatibility for pre-#127 stored replays in `@chess-platform/game`.

### 4. Comprehensive Caller Ingress Validation (HTTP 422)
`CoreFenValidator` in `@chess-platform/api` composes `structuralFenValidator`, `parseFen`, and `validatePositionSemantics`. It catches only `FenError` and maps to `InvalidFenError('Invalid FEN position.')`, propagating programming or infrastructure errors.

All 10 caller ingress routes enforce strict validation and return stable HTTP 422 (`validation_failed`):
1. `POST /v1/analysis`
2. `POST /v1/analysis/puzzle`
3. `POST /v1/analysis/mistake-prediction`
4. `POST /v1/coach`
5. `POST /v1/ai/move-explanation`
6. `POST /v1/study-partner/sessions`
7. `POST /v1/studies/:id/chapters`
8. `POST /v1/lessons/:id/steps`
9. `PATCH /v1/steps/:id`
10. `POST /v1/studies/:id/import` (PGN with empty movetext, invalid moves, or mixed valid/invalid games fail atomically with zero partial chapters written)

Provider dispatch (engine and LLM) is verified to remain at baseline when invalid FENs are submitted. Corrupt historical StudyPartner sessions return 422 instead of crashing with unhandled 500 or dispatching to engine/LLM.

### 5. Engine-Neutral Initial Position Port & Repository Default Resolution
To fix variant-derived default FENs (such as Horde and Racing Kings) across study chapter creation and PGN import without hardcoding engine logic into domain or persistence packages:
- An engine-neutral interface `InitialPositionPort` is defined in `@chess-platform/studies`:
  ```typescript
  export interface InitialPositionPort {
    initialFen(variant?: StudyVariant): string;
  }
  ```
- The existing `PositionReader` port extends `InitialPositionPort`.
- Both `InMemoryStudiesRepository` and `PgStudiesRepository` require `positionReader: InitialPositionPort` via mandatory constructor injection.
- When creating a chapter (`createChapter`), both repositories consistently resolve `startingFen !== undefined ? startingFen : this.positionReader.initialFen(study.variant)`. When importing PGN (`importPgn`), missing `[FEN]` tags resolve via the same canonical repository port `tagValue(game, 'FEN') || this.positionReader.initialFen(study.variant)`. The operation-supplied `PositionReader` passed into `importPgn` is preserved for legal SAN evaluation, move resolution, and tree construction.
- **Export Omission Policy & Round-Trip Fidelity (Qodo fef0004f)**: In `exportPgn`, both repositories omit the `[FEN]` tag if and only if `chapter.startingFen === this.positionReader.initialFen(study.variant)`. When `startingFen` differs from the variant's canonical start (including legacy Standard starts stored in variant studies or custom positions), the explicit `[FEN]` tag is emitted. On reimport, exact stored positions are preserved; canonical starts restore canonical defaults without redundant tags, and invalid legacy setups fail closed under strict ingress validation rather than silently canonicalizing to another position. Unused `DEFAULT_STARTING_FEN` constants are removed from repository implementations.
- The `POST /v1/studies/:id/chapters` route handler in `@chess-platform/api` does not compute a competing default; it leaves `startingFen` undefined when omitted and validates against `coreFenValidator` only when an explicit FEN is provided.
- In production compositions (`bootstrap.ts`, `fakes.ts`, `harness.ts`), `CorePositionReader` from `@chess-platform/api` is injected, delegating `initialFen` to `Position.initial(variant).fen()`.
- Package boundaries remain clean and dependency-free; no database schema migrations or stored study rewrites are required.

### 6. Atomic Strict Input vs. Derived Terminal Leaves & Tactical Blast Threats
- **Two-King Input Invariant**: No 1-king exception is introduced into FEN ingress validation. Input validation strictly requires 2 kings for Atomic positions.
- **Derived Terminal Leaves**: A legally played Atomic winning move (e.g. `Nxd5` or `Qxf7` exploding Black's king) produces a 1-king terminal state that can be appended, stored, read, and exported via PGN as a leaf node.
- Attempting to continue past that terminal leaf, append further moves, or forge a 1-king starting FEN strictly returns HTTP 422 with zero partial writes.
- **Tactical Blast Threats vs. Check (Qodo 28f1a7ad Clarification)**: In Atomic chess rules (aligned with actual Lichess Atomic rules and verified against isolated python-chess 1.11.2 variant oracle), an attack on an enemy piece adjacent to the enemy king constitutes a tactical explosion threat, NOT a check on the king itself. A king is in check only when its own square is directly attacked (and kings are not connected). For example, after `1. e4 Nc6 2. Qh5 a6`, White's queen attacks `f7`, which is adjacent to Black's king on `e8`. Black's move `2... a6` is legal, and the resulting position `r1bqkbnr/1ppppppp/p1n5/7Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3` is valid, legal, and in progress. On move 3, White can play `3. Qxf7#` (`h5f7`), detonating the queen, pawn, and king. Ingress validation correctly accepts this position without falsely treating blast threats as illegal opposite-check.

## Consequences & Verification

- **Verification Evidence**:
  - Initial baseline probe on HEAD `e1797525b7f736e15dd69cafb80327fb691c5622` confirmed 5/5 behavioral RED failures (king capture generated, pocket king dropped, adjacent kings accepted, side-not-to-move in check accepted, pocket king accepted); unchanged candidate probe passed 5/5 GREEN.
  - Coordinator independently reran 27 focused tests across core (14), API ingress (5), and game stored-history (8): 27 passed, 0 failed, 0 skipped.
  - Follow-up fixture correction: Black rook capture fixture corrected to `4r1k1/8/8/8/8/8/8/4K3 b - - 0 1` (asserting `e8e1` capture omitted and rejected); expanded six-case probe verified baseline fails 6/6 (exit 1) and candidate passes 6/6 (exit 0); author executed core package tests (`npm test -w @chess-platform/core`) passing 182/182 tests and compiled `fen-legality-125.test.js` passing 14/14 tests. Subsequent root independent rerun verified baseline 6 FAIL exit 1 (`outputs/issue125-root-six-red.log`), candidate 6 PASS exit 0 (`outputs/issue125-root-six-green.log`), and full core npm test 182 PASS, 0 FAIL, 0 SKIP exit 0 (`outputs/issue125-root-corrected-core.log`).
  - Qodo review responses: supported finding `c8aa2377-bed4-4dbf-9a10-710c4d4e6716` resolved via unified `InitialPositionPort` default in `createChapter` and `importPgn` across repositories, with route competing default removed; supported finding `fef0004f-9b60-47dd-9414-3e299656aebf` resolved via unified `InitialPositionPort` export omission policy in `exportPgn` across both repositories; finding `28f1a7ad-c140-45ca-812b-ebcfa614211f` clarified with Lichess and python-chess 1.11.2 oracle-verified positive regressions in core (`fen-legality-125.test.ts`) and API (`fen-ingress-125.test.ts`). Provider disposition for all findings remains pending root owner actions.
  - Author-observed unit verification counts: `@chess-platform/studies` 63/63 PASS; `@chess-platform/persistence` 113/113 PASS (unit tests; live PostgreSQL integration PASS not claimed); `@chess-platform/core` 183/183 PASS; `@chess-platform/api` fen-ingress 7/7 PASS.
  - Zero OpenAPI specification drift on `packages/api/openapi.json`.
  - Zero lint errors across `@chess-platform/core`, `@chess-platform/api`, and `@chess-platform/studies`.
  - Zero `as any` introduced across all touched packages.
- **Remaining Limitations**:
  - Independent root integrated CORE13 gate execution, renewed new-head review, remote CI, and review provider disposition on Qodo findings remain pending root owner actions.
  - Live PostgreSQL integration tests and real binary engine smoke tests remain root-owned.
  - Full repository CI and gateway clean-install verification remain root-owned.
