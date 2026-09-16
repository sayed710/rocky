import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const armScript = (dir, body, options = 'undefined') => `
import { existsSync, writeFileSync } from 'node:fs';
import { armFailureEvidence, buildEvidence, clearEvidence, writeEvidence } from ${JSON.stringify(
  pathToFileURL(join(REPO_ROOT, 'scripts/lib/run-evidence.mjs')).href,
)};
const DIR = ${JSON.stringify(dir)};
const FILE = 'evidence.json';
const build = (exitCode) => buildEvidence({
  harness: 'test', outcome: 'aborted', exitCode,
  startedAt: '2026-08-27T10:00:00.000Z', finishedAt: '2026-08-27T10:00:01.000Z',
});
clearEvidence(DIR, FILE);
const fallback = armFailureEvidence(DIR, FILE, build, ${options});
${body}
`;

test('a real SIGTERM leaves the artifact and still terminates by the signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-evidence-'));
  const file = join(dir, 'child.mjs');
  writeFileSync(file, armScript(dir, "console.log('armed');\nsetTimeout(() => {}, 60_000);"), 'utf8');

  const child = spawn(process.execPath, [file], { cwd: REPO_ROOT, encoding: 'utf8' });
  await once(child.stdout, 'data');
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');

  assert.equal(
    signal,
    'SIGTERM',
    'the handler re-raises after writing, so the process still dies BY the signal rather than ' +
      'turning an interrupt into an ordinary exit',
  );
  assert.equal(code, null);
  assert.equal(JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')).exitCode, 143);
});
