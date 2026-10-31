/**
 * Tests for the decision-variable part of gates 10 and 11 of the deployment gate check: the scalars
 * read from the protected evidence files (PREV_REV, SNAPSHOT_NEWEST, RELEASE_EXISTENCE,
 * RELEASE_EXISTS, INVENTORY and DEPLOY_MARKER) may be WRITTEN only at their allowed sites.
 *
 * The evidence-file allowlist (checkEvidenceReferences) keeps every other writer away from the
 * files, but a shell builtin could still rewrite the variable after its verified read without naming
 * any file (`read -r PREV_REV <<< 5` turns a verified target 4 into 5). Every write site of these
 * names — any bare occurrence of the name, or an assigning expansion `${NAME=`, `${NAME:=`,
 * `${NAME[` — must be one of the allowed lines, each the allowed number of times; reads (`$NAME`,
 * `"$NAME"`, `${NAME}`, `${NAME:-...}`) are unrestricted.
 *
 * Each case mutates the real deploy.yml text in memory (never the file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkReleaseExistence, checkRollbackTarget } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r/g, '');

const PREV_REV_READ = `PREV_REV=$(sed -n 's/^rollback_revision=//p' "$RESOLVED")`;
const SNAPSHOT_READ = `SNAPSHOT_NEWEST=$(sed -n 's/^rollback_newest_revision=//p' "$RESOLVED")`;
const EXISTENCE_READ = `RELEASE_EXISTENCE=$(sed -n 's/^release_existence=//p' "$EXISTENCE_FILE")`;
const INVENTORY_READ = `INVENTORY=$(sed -n 's/^orphan_inventory=//p' "$INV_VERDICT")`;
const MARKER_READ = `DEPLOY_MARKER=$(sed -n 's/^deploy_marker=//p' "$MARKER_FILE")`;
// RELEASE_EXISTS has no read: its last write before the rollback target is resolved is the case
// arm, so the rewrite goes right after `PREV_REV=""`, the first line after the case.
const AFTER_EXISTS = 'PREV_REV=""';

/** Both gates the decision variables belong to (10: PREV_REV; 11: the others). */
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

const writeRule = (name) => new RegExp(`decision variable ${name} may only be written in its allowed forms`);

function assertWriteRejected(text, name, offending) {
  const problems = gates(text);
  assert.ok(problems.some((p) => writeRule(name).test(p) && p.includes(offending)),
    `no problem matched ${writeRule(name)} naming ${offending}: ${problems.join(' | ')}`);
}

test('the real deploy.yml passes gates 10 and 11 with the decision-variable rule', () => {
  assert.deepEqual(gates(deployYml), []);
});

test('the real deploy.yml with CRLF line endings passes gates 10 and 11', () => {
  assert.deepEqual(gates(deployYml.replace(/\n/g, '\r\n')), []);
});

// A builtin rewrite right after the verified read (or the last allowed write) names no evidence file,
// so only the write-site allowlist catches it.
for (const [name, anchor, rewrite] of [
  ['PREV_REV', PREV_REV_READ, 'read -r PREV_REV <<< 5'],
  ['PREV_REV', PREV_REV_READ, `printf -v PREV_REV '%s' 5`],
  ['INVENTORY', INVENTORY_READ, 'read -r INVENTORY <<< empty'],
  ['INVENTORY', INVENTORY_READ, 'printf -v INVENTORY %s empty'],
  ['RELEASE_EXISTENCE', EXISTENCE_READ, 'read -r RELEASE_EXISTENCE <<< absent'],
  ['PREV_REV', PREV_REV_READ, ': "${PREV_REV:=5}"'],
  ['PREV_REV', PREV_REV_READ, 'declare PREV_REV=5'],
  ['RELEASE_EXISTS', AFTER_EXISTS, 'export RELEASE_EXISTS=false'],
  ['SNAPSHOT_NEWEST', SNAPSHOT_READ, 'let SNAPSHOT_NEWEST=3'],
  ['DEPLOY_MARKER', MARKER_READ, 'DEPLOY_MARKER=x'],
  ['INVENTORY', INVENTORY_READ, 'eval "INVENTORY=empty"'],
  ['RELEASE_EXISTENCE', EXISTENCE_READ, 'unset RELEASE_EXISTENCE'],
  // More write sites of the same kinds: an assigning expansion without the colon, a subscript
  // write, an arithmetic assignment, mapfile, a nameref and a name spliced with empty quotes.
  ['PREV_REV', PREV_REV_READ, ': "${PREV_REV=5}"'],
  ['PREV_REV', PREV_REV_READ, ': "${PREV_REV[0]:=5}"'],
  ['SNAPSHOT_NEWEST', SNAPSHOT_READ, '(( SNAPSHOT_NEWEST = 3 ))'],
  ['DEPLOY_MARKER', MARKER_READ, 'mapfile -t DEPLOY_MARKER < /dev/null'],
  ['PREV_REV', PREV_REV_READ, 'declare -n ref=PREV_REV; ref=5'],
  ['PREV_REV', PREV_REV_READ, 'read -r PREV""_REV <<< 5'],
]) {
  test(`rejects a write of ${name} outside its allowed forms: ${rewrite}`, () => {
    assertWriteRejected(insertAfter(anchor, rewrite), name, rewrite);
  });
}

// Each allowed form is also counted: repeating one after the verified read is rejected too.
for (const [name, anchor, repeat] of [
  ['PREV_REV', PREV_REV_READ, 'PREV_REV=""'],
  ['RELEASE_EXISTENCE', EXISTENCE_READ, 'RELEASE_EXISTENCE=unknown'],
]) {
  test(`rejects a repeated allowed form of ${name}: ${repeat}`, () => {
    const problems = gates(insertAfter(anchor, repeat));
    assert.ok(problems.some((p) => writeRule(name).test(p) && p.includes(`\`${repeat}\` must appear exactly 1 time(s), found 2`)),
      `no count problem for ${repeat}: ${problems.join(' | ')}`);
  });
}

// Controls: reads are not write sites, whatever their spelling.
for (const [anchor, read] of [
  [PREV_REV_READ, 'echo "$PREV_REV ${INVENTORY:-none}"'],
  [PREV_REV_READ, 'if [ -n "${RELEASE_EXISTENCE}" ] && [ "$RELEASE_EXISTS" = true ]; then echo "${SNAPSHOT_NEWEST:+x}${DEPLOY_MARKER:-}"; fi'],
  [INVENTORY_READ, 'echo "inventory=$INVENTORY prev=${PREV_REV:-<none>}"'],
]) {
  test(`does not count a read as a write site: ${read}`, () => {
    assert.deepEqual(gates(insertAfter(anchor, read)), []);
  });
}
