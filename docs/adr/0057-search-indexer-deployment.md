# ADR-0057 — Dedicated Single-Replica Deployment for the Search Indexer

> **Superseded in part by [ADR-0152](0152-moderation-and-trust-operations.md):** the bot and anti-cheat analyzers no longer remain gateway flags; they moved to the trust worker.

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-28                                                       |
| **Scope**  | `deploy/helm/gambit` (M14)                                       |

---

## Context

ADR-0056 added the live search indexer as a gateway-hosted worker behind `SEARCH_INDEXER=1`, and recorded an operational constraint: set the flag on exactly one replica, because the worker's dedup set is process-local. Nothing in the chart enforced or even exposed that — `SEARCH_INDEXER` did not appear in `deploy/helm/gambit` at all, so the feature was unreachable from a Helm install.

Three properties make this awkward to solve by adding the flag to the existing gateway Deployment:

1. `gateway.replicas` defaults to `2` (ADR-0010), and a Deployment cannot vary env per pod. Enabling the flag there enables it on every replica.
2. Unlike `TOURNAMENT_REPORTER`, whose duplicate work is made safe by version CAS on the tournaments table, the indexer has no cross-process coordination — each replica would issue its own `findGame` read and its own search upsert for every finished game.
3. Requiring `gateway.replicas: 1` to use the indexer would trade away horizontal scaling of the WebSocket edge for a background worker. Wrong trade.

`SEARCH_ENABLED` (ADR-0055's kill switch) was likewise absent from the chart, so search could not be disabled in a Kubernetes deployment.

## Decision

1. **Dedicated Deployment (`templates/search-indexer.yaml`)**
   - Renders `<fullname>-search-indexer` when `gateway.searchIndexer.enabled=true` (default `false`).
   - Runs the gateway image with `SEARCH_INDEXER=1`, and is the single owner of that flag across the release.
   - `replicas: 1` is **hard-coded, not a value**. Parameterising it would reintroduce the exact duplicate-work problem the template exists to remove.
   - **No Service is rendered.** The pod runs the same `serve.ts` entry point so it binds the WS and health ports, but it receives no client traffic. With no clients it never claims game ownership, so it stays inert in the Redis ownership registry (ADR-0010) while still consuming `gamesEndedChannel()` broadcasts.
   - Reuses the gateway's `wait-for-api` init container: the API applies migrations before reporting Ready, so `games`, `users` and `search_documents` exist before the indexer starts.
   - Liveness/readiness probes target the pod directly, so the absent Service does not affect them.
   - Resources are separately tunable via `gateway.searchIndexer.resources` — a background indexer has a different profile from a WS edge node.

2. **`SEARCH_ENABLED` wired into the API (`templates/api.yaml`)**
   - New `search.enabled` value (default `true`). When `false`, the API Deployment gets `SEARCH_ENABLED=0`, so `deps.searchRepository` is never constructed and `GET /v1/search` returns 503 per ADR-0055.
   - Left unset when `true` so the application keeps its own default rather than the chart asserting one.

3. **Fail closed on a contradictory combination**
   - `gateway.searchIndexer.enabled=true` with `search.enabled=false` calls `fail` at template time rather than deploying an indexer that populates an index nothing will serve. This follows the chart's existing fail-closed style (ADR-0044's secret checks).

4. **Explicit non-decision recorded in `templates/gateway.yaml`**
   - A comment states that `SEARCH_INDEXER` is deliberately absent from the gateway Deployment and points at this ADR, so the flag is not "helpfully" added there later.

5. **Explicit zero-gap rollout strategy**
   - `strategy: RollingUpdate` with `maxSurge: 1, maxUnavailable: 0`, stated explicitly rather than inherited.
   - With `replicas: 1` and no strategy, the default RollingUpdate resolves `maxSurge: 25%` to 1 anyway, so an upgrade briefly runs two indexer pods. That is recorded here instead of left implicit.
   - **`Recreate` was considered and rejected.** It terminates the old pod before the replacement is Ready, and `gamesEndedChannel()` is Redis PUBLISH/SUBSCRIBE — fire-and-forget, not a durable queue. Every game finishing inside that window would be dropped from the index, recoverable only by rerunning `reindex-search`. A brief overlap costs one duplicated read plus one idempotent upsert per game finished during the rollout. Losing games is worse than indexing a few twice.
   - The strategy is pinned by a snapshot assertion so it is not "simplified" to `Recreate` later.

6. **Verification (`scripts/helm-snapshot-test.sh`)**
   - The chart's existing snapshot test is extended with assertions covering: opt-in default, render-when-enabled, `replicas == 1`, the explicit strategy, `SEARCH_INDEXER` set exactly once and absent from the gateway, no Service added, exactly one added resource, the fail-closed combination, and the `SEARCH_ENABLED` kill switch reaching the API. Written with grep/awk, adding no new dependency.
   - **CI wiring is PENDING.** The assertions exist and pass locally, but `scripts/helm-snapshot-test.sh` is not yet invoked by `.github/workflows/ci.yml` — that file could not be committed here (the integration lacks the GitHub App `workflows` permission), and the script has never run in CI. Until a step is added, indexer rendering is **not** continuously verified. The required step is recorded in the pull request description.

## Consequences

- The live indexer is reachable from a Helm install, and correct by construction: exactly one indexing process per release regardless of how far the gateway scales.
- Default renders are unchanged — 13 resources with the indexer off, 14 with it on. Existing deployments see no diff until they opt in.
- Upgrades never leave the channel unsubscribed, at the cost of a brief two-pod overlap that duplicates idempotent work.
- Until the CI step is added, the chart's indexer behaviour is guarded only by the local snapshot test.
- Search can now be disabled in Kubernetes via `search.enabled=false`.
- This closes the "dedicated single-replica Deployment" debt for the indexer specifically. `TOURNAMENT_REPORTER`, `BOT_AUTO_ANALYZE` and `ANTICHEAT_AUTO_ANALYZE` remain gateway-hosted on every replica; the reporter is safe by CAS, and the two analyzers keep the process-local dedup caveat recorded in ADR-0056. Shared distributed leadership for those remains tracked debt.
- The indexer pod holds a Redis connection and a Postgres pool while owning no games. That is the cost of reusing one entry point rather than building a worker-only binary; a dedicated entry point is the natural follow-up if more workers move out of the gateway.
