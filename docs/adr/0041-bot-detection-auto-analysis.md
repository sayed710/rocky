# ADR-0041 — Bot Detection Automated Auto-Analysis Worker and Gateway Hosting

> **Superseded in part by [ADR-0152](0152-moderation-and-trust-operations.md):** bot-timing analysis now runs only in the dedicated single-replica trust worker; the gateway refuses `BOT_AUTO_ANALYZE`.

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-24                                                       |
| **Scope**  | `@chess-platform/api`, `services/gateway` (M12)                  |

---

## Context

Increment 5 implemented Postgres persistence (`bot_reports` table, `PgBotBehaviorReportRepository`), `EventStoreBotTimingSource`, `BotDetectionService`, and moderation REST API endpoints (`GET` read endpoints and `POST /v1/moderation/bot-detection/games/:gameId/analyze`).

Unlike anti-cheat engine correlation (which relies on external Stockfish evaluation and remains un-hosted in `services/gateway`), behavioral bot detection requires no engine process — only Postgres and the game event store. Thus, bot detection auto-analysis can be fully hosted directly inside `services/gateway` upon terminal game broadcasts.

## Decision

We encapsulate load-and-analyze logic into `BotAnalysisService`, introduce an automated worker (`BotAutoAnalyzer`) in `@chess-platform/api`, refactor the moderation analyze route to share `BotAnalysisService`, and host the worker in `services/gateway` behind `BOT_AUTO_ANALYZE=1`.

### 1. Application Service (`BotAnalysisService`)

- Implemented in `packages/api/src/bot-detection/analysis-service.ts`.
- Wraps `BotGameTimingSource` and `BotDetectionService`.
- `analyzeAndStore(gameId)` loads move timings for finished games and delegates to `BotDetectionService.analyzeAndStore`. Returns `null` if the game is absent or not finished.
- Both the moderation analyze endpoint (`POST /v1/moderation/bot-detection/games/:gameId/analyze`) and the background worker (`BotAutoAnalyzer`) share this application service.

### 2. Auto-Analysis Worker (`BotAutoAnalyzer`)

- Implemented in `packages/api/src/bot-detection/auto-analyzer.ts`.
- Subscribes once to `gamesEndedChannel()` (`games:ended`) on `start()`.
- **Deduplication:** Maintains an in-process `seen: Set<string>` of processed game IDs, bounded at `MAX_SEEN = 10_000` with FIFO eviction.
- **Fire-and-Forget & Crash Safety:** Asynchronous analysis runs as a background promise tracked in `inFlight`. Rejections call `options.onError` (defaulting to `console.error`) inside a try/catch block so a throwing error handler never rejects the promise or breaks `drain()`. Failed games are removed from `seen` so re-broadcasts can retry.
- **Idempotency:** Delegates to the injected `BotGameAnalyzer` (`BotAnalysisService` in production) via `analyzeAndStore(gameId)`. SQL upserts on `(player_id, game_id)` make at-least-once delivery safe.
- **Lifecycle:** Provides `stop()` to unsubscribe and clear local state, and `async drain()` to await in-flight promises deterministically in tests.

### 3. Gateway Process Hosting (`services/gateway`)

- Hosted in `services/gateway/src/serve.ts` behind `process.env['BOT_AUTO_ANALYZE'] === '1'`.
- Requires `DATABASE_URL` (instantiates `PgBotBehaviorReportRepository` and `EventStoreBotTimingSource`). Needs no engine binary.
- Wires `botAutoAnalyzer?.stop()` into the graceful shutdown handler (`SIGINT`/`SIGTERM`).
- **Single-Process Topology Recommendation:** In a multi-replica gateway deployment, each replica will receive the `games:ended` pubsub broadcast and run auto-analysis N×. This is correct due to idempotent upsert, but wasteful. Single-replica gateway hosting or single-worker partitioning is recommended.

## Consequences

- **Fully Automated Engine-Free Bot Detection:** When gateway hosting is enabled (`BOT_AUTO_ANALYZE=1` with `DATABASE_URL`), finished games are automatically analyzed upon completion without requiring manual moderator action or engine setup.
- **Shared Application Path:** The moderation REST API analyze handler and background worker share `BotAnalysisService`, preventing duplicate loading logic.
- **Robustness:** Worker rejections or error-hook failures never crash the gateway or interrupt real-time play.
