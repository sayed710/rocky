/**
 * Trust analysis has exactly one host (ADR-0152): the dedicated trust worker. The WebSocket gateway
 * refuses the analyzer flags rather than running a copy on every replica, and the worker refuses to
 * start without the database it needs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../src/serve.js', import.meta.url));
const WORKER = fileURLToPath(new URL('../src/trust-worker.js', import.meta.url));

/** Run an entrypoint until it exits; fail the test if it is still running after `ms`. */
function exitOf(script: string, env: Record<string, string>, ms = 15_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} was still running after ${ms} ms:\n${output}`));
    }, ms);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const GATEWAY_ENV = { ACCESS_TOKEN_SECRET: 'x'.repeat(32), PORT: '0', HEALTH_PORT: '0', HOST: '127.0.0.1' };

for (const flag of ['BOT_AUTO_ANALYZE', 'ANTICHEAT_AUTO_ANALYZE']) {
  test(`the gateway refuses to start with ${flag} set, pointing at the trust worker`, async () => {
    const { code, output } = await exitOf(SERVE, { ...GATEWAY_ENV, [flag]: '1' });
    assert.equal(code, 1);
    assert.match(output, new RegExp(`${flag}.*trust worker`));
  });
}

test('the trust worker refuses to start without a database', async () => {
  const { code, output } = await exitOf(WORKER, { BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '0' });
  assert.equal(code, 1);
  assert.match(output, /DATABASE_URL is required/);
});

test('the trust worker refuses anti-cheat analysis without an engine', async () => {
  const { code, output } = await exitOf(WORKER, { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', BOT_AUTO_ANALYZE: '0', ANTICHEAT_AUTO_ANALYZE: '1' });
  assert.equal(code, 1);
  assert.match(output, /requires STOCKFISH_PATH/);
});
