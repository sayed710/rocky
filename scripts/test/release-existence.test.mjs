/**
 * Tests for scripts/lib/release-existence.mjs and its CLI scripts/release-existence.mjs: release
 * existence is `exists` only on a clean `helm status`, `absent` only on Helm's exact not-found error
 * corroborated by an empty `helm list --all`, and `unknown` otherwise; an uninstall is allowed only
 * when `helm history` is exactly revision 1.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HELM_RELEASE_NOT_FOUND,
  checkOnlyInitialRevision,
  classifyReleaseExistence,
} from '../lib/release-existence.mjs';

const CLI = fileURLToPath(new URL('../release-existence.mjs', import.meta.url));
const NOT_FOUND = 'Error: release: not found';

const absentEvidence = (overrides = {}) => ({
  release: 'gambit',
  statusExitCode: 1,
  statusStderr: `${NOT_FOUND}\n`,
  listExitCode: 0,
  listStdout: '[]\n',
  ...overrides,
});
const state = (evidence) => classifyReleaseExistence(evidence).state;

test('the not-found text is Helm v3.16.3 ErrReleaseNotFound as printed by the CLI', () => {
  assert.equal(HELM_RELEASE_NOT_FOUND, NOT_FOUND);
});

test('helm status exit 0 means exists, whatever else is on stderr and without a list', () => {
  assert.equal(state({ release: 'gambit', statusExitCode: 0, statusStderr: '' }), 'exists');
  assert.equal(state({ release: 'gambit', statusExitCode: 0, statusStderr: 'WARNING: something' }), 'exists');
  assert.equal(state({ release: 'gambit', statusExitCode: 0, statusStderr: NOT_FOUND }), 'exists');
});

test('confirmed absence: exact not-found and an empty list', () => {
  const result = classifyReleaseExistence(absentEvidence());
  assert.equal(result.state, 'absent');
  assert.match(result.reason, /release: not found.*no release named gambit/);
});

test('whitespace and CRLF around the not-found message and the list are tolerated', () => {
  assert.equal(state(absentEvidence({ statusStderr: `\r\n  ${NOT_FOUND}\r\n` })), 'absent');
  assert.equal(state(absentEvidence({ statusStderr: `\t${NOT_FOUND}   ` })), 'absent');
  assert.equal(state(absentEvidence({ listStdout: ' [ ]\r\n' })), 'absent');
});

test('a list naming only other releases (including similar names) is still absence', () => {
  const list = JSON.stringify([
    { name: 'gambit-x', namespace: 'default', revision: '2', status: 'deployed' },
    { name: 'xgambit', namespace: 'default', revision: '1', status: 'failed' },
    { name: 'gambit2', namespace: 'default', revision: '1', status: 'uninstalled' },
  ]);
  assert.equal(state(absentEvidence({ listStdout: list })), 'absent');
});

test('"release: not found" embedded in another error is not absence', () => {
  for (const stderr of [
    'Error: Kubernetes cluster unreachable: release: not found',
    'Error: query: failed to query with labels: release: not found',
    `${NOT_FOUND}: extra`,
    `${NOT_FOUND}.`,
    `WARNING: Kubernetes configuration file is group-readable. This is insecure.\n${NOT_FOUND}`,
    `${NOT_FOUND}\n${NOT_FOUND}`,
    'release: not found',
    'Error: release: Not Found',
    'error: release: not found',
    'Error: release gambit not found',
    'Error:  release: not found',
  ]) {
    assert.equal(state(absentEvidence({ statusStderr: stderr })), 'unknown', stderr);
  }
});

test('API, auth, RBAC, timeout and transport errors are unknown', () => {
  for (const stderr of [
    'Error: Kubernetes cluster unreachable: Get "https://10.0.0.1:6443/version": dial tcp 10.0.0.1:6443: connect: connection refused',
    'Error: Unauthorized',
    'Error: query: failed to query with labels: secrets is forbidden: User "x" cannot list resource "secrets"',
    'Error: context deadline exceeded',
    'Error: net/http: TLS handshake timeout',
  ]) {
    const result = classifyReleaseExistence(absentEvidence({ statusStderr: stderr }));
    assert.equal(result.state, 'unknown', stderr);
    assert.match(result.reason, /an error other than Helm's not-found error/);
  }
});

test('a failing helm status with empty or whitespace-only stderr is unknown', () => {
  for (const stderr of ['', '   ', '\r\n', undefined, null]) {
    const result = classifyReleaseExistence(absentEvidence({ statusStderr: stderr }));
    assert.equal(result.state, 'unknown');
    assert.match(result.reason, /no error message/);
  }
});

test('not-found without a list, or with a failing list, is unknown', () => {
  assert.equal(state(absentEvidence({ listExitCode: null, listStdout: null })), 'unknown');
  assert.equal(state(absentEvidence({ listExitCode: undefined, listStdout: undefined })), 'unknown');
  assert.equal(state(absentEvidence({ listExitCode: 1 })), 'unknown');
  assert.equal(state(absentEvidence({ listExitCode: 1, listStdout: '' })), 'unknown');
  assert.equal(state(absentEvidence({ listExitCode: '0' })), 'unknown');
  assert.equal(state(absentEvidence({ listExitCode: -1 })), 'unknown');
});

test('not-found with a list naming gambit is a contradiction: unknown', () => {
  for (const entry of [
    { name: 'gambit', namespace: 'default', revision: '4', status: 'deployed' },
    { name: 'gambit', status: 'uninstalled' },
    { name: 'gambit', status: 'pending-install' },
    { name: 'gambit' },
  ]) {
    const result = classifyReleaseExistence(absentEvidence({ listStdout: JSON.stringify([entry]) }));
    assert.equal(result.state, 'unknown');
    assert.match(result.reason, /contradicts/);
  }
  assert.equal(state(absentEvidence({ listStdout: JSON.stringify([{ name: 'other' }, { name: 'gambit' }]) })), 'unknown');
});

test('a list name that only differs from gambit by case or whitespace is unknown', () => {
  assert.equal(state(absentEvidence({ listStdout: '[{"name":"Gambit"}]' })), 'unknown');
  assert.equal(state(absentEvidence({ listStdout: '[{"name":" gambit "}]' })), 'unknown');
});

test('non-JSON or non-array list output is unknown', () => {
  for (const out of ['', 'NAME\tNAMESPACE\tREVISION', 'null', '{}', '"[]"', '[] []', '[', '0', 'true']) {
    assert.equal(state(absentEvidence({ listStdout: out })), 'unknown', JSON.stringify(out));
  }
  assert.equal(state(absentEvidence({ listStdout: null })), 'unknown');
});

test('list entries with odd shapes are unknown', () => {
  for (const out of ['[null]', '[1]', '["gambit"]', '[[]]', '[{}]', '[{"name":1}]', '[{"name":null}]', '[{"Name":"gambit"}]']) {
    assert.equal(state(absentEvidence({ listStdout: out })), 'unknown', out);
  }
});

test('invalid evidence is unknown', () => {
  assert.equal(state(absentEvidence({ statusExitCode: '1' })), 'unknown');
  assert.equal(state(absentEvidence({ statusExitCode: -1 })), 'unknown');
  assert.equal(state(absentEvidence({ statusExitCode: 1.5 })), 'unknown');
  assert.equal(state(absentEvidence({ statusExitCode: undefined })), 'unknown');
  assert.equal(state(absentEvidence({ release: '' })), 'unknown');
  assert.equal(state(absentEvidence({ release: '^gambit$' })), 'unknown');
});

test('reasons are bounded and single-line', () => {
  const huge = `${'x'.repeat(5000)}\nsecond line`;
  const { reason } = classifyReleaseExistence(absentEvidence({ listStdout: huge }));
  assert.ok(reason.length < 600, `reason is ${reason.length} chars`);
  assert.ok(!/[\r\n]/.test(reason));
});

test('only-initial-revision accepts exactly one revision 1', () => {
  assert.deepEqual(checkOnlyInitialRevision([{ revision: 1, status: 'deployed' }]), { ok: true });
  assert.deepEqual(checkOnlyInitialRevision([{ revision: '1', status: 'failed' }]), { ok: true });
});

test('only-initial-revision rejects anything else', () => {
  for (const history of [
    [],
    [{ revision: 1, status: 'superseded' }, { revision: 2, status: 'deployed' }],
    [{ revision: 1, status: 'deployed' }, { revision: 1, status: 'deployed' }],
    [{ revision: 2, status: 'deployed' }],
    [{ revision: '01', status: 'deployed' }],
    [{ revision: 1.0000001, status: 'deployed' }],
    [{ status: 'deployed' }],
    [null],
    [1],
    [[{ revision: 1 }]],
    { revision: 1 },
    null,
    'x',
  ]) {
    assert.equal(checkOnlyInitialRevision(history).ok, false, JSON.stringify(history));
  }
});

function withFiles(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-existence-'));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], content);
    }
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function classifyCli(statusExit, statusStderr, list) {
  return withFiles({ err: statusStderr, out: list?.stdout ?? '' }, (p) => {
    const args = [CLI, 'classify', '--release', 'gambit', '--status-exit', statusExit, '--status-stderr', p.err];
    if (list) args.push('--list-exit', list.exit, '--list-stdout', p.out);
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
  });
}

test('CLI classify prints the state and a single-line reason', () => {
  let r = classifyCli('0', '');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^release_existence=exists\nrelease_existence_reason=.+\n$/);
  r = classifyCli('1', `${NOT_FOUND}\r\n`, { exit: '0', stdout: '[]\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^release_existence=absent\n/);
  r = classifyCli('1', 'Error: Unauthorized\nmore', { exit: '0', stdout: '[]' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^release_existence=unknown\nrelease_existence_reason=[^\n]*not-found error[^\n]*\n$/);
  r = classifyCli('1', NOT_FOUND);
  assert.match(r.stdout, /^release_existence=unknown\n/);
});

test('CLI classify usage errors exit 2 and print no state', () => {
  for (const [exit, list] of [['x', undefined], ['01', undefined], ['-1', undefined], ['1', { exit: 'x', stdout: '[]' }]]) {
    const r = classifyCli(exit, NOT_FOUND, list);
    assert.equal(r.status, 2, `${exit} ${JSON.stringify(list)}`);
    assert.equal(r.stdout, '');
  }
  const r = spawnSync(process.execPath, [CLI, 'classify', '--release', 'gambit'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
});

test('CLI classify with an unreadable stderr file fails without printing a state', () => {
  const r = spawnSync(process.execPath, [CLI, 'classify', '--release', 'gambit', '--status-exit', '1', '--status-stderr', join(tmpdir(), 'does-not-exist-release-existence')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('CLI only-initial-revision', () => {
  const ok = spawnSync(process.execPath, [CLI, 'only-initial-revision'], { input: '[{"revision":1,"status":"deployed"}]', encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'initial_install_revision=1\n');
  for (const input of ['', 'Error: boom', '[]', '[{"revision":1},{"revision":2}]', '[{"revision":2}]']) {
    const bad = spawnSync(process.execPath, [CLI, 'only-initial-revision'], { input, encoding: 'utf8' });
    assert.equal(bad.status, 1, input);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^release-existence: [^\n]+\n$/);
  }
  assert.equal(spawnSync(process.execPath, [CLI, 'only-initial-revision', 'x'], { input: '[]', encoding: 'utf8' }).status, 2);
});
