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
  abort: 'packages/persistence/src/pg/abortable-client.ts',
  diagnostics: 'packages/api/src/tournament/arena-diagnostics.ts',
};
const originals = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(join(root, path))]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function restore() { for (const [key, path] of Object.entries(paths)) writeFileSync(join(root, path), originals[key]); }
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });
const edit = (key, before, after) => ({ key, before, after });
const outcomeBlock = `      else arena.recordResultByGame(gameId, result, nowMs);\n      arena.pairAvailable(nowMs);`;
const mutations = [
  ['local Date.now authority', [edit('service', 'arena.isExpired(read.nowMs)', 'arena.isExpired(Date.now())'),
    edit('service', 'current.settle(nowMs)', 'current.settle(Date.now())')], 'unit'],
  ['pairing permitted at exact T', [edit('domain', 'return nowMs >= this.startedAtMs + this.config.durationMs;', 'return nowMs > this.startedAtMs + this.config.durationMs;')], 'unit'],
  ['settlement at T-1', [edit('domain', 'return nowMs >= this.startedAtMs + this.config.durationMs;', 'return nowMs + 1 >= this.startedAtMs + this.config.durationMs;')], 'unit'],
  ['post-deadline abandon repartner', [edit('service', outcomeBlock, '      else arena.recordResultByGame(gameId, result, nowMs);\n      arena.pairAvailable(result === \'*\' ? 0 : nowMs);')], 'unit'],
  ['post-deadline result reparing', [edit('service', outcomeBlock, '      else arena.recordResultByGame(gameId, result, 0);\n      arena.pairAvailable(0);')], 'unit'],
  ['duplicate logical settlement writes', [edit('pg', 'if (!isDeepStrictEqual(snapshot, before)) {', 'if (true) {')], 'pg'],
  ['start retry changes effective deadline', [edit('domain', "    if (this.state !== 'registration') return;", '    // MUTATION: restart any state'),
    edit('pg', "if (before.startedAtMs !== undefined && snapshot.startedAtMs !== before.startedAtMs) throw new Error('Arena start instant is immutable');", '// MUTATION: permit start replacement')], 'pg'],
  ['authority failure falls back locally', [edit('service', "        throw e; // infrastructure/corruption reaches the router's sanitized 5xx handler", '        const fallback = await this.load(id);\n        fallback.settle(this.clock?.() ?? Date.now());\n        return fallback;')], 'unit'],
  ['generic stale snapshot save bypasses version CAS', [edit('pg', 'WHERE id = $1 AND version = $7', 'WHERE id = $1 AND $7::int >= 0')], 'pg'],
  ['poison Arena stops page processing', [edit('worker', '        });\n      }\n    }\n    this.options.metrics', '        });\n        break;\n      }\n    }\n    this.options.metrics')], 'pg'],
  ['crash permanently consumes due work', [edit('pg', '    return result.rows.map(row => row.tournament_id);', '    await this.pool.query(\'DELETE FROM arena_deadlines WHERE tournament_id = ANY($1::text[])\', [result.rows.map(row => row.tournament_id)]);\n    return result.rows.map(row => row.tournament_id);')], 'pg'],
  ['finished Arena keeps due row', [edit('migration', '    DELETE FROM arena_deadlines WHERE tournament_id = NEW.id;', '    PERFORM 1;')], 'pg'],
  ['pre-deadline committed pairing discarded in recovery', [edit('service', '    const arena = await this.getTournament(id, signal);', '    const arena = await this.getTournament(id, signal);\n    if (arena.isExpired(this.clock?.() ?? Date.now())) return arena;')], 'unit'],
  ['duplicate reporter scores next pairing twice', [edit('service', '      if (!arena.pairingForGame(gameId)) return;', `      if (!arena.pairingForGame(gameId)) {\n        const next = arena.toSnapshot().gameLinks?.[0]?.[1];\n        if (next) arena.recordResultByGame(next, result === '*' ? 'draw' : result, nowMs);\n        return;\n      }`)], 'unit'],
  ['replica skew changes database decision', [edit('pg', 'const nowMs = this.arenaTime(time.rows[0]?.ms);', 'const nowMs = _simulationClock ? _simulationClock() : this.arenaTime(time.rows[0]?.ms);')], 'pg'],
  ['new authorization collides with legacy orphan namespace', [edit('launcher', 'const identity = JSON.stringify(input.arenaLaunchNamespace', 'const identity = JSON.stringify(false')], 'pg'],
  ['legacy ended slot is incorrectly consumed as proven outcome', [edit('launcher', 'if (ending && input.committedArenaPairing && !input.arenaLaunchNamespace) {', 'if (false) {')], 'pg'],
  ['postcommit recovery failure falsely rejects durable registration', [edit('service', '      return committed;', '      void committed;\n      throw error;')], 'unit'],
  ['continuous arrival scan discards finite watermark', [edit('worker', 'signal, this.ceiling)', 'signal, null)')], 'unit'],
  ['empty watermark admits an unbounded arrival scan', [edit('worker', '    if (this.ceiling === null) return { scanned: 0, failed: 0 };', '    // MUTATION: scan arrivals without a finite watermark')], 'unit'],
  ['stop fails to cancel or prevent subsequent Arena work', [edit('worker', '    this.controller?.abort();', '    // MUTATION: drain without cancellation')], 'unit'],
  ['malformed links suppress repair projection', [edit('migration', "OR jsonb_typeof(link.value->1) IS DISTINCT FROM 'string'", 'OR false')], 'pg-migration'],
  ['work branches sort entire dense backlog before limiting', [edit('pg', 'ORDER BY tournament_id LIMIT $2)', 'ORDER BY tournament_id)')], 'pg-migration'],
  ['cancellation returns an active query client instead of destroying it', [edit('abort', '      release(true);\n      reject(signal!.reason);', '      release();\n      reject(signal!.reason);')], 'pg-client'],
  ['ignore membership boundary on both query branches', [edit('pg', 'AND ($3::bigint IS NULL OR work_sequence <= $3)', 'AND ($3::bigint IS NULL OR $3::bigint >= 0)')], 'pg'],
  ['recompute membership boundary every page', [edit('worker', 'if (this.cursor === null) this.ceiling =', 'this.ceiling =')], 'pg'],
  ['projection update advances existing membership', [edit('migration', 'invalid = EXCLUDED.invalid;', 'invalid = EXCLUDED.invalid, work_sequence = DEFAULT;')], 'pg'],
  ['skip earliest eligible member', [edit('worker', 'for (const id of ids) {', 'for (const id of ids.slice(1)) {')], 'pg'],
  ['recovered membership boundary excludes durable work', [edit('pg', 'return result.rows[0]?.ceiling ?? null;', 'return result.rows[0] ? \'0\' : null;')], 'pg'],
  ['participant state validation skipped in repair projection', [edit('migration', "player_id := participant #>> '{}';", "CONTINUE; -- MUTATION skips participant state validation\n        player_id := participant #>> '{}';")], 'pg-migration'],
  ['direct creation accepts invalid duration', [edit('service', 'if (!Number.isSafeInteger(cmd.durationMs) || cmd.durationMs <= 0)', 'if (false)')], 'unit'],
  ['inactive games corruption loses repair classification', [edit('diagnostics', " || message.startsWith('Invalid inactive Arena games;')", '')], 'unit'],
  ['linked active pairing bypasses structural repair validation', [edit('migration', "FOR active_pairing IN SELECT key, value FROM jsonb_each(NEW.snapshot->'activeGames') LOOP", "FOR active_pairing IN SELECT key, value FROM jsonb_each(NEW.snapshot->'activeGames') LOOP\n        CONTINUE; -- MUTATION bypasses active pairing structure")], 'pg-migration'],
  ['duplicate simultaneous player escapes repair projection', [edit('migration', 'OR white_player = ANY(active_players) OR black_player = ANY(active_players)', 'OR false')], 'pg-migration'],
  ['invalid pairing sequence escapes repair projection', [edit('migration', 'IF sequence_value <= 0 OR sequence_value > 9007199254740991\n           OR sequence_value <> trunc(sequence_value) OR sequence_value > max_sequence THEN', 'IF false THEN')], 'pg-migration'],
];
// A named PostgreSQL witness makes each kill attributable to its intended
// invariant. Full positive suites run separately; mutation runs need no unrelated cases.
const pgWitnesses = new Map([
  ['linked active pairing bypasses structural repair validation', 'active pairing corruption is immediate repair even when linked before expiry'],
  ['duplicate simultaneous player escapes repair projection', 'active pairing corruption is immediate repair even when linked before expiry'],
  ['invalid pairing sequence escapes repair projection', 'active pairing corruption is immediate repair even when linked before expiry'],
  ['ignore membership boundary on both query branches', 'membership boundary excludes late due, pending and invalid arrivals on both query branches'],
  ['recompute membership boundary every page', 'membership boundary revisits earlier due work despite repeated middle-ID arrivals'],
  ['projection update advances existing membership', 'membership boundary survives worker restart with concurrent recovery and exact deadline'],
  ['skip earliest eligible member', 'membership boundary revisits earlier due work despite repeated middle-ID arrivals'],
  ['recovered membership boundary excludes durable work', 'membership boundary survives worker restart with concurrent recovery and exact deadline'],
  ['duplicate logical settlement writes', 'opposite-clock replicas and workers cannot finish idle Arena before T'],
  ['start retry changes effective deadline', 'lost response after authoritative start commit recovers the same deadline and one game'],
  ['generic stale snapshot save bypasses version CAS', 'row lock wait crosses deadline; time is read after acquisition and stale saves fail'],
  ['poison Arena stops page processing', 'two PostgreSQL workers settle once, skip poison rows and catch up after restart'],
  ['crash permanently consumes due work', 'rollback before commit preserves due work for restarted worker'],
  ['finished Arena keeps due row', 'two PostgreSQL workers settle once, skip poison rows and catch up after restart'],
  ['replica skew changes database decision', 'production PostgreSQL clock establishes start independently of process clocks'],
  ['new authorization collides with legacy orphan namespace', 'new committed authorization cannot consume a legacy ended orphan in the same slot'],
  ['legacy ended slot is incorrectly consumed as proven outcome', 'legacy unlinked pairing refuses ambiguous ended slot'],
]);
function command(args, cwd = root) {
  return spawnSync(process.execPath, args, { cwd, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function build(edits) {
  const workspaces = new Set(edits.map(({ key }) => key === 'domain' ? 'tournament' : ['pg', 'migration', 'abort'].includes(key) ? 'persistence' : 'api'));
  // Domain declarations must precede their dependent persistence build.
  for (const name of ['tournament', 'persistence', 'api']) if (workspaces.has(name)) {
    const result = command([npmCli, 'run', name === 'api' ? 'build:test' : 'build', '--workspace', `@chess-platform/${name}`]);
    if (result.status !== 0) throw new Error(`Compile failed (${name}); not a kill:\n${result.stdout}\n${result.stderr}`);
  }
  if (edits.some(({ key }) => key === 'abort' || key === 'pg')) {
    const result = command([npmCli, 'run', 'build:test', '--workspace', '@chess-platform/persistence']);
    if (result.status !== 0) throw new Error(`Compile failed (persistence tests); not a kill:\n${result.stdout}\n${result.stderr}`);
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
      const test = suite === 'pg-client' ? 'dist-test/test/abortable-client.test.js'
        : suite === 'pg-migration' ? 'dist-test/test/arena-deadlines.integration.test.js'
        : suite === 'unit' ? 'dist-test/test/arena-deadline.test.js' : 'dist-test/test/arena-deadline.integration.test.js';
      const testNamePattern = pgWitnesses.get(name);
      const result = command(['--test', '--test-concurrency=1', ...(testNamePattern ? [`--test-name-pattern=${testNamePattern}`] : []), test],
        join(root, suite.startsWith('pg-') ? 'packages/persistence' : 'packages/api'));
      const output = result.stdout + result.stderr;
      if (result.signal || result.error) throw new Error(`Process failure is not a kill: ${name}`);
      if (result.status === 0) throw new Error(`Mutation survived: ${name}`);
      if (!/AssertionError|ERR_ASSERTION|Missing expected|Concurrent update|Invalid Arena|Unknown gameId|Invalid persisted Arena/.test(output)) {
        throw new Error(`Mutation failed without recognizable behavioral evidence: ${name}\n${output}`);
      }
      evidence.push({ name, compiled: true, killed: true, suite,
        ...(testNamePattern ? { testNamePattern } : {}),
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
