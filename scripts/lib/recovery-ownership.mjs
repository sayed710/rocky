/**
 * Whether the post-deploy recovery in deploy.yml may act on release gambit, and whether an install
 * on confirmed absence would adopt live objects.
 *
 * Helm (v3.16.3) has no compare-and-swap or lease on a release, so between pre_upgrade's
 * `helm history` snapshot and the rollback step another writer can change it. Confirmed on a real
 * cluster: an operator's `helm upgrade` before or after this run's upgrade made the step roll back
 * past the operator's revision or revert it, and a reinstall left a "revision 1" the step would
 * uninstall. The workflow therefore marks its upgrade (`helm upgrade --install --description
 * <marker>`) and, before any `helm rollback` / `helm uninstall`, re-reads the history and requires:
 *
 * - the history is well formed and below the `--max 256` window (lib/rollback-revision.mjs);
 * - its newest revision is exactly the snapshot's newest + 1 (0 + 1 for an initial install);
 * - that revision is `deployed` and its description is exactly this run's marker;
 * - for a rollback, the verified target is still in the history (and below this run's revision).
 *
 * Helm v3.16.3 records the marker: pkg/action/upgrade.go releasingUpgrade sets
 * `upgradedRelease.Info.Description = u.Description` (else "Upgrade complete") together with
 * StatusDeployed, and RunWithContext stores it with Releases.Update; pkg/action/install.go
 * performInstall calls `rel.SetStatus(release.StatusDeployed, i.Description)` (else "Install
 * complete"), and cmd/helm/upgrade.go copies `client.Description` to the Install action when
 * `--install` finds no release. A failed upgrade or install overwrites it ("Upgrade \"gambit\"
 * failed: ...", failRelease), so a marked revision is one this run completed. The window between
 * this check and the `helm` command it guards is not closed (no CAS); see ADR-0076.
 *
 * The orphan inventory: when Helm has no record of the release but its objects are still live
 * and annotated `meta.helm.sh/release-name=gambit` (plus `app.kubernetes.io/managed-by=Helm`),
 * pkg/action/install.go adopts them (existingResourceConflict in pkg/action/validate.go accepts
 * them, performInstall then Updates instead of Creates), and a failed `--atomic` install or the
 * workflow's uninstall deletes them. pre_upgrade therefore lists the kinds the chart renders by
 * the release's instance label and by that annotation, and installs only into a namespace where
 * both lists are positively empty.
 */

import { HELM_STATUSES, parseRevision, saturatedHistoryReason } from './rollback-revision.mjs';

/** The kinds deploy/helm/gambit/templates renders, as `kubectl get` resource names. */
export const BASE_INVENTORY_KINDS = Object.freeze([
  'deployments.apps',
  'statefulsets.apps',
  'services',
  'configmaps',
  'secrets',
  'ingresses.networking.k8s.io',
  'networkpolicies.networking.k8s.io',
]);

/** templates/externalsecret.yaml's kind; inventoried only when the API server serves it. */
export const EXTERNAL_SECRET_RESOURCE = 'externalsecrets.external-secrets.io';

const MARKER_PREFIX = 'gambit-deploy';
const RUN_NUMBER = /^[1-9][0-9]{0,19}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$/;
const MARKER = /^gambit-deploy [1-9][0-9]{0,19}-[1-9][0-9]{0,19} [0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$/;

function oneLine(value, max = 300) {
  const flat = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * This run's marker: `gambit-deploy <GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT> <VERSION>` — one line of
 * safe characters, unique per run attempt.
 *
 * @param {{runId: unknown, runAttempt: unknown, version: unknown}} parts
 * @returns {string}
 * @throws {Error} When a part is missing or malformed.
 */
export function composeDeployMarker({ runId, runAttempt, version }) {
  if (typeof runId !== 'string' || !RUN_NUMBER.test(runId)) {
    throw new Error(`cannot compose the deploy marker: GITHUB_RUN_ID ${JSON.stringify(runId)} is not a run id`);
  }
  if (typeof runAttempt !== 'string' || !RUN_NUMBER.test(runAttempt)) {
    throw new Error(`cannot compose the deploy marker: GITHUB_RUN_ATTEMPT ${JSON.stringify(runAttempt)} is not a run attempt`);
  }
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`cannot compose the deploy marker: VERSION ${JSON.stringify(version)} is not a semver version`);
  }
  return `${MARKER_PREFIX} ${runId}-${runAttempt} ${version}`;
}

/**
 * Whether a fresh `helm history <release> -o json --max 256` shows that the newest revision is the
 * one this run's upgrade (or install) created, so recovery acts on nothing another writer made.
 *
 * @param {object} input
 * @param {unknown} input.history Parsed `helm history -o json`.
 * @param {'uninstall' | 'rollback'} input.action
 * @param {unknown} input.snapshotNewest The pre-upgrade snapshot's newest revision (0 when absent).
 * @param {unknown} input.marker This run's marker.
 * @param {unknown} [input.targetRevision] The verified rollback target (rollback only).
 * @returns {{ok: true, newestRevision: number} | {ok: false, reason: string}}
 */
export function checkRecoveryOwnership({ history, action, snapshotNewest, marker, targetRevision }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (action !== 'uninstall' && action !== 'rollback') {
    return refuse(`unknown recovery action ${JSON.stringify(action)}`);
  }
  if (typeof marker !== 'string' || !MARKER.test(marker)) {
    return refuse(`this run's revision marker is missing or malformed (${oneLine(JSON.stringify(marker ?? null))}); the deploy_marker output of pre_upgrade was not published`);
  }
  const snapshot = typeof snapshotNewest === 'number' ? snapshotNewest
    : typeof snapshotNewest === 'string' && /^(0|[1-9][0-9]*)$/.test(snapshotNewest) ? Number(snapshotNewest) : NaN;
  if (!Number.isSafeInteger(snapshot) || snapshot < 0) {
    return refuse(`the pre-upgrade snapshot's newest revision is missing or malformed (${oneLine(JSON.stringify(snapshotNewest ?? null))}); the snapshot_newest_revision output of pre_upgrade was not published`);
  }
  let target = null;
  if (action === 'uninstall') {
    if (snapshot !== 0) {
      return refuse(`an uninstall is allowed only after an initial install (pre-upgrade newest revision 0), got snapshot newest revision ${snapshot}`);
    }
    if (targetRevision !== undefined && targetRevision !== null && targetRevision !== '') {
      return refuse('an uninstall takes no target revision');
    }
  } else {
    if (snapshot < 1) {
      return refuse('a rollback needs a pre-upgrade history (snapshot newest revision 0 means there was no release)');
    }
    target = parseRevision(targetRevision);
    if (target === null) {
      return refuse(`the rollback target ${oneLine(JSON.stringify(targetRevision ?? null))} is not a revision`);
    }
    if (target > snapshot) {
      return refuse(`the rollback target revision ${target} is not below this run's revision ${snapshot + 1}`);
    }
  }

  if (!Array.isArray(history)) {
    return refuse('helm history output is not a JSON array');
  }
  if (history.length === 0) {
    return refuse('helm history is empty; the release this run deployed is gone');
  }
  const saturated = saturatedHistoryReason(history);
  if (saturated) {
    return refuse(saturated);
  }
  const byRevision = new Map();
  for (const [index, entry] of history.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return refuse(`helm history entry #${index} is not an object`);
    }
    const revision = parseRevision(entry.revision);
    if (revision === null) {
      return refuse(`helm history entry #${index} has an invalid revision ${oneLine(JSON.stringify(entry.revision ?? null))}`);
    }
    if (typeof entry.status !== 'string' || !HELM_STATUSES.has(entry.status)) {
      return refuse(`helm history revision ${revision} has an unknown status ${oneLine(JSON.stringify(entry.status ?? null))}`);
    }
    if (byRevision.has(revision)) {
      return refuse(`helm history has duplicate revision ${revision}`);
    }
    byRevision.set(revision, entry);
  }

  const newest = Math.max(...byRevision.keys());
  const expected = snapshot + 1;
  if (newest !== expected) {
    return refuse(`the newest revision is ${newest}, but this run's upgrade can only have created revision ${expected} (the pre-upgrade newest was ${snapshot}): another writer changed release gambit after the pre-upgrade snapshot`);
  }
  const newestEntry = byRevision.get(newest);
  if (newestEntry.status !== 'deployed') {
    return refuse(`the newest revision ${newest} has status "${newestEntry.status}", not "deployed"`);
  }
  if (newestEntry.description !== marker) {
    return refuse(`the newest revision ${newest} was not written by this run: its description is ${oneLine(JSON.stringify(newestEntry.description ?? null))}, expected this run's marker "${marker}"`);
  }
  if (action === 'rollback' && !byRevision.has(target)) {
    return refuse(`the verified rollback target revision ${target} is no longer in the history`);
  }
  return { ok: true, newestRevision: newest };
}

const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const NAMED_OBJECT = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const ANNOTATED_OBJECT = /^([A-Za-z][A-Za-z0-9]*)\/([a-z0-9]([-a-z0-9.]*[a-z0-9])?)\t(.*)$/;

function lines(text) {
  return text.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '');
}

function listKinds(kinds) {
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds.join('');
}

/**
 * Classifies the namespace inventory taken before an install on confirmed absence.
 *
 * @param {object} evidence
 * @param {string} evidence.release
 * @param {string} evidence.kinds The comma-separated kinds that were queried.
 * @param {number} evidence.apiResourcesExit Exit of `kubectl api-resources --api-group=external-secrets.io -o name`.
 * @param {string | null} evidence.apiResourcesStdout Its stdout.
 * @param {number} evidence.labelExit Exit of `kubectl get <kinds> -l app.kubernetes.io/instance=<release> -o name`.
 * @param {string | null} evidence.labelStdout Its stdout.
 * @param {number} evidence.annotationExit Exit of `kubectl get <kinds> -o jsonpath=<kind/name TAB release-name annotation>`.
 * @param {string | null} evidence.annotationStdout Its stdout.
 * @returns {{state: 'empty' | 'occupied' | 'unknown', objects: string[], reason: string}}
 */
export function classifyOrphanInventory({
  release, kinds, apiResourcesExit, apiResourcesStdout, labelExit, labelStdout, annotationExit, annotationStdout,
}) {
  const unknown = (reason) => ({ state: 'unknown', objects: [], reason });
  if (typeof release !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(release)) {
    return unknown(`invalid release name ${JSON.stringify(release)}`);
  }
  const exitOk = (code) => Number.isInteger(code) && code === 0;
  const readable = (text) => typeof text === 'string';

  if (!exitOk(apiResourcesExit)) {
    return unknown(`'kubectl api-resources --api-group=external-secrets.io' failed (exit ${apiResourcesExit}), so it is unknown whether ExternalSecrets must be inventoried`);
  }
  if (!readable(apiResourcesStdout)) {
    return unknown('the API discovery output is missing and cannot be read');
  }
  const served = lines(apiResourcesStdout).map((line) => line.trim());
  if (served.some((name) => !RESOURCE_NAME.test(name))) {
    return unknown(`the API discovery output cannot be read as resource names: ${oneLine(apiResourcesStdout)}`);
  }
  const expected = [...BASE_INVENTORY_KINDS, ...(served.includes(EXTERNAL_SECRET_RESOURCE) ? [EXTERNAL_SECRET_RESOURCE] : [])];
  if (kinds !== expected.join(',')) {
    return unknown(`the inventory queried kinds ${JSON.stringify(kinds)}, expected ${JSON.stringify(expected.join(','))}`);
  }
  if (!exitOk(labelExit)) {
    return unknown(`listing ${listKinds(expected)} labelled app.kubernetes.io/instance=${release} failed (exit ${labelExit})`);
  }
  if (!exitOk(annotationExit)) {
    return unknown(`listing the meta.helm.sh/release-name annotation of ${listKinds(expected)} failed (exit ${annotationExit})`);
  }
  if (!readable(labelStdout) || !readable(annotationStdout)) {
    return unknown('an inventory output is missing and cannot be read');
  }

  const objects = [];
  for (const line of lines(labelStdout)) {
    if (!NAMED_OBJECT.test(line.trim())) {
      return unknown(`the labelled-object list cannot be read as kind/name lines: ${oneLine(line)}`);
    }
    objects.push(line.trim());
  }
  for (const line of lines(annotationStdout)) {
    const m = ANNOTATED_OBJECT.exec(line.replace(/[\r\n]+$/, ''));
    if (!m) {
      return unknown(`the annotation list cannot be read as kind/name<TAB>release-name lines: ${oneLine(line)}`);
    }
    if (m[4].trim() === release) {
      objects.push(`${m[1]}/${m[2]} (meta.helm.sh/release-name=${release})`);
    }
  }
  if (objects.length > 0) {
    return {
      state: 'occupied',
      objects,
      reason: `${objects.length} object(s) belong to release ${release}: ${objects.join(', ')}`,
    };
  }
  return {
    state: 'empty',
    objects: [],
    reason: `no ${listKinds(expected)} carries app.kubernetes.io/instance=${release} or meta.helm.sh/release-name=${release}`,
  };
}
