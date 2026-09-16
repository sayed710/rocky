import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithZeroSkip } from '../run-zero-skip.mjs';

test('zero-skip enforcer: succeeds when a suite reports zero skips', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when skipped is 0');
});

test('zero-skip enforcer: fails when a suite reports skipped > 0 (TAP format)', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 5\\n# pass 4\\n# skipped 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when skipped > 0');
});

test('zero-skip enforcer: fails when a suite reports skipped > 0 (Node spec format)', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ℹ tests 10\\nℹ pass 8\\nℹ skipped 2");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when spec format reports skipped > 0');
});

test('zero-skip enforcer: propagates natural non-zero exit code on failure', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'process.exit(42);',
  ], { silent: true });
  assert.equal(code, 42, 'should propagate original exit code');
});

test('zero-skip enforcer: detects real child test process self-skipping', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '--input-type=module',
    '-e',
    'import test from "node:test"; test("skipping test", { skip: "not provisioned" }, () => {});',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when child test self-skips');
});

test('zero-skip enforcer: does not falsely fail on test names containing the word skipped', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 145 - a stored game whose chess960 metadata is corrupt is skipped, not thrown from\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when test name contains the word skipped');
});


