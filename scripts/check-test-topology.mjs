import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(process.cwd());

export const SUITE_DEFINITIONS = [
  {
    name: 'acceptance-playwright',
    pattern: /^packages\/web\/e2e\/.*\.spec\.ts$/,
    target: 'npm run e2e (m6-acceptance)',
    isReachable: (relPath) => /^packages\/web\/e2e\/.+\.spec\.ts$/.test(relPath),
  },
  {
    name: 'gateway-redis-integration',
    pattern: /^services\/gateway\/test\/.*\.integration\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
    isReachable: (relPath) => /^services\/gateway\/test\/.+\.integration\.test\.ts$/.test(relPath),
  },
  {
    name: 'gateway-unit',
    pattern: /^services\/gateway\/test\/.*\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
    isReachable: (relPath) => /^services\/gateway\/test\/.+\.test\.ts$/.test(relPath),
  },
  {
    name: 'gateway-trusted-edge',
    pattern: /^scripts\/nginx-trusted-edge-acceptance\.mjs$/,
    target: 'npm run test:trusted-edge in services/gateway (gateway-service)',
    isReachable: (relPath) => relPath === 'scripts/nginx-trusted-edge-acceptance.mjs',
  },
  {
    name: 'persistence-postgres-integration',
    pattern: /^packages\/persistence\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/persistence',
    isReachable: (relPath) => /^packages\/persistence\/test\/.+\.integration\.test\.ts$/.test(relPath),
  },
  {
    name: 'persistence-unit',
    pattern: /^packages\/persistence\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/persistence (build-test)',
    isReachable: (relPath) =>
      /^packages\/persistence\/test\/.+\.test\.ts$/.test(relPath) &&
      !relPath.endsWith('.integration.test.ts'),
  },
  {
    name: 'api-postgres-integration',
    pattern: /^packages\/api\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/api',
    isReachable: (relPath) => /^packages\/api\/test\/.+\.integration\.test\.ts$/.test(relPath),
  },
  {
    name: 'api-engine-smoke',
    pattern: /^packages\/api\/test\/(analysis-.*smoke|analysis-real-stack)\.test\.ts$/,
    target: 'npm run test:analysis-smoke -w @chess-platform/api (analysis-smoke)',
    isReachable: (relPath) =>
      [
        'packages/api/test/analysis-stockfish-smoke.test.ts',
        'packages/api/test/analysis-fairy-threecheck-smoke.test.ts',
        'packages/api/test/analysis-real-stack.test.ts',
      ].includes(relPath),
  },
  {
    name: 'api-diagnostics',
    pattern: /^packages\/api\/test\/diagnostics\/.*\.diag\.ts$/,
    target: 'npm run test:diagnostics:abort -w @chess-platform/api',
    isReachable: (relPath) =>
      relPath === 'packages/api/test/diagnostics/signature-b-preload-abort.diag.ts',
  },
  {
    name: 'api-posix-unit',
    pattern: /^packages\/api\/test\/.*\.posix\.test\.ts$/,
    target: 'npm run test:posix -w @chess-platform/api',
    isReachable: (relPath) => /^packages\/api\/test\/.+\.posix\.test\.ts$/.test(relPath),
  },
  {
    name: 'api-unit',
    pattern: /^packages\/api\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/api (build-test)',
    isReachable: (relPath) =>
      /^packages\/api\/test\/.+\.test\.ts$/.test(relPath) &&
      !relPath.endsWith('.integration.test.ts') &&
      !relPath.endsWith('.posix.test.ts') &&
      !/^packages\/api\/test\/(analysis-.*smoke|analysis-real-stack)\.test\.ts$/.test(relPath),
  },
  {
    name: 'ai-orchestrator-live-provider',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-orchestrator',
    isReachable: (relPath) =>
      /^packages\/ai-orchestrator\/test\/.*integration\.test\.ts$/.test(relPath),
  },
  {
    name: 'ai-orchestrator-unit',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-orchestrator (build-test)',
    isReachable: (relPath) =>
      /^packages\/ai-orchestrator\/test\/.+\.test\.ts$/.test(relPath) &&
      !relPath.includes('integration'),
  },
  {
    name: 'ai-features-live-provider',
    pattern: /^packages\/ai-features\/test\/.*integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-features',
    isReachable: (relPath) =>
      /^packages\/ai-features\/test\/.*integration\.test\.ts$/.test(relPath),
  },
  {
    name: 'ai-features-unit',
    pattern: /^packages\/ai-features\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-features (build-test)',
    isReachable: (relPath) =>
      /^packages\/ai-features\/test\/.+\.test\.ts$/.test(relPath) &&
      !relPath.includes('integration'),
  },
  {
    name: 'scripts-postgres-integration',
    pattern: /^scripts\/test\/.*\.integration\.test\.mjs$/,
    target: 'npm run test:scripts:integration (postgres-integration)',
    isReachable: (relPath) => /^scripts\/test\/.+\.integration\.test\.mjs$/.test(relPath),
  },
  {
    name: 'scripts-unit',
    pattern: /^scripts\/test\/.*\.test\.mjs$/,
    target: 'npm run test:scripts (build-test)',
    isReachable: (relPath) =>
      /^scripts\/test\/.+\.test\.mjs$/.test(relPath) &&
      !relPath.endsWith('.integration.test.mjs'),
  },
  {
    name: 'load-harness-posix',
    pattern: /^deploy\/load\/test\/.*\.posix\.test\.mjs$/,
    target: 'npm run test:load-harness:posix',
    isReachable: (relPath) => /^deploy\/load\/test\/.+\.posix\.test\.mjs$/.test(relPath),
  },
  {
    name: 'load-harness-unit',
    pattern: /^deploy\/load\/test\/.*\.test\.mjs$/,
    target: 'npm run test:load-harness (build-test)',
    isReachable: (relPath) =>
      /^deploy\/load\/test\/.+\.test\.mjs$/.test(relPath) &&
      !relPath.endsWith('.posix.test.mjs'),
  },
  {
    name: 'domain-hermetic-unit',
    pattern: /^packages\/[^/]+\/test\/.*\.test\.ts$/,
    target: 'npm test (build-test)',
    isReachable: (relPath) => {
      const match = relPath.match(/^packages\/([^/]+)\/test\/(.+)\.test\.ts$/);
      if (!match) return false;
      const pkg = match[1];
      if (['api', 'persistence', 'ai-orchestrator', 'ai-features'].includes(pkg)) return false;
      return true;
    },
  },
];

/**
 * Validates whether a file path is located within an authorized test directory structure.
 *
 * @param {string} relPath - Repository-relative POSIX file path.
 * @returns {boolean} True if the path resides in an approved test location.
 */
export function isAllowedPlacement(relPath) {
  if (relPath === 'scripts/nginx-trusted-edge-acceptance.mjs') return true;
  if (/^packages\/[^/]+\/test\/.+/.test(relPath)) return true;
  if (/^packages\/web\/e2e\/.+/.test(relPath)) return true;
  if (/^services\/[^/]+\/test\/.+/.test(relPath)) return true;
  if (/^scripts\/test\/.+/.test(relPath)) return true;
  if (/^deploy\/[^/]+\/test\/.+/.test(relPath)) return true;
  return false;
}

/**
 * Recursively scans the repository from the given root directory to discover all test files,
 * regardless of whether they reside in a /test/ directory or are misplaced in src/.
 * Excludes build artifacts, dependencies, and generated reports.
 *
 * @param {string} [root=REPO_ROOT] - Repository root directory to scan.
 * @returns {string[]} Sorted array of repository-relative POSIX file paths for all discovered tests.
 */
export function findTestFiles(root = REPO_ROOT) {
  const testFiles = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).split(sep).join('/');

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'dist-test' ||
          entry.name === '.git' ||
          entry.name === 'coverage' ||
          entry.name === 'playwright-report' ||
          entry.name === 'test-results' ||
          entry.name === 'helm' ||
          entry.name === 'observability'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          relPath === 'scripts/nginx-trusted-edge-acceptance.mjs' ||
          /\.(test|spec|diag)\.(ts|js|mjs|cjs)$/.test(relPath)
        ) {
          testFiles.push(relPath);
        }
      }
    }
  }

  walk(root);
  return testFiles.sort();
}

/**
 * Matches a repository-relative test file path against known zero-skip suite definitions.
 *
 * @param {string} relPath - Repository-relative file path in POSIX format.
 * @returns {object|null} The matching suite definition object, or null if unclassified.
 */
export function classifyTestFile(relPath) {
  for (const suite of SUITE_DEFINITIONS) {
    if (suite.pattern.test(relPath)) {
      return suite;
    }
  }
  return null;
}

/**
 * Scans the repository and validates that:
 * 1. 100% of test files are placed in authorized test directories (no src/ co-location).
 * 2. 100% of test files map to an explicit zero-skip suite.
 * 3. 100% of test files are reachable by their owning suite's runner execution globs.
 *
 * @param {string} [root=REPO_ROOT] - Repository root directory to verify.
 * @returns {{
 *   totalFiles: number,
 *   misplaced: string[],
 *   unclassified: string[],
 *   unreachable: Array<{ file: string, suite: string }>,
 *   categorized: Map<string, string[]>
 * }}
 */
export function verifyTestTopology(root = REPO_ROOT) {
  const files = findTestFiles(root);
  const misplaced = [];
  const unclassified = [];
  const unreachable = [];
  const categorized = new Map();

  for (const file of files) {
    if (!isAllowedPlacement(file)) {
      misplaced.push(file);
      continue;
    }

    const suite = classifyTestFile(file);
    if (!suite) {
      unclassified.push(file);
      continue;
    }

    if (suite.isReachable && !suite.isReachable(file)) {
      unreachable.push({ file, suite: suite.name });
      continue;
    }

    const list = categorized.get(suite.name) || [];
    list.push(file);
    categorized.set(suite.name, list);
  }

  return {
    totalFiles: files.length,
    misplaced,
    unclassified,
    unreachable,
    categorized,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = verifyTestTopology();
  console.log(`[TEST TOPOLOGY] Verified ${result.totalFiles} test files across ${result.categorized.size} suites.`);

  for (const [suiteName, files] of result.categorized.entries()) {
    console.log(`  - ${suiteName}: ${files.length} file(s)`);
  }

  let failed = false;

  if (result.misplaced.length > 0) {
    console.error(`[TEST TOPOLOGY] FAILED: ${result.misplaced.length} misplaced test file(s) found (outside authorized test directories):`);
    for (const f of result.misplaced) {
      console.error(`  - ${f}`);
    }
    failed = true;
  }

  if (result.unclassified.length > 0) {
    console.error(`[TEST TOPOLOGY] FAILED: ${result.unclassified.length} unclassified test file(s) found:`);
    for (const f of result.unclassified) {
      console.error(`  - ${f}`);
    }
    failed = true;
  }

  if (result.unreachable.length > 0) {
    console.error(`[TEST TOPOLOGY] FAILED: ${result.unreachable.length} test file(s) unreachable by suite runner:`);
    for (const item of result.unreachable) {
      console.error(`  - ${item.file} (suite: ${item.suite})`);
    }
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  console.log('[TEST TOPOLOGY] All test files successfully placed, classified, and reachable by explicit zero-skip suites.');
}

