#!/usr/bin/env node
/** Run test suites through npm and report Node test-runner totals portably with zero-skip auditing. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath is unavailable; run this script through "npm run test:counts"');
  process.exit(1);
}

const HERMETIC_SUITES = [
  ['core', ['test', '--workspace', '@chess-platform/core']],
  ['search', ['test', '--workspace', '@chess-platform/search']],
  ['social', ['test', '--workspace', '@chess-platform/social']],
  ['messaging', ['test', '--workspace', '@chess-platform/messaging']],
  ['community', ['test', '--workspace', '@chess-platform/community']],
  ['achievements', ['test', '--workspace', '@chess-platform/achievements']],
  ['studies', ['test', '--workspace', '@chess-platform/studies']],
  ['learning', ['test', '--workspace', '@chess-platform/learning']],
  ['anti-cheat', ['test', '--workspace', '@chess-platform/anti-cheat']],
  ['game', ['test', '--workspace', '@chess-platform/game']],
  ['tournament', ['test', '--workspace', '@chess-platform/tournament']],
  ['realtime-gateway', ['test', '--workspace', '@chess-platform/realtime-gateway']],
  ['persistence (hermetic unit)', ['test', '--workspace', '@chess-platform/persistence']],
  ['api (hermetic unit)', ['test', '--workspace', '@chess-platform/api']],
  ['engine', ['test', '--workspace', '@chess-platform/engine']],
  ['web (hermetic unit)', ['test', '--workspace', '@chess-platform/web']],
  ['e2e-harness', ['test', '--workspace', '@chess-platform/e2e-harness']],
  ['ai-orchestrator (hermetic unit)', ['test', '--workspace', '@chess-platform/ai-orchestrator']],
  ['ai-features (hermetic unit)', ['test', '--workspace', '@chess-platform/ai-features']],
  ['scripts (hermetic unit)', ['run', 'test:scripts']],
  ['load-harness (hermetic unit)', ['run', 'test:load-harness']],
];

const SERVICE_SUITES = [
  {
    name: 'gateway-service (redis integration)',
    args: ['test', '--prefix', 'services/gateway'],
    envReq: 'REDIS_URL',
    isAvailable: Boolean(process.env.REDIS_URL),
  },
  {
    name: 'persistence (postgres integration)',
    args: ['run', 'test:integration:postgres', '--workspace', '@chess-platform/persistence'],
    envReq: 'DATABASE_URL',
    isAvailable: Boolean(process.env.DATABASE_URL),
  },
  {
    name: 'api (postgres integration)',
    args: ['run', 'test:integration:postgres', '--workspace', '@chess-platform/api'],
    envReq: 'DATABASE_URL',
    isAvailable: Boolean(process.env.DATABASE_URL),
  },
  {
    name: 'scripts (postgres integration)',
    args: ['run', 'test:scripts:integration'],
    envReq: 'DATABASE_URL',
    isAvailable: Boolean(process.env.DATABASE_URL),
  },
  {
    name: 'api (engine smoke)',
    args: ['run', 'test:analysis-smoke', '--workspace', '@chess-platform/api'],
    envReq: 'STOCKFISH_PATH & DATABASE_URL',
    isAvailable: Boolean(process.env.STOCKFISH_PATH && process.env.DATABASE_URL),
  },
  {
    name: 'ai-orchestrator (live provider contract)',
    args: ['run', 'test:live-provider', '--workspace', '@chess-platform/ai-orchestrator'],
    envReq: 'OPENAI_API_KEY & ANTHROPIC_API_KEY',
    isAvailable: Boolean(process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY),
  },
  {
    name: 'ai-features (live provider contract)',
    args: ['run', 'test:live-provider', '--workspace', '@chess-platform/ai-features'],
    envReq: 'OPENAI_API_KEY & ANTHROPIC_API_KEY & GAMBIT_TEST_INTEGRATION=1',
    isAvailable: Boolean(
      process.env.OPENAI_API_KEY &&
      process.env.ANTHROPIC_API_KEY &&
      process.env.GAMBIT_TEST_INTEGRATION === '1'
    ),
  },
  {
    name: 'api (posix unit)',
    args: ['run', 'test:posix', '--workspace', '@chess-platform/api'],
    envReq: 'POSIX platform required',
    isAvailable: process.platform !== 'win32',
  },
  {
    name: 'load-harness (posix)',
    args: ['run', 'test:load-harness:posix'],
    envReq: 'POSIX platform required',
    isAvailable: process.platform !== 'win32',
  },
];

let totalTests = 0;
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
let totalTodo = 0;
let totalCancelled = 0;
let hadError = false;

console.log('\n=== Hermetic Unit Test Suites ===');
for (const [name, args] of HERMETIC_SUITES) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tests = testCount(output);
  const passMetric = metric(output, 'pass');
  const failed = metric(output, 'fail') ?? 0;
  const skipped = metric(output, 'skipped') ?? 0;
  const todo = metric(output, 'todo') ?? 0;
  const cancelled = metric(output, 'cancelled') ?? 0;
  const passed = passMetric ?? (failed === 0 && skipped === 0 && todo === 0 && cancelled === 0 ? (tests ?? 0) : 0);

  if (
    result.status !== 0 ||
    tests === null ||
    tests === 0 ||
    failed > 0 ||
    skipped > 0 ||
    todo > 0 ||
    cancelled > 0
  ) {
    console.error(
      `${name}: ERROR (status=${result.status}, tests=${tests}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}, cancelled=${cancelled})`
    );
    if (result.error) console.error(result.error.message);
    if (output.trim()) console.error(output.trim());
    hadError = true;
    continue;
  }
  console.log(
    `${name}: tests ${tests}, passed ${passed}, failed ${failed}, skipped ${skipped}, todo ${todo}, cancelled ${cancelled}`
  );
  totalTests += tests;
  totalPassed += passed;
  totalFailed += failed;
  totalSkipped += skipped;
  totalTodo += todo;
  totalCancelled += cancelled;
}

console.log('\n=== Environment & Integration Test Suites ===');
for (const suite of SERVICE_SUITES) {
  if (!suite.isAvailable) {
    console.log(`${suite.name}: NOT EXECUTED (${suite.envReq} not provided)`);
    continue;
  }

  const result = spawnSync(process.execPath, [npmCli, ...suite.args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tests = testCount(output);
  const passMetric = metric(output, 'pass');
  const failed = metric(output, 'fail') ?? 0;
  const skipped = metric(output, 'skipped') ?? 0;
  const todo = metric(output, 'todo') ?? 0;
  const cancelled = metric(output, 'cancelled') ?? 0;
  const passed = passMetric ?? (failed === 0 && skipped === 0 && todo === 0 && cancelled === 0 ? (tests ?? 0) : 0);

  if (
    result.status !== 0 ||
    tests === null ||
    tests === 0 ||
    failed > 0 ||
    skipped > 0 ||
    todo > 0 ||
    cancelled > 0
  ) {
    console.error(
      `${suite.name}: ERROR (status=${result.status}, tests=${tests}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}, cancelled=${cancelled})`
    );
    if (result.error) console.error(result.error.message);
    if (output.trim()) console.error(output.trim());
    hadError = true;
    continue;
  }
  console.log(
    `${suite.name}: tests ${tests}, passed ${passed}, failed ${failed}, skipped ${skipped}, todo ${todo}, cancelled ${cancelled}`
  );
  totalTests += tests;
  totalPassed += passed;
  totalFailed += failed;
  totalSkipped += skipped;
  totalTodo += todo;
  totalCancelled += cancelled;
}

console.log(
  `\nGrand Total Executed: ${totalTests} tests (${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped, ${totalTodo} todo, ${totalCancelled} cancelled)`
);
if (hadError) process.exitCode = 1;

/**
 * Extracts an aggregated numeric test metric from TAP (`# <name> <N>`) or spec (`ℹ <name> <N>`) reporter summary output lines.
 *
 * @param {string} output - Combined stdout/stderr text output from a test runner.
 * @param {string} name - Metric name to search for ('tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled').
 * @returns {number|null} Aggregated integer count across all reporter summaries, or null if not found.
 */
function metric(output, name) {
  const pattern = name === 'fail'
    ? /^\s*(?:#|ℹ)\s+fail(?:ed)?:?\s+(\d+)\b/gim
    : new RegExp(`^\\s*(?:#|ℹ)\\s+${name}:?\\s+(\\d+)\\b`, 'gim');
  const matches = [...output.matchAll(pattern)];
  if (matches.length === 0) return null;
  return matches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
}

/**
 * Resolves the total tests count from reporter summary lines or TAP plan headers.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number|null} Total test count, or null if not detected.
 */
function testCount(output) {
  const summaryTests = metric(output, 'tests');
  if (summaryTests !== null) return summaryTests;
  const planMatches = [...output.matchAll(/^\s*1\.\.(\d+)\b/gm)];
  if (planMatches.length > 0) {
    return planMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }
  return null;
}
