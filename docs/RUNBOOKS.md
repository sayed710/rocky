# Gambit — Alert Runbooks

One entry per alert in `deploy/observability/prometheus/rules/gambit.rules.yml`. Each alert's
`runbook_url` annotation links to its anchor here.

A runbook that says "investigate the issue" wastes the responder's time at the worst possible
moment, so each of these names the specific queries and commands to run and what their answers mean.

**Assumed access:** `kubectl` against the cluster, and the Prometheus/Grafana UIs. The Gambit
dashboards are `gambit-service-health` and `gambit-observability-pipeline`.

**Note on scraping (SEC-1):** `/v1/metrics` is blocked at the public web proxy. Prometheus scrapes
the API Service directly in-cluster, so its pods need a narrow additive NetworkPolicy allowing the
API port. To read metrics by hand, port-forward rather than hit the public hostname:

```bash
kubectl port-forward svc/<release>-gambit-api 8080:8080
curl -s localhost:8080/v1/metrics | head -40
```

---

## GambitTargetDown

**Fires when:** Prometheus has been unable to scrape a Gambit target (`up{job=~"gambit.*"} == 0`)
for 5 minutes.

> If this alert has never fired and you doubt it works, check the selector first: it assumes scrape
> jobs named `gambit-…`. A matcher that matches nothing is silently inert. See
> `docs/OBSERVABILITY.md`.

**Deal with this first.** Every other alert in this file is blind while a target is down — an absent
series never breaches a threshold, so a dead API looks identical to a perfectly healthy one.

1. Which target, and is the pod alive?
   ```bash
   kubectl get pods -l app.kubernetes.io/name=gambit
   kubectl describe pod <pod>
   ```
   `CrashLoopBackOff` → go to the logs. `Running` but unscrapable → networking or port config.
2. Can anything reach the endpoint from inside the cluster?
   ```bash
   kubectl exec deploy/<release>-gambit-api -- wget -qO- localhost:8080/v1/health
   ```
3. If the pod is healthy and the endpoint answers, the fault is in the Prometheus scrape config or a
   NetworkPolicy, not in Gambit.

**Recovered when:** `up == 1` for the target and the SLI series reappear.

---

## GambitApiErrorBudgetBurnFast

**Fires when:** the 5xx ratio exceeds 7.2% over both 1h and 5m — 14.4x the sustainable rate. At this
pace the entire 30-day budget is gone in just over two days.

**This is a page. Something is broken right now.**

1. Is it one route or all of them?
   ```promql
   topk(5, sum by (route) (rate(http_requests_total{status=~"5.."}[5m])))
   ```
   One route → a specific handler or its dependency. All routes → Postgres, or a bad deploy.
2. Did it start at a deploy?
   ```bash
   kubectl rollout history deploy/<release>-gambit-api
   ```
   If the onset matches a rollout, roll back first and diagnose afterwards:
   ```bash
   kubectl rollout undo deploy/<release>-gambit-api
   ```
3. What is the error actually saying? Unexpected errors are logged with their stack; only
   `HttpError` messages reach a response body.
   ```bash
   kubectl logs deploy/<release>-gambit-api --tail=200 | grep -i "internal server error"
   ```
4. If every route is failing, check the database before anything else — a failed migration or an
   exhausted connection pool presents as uniform 5xx.

**Recovered when:** `gambit:api_error:ratio_rate5m` is back under 0.072 and falling. The 1h window
lags, so the alert clears a while after the fix; do not assume the fix failed.

---

## GambitApiErrorBudgetBurnMedium

**Fires when:** the 5xx ratio exceeds 3% over both 6h and 30m — 6x burn.

Same investigation as the fast burn, but the elevated rate has persisted long enough that a
transient cause is unlikely. Look for something intermittent rather than something broken:

1. A single failing replica — compare error rates per pod if the scrape adds a pod label, or
   `kubectl logs` each replica in turn.
2. A dependency degrading under load rather than failing outright: slow Postgres queries, Redis
   evictions, or the engine subprocess pool exhausted.
3. Correlate with latency — if `gambit:api_latency_slow:ratio_rate30m` rose at the same time, this is
   saturation, not a code fault.

---

## GambitApiErrorBudgetBurnSlow

**Fires when:** the 5xx ratio exceeds 1.5% over both 1d and 2h — 3x burn.

**This is a ticket, not a page.** Nothing is on fire, but the budget will be exhausted in about ten
days if nothing changes.

Find the persistent minority failure:

```promql
topk(10, sum by (route, status) (rate(http_requests_total{status=~"5.."}[6h])))
```

Common causes: one endpoint failing for a subset of inputs, a background worker retrying against a
broken dependency, or a client hammering a route that errors on malformed state.

---

## GambitApiLatencyBudgetBurnFast

**Fires when:** more than 14.4% of requests exceed 250 ms, over both 1h and 5m.

1. Which routes?
   ```promql
   histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
   ```
2. Is it saturation or a slow dependency? Check whether request rate rose at the same time. Latency
   climbing on flat traffic points at a dependency; climbing *with* traffic points at capacity.
3. Postgres is the usual answer. Check for long-running queries and connection-pool waits.
4. If `/v1/search` is disproportionately slow, note that ADR-0059 measured the `id` tie-break
   defeating the HNSW index — semantic search is a sequential scan by design today, so its latency
   scales with corpus size.

**Recovered when:** `gambit:api_latency_slow:ratio_rate5m` is back under 0.144.

---

## GambitApiLatencyBudgetBurnSlow

**Fires when:** more than 6% of requests exceed 250 ms over both 6h and 30m.

A warning. Usually the shape of gradual capacity loss — a table that has grown past its indexes, a
cache that stopped being effective, or steadily rising traffic. Compare this week's p95 against last
week's before changing anything.

---

## GambitSpanExportFailing

**Fires when:** more than 5% of spans fail to reach the collector over 10 minutes.

Traces are being lost, which means the *next* incident will be harder to diagnose than this one.
The application is unaffected — export is best-effort and never blocks a request.

1. Failing or dropping? They mean different things.
   ```promql
   sum(rate(span_export_failed_total[5m]))
   sum(rate(span_export_dropped_total[5m]))
   ```
   Failed → the collector rejected or was unreachable. Dropped → the queue overflowed; see
   `GambitSpanQueueOverflowing`.
2. Is the collector endpoint right and reachable?
   ```bash
   kubectl exec deploy/<release>-gambit-api -- env | grep OTEL
   ```
   The chart renders these only when `tracing.enabled=true` (ADR-0062).
3. `FetchSpanTransport` classifies failures: `408`/`429`/`5xx` and network errors are retried up to
   three times; other `4xx` are permanent and are not retried, because a 401 or 413 will fail
   identically forever. A permanent failure means credentials or payload size, not availability.

**Mitigation if the collector cannot be fixed quickly:** unset `OTEL_EXPORTER_OTLP_ENDPOINT` so
export falls back to log-only. Spans still reach the structured logs.

---

## GambitSpanQueueOverflowing

**Fires when:** `span_export_dropped_total` has been increasing for 15 minutes.

`BatchSpanProcessor` is evicting the oldest spans to stay within `maxQueueSize` (2048). Spans are
arriving faster than they can be exported.

1. Nearly always a slow or unreachable collector rather than a traffic spike — check
   `GambitSpanExportFailing` first, since the two usually fire together.
2. If export is succeeding but the queue is still overflowing, the service is genuinely producing
   more spans than the pipeline can carry. Reduce sampling rather than raising the queue size:
   ```
   OTEL_TRACES_SAMPLER_ARG=0.1
   ```
   A larger queue delays the same loss and costs memory.
3. Note that a value outside `[0, 1]` is rejected with a warning and falls back to always-on
   sampling (ADR-0062), so check the logs after changing it.

---

## GambitGatewayAuthFailureSpike

**Fires when:** more than one WebSocket token verification failure per second **across all gateway
replicas** (`sum(rate(...))`), sustained 10 minutes.

Two very different causes, and the first is far more likely:

1. **Secret mismatch after a deploy.** The gateway verifies tokens with a shared secret rather than
   calling the API, so if `ACCESS_TOKEN_SECRET` differs between them, *every* token fails. Check
   both:
   ```bash
   kubectl get secret <release>-gambit -o jsonpath='{.data.ACCESS_TOKEN_SECRET}' | base64 -d | sha256sum
   kubectl exec deploy/<release>-gambit-gateway -- sh -c 'echo -n "$ACCESS_TOKEN_SECRET" | sha256sum'
   ```
   Compare hashes — never print the secret itself. A mismatch means a partial rollout: both
   Deployments need the same Secret version.
2. **Credential stuffing against the socket.** If the secrets match and the API's own auth error
   rate rose too, it is an attack. Note that anonymous connections are permitted for spectating and
   are *not* counted here — this metric only moves when a token was supplied and failed to verify.

Expired tokens produce a low background rate; that is normal and should not reach one per second.

**Recovered when:** `rate(gateway_auth_failures_total[5m])` returns to its baseline.

---

## Gateway Chaos & Multi-Node Failover Runbook

### Running the Chaos Test Suite Locally

The chaos test suite exercises multi-node game authority ownership, command forwarding, ungraceful crash failover, graceful drain handoff, and Redis loss recovery using a two-node Docker Compose stack.

**Execution:**
```bash
# Bring up the two-node chaos stack
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build

# Run the automated chaos test suite
node scripts/chaos-test.mjs

# Teardown the stack when done
docker compose -f docker-compose.yml -f docker-compose.chaos.yml down -v
```

### Production Failure Modes & Observability Signs

1. **Ungraceful Gateway Node Crash (SIGKILL / OOM / Host Failure)**:
   - **Production Symptom**: Active WebSocket connections on the failed node drop. Clients automatically reconnect (or open new connections) to surviving gateway nodes.
   - **Observability Signal**: `gateway_owned_games` gauge drops on crashed pod (or pod disappears from Prometheus scrape target). `gateway_ownership_claims_total` counter increments on surviving nodes as commands arrive for orphaned games and the 30s lease TTL (or shortened test TTL) expires.
   - **Recovery Verification**: Ensure surviving nodes successfully claim ownership and process commands. Verify Postgres event log has zero missing or duplicate events for active games.

2. **Graceful Node Drain / Maintenance (SIGTERM / Helm Rollout)**:
   - **Production Symptom**: Gateway replica receives SIGTERM. `OwnershipRegistry.releaseAll()` runs compare-and-delete Lua scripts for all owned games before exit.
   - **Observability Signal**: `gateway_ownership_releases_total` counter increments on terminating node; `gateway_owned_games` drops to 0. Successor node claims ownership immediately on the next client command without waiting for lease TTL expiry.
   - **Recovery Verification**: Forwarding latency and claim latency remain low during rolling gateway upgrades.

3. **Redis Outage / Connectivity Loss**:
   - **Production Symptom**: When Redis is unreachable, non-owner nodes cannot forward commands and fail immediately. Owner nodes continue serving local commands through the fast path for the remainder of their valid lease window (derived from `OWNERSHIP_LEASE_TTL_SEC` and `OWNERSHIP_RENEWAL_INTERVAL_SEC`, up to ~22 seconds under production defaults). Once the safety margin window ages out without successful renewal, the owner closes the fast path and fails closed (rejecting commands) to prevent split-brain execution.
   - **Observability Signal**: `gateway_ownership_renewal_failures_total` counter spikes on owner nodes. `gateway_fast_path_commands_total` increments while in the valid lease window, then stops when the lease ages out. Non-owner nodes increment `gateway_forward_timeouts_total`. Logs report `[OwnershipRegistry] renewal failed`.
   - **Operator Action**: Restore Redis or repair network connectivity as quickly as possible. If Redis is restored before the lease window ages out (~22s), ongoing games on owner nodes suffer zero interruption. If Redis remains down past the lease window, ongoing games fail closed safely until Redis connectivity is restored and renewals/claims resume. Once Redis connectivity is restored, `pingRedis` health checks succeed, lease renewals resume, and command routing recovers automatically.

## Games projection lagging, failing, or needing a rebuild

The gateway folds `game_events` into `games` continuously ([ADR-0147](adr/0147-durable-games-projection.md)); nobody has to run anything for live games.

- **Is it keeping up?** Compare the checkpoint with the log. `SELECT updated_at FROM projection_checkpoints WHERE projection = 'games'` should be recent while games are played, and
  `SELECT count(*) FROM game_events e, projection_checkpoints c WHERE c.projection = 'games' AND (e.xact_id, e.game_id, e.seq) > (c.xact_id, c.game_id, c.seq)` should stay small.
  A backlog that does not drain usually means a long-running or idle-in-transaction session anywhere on the PostgreSQL server holding back the transaction horizon: find it in `pg_stat_activity` (`xact_start`) and end it. Gateway logs `Games projection batch failed` mean the database itself is failing.
- **Failed streams.** `SELECT game_id, attempts, last_error, retry_at FROM games_projection_failures`. Each row is also logged as `Games projection failed for a game stream`. They are retried automatically (at most hourly, and immediately on the game's next event); fix the cause (usually a missing upcaster in a deploy) rather than deleting rows. A failure row is removed by the first successful re-fold.
- **Rebuild** (after a logical restore into a different cluster, or to repair rows by hand): run it from any API container, beside running gateways.
  Compose: `docker compose exec api sh -c "cd packages/persistence && node dist/pg/games-rebuild-cli.js"`.
  Kubernetes: `kubectl exec <any-api-pod> -- npm run games:rebuild --workspace @chess-platform/persistence` (the same command the chart uses for `migrate`).
  It prints the number of games projected and deferred to the live projector, and exits non-zero if any stream failed or a page kept conflicting with live projection (rerun it). Endings the rebuild itself makes terminal do not wake the search indexer or achievements; run `reindex-search` afterwards if needed.

