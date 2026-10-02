# ADR-0152 — Moderation and trust operations: player reports, first admin, trust worker

**Status:** Proposed for owner review
**Date:** 2026-10-01

## Context

Verified on `main` at `0639043` (after PR #82; open PR #81 uses the preceding ADR number):

- Moderators had evidence routes (`/v1/moderation/anti-cheat/*`, `/v1/moderation/bot-detection/*`) but players had no way to report anyone, and there was no queue to triage reports in.
- `POST /v1/users/:userId/roles` requires an admin, and nothing else grants roles, so a fresh installation could never get its first admin.
- Bot-timing and anti-cheat analysis of finished games already ran as durable `TerminalEventReconciler` consumers (committed `GameEnded` rows plus per-consumer receipts), but only behind `BOT_AUTO_ANALYZE` / `ANTICHEAT_AUTO_ANALYZE` on the gateway. Neither Compose nor Helm set them, so no shipped deployment ran either analyzer. Setting them on the Helm gateway (`replicas: 2`) would have analyzed every game once per replica, and the anti-cheat flag without an engine only logged a warning.
- The tournament reporter was on in Compose and off by default in Helm, so a Helm install served tournaments whose rounds never advanced.

## Decisions

### 1. Player reports are intake and human triage only

`POST /v1/reports` files a report (`subjectId`, optional `gameId`, `reason` in `cheating | harassment | spam | other`, optional plain-text `detail` of at most 1000 characters). The reporter comes from authentication only; the client cannot set status, assignee, note or reporter. The reply echoes only what was submitted.

- Self-reports (in any UUID case) are refused with 422, an unknown subject with 404.
- A `gameId` must be a game the subject played, read from the event log (`GameCreated`), not from the rebuildable `games` projection. The reporter need not have played it, because spectators witness cheating. A live game is accepted, because harassment happens during play.
- Nothing bans, scores or resolves anyone automatically. Engine evidence informs a moderator and never closes a report.

Reports are stored in `player_reports` (migration `packages/persistence/migrations/0047_player_reports.sql`). The status and reason vocabularies are CHECK constraints. The status is coupled to its columns: open ⇔ no assignee, and closed ⇔ `closed_at`. The table has two indexes, each serving a real query: the queue `(status, id)` and the per-player view `(subject_id, status, id)`. The user foreign keys take no `ON DELETE` action: deleting an account must not erase reports about it, reports it filed, or a moderator's claim. Account deletion, when it exists, must decide retention for these rows explicitly.

### 2. Report admission

A report makes one atomic admission of four buckets before any repository read or write:

- `player-report:user:` 5/h. This is the hourly shape of the other rarely-repeated creations (`register`, `teamCreation`).
- `player-report:user-day:` 20/24 h, which stops the hourly budget being spent around the clock as a mass-reporting campaign.
- `player-report:ip:` 50/h, with the repository's 10-account shared-NAT margin.
- `player-report:pair:<reporter>:<subject>` 3/24 h. This is the `friendRequestRepeat` precedent. It names the reporter first, so only the reporter charges it.

No bucket is keyed by the subject alone, so nobody can spend a victim's ability to report or to be reported. Limiter faults fail closed, `rateLimit.enabled=false` skips admission, and a refusal is a 429 with `Retry-After`. `packages/api/test/rate-limit-structure.test.ts` pins the shape.

### 3. Moderator queue and state machine

The queue routes are under `/v1/moderation/player-reports`. They are named apart from the anti-cheat "reports" and use the existing `MODERATION` policy (moderator or admin).

- The list is keyset-paged by the time-ordered id, oldest first, filtered by status and optionally by subject. List rows carry no report text and no note.
- A moderator never sees reports they filed or are the subject of, and asking for one is a 403. Pages are stable within a snapshot. A report committed late behind a cursor is seen on the next pass from the head, which is how the queue is meant to be read.
- `GET /v1/moderation/player-reports/:id` writes its audit row before reading (the ADR-0033 pattern).

`POST /v1/moderation/player-reports/:id/transition` with `{action, expectedVersion, note?}` follows this state machine:

- `claim` moves open → reviewing and makes the caller the assignee.
- `resolve` and `dismiss` move reviewing → resolved or dismissed. Only the assignee or an admin may do this, and the call may carry an internal note of at most 2000 characters.
- The terminal states are final.

The rules live in one function, `refusePlayerReportTransition`, shared by both implementations:

1. A party to the report gets 403. That is the reporter or the subject, admins included.
2. A stale `expectedVersion` gets 409. It is checked before the state, so a retry of an already-made decision always answers the same way.
3. A wrong state gets 409.
4. Closing another moderator's claim, by anyone who is not an admin, gets 403.

PostgreSQL locks the row (`SELECT … FOR UPDATE`), applies the rules, then writes the update (`version = version + 1`) and its `audit_log` row in one transaction. Racing claims serialize on the row lock, and the loser sees the new version and gets 409, never a 500.

### 4. Audit and privacy

Every moderator read and decision is audited as `player_reports.{list,view,claim,resolve,dismiss}`. Audit metadata holds identifiers and the state change only: subject, from, to, version, and the previous assignee, which makes an admin override visible. It never holds report or note text. Player-facing responses never include the status, the assignee, the note, or who reported.

### 5. First admin: an operator command, not an endpoint

The operator runs `npm run admin:bootstrap --workspace @chess-platform/persistence -- <user-id> <operator-label>`. In a cluster the command is `kubectl exec deploy/<release>-api -- node packages/persistence/dist/pg/first-admin-cli.js <user-id> <operator-label>`. It connects directly to the database and does the following in one transaction:

- Sets `lock_timeout` to 5 s.
- Takes `LOCK TABLE roles IN SHARE ROW EXCLUSIVE MODE`, which conflicts with itself and with every roles insert.
- Refuses if any admin exists.
- Requires an existing, non-bot account (`users.flags->>'bot'`).
- Inserts the role and an `audit_log` row: `roles.bootstrap_first_admin`, actor NULL, `meta` = `{source: 'operator-cli', operator, databaseUser, database}`.

It never creates accounts or credentials, prints only `{granted, userId}`, exits 1 on any refusal, and has no force option. After the first admin exists, every grant goes through the authenticated API.

### 6. One host for trust analysis: the trust worker

`services/gateway/src/trust-worker.ts` is a thin entrypoint in the gateway image, which ships Stockfish. It composes `startTrustAnalyzers` from `packages/api/src/trust-analyzers.ts`, the existing reconciler consumers, unchanged. It runs no WebSocket server, game authority, ownership registry, command consumer or engine bot, and serves only `/health` and `/ready`. The readiness check covers the database only, because Redis merely wakes the worker early.

Its configuration is strict. It requires `DATABASE_URL`, and each flag must be exactly `"0"` or `"1"` with at least one set to `"1"`. Anti-cheat analysis requires `STOCKFISH_PATH`. There is no in-memory mode. The work list is the durable terminal inbox, rescanned at start and every `TRUST_SCAN_MS`.

Shutdown stops taking new games and lets the game in progress finish. A game cut short was never acknowledged, so it is redone. Each consumer analyzes one game at a time, which bounds engine use.

The gateway now refuses `BOT_AUTO_ANALYZE` and `ANTICHEAT_AUTO_ANALYZE` (any value but `"0"`), so no second copy can run on the scalable replicas.

The deployments are wired as follows:

- **Compose** adds a `trust-worker` service.
- **Helm** adds `templates/trust-worker.yaml`. It is pinned to `replicas: 1` (hard-coded), with RollingUpdate maxSurge 1 / maxUnavailable 0; the overlap only repeats idempotent upserts. It has no Service and no Ingress, a NetworkPolicy that admits no inbound traffic, no access-token secret, and `terminationGracePeriodSeconds: 300`.
- Its typed booleans are `trustWorker.{enabled,botAnalysis,antiCheatAnalysis}`; a quoted string is refused at render, and so is turning both analyzers off.
- `rollout.strategy` (api and web only) never duplicates the worker.

On an installation with history, the first rollout backfills every past ending, one game at a time. This is documented in `values.yaml`.

### 7. Tournament reporter: on by default, on every gateway replica

The architecture review challenged a move to the singleton and rejected it. The reporter needs only the event store, the tournaments repository and the launcher, so the move would work. But it would put tournament progression on one pod and buy nothing. Duplicates across replicas are harmless: `recordCommittedOutcome` (round-based and arena) is idempotent under the tournaments version CAS.

The review found one real gap, which predates this change and which the default made easier to reach. The launch id is derived from `(tournament, match, attempt)` and does not include the players. Two operations racing from one tournament version could pair the same slot differently, and the loser linked the winner's game under the wrong players. `DurableGameLauncher.launch` no longer links a game whose players, variant or time control differ. A plain refusal would wedge the pairing forever when a lost race leaves an unlinked game in the slot (raised on PR #83 by Greptile and Qodo). Instead the launcher walks `attempt, attempt+1, …` (at most 8) and takes the first slot that is free or holds this exact pairing's game, still unfinished. An ended game is never linked again, so a relaunch after an abandon cannot land on the aborted game. Every replica walks the same sequence, so they converge, and the tournament's version CAS still decides which link is kept. An unlinked game is never started, and its no-show deadline ends it. Helm `gateway.tournamentReporter.enabled` now defaults to `true` and must be a boolean; `false` remains the explicit operator kill switch.

## Consequences

- There is no web UI for reporting or the queue yet. That is a later `packages/web` PR.
- Follow-ups: account deletion must decide report retention; arena pairing near the deadline still uses each replica's clock (a rare orphaned arena game); a poison game is retried every scan with no backoff; Compose builds the gateway image twice.

## Reliability follow-up — 2026-10-02

[ADR-0155](0155-trust-terminal-retry-isolation.md) closes poison-game retry backoff
with durable due scheduling and renewable, fenced per-consumer leases. It
supersedes the original overlap/retry behavior described above for upgraded
workers. The rollout must drain legacy workers, which do not enforce leases.
