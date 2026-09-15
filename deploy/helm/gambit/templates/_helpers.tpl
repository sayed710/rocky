{{/*
Helper templates for the Gambit Helm chart.
*/}}

{{/*
Expand the chart name.
*/}}
{{- define "gambit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full name: release name + chart name.
*/}}
{{- define "gambit.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version label.
*/}}
{{- define "gambit.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "gambit.labels" -}}
helm.sh/chart: {{ include "gambit.chart" . }}
{{ include "gambit.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "gambit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gambit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Secret name.
*/}}
{{- define "gambit.secretName" -}}
{{- default (printf "%s-secret" (include "gambit.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
ConfigMap name.
*/}}
{{- define "gambit.configMapName" -}}
{{- printf "%s-config" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
Resolve the trusted proxy hop count from the rendered topology unless the
operator supplies an explicit non-negative integer override.
*/}}
{{- define "gambit.trustProxy" -}}
{{- $explicit := toString .Values.config.trustProxy -}}
{{- if ne $explicit "" -}}
{{- if not (regexMatch "^(0|[1-9][0-9]*)$" $explicit) -}}
{{- fail (printf "config.trustProxy must be an empty value or a non-negative integer (got %q)" $explicit) -}}
{{- end -}}
{{- $explicit -}}
{{- else if .Values.web.ingress.enabled -}}
2
{{- else -}}
1
{{- end -}}
{{- end -}}

{{/*
Progressive delivery (M14 inc 9, ADR-0075).

`gambit.variants` returns the list of Deployment variants for a traffic-taking
component (api or web). Every strategy produces at least one variant, marked
`primary: true`, whose Service keeps the unsuffixed name the rest of the release
already refers to — so `rolling` renders exactly what the chart rendered before
this existed.

Each variant carries:
  name      Deployment name suffix ("", "-blue", "-green", "-canary")
  service   Service name suffix ("" for the primary, "-preview" or "-canary")
  color     value of the gambit.dev/color selector label, or ""
  track     value of the gambit.dev/track selector label, or ""
  tag       image tag for this variant
  replicas  replica count for this variant
  primary   whether this variant is the one live traffic reaches by default

The Deployment and Service suffixes are deliberately separate. Blue/green flips
by rewriting a Service selector, which requires the Deployment names to stay put
across a flip (renaming them would recreate pods and defeat the point), while
the Service names must stay put so consumers never re-point.

The api and web variant lists are parallel: a variant's `service` suffix is the
same on both, which is what lets a web variant address the api variant of its own
version (`API_UPSTREAM` -> `<fullname>-api<service>`). A canary cohort therefore
gets the canary frontend AND the canary API, never a mixed pair.
*/}}
{{- define "gambit.variants" -}}
{{- include "gambit.rollout.validate" .root -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $r := $root.Values.rollout -}}
{{- $baseTag := index $root.Values.images $component "tag" -}}
{{- $replicas := index $root.Values $component "replicas" -}}
{{- if eq $r.strategy "blueGreen" -}}
{{- $active := $r.blueGreen.activeColor -}}
{{- $inactive := ternary "green" "blue" (eq $active "blue") -}}
{{/* BOTH colors fall back to images.<component>.tag. The fallback has to be
     symmetric: with it on the active color only, a release that set just the
     standby's tag would render fine and then fail to render at the moment
     activeColor was flipped — the newly-inactive color having no tag of its own.
     A cutover, and the rollback after it, are the two worst moments to discover
     a validation error. What actually has to be rejected is the two colors
     resolving to the SAME image, which is checked below. */}}
{{- $activeTag := default $baseTag (index $r.blueGreen.colors $active "tag") -}}
{{- $inactiveTag := default $baseTag (index $r.blueGreen.colors $inactive "tag") -}}
{{- if and $r.blueGreen.preview.enabled (eq $activeTag $inactiveTag) -}}
{{- fail (printf "rollout.blueGreen: the %s and %s tracks of `%s` both resolve to tag %q, so the preview would be a copy of what is already live and a flip would change nothing. Give the standby color its own rollout.blueGreen.colors.%s.tag, or leave images.%s.tag at the version you would roll back to." $active $inactive $component $activeTag $inactive $component) -}}
{{- end -}}
- name: "-{{ $active }}"
  service: ""
  color: {{ $active | quote }}
  track: ""
  tag: {{ $activeTag | quote }}
  replicas: {{ $replicas }}
  primary: true
{{ if $r.blueGreen.preview.enabled -}}
- name: "-{{ $inactive }}"
  service: "-preview"
  color: {{ $inactive | quote }}
  track: ""
  tag: {{ $inactiveTag | quote }}
  {{/* Empty means "match the active color" — tested for explicitly rather than
       with `default`, which would also swallow a deliberate 0 (a standby whose
       manifests are staged but scaled to nothing). */}}
  replicas: {{ if eq (toString $r.blueGreen.preview.replicas) "" }}{{ $replicas }}{{ else }}{{ int $r.blueGreen.preview.replicas }}{{ end }}
  primary: false
{{ end -}}
{{- else if eq $r.strategy "canary" -}}
{{/* The stable track is named "-stable" rather than reusing the unsuffixed
     name, so that adopting canary on a live release REPLACES the Deployment
     instead of trying to add gambit.dev/track to its selector. A Deployment's
     spec.selector is immutable in apps/v1: mutating it fails the upgrade
     outright. Every strategy therefore owns a distinct set of Deployment names,
     and switching between them is always a replace. */}}
- name: "-stable"
  service: ""
  color: ""
  track: "stable"
  tag: {{ $baseTag | quote }}
  replicas: {{ $replicas }}
  primary: true
- name: "-canary"
  service: "-canary"
  color: ""
  track: "canary"
  tag: {{ $r.canary.tag | quote }}
  replicas: {{ $r.canary.replicas }}
  primary: false
{{- else -}}
- name: ""
  service: ""
  color: ""
  track: ""
  tag: {{ $baseTag | quote }}
  replicas: {{ $replicas }}
  primary: true
{{- end -}}
{{- end -}}

{{/*
Hostname of the blue/green preview Ingress. One definition of the "empty means
preview.<host>" rule, which both the rule and the TLS stanza need.
*/}}
{{- define "gambit.previewHost" -}}
{{- default (printf "preview.%s" .Values.web.ingress.host) .Values.rollout.blueGreen.preview.host -}}
{{- end -}}

{{/*
TLS stanza for an Ingress, given the host it serves. Takes a dict of root + host.
Every Ingress in the release terminates TLS with the same certificate secret, so
that rule lives here rather than in each of them.
*/}}
{{- define "gambit.ingressTls" -}}
{{- if .root.Values.web.ingress.tls.enabled }}
tls:
  - hosts:
      - {{ .host | quote }}
    secretName: {{ .root.Values.web.ingress.tls.secretName | quote }}
{{- end }}
{{- end -}}

{{/*
Variant selector labels. These go on the pod template AND the Deployment
selector: without them, two colors of the same component would select each
other's pods and their ReplicaSets would fight over the same fleet.
*/}}
{{- define "gambit.variantSelectorLabels" -}}
{{- $lines := list -}}
{{- if .color -}}{{- $lines = append $lines (printf "gambit.dev/color: %q" .color) -}}{{- end -}}
{{- if .track -}}{{- $lines = append $lines (printf "gambit.dev/track: %q" .track) -}}{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}

{{/*
Rollout configuration validation. Every guard here fails the render rather than
producing a release that looks progressive and is not.
*/}}
{{- define "gambit.rollout.validate" -}}
{{- $r := .Values.rollout -}}
{{- if not (has $r.strategy (list "rolling" "blueGreen" "canary")) -}}
{{- fail (printf "rollout.strategy must be one of rolling, blueGreen, canary (got %q)" $r.strategy) -}}
{{- end -}}
{{- if eq $r.strategy "blueGreen" -}}
{{- if not (has $r.blueGreen.activeColor (list "blue" "green")) -}}
{{- fail (printf "rollout.blueGreen.activeColor must be blue or green (got %q)" $r.blueGreen.activeColor) -}}
{{- end -}}
{{/* The two colors resolving to the same image is rejected in `gambit.variants`,
     where both tags are resolved against the per-component fallback. */}}
{{- end -}}
{{- if eq $r.strategy "canary" -}}
{{- if not .Values.web.ingress.enabled -}}
{{- fail "rollout.strategy=canary requires web.ingress.enabled=true: the traffic split is an ingress-nginx canary annotation, and with no Ingress the canary track would render but receive no traffic" -}}
{{- end -}}
{{- if not $r.canary.tag -}}
{{- fail "rollout.canary.tag must be set when rollout.strategy=canary: defaulting it to the stable tag would send a share of production traffic to a second copy of the version already running" -}}
{{- end -}}
{{- $w := int $r.canary.weight -}}
{{- if or (lt $w 0) (gt $w 100) -}}
{{- fail (printf "rollout.canary.weight must be between 0 and 100 (got %v)" $r.canary.weight) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Postgres service name (when bundled).
*/}}
{{- define "gambit.postgresServiceName" -}}
{{- printf "%s-postgres" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
Redis service name (when bundled).
*/}}
{{- define "gambit.redisServiceName" -}}
{{- printf "%s-redis" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
DATABASE_URL resolution:
  - If postgres.enabled=true: build from bundled postgres service + Secret password.
  - If postgres.enabled=false: use externalDatabaseUrl from values.
Both api and gateway use this — they share the same DATABASE_URL source.
*/}}
{{- define "gambit.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "postgres://%s:$(POSTGRES_PASSWORD)@%s:%d/%s" .Values.postgres.user (include "gambit.postgresServiceName" .) (int .Values.postgres.port) .Values.postgres.database -}}
{{- else -}}
{{- required "externalDatabaseUrl is required when postgres.enabled=false" .Values.externalDatabaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
REDIS_URL resolution:
  - If redis.enabled=true: build from bundled redis service.
  - If redis.enabled=false: use externalRedisUrl from values.
*/}}
{{- define "gambit.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- printf "redis://%s:%d" (include "gambit.redisServiceName" .) (int .Values.redis.port) -}}
{{- else -}}
{{- required "externalRedisUrl is required when redis.enabled=false" .Values.externalRedisUrl -}}
{{- end -}}
{{- end -}}
