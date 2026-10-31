import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  HELM_STATUSES,
  RollbackRevisionError,
  formatRollbackOutput,
  resolveRollbackRevision,
} from '../lib/rollback-revision.mjs';

const CLI = 'scripts/resolve-rollback-revision.mjs';

/** `helm history -o json` entries, as Helm prints them. */
function entry(revision, status, extra = {}) {
  return {
    revision,
    updated: '2026-10-11T10:00:00Z',
    status,
    chart: 'gambit-0.1.0',
    app_version: `1.0.${typeof revision === 'number' ? revision : 0}`,
    description: `revision ${revision}`,
    ...extra,
  };
}
const history = (...pairs) => pairs.map(([revision, status]) => entry(revision, status));

test('a healthy history rolls back to its deployed revision, with traceable evidence', () => {
  assert.deepEqual(resolveRollbackRevision(history([3, 'superseded'], [4, 'deployed'])), {
    revision: 4,
    status: 'deployed',
    chart: 'gambit-0.1.0',
    appVersion: '1.0.4',
    description: 'revision 4',
    updated: '2026-10-11T10:00:00Z',
    newestRevision: 4,
  });
});

test('failed revisions above the deployed one are skipped, never targeted', () => {
  const target = resolveRollbackRevision(history([3, 'superseded'], [4, 'deployed'], [5, 'failed']));
  assert.equal(target.revision, 4);
  assert.equal(target.newestRevision, 5);
  assert.equal(resolveRollbackRevision(history([2, 'superseded'], [3, 'deployed'], [4, 'failed'], [5, 'failed'])).revision, 3);
});

test('an atomic recovery is the deployed revision', () => {
  const recovered = [entry(4, 'superseded'), entry(5, 'failed'), entry(6, 'deployed', { description: 'Rollback to 4' })];
  const target = resolveRollbackRevision(recovered);
  assert.equal(target.revision, 6);
  assert.equal(target.description, 'Rollback to 4');
});

test('statuses other than pending-* below the deployed revision are allowed', () => {
  assert.equal(resolveRollbackRevision(history(
    [1, 'failed'], [2, 'unknown'], [3, 'uninstalled'], [4, 'superseded'], [5, 'deployed'], [6, 'failed'],
  )).revision, 5);
});

test('order does not matter, only revision numbers', () => {
  assert.equal(resolveRollbackRevision(history([5, 'failed'], [4, 'deployed'], [3, 'superseded'])).revision, 4);
});

test('canonical digit-string revisions are accepted', () => {
  assert.equal(resolveRollbackRevision(history(['3', 'superseded'], ['4', 'deployed'], ['5', 'failed'])).revision, 4);
});

test('anything that does not prove a single safe target is refused, with the reason', () => {
  const cases = [
    ['not an array', {}, /not a JSON array/],
    ['null', null, /not a JSON array/],
    ['empty', [], /empty/],
    ['null entry', [null, entry(4, 'deployed')], /entry #0 is not an object/],
    ['array entry', [[4, 'deployed']], /entry #0 is not an object/],
    ['revision 0', history([0, 'deployed']), /invalid revision 0/],
    ['revision 0 above', history([4, 'deployed'], [0, 'failed']), /invalid revision 0/],
    ['negative', history([-4, 'deployed']), /invalid revision -4/],
    ['fraction', history([4.5, 'deployed']), /invalid revision 4.5/],
    ['unsafe integer', history([2 ** 53, 'deployed']), /invalid revision/],
    ['unsafe string', history(['9007199254740993', 'deployed']), /invalid revision/],
    ['leading zero', history([4, 'superseded'], ['05', 'deployed']), /invalid revision "05"/],
    ['string zero', history(['0', 'deployed']), /invalid revision "0"/],
    ['non-numeric', history(['x', 'deployed']), /invalid revision "x"/],
    ['signed string', history(['+4', 'deployed']), /invalid revision/],
    ['missing revision', [{ status: 'superseded' }, entry(4, 'deployed')], /invalid revision undefined/],
    ['malformed below', history(['x', 'superseded'], [4, 'deployed']), /entry #0 has an invalid revision/],
    ['unknown status', history([4, 'deployed'], [5, 'exploded']), /unknown status "exploded"/],
    ['non-string status', [entry(4, 'deployed'), { revision: 5, status: 1 }], /unknown status 1/],
    ['missing status', [entry(4, 'deployed'), { revision: 5 }], /unknown status/],
    ['wrong-case status', history([4, 'Deployed']), /unknown status "Deployed"/],
    ['duplicate revision', history([3, 'superseded'], [4, 'deployed'], [4, 'failed']), /duplicate revision 4/],
    ['duplicate string/number', history([4, 'deployed'], ['4', 'failed']), /duplicate revision 4/],
    ['two deployed', history([3, 'deployed'], [4, 'deployed']), /2 revisions with status "deployed" \(3, 4\)/],
    ['no deployed (failed only)', history([1, 'failed']), /no revision with status "deployed"/],
    ['no deployed', history([4, 'superseded'], [5, 'failed']), /no revision with status "deployed"/],
    ['superseded above', history([3, 'deployed'], [4, 'superseded']), /revision 4 \(superseded\) above deployed revision 3/],
    ['unknown above', history([3, 'deployed'], [4, 'unknown']), /revision 4 \(unknown\) above/],
    ['uninstalled above', history([3, 'deployed'], [4, 'uninstalled']), /revision 4 \(uninstalled\) above/],
    ['uninstalling above', history([3, 'deployed'], [4, 'uninstalling']), /revision 4 \(uninstalling\) above/],
    ['pending-upgrade tip', history([4, 'deployed'], [5, 'pending-upgrade']), /unfinished operation: revision 5 is pending-upgrade/],
    ['pending-rollback tip', history([4, 'deployed'], [5, 'pending-rollback']), /revision 5 is pending-rollback/],
    ['pending-install tip', history([4, 'deployed'], [5, 'pending-install']), /revision 5 is pending-install/],
    ['pending below', history([3, 'pending-upgrade'], [4, 'deployed']), /revision 3 is pending-upgrade/],
  ];
  for (const [name, input, message] of cases) {
    assert.throws(() => resolveRollbackRevision(input), (error) => {
      assert.ok(error instanceof RollbackRevisionError, `${name}: ${error}`);
      assert.match(error.message, message, name);
      return true;
    }, name);
  }
});

/** N revisions: 1..N-1 superseded, N deployed (a long but otherwise healthy history). */
function longHistory(n) {
  return Array.from({ length: n }, (_, i) => entry(i + 1, i + 1 === n ? 'deployed' : 'superseded'));
}

test('a history that fills the --max 256 window is refused: completeness cannot be proven', () => {
  // cmd/helm/history.go (v3.16.3) keeps only the newest --max records (default 256), so a
  // disqualifying older record (a pending-* or a second deployed revision) can sit outside a full
  // window. 256 or more returned entries therefore prove nothing about the rest.
  for (const n of [256, 257, 300]) {
    assert.throws(() => resolveRollbackRevision(longHistory(n)), (error) => {
      assert.ok(error instanceof RollbackRevisionError, `${n}: ${error}`);
      assert.match(error.message, new RegExp(`returned ${n} revisions, which fills the --max 256 window`));
      assert.match(error.message, /cannot be proven complete/);
      return true;
    }, `${n} entries`);
  }
  // The window check comes first: even a history that would otherwise be refused for another
  // reason reports the saturated window.
  const saturatedAndPending = longHistory(256);
  saturatedAndPending[0] = entry(1, 'pending-upgrade');
  assert.throws(() => resolveRollbackRevision(saturatedAndPending), /fills the --max 256 window/);
});

test('a history of 255 entries is below the window and still resolves', () => {
  const target = resolveRollbackRevision(longHistory(255));
  assert.equal(target.revision, 255);
  assert.equal(target.newestRevision, 255);
});

test('the CLI refuses a saturated history with the window reason', () => {
  const bad = spawnSync(process.execPath, [CLI], { input: JSON.stringify(longHistory(256)), encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^resolve-rollback-revision: [^\n]*fills the --max 256 window[^\n]*\n$/);
});

test('the known status set is exactly Helm v3\'s', () => {
  assert.deepEqual([...HELM_STATUSES].sort(), [
    'deployed', 'failed', 'pending-install', 'pending-rollback', 'pending-upgrade',
    'superseded', 'uninstalled', 'uninstalling', 'unknown',
  ]);
});

test('output lines are single-line key=value pairs for $GITHUB_OUTPUT', () => {
  const target = resolveRollbackRevision([entry(4, 'deployed', { description: 'Upgrade\ncomplete\r\n::error::x' })]);
  const lines = formatRollbackOutput(target).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'rollback_revision=4');
  assert.equal(lines[1], 'rollback_newest_revision=4');
  assert.match(lines[2], /^rollback_evidence=status deployed in the pre-upgrade helm history \(newest revision 4\); chart gambit-0\.1\.0, app 1\.0\.4, updated 2026-10-11T10:00:00Z, description "Upgrade complete ::error::x"$/);
  assert.equal(lines[3], '');
});

test('the CLI prints the target on success and fails closed with the reason on stderr', () => {
  const ok = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify(history([3, 'superseded'], [4, 'deployed'], [5, 'failed'])),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^rollback_revision=4$/m);
  assert.match(ok.stdout, /^rollback_newest_revision=5$/m);

  for (const [args, input, reason] of [
    [[], '', /not valid JSON/],
    [[], 'Error: release: not found', /not valid JSON/],
    [[], '[]', /empty/],
    [[], JSON.stringify(history([4, 'deployed'], [5, 'pending-upgrade'])), /pending-upgrade/],
    [['--bogus'], '[]', /unexpected argument/],
  ]) {
    const bad = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
    assert.equal(bad.status, 1, `expected failure for ${JSON.stringify(args)} ${input}`);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^resolve-rollback-revision: [^\n]+\n$/);
    assert.match(bad.stderr, reason);
  }
});
