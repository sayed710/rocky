/**
 * Tests for scripts/lib/recovery-ownership.mjs and its CLI scripts/recovery-ownership.mjs:
 *
 * - the per-run Helm revision marker (`helm upgrade --install --description`);
 * - the ownership re-check the rollback step runs before `helm uninstall` / `helm rollback`
 *   (the newest revision must be exactly the one this run's upgrade created);
 * - the orphan inventory pre_upgrade runs before an install on confirmed absence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BASE_INVENTORY_KINDS,
  EXTERNAL_SECRET_RESOURCE,
  checkRecoveryOwnership,
  classifyOrphanInventory,
  composeDeployMarker,
} from '../lib/recovery-ownership.mjs';

const CLI = 'scripts/recovery-ownership.mjs';
const MARKER = 'gambit-deploy 4242-1 1.2.3';
const BASE_KINDS = 'deployments.apps,statefulsets.apps,services,configmaps,secrets,ingresses.networking.k8s.io,networkpolicies.networking.k8s.io';

function entry(revision, status, description = `revision ${revision}`) {
  return { revision, updated: '2026-10-11T10:00:00Z', status, chart: 'gambit-0.1.0', app_version: '1.2.3', description };
}
/** History after this run's successful upgrade over pre-upgrade newest revision 2 (target 2). */
const ours = () => [entry(1, 'superseded'), entry(2, 'superseded'), entry(3, 'deployed', MARKER)];
const rollback = (history, extra = {}) =>
  checkRecoveryOwnership({ history, action: 'rollback', snapshotNewest: 2, marker: MARKER, targetRevision: 2, ...extra });
const uninstall = (history, extra = {}) =>
  checkRecoveryOwnership({ history, action: 'uninstall', snapshotNewest: 0, marker: MARKER, ...extra });

function refused(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal, got ${JSON.stringify(result)}`);
  assert.match(result.reason, pattern, label);
}

// --- marker -------------------------------------------------------------------------------

test('the marker names the run, the attempt and the version on one line', () => {
  assert.equal(composeDeployMarker({ runId: '4242', runAttempt: '1', version: '1.2.3' }), MARKER);
  assert.equal(composeDeployMarker({ runId: '9876543210', runAttempt: '3', version: '1.2.3-beta.1' }), 'gambit-deploy 9876543210-3 1.2.3-beta.1');
});

test('the marker refuses anything that is not a run id, an attempt and a semver version', () => {
  for (const [runId, runAttempt, version] of [
    ['', '1', '1.2.3'], ['4242', '', '1.2.3'], ['4242', '1', ''], ['abc', '1', '1.2.3'], ['4242', '0', '1.2.3'],
    ['04242', '1', '1.2.3'], ['4242', '1', 'v1.2.3'], ['4242', '1', '1.2.3\n::error::x'], ['4242', '1', '1.2.3 x'],
    ['4242', '1', '1.2'], [undefined, '1', '1.2.3'], ['4242', '1', '1.2.3"'],
  ]) {
    assert.throws(() => composeDeployMarker({ runId, runAttempt, version }), /marker/, JSON.stringify([runId, runAttempt, version]));
  }
});

// --- ownership re-check -------------------------------------------------------------------

test('rollback is allowed only when the newest revision is this run\'s deployed N+1 and the target is still there', () => {
  assert.deepEqual(rollback(ours()), { ok: true, newestRevision: 3 });
  // Order and digit strings do not matter.
  assert.deepEqual(rollback([entry('3', 'deployed', MARKER), entry('2', 'superseded')]), { ok: true, newestRevision: 3 });
});

test('S4a: an operator upgrade between the snapshot and this run\'s upgrade is refused', () => {
  const h = [entry(1, 'superseded'), entry(2, 'superseded'), entry(3, 'superseded', 'Upgrade complete'), entry(4, 'deployed', MARKER)];
  refused(rollback(h), /newest revision is 4, but this run's upgrade can only have created revision 3 \(the pre-upgrade newest was 2\).*another writer/, 'S4a');
});

test('S4b: an operator upgrade after this run\'s upgrade is refused', () => {
  const h = [entry(1, 'superseded'), entry(2, 'superseded'), entry(3, 'superseded', MARKER), entry(4, 'deployed', 'Upgrade complete')];
  refused(rollback(h), /newest revision is 4, but this run's upgrade can only have created revision 3.*another writer/, 'S4b');
});

test('a newest revision N+1 written by someone else is refused', () => {
  const h = [entry(1, 'superseded'), entry(2, 'superseded'), entry(3, 'deployed', 'Upgrade complete')];
  refused(rollback(h), /newest revision 3 was not written by this run: its description is "Upgrade complete", expected this run's marker "gambit-deploy 4242-1 1\.2\.3"/, 'foreign N+1');
  // A marker of another run, or of another attempt of this run, is not this run's.
  refused(rollback([entry(2, 'superseded'), entry(3, 'deployed', 'gambit-deploy 4242-2 1.2.3')]), /not written by this run/, 'other attempt');
  refused(rollback([entry(2, 'superseded'), entry(3, 'deployed', `${MARKER} `)]), /not written by this run/, 'padded');
  refused(rollback([entry(2, 'superseded'), { revision: 3, status: 'deployed' }]), /not written by this run/, 'no description');
});

test('a newest revision with this run\'s marker that is not deployed is refused', () => {
  for (const status of ['failed', 'pending-upgrade', 'pending-rollback', 'superseded', 'uninstalled', 'unknown']) {
    refused(rollback([entry(2, 'superseded'), entry(3, status, MARKER)]), new RegExp(`newest revision 3 has status "${status}", not "deployed"`), status);
  }
});

test('the verified rollback target must still be in the history', () => {
  refused(rollback([entry(3, 'deployed', MARKER)]), /verified rollback target revision 2 is no longer in the history/, 'pruned');
  refused(rollback(ours(), { targetRevision: 3 }), /target revision 3 is not below/, 'target is newest');
  refused(rollback(ours(), { targetRevision: 0 }), /target/, 'target 0');
  refused(rollback(ours(), { targetRevision: undefined }), /target/, 'no target');
});

test('the uninstall re-check: revision 1 only, deployed, with this run\'s marker', () => {
  assert.deepEqual(uninstall([entry(1, 'deployed', MARKER)]), { ok: true, newestRevision: 1 });
  refused(uninstall([entry(1, 'deployed', 'Install complete')]), /not written by this run/, 'reinstalled revision 1 by another writer');
  refused(uninstall([entry(1, 'failed', MARKER)]), /not "deployed"/, 'failed install');
  refused(uninstall([entry(1, 'superseded', MARKER), entry(2, 'deployed', 'Upgrade complete')]), /newest revision is 2, but this run's upgrade can only have created revision 1/, 'S4c');
  refused(uninstall([entry(1, 'deployed', MARKER)], { snapshotNewest: 2 }), /uninstall.*pre-upgrade newest revision 0/, 'uninstall after an existing release');
  refused(uninstall([entry(1, 'deployed', MARKER)], { targetRevision: 1 }), /uninstall takes no target/, 'uninstall with a target');
});

test('malformed input never verifies ownership', () => {
  for (const [label, history] of [
    ['not an array', {}], ['null', null], ['empty', []], ['null entry', [null, entry(3, 'deployed', MARKER)]],
    ['bad revision', [entry('x', 'superseded'), entry(3, 'deployed', MARKER)]], ['leading zero', [entry('03', 'deployed', MARKER)]],
    ['duplicate', [entry(2, 'superseded'), entry(3, 'deployed', MARKER), entry(3, 'failed')]],
    ['unknown status', [entry(2, 'superseded'), entry(3, 'exploded', MARKER)]],
  ]) {
    assert.equal(rollback(history).ok, false, label);
  }
  for (const [label, extra] of [
    ['empty marker', { marker: '' }], ['bad marker', { marker: 'Upgrade complete' }], ['undefined marker', { marker: undefined }],
    ['empty snapshot', { snapshotNewest: '' }], ['negative snapshot', { snapshotNewest: -1 }], ['string snapshot', { snapshotNewest: 'x' }],
    ['rollback over snapshot 0', { snapshotNewest: 0 }], ['bad action', { action: 'delete' }], ['target above snapshot', { targetRevision: 5 }],
  ]) {
    assert.equal(rollback(ours(), extra).ok, false, label);
  }
});

test('a re-read history that fills the --max 256 window is refused', () => {
  const full = Array.from({ length: 255 }, (_, i) => entry(i + 1, 'superseded'));
  full.push(entry(256, 'deployed', MARKER));
  refused(rollback(full, { snapshotNewest: 255, targetRevision: 255 }), /returned 256 revisions, which fills the --max 256 window/, 'saturated');
  const below = full.slice(1);
  assert.deepEqual(rollback(below, { snapshotNewest: 255, targetRevision: 255 }), { ok: true, newestRevision: 256 });
});

// --- orphan inventory ---------------------------------------------------------------------

const inventory = (extra = {}) => classifyOrphanInventory({
  release: 'gambit', kinds: BASE_KINDS,
  apiResourcesExit: 0, apiResourcesStdout: '',
  labelExit: 0, labelStdout: '', annotationExit: 0, annotationStdout: '',
  ...extra,
});

test('the inventory kinds are the kinds the chart renders', () => {
  assert.equal(BASE_INVENTORY_KINDS.join(','), BASE_KINDS);
  assert.equal(EXTERNAL_SECRET_RESOURCE, 'externalsecrets.external-secrets.io');
});

test('an empty namespace is empty', () => {
  assert.deepEqual(inventory(), { state: 'empty', objects: [], reason: 'no deployments.apps, statefulsets.apps, services, configmaps, secrets, ingresses.networking.k8s.io or networkpolicies.networking.k8s.io carries app.kubernetes.io/instance=gambit or meta.helm.sh/release-name=gambit' });
  // Objects of other releases do not count.
  const other = inventory({ annotationStdout: 'ConfigMap/other-cfg\tother\nSecret/plain\t\n' });
  assert.equal(other.state, 'empty');
  // kubectl's "No resources found" goes to stderr; whitespace-only stdout is empty.
  assert.equal(inventory({ labelStdout: '\n', annotationStdout: '\r\n' }).state, 'empty');
});

test('S5a: labelled or Helm-annotated objects of the release are occupied, named one by one', () => {
  const r = inventory({
    labelStdout: 'deployment.apps/gambit-api\nservice/gambit-api\n',
    annotationStdout: 'Deployment/gambit-api\tgambit\nService/gambit-api\tgambit\nConfigMap/unrelated\tother\n',
  });
  assert.equal(r.state, 'occupied');
  assert.deepEqual(r.objects, ['deployment.apps/gambit-api', 'service/gambit-api', 'Deployment/gambit-api (meta.helm.sh/release-name=gambit)', 'Service/gambit-api (meta.helm.sh/release-name=gambit)']);
  assert.match(r.reason, /4 object\(s\) belong to release gambit: deployment\.apps\/gambit-api, service\/gambit-api, Deployment\/gambit-api/);
  // Annotation alone (Helm adopts on the annotation + managed-by label, whatever the instance label).
  const annotated = inventory({ annotationStdout: 'ConfigMap/renamed\tgambit\n' });
  assert.equal(annotated.state, 'occupied');
  assert.deepEqual(annotated.objects, ['ConfigMap/renamed (meta.helm.sh/release-name=gambit)']);
  // Label alone (S5c-style objects created without Helm annotations still belong to the release).
  assert.equal(inventory({ labelStdout: 'configmap/gambit-gambit-config\n' }).state, 'occupied');
});

test('any kubectl failure, or output that cannot be read exactly, is unknown', () => {
  for (const [label, extra, pattern] of [
    ['api-resources fails', { apiResourcesExit: 1 }, /api-resources.*exit 1/],
    ['label query fails', { labelExit: 1 }, /instance=gambit.*exit 1/],
    ['annotation query fails', { annotationExit: 1 }, /release-name.*exit 1/],
    ['bad exit code', { labelExit: -1 }, /exit/],
    ['label output not names', { labelStdout: 'NAME READY\ngambit-api 1/1\n' }, /cannot be read/],
    ['annotation output not kind/name<TAB>value', { annotationStdout: 'gambit-api gambit\n' }, /cannot be read/],
    ['api-resources output garbage', { apiResourcesStdout: 'NAME SHORTNAMES\n' }, /cannot be read/],
    ['missing stdout', { labelStdout: null }, /cannot be read|missing/],
  ]) {
    const r = inventory(extra);
    assert.equal(r.state, 'unknown', label);
    assert.match(r.reason, pattern, label);
  }
});

test('ExternalSecret is inventoried exactly when its API is served', () => {
  const served = { apiResourcesStdout: `${EXTERNAL_SECRET_RESOURCE}\nsecretstores.external-secrets.io\n` };
  // Served but not queried: the inventory would miss ExternalSecrets.
  const missed = inventory(served);
  assert.equal(missed.state, 'unknown');
  assert.match(missed.reason, /queried kinds .* expected .*externalsecrets\.external-secrets\.io/);
  // Served and queried.
  assert.equal(inventory({ ...served, kinds: `${BASE_KINDS},${EXTERNAL_SECRET_RESOURCE}` }).state, 'empty');
  const es = inventory({ ...served, kinds: `${BASE_KINDS},${EXTERNAL_SECRET_RESOURCE}`, labelStdout: 'externalsecret.external-secrets.io/gambit-gambit-secret\n' });
  assert.equal(es.state, 'occupied');
  // Queried but not served: kubectl would fail; the kinds must match discovery exactly.
  assert.equal(inventory({ kinds: `${BASE_KINDS},${EXTERNAL_SECRET_RESOURCE}` }).state, 'unknown');
  // A kind list missing one of the chart's kinds is never an inventory.
  assert.equal(inventory({ kinds: BASE_KINDS.replace(',secrets', '') }).state, 'unknown');
});

// --- CLI ----------------------------------------------------------------------------------

function withFiles(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-ownership-'));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], content);
    }
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

test('CLI marker prints deploy_marker and fails closed on bad input', () => {
  const ok = run(['marker', '--run-id', '4242', '--run-attempt', '1', '--version', '1.2.3']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `deploy_marker=${MARKER}\n`);
  const bad = run(['marker', '--run-id', '', '--run-attempt', '1', '--version', '1.2.3']);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^recovery-ownership: [^\n]+\n$/);
  assert.equal(run(['marker', '--run-id', '4242']).status, 2);
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run([]).status, 2);
});

test('CLI check verifies ownership or exits 1 with the reason', () => {
  const args = ['check', '--action', 'rollback', '--snapshot-newest', '2', '--marker', MARKER, '--target', '2'];
  const ok = run(args, JSON.stringify(ours()));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'recovery_ownership=verified\nrecovery_newest_revision=3\n');
  for (const input of ['', 'Error: release: not found', JSON.stringify([entry(2, 'superseded'), entry(3, 'deployed', 'Upgrade complete')])]) {
    const bad = run(args, input);
    assert.equal(bad.status, 1, input);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^recovery-ownership: [^\n]+\n$/);
  }
  const un = run(['check', '--action', 'uninstall', '--snapshot-newest', '0', '--marker', MARKER], JSON.stringify([entry(1, 'deployed', MARKER)]));
  assert.equal(un.status, 0, un.stderr);
  // An empty --snapshot-newest / --marker (an unpublished step output) is a refusal, not a usage error.
  assert.equal(run(['check', '--action', 'rollback', '--snapshot-newest', '', '--marker', MARKER, '--target', '2'], JSON.stringify(ours())).status, 1);
  assert.equal(run(['check', '--action', 'rollback', '--snapshot-newest', '2', '--marker', '', '--target', '2'], JSON.stringify(ours())).status, 1);
  assert.equal(run(['check', '--action', 'rollback', '--bogus', 'x'], '[]').status, 2);
});

test('CLI inventory prints the state, the objects and a single-line reason', () => {
  const r = withFiles({ api: '', label: 'deployment.apps/gambit-api\n', annotation: 'Deployment/gambit-api\tgambit\n' }, (p) =>
    run(['inventory', '--release', 'gambit', '--kinds', BASE_KINDS, '--api-exit', '0', '--api-stdout', p.api,
      '--label-exit', '0', '--label-stdout', p.label, '--annotation-exit', '0', '--annotation-stdout', p.annotation]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^orphan_inventory=occupied\norphan_inventory_objects=deployment\.apps\/gambit-api, Deployment\/gambit-api \(meta\.helm\.sh\/release-name=gambit\)\norphan_inventory_reason=[^\n]+\n$/);
  const empty = withFiles({ api: '', label: '', annotation: '' }, (p) =>
    run(['inventory', '--release', 'gambit', '--kinds', BASE_KINDS, '--api-exit', '0', '--api-stdout', p.api,
      '--label-exit', '0', '--label-stdout', p.label, '--annotation-exit', '0', '--annotation-stdout', p.annotation]));
  assert.match(empty.stdout, /^orphan_inventory=empty\n/);
  const failing = withFiles({ api: '', label: '', annotation: '' }, (p) =>
    run(['inventory', '--release', 'gambit', '--kinds', BASE_KINDS, '--api-exit', '0', '--api-stdout', p.api,
      '--label-exit', '1', '--label-stdout', p.label, '--annotation-exit', '0', '--annotation-stdout', p.annotation]));
  assert.match(failing.stdout, /^orphan_inventory=unknown\n/);
  assert.equal(run(['inventory', '--release', 'gambit']).status, 2);
});
