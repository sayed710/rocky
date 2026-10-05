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
  console.log('[O09 mutation] GREEN: original contract; no production files modified');
  const lifecycle = await readFile(new URL('./lib/production-journey-lifecycle.mjs', import.meta.url), 'utf8');
  const lifecycleTests = (await readFile(new URL('./test/production-journey-lifecycle.test.mjs', import.meta.url), 'utf8'))
    .replace('../lib/production-journey-lifecycle.mjs', './lifecycle.mjs');
  const target = '    await work;';
  assert.ok(lifecycle.includes(target), 'Lifecycle mutation target drift');
  await writeFile(join(directory, 'lifecycle.test.mjs'), lifecycleTests);
  const racedSource = lifecycle
    .replace('  let expired = false;', '  let expired = false; let rejectDeadline; const deadline = new Promise((_, reject) => { rejectDeadline = reject; });')
    .replace('    expired = true;', '    expired = true; rejectDeadline(new Error("deadline exceeded"));')
    .replace(target, '    await Promise.race([work, deadline]);');
  await writeFile(join(directory, 'lifecycle.mjs'), racedSource);
  const raced = spawnSync(process.execPath, ['--test', join(directory, 'lifecycle.test.mjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(raced.status, 1, `Deadline race mutation survived\n${raced.stdout}${raced.stderr}`);
  assert.match(raced.stdout, /AssertionError|ERR_ASSERTION/, 'Deadline race did not fail its cleanup assertion');
  console.log('[O09 mutation] KILLED: cleanup races active work');
  await writeFile(join(directory, 'lifecycle.mjs'), lifecycle);
  const settled = spawnSync(process.execPath, ['--test', join(directory, 'lifecycle.test.mjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(settled.status, 0, settled.stdout + settled.stderr);
  console.log('[O09 mutation] GREEN: original lifecycle');
} finally {
  await rm(directory, { recursive: true, force: true });
}
