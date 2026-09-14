#!/usr/bin/env node
/**
 * Runs the k6 load baseline against a already-running Gambit stack and reports the result against
 * the SLOs in docs/SLO.md.
 *
 * k6 runs from its Docker image rather than as an npm dependency, matching how helm, kubeconform
 * and promtool are already used here — load tooling is not something the application should carry.
 *
 * Exits non-zero when a k6 threshold is breached. Those thresholds ARE the SLOs, so a failure means
 * either the service regressed or the objective was never achievable; both need a human.
 *
 * Usage:
 *   docker compose up -d --build          # or point BASE_URL at any running stack
 *   node scripts/load-test.mjs
 *
 * Env:
 *   BASE_URL   trusted web edge as seen FROM THE CONTAINER (default http://host.docker.internal:3000)
 *   HEALTH_URL trusted web edge as seen from this process  (default http://localhost:3000)
 *   READ_VUS, AUTH_VUS, DURATION   passed through to the scenario
 */

import { K6_IMAGE, fail, readSummaryMetrics, runK6 } from './lib/k6-docker.mjs';
import {
  EVIDENCE_DIR,
  beginEvidence,
  buildEvidence,
  writeEvidence,
} from './lib/run-evidence.mjs';

const SCENARIO = 'deploy/load/scenarios/api-baseline.js';
const EVIDENCE_FILE = 'http-load-evidence.json';

/**
 * The SLO targets, restated here only so the artifact can carry them beside what was measured.
 *
 * They are ENFORCED in `deploy/load/scenarios/api-baseline.js`, where they are the k6 thresholds —
 * these are labels on a number, not a second gate. A summary that records `p99 = 240 ms` and
 * nothing else cannot be read as a pass or a fail by anyone who was not at the terminal.
 */
const SLO_TARGETS = Object.freeze({
  availability: 'http_req_failed rate<0.005 (5xx only)',
  readLatency: 'http_req_duration{scenario:read} p(99)<250ms',
  authLatency: 'http_req_duration{scenario:auth} p(95)<2000ms (not an SLO)',
  authFailures: 'auth_failures rate<0.01',
  readChecks: 'checks{scenario:read} rate>0.999',
});

const baseUrl = process.env['BASE_URL'] ?? 'http://host.docker.internal:3000';
const healthUrl = process.env['HEALTH_URL'] ?? 'http://localhost:3000';

/**
 * Refuse to start against a stack that is not answering.
 *
 * Checked from THIS process via `HEALTH_URL`, while k6 uses `BASE_URL` from inside its container:
 * the two are different views of the same service and are allowed to differ, so this proves the
 * stack is up rather than that k6 can reach it.
 */
async function assertStackIsUp() {
  process.stdout.write(`Checking ${healthUrl}/v1/health ... `);
  try {
    const res = await fetch(`${healthUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) fail(`health returned ${res.status}. Start the stack first: docker compose up -d --build`);
    console.log('up');
  } catch (err) {
    fail(
      `cannot reach the API (${err instanceof Error ? err.message : String(err)}).\n` +
        '  Start it with:  docker compose up -d --build\n' +
        '  Or point HEALTH_URL/BASE_URL at a running stack.',
    );
  }
}

/** Run the HTTP scenario in the pinned k6 image, passing the tunables through as container env. */
function runApiBaseline() {
  return runK6({
    scenario: SCENARIO,
    summaryFile: 'summary.json',
    target: baseUrl,
    env: {
      BASE_URL: baseUrl,
      READ_VUS: process.env['READ_VUS'] || undefined,
      AUTH_VUS: process.env['AUTH_VUS'] || undefined,
      DURATION: process.env['DURATION'] || undefined,
    },
  });
}

/**
 * Print the run against the SLOs it was held to, and return the figures for the evidence envelope.
 *
 * Deliberately does not exit: the caller writes evidence first, so a breached threshold still
 * leaves an artifact explaining what breached.
 */
function report(summaryPath, k6ExitCode) {
  const m = readSummaryMetrics(summaryPath);

  const num = (v) => (typeof v === 'number' ? v : undefined);
  const pct = (v) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(3)}%`);
  const ms = (v) => (v === undefined ? 'n/a' : `${v.toFixed(1)} ms`);

  const failedRate = num(m.http_req_failed?.value ?? m.http_req_failed?.rate);
  const availability = failedRate === undefined ? undefined : 1 - failedRate;

  // Report the SAME series the threshold enforces. The latency SLO is scoped to `scenario:read`;
  // printing the aggregate mixes in the scrypt-bound registration path, which is precisely what
  // splitting the scenarios was meant to prevent — and it is what the first version of this
  // reporter did, quoting 98.29 ms when the SLO-relevant figure was 98.64 ms.
  //
  // p(99) exists at all only because the scenario asks for it via summaryTrendStats; k6's default
  // trend stats stop at p(95).
  const read = m['http_req_duration{scenario:read}'];
  const auth = m['http_req_duration{scenario:auth}'];

  console.log('\n=== Measured against docs/SLO.md ===\n');
  console.log(`  requests:                 ${num(m.http_reqs?.count) ?? 'n/a'}`);
  console.log(`  availability:             ${pct(availability)}   (SLO 99.5%, 5xx only)`);
  console.log('');
  console.log('  read path — the SLO-scoped series:');
  console.log(`    p95:                    ${ms(num(read?.['p(95)']))}`);
  console.log(`    p99:                    ${ms(num(read?.['p(99)']))}   (SLO: 99% under 250 ms)`);
  console.log(`    max:                    ${ms(num(read?.max))}`);
  console.log('');
  console.log('  auth path — separate threshold, scrypt-bound, NOT part of the latency SLO:');
  console.log(`    p95:                    ${ms(num(auth?.['p(95)']))}`);
  const limited = num(m.auth_rate_limited?.value ?? m.auth_rate_limited?.rate);
  if (limited !== undefined) {
    console.log(`    rate-limited:           ${pct(limited)}   (expected: 5/hour/IP, ADR-0013)`);
  }
  console.log('');

  if (k6ExitCode !== 0) {
    console.log('=== Result: THRESHOLD BREACHED ===');
    console.log('A k6 threshold here is an SLO from docs/SLO.md. Either the service regressed, or');
    console.log('the objective was never achievable on this hardware — both need a human decision,');
    console.log('so this exits non-zero rather than recording a number nobody looked at.');
  } else {
    console.log('=== Result: every SLO threshold held ===');
    console.log(`Summary written to ${summaryPath}`);
  }

  return {
    requests: num(m.http_reqs?.count),
    availability,
    readP95Ms: num(read?.['p(95)']),
    readP99Ms: num(read?.['p(99)']),
    readMaxMs: num(read?.max),
    authP95Ms: num(auth?.['p(95)']),
    authRateLimited: limited,
  };
}

/**
 * The k6 summary says what was measured; this says what it was measured against.
 *
 * `results/summary.json` is a metrics blob with no scenario, no timestamp, no target and no
 * verdict, which makes an old one indistinguishable from the run you just did — and makes a number
 * in it unreadable without the console scrollback that produced it.
 */
async function main() {
  const startedAt = new Date();
  const topology = { scenario: SCENARIO, baseUrl, healthUrl };
  const configuration = {
    readVus: Number(process.env['READ_VUS'] ?? 20),
    authVus: Number(process.env['AUTH_VUS'] ?? 3),
    duration: process.env['DURATION'] ?? '30s',
    k6Image: K6_IMAGE,
  };

  // Armed before the first thing that can exit: an unreachable stack, a k6 image that will not
  // pull, or a summary that will not parse all end the process without reaching the write below,
  // and the previous run's artifact has already been cleared by then.
  const fallback = beginEvidence(EVIDENCE_DIR, EVIDENCE_FILE, (exitCode) =>
    buildEvidence({
      harness: 'http-load',
      outcome: 'aborted',
      exitCode,
      startedAt,
      finishedAt: new Date(),
      topology,
      configuration,
      expected: SLO_TARGETS,
      observed: {},
      notes: ['The run ended before it produced a summary, so nothing was measured.'],
    }),
  );

  await assertStackIsUp();
  const { code, summaryPath } = runApiBaseline();
  const observed = report(summaryPath, code);

  const path = writeEvidence(
    EVIDENCE_DIR,
    EVIDENCE_FILE,
    buildEvidence({
      harness: 'http-load',
      outcome: code === 0 ? 'passed' : 'threshold-breached',
      exitCode: code === 0 ? 0 : 1,
      startedAt,
      finishedAt: new Date(),
      topology: { ...topology, summaryFile: summaryPath },
      configuration,
      expected: SLO_TARGETS,
      observed,
      notes: [
        'One host, one dataset, one concurrency level. These figures describe this machine, not ' +
          'the service capacity, and support no claim about scale.',
      ],
    }),
  );
  fallback.markWritten();
  console.log(`Evidence written to ${path}`);

  if (code !== 0) process.exit(1);
}

await main();
