# ADR-0076 — Deploy-gated CI/CD pipeline and automated release delivery

| Field      | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| **Status** | Accepted                                                                 |
| **Date**   | 2026-08-03                                                               |
| **Scope**  | `.github/workflows`, `deploy/environments`, `scripts`, `docs`            |

---

## Context

Every release of Gambit prior to Milestone 14 Increment 10 required human intervention to build container images and manually execute `helm upgrade` against a target Kubernetes cluster. No automated CI/CD pipeline existed to publish built artifacts or execute gated deployments.

While `.github/workflows/ci.yml` validates domain code, PostgreSQL integration, gateway behavior, Playwright acceptance, and Helm manifest schemas on pushes to `main` and pull requests, it never publishes container images and never deploys resources to any environment.

Shipping production services without automated, gated deployment pipelines introduces four major failure modes:
1. **Version mismatch drift**: A release tag (e.g. `v1.2.3`) is created, but container images are built under mismatched tags or default floating tags (`:latest`), or Helm `Chart.yaml` claims an `appVersion` different from the deployed images.
2. **Ungated or destructive rollouts**: Deployments execute without human approval gates, or overlapping deployments cancel one another mid-flight (`cancel-in-progress: true`), leaving partially applied Helm releases in Kubernetes.
3. **Non-atomic release failures & double-rollbacks**: Deployments execute without atomic rollback flags (`--atomic`), leaving a broken version live on pod failure; or explicit rollback logic fires blindly on `--atomic` failure, rolling back past the restored healthy release or uninstalling a live release due to history parsing errors.
4. **Shell script injection & quoting hazards**: Secrets or free-text user inputs are directly interpolated as raw text into `run:` scripts (`${{ inputs.version }}`), creating script-injection vectors.

Furthermore, because no physical Kubernetes cluster is connected directly to this repository, the deploy execution path cannot be end-to-end exercised in CI. The pipeline must therefore enforce its safety invariants statically via an automated guard check.

## Decision

### 1. Release workflow triggered strictly on version tags (`.github/workflows/release.yml`)

Releases are triggered by pushing a git tag matching `v*` (e.g. `v1.2.3`). Because tag pushes do not trigger standard branch CI (`ci.yml`), `release.yml` includes an explicit `verify` job (`npm ci`, `npm run build`, `npm test`, `npm run lint`) that must pass before any artifact is published.

The subsequent `publish` job:
- Validates that the git tag version (without leading `v`) matches `appVersion` in `deploy/helm/gambit/Chart.yaml` exactly, and passes strict SemVer format validation (`^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$`). A mismatch or malformed string immediately aborts the workflow.
- Builds and publishes the three container images (`api`, `gateway`, `web`) to GitHub Container Registry (GHCR) using `docker/build-push-action@v5`.
- Tags each image with both the semantic version (e.g. `1.2.3`) and the exact git commit SHA. **Floating `:latest` tags are never published or deployed.**
- Authenticates using `GITHUB_TOKEN` with scoped `permissions: { contents: read, packages: write }`.
- Passes input values via step `env:` blocks to eliminate shell-injection risks.
- Hardcodes the target GHCR repository owner (`ghcr.io/senasehs19-oss/gambit-{api,gateway,web}`) to maintain strict alignment with chart defaults.

### 2. Gated deploy workflow (`.github/workflows/deploy.yml`)

The deployment pipeline is triggered via `workflow_dispatch` (with explicit inputs for `version`, `environment`, `strategy`, `canary_weight`, `target_color` and `active_color`) or automatically on `release: [published]` for staging.

**Blue/green is two runs, and the inputs say which one you are doing.** ADR-0075's whole argument for blue/green is that the new version can be exercised before it takes traffic; a pipeline that puts the incoming version straight onto the active colour throws that away and is a rolling release with extra steps. So `target_color` names the colour that receives this version and `active_color` names the colour serving traffic afterwards: unequal is a stage (the standby gets the version, reachable only at the preview host), equal is the cutover. No third "mode" input is needed, and a straight cutover stays expressible for operators who want it.

Two consequences follow from the chart's contract rather than from choice:

- **The pipeline must not set `images.api.tag` / `images.web.tag` for blue/green.** The colour that did not receive the version falls back to those, so overriding them makes both colours resolve to the same image and the chart refuses to render (ADR-0075 rejects a preview that is a copy of what is already live). They therefore hold the rollback target, and the environment values file is where an operator keeps it current. An earlier draft of this workflow set them unconditionally, which made **every** blue/green deploy fail at render time.
- **The gateway moves only on the cutover.** It is not colour-versioned, so moving it is what actually exposes the new version; leaving it alone during a stage means the standby is previewed against exactly what is serving today.

A blue/green **initial install is refused**: with no existing release there is no published baseline for the standby colour to hold and nothing to roll back to. The first install uses `rolling`.

Key architectural decisions in `deploy.yml`:
- **Least-privilege permissions**: Declares explicit top-level `permissions: { contents: read, packages: read }`.
- **Environment variable safety**: Every `inputs.*` and `secrets.*` value is passed via step `env:` blocks and referenced as shell variables (`$VERSION`, `$KUBECONFIG_SECRET`). Version values are validated against a strict SemVer regex before use.
- **Human approval environment gate**: The `deploy` job explicitly declares `environment: ${{ needs.validate.outputs.environment }}`. Environment protection rules (manual approvals, deployment windows, protected secrets) are enforced at the GitHub environment layer.
- **Queueing concurrency**: Top-level concurrency specifies `cancel-in-progress: false` per environment (`group: deploy-${{ inputs.environment }}`). Deploys queue sequentially; a new deploy must never cancel an in-flight rollout.
- **`needs:`-gated execution**: The `deploy` job depends on a prior `validate` job, ensuring deployment logic never runs unqualified.
- **Fail closed on missing credentials**: If `secrets.KUBECONFIG` is missing or empty, the workflow exits non-zero immediately. It never skips silently or reports false success.
- **Pre-flight image verification**: Queries GHCR (`docker manifest inspect`) for all three container images (`api`, `gateway`, `web`) at the specified version tag before executing `helm upgrade`. Error output is captured explicitly and reported as "could not be verified" to avoid mischaracterizing auth or network faults as missing image tags.
- **Single-source strategy composition & pre-flight render**: Strategy arguments (`EXTRA_ARGS`) are constructed ONCE in the step. Pre-flight `helm template` dry-run validation executes first using `${EXTRA_ARGS[@]}`, followed by `helm upgrade` using the exact same `${EXTRA_ARGS[@]}`, eliminating flag drift between validation and upgrade.
- **Atomic rollouts with explicit timeouts**: `helm upgrade --install` is invoked with `--atomic`, `--wait`, and `--timeout 5m0s`, passing the environment values file (`deploy/environments/<env>.values.yaml`). If a pod fails to reach ready status during upgrade, Helm automatically reverts the release to the pre-upgrade revision.
- **Strategy-independent smoke check**: Post-deploy verification queries Deployments by release instance label selector (`kubectl get deployments -l app.kubernetes.io/instance=gambit`). This correctly matches Deployments rendered under any strategy (`rolling`, `blueGreen`, `canary`) and fails closed if zero Deployments match. Literal Deployment names (e.g. `deployment/gambit-api`) are prohibited.
- **Three-way rollback branch**: Helm `--atomic` covers failures *during* `helm upgrade` (reverting to pre-upgrade revision automatically). The explicit rollback step (`id: smoke_check` failure condition: `if: failure() && steps.smoke_check.outcome == 'failure'`) covers only failures occurring *after* a successful `helm upgrade`. It uses a strict three-way branch:
  1. **Initial install** (`RELEASE_EXISTS=false` determined via `helm status` exit code): uninstalls the initial failed release (`helm uninstall gambit`).
  2. **Upgrade with known revision** (`RELEASE_EXISTS=true` and `PREV_REV` parsed via machine-readable `helm history -o json` with explicit `require('node:fs')`): rolls back to that explicit revision (`helm rollback gambit "$PREV_REV"`).
  3. **Upgrade with unparseable revision** (`RELEASE_EXISTS=true` but `PREV_REV` missing/unparseable): fails loudly with `::error::` for human operator intervention without guessing or uninstalling live releases.

  Case 3 is announced when it is *created*, not when it bites: if the revision cannot be read while the release exists, the pre-upgrade step emits a `::warning::` with the raw `helm history` output immediately. Otherwise the only signal is a refusal to roll back, discovered mid-incident.

### 3. Environment values files (`deploy/environments/*.values.yaml`)

Per-environment configuration is stored in `deploy/environments/staging.values.yaml` and `deploy/environments/production.values.yaml` and passed with `-f`. No secrets are stored in these files: credentials reference `secrets.existingSecret` or External Secrets Operator integration (ADR-0044). Baseline image tags (`images.api.tag: 0.1.0` / `images.web.tag: 0.1.0`) provide rollback targets for `blueGreen` rollouts.

### 4. Static gate verification guard (`scripts/check-deploy-gates.mjs`)

The pipeline's safety invariants are enforced by a plain Node ESM guard script (`scripts/check-deploy-gates.mjs`, executable via `npm run check:deploy-gates`), wired into `.github/workflows/ci.yml` under the `helm` job.

The guard scans workflow text and chart values without external dependencies (stripping comment and `echo` lines when inspecting command steps) and asserts nine invariants:
1. `deploy.yml`'s deploy job declares `environment:`.
2. `deploy.yml` specifies `concurrency` with `cancel-in-progress: false`.
3. Every `helm upgrade` command passes `--atomic`, `--wait`, and explicit `--timeout`.
4. The `deploy` job is `needs:`-gated.
5. Neither workflow uses floating `:latest` image tags (enforced via shared helper `checkNoFloatingTags`).
6. The image repositories published by `release.yml` match `deploy/helm/gambit/values.yaml` exactly.
7. `deploy.yml` does not refer to Deployments by hardcoded names (names vary by strategy, ADR-0075).
8. `deploy.yml` includes a `helm template` pre-flight check before `helm upgrade` (ignoring `echo` log text).
9. `deploy.yml` strategy composition (`case "$STRATEGY" in`) appears exactly once (single-source composition).

## Consequences

**What is verified vs unexercised**:
Because no live cluster is connected to this repository, the actual execution of `helm upgrade` against a Kubernetes API server is unexercised in CI. What this increment delivers and continuously verifies is the **pipeline's gate structure, concurrency controls, atomic flags, strategy-independent smoke checks, script injection guards, safe three-way rollback logic, single-source argument composition, and image repository alignment**, enforced statically by `check-deploy-gates.mjs`.

**Operator release workflow**:
Operators release by tagging a commit (`git tag v1.2.3 && git push origin v1.2.3`). `release.yml` verifies the codebase, validates `Chart.yaml` `appVersion`, and pushes tagged images to GHCR. Deployment to staging or production is executed via `deploy.yml` (`workflow_dispatch`), passing the desired release strategy.

**Immutable image tags**:
Releases use exact semantic tags (e.g. `1.2.3`) and commit SHAs. Rollbacks are deterministic because image content bound to a version tag never changes.

## Amendment (2026-10-10): canary and blue/green keep what is deployed

Two statements above did not hold, because `helm upgrade` runs without `--reuse-values` and so recomputes every unset value from the chart defaults and the environment values file:

- **Canary was a 100% rollout.** The composition set `images.api.tag` / `images.web.tag` to the new version alongside `rollout.canary.tag`. The stable track reads `images.<component>.tag`, so both tracks ran the new version and the weight routed nothing. It also moved the gateway and trust worker for all traffic.
- **A blue/green stage did not leave the gateway "where it is".** With `images.gateway.tag` unset it fell back to the chart default, and the live colour, the rollback colour and every `wait-for-api` init container fell back to the environment file's baseline `images.*.tag`. Keeping that file current by hand (§3 above) could not cover the gateway, and gave no guarantee for the rest.

The workflow now reads the **deployed** revision (`helm history` → newest `deployed` revision → `helm get values --all`) through `scripts/resolve-deployed-image-tags.mjs`, and pins everything the run is not changing: canary keeps the stable track on the version serving traffic (the active colour's, if the release was blue/green) and keeps the gateway and trust worker; blue/green keeps the other colour's tag, `images.*.tag` and, on a stage, the gateway. The other colour therefore holds the immediately previous live version only when the cutover targets the standby; a cutover onto the colour already live replaces that version. It fails closed if those tags cannot be read or the newest revision is not the deployed one (the post-deploy rollback targets the newest), refuses a blue/green stage whose `active_color` is not the colour serving traffic now, and refuses a canary initial install as it already refused a blue/green one. What is kept is image versions, not pod templates: a strategy switch or a new chart version can still restart the gateway and trust worker through their `wait-for-api` init image and chart labels. The chart rejects a canary whose tag equals the stable track's. `scripts/helm-snapshot-test.sh` executes the workflow's own composition across a chained deploy lifecycle and asserts the image of every Deployment, rather than only that the render succeeds. No workflow deploy now relies on the baseline tags in `deploy/environments/*.values.yaml` (rolling sets every tag explicitly); they remain defaults for manual `helm` commands and are no longer a rollback contract.

## Amendment 2026-10-11: the automatic rollback targets only the verified pre-upgrade deployed revision

**Defect.** §2's case 2 rolled back to the *newest* revision of the pre-upgrade `helm history -o json`, without looking at its status. Helm v3.16.3 makes that wrong after any failed non-atomic upgrade: such an upgrade leaves `N:deployed, N+1:failed`; a rolling upgrade over that succeeds (Helm refuses only a `pending-*` tip and upgrades from the deployed revision), so when its smoke check then failed the workflow ran `helm rollback gambit N+1`. `helm rollback` copies the target revision's chart and values with no status check, so that re-applied the configuration that had already failed. Canary and blue/green were protected by the gate the 2026-10-10 amendment added (they refuse unless the newest revision is the deployed one); rolling had no guard.

**Invariant.** An automatic post-deploy rollback targets only a provably safe pre-upgrade revision: the unique revision with status `deployed` in the single pre-upgrade `helm history gambit -o json` snapshot, after whole-history validation. `scripts/lib/rollback-revision.mjs` (`resolveRollbackRevision`, CLI `scripts/resolve-rollback-revision.mjs`) decides it and returns its evidence (revision, status, chart, app version, description, update time, newest revision); `pre_upgrade` logs that evidence and publishes the target as `prev_revision`, and the rollback step echoes which revision it rolls back to and why. `scripts/check-deploy-gates.mjs` gate 10 asserts the target comes from that resolver and nowhere else.

**Helm semantics relied on** (v3.16.3): the statuses are `unknown`, `deployed`, `uninstalled`, `superseded`, `failed`, `uninstalling`, `pending-install`, `pending-upgrade`, `pending-rollback`; a failed revision is never what Helm serves; an atomic recovery creates a new `deployed` revision ("Rollback to N") on top of the failed one; a successful rollback or upgrade supersedes every `deployed` record, but `deployed` is not guaranteed unique after corruption; `helm history -o json` is ascending by revision and capped by `--max` (default 256). A historical `deployed` revision becomes `superseded` once the new upgrade succeeds, so the decision is made from the pre-upgrade snapshot only.

**Fail-closed cases.** No target, and therefore no automatic rollback and no uninstall — the rollback step fails with an `::error::` naming the reason and telling the operator to inspect `helm history gambit` and roll back manually — when the history cannot be read or is not a JSON array; is empty; has an entry that is not an object, a revision that is not a positive safe integer (JSON number, or canonical digit string without leading zeros), or a status outside the set above; repeats a revision number; contains any `pending-*` revision; has no or more than one `deployed` revision; or has anything other than `failed` above the deployed revision. A failed initial install is still uninstalled, unchanged.

**Unchanged.** `--atomic --wait --timeout 5m0s`, the rollback step's condition and three-way branch, the canary/blue-green refusal (now fed by the same history snapshot; it still compares the newest revision with the newest `deployed` one, exactly as before) and their deployed-tag pinning. `helm status` is still how release existence is detected.

**Explicitly not decided.** A rolling deploy over a failed (or otherwise unverifiable) tip is still allowed — fixing forward is a legitimate operator action — and only warns in `pre_upgrade` that the automatic rollback will refuse. Whether rolling should refuse in that state is left to the owner. `scripts/helm-snapshot-test.sh` executes the workflow's own `pre_upgrade` and rollback step bodies against a stub `helm` for each of these cases and asserts the exact `helm rollback` / `helm uninstall` they would issue.
