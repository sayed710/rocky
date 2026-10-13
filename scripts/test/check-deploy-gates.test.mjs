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

// Every output-redirection spelling that (over)writes the resolver's output file must be counted, so
// one extra write before PREV_REV is read makes "$RESOLVED" written twice.
for (const write of [
  `printf 'rollback_revision=5\\n' 1> "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' >| "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' 1>> "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' 1>| "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' &> "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' &>> "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' 2> "$RESOLVED" >&2`,
  `printf 'rollback_revision=5\\n' 2>> "$RESOLVED" >&2`,
  `printf 'rollback_revision=5\\n' >& "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' 1<> "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' >"$RESOLVED"`,
  `printf 'rollback_revision=5\\n' > "\${RESOLVED}"`,
  `printf 'rollback_revision=5\\n' > \${RESOLVED}`,
  `printf 'rollback_revision=5\\n' > $RESOLVED`,
  `printf 'rollback_revision=5\\n' 1> $RESOLVED`,
  `printf 'rollback_revision=5\\n' >| \${RESOLVED}`,
  `printf 'rollback_revision=5\\n' | tee "\${RESOLVED}" >/dev/null`,
  `printf 'rollback_revision=5\\n' | tee -a $RESOLVED >/dev/null`,
  // A backslash-newline continuation between the operator and the target.
  `printf 'rollback_revision=5\\n' > \\\n              "$RESOLVED"`,
  `printf 'rollback_revision=5\\n' > \\\r\n              "$RESOLVED"`,
  // Empty quote segments concatenate to the same path.
  `printf 'rollback_revision=5\\n' > "$RESOLVED"''`,
  `printf 'rollback_revision=5\\n' > "$RESOLVED"""`,
  // An apostrophe inside double quotes is a literal, not the start of a single-quoted segment.
  `echo "it's 5" > "$RESOLVED"; sed 's/a/b/' f`,
  `printf "don't" 1> "$RESOLVED" # it's`,
  `echo "it's" >> "$RESOLVED"; x='y'`,
  // Quote forms a quote-state scan misreads: ANSI-C quoting (`\'` does not end $'...') and an
  // apostrophe inside a backtick substitution within double quotes.
  `echo $'it\\'s' > "$RESOLVED"; sed 's/a/b/' /dev/null`,
  `echo "\`printf "it's"\`" > "$RESOLVED"; sed 's/a/b/' /dev/null`,
]) {
  test(`rejects another write to the resolver's output file: ${write.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`, () => {
    const text = mutate(PREV_REV_LINE, `${write}\n              ${PREV_REV_LINE}`);
    assertRejected(text, /"\$RESOLVED" must be written only by scripts\/resolve-rollback-revision\.mjs, found 2 write/);
  });
}

// Writes to other files (a longer variable name, or stderr captured elsewhere) are not writes to it.
for (const other of [
  `printf 'rollback_revision=5\\n' > "$RESOLVED_OLD"`,
  `printf 'rollback_revision=5\\n' 1> $RESOLVED_OLD`,
  `printf 'rollback_revision=5\\n' >| \${RESOLVED_OLD}`,
  `printf 'rollback_revision=5\\n' | tee $RESOLVED_OLD >/dev/null`,
  `sed -n p "$RESOLVED" 2> "$HISTORY_ERR" 2>> "$LIST_ERR"`,
]) {
  test(`does not count a write to another file as a write to the resolver's output: ${other}`, () => {
    assert.deepEqual(checkRollbackTarget(mutate(PREV_REV_LINE, `${other}\n              ${PREV_REV_LINE}`)), []);
  });
}

// Fail-closed: quoting is not parsed, so a redirection mentioned inside a single-quoted literal or an
// inline comment is still counted as a write (a false positive only fails the gate).
for (const literal of [
  `echo 'example: 1> "$RESOLVED" next'`,
  `echo 'example: > $RESOLVED next'`,
]) {
  test(`counts a redirection mentioned in a single-quoted literal (fail-closed): ${literal}`, () => {
    const text = mutate(PREV_REV_LINE, `${literal}\n              ${PREV_REV_LINE}`);
    assertRejected(text, /"\$RESOLVED" must be written only by scripts\/resolve-rollback-revision\.mjs, found 2 write/);
  });
}

test('counts a redirection mentioned in an inline comment (fail-closed): echo x # example: > "$RESOLVED"', () => {
  const text = mutate(PREV_REV_LINE, `echo x # example: > "$RESOLVED"\n              ${PREV_REV_LINE}`);
  assertRejected(text, /"\$RESOLVED" must be written only by scripts\/resolve-rollback-revision\.mjs, found 2 write/);
});

// Allowlist contract: "$RESOLVED" may only be referenced in its allowed forms (the mktemp, the
// resolver's redirect, sed reads and the publication to $GITHUB_OUTPUT). Every other reference fails,
// whatever it is — including the forms a write-pattern scan missed.
const RESOLVED_ALLOWLIST = /"\$RESOLVED" may only be referenced in its allowed forms/;
for (const [label, extra, offending] of [
  // Missed by the write scan: an empty quoted prefix, tee with a redirection before the file, and a
  // name spliced back together by a backslash-newline (bash removes it; it is not a space). The
  // continuation line sits at the run block's indentation, which YAML strips.
  ['an empty quoted prefix', `printf x > ''"$RESOLVED"`, `printf x > ''"$RESOLVED"`],
  ['tee after a redirection', `printf x | tee 2>/dev/null "$RESOLVED"`, `printf x | tee 2>/dev/null "$RESOLVED"`],
  ['a name spliced by a backslash-newline', `printf x > "$RES\\\n          OLVED"`, `printf x > "$RESOLVED"`],
  ['a name spliced by a backslash-CRLF', `printf x > "$RES\\\r\n          OLVED"`, `printf x > "$RESOLVED"`],
  // Not writes by redirection at all, or not writes: still not an allowed form.
  ['an alias', `X="$RESOLVED"`, `X="$RESOLVED"`],
  ['cp onto it', `cp "$HISTORY_FILE" "$RESOLVED"`, `cp "$HISTORY_FILE" "$RESOLVED"`],
  ['sed -i', `sed -i 's/4/5/' "$RESOLVED"`, `sed -i 's/4/5/' "$RESOLVED"`],
  ['an exec fd', `exec 3>"$RESOLVED"`, `exec 3>"$RESOLVED"`],
  ['an indirect name', `v=RESOLVED; printf x > "\${!v}"`, `v=RESOLVED; printf x > "\${!v}"`],
  ['an extra read', `cat "$RESOLVED"`, `cat "$RESOLVED"`],
]) {
  test(`rejects a reference to the resolver's output file outside the allowlist: ${label}`, () => {
    const text = mutate(PREV_REV_LINE, `${extra}\n              ${PREV_REV_LINE}`);
    const problems = checkRollbackTarget(text);
    assert.ok(problems.some((p) => RESOLVED_ALLOWLIST.test(p) && p.includes(offending)),
      `no problem matched ${RESOLVED_ALLOWLIST} naming ${offending}: ${problems.join(' | ')}`);
  });
}

test('the real deploy.yml with CRLF line endings passes gate 10', () => {
  assert.deepEqual(checkRollbackTarget(deployYml.replace(/\r/g, '').replace(/\n/g, '\r\n')), []);
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
