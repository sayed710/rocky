# ADR-0150 — Durable, exactly-once ratings with explicit variant × speed pools

**Status:** Proposed for owner review
**Date:** 2026-09-27

## Context

Verified on `main` at `6f141e1` (after PR #73, ADR-0149):

- `ratings` was keyed by `(user_id, variant)`, with no speed. Nothing at runtime wrote it (`RatingsRepository.upsert` had no production caller), so the leaderboard was empty and no profile showed a rating after a rated game (`FABLE_ASTRA_FULL_AUDIT.md` §14 #4).
- `packages/persistence/src/glicko2.ts` is a pure Glicko-2 implementation (1500 / 350 / 0.06, τ 0.5) that takes a batch of results but defines no rating period and no inactivity RD growth.
- `classifySpeed` already produces six speed classes, with unlimited time controls classified as `correspondence`.
- Bot games are created with `rated: false`, tournament games with `rated: true`. Direct/harness games carry the caller's `rated`. `GameCreated.source` exists only for seek and tournament games (ADR-0148).
- `game_events.xact_id` and ADR-0147's committed-prefix scan already give a durable, replay-stable order for committed events.

## Owner decisions applied

These are the owner's decisions for this increment, not engineering inferences.

1. **Pool identity** is `variant × speed`, using all six speed classes unmerged. Each combination is independent.
2. **Correspondence.** Rated unlimited games rate in their variant's `correspondence` pool.
3. **Tournaments.** Played tournament games are rated. There is no per-tournament setting.
4. **Tournament one-player no-show** decides the tournament result only and changes no rating.
5. **Tournament double forfeit** changes no rating.
6. **Ordinary endings** of an eligible rated game are all rated alike: checkmate, resignation, timeout, stalemate, agreement, insufficient material, fifty-move, threefold, and variant-specific wins and draws. There are no special exclusions.
7. **Pre-first-move aborts and seek no-shows** are never rated. Any ending with no score or with aborted semantics is ineligible.
8. **Bots.** Games involving an engine bot or any other bot account are never rated. A direct-created human-vs-human game may be rated when its durable `GameCreated.rated` is true; no particular source is required.
9. **Consumers** get no silent speed fallback. The leaderboard takes an explicit speed, the profile lists distinct pools, and the seek range check uses the seek's own pool.
10. **Legacy rows.** The migration fails closed with an operator-facing message if variant-only rows exist. It never copies, guesses or deletes them.
11. **Glicko model.** One update per eligible game, each game its own rating period. There is no inactivity RD growth and no fixed periods.
12. **Ordering** is an engineering decision: the smallest deterministic durable order, reusing the `xact_id` committed prefix if it is sufficient.

## Decision

1. **Schema.** Migration 0044 refuses legacy variant-only `ratings` rows, adds `speed` to the primary key, and creates `rating_checkpoint`, `rating_applications` and `rating_blocked_games`. Migration 0045 builds `game_events_ended_order_idx (xact_id, server_ts, game_id) WHERE type = 'GameEnded'` online. Migration 0046 preserves the checksums of both published predecessors while replacing arbitrary rating, RD and volatility caps with finite-value checks. It adds blocked-game disposition fields and `rating_ineligible_games` for durable exclusions. It freezes previously acknowledged but unrecorded exclusions as `pre_upgrade` while holding the checkpoint lock. A checkpoint trigger also records skips made by a 0044 applier still running during a rolling deploy. The one-time backfill can delay rating application during upgrade; schedule it in a quiet window if the checkpoint covers a large history. The three per-game decision tables have mutually exclusive insert triggers that serialize by game id, so a race cannot commit conflicting decisions. The leaderboard index is `(variant, speed, rating DESC)`.
2. **Eligibility is folded from the stream** (`decideRating` in `packages/persistence/src/rating-eligibility.ts`). The stream is validated by the same `projectGameStream` the games projector uses, then:
   - The stream must be one the authority could have written, or the game is blocked (not rated, not skipped): `rated` must be a boolean, the time-control kind must be known, the result must be one `Game` records for that termination, `GameEnded.winner` must match the result, and a player must not face themself. `Game` records checkmate, resignation and timeout only as decisive; stalemate, agreement, insufficient material, fifty-move and threefold only as draws; a variant ending as either; `aborted` only as `*`; and `no_show` as `*` or decisive.
   - `rated = false` is ineligible (`casual`).
   - `aborted`, `no_show` (any source, any result) or a `*` result is ineligible (`no_result`).
   - A reserved engine-bot id or a seat that is not an account-shaped UUID is ineligible (`not_human`).
   - Everything else is rated in `(GameCreated.variant, classifySpeed(GameCreated.timeControl))`.

   Before any rating write, the applier also requires `GameCreated.variant` to be a row of `variants`, the catalog `ratings.variant` references. That table is the authority the foreign key enforces, so no second list can drift from it. Any other variant makes the game blocked instead of failing the foreign key on every retry and stopping every pool.

   The applier then checks the accounts in the database. A missing account, or one with `users.flags.bot = true`, is ineligible. No caller, client or projection supplies any of these facts. The first ineligible decision is recorded by game id and reused on replay, even if account flags or existence later change.
3. **Order.** Ratings in one pool depend on every earlier rating of both players there, and transitively on their opponents'. So each pool needs one total order that live processing and every replay share. `PgRatingsApplier` walks committed `GameEnded` rows in `(xact_id, server_ts, game_id)` order, reading only rows below `pg_snapshot_xmin(pg_current_snapshot())`. ADR-0147 proved that a transaction still running then has an id at or above that horizon, so no ending can later appear before a position already passed. The order a live run applies is therefore exactly the order any later replay of the same log applies.

   Within one `xact_id` the ending's `server_ts` breaks ties. The known case of many endings in one transaction is migration 0040's column fill: and they keep their original insert times, so the historical backfill is ordered by when games ended rather than by UUID. `game_id` is only the last tie-breaker for identical timestamps inside one transaction. The cursor carries `server_ts` as text, so it keeps full microsecond precision.
4. **Exactly once, atomically, per batch.** A batch is one transaction:
   1. Read the horizon (first statement).
   2. Lock `rating_checkpoint` `FOR UPDATE SKIP LOCKED`. Another replica gets `busy` and does nothing.
   3. Read the horizon again, for the rewind test in 8 only. Another applier may have committed a checkpoint past the first horizon while this one waited for the lock. Compared with the first horizon, that ordinary progress would look like a restore and replay the whole history.
   4. Read up to 200 endings after the checkpoint and below the first horizon. In the case above this page is empty, so the batch changes nothing.
   5. Rate each game.
   6. Advance the checkpoint.

   All of this commits together. For one game (`applyRatedGame`): create both pool rows at the Glicko-2 defaults if missing (`INSERT … ON CONFLICT DO NOTHING`), and `SELECT … FOR UPDATE` them one at a time in player-id order, whatever the colours. Compute both new ratings from those pre-game rows with `rateGame`. Insert the ledger row `ON CONFLICT (game_id) DO NOTHING`, and if that inserted nothing, roll back to the game's savepoint and report `already_applied`. Otherwise update both rows. A crash or error anywhere before `COMMIT` leaves the ratings, the ledger and the checkpoint all unchanged. Nothing is acknowledged before the transaction that applies it commits.
5. **Concurrency.** The checkpoint lock serializes appliers, so a player's games are applied in log order and never concurrently. Independently of it, the ledger primary key makes a second application of a game impossible: a racing transaction waits on the first's row locks or uncommitted rows, then finds the ledger row. Player-id lock order means two transactions sharing players cannot deadlock through colour order. First-row creation is safe under concurrency because a second insert of the same key waits for the first and then does nothing.
6. **Failures.**
   - Only a deterministic verdict on a stream that loaded successfully makes a sticky block: a `CorruptGameStreamError` from `projectGameStream` or `decideRating` (the checks in 2), or a variant outside `variants`. The game is recorded in `rating_blocked_games` in the same transaction and logged at error level, and the checkpoint passes it. An existing block is checked before any automatic application, including after a rewind. An operator can inspect it and record a `leave_blocked` disposition through the CLI; no single-game historical retry exists.
   - Everything else aborts the whole batch and is retried, and never blocks a game. That covers loading the stream (including an event version this gateway has no upcaster for, as a newer gateway can write during a rolling deploy), rating-table failures, lost connections, timeouts, lock failures, and any other error whatever its class: a `TypeError`, a `RangeError`, a generic `PersistenceError` or any SQLSTATE. In particular, a SQLSTATE class 22 or 23 failure is not evidence of bad event data. Nothing moves, and the worker retries with exponential backoff up to 30 s. A previously applied game is recognized from its ledger entry before current account flags are read, so a later account change cannot reclassify it on rewind.
7. **Runtime.** Every gateway with `DATABASE_URL` runs the applier through the existing checkpointed-batch worker (`GamesProjectionWorker`, now generic over the batch type). It works back-to-back while pages are full and polls every second when caught up. Shutdown awaits the in-flight batch before the pool closes.

   No pub/sub or wake is involved. Each poll re-reads the committed log, so a lost notification, a crash or a restart only delays ratings. `ratings_games_total{outcome=applied|already_applied|ineligible|blocked|already_blocked}` and `ratings_batch_failures_total` have bounded labels. `blocked` counts only blocks recorded by that batch, and only those are listed and logged as new. A replay that meets an earlier block counts `already_blocked`, so a rewind does not look like a new incident. `GambitRatingsGameBlocked` fires when `increase(ratings_games_total{outcome="blocked"}[15m])` is positive, so it fires for a new block and clears after 15 minutes. A counter that is merely high from old blocks, or reset by a restart, does not fire it. A separate ten-second indexed probe exports `ratings_oldest_pending_ending_age_seconds`; its failures increment `ratings_backlog_sample_failures_total` without stopping application. The age sees committed endings even when a long transaction holds the apply horizon back.
8. **Backfill and restore.** The checkpoint starts at the origin, so the first run after deploy applies eligible historical endings in the same order as live endings. It is restart-safe (the checkpoint) and idempotent (the ledger). A same-cluster checkpoint rewind replays already-applied games safely. A checkpoint at or above the horizon read after the checkpoint lock (4.3) came from another cluster's transaction counter, so the batch restarts from the origin. A cross-cluster logical restore may preserve `game_events.xact_id` values above the destination's transaction counter; an origin rewind alone cannot process those rows, and new endings could otherwise rate first. The applier detects that lower-counter case and stops before advancing the checkpoint. This check cannot prove that every cross-cluster restore is safe: a destination with a higher transaction counter may evade it. A physical restore that preserves cluster transaction history is the supported automatic recovery route. Every cross-cluster logical restore requires an operator-controlled ordering plan before gateways resume; the backup drill's isolated restore must never be promoted as an automatic ratings recovery.
9. **Consumers.**
   - `RatingsRepository` is read-only. It offers `get(user, variant, speed)`, `listForUser(user)` (every pool, by variant and then fastest speed first) and `leaderboard(variant, speed, limit)`. `upsert` is removed; only the in-memory test fake keeps a seeding method.
   - The REST leaderboard is `GET /v1/leaderboard/:variant/:speed`. The variant-only route is gone (404), and an unknown speed is a 422.
   - `RatingView` and `LeaderboardEntry` carry `speed`, and the profile and `/v1/users/:handle/ratings` list every pool separately.
   - Seek acceptance checks the acceptor's rating in `(seek.variant, classifySpeed(seek.timeControl))`. With no row there, the acceptor stands at the Glicko-2 start (1500), never at another pool's rating.
   - The web leaderboard adds a time-control selector that opens on a disabled prompt and loads nothing until a speed is chosen. Profile rows read `Variant · Speed: rating (RD n)`.
   - Tournament pairing, GraphQL, search and achievements read no ratings.

## Alternatives rejected

- **Consuming the `games` projection.** It is derived and lags the log, and a rebuild re-folds it. Taking ratings from it would tie rating truth to its checkpoint and failure retries. The applier reads the same committed events directly, reusing the projection's pure fold only for validation.
- **Hooking the authority's `GameEnded` broadcast, or Redis.** Pub/sub is at most once and ordered by delivery, not by commit. A lost message would lose a rating, and two replicas would race without a defined order.
- **Per-consumer receipts (ADR-0144's `TerminalEventReconciler`).** It finds unprocessed endings without an order. That is sufficient for idempotent analyzers but not for order-sensitive ratings: a retried failure would apply after later games.
- **Ordering by `GameEnded.at` or `server_ts` alone.** A transaction can commit after a later-stamped one, so a cursor over timestamps can skip or reorder a late commit, and replay would diverge from live.
- **Per-player or per-pool parallel application.** Correctness only needs one order per pool, and pools are independent. However, the stable order comes from one global committed-prefix scan, and a game's pool is known only after its stream is read. Splitting application by pool would add a discovery queue and cross-worker coordination for throughput current volumes do not need. A 200-game batch is one short transaction. See the limits below.
- **A check-then-insert exactly-once test in application code.** It is racy without serialization. The ledger's primary key is the guard, written in the rating transaction.

## Limits and follow-ups

- **One applier at a time.** Throughput is one batch transaction at a time for the whole cluster. The upgrade path, if volume demands it, is a pool-partitioned pending queue filled by the ordered scan.
- **No time decay.** No inactivity RD growth is applied (owner decision 11), so a returning player's RD is where they left it. Time-based RD decay needs its own decision and a replay-safe definition of elapsed time.
- **No RD cap.** RD can rise above 350; the schema rejects non-finite values but imposes no arbitrary numeric ceiling. There is no provisional-rating display.
- **Deleted accounts.** No account-deletion API exists. A plain SQL deletion of a player with a projected game is normally refused by `games` foreign keys. If an operator handles those references and deletes the account, its rating rows cascade, while the application ledger retains UUIDs. Pending games with a missing account become ineligible. Privacy and historical-rating policy require an owner decision before supporting product deletion.
- **Blocked games** remain unrated under replay. The operator CLI supports inspection and a durable `leave_blocked` disposition, not a mathematically unsound one-game retry. Recovering a historical blocked game after later ratings needs a full affected-pool rebuild under an approved plan.
- **Cluster-wide horizon.** As with ADR-0147, a long-running or idle-in-transaction session anywhere delays ratings. The age gauge makes this visible. The lower-counter cross-cluster restore guard catches one unsafe case; all cross-cluster logical restores remain outside automatic recovery.
- **Pre-migration data.** Deployments that already hold variant-only rating rows cannot migrate until an operator decides what those rows mean.
