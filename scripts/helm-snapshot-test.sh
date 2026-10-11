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
NETWORK_POLICY_IPBLOCK_COUNT=$(yq 'select(.kind=="NetworkPolicy") | .spec.ingress[].from[] | select(.ipBlock != null) | .ipBlock.cidr' "$TMPDIR/default.yaml" | awk '$0 != "---" && NF { count++ } END { print count + 0 }')
GATEWAY_POLICY_PORTS=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .spec.ingress[].ports[] | select(.protocol=="TCP") | .port' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | sort -n | tr '\n' ' ' | sed 's/ $//')
WEB_ALLOWED_NAMESPACE=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="web") | .spec.ingress[0].from[0].namespaceSelector.matchLabels."kubernetes.io/metadata.name"' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
WEB_ALLOWED_POD=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="web") | .spec.ingress[0].from[0].podSelector.matchLabels."app.kubernetes.io/name"' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Trusted edge: four application NetworkPolicies render with Ingress (web, api, gateway, trust-worker)" "$([ "$NETWORK_POLICY_COUNT" = "4" ] && echo 0 || echo 1)"
check "Trusted edge: web allows only the configured ingress-controller namespace" "$([ "$WEB_ALLOWED_NAMESPACE" = "ingress-nginx" ] && echo 0 || echo 1)"
check "Trusted edge: web allows only the configured ingress-controller pods" "$([ "$WEB_ALLOWED_POD" = "ingress-nginx" ] && echo 0 || echo 1)"
check "Trusted edge: web policy is omitted for the one-hop ingress-disabled topology" "$([ "$INGRESS_OFF_NETWORK_POLICY_COUNT" = "3" ] && echo 0 || echo 1)"
check "Trusted edge: only gateway, trust-worker (migration wait) and web pods can enter the API" "$([ "$API_ALLOWED_COMPONENTS" = "gateway trust-worker web" ] && echo 0 || echo 1)"
check "Trusted edge: only web pods can enter the WebSocket gateway" "$([ "$GATEWAY_ALLOWED_COMPONENTS" = "web" ] && echo 0 || echo 1)"
check "Trusted edge: bundled policies do not guess node CIDRs" "$([ "$NETWORK_POLICY_IPBLOCK_COUNT" = "0" ] && echo 0 || echo 1)"
check "Trusted edge: application pods cannot enter the gateway health port" "$([ "$GATEWAY_POLICY_PORTS" = "4175" ] && echo 0 || echo 1)"

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

# The indexer's wait-for-api init container must reach the API without opening
# that boundary to other releases, components, or ports.
INDEXER_API_ALLOWED_COMPONENTS=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="api") | .spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"' "$TMPDIR/indexer.yaml" 2>/dev/null | grep -vx -- '---' | sort | tr '\n' ' ' | sed 's/ $//')
INDEXER_API_INSTANCE=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="api") | .spec.ingress[].from[] | select(.podSelector.matchLabels."app.kubernetes.io/component"=="search-indexer") | .podSelector.matchLabels."app.kubernetes.io/instance"' "$TMPDIR/indexer.yaml" 2>/dev/null || echo "")
INDEXER_API_PORT=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="api") | .spec.ingress[].ports[] | select(.protocol=="TCP") | .port' "$TMPDIR/indexer.yaml" 2>/dev/null || echo "")
INDEXER_GATEWAY_ALLOWED_COMPONENTS=$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"' "$TMPDIR/indexer.yaml" 2>/dev/null | grep -vx -- '---' | sort | tr '\n' ' ' | sed 's/ $//')
check "Indexer enabled: only gateway, search-indexer, trust-worker and web pods can enter the API" "$([ "$INDEXER_API_ALLOWED_COMPONENTS" = "gateway search-indexer trust-worker web" ] && echo 0 || echo 1)"
check "Indexer enabled: API ingress is scoped to the same release" "$([ "$INDEXER_API_INSTANCE" = "release-name" ] && echo 0 || echo 1)"
check "Indexer enabled: API ingress remains limited to TCP port 8080" "$([ "$INDEXER_API_PORT" = "8080" ] && echo 0 || echo 1)"
check "Indexer enabled: only web pods can enter the WebSocket gateway" "$([ "$INDEXER_GATEWAY_ALLOWED_COMPONENTS" = "web" ] && echo 0 || echo 1)"

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
IX_SURGE=$(deployment_doc "$TMPDIR/indexer.yaml" search-indexer | grep -c 'maxSurge: 1' || true)
IX_UNAVAIL=$(deployment_doc "$TMPDIR/indexer.yaml" search-indexer | grep -c 'maxUnavailable: 0' || true)
IX_RECREATE=$(deployment_doc "$TMPDIR/indexer.yaml" search-indexer | grep -c 'type: Recreate' || true)
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

# --- Engine bot (ADR-0080) --------------------------------------------------
# Play vs Computer needs ENGINE_BOT=1 on the gateway; the gateway image supplies
# Stockfish and STOCKFISH_PATH. On by default, off only when asked, and never on
# any other Deployment — the search indexer runs the same image.
echo ""
echo "Engine bot (ADR-0080):"

gateway_env_names() {
  yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .spec.template.spec.containers[] | select(.name=="gateway") | .env[].name' "$1" 2>/dev/null | grep -vx -- '---' | tr '
' ' ' | sed 's/ $//'
}
gateway_env_value() {
  yq "select(.kind==\"Deployment\" and .metadata.labels.\"app.kubernetes.io/component\"==\"gateway\") | .spec.template.spec.containers[] | select(.name==\"gateway\") | .env[] | select(.name==\"$2\") | .value" "$1" 2>/dev/null || echo ""
}

helm template "$CHART_DIR" "${HELM_SECRETS[@]}"   --set gateway.engineBot.enabled=false > "$TMPDIR/engine-bot-off.yaml" 2>/dev/null
helm template "$CHART_DIR" "${HELM_SECRETS[@]}"   --set gateway.tournamentReporter.enabled=false > "$TMPDIR/reporter-off.yaml" 2>/dev/null

check "Engine bot: ENGINE_BOT=\"1\" on the gateway by default" "$([ "$(gateway_env_value "$TMPDIR/default.yaml" ENGINE_BOT)" = "1" ] && echo 0 || echo 1)"
check "Engine bot: ENGINE_BOT appears once in the default release (gateway only)" "$([ "$(grep -c 'name: ENGINE_BOT' "$TMPDIR/default.yaml" || true)" = "1" ] && echo 0 || echo 1)"
check "Engine bot: ENGINE_BOT is absent when gateway.engineBot.enabled=false" "$([ "$(grep -c 'ENGINE_BOT' "$TMPDIR/engine-bot-off.yaml" || true)" = "0" ] && echo 0 || echo 1)"
check "Engine bot: not set on the search-indexer Deployment" "$([ "$(deployment_doc "$TMPDIR/indexer.yaml" search-indexer | grep -c 'ENGINE_BOT' || true)" = "0" ] && echo 0 || echo 1)"
check "Engine bot: the chart configures no engine of its own (no STOCKFISH_PATH env)" "$([ "$(grep -c 'name: STOCKFISH' "$TMPDIR/default.yaml" || true)" = "0" ] && echo 0 || echo 1)"

# The rest of the gateway env contract is pinned, so a flag cannot ride in on
# a change to anything else. Disabling the bot removes exactly ENGINE_BOT. The
# trust analyzers never appear here: they run in the trust-worker Deployment.
GW_ENV_BASE="POSTGRES_PASSWORD DATABASE_URL ACCESS_TOKEN_SECRET ACCESS_TOKEN_TTL_SEC PORT HOST HEALTH_PORT NODE_ENV REDIS_URL NODE_ID CMD_FORWARD_TIMEOUT_MS OWNERSHIP_LEASE_TTL_SEC OWNERSHIP_RENEWAL_INTERVAL_SEC TRUST_PROXY"
GW_REPORTER="TOURNAMENT_REPORTER TOURNAMENT_REPORTER_SCAN_MS"
check "Gateway env contract: default render is the base contract plus the reporter and ENGINE_BOT" "$([ "$(gateway_env_names "$TMPDIR/default.yaml")" = "$GW_ENV_BASE $GW_REPORTER ENGINE_BOT" ] && echo 0 || echo 1)"
check "Gateway env contract: engine bot disabled removes exactly ENGINE_BOT" "$([ "$(gateway_env_names "$TMPDIR/engine-bot-off.yaml")" = "$GW_ENV_BASE $GW_REPORTER" ] && echo 0 || echo 1)"

# Tournament reporter (ADR-0025, ADR-0152): a chart that serves tournaments
# records their results by default, on every gateway replica (deterministic
# launch ids + version CAS make duplicates harmless). Off only when asked.
check "Tournament reporter: TOURNAMENT_REPORTER=1 and a 30000 ms scan on the gateway by default" "$([ "$(gateway_env_value "$TMPDIR/default.yaml" TOURNAMENT_REPORTER)" = "1" ] && [ "$(gateway_env_value "$TMPDIR/default.yaml" TOURNAMENT_REPORTER_SCAN_MS)" = "30000" ] && echo 0 || echo 1)"
check "Tournament reporter: the explicit kill switch removes exactly its two variables" "$([ "$(gateway_env_names "$TMPDIR/reporter-off.yaml")" = "$GW_ENV_BASE ENGINE_BOT" ] && echo 0 || echo 1)"
check "Tournament reporter: a string boolean is refused" "$(helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set-string gateway.tournamentReporter.enabled=false >/dev/null 2>&1 && echo 1 || echo 0)"

# --- Trust worker (ADR-0152) ------------------------------------------------
# Bot-timing and anti-cheat analysis of every finished game run in ONE
# dedicated Deployment, never on the scalable gateway replicas: one pod,
# no Service, no Ingress, the thin trust-worker entrypoint, both analyzers on.
echo ""
echo "Trust worker (ADR-0152):"
trust_doc() { deployment_doc "$1" trust-worker; }
trust_env_value() {
  yq "select(.kind==\"Deployment\" and .metadata.labels.\"app.kubernetes.io/component\"==\"trust-worker\") | .spec.template.spec.containers[0].env[] | select(.name==\"$2\") | .value" "$1" 2>/dev/null || echo ""
}
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set trustWorker.antiCheatAnalysis=false > "$TMPDIR/trust-bot-only.yaml" 2>/dev/null
helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set trustWorker.enabled=false > "$TMPDIR/trust-off.yaml" 2>/dev/null

check "Trust worker: exactly one Deployment renders by default" "$([ "$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .metadata.name' "$TMPDIR/default.yaml" 2>/dev/null | grep -vc -- '---' || true)" = "1" ] && echo 0 || echo 1)"
check "Trust worker: pinned to one replica" "$([ "$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .spec.replicas' "$TMPDIR/default.yaml" 2>/dev/null | tr -d '
-')" = "1" ] && echo 0 || echo 1)"
check "Trust worker: runs the thin trust-worker entrypoint, not the WebSocket gateway" "$([ "$(trust_doc "$TMPDIR/default.yaml" | grep -c 'services/gateway/dist/trust-worker.js' || true)" = "1" ] && [ "$(trust_doc "$TMPDIR/default.yaml" | grep -c 'serve.js' || true)" = "0" ] && echo 0 || echo 1)"
check "Trust worker: BOT_AUTO_ANALYZE=1 and ANTICHEAT_AUTO_ANALYZE=1 by default" "$([ "$(trust_env_value "$TMPDIR/default.yaml" BOT_AUTO_ANALYZE)" = "1" ] && [ "$(trust_env_value "$TMPDIR/default.yaml" ANTICHEAT_AUTO_ANALYZE)" = "1" ] && echo 0 || echo 1)"
check "Trust worker: antiCheatAnalysis=false renders ANTICHEAT_AUTO_ANALYZE=0" "$([ "$(trust_env_value "$TMPDIR/trust-bot-only.yaml" ANTICHEAT_AUTO_ANALYZE)" = "0" ] && [ "$(trust_env_value "$TMPDIR/trust-bot-only.yaml" BOT_AUTO_ANALYZE)" = "1" ] && echo 0 || echo 1)"
check "Trust worker: the analyzer flags appear nowhere but the trust worker" "$([ "$(grep -c 'name: BOT_AUTO_ANALYZE' "$TMPDIR/default.yaml" || true)" = "1" ] && [ "$(grep -c 'name: ANTICHEAT_AUTO_ANALYZE' "$TMPDIR/default.yaml" || true)" = "1" ] && echo 0 || echo 1)"
check "Trust worker: no Service and no Ingress select it" "$([ "$(yq 'select((.kind=="Service" or .kind=="Ingress") and (.metadata.labels."app.kubernetes.io/component"=="trust-worker" or .spec.selector."app.kubernetes.io/component"=="trust-worker")) | .metadata.name' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | grep -c . || true)" = "0" ] && [ "$(yq 'select(.kind=="Service") | .metadata.name' "$TMPDIR/default.yaml" 2>/dev/null | grep -vx -- '---' | grep -c . || true)" -gt 0 ] && echo 0 || echo 1)"
check "Trust worker: terminationGracePeriodSeconds lets a long analysis finish (300)" "$([ "$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .spec.template.spec.terminationGracePeriodSeconds' "$TMPDIR/default.yaml" 2>/dev/null | tr -d '
-')" = "300" ] && echo 0 || echo 1)"
check "Trust worker: disabled, the API NetworkPolicy no longer admits it" "$([ "$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="api") | .spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"' "$TMPDIR/trust-off.yaml" 2>/dev/null | grep -c 'trust-worker' || true)" = "0" ] && echo 0 || echo 1)"
check "Trust worker: positive control - the refused renders differ from one that succeeds" "$(helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set trustWorker.enabled=true --set trustWorker.botAnalysis=true --set trustWorker.antiCheatAnalysis=false >/dev/null 2>&1 && echo 0 || echo 1)"
check "Trust worker: declares only its health port (no WebSocket port)" "$([ "$(trust_doc "$TMPDIR/default.yaml" | grep -c 'containerPort' || true)" = "1" ] && echo 0 || echo 1)"
TW_RECREATE=$(trust_doc "$TMPDIR/default.yaml" | grep -c 'type: Recreate' || true)
TW_ROLLING_FIELDS=$(trust_doc "$TMPDIR/default.yaml" | grep -Ec 'rollingUpdate:|maxSurge:|maxUnavailable:' || true)
check "Trust worker: Recreate prevents legacy/new revision overlap with no rolling fields" "$([ "$TW_RECREATE" = "1" ] && [ "$TW_ROLLING_FIELDS" = "0" ] && echo 0 || echo 1)"
check "Trust worker: NetworkPolicy admits no inbound traffic" "$([ "$(yq 'select(.kind=="NetworkPolicy" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .spec.ingress | length' "$TMPDIR/default.yaml" 2>/dev/null | tr -d '
-')" = "0" ] && echo 0 || echo 1)"
check "Trust worker: carries no access-token secret" "$([ "$(trust_doc "$TMPDIR/default.yaml" | grep -c 'ACCESS_TOKEN_SECRET' || true)" = "0" ] && echo 0 || echo 1)"
check "Trust worker: has CPU and memory limits for the engine" "$([ "$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .spec.template.spec.containers[0].resources.limits | (has("cpu") and has("memory"))' "$TMPDIR/default.yaml" 2>/dev/null | tr -d '
-')" = "true" ] && echo 0 || echo 1)"
check "Trust worker: enabled=false renders nothing" "$([ "$(grep -c 'trust-worker' "$TMPDIR/trust-off.yaml" || true)" = "0" ] && echo 0 || echo 1)"
check "Trust worker: both analyzers off is refused" "$(helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set trustWorker.botAnalysis=false --set trustWorker.antiCheatAnalysis=false >/dev/null 2>&1 && echo 1 || echo 0)"
for key in enabled botAnalysis antiCheatAnalysis; do
  check "Trust worker: a string boolean for trustWorker.$key is refused" "$(helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set-string trustWorker.$key=true >/dev/null 2>&1 && echo 1 || echo 0)"
done
for strategy in "rollout.strategy=blueGreen --set rollout.blueGreen.colors.green.tag=9.9.9" "rollout.strategy=canary --set rollout.canary.tag=9.9.9"; do
  # shellcheck disable=SC2086
  helm template "$CHART_DIR" "${HELM_SECRETS[@]}" --set $strategy > "$TMPDIR/trust-rollout.yaml" 2>/dev/null
  check "Trust worker: still exactly one Deployment under ${strategy%% *}" "$([ "$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="trust-worker") | .metadata.name' "$TMPDIR/trust-rollout.yaml" 2>/dev/null | grep -vc -- '---' || true)" = "1" ] && echo 0 || echo 1)"
done

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

# default.yaml is the rolling render; the loop below adds the other two strategies.
# 9. The exclusions hold. The gateway is never versioned by this mechanism (long-
# lived connections + Redis-coordinated game ownership), and the search indexer
# must stay a single process however the HTTP tier is being rolled out.
for f in bg-blue canary; do
  GW_DEPS=$(yq 'select(.kind=="Deployment" and .metadata.labels."app.kubernetes.io/component"=="gateway") | .metadata.name' "$TMPDIR/$f.yaml" 2>/dev/null | grep -c . || true)
  check "$f: exactly one gateway Deployment (gateway is excluded from rollouts)" "$([ "$GW_DEPS" = "1" ] && echo 0 || echo 1)"
  check "$f: ENGINE_BOT=\"1\" still on the gateway" "$([ "$(gateway_env_value "$TMPDIR/$f.yaml" ENGINE_BOT)" = "1" ] && [ "$(grep -c 'name: ENGINE_BOT' "$TMPDIR/$f.yaml" || true)" = "1" ] && echo 0 || echo 1)"
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
reject "Fail-closed: a string gateway.engineBot.enabled is rejected (\"false\" would be truthy)" --set-string gateway.engineBot.enabled=false
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

# --- Workflow strategy compositions (.github/workflows/deploy.yml) ----------
# These renders EXECUTE the composition deploy.yml contains: its
# `case "$STRATEGY" in` block is extracted from the workflow and run, so this
# test cannot drift from the pipeline. Every run starts from the values the
# previous run left deployed (what `helm get values --all` returns, modelled by
# coalescing chart defaults, the environment file and that run's flags) and
# passes them through the same resolver the workflow uses. Asserting only that a
# render succeeds is what let both defects through: the canary composition put
# the stable track on the new version (a 100% rollout), and a blue/green stage
# dropped the live colour, the gateway and the trust worker to the environment
# file's baseline tag. So these assert the image of every Deployment.
echo ""
echo "Workflow strategy compositions (deploy.yml, executed):"

WF_ENV_FILE=deploy/environments/production.values.yaml
WF_BASELINE_TAG=0.1.0  # images.*.tag in the environment files and chart defaults; nothing may fall back to it
R=ghcr.io/senasehs19-oss/gambit
COMPOSITION=$(awk '
  /EXTRA_ARGS=\(\)/ { on = 1 }
  on { sub(/\r$/, ""); print }
  on && /^[[:space:]]*esac[[:space:]]*$/ { exit }
' .github/workflows/deploy.yml)
check "Workflow composition: the strategy case block is extracted from deploy.yml" \
  "$(printf '%s\n' "$COMPOSITION" | grep -q 'case "$STRATEGY" in' && printf '%s\n' "$COMPOSITION" | grep -qx '[[:space:]]*esac' && echo 0 || echo 1)"

# compose OUT STRATEGY VERSION TARGET_COLOR ACTIVE_COLOR CANARY_WEIGHT [DEPLOYED_TAGS_FILE]
# Runs the extracted block exactly as the workflow step does and writes EXTRA_ARGS,
# NUL-separated, to OUT. Fails if the block refuses (it calls `exit 1`).
compose() {
  local out="$1"
  (
    STRATEGY="$2" VERSION="$3" TARGET_COLOR="$4" ACTIVE_COLOR="$5" CANARY_WEIGHT="$6"
    DEPLOYED_API_TAG="" DEPLOYED_WEB_TAG="" DEPLOYED_GATEWAY_TAG="" DEPLOYED_LIVE_API_TAG=""
    DEPLOYED_LIVE_WEB_TAG="" DEPLOYED_BLUE_TAG="" DEPLOYED_GREEN_TAG="" DEPLOYED_STRATEGY="" DEPLOYED_ACTIVE_COLOR=""
    if [ -n "${7:-}" ]; then
      # The resolver's $GITHUB_OUTPUT lines become the step's env, as in deploy.yml.
      while IFS='=' read -r key value; do
        [ -n "$key" ] && printf -v "$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')" '%s' "$value"
      done < "$7"
    fi
    eval "$COMPOSITION"
    printf '%s\0' "${EXTRA_ARGS[@]}"
  ) > "$out" 2> "$out.err"
}

# deployed_values ARGS_FILE OUT_JSON: what `helm get values --all` would return after
# the run — chart defaults, then the environment file, then the run's flags.
# Every step returns explicitly on failure: this runs inside `|| return 1`, where
# errexit does not apply, so an unchecked yq failure would leave stale values.
deployed_values() {
  local args=() i
  rm -f "$2" || return 1
  mapfile -d '' args < "$1" || return 1
  yq -o json eval-all '. as $item ireduce ({}; . * $item)' "$CHART_DIR/values.yaml" "$WF_ENV_FILE" > "$2.tmp" || return 1
  for ((i = 0; i < ${#args[@]}; i += 2)); do
    VALUE_PATH=".${args[i+1]%%=*}" VALUE="${args[i+1]#*=}" \
      yq -o json -i 'eval(strenv(VALUE_PATH)) = strenv(VALUE)' "$2.tmp" || return 1
  done
  mv "$2.tmp" "$2"
}

# wf_step NAME FROM STRATEGY VERSION [TARGET_COLOR ACTIVE_COLOR CANARY_WEIGHT]
# One deploy.yml run on top of the release run FROM left deployed ("" = none yet).
# Errors from every stage go to $TMPDIR/wf-NAME.err, so wf_run can show why a run
# that should succeed did not, while expected rejections stay quiet.
wf_step() {
  local name="$1" from="$2" args=() err="$TMPDIR/wf-$1.err"
  : > "$err"
  if ! compose "$TMPDIR/wf-$name.args" "$3" "$4" "${5:-green}" "${6:-blue}" "${7:-10}" "${from:+$TMPDIR/wf-$from.tags}"; then
    # ::error:: annotations go to stdout, as GitHub Actions reads them there.
    { echo "deploy.yml composition refused:"; tr '\0' ' ' < "$TMPDIR/wf-$name.args"; cat "$TMPDIR/wf-$name.args.err"; } >> "$err"
    return 1
  fi
  mapfile -d '' args < "$TMPDIR/wf-$name.args" || return 1
  helm template "$CHART_DIR" -f "$WF_ENV_FILE" "${HELM_PRODUCTION_EMAIL[@]}" "${args[@]}" \
    > "$TMPDIR/wf-$name.yaml" 2>> "$err" || return 1
  deployed_values "$TMPDIR/wf-$name.args" "$TMPDIR/wf-$name.values.json" 2>> "$err" || return 1
  node scripts/resolve-deployed-image-tags.mjs < "$TMPDIR/wf-$name.values.json" > "$TMPDIR/wf-$name.tags" 2>> "$err"
}
wf_run() {
  if wf_step "$@"; then
    check "Workflow run '$1' composes and renders" 0
  else
    check "Workflow run '$1' composes and renders" 1
    sed 's/^/      /' "$TMPDIR/wf-$1.err"
  fi
}

# "<init images> | <container images>" of one Deployment in a run's render.
wf_images() {
  yq "select(.kind==\"Deployment\" and .metadata.name==\"release-name-gambit-$2\") | (((.spec.template.spec.initContainers // []) | map(.image) | join(\",\")) + \" | \" + (.spec.template.spec.containers | map(.image) | join(\",\")))" "$TMPDIR/wf-$1.yaml" 2>/dev/null || echo ""
}
api_img() { echo "$R-api:$1 | $R-api:$1"; }          # migrate init + api, same variant tag
web_img() { echo " | $R-web:$1"; }
gw_img() { echo "$R-api:$2 | $R-gateway:$1"; }       # wait-for-api init reads images.api.tag
expect_images() {  # RUN DEPLOYMENT EXPECTED DESCRIPTION
  local got; got=$(wf_images "$1" "$2")
  check "$1: $4" "$([ "$got" = "$3" ] && echo 0 || echo 1)"
  [ "$got" = "$3" ] || echo "      $2: got '$got', expected '$3'"
}
expect_unchanged() {  # RUN BEFORE DEPLOYMENT: the whole Deployment is byte-identical (no restart, no image change)
  check "$1: $3 Deployment is unchanged from '$2' (not restarted, not moved)" \
    "$([ -n "$(doc_by_name "$TMPDIR/wf-$2.yaml" Deployment "release-name-gambit-$3")" ] && [ "$(doc_by_name "$TMPDIR/wf-$1.yaml" Deployment "release-name-gambit-$3")" = "$(doc_by_name "$TMPDIR/wf-$2.yaml" Deployment "release-name-gambit-$3")" ] && echo 0 || echo 1)"
}
expect_primary() {  # RUN SELECTOR_KEY VALUE
  check "$1: the primary api and web Services select $2=$3" \
    "$([ "$(doc_by_name "$TMPDIR/wf-$1.yaml" Service release-name-gambit-api | yq ".spec.selector.\"$2\"")" = "$3" ] && [ "$(doc_by_name "$TMPDIR/wf-$1.yaml" Service release-name-gambit-web | yq ".spec.selector.\"$2\"")" = "$3" ] && echo 0 || echo 1)"
}

# 0. The first install is rolling, and rolling still moves every component.
wf_run live110 "" rolling 1.1.0
for d in api web; do expect_images live110 "$d" "$(${d}_img 1.1.0)" "rolling puts $d on the version"; done
expect_images live110 gateway "$(gw_img 1.1.0 1.1.0)" "rolling puts the gateway on the version"
expect_images live110 trust-worker "$(gw_img 1.1.0 1.1.0)" "rolling puts the trust worker on the version"

# 1. R-07: a canary of 1.2.3 over live 1.1.0 keeps the stable track on 1.1.0.
wf_run canary123 live110 canary 1.2.3 green blue 10
expect_images canary123 api-stable "$(api_img 1.1.0)" "stable api stays on the live version"
expect_images canary123 web-stable "$(web_img 1.1.0)" "stable web stays on the live version"
expect_images canary123 api-canary "$(api_img 1.2.3)" "canary api runs the new version"
expect_images canary123 web-canary "$(web_img 1.2.3)" "canary web runs the new version"
expect_primary canary123 gambit.dev/track stable
check "canary123: the canary Ingress carries the requested weight" \
  "$([ "$(doc_by_name "$TMPDIR/wf-canary123.yaml" Ingress release-name-gambit-web-canary | yq '.metadata.annotations."nginx.ingress.kubernetes.io/canary-weight"')" = "10" ] && echo 0 || echo 1)"
expect_unchanged canary123 live110 gateway
expect_unchanged canary123 live110 trust-worker

# 2. R-08: a blue/green stage keeps the live colour, the gateway and the trust worker.
wf_run stage123 live110 blueGreen 1.2.3 green blue
expect_images stage123 api-blue "$(api_img 1.1.0)" "live blue api stays on the live version"
expect_images stage123 web-blue "$(web_img 1.1.0)" "live blue web stays on the live version"
expect_images stage123 api-green "$(api_img 1.2.3)" "standby green api is staged with the new version"
expect_images stage123 web-green "$(web_img 1.2.3)" "standby green web is staged with the new version"
expect_primary stage123 gambit.dev/color blue
expect_unchanged stage123 live110 gateway
expect_unchanged stage123 live110 trust-worker

# 3. The cutover moves traffic and the gateway, and keeps the old colour as the rollback target.
wf_run flip123 stage123 blueGreen 1.2.3 green green
expect_primary flip123 gambit.dev/color green
expect_images flip123 api-blue "$(api_img 1.1.0)" "blue keeps the replaced version as the rollback target"
expect_images flip123 web-blue "$(web_img 1.1.0)" "blue web keeps the replaced version as the rollback target"
for d in api-blue api-green web-blue web-green; do
  check "flip123: the cutover does not change the $d image" "$([ "$(wf_images flip123 $d)" = "$(wf_images stage123 $d)" ] && echo 0 || echo 1)"
done
expect_images flip123 gateway "$(gw_img 1.2.3 1.1.0)" "the cutover moves the gateway to the new version"
expect_images flip123 trust-worker "$(gw_img 1.2.3 1.1.0)" "the cutover moves the trust worker to the new version"

# 4. Repeating the cutover changes nothing, rather than losing the rollback target.
wf_run recut123 flip123 blueGreen 1.2.3 green green
for d in api-blue api-green web-blue web-green gateway trust-worker; do expect_unchanged recut123 flip123 "$d"; done

# 5. The next stage starts from green live on 1.2.3, not from any fallback.
wf_run stage130 flip123 blueGreen 1.3.0 blue green
expect_images stage130 api-green "$(api_img 1.2.3)" "live green api stays on the live version"
expect_images stage130 web-green "$(web_img 1.2.3)" "live green web stays on the live version"
expect_images stage130 api-blue "$(api_img 1.3.0)" "standby blue is staged with the new version"
expect_images stage130 web-blue "$(web_img 1.3.0)" "standby blue web is staged with the new version"
expect_primary stage130 gambit.dev/color green
expect_unchanged stage130 flip123 gateway
expect_unchanged stage130 flip123 trust-worker

# 6. Rolling back through the workflow restores blue and still keeps green's version.
wf_run back110 flip123 blueGreen 1.1.0 blue blue
expect_primary back110 gambit.dev/color blue
expect_images back110 api-blue "$(api_img 1.1.0)" "blue serves the rollback version"
expect_images back110 api-green "$(api_img 1.2.3)" "green keeps the version it ran"
expect_images back110 web-green "$(web_img 1.2.3)" "green web keeps the version it ran"
expect_images back110 gateway "$(gw_img 1.1.0 1.1.0)" "the gateway follows the cutover back"
expect_images back110 trust-worker "$(gw_img 1.1.0 1.1.0)" "the trust worker follows the cutover back"

# 7. A canary started from a blue/green release keeps stable on the LIVE colour's version.
wf_run canary130 flip123 canary 1.3.0 green blue 10
expect_images canary130 api-stable "$(api_img 1.2.3)" "stable api is the live colour's version, not the fallback"
expect_images canary130 web-stable "$(web_img 1.2.3)" "stable web is the live colour's version, not the fallback"
expect_images canary130 api-canary "$(api_img 1.3.0)" "canary api runs the new version"
expect_images canary130 web-canary "$(web_img 1.3.0)" "canary web runs the new version"
# Main images stay on the live version. The wait-for-api init image follows the
# stable api tag, so this strategy switch does restart them (expected, ADR-0075).
expect_images canary130 gateway "$(gw_img 1.2.3 1.2.3)" "the gateway stays on the live version"
expect_images canary130 trust-worker "$(gw_img 1.2.3 1.2.3)" "the trust worker stays on the live version"

# 8. Nothing in the lifecycle fell back to the environment file's baseline tag.
for run in live110 canary123 stage123 flip123 recut123 stage130 back110 canary130; do
  check "$run: no image falls back to the baseline tag $WF_BASELINE_TAG" \
    "$(grep -Eq "image: \"?$R-[a-z]+:${WF_BASELINE_TAG//./\\.}\"?\$" "$TMPDIR/wf-$run.yaml" && echo 1 || echo 0)"
done

# 9. Fail closed.
for s in canary blueGreen; do
  if compose "$TMPDIR/wf-unresolved.args" "$s" 1.2.3 green blue 10; then
    check "Workflow composition: $s refuses to compose without the deployed tags" 1
  else
    check "Workflow composition: $s refuses to compose without the deployed tags" 0
  fi
done
# A "stage" onto the colour that is live now (green serves 1.2.3 after flip123)
# while naming blue active would switch production to blue's older 1.1.0.
if wf_step badstage flip123 blueGreen 1.3.0 green blue; then
  check "Workflow composition: a stage that would switch the serving colour is rejected" 1
else
  check "Workflow composition: a stage that would switch the serving colour is rejected" 0
fi
if wf_step canary110 live110 canary 1.1.0 green blue 10; then
  check "Workflow composition: a canary of the version already live is rejected" 1
else
  check "Workflow composition: a canary of the version already live is rejected" 0
fi
# REGRESSION GUARD (R-07): the composition deploy.yml used to produce for canary
# put stable and canary on the same version. The chart must refuse it.
if helm template "$CHART_DIR" -f "$WF_ENV_FILE" "${HELM_PRODUCTION_EMAIL[@]}" \
     --set rollout.strategy=canary --set rollout.canary.tag=1.2.3 --set rollout.canary.weight=10 \
     --set images.api.tag=1.2.3 --set images.gateway.tag=1.2.3 --set images.web.tag=1.2.3 >/dev/null 2>&1; then
  check "Fail-closed: a canary on the stable track's own tag (the old 100% composition) is rejected" 1
else
  check "Fail-closed: a canary on the stable track's own tag (the old 100% composition) is rejected" 0
fi

# --- Workflow post-deploy rollback target (.github/workflows/deploy.yml) -----
# These EXECUTE the `run:` bodies of the workflow's `pre_upgrade` step and its
# "Rollback on post-deploy verification failure" step, extracted from deploy.yml,
# with a stub `helm` first on PATH. The stub serves a fixture `helm history -o
# json` / `helm status` / `helm get values` and records every invocation, so the
# assertions are on the `helm rollback` / `helm uninstall` the workflow would
# really issue. The rollback step gets its env exactly as deploy.yml wires it
# from the pre_upgrade outputs. The scenario modelled is: the upgrade succeeded
# and the smoke check failed, which is the only time the rollback step runs.
#
# Helm semantics relied on (v3.16.3): a failed non-atomic upgrade leaves
# `N:deployed, N+1:failed`; a later rolling upgrade over that succeeds; and
# `helm rollback <rev>` re-applies <rev>'s chart and values without checking its
# status, so rolling back to the newest revision can re-apply a FAILED release.
echo ""
echo "Workflow post-deploy rollback target (deploy.yml, executed):"

WF_FILE=.github/workflows/deploy.yml
RB_ROOT="$TMPDIR/rollback"
mkdir -p "$RB_ROOT/bin"

# step_body MARKER_REGEX: the dedented `run: |` block of the first step at or after
# the line matching MARKER_REGEX.
step_body() {
  awk -v marker="$1" '
    { sub(/\r$/, "") }
    !found && $0 ~ marker { found = 1; next }
    found && !inrun && /^[[:space:]]*run:[[:space:]]*\|[[:space:]]*$/ {
      inrun = 1; match($0, /^[[:space:]]*/); runind = RLENGTH; next
    }
    inrun {
      if ($0 ~ /^[[:space:]]*$/) { print ""; next }
      match($0, /^[[:space:]]*/)
      if (RLENGTH <= runind) exit
      if (!bodyind) bodyind = RLENGTH
      print substr($0, bodyind + 1)
    }
  ' "$WF_FILE"
}
# step_output_env MARKER_REGEX: "NAME KEY" for every `NAME: ${{ steps.pre_upgrade.outputs.KEY }}`
# in that step's env block, i.e. how deploy.yml feeds pre_upgrade's outputs to it.
step_output_env() {
  awk -v marker="$1" '
    { sub(/\r$/, "") }
    !found && $0 ~ marker { found = 1; next }
    found && /^[[:space:]]*run:/ { exit }
    found && /^[[:space:]]*-[[:space:]]+name:/ { exit }
    found && match($0, /^[[:space:]]*[A-Z_][A-Z0-9_]*:[[:space:]]*\$\{\{[[:space:]]*steps\.pre_upgrade\.outputs\.[a-z_]+[[:space:]]*\}\}/) {
      line = $0
      gsub(/[${}:]/, " ", line)
      n = split(line, f, /[[:space:]]+/)
      name = ""; key = ""
      for (i = 1; i <= n; i++) {
        if (f[i] == "") continue
        if (name == "") { name = f[i]; continue }
        if (f[i] ~ /^steps\.pre_upgrade\.outputs\./) { key = f[i]; sub(/^steps\.pre_upgrade\.outputs\./, "", key) }
      }
      print name, key
    }
  ' "$WF_FILE"
}

PRE_MARKER='^[[:space:]]*id:[[:space:]]*pre_upgrade[[:space:]]*$'
RB_MARKER='^[[:space:]]*-[[:space:]]+name:[[:space:]]*Rollback on post-deploy verification failure[[:space:]]*$'
step_body "$PRE_MARKER" > "$RB_ROOT/pre_upgrade.sh"
step_body "$RB_MARKER" > "$RB_ROOT/rollback.sh"
step_output_env "$RB_MARKER" > "$RB_ROOT/rollback.env"
check "Rollback workflow: the pre_upgrade run body is extracted from deploy.yml" \
  "$(grep -q 'helm status gambit' "$RB_ROOT/pre_upgrade.sh" && grep -q 'prev_revision=' "$RB_ROOT/pre_upgrade.sh" && echo 0 || echo 1)"
check "Rollback workflow: the rollback run body is extracted from deploy.yml" \
  "$(grep -q 'helm rollback gambit' "$RB_ROOT/rollback.sh" && grep -q 'helm uninstall gambit' "$RB_ROOT/rollback.sh" && echo 0 || echo 1)"
check "Rollback workflow: the rollback step reads release_exists and its target from pre_upgrade outputs" \
  "$(grep -q ' release_exists$' "$RB_ROOT/rollback.env" && grep -q ' prev_revision$' "$RB_ROOT/rollback.env" && echo 0 || echo 1)"

# The stub helm: serves the scenario's fixtures from $HELM_STUB_DIR and records every call.
cat > "$RB_ROOT/bin/helm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HELM_STUB_DIR/calls.log"
case "$1" in
  status)
    exit "$(cat "$HELM_STUB_DIR/status_rc" 2>/dev/null || echo 0)" ;;
  history)
    if [ -f "$HELM_STUB_DIR/history.json" ]; then cat "$HELM_STUB_DIR/history.json"; exit 0; fi
    echo "Error: release: not found" >&2; exit 1 ;;
  get)
    [ "${2:-}" = values ] && [ -f "$HELM_STUB_DIR/values.json" ] && { cat "$HELM_STUB_DIR/values.json"; exit 0; }
    echo "Error: values not available" >&2; exit 1 ;;
  rollback|uninstall)
    exit 0 ;;
  *)
    echo "helm stub: unexpected invocation: $*" >&2; exit 64 ;;
esac
STUB
cat > "$RB_ROOT/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >> "$HELM_STUB_DIR/calls.log"
echo "kubectl stub: the rollback path must not call kubectl" >&2
exit 64
STUB
chmod +x "$RB_ROOT/bin/helm" "$RB_ROOT/bin/kubectl"
RB_VALUES='{"images":{"api":{"tag":"1.1.0"},"web":{"tag":"1.1.0"},"gateway":{"tag":"1.1.0"}},"rollout":{"strategy":"rolling"}}'

# hist REV:STATUS...: a `helm history -o json` array. REV is inserted raw, so malformed
# revisions ("05", 4.5, -1, ...) can be expressed.
hist() {
  local out="" sep="" e r s d
  for e in "$@"; do
    r="${e%%:*}"; s="${e#*:}"; d="${r//\"/}"
    out+="$sep{\"revision\":$r,\"updated\":\"2026-10-11T10:00:00Z\",\"status\":\"$s\",\"chart\":\"gambit-0.1.0\",\"app_version\":\"1.0.$d\",\"description\":\"fixture revision $d\"}"
    sep=","
  done
  printf '[%s]' "$out"
}

# rb_run NAME STRATEGY HISTORY [STATUS_RC]: run pre_upgrade, then (if it succeeded)
# the rollback step with pre_upgrade's outputs. HISTORY "@missing" makes `helm
# history` fail. Leaves pre.rc/pre.log/rb.rc/rb.log/calls.log in $RB_ROOT/NAME.
rb_run() {
  local name="$1" strategy="$2" history="$3" status_rc="${4:-0}"
  local fx="$RB_ROOT/$name" rc envname key line k v
  local -A out=()
  local -a rbenv=()
  mkdir -p "$fx"
  : > "$fx/calls.log"; : > "$fx/github_output"
  printf '%s' "$status_rc" > "$fx/status_rc"
  [ "$history" = "@missing" ] || printf '%s' "$history" > "$fx/history.json"
  printf '%s' "$RB_VALUES" > "$fx/values.json"
  rc=0
  env PATH="$RB_ROOT/bin:$PATH" HELM_STUB_DIR="$fx" GITHUB_OUTPUT="$fx/github_output" \
    STRATEGY="$strategy" ENVIRONMENT=production VERSION=1.2.3 \
    bash -e "$RB_ROOT/pre_upgrade.sh" > "$fx/pre.log" 2>&1 || rc=$?
  echo "$rc" > "$fx/pre.rc"
  : > "$fx/rb.log"; echo "skipped" > "$fx/rb.rc"
  [ "$rc" = 0 ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -n "$line" ] || continue
    k="${line%%=*}"; v="${line#*=}"
    out["$k"]="$v"
  done < "$fx/github_output"
  while read -r envname key; do
    [ -n "$envname" ] && rbenv+=("$envname=${out[$key]:-}")
  done < "$RB_ROOT/rollback.env"
  rc=0
  env PATH="$RB_ROOT/bin:$PATH" HELM_STUB_DIR="$fx" "${rbenv[@]}" \
    bash -e "$RB_ROOT/rollback.sh" > "$fx/rb.log" 2>&1 || rc=$?
  echo "$rc" > "$fx/rb.rc"
}
rb_mutations() { grep -E '^(rollback|uninstall)( |$)' "$RB_ROOT/$1/calls.log" || true; }
rb_show() {
  echo "      pre_upgrade exit $(cat "$RB_ROOT/$1/pre.rc"), rollback step exit $(cat "$RB_ROOT/$1/rb.rc"); helm mutations: $(rb_mutations "$1" | tr '\n' ';')"
  sed 's/^/      | /' "$RB_ROOT/$1/pre.log" "$RB_ROOT/$1/rb.log" | head -n 40
}
# expect_rollback NAME REV DESC: the workflow rolls back to exactly REV, and nothing else.
expect_rollback() {
  local ok=1
  [ "$(cat "$RB_ROOT/$1/pre.rc")" = 0 ] && [ "$(cat "$RB_ROOT/$1/rb.rc")" = 0 ] \
    && [ "$(rb_mutations "$1")" = "rollback gambit $2 --wait --timeout 5m0s" ] && ok=0
  check "$1: $3" "$ok"
  [ "$ok" = 0 ] || rb_show "$1"
}
# expect_rollback_logged NAME REV: the rollback step says which revision and why (its status).
expect_rollback_logged() {
  local ok=1
  grep -q "revision $2" "$RB_ROOT/$1/rb.log" && grep -qi 'deployed' "$RB_ROOT/$1/rb.log" && ok=0
  check "$1: the rollback step logs target revision $2 and that it was the deployed revision" "$ok"
  [ "$ok" = 0 ] || rb_show "$1"
}
# expect_refusal NAME REASON_ERE DESC: deploy proceeds (pre_upgrade warns), and the rollback
# step neither rolls back nor uninstalls, failing with an actionable ::error:: naming the reason.
expect_refusal() {
  local ok=1
  [ "$(cat "$RB_ROOT/$1/pre.rc")" = 0 ] && [ "$(cat "$RB_ROOT/$1/rb.rc")" != 0 ] \
    && [ "$(cat "$RB_ROOT/$1/rb.rc")" != skipped ] && [ -z "$(rb_mutations "$1")" ] \
    && grep -q '::warning::' "$RB_ROOT/$1/pre.log" \
    && grep -q '::error::' "$RB_ROOT/$1/rb.log" && grep -q 'helm history gambit' "$RB_ROOT/$1/rb.log" \
    && grep -qiE -- "$2" "$RB_ROOT/$1/rb.log" && ok=0
  check "$1: $3" "$ok"
  [ "$ok" = 0 ] || rb_show "$1"
}
# expect_pre_refused NAME MESSAGE_ERE DESC: pre_upgrade refuses the deploy (canary/blueGreen gate).
expect_pre_refused() {
  local ok=1
  [ "$(cat "$RB_ROOT/$1/pre.rc")" != 0 ] && [ -z "$(rb_mutations "$1")" ] \
    && grep -qE -- "$2" "$RB_ROOT/$1/pre.log" && ok=0
  check "$1: $3" "$ok"
  [ "$ok" = 0 ] || rb_show "$1"
}

# 1. The defect: a later failed revision sits on top of the deployed one.
rb_run failed-tip rolling "$(hist 3:superseded 4:deployed 5:failed)"
expect_rollback failed-tip 4 "rolling over 4:deployed,5:failed rolls back to deployed 4, not failed 5"
expect_rollback_logged failed-tip 4
rb_run failed-tips rolling "$(hist 2:superseded 3:deployed 4:failed 5:failed)"
expect_rollback failed-tips 3 "rolling over 3:deployed,4:failed,5:failed rolls back to deployed 3"

# 2. A pending or unknown revision on top: never an automatic rollback to it.
for s in pending-upgrade pending-rollback pending-install unknown; do
  rb_run "tip-$s" rolling "$(hist 3:superseded 4:deployed "5:$s")"
  expect_refusal "tip-$s" "${s%%-*}" "a $s revision above deployed 4: no rollback, no uninstall, actionable error"
done
rb_run pending-below rolling "$(hist 3:pending-upgrade 4:deployed)"
expect_refusal pending-below "pending" "a pending revision anywhere in the history fails closed"

# 3. Healthy controls (pass on the unfixed workflow too).
rb_run healthy rolling "$(hist 3:superseded 4:deployed)"
expect_rollback healthy 4 "healthy 3:superseded,4:deployed rolls back to 4"
expect_rollback_logged healthy 4
rb_run healthy-string rolling '[{"revision":"3","status":"superseded"},{"revision":"4","status":"deployed"}]'
expect_rollback healthy-string 4 "canonical digit-string revisions are accepted"

# 4. Atomic recovery created a new deployed revision on top of the failed one.
rb_run atomic-recovered rolling "[$(hist 4:superseded | tr -d '[]'),$(hist 5:failed | tr -d '[]'),{\"revision\":6,\"updated\":\"2026-10-11T10:00:00Z\",\"status\":\"deployed\",\"chart\":\"gambit-0.1.0\",\"app_version\":\"1.0.4\",\"description\":\"Rollback to 4\"}]"
expect_rollback atomic-recovered 6 "atomic-recovered 4:superseded,5:failed,6:deployed rolls back to 6"

# 5. Anything that does not prove a single safe target fails closed.
rb_refuse() {  # NAME REASON_ERE DESC HISTORY
  rb_run "$1" rolling "$4"
  expect_refusal "$1" "$2" "$3"
}
rb_refuse hist-missing 'history' "helm history fails: no rollback, no uninstall" @missing
rb_refuse hist-empty-output 'JSON|history' "empty helm history output fails closed" ''
rb_refuse hist-empty-array 'empty|deployed' "an empty history array fails closed" '[]'
rb_refuse hist-not-json 'JSON' "non-JSON helm history fails closed" 'Error: something went wrong'
rb_refuse hist-object 'array' "a non-array helm history fails closed" '{"revision":4,"status":"deployed"}'
rb_refuse entry-null 'entry|object' "a null history entry fails closed" "[null,$(hist 4:deployed | tr -d '[]')]"
rb_refuse rev-zero 'revision' "revision 0 fails closed" "$(hist 0:deployed)"
rb_refuse rev-zero-tip 'revision' "a revision 0 above the deployed one fails closed" "$(hist 4:deployed 0:failed)"
rb_refuse rev-negative 'revision' "a negative revision fails closed" "$(hist 3:superseded -4:deployed)"
rb_refuse rev-fraction 'revision' "a fractional revision fails closed" "$(hist 3:superseded 4.5:deployed)"
rb_refuse rev-unsafe 'revision' "an unsafe-integer revision fails closed" "$(hist 3:superseded 9007199254740993:deployed)"
rb_refuse rev-leading-zero 'revision' "a revision with a leading zero (\"05\") fails closed" "$(hist 4:superseded '"05"':deployed)"
rb_refuse rev-non-numeric 'revision' "a non-numeric revision fails closed" "$(hist 3:superseded '"x"':deployed)"
rb_refuse rev-malformed-below 'revision' "a malformed revision anywhere in the history fails closed" "$(hist '"x"':superseded 4:deployed)"
rb_refuse rev-missing 'revision' "an entry without a revision fails closed" '[{"status":"superseded"},{"revision":4,"status":"deployed"}]'
rb_refuse status-bogus 'status' "an unknown status string fails closed" "$(hist 3:superseded 4:deployed 5:exploded)"
rb_refuse status-number 'status' "a non-string status fails closed" '[{"revision":4,"status":"deployed"},{"revision":5,"status":1}]'
rb_refuse dup-revision 'duplicate' "duplicated revision numbers fail closed" "$(hist 3:superseded 4:deployed 4:failed)"
rb_refuse two-deployed 'deployed' "two deployed revisions fail closed" "$(hist 3:deployed 4:deployed)"
rb_refuse superseded-above 'superseded' "a superseded revision above the deployed one fails closed" "$(hist 3:deployed 4:superseded)"
rb_refuse uninstalled-above 'uninstall' "an uninstalled revision above the deployed one fails closed" "$(hist 3:deployed 4:uninstalled)"
rb_refuse uninstalling-above 'uninstall' "an uninstalling revision above the deployed one fails closed" "$(hist 3:deployed 4:uninstalling)"
rb_refuse failed-only 'deployed' "a history with no deployed revision (1:failed) fails closed" "$(hist 1:failed)"
rb_refuse no-deployed 'deployed' "a history with no deployed revision (4:superseded,5:failed) fails closed" "$(hist 4:superseded 5:failed)"

# 6. Initial install: unchanged, the failed release is uninstalled.
rb_run initial-install rolling @missing 1
check "initial-install: a failed initial install is uninstalled (no rollback)" \
  "$([ "$(cat "$RB_ROOT/initial-install/pre.rc")" = 0 ] && [ "$(rb_mutations initial-install)" = "uninstall gambit --wait --timeout 5m0s" ] && echo 0 || echo 1)"
[ "$(rb_mutations initial-install)" = "uninstall gambit --wait --timeout 5m0s" ] || rb_show initial-install

# 7. Canary and blue/green: the pre-upgrade gate is unchanged.
for s in canary blueGreen; do
  rb_run "$s-failed-tip" "$s" "$(hist 3:superseded 4:deployed 5:failed)"
  expect_pre_refused "$s-failed-tip" 'is not the deployed one' "$s over a failed tip is still refused before the upgrade"
  rb_run "$s-pending-tip" "$s" "$(hist 3:superseded 4:deployed 5:pending-upgrade)"
  expect_pre_refused "$s-pending-tip" 'is not the deployed one' "$s over a pending tip is still refused before the upgrade"
  rb_run "$s-no-history" "$s" @missing
  expect_pre_refused "$s-no-history" 'Could not determine the deployed revision' "$s without a readable history is still refused"
  rb_run "$s-initial" "$s" @missing 1
  expect_pre_refused "$s-initial" 'initial install' "$s initial install is still refused"
  rb_run "$s-healthy" "$s" "$(hist 3:superseded 4:deployed)"
  expect_rollback "$s-healthy" 4 "$s over healthy history keeps its deployed-tag pinning and rolls back to deployed 4"
  check "$s-healthy: the deployed tags are read from deployed revision 4" \
    "$(grep -qx 'get values gambit --all -o json --revision 4' "$RB_ROOT/$s-healthy/calls.log" && grep -qx 'deployed_live_api_tag=1.1.0' "$RB_ROOT/$s-healthy/github_output" && echo 0 || echo 1)"
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All snapshot tests passed."
