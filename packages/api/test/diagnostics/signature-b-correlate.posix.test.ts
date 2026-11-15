import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTICS_DIR = path.resolve(__dirname, '../../../test/diagnostics');

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
 */
function reap(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Wait for a pid to disappear, or give up.
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

/** A test file that finishes immediately. */
function trivialTarget(dir: string): string {
  const file = path.join(dir, 'noop.test.cjs');
  fs.writeFileSync(file, "require('node:test').test('noop', () => {});\n");
  return file;
}

/** Runs the pass script with a preload injected only into the pass process itself. */
function runPassWithPreload(preloadPath: string, args: string[], cwd?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--require', preloadPath, path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), ...args], {
    cwd: cwd ?? path.resolve(DIAGNOSTICS_DIR, '../..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}

test('pass runner: normal close awaits delayed/stubborn descendant exit before directory cleanup or retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-posix-await-'));
  let descendantPid: number | null = null;
  try {
    const pidFile = path.join(dir, 'descendant.pid');
    const eventsFile = path.join(dir, 'events.jsonl');
    const target = path.join(dir, 'stubborn.test.cjs');
    const workerCode =
      "const fs = require('node:fs');\n" +
      "process.on('SIGTERM', () => {});\n" +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      'setTimeout(() => {}, 30000);\n';

    fs.writeFileSync(
      target,
      "const { spawn } = require('node:child_process');\n" +
        "const fs = require('node:fs');\n" +
        "const { test } = require('node:test');\n" +
        `test('spawns stubborn descendant on run 1', async () => {\n` +
        `  if (fs.existsSync(${JSON.stringify(pidFile)})) return;\n` +
        `  spawn(process.execPath, ['-e', ${JSON.stringify(workerCode)}], { stdio: 'ignore' }).unref();\n` +
        `  for (let i = 0; i < 200 && !fs.existsSync(${JSON.stringify(pidFile)}); i++) {\n` +
        '    await new Promise((r) => setTimeout(r, 25));\n' +
        '  }\n' +
        '});\n',
    );

    const spy = path.join(dir, 'delay-kill-spy.cjs');
    fs.writeFileSync(
      spy,
      "const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');\n" +
        "const { syncBuiltinESMExports } = require('node:module');\n" +
        `const pidFile = ${JSON.stringify(pidFile)}, eventsFile = ${JSON.stringify(eventsFile)};\n` +
        'const origKill = process.kill.bind(process), origRm = fs.rmSync.bind(fs), origSpawn = cp.spawn;\n' +
        'const deliverAt = new Map();\n' +
        'function alive() {\n' +
        `  try { const p = Number(fs.readFileSync(pidFile, 'utf8').trim()); origKill(p, 0); return true; } catch { return false; }\n` +
        '}\n' +
        'function record(op, dirName) {\n' +
        "  fs.appendFileSync(eventsFile, JSON.stringify({ op, dirName, descendantAlive: alive() }) + '\\n');\n" +
        '}\n' +
        'process.kill = (pid, sig) => {\n' +
        "  if (typeof pid === 'number' && pid < 0 && sig === 'SIGKILL' && !deliverAt.has(pid)) {\n" +
        '    deliverAt.set(pid, Date.now() + 200);\n' +
        "    setTimeout(() => { try { origKill(pid, 'SIGKILL'); } catch {} }, 200).unref();\n" +
        '  }\n' +
        '  if (typeof pid === \'number\' && pid < 0 && Date.now() < (deliverAt.get(pid) ?? 0)) return origKill(pid, 0);\n' +
        '  return origKill(pid, sig);\n' +
        '};\n' +
        'fs.rmSync = (targetPath, opts) => {\n' +
        '  const base = path.basename(String(targetPath));\n' +
        "  if (base === 'child-logs-run1' || base === 'reports-run1') record('rmSync', base);\n" +
        '  return origRm(targetPath, opts);\n' +
        '};\n' +
        'cp.spawn = function patchedSpawn(cmd, args, opts) {\n' +
        "  if (String(opts?.env?.SIGB_LOG_DIR ?? '').endsWith('child-logs-run2')) record('spawn-run2', 'run2');\n" +
        '  return origSpawn.call(this, cmd, args, opts);\n' +
        '};\n' +
        'syncBuiltinESMExports();\n',
    );

    const out = path.join(dir, 'out');
    const result = runPassWithPreload(spy, ['--runs', '2', '--max-minutes', '1', '--target', target, '--out', out], dir);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    descendantPid = await readWorkerPid(pidFile, 2_000);
    assert.ok(descendantPid !== null, 'stubborn descendant recorded its pid');
    assert.equal(await waitForExit(descendantPid), true, 'stubborn descendant must exit');
    descendantPid = null;

    const events = fs
      .readFileSync(eventsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; dirName: string; descendantAlive: boolean });
    assert.ok(events.some((e) => e.op === 'rmSync' && e.dirName === 'reports-run1'));
    assert.ok(events.some((e) => e.op === 'rmSync' && e.dirName === 'child-logs-run1'));
    assert.ok(events.some((e) => e.op === 'spawn-run2'));
    for (const event of events) {
      assert.equal(event.descendantAlive, false, `descendant was still alive at ${JSON.stringify(event)}`);
    }
  } finally {
    reap(descendantPid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: POSIX group cleanup handles zombies and fails closed on EPERM or unverified state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-posix-failclosed-'));
  try {
    const target = trivialTarget(dir);
    const makeSpy = (name: string, body: string): string => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      return p;
    };

    // 1. EPERM on signaling process group fails closed without retrying.
    const epermSpy = makeSpy(
      'eperm-spy.cjs',
      'const origKill = process.kill.bind(process);\n' +
        'process.kill = (pid, sig) => {\n' +
        "  if (typeof pid === 'number' && pid < 0 && sig === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EPERM' });\n" +
        '  return origKill(pid, sig);\n' +
        '};\n',
    );
    const epermOut = path.join(dir, 'eperm-out');
    const epermRes = runPassWithPreload(epermSpy, ['--runs', '2', '--max-minutes', '1', '--target', target, '--out', epermOut], dir);
    assert.notEqual(epermRes.status, 0);
    assert.doesNotMatch(String(epermRes.stdout), /was not observed/);
    const epermSummary = JSON.parse(fs.readFileSync(path.join(epermOut, 'summary.json'), 'utf8')) as {
      runs: Array<{ collectionError: string | null }>;
    };
    assert.equal(epermSummary.runs.length, 1);
    assert.match(String(epermSummary.runs[0]?.collectionError), /EPERM/);

    // 2. Positively identified zombie-only group (e.g. unreaped in a container) completes cleanly.
    const psSpyScript = (psStdout: string): string =>
      "const cp = require('node:child_process');\n" +
      "const { syncBuiltinESMExports } = require('node:module');\n" +
      'const origKill = process.kill.bind(process), origSpawnSync = cp.spawnSync;\n' +
      'let pgid = null;\n' +
      'process.kill = (pid, sig) => {\n' +
      "  if (typeof pid === 'number' && pid < 0) { pgid = -pid; if (sig === 'SIGKILL') { try { origKill(pid, 'SIGKILL'); } catch {} } return true; }\n" +
      '  return origKill(pid, sig);\n' +
      '};\n' +
      'cp.spawnSync = function patchedSpawnSync(cmd, args, opts) {\n' +
      `  if (cmd === 'ps' && pgid !== null) { const out = (${psStdout})(pgid); return { pid: 0, output: [null, out, ''], stdout: out, stderr: '', status: 0, signal: null }; }\n` +
      '  return origSpawnSync.call(this, cmd, args, opts);\n' +
      '};\n' +
      'syncBuiltinESMExports();\n';

    const zombieSpy = makeSpy('zombie-spy.cjs', psSpyScript('(pgid) => `${pgid} Z\\n`'));
    const zombieRes = runPassWithPreload(zombieSpy, ['--runs', '1', '--max-minutes', '1', '--target', target, '--out', path.join(dir, 'z-out')], dir);
    assert.equal(zombieRes.status, 0, `${zombieRes.stdout}${zombieRes.stderr}`);

    // 3. Unverified group (kill(-pgid, 0) succeeds but ps sees no entries) fails closed without retrying.
    const unverifiedOut = path.join(dir, 'u-out');
    const unverifiedSpy = makeSpy('unverified-spy.cjs', psSpyScript("() => ''"));
    const unverifiedRes = runPassWithPreload(unverifiedSpy, ['--runs', '2', '--max-minutes', '1', '--target', target, '--out', unverifiedOut], dir);
    assert.notEqual(unverifiedRes.status, 0);
    assert.doesNotMatch(String(unverifiedRes.stdout), /was not observed/);
    const unverifiedSummary = JSON.parse(fs.readFileSync(path.join(unverifiedOut, 'summary.json'), 'utf8')) as {
      runs: Array<{ collectionError: string | null }>;
    };
    assert.equal(unverifiedSummary.runs.length, 1);
    assert.match(String(unverifiedSummary.runs[0]?.collectionError), /did not exit within/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: interrupting the pass takes the detached test tree with it', async () => {
  // Detaching the run is what makes its group killable, and it is also what stops a terminal Ctrl-C
  // reaching it: the runner is no longer in the foreground process group. Without the handlers this
  // asserts, interrupting a pass would leave node --test and every per-file worker running against
  // the suite database.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-signal-'));
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

    let workerPid: number | null = null;
    const pass = spawn(
      process.execPath,
      [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), '--runs', '1', '--target', target, '--out', path.join(dir, 'out')],
      { cwd: path.resolve(DIAGNOSTICS_DIR, '../..'), env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: 'ignore' },
    );

    try {
      // Wait for the worker to have written a usable pid, so the interrupt has something to clean
      // up and the liveness probe addresses the worker rather than this process group.
      workerPid = await readWorkerPid(pidFile);
      assert.ok(workerPid !== null, 'the per-file worker started and recorded its pid');

      pass.kill('SIGTERM');
      await new Promise((resolve) => pass.on('close', resolve));

      assert.equal(
        await waitForExit(workerPid),
        true,
        'the detached per-file worker must not survive the interrupted pass',
      );
      // Same reason as the ceiling test: once the pid is proven gone it belongs to nobody, and
      // reaping it later could kill an unrelated process the OS gave that number to.
      workerPid = null;
    } finally {
      // Two ways this test could leak the tree it started: the worker never appears, so the
      // assertion throws before the interrupt is sent; or the cleanup being asserted did not happen,
      // so the worker is still sleeping. Both are covered here rather than in the happy path.
      pass.kill('SIGKILL');
      reap(workerPid);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: interrupt shares cleanup owner, signals once, awaits exit before rmSync, and skips next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-sigorder-'));
  let workerPid: number | null = null;
  try {
    const pidFile = path.join(dir, 'child.pid');
    const eventsFile = path.join(dir, 'events.jsonl');
    const target = path.join(dir, 'blocks.test.cjs');
    fs.writeFileSync(
      target,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        "require('node:test').test('blocks', async () => { await new Promise((r) => setTimeout(r, 30000)); });\n",
    );
    const spy = path.join(dir, 'sig-spy.cjs');
    fs.writeFileSync(
      spy,
      "const fs = require('node:fs'), path = require('node:path');\n" +
        `const pidFile = ${JSON.stringify(pidFile)}, eventsFile = ${JSON.stringify(eventsFile)};\n` +
        'const origKill = process.kill.bind(process), origRm = fs.rmSync.bind(fs);\n' +
        'let sigkillCount = 0; const deliverAt = new Map();\n' +
        'function alive() { try { origKill(Number(fs.readFileSync(pidFile, "utf8").trim()), 0); return true; } catch { return false; } }\n' +
        'process.kill = (pid, sig) => {\n' +
        "  if (typeof pid === 'number' && pid < 0 && sig === 'SIGKILL') {\n" +
        '    sigkillCount += 1;\n' +
        '    if (!deliverAt.has(pid)) {\n' +
        '      deliverAt.set(pid, Date.now() + 150);\n' +
        "      setTimeout(() => { try { origKill(pid, 'SIGKILL'); } catch {} }, 150).unref();\n" +
        '    }\n' +
        '  }\n' +
        "  if (typeof pid === 'number' && pid < 0 && Date.now() < (deliverAt.get(pid) ?? 0)) return origKill(pid, 0);\n" +
        '  return origKill(pid, sig);\n' +
        '};\n' +
        'fs.rmSync = (targetPath, opts) => {\n' +
        '  const base = path.basename(String(targetPath));\n' +
        "  if (base === 'reports-run1' && fs.existsSync(String(targetPath))) {\n" +
        "    fs.appendFileSync(eventsFile, JSON.stringify({ op: 'rmSync', base, workerAlive: alive(), sigkillCount }) + '\\n');\n" +
        '  }\n' +
        '  return origRm(targetPath, opts);\n' +
        '};\n',
    );
    const out = path.join(dir, 'out');
    let stdout = '';
    const pass = spawn(
      process.execPath,
      ['--require', spy, path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), '--runs', '2', '--target', target, '--out', out],
      { cwd: path.resolve(DIAGNOSTICS_DIR, '../..'), env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pass.stdout?.on('data', (c) => {
      stdout += c;
    });
    try {
      workerPid = await readWorkerPid(pidFile);
      assert.ok(workerPid !== null, 'worker started');
      pass.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => pass.on('close', resolve));
      assert.equal(code, 143);
      assert.equal(await waitForExit(workerPid), true);
      workerPid = null;
      assert.doesNotMatch(stdout, /was not observed|observed nothing/);
      assert.ok(!fs.existsSync(path.join(out, 'child-logs-run2')), 'must not start run 2 after SIGTERM');
      assert.ok(!fs.existsSync(path.join(out, 'reports-run1')), 'activeReportDir must be removed after exit');
      const events = fs
        .readFileSync(eventsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { op: string; workerAlive: boolean; sigkillCount: number });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.workerAlive, false, 'reports-run1 must not be removed while worker is still live');
      assert.equal(events[0]?.sigkillCount, 1, 'shared cleanup owner must signal -pgid at most once');
    } finally {
      pass.kill('SIGKILL');
      reap(workerPid);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an existing group-readable --out is secured or refused', () => {
  // `mkdirSync`'s mode applies only when it creates the directory, so an existing `--out` keeps
  // whatever permissions it had — and a captured run's artifacts would land in a shared directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-perm-'));
  try {
    const out = path.join(dir, 'shared');
    fs.mkdirSync(out, { recursive: true });
    fs.chmodSync(out, 0o777);

    const result = runPass(['--runs', '1', '--target', trivialTarget(dir), '--out', out]);

    assert.equal(result.status, 0, 'a securable directory is narrowed rather than refused');
    assert.equal(fs.statSync(out).mode & 0o077, 0, 'and it is owner-only before anything is written into it');
    assert.match(`${result.stdout}`, /narrowed/, 'and the narrowing is stated rather than done silently');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
