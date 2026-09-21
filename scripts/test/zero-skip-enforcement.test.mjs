import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithZeroSkip } from '../run-zero-skip.mjs';
import { runHermeticTests, HERMETIC_WORKSPACES } from '../run-hermetic-tests.mjs';
import {
  createStreamingTestParser,
  createStreamLineProcessor,
  parseCancelledCount,
  parseFailCount,
  parsePassCount,
  parseSkippedCount,
  parseTestCount,
  parseTodoCount,
} from '../lib/test-output-parser.mjs';


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

test('zero-skip enforcer: fails when test runner reports 0 tests executed', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 0\\n# pass 0\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when 0 tests were executed');
});

test('zero-skip enforcer: fails when child process is terminated by a signal', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'process.kill(process.pid, "SIGTERM");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when child process is killed by signal');
});

test('zero-skip enforcer: fails when child process exits 0 with arbitrary text and no test summary', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("Hello world, no tests here");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when arbitrary text without test summary is output');
});

test('zero-skip enforcer: fails unconditionally when a skip is reported', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("not ok 1 - test # SKIP SIGTERM on Windows terminates without running handlers\\n# tests 1\\n# pass 0\\n# skipped 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when test is skipped regardless of platform');
});

test('zero-skip enforcer: ignores decoy "skipped N" in ordinary output when summary has skipped 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("application skipped 1 old record\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when prose contains "skipped 1" but genuine summary reports skipped 0');
});

test('zero-skip enforcer: fails when summary reports skipped 1 even if ordinary output has decoy "skipped 0"', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("processed item, skipped 0 errors\\n# tests 1\\n# pass 0\\n# skipped 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when genuine summary reports skipped 1 despite earlier "skipped 0"');
});

test('zero-skip enforcer: ignores decoy "tests 0" in ordinary output when summary has tests 5', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("unrelated tests 0\\n# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when prose contains "tests 0" but genuine summary reports tests 5');
});

test('zero-skip enforcer: fails when ordinary output contains decoy "tests 5" without real reporter summary', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("we ran tests 5");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when prose contains "tests 5" but no genuine reporter summary exists');
});

test('zero-skip enforcer: succeeds with valid TAP plan "1..N"', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("1..3\\nok 1 - test a\\nok 2 - test b\\nok 3 - test c");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when genuine TAP plan 1..N is present');
});

test('zero-skip enforcer: fails on decoy "1..N" in ordinary prose without newline anchor', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("see section 1..5 in the manual for details");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when 1..N is unanchored prose');
});

test('zero-skip enforcer: succeeds with valid Node spec reporter output (ℹ tests 5)', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ℹ tests 5\\nℹ pass 5\\nℹ skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 for valid Node spec format summary');
});

test('zero-skip enforcer: fails when an earlier suite in a multi-summary run reports skipped 1 even if later suite reports skipped 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 5\\n# pass 4\\n# skipped 1\\n# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when any suite in a multi-summary run reports skipped > 0');
});

test('zero-skip enforcer: fails when an earlier suite in a multi-summary run reports 0 tests executed', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 0\\n# pass 0\\n# skipped 0\\n# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when any suite in a multi-summary run executes 0 tests');
});

test('repository-level hermetic runner: fails when a child workspace exits 0 but reports skipped > 0', async () => {
  const code = await runHermeticTests({
    workspaces: ['mock-pkg-a', 'mock-pkg-b'],
    commandBuilder: (ws) =>
      ws === 'mock-pkg-b'
        ? { cmd: process.execPath, args: ['-e', 'console.log("# tests 1\\n# pass 0\\n# skipped 1");'] }
        : { cmd: process.execPath, args: ['-e', 'console.log("# tests 3\\n# pass 3\\n# skipped 0");'] },
    silent: true,
  });
  assert.equal(code, 1, 'should fail repository hermetic runner when child workspace reports skipped > 0');
});

test('repository-level hermetic runner: succeeds across multiple workspaces when all report tests > 0 and skipped = 0', async () => {
  const code = await runHermeticTests({
    workspaces: ['mock-pkg-a', 'mock-pkg-b', 'mock-pkg-c'],
    commandBuilder: () => ({
      cmd: process.execPath,
      args: ['-e', 'console.log("ℹ tests 5\\nℹ pass 5\\nℹ skipped 0");'],
    }),
    silent: true,
  });
  assert.equal(code, 0, 'should succeed when all child workspaces report valid tests and zero skips');
});

test('repository-level hermetic runner: fails when a child workspace reports zero executed tests', async () => {
  const code = await runHermeticTests({
    workspaces: ['mock-pkg-a'],
    commandBuilder: () => ({
      cmd: process.execPath,
      args: ['-e', 'console.log("# tests 0\\n# pass 0\\n# skipped 0");'],
    }),
    silent: true,
  });
  assert.equal(code, 1, 'should fail when a child workspace executes zero tests');
});

test('repository-level hermetic runner: propagates natural failure exit code when a child workspace fails', async () => {
  const code = await runHermeticTests({
    workspaces: ['mock-pkg-a'],
    commandBuilder: () => ({
      cmd: process.execPath,
      args: ['-e', 'process.exit(42);'],
    }),
    silent: true,
  });
  assert.equal(code, 42, 'should propagate non-zero exit code of failing workspace');
});

test('repository-level hermetic runner: exports the 19 declared hermetic workspaces', () => {
  assert.equal(HERMETIC_WORKSPACES.length, 19, 'should declare exactly 19 hermetic workspaces');
  assert.ok(HERMETIC_WORKSPACES.includes('@chess-platform/core'));
  assert.ok(HERMETIC_WORKSPACES.includes('@chess-platform/achievements'));
  assert.ok(HERMETIC_WORKSPACES.includes('@chess-platform/ai-features'));
});

test('zero-skip enforcer: fails when a suite reports TODO-only Node test output (todo > 0)', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 1\\n# pass 0\\n# fail 0\\n# skipped 0\\n# todo 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when todo > 0 (TODO-only)');
});

test('zero-skip enforcer: fails when a suite reports mixed pass + TODO (todo > 0)', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 2\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when mixed pass and todo > 0');
});

test('zero-skip enforcer: succeeds when a suite reports clean Node summary with todo 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 2\\n# pass 2\\n# fail 0\\n# skipped 0\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when todo is 0');
});

test('zero-skip enforcer: ignores decoy TODO prose in ordinary output when summary has todo 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("todo 5 items remain in application backlog\\n# tests 1\\n# pass 1\\n# skipped 0\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should ignore decoy TODO text in application logs');
});

test('zero-skip enforcer: fails when a suite reports cancelled > 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 2\\n# pass 1\\n# fail 0\\n# cancelled 1\\n# skipped 0\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when cancelled > 0');
});

test('zero-skip enforcer: fails when spec reporter format reports todo > 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ℹ tests 3\\nℹ pass 2\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 0\\nℹ todo 1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when spec reporter reports todo > 0');
});

test('zero-skip enforcer: fails when spec reporter format reports cancelled > 0', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ℹ tests 3\\nℹ pass 2\\nℹ fail 0\\nℹ cancelled 1\\nℹ skipped 0\\nℹ todo 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when spec reporter reports cancelled > 0');
});

test('zero-skip enforcer: fails when TAP stream contains individual test TODO directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - pending feature # TODO implement next week\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when individual test has # TODO');
});

test('zero-skip enforcer: fails when an earlier suite in a multi-summary run reports todo 1', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 3\\n# pass 2\\n# fail 0\\n# skipped 0\\n# todo 1\\n# tests 5\\n# pass 5\\n# fail 0\\n# skipped 0\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when earlier suite in multi-summary run has todo > 0');
});

test('zero-skip enforcer: fails when an earlier suite in a multi-summary run reports cancelled 1', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 3\\n# pass 2\\n# fail 0\\n# cancelled 1\\n# skipped 0\\n# todo 0\\n# tests 5\\n# pass 5\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when earlier suite in multi-summary run has cancelled > 0');
});

test('zero-skip enforcer: fails when summary reports skipped 0 but individual test has TAP SKIP directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 1\\n# skipped 0\\nok 1 - deferred # SKIP reason");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when TAP # SKIP directive is present despite summary skipped 0');
});

test('zero-skip enforcer: succeeds when summary reports skipped 0 and normal test passes', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 1\\n# skipped 0\\nok 1 - normal");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when clean summary and no skip directive');
});

test('zero-skip enforcer: ignores prose mentioning SKIP reason when summary is clean', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("SKIP reason is logged in prose\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should ignore prose containing SKIP reason');
});

test('zero-skip enforcer: fails when summary reports todo 0 but individual test has TAP TODO directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 1\\n# todo 0\\nok 1 - pending # TODO reason");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when TAP # TODO directive is present despite summary todo 0');
});

test('zero-skip enforcer: succeeds when summary reports todo 0 and test is complete', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 1\\n# todo 0\\nok 1 - complete");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when clean summary and no todo directive');
});

test('zero-skip enforcer: ignores prose mentioning TODO 3 application tasks when summary is clean', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("TODO 3 application tasks remain in backlog\\n# tests 1\\n# pass 1\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should ignore prose containing TODO tasks');
});

test('zero-skip enforcer: fails when raw TAP output has not ok despite child exit 0 and positive plan', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("not ok 1 - failure\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when raw TAP contains not ok');
});

test('zero-skip enforcer: succeeds when raw TAP output has ok and positive plan', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - success\\n1..1");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when raw TAP has ok and valid plan');
});

test('zero-skip enforcer: fails when earlier summary reports tests 0 followed by positive tests', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 0\\n# tests 5\\n# pass 5\\n# fail 0\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when any summary reports tests 0');
});

test('zero-skip enforcer: succeeds when multiple positive summaries are reported', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("# tests 2\\n# pass 2\\n# skipped 0\\n# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when multiple positive summaries pass');
});

test('zero-skip enforcer: fails when TAP plan declares 1..0 despite positive summary', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("1..0\\n# tests 5\\n# pass 5\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when TAP plan has 0 tests');
});

test('zero-skip enforcer: fails when unnumbered TAP test point has SKIP directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok - unnumbered test # SKIP not supported\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when unnumbered TAP test has # SKIP');
});

test('zero-skip enforcer: fails when unnumbered TAP test point has TODO directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok - unnumbered test # TODO pending feature\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when unnumbered TAP test has # TODO');
});

test('zero-skip enforcer: succeeds when test title contains escaped hash before SKIP keyword', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - test title has \\\\# SKIP inside text\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when escaped hash is present in test description');
});

test('test-output-parser: parseTestCount detects zero-test summaries and preserves failure', () => {
  assert.equal(parseTestCount('# tests 0\n# tests 5'), 0, '# tests 0 should return 0 even when followed by positive summary');
  assert.equal(parseTestCount('ℹ tests 0\nℹ tests 10'), 0, 'spec format 0 tests should return 0');
  assert.equal(parseTestCount('1..0\n# tests 5'), 0, 'zero-test plan header must return 0 even with positive summary');
  assert.equal(parseTestCount('1..5\n# tests 0'), 0, 'zero-test summary must return 0 even with positive plan header');
  assert.equal(parseTestCount('# tests 2\n# tests 5'), 7, 'multiple positive summaries should aggregate');
  assert.equal(parseTestCount('1..3\nok 1\nok 2\nok 3'), 3, 'TAP-only plan fallback should parse');
  assert.equal(parseTestCount('1..0'), 0, 'TAP-only zero plan should return 0');
  assert.equal(parseTestCount('arbitrary text with no test summary'), null, 'unrecognized output should return null');
});

test('test-output-parser: parseSkippedCount detects TAP and spec skip directives independently of summary', () => {
  const mixedOutput = '# tests 1\n# skipped 0\nok 1 - deferred # SKIP temporary reason';
  assert.equal(parseSkippedCount(mixedOutput), 1, 'individual # SKIP should raise count to at least 1 when summary is 0');

  const cleanOutput = '# tests 1\n# skipped 0\nok 1 - normal';
  assert.equal(parseSkippedCount(cleanOutput), 0, 'clean summary with normal test should be 0');

  const unnumberedSkip = 'ok - deferred test # SKIP reason\n1..1';
  assert.equal(parseSkippedCount(unnumberedSkip), 1, 'unnumbered ok with # SKIP should be detected');

  const escapedHashTitle = 'ok 1 - test has \\# SKIP in title\n# tests 1\n# pass 1\n# skipped 0';
  assert.equal(parseSkippedCount(escapedHashTitle), 0, 'escaped hash in test title should not be detected as SKIP');

  const proseDecoy = 'unrelated log: SKIP reason is handled\n# tests 1\n# skipped 0';
  assert.equal(parseSkippedCount(proseDecoy), 0, 'decoy prose mentioning SKIP reason should be ignored');

  const tapOnlySkip = 'ok 1 - unsupported platform # SKIP win32 not supported\n1..1';
  assert.equal(parseSkippedCount(tapOnlySkip), 1, 'TAP-only # SKIP without summary should return 1');
});

test('test-output-parser: parseTodoCount detects TAP and spec todo directives independently of summary', () => {
  const mixedOutput = '# tests 1\n# todo 0\nok 1 - pending # TODO implement soon';
  assert.equal(parseTodoCount(mixedOutput), 1, 'individual # TODO should raise count to at least 1 when summary is 0');

  const cleanOutput = '# tests 1\n# todo 0\nok 1 - complete';
  assert.equal(parseTodoCount(cleanOutput), 0, 'clean summary with complete test should be 0');

  const unnumberedTodo = 'ok - pending test # TODO reason\n1..1';
  assert.equal(parseTodoCount(unnumberedTodo), 1, 'unnumbered ok with # TODO should be detected');

  const escapedHashTodoTitle = 'ok 1 - test has \\# TODO in title\n# tests 1\n# pass 1\n# todo 0';
  assert.equal(parseTodoCount(escapedHashTodoTitle), 0, 'escaped hash in test title should not be detected as TODO');

  const proseDecoy = 'TODO 3 application tasks remain in backlog\n# tests 1\n# todo 0';
  assert.equal(parseTodoCount(proseDecoy), 0, 'decoy prose mentioning TODO should be ignored');

  const tapOnlyTodo = 'ok 1 - deferred feature # TODO not yet ready\n1..1';
  assert.equal(parseTodoCount(tapOnlyTodo), 1, 'TAP-only # TODO without summary should return 1');
});

test('test-output-parser: parseFailCount detects raw TAP not ok and differentiates TODO/SKIP directives', () => {
  const rawFailure = 'not ok 1 - broken assertion\n1..1';
  assert.equal(parseFailCount(rawFailure), 1, 'raw TAP not ok should register as failure');

  const unnumberedRawFailure = 'not ok - broken assertion\n1..1';
  assert.equal(parseFailCount(unnumberedRawFailure), 1, 'unnumbered raw TAP not ok should register as failure');

  const cleanTap = 'ok 1 - success\n1..1';
  assert.equal(parseFailCount(cleanTap), 0, 'clean TAP ok should not register as failure');

  const tapTodoNotOk = 'not ok 1 - planned feature # TODO will fix\n1..1';
  assert.equal(parseFailCount(tapTodoNotOk), 0, 'TAP not ok with # TODO should not count as raw failure (handled by todo)');
  assert.equal(parseTodoCount(tapTodoNotOk), 1, 'TAP not ok with # TODO must register as TODO');

  const tapSkipNotOk = 'not ok 1 - skipped test # SKIP broken environment\n1..1';
  assert.equal(parseFailCount(tapSkipNotOk), 0, 'TAP not ok with # SKIP should not count as raw failure (handled by skip)');
  assert.equal(parseSkippedCount(tapSkipNotOk), 1, 'TAP not ok with # SKIP must register as SKIP');
});

test('zero-skip enforcer: fails when child output contains # SKIPPED directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - feature # SKIPPED not ready\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when # SKIPPED is present');
});

test('zero-skip enforcer: fails when child output contains unnumbered # SKIPPED directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok - feature # SKIPPED not ready\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when unnumbered # SKIPPED is present');
});

test('zero-skip enforcer: fails when child output contains # TO-DO directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - feature # TO-DO future item\\n# tests 1\\n# pass 1\\n# todo 0");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when # TO-DO is present');
});

test('zero-skip enforcer: fails when child output contains unnumbered # TO-DO directive', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok - feature # TO-DO future item\\n1..1");',
  ], { silent: true });
  assert.equal(code, 1, 'should return exit code 1 when unnumbered # TO-DO is present');
});

test('zero-skip enforcer: succeeds when test title contains escaped hash before SKIPPED keyword', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    'console.log("ok 1 - title has \\\\# SKIPPED inside\\n# tests 1\\n# pass 1\\n# skipped 0");',
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when escaped hash is present in test description');
});

test('test-output-parser: parseSkippedCount and parseTodoCount detect SKIPPED and TO-DO variants', () => {
  assert.equal(parseSkippedCount('ok 1 - item # SKIPPED reason\n1..1'), 1);
  assert.equal(parseSkippedCount('ok - item # SKIPPED reason\n1..1'), 1);
  assert.equal(parseSkippedCount('not ok 1 - item # SKIPPED reason\n1..1'), 1);
  assert.equal(parseSkippedCount('ok 1 - item with \\# SKIPPED escaped\n# tests 1\n# skipped 0'), 0);

  assert.equal(parseTodoCount('ok 1 - item # TO-DO reason\n1..1'), 1);
  assert.equal(parseTodoCount('ok - item # TO-DO reason\n1..1'), 1);
  assert.equal(parseTodoCount('not ok 1 - item # TO-DO reason\n1..1'), 1);
  assert.equal(parseTodoCount('ok 1 - item with \\# TO-DO escaped\n# tests 1\n# todo 0'), 0);
});

test('streaming-test-parser: maintains O(1) bounded state with identical metrics to static parsers', () => {
  const fixtures = [
    '# tests 10\n# pass 8\n# skipped 2\n# fail 0\n# todo 0',
    'ℹ tests 5\nℹ pass 4\nℹ skipped 0\nℹ fail 0\nℹ todo 1',
    '1..20\nok 1 - first\nnot ok 2 - fail\nok 3 - skip # SKIP reason',
    'ok 1 - escaped \\# SKIP in title\n# tests 1\n# pass 1\n# skipped 0',
    '- test (skipped)\nℹ tests 1\nℹ pass 0\nℹ skipped 0',
    '- test (cancelled)\nℹ tests 2\nℹ pass 1\nℹ cancelled 0',
    'not ok 1 - raw unsummarized failure',
    '# tests 0\n# pass 0\n# skipped 0',
    '1..0',
  ];

  for (const fixture of fixtures) {
    const parser = createStreamingTestParser();
    for (const line of fixture.split('\n')) {
      parser.pushLine(line);
    }
    const streamed = parser.getResults();

    assert.equal(streamed.totalTests, parseTestCount(fixture), `totalTests mismatch on: ${fixture}`);
    assert.equal(streamed.skippedCount, parseSkippedCount(fixture), `skippedCount mismatch on: ${fixture}`);
    assert.equal(streamed.todoCount, parseTodoCount(fixture), `todoCount mismatch on: ${fixture}`);
    assert.equal(streamed.cancelledCount, parseCancelledCount(fixture), `cancelledCount mismatch on: ${fixture}`);
    assert.equal(streamed.failCount, parseFailCount(fixture), `failCount mismatch on: ${fixture}`);
  }
});

test('streaming-test-parser: processes large transcripts with strictly bounded memory', () => {
  const parser = createStreamingTestParser();
  for (let i = 1; i <= 20000; i++) {
    parser.pushLine(`ok ${i} - synthetic pass item`);
  }
  parser.pushLine('# tests 20000');
  parser.pushLine('# pass 20000');
  parser.pushLine('# skipped 0');
  parser.pushLine('# fail 0');

  const results = parser.getResults();
  assert.equal(results.totalTests, 20000);
  assert.equal(results.skippedCount, 0);
  assert.equal(results.failCount, 0);
  assert.equal(results.todoCount, 0);
});

test('streaming-stream-processor: correctly handles TAP and report lines split across arbitrary chunks', () => {
  const parser = createStreamingTestParser();
  const processor = createStreamLineProcessor(parser);

  // Split line across 4 separate chunks
  processor.pushStdoutChunk(Buffer.from('# '));
  processor.pushStdoutChunk(Buffer.from('te'));
  processor.pushStdoutChunk(Buffer.from('sts '));
  processor.pushStdoutChunk(Buffer.from('12\n'));

  // Split directives across chunks
  processor.pushStdoutChunk(Buffer.from('# pass 10\n# skip'));
  processor.pushStdoutChunk(Buffer.from('ped 0\n# todo 0\n# cancelled 0\n# fail 2\n'));

  const results = processor.getResults();
  assert.equal(results.totalTests, 12);
  assert.equal(results.passCount, 10);
  assert.equal(results.skippedCount, 0);
  assert.equal(results.failCount, 2);
});

test('streaming-stream-processor: prevents cross-stream corruption between interleaved stdout and stderr chunks', () => {
  const parser = createStreamingTestParser();
  const processor = createStreamLineProcessor(parser);

  // stdout emits a partial line with a SKIP directive
  processor.pushStdoutChunk(Buffer.from('ok 1 - dynamic test # SK'));

  // stderr emits log output in between
  processor.pushStderrChunk(Buffer.from('[WARN] connecting to redis replica...\n'));
  processor.pushStderrChunk(Buffer.from('[INFO] connected\n'));

  // stdout completes the line
  processor.pushStdoutChunk(Buffer.from('IP skipped intentionally\n# tests 1\n# pass 0\n# skipped 1\n'));

  const results = processor.getResults();
  assert.equal(results.totalTests, 1);
  assert.equal(results.skippedCount, 1);
});

test('streaming-stream-processor: correctly reconstructs multibyte UTF-8 ℹ sequence split across chunk boundaries', () => {
  const parser = createStreamingTestParser();
  const processor = createStreamLineProcessor(parser);

  // 'ℹ' is U+2139: UTF-8 bytes 0xE2 0x84 0xB9
  // Chunk 1 has the first 2 bytes:
  const chunk1 = Buffer.from([0xe2, 0x84]);
  // Chunk 2 has the 3rd byte plus " tests 8\n":
  const chunk2 = Buffer.concat([
    Buffer.from([0xb9]),
    Buffer.from(' tests 8\nℹ pass 8\nℹ skipped 0\nℹ todo 0\nℹ cancelled 0\nℹ fail 0\n'),
  ]);

  processor.pushStdoutChunk(chunk1);
  processor.pushStdoutChunk(chunk2);

  const results = processor.getResults();
  assert.equal(results.totalTests, 8, 'totalTests should be 8 from reconstructed ℹ tests 8');
  assert.equal(results.passCount, 8);
  assert.equal(results.skippedCount, 0);
  assert.equal(results.failCount, 0);
});

test('streaming-stream-processor: falsification proves naive chunk.toString and shared lineBuffer fail', () => {
  // Falsification Case 1: Naive chunk.toString('utf8') splits multibyte 'ℹ' into replacement characters
  const chunk1 = Buffer.from([0xe2, 0x84]);
  const chunk2 = Buffer.from([0xb9, 0x20, 0x74, 0x65, 0x73, 0x74, 0x73, 0x20, 0x35, 0x0a]); // " tests 5\n"
  const naiveText = chunk1.toString('utf8') + chunk2.toString('utf8');
  assert.ok(naiveText.includes('\ufffd'), 'Naive toString must contain Unicode replacement characters');
  assert.ok(!naiveText.startsWith('ℹ tests 5'), 'Naive toString must fail to reconstruct "ℹ tests 5"');

  // Falsification Case 2: Shared line buffer between stdout and stderr corrupts anchored TAP directives
  let sharedBuffer = '';
  const fakeStdout1 = 'ok 1 - test # SK';
  const fakeStderr = '[LOG] db query error\n';
  const fakeStdout2 = 'IP reason\n';

  sharedBuffer += fakeStdout1;
  sharedBuffer += fakeStderr;
  const corruptedLines = sharedBuffer.split('\n');
  assert.equal(corruptedLines[0], 'ok 1 - test # SK[LOG] db query error', 'Shared buffer line was corrupted');
  assert.ok(!corruptedLines[0].includes('# SKIP'), 'Anchored SKIP directive was corrupted into # SK[LOG]');
});

test('zero-skip enforcer: preserves zero-skip pass when child process streams split multibyte UTF-8 summary', async () => {
  const code = await runWithZeroSkip(process.execPath, [
    '-e',
    `
      // Write first 2 bytes of ℹ (0xE2, 0x84)
      process.stdout.write(Buffer.from([0xe2, 0x84]));
      // Follow with remaining byte (0xB9) + rest of summary
      process.stdout.write(Buffer.concat([
        Buffer.from([0xb9]),
        Buffer.from(" tests 4\\nℹ pass 4\\nℹ skipped 0\\nℹ todo 0\\nℹ cancelled 0\\nℹ fail 0\\n")
      ]));
    `,
  ], { silent: true });
  assert.equal(code, 0, 'should return exit code 0 when multibyte ℹ is split across child writes');
});


