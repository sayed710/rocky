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

1. **Schema (migration 0044).** A `DO` block counts `ratings`. If any row exists it raises with operator instructions, and the whole migration rolls back (decision 10). Otherwise `ratings` gains `speed` with a six-value `CHECK`, and the primary key becomes `(user_id, variant, speed)`. Bounded `CHECK`s reject NaN and ±Infinity (`rating BETWEEN -10000 AND 10000`, `0 < rd <= 1000`, `0 < vol < 1`). The leaderboard index becomes `(variant, speed, rating DESC)`. The migration also adds three tables: `rating_checkpoint`, a single row; `rating_applications`, the ledger with primary key `game_id`; and `rating_blocked_games`. Migration 0045 builds `game_events_ended_order_idx (xact_id, server_ts, game_id) WHERE type = 'GameEnded'` online.
2. **Eligibility is folded from the stream** (`decideRating` in `packages/persistence/src/rating-eligibility.ts`). The stream is validated by the same `projectGameStream` the games projector uses, then:
   - An unknown termination or result, or a player facing themself, throws, so the game is blocked, not rated and not skipped.
   - `rated = false` is ineligible (`casual`).
   - `aborted`, `no_show` (any source, any result) or a `*` result is ineligible (`no_result`).
   - A reserved engine-bot id or a seat that is not an account-shaped UUID is ineligible (`not_human`).
   - Everything else is rated in `(GameCreated.variant, classifySpeed(GameCreated.timeControl))`.

   The applier then checks the accounts in the database. A missing account, or one with `users.flags.bot = true`, is ineligible. No caller, client or projection supplies any of these facts.
3. **Order.** Ratings in one pool depend on every earlier rating of both players there, and transitively on their opponents'. So each pool needs one total order that live processing and every replay share. `PgRatingsApplier` walks committed `GameEnded` rows in `(xact_id, server_ts, game_id)` order, reading only rows below `pg_snapshot_xmin(pg_current_snapshot())`. ADR-0147 proved that a transaction still running then has an id at or above that horizon, so no ending can later appear before a position already passed. The order a live run applies is therefore exactly the order any later replay of the same log applies.

   Within one `xact_id` the ending's `server_ts` breaks ties. The known case of many endings in one transaction is migration 0040's column fill: and they keep their original insert times, so the historical backfill is ordered by when games ended rather than by UUID. `game_id` is only the last tie-breaker for identical timestamps inside one transaction. The cursor carries `server_ts` as text, so it keeps full microsecond precision.
4. **Exactly once, atomically, per batch.** A batch is one transaction:
   1. Read the horizon (first statement).
   2. Lock `rating_checkpoint` `FOR UPDATE SKIP LOCKED`. Another replica gets `busy` and does nothing.
   3. Read up to 200 endings after the checkpoint.
   4. Rate each game in a savepoint.
   5. Advance the checkpoint.

   All of this commits together. For one game (`applyRatedGame`): create both pool rows at the Glicko-2 defaults if missing (`INSERT … ON CONFLICT DO NOTHING`), and `SELECT … FOR UPDATE` them one at a time in player-id order, whatever the colours. Compute both new ratings from those pre-game rows with `rateGame`. Insert the ledger row `ON CONFLICT (game_id) DO NOTHING`, and if that inserted nothing, roll back to the game's savepoint and report `already_applied`. Otherwise update both rows. A crash or error anywhere before `COMMIT` leaves the ratings, the ledger and the checkpoint all unchanged. Nothing is acknowledged before the transaction that applies it commits.
5. **Concurrency.** The checkpoint lock serializes appliers, so a player's games are applied in log order and never concurrently. Independently of it, the ledger primary key makes a second application of a game impossible: a racing transaction waits on the first's row locks or uncommitted rows, then finds the ledger row. Player-id lock order means two transactions sharing players cannot deadlock through colour order. First-row creation is safe under concurrency because a second insert of the same key waits for the first and then does nothing.
6. **Failures.**
   - Errors caused by the stream's own data (a `PersistenceError`, a `TypeError`/`RangeError`, SQLSTATE classes 22 and 23) roll back that game's savepoint. The game is recorded in `rating_blocked_games` in the same transaction and logged at error level, and the checkpoint passes it. It is never rated automatically, because rating it later would apply it out of order. An operator decides.
   - Any other error (lost connection, timeout, lock failure, injected `XX000`) aborts the whole batch. Nothing moves, and the worker retries with exponential backoff up to 30 s.
7. **Runtime.** Every gateway with `DATABASE_URL` runs the applier through the existing checkpointed-batch worker (`GamesProjectionWorker`, now generic over the batch type). It works back-to-back while pages are full and polls every second when caught up. Shutdown awaits the in-flight batch before the pool closes.

   No pub/sub or wake is involved. Each poll re-reads the committed log, so a lost notification, a crash or a restart only delays ratings. `ratings_games_total{outcome=applied|already_applied|ineligible|blocked}` and `ratings_batch_failures_total` are the only metrics; neither has per-user or per-game labels.
8. **Backfill.** The checkpoint starts at the origin, so the first run after deploy applies every eligible historical ending, in the same order and with the same code as live endings. It is restart-safe (the checkpoint) and idempotent (the ledger). A checkpoint above this cluster's transaction ids (a logical restore) restarts from the origin; the ledger then skips every game already applied. No destructive rebuild command is provided. Normal recovery never needs one, and the integration suite proves that a from-zero replay reproduces the live ratings exactly.
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
- **No RD cap.** RD can rise a fraction above 350 (Glicko-2's φ* step); the schema allows up to 1000. There is no provisional-rating display.
- **Deleted accounts.** A game whose player account no longer exists when the applier reaches it is ineligible for both players. A later replay after an account deletion can therefore differ from the original live run for that account's opponents. Replays of applied games are refused by the ledger, so this only affects games not yet applied.
- **Blocked games** stay unrated until an operator acts; there is no tooling beyond the table and the error log.
- **Cluster-wide horizon.** As with ADR-0147, the horizon is cluster-wide: a long-running or idle-in-transaction session anywhere delays ratings (lag, never loss). A logical restore needs the rewind described above.
- **No backlog metrics.** No backlog-size or oldest-pending-age metric is exported. Pending work is `GameEnded` rows after `rating_checkpoint`, which an operator can count.
- **Pre-migration data.** Deployments that already hold variant-only rating rows cannot migrate until an operator decides what those rows mean.
