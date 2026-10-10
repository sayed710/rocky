# Deploying Gambit to Kubernetes

> M14 Increment 4 — Helm chart for Kubernetes deployment.

This guide covers deploying the Gambit platform to a Kubernetes cluster using
the bundled Helm chart at `deploy/helm/gambit/`. It is the next step after the
docker-compose local stack (M14 increment 1) and mirrors the same service
topology: Postgres, Redis, API, WebSocket gateway, and web frontend.

## Prerequisites

- A Kubernetes cluster (e.g., [kind](https://kind.sigs.k8s.io/), minikube, or a
  cloud provider)
- [Helm](https://helm.sh/) 3.x
- Container images built and pushed to a registry (see [Building images](#building-images))

## Quick start (kind / local cluster)

```bash
# 1. Build and push images to your registry (or load into kind)
docker build -f Dockerfile.api     -t ghcr.io/senasehs19-oss/gambit-api:latest .
docker build -f Dockerfile.gateway -t ghcr.io/senasehs19-oss/gambit-gateway:latest .
docker build -f Dockerfile.web     -t ghcr.io/senasehs19-oss/gambit-web:latest .

# For kind, load images directly:
kind load docker-image ghcr.io/senasehs19-oss/gambit-api:latest
kind load docker-image ghcr.io/senasehs19-oss/gambit-gateway:latest
kind load docker-image ghcr.io/senasehs19-oss/gambit-web:latest

# 2. Install the chart
helm install gambit deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console

# 3. Check that everything is running
kubectl get pods

# 4. Port-forward the web service to access the UI
kubectl port-forward svc/gambit-web 3000:8080
# Open http://localhost:3000
```

## Building images

The chart references images via `values.yaml`:

| Service | Image | Dockerfile |
|---|---|---|
| API | `images.api.repository` | `Dockerfile.api` |
| Gateway | `images.gateway.repository` | `Dockerfile.gateway` |
| Web | `images.web.repository` | `Dockerfile.web` |

Override the repository and tag:

```bash
helm install gambit deploy/helm/gambit \
  --set images.api.repository=my-registry/gambit-api \
  --set images.api.tag=v1.0.0 \
  --set images.gateway.repository=my-registry/gambit-gateway \
  --set images.gateway.tag=v1.0.0 \
  --set images.web.repository=my-registry/gambit-web \
  --set images.web.tag=v1.0.0
```

## Configuration

### Key values

| Value | Default | Description |
|---|---|---|
| `gateway.replicas` | `2` | Safe horizontal scaling through Redis ownership/command forwarding |
| `api.replicas` | `2` | API is stateless, can scale horizontally |
| `web.replicas` | `2` | Web is stateless, can scale horizontally |
| `postgres.enabled` | `true` | Bundle Postgres as a StatefulSet |
| `redis.enabled` | `true` | Bundle Redis as a StatefulSet |
| `externalDatabaseUrl` | `""` | External Postgres URL (when `postgres.enabled=false`) |
| `externalRedisUrl` | `""` | External Redis URL (when `redis.enabled=false`) |
| `secrets.existingSecret` | `""` | Existing Secret containing the required keys |
| `secrets.accessTokenSecret` | `""` | Required HMAC secret when `existingSecret` is not set |
| `secrets.postgresPassword` | `""` | Required when bundled Postgres is enabled |
| `email.provider` | `resend` | Single production transport; `console` is development-only |
| `email.from` | `""` | Required plain sender address on a Resend-verified domain |
| `email.publicWebOrigin` | `""` | Required HTTPS origin that must be trusted for fragment identity links |
| `email.timeoutMs` | `5000` | Bounded provider timeout in milliseconds |
| `secrets.externalSecrets.enabled` | `false` | Enable External Secrets Operator integration (ADR-0044) |
| `secrets.externalSecrets.secretStore.name` | `""` | SecretStore / ClusterSecretStore name |
| `secrets.externalSecrets.secretStore.kind` | `SecretStore` | SecretStore or ClusterSecretStore |
| `secrets.externalSecrets.accessTokenSecret.key` | `""` | Backing store key for ACCESS_TOKEN_SECRET |
| `secrets.externalSecrets.resendApiKey.key` | `""` | Backing store key for RESEND_API_KEY |
| `secrets.externalSecrets.postgresPassword.key` | `""` | Backing store key for POSTGRES_PASSWORD |
| `web.ingress.enabled` | `true` | Enable Ingress for the web service |
| `web.ingress.host` | `gambit.local` | Ingress hostname |
| `tracing.enabled` | `false` | Enable OTLP distributed trace export (ADR-0062) |
| `tracing.otlpEndpoint` | `""` | Base OTLP collector URL (`/v1/traces` appended) |
| `tracing.otlpTracesEndpoint` | `""` | Signal-specific OTLP traces URL (verbatim) |
| `tracing.samplerArg` | `""` | Trace sampling probability ratio in [0, 1] |
| `rollout.strategy` | `rolling` | `rolling`, `blueGreen` or `canary` (ADR-0075) |
| `rollout.blueGreen.activeColor` | `blue` | Color the primary Service selects; flipping it is the cutover |
| `rollout.blueGreen.colors.<color>.tag` | `""` | Image tag per color; falls back to `images.<component>.tag` |
| `rollout.blueGreen.preview.enabled` | `true` | Render the standby color and its preview host |
| `rollout.blueGreen.preview.replicas` | `""` | Standby size; empty means the same as the active color |
| `rollout.blueGreen.preview.host` | `""` | Preview hostname; empty means `preview.<web.ingress.host>` |
| `rollout.canary.weight` | `10` | Percent of ingress traffic to the canary track |
| `rollout.canary.tag` | `""` | Canary image tag — required when `strategy=canary` |
| `rollout.canary.replicas` | `1` | Canary replica count |
| `rollout.canary.header` | `""` | Header enabling deterministic canary opt-in |

### Secrets

**Never commit real secret values.** The chart templates secrets from
`.Values.secrets`. There are no placeholder credentials: Helm rendering fails
closed when the access-token secret is missing or shorter than 32 characters. Production Resend
delivery also requires an existing Secret or External Secrets reference containing
`RESEND_API_KEY`; the provider credential is not accepted as an inline chart value.
For a local/development install, provide inline application secrets and select the safe console
sender explicitly:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.accessTokenSecret="<your-secret>" \
  --set secrets.postgresPassword="<your-password>" \
  --set config.nodeEnv=development \
  --set email.provider=console
```

Alternatively reference a pre-existing Secret by setting `secrets.existingSecret`, or use the **External Secrets Operator** integration (`secrets.externalSecrets.enabled=true`) to sync directly from a secrets manager (AWS Secrets Manager, GCP Secret Manager, Vault, etc.). A production existing Secret contains `RESEND_API_KEY` as well as `ACCESS_TOKEN_SECRET` (and `POSTGRES_PASSWORD` when bundled Postgres is enabled).

### External secrets (production)

For production environments using the [External Secrets Operator](https://external-secrets.io/):

1. Install the External Secrets Operator in your Kubernetes cluster.
2. Create a `SecretStore` or `ClusterSecretStore` connected to your cloud secrets manager (e.g. AWS Secrets Manager, GCP Secret Manager, Vault).
3. Install the Gambit chart with `secrets.externalSecrets` enabled:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name="gambit-store" \
  --set secrets.externalSecrets.secretStore.kind="SecretStore" \
  --set secrets.externalSecrets.accessTokenSecret.key="production/gambit/access-token" \
  --set secrets.externalSecrets.resendApiKey.key="production/gambit/resend-api-key" \
  --set secrets.externalSecrets.postgresPassword.key="production/gambit/postgres-password" \
  --set email.from="security@your-verified-domain.example" \
  --set email.publicWebOrigin="https://your-public-web-origin.example"
```

When enabled, the chart renders an `ExternalSecret` custom resource (`apiVersion: external-secrets.io/v1`) that ESO reconciles into a Kubernetes Secret named `<fullname>-secret`. The API and Gateway deployments consume this Secret seamlessly. Note that `secrets.externalSecrets` and `secrets.existingSecret` are mutually exclusive.


### External datastores

For production, use managed Postgres and Redis:

```bash
helm install gambit deploy/helm/gambit \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl="postgres://user:pass@db.example.com:5432/gambit" \
  --set externalRedisUrl="redis://redis.example.com:6379" \
  --set secrets.existingSecret="gambit-production-secrets" \
  --set email.from="security@your-verified-domain.example" \
  --set email.publicWebOrigin="https://your-public-web-origin.example"
```

When `postgres.enabled=false`, the chart does not create the Postgres
StatefulSet/Service/PVC, and `DATABASE_URL` is set from `externalDatabaseUrl`.
The `POSTGRES_PASSWORD` key is omitted from the Secret (it is only needed for
the bundled Postgres). The same applies to Redis.

> [!NOTE]
> **Postgres `vector` Extension**: PostgreSQL must provide the `vector` extension (provided by `pgvector/pgvector:pg16` in bundled deployments). Managed Postgres databases used with `postgres.enabled=false` must have `pgvector` installed and available.

### Migrations

Database migrations run as an **init container** in the API Deployment, using
the same `npm run migrate --workspace @chess-platform/persistence` command that
the compose API runs. The migration init container runs before the API
container starts, ensuring the schema exists before the API serves traffic.

The gateway's init container (`wait-for-api`) waits for the API's health
endpoint to respond, which ensures the schema exists before the gateway starts
— mirroring compose's `depends_on: api: condition: service_healthy`.

### Health probes

| Service | Liveness | Readiness |
|---|---|---|
| API | `GET /v1/health` | `GET /v1/ready` (checks PostgreSQL) |
| Gateway | `GET :4176/health` | `GET :4176/ready` (checks PostgreSQL + Redis) |
| Web | `GET /` | `GET /` |

Kubernetes has no compose-style `depends_on`. Instead, health-gated ordering is
achieved via probes: the API's readiness probe prevents traffic until
migrations complete and the health endpoint responds; the gateway's init
container waits for the API to be Ready.

## Gateway scaling

M14 increment 5 added a Redis ownership registry and command forwarding. One
node owns each game; other nodes forward commands to it, while Redis pub/sub
fans authoritative broadcasts back to every connected client. Consequently
the chart now defaults to two gateway replicas. `REDIS_URL` is required for a
multi-replica deployment; keep one replica only when deliberately running
without Redis.

See `docs/adr/0010-game-authority-ownership.md` for the decision record.

## Release strategies (blue/green, canary)

`rollout.strategy` chooses how a new version reaches production. It covers the
**api and web** only — the gateway keeps its rolling update because a flip would
sever every live WebSocket connection, and its game-command ownership registry
(ADR-0010) is keyed by game rather than by version. See
`docs/adr/0075-progressive-delivery.md`.

**Before using either strategy:** both run two API versions against one database,
so any migration in the release must be backward compatible with the version
still serving (add columns, backfill, drop in a later release). Concurrent
migration runs are safe — the runner takes a database-wide advisory lock.

**Keep these values in a values file.** `helm upgrade` does not carry previous
`--set` flags forward, so the `...` in the examples below is not shorthand you can
drop — omitting the earlier flags reverts them to chart defaults. Put the release's
values in a file and pass `-f`, then a cutover really is one changed value:

```bash
helm upgrade gambit deploy/helm/gambit -f prod-values.yaml \
  --set rollout.blueGreen.activeColor=green
```

### Blue/green

Deploy the new version to the standby color, exercise it on the preview host,
then flip. Neither the flip nor the rollback restarts a pod.

```bash
# 1. Install/upgrade with both colors. Blue is active on 1.0.0;
#    green is the incoming 1.1.0, reachable only at preview.gambit.local.
helm upgrade gambit deploy/helm/gambit \
  --set rollout.strategy=blueGreen \
  --set rollout.blueGreen.activeColor=blue \
  --set rollout.blueGreen.colors.blue.tag=1.0.0 \
  --set rollout.blueGreen.colors.green.tag=1.1.0

# 2. Smoke-test the standby against production dependencies.
curl -H 'Host: preview.gambit.local' http://<ingress-ip>/v1/health

# 3. Cut over. This rewrites Service selectors and nothing else.
helm upgrade gambit deploy/helm/gambit ... --set rollout.blueGreen.activeColor=green

# 4. Roll back, if needed, at the same speed.
helm upgrade gambit deploy/helm/gambit ... --set rollout.blueGreen.activeColor=blue
```

The standby runs at the active color's replica count so it can absorb the flip
immediately. If you set `preview.replicas` lower to save cost, scale it back up
in a separate upgrade **before** flipping — otherwise the cutover moves all
traffic onto an under-provisioned fleet and scales up afterwards.

Keep the old color on its old tag after a flip. It is the rollback.

### Canary

A weighted share of ingress traffic goes to a second track. **Requires
ingress-nginx** — the split is its `canary-weight` annotation; other controllers
ignore it and would send full traffic to both Ingresses.

```bash
# 10% of traffic to 1.1.0, plus deterministic opt-in by header.
helm upgrade gambit deploy/helm/gambit \
  --set rollout.strategy=canary \
  --set rollout.canary.tag=1.1.0 \
  --set rollout.canary.weight=10 \
  --set rollout.canary.header=X-Gambit-Canary

# Test the canary on purpose rather than waiting to be sampled into it.
curl -H 'X-Gambit-Canary: always' http://<ingress-ip>/v1/health

# Ramp: 10 -> 25 -> 50 -> 100, watching the SLO dashboards (docs/SLO.md) at each step.
helm upgrade gambit deploy/helm/gambit ... --set rollout.canary.weight=25

# Abort: weight 0 leaves the canary staged and header-reachable but takes it out
# of sampled traffic immediately.
helm upgrade gambit deploy/helm/gambit ... --set rollout.canary.weight=0
```

Promote by making the canary tag the stable tag (`images.*.tag`) and returning
`rollout.strategy` to `rolling`, or by moving to blue/green for the cutover.

Each web variant is paired with the api variant of its own version, so a canary
user gets the canary frontend and the canary API — never a new SPA against the
old API.

### Notes

- Rendering is fail-closed: an unknown strategy, a preview whose two colors
  resolve to the same image, a canary with no tag, a canary with no Ingress, or a
  weight outside 0–100 all fail `helm template` rather than producing a release
  that looks progressive and is not.
- You only have to set the incoming color's tag. The other color falls back to
  `images.<component>.tag`, so leave that at the version you would roll back to —
  and a flip never newly breaks the render.
- Switching *strategies* on a live release renames Deployments (`…-api` becomes
  `…-api-blue` or `…-api-stable`), so Helm deletes and recreates them. This is
  deliberate: a Deployment's `spec.selector` is immutable, so keeping the name
  would make the upgrade fail instead. Flips within blue/green and canary weight
  changes do not have this effect.
- With TLS enabled, the preview host reuses the primary certificate secret, so
  that certificate must cover the preview hostname (wildcard or explicit SAN).

## Automated CI/CD release & deployment runbook

M14 Increment 10 (ADR-0076) provides automated GitHub Actions workflows for publishing release images and executing gated Kubernetes deployments.

### 1. Cut a release tag

Ensure `deploy/helm/gambit/Chart.yaml` has its `appVersion` bumped to match your target version (e.g. `"1.2.3"`).

```bash
git tag v1.2.3
git push origin v1.2.3
```

Pushing `v1.2.3` triggers `.github/workflows/release.yml`, which:
1. Runs full verification (`npm ci`, `npm run build`, `npm test`, `npm run lint`).
2. Asserts that tag version (`1.2.3`) matches `Chart.yaml` `appVersion`.
3. Builds and pushes three container images to GHCR:
   - `ghcr.io/senasehs19-oss/gambit-api:1.2.3` (and `:1.2.3-<sha>`)
   - `ghcr.io/senasehs19-oss/gambit-gateway:1.2.3` (and `:1.2.3-<sha>`)
   - `ghcr.io/senasehs19-oss/gambit-web:1.2.3` (and `:1.2.3-<sha>`)

### 2. Deploy to staging

Before deploying, define `EMAIL_FROM` and `PUBLIC_WEB_ORIGIN` as non-secret variables in both the
`staging` and `production` GitHub Environments. The sender domain must be verified in Resend; the
origin must be the reachable canonical HTTPS web origin. The workflow fails before Helm if either
variable is absent. Keep `RESEND_API_KEY` in the Kubernetes Secret/ExternalSecret described above.

Once images publish, trigger `.github/workflows/deploy.yml` manually via **workflow_dispatch** (or automatically via `release: [published]`):
- **version**: `1.2.3`
- **environment**: `staging`
- **strategy**: `rolling` (or `blueGreen` / `canary`)

The pipeline validates image existence in GHCR, verifies the `KUBECONFIG` secret, applies `deploy/environments/staging.values.yaml`, and executes an atomic rollout:
```bash
helm upgrade --install gambit deploy/helm/gambit \
  --atomic --wait --timeout 5m0s \
  -f deploy/environments/staging.values.yaml \
  --set-string email.from="$EMAIL_FROM" \
  --set-string email.publicWebOrigin="$PUBLIC_WEB_ORIGIN" \
  --set images.api.tag=1.2.3 \
  --set images.gateway.tag=1.2.3 \
  --set images.web.tag=1.2.3
```

### 3. Promote to production

After staging validation passes, trigger `.github/workflows/deploy.yml` via **workflow_dispatch**.
GitHub environment protection holds the job pending approval; once approved it verifies the images
exist in GHCR, applies `deploy/environments/production.values.yaml`, pre-flight renders the release,
and executes `helm upgrade --atomic`.

With `rolling` or `canary` that is one run. **Blue/green is two**, matching the flow described under
"Release strategies" above — stage, verify on the preview host, then flip. The two colour inputs
express both:

| Run | `target_color` | `active_color` | Effect |
|---|---|---|---|
| Stage | `green` | `blue` | `green` gets 1.2.3 and is reachable at `preview.<host>`; `blue` keeps serving the live version; the gateway is not moved |
| Flip | `green` | `green` | `green` starts serving traffic and the gateway moves to 1.2.3; `blue` stays on the old version as the rollback target |

Setting `target_color` equal to `active_color` in a single run is a straight cutover — legitimate,
but it skips the preview, which is the reason to choose blue/green in the first place.

Everything the run does *not* change stays on what the deployed release runs. Before the upgrade the
workflow reads the deployed revision's tags (`helm history` + `helm get values --all`, via
`scripts/resolve-deployed-image-tags.mjs`) and pins them: on a stage, the live colour, the gateway
and the trust worker keep their versions; on a cutover, the other colour keeps its previous
assignment. That is the version just replaced only when you cut over to the standby colour (the
normal stage-then-flip); cutting over onto the colour already live replaces that version, so to keep
it as the rollback target, always target the standby. Without this, `helm upgrade` (which does not reuse the
release's values) would fall back to the baseline `images.*.tag` in the environment values file. If
the deployed tags cannot be read exactly, or the newest release revision is not the deployed one,
the deploy is refused. A stage must also keep `active_color` on the colour serving traffic now; to
change the serving colour, run a cutover. What is kept is the image *version*: a strategy switch or a
new chart version can still restart the gateway and trust worker (their `wait-for-api` init image
follows `images.api.tag`, and their pod labels carry the chart version).

A canary run works the same way: the stable track, the gateway and the trust worker stay on the
deployed version and only the canary track gets the new one. Promote it with a `rolling` run of that
version. The chart refuses a canary whose tag equals the stable track's, and the workflow refuses a
canary initial install for the same reason it refuses a blue/green one.

A blue/green **initial install is rejected**: with no live release there is no published baseline for
the standby colour to hold, and nothing to roll back to. Install first with `strategy=rolling`.

### 4. Rollback procedure

If an issue is detected during or after deployment:
- **Automatic Rollback**: The deployment workflow passes `--atomic --wait --timeout 5m0s`. If pods fail health probes or rollouts time out, Helm automatically reverts to the previous working release revision before the workflow finishes.
- **Manual Rollback (Blue/Green)**: Flip `activeColor` back to the standby color in one command:
  ```bash
  helm upgrade gambit deploy/helm/gambit -f deploy/environments/production.values.yaml \
    --set rollout.strategy=blueGreen \
    --set rollout.blueGreen.activeColor=blue
  ```
- **Manual Rollback (Helm CLI)**:
  ```bash
  helm rollback gambit --wait --timeout 5m0s
  ```

## Search indexer and reindex CLI

The live search indexer (ADR-0056, ADR-0061) keeps `search_documents` and `search_embeddings` current by consuming game-ended broadcasts. Its dedup set is process-local, so it runs in a dedicated single-replica Deployment instead of on the gateway replicas:

```bash
helm upgrade gambit deploy/helm/gambit --set gateway.searchIndexer.enabled=true
```

That Deployment's replica count is fixed at 1 by design and is not exposed as a value — two indexers would each read and upsert every finished game. The upsert is idempotent, so the index would still be correct, just built twice.

`--set search.semanticEnabled=false` disables writing vector embeddings (ADR-0061), causing the indexer to write keyword documents (`search_documents`) only. `--set search.enabled=false` disables search altogether (ADR-0055): the API stops constructing a search repository and `GET /v1/search` returns 503. Combining `search.enabled=false` with an enabled indexer fails at template time.

### Backfill existing data

To populate search indexes (both keyword and vector embeddings) for pre-existing games, players, and tournaments, run the backfill script:

```bash
npm run reindex-search -w @chess-platform/api
```

When `SEMANTIC_SEARCH_ENABLED !== '0'`, the reindex script generates 256-dimensional vector embeddings and writes to both `search_documents` and `search_embeddings` (ADR-0061).

See `docs/adr/0057-search-indexer-deployment.md` and `docs/adr/0061-embedding-pipeline.md` for decision records.

## Validation

```bash
# Lint the chart
helm lint deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console

# Render templates (default values)
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console

# Render templates (external datastores)
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379 \
  --set config.nodeEnv=development \
  --set email.provider=console

# Validate against Kubernetes schemas
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console \
  | kubeconform -strict -summary

# Render the progressive-delivery strategies (they add objects the default
# render does not have, so each needs its own schema pass)
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console \
  --set rollout.strategy=blueGreen \
  --set rollout.blueGreen.colors.green.tag=0.2.0 \
  | kubeconform -strict -summary

helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  --set config.nodeEnv=development \
  --set email.provider=console \
  --set rollout.strategy=canary \
  --set rollout.canary.tag=0.2.0 \
  | kubeconform -strict -summary

# Run the snapshot test (verifies key wiring)
PATH=/usr/local/bin:$PATH bash scripts/helm-snapshot-test.sh
```

## Uninstalling

```bash
helm uninstall gambit
```

This removes all resources created by the chart. PVCs for Postgres and Redis
are retained by default (StatefulSet PVCs are not automatically deleted). To
delete them:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=gambit
```
