# ADR-0143 — Historical Tournament Withdrawal State Preservation

**Status:** Accepted
**Date:** 2026-09-20
**Context:** Tournament Aggregate Historical Standings Accuracy (PR Isolation Task)

## Context

Prior to this change, `Tournament.standingsAfterRound(roundIndex)` correctly computed historical game points and tiebreaks up to `roundIndex` by filtering match results, but evaluated player withdrawal status using the aggregate's current `Set<string> withdrawn`.

Consequently, temporal withdrawal information was lost:
- A player actively competed in rounds 0 and 1.
- The player withdrew during round 2.
- A caller later requested `standingsAfterRound(0)`.
- The returned standing for that player showed `withdrawn = true`, retroactively applying an event from round 2 to round 0 when the player was active.

As noted in `packages/tournament/src/tournament.ts`, resolving this correctness gap requires recording the round at which each player withdrew and persisting that information in `TournamentSnapshot`.

## Decision

### 1. Per-Player Withdrawal Round Tracking
In `packages/tournament/src/tournament.ts`, the `Tournament` aggregate tracks per-player withdrawal round indices via an internal map:
```typescript
private readonly withdrawalRounds = new Map<string, number>();
```

### 2. Zero-Based Round Semantics and Pre-Advance Capture
When a player withdraws while the tournament is in the `running` state:
- The current 0-based round index (`this.rounds[this.rounds.length - 1].roundIndex`) is recorded immediately.
- Critically, this round index is recorded **before** executing forfeit side effects and before calling `this.tryAdvance()`. If forfeiting an unfinished game resolves the current round and causes `tryAdvance()` to advance the tournament or transition to `finished`, the withdrawal is accurately associated with the round in which the withdrawal occurred, never the newly advanced round.

### 3. Idempotency (First Withdrawal Wins)
Repeated calls to `withdraw(playerId)` for a player already marked withdrawn return early without updating `this.withdrawalRounds`. The initial withdrawal round is authoritative.

### 4. Registration-Phase Withdrawal Invariance
If a player withdraws during `registration`, they are removed from `participants` exactly as before. Because they never competed in a tournament round, no historical withdrawal entry is created or persisted.

### 5. Additive Snapshot Contract and Defensive Copying
`TournamentSnapshot` is extended with an optional, backward-compatible field following existing tuple-array conventions:
```typescript
readonly withdrawalRounds?: readonly (readonly [string, number])[];
```
`toSnapshot()` serializes a defensive copy via `Array.from(this.withdrawalRounds.entries())`. `Tournament.restore()` populates internal state defensively via `Map` constructor. Callers cannot mutate aggregate state by modifying snapshot objects.

### 6. Legacy Snapshot Backward Compatibility
Existing persisted tournament snapshots lack `withdrawalRounds`. They continue to restore without error:
- When a restored snapshot contains players in `withdrawn` but omits `withdrawalRounds`, `standingsAfterRound(roundIndex)` preserves legacy observable semantics (reporting `withdrawn = true` across all historical rounds) rather than fabricating an arbitrary withdrawal round.
- Modern snapshots with `withdrawalRounds` provide truthful per-round historical status (`withdrawn = roundIndex >= withdrawalRound`).
- Current standings via `Tournament.standings()` continue to report current withdrawal status unchanged.

### 7. No Database Migration or Persistence Changes
`TournamentSnapshot` is stored as opaque `JSONB` in the `tournaments` table (`packages/persistence/migrations/0003_tournaments.sql`). Adding an optional snapshot property requires zero database schema migrations and zero changes to `packages/persistence/**`.

### 8. Scoring and Pairing Invariance
Scoring rules, tiebreaks (Buchholz, Sonneborn-Berger, Median Buchholz), Swiss pairing, Round Robin pairing, game linking, game launch attempts, and Arena tournaments remain strictly unchanged.

### 9. Strict Open-PR Isolation
This change has zero file overlap with open PRs #55, #56, and #57, and touches only `packages/tournament/**` and this ADR.

## Consequences

- `Tournament.standingsAfterRound(roundIndex)` reports truthful historical withdrawal status: players active in earlier rounds are reported as `withdrawn: false` in those rounds.
- Legacy snapshots remain backward-compatible without database migration.
- `Tournament.standings()` behavior is preserved identically.
- Downstream packages maintain zero type drift.
