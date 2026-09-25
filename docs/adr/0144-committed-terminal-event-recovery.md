# ADR-0144 — Recover committed terminal game events

**Status:** Proposed for owner review
**Date:** 2026-09-25

## Context

`GameAuthority` commits `GameEnded` before publishing it. A crash, lost Redis message, or a failed tournament callback can therefore leave durable terminal truth without the downstream effect. ADR-0025's reporter watched live channels and scanned only the newest 100 tournaments; its `watched` set also prevented retries after a failed callback.

## Decision

- PostgreSQL `game_events` is the only source of terminal truth. Broadcasts wake reconciliation but never supply the result to record. The tournament reporter subscribes before reading each linked game, scans all running tournaments in keyset pages on startup and periodically, and keeps a failed game eligible for the next scan.
- Tournament services process a committed outcome through their existing version-CAS retry loops. A round result already recorded for the same linked game is a no-op; a conflicting result is an error. An arena result or abort removes its link, so a concurrent retry observes the absent link and does not score or relaunch again. The existing deterministic launcher converges on the same replacement game ID after an abort or CAS retry.
- Event-store-backed bot and anti-cheat analyzers use `TerminalEventReconciler`. It pages committed `GameEnded` rows, omitting rows with per-consumer receipts. A receipt is inserted only after the analyzer's durable upsert succeeds. Two replicas may analyze the same game, but `(player_id, game_id)` report upserts make repeated writes idempotent. Failed rows stay pending and are retried; each scan is capped at ten pages, and later scans resume from the beginning of the pending set. No timestamp high-water mark is used because transaction commit order need not match event timestamps.
- A failed/uncertain authority append reloads its cached game from the event log before it may be reused. Ownership-takeover reloads retain the command queue and reject synchronous stale-state reads until the reload completes.

Migration 0033 adds consumer receipts. Migrations 0034 and 0035 build the terminal-event and running-tournament scan indexes online. Existing committed endings are discoverable without copying them to a new outbox or shadow projection.

## Limits and follow-ups

This is the first timed-game lifecycle increment. It does not change clock start, readiness, no-show, autonomous flag expiry, games projection, ratings, or leaderboard behavior. Search indexing and achievement awards read the unfinished games projection; their durable recovery is deferred to the dedicated projection work. Achievement increments additionally need an atomic per-game award key before replay. An unreadable event stream stays pending and emits an operator error rather than being silently acknowledged. A dedicated single-replica tournament reporter remains optional future deployment work.
