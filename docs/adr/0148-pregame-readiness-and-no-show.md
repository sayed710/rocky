# ADR-0148 — Durable player readiness, first-move clock start and source-specific no-show

**Status:** Proposed for owner review
**Date:** 2026-09-26

## Context

Verified on `main` at `deba3a8`:

- `Game.reduce` seeded every game's clock with `initClock(timeControl, GameCreated.at)`, so White's first move was charged for everything since creation, including the time before either player saw the board (audit §5, "creator loses ~10 s").
- Nothing recorded whether a player had arrived. Room membership and `presence` frames are per-node and transient, and move admission checked only turn and legality.
- Nothing ended a game nobody played. A seek or tournament game with an absent player stayed ongoing forever, the seek receipt redirected to it for its five-minute window, and a tournament round waited on it indefinitely.
- The event log already serializes writers: `GameAuthority` applies commands under a per-game lock on the owning replica (ADR-0010), and every append carries `expectedSeq`, enforced by the `(game_id, seq)` primary key in `PostgresEventStore`.
- `MovePlayed` stores `moveTimeMs`, and replay charges exactly that. A stored stream therefore replays to the same clocks whatever the live anchor rule is.
- The tournament domain already has a `double_forfeit` result, scored zero for both in round-based standings and a loss for both in arenas. `TournamentResultReporter` mapped every `'*'` ending to `abandonGame`, which relaunches the pairing.

Four creation paths exist:

| Path | Code | Players | Classification |
|---|---|---|---|
| Seek acceptance | `POST /v1/seeks/:id/accept` in `packages/api/src/routes.ts` | two humans | human seek |
| Tournament pairing | `DurableGameLauncher` in `packages/api/src/tournament/durable-launcher.ts` (API replicas and the gateway's reporter) | two humans | tournament |
| Play vs Computer | `POST /v1/games/bot` in `packages/api/src/routes.ts` | one human and a first-party engine account | human vs bot |
| Direct / harness | `GameAuthority.createGame` via `packages/e2e-harness/src/harness.ts` and `packages/e2e-harness/src/launcher.ts` | test identities, often the harness random bot | infrastructure / test only |

A first-party engine never joins a room, so it can never become ready. Requiring readiness in a bot game would lock it, and a no-show deadline would end games whose human is present. `createGame` is called in production only through the paths above; its remaining callers are the e2e harness and tests.

## Decision

1. **Durable source.** `GameCreated` gains an optional, unversioned `source: 'seek' | 'tournament'`, written by seek acceptance and `DurableGameLauncher` only. Bot games, direct/harness games and every stored game have no source and keep exactly the lifecycle they had: clock anchored at creation, no readiness, no no-show. An unknown stored source fails the fold rather than being guessed.
2. **Durable readiness.** A new `PlayerReady { by, at }` event records that a seat is ready. It is written only by the domain's `markReady`, which emits it only for a sourced game that is ongoing, has no move, and whose seat is not ready yet. Every other call is a no-op with no events, so duplicate joins, several tabs, reconnects and racing replicas can neither duplicate it nor fail. Readiness never reverts; a disconnect changes nothing.
3. **Where readiness comes from.** After an authenticated join resolves a seat (`RealtimeGateway.completeJoin`), the gateway routes a `ready` command through the command router, so the game's single owner applies it under the game's command lock and appends it with `expectedSeq`. Spectators, anonymous connections and tokens for other users never get a seat, so they never route it. The wire decoder produces neither `ready` nor `expireNoShow`, so a client cannot send one. A losing append (another seat's readiness or a move committed first) reloads the owner's copy and surfaces as `invalid_command`; the gateway re-routes up to three times, re-deciding against the durable log, and reports a final failure to the client. The next join tries again.
4. **First-move clock.** A sourced game's clock has no anchor until the first move: `initClock(timeControl, null)`. `charge` treats a null anchor as zero elapsed, so the first move consumes no chess time (only the increment applies, as before), and its server timestamp becomes the anchor for the opponent's running clock. Before it, `hasFlagged` is always false, so no flag can be claimed. Later moves are unchanged. Unlimited games keep no anchor at all. Replay uses the stored `moveTimeMs`, so it never reads the wall clock and old streams replay exactly.
5. **Move admission.** `Game.playMove` refuses the first move of a sourced game until both seats are ready (`awaitingReadiness`). The authority checks the same condition first to answer the new reject code `not_ready`. Because readiness and moves are applied by one owner in arrival order and appended with `expectedSeq`, a move evaluated before a readiness commits is refused, never admitted early.
6. **No-show rule.** `Game.noShowVerdict(afterMs, at)` decides a sourced game with no move once `at ≥ GameCreated.at + afterMs`:
   - seek: `GameEnded { result: '*', termination: 'no_show', winner: null }` whoever was ready, because the seek deadline governs the whole wait for the first move;
   - tournament, one seat ready: that player wins (`1-0` or `0-1`, `termination: 'no_show'`);
   - tournament, neither ready: `'*'`, `termination: 'no_show'`, no winner (a double forfeit);
   - tournament, both ready: no ending; the game waits for the first move with full clocks.
   `no_show` is a new termination, never `timeout` or `aborted`.
7. **Server-authoritative expiry.** `NoShowExpiryWorker` (`services/gateway/src/no-show-expiry.ts`) runs on every gateway with `DATABASE_URL`. Each pass reads a page of possibly-due games from the `games` projection (`PgNoShowCandidates`, served by the partial index `games_pregame_pending_idx`), re-decides each from the durable event log, and routes `expireNoShow` as the reserved actor `NO_SHOW_ACTOR` to the owning replica, exactly like a player command. The owner re-decides under the command lock with its own clock. Deadlines come from `NO_SHOW_SEEK_MS` (default 60 000) and `NO_SHOW_TOURNAMENT_MS` (default 300 000), validated as positive integers, measured from `GameCreated.at`; `NO_SHOW_SCAN_MS` (default 5 000) sets the poll. No browser, room or Redis timer is involved.
8. **Concurrency.** Exactly one of a first move and an expiry can commit: both run on the owner under one lock, the domain refuses the expiry after a move and the move after the ending, and a stale owner's append fails the `expectedSeq` check, reloads, and is refused. Two workers deciding one game both route to its owner; the second finds it over. Nothing can follow `GameEnded`.
9. **Recovery and bounds.** The worker keeps no state that correctness depends on. A crash before the append is retried by the next pass; one after it finds the game ended; a restart catches up on every overdue game in its first passes. Each pass reads at most 50 candidates after a rotating keyset cursor, so a game that keeps failing cannot starve others. Tournament games whose players are both ready stay in the pending index, so the worker remembers up to 10 000 of them in memory rather than re-reading their logs. A claim made only to expire a game with no local room is released afterwards, so an expired game does not keep a lease and an owner consumer. Shutdown stops scheduling and awaits the in-flight pass before Redis and the pool close.
10. **Tournaments.** `TournamentResultReporter` maps a `no_show` ending with no winner to `double_forfeit`, so it is recorded as a decided result and never reaches the aborted-game relaunch. A `no_show` with a winner maps like any decisive result. Recovery, idempotency and restart behaviour are the committed-terminal-event contract of ADR-0144, unchanged. The tournament domain needed no change.
11. **Projection.** `projectGameStream` projects `GameCreated.source` into a new `games.source` column. `PlayerReady` advances `last_seq` but not the projected ply count. A no-show ending projects its result, `termination = 'no_show'` and `ended_at` through the existing single writer (ADR-0147), so history, `GET /v1/games/:id` and the ended-game seek receipt guard become truthful without a second projection path.
12. **Protocol and UI.** `StateView.ready` carries each seat's durable readiness, or `null` for a game without a source. A `ready` broadcast on the game channel carries both seats to every replica's rooms and is replayed on resume. The web client reads a missing or malformed `ready` as `null`, merges broadcasts monotonically, keeps the board closed while a seat is not ready, and describes waiting and no-show states. The browser is never the authority for readiness or time.
13. **Migrations.** 0042 inserts the `no_show` termination and adds `games.source` with a `NOT VALID` check, so nothing scans `games` under the exclusive lock; 0043 validates the check without blocking writes; 0044 builds `games_pregame_pending_idx (started_at, id) WHERE source IS NOT NULL AND result IS NULL AND ply_count = 0` concurrently. The index exists for the candidate query in point 7 and holds only games still waiting for a first move.

## Alternatives rejected

- **Presence as readiness.** Room membership and Redis presence are per-node and vanish on disconnect or restart, so they cannot decide an outcome.
- **Anchoring the clock at "both ready".** The owner policy is that waiting after both are ready consumes no chess time; the first accepted move is the only anchor that satisfies it.
- **Appending the ending directly from the worker.** It would leave the owner's cached copy stale, so joins and resumes on that replica would show an ongoing game until its next failed append.
- **A per-game timer (browser, room or Redis key).** It does not survive restarts and would need its own claim protocol; the event log already has one.
- **Scanning `game_events` for pending games.** Every pass would walk all historical sourced games. The partial projection index shrinks as games start or end.
- **Recording the deadline on `GameCreated`.** It would bind the API to the worker's configuration. The deadline is derived from the durable creation time plus configuration, which is deterministic for any fixed configuration.

## Limits and follow-ups

- Expiry happens within one scan interval after both the deadline and the game's projection. Projection lag (ADR-0147's cluster-wide horizon) delays it; it never loses it.
- A configuration change applies to games already waiting.
- A game created before this change and still in progress keeps its creation-anchored clock and has no readiness or no-show.
- During a rolling deploy, a replica running the previous release cannot fold a stream that contains `PlayerReady` (its reducer does not know the event) and cannot project `games.source` before 0042 runs; its joins to such games fail until it is replaced, and its projector batches retry. Run the migrations before the new release, and replace every gateway replica in one rollout.
- A present player may still `abort` before the second move, which for a tournament game remains the existing aborted-game relaunch. Tightening that is a separate tournament rule.
- Bot and direct games keep the original lifecycle, including the first move charged from creation.
- Autonomous in-play flag expiry after the first move is the next increment. Ratings, rating pools and leaderboards are unchanged; no-show endings carry no rating semantics.
