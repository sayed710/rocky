/**
 * Tests that the deployment gate check runs when invoked through a symlinked or junctioned path.
 *
 * Node resolves the main module through realpath while process.argv[1] keeps the invoked path, so a
 * plain `import.meta.url === pathToFileURL(process.argv[1]).href` guard skipped every gate (exit 0)
 * under a symlinked checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from '../check-deploy-gates.mjs';

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Creates a directory link to target under a fresh os.tmpdir() directory; returns [link, cleanup]. */
function linkTo(target) {
  const parent = mkdtempSync(join(tmpdir(), 'deploy-gates-link-'));
  const cleanup = () => rmSync(parent, { recursive: true, force: true });
  const link = join(parent, 'linked');
  try {
    symlinkSync(target, link, LINK_TYPE);
  } catch (error) {
    cleanup();
    assert.fail(`cannot create a ${LINK_TYPE} link under ${tmpdir()} in this environment (${error.code ?? error.message}); this test needs one to exercise the symlinked entry point`);
  }
  return [link, cleanup];
}

test('isMainModule matches the invoked path itself', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-gates-main-')));
  try {
    const file = join(dir, 'entry.mjs');
    writeFileSync(file, '');
    assert.equal(isMainModule(pathToFileURL(file).href, file), true);
    assert.equal(isMainModule(pathToFileURL(file).href, join(dir, 'other.mjs')), false);
    assert.equal(isMainModule(pathToFileURL(file).href, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMainModule matches a module invoked through a linked directory', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-gates-main-')));
  try {
    const file = join(dir, 'entry.mjs');
    writeFileSync(file, '');
    const [link, cleanup] = linkTo(dir);
    try {
      // import.meta.url is the realpath'd URL; argv[1] is the path through the link.
      assert.equal(isMainModule(pathToFileURL(file).href, join(link, 'entry.mjs')), true);
      // A missing argv[1] path cannot be resolved and is not the main module.
      assert.equal(isMainModule(pathToFileURL(file).href, join(link, 'missing.mjs')), false);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI runs every gate when invoked through a linked scripts directory', () => {
  const [link, cleanup] = linkTo(SCRIPTS_DIR);
  try {
    const result = spawnSync(process.execPath, [join(link, 'check-deploy-gates.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /=== Deployment gate check ===/, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /=== Results: all deployment gates verified ===/);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  } finally {
    cleanup();
  }
});
