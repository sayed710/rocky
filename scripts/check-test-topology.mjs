import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());

export const SUITE_DEFINITIONS = [
  {
    name: 'acceptance-playwright',
    pattern: /^packages\/web\/e2e\/.*\.spec\.ts$/,
    target: 'npm run e2e (m6-acceptance)',
  },
  {
    name: 'gateway-redis-integration',
    pattern: /^services\/gateway\/test\/.*\.integration\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
  },
  {
    name: 'gateway-unit',
    pattern: /^services\/gateway\/test\/.*\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
  },
  {
    name: 'gateway-trusted-edge',
    pattern: /^scripts\/nginx-trusted-edge-acceptance\.mjs$/,
    target: 'npm run test:trusted-edge in services/gateway (gateway-service)',
  },
  {
    name: 'persistence-postgres-integration',
    pattern: /^packages\/persistence\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/persistence',
  },
  {
    name: 'persistence-unit',
    pattern: /^packages\/persistence\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/persistence (build-test)',
  },
  {
    name: 'api-postgres-integration',
    pattern: /^packages\/api\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/api',
  },
  {
    name: 'api-engine-smoke',
    pattern: /^packages\/api\/test\/(analysis-.*smoke|analysis-real-stack)\.test\.ts$/,
    target: 'npm run test:analysis-smoke -w @chess-platform/api (analysis-smoke)',
  },
  {
    name: 'api-diagnostics',
    pattern: /^packages\/api\/test\/diagnostics\/.*\.diag\.ts$/,
    target: 'npm run test:diagnostics:abort -w @chess-platform/api',
  },
  {
    name: 'api-posix-unit',
    pattern: /^packages\/api\/test\/.*\.posix\.test\.ts$/,
    target: 'npm run test:posix -w @chess-platform/api',
  },
  {
    name: 'api-unit',
    pattern: /^packages\/api\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/api (build-test)',
  },
  {
    name: 'ai-orchestrator-live-provider',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-orchestrator',
  },
  {
    name: 'ai-orchestrator-unit',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-orchestrator (build-test)',
  },
  {
    name: 'ai-features-live-provider',
    pattern: /^packages\/ai-features\/test\/.*integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-features',
  },
  {
    name: 'ai-features-unit',
    pattern: /^packages\/ai-features\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-features (build-test)',
  },
  {
    name: 'scripts-postgres-integration',
    pattern: /^scripts\/test\/.*\.integration\.test\.mjs$/,
    target: 'npm run test:scripts:integration (postgres-integration)',
  },
  {
    name: 'scripts-unit',
    pattern: /^scripts\/test\/.*\.test\.mjs$/,
    target: 'npm run test:scripts (build-test)',
  },
  {
    name: 'load-harness-posix',
    pattern: /^deploy\/load\/test\/.*\.posix\.test\.mjs$/,
    target: 'npm run test:load-harness:posix',
  },
  {
    name: 'load-harness-unit',
    pattern: /^deploy\/load\/test\/.*\.test\.mjs$/,
    target: 'npm run test:load-harness (build-test)',
  },
  {
    name: 'domain-hermetic-unit',
    pattern: /^packages\/[^/]+\/test\/.*\.test\.ts$/,
    target: 'npm test (build-test)',
  },
];

/**
 * Recursively scans the repository from the given root directory to discover all test files,
 * excluding build artifacts, dependencies, and generated reports.
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
      const relPath = relative(root, fullPath).replace(/\\/g, '/');

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
          relPath.match(/(^packages\/web\/e2e\/.*\.spec\.ts$)/) ||
          relPath.match(/(^scripts\/nginx-trusted-edge-acceptance\.mjs$)/) ||
          (relPath.includes('/test/') && relPath.match(/\.(test|diag)\.(ts|js|mjs|cjs)$/))
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
 * Scans the repository and validates that 100% of test files map to an explicit zero-skip suite.
 *
 * @param {string} [root=REPO_ROOT] - Repository root directory to verify.
 * @returns {{ totalFiles: number, unclassified: string[], categorized: Map<string, string[]> }}
 *   Verification summary containing total count, any unclassified files, and categorized groupings.
 */
export function verifyTestTopology(root = REPO_ROOT) {
  const files = findTestFiles(root);
  const unclassified = [];
  const categorized = new Map();

  for (const file of files) {
    const suite = classifyTestFile(file);
    if (!suite) {
      unclassified.push(file);
    } else {
      const list = categorized.get(suite.name) || [];
      list.push(file);
      categorized.set(suite.name, list);
    }
  }

  return {
    totalFiles: files.length,
    unclassified,
    categorized,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = verifyTestTopology();
  console.log(`[TEST TOPOLOGY] Verified ${result.totalFiles} test files across ${result.categorized.size} suites.`);

  for (const [suiteName, files] of result.categorized.entries()) {
    console.log(`  - ${suiteName}: ${files.length} file(s)`);
  }

  if (result.unclassified.length > 0) {
    console.error(`[TEST TOPOLOGY] FAILED: ${result.unclassified.length} unclassified test file(s) found:`);
    for (const f of result.unclassified) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log('[TEST TOPOLOGY] All test files successfully classified into explicit zero-skip suites.');
}
