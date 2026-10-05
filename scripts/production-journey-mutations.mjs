import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('./lib/production-journey-contract.mjs', import.meta.url), 'utf8');
const tests = (await readFile(new URL('./test/production-journey-contract.test.mjs', import.meta.url), 'utf8'))
  .replace('../lib/production-journey-contract.mjs', './contract.mjs');
const directory = await mkdtemp(join(tmpdir(), 'rookzen-o09-mutations-'));
try {
  const cases = [
    ['casual result allowed', "  assert.equal(game.rated, true);", ''],
    ['rating direction ignored', "  assert.ok(after[0] < before[0], 'Loser rating did not decrease');", ''],
    ['backend port allowed', "  assert.equal(actual.host, edge.host, 'Traffic bypassed the public edge');", ''],
    ['review request omitted', "  assert.ok(evidence.apiPaths.includes(`/v1/games/${evidence.gameId}/review`), 'Review was not requested');", ''],
  ];
  await writeFile(join(directory, 'contract.test.mjs'), tests);
  for (const [name, target, replacement] of cases) {
    assert.ok(source.includes(target), `Mutation target drift: ${name}`);
    await writeFile(join(directory, 'contract.mjs'), source.replace(target, replacement));
    const result = spawnSync(process.execPath, ['--test', join(directory, 'contract.test.mjs')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, `Mutation survived: ${name}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /AssertionError|ERR_ASSERTION/, `No assertion failure for ${name}`);
    console.log(`[O09 mutation] KILLED: ${name}`);
  }
  await writeFile(join(directory, 'contract.mjs'), source);
  const green = spawnSync(process.execPath, ['--test', join(directory, 'contract.test.mjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(green.status, 0, green.stdout + green.stderr);
  console.log('[O09 mutation] GREEN: original contract, 4 tests; no production files modified');
} finally {
  await rm(directory, { recursive: true, force: true });
}
