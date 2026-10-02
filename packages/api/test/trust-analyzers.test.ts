/** The trust worker's configuration refuses anything it cannot run exactly as asked (ADR-0152). */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveTrustWorkerConfig } from '../src/trust-analyzers';

const BASE = { DATABASE_URL: 'postgres://x@localhost/x', STOCKFISH_PATH: '/usr/local/bin/stockfish' };

test('both analyzers on, or either one alone', () => {
  assert.deepEqual(resolveTrustWorkerConfig({ ...BASE, BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '1' }), { botAnalysis: true, antiCheatAnalysis: true });
  assert.deepEqual(resolveTrustWorkerConfig({ ...BASE, BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '0' }), { botAnalysis: true, antiCheatAnalysis: false });
  // Bot timing needs no engine.
  assert.deepEqual(
    resolveTrustWorkerConfig({ DATABASE_URL: BASE.DATABASE_URL, BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '0' }),
    { botAnalysis: true, antiCheatAnalysis: false },
  );
});

test('no database, no engine for anti-cheat, nothing to do, or a malformed flag stops the worker', () => {
  const refusals: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{ BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: '0' }, /DATABASE_URL is required/],
    [{ DATABASE_URL: BASE.DATABASE_URL, BOT_AUTO_ANALYZE: '0', ANTICHEAT_AUTO_ANALYZE: '1' }, /requires STOCKFISH_PATH/],
    [{ ...BASE, BOT_AUTO_ANALYZE: '0', ANTICHEAT_AUTO_ANALYZE: '0' }, /nothing to do/],
    [{ ...BASE, ANTICHEAT_AUTO_ANALYZE: '1' }, /BOT_AUTO_ANALYZE must be "0" or "1"/],
    [{ ...BASE, BOT_AUTO_ANALYZE: 'true', ANTICHEAT_AUTO_ANALYZE: '1' }, /BOT_AUTO_ANALYZE must be "0" or "1"/],
    [{ ...BASE, BOT_AUTO_ANALYZE: '1', ANTICHEAT_AUTO_ANALYZE: 'yes' }, /ANTICHEAT_AUTO_ANALYZE must be "0" or "1"/],
  ];
  for (const [env, message] of refusals) assert.throws(() => resolveTrustWorkerConfig(env), message);
});
