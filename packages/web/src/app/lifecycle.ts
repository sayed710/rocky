/**
 * Application lifecycle management — structural teardown and run loop.
 *
 * Keeps re-bootstrapping safe across SPA navigations by guaranteeing that every
 * disposable controller and view returned by `bootstrap` is torn down before the
 * new route mounts.
 *
 * Exhaustiveness guarantee: `DISPOSABLE_TEARDOWN_MAP` is typed as
 * `Record<DisposableKey, true>` where `DisposableKey` is derived directly from
 * `BootstrappedDisposables`. Adding a disposable key to `BootstrappedDisposables`
 * without including it in `DISPOSABLE_TEARDOWN_MAP` causes a TypeScript compile error.
 */
import type { Bootstrapped, DisposableKey } from './bootstrap.js';

export interface Disposable {
  dispose: () => void;
}

/**
 * Map of disposable keys to drive structural teardown in defined order.
 * Typed as `Record<DisposableKey, true>` for compile-time exhaustiveness checking.
 */
export const DISPOSABLE_TEARDOWN_MAP: Record<DisposableKey, true> = {
  controller: true,
  board: true,
  lobby: true,
  profile: true,
  leaderboard: true,
  tournament: true,
  tournamentCommentary: true,
  search: true,
  messages: true,
  teams: true,
  forum: true,
  learning: true,
  endgames: true,
  studies: true,
  passkeys: true,
  passwordReset: true,
  emailVerification: true,
  connectivity: true,
  analysis: true,
  app: true,
};

/**
 * Array of disposable keys derived from {@link DISPOSABLE_TEARDOWN_MAP} in defined teardown order.
 */
export const DISPOSABLE_KEYS: readonly DisposableKey[] = Object.keys(
  DISPOSABLE_TEARDOWN_MAP,
) as DisposableKey[];

/**
 * Managed application lifecycle controller.
 */
export interface AppLifecycle {
  /** Run the bootstrap, tearing down any previous route disposables first. */
  run: () => Bootstrapped;
  /** Get the theme toggle controller from the current route run. */
  getCurrentTheme: () => { toggle: () => void } | null;
  /** Explicitly teardown all active route disposables. */
  teardown: () => void;
}

/**
 * Create a testable application lifecycle controller.
 *
 * @param bootstrapFn Function that performs application bootstrap and returns a {@link Bootstrapped} handle.
 */
export function createLifecycle(
  bootstrapFn: () => Bootstrapped,
): AppLifecycle {
  let previous: Bootstrapped | null = null;
  let currentTheme: { toggle: () => void } | null = null;

  const teardown = (): void => {
    if (!previous) return;
    for (const key of DISPOSABLE_KEYS) {
      const item = previous[key];
      if (item) {
        try {
          item.dispose();
        } catch (err) {
          // One controller failing to tear down must not strand the rest. Without isolation the
          // loop aborts, every later disposable stays live, and `run()` never reaches the next
          // bootstrap — so a single throw turns a navigation into a blank page *and* the leak this
          // module exists to prevent. Reported rather than swallowed: the failure is real, it is
          // just not the caller's to recover from mid-navigation.
          console.error(`[Rookzen] teardown failed for "${key}":`, err);
        }
      }
    }
    previous = null;
    // The theme belongs to the run being torn down. Leaving it set means `getCurrentTheme()` hands
    // out a toggle from a page that no longer exists, and holds it referenced.
    currentTheme = null;
  };

  const run = (): Bootstrapped => {
    teardown();
    const result = bootstrapFn();
    currentTheme = result.theme;
    previous = result;
    return result;
  };

  return {
    run,
    getCurrentTheme: () => currentTheme,
    teardown,
  };
}
