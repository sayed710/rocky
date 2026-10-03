/** Serial local validation: keep memory bounded and preserve exact gate counts. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const gates = [
  ['build', ['run', 'build']], ['lint', ['run', 'lint']],
  ...Object.keys(pkg.scripts).filter(name => name.startsWith('check:')).map(name => [name, ['run', name]]),
  ['test:scripts', ['run', 'test:scripts']],
  ['hermetic', ['test'], true],
  ['postgres:persistence', ['run', 'test:integration:postgres', '--workspace', '@chess-platform/persistence']],
  ['postgres:api', ['run', 'test:integration:postgres', '--workspace', '@chess-platform/api']],
  ['gateway:build', ['run', 'build', '--prefix', 'services/gateway']],
  ['gateway:lint', ['run', 'lint', '--prefix', 'services/gateway']],
  ['gateway:test', ['test', '--prefix', 'services/gateway']],
];
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for local validation');
const from = process.argv[2];
const start = from ? gates.findIndex(([name]) => name === from) : 0;
if (start < 0) throw new Error(`Unknown gate: ${from}`);
const evidencePath = join(root, 'docs/audits/ARENA_DEADLINE_LOCAL_VALIDATION_2026-10-04.json');
const evidence = start ? JSON.parse(readFileSync(evidencePath, 'utf8')).slice(0, start) : [];
if (evidence.some(record => record.exitCode !== 0)) throw new Error('Earlier gates did not pass');
for (const [name, args, hermetic] of gates.slice(start)) {
  const env = { ...process.env };
  if (hermetic) { delete env.DATABASE_URL; delete env.REDIS_URL; }
  process.stdout.write(`Starting ${name}\n`);
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, env,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(root, `arena-validation-${name.replaceAll(':', '-')}.log`), output);
  const totals = [...output.matchAll(/(?:ℹ|#) tests (\d+)/g)].map(match => Number(match[1]));
  const skips = [...output.matchAll(/(?:ℹ|#) skipped (\d+)/g)].map(match => Number(match[1]));
  const record = { gate: name, exitCode: result.status, tests: totals.reduce((a, b) => a + b, 0),
    skipped: skips.reduce((a, b) => a + b, 0), signal: result.signal };
  evidence.push(record);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  if (result.status !== 0 || record.skipped !== 0) {
    process.stdout.write(output.slice(-14_000));
    throw new Error(`Gate failed without retry: ${name}`);
  }
  process.stdout.write(`Passed ${name}: ${record.tests} tests, ${record.skipped} skips\n`);
}
