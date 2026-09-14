import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThemeToggle } from '../src/app/theme-toggle.js';
import type { Theme } from '../src/app/theme-toggle.js';
import type { KeyValueStorage } from '../src/net/session.js';

class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, val: string): void { this.map.set(key, val); }
  removeItem(key: string): void { this.map.delete(key); }
}

test('initial theme from explicit override', () => {
  let received: Theme | null = null;
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { received = th; } },
    initial: 'light',
  });
  assert.equal(t.current, 'light');
  assert.equal(received, null); // emit not called yet
});

test('initial theme from storage', () => {
  const storage = new FakeStorage();
  storage.setItem('gambit-theme', 'light');
  const t = new ThemeToggle({
    callbacks: { onTheme: () => {} },
    storage,
  });
  assert.equal(t.current, 'light');
});

test('toggle switches between light and dark', () => {
  let themes: Theme[] = [];
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { themes.push(th); } },
    initial: 'light',
  });
  t.toggle();
  assert.equal(t.current, 'dark');
  assert.deepEqual(themes, ['dark']);
  t.toggle();
  assert.equal(t.current, 'light');
  assert.deepEqual(themes, ['dark', 'light']);
});

test('set persists to storage and notifies', () => {
  const storage = new FakeStorage();
  let themes: Theme[] = [];
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { themes.push(th); } },
    storage,
    initial: 'light',
  });
  t.set('dark');
  assert.equal(storage.getItem('gambit-theme'), 'dark');
  assert.deepEqual(themes, ['dark']);
});

test('emit sends current theme to callbacks', () => {
  let received: Theme | null = null;
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { received = th; } },
    initial: 'dark',
  });
  t.emit();
  assert.equal(received, 'dark');
});

test('custom storage key', () => {
  const storage = new FakeStorage();
  let themes: Theme[] = [];
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { themes.push(th); } },
    storage,
    storageKey: 'custom-key',
    initial: 'light',
  });
  t.set('dark');
  assert.equal(storage.getItem('custom-key'), 'dark');
  assert.equal(storage.getItem('gambit-theme'), null);
});

test('storage errors are silently ignored', () => {
  const brokenStorage: KeyValueStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => {},
  };
  let themes: Theme[] = [];
  // Should not throw on construction or set
  const t = new ThemeToggle({
    callbacks: { onTheme: (th) => { themes.push(th); } },
    storage: brokenStorage,
    initial: 'light',
  });
  t.set('dark');
  assert.equal(t.current, 'dark');
  assert.deepEqual(themes, ['dark']);
});

test('defaults to dark when no preference or system detection', () => {
  const t = new ThemeToggle({
    callbacks: { onTheme: () => {} },
    // No storage, no initial — should default to dark
  });
  assert.equal(t.current, 'dark');
});

test('dark-first: system light preference does NOT override dark default for new users', () => {
  const originalMatchMedia = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (query: string): MediaQueryList => ({
      matches: false, // OS prefers light (does not match prefers-color-scheme: dark)
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    const t = new ThemeToggle({
      callbacks: { onTheme: () => {} },
    });
    assert.equal(t.current, 'dark', 'first-time user on light OS must start in dark theme');
  } finally {
    globalThis.matchMedia = originalMatchMedia;
  }
});

test('dark-first: explicit stored user choice still wins over default', () => {
  const storage = new FakeStorage();
  storage.setItem('gambit-theme', 'light');
  const t = new ThemeToggle({
    callbacks: { onTheme: () => {} },
    storage,
  });
  assert.equal(t.current, 'light', 'stored user choice of light theme must win');
});
