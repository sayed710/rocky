/**
 * Tests for the read forms of the protected evidence files in gates 10 and 11 of the deployment
 * gate check: "$RESOLVED", "$EXISTENCE_FILE", "$INV_VERDICT" and "$MARKER_FILE" may be read only
 * into the exact (variable, key) pairs deploy.yml uses, each exactly once.
 *
 * A generic `VAR=$(sed -n 's/^key=//p' "$FILE")` form would let a read assign into any variable
 * (`GITHUB_OUTPUT=$(sed ... "$RESOLVED")` silently redirects every later `>> "$GITHUB_OUTPUT"`,
 * including the deploy marker, to a file named after the revision) or read another key into a
 * decision variable.
 *
 * Each case mutates the real deploy.yml text in memory (never the file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkReleaseExistence, checkRollbackTarget } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r/g, '');

const read = (variable, key, file) => `${variable}=$(sed -n 's/^${key}=//p' "$${file}")`;
const PREV_REV_READ = read('PREV_REV', 'rollback_revision', 'RESOLVED');
const EXISTENCE_READ = read('RELEASE_EXISTENCE', 'release_existence', 'EXISTENCE_FILE');
const EXISTENCE_REASON_READ = read('EXISTENCE_REASON', 'release_existence_reason', 'EXISTENCE_FILE');
const INVENTORY_READ = read('INVENTORY', 'orphan_inventory', 'INV_VERDICT');
const MARKER_READ = read('DEPLOY_MARKER', 'deploy_marker', 'MARKER_FILE');
const ECHO_READ = `echo "Automatic rollback target: revision $PREV_REV, $(sed -n 's/^rollback_evidence=//p' "$RESOLVED")."`;

/** Both gates the evidence files belong to (10: RESOLVED; 11: the others). */
const gates = (text) => [...checkRollbackTarget(text), ...checkReleaseExistence(text)];

/** Inserts `line` right after the one line whose trimmed text is `anchor`, at the same indentation. */
function insertAfter(anchor, line, text = deployYml) {
  const lines = text.split('\n');
  const at = lines.map((l, i) => (l.trim() === anchor ? i : -1)).filter((i) => i !== -1);
  assert.equal(at.length, 1, `expected exactly one line: ${anchor}`);
  const indent = lines[at[0]].match(/^\s*/)[0];
  lines.splice(at[0] + 1, 0, `${indent}${line}`);
  return lines.join('\n');
}

const referenceRule = (file) => `"$${file}" may only be referenced in its allowed forms [`;

test('the real deploy.yml passes gates 10 and 11 with the pinned evidence reads', () => {
  assert.deepEqual(gates(deployYml), []);
});

test('the real deploy.yml with CRLF line endings passes gates 10 and 11', () => {
  assert.deepEqual(gates(deployYml.replace(/\n/g, '\r\n')), []);
});

// Each rejection must come from the evidence-reference rule, name the offending line and list the
// file's allowed (variable, key) pair(s) — not a generic `VAR=` / `<key>` form.
for (const [file, anchor, inserted, allowedPair] of [
  ['RESOLVED', PREV_REV_READ, read('GITHUB_OUTPUT', 'rollback_revision', 'RESOLVED'), PREV_REV_READ],
  ['MARKER_FILE', MARKER_READ, read('PATH', 'deploy_marker', 'MARKER_FILE'), MARKER_READ],
  ['INV_VERDICT', INVENTORY_READ, read('INVENTORY', 'orphan_inventory_reason', 'INV_VERDICT'), INVENTORY_READ],
  ['EXISTENCE_FILE', EXISTENCE_READ, read('RELEASE_EXISTS', 'release_existence', 'EXISTENCE_FILE'), EXISTENCE_READ],
  ['RESOLVED', ECHO_READ, `echo "x $(sed -n 's/^rollback_revision=//p' "$RESOLVED")"`,
    `echo "...$(sed -n 's/^rollback_evidence=//p' "$RESOLVED")..."`],
]) {
  test(`rejects a read of "$${file}" outside its exact (variable, key) pairs: ${inserted}`, () => {
    const problems = gates(insertAfter(anchor, inserted));
    assert.ok(
      problems.some((p) => p.includes(referenceRule(file)) && p.includes(`offending line(s): [${inserted}]`) && p.includes(allowedPair)),
      `no evidence-reference problem for "$${file}" naming ${inserted} and listing ${allowedPair}: ${problems.join(' | ')}`,
    );
  });
}

// Each allowed pair is counted: repeating one is rejected even for a non-decision variable.
test(`rejects a duplicated allowed read: ${EXISTENCE_REASON_READ}`, () => {
  const problems = gates(insertAfter(EXISTENCE_REASON_READ, EXISTENCE_REASON_READ));
  assert.ok(
    problems.some((p) => p.includes(referenceRule('EXISTENCE_FILE')) && p.includes(`\`${EXISTENCE_REASON_READ}\` must appear exactly once, found 2`)),
    `no count problem for ${EXISTENCE_REASON_READ}: ${problems.join(' | ')}`,
  );
});
