#!/usr/bin/env node
/**
 * Bounded reproduction pass for the Signature B failure (ADR-0140 §4): a `packages/api` test-file
 * subprocess that dies with a bare `'test failed'`, no assertion, no stack, and none of its own
 * tests reported.
 *
 * Every run is instrumented on both sides of the process boundary at once:
 *
 * - **Child side** — `signature-b-preload.cjs` is `--require`d into each per-file child and records
 *   which JS lifecycle path, if any, the child took before dying.
 * - **Parent side** — the built-in `tap` reporter writes to a file while `spec` keeps stdout. That
 *   pairing is the point: Node's runner attaches the child's `exitCode` and `signal` to the error it
 *   throws, `spec` discards them (its `formatError` replaces the error with `error.cause`, the bare
 *   string `'test failed'`), and `tap` serializes them into its YAML block. Running both recovers
 *   the exit status without a custom reporter, without patching Node internals, and without changing
 *   what a human sees on stdout. It is also the only place a dying child's own fatal banner
 *   survives: the runner re-emits child stderr as `test:stderr` reporter events, so a heap
 *   exhaustion's `FATAL ERROR:` lands in the report and never on this process's stderr.
 *
 * The pass is **bounded by construction** and stops at the first capture. The wall-clock ceiling is
 * an absolute deadline enforced *during* a run, not merely consulted before starting another, and
 * expiring it kills the whole process tree — `node:test` spawns one child per test file, so killing
 * only the process this script started would leave workers behind on POSIX. It never retries a
 * failed file and never reruns the suite to get a green result — those would hide the defect rather
 * than explain it.
 *
 * Concurrency is **matched, not lowered**: each run passes the same `--test-concurrency=1` that
 * `packages/api`'s own `npm test` passes, so the pass measures the configuration CI and developers
 * actually run, which is the configuration under which every occurrence has been observed. Running
 * it at Node's default parallelism would be a different experiment, not a stricter one.
 *
 * A pass that captures nothing proves nothing beyond "not observed in N runs", and the printed
 * summary says so; a pass containing a run whose report could not be read says it is inconclusive
 * instead.
 *
 * Usage, from `packages/api` (compile first: `npx tsc -p tsconfig.test.json`):
 *
 *     node ./test/diagnostics/run-signature-b-pass.mjs \
 *       [--runs 20] [--max-minutes 45] [--out <dir>] [--target <glob>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { freemem, tmpdir, totalmem } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '../..');
const { correlate, fatalMarkersIn, parseTapFailures, readChildLogs } =
  createRequire(import.meta.url)('./signature-b-correlate.cjs');

/** Every option this script accepts, so one cannot be consumed as another's value. */
const KNOWN_FLAGS = new Set(['runs', 'max-minutes', 'out', 'package', 'target']);

/** Refuse before anything is created or spawned; a usage error must not leave artifacts behind. */
function usageError(message) {
  console.error(message);
  process.exit(2);
}

/**
 * Read one option's value, rejecting an option that was given no value.
 *
 * `--out --target file` must be a usage error rather than a request to create a directory called
 * `--target`, which would then silently write diagnostic artifacts somewhere nobody expects.
 *
 * @param {string} name
 * @param {string|number} fallback
 * @returns {string|number}
 */
const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined) usageError(`--${name} requires a value`);
  if (value.startsWith('--') && KNOWN_FLAGS.has(value.slice(2))) {
    usageError(`--${name} requires a value; got the option ${value}`);
  }
  return value;
};

/**
 * A ceiling that does not describe a real experiment must stop the run, not shrink it.
 *
 * `--runs 0`, a negative value or a typo would otherwise execute nothing and still print that
 * Signature B was not observed — an empty experiment presented as a clean pass, which is the exact
 * dishonesty this whole diagnostic exists to avoid.
 *
 * @param {string} name
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(name, raw, fallback, { integer = false } = {}) {
  if (raw === fallback) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    usageError(`--${name} must be a positive number; got ${JSON.stringify(raw)}`);
  }
  if (integer && !Number.isInteger(value)) {
    usageError(`--${name} must be a whole number of runs; got ${JSON.stringify(raw)}`);
  }
  return value;
}

// `--runs 1.5` would otherwise run twice, exceeding the ceiling the pass just declared. Minutes are
// a duration and are legitimately fractional, so the integer rule belongs to the count alone.
const maxRuns = positiveNumber('runs', flag('runs', 20), 20, { integer: true });
const maxMs = positiveNumber('max-minutes', flag('max-minutes', 45), 45) * 60_000;
// The fallback is computed only when --out is absent: an argument is evaluated before the call,
// so an eager mkdtemp would create an unused directory on every run that supplies its own.
//
// Resolved against THIS process's working directory, because the paths derived from it are used by
// two processes with different ones: this process creates and reads them, while the spawned runner
// resolves the same strings against the package it was pointed at. Left relative, `--out artifacts`
// with `--package ../persistence` would have the child write its report into the other package and
// this process look for it here — a pass that cannot read its own run.
const outDir = path.resolve(flag('out', null) ?? fs.mkdtempSync(path.join(tmpdir(), 'sigb-pass-')));

// What each run executes. The default is the whole compiled suite, which is what reproducing
// Signature B requires; `--target` exists so this script's own tests can point a run at one trivial
// file instead of launching a second copy of the suite against the same database.
const target = flag('target', 'dist-test/test/**/*.test.js');

// Which package a run executes in. Signature B has been observed in `packages/persistence` as well
// as `packages/api`, and a runner that can only ever run one of them cannot capture it in the
// other. Resolved against `packages/api` so `--package ../persistence` reads the way it is written,
// and defaulting to this package so every existing invocation means exactly what it meant before.
const packageDir = path.resolve(API_DIR, String(flag('package', '.')));

/**
 * Make the artifact directory owner-only, or refuse to write into it.
 *
 * `mkdirSync`'s `mode` applies only when the directory is created, so a `--out` that already exists
 * keeps whatever permissions it had — and a captured `run<N>.tap` holds raw suite output. Where
 * POSIX permission bits are meaningful this narrows an existing directory to `0700` and verifies it
 * took, refusing if it did not. **On Windows this guarantee is not offered**: `chmod` there sets
 * only the read-only bit, ACLs are what actually govern access, and claiming a POSIX mode was
 * enforced would be a false statement about the filesystem.
 *
 * @param {string} dir
 */
function ensurePrivateDirectory(dir) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    if (existed) console.log('note: on Windows the artifact directory inherits its ACLs; POSIX modes are not enforced here.');
    return;
  }
  if (!existed) return;
  const before = fs.statSync(dir).mode & 0o777;
  if ((before & 0o077) === 0) return;
  fs.chmodSync(dir, 0o700);
  const after = fs.statSync(dir).mode & 0o777;
  if ((after & 0o077) !== 0) {
    usageError(`--out ${dir} is group/world accessible (mode ${after.toString(8)}) and could not be secured`);
  }
  console.log(`note: narrowed ${dir} from mode ${before.toString(8)} to 700 before writing artifacts.`);
}

ensurePrivateDirectory(outDir);

// A pass owns its artifact directory: it empties each run's child logs so that no earlier run can
// lend it evidence. That is right for the logs and fatal for a capture — reusing an `--out` would
// delete the child logs an earlier pass captured while leaving its `capture.json` behind, and the
// directory would then assert a termination whose evidence no longer exists. Deleting the old
// capture instead would be worse: it is the rarest artifact this produces. So refuse, here, before
// anything is created or spawned.
if (fs.existsSync(path.join(outDir, 'capture.json'))) {
  usageError(`--out ${outDir} already holds a capture from an earlier pass; move it aside or choose another directory`);
}
console.log(`Signature B bounded pass — ceiling ${maxRuns} runs or ${maxMs / 60_000} minutes, stopping at first capture.`);
console.log(`Artifacts: ${outDir}\n`);

/**
 * Kill a run and everything it started, bounded, on either platform.
 *
 * This matters because `node:test` spawns one child process per test file, so the process this
 * script starts is never the only one. Measured on Windows (Node v24.15.0): killing the runner
 * leaves the per-file child already **gone**, because libuv puts spawned processes in a job object
 * that terminates with the parent. POSIX offers no such guarantee — `SIGKILL` to a parent is not
 * delivered to its children, which are reparented and keep running — so the group has to be killed
 * explicitly. `taskkill /T` covers the Windows case anyway rather than relying on the job object.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10_000 });
    } else {
      // Spawned detached, so the child leads its own process group and the negated pid reaches
      // every descendant in it, not just the runner.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone, which is the outcome this wanted */
  }
}

/**
 * Execute one instrumented suite run under an absolute deadline.
 *
 * Asynchronous rather than `spawnSync` because the deadline must be able to act *while* a run is
 * in flight — a hung `node --test` would otherwise block the loop past the declared ceiling — and
 * because killing a tree requires a handle the synchronous API never yields.
 *
 * @param {string} tapPath
 * @param {string} logDir
 * @param {string} reportDir
 * @param {number} budgetMs
 * @returns {Promise<{ status: number|null, signal: string|null, timedOut: boolean, error: Error|null, stderr: string }>}
 */
/**
 * The run currently in flight, so an interrupted pass can take its process tree with it.
 *
 * Detaching the child is what makes the group killable on POSIX, and it is also what stops a
 * terminal `SIGINT` reaching it: Ctrl-C goes to the foreground process group, which the detached
 * runner is no longer in. Without these handlers, interrupting the pass would leave `node --test`
 * and every per-file worker running against the suite database.
 *
 * @type {import('node:child_process').ChildProcess | null}
 */
let activeChild = null;

/**
 * The report directory of the run in flight, for the same reason `activeChild` exists.
 *
 * An interrupt reaches this process between a child writing a report and this script reading and
 * deleting it, and a report body carries the whole command line and every environment variable.
 * Killing the tree without this would leave that file on disk.
 *
 * @type {string | null}
 */
let activeReportDir = null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (activeChild !== null) killTree(activeChild);
    if (activeReportDir !== null) fs.rmSync(activeReportDir, { recursive: true, force: true });
    // 128 + signal number, the conventional shell encoding for "terminated by this signal".
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function runOnce(tapPath, logDir, reportDir, budgetMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--require', path.join(HERE, 'signature-b-preload.cjs'),
        // Node writes one of these, named after the pid that died, when it dies of its OWN fatal
        // error — a V8 heap exhaustion, an internal assertion. Measured here: a heap exhaustion
        // leaves a report, while `process.abort()` and an external kill leave none, and all three
        // can leave exit code 134. The report is therefore what separates a fault Node suffered
        // from a status something else chose, and unlike the printed banner it is attributable to
        // an exact process rather than to a position in the report stream.
        '--report-on-fatalerror', `--report-directory=${reportDir}`,
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
        '--test', '--test-concurrency=1', target,
      ],
      {
        cwd: packageDir,
        env: { ...process.env, SIGB_LOG_DIR: logDir },
        // `spec` goes straight to this terminal, which is the whole point of running it alongside
        // `tap`: the human-facing output must stay exactly what it would be without the diagnostic.
        // Only stderr is captured, and only to test it for known fatal markers.
        stdio: ['ignore', 'inherit', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );

    activeChild = child;
    let stderr = '';
    let timedOut = false;
    child.stderr?.on('data', (chunk) => {
      // Bounded: only the tail can carry a fatal marker, and the suite's own output is unbounded.
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, budgetMs);

    child.on('error', (error) => {
      clearTimeout(deadline);
      activeChild = null;
      resolve({ status: null, signal: null, timedOut, error, stderr });
    });
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      activeChild = null;
      // The runner can exit before its per-file child does (it fails fast when it cannot write its
      // report), and that child, in the same process group, keeps writing logs into the output
      // directory. Reap the group so nothing from this run outlives it: a caller that removes the
      // directory next would otherwise race those writes (ENOTEMPTY), and the next run's logs could
      // be mixed with this one's.
      killTree(child);
      resolve({ status, signal, timedOut, error: null, stderr });
    });
  });
}

const startedAt = Date.now();
const runs = [];
let capture = null;

for (let run = 1; run <= maxRuns; run++) {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= maxMs) {
    console.log(`ceiling reached: ${Math.round(elapsed / 1000)}s elapsed`);
    break;
  }

  const tapPath = path.join(outDir, `run${run}.tap`);
  const logDir = path.join(outDir, `child-logs-run${run}`);
  const reportDir = path.join(outDir, `reports-run${run}`);
  // Emptied, not merely created. `mkdirSync` is happy with a directory that already holds an
  // interrupted pass's artifacts, and this is the same staleness the correlator refuses on the child
  // -log side: a leftover report would be counted as this run's, and since a report is attributed by
  // the pid in its name, a reused pid would let a file that merely chose its exit status inherit a
  // native fault it never suffered.
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  activeReportDir = reportDir;

  const freeBefore = freemem();
  const startedRun = Date.now();
  const result = await runOnce(tapPath, logDir, reportDir, Math.max(1, maxMs - elapsed));
  const durationMs = Date.now() - startedRun;

  // A run whose report cannot be read has not answered the question, and must not be filed next to
  // the runs that did. Reporting it as "zero captures" would let a broken pass look like a quiet one.
  let records = [];
  let collectionError = result.error ? `${result.error.name}: ${result.error.message}` : null;
  if (collectionError === null && result.timedOut) collectionError = 'run exceeded the wall-clock ceiling';
  if (collectionError === null) {
    try {
      const isWin = process.platform === 'win32';
      const tapText = fs.readFileSync(tapPath, 'utf8');
      records = correlate(
        parseTapFailures(tapText, { isWindows: isWin }),
        readChildLogs(logDir),
        { isWindows: isWin },
      );
    } catch (error) {
      collectionError = `${error.name}: ${error.message}`;
    }
  }

  // Names only. A report BODY carries the whole command line and every environment variable — this
  // suite runs with DATABASE_URL and its password in the environment — so the body is never retained
  // and never printed. The name is the whole of the evidence: Node writes one only for a fault it
  // suffered itself, and names it after the pid that died.
  let reportFiles = [];
  try {
    reportFiles = fs.readdirSync(reportDir);
  } catch {
    /* nothing wrote one, which is itself the observation */
  }
  // Deleted here rather than on the way out of a branch, so that a run which is captured, a run
  // which is clean and a run whose report could not be read all leave the same nothing behind.
  fs.rmSync(reportDir, { recursive: true, force: true });
  activeReportDir = null;

  // Attributed to the failure whose child wrote it. A run can hold several failures, and a single
  // flat list cannot say which child suffered the fault — which is the only thing the report was
  // collected to say.
  for (const record of records) {
    const pid = record.child?.pid ?? null;
    record.reportFiles = pid === null ? [] : reportFiles.filter((name) => name.includes(`.${pid}.`));
  }

  const summary = {
    run,
    durationMs,
    runnerExitCode: result.status,
    // Set by this script's own deadline, never inferred from `signal`. A child that terminates
    // itself by signal is not a run that ran out of time, and reporting it as one would misattribute
    // the very kind of termination this diagnostic exists to identify.
    timedOut: result.timedOut,
    freeMemBeforeMb: Math.round(freeBefore / 1048576),
    freeMemAfterMb: Math.round(freemem() / 1048576),
    totalMemMb: Math.round(totalmem() / 1048576),
    captures: records.length,
    reportFiles: reportFiles.length,
    collectionError,
  };
  runs.push(summary);
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ runs }, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `run ${run}: ${Math.round(durationMs / 1000)}s  runnerExit=${result.status}  ` +
      `captures=${records.length}  freeMb ${summary.freeMemBeforeMb}->${summary.freeMemAfterMb}` +
      (collectionError === null ? '' : `  COLLECTION FAILED: ${collectionError}`),
  );

  if (collectionError !== null) {
    console.error(`\nRun ${run} produced no readable diagnostic result. Stopping rather than reporting a clean pass.`);
    process.exitCode = 1;
    break;
  }

  if (records.length > 0) {
    // A child's fatal banner reaches the REPORT, never this process's stderr: the runner reads each
    // child's stderr line by line and re-emits it as a `test:stderr` reporter event. Measured on a
    // real bounded heap exhaustion, this process's stderr held zero bytes while the report held the
    // whole banner. So the markers come from each record's own region of the report, and this
    // process's stderr is recorded separately, as what it actually is: the runner's own.
    const fatalMarkers = [...new Set(records.flatMap((record) => record.fatalMarkers))];
    capture = { run, records, fatalMarkers, reportFiles, runnerStderrMarkers: fatalMarkersIn(result.stderr) };
    fs.writeFileSync(path.join(outDir, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
    // The raw TAP has served its purpose the moment `capture.json` exists — which now includes the
    // fatal markers read out of it, the evidence the first real capture of this investigation lost
    // by looking for them on the parent's stderr instead. It is a full transcript of whatever the
    // suite printed, so keeping it past the normalised record retains arbitrary test output for no
    // diagnostic gain; the child logs stay, being enumerated lifecycle events.
    fs.rmSync(tapPath, { force: true });
    console.log(`\nCAPTURED on run ${run}:\n${records.map((r) => JSON.stringify(r, null, 2)).join('\n')}`);
    console.log(`\nRaw TAP discarded; the normalised record is ${path.join(outDir, 'capture.json')}.`);
    break;
  }

  // A clean run's artifacts answer nothing and would otherwise grow without bound across the pass.
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(tapPath, { force: true });
}

const minutes = Math.round((Date.now() - startedAt) / 60_000);
const unreadable = runs.filter((entry) => entry.collectionError !== null).length;
const readable = runs.length - unreadable;
console.log(`\n${runs.length} run(s), ${minutes} minute(s), ${capture ? 1 : 0} capture(s), ${unreadable} unreadable.`);

// Only a pass that actually observed something may say the defect was not observed. Counting the
// runs that produced a readable report — rather than the runs that were started — covers an empty
// experiment and a wholly unreadable one with the same test, and neither is a clean result.
if (capture) {
  // Only a record whose exit status names something may be described as naming something. An
  // `unclassified` or `inconclusive` capture is still worth having, but saying it names a mechanism
  // would overstate exactly the evidence this diagnostic exists to report precisely.
  const named = capture.records.filter((record) => record.specific);
  console.log(
    named.length > 0
      ? `See capture.json. ${named.length} of ${capture.records.length} record(s) name a candidate mechanism; a candidate is not a cause.`
      : 'See capture.json. No record names a mechanism — the exit status is one no measurement here identifies.',
  );
} else if (readable === 0) {
  console.error('No run produced a readable result, so this pass observed nothing. It is not a clean result.');
  process.exitCode = 1;
} else if (unreadable > 0) {
  console.log('This pass is inconclusive: at least one run produced no readable diagnostic result.');
} else {
  console.log('Signature B was not observed in this pass. That bounds its rate; it does not mean it is fixed.');
}
