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
    envReq: 'OPENAI_API_KEY | ANTHROPIC_API_KEY',
    isAvailable: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
  },
  {
    name: 'ai-features (live provider contract)',
    args: ['run', 'test:live-provider', '--workspace', '@chess-platform/ai-features'],
    envReq: 'OPENAI_API_KEY | ANTHROPIC_API_KEY',
    isAvailable: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
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

let total = 0;
let skippedTotal = 0;
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
  const tests = metric(output, 'tests');
  const skipped = metric(output, 'skipped') ?? 0;
  const failed = metric(output, 'fail') ?? 0;

  if (result.status !== 0 || tests === null || tests === 0 || failed > 0) {
    console.error(`${name}: ERROR (status=${result.status}, tests=${tests}, failed=${failed})`);
    if (result.error) console.error(result.error.message);
    if (output.trim()) console.error(output.trim());
    hadError = true;
    continue;
  }
  console.log(`${name}: ${tests} passed, ${failed} failed, ${skipped} skipped`);
  total += tests;
  skippedTotal += skipped;
  if (skipped > 0) {
    hadError = true;
  }
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
  const tests = metric(output, 'tests');
  const skipped = metric(output, 'skipped') ?? 0;
  const failed = metric(output, 'fail') ?? 0;

  if (result.status !== 0 || tests === null || tests === 0 || failed > 0) {
    console.error(`${suite.name}: ERROR (status=${result.status}, tests=${tests}, failed=${failed})`);
    if (result.error) console.error(result.error.message);
    if (output.trim()) console.error(output.trim());
    hadError = true;
    continue;
  }
  console.log(`${suite.name}: ${tests} passed, ${failed} failed, ${skipped} skipped`);
  total += tests;
  skippedTotal += skipped;
  if (skipped > 0) {
    hadError = true;
  }
}

console.log(`\nGrand Total Executed: ${total} tests (${skippedTotal} skipped)`);
if (hadError) process.exitCode = 1;

/**
 * Extracts a numeric test metric (e.g. 'tests', 'pass', 'fail', 'skipped') from TAP
 * (`# <name> <N>`) or spec (`ℹ <name> <N>`) reporter summary output lines.
 *
 * @param {string} output - Combined stdout/stderr text output from a test runner.
 * @param {string} name - Metric name to search for.
 * @returns {number|null} Parsed integer count, or null if not found.
 */
function metric(output, name) {
  const patterns = [
    new RegExp(`^# ${name}\\s+(\\d+)`, 'm'),
    new RegExp(`^ℹ ${name}\\s+(\\d+)`, 'm'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return null;
}
