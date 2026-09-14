import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle, DISPOSABLE_KEYS, DISPOSABLE_TEARDOWN_MAP } from '../src/app/lifecycle.js';
import type { Bootstrapped, DisposableKey } from '../src/app/bootstrap.js';
import type { App } from '../src/app/composition.js';
import type { AuthController } from '../src/app/auth-controller.js';
import type { ThemeToggle } from '../src/app/theme-toggle.js';

function createMockBootstrapped(
  onDispose: (key: DisposableKey) => void,
  nullKeys: ReadonlySet<DisposableKey> = new Set(),
): Bootstrapped {
  const disposables: Record<string, unknown> = {};
  for (const key of DISPOSABLE_KEYS) {
    if (nullKeys.has(key)) {
      disposables[key] = null;
    } else {
      disposables[key] = {
        dispose: () => onDispose(key),
      };
    }
  }

  return {
    app: disposables.app as App,
    auth: disposables.auth as AuthController,
    theme: { toggle: () => {} } as unknown as ThemeToggle,
    controller: disposables.controller as Bootstrapped['controller'],
    board: disposables.board as Bootstrapped['board'],
    lobby: disposables.lobby as Bootstrapped['lobby'],
    profile: disposables.profile as Bootstrapped['profile'],
    leaderboard: disposables.leaderboard as Bootstrapped['leaderboard'],
    tournament: disposables.tournament as Bootstrapped['tournament'],
    tournamentCommentary: disposables.tournamentCommentary as Bootstrapped['tournamentCommentary'],
    search: disposables.search as Bootstrapped['search'],
    messages: disposables.messages as Bootstrapped['messages'],
    teams: disposables.teams as Bootstrapped['teams'],
    forum: disposables.forum as Bootstrapped['forum'],
    learning: disposables.learning as Bootstrapped['learning'],
    endgames: disposables.endgames as Bootstrapped['endgames'],
    studies: disposables.studies as Bootstrapped['studies'],
    passkeys: disposables.passkeys as Bootstrapped['passkeys'],
    passwordReset: disposables.passwordReset as Bootstrapped['passwordReset'],
    emailVerification: disposables.emailVerification as Bootstrapped['emailVerification'],
    connectivity: disposables.connectivity as Bootstrapped['connectivity'],
    analysis: disposables.analysis as Bootstrapped['analysis'],
  };
}

test('running twice tears down every disposable from the first run before second bootstrap begins', () => {
  const events: string[] = [];
  let runCount = 0;

  const lifecycle = createLifecycle(() => {
    runCount += 1;
    events.push(`bootstrap:${runCount}`);
    return createMockBootstrapped((key) => {
      events.push(`teardown:${key}`);
    });
  });

  lifecycle.run();
  assert.equal(runCount, 1);
  assert.deepEqual(events, ['bootstrap:1']);

  events.length = 0;
  lifecycle.run();
  assert.equal(runCount, 2);

  // Verify all disposables from run 1 are torn down before bootstrap 2 begins
  const teardownEvents = events.filter((e) => e.startsWith('teardown:'));
  const bootstrap2Index = events.indexOf('bootstrap:2');

  assert.equal(teardownEvents.length, DISPOSABLE_KEYS.length);
  for (const key of DISPOSABLE_KEYS) {
    const idx = events.indexOf(`teardown:${key}`);
    assert.ok(idx !== -1, `teardown for ${key} should occur`);
    assert.ok(idx < bootstrap2Index, `teardown for ${key} should occur BEFORE bootstrap:2`);
  }
});

test('SPA re-bootstrap disposes the previous authentication controller', () => {
  const events: string[] = [];
  const lifecycle = createLifecycle(() => createMockBootstrapped((key) => { events.push(key); }));

  lifecycle.run();
  lifecycle.run();

  assert.ok((DISPOSABLE_KEYS as readonly string[]).includes('auth'));
  assert.equal(events.filter((key) => key === 'auth').length, 1);
});

test('a disposable that is null for a route is skipped without error', () => {
  const disposedKeys: DisposableKey[] = [];
  let runCount = 0;

  const nullSet = new Set<DisposableKey>(['board', 'controller', 'studies']);

  const lifecycle = createLifecycle(() => {
    runCount += 1;
    return createMockBootstrapped((key) => {
      disposedKeys.push(key);
    }, runCount === 1 ? nullSet : new Set());
  });

  lifecycle.run();
  assert.equal(disposedKeys.length, 0);

  lifecycle.run();
  assert.equal(disposedKeys.length, DISPOSABLE_KEYS.length - nullSet.size);
  assert.ok(!disposedKeys.includes('board'));
  assert.ok(!disposedKeys.includes('controller'));
  assert.ok(!disposedKeys.includes('studies'));
});

test('regression guard: DISPOSABLE_KEYS exhaustiveness is enforced at type level', () => {
  // Verify DISPOSABLE_TEARDOWN_MAP satisfies Record<DisposableKey, true> at runtime as well.
  const _check: Record<DisposableKey, true> = DISPOSABLE_TEARDOWN_MAP;
  assert.ok(_check);

  // If `DisposableKey` ever stops being driven by `BootstrappedDisposables`, or the map stops being
  // `Record<DisposableKey, true>`, this stops erroring and the guard is gone.
  // @ts-expect-error - a map missing a key must not satisfy Record<DisposableKey, true>
  const _incomplete: Record<DisposableKey, true> = { controller: true };
  void _incomplete;
});

test('one disposable throwing does not strand the rest, and the next route still boots', () => {
  // Without isolation the loop aborts on the first throw: every later disposable stays live, and
  // `run()` never reaches the next bootstrap — a blank page plus the leak this module prevents.
  const disposed: DisposableKey[] = [];
  const failing: DisposableKey = DISPOSABLE_KEYS[0]!;
  let bootstraps = 0;

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (msg: unknown): void => { errors.push(String(msg)); };

  try {
    const lifecycle = createLifecycle(() => {
      bootstraps += 1;
      return createMockBootstrapped((key) => {
        if (key === failing) throw new Error(`boom in ${key}`);
        disposed.push(key);
      });
    });

    lifecycle.run();
    lifecycle.run();

    assert.equal(bootstraps, 2, 'the second bootstrap must still run');
    assert.equal(
      disposed.length,
      DISPOSABLE_KEYS.length - 1,
      'every disposable except the throwing one is torn down',
    );
    assert.ok(!disposed.includes(failing));
    assert.equal(errors.length, 1, 'the failure is reported, not swallowed');
    assert.match(errors[0]!, new RegExp(`teardown failed for "${failing}"`));
  } finally {
    console.error = originalError;
  }
});

test('teardown clears the theme so a torn-down run cannot still be toggled', () => {
  const lifecycle = createLifecycle(() => createMockBootstrapped(() => {}));

  lifecycle.run();
  assert.ok(lifecycle.getCurrentTheme(), 'a live run exposes its theme');

  lifecycle.teardown();
  assert.equal(
    lifecycle.getCurrentTheme(),
    null,
    'after teardown there is no page left to toggle',
  );
});
