/** Behavioral falsification runner. Run serially with DATABASE_URL against PostgreSQL 16.
 * Every mutation must compile; source bytes are restored even on a failed check. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npmCli)) throw new Error('Cannot locate npm CLI beside Node');
const paths = {
  domain: 'packages/tournament/src/arena.ts',
  service: 'packages/api/src/tournament/arena.service.ts',
  pg: 'packages/persistence/src/pg/repositories.ts',
  worker: 'packages/api/src/tournament/arena-deadline-worker.ts',
  migration: 'packages/persistence/migrations/0049_arena_deadlines.sql',
  launcher: 'packages/api/src/tournament/durable-launcher.ts',
};
const originals = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(join(root, path))]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function restore() { for (const [key, path] of Object.entries(paths)) writeFileSync(join(root, path), originals[key]); }
process.on('SIGINT', () => { restore(); process.exit(130); });
const edit = (key, before, after) => ({ key, before, after });
const outcomeBlock = `      else arena.recordResultByGame(gameId, result, nowMs);\n      arena.pairAvailable(nowMs);`;
const mutations = [
  ['local Date.now authority', [edit('service', 'arena.settle(nowMs)', 'arena.settle(Date.now())')], 'unit'],
  ['pairing permitted at exact T', [edit('domain', 'return nowMs >= this.startedAtMs + this.config.durationMs;', 'return nowMs > this.startedAtMs + this.config.durationMs;')], 'unit'],
  ['settlement at T-1', [edit('domain', 'return nowMs >= this.startedAtMs + this.config.durationMs;', 'return nowMs + 1 >= this.startedAtMs + this.config.durationMs;')], 'unit'],
  ['post-deadline abandon repartner', [edit('service', outcomeBlock, '      else arena.recordResultByGame(gameId, result, nowMs);\n      arena.pairAvailable(result === \'*\' ? 0 : nowMs);')], 'unit'],
  ['post-deadline result reparing', [edit('service', outcomeBlock, '      else arena.recordResultByGame(gameId, result, 0);\n      arena.pairAvailable(0);')], 'unit'],
  ['duplicate logical settlement writes', [edit('pg', 'if (!isDeepStrictEqual(snapshot, before)) {', 'if (true) {')], 'pg'],
  ['start retry changes effective deadline', [edit('domain', "    if (this.state !== 'registration') return;", '    // MUTATION: restart any state'),
    edit('pg', "if (before.startedAtMs !== undefined && snapshot.startedAtMs !== before.startedAtMs) throw new Error('Arena start instant is immutable');", '// MUTATION: permit start replacement')], 'pg'],
  ['authority failure falls back locally', [edit('service', '        if (e instanceof HttpError) throw e;', '        const fallback = await this.load(id);\n        fallback.settle(this.clock?.() ?? Date.now());\n        return fallback;')], 'unit'],
  ['stale snapshot overwrites current version', [edit('pg', 'WHERE id = $1 AND version = $7', 'WHERE id = $1 AND $7::int >= 0')], 'pg'],
  ['poison Arena stops page processing', [edit('worker', '        });\n      }\n    }\n    this.options.metrics', '        });\n        break;\n      }\n    }\n    this.options.metrics')], 'pg'],
  ['crash permanently consumes due work', [edit('pg', '    return result.rows.map(row => row.tournament_id);', '    await this.pool.query(\'DELETE FROM arena_deadlines WHERE tournament_id = ANY($1::text[])\', [result.rows.map(row => row.tournament_id)]);\n    return result.rows.map(row => row.tournament_id);')], 'pg'],
  ['finished Arena keeps due row', [edit('migration', '    DELETE FROM arena_deadlines WHERE tournament_id = NEW.id;', '    PERFORM 1;')], 'pg'],
  ['pre-deadline committed pairing discarded in recovery', [edit('service', '  async reconcile(id: string): Promise<ArenaTournament> {\n    const arena = await this.getTournament(id);', '  async reconcile(id: string): Promise<ArenaTournament> {\n    const arena = await this.getTournament(id);\n    if (arena.isExpired(this.clock?.() ?? Date.now())) return arena;')], 'unit'],
  ['duplicate reporter scores next pairing twice', [edit('service', '      if (!arena.pairingForGame(gameId)) return;', `      if (!arena.pairingForGame(gameId)) {\n        const next = arena.toSnapshot().gameLinks?.[0]?.[1];\n        if (next) arena.recordResultByGame(next, result === '*' ? 'draw' : result, nowMs);\n        return;\n      }`)], 'unit'],
  ['replica skew changes database decision', [edit('pg', 'apply: (snapshot: ArenaSnapshot, nowMs: number) => ArenaSnapshot): Promise<ArenaSnapshot | null>', 'apply: (snapshot: ArenaSnapshot, nowMs: number) => ArenaSnapshot, simulationClock?: () => number): Promise<ArenaSnapshot | null>'),
    edit('pg', 'const nowMs = Number(time.rows[0]!.ms);', 'const nowMs = simulationClock ? simulationClock() : Number(time.rows[0]!.ms);')], 'pg'],
  ['new authorization collides with legacy orphan namespace', [edit('launcher', 'const identity = JSON.stringify(input.arenaLaunchNamespace', 'const identity = JSON.stringify(false')], 'pg'],
  ['legacy ended slot is incorrectly consumed as proven outcome', [edit('launcher', 'if (ending && input.committedArenaPairing && !input.arenaLaunchNamespace) {', 'if (false) {')], 'pg'],
];
function command(args, cwd = root) {
  return spawnSync(process.execPath, args, { cwd, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function build(edits) {
  const workspaces = new Set(edits.map(({ key }) => key === 'domain' ? 'tournament' : key === 'pg' || key === 'migration' ? 'persistence' : 'api'));
  // Domain declarations must precede their dependent persistence build.
  for (const name of ['tournament', 'persistence', 'api']) if (workspaces.has(name)) {
    const result = command([npmCli, 'run', name === 'api' ? 'build:test' : 'build', '--workspace', `@chess-platform/${name}`]);
    if (result.status !== 0) throw new Error(`Compile failed (${name}); not a kill:\n${result.stdout}\n${result.stderr}`);
  }
}
const evidence = [];
try {
  for (const [name, edits, suite] of mutations) {
    try {
      for (const { key, before, after } of edits) {
        const path = join(root, paths[key]);
        // Windows checkouts may use CRLF. Match multiline anchors consistently;
        // restoration still uses the original raw Buffer, never normalized text.
        const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
        if (!source.includes(before)) throw new Error(`Mutation anchor absent: ${name}`);
        writeFileSync(path, source.replaceAll(before, after));
      }
      build(edits);
      const test = suite === 'unit' ? 'dist-test/test/arena-deadline.test.js' : 'dist-test/test/arena-deadline.integration.test.js';
      const result = command(['--test', '--test-concurrency=1', test], join(root, 'packages/api'));
      const output = result.stdout + result.stderr;
      if (result.status === 0) throw new Error(`Mutation survived: ${name}`);
      if (!/AssertionError|ERR_ASSERTION|Missing expected|Concurrent update|Invalid Arena|Unknown gameId|Invalid persisted Arena/.test(output)) {
        throw new Error(`Mutation failed without recognizable behavioral evidence: ${name}\n${output}`);
      }
      evidence.push({ name, compiled: true, killed: true, suite,
        failingTests: output.split('\n').filter(line => /✖/.test(line)).map(line => line.trim()) });
      process.stdout.write(`${evidence.length}/${mutations.length} compiled and killed: ${name}\n`);
    } finally { restore(); build(edits); }
  }
  for (const [key, path] of Object.entries(paths)) {
    if (hash(readFileSync(join(root, path))) !== hash(originals[key])) throw new Error(`Source restoration mismatch: ${path}`);
  }
  writeFileSync(join(root, 'docs/audits/ARENA_DEADLINE_MUTATIONS_2026-10-04.json'), JSON.stringify({ mutations: evidence,
    restoredByteIdentically: true, sourceSha256: Object.fromEntries(Object.entries(originals).map(([key, bytes]) => [paths[key], hash(bytes)])) }, null, 2) + '\n');
} finally { restore(); }
