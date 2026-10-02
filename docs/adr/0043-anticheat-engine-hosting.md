# ADR-0043 — Anti-Cheat Automated Auto-Analyzer Production Engine Hosting

> **Superseded in part by [ADR-0152](0152-moderation-and-trust-operations.md):** anti-cheat analysis now runs only in the dedicated single-replica trust worker; the gateway refuses `ANTICHEAT_AUTO_ANALYZE`.

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-24                                                       |
| **Scope**  | `@chess-platform/api`, `services/gateway` (M12)                  |

---

## Context

The anti-cheat auto-analyzer (`AntiCheatAutoAnalyzer`) subscribes to `gamesEndedChannel()` (`games:ended`) and analyzes finished games, but was previously not hosted in production because it requires a real engine binary to perform position evaluations.

The engine infrastructure (`@chess-platform/engine`, `EngineManager`, `createEngineManager`, `EngineBackedEvaluator`) already exists on `main`. This decision defines the production wiring that hosts `AntiCheatAutoAnalyzer` in `services/gateway` with a real subprocess-backed engine provider, bringing anti-cheat to full production parity with the bot-detection auto-analyzer.

## Decision

We introduce API composition factories in `@chess-platform/api` and host `AntiCheatAutoAnalyzer` in `services/gateway` behind an environment flag with graceful engine subprocess shutdown.

### 1. API Engine Provider & Service Composition (`packages/api`)

- Implemented in `packages/api/src/anti-cheat/engine-provider.ts` and re-exported from `@chess-platform/api`.
- **`createEngineProviderFromEnv()`**: Reads `STOCKFISH_PATH` from `process.env`. If set, invokes `createEngineManager()` to return an `EngineManager` instance (lazy UCI worker spawning on first analysis). If unset, returns `undefined` so engine-free code paths can avoid engine overhead.
- **`createEngineBackedAnalysisService(source, provider, repository)`**: Composes an `AntiCheatAnalysisService` using `EngineBackedEvaluator` (`(variant) => new EngineBackedEvaluator(provider, variant)`).

### 2. Realtime Gateway Hosting (`services/gateway`)

- Hosted in `services/gateway/src/serve.ts` behind `ANTICHEAT_AUTO_ANALYZE=1`.
- **Preconditions:** Requires both `DATABASE_URL` (for `PgAntiCheatReportRepository` and `EventStoreGameSource`) and `STOCKFISH_PATH` (for `createEngineProviderFromEnv()`). If either is missing, the gateway logs a clear warning and skips initialization without crashing.
- **Lifecycle & Shutdown:** Integrates `antiCheatAutoAnalyzer?.stop()` and graceful engine pool termination (`antiCheatEngine.shutdown()`) into the `SIGINT`/`SIGTERM` shutdown handler.

### 3. Testing & Degradation Strategy

- **Hermetic Testing:** Hermetically verified in `packages/api/test/anti-cheat-engine-provider.test.ts` using a fake `AnalysisProvider` and `InMemoryEventStore` / `InMemoryAntiCheatReportRepository`.
- **CI Gate Safety:** The real-engine execution path is ENV-GATED and intentionally unverified in CI without a pinned Stockfish binary.
- **Crash Safety:** `AntiCheatAutoAnalyzer` encapsulates per-analysis error isolation. A missing or failing engine binary causes individual analysis promises to fail and log errors, leaving the gateway process and real-time game serving fully operational.

### 4. Single-Process Deployment Topology Recommendation

- Multi-replica gateway deployments receiving the `games:ended` pubsub message will analyze finished games N×. While SQL upserts on `(player_id, game_id)` are idempotent and correct, running parallel engine analyses across replicas wastes CPU and engine worker capacity.
- Single-replica gateway hosting or dedicated worker partitioning is strongly recommended when `ANTICHEAT_AUTO_ANALYZE=1` is enabled.

## Consequences

- **Production Parity:** Finished games can be automatically analyzed with Stockfish evaluations upon completion without manual moderator intervention.
- **Robust Environment Gating:** Systems without Stockfish binaries or `DATABASE_URL` log descriptive warnings when `ANTICHEAT_AUTO_ANALYZE=1` is set, avoiding startup panics.
- **Clean Subprocess Lifecycle:** Subprocess workers spawned by `EngineManager` shut down gracefully when the gateway receives termination signals.
