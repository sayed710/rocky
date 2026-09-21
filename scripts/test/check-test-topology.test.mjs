import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  findTestFiles,
  classifyTestFile,
  verifyTestTopology,
  isAllowedPlacement,
  extractRunnerPatterns,
  isTestFileReachableByRunner,
  SUITE_DEFINITIONS,
} from '../check-test-topology.mjs';

test('topology: all test files in the repository are classified into explicit suites', () => {
  const result = verifyTestTopology();
  assert.equal(result.misplaced.length, 0, `Found misplaced test files: ${result.misplaced.join(', ')}`);
  assert.equal(result.unclassified.length, 0, `Found unclassified test files: ${result.unclassified.join(', ')}`);
  assert.equal(result.unreachable.length, 0, `Found unreachable test files: ${result.unreachable.map((u) => `${u.file} (${u.suite})`).join(', ')}`);
  assert.ok(result.totalFiles > 300, `Expected over 300 test files, got ${result.totalFiles}`);
});

test('topology: isAllowedPlacement rejects misplaced test files in unauthorized locations', () => {
  assert.equal(isAllowedPlacement('packages/chess-core/src/fen.test.ts'), false);
  assert.equal(isAllowedPlacement('test/root.test.ts'), false);
  assert.equal(isAllowedPlacement('root.test.js'), false);
  assert.equal(isAllowedPlacement('services/gateway/src/server.test.ts'), false);

  assert.equal(isAllowedPlacement('packages/chess-core/test/fen.test.ts'), true);
  assert.equal(isAllowedPlacement('packages/web/e2e/game.spec.ts'), true);
  assert.equal(isAllowedPlacement('services/gateway/test/engine-bot.test.ts'), true);
  assert.equal(isAllowedPlacement('scripts/test/zero-skip-enforcement.test.mjs'), true);
  assert.equal(isAllowedPlacement('scripts/nginx-trusted-edge-acceptance.mjs'), true);
  assert.equal(isAllowedPlacement('deploy/load/test/run-evidence.test.mjs'), true);
});

test('topology: classifyTestFile correctly maps each suite pattern', () => {
  assert.equal(classifyTestFile('packages/web/e2e/game.spec.ts')?.name, 'acceptance-playwright');
  assert.equal(classifyTestFile('services/gateway/test/redis-ownership.integration.test.ts')?.name, 'gateway-redis-integration');
  assert.equal(classifyTestFile('services/gateway/test/engine-bot.test.ts')?.name, 'gateway-unit');
  assert.equal(classifyTestFile('scripts/nginx-trusted-edge-acceptance.mjs')?.name, 'gateway-trusted-edge');
  assert.equal(classifyTestFile('packages/persistence/test/pg.integration.test.ts')?.name, 'persistence-postgres-integration');
  assert.equal(classifyTestFile('packages/persistence/test/event-store.test.ts')?.name, 'persistence-unit');
  assert.equal(classifyTestFile('packages/api/test/pg-security.integration.test.ts')?.name, 'api-postgres-integration');
  assert.equal(classifyTestFile('packages/api/test/analysis-stockfish-smoke.test.ts')?.name, 'api-engine-smoke');
  assert.equal(classifyTestFile('packages/api/test/diagnostics/signature-b-preload-abort.diag.ts')?.name, 'api-diagnostics');
  assert.equal(classifyTestFile('packages/api/test/diagnostics/signature-b-correlate.posix.test.ts')?.name, 'api-posix-unit');
  assert.equal(classifyTestFile('packages/api/test/auth.test.ts')?.name, 'api-unit');
  assert.equal(classifyTestFile('packages/ai-orchestrator/test/adapters-live.integration.test.ts')?.name, 'ai-orchestrator-live-provider');
  assert.equal(classifyTestFile('packages/ai-orchestrator/test/orchestrator.test.ts')?.name, 'ai-orchestrator-unit');
  assert.equal(classifyTestFile('packages/ai-features/test/coach-integration.test.ts')?.name, 'ai-features-live-provider');
  assert.equal(classifyTestFile('packages/ai-features/test/coach.test.ts')?.name, 'ai-features-unit');
  assert.equal(classifyTestFile('scripts/test/backup-restore-drill.integration.test.mjs')?.name, 'scripts-postgres-integration');
  assert.equal(classifyTestFile('scripts/test/zero-skip-enforcement.test.mjs')?.name, 'scripts-unit');
  assert.equal(classifyTestFile('deploy/load/test/run-evidence.posix.test.mjs')?.name, 'load-harness-posix');
  assert.equal(classifyTestFile('deploy/load/test/run-evidence.test.mjs')?.name, 'load-harness-unit');
  assert.equal(classifyTestFile('packages/chess-core/test/fen.test.ts')?.name, 'domain-hermetic-unit');
});

test('topology: extractRunnerPatterns mechanically extracts globs and files from package runner scripts', () => {
  assert.deepEqual(
    extractRunnerPatterns('node ../../scripts/run-zero-skip.mjs -- node --test --test-concurrency=1 "dist-test/test/**/*.posix.test.js"'),
    ['dist-test/test/**/*.posix.test.js']
  );
  assert.deepEqual(
    extractRunnerPatterns('tsc -p tsconfig.test.json && node ../../scripts/run-zero-skip.mjs -- node --test dist-test/test/a.test.js dist-test/test/b.test.js'),
    ['dist-test/test/a.test.js', 'dist-test/test/b.test.js']
  );
  assert.deepEqual(
    extractRunnerPatterns('playwright test'),
    ['e2e/**/*.spec.ts']
  );
  assert.deepEqual(extractRunnerPatterns('echo "not a test runner"'), []);
});

test('topology: runner reachability mechanically validates package manifest configuration', () => {
  const smokeSuite = SUITE_DEFINITIONS.find((s) => s.name === 'api-engine-smoke');
  assert.ok(smokeSuite?.isReachable);
  assert.equal(smokeSuite.isReachable('packages/api/test/analysis-stockfish-smoke.test.ts'), true);
  assert.equal(smokeSuite.isReachable('packages/api/test/analysis-unknown-smoke.test.ts'), false);

  const persistenceUnitSuite = SUITE_DEFINITIONS.find((s) => s.name === 'persistence-unit');
  assert.ok(persistenceUnitSuite?.isReachable);
  assert.equal(persistenceUnitSuite.isReachable('packages/persistence/test/event-store.test.ts'), true);
  assert.equal(persistenceUnitSuite.isReachable('packages/persistence/test/pg.integration.test.ts'), false);

  const apiUnitSuite = SUITE_DEFINITIONS.find((s) => s.name === 'api-unit');
  assert.ok(apiUnitSuite?.isReachable);
  assert.equal(apiUnitSuite.isReachable('packages/api/test/auth.test.ts'), true);
  assert.equal(apiUnitSuite.isReachable('packages/api/test/analysis-stockfish-smoke.test.ts'), false);
  assert.equal(apiUnitSuite.isReachable('packages/api/test/diagnostics/signature-b-correlate.posix.test.ts'), false);
  assert.equal(apiUnitSuite.isReachable('packages/api/test/pg-security.integration.test.ts'), false);
});

test('topology: falsification regression proves validation fails when runner glob narrows', () => {
  // Falsification Case 1: Narrowing api test:posix in manifest causes nested posix test to become unreachable
  const falsifiedPosix = verifyTestTopology(undefined, {
    manifestOverrides: {
      'packages/api/package.json': {
        scripts: {
          'test:posix': 'npm run build:test && node ../../scripts/run-zero-skip.mjs -- node --test --test-concurrency=1 "dist-test/test/*.posix.test.js"',
        },
      },
    },
  });
  assert.ok(falsifiedPosix.unreachable.length > 0, 'Topology check must fail when runner glob is non-recursive');
  const posixFailure = falsifiedPosix.unreachable.find((u) => u.file === 'packages/api/test/diagnostics/signature-b-correlate.posix.test.ts');
  assert.ok(posixFailure, 'signature-b-correlate.posix.test.ts must be flagged unreachable when glob does not recurse');
  assert.equal(posixFailure.suite, 'api-posix-unit');

  // Falsification Case 2: Narrowing test:scripts in root manifest causes unlisted scripts test to become unreachable
  const falsifiedScripts = verifyTestTopology(undefined, {
    manifestOverrides: {
      'package.json': {
        scripts: {
          'test:scripts': 'node scripts/run-zero-skip.mjs -- node --test "scripts/test/zero-skip-enforcement.test.mjs"',
        },
      },
    },
  });
  assert.ok(falsifiedScripts.unreachable.length > 0, 'Topology check must fail when root script runner is narrowed');
  const scriptsFailure = falsifiedScripts.unreachable.find((u) => u.file === 'scripts/test/check-test-topology.test.mjs');
  assert.ok(scriptsFailure, 'check-test-topology.test.mjs must be flagged unreachable when test:scripts is narrowed');
  assert.equal(scriptsFailure.suite, 'scripts-unit');

  // Falsification Case 3: Narrowing persistence test:unit to a non-existent pattern causes all persistence tests to be unreachable
  const falsifiedPersistence = verifyTestTopology(undefined, {
    manifestOverrides: {
      'packages/persistence/package.json': {
        scripts: {
          'test:unit': 'node ../../scripts/run-zero-skip.mjs -- node --test "dist-test/test/none.test.js"',
        },
      },
    },
  });
  assert.ok(falsifiedPersistence.unreachable.length >= 7, 'All persistence unit tests must be flagged unreachable');
  assert.ok(falsifiedPersistence.unreachable.every((u) => u.suite === 'persistence-unit'));
});

test('topology: classifyTestFile returns null for unknown files', () => {
  assert.equal(classifyTestFile('random/path/unknown.test.ts'), null);
});

