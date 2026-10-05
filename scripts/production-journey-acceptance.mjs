import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { browserJourney } from './lib/production-journey-browser.mjs';
import { waitForHealth } from './lib/wait-for-health.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = `o09-${randomUUID().slice(0, 8)}`;
const output = resolve(root, 'test-results', 'production-journey', runId);
const override = resolve(output, 'compose.acceptance.yml');
const composeArgs = ['compose', '-p', runId, '-f', resolve(root, 'docker-compose.yml'), '-f', override];
const deadline = Date.now() + 20 * 60_000;
const evidence = { runId, stages: {}, startedAt: new Date().toISOString() };
let browser;
let stageName = 'preflight';
let started = false;
let interrupted = false;
let webPort;
const sensitive = [];
const protect = value => { sensitive.push(value); return value; };
const redact = message => sensitive.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(message));

/** Bound subprocesses by the global deadline; no shell interpolation of identities or SQL. */
function command(binary, args, timeout = 120_000, cleanup = false, extraEnv = {}) {
  const remaining = cleanup ? timeout : Math.min(timeout, deadline - Date.now());
  if (remaining <= 0 || (interrupted && !cleanup)) return Promise.reject(new Error('Global journey deadline or interruption'));
  return new Promise((resolveCommand, reject) => {
    execFile(binary, args, { cwd: root, timeout: remaining, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, WEB_PORT: String(webPort), ...extraEnv } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${binary} ${args.slice(0, 3).join(' ')} failed: ${stderr.slice(-2000) || error.message}`));
      else resolveCommand(stdout.trim());
    });
  });
}
const compose = (...args) => command('docker', [...composeArgs, ...args]);
const stage = name => { stageName = name; console.log(`[O09] ${name}`); };

/** Only an isolated run's database is queried; never manufacture game or rating state. */
async function sql(statement) {
  return compose('exec', '-T', 'postgres', 'psql', '-U', 'gambit', '-d', 'gambit', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement);
}

/** Healthy Compose services plus Gateway's stronger DB/Redis readiness and public API. */
async function ready() {
  const state = JSON.parse(await compose('ps', '--format', 'json', '--no-trunc').then(text => `[${text.split(/\r?\n/).join(',')}]`));
  for (const service of ['postgres', 'redis', 'api', 'gateway', 'trust-worker', 'web']) {
    const container = state.find(row => row.Service === service);
    assert.equal(container?.Health, 'healthy', `${service} is not healthy`);
  }
  await compose('exec', '-T', 'gateway', 'node', '-e', "fetch('http://localhost:4176/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))");
  await waitForHealth(`${evidence.baseURL}/v1/health`, 'public API', { timeoutMs: Math.min(30_000, deadline - Date.now()) });
  await waitForHealth(evidence.baseURL, 'public web', { timeoutMs: Math.min(30_000, deadline - Date.now()) });
}

/** Prove replay via the production applier's metric, without opening its internal port. */
async function replayObserved() {
  const until = Math.min(deadline, Date.now() + 30_000);
  while (Date.now() < until) {
    const metric = await compose('exec', '-T', 'gateway', 'node', '-e', "fetch('http://localhost:4176/metrics').then(r=>{if(!r.ok)throw Error(r.status);return r.text()}).then(t=>console.log(t.split('\\n').filter(l=>l.startsWith('ratings_games_total')&&l.includes('already_applied')).join('\\n')))");
    if (/ratings_games_total\{[^}]*outcome="already_applied"[^}]*\}\s+[1-9]/.test(metric)) {
      evidence.replayMetric = metric;
      return;
    }
    await new Promise(resolvePoll => setTimeout(resolvePoll, 500));
  }
  throw new Error('Production rating applier did not prove already_applied replay');
}

/** Stop all stateful application processes, rewind only the documented ratings cursor, recover. */
async function restart() {
  await compose('stop', 'web', 'gateway', 'api', 'trust-worker');
  await sql("UPDATE rating_checkpoint SET xact_id='0'::xid8, server_ts='-infinity', game_id='00000000-0000-0000-0000-000000000000', updated_at=now()");
  await compose('up', '-d', '--wait', '--wait-timeout', '120');
  await ready();
}

/** Always remove only the newly owned project and volumes, with an independent cleanup budget. */
async function main() {
  await mkdir(output, { recursive: true });
  await writeFile(override, 'services:\n  postgres:\n    ports: !reset []\n  redis:\n    ports: !reset []\n');
  // Choose once: Docker's HostPort=0 can allocate a different endpoint after stop/start.
  webPort = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
  let timer;
  try {
    evidence.baseSHA = await command('git', ['rev-parse', 'origin/main']);
    evidence.head = await command('git', ['rev-parse', 'HEAD']);
    evidence.dirty = Boolean(await command('git', ['status', '--porcelain']));
    evidence.docker = await command('docker', ['version', '--format', '{{.Client.Version}} / {{.Server.Version}}']);
    evidence.compose = await command('docker', ['compose', 'version', '--short']);
    evidence.playwright = createRequire(import.meta.url)('@playwright/test/package.json').version;
    const config = JSON.parse(await compose('config', '--format', 'json'));
    for (const service of ['api', 'gateway', 'trust-worker']) assert.ok(!config.services[service].ports?.length, `${service} is directly published`);
    assert.equal(config.services.web.build.dockerfile, 'Dockerfile.web');
    assert.equal(config.services.api.environment.TRUST_PROXY, '1');
    assert.equal(config.services.gateway.environment.TRUST_PROXY, '1');
    stage('build actual production images');
    // Set before build/start so partial startup failures still clean the owned project.
    started = true;
    await command('docker', [...composeArgs, 'build'], 15 * 60_000);
    stage('start isolated Compose stack');
    await compose('up', '-d', '--wait', '--wait-timeout', '120');
    const port = await compose('port', 'web', '8080');
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    evidence.baseURL = `http://${port}`;
    await ready();
    stage('existing public-edge Compose smoke test');
    await command(process.execPath, [resolve(root, 'scripts/smoke-test.mjs')], 60_000, false, {
      API_URL: evidence.baseURL, WEB_URL: evidence.baseURL, WS_URL: `${evidence.baseURL.replace(/^http:/, 'ws:')}/ws`,
    });
    evidence.stages.smoke = true;
    let rejectDeadline;
    const expired = new Promise((_, reject) => { rejectDeadline = reject; });
    timer = setTimeout(() => { interrupted = true; void browser?.close(); rejectDeadline(new Error('Global browser journey deadline exceeded')); }, Math.max(1, deadline - Date.now()));
    await Promise.race([browserJourney({ baseURL: evidence.baseURL, evidence, stage, restart, replayObserved, protect, setBrowser: value => { browser = value; }, database: async id => {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      return JSON.parse(await sql(`SELECT coalesce(json_agg(r), '[]'::json) FROM (SELECT * FROM rating_applications WHERE game_id='${id}') r`));
    } }), expired]);
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.failure = { stage: stageName, message: redact(error.message) };
    // Do not retain auth-bearing traces, console emails, cookies or full container logs.
    if (started) evidence.containers = await command('docker', [...composeArgs, 'ps', '-a', '--format', 'json'], 15_000, true).catch(error => error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    if (started) {
      try {
        await command('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], 60_000, true);
        evidence.cleanedUp = true;
      } catch (error) {
        evidence.cleanedUp = false;
        evidence.cleanupFailure = error.message;
        evidence.passed = false;
        process.exitCode = 1;
      }
    }
    evidence.completedAt = new Date().toISOString();
    await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`[O09] Evidence: ${resolve(output, 'evidence.json')}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; void browser?.close(); });
main().then(() => {
  assert.equal(evidence.passed, true, evidence.cleanupFailure ?? 'Journey did not pass');
  assert.equal(evidence.cleanedUp, true, 'Owned Compose project was not cleaned up');
  console.log('[O09] PASSED');
}).catch(error => { console.error(`[O09] FAILED: ${redact(error.message)}`); process.exitCode = 1; });
