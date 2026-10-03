/** Run the single gateway runtime suite; Windows delegates real signal semantics to Linux Docker. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Map loopback service URLs to Docker Desktop's host, retaining credentials and database names. */
export function dockerServiceUrl(value) {
  const url = new URL(value);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  // Other hosts must resolve and be reachable from the Linux engine's network.
  return url.href;
}

/** Explicit routing: one complete suite, no host signal test or second conflicting copy. */
export function gatewayTestPlan(platform, env, image) {
  for (const key of ['DATABASE_URL', 'REDIS_URL']) {
    if (!env[key]) throw new Error(`${key} is required for the complete zero-skip gateway runtime suite.`);
  }
  if (platform !== 'win32') return [{ command: 'npm', args: ['run', 'test:runtime'] }];
  return [
    { command: 'docker', args: ['build', '--platform=linux/amd64', '-f', 'Dockerfile.gateway-test', '-t', image, '.'], cwd: ROOT },
    { command: 'docker', args: ['run', '--rm', '--platform=linux/amd64',
      '-e', `DATABASE_URL=${dockerServiceUrl(env.DATABASE_URL)}`,
      '-e', `REDIS_URL=${dockerServiceUrl(env.REDIS_URL)}`, image] },
  ];
}

/** Fail closed on unavailable Linux runtime, build failures, signal termination or failed assertions. */
export function runGatewayTests(platform = process.platform, env = process.env, run = spawnSync) {
  const image = `rocky-gateway-test:${randomUUID()}`;
  const plan = gatewayTestPlan(platform, env, image);
  if (platform === 'win32') console.log('[gateway] Windows routes the required complete suite to real Linux Docker; no tests are skipped.');
  try {
    for (const step of plan) {
      const result = run(step.command, step.args, { cwd: step.cwd ?? resolve(ROOT, 'services/gateway'), env, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0 || result.signal) return result.status || 1;
    }
    return 0;
  } finally {
    if (platform === 'win32') run('docker', ['image', 'rm', image], { stdio: 'ignore' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runGatewayTests(); }
  catch (error) { console.error(`[gateway] ${error.message}`); process.exitCode = 1; }
}
