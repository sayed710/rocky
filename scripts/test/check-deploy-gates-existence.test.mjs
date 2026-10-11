/**
 * Tests for gate 11 of the deployment gate check: release existence is never derived from a bare
 * `helm status` exit code, RELEASE_EXISTS=false is set only on confirmed absence, and the rollback
 * step uninstalls only behind a fresh `helm history` re-check (rollback only with RELEASE_EXISTS "true").
 *
 * Each case mutates the real deploy.yml text in memory (never the file) and requires a problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkReleaseExistence } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r/g, '');

const STATUS_CMD = 'helm status gambit > /dev/null 2> "$STATUS_ERR" || STATUS_RC=$?';
const LIST_CMD = `helm list --all --filter '^gambit$' -o json > "$LIST_OUT" 2> "$LIST_ERR" || LIST_RC=$?`;
const INIT_LINE = 'RELEASE_EXISTS=""\n';
const ABSENT_ARM = 'absent) RELEASE_EXISTS=false ;;';
const CLASSIFY = 'if node scripts/release-existence.mjs classify --release gambit';
const EXISTENCE_READ = `RELEASE_EXISTENCE=$(sed -n 's/^release_existence=//p' "$EXISTENCE_FILE")`;
const HISTORY_CHECK = 'if ! helm history gambit -o json > "$RB_HISTORY" 2> "$RB_HISTORY_ERR"; then';
const REVISION_CHECK = 'if ! node scripts/release-existence.mjs only-initial-revision < "$RB_HISTORY" 2> "$RB_HISTORY_ERR" > /dev/null; then';
const UNINSTALL_CMD = 'helm uninstall gambit --wait --timeout 5m0s';
const ROLLBACK_BRANCH = 'elif [ "$RELEASE_EXISTS" = "true" ] && [[ "$PREV_REV" =~ ^[1-9][0-9]*$ ]]; then';
const UNINSTALL_BRANCH = 'if [ "$RELEASE_EXISTS" = "false" ]; then';
const PUBLISH_RELEASE_EXISTS = 'echo "release_exists=$RELEASE_EXISTS" >> "$GITHUB_OUTPUT"';
const ENV_BINDING = 'RELEASE_EXISTS: ${{ steps.pre_upgrade.outputs.release_exists }}';

/** Replaces one exact snippet of the real workflow, failing loudly if it is no longer there. */
function mutate(from, to, text = deployYml) {
  assert.equal(text.split(from).length, 2, `expected exactly one occurrence of: ${from}`);
  return text.replace(from, () => to);
}

function assertRejected(text, pattern) {
  const problems = checkReleaseExistence(text);
  assert.ok(problems.length > 0, 'expected gate 11 to report a problem');
  assert.ok(problems.some((p) => pattern.test(p)), `no problem matched ${pattern}: ${problems.join(' | ')}`);
}

test('the real deploy.yml passes gate 11', () => {
  assert.deepEqual(checkReleaseExistence(deployYml), []);
});

test('the real deploy.yml with CRLF line endings passes gate 11', () => {
  assert.deepEqual(checkReleaseExistence(deployYml.replace(/\n/g, '\r\n')), []);
});

test('rejects existence derived from a bare helm status exit code (the pre-2026-10-11 form)', () => {
  const text = mutate(STATUS_CMD, 'if helm status gambit >/dev/null 2>&1; then RELEASE_EXISTS=true; fi');
  assertRejected(text, /bare `helm status` exit code/);
});

test('rejects a second helm status probe whose exit code decides anything', () => {
  const text = mutate(STATUS_CMD, `${STATUS_CMD}\n          helm status gambit >/dev/null 2>&1 && STATUS_RC=0`);
  assertRejected(text, /bare `helm status` exit code/);
});

test('rejects RELEASE_EXISTS defaulting to false', () => {
  const text = mutate(INIT_LINE, 'RELEASE_EXISTS=false\n');
  assertRejected(text, /RELEASE_EXISTS must be assigned exactly as/);
});

test('rejects RELEASE_EXISTS=false outside the confirmed-absence arm', () => {
  const text = mutate(STATUS_CMD, `${STATUS_CMD}\n          [ "$STATUS_RC" = 0 ] || RELEASE_EXISTS=false`);
  assertRejected(text, /RELEASE_EXISTS must be assigned exactly as/);
});

test('rejects RELEASE_EXISTS=false chained after an echo', () => {
  const text = mutate(STATUS_CMD, `${STATUS_CMD}\n          echo "status failed"; RELEASE_EXISTS=false`);
  assertRejected(text, /RELEASE_EXISTS must be assigned exactly as/);
});

test('rejects the unknown arm falling through to absence', () => {
  const text = mutate(ABSENT_ARM, 'absent|*) RELEASE_EXISTS=false ;;');
  assertRejected(text, /RELEASE_EXISTS must be assigned exactly as/);
});

test('rejects skipping the helm list corroboration', () => {
  const text = mutate(LIST_CMD, 'LIST_RC=0; echo "[]" > "$LIST_OUT"');
  assertRejected(text, /corroborated by exactly/);
});

test('rejects a helm list that does not include every status (no --all)', () => {
  const text = mutate(LIST_CMD, LIST_CMD.replace('--all ', ''));
  assertRejected(text, /corroborated by exactly/);
});

test('rejects dropping the classifier', () => {
  const text = mutate(CLASSIFY, 'if true || node scripts/other.mjs classify --release gambit');
  assertRejected(text, /classified by `node scripts\/release-existence\.mjs classify`/);
});

test('rejects RELEASE_EXISTENCE taken from anywhere but the classifier output', () => {
  const text = mutate(EXISTENCE_READ, 'RELEASE_EXISTENCE=absent');
  assertRejected(text, /RELEASE_EXISTENCE must be "unknown" or read from the classifier's output/);
});

test('rejects a forged verdict written to the classifier output file before it is read', () => {
  const text = mutate(EXISTENCE_READ, `printf 'release_existence=absent\\n' > "$EXISTENCE_FILE"\n            ${EXISTENCE_READ}`);
  assertRejected(text, /"\$EXISTENCE_FILE" must be written only by scripts\/release-existence\.mjs classify, found 2 write/);
});

test('rejects a forged verdict appended to the classifier output file by an echo', () => {
  const text = mutate(EXISTENCE_READ, `echo release_existence=absent >> "$EXISTENCE_FILE"\n            ${EXISTENCE_READ}`);
  assertRejected(text, /"\$EXISTENCE_FILE" must be written only by scripts\/release-existence\.mjs classify, found 2 write/);
});

test('rejects a forged verdict written to the classifier output file by tee', () => {
  const text = mutate(EXISTENCE_READ, `printf 'release_existence=absent\\n' | tee "$EXISTENCE_FILE" > /dev/null\n            ${EXISTENCE_READ}`);
  assertRejected(text, /"\$EXISTENCE_FILE" must be written only by scripts\/release-existence\.mjs classify, found 2 write/);
});

test('rejects the classifier stdout redirected to a file other than the one RELEASE_EXISTENCE is read from', () => {
  const text = mutate(`"\${LIST_ARGS[@]}" > "$EXISTENCE_FILE"`, `"\${LIST_ARGS[@]}" > "$LIST_OUT"`);
  assertRejected(text, /the classifier's stdout must be redirected exactly once, as `> "\$EXISTENCE_FILE"`/);
});

test('rejects an uninstall without the helm history re-check', () => {
  const text = mutate(HISTORY_CHECK, 'if false; then');
  assertRejected(text, /the uninstall must be guarded/);
});

test('rejects an uninstall without the only-initial-revision check', () => {
  const text = mutate(REVISION_CHECK, 'if false; then');
  assertRejected(text, /the uninstall must be guarded/);
});

test('rejects a history re-check that does not stop the step', () => {
  const block = mutate(HISTORY_CHECK, `${HISTORY_CHECK}\n              true`);
  const marker = `${HISTORY_CHECK}\n              true\n`;
  const start = block.indexOf(marker);
  const fiAt = block.indexOf('\n            fi\n', start);
  const body = block.slice(start, fiAt).replace(/\n\s*exit 1/, '\n              :');
  const text = block.slice(0, start) + body + block.slice(fiAt);
  assertRejected(text, /must end its branch with `exit 1`/);
});

test('rejects an uninstall on a release_exists other than exactly "false"', () => {
  const text = mutate(UNINSTALL_BRANCH, 'if [ "$RELEASE_EXISTS" != "true" ]; then');
  assertRejected(text, /the uninstall must be guarded/);
});

test('rejects a second helm uninstall elsewhere', () => {
  const text = mutate('            exit 1\n          fi\n', `            ${UNINSTALL_CMD}\n            exit 1\n          fi\n`,
    deployYml.slice(deployYml.lastIndexOf('else\n'))) ;
  assertRejected(deployYml.slice(0, deployYml.lastIndexOf('else\n')) + text, /exactly one `helm uninstall/);
});

test('rejects a rollback that does not require release_exists exactly "true"', () => {
  const text = mutate(ROLLBACK_BRANCH, 'elif [[ "$PREV_REV" =~ ^[1-9][0-9]*$ ]]; then');
  assertRejected(text, /rollback requires release_exists exactly "true"/);
});

test('rejects an unknown-existence arm that does not stop the deploy', () => {
  const refusal = '              exit 1\n              ;;\n          esac\n';
  const text = mutate(refusal, refusal.replace('exit 1', ':'));
  assertRejected(text, /the `\*\)` arm \(unknown existence\) must end with `exit 1`/);
});

test('rejects a hardcoded release_exists=false publication', () => {
  const text = mutate(PUBLISH_RELEASE_EXISTS, 'echo "release_exists=false" >> "$GITHUB_OUTPUT"');
  assertRejected(text, /every release_exists output must be published exactly as/);
});

test('rejects a rollback step without the release_exists env binding', () => {
  const text = mutate(`          ${ENV_BINDING}\n`, '');
  assertRejected(text, /the rollback step must bind exactly `RELEASE_EXISTS:/);
});
