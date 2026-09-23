#!/usr/bin/env node
/** Run test suites through npm and report Node test-runner totals portably with zero-skip auditing. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCompleteTestOutput } from './lib/test-output-parser.mjs';
import { getHermeticWorkspaces, PARTITIONED_PACKAGES } from './lib/workspace-topology.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath is unavailable; run this script through "npm run test:counts"');
  process.exit(1);
}

const HERMETIC_SUITES = [
  ...getHermeticWorkspaces().map((pkg) => {
    const base = pkg.replace('@chess-platform/', '');
    const label = PARTITIONED_PACKAGES.includes(pkg) ? `${base} (hermetic unit)` : base;
    return [label, ['test', '--workspace', pkg]];
  }),
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
    name: 'gateway-service (trusted edge through Nginx)',
    args: ['run', 'test:trusted-edge', '--prefix', 'services/gateway'],
    envReq: 'REQUIRE_DOCKER=1',
    isAvailable: process.env.REQUIRE_DOCKER === '1',
    env: { REQUIRE_DOCKER: '1' },
  },
  {
    name: 'gateway-service (web delivery through Nginx)',
    args: ['run', 'test:web-delivery', '--prefix', 'services/gateway'],
    envReq: 'REQUIRE_DOCKER=1',
    isAvailable: process.env.REQUIRE_DOCKER === '1',
    env: { REQUIRE_DOCKER: '1' },
  },
  {
    name: 'web (Playwright acceptance)',
    args: ['run', 'e2e', '--workspace', '@chess-platform/web'],
    envReq: 'GAMBIT_E2E_BACKEND=1 and Playwright Chromium installed',
    isAvailable: process.env.GAMBIT_E2E_BACKEND === '1',
    env: { GAMBIT_E2E_BACKEND: '1' },
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
    name: 'ai-orchestrator (OpenAI live contract)',
    args: ['run', 'test:live-provider:openai', '--workspace', '@chess-platform/ai-orchestrator'],
    envReq: 'OPENAI_API_KEY',
    isAvailable: Boolean(process.env.OPENAI_API_KEY),
  },
  {
    name: 'ai-orchestrator (Anthropic live contract)',
    args: ['run', 'test:live-provider:anthropic', '--workspace', '@chess-platform/ai-orchestrator'],
    envReq: 'ANTHROPIC_API_KEY',
    isAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
  },
  {
    name: 'ai-features (OpenAI live contract)',
    args: ['run', 'test:live-provider:openai', '--workspace', '@chess-platform/ai-features'],
    envReq: 'OPENAI_API_KEY',
    isAvailable: Boolean(process.env.OPENAI_API_KEY),
  },
  {
    name: 'ai-features (Anthropic live contract)',
    args: ['run', 'test:live-provider:anthropic', '--workspace', '@chess-platform/ai-features'],
    envReq: 'ANTHROPIC_API_KEY',
    isAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
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
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const parsed = parseCompleteTestOutput(output);
  const { totalTests: tests, passCount: passed, failCount: failed, skippedCount: skipped,
    todoCount: todo, cancelledCount: cancelled, accountingValid, accountingError } = parsed;

  if (
    result.status !== 0 ||
    result.error ||
    tests === null ||
    tests === 0 ||
    !accountingValid ||
    passed === null ||
    passed !== tests ||
    failed > 0 ||
    skipped > 0 ||
    todo > 0 ||
    cancelled > 0
  ) {
    if (result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      console.error(`${name}: ERROR (output exceeded maxBuffer of 64MB)`);
    } else {
      console.error(
        `${name}: ERROR (status=${result.status}, tests=${tests}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}, cancelled=${cancelled}, accounting=${accountingError ?? 'valid'})`
      );
    }
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
    env: { ...process.env, ...(suite.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const parsed = parseCompleteTestOutput(output);
  const { totalTests: tests, passCount: passed, failCount: failed, skippedCount: skipped,
    todoCount: todo, cancelledCount: cancelled, accountingValid, accountingError } = parsed;

  if (
    result.status !== 0 ||
    result.error ||
    tests === null ||
    tests === 0 ||
    !accountingValid ||
    passed === null ||
    passed !== tests ||
    failed > 0 ||
    skipped > 0 ||
    todo > 0 ||
    cancelled > 0
  ) {
    if (result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      console.error(`${suite.name}: ERROR (output exceeded maxBuffer of 64MB)`);
    } else {
      console.error(
        `${suite.name}: ERROR (status=${result.status}, tests=${tests}, passed=${passed}, failed=${failed}, skipped=${skipped}, todo=${todo}, cancelled=${cancelled}, accounting=${accountingError ?? 'valid'})`
      );
    }
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
