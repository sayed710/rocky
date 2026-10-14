/**
 * Tests for the step-output publications and the producer inputs in gates 10 and 11 of the
 * deployment gate check.
 *
 * $GITHUB_OUTPUT is last-value-wins: a second `prev_revision=` (or `release_exists=`) line appended
 * after the legitimate one silently replaces the verified rollback target, however `$GITHUB_OUTPUT`
 * is spelled (`"${GITHUB_OUTPUT}"`, unquoted) and whatever file is copied into it. Every reference
 * to GITHUB_OUTPUT must therefore be one of deploy.yml's exact publication lines, each once.
 *
 * The release-existence classifier's verdict is only as good as its inputs: `--status-stderr`
 * naming the wrong file, a dropped `"${LIST_ARGS[@]}"` or `--list-exit 0` turns a failed
 * `helm list` into "absent". The classifier and inventory invocations are pinned to their exact
 * lines, and LIST_ARGS, STATUS_RC and LIST_RC to their exact write sites.
 *
 * Each case mutates the real deploy.yml text in memory (never the file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkReleaseExistence, checkRollbackTarget } from '../check-deploy-gates.mjs';

const deployYml = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r/g, '');

/** Both gates (10: rollback target and step outputs; 11: release existence and its producers). */
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

/** Replaces the one occurrence of `from` in deploy.yml with `to`. */
function replaceOnce(from, to) {
  assert.equal(deployYml.split(from).length, 2, `expected exactly one occurrence of: ${from}`);
  return deployYml.replace(from, () => to);
}

const PUBLISH_PREV_REV = 'echo "prev_revision=$PREV_REV" >> "$GITHUB_OUTPUT"';
const PUBLISH_RELEASE_EXISTS = 'echo "release_exists=$RELEASE_EXISTS" >> "$GITHUB_OUTPUT"';
const PUBLISH_REFUSAL = 'echo "rollback_refusal=$ROLLBACK_REFUSAL" >> "$GITHUB_OUTPUT"';
const PUBLISH_RESOLVED = 'cat "$RESOLVED" >> "$GITHUB_OUTPUT"';

const STATUS_CMD = 'helm status gambit > /dev/null 2> "$STATUS_ERR" || STATUS_RC=$?';
const LIST_CMD = `helm list --all --filter '^gambit$' -o json > "$LIST_OUT" 2> "$LIST_ERR" || LIST_RC=$?`;
const LIST_ARGS_BUILD = 'LIST_ARGS=(--list-exit "$LIST_RC" --list-stdout "$LIST_OUT")';
const CLASSIFIER = 'if node scripts/release-existence.mjs classify --release gambit --status-exit "$STATUS_RC" ' +
  '--status-stderr "$STATUS_ERR" "${LIST_ARGS[@]}" > "$EXISTENCE_FILE" 2>> "$LIST_ERR"; then';

const outputRule = '"$GITHUB_OUTPUT" may only be referenced in its allowed forms [';
const referenceRule = (file) => `"$${file}" may only be referenced in its allowed forms [`;
const writeRule = (name) => `${name} may only be written in its allowed forms [`;

/** Asserts some problem contains every one of `parts`. */
function assertProblem(problems, parts) {
  assert.ok(
    problems.some((p) => parts.every((part) => p.includes(part))),
    `no problem containing all of [${parts.join(' ; ')}]: ${problems.join(' | ')}`,
  );
}

test('the real deploy.yml passes gates 10 and 11 with the pinned publications and producer inputs', () => {
  assert.deepEqual(gates(deployYml), []);
});

test('the real deploy.yml with CRLF line endings passes gates 10 and 11', () => {
  assert.deepEqual(gates(deployYml.replace(/\n/g, '\r\n')), []);
});

// Publications: every reference to GITHUB_OUTPUT, in any spelling, must be one exact allowed line.
for (const [anchor, inserted] of [
  [PUBLISH_PREV_REV, 'echo "prev_revision=5" >> "${GITHUB_OUTPUT}"'],
  [PUBLISH_RELEASE_EXISTS, 'echo "release_exists=false" >> $GITHUB_OUTPUT'],
  [PUBLISH_RESOLVED, 'cat "$HISTORY_FILE" >> "$GITHUB_OUTPUT"'],
]) {
  test(`rejects an unlisted step-output publication: ${inserted}`, () => {
    assertProblem(gates(insertAfter(anchor, inserted)), [outputRule, `offending line(s): [${inserted}]`, anchor]);
  });
}

test(`rejects a duplicated allowed publication: ${PUBLISH_REFUSAL}`, () => {
  assertProblem(gates(insertAfter(PUBLISH_REFUSAL, PUBLISH_REFUSAL)), [
    outputRule,
    `\`${PUBLISH_REFUSAL}\` must appear exactly once, found 2`,
  ]);
});

// The classifier invocation is one exact line (its continuation joined).
for (const [from, to] of [
  ['--status-stderr "$STATUS_ERR"', '--status-stderr "$LIST_ERR"'],
  [' "${LIST_ARGS[@]}"', ''],
]) {
  test(`rejects a changed classifier invocation: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`, () => {
    const mutated = CLASSIFIER.replace(from, to);
    assertProblem(gates(replaceOnce(from, to)), [referenceRule('EXISTENCE_FILE'), `offending line(s): [${mutated}]`, CLASSIFIER]);
  });
}

test('rejects --list-exit 0 in the LIST_ARGS array', () => {
  const mutated = LIST_ARGS_BUILD.replace('--list-exit "$LIST_RC"', '--list-exit 0');
  assertProblem(gates(replaceOnce(LIST_ARGS_BUILD, mutated)), [writeRule('LIST_ARGS'), `offending write site line(s): [${mutated}]`, LIST_ARGS_BUILD]);
});

test('rejects an extra STATUS_RC write: STATUS_RC=1', () => {
  assertProblem(gates(insertAfter(STATUS_CMD, 'STATUS_RC=1')), [writeRule('STATUS_RC'), 'offending write site line(s): [STATUS_RC=1]', STATUS_CMD]);
});

test('rejects LIST_RC=0 inserted after the list call', () => {
  assertProblem(gates(insertAfter(LIST_CMD, 'LIST_RC=0')), [writeRule('LIST_RC'), '`LIST_RC=0` must appear exactly 1 time(s), found 2']);
});

test('rejects LIST_ARGS=() inserted after the array build', () => {
  assertProblem(gates(insertAfter(LIST_ARGS_BUILD, 'LIST_ARGS=()')), [writeRule('LIST_ARGS'), '`LIST_ARGS=()` must appear exactly 1 time(s), found 2']);
});

test('rejects a changed inventory classifier input: --label-exit 0', () => {
  const problems = gates(replaceOnce('--label-exit "$INV_LABEL_RC"', '--label-exit 0'));
  assertProblem(problems, [referenceRule('INV_VERDICT'), '--label-exit 0 --label-stdout "$INV_LABELLED"']);
});
