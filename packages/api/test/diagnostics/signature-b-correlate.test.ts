import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTICS_DIR = path.resolve(__dirname, '../../../test/diagnostics');
const CORRELATE_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-correlate.cjs');
const PRELOAD_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-preload.cjs');

/**
 * One record per parent-observed failure, exactly as `correlate` emits it.
 *
 * Declared once so the tests assert against the contract instead of each call site casting to its
 * own guess of the shape. A field that moves or is dropped then fails to compile here, rather than
 * silently passing every test that did not happen to name it.
 */
interface CorrelatedRecord {
  file: string;
  parent: {
    exitCode: number | null;
    signal: string | null;
    failureType: string | null;
    durationMs: number | null;
  };
  child: {
    logFound: boolean;
    ambiguous: boolean;
    candidates: number;
    pid: number | null;
    kinds: string[];
  };
  fatalMarkers: string[];
  classification: string;
  meaning: string;
  specific: boolean;
  narrowed: boolean;
  statement: string;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const correlator = require(CORRELATE_PATH) as {
  EXIT_CODE_TABLE: ReadonlyArray<{ code: number; id: string; specific: boolean }>;
  MAX_RECORDS: number;
  classifyTermination(t: { exitCode: number | null; signal: string | null }): {
    id: string;
    meaning: string;
    specific: boolean;
  };
  correlate(failures: unknown[], childLogs: Map<string, unknown>, options?: { isWindows?: boolean }): CorrelatedRecord[];
  fatalMarkersIn(text: string | undefined): string[];
  narrowFromChildEvidence(
    c: { id: string; specific: boolean },
    kinds: readonly string[],
  ): { narrowed: boolean; statement: string };
  parseTapFailures(tap: string, options?: { isWindows?: boolean }): Array<{
    file: string;
    exitCode: number | null;
    signal: string | null;
    failureType: string | null;
    durationMs: number | null;
    fatalMarkers: string[];
    isWindows?: boolean;
  }>;
  readChildLogs(dir: string): Map<string, { pid: number | null; kinds: string[] }>;
  matchChild(logs: Map<string, unknown>, file: string, parentIsWindows?: boolean): { child: unknown; ambiguous: boolean; candidates: number };
  normalizePath(p: string): string;
  isWindowsPath(p: string): boolean;
};

/**
 * Whether a child died of a fault it suffered, rather than by choosing its own exit status.
 *
 * The two platforms report the same event differently and neither encoding is the contract. Windows
 * has no signals, so a V8 fatal error reaches the parent as exit code 134 with `signal: null`; POSIX
 * raises SIGABRT, and the exit code is then null. Asserting 134 alone passes on the machine this was
 * written on and fails everywhere CI runs it — which is exactly how it did fail.
 */
function diedOfAFault(exitCode: number | null | undefined, signal: string | null | undefined): boolean {
  return exitCode === 134 || signal === 'SIGABRT';
}

/** A TAP block in the exact shape Node's built-in reporter emits for a file-level failure. */
function tapFailure(file: string, exitCode: string, signal = '~', failureType = 'testCodeFailure'): string {
  return [
    `# Subtest: ${file}`,
    `not ok 1 - ${file}`,
    '  ---',
    '  duration_ms: 612.4',
    "  type: 'test'",
    `  location: 'C:\\repo\\${file}:1:1'`,
    `  failureType: '${failureType}'`,
    `  exitCode: ${exitCode}`,
    `  signal: ${signal}`,
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
  ].join('\n');
}

test('correlator: reads the exit status the spec reporter discards out of a TAP block', () => {
  const failures = correlator.parseTapFailures(tapFailure('studies-api.test.js', '3221225477'));

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.exitCode, 3221225477, 'the NTSTATUS code survives as an unsigned integer');
  assert.equal(failures[0]?.signal, null, 'a YAML ~ is null, not the string "~"');
  assert.equal(failures[0]?.failureType, 'testCodeFailure');
});

test('correlator: ignores a test that failed on its own assertion', () => {
  const realFailure = [
    'not ok 1 - some genuine test',
    '  ---',
    '  duration_ms: 3.1',
    "  error: 'Expected values to be strictly equal'",
    '  ...',
  ].join('\n');

  assert.deepEqual(correlator.parseTapFailures(realFailure), [], 'only Node\'s bare fallback is Signature B');
});

test('correlator: an ordinary failing assertion is not a Signature B capture', () => {
  // Node writes `error: 'test failed'` for any file whose child exited non-zero, so a file holding
  // an ordinary failing test carries the identical message — under `subtestsFailed`, because a
  // subtest did fail. Matching the message alone would report every regression as a capture and
  // halt the pass on a false positive.
  const ordinary = tapFailure('has-a-failing-test.test.js', '1', '~', 'subtestsFailed');

  assert.deepEqual(correlator.parseTapFailures(ordinary), [], 'only the no-subtest-failed branch is this defect');
  assert.equal(correlator.parseTapFailures(tapFailure('died.test.js', '1')).length, 1, 'testCodeFailure still counts');
});

test('correlator: classifies every termination code that was measured on this platform', () => {
  assert.equal(correlator.classifyTermination({ exitCode: 134, signal: null }).id, 'native-abort-or-v8-fatal');
  assert.equal(correlator.classifyTermination({ exitCode: 3221225477, signal: null }).id, 'native-access-violation');
  assert.equal(correlator.classifyTermination({ exitCode: 4294967295, signal: null }).id, 'external-terminate-process');
  assert.equal(
    correlator.classifyTermination({ exitCode: 3221225786, signal: null }).id,
    'external-control-c',
    '0xC000013A is STATUS_CONTROL_C_EXIT, a console interrupt — not a native fault',
  );
});

test('correlator: an unmeasured NTSTATUS code names no mechanism', () => {
  // The range fallback used to report anything at or above 0xC0000000 as a native-fault candidate.
  // STATUS_CONTROL_C_EXIT (0xC000013A) disproves that as a rule: it lives in the range and means a
  // console CTRL+C. So membership narrows the shape of the answer and nothing more, and a value the
  // measured table does not cover has to be reported non-specific.
  const unmeasured = correlator.classifyTermination({ exitCode: 0xc0000022, signal: null });

  assert.equal(unmeasured.id, 'ntstatus-unmeasured');
  assert.equal(unmeasured.specific, false, 'an unmeasured status in the range must not claim a mechanism');
  assert.match(unmeasured.meaning, /does not cover/);
  assert.doesNotMatch(unmeasured.meaning, /^candidate:/, 'it names no candidate to lead with');
});

test('correlator: an exit status names a candidate mechanism, never a proven one', () => {
  // An exit status is a 32-bit integer the terminating party chooses. `TerminateProcess(h,
  // 0xC0000005)` produces the same number as a real access violation, so treating the number as
  // proof of a native fault would be an unsupported claim dressed as a measurement.
  for (const exitCode of [134, 3221225477, 3221226505, 3221225725, 3221225540, 4294967295, 3221225786]) {
    const classification = correlator.classifyTermination({ exitCode, signal: null });
    assert.equal(classification.specific, true, `${exitCode} names a specific mechanism`);
    assert.match(classification.meaning, /candidate/, `${exitCode} must be described as a candidate`);
  }

  assert.ok(
    correlator.EXIT_CODE_TABLE.every((entry) => !('conclusive' in entry)),
    'no entry may claim to be conclusive from its status number alone',
  );
});

test('correlator: same-basename files in different directories are never merged', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-collide-'));
  try {
    const lines = [
      { kind: 'start', pid: 111, testFile: 'C:\\r\\dist-test\\test\\foo\\a.test.js' },
      { kind: 'exit', pid: 111, testFile: 'C:\\r\\dist-test\\test\\foo\\a.test.js' },
      { kind: 'start', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'preload-installed', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-c.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/bar/a.test.js', '1')),
      logs,
    );
    assert.equal(resolved[0]?.child.pid, 222, 'the full path picks the right one of two same-named files');
    assert.equal(resolved[0]?.child.ambiguous, false);
    assert.deepEqual(resolved[0]?.child.kinds, ['start', 'preload-installed']);

    // A parent path too short to disambiguate must be reported as ambiguous, never guessed.
    const ambiguous = correlator.correlate(
      correlator.parseTapFailures(tapFailure('a.test.js', '1')),
      logs,
    );
    assert.equal(ambiguous[0]?.child.ambiguous, true, 'two candidates is not an answer');
    assert.equal(ambiguous[0]?.child.pid, null, 'and no PID may be attributed');
    assert.equal(ambiguous[0]?.narrowed, false, 'evidence that is not this file\'s narrows nothing');
    assert.match(ambiguous[0]?.statement ?? '', /without guessing/);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: an option given no value is a usage error, not a path', () => {
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [CORRELATE_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });

  // `--tap --child-logs d` must not read a file literally called "--child-logs".
  const swallowed = run(['--tap', '--child-logs', 'd']);
  assert.notEqual(swallowed.status, 0);
  assert.match(`${swallowed.stderr}`, /--tap requires a value/);

  const missing = run(['--tap']);
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}`, /requires a value/);
});

test('correlator: names the signal that killed a child but never claims who sent it', () => {
  // Node's exit contract reports the signal, not its sender, so an external SIGKILL on Linux is
  // indistinguishable here from a runner cancellation. Attributing one would be the same
  // unsupported leap this module refuses to make for exit code 1.
  const classification = correlator.classifyTermination({ exitCode: null, signal: 'SIGKILL' });

  assert.equal(classification.id, 'signal-terminated');
  assert.equal(classification.specific, false, 'the mechanism is known; the actor is not');
  assert.match(classification.meaning, /SIGKILL/);
  assert.doesNotMatch(classification.meaning, /the test runner killed/, 'no sender may be named');
});

test('correlator: refuses to identify exit code 1, which four different causes produce', () => {
  const classification = correlator.classifyTermination({ exitCode: 1, signal: null });

  assert.equal(classification.id, 'inconclusive');
  assert.equal(classification.specific, false, 'claiming a cause from exit code 1 would be the wrong answer');
});

test('correlator: an unrun JS exit path narrows an inconclusive code without identifying it', () => {
  const inconclusive = { id: 'inconclusive', specific: false };

  const silent = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed']);
  assert.equal(silent.narrowed, true);
  assert.match(silent.statement, /excludes process\.exit and an uncaught exception/);

  const exited = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed', 'process.exit']);
  assert.equal(exited.narrowed, false, 'a child whose own log names the cause explains itself');

  const nothing = correlator.narrowFromChildEvidence(inconclusive, []);
  assert.equal(nothing.narrowed, false, 'no child log is no evidence');
});

test('correlator: a shutdown event is not a cause, and is not reported as one', () => {
  // `exit` and `beforeExit` fire for any orderly termination, so treating them as causal would let
  // a child that merely finished be reported as having explained itself. What they do establish is
  // narrower and still useful: neither fires for an external kill or a native fault.
  const inconclusive = { id: 'inconclusive', specific: false };

  const named = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'process.exit', 'exit']);
  assert.equal(named.narrowed, false, 'a hook that names the cause explains the child');
  assert.match(named.statement, /process\.exit, which names the cause/);

  const shutdownOnly = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'exit']);
  assert.equal(shutdownOnly.narrowed, true, 'reaching shutdown is evidence, just not of a cause');
  assert.doesNotMatch(shutdownOnly.statement, /names the cause/, 'no cause may be claimed from a lifecycle event');
  assert.match(shutdownOnly.statement, /does not say why it exited/);

  const beforeOnly = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'beforeExit']);
  assert.doesNotMatch(beforeOnly.statement, /names the cause/, 'beforeExit names nothing either');
});

test('correlator: joins the parent record to the child that ran that file', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-correlate-'));
  try {
    // The unrelated child is written FIRST on purpose: a correlator that took whichever log came
    // to hand rather than the one for this file would report PID 9999, and ordering it the other
    // way round would let that mistake pass unnoticed.
    const lines = [
      { kind: 'start', pid: 9999, testFile: 'C:\\repo\\dist-test\\test\\other.test.js' },
      { kind: 'exit', pid: 9999, testFile: 'C:\\repo\\dist-test\\test\\other.test.js' },
      { kind: 'start', pid: 4242, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js' },
      { kind: 'preload-installed', pid: 4242, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const records = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      correlator.readChildLogs(logDir),
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.child.pid, 4242, 'the PID comes from the child that ran this file, not another');
    assert.deepEqual(records[0]?.child.kinds, ['start', 'preload-installed']);
    assert.equal(records[0]?.parent.exitCode, 1);
    assert.equal(records[0]?.classification, 'inconclusive');
    assert.equal(records[0]?.narrowed, true, 'silence on the child side is what makes exit code 1 informative');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: joins a capture taken on either platform, read on either platform', () => {
  // A capture is taken on the developer machine and may be read anywhere, CI included. The host's
  // own path helpers split only on the host's separator, so a Windows log read on Linux would keep
  // its backslashes and match nothing — which is exactly how CI caught this.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-sep-'));
  try {
    const lines = [
      { kind: 'start', pid: 111, testFile: 'C:\\repo\\dist-test\\test\\windows-style.test.js' },
      { kind: 'start', pid: 222, testFile: '/home/runner/repo/dist-test/test/posix-style.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-3.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const logs = correlator.readChildLogs(logDir);

    assert.deepEqual(
      [...logs.keys()].sort(),
      ['/home/runner/repo/dist-test/test/posix-style.test.js', 'C:/repo/dist-test/test/windows-style.test.js'].sort(),
      'both separators normalise to / so the key never depends on the reading platform',
    );

    const pidFor = (file: string): number | null =>
      correlator.correlate(correlator.parseTapFailures(tapFailure(file, '1')), logs)[0]?.child.pid ?? null;

    assert.equal(pidFor('dist-test/test/windows-style.test.js'), 111, 'a backslash-recorded child matches its parent');
    assert.equal(pidFor('dist-test/test/posix-style.test.js'), 222, 'so does a forward-slash one');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: a malformed trailing line does not discard the record before it', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-correlate-'));
  try {
    const good = JSON.stringify({ kind: 'start', pid: 7, testFile: 'a.test.js' });
    fs.writeFileSync(path.join(logDir, 'run-2.jsonl'), `${good}\n{"kind":"preload-inst`);

    const logs = correlator.readChildLogs(logDir);

    assert.equal(logs.get('a.test.js')?.pid, 7, 'a child killed mid-write still yields what it managed to log');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: bounds how many records one report can produce', () => {
  const many = Array.from({ length: correlator.MAX_RECORDS + 25 }, (_, i) => tapFailure(`f${i}.test.js`, '1')).join('\n');

  assert.equal(correlator.parseTapFailures(many).length, correlator.MAX_RECORDS);
});

/** Runs the pass script and returns its result, isolated from this suite's own test context. */
function runPass(args: string[], cwd?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), ...args], {
    cwd: cwd ?? path.resolve(DIAGNOSTICS_DIR, '../..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}

/**
 * Read a worker pid once the file actually holds one.
 *
 * `existsSync` turns true when the worker creates the file, which can precede it writing the bytes.
 * An empty read gives `Number('') === 0`, and pid 0 is not "no process" — `process.kill(0, ...)`
 * addresses this test's *own* process group, so a naive read would have the test signalling itself
 * and then reporting the worker as still alive.
 *
 * @returns the pid, or null if none appeared before the deadline
 */
async function readWorkerPid(pidFile: string, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Kill a pid outright, tolerating one that is already gone.
 *
 * Used from `finally` in the tests that deliberately start a long-sleeping worker: if their cleanup
 * assertion fails, the worker they were complaining about would otherwise outlive the suite and
 * interfere with whatever runs next. A test that leaks the process it is policing is worse than no
 * test at all.
 */
function reap(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone, which is what the assertion wanted */
  }
}

/**
 * Wait for a pid to disappear, or give up.
 *
 * `process.kill(pid, 0)` sends no signal and throws ESRCH once the process is gone, but signal
 * delivery and reaping are asynchronous — sampling once right after a kill can still see a process
 * that is on its way out. Polling to a deadline tests the guarantee that actually matters ("it does
 * not survive") without asserting anything about how fast the OS gets there.
 */
async function waitForExit(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A test file that finishes immediately, so a pass over it costs a process start and nothing more. */
function trivialTarget(dir: string): string {
  const file = path.join(dir, 'noop.test.cjs');
  fs.writeFileSync(file, "require('node:test').test('noop', () => {});\n");
  return file;
}

test('pass runner: --runs is a whole, finite, positive count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-runs-'));
  try {
    const target = trivialTarget(dir);

    // A fractional count is the one that matters: 1.5 passes a naive positive-number check and then
    // executes runs 1 and 2, exceeding the ceiling the pass just declared to the reader.
    for (const bad of ['1.5', '0', '-3', 'Infinity', 'twenty', '']) {
      const result = runPass(['--runs', bad, '--target', target, '--out', path.join(dir, `r${bad || 'empty'}`)]);
      assert.notEqual(result.status, 0, `--runs ${JSON.stringify(bad)} must be refused`);
      assert.match(`${result.stderr}`, /must be a (positive number|whole number of runs)/, `--runs ${JSON.stringify(bad)} must say why`);
      assert.doesNotMatch(`${result.stdout}`, /was not observed/, 'a refused ceiling must not report a clean pass');
    }

    for (const good of ['1', '2']) {
      const out = path.join(dir, `ok${good}`);
      const result = runPass(['--runs', good, '--target', target, '--out', out]);
      assert.equal(result.status, 0, `--runs ${good} must be accepted`);
      const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as { runs: unknown[] };
      assert.equal(summary.runs.length, Number(good), `--runs ${good} must execute exactly ${good} run(s)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an option consumed as another option is a usage error', () => {
  for (const args of [['--out', '--target', 'x'], ['--target', '--out'], ['--max-minutes']]) {
    const result = runPass(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} must be refused`);
    assert.match(`${result.stderr}`, /requires a value/);
  }
  assert.ok(!fs.existsSync(path.resolve(DIAGNOSTICS_DIR, '../..', '--target')), 'and must create no directory named after an option');
});

test('pass runner: the ceiling kills the run and every process it started', async () => {
  // Deterministic in both directions by a wide margin: the target blocks for 30s while the ceiling
  // is 6s, which has to outlast two process starts — this script starts `node --test`, which then
  // spawns the per-file worker that records its pid at load time. This is the one behaviour that
  // needs a real timeout, because it is the process-tree cleanup being asserted: node:test spawns
  // one child per file, and on POSIX a SIGKILL to the runner is not delivered to that child.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-tree-'));
  let workerPid: number | null = null;
  try {
    const pidFile = path.join(dir, 'child.pid');
    const target = path.join(dir, 'blocks.test.cjs');
    fs.writeFileSync(
      target,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        "require('node:test').test('blocks', async () => {\n" +
        '  await new Promise((r) => setTimeout(r, 30000));\n' +
        '});\n',
    );
    const out = path.join(dir, 'out');

    const result = runPass(['--runs', '1', '--max-minutes', '0.1', '--target', target, '--out', out]);

    assert.notEqual(result.status, 0, 'a pass with no readable run must not exit successfully');
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ timedOut: boolean; collectionError: string | null }>;
    };
    assert.equal(summary.runs[0]?.timedOut, true, 'the deadline, not a signal, is what marks a run timed out');
    assert.match(`${summary.runs[0]?.collectionError}`, /ceiling/);

    workerPid = await readWorkerPid(pidFile);
    assert.ok(workerPid !== null, 'the per-file child recorded its pid');
    assert.equal(await waitForExit(workerPid), true, 'the per-file child must not outlive the ceiling');
    // Proven gone, so there is nothing left to reap — and `waitForExit` only ever held the number.
    // Passing a dead pid to `reap` would signal whatever the OS has since reused it for.
    workerPid = null;
  } finally {
    reap(workerPid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a completed run is not reported as timed out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-nottimeout-'));
  try {
    const out = path.join(dir, 'out');
    const result = runPass(['--runs', '1', '--target', trivialTarget(dir), '--out', out]);

    assert.equal(result.status, 0);
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ timedOut: boolean; collectionError: string | null }>;
    };
    assert.equal(summary.runs[0]?.timedOut, false, 'a run that finished inside its budget did not time out');
    assert.equal(summary.runs[0]?.collectionError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a capture keeps the normalised record and discards the raw TAP', () => {
  // The raw TAP is a full transcript of whatever the suite printed. Once `capture.json` holds the
  // enumerated fields, keeping the transcript retains arbitrary test output for no diagnostic gain.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-capture-'));
  try {
    const target = path.join(dir, 'dies.test.cjs');
    fs.writeFileSync(target, 'process.exit(3);\n');
    const out = path.join(dir, 'out');

    const result = runPass(['--runs', '3', '--target', target, '--out', out]);

    assert.equal(result.status, 0);
    const capture = JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8')) as {
      run: number;
      records: Array<{ parent: { exitCode: number | null } }>;
    };
    assert.equal(capture.run, 1, 'the pass stops at the first capture');
    assert.equal(capture.records[0]?.parent.exitCode, 3, 'and the normalised record carries the exit status');

    assert.ok(!fs.existsSync(path.join(out, 'run1.tap')), 'the raw TAP must not outlive the normalised record');
    assert.ok(fs.existsSync(path.join(out, 'child-logs-run1')), 'the child lifecycle log is enumerated and kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an experiment that runs nothing is refused, not reported clean', () => {
  const runner = path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs');
  const attempt = (runs: string): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [runner, '--runs', runs], {
      cwd: path.resolve(DIAGNOSTICS_DIR, '../..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });

  for (const runs of ['0', '-3', 'twenty']) {
    const result = attempt(runs);
    assert.notEqual(result.status, 0, `--runs ${runs} must not exit successfully`);
    assert.match(`${result.stderr}`, /must be a positive number/, `--runs ${runs} must say why`);
    assert.doesNotMatch(
      `${result.stdout}`,
      /was not observed/,
      'an experiment that never ran must never claim the defect was not observed',
    );
  }
});

test('pass runner: a pass whose every run was unreadable is refused, not reported clean', () => {
  // The report is made unreadable by construction rather than by racing a clock: `run1.tap` is
  // pre-created as a *directory*, so the reporter cannot write it and reading it back raises
  // EISDIR. That is deterministic on every machine, needs no timeout, and leaves nothing running —
  // a fixture that instead outlived a short ceiling would leak the test-file child the runner had
  // already spawned, which survives being killed at one level up.
  //
  // `--target` points the nested run at one trivial file of this test's own making. Without it the
  // run would launch a second copy of the whole API suite against the database the suite running
  // this very test is already using.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-target-'));
  try {
    const trivial = path.join(dir, 'noop.test.cjs');
    fs.writeFileSync(trivial, "require('node:test').test('noop', () => {});\n");
    const out = path.join(dir, 'out');
    fs.mkdirSync(path.join(out, 'run1.tap'), { recursive: true });

    const result = spawnSync(
      process.execPath,
      [
        path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'),
        '--runs', '1',
        '--target', trivial,
        '--out', out,
      ],
      {
        cwd: path.resolve(DIAGNOSTICS_DIR, '../..'),
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );

    assert.notEqual(result.status, 0, 'an unreadable pass must not exit successfully');
    assert.doesNotMatch(`${result.stdout}`, /was not observed/, 'and must not claim the defect was not observed');
    assert.match(`${result.stderr}`, /observed nothing/, 'and must say the pass observed nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: captures a real child termination end to end through the parent reporter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-e2e-'));
  try {
    // Reproduces Signature B's exact shape: the child dies before registering a single test, so
    // the runner has no subtest failure to report and falls back to the bare 'test failed'.
    fs.writeFileSync(path.join(dir, 'dies.test.cjs'), 'process.exit(3);\n');
    const tapPath = path.join(dir, 'report.tap');
    const logDir = path.join(dir, 'child-logs');
    fs.mkdirSync(logDir, { recursive: true });

    const run = spawnSync(
      process.execPath,
      [
        '--require', PRELOAD_PATH,
        '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
        '--test', 'dies.test.cjs',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        // NODE_TEST_CONTEXT is set in this process because a test runner spawned it. Inheriting it
        // would tell the nested Node it is already a test child, so it would never act as a runner.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, SIGB_LOG_DIR: logDir },
      },
    );

    assert.notEqual(run.status, 0, 'the runner must report the file as failed');

    const records = correlator.correlate(
      correlator.parseTapFailures(fs.readFileSync(tapPath, 'utf8')),
      correlator.readChildLogs(logDir),
    );

    assert.equal(records.length, 1, 'the file-level failure is correlated');
    assert.equal(
      records[0]?.parent.exitCode,
      3,
      'the exit code the spec reporter would have discarded is recovered from the parent',
    );
    assert.equal(records[0]?.parent.signal, null, 'Windows reports no signal for a self-terminating child');
    assert.ok(typeof records[0]?.child.pid === 'number', 'the child that died is identified by PID');
    assert.ok(
      records[0]?.child.kinds.includes('process.exit'),
      'and its own log agrees with the parent about how it went',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: a missing child log from one directory is never falsely matched to a child in another directory', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-nodup-'));
  try {
    // Only bar/a.test.js logged; foo/a.test.js died before writing any log
    const lines = [
      { kind: 'start', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'preload-installed', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'exit', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-single.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent reports dist-test/test/foo/a.test.js failed.
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/foo/a.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(
      resolved[0]?.child.logFound,
      false,
      'a file in foo/ must not claim the log of a different file in bar/ just because the basename matches',
    );
    assert.equal(resolved[0]?.child.pid, null, 'no PID may be attributed to the unlogged file');
    assert.deepEqual(resolved[0]?.child.kinds, [], 'no lifecycle events may be falsely attributed');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: classifies signed negative 32-bit NTSTATUS codes identically to unsigned equivalents', () => {
  // NTSTATUS 0xC0000005 in 32-bit signed two's complement is -1073741819 (unsigned 3221225477)
  const signedViolation = correlator.classifyTermination({ exitCode: -1073741819, signal: null });
  assert.equal(signedViolation.id, 'native-access-violation');
  assert.equal(signedViolation.specific, true);

  // Unmeasured NTSTATUS 0xC0000022 in 32-bit signed is -1073741790
  const signedUnmeasured = correlator.classifyTermination({ exitCode: -1073741790, signal: null });
  assert.equal(signedUnmeasured.id, 'ntstatus-unmeasured');
  assert.equal(signedUnmeasured.specific, false);
});

test('correlator: parses TAP failure blocks with double-quoted or unquoted YAML values', () => {
  const doubleQuoted = [
    '# Subtest: dist-test/test/foo.test.js',
    'not ok 1 - dist-test/test/foo.test.js',
    '  ---',
    '  duration_ms: 123.4',
    '  failureType: "testCodeFailure"',
    '  exitCode: 1',
    '  signal: ~',
    '  error: "test failed"',
    '  code: "ERR_TEST_FAILURE"',
    '  ...',
  ].join('\n');

  const unquoted = [
    '# Subtest: dist-test/test/bar.test.js',
    'not ok 2 - dist-test/test/bar.test.js',
    '  ---',
    '  duration_ms: 234.5',
    '  failureType: testCodeFailure',
    '  exitCode: 134',
    '  signal: ~',
    '  error: test failed',
    '  code: ERR_TEST_FAILURE',
    '  ...',
  ].join('\n');

  const dqFailures = correlator.parseTapFailures(doubleQuoted);
  assert.equal(dqFailures.length, 1);
  assert.equal(dqFailures[0]?.file, 'dist-test/test/foo.test.js');
  assert.equal(dqFailures[0]?.exitCode, 1);
  assert.equal(dqFailures[0]?.failureType, 'testCodeFailure');

  const uqFailures = correlator.parseTapFailures(unquoted);
  assert.equal(uqFailures.length, 1);
  assert.equal(uqFailures[0]?.file, 'dist-test/test/bar.test.js');
  assert.equal(uqFailures[0]?.exitCode, 134);
  assert.equal(uqFailures[0]?.failureType, 'testCodeFailure');

  const singleQuoted = [
    '# Subtest: dist-test/test/baz.test.js',
    'not ok 3 - dist-test/test/baz.test.js',
    '  ---',
    '  duration_ms: \'345.6\'',
    '  failureType: \'testCodeFailure\'',
    '  exitCode: \'1\'',
    '  signal: ~',
    '  error: \'test failed\'',
    '  code: \'ERR_TEST_FAILURE\'',
    '  ...',
  ].join('\n');

  const sqFailures = correlator.parseTapFailures(singleQuoted);
  assert.equal(sqFailures.length, 1);
  assert.equal(sqFailures[0]?.file, 'dist-test/test/baz.test.js');
  assert.equal(sqFailures[0]?.exitCode, 1);
  assert.equal(sqFailures[0]?.durationMs, 345.6);
  assert.equal(sqFailures[0]?.failureType, 'testCodeFailure');
});

test('correlator: path suffix matching for Windows-origin paths is case-insensitive across platforms', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-case-'));
  try {
    const lines = [
      { kind: 'start', pid: 333, testFile: 'C:\\Repo\\Dist-Test\\Test\\Studies-Api.Test.js' },
      { kind: 'preload-installed', pid: 333, testFile: 'C:\\Repo\\Dist-Test\\Test\\Studies-Api.Test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-case.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent uses lower-case path
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.pid, 333, 'casing difference must not prevent matching for Windows-origin paths');
    assert.equal(resolved[0]?.child.logFound, true);
    assert.equal(resolved[0]?.child.ambiguous, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: isWindowsPath identifies Windows drive letters and UNC paths without false-positive on POSIX backslash filenames', () => {
  assert.equal(correlator.isWindowsPath('C:/repo/test.js'), true);
  assert.equal(correlator.isWindowsPath('C:\\repo\\test.js'), true);
  assert.equal(correlator.isWindowsPath('d:/repo/test.js'), true);
  assert.equal(correlator.isWindowsPath('//server/share/test.js'), false);
  assert.equal(correlator.isWindowsPath('\\\\server\\share\\test.js'), true);
  assert.equal(correlator.isWindowsPath('/home/runner/repo/test.js'), false);
  assert.equal(correlator.isWindowsPath('/home/runner/repo/weird\\name.test.js'), false);
  assert.equal(correlator.isWindowsPath('weird\\name.test.js'), false);
  assert.equal(correlator.isWindowsPath('dist-test/test.js'), false);
});

test('correlator: POSIX paths preserve case sensitivity regardless of analyzer host OS', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-posix-case-'));
  try {
    const lines = [
      { kind: 'start', pid: 555, testFile: 'dist-test/test/studies-api.test.js' },
      { kind: 'preload-installed', pid: 555, testFile: 'dist-test/test/studies-api.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-posix.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent uses different casing on a purely POSIX relative path
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('Dist-Test/Test/Studies-Api.Test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.logFound, false, 'case mismatch on POSIX paths must not match');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: relative backslash-delimited Windows child path matches case-insensitively across platforms', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-relwin-'));
  try {
    const lines = [
      { kind: 'start', pid: 444, testFile: 'Dist-Test\\Test\\Studies-Api.Test.js', isWindows: true },
      { kind: 'preload-installed', pid: 444, testFile: 'Dist-Test\\Test\\Studies-Api.Test.js', isWindows: true },
    ];
    fs.writeFileSync(path.join(logDir, 'run-relwin.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent uses lower-case forward-slash path
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.pid, 444, 'relative backslash-delimited child path must match case-insensitively');
    assert.equal(resolved[0]?.child.logFound, true);
    assert.equal(resolved[0]?.child.ambiguous, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: POSIX paths with backslashes in filenames preserve filename structure and case sensitivity', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-posix-backslash-'));
  try {
    const lines = [
      { kind: 'start', pid: 666, testFile: '/home/runner/repo/dist-test/test/weird\\name.test.js' },
      { kind: 'preload-installed', pid: 666, testFile: '/home/runner/repo/dist-test/test/weird\\name.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-posix-bs.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    assert.equal(correlator.normalizePath('/home/runner/repo/dist-test/test/weird\\name.test.js'), '/home/runner/repo/dist-test/test/weird\\name.test.js');

    // Matching with correct case
    const matchOk = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/weird\\name.test.js', '1')),
      logs,
    );
    assert.equal(matchOk.length, 1);
    assert.equal(matchOk[0]?.child.pid, 666);
    assert.equal(matchOk[0]?.child.logFound, true);

    // Mismatched case must not match on POSIX
    const matchCaseFail = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/Weird\\name.test.js', '1')),
      logs,
    );
    assert.equal(matchCaseFail.length, 1);
    assert.equal(matchCaseFail[0]?.child.logFound, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: readChildLogs aggregates casing variants of the same Windows child file into a single entry', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-case-aggregate-'));
  try {
    const lines = [
      { kind: 'start', pid: 777, testFile: 'C:\\Repo\\Dist-Test\\Test\\Studies-Api.Test.js' },
      { kind: 'preload-installed', pid: 777, testFile: 'c:\\repo\\dist-test\\test\\studies-api.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-case-agg.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Both lines must aggregate into one entry rather than creating conflicting entries
    assert.equal(logs.size, 1);

    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.pid, 777);
    assert.equal(resolved[0]?.child.logFound, true);
    assert.equal(resolved[0]?.child.ambiguous, false, 'casing variants of the same child must not cause ambiguity');
    assert.deepEqual(resolved[0]?.child.kinds, ['start', 'preload-installed']);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: parseTapFailures rejects non-finite exitCode and duration_ms scalars', () => {
  const nonFiniteTap = [
    'TAP version 13',
    '# Subtest: dist-test/test/non-finite.test.js',
    'not ok 1 - dist-test/test/non-finite.test.js',
    '  ---',
    '  duration_ms: Infinity',
    '  failureType: testCodeFailure',
    '  exitCode: Infinity',
    '  signal: ~',
    '  error: test failed',
    '  code: ERR_TEST_FAILURE',
    '  ...',
    '# Subtest: dist-test/test/neg-infinity.test.js',
    'not ok 2 - dist-test/test/neg-infinity.test.js',
    '  ---',
    '  duration_ms: -Infinity',
    '  failureType: testCodeFailure',
    '  exitCode: -Infinity',
    '  signal: ~',
    '  error: test failed',
    '  code: ERR_TEST_FAILURE',
    '  ...',
    '# Subtest: dist-test/test/nan.test.js',
    'not ok 3 - dist-test/test/nan.test.js',
    '  ---',
    '  duration_ms: NaN',
    '  failureType: testCodeFailure',
    '  exitCode: NaN',
    '  signal: ~',
    '  error: test failed',
    '  code: ERR_TEST_FAILURE',
    '  ...',
  ].join('\n');

  const failures = correlator.parseTapFailures(nonFiniteTap);
  assert.equal(failures.length, 3);
  assert.equal(failures[0]?.exitCode, null);
  assert.equal(failures[0]?.durationMs, null);
  assert.equal(failures[1]?.exitCode, null);
  assert.equal(failures[1]?.durationMs, null);
  assert.equal(failures[2]?.exitCode, null);
  assert.equal(failures[2]?.durationMs, null);
});

test('correlator: POSIX parent path with backslash filename does not falsely match Windows child path with directory segments', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-posix-parent-win-child-'));
  try {
    // Windows child log where 'weird' is a directory and 'name.test.js' is the file
    const lines = [
      { kind: 'start', pid: 888, testFile: 'C:\\repo\\dist-test\\test\\weird\\name.test.js' },
      { kind: 'preload-installed', pid: 888, testFile: 'C:\\repo\\dist-test\\test\\weird\\name.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-win-child.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // POSIX parent failure where 'weird\name.test.js' is a single filename in 'test/'
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/weird\\name.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.logFound, false, 'POSIX parent path with backslash in filename must not match Windows child directory segments');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: relative backslash-delimited Windows parent path matches Windows child path with Windows platform context', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-relwin-parent-'));
  try {
    const lines = [
      { kind: 'start', pid: 999, testFile: 'C:\\repo\\dist-test\\test\\foo.test.js' },
      { kind: 'preload-installed', pid: 999, testFile: 'C:\\repo\\dist-test\\test\\foo.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-win.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent uses backslash-delimited relative path with explicit Windows platform context
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test\\test\\foo.test.js', '1'), { isWindows: true }),
      logs,
      { isWindows: true },
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.pid, 999, 'relative Windows backslash parent must match Windows child');
    assert.equal(resolved[0]?.child.logFound, true);
    assert.equal(resolved[0]?.child.ambiguous, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: correlates bare string failures with normalized null parent fields', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-string-failure-'));
  try {
    const lines = [
      { kind: 'start', pid: 777, testFile: '/home/runner/repo/dist-test/test/studies-api.test.js' },
      { kind: 'preload-installed', pid: 777, testFile: '/home/runner/repo/dist-test/test/studies-api.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-str.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    const resolved = correlator.correlate(['dist-test/test/studies-api.test.js'], logs);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.file, 'dist-test/test/studies-api.test.js');
    assert.equal(resolved[0]?.parent.exitCode, null);
    assert.equal(resolved[0]?.parent.signal, null);
    assert.equal(resolved[0]?.parent.failureType, null);
    assert.equal(resolved[0]?.parent.durationMs, null);
    assert.equal(resolved[0]?.child.pid, 777);
    assert.equal(resolved[0]?.child.logFound, true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: CLI derives capture platform from child logs without relying on analyzer host platform', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-cli-platform-'));
  try {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);
    const tapPath = path.join(tmpDir, 'test.tap');

    // Windows capture: child log contains Windows metadata
    const winChild = [
      { kind: 'start', pid: 4321, testFile: 'C:\\repo\\dist-test\\test\\windows-target.test.js', isWindows: true },
      { kind: 'preload-installed', pid: 4321, testFile: 'C:\\repo\\dist-test\\test\\windows-target.test.js', isWindows: true },
    ];
    fs.writeFileSync(path.join(logDir, 'run-win.jsonl'), `${winChild.map((l) => JSON.stringify(l)).join('\n')}\n`);

    // TAP failure has backslash-delimited relative path
    fs.writeFileSync(tapPath, tapFailure('dist-test\\test\\windows-target.test.js', '1'));

    const run = (extraArgs: string[] = []): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [CORRELATE_PATH, '--tap', tapPath, '--child-logs', logDir, ...extraArgs], {
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });

    // Run CLI without explicit platform flag: must derive Windows from child logs
    const resultAuto = run();
    assert.equal(resultAuto.status, 0);
    const linesAuto = String(resultAuto.stdout).trim().split('\n').filter(Boolean);
    assert.equal(linesAuto.length, 1);
    const recordAuto = JSON.parse(linesAuto[0]);
    assert.equal(recordAuto.child.pid, 4321, 'CLI must derive Windows capture from child log metadata');
    assert.equal(recordAuto.child.logFound, true);

    // Overriding with --posix forces POSIX semantics (where backslash in relative path does not match)
    const resultPosix = run(['--posix']);
    assert.equal(resultPosix.status, 0);
    const linesPosix = String(resultPosix.stdout).trim().split('\n').filter(Boolean);
    assert.equal(linesPosix.length, 1);
    const recordPosix = JSON.parse(linesPosix[0]);
    assert.equal(recordPosix.child.logFound, false, '--posix flag must override and preserve POSIX backslash semantics');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('correlator: CLI preserves POSIX semantics when log directory contains mixed or stale Windows logs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-cli-mixed-'));
  try {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir);
    const tapPathCasing = path.join(tmpDir, 'casing.tap');
    const tapPathExact = path.join(tmpDir, 'exact.tap');

    // Mixed logs: a stale Windows child log and a POSIX child log
    const staleWinChild = [
      { kind: 'start', pid: 1111, testFile: 'C:\\stale\\dist-test\\test\\stale.test.js', isWindows: true },
      { kind: 'preload-installed', pid: 1111, testFile: 'C:\\stale\\dist-test\\test\\stale.test.js', isWindows: true },
    ];
    const posixChild = [
      { kind: 'start', pid: 2222, testFile: '/repo/dist-test/test/posix-target.test.js', isWindows: false },
      { kind: 'preload-installed', pid: 2222, testFile: '/repo/dist-test/test/posix-target.test.js', isWindows: false },
    ];
    fs.writeFileSync(path.join(logDir, 'run-stale-win.jsonl'), `${staleWinChild.map((l) => JSON.stringify(l)).join('\n')}\n`);
    fs.writeFileSync(path.join(logDir, 'run-posix.jsonl'), `${posixChild.map((l) => JSON.stringify(l)).join('\n')}\n`);

    // TAP failure 1: uppercase POSIX path (should NOT match lowercase posix-target when case-sensitive)
    fs.writeFileSync(tapPathCasing, tapFailure('dist-test/test/POSIX-TARGET.test.js', '1'));
    // TAP failure 2: exact lowercase POSIX path
    fs.writeFileSync(tapPathExact, tapFailure('dist-test/test/posix-target.test.js', '1'));

    const run = (tap: string, extraArgs: string[] = []): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [CORRELATE_PATH, '--tap', tap, '--child-logs', logDir, ...extraArgs], {
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });

    // Without explicit flags, mixed logs must NOT force Windows semantics globally; POSIX case-sensitivity is preserved
    const resultCasing = run(tapPathCasing);
    assert.equal(resultCasing.status, 0);
    const linesCasing = String(resultCasing.stdout).trim().split('\n').filter(Boolean);
    assert.equal(linesCasing.length, 1);
    const recordCasing = JSON.parse(linesCasing[0]);
    assert.equal(recordCasing.child.logFound, false, 'mixed logs must not force Windows case folding onto POSIX paths');

    // Exact casing matches the POSIX child correctly
    const resultExact = run(tapPathExact);
    assert.equal(resultExact.status, 0);
    const linesExact = String(resultExact.stdout).trim().split('\n').filter(Boolean);
    assert.equal(linesExact.length, 1);
    const recordExact = JSON.parse(linesExact[0]);
    assert.equal(recordExact.child.logFound, true);
    assert.equal(recordExact.child.pid, 2222);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('correlator: a stale log from an earlier run is never merged into a later run\'s evidence', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-stale-'));
  try {
    // Two runs of the SAME file, in one directory. That is not a contrivance: the preload defaults
    // SIGB_LOG_DIR to os.tmpdir()/sigb-diag, which is its documented manual usage and which nothing
    // ever cleans, and the correlator CLI takes --child-logs pointed at whatever a reader chose.
    const clean = ['start', 'preload-installed', 'beforeExit', 'exit'].map((kind) => ({
      kind, pid: 1111, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js',
    }));
    const terminated = ['start', 'preload-installed'].map((kind) => ({
      kind, pid: 2222, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js',
    }));
    fs.writeFileSync(path.join(logDir, 'run-1111-1000.jsonl'), `${clean.map((l) => JSON.stringify(l)).join('\n')}\n`);
    fs.writeFileSync(path.join(logDir, 'run-2222-2000.jsonl'), `${terminated.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const records = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      correlator.readChildLogs(logDir),
      { isWindows: true },
    );

    assert.equal(records.length, 1);
    // The failure this guards against is not cosmetic. Concatenating the two processes' events puts
    // `exit` in the list, and `narrowFromChildEvidence` then states that an external termination and
    // a native fault are ruled out — a false negative on the one hypothesis still standing.
    assert.equal(records[0]?.child.ambiguous, true, 'two processes ran this file; neither one is the evidence');
    assert.equal(records[0]?.child.candidates, 2);
    assert.deepEqual(records[0]?.child.kinds, [], 'events from two different processes must never be concatenated');
    assert.equal(records[0]?.narrowed, false);
    assert.doesNotMatch(
      String(records[0]?.statement),
      /rules out an external termination/,
      'a stale log must never be allowed to rule out the mechanism under investigation',
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: reads a child fatal banner from the report Node routes it to, not the parent stderr', () => {
  // Measured this session on a real bounded V8 heap exhaustion: the parent runner's stderr was zero
  // bytes, while the TAP report carried the whole banner as `# ` diagnostic lines. Node's runner
  // attaches a readline Interface to each child's stderr and re-emits every line as a `test:stderr`
  // report event, so the parent's own stderr structurally cannot hold a child's fatal output.
  const tapText = [
    'TAP version 13',
    '# <--- Last few GCs --->',
    '# FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    '# ----- Native stack trace -----',
    tapFailure('dist-test/test/studies-api.test.js', '134'),
    '1..1',
  ].join('\n');

  assert.deepEqual(
    correlator.fatalMarkersIn(tapText),
    ['FATAL ERROR:', 'JavaScript heap out of memory', '<--- Last few GCs --->', '----- Native stack trace -----'],
    'the markers that name a V8 fatal must be recoverable from the reporter output',
  );
  assert.deepEqual(correlator.fatalMarkersIn(''), [], 'an empty stream names nothing');
  assert.deepEqual(correlator.fatalMarkersIn(undefined), [], 'a missing stream names nothing');
});

test('pass runner: a capture keeps the fatal markers that name the mechanism', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-markers-'));
  try {
    // `fs.writeSync(2, ...)` rather than `process.stderr.write`: stderr is a pipe here, its writes
    // are asynchronous, and an exit on the next line would race them away — which would make this
    // test flake for a reason that has nothing to do with what it is checking.
    const target = path.join(dir, 'fatal.test.cjs');
    fs.writeFileSync(
      target,
      "require('node:fs').writeSync(2, 'FATAL ERROR: Reached heap limit Allocation failed - " +
        "JavaScript heap out of memory\\n');\nprocess.exit(134);\n",
    );
    const out = path.join(dir, 'out');
    const result = runPass(['--runs', '1', '--max-minutes', '1', '--out', out, '--target', target], dir);

    const capturePath = path.join(out, 'capture.json');
    assert.ok(fs.existsSync(capturePath), `the pass must capture this file-level failure:\n${result.stdout}${result.stderr}`);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { fatalMarkers: string[] };
    assert.deepEqual(
      capture.fatalMarkers,
      ['FATAL ERROR:', 'JavaScript heap out of memory'],
      'the capture must record the banner the child actually printed',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: --package points a pass at another workspace package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-package-'));
  try {
    // Signature B has been observed in packages/persistence as well as packages/api, and a runner
    // that can only ever run one package cannot capture it in the other. The target is resolved
    // inside the named package, so a pass that finds this file at all proves it ran there.
    const pkg = path.join(dir, 'other-package');
    fs.mkdirSync(pkg, { recursive: true });
    trivialTarget(pkg);
    const out = path.join(dir, 'out');
    const result = runPass(['--runs', '1', '--max-minutes', '1', '--out', out, '--package', pkg, '--target', 'noop.test.cjs'], dir);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(String(result.stdout), /1 run\(s\)/);
    assert.match(String(result.stdout), /Signature B was not observed/);
    // A pass whose runner failed to start still prints that summary: zero captures is what a run
    // that never ran also produces. The runner's own exit status is what separates them, and it is
    // also what catches a preload this file could no longer resolve from the other package's
    // directory — `node --require <missing>` exits non-zero before any test runs.
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ runnerExitCode: number | null; collectionError: string | null }>;
    };
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0]?.runnerExitCode, 0, 'the run must have executed, preload and all');
    assert.equal(summary.runs[0]?.collectionError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: a fatal banner from an earlier file is not attributed to a later file\'s failure', () => {
  // A whole-run scan cannot survive this suite's own diagnostics: the pass runner lets a child's
  // `spec` output through to the terminal, so a test that deliberately prints a fatal banner puts
  // that banner into the outer run's report. Measured while hunting a real occurrence — every full
  // `packages/api` run reported two fatal markers that this file had printed itself. Under
  // `--test-concurrency=1` the child that printed them is the one whose result comes next, so
  // attribution is exact rather than a guess.
  const tapText = [
    'TAP version 13',
    '# FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    '# <--- Last few GCs --->',
    '# Subtest: dist-test/test/noisy.test.js',
    'ok 1 - dist-test/test/noisy.test.js',
    '  ---',
    '  duration_ms: 10',
    '  ...',
    tapFailure('dist-test/test/studies-api.test.js', '134').replace('not ok 1 -', 'not ok 2 -'),
    '1..2',
  ].join('\n');

  const failures = correlator.parseTapFailures(tapText, { isWindows: false });

  assert.equal(failures.length, 1, 'only the bare file-level failure is a candidate');
  assert.deepEqual(
    failures[0]?.fatalMarkers,
    [],
    'the banner belongs to the file that printed it, which passed, not to the file that failed later',
  );
});

test('correlator: a fatal banner printed by the file that then failed is attributed to it', () => {
  const tapText = [
    'TAP version 13',
    '# Subtest: dist-test/test/quiet.test.js',
    'ok 1 - dist-test/test/quiet.test.js',
    '  ---',
    '  duration_ms: 10',
    '  ...',
    '# <--- Last few GCs --->',
    '# FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    tapFailure('dist-test/test/studies-api.test.js', '134').replace('not ok 1 -', 'not ok 2 -'),
    '1..2',
  ].join('\n');

  const failures = correlator.parseTapFailures(tapText, { isWindows: false });

  assert.equal(failures.length, 1);
  assert.deepEqual(
    failures[0]?.fatalMarkers,
    ['FATAL ERROR:', 'JavaScript heap out of memory', '<--- Last few GCs --->'],
    'a banner printed after the previous file finished belongs to the file that failed next',
  );
});

test('pass runner: a diagnostic report separates a real V8 fatal from a status that merely looks like one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-report-'));
  try {
    // Exit code 134 is produced by a V8 heap exhaustion, by `process.abort()`, and by any process
    // that chooses to exit 134 — measured all three this session. Node writes a diagnostic report
    // for the first and not for the others, and names the file after the pid that died, so the
    // report is what tells them apart even when nothing was printed.
    const reportDir = path.join(dir, 'reports');
    fs.mkdirSync(reportDir);
    const fatal = path.join(dir, 'oom.cjs');
    // Bounded by construction: a 64 MB ceiling and an allocation loop that stops at 400 MB of
    // intent, so this can never reach for the host's real memory.
    fs.writeFileSync(fatal, 'const held = [];\nfor (let i = 0; i < 400; i++) held.push(new Array(131072).fill(i));\n');
    const crashed = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', '--report-on-fatalerror', `--report-directory=${reportDir}`, fatal],
      { encoding: 'utf8', timeout: 60_000 },
    );

    assert.ok(
      diedOfAFault(crashed.status, crashed.signal),
      `a heap exhaustion must abort, however this platform reports it (status ${crashed.status}, signal ${crashed.signal})`,
    );
    const reports = fs.readdirSync(reportDir);
    assert.equal(reports.length, 1, 'a V8 fatal writes exactly one report');
    assert.ok(
      reports[0]?.includes(`.${crashed.pid}.`),
      `the report must name the process that died (pid ${crashed.pid}, got ${reports[0]})`,
    );

    // The same status, chosen deliberately rather than reached by a fault, writes none.
    const quietDir = path.join(dir, 'quiet-reports');
    fs.mkdirSync(quietDir);
    const chosen = path.join(dir, 'chosen.cjs');
    fs.writeFileSync(chosen, 'process.exit(134);\n');
    const exited = spawnSync(
      process.execPath,
      ['--report-on-fatalerror', `--report-directory=${quietDir}`, chosen],
      { encoding: 'utf8', timeout: 60_000 },
    );

    assert.equal(exited.status, 134, 'a chosen exit status is the same number on every platform');
    assert.equal(exited.signal, null, 'and it is an exit, not an abort');
    assert.deepEqual(fs.readdirSync(quietDir), [], 'choosing the status of a fault is not a fault');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: exit 134 alone names nothing, and the capture carries what separates the two', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-capture-reports-'));
  try {
    // Two files that die with the SAME status by different means. A capture that could not tell them
    // apart would be the whole defect this instrumentation exists to fix, so the test runs both
    // through the real pass runner and asserts the pair of channels that separates them.
    //
    // First: a genuine V8 heap exhaustion. The ceiling reaches the child through NODE_OPTIONS, and
    // is bounded by construction — 80 MB, with the allocation loop stopping at 400 MB of intent —
    // so this can never reach for the host's real memory.
    const oom = path.join(dir, 'oom.test.cjs');
    fs.writeFileSync(oom, 'const held = [];\nfor (let i = 0; i < 400; i++) held.push(new Array(131072).fill(i));\n');
    const oomOut = path.join(dir, 'oom-out');
    const oomResult = spawnSync(
      process.execPath,
      [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), '--runs', '1', '--max-minutes', '2', '--out', oomOut, '--target', oom],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '--max-old-space-size=80' } },
    );
    const oomCapturePath = path.join(oomOut, 'capture.json');
    assert.ok(fs.existsSync(oomCapturePath), `a heap exhaustion must be captured:\n${oomResult.stdout}${oomResult.stderr}`);
    const fatal = JSON.parse(fs.readFileSync(oomCapturePath, 'utf8')) as {
      reportFiles: string[];
      fatalMarkers: string[];
      records: Array<{ parent: { exitCode: number | null; signal: string | null }; child: { kinds: string[] } }>;
    };

    assert.ok(
      diedOfAFault(fatal.records[0]?.parent.exitCode, fatal.records[0]?.parent.signal),
      `the child must have aborted (exitCode ${fatal.records[0]?.parent.exitCode}, signal ${fatal.records[0]?.parent.signal})`,
    );
    assert.deepEqual(fatal.records[0]?.child.kinds, ['start', 'preload-installed'],
      'a V8 fatal runs no JS exit path, which is why the status alone cannot name it');
    assert.ok(fatal.fatalMarkers.includes('JavaScript heap out of memory'),
      `the banner must be recovered from the report Node routed it to, got ${JSON.stringify(fatal.fatalMarkers)}`);
    assert.equal(fatal.reportFiles.length, 1, 'a V8 fatal writes exactly one diagnostic report');

    // Second: the same status, chosen rather than suffered. Neither channel fires.
    const chosen = path.join(dir, 'chosen.test.cjs');
    fs.writeFileSync(chosen, 'process.exit(134);\n');
    const chosenOut = path.join(dir, 'chosen-out');
    const chosenResult = runPass(['--runs', '1', '--max-minutes', '1', '--out', chosenOut, '--target', chosen], dir);
    const chosenCapturePath = path.join(chosenOut, 'capture.json');
    assert.ok(fs.existsSync(chosenCapturePath), `${chosenResult.stdout}${chosenResult.stderr}`);
    const quiet = JSON.parse(fs.readFileSync(chosenCapturePath, 'utf8')) as {
      reportFiles: string[];
      fatalMarkers: string[];
      records: Array<{ parent: { exitCode: number | null; signal: string | null } }>;
    };

    assert.equal(quiet.records[0]?.parent.exitCode, 134, 'a chosen status, identical on every platform');
    assert.equal(quiet.records[0]?.parent.signal, null, 'and reached by exiting, not by aborting');
    assert.deepEqual(quiet.fatalMarkers, [], 'nothing was printed');
    assert.deepEqual(quiet.reportFiles, [], 'and no report was written, which is what tells them apart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: a marker inside an earlier failure\'s own report is not attributed to the next file', () => {
  // A TAP point line is followed by that test's YAML block, so anchoring the region to the point
  // line alone leaves the previous failure's whole body inside the next failure's region. A suite
  // that asserts on a formatter, or that fails with a message quoting one of these banners, would
  // then hand that banner to whichever file failed next. The region has to start after the block
  // ends, and only Node's own `# ` diagnostic lines count as a child's output.
  const tapText = [
    'TAP version 13',
    '# Subtest: dist-test/test/formatter.test.js',
    'not ok 1 - dist-test/test/formatter.test.js',
    '  ---',
    '  duration_ms: 5',
    "  failureType: 'subtestsFailed'",
    "  error: 'expected FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'",
    '  ...',
    'a bare line mentioning <--- Last few GCs ---> that Node never emitted as a diagnostic',
    tapFailure('dist-test/test/studies-api.test.js', '134').replace('not ok 1 -', 'not ok 2 -'),
    '1..2',
  ].join('\n');

  const failures = correlator.parseTapFailures(tapText, { isWindows: false });

  assert.equal(failures.length, 1, 'the first block failed a subtest, so only the second is a candidate');
  assert.deepEqual(
    failures[0]?.fatalMarkers,
    [],
    'neither an earlier failure\'s report body nor an undiagnosed bare line is this file\'s banner',
  );
});

test('correlator: two runs that reused one pid are not merged into a single process', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-pidreuse-'));
  try {
    // Bucketing by pid alone is not enough: Windows reuses pids freely, and the preload's default
    // log directory is never cleaned, so the same pid can name two different processes that both
    // ran this file. Merging them puts the earlier run's `exit` into the later run's evidence, which
    // is the false negative the per-process bucketing exists to prevent. Each process writes its own
    // file — `run-<pid>-<ms>.jsonl` — so the file is the identity the pid alone cannot supply.
    const line = (kind: string) => JSON.stringify({
      kind, pid: 1111, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js',
    });
    fs.writeFileSync(
      path.join(logDir, 'run-1111-1000.jsonl'),
      `${['start', 'preload-installed', 'beforeExit', 'exit'].map(line).join('\n')}\n`,
    );
    fs.writeFileSync(
      path.join(logDir, 'run-1111-2000.jsonl'),
      `${['start', 'preload-installed'].map(line).join('\n')}\n`,
    );

    const records = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      correlator.readChildLogs(logDir),
      { isWindows: true },
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.child.ambiguous, true, 'one pid, two processes: neither is the evidence');
    assert.equal(records[0]?.child.candidates, 2);
    assert.deepEqual(records[0]?.child.kinds, []);
    assert.doesNotMatch(
      String(records[0]?.statement),
      /rules out an external termination/,
      'a reused pid must not be allowed to rule out the mechanism under investigation',
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('pass runner: a relative --out belongs to the caller, not to the package being run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-relout-'));
  try {
    // The parent creates and reads the artifact paths itself, while the child resolves the same
    // strings against the package it was pointed at. Left relative, those are two different
    // directories the moment `--package` names anything but this one: the parent would look for a
    // report the child wrote somewhere else, and the pass would report that it could not read its
    // own run.
    const pkg = path.join(dir, 'other-package');
    fs.mkdirSync(pkg, { recursive: true });
    trivialTarget(pkg);
    const result = runPass(
      ['--runs', '1', '--max-minutes', '1', '--out', 'artifacts', '--package', pkg, '--target', 'noop.test.cjs'],
      dir,
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const summaryPath = path.join(dir, 'artifacts', 'summary.json');
    assert.ok(fs.existsSync(summaryPath), 'the artifacts belong beside the caller, not inside the package');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      runs: Array<{ runnerExitCode: number | null; collectionError: string | null }>;
    };
    assert.equal(summary.runs[0]?.collectionError, null, 'the run must be readable, not written out of reach');
    assert.equal(summary.runs[0]?.runnerExitCode, 0);
    assert.ok(!fs.existsSync(path.join(pkg, 'artifacts')), 'nothing may be left inside the package under test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a diagnostic report is attributed to the child that wrote it, and its body is not kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-report-attr-'));
  try {
    // Bounded by construction: an 80 MB ceiling reached through NODE_OPTIONS, and a loop that stops
    // at 400 MB of intent.
    const oom = path.join(dir, 'oom.test.cjs');
    fs.writeFileSync(oom, 'const held = [];\nfor (let i = 0; i < 400; i++) held.push(new Array(131072).fill(i));\n');
    const out = path.join(dir, 'out');
    const result = spawnSync(
      process.execPath,
      [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), '--runs', '1', '--max-minutes', '2', '--out', out, '--target', oom],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '--max-old-space-size=80' } },
    );

    const capturePath = path.join(out, 'capture.json');
    assert.ok(fs.existsSync(capturePath), `${result.stdout}${result.stderr}`);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as {
      records: Array<{ child: { pid: number | null }; reportFiles: string[] }>;
    };

    // A run can hold several failures. A single flat list cannot say which child suffered the fault,
    // which is the only thing the report was collected to say — and Node names each report after the
    // pid that wrote it, so the join needs nothing the capture does not already hold.
    const record = capture.records[0];
    assert.ok(record, 'the heap exhaustion must be captured');
    assert.equal(record.reportFiles.length, 1, `expected one report for this child, got ${JSON.stringify(record.reportFiles)}`);
    assert.ok(
      record.reportFiles[0]?.includes(`.${record.child.pid}.`),
      `the report must name the child that died (pid ${record.child.pid}, got ${record.reportFiles[0]})`,
    );

    // A report body carries the whole command line and every environment variable — DATABASE_URL and
    // its password included. The name is the evidence; the body is a credential file, and it is
    // treated exactly as the raw report transcript is.
    const leftBehind = fs.existsSync(path.join(out, 'reports-run1'))
      ? fs.readdirSync(path.join(out, 'reports-run1'))
      : [];
    assert.deepEqual(leftBehind, [], 'no report body may be retained in the artifacts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: in a run with two failures, the report goes to the child that faulted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-two-'));
  try {
    // The reason per-record attribution exists. Two files die in one run, with the SAME status where
    // this platform reports one: the first suffers a real heap exhaustion, the second simply chooses
    // to leave. Only the first makes Node write a report. A run-level list would hand that report to
    // both records and say the second faulted too, which is the opposite of what it was collected to
    // establish.
    //
    // Bounded by construction: an 80 MB ceiling reached through NODE_OPTIONS, and a loop that stops
    // at 400 MB of intent.
    fs.writeFileSync(
      path.join(dir, 'a-fault.test.cjs'),
      'const held = [];\nfor (let i = 0; i < 400; i++) held.push(new Array(131072).fill(i));\n',
    );
    fs.writeFileSync(path.join(dir, 'b-chosen.test.cjs'), 'process.exit(134);\n');

    const out = path.join(dir, 'out');
    const result = spawnSync(
      process.execPath,
      [
        path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'),
        '--runs', '1', '--max-minutes', '3', '--out', out,
        '--target', path.join(dir, '*.test.cjs'),
      ],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '--max-old-space-size=80' } },
    );

    const capturePath = path.join(out, 'capture.json');
    assert.ok(fs.existsSync(capturePath), `both files must be captured:\n${result.stdout}${result.stderr}`);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as {
      reportFiles: string[];
      records: Array<{
        file: string;
        parent: { exitCode: number | null; signal: string | null };
        child: { pid: number | null };
        reportFiles: string[];
      }>;
    };

    assert.equal(capture.records.length, 2, `expected both files to fail, got ${capture.records.map((r) => r.file).join(', ')}`);
    const faulted = capture.records.find((record) => record.file.includes('a-fault'));
    const chosen = capture.records.find((record) => record.file.includes('b-chosen'));
    assert.ok(faulted && chosen, 'both files must appear in the capture');

    assert.ok(diedOfAFault(faulted.parent.exitCode, faulted.parent.signal), 'the first file must have aborted');
    assert.equal(chosen.parent.exitCode, 134, 'the second file chose the status the first was given');

    assert.equal(faulted.reportFiles.length, 1, `the fault wrote one report, got ${JSON.stringify(faulted.reportFiles)}`);
    assert.ok(
      faulted.reportFiles[0]?.includes(`.${faulted.child.pid}.`),
      `and it names that child (pid ${faulted.child.pid}, got ${faulted.reportFiles[0]})`,
    );
    assert.deepEqual(
      chosen.reportFiles,
      [],
      'the file that merely chose the status wrote nothing, and must not inherit the other file\'s report',
    );
    assert.equal(capture.reportFiles.length, 1, 'the run as a whole still saw exactly one report');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a reused --out cannot lend one pass a previous pass\'s diagnostic report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-stale-report-'));
  try {
    // The same staleness this correlator refuses on the child-log side, on the artifact side. An
    // interrupted pass leaves `reports-run1` behind; a later pass given the same `--out` created the
    // directory without emptying it, so the leftover counted as this run's — and since attribution
    // accepts any filename carrying the pid, a reused pid would let a file that merely chose its
    // exit status inherit a native fault it never suffered.
    const out = path.join(dir, 'out');
    fs.mkdirSync(path.join(out, 'reports-run1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'reports-run1', 'report.19700101.000000.4242.0.001.json'), '{"stale":true}\n');

    const result = runPass(['--runs', '1', '--max-minutes', '1', '--out', out, '--target', trivialTarget(dir)], dir);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ reportFiles: number }>;
    };
    assert.equal(summary.runs[0]?.reportFiles, 0, 'a leftover from an earlier pass is not this run\'s evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: no diagnostic report body survives a run, whatever the run did', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-no-bodies-'));
  try {
    // A report body carries the whole command line and every environment variable, this suite's
    // DATABASE_URL password included. The names are recorded; the bodies must not outlive the run
    // that produced them, on the capture path or any other. Run both kinds and check the artifacts.
    const clean = path.join(dir, 'clean');
    const cleanResult = runPass(['--runs', '1', '--max-minutes', '1', '--out', clean, '--target', trivialTarget(dir)], dir);
    assert.equal(cleanResult.status, 0, `${cleanResult.stdout}${cleanResult.stderr}`);

    const failing = path.join(dir, 'fail-target.test.cjs');
    fs.writeFileSync(failing, 'process.exit(134);\n');
    const captured = path.join(dir, 'captured');
    runPass(['--runs', '1', '--max-minutes', '1', '--out', captured, '--target', failing], dir);
    assert.ok(fs.existsSync(path.join(captured, 'capture.json')), 'the failing target must be captured');

    for (const artifacts of [clean, captured]) {
      const bodies = fs
        .readdirSync(artifacts, { recursive: true, encoding: 'utf8' })
        .filter((entry) => entry.includes('report.') && entry.endsWith('.json'));
      assert.deepEqual(bodies, [], `a report body survived in ${artifacts}: ${JSON.stringify(bodies)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an --out that already holds a capture is refused, not quietly reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-prior-capture-'));
  try {
    // A pass owns its artifact directory: it empties each run's child logs so no earlier run can lend
    // it evidence. That is right for the logs and fatal for a capture — reusing an `--out` would
    // delete the child logs a previous pass captured while leaving its `capture.json` behind, so the
    // directory would end up asserting a termination whose evidence no longer exists.
    //
    // Deleting the old capture instead would be worse: a capture is the rarest artifact this whole
    // diagnostic produces. So the pass refuses, before it creates or spawns anything.
    const out = path.join(dir, 'out');
    fs.mkdirSync(path.join(out, 'child-logs-run1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'capture.json'), '{"run":1,"records":[]}\n');
    // The evidence the capture refers to. It is what a reused `--out` would destroy: the pass
    // empties each run's child logs before running it, so a replacement pass would delete these and
    // leave the capture above pointing at nothing.
    fs.writeFileSync(path.join(out, 'child-logs-run1', 'run-4242-1000.jsonl'), '{"kind":"start","pid":4242}\n');

    const result = runPass(['--runs', '1', '--max-minutes', '1', '--out', out, '--target', trivialTarget(dir)], dir);

    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(String(result.stderr), /capture/i, 'the refusal must say what is in the way');
    assert.ok(!fs.existsSync(path.join(out, 'summary.json')), 'a refused pass must not have run anything');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8')),
      { run: 1, records: [] },
      'and must leave the capture it refused to overwrite exactly as it found it',
    );
    assert.deepEqual(
      fs.readdirSync(path.join(out, 'child-logs-run1')),
      ['run-4242-1000.jsonl'],
      'the capture must still have the child logs it refers to; refusing early is what protects them',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
