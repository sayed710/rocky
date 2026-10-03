import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatewayTestPlan, runGatewayTests, dockerServiceUrl } from '../run-gateway-tests.mjs';
import { verifyGatewaySignalRoute, classifyTestFile } from '../check-test-topology.mjs';

const env = { DATABASE_URL: 'postgres://chess:chess@127.0.0.1:55433/chess_test', REDIS_URL: 'redis://localhost:56380' };
const file = 'services/gateway/test/trust-worker-entrypoint.integration.test.ts';
const source = readFileSync(file, 'utf8');

test('Windows routes exactly one complete suite to real Linux, while Linux runs it directly', () => {
  const windows = gatewayTestPlan('win32', env, 'test:image');
  assert.equal(windows.length, 2);
  assert.ok(windows.every((step) => step.command === 'docker'));
  assert.deepEqual(windows[0].args, ['build', '--platform=linux/amd64', '-f', 'Dockerfile.gateway-test', '-t', 'test:image', '.']);
  assert.deepEqual(windows[1].args, ['run', '--rm', '--platform=linux/amd64', '-e', 'DATABASE_URL=postgres://chess:chess@host.docker.internal:55433/chess_test', '-e', 'REDIS_URL=redis://host.docker.internal:56380', 'test:image']);
  assert.deepEqual(gatewayTestPlan('linux', env, 'unused'), [{ command: 'npm', args: ['run', 'test:runtime'] }]);
  assert.equal(dockerServiceUrl('postgres://u:p@db.example:5432/chess_test'), 'postgres://u:p@db.example:5432/chess_test');
  assert.throws(() => gatewayTestPlan('win32', {}, 'test'), /DATABASE_URL is required/);
  assert.throws(() => gatewayTestPlan('linux', { DATABASE_URL: env.DATABASE_URL }, 'test'), /REDIS_URL is required/);
});

test('unavailable Docker, failed builds, failed tests and signal termination cannot report success', () => {
  assert.throws(() => runGatewayTests('win32', env, () => ({ error: new Error('Docker unavailable') })), /Docker unavailable/);
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }]) {
    const calls = [];
    assert.equal(runGatewayTests('win32', env, (command, args) => {
      calls.push([command, args]);
      return args[0] === 'image' ? { status: 0 } : result;
    }), 1);
    assert.equal(calls.filter(([, args]) => args[0] === 'run').length, 0, 'a failed build must not start the test');
  }
  let runs = 0;
  assert.equal(runGatewayTests('win32', env, (_command, args) => {
    if (args[0] === 'run') { runs++; return { status: 1 }; }
    return { status: 0 };
  }), 1);
  assert.equal(runs, 1);
});

test('real signal topology is reachable and eight faulty alternatives fail closed', () => {
  assert.deepEqual(verifyGatewaySignalRoute(), []);
  assert.equal(classifyTestFile(file).isReachable(file), true);
  const mutateSource = (before, after) => {
    assert.ok(source.includes(before));
    assert.ok(verifyGatewaySignalRoute(undefined, { [file]: source.replace(before, after) }).length > 0);
  };
  mutateSource('assert.equal(code, 0, output)', 'assert.ok(code === null || code === 0)'); // 1: null acceptance
  mutateSource("test('the trust worker becomes ready", "test.skip('the trust worker becomes ready"); // 2: skip
  mutateSource('assert.equal(code, 0, output)', ''); // 3: removed exit assertion
  mutateSource("assert.notEqual(process.platform, 'win32'", "assert.equal(process.platform, 'win32'"); // 4: native Windows
  const pkg = JSON.parse(readFileSync('services/gateway/package.json', 'utf8'));
  pkg.scripts['test:runtime'] = pkg.scripts['test:runtime'].replace('**/*.test.js', 'missing/*.test.js');
  assert.ok(verifyGatewaySignalRoute(undefined, { 'services/gateway/package.json': JSON.stringify(pkg) }).length > 0); // 5: discovery
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.ok(verifyGatewaySignalRoute(undefined, { '.github/workflows/ci.yml': ci.replace(/run: npm test(\r?\n\s+working-directory: services\/gateway)/, 'run: npm run lint$1') }).length > 0);
  assert.ok(verifyGatewaySignalRoute(undefined, { '.github/workflows/ci.yml': ci.replace('run-gateway-tests|', '') }).length > 0);
  assert.ok(verifyGatewaySignalRoute(undefined, { '.github/workflows/ci.yml': ci.replace('test/gateway-signal-route\\.test|', '') }).length > 0);
  mutateSource("entry.msg === 'Shutdown signal received; finishing the game in progress'", 'true'); // 6: missing handler proof
  mutateSource("child.kill('SIGTERM')", "child.kill('SIGKILL')"); // 7: forced kill
  pkg.scripts.test = 'node ../../scripts/run-gateway-tests.mjs && npm run test:runtime';
  assert.ok(verifyGatewaySignalRoute(undefined, { 'services/gateway/package.json': JSON.stringify(pkg) }).length > 0); // 8: duplicate conflicting run
});
