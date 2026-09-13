/**
 * Theme toggle — a pure, DOM-free controller for light/dark theme switching.
 *
 * Manages the user's color scheme preference, persisting it to an injectable
 * key-value store (localStorage in production, a fake in tests). The
 * controller exposes callbacks for theme changes and provides the current
 * theme as a value. It never touches the DOM directly; the bootstrap layer
 * applies the active theme class to the document element.
 */
import type { KeyValueStorage } from '../net/session.js';

/**
 * Represents the available themes.
 */
export type Theme = 'light' | 'dark';

/** Callbacks the bootstrap wires to DOM elements. */
export interface ThemeCallbacks {
  /** Invoked when the theme changes. */
  onTheme: (theme: Theme) => void;
}

/**
 * Configuration options for the theme toggle controller.
 */
export interface ThemeToggleOptions {
  readonly callbacks: ThemeCallbacks;
  /** Injected storage (defaults to localStorage). */
  readonly storage?: KeyValueStorage;
  /** Storage key for the theme preference. */
  readonly storageKey?: string;
  /** Initial theme override (takes precedence over storage and the product default). */
  readonly initial?: Theme;
}

const DEFAULT_KEY = 'gambit-theme';

/**
 * Manages the light/dark theme preference.
 *
 * The controller is framework-independent and DOM-free. It reads the initial
 * theme from (1) an explicit override, (2) the persisted user preference, or
 * (3) the product's dark-first default. It persists changes to the injected
 * storage and notifies via callbacks.
 */
export class ThemeToggle {
  private readonly callbacks: ThemeCallbacks;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;
  private theme: Theme;

  /**
   * Initializes a new ThemeToggle instance.
   *
   * @param opts - Options including callbacks, storage, and initial overrides.
   */
  constructor(opts: ThemeToggleOptions) {
    this.callbacks = opts.callbacks;
    this.storage = opts.storage;
    this.storageKey = opts.storageKey ?? DEFAULT_KEY;
    this.theme = opts.initial ?? this.resolveInitial();
  }

  /** Current theme. */
  get current(): Theme {
    return this.theme;
  }

  /** Toggle between light and dark. */
  toggle(): void {
    this.set(this.theme === 'light' ? 'dark' : 'light');
  }

  /** Set the theme explicitly, persist, and notify. */
  set(theme: Theme): void {
    this.theme = theme;
    if (this.storage) {
      try {
        this.storage.setItem(this.storageKey, theme);
      } catch {
        // Storage may be unavailable (private browsing, etc.) — ignore.
      }
    }
    this.callbacks.onTheme(theme);
  }

  /** Emit the current theme to callbacks (useful on init). */
  emit(): void {
    this.callbacks.onTheme(this.theme);
  }

  /**
   * Resolves the initial theme.
   *
   * Explicit previously stored user choice wins. Otherwise, new and default
   * users start in dark mode per the approved Rookzen dark-first product
   * direction; system light preference does not override the dark default.
   *
   * @returns The resolved initial theme ('dark' or 'light').
   */
  private resolveInitial(): Theme {
    // 1. Check persisted preference.
    if (this.storage) {
      try {
        const stored = this.storage.getItem(this.storageKey);
        if (stored === 'light' || stored === 'dark') return stored;
      } catch {
        // Storage unavailable — fall through.
      }
    }
    // 2. Rookzen is DARK-FIRST: system light preference must NOT override dark default.
    return 'dark';
  }
}
