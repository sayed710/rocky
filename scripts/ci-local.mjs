#!/usr/bin/env node
/**
 * Run what CI runs, here.
 *
 * Written on 2026-08-06, when GitHub Actions went into a `major_outage` that lasted long enough to
 * block every merge in the repo: runs stopped being created entirely, so a branch could not be
 * shown green no matter how correct it was. Nothing about that is specific to one outage — a
 * network drop, an exhausted quota, or working on a plane all produce the same "no CI" situation,
 * and the checks themselves have no reason to be unavailable in any of them.
 *
 * The point is PARITY, not a second pipeline. Every command below is copied from
 * `.github/workflows/ci.yml`, and `scripts/check-ci-parity.mjs` fails the build if the two drift —
 * so this cannot quietly become a weaker suite that says "green" while CI would not.
 *
 * The two service-backed jobs need real Postgres and Redis. `docker compose up -d postgres redis`
 * provides both; without them those jobs are reported as SKIPPED, never as passed.
 *
 *   node scripts/ci-local.mjs            # everything available
 *   node scripts/ci-local.mjs --quick    # skip the service-backed jobs
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const QUICK = process.argv.includes('--quick');

/** One CI step: a label, the command, and where it runs. */
const CORE = [
  ['build (dependency order)', 'npm run build'],
  ['typecheck (tsc --noEmit)', 'npm run lint'],
  ['test (node --test)', 'npm test'],
  ['load harness contract', 'npm run test:load-harness'],
  // The workflow invokes the script directly rather than through the npm alias; matched verbatim so
  // the parity check compares like with like.
  ['observability drift', 'node scripts/check-observability-drift.mjs'],
  ['docker build order', 'npm run check:build-order'],
  ['deploy gates', 'npm run check:deploy-gates'],
  ['ADR claims', 'npm run check:adr-claims'],
  ['CI parity', 'npm run check:ci-parity'],
  ['variant parity', 'npm run check:variant-parity'],
  ['engine pin parity', 'npm run check:engine-pin-parity'],
  ['test topology', 'npm run check:test-topology'],
  ['guard script tests', 'npm run test:scripts'],
];

/**
 * CI gives these jobs a service container. Locally they need one already listening, and the
 * credentials differ from Compose's, so the caller supplies the URL through the same environment
 * variable the workflow sets.
 */
const POSTGRES_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const DOCKER_AVAILABLE =
  !QUICK &&
  spawnSync('docker info', {
    stdio: 'ignore',
    shell: true,
    timeout: 5_000,
  }).status === 0;

/**
 * CI gets a brand-new Postgres container per run; a local database keeps whatever the last run left
 * in it, and several of these suites assume they are alone in there — a second run against a dirty
 * database fails on rows the first run inserted, which reads exactly like a regression and is not
 * one. The script will not drop anything (pointing this at a database that matters and having it
 * cleared would be far worse than a confusing failure), so it insists the name say `test` and
 * leaves emptying it to you.
 */
function disposableDatabase(url) {
  if (!url) return false;
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  return /test/i.test(name);
}

const SERVICE_JOBS = [
  {
    name: 'postgres integration (persistence + api)',
    needs: 'DATABASE_URL',
    available: Boolean(POSTGRES_URL) && disposableDatabase(POSTGRES_URL),
    unavailableReason: POSTGRES_URL && !disposableDatabase(POSTGRES_URL)
      ? 'DATABASE_URL does not name a database with "test" in it — these suites need a disposable, empty one'
      : null,
    steps: [
      ['persistence against Postgres', 'npm run test:integration:postgres --workspace @chess-platform/persistence'],
      ['api concurrency against Postgres', 'npm run test:integration:postgres --workspace @chess-platform/api'],
      ['scripts integration against Postgres', 'npm run test:scripts:integration'],
    ],
  },
  {
    name: 'gateway service (build + Redis integration)',
    needs: 'REDIS_URL',
    available: Boolean(REDIS_URL),
    // `services/gateway` is not a workspace, so these run in its own directory — the same thing the
    // workflow expresses with `working-directory`.
    cwd: 'services/gateway',
    steps: [
      ['gateway build', 'npm run build'],
      ['gateway typecheck', 'npm run lint'],
      ['gateway against Redis', 'npm test'],
    ],
  },
  {
    name: 'trusted edge acceptance (real Nginx)',
    needs: 'Docker',
    available: DOCKER_AVAILABLE,
    cwd: 'services/gateway',
    env: { REQUIRE_DOCKER: '1' },
    steps: [
      ['trusted edge through real Nginx', 'npm run test:trusted-edge'],
      ['web delivery caching and compression through real Nginx', 'npm run test:web-delivery'],
    ],
  },
  {
    name: 'posix contract tests (Linux/macOS only)',
    needs: 'POSIX platform',
    available: process.platform !== 'win32',
    steps: [
      ['POSIX API tests', 'npm run test:posix -w @chess-platform/api'],
      ['POSIX load harness tests', 'npm run test:load-harness:posix'],
    ],
  },
];

/**
 * Run one command, streaming its output, and return whether it succeeded.
 *
 * `serviceEnv: false` removes `DATABASE_URL` and `REDIS_URL` from the child's environment. In the
 * workflow only the two service-backed jobs see those variables; the ordinary build/test job does
 * not. Locally you export them once for the whole run, and the suites that skip their integration
 * tests when the variable is absent then stop skipping — so the plain `npm test` step quietly
 * became a different, database-backed suite. That is the opposite of parity, and it is how the
 * first run of this script reported a failure the real CI would never have produced.
 */
function run(command, { cwd, serviceEnv = false, extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (!serviceEnv) {
    delete env['DATABASE_URL'];
    delete env['REDIS_URL'];
  }
  const result = spawnSync(command, { stdio: 'inherit', shell: true, env, ...(cwd ? { cwd } : {}) });
  return result.status === 0;
}

const failed = [];
const skipped = [];

for (const [label, command] of CORE) {
  process.stdout.write(`\n=== ${label} ===\n`);
  if (!run(command)) failed.push(label);
}

for (const job of SERVICE_JOBS) {
  if (QUICK || !job.available) {
    const why = QUICK ? '--quick' : (job.unavailableReason ?? `${job.needs} is not set`);
    skipped.push(`${job.name} (${why})`);
    continue;
  }
  for (const [label, command] of job.steps) {
    process.stdout.write(`\n=== ${label} ===\n`);
    if (!run(command, { cwd: job.cwd, serviceEnv: true, extraEnv: job.env })) failed.push(label);
  }
}

process.stdout.write('\n');
for (const name of skipped) process.stdout.write(`  SKIPPED  ${name}\n`);
for (const name of failed) process.stdout.write(`  FAILED   ${name}\n`);

if (failed.length > 0) {
  process.stdout.write(`\n${failed.length} step(s) failed.\n`);
  process.exit(1);
}

// Skipped is not passed. Say so plainly rather than printing a green line that overstates what ran.
process.stdout.write(
  skipped.length > 0
    ? `\nEverything that ran passed. ${skipped.length} job(s) did NOT run — see SKIPPED above.\n`
    : '\nEverything CI runs passed here.\n',
);
