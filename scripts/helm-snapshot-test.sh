#!/usr/bin/env bash
#
# Snapshot test: proves key wiring of the Gambit Helm chart.
#
# Verifies:
#   1. Gateway replicas == 2
#   2. API + gateway share the same DATABASE_URL source (both reference
#      $(POSTGRES_PASSWORD) from the Secret when postgres is bundled)
#   3. POSTGRES_PASSWORD appears BEFORE DATABASE_URL in every container's
#      env list (Kubernetes only expands $(VAR) for vars defined earlier —
#      regression guard for the env-ordering bug)
#   4. Gateway gets REDIS_URL + NODE_ID from the pod name (downward API)
#   5. Secrets come from the Secret (not hardcoded in env)
#   6. Probes hit the correct endpoints
#   7. Search indexer (ADR-0057): opt-in, pinned to one replica, no Service,
#      absent from the default render, and mutually exclusive with search
#      being disabled
#
set -euo pipefail

CHART_DIR="deploy/helm/gambit"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

# Emit the single YAML document that is both a Deployment and carries the given
# component label, so env assertions can be scoped to one container instead of
# grepping the whole release. Uses awk's record separator on the document
# delimiter — no yq dependency.
deployment_doc() {
  local file="$1"
  local component="$2"
  awk -v c="app.kubernetes.io/component: $component" '
    BEGIN { RS = "\n---\n" }
    $0 ~ /kind: Deployment/ && index($0, c) { print; exit }
  ' "$file"
}

# Render default values
HELM_SECRETS=(
  --set secrets.accessTokenSecret=test-only-access-token-secret-32-bytes-minimum
  --set secrets.postgresPassword=test-only-postgres-password
  --set config.nodeEnv=development
  --set email.provider=console
)
HELM_PRODUCTION_EMAIL=(
  --set-string email.from=security@example.test
  --set-string email.publicWebOrigin=https://app.example.test
)

helm template "$CHART_DIR" "${HELM_SECRETS[@]}" > "$TMPDIR/default.yaml" 2>/dev/null

# Render without an external ingress hop. The internal web nginx remains the
# sole trusted proxy, so TRUST_PROXY must be derived as one hop.
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set web.ingress.enabled=false > "$TMPDIR/ingress-off.yaml" 2>/dev/null

# Render external-datastore override
helm template "$CHART_DIR" \
  --set secrets.accessTokenSecret=test-only-access-token-secret-32-bytes-minimum \
  --set config.nodeEnv=development \
  --set email.provider=console \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379 \
  > "$TMPDIR/external.yaml" 2>/dev/null

# Render external-secrets override
helm template "$CHART_DIR" \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379 \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name=gambit-store \
  --set secrets.externalSecrets.accessTokenSecret.key=gambit/access-token \
  --set secrets.externalSecrets.resendApiKey.key=gambit/resend-api-key \
  "${HELM_PRODUCTION_EMAIL[@]}" \
  > "$TMPDIR/external-secrets.yaml" 2>/dev/null

# Production delivery accepts a Secret reference, never an inline provider credential.
helm template "$CHART_DIR" \
  --set secrets.existingSecret=test-production-secrets \
  "${HELM_PRODUCTION_EMAIL[@]}" \
  > "$TMPDIR/production-email.yaml" 2>/dev/null

# Rendering without a secret must fail closed.
if helm template "$CHART_DIR" \
     --set config.nodeEnv=development --set email.provider=console > /dev/null 2>&1; then
  echo "Chart rendered without ACCESS_TOKEN_SECRET"
  exit 1
fi

echo ""
echo "=== Snapshot test: key wiring ==="
echo ""

# --- Trusted edge topology -------------------------------------------------
DEFAULT_TRUST_PROXY=$(yq 'select(.kind=="ConfigMap") | .data.TRUST_PROXY' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
INGRESS_OFF_TRUST_PROXY=$(yq 'select(.kind=="ConfigMap") | .data.TRUST_PROXY' "$TMPDIR/ingress-off.yaml" 2>/dev/null || echo "")
check "Trusted edge: ingress + web derives TRUST_PROXY=2" "$([ "$DEFAULT_TRUST_PROXY" = "2" ] && echo 0 || echo 1)"
check "Trusted edge: web-only topology derives TRUST_PROXY=1" "$([ "$INGRESS_OFF_TRUST_PROXY" = "1" ] && echo 0 || echo 1)"

NETWORK_POLICY_COUNT=$(yq 'select(.kind=="NetworkPolicy") | .metadata.name' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | grep -c . || true)
INGRESS_OFF_NETWORK_POLICY_COUNT=$(yq 'select(.kind=="NetworkPolicy") | .metadata.name' "$TMPDIR/ingress-off.yaml" 2>/dev/null | grep -vx -- '---' | grep -c . || true)
API_ALLOWED_COMPONENTS=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="api") | .spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | sort | tr '\n' ' ' | sed 's/ $//')
GATEWAY_ALLOWED_COMPONENTS=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | sort | tr '\n' ' ' | sed 's/ $//')
WEB_ALLOWED_NAMESPACE=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="web") | .spec.ingress[0].from[0].namespaceSelector.matchLabels."kubernetes.io/metadata.name"' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
WEB_ALLOWED_POD=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="web") | .spec.ingress[0].from[0].podSelector.matchLabels."app.kubernetes.io/name"' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Trusted edge: three application NetworkPolicies render with Ingress" "$([ "$NETWORK_POLICY_COUNT" = "3" ] && echo 0 || echo 1)"
check "Trusted edge: web allows only the configured ingress-controller namespace" "$([ "$WEB_ALLOWED_NAMESPACE" = "ingress-nginx" ] && echo 0 || echo 1)"
check "Trusted edge: web allows only the configured ingress-controller pods" "$([ "$WEB_ALLOWED_POD" = "ingress-nginx" ] && echo 0 || echo 1)"
check "Trusted edge: web policy is omitted for the one-hop ingress-disabled topology" "$([ "$INGRESS_OFF_NETWORK_POLICY_COUNT" = "2" ] && echo 0 || echo 1)"
check "Trusted edge: only gateway and web pods can enter the API" "$([ "$API_ALLOWED_COMPONENTS" = "gateway web" ] && echo 0 || echo 1)"
check "Trusted edge: only web pods can enter the WebSocket gateway" "$([ "$GATEWAY_ALLOWED_COMPONENTS" = "web" ] && echo 0 || echo 1)"

# --- 1. Gateway replicas == 2 ---
GATEWAY_REPLICAS=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.replicas' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway replicas == 2 (default values)" "$([ "$GATEWAY_REPLICAS" = "2" ] && echo 0 || echo 1)"

# --- 2. API + gateway share the same DATABASE_URL source ---
API_DB_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
GW_DB_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API DATABASE_URL references \$(POSTGRES_PASSWORD)" "$([ "$API_DB_URL" = 'postgres://gambit:$(POSTGRES_PASSWORD)@release-name-gambit-postgres:5432/gambit' ] && echo 0 || echo 1)"
check "Gateway DATABASE_URL references \$(POSTGRES_PASSWORD)" "$([ "$GW_DB_URL" = 'postgres://gambit:$(POSTGRES_PASSWORD)@release-name-gambit-postgres:5432/gambit' ] && echo 0 || echo 1)"
check "API and gateway share the same DATABASE_URL source" "$([ "$API_DB_URL" = "$GW_DB_URL" ] && echo 0 || echo 1)"

# --- 2b. External datastore: DATABASE_URL comes from externalDatabaseUrl ---
API_DB_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
GW_DB_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
check "External: API DATABASE_URL = externalDatabaseUrl" "$([ "$API_DB_EXT" = 'postgres://user:pass@db.example.com:5432/gambit' ] && echo 0 || echo 1)"
check "External: Gateway DATABASE_URL = externalDatabaseUrl" "$([ "$GW_DB_EXT" = 'postgres://user:pass@db.example.com:5432/gambit' ] && echo 0 || echo 1)"

# --- 3. REGRESSION GUARD: POSTGRES_PASSWORD appears BEFORE DATABASE_URL ---
# Kubernetes only expands $(VAR) for vars defined earlier in the same env list.
# If POSTGRES_PASSWORD comes after DATABASE_URL, $(POSTGRES_PASSWORD) stays
# literal and the DB connection fails.

# Helper: get the env-array index of a named env var in a specific container
# Args: yaml_file, deployment_name_pattern, container_type (containers|initContainers), container_name, env_name
env_index() {
  local yaml_file="$1" dep_pattern="$2" container_type="$3" container_name="$4" env_name="$5"
  yq ". | select(.kind==\"Deployment\" and .metadata.name | test(\"$dep_pattern\")) | .spec.template.spec.${container_type}[] | select(.name==\"$container_name\") | .env | to_entries | .[] | select(.value.name==\"$env_name\") | .key" "$yaml_file" 2>/dev/null || echo "-1"
}

# API migrate initContainer
MIGRATE_PW_IDX=$(env_index "$TMPDIR/default.yaml" "api" "initContainers" "migrate" "POSTGRES_PASSWORD")
MIGRATE_DB_IDX=$(env_index "$TMPDIR/default.yaml" "api" "initContainers" "migrate" "DATABASE_URL")
check "API migrate: POSTGRES_PASSWORD (idx=$MIGRATE_PW_IDX) before DATABASE_URL (idx=$MIGRATE_DB_IDX)" "$([ -n "$MIGRATE_PW_IDX" ] && [ -n "$MIGRATE_DB_IDX" ] && [ "$MIGRATE_PW_IDX" -lt "$MIGRATE_DB_IDX" ] && echo 0 || echo 1)"

# API main container
API_PW_IDX=$(env_index "$TMPDIR/default.yaml" "api" "containers" "api" "POSTGRES_PASSWORD")
API_DB_IDX=$(env_index "$TMPDIR/default.yaml" "api" "containers" "api" "DATABASE_URL")
check "API container: POSTGRES_PASSWORD (idx=$API_PW_IDX) before DATABASE_URL (idx=$API_DB_IDX)" "$([ -n "$API_PW_IDX" ] && [ -n "$API_DB_IDX" ] && [ "$API_PW_IDX" -lt "$API_DB_IDX" ] && echo 0 || echo 1)"

# Gateway main container
GW_PW_IDX=$(env_index "$TMPDIR/default.yaml" "gateway" "containers" "gateway" "POSTGRES_PASSWORD")
GW_DB_IDX=$(env_index "$TMPDIR/default.yaml" "gateway" "containers" "gateway" "DATABASE_URL")
check "Gateway container: POSTGRES_PASSWORD (idx=$GW_PW_IDX) before DATABASE_URL (idx=$GW_DB_IDX)" "$([ -n "$GW_PW_IDX" ] && [ -n "$GW_DB_IDX" ] && [ "$GW_PW_IDX" -lt "$GW_DB_IDX" ] && echo 0 || echo 1)"

# --- 4. Gateway gets REDIS_URL + NODE_ID from pod name ---
GW_REDIS_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="REDIS_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway gets REDIS_URL (bundled redis)" "$([ "$GW_REDIS_URL" = 'redis://release-name-gambit-redis:6379' ] && echo 0 || echo 1)"

GW_NODE_ID_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="NODE_ID") | .valueFrom.fieldRef.fieldPath' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway NODE_ID from pod name (downward API)" "$([ "$GW_NODE_ID_REF" = 'metadata.name' ] && echo 0 || echo 1)"

# External redis
GW_REDIS_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="REDIS_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
check "External: Gateway REDIS_URL = externalRedisUrl" "$([ "$GW_REDIS_EXT" = 'redis://redis.example.com:6379' ] && echo 0 || echo 1)"

# --- 5. Secrets come from the Secret (not hardcoded) ---
API_SECRET_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API ACCESS_TOKEN_SECRET from Secret" "$([ "$API_SECRET_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

API_RESEND_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="RESEND_API_KEY") | .valueFrom.secretKeyRef.name' "$TMPDIR/production-email.yaml" 2>/dev/null || echo "")
check "Production API RESEND_API_KEY from existing Secret" "$([ "$API_RESEND_REF" = 'test-production-secrets' ] && echo 0 || echo 1)"

API_EMAIL_PROVIDER=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="EMAIL_PROVIDER") | .valueFrom.configMapKeyRef.key' "$TMPDIR/production-email.yaml" 2>/dev/null || echo "")
API_PUBLIC_ORIGIN=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="PUBLIC_WEB_ORIGIN") | .valueFrom.configMapKeyRef.key' "$TMPDIR/production-email.yaml" 2>/dev/null || echo "")
check "API EMAIL_PROVIDER from ConfigMap" "$([ "$API_EMAIL_PROVIDER" = 'EMAIL_PROVIDER' ] && echo 0 || echo 1)"
check "API PUBLIC_WEB_ORIGIN from ConfigMap" "$([ "$API_PUBLIC_ORIGIN" = 'PUBLIC_WEB_ORIGIN' ] && echo 0 || echo 1)"

GW_SECRET_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway ACCESS_TOKEN_SECRET from Secret" "$([ "$GW_SECRET_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

# Verify POSTGRES_PASSWORD comes from Secret (not hardcoded)
PG_PW_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="POSTGRES_PASSWORD") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API POSTGRES_PASSWORD from Secret" "$([ "$PG_PW_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

# --- 6. API has migration init container ---
MIGRATE_CMD=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.initContainers[] | select(.name=="migrate") | .command[2]' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API has migration init container" "$([ "$MIGRATE_CMD" = 'npm run migrate --workspace @chess-platform/persistence' ] && echo 0 || echo 1)"

# --- 7. Gateway has wait-for-api init container ---
WAIT_CMD=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.initContainers[] | select(.name=="wait-for-api") | .name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway has wait-for-api init container" "$([ "$WAIT_CMD" = 'wait-for-api' ] && echo 0 || echo 1)"

# --- 8. Probes hit correct endpoints ---
API_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API readiness probe hits /v1/ready" "$([ "$API_PROBE" = '/v1/ready' ] && echo 0 || echo 1)"

GW_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway readiness probe hits /ready" "$([ "$GW_PROBE" = '/ready' ] && echo 0 || echo 1)"

WEB_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("web")) | .spec.template.spec.containers[] | select(.name=="web") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Web readiness probe hits /" "$([ "$WEB_PROBE" = '/' ] && echo 0 || echo 1)"

# --- 9. External secrets integration ---
ES_KIND=$(grep -c 'kind: ExternalSecret' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: renders kind: ExternalSecret" "$([ "$ES_KIND" -gt 0 ] && echo 0 || echo 1)"

ES_API_VER=$(grep -c 'apiVersion: external-secrets.io/v1' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: apiVersion external-secrets.io/v1" "$([ "$ES_API_VER" -gt 0 ] && echo 0 || echo 1)"

ES_TARGET=$(yq '. | select(.kind=="ExternalSecret") | .spec.target.name' "$TMPDIR/external-secrets.yaml" 2>/dev/null || grep -A2 'target:' "$TMPDIR/external-secrets.yaml" | grep 'name:' | head -n1 | awk '{print $2}')
GW_SECRET_REF_ES=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/external-secrets.yaml" 2>/dev/null || grep -A3 'ACCESS_TOKEN_SECRET' "$TMPDIR/external-secrets.yaml" | grep 'name:' | head -n1 | awk '{print $2}')
check "External secrets: target.name resolves to consumer secretKeyRef name" "$([ -n "$ES_TARGET" ] && [ "$ES_TARGET" = "$GW_SECRET_REF_ES" ] && [ "$ES_TARGET" = "release-name-gambit-secret" ] && echo 0 || echo 1)"

ES_SECRET_COUNT=$(grep -c '^kind: Secret$' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: inline Secret is not rendered (kind: Secret count == 0)" "$([ "$ES_SECRET_COUNT" = "0" ] && echo 0 || echo 1)"

DEFAULT_SECRET_COUNT=$(grep -c '^kind: Secret$' "$TMPDIR/default.yaml" || true)
DEFAULT_ES_COUNT=$(grep -c '^kind: ExternalSecret$' "$TMPDIR/default.yaml" || true)
check "Default render: exactly one kind: Secret" "$([ "$DEFAULT_SECRET_COUNT" = "1" ] && echo 0 || echo 1)"
check "Default render: no kind: ExternalSecret" "$([ "$DEFAULT_ES_COUNT" = "0" ] && echo 0 || echo 1)"


# --- Search indexer (M14 inc 7, ADR-0057) -----------------------------------
# The live indexer (ADR-0056) dedups in-process, so exactly one process may run
# it per release. These assertions guard that invariant in the chart: it must be
# opt-in, pinned to a single replica, and must not gain a Service (which would
# imply it takes traffic and could be scaled behind a load balancer).
echo ""
echo "Search indexer (ADR-0057):"

helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set gateway.searchIndexer.enabled=true > "$TMPDIR/indexer.yaml" 2>/dev/null

# Opt-in: absent unless explicitly enabled.
DEFAULT_IX=$(grep -c 'app.kubernetes.io/component: search-indexer' "$TMPDIR/default.yaml" || true)
check "Default render: no search-indexer resources" "$([ "$DEFAULT_IX" = "0" ] && echo 0 || echo 1)"

# Present when enabled.
IX_PRESENT=$(grep -c 'app.kubernetes.io/component: search-indexer' "$TMPDIR/indexer.yaml" || true)
check "Indexer enabled: search-indexer resources render" "$([ "$IX_PRESENT" -gt 0 ] && echo 0 || echo 1)"

# Exactly one Deployment, and its replica count is 1. Read the replicas line that
# follows the search-indexer Deployment's metadata, without depending on yq.
IX_REPLICAS=$(awk '
  /^kind: Deployment$/ { indoc=1; isix=0 }
  indoc && /app.kubernetes.io\/component: search-indexer/ { isix=1 }
  isix && /^  replicas:/ { print $2; exit }
' "$TMPDIR/indexer.yaml")
check "Indexer: replicas == 1 (pinned, not configurable)" "$([ "$IX_REPLICAS" = "1" ] && echo 0 || echo 1)"

# SEARCH_INDEXER must be set to exactly "1", inside the search-indexer
# Deployment, and must appear nowhere else in the release.
IX_DOC=$(deployment_doc "$TMPDIR/indexer.yaml" search-indexer)
IX_SCOPED=$(printf '%s\n' "$IX_DOC" | grep -A1 'name: SEARCH_INDEXER' | grep -c 'value: "1"' || true)
IX_GLOBAL=$(grep -c 'name: SEARCH_INDEXER' "$TMPDIR/indexer.yaml" || true)
check "Indexer: SEARCH_INDEXER=\"1\" on the search-indexer container" "$([ "$IX_SCOPED" = "1" ] && echo 0 || echo 1)"
check "Indexer: SEARCH_INDEXER appears nowhere else in the release" "$([ "$IX_GLOBAL" = "1" ] && echo 0 || echo 1)"

# The gateway Deployment must NOT carry the flag — duplicate indexing is not
# made safe by CAS the way TOURNAMENT_REPORTER is.
GW_FLAG=$(grep -c 'name: SEARCH_INDEXER' "$TMPDIR/default.yaml" || true)
check "Gateway render: SEARCH_INDEXER is not set on gateway replicas" "$([ "$GW_FLAG" = "0" ] && echo 0 || echo 1)"

# No Service for the indexer: Service count is unchanged by enabling it.
SVC_DEFAULT=$(grep -c '^kind: Service$' "$TMPDIR/default.yaml" || true)
SVC_INDEXER=$(grep -c '^kind: Service$' "$TMPDIR/indexer.yaml" || true)
check "Indexer: adds no Service (Service count unchanged)" "$([ "$SVC_DEFAULT" = "$SVC_INDEXER" ] && echo 0 || echo 1)"

# Enabling it adds exactly one resource (the Deployment).
DOCS_DEFAULT=$(grep -c '^kind: ' "$TMPDIR/default.yaml" || true)
DOCS_INDEXER=$(grep -c '^kind: ' "$TMPDIR/indexer.yaml" || true)
check "Indexer: adds exactly one resource to the release" "$([ "$((DOCS_INDEXER - DOCS_DEFAULT))" = "1" ] && echo 0 || echo 1)"

# Rollout strategy must be explicit and zero-gap. Recreate / maxSurge 0 would
# leave the fire-and-forget game-ended channel unsubscribed during upgrades.
IX_SURGE=$(grep -c 'maxSurge: 1' "$TMPDIR/indexer.yaml" || true)
IX_UNAVAIL=$(grep -c 'maxUnavailable: 0' "$TMPDIR/indexer.yaml" || true)
IX_RECREATE=$(grep -c 'type: Recreate' "$TMPDIR/indexer.yaml" || true)
check "Indexer: explicit maxSurge 1 / maxUnavailable 0 (no rollout gap)" "$([ "$IX_SURGE" = "1" ] && [ "$IX_UNAVAIL" = "1" ] && [ "$IX_RECREATE" = "0" ] && echo 0 || echo 1)"

# Fail closed: indexer enabled while search is disabled must not render.
if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
     --set gateway.searchIndexer.enabled=true \
     --set search.enabled=false >/dev/null 2>&1; then
  check "Fail-closed: indexer + search.enabled=false is rejected" 1
else
  check "Fail-closed: indexer + search.enabled=false is rejected" 0
fi

# The ADR-0055 kill switch reaches the API.
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set search.enabled=false > "$TMPDIR/search-off.yaml" 2>/dev/null
API_DOC=$(deployment_doc "$TMPDIR/search-off.yaml" api)
KILL_SCOPED=$(printf '%s\n' "$API_DOC" | grep -A1 'name: SEARCH_ENABLED' | grep -c 'value: "0"' || true)
KILL_GLOBAL=$(grep -c 'name: SEARCH_ENABLED' "$TMPDIR/search-off.yaml" || true)
check "search.enabled=false sets SEARCH_ENABLED=\"0\" on the API container" "$([ "$KILL_SCOPED" = "1" ] && echo 0 || echo 1)"
check "search.enabled=false sets SEARCH_ENABLED nowhere else" "$([ "$KILL_GLOBAL" = "1" ] && echo 0 || echo 1)"

# And it must be absent entirely when search is enabled (the app keeps its default).
KILL_DEFAULT=$(grep -c 'name: SEARCH_ENABLED' "$TMPDIR/default.yaml" || true)
check "Default render: SEARCH_ENABLED is not set at all" "$([ "$KILL_DEFAULT" = "0" ] && echo 0 || echo 1)"

# The ADR-0060 semantic switch narrows the kill to ?mode=semantic|hybrid.
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set search.semanticEnabled=false > "$TMPDIR/semantic-off.yaml" 2>/dev/null
API_DOC=$(deployment_doc "$TMPDIR/semantic-off.yaml" api)
SEM_SCOPED=$(printf '%s\n' "$API_DOC" | grep -A1 'name: SEMANTIC_SEARCH_ENABLED' | grep -c 'value: "0"' || true)
SEM_KEYWORD=$(printf '%s\n' "$API_DOC" | grep -c 'name: SEARCH_ENABLED' || true)
check "search.semanticEnabled=false sets SEMANTIC_SEARCH_ENABLED=\"0\" on the API container" "$([ "$SEM_SCOPED" = "1" ] && echo 0 || echo 1)"
check "search.semanticEnabled=false leaves keyword search alone" "$([ "$SEM_KEYWORD" = "0" ] && echo 0 || echo 1)"

SEM_DEFAULT=$(grep -c 'name: SEMANTIC_SEARCH_ENABLED' "$TMPDIR/default.yaml" || true)
check "Default render: SEMANTIC_SEARCH_ENABLED is not set at all" "$([ "$SEM_DEFAULT" = "0" ] && echo 0 || echo 1)"

# search.enabled=false already stops the semantic repository being constructed, so
# emitting the narrower switch too would be redundant noise in the manifest.
SEM_REDUNDANT=$(grep -c 'name: SEMANTIC_SEARCH_ENABLED' "$TMPDIR/search-off.yaml" || true)
check "search.enabled=false does not also emit SEMANTIC_SEARCH_ENABLED" "$([ "$SEM_REDUNDANT" = "0" ] && echo 0 || echo 1)"

# The ADR-0061 semantic switch disables vector embedding on the search-indexer container when searchIndexer is enabled.
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set gateway.searchIndexer.enabled=true \
  --set search.semanticEnabled=false > "$TMPDIR/semantic-off-indexer.yaml" 2>/dev/null
IX_SEM_DOC=$(deployment_doc "$TMPDIR/semantic-off-indexer.yaml" search-indexer)
IX_SEM_SCOPED=$(printf '%s\n' "$IX_SEM_DOC" | grep -A1 'name: SEMANTIC_SEARCH_ENABLED' | grep -c 'value: "0"' || true)
check "search.semanticEnabled=false sets SEMANTIC_SEARCH_ENABLED=\"0\" on the search-indexer container" "$([ "$IX_SEM_SCOPED" = "1" ] && echo 0 || echo 1)"

# --- Tracing (M13 inc 6, ADR-0062) ------------------------------------------
echo ""
echo "Tracing (ADR-0062):"

# Default render: no OTEL vars anywhere
OTEL_DEFAULT=$(grep -c 'OTEL_' "$TMPDIR/default.yaml" || true)
check "Default render: no OTEL vars anywhere" "$([ "$OTEL_DEFAULT" = "0" ] && echo 0 || echo 1)"

# Enabled + base endpoint: sets OTEL_EXPORTER_OTLP_ENDPOINT on both API and Gateway
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set tracing.enabled=true \
  --set tracing.otlpEndpoint=http://collector:4318 > "$TMPDIR/tracing-base.yaml" 2>/dev/null

API_OTEL_BASE=$(deployment_doc "$TMPDIR/tracing-base.yaml" api | grep -A1 'name: OTEL_EXPORTER_OTLP_ENDPOINT' | grep -c 'value: "http://collector:4318"' || true)
GW_OTEL_BASE=$(deployment_doc "$TMPDIR/tracing-base.yaml" gateway | grep -A1 'name: OTEL_EXPORTER_OTLP_ENDPOINT' | grep -c 'value: "http://collector:4318"' || true)
check "Tracing enabled+base endpoint: OTEL_EXPORTER_OTLP_ENDPOINT set on API container" "$([ "$API_OTEL_BASE" = "1" ] && echo 0 || echo 1)"
check "Tracing enabled+base endpoint: OTEL_EXPORTER_OTLP_ENDPOINT set on Gateway container" "$([ "$GW_OTEL_BASE" = "1" ] && echo 0 || echo 1)"

# Enabled + traces endpoint: sets OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
  --set tracing.enabled=true \
  --set tracing.otlpTracesEndpoint=http://collector:4318/v1/traces > "$TMPDIR/tracing-traces.yaml" 2>/dev/null

API_OTEL_TRACES=$(deployment_doc "$TMPDIR/tracing-traces.yaml" api | grep -A1 'name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' | grep -c 'value: "http://collector:4318/v1/traces"' || true)
GW_OTEL_TRACES=$(deployment_doc "$TMPDIR/tracing-traces.yaml" gateway | grep -A1 'name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' | grep -c 'value: "http://collector:4318/v1/traces"' || true)
check "Tracing enabled+traces endpoint: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT set on API container" "$([ "$API_OTEL_TRACES" = "1" ] && echo 0 || echo 1)"
check "Tracing enabled+traces endpoint: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT set on Gateway container" "$([ "$GW_OTEL_TRACES" = "1" ] && echo 0 || echo 1)"

# Fail closed: tracing enabled with no endpoint must fail render
if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
     --set tracing.enabled=true >/dev/null 2>&1; then
  check "Fail-closed: tracing.enabled=true with no endpoint is rejected" 1
else
  check "Fail-closed: tracing.enabled=true with no endpoint is rejected" 0
fi

# --- Progressive delivery (M14 inc 9, ADR-0075) -----------------------------
# Three properties matter here and none of them are schema-checkable:
#   1. `rolling` renders what the chart rendered before this existed.
#   2. A blue/green flip changes Service selectors and NOTHING else — that is
#      the entire reason to prefer it over a rolling update for rollback.
#   3. Each web variant addresses the api variant of its own version, so a
#      canary cohort never gets a new frontend against the old API.
echo ""
echo "Progressive delivery (ADR-0075):"

# Reads a whole document by kind + exact name, so assertions can be scoped to one
# variant now that a component can render more than one Deployment.
doc_by_name() {
  yq "select(.kind==\"$2\" and .metadata.name==\"$3\")" "$1" 2>/dev/null || echo ""
}

BG_SET=(
  --set rollout.strategy=blueGreen
  --set rollout.blueGreen.colors.blue.tag=0.1.0
  --set rollout.blueGreen.colors.green.tag=0.2.0
)
CANARY_SET=(
  --set rollout.strategy=canary
  --set rollout.canary.tag=0.2.0
  --set rollout.canary.weight=25
)

helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${BG_SET[@]}" \
  --set rollout.blueGreen.activeColor=blue > "$TMPDIR/bg-blue.yaml" 2>/dev/null
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${BG_SET[@]}" \
  --set rollout.blueGreen.activeColor=green > "$TMPDIR/bg-green.yaml" 2>/dev/null
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${CANARY_SET[@]}" > "$TMPDIR/canary.yaml" 2>/dev/null

# 1. The default strategy stays inert: no variant labels, one Deployment each.
VARIANT_LABELS_DEFAULT=$(grep -c 'gambit.dev/\(color\|track\)' "$TMPDIR/default.yaml" || true)
check "Default render: no variant labels (rolling is unchanged behaviour)" "$([ "$VARIANT_LABELS_DEFAULT" = "0" ] && echo 0 || echo 1)"

API_DEPS_DEFAULT=$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="api") | .metadata.name' "$TMPDIR/default.yaml" 2>/dev/null | grep -c . || true)
check "Default render: exactly one api Deployment" "$([ "$API_DEPS_DEFAULT" = "1" ] && echo 0 || echo 1)"

# 2. REGRESSION GUARD: the web proxy upstreams must be the chart's Service names.
# The image ships compose defaults (api:8080), which do not resolve in Kubernetes
# — and nginx resolves an upstream literal at config load, so the wrong value is a
# CrashLoopBackOff, not a 502. This is the bug ADR-0075 fixes.
WEB_API_UP=$(doc_by_name "$TMPDIR/default.yaml" Deployment release-name-gambit-web | yq '.spec.template.spec.containers[] | select(.name=="web") | .env[] | select(.name=="API_UPSTREAM") | .value' 2>/dev/null || echo "")
WEB_GW_UP=$(doc_by_name "$TMPDIR/default.yaml" Deployment release-name-gambit-web | yq '.spec.template.spec.containers[] | select(.name=="web") | .env[] | select(.name=="GATEWAY_UPSTREAM") | .value' 2>/dev/null || echo "")
check "Web API_UPSTREAM is the release-prefixed api Service" "$([ "$WEB_API_UP" = "release-name-gambit-api:8080" ] && echo 0 || echo 1)"
check "Web GATEWAY_UPSTREAM is the release-prefixed gateway Service" "$([ "$WEB_GW_UP" = "release-name-gambit-gateway:4175" ] && echo 0 || echo 1)"

# 3. Blue/green: the primary Service selects the active color, preview the standby.
BG_PRIMARY_COLOR=$(doc_by_name "$TMPDIR/bg-blue.yaml" Service release-name-gambit-api | yq '.spec.selector."gambit.dev/color"' 2>/dev/null || echo "")
BG_PREVIEW_COLOR=$(doc_by_name "$TMPDIR/bg-blue.yaml" Service release-name-gambit-api-preview | yq '.spec.selector."gambit.dev/color"' 2>/dev/null || echo "")
check "Blue/green: primary api Service selects the active color" "$([ "$BG_PRIMARY_COLOR" = "blue" ] && echo 0 || echo 1)"
check "Blue/green: preview api Service selects the standby color" "$([ "$BG_PREVIEW_COLOR" = "green" ] && echo 0 || echo 1)"

# 4. A Deployment's selector must carry the variant label. Without it, the two
# colors' ReplicaSets select each other's pods and fight over one fleet.
BG_DEP_SELECTOR=$(doc_by_name "$TMPDIR/bg-blue.yaml" Deployment release-name-gambit-api-green | yq '.spec.selector.matchLabels."gambit.dev/color"' 2>/dev/null || echo "")
check "Blue/green: Deployment selector carries the color (colors cannot claim each other's pods)" "$([ "$BG_DEP_SELECTOR" = "green" ] && echo 0 || echo 1)"

# 5. THE flip property: changing activeColor rewrites selectors and nothing else.
# Same Deployments, same images, same replica counts before and after.
bg_pod_specs() {
  yq 'select(.kind=="Deployment") | .metadata.name + " " + (.spec.replicas|tostring) + " " + .spec.template.spec.containers[0].image' "$1" 2>/dev/null | sort
}
BLUE_SPECS=$(bg_pod_specs "$TMPDIR/bg-blue.yaml")
GREEN_SPECS=$(bg_pod_specs "$TMPDIR/bg-green.yaml")
check "Blue/green: a flip changes no Deployment name, image or replica count" "$([ "$BLUE_SPECS" = "$GREEN_SPECS" ] && echo 0 || echo 1)"

FLIPPED_COLOR=$(doc_by_name "$TMPDIR/bg-green.yaml" Service release-name-gambit-api | yq '.spec.selector."gambit.dev/color"' 2>/dev/null || echo "")
check "Blue/green: a flip does change the primary Service selector" "$([ "$FLIPPED_COLOR" = "green" ] && echo 0 || echo 1)"

# 6. Version pairing: each web variant addresses the api variant of its own version.
BG_WEB_ACTIVE_UP=$(doc_by_name "$TMPDIR/bg-blue.yaml" Deployment release-name-gambit-web-blue | yq '.spec.template.spec.containers[0].env[] | select(.name=="API_UPSTREAM") | .value' 2>/dev/null || echo "")
BG_WEB_PREVIEW_UP=$(doc_by_name "$TMPDIR/bg-blue.yaml" Deployment release-name-gambit-web-green | yq '.spec.template.spec.containers[0].env[] | select(.name=="API_UPSTREAM") | .value' 2>/dev/null || echo "")
check "Blue/green: active web addresses the primary api Service" "$([ "$BG_WEB_ACTIVE_UP" = "release-name-gambit-api:8080" ] && echo 0 || echo 1)"
check "Blue/green: preview web addresses the preview api Service" "$([ "$BG_WEB_PREVIEW_UP" = "release-name-gambit-api-preview:8080" ] && echo 0 || echo 1)"

CANARY_WEB_UP=$(doc_by_name "$TMPDIR/canary.yaml" Deployment release-name-gambit-web-canary | yq '.spec.template.spec.containers[0].env[] | select(.name=="API_UPSTREAM") | .value' 2>/dev/null || echo "")
check "Canary: canary web addresses the canary api Service (no mixed pair)" "$([ "$CANARY_WEB_UP" = "release-name-gambit-api-canary:8080" ] && echo 0 || echo 1)"

# 7. Canary: stable Service must exclude canary pods, or the weight means nothing.
CANARY_STABLE_TRACK=$(doc_by_name "$TMPDIR/canary.yaml" Service release-name-gambit-api | yq '.spec.selector."gambit.dev/track"' 2>/dev/null || echo "")
check "Canary: stable api Service selects only the stable track" "$([ "$CANARY_STABLE_TRACK" = "stable" ] && echo 0 || echo 1)"

# 8. The weight reaches the ingress controller.
CANARY_ANN=$(doc_by_name "$TMPDIR/canary.yaml" Ingress release-name-gambit-web-canary | yq '.metadata.annotations."nginx.ingress.kubernetes.io/canary"' 2>/dev/null || echo "")
CANARY_WEIGHT=$(doc_by_name "$TMPDIR/canary.yaml" Ingress release-name-gambit-web-canary | yq '.metadata.annotations."nginx.ingress.kubernetes.io/canary-weight"' 2>/dev/null || echo "")
check "Canary: Ingress is annotated canary=true" "$([ "$CANARY_ANN" = "true" ] && echo 0 || echo 1)"
check "Canary: canary-weight matches rollout.canary.weight" "$([ "$CANARY_WEIGHT" = "25" ] && echo 0 || echo 1)"

CANARY_HEADER_OFF=$(doc_by_name "$TMPDIR/canary.yaml" Ingress release-name-gambit-web-canary | grep -c 'canary-by-header' || true)
check "Canary: canary-by-header is absent unless configured" "$([ "$CANARY_HEADER_OFF" = "0" ] && echo 0 || echo 1)"

# 9. The exclusions hold. The gateway is never versioned by this mechanism (long-
# lived connections + Redis-coordinated game ownership), and the search indexer
# must stay a single process however the HTTP tier is being rolled out.
for f in bg-blue canary; do
  GW_DEPS=$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .metadata.name' "$TMPDIR/$f.yaml" 2>/dev/null | grep -c . || true)
  check "$f: exactly one gateway Deployment (gateway is excluded from rollouts)" "$([ "$GW_DEPS" = "1" ] && echo 0 || echo 1)"
done

helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${CANARY_SET[@]}" \
  --set gateway.searchIndexer.enabled=true > "$TMPDIR/canary-indexer.yaml" 2>/dev/null
IX_DEPS=$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="search-indexer") | .spec.replicas' "$TMPDIR/canary-indexer.yaml" 2>/dev/null | tr -d '\n' || true)
check "Canary + indexer: still exactly one indexer replica" "$([ "$IX_DEPS" = "1" ] && echo 0 || echo 1)"

# 9b. A Deployment's spec.selector is immutable in apps/v1, and every strategy
# puts different variant labels in it. So no two strategies may share a
# Deployment NAME: if they did, switching strategy on a live release would try to
# mutate the selector of an existing object and Kubernetes would reject the
# upgrade. Distinct names make every switch a replace instead.
# yq separates multi-document results with `---`; that line is not a name and
# would make every pair of lists look like it shares an element.
http_deployment_names() {
  yq 'select(.kind=="Deployment" and (.metadata.labels."app.kubernetes.io/component"=="api" or .metadata.labels."app.kubernetes.io/component"=="web")) | .metadata.name' "$1" 2>/dev/null | grep -vx -- '---' | sort
}
ROLLING_NAMES=$(http_deployment_names "$TMPDIR/default.yaml")
BG_NAMES=$(http_deployment_names "$TMPDIR/bg-blue.yaml")
CANARY_NAMES=$(http_deployment_names "$TMPDIR/canary.yaml")
SHARED=$(comm -12 <(printf '%s\n' "$ROLLING_NAMES") <(printf '%s\n' "$BG_NAMES"); \
         comm -12 <(printf '%s\n' "$ROLLING_NAMES") <(printf '%s\n' "$CANARY_NAMES"); \
         comm -12 <(printf '%s\n' "$BG_NAMES") <(printf '%s\n' "$CANARY_NAMES"))
# Empty name lists would make the disjointness trivially true, so this must also
# prove it read something: 2 Deployments under rolling, 4 under each of the others.
NAME_COUNTS="$(printf '%s\n' "$ROLLING_NAMES" | grep -c .)/$(printf '%s\n' "$BG_NAMES" | grep -c .)/$(printf '%s\n' "$CANARY_NAMES" | grep -c .)"
check "No two strategies share a Deployment name (selectors are immutable)" "$([ -z "$SHARED" ] && [ "$NAME_COUNTS" = "2/4/4" ] && echo 0 || echo 1)"

# 10. Fail-closed guards. Each of these renders a release that would look
# progressive while doing nothing of the sort.
reject() {
  local desc="$1"; shift
  if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "$@" >/dev/null 2>&1; then
    check "$desc" 1
  else
    check "$desc" 0
  fi
}
reject "Fail-closed: unknown rollout.strategy is rejected" --set rollout.strategy=bogus
reject "Fail-closed: activeColor outside blue/green is rejected" "${BG_SET[@]}" --set rollout.blueGreen.activeColor=purple
reject "Fail-closed: both colors resolving to the same image is rejected" --set rollout.strategy=blueGreen

# A flip must never be the thing that first fails to render. An operator who sets
# only the incoming color's tag — letting the outgoing one fall back to
# images.<component>.tag, which is the version they would roll back to — has a
# valid release, and it has to stay valid after activeColor changes.
for COLOR in blue green; do
  if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
       --set rollout.strategy=blueGreen \
       --set rollout.blueGreen.colors.green.tag=0.2.0 \
       --set rollout.blueGreen.activeColor="$COLOR" >/dev/null 2>&1; then
    check "Blue/green renders with activeColor=$COLOR when only the incoming tag is set (a flip cannot newly break the render)" 0
  else
    check "Blue/green renders with activeColor=$COLOR when only the incoming tag is set (a flip cannot newly break the render)" 1
  fi
done
reject "Fail-closed: canary without its own tag is rejected" --set rollout.strategy=canary
reject "Fail-closed: canary without an Ingress is rejected" --set rollout.strategy=canary --set rollout.canary.tag=0.2.0 --set web.ingress.enabled=false
reject "Fail-closed: canary weight above 100 is rejected" "${CANARY_SET[@]}" --set rollout.canary.weight=150
reject "Fail-closed: canary weight below 0 is rejected" "${CANARY_SET[@]}" --set rollout.canary.weight=-1
reject "Fail-closed: invalid explicit TRUST_PROXY is rejected" --set-string config.trustProxy=1.5
reject "Fail-closed: empty ingress-controller namespace selector is rejected" --set networkPolicy.ingressController.namespaceLabels=null
reject "Fail-closed: empty ingress-controller pod selector is rejected" --set networkPolicy.ingressController.podLabels=null

# Weight 0 is legitimate: the canary is staged and reachable by header, taking no
# sampled traffic yet. It must NOT be rejected.
if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${CANARY_SET[@]}" \
     --set rollout.canary.weight=0 >/dev/null 2>&1; then
  check "Canary weight 0 renders (staged canary, header-only access)" 0
else
  check "Canary weight 0 renders (staged canary, header-only access)" 1
fi

# An explicit standby size must be honoured — including 0, which stages the
# standby's manifests without running it. `default` would treat 0 as unset and
# silently give it the active color's full replica count.
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" "${BG_SET[@]}" \
  --set rollout.blueGreen.preview.replicas=0 > "$TMPDIR/bg-zero.yaml" 2>/dev/null
BG_ZERO=$(doc_by_name "$TMPDIR/bg-zero.yaml" Deployment release-name-gambit-api-green | yq '.spec.replicas' 2>/dev/null || echo "")
check "Blue/green: an explicit standby replica count of 0 is honoured" "$([ "$BG_ZERO" = "0" ] && echo 0 || echo 1)"

# Turning the preview off leaves a single-color release — the standby tag is then
# not required, because there is no standby.
if helm template "$CHART_DIR" "${HELM_SECRETS[@]}" \
     --set rollout.strategy=blueGreen --set rollout.blueGreen.preview.enabled=false >/dev/null 2>&1; then
  check "Blue/green with preview disabled needs no standby tag" 0
else
  check "Blue/green with preview disabled needs no standby tag" 1
fi

# --- Workflow flag compositions (.github/workflows/deploy.yml) --------------
# NOTE: These test assertions mirror the exact flag compositions produced by
# deploy.yml for each strategy. If deploy.yml changes its flag composition,
# update these snapshot assertions to match.
echo ""
echo "Workflow strategy flag compositions (deploy.yml):"

if helm template "$CHART_DIR" -f deploy/environments/production.values.yaml \
     "${HELM_PRODUCTION_EMAIL[@]}" \
     --set rollout.strategy=rolling \
     --set images.api.tag=1.2.3 \
     --set images.gateway.tag=1.2.3 \
     --set images.web.tag=1.2.3 >/dev/null 2>&1; then
  check "Workflow composition: rolling renders cleanly with production values" 0
else
  check "Workflow composition: rolling renders cleanly with production values" 1
fi

if helm template "$CHART_DIR" -f deploy/environments/production.values.yaml \
     "${HELM_PRODUCTION_EMAIL[@]}" \
     --set rollout.strategy=blueGreen \
     --set rollout.blueGreen.activeColor=blue \
     --set rollout.blueGreen.colors.blue.tag=1.2.3 \
     --set images.gateway.tag=1.2.3 >/dev/null 2>&1; then
  check "Workflow composition: blueGreen renders cleanly with production values" 0
else
  check "Workflow composition: blueGreen renders cleanly with production values" 1
fi

if helm template "$CHART_DIR" -f deploy/environments/production.values.yaml \
     "${HELM_PRODUCTION_EMAIL[@]}" \
     --set rollout.strategy=canary \
     --set rollout.canary.tag=1.2.3 \
     --set rollout.canary.weight=10 \
     --set images.api.tag=1.2.3 \
     --set images.gateway.tag=1.2.3 \
     --set images.web.tag=1.2.3 >/dev/null 2>&1; then
  check "Workflow composition: canary renders cleanly with production values" 0
else
  check "Workflow composition: canary renders cleanly with production values" 1
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All snapshot tests passed."
