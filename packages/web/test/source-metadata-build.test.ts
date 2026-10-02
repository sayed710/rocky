/**
 * The build half of the source-disclosure contract (ADR-0153), exercised through a real
 * `vite build` with the real `vite.config.ts` rather than by reading the config's text.
 *
 * `source-metadata.test.ts` covers the validation rules; this covers what actually reaches the
 * shipped bundle: that a supplied SHA is embedded, that a local build without one embeds no
 * revision, that a malformed one stops the build, and that nothing but the validated value is
 * carried across from the build environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITE_BIN = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
const SHA = '5d0a20e1a2a6d3f36645ae14cc0d631824b86b93';
// A distinctive value in another VITE_-prefixed variable: it must not appear in the bundle.
const PROBE = 'rookzen-env-probe-7f3a91c2';

interface BuildResult {
  readonly code: number | null;
  readonly output: string;
  readonly bundle: string;
}

async function viteBuild(gitSha: string | undefined): Promise<BuildResult> {
  const outDir = mkdtempSync(join(tmpdir(), 'rookzen-source-build-'));
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_SOURCE_PROBE: PROBE };
  delete env['VITE_GIT_SHA'];
  if (gitSha !== undefined) env['VITE_GIT_SHA'] = gitSha;
  try {
    const { code, output } = await new Promise<{ code: number | null; output: string }>((done, fail) => {
      const child = spawn(process.execPath, [VITE_BIN, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
        cwd: PACKAGE_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      child.on('error', fail);
      child.on('close', (exitCode) => done({ code: exitCode, output: text }));
    });
    let bundle = '';
    if (code === 0) {
      const assets = join(outDir, 'assets');
      for (const name of readdirSync(assets)) {
        if (name.endsWith('.js')) bundle += readFileSync(join(assets, name), 'utf8');
      }
    }
    return { code, output, bundle };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test('the Vite config embeds exactly the validated revision of its build environment', () => {
  const define = (viteConfig as { define?: Record<string, unknown> }).define;
  assert.ok(define, 'vite config declares no `define`');
  // Tests run without VITE_GIT_SHA unless a caller set one; either way the embedded value is the
  // JSON of what `resolveBuildRevision` accepted, never a raw environment string.
  const raw = process.env['VITE_GIT_SHA'];
  const expected = raw === undefined || raw === '' ? 'null' : JSON.stringify(raw.toLowerCase());
  assert.equal(define['__ROOKZEN_SOURCE_REVISION__'], expected);
});

test('vite build: SHA supplied, SHA absent, and SHA malformed', { timeout: 180_000 }, async () => {
  const [stamped, local, malformed] = await Promise.all([
    viteBuild(SHA),
    viteBuild(undefined),
    viteBuild('HEAD'),
  ]);

  // Production-style: the exact revision is in the bundle, and the constant was substituted.
  assert.equal(stamped.code, 0, stamped.output);
  assert.ok(stamped.bundle.includes(SHA), 'a supplied VITE_GIT_SHA must reach the bundle');
  assert.equal(stamped.bundle.includes('__ROOKZEN_SOURCE_REVISION__'), false);

  // Local developer build: still succeeds, and claims no revision.
  assert.equal(local.code, 0, local.output);
  assert.equal(local.bundle.includes(SHA), false, 'an unstamped build must not carry a revision');
  assert.equal(local.bundle.includes('__ROOKZEN_SOURCE_REVISION__'), false);

  // Fail closed: a pipeline that meant to stamp a revision cannot ship a build without one.
  assert.notEqual(malformed.code, 0, 'a malformed VITE_GIT_SHA must fail the build');
  assert.match(malformed.output, /VITE_GIT_SHA must be a full 40- or 64-character hexadecimal Git commit SHA/);

  // Only the validated revision crosses from the environment: no other VITE_* value is embedded.
  for (const { bundle } of [stamped, local]) {
    assert.equal(bundle.includes(PROBE), false, 'unrelated VITE_* variables must stay out of the bundle');
  }
});
