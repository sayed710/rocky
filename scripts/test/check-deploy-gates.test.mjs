/**
 * Tests for gate 10 of the deployment gate check: the automatic rollback targets only the revision
 * scripts/resolve-rollback-revision.mjs verified, read from the file the resolver wrote.
 *
 * Each case mutates the real deploy.yml text in memory (never the file) and requires a problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkRollbackTarget } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

const PREV_REV_LINE = `PREV_REV=$(sed -n 's/^rollback_revision=//p' "$RESOLVED")`;
const RESOLVER_CALL = 'elif node scripts/resolve-rollback-revision.mjs < "$HISTORY_FILE" > "$RESOLVED" 2> "$HISTORY_ERR"; then';
const PUBLISH_LINE = 'echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"';
const ROLLBACK_CMD = 'helm rollback gambit "$PREV_REV" --wait --timeout 5m0s';

/** Replaces one exact snippet of the real workflow, failing loudly if it is no longer there. */
function mutate(from, to) {
  assert.equal(deployYml.split(from).length, 2, `expected exactly one occurrence of: ${from}`);
  return deployYml.replace(from, () => to);
}

function assertRejected(text, pattern) {
  const problems = checkRollbackTarget(text);
  assert.ok(problems.length > 0, 'expected gate 10 to report a problem');
  assert.ok(problems.some((p) => pattern.test(p)), `no problem matched ${pattern}: ${problems.join(' | ')}`);
}

test('the real deploy.yml passes gate 10', () => {
  assert.deepEqual(checkRollbackTarget(deployYml), []);
});

test('rejects PREV_REV read from a hardcoded here-string', () => {
  const text = mutate(PREV_REV_LINE, `PREV_REV=$(sed -n 's/^rollback_revision=//p' <<< 'rollback_revision=5')`);
  assertRejected(text, /PREV_REV must be empty or the rollback_revision read from the resolver's output file/);
});

test("rejects a sed reading a file other than the resolver's output", () => {
  const text = mutate(PREV_REV_LINE, `PREV_REV=$(sed -n 's/^rollback_revision=//p' "$HISTORY_FILE")`);
  assertRejected(text, /PREV_REV must be empty or the rollback_revision read from the resolver's output file/);
});

test("rejects another write to the resolver's output file", () => {
  const text = mutate(PREV_REV_LINE, `echo rollback_revision=5 > "$RESOLVED"\n              ${PREV_REV_LINE}`);
  assertRejected(text, /"\$RESOLVED" must be written only by scripts\/resolve-rollback-revision\.mjs/);
});

test("rejects a tee write to the resolver's output file", () => {
  const text = mutate(PREV_REV_LINE, `printf 'rollback_revision=5\\n' | tee "$RESOLVED" >/dev/null\n              ${PREV_REV_LINE}`);
  assertRejected(text, /"\$RESOLVED" must be written only by scripts\/resolve-rollback-revision\.mjs/);
});

test('rejects publishing a prev_revision output other than $PREV_REV', () => {
  const text = mutate(PUBLISH_LINE, 'echo "prev_revision=$NEWEST_REV" >> "$GITHUB_OUTPUT"');
  assertRejected(text, /every prev_revision output must be published exactly as/);
});

test('rejects a PREV_REV assignment chained after an echo', () => {
  const text = mutate(PREV_REV_LINE, `echo "target selected"; PREV_REV=5\n              ${PREV_REV_LINE}`);
  assertRejected(text, /PREV_REV must be empty or the rollback_revision read from the resolver's output file/);
});

test('rejects PREV_REV selected from helm history with inline node -e', () => {
  const text = mutate(
    PREV_REV_LINE,
    `PREV_REV=$(helm history gambit -o json | node -e 'const h=JSON.parse(require("fs").readFileSync(0));console.log(h[h.length-1].revision)')`,
  );
  assertRejected(text, /inline JavaScript/);
  assertRejected(text, /PREV_REV must be empty/);
});

test('rejects a helm rollback that does not target "$PREV_REV"', () => {
  const text = mutate(ROLLBACK_CMD, 'helm rollback gambit 0 --wait --timeout 5m0s');
  assertRejected(text, /every helm rollback must target "\$PREV_REV"/);
});

test('rejects a workflow without the resolver call', () => {
  const text = mutate(RESOLVER_CALL, 'elif true; then');
  assertRejected(text, /not resolved by scripts\/resolve-rollback-revision\.mjs/);
  assertRejected(text, /PREV_REV must be empty/);
});
