/**
 * Tests for the recovery-safety part of gate 11 of the deployment gate check:
 *
 * - the rollback step runs exactly when post-deploy verification failed
 *   (`if: failure() && steps.smoke_check.outcome == 'failure'`);
 * - the workflow's helm upgrade records this run's marker (`--description "$DEPLOY_MARKER"`), and
 *   the rollback step re-verifies ownership (scripts/recovery-ownership.mjs check) before both the
 *   uninstall and the rollback;
 * - on confirmed absence, the namespace inventory refuses before RELEASE_EXISTS=false;
 * - every `helm history` asks for the explicit --max 256 window.
 *
 * Each case mutates the real deploy.yml text in memory (never the file) and requires a problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkReleaseExistence } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r/g, '');

const IF_LINE = "        if: failure() && steps.smoke_check.outcome == 'failure'\n";
const DESCRIPTION = '            --description "$DEPLOY_MARKER" \\\n';
const UPGRADE_MARKER_GUARD = '          if [ -z "$DEPLOY_MARKER" ]; then\n';
const MARKER_BINDING = 'DEPLOY_MARKER: ${{ steps.pre_upgrade.outputs.deploy_marker }}';
const SNAPSHOT_BINDING = 'SNAPSHOT_NEWEST: ${{ steps.pre_upgrade.outputs.snapshot_newest_revision }}';
const MARKER_READ = `DEPLOY_MARKER=$(sed -n 's/^deploy_marker=//p' "$MARKER_FILE")`;
const PUBLISH_MARKER = 'echo "deploy_marker=$DEPLOY_MARKER" >> "$GITHUB_OUTPUT"';
const PUBLISH_SNAPSHOT = 'echo "snapshot_newest_revision=$SNAPSHOT_NEWEST" >> "$GITHUB_OUTPUT"';
const SNAPSHOT_READ = `SNAPSHOT_NEWEST=$(sed -n 's/^rollback_newest_revision=//p' "$RESOLVED")`;
const ROLLBACK_BRANCH = 'elif [ "$RELEASE_EXISTS" = "true" ] && [[ "$PREV_REV" =~ ^[1-9][0-9]*$ ]]; then';
const RB_HISTORY_CHECK = 'if ! helm history gambit -o json --max 256 > "$RB_HISTORY" 2> "$RB_HISTORY_ERR"; then';
const OWNERSHIP_UNINSTALL = 'if ! node scripts/recovery-ownership.mjs check --action uninstall --snapshot-newest "$SNAPSHOT_NEWEST" --marker "$DEPLOY_MARKER" < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
const OWNERSHIP_ROLLBACK = 'if ! node scripts/recovery-ownership.mjs check --action rollback --snapshot-newest "$SNAPSHOT_NEWEST" --marker "$DEPLOY_MARKER" --target "$PREV_REV" < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
const PRE_HISTORY = 'if ! helm history gambit -o json --max 256 > "$HISTORY_FILE" 2> "$HISTORY_ERR"; then';
const INVENTORY_REFUSAL = '              if [ "$INVENTORY" != "empty" ]; then\n';
const INVENTORY_READ = `INVENTORY=$(sed -n 's/^orphan_inventory=//p' "$INV_VERDICT")`;
const INVENTORY_CLASSIFY = 'if node scripts/recovery-ownership.mjs inventory --release gambit --kinds "$INV_KINDS" \\\n';
const LABEL_QUERY = 'kubectl get "$INV_KINDS" -l app.kubernetes.io/instance=gambit -o name > "$INV_LABELLED" 2>> "$INV_ERR" || INV_LABEL_RC=$?';
const ANNOTATION_QUERY_START = 'kubectl get "$INV_KINDS" -o jsonpath=';
const ABSENT_ASSIGNMENT = '              RELEASE_EXISTS=false\n';

function mutate(from, to, text = deployYml) {
  assert.equal(text.split(from).length, 2, `expected exactly one occurrence of: ${from}`);
  return text.replace(from, () => to);
}
function mutateAfter(anchor, from, to, text = deployYml) {
  assert.equal(text.split(anchor).length, 2, `expected exactly one occurrence of: ${anchor}`);
  const at = text.indexOf(from, text.indexOf(anchor));
  assert.notEqual(at, -1, `expected ${from} after ${anchor}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
/** Deletes the whole line containing `snippet` (which must occur once). */
function dropLine(snippet, text = deployYml) {
  assert.equal(text.split(snippet).length, 2, `expected exactly one occurrence of: ${snippet}`);
  const at = text.indexOf(snippet);
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at) + 1;
  return text.slice(0, start) + text.slice(end);
}
/** Deletes an `if ...; then` guard line through its matching `fi` (inclusive). */
function dropGuard(guardLine, text = deployYml, from = 0) {
  const at = text.indexOf(guardLine, from);
  assert.notEqual(at, -1, `expected ${guardLine}`);
  const start = text.lastIndexOf('\n', at) + 1;
  const indent = text.slice(start, at);
  const fi = text.indexOf(`\n${indent}fi\n`, at);
  assert.notEqual(fi, -1, `expected the fi of ${guardLine}`);
  return text.slice(0, start) + text.slice(fi + indent.length + 4);
}
function assertRejected(text, pattern) {
  const problems = checkReleaseExistence(text);
  assert.ok(problems.length > 0, 'expected gate 11 to report a problem');
  assert.ok(problems.some((p) => pattern.test(p)), `no problem matched ${pattern}: ${problems.join(' | ')}`);
}

test('the real deploy.yml passes gate 11 including the recovery checks', () => {
  assert.deepEqual(checkReleaseExistence(deployYml), []);
});

// --- the rollback step's condition --------------------------------------------------------

for (const [label, replacement] of [
  ['always()', "        if: always()\n"],
  ['false', '        if: false\n'],
  ['failure() alone', '        if: failure()\n'],
  ['success()', "        if: success() && steps.smoke_check.outcome == 'success'\n"],
  ['the smoke check outcome alone', "        if: steps.smoke_check.outcome == 'failure'\n"],
  ['a different step', "        if: failure() && steps.pre_upgrade.outcome == 'failure'\n"],
]) {
  test(`rejects the rollback step's if: replaced by ${label}`, () => {
    assertRejected(mutate(IF_LINE, replacement), /the rollback step's `if:` must be exactly `failure\(\) && steps\.smoke_check\.outcome == 'failure'`/);
  });
}

test("rejects the rollback step's if: removed", () => {
  assertRejected(mutate(IF_LINE, ''), /the rollback step's `if:` must be exactly/);
});

test("rejects a second if: on the rollback step", () => {
  assertRejected(mutate(IF_LINE, `${IF_LINE}        if: always()\n`), /the rollback step's `if:` must be exactly/);
});

test('rejects a smoke check step without id smoke_check', () => {
  assertRejected(mutate('        id: smoke_check\n', '        id: smoke\n'), /smoke_check/);
});

// --- F1: marker and ownership re-check ----------------------------------------------------

test('rejects a helm upgrade without the run marker as --description', () => {
  assertRejected(mutate(DESCRIPTION, ''), /--description "\$DEPLOY_MARKER"/);
});

test('rejects a helm upgrade whose --description is not the marker', () => {
  assertRejected(mutate(DESCRIPTION, '            --description "deploy $VERSION" \\\n'), /--description "\$DEPLOY_MARKER"/);
});

test('rejects an upgrade step that does not refuse an empty marker', () => {
  assertRejected(dropGuard(UPGRADE_MARKER_GUARD.trim()), /refuse an empty DEPLOY_MARKER/);
});

test('rejects an upgrade step without the deploy_marker binding', () => {
  assertRejected(mutateAfter('- name: Pre-flight template validation and Helm upgrade', `          ${MARKER_BINDING}\n`, ''), /must bind exactly `DEPLOY_MARKER:/);
});

test('rejects a marker that is not composed by scripts/recovery-ownership.mjs marker', () => {
  assertRejected(mutate(MARKER_READ, 'DEPLOY_MARKER="gambit-deploy $VERSION"'), /DEPLOY_MARKER must be assigned only/);
});

test('rejects a hardcoded deploy_marker publication', () => {
  assertRejected(mutate(PUBLISH_MARKER, 'echo "deploy_marker=gambit-deploy" >> "$GITHUB_OUTPUT"'), /deploy_marker output must be published exactly/);
});

test('rejects a snapshot newest revision taken from anywhere but the resolver output', () => {
  assertRejected(mutate(SNAPSHOT_READ, 'SNAPSHOT_NEWEST=$(cat "$HISTORY_FILE" | wc -l)'), /SNAPSHOT_NEWEST must be assigned exactly as/);
});

test('rejects a hardcoded snapshot_newest_revision publication', () => {
  assertRejected(mutate(PUBLISH_SNAPSHOT, 'echo "snapshot_newest_revision=1" >> "$GITHUB_OUTPUT"'), /snapshot_newest_revision output must be published exactly/);
});

test('rejects a rollback step without the marker or snapshot bindings', () => {
  const rbStep = '- name: Rollback on post-deploy verification failure';
  assertRejected(mutateAfter(rbStep, `          ${MARKER_BINDING}\n`, ''), /must bind exactly `DEPLOY_MARKER:/);
  assertRejected(mutateAfter(rbStep, `          ${SNAPSHOT_BINDING}\n`, ''), /must bind exactly `SNAPSHOT_NEWEST:/);
});

test('rejects an uninstall without the ownership re-check', () => {
  assertRejected(dropGuard(OWNERSHIP_UNINSTALL), /the uninstall must be guarded/);
});

test('rejects an ownership re-check before the uninstall that does not stop the step', () => {
  assertRejected(mutateAfter(OWNERSHIP_UNINSTALL, '              exit 1\n', '              :\n'), /must end its branch with `exit 1`/);
});

test('rejects a rollback without the ownership re-check', () => {
  assertRejected(dropGuard(OWNERSHIP_ROLLBACK), /the rollback must be guarded/);
});

test('rejects a rollback without the helm history re-read', () => {
  assertRejected(dropGuard(RB_HISTORY_CHECK, deployYml, deployYml.indexOf(ROLLBACK_BRANCH)), /the rollback must be guarded/);
});

test('rejects an ownership re-check before the rollback that does not stop the step', () => {
  assertRejected(mutateAfter(OWNERSHIP_ROLLBACK, '              exit 1\n', '              :\n'), /must end its branch with `exit 1`/);
});

test('rejects an ownership re-check for the rollback that does not name the target', () => {
  assertRejected(mutate(OWNERSHIP_ROLLBACK, OWNERSHIP_ROLLBACK.replace(' --target "$PREV_REV"', '')), /the rollback must be guarded/);
});

test('rejects a rollback moved after the branch closes', () => {
  const text = mutateAfter(ROLLBACK_BRANCH, '            helm rollback gambit "$PREV_REV" --wait --timeout 5m0s\n', '');
  assertRejected(text.replace('          else\n            echo "::error::Post-deploy smoke check failed', '          else\n            helm rollback gambit "$PREV_REV" --wait --timeout 5m0s\n            echo "::error::Post-deploy smoke check failed'), /rollback/);
});

// --- F2: orphan inventory before RELEASE_EXISTS=false --------------------------------------

test('rejects confirmed absence without the inventory classifier', () => {
  assertRejected(mutate(INVENTORY_CLASSIFY, 'if true || node scripts/other.mjs inventory --release gambit --kinds "$INV_KINDS" \\\n'), /namespace inventory/);
});

test('rejects an inventory refusal that does not stop the deploy', () => {
  assertRejected(mutateAfter(INVENTORY_REFUSAL, '                exit 1\n', '                :\n'), /namespace inventory/);
});

test('rejects an inventory whose verdict is not read from the classifier output', () => {
  assertRejected(mutate(INVENTORY_READ, 'INVENTORY=empty'), /INVENTORY must be/);
});

test('rejects RELEASE_EXISTS=false before the inventory', () => {
  const text = mutate(ABSENT_ASSIGNMENT, '').replace('            absent)\n', `            absent)\n${ABSENT_ASSIGNMENT}`);
  assertRejected(text, /namespace inventory|RELEASE_EXISTS=false/);
});

test('rejects dropping the labelled-object query', () => {
  assertRejected(dropLine(LABEL_QUERY), /namespace inventory/);
});

test('rejects dropping the Helm-annotation query', () => {
  assertRejected(dropLine(ANNOTATION_QUERY_START), /namespace inventory/);
});

test('rejects an inventory missing one of the chart kinds', () => {
  assertRejected(mutate(',secrets,ingresses', ',ingresses'), /INV_KINDS/);
});

test('rejects dropping the ExternalSecret discovery', () => {
  assertRejected(dropLine('kubectl api-resources --api-group=external-secrets.io -o name'), /namespace inventory/);
});

// --- F4: explicit history window -----------------------------------------------------------

test('rejects a pre-upgrade helm history without --max 256', () => {
  assertRejected(mutate(PRE_HISTORY, PRE_HISTORY.replace(' --max 256', '')), /--max 256/);
});

test('rejects a helm history with --max 0 (returns nothing in v3.16.3)', () => {
  assertRejected(mutate(PRE_HISTORY, PRE_HISTORY.replace('--max 256', '--max 0')), /--max 256/);
});

test('rejects a rollback-time helm history without --max 256', () => {
  assertRejected(mutateAfter(ROLLBACK_BRANCH, RB_HISTORY_CHECK, RB_HISTORY_CHECK.replace(' --max 256', '')), /--max 256/);
});
