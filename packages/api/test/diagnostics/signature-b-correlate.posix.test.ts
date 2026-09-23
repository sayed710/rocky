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
