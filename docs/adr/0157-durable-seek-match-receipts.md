# ADR-0157: Suppress ended-game seek receipts from durable events

Status: Accepted engineering correction; owner manually merges the PR.

Date: 2026-10-05

## Context

The current-main Fable/Astra re-verification at `3aa201056c4ff0396ec5fc9f4438cb210356ef38` found one required P1 remainder. `GET /v1/seeks` returns a creator's recent match receipt, and the lobby redirects on it. The repository only consulted `games.ended_at`, an asynchronous projection. A committed `GameEnded` could therefore still redirect the creator while the projector lagged or stopped. The existing projection integration test explicitly expected that window; the original audit requires no redirect to ended games.

## Decision

Keep the existing creator, TTL, projection-ended fallback, ordering and open-seek-limit contracts. In the receipt branch of the same SQL statement, exclude a game with a committed `game_events.type = 'GameEnded'` row. The existing migration 0034 partial terminal-event index supports the correlated lookup; no migration, new worker, polling, retry, configuration or protocol change is needed.

PostgreSQL's statement snapshot is the visibility boundary. An ending committed before that snapshot suppresses the receipt independently of projection. Uncommitted or rolled-back endings do not. A game can still end after a response snapshot or while the browser navigates; this change does not claim to freeze live games or make HTTP navigation linearizable with future commands.

The projector retains authority for history and ratings. This narrow lifecycle read uses the append-only event log only to exclude terminal games, just as other durable lifecycle consumers use terminal events.

## Verification

The existing PostgreSQL projector regression now proves both a committed ending and an unchanged `ended_at = NULL` before expecting the receipt absent. Real PostgreSQL plus the production REST router covers resignation, abort and checkmate; live receipts outside a limit of one; unchanged open seeks; anonymous and other-account privacy; unrelated-game endings; and uncommitted/rolled-back endings on an independent connection. No projector runs in those REST fixtures.

The strengthened existing test and all three corrected REST fixtures failed the intended receipt assertions before the production change. An initial database setup without pgvector and an impossible projection-delete fixture were setup errors, not behavioral RED or mutation credit. Both were corrected without weakening production constraints.

Complete local and exact-head external gates are recorded in PROJECT_STATE and the PR handoff after execution. The pinned-main ledger remains historical to its exact SHA; this ADR and a merge-ready branch do not claim current-main integration or public-launch approval.
