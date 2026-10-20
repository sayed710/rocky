/**
 * The #127 stored-history boundary, as packaging and imports enforce it: the subpath resolves at
 * runtime, the package's internals do not, and only the reviewed finished-game readers import it.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

const REPO = join(__dirname, '..', '..', '..', '..');

test('@chess-platform/game exposes its root and the stored-history subpath, and nothing else', () => {
  const root = require('@chess-platform/game') as Record<string, unknown>;
  const stored = require('@chess-platform/game/stored-history') as Record<string, unknown>;
  assert.equal(typeof root.Game, 'function');
  assert.equal(typeof stored.replayStoredHistory, 'function');
  assert.equal(root.replayStoredHistory, undefined, 'the replay is not on the root entry');
  for (const deep of ['@chess-platform/game/dist/game.js', '@chess-platform/game/dist/internal/stored-replay-key.js', '@chess-platform/game/package.json']) {
    assert.throws(() => require(deep), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, deep);
  }
});

/** Every TypeScript source file under the given repository-relative roots, test files excluded. */
function sources(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('dist')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(REPO, path).split(sep).join('/'));
    }
  };
  for (const root of roots) walk(join(REPO, root));
  return out;
}

const ALLOWED_IMPORTERS = [
  'packages/api/src/anti-cheat/source.ts',
  'packages/api/src/bot-detection/source.ts',
  'packages/api/src/game-export/finished-game-pgn.ts',
  'packages/api/src/game-review/finished-game-review.ts',
  'packages/api/src/tournament/durable-finished-game.ts',
  'packages/api/src/tournament/durable-live-view.ts',
];

test('only the reviewed finished-game readers import the stored-history replay or its key', () => {
  const roots = readdirSync(join(REPO, 'packages')).map((p) => `packages/${p}/src`).filter((p) => {
    try {
      return statSync(join(REPO, p)).isDirectory();
    } catch {
      return false;
    }
  });
  const importers = sources(...roots, 'services/gateway/src').filter((file) => {
    const text = readFileSync(join(REPO, file), 'utf8');
    return /['"]@chess-platform\/game\/stored-history['"]/.test(text) || /stored-replay-key['"]/.test(text);
  });
  assert.deepEqual(importers.sort(), [
    ...ALLOWED_IMPORTERS,
    'packages/game/src/game.ts',
    'packages/game/src/stored-history.ts',
  ].sort());
});
