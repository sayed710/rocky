# ADR-0080 — Engine Bot Opponent Wiring ("Play vs Computer")

| Field      | Value                                                                                                          |
|------------|----------------------------------------------------------------------------------------------------------------|
| **Status** | Accepted                                                                                                       |
| **Date**   | 2026-08-03                                                                                                     |
| **Scope**  | `@chess-platform/api`, `@chess-platform/persistence`, `@chess-platform/realtime-gateway`, `services/gateway`  |

---

## Context

Prior to this increment, `@chess-platform/engine` provided a UCI engine bridge (worker pool, priority scheduler, circuit breaker, watchdog cancellation), but no production path invoked `AnalysisProvider.play()`. Users could not play against computer opponents, and `packages/e2e-harness` recorded this gap as technical debt.

Wiring the engine bridge into live gameplay requires solving four architectural challenges:
1. **Identity & Authentication Security**: How bot accounts are represented in the persistence layer without opening authentication vulnerabilities.
2. **Multi-Node Command Routing**: Ensuring bot moves respect sharded game authority across multiple gateway replicas (ADR-0010).
3. **Rating Integrity**: Preventing uncalibrated or manipulated bot games from altering human ratings.
4. **Shared Engine Resources**: Avoiding resource contention or duplicate engine pools when anti-cheat auto-analysis and bot play run in the same gateway process.

## Decision

### 1. Bot Accounts Are Credential-Less User Rows

Bot accounts (`gambit-novice`, `gambit-club`, `gambit-master`) are seeded as standard user rows in `packages/persistence/migrations/0021_engine_bots.sql` with stable, hardcoded UUIDs and `flags = '{"bot": true}'::jsonb`.

Because authentication credentials in Gambit live exclusively in a separate table (`credentials`), a `users` row with no corresponding credentials row cannot authenticate under any login flow. This credential-less user design is the core security property: bots can participate in games, events, rating tables, and presenters like any user, but can never be logged into.

`packages/api/src/bot/catalogue.ts` acts as the single source of truth for bot account metadata, levels, and `StrengthSpec` mapping.

Those handles are also **reserved at the API edge**: registration refuses them, case-insensitively. This is not cosmetic. `users.handle` is `UNIQUE`, so a human who had already claimed `gambit-master` would turn the seed INSERT into a unique violation that aborts migration 0021 — and migrations run in the API's init container, so the deploy stops. Skipping the row on conflict instead would be worse: the bot account would silently not exist and the first `POST /v1/games/bot` would fail on a foreign key at runtime, far from the cause. The migration therefore checks for the collision up front and raises an error naming the offending handles and the remedy, while the edge reservation stops new ones being created.

### 2. Multi-Node Routing via `CommandRouter`

In `services/gateway/src/engine-bot.ts`, `EngineBotMover` handles engine move generation. To support multi-node deployments (`replicas: 2+`), bot moves are submitted exclusively via `CommandRouter.route(gameId, botUserId, cmd)` rather than calling `authority.apply(...)` directly.

Under Redis-backed command routing (ADR-0010), only the node holding the game's ownership lease executes commands against `GameAuthority`; non-owner nodes forward commands via Redis. Routing through `CommandRouter` ensures bot moves function correctly regardless of which gateway replica owns the live game.

### 3. Bot Games Are Always Unrated

The `POST /v1/games/bot` route in `packages/api/src/routes.ts` enforces `rated: false` unconditionally. Games against calibrated or uncalibrated engine bots must not mutate human ratings, as rating updates against engine opponents lack anti-abuse protections and adding rating flags would be speculative.

### 4. Shared Engine Provider and Observability

In `services/gateway/src/serve.ts`, when `ENGINE_BOT` or `ANTICHEAT_AUTO_ANALYZE` is enabled, a single shared engine provider is created via `createEngineProviderFromEnv()`. Both workers share the underlying worker pool, circuit breaker, and priority scheduler, ensuring `JobPriority.BotMove` (priority 0) takes precedence over background analysis without duplicating engine subprocesses.

`EngineBotMover` emits three production metrics registered in `services/gateway/src/serve.ts`:
- `gateway_bot_moves_total` (counter)
- `gateway_bot_move_failures_total` (counter)
- `gateway_bot_move_seconds` (histogram)

### 5. What Is NOT Proven

There is no Stockfish binary in CI or on the development machine. Consequently:
- All test suites (`packages/api/test/bot-game-route.test.ts`, `services/gateway/test/engine-bot.test.ts`) exercise the engine bot wiring against a fake `AnalysisProvider`.
- Stockfish's actual play, UCI options negotiation (`UCI_LimitStrength`, `Skill Level`), and the calibration of `elo` ratings to real playing strength remain unverified. Milestone 5's deferred "real-engine golden test" remains open.
- Enabling `ENGINE_BOT` in Kubernetes additionally requires bundling a Stockfish binary into the gateway container image and adding Helm chart values/templates for `ENGINE_BOT`; both are out of scope for this increment.

## Consequences

- Logged-in users can create games against engine bots at three levels (`novice`, `club`, `master`) via `POST /v1/games/bot`.
- Games against engine bots commit atomically using `GameStarter` in `packages/persistence/src/repositories.ts` and `packages/persistence/src/pg/repositories.ts`.
- `EngineBotMover` reacts to game joins (`onGameLoaded` in `packages/realtime-gateway/src/gateway.ts`) and move broadcasts, submitting moves through `CommandRouter`.
- CI verification scripts (`npm run check:adr-claims`, `npm run check:observability`, `npm run build`, `npm run lint`, `npm test`) pass with zero drift, as guarded per ADR-0079.

## Amendment — M15 Increment 69: only the owner decides, and Helm enables the bot

Decision 2 was incomplete. Routing made the owner the node that *applies* a bot move, but every replica with a session in the game ran a mover, and each chose its move from its own `GameAuthority`. A non-owner's copy never sees the owner's moves: they reach it as room broadcasts, which do not touch the authority (the same fact `RedisCommandRouter`'s takeover reload exists for). With two replicas, a human who reconnected to the other pod, a second tab, or a spectator was enough to make that replica ask the engine about an old position on every broadcast and route the answer to the owner, which applied it whenever it happened to be legal. That was reproduced: the owner applied `…Nf6` at ply 4, computed by the other replica for ply 1.

The decision now sits with the owner too:

- **Before the engine**, `EngineBotMover` calls `RedisCommandRouter.prepareOwnership(gameId)`: the router's own ownership step (a valid local lease, or a `claim`, then the takeover reload) with no command applied, re-checking the lease after the reload because the reload is I/O. A replica that does not own the game returns without asking the engine. An unowned game (the bot opening as White at ply 0, or an owner that has gone away) is claimed and rehydrated from the event log before its position is read.
- **Reload debt belongs to a claim.** The router's takeover reload (`rehydrateIfStale`, shared with `route()`) was keyed by game only, so a reload begun for an earlier claim, whose log read predated another owner's moves, could finish after a later claim and settle that claim's debt, leaving a stale copy marked fresh. Each claim now gets a number from one process-wide counter; only a reload started for the current claim clears the debt, and a caller that finds an older reload in flight starts a new one, which queues behind the older one on the game's command lock in `GameAuthority.reloadFromLog` and so reads the log after it. Numbers are never reused, so the entry is dropped once settled.
- **A lease that lapsed unnoticed is a new claim.** When a renewal throws (Redis unreachable), `OwnershipRegistry` keeps the game in its owned set on purpose and lets the local lease age out. If the key then expired and another node owned the game in between, the next `SET NX` by this node used to be recorded as continuing ownership, so `onClaimed` never fired and nothing reloaded. A `SET NX` that creates the key now always counts as a new claim; renewing a key this node still holds does not.
- **After the engine**, the move is submitted only if `RedisCommandRouter.holdsOwnership(gameId)` is still true (a valid lease with no reload debt: a lease lost and re-claimed during the think leaves the untouched cached copy looking current) and the local state is still the same ply and FEN (which encodes the side to move) and not over. A result that fails either check is dropped, and the mover immediately takes one more pass from the top. A changed position would have queued that pass anyway; a lease that lapsed during the think (a missed renewal) announces nothing, and the bot may still be to move. The new pass re-claims (renewing the lease if it is still this node's) or finds another owner.
- The check is synchronous and immediately followed by `route()`. While the lease is valid no other node can own the game, and in the checked position only the bot has a legal move, so no command can change the position before the apply. The apply can still queue on the game's command lock behind an earlier command's append; a resignation there ends the game and the move is rejected as game over. The last line of defence is the event log's expected-sequence check on every append. No expected-ply field was added to the command protocol.
- **Finished games let go.** An `ended` broadcast unregisters the game, and a copy that already says `over` unregisters before any ownership traffic (an ending is final, so a stale copy that shows one is right). This covers joining a finished game on a non-owner, whose owner keeps renewing its lease.
- **Non-owners check back.** A replica that registered a bot game but does not own it re-checks every `OWNERSHIP_LEASE_TTL_SEC` (the value `serve.ts` passes as `nonOwnerRecheckMs`): it reloads its copy from the event log, unregisters the game if it has ended, and otherwise tries ownership again. This is what recovers a game whose owner died, since nothing is broadcast when a lease expires, and a game whose `ended` broadcast was lost, since Redis pub/sub is best-effort. Per registered non-owner game and lease period it costs one ownership attempt and one full reload: the log read plus a replay that rebuilds the broadcast history, quadratic in the game's length. It never makes an engine call unless the claim succeeds.
- On a single node (`LocalCommandRouter`, no `ownership`) the gate and the re-checks are absent and the post-engine position check still applies.
- Remaining limits: a dead owner's game resumes after its lease expires plus up to one re-check period (at most about twice the lease TTL), and only on a replica that has the game registered; with no session on any surviving replica the game waits for the next join, which registers it. A lease that keeps lapsing while the engine thinks costs one engine call per lapse, since each dropped result is followed by a fresh pass. A registration lasts until the game ends, so one spectator visit keeps that replica re-checking the game for its lifetime, and every broadcast costs each such non-owner an ownership attempt (two Redis round trips), which is unavoidable while its copy is stale. `route()` itself does not re-check the lease after its takeover reload the way `prepareOwnership` does; that predates this amendment and is left for a follow-up.

`services/gateway/test/engine-bot-multinode.integration.test.ts` proves this against the production router, registry and per-node Redis pub/sub on real Redis: only the owner calls the engine, including on duplicate broadcasts; Bot-as-White at ply 0 gets exactly one claimant; a takeover computes from the rehydrated position; a result is not applied after ownership is lost, or lost and regained, while thinking; a reload begun for an earlier claim does not settle a later one; an owner that dies is replaced with no further event; a finished game stops every replica. `engine-bot.test.ts` covers the lapsed-lease re-run, the missed-`ended` re-check and the finished-game join. Ten safety checks were each disabled in turn, one at a time: the pre-engine ownership gate, the post-engine check, the `ended` unregister, the reload-debt clause of `holdsOwnership`, the claim-generation check, the re-run after a dropped result, the non-owner re-check, the reload before a re-check pass, the unregister of a finished copy, and the new-claim rule for a `SET NX` that creates the key. Each disabling failed at least one of these tests.

The chart now renders `ENGINE_BOT=1` on the gateway through `gateway.engineBot.enabled`, default `true` under the default two replicas, matching Compose. The value must be a boolean: a quoted `"false"` is truthy in a template, so the chart refuses to render it rather than leaving the bot on. The gateway image supplies Stockfish and `STOCKFISH_PATH` (ADR-0121), so the chart configures no engine. This closes the last item of section 5.
