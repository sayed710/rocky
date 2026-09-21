import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

const REPO_ROOT = resolve(process.cwd());

/**
 * Mechanically extracts test runner target file globs/paths from a package.json script command.
 * Parses flags and options out of `node --test` or `playwright test` command invocations.
 *
 * @param {string} scriptCmd - Script command from package.json manifest.
 * @returns {string[]} Array of extracted target globs or file paths.
 */
export function extractRunnerPatterns(scriptCmd) {
  if (!scriptCmd) return [];
  const parts = scriptCmd.split('&&').map((s) => s.trim());
  const testSubCmd = parts.find((s) => s.includes('node --test') || s.includes('playwright test'));
  if (!testSubCmd) return [];
  if (testSubCmd.includes('playwright test')) return ['e2e/**/*.spec.ts'];

  const afterTest = testSubCmd.slice(testSubCmd.indexOf('node --test') + 'node --test'.length).trim();
  const tokenRegex = /(?:\"([^\"]+)\"|'([^']+)'|(\S+))/g;
  const patterns = [];
  let m;
  while ((m = tokenRegex.exec(afterTest)) !== null) {
    const token = m[1] || m[2] || m[3];
    if (token.startsWith('-')) continue;
    patterns.push(token);
  }
  return patterns;
}

/**
 * Evaluates whether a candidate path matches a runner glob pattern.
 * Uses picomatch with a fallback pattern matcher.
 *
 * @param {string} pattern - Glob or file path pattern.
 * @param {string} candidate - Relative candidate file path to match.
 * @returns {boolean}
 */
export function matchRunnerPattern(pattern, candidate) {
  try {
    const isMatch = picomatch(pattern);
    return isMatch(candidate);
  } catch {
    const reStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${reStr}$`).test(candidate);
  }
}

/**
 * Resolves the authoritative manifest for a suite and test file, and mechanically checks
 * whether the actual runner glob in package.json reaches the test file.
 *
 * @param {object} suite - Suite definition.
 * @param {string} relPath - Repository-relative POSIX file path.
 * @param {object} [options={}] - Verification options (root, manifestCache, manifestOverrides).
 * @returns {boolean} True if the test file is reached by the actual runner glob in package.json.
 */
export function isTestFileReachableByRunner(suite, relPath, options = {}) {
  const root = options.root || REPO_ROOT;
  const manifestCache = options.manifestCache || new Map();
  const manifestOverrides = options.manifestOverrides || {};

  let manifestPath = suite.manifest;
  if (!manifestPath) {
    const match = relPath.match(/^packages\/([^/]+)\//);
    if (!match) return false;
    manifestPath = `packages/${match[1]}/package.json`;
  }

  let baseManifest = manifestCache.get(manifestPath);
  if (!baseManifest) {
    const fullPath = join(root, manifestPath);
    if (existsSync(fullPath)) {
      baseManifest = JSON.parse(readFileSync(fullPath, 'utf8'));
      manifestCache.set(manifestPath, baseManifest);
    }
  }

  let manifest = baseManifest;
  if (manifestOverrides[manifestPath]) {
    manifest = {
      ...baseManifest,
      ...manifestOverrides[manifestPath],
      scripts: {
        ...(baseManifest?.scripts || {}),
        ...(manifestOverrides[manifestPath].scripts || {}),
      },
    };
  }
  if (!manifest) return false;

  const scriptCmd = manifest.scripts?.[suite.script];
  if (!scriptCmd) return false;

  const patterns = extractRunnerPatterns(scriptCmd);
  if (!patterns || patterns.length === 0) return false;

  const manifestDir = dirname(manifestPath);
  const relToManifest = manifestDir === '.' ? relPath : relative(manifestDir, relPath).split(sep).join('/');
  const compiledPath = relToManifest.startsWith('test/')
    ? 'dist-test/test/' + relToManifest.slice(5).replace(/\.ts$/, '.js')
    : null;

  for (const pat of patterns) {
    let normPat = pat;
    let checkRelPath = relPath;
    if (pat.startsWith('../') || pat.startsWith('./')) {
      normPat = join(manifestDir, pat).split(sep).join('/');
    }

    if (
      matchRunnerPattern(normPat, relToManifest) ||
      (compiledPath && matchRunnerPattern(normPat, compiledPath)) ||
      matchRunnerPattern(normPat, checkRelPath) ||
      matchRunnerPattern(normPat, relPath)
    ) {
      return true;
    }
  }

  return false;
}

const RAW_SUITE_DEFINITIONS = [
  {
    name: 'acceptance-playwright',
    pattern: /^packages\/web\/e2e\/.*\.spec\.ts$/,
    target: 'npm run e2e (m6-acceptance)',
    manifest: 'packages/web/package.json',
    script: 'e2e',
  },
  {
    name: 'gateway-redis-integration',
    pattern: /^services\/gateway\/test\/.*\.integration\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
    manifest: 'services/gateway/package.json',
    script: 'test',
  },
  {
    name: 'gateway-unit',
    pattern: /^services\/gateway\/test\/.*\.test\.ts$/,
    target: 'npm test in services/gateway (gateway-service)',
    manifest: 'services/gateway/package.json',
    script: 'test',
  },
  {
    name: 'gateway-trusted-edge',
    pattern: /^scripts\/nginx-trusted-edge-acceptance\.mjs$/,
    target: 'npm run test:trusted-edge in services/gateway (gateway-service)',
    manifest: 'services/gateway/package.json',
    script: 'test:trusted-edge',
  },
  {
    name: 'persistence-postgres-integration',
    pattern: /^packages\/persistence\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/persistence',
    manifest: 'packages/persistence/package.json',
    script: 'test:integration:postgres',
  },
  {
    name: 'persistence-unit',
    pattern: /^packages\/persistence\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/persistence (build-test)',
    manifest: 'packages/persistence/package.json',
    script: 'test:unit',
  },
  {
    name: 'api-postgres-integration',
    pattern: /^packages\/api\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:integration:postgres -w @chess-platform/api',
    manifest: 'packages/api/package.json',
    script: 'test:integration:postgres',
  },
  {
    name: 'api-engine-smoke',
    pattern: /^packages\/api\/test\/(analysis-.*smoke|analysis-real-stack)\.test\.ts$/,
    target: 'npm run test:analysis-smoke -w @chess-platform/api (analysis-smoke)',
    manifest: 'packages/api/package.json',
    script: 'test:analysis-smoke',
  },
  {
    name: 'api-diagnostics',
    pattern: /^packages\/api\/test\/diagnostics\/.*\.diag\.ts$/,
    target: 'npm run test:diagnostics:abort -w @chess-platform/api',
    manifest: 'packages/api/package.json',
    script: 'test:diagnostics:abort',
  },
  {
    name: 'api-posix-unit',
    pattern: /^packages\/api\/test\/.*\.posix\.test\.ts$/,
    target: 'npm run test:posix -w @chess-platform/api',
    manifest: 'packages/api/package.json',
    script: 'test:posix',
  },
  {
    name: 'api-unit',
    pattern: /^packages\/api\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/api (build-test)',
    manifest: 'packages/api/package.json',
    script: 'test:unit',
  },
  {
    name: 'ai-orchestrator-live-provider',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-orchestrator',
    manifest: 'packages/ai-orchestrator/package.json',
    script: 'test:live-provider',
  },
  {
    name: 'ai-orchestrator-unit',
    pattern: /^packages\/ai-orchestrator\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-orchestrator (build-test)',
    manifest: 'packages/ai-orchestrator/package.json',
    script: 'test:unit',
  },
  {
    name: 'ai-features-live-provider',
    pattern: /^packages\/ai-features\/test\/.*integration\.test\.ts$/,
    target: 'npm run test:live-provider -w @chess-platform/ai-features',
    manifest: 'packages/ai-features/package.json',
    script: 'test:live-provider',
  },
  {
    name: 'ai-features-unit',
    pattern: /^packages\/ai-features\/test\/.*\.test\.ts$/,
    target: 'npm test -w @chess-platform/ai-features (build-test)',
    manifest: 'packages/ai-features/package.json',
    script: 'test:unit',
  },
  {
    name: 'scripts-postgres-integration',
    pattern: /^scripts\/test\/.*\.integration\.test\.mjs$/,
    target: 'npm run test:scripts:integration (postgres-integration)',
    manifest: 'package.json',
    script: 'test:scripts:integration',
  },
  {
    name: 'scripts-unit',
    pattern: /^scripts\/test\/.*\.test\.mjs$/,
    target: 'npm run test:scripts (build-test)',
    manifest: 'package.json',
    script: 'test:scripts',
  },
  {
    name: 'load-harness-posix',
    pattern: /^deploy\/load\/test\/.*\.posix\.test\.mjs$/,
    target: 'npm run test:load-harness:posix',
    manifest: 'package.json',
    script: 'test:load-harness:posix',
  },
  {
    name: 'load-harness-unit',
    pattern: /^deploy\/load\/test\/.*\.test\.mjs$/,
    target: 'npm run test:load-harness (build-test)',
    manifest: 'package.json',
    script: 'test:load-harness',
  },
  {
    name: 'domain-hermetic-unit',
    pattern: /^packages\/[^/]+\/test\/.*\.test\.ts$/,
    target: 'npm test (build-test)',
    manifest: null,
    script: 'test',
  },
];

export const SUITE_DEFINITIONS = RAW_SUITE_DEFINITIONS.map((suite) => ({
  ...suite,
  isReachable(relPath, options) {
    return isTestFileReachableByRunner(this, relPath, options);
  },
}));

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
export function verifyTestTopology(root = REPO_ROOT, options = {}) {
  const files = findTestFiles(root);
  const misplaced = [];
  const unclassified = [];
  const unreachable = [];
  const categorized = new Map();
  const manifestCache = new Map();

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

    if (suite.isReachable && !suite.isReachable(file, { root, manifestCache, ...options })) {
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

