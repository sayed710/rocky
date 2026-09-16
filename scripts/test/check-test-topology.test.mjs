import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  findTestFiles,
  classifyTestFile,
  verifyTestTopology,
  SUITE_DEFINITIONS,
} from '../check-test-topology.mjs';

test('topology: all test files in the repository are classified into explicit suites', () => {
  const result = verifyTestTopology();
  assert.equal(result.unclassified.length, 0, `Found unclassified test files: ${result.unclassified.join(', ')}`);
  assert.ok(result.totalFiles > 300, `Expected over 300 test files, got ${result.totalFiles}`);
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

test('topology: classifyTestFile returns null for unknown files', () => {
  assert.equal(classifyTestFile('random/path/unknown.test.ts'), null);
});
