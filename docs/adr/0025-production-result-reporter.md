# 25. Production Tournament Result Reporter

> **Superseded in part by [ADR-0152](0152-moderation-and-trust-operations.md):** the reporter is now enabled by default in Helm as well as Compose, and a launch never links a slot's game under another pairing; it takes the next attempt of the slot.

Date: 2026-07-18

## Status

Accepted

## Context

During M9 Increment 11 (Arena Realtime Game Lifecycle), we built `TournamentResultReporter` to watch for completed games in a tournament and automatically record their results back into the tournament state. This was initially built in the `e2e-harness` to prove the concept. For production deployment, this background daemon must be hosted properly.

We need to answer two architectural questions:
1.  **Where should it live?**
2.  **How does it discover games?** (Both at process startup, and dynamically as new games launch).

## Decision

1.  **Relocation**: We have moved `TournamentResultReporter` from `e2e-harness` to `@chess-platform/api` (in `src/tournament/reporter.ts`). It is instantiated and hosted in the composition root of the production gateway (`services/gateway`) behind `TOURNAMENT_REPORTER=1`. This introduces a declared `@chess-platform/api → @chess-platform/realtime-gateway` dependency edge (for the `PubSub` port type and `gameChannel` naming); the reverse direction remains forbidden.
2.  **Startup Rehydration**: The reporter includes an `async start()` method. Upon startup, it queries the `TournamentsRepository` for up to 100 recent running tournaments. For each running tournament, it reads the `gameLinks` and subscribes to the per-game PubSub channels.
3.  **Discovery of new launches** happens through two complementary paths:
    - **Same-process launches**: the composition root wraps the `GameLauncher` so a successful launch immediately invokes `reporter.watch(tournamentId, gameId)`.
    - **Cross-process launches**: tournaments are normally started via the API service, a *different* process — a synchronous callback can never see those launches. The reporter therefore **re-scans** running tournaments on a timer (`TOURNAMENT_REPORTER_SCAN_MS`, default 30s) and subscribes to any in-flight `gameLink` it is not already watching (a watched-set prevents double subscription). Results for cross-process games are thus recorded within one scan interval of the game ending (the `EndedBroadcast` for a game that ended before the reporter subscribed is missed; the game link stays in-flight and — for aborted/never-recorded games — resolution falls to the tournament-director manual endpoint; an event-log catch-up read is a possible later increment).
4.  **Multi-replica safety**: the gateway chart runs 2 replicas; when the reporter is enabled every replica runs one. Optimistic concurrency (the version CAS below) serializes their writes — the losing replica observes an already-recorded pairing and logs a benign error. A dedicated single-replica reporter Deployment is a possible later increment.

## Consequences

**Positive:**
- Production-grade resilience: process restarts will no longer drop active games. 
- Minimal complexity: Reusing the existing `PubSub` for completion events and a synchronous callback for launch events avoids needing a heavy event broker like Kafka.

**Negative:**
- The composition root must manually wire the callback between the launcher and the reporter.
- The `start()` loop is currently a simple query (`list(100)`). If the system scales to thousands of concurrent running tournaments, we will need a more robust pagination or indexing strategy for active games.
