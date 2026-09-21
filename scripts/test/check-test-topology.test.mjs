import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findTestFiles,
  classifyTestFile,
  verifyTestTopology,
  isAllowedPlacement,
  extractRunnerPatterns,
  extractPlaywrightPatterns,
  getPlaywrightDiscoveredFiles,
  matchRunnerPattern,
  isTestFileReachableByRunner,
  SUITE_DEFINITIONS,
} from '../check-test-topology.mjs';
import {
  discoverWorkspacePackages,
  getHermeticWorkspaces,
} from '../lib/workspace-topology.mjs';


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
  // Mechanically extracts from packages/web/playwright.config.ts testDir ('./e2e')
  assert.deepEqual(
    extractRunnerPatterns('playwright test', { manifestDir: 'packages/web' }),
    ['e2e/**/*.spec.ts']
  );
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web'),
    ['e2e/**/*.spec.ts']
  );
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': "testDir: './smoke-e2e', testMatch: '**/*.acceptance.ts'",
      },
    }),
    ['smoke-e2e/**/*.acceptance.ts']
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

test('topology: falsification regression proves validation fails when Playwright testDir drifts', () => {
  // Falsification Case 4: Changing testDir in Playwright config causes web e2e tests to become unreachable
  const falsifiedPlaywright = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        import type { PlaywrightTestConfig } from '@playwright/test';
        const config: PlaywrightTestConfig = {
          testDir: './drifted-e2e',
        };
        export default config;
      `,
    },
  });
  assert.ok(falsifiedPlaywright.unreachable.length >= 25, 'Topology check must fail when Playwright testDir drifts');
  assert.ok(falsifiedPlaywright.unreachable.every((u) => u.suite === 'acceptance-playwright'));
  const webFailure = falsifiedPlaywright.unreachable.find((u) => u.file === 'packages/web/e2e/game-actions.spec.ts');
  assert.ok(webFailure, 'packages/web/e2e/game-actions.spec.ts must be flagged unreachable when Playwright testDir is changed to ./drifted-e2e');
  assert.equal(webFailure.suite, 'acceptance-playwright');
});

test('workspace topology: filters hermetic workspaces by packages/ filesystem location and derives relDir dynamically', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'synth-workspace-'));
  try {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'synthetic-monorepo',
        workspaces: ['packages/*', 'services/*', 'tools/cli'],
      })
    );
    mkdirSync(join(tmpDir, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@chess-platform/core' })
    );
    mkdirSync(join(tmpDir, 'services', 'gateway'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'services', 'gateway', 'package.json'),
      JSON.stringify({ name: '@chess-platform/gateway' })
    );
    mkdirSync(join(tmpDir, 'tools', 'cli'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'tools', 'cli', 'package.json'),
      JSON.stringify({ name: 'custom-cli' })
    );

    const discovered = discoverWorkspacePackages(tmpDir);
    assert.equal(discovered.length, 3);
    const corePkg = discovered.find((p) => p.name === '@chess-platform/core');
    const gatewayPkg = discovered.find((p) => p.name === '@chess-platform/gateway');
    const cliPkg = discovered.find((p) => p.name === 'custom-cli');

    // relDir must be derived from actual relative path, not hardcoded packages/*
    assert.equal(corePkg?.relDir, 'packages/core');
    assert.equal(gatewayPkg?.relDir, 'services/gateway');
    assert.equal(cliPkg?.relDir, 'tools/cli');

    // getHermeticWorkspaces must ONLY include packages physically located under packages/
    const hermetic = getHermeticWorkspaces(tmpDir);
    assert.deepEqual([...hermetic], ['@chess-platform/core']);
    assert.ok(!hermetic.includes('@chess-platform/gateway'), 'services/* workspace must not be included in hermetic fan-out');
    assert.ok(!hermetic.includes('custom-cli'), 'tools/* workspace must not be included in hermetic fan-out');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('topology: matchRunnerPattern correctly matches glob patterns across directory levels', () => {
  assert.equal(matchRunnerPattern('e2e/**/*.spec.ts', 'e2e/game-actions.spec.ts'), true);
  assert.equal(matchRunnerPattern('e2e/**/*.spec.ts', 'e2e/nested/deep/game-actions.spec.ts'), true);
  assert.equal(matchRunnerPattern('e2e/**/*.spec.ts', 'packages/web/e2e/game-actions.spec.ts'), false);
  assert.equal(matchRunnerPattern('dist-test/test/**/*.posix.test.js', 'dist-test/test/diagnostics/signature-b-correlate.posix.test.js'), true);
  assert.equal(matchRunnerPattern('dist-test/test/**/*.posix.test.js', 'dist-test/test/foo.posix.test.js'), true);
});

test('topology: regex fallback matches **/ as zero or more directory segments', () => {
  const normPattern = 'e2e/**/*.spec.ts';
  const reStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (token) => {
      if (token === '**/') return '(?:[^/]+/)*';
      if (token === '**') return '.*';
      return '[^/]*';
    });
  const re = new RegExp(`^${reStr}$`);
  assert.equal(re.test('e2e/game-actions.spec.ts'), true, 'zero directory segments under e2e must match');
  assert.equal(re.test('e2e/nested/game-actions.spec.ts'), true, 'one directory segment under e2e must match');
  assert.equal(re.test('e2e/nested/deep/game-actions.spec.ts'), true, 'multiple directory segments under e2e must match');
  assert.equal(re.test('other/game-actions.spec.ts'), false, 'different directory must not match');
});

test('topology: extractPlaywrightPatterns confidently resolves literal testDir and defaults testMatch when omitted', () => {
  // Case 1: Real project config (testDir: './e2e', testMatch omitted)
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web'),
    ['e2e/**/*.spec.ts']
  );

  // Case 2: testDir omitted, testMatch omitted -> real Playwright defaults used
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            timeout: 30000,
          };
        `,
      },
    }),
    ['**/*.spec.ts']
  );

  // Case 3: testDir omitted, testMatch provided as literal
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            testMatch: '**/*.acceptance.ts',
          };
        `,
      },
    }),
    ['**/*.acceptance.ts']
  );

  // Case 4: testDir provided, testMatch provided as array of string literals
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            testDir: './e2e',
            testMatch: [
              '**/*.spec.ts',
              '**/*.acceptance.ts',
            ],
          };
        `,
      },
    }),
    ['e2e/**/*.spec.ts', 'e2e/**/*.acceptance.ts']
  );

  // Case 5: Comments containing testDir or testMatch are ignored
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          // testDir: unparseableVariable,
          /* testMatch: unparseableMatch, */
          export default {
            testDir: './e2e',
          };
        `,
      },
    }),
    ['e2e/**/*.spec.ts']
  );

  // Case 6: Preceding string literals containing testMatch or testDir are ignored
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          const note = "Note that testMatch: '**/*.legacy.ts' was deprecated";
          export default {
            testDir: './e2e',
          };
        `,
      },
    }),
    ['e2e/**/*.spec.ts']
  );

  // Case 7: Nested project properties do not override direct config properties
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            projects: [
              {
                name: 'legacy',
                testDir: './nested-legacy',
                testMatch: '**/*.legacy.ts',
              },
            ],
            testDir: './e2e',
          };
        `,
      },
    }),
    ['e2e/**/*.spec.ts']
  );

  // Case 8: Direct property value containing property keywords in string literals is safely skipped
  assert.deepEqual(
    extractPlaywrightPatterns('packages/web', {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            name: "e2e runner with testMatch: '**/*.decoy.ts'",
            testDir: './e2e',
          };
        `,
      },
    }),
    ['e2e/**/*.spec.ts']
  );
});

test('topology: extractPlaywrightPatterns fails closed on non-literal static expressions', () => {
  const overrideVar = {
    'packages/web/playwright.config.ts': `
      const dir = './other-e2e';
      export default { testDir: dir };
    `,
  };
  assert.throws(
    () => extractPlaywrightPatterns('packages/web', { playwrightConfigOverrides: overrideVar }),
    /Cannot mechanically resolve Playwright 'testDir'.*property is present but non-literal or unparseable/
  );

  const overrideExpr = {
    'packages/web/playwright.config.ts': `
      export default {
        testDir: path.join(__dirname, 'e2e'),
      };
    `,
  };
  assert.throws(
    () => extractPlaywrightPatterns('packages/web', { playwrightConfigOverrides: overrideExpr }),
    /Cannot mechanically resolve Playwright 'testDir'/
  );

  const overrideMatchVar = {
    'packages/web/playwright.config.ts': `
      const customMatch = '**/*.spec.ts';
      export default {
        testDir: './e2e',
        testMatch: customMatch,
      };
    `,
  };
  assert.throws(
    () => extractPlaywrightPatterns('packages/web', { playwrightConfigOverrides: overrideMatchVar }),
    /Cannot mechanically resolve Playwright 'testMatch'.*property is present but non-literal or unsupported/
  );
});

test('topology: getPlaywrightDiscoveredFiles derives reachable files directly from Playwright CLI', () => {
  const discovered = getPlaywrightDiscoveredFiles('packages/web');
  assert.equal(discovered.size, 26);
  assert.ok(discovered.has('packages/web/e2e/game-actions.spec.ts'));
  assert.ok(discovered.has('packages/web/e2e/app-loads.spec.ts'));
});

test('topology: falsification regression proves validation flags ignored test files unreachable', () => {
  const falsified = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        export default {
          testDir: './e2e',
          testIgnore: '**/game-actions.spec.ts',
        };
      `,
    },
  });
  assert.ok(falsified.unreachable.length > 0, 'Test file excluded by testIgnore must be unreachable');
  const ignoredFailure = falsified.unreachable.find((u) => u.file === 'packages/web/e2e/game-actions.spec.ts');
  assert.ok(ignoredFailure, 'game-actions.spec.ts must be flagged unreachable');
  assert.equal(ignoredFailure.suite, 'acceptance-playwright');
});

test('topology: falsification regression proves project-level testDir overrides are respected', () => {
  const falsified = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        export default {
          projects: [
            {
              name: 'other',
              testDir: './drifted-e2e',
            },
          ],
        };
      `,
    },
  });
  assert.ok(falsified.unreachable.length >= 25, 'Files outside project testDir must be unreachable');
  assert.ok(falsified.unreachable.every((u) => u.suite === 'acceptance-playwright'));
});

test('topology: falsification regression proves project-level testIgnore excludes files', () => {
  const falsified = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        export default {
          testDir: './e2e',
          projects: [
            {
              name: 'chromium',
              testIgnore: '**/game-actions.spec.ts',
            },
          ],
        };
      `,
    },
  });
  const ignoredFailure = falsified.unreachable.find((u) => u.file === 'packages/web/e2e/game-actions.spec.ts');
  assert.ok(ignoredFailure, 'game-actions.spec.ts must be flagged unreachable by project testIgnore');
});

test('topology: object spreads and dynamic variables in Playwright config are evaluated by Playwright discovery engine', () => {
  // Case A: variable testDir pointing to drifted directory flags e2e files unreachable
  const falsifiedVar = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        const dir = './other-e2e';
        export default { testDir: dir };
      `,
    },
  });
  assert.ok(falsifiedVar.unreachable.length >= 25, 'Variable testDir pointing to ./other-e2e must flag e2e files unreachable');

  // Case B: spread config pointing to ./e2e discovers all files
  const spreadSuccess = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        const base = { testDir: './e2e' };
        export default { ...base };
      `,
    },
  });
  assert.equal(spreadSuccess.unreachable.length, 0, 'Spread config pointing to ./e2e must reach all test files');

  // Case C: spread config pointing to ./other-e2e flags e2e files unreachable
  const spreadDrift = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        const base = { testDir: './other-e2e' };
        export default { ...base };
      `,
    },
  });
  assert.ok(spreadDrift.unreachable.length >= 25, 'Spread config pointing to ./other-e2e must flag e2e files unreachable');
});

test('topology: omitting testMatch uses real Playwright default pattern', () => {
  const defaultMatch = verifyTestTopology(undefined, {
    playwrightConfigOverrides: {
      'packages/web/playwright.config.ts': `
        export default {
          testDir: './e2e',
        };
      `,
    },
  });
  assert.equal(defaultMatch.unreachable.length, 0, 'Omitting testMatch must use Playwright default and discover all e2e spec files');
});

test('topology: unresolvable or errored Playwright configuration fails closed', () => {
  // Case A: export default calls an undefined function
  assert.throws(
    () => verifyTestTopology(undefined, {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default buildDynamicConfig();
        `,
      },
    }),
    /Cannot mechanically resolve Playwright configuration/
  );

  // Case B: export default references an undeclared identifier
  assert.throws(
    () => verifyTestTopology(undefined, {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default nonExistentConfig;
        `,
      },
    }),
    /Cannot mechanically resolve Playwright configuration/
  );

  // Case C: unimported module / function expression throws runtime error
  assert.throws(
    () => verifyTestTopology(undefined, {
      playwrightConfigOverrides: {
        'packages/web/playwright.config.ts': `
          export default {
            testDir: path.join(__dirname, 'e2e'),
          };
        `,
      },
    }),
    /Cannot mechanically resolve Playwright configuration/
  );
});
