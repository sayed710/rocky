import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/app/bootstrap.js';
import type { BootstrapDependencies } from '../src/app/bootstrap.js';
import { createI18n, I18n } from '../src/i18n/manager.js';
import { LocaleStorage, DEFAULT_LOCALE_STORAGE_KEY } from '../src/i18n/storage.js';
import type { KeyValueStorage } from '../src/net/session.js';
import type { MessagesCatalog } from '../src/i18n/catalog/index.js';
import { enMessages } from '../src/i18n/catalog/en.js';
import type { Locale } from '../src/i18n/types.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { MemoryTokenStore } from '../src/net/session.js';

class MemoryStorage implements KeyValueStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.get(k) ?? null; }
  setItem(k: string, v: string): void { this.store.set(k, v); }
  removeItem(k: string): void { this.store.delete(k); }
}

class FakeHTMLButtonElement {
  textContent = '';
  classList = new Set<string>();
  disabled = false;
  hidden = false;
  onclick: ((event: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  setAttribute() {}
  getAttribute() { return null; }
  appendChild() { return null; }
  removeChild() { return null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  id = '';
  type = 'button';
}

class FakeHTMLFormElement {
  id = '';
  hidden = false;
  onsubmit: ((e: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  getAttribute() { return null; }
  appendChild() { return null; }
  removeChild() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new Set<string>();
  textContent = '';
  reportValidity = (): boolean => true;
  submit() {}
}

const globalScope = globalThis as unknown as {
  HTMLButtonElement: unknown;
  HTMLFormElement: unknown;
};
if (!globalScope.HTMLButtonElement) globalScope.HTMLButtonElement = FakeHTMLButtonElement;
if (!globalScope.HTMLFormElement) globalScope.HTMLFormElement = FakeHTMLFormElement;

interface FakeElement {
  id: string;
  textContent: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  className: string;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string, force?: boolean): boolean;
  };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(event: string, handler: unknown): void;
  removeEventListener(event: string, handler: unknown): void;
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
  querySelectorAll(sel: string): unknown[];
  querySelector(sel: string): unknown;
  focus(): void;
  click(): void;
}

function makeFakeEl(id = '', dataset: Record<string, string> = {}): FakeElement {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  return {
    id,
    textContent: '',
    disabled: false,
    hidden: false,
    value: '',
    className: '',
    attributes: attrs,
    dataset,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        if (force === true) classes.add(c);
        else if (force === false || classes.has(c)) classes.delete(c);
        else classes.add(c);
        return classes.has(c);
      },
    },
    setAttribute(k: string, v: string) { attrs[k] = v; },
    getAttribute(k: string) { return attrs[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child: unknown) { return child; },
    removeChild(child: unknown) { return child; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    focus() {},
    click() {},
  };
}

function makeTestDoc(staticNodes: FakeElement[] = []): Document {
  const elementMap = new Map<string, FakeElement>();
  const standardIds = [
    'board', 'status', 'flip', 'theme-toggle', 'auth', 'auth-status', 'auth-logout',
    'auth-submit', 'auth-error', 'auth-form', 'auth-handle', 'auth-password', 'auth-email',
    'meta-connection', 'meta-role', 'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name',
    'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status', 'game-actions',
    'action-error', 'game-review', 'game-review-note', 'game-review-error', 'game-review-summary', 'game-review-moves',
  ];

  for (const id of standardIds) {
    elementMap.set(id, makeFakeEl(id));
  }
  for (const node of staticNodes) {
    if (node.id) elementMap.set(node.id, node);
  }

  const docEl = makeFakeEl('documentElement');
  docEl.setAttribute('lang', 'en');
  docEl.setAttribute('dir', 'ltr');

  return {
    getElementById: (id: string) => (elementMap.get(id) ?? null) as unknown as HTMLElement,
    querySelectorAll: (sel: string) => {
      if (sel === '[data-i18n]') return staticNodes.filter(n => 'i18n' in n.dataset);
      if (sel === '[data-i18n-aria-label]') return staticNodes.filter(n => 'i18nAriaLabel' in n.dataset);
      if (sel === '[data-i18n-placeholder]') return staticNodes.filter(n => 'i18nPlaceholder' in n.dataset);
      return [];
    },
    documentElement: docEl as unknown as HTMLElement,
    body: makeFakeEl('body') as unknown as HTMLElement,
  } as unknown as Document;
}

function makeDeps(overrides: Partial<BootstrapDependencies> = {}): BootstrapDependencies {
  const sockets = new FakeSocketFactory();
  return {
    config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
    httpTransport: new FakeTransport().onEach((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/v1/capabilities') return json(200, { capabilities: {} });
      if (path === '/v1/auth/login') {
        return json(200, {
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
          tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
        });
      }
      return json(200, {});
    }),
    wsFactory: sockets.factory,
    tokenStore: new MemoryTokenStore(),
    ...overrides,
  };
}

describe('i18n bootstrap integration regressions', () => {
  it('preserves injected i18n instance identity', () => {
    const doc = makeTestDoc();
    const customI18n = createI18n();
    const bootstrapped = bootstrap(doc, makeDeps({ i18n: customI18n }));

    assert.strictEqual(bootstrapped.app.i18n, customI18n);
    assert.strictEqual(customI18n.document, doc);
  });

  it('bootstrap targets the supplied Document, not a global or foreign document', () => {
    const docA = makeTestDoc();
    const docB = makeTestDoc();

    const bootstrapped = bootstrap(docA, makeDeps());
    assert.strictEqual(docA.documentElement.getAttribute('lang'), 'en');
    assert.strictEqual(docA.documentElement.getAttribute('dir'), 'ltr');

    // Register a test catalog on bootstrapped app i18n
    bootstrapped.app.i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);
    bootstrapped.app.i18n.setLocale('ar');

    assert.strictEqual(docA.documentElement.getAttribute('lang'), 'ar');
    assert.strictEqual(docA.documentElement.getAttribute('dir'), 'rtl');

    // Foreign document docB must remain untouched
    assert.strictEqual(docB.documentElement.getAttribute('lang'), 'en');
    assert.strictEqual(docB.documentElement.getAttribute('dir'), 'ltr');
  });

  it('independent bootstraps own independent shell-localization handles', () => {
    const doc1 = makeTestDoc();
    const doc2 = makeTestDoc();

    const b1 = bootstrap(doc1, makeDeps());
    const b2 = bootstrap(doc2, makeDeps());

    assert.ok(b1.shellLocalization);
    assert.ok(b2.shellLocalization);
    assert.notStrictEqual(b1.shellLocalization, b2.shellLocalization);

    // Disposing b1 does not crash or invalidate b2
    b1.shellLocalization.dispose();
    assert.doesNotThrow(() => {
      b2.shellLocalization?.dispose();
    });
  });

  it('locale changes do not erase live auth session handle', async () => {
    const doc = makeTestDoc();
    const bootstrapped = bootstrap(doc, makeDeps());
    const authStatusEl = doc.getElementById('auth-status');

    assert.ok(authStatusEl);
    assert.strictEqual(authStatusEl.textContent, 'Not signed in');

    // Sign in alice via AuthController
    await bootstrapped.auth.login('alice', 'pw');
    assert.strictEqual(authStatusEl.textContent, 'Signed in as alice');

    // Changing locale re-localizes with preserved handle without erasing data
    bootstrapped.app.i18n.registerCatalog('ar', {
      'shell.authStatus.signedIn': 'مسجل كـ {handle}',
      'shell.authStatus.notSignedIn': 'غير مسجل',
    } as unknown as MessagesCatalog);

    bootstrapped.app.i18n.setLocale('ar');
    assert.strictEqual(authStatusEl.textContent, 'مسجل كـ alice');

    // Switch back to en
    bootstrapped.app.i18n.setLocale('en');
    assert.strictEqual(authStatusEl.textContent, 'Signed in as alice');
  });

  it('locale changes do not erase dynamic controller-owned elements', () => {
    const statusEl = makeFakeEl('status');
    const metaConnEl = makeFakeEl('meta-connection');
    const reviewNoteEl = makeFakeEl('game-review-note');

    const doc = makeTestDoc([statusEl, metaConnEl, reviewNoteEl]);
    const bootstrapped = bootstrap(doc, makeDeps());

    // Controllers write live runtime values to dynamic nodes
    const domStatus = doc.getElementById('status')!;
    const domConn = doc.getElementById('meta-connection')!;
    const domNote = doc.getElementById('game-review-note')!;

    domStatus.textContent = 'White to move · 12 plies played';
    domConn.textContent = 'Connected (24ms)';
    domNote.textContent = 'Select a move to see the position before it was played.';

    // Locale change occurs
    bootstrapped.app.i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);
    bootstrapped.app.i18n.setLocale('ar');

    // Live controller data remains intact, NOT overwritten with initial HTML strings
    assert.strictEqual(domStatus.textContent, 'White to move · 12 plies played');
    assert.strictEqual(domConn.textContent, 'Connected (24ms)');
    assert.strictEqual(domNote.textContent, 'Select a move to see the position before it was played.');
  });

  it('static shell elements with data-i18n re-localize cleanly on locale change', () => {
    const brandNode = makeFakeEl('brand', { i18n: 'shell.brand' });
    const flipBtn = makeFakeEl('flip-btn', { i18nAriaLabel: 'shell.flipBoardAria' });

    const doc = makeTestDoc([brandNode, flipBtn]);
    const bootstrapped = bootstrap(doc, makeDeps());

    assert.strictEqual(brandNode.textContent, 'Rookzen');
    assert.strictEqual(flipBtn.getAttribute('aria-label'), 'Flip board');

    bootstrapped.app.i18n.registerCatalog('ar', {
      'shell.brand': 'روك زن',
      'shell.flipBoardAria': 'قلب اللوحة',
    } as unknown as MessagesCatalog);

    bootstrapped.app.i18n.setLocale('ar');
    assert.strictEqual(brandNode.textContent, 'روك زن');
    assert.strictEqual(flipBtn.getAttribute('aria-label'), 'قلب اللوحة');
  });

  it('persists locale preference across independent bootstrap runs', () => {
    const storage = new MemoryStorage();
    const doc1 = makeTestDoc();
    const b1 = bootstrap(doc1, makeDeps({ storage }));

    b1.app.i18n.registerCatalog('ar', { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog);
    b1.app.i18n.setLocale('ar');

    assert.strictEqual(storage.getItem(DEFAULT_LOCALE_STORAGE_KEY), 'ar');

    // Second bootstrap run with the same storage
    const doc2 = makeTestDoc();
    const testCatalogAr = { 'shell.brand': 'روك زن' } as unknown as MessagesCatalog;
    // Injected i18n with pre-registered Arabic catalog to simulate future AR runtime
    const i18n2 = new I18n({
      storage: new LocaleStorage({ storage }),
      catalogs: {
        en: enMessages,
        ar: testCatalogAr,
      },
    });

    const b2 = bootstrap(doc2, makeDeps({ i18n: i18n2, storage }));
    assert.strictEqual(b2.app.i18n.locale, 'ar');
  });

  it('rejects activating ar in production when no Arabic catalog is registered, preserving en', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEFAULT_LOCALE_STORAGE_KEY, 'ar'); // Stale or corrupt stored preference

    const doc = makeTestDoc();
    const b = bootstrap(doc, makeDeps({ storage }));

    // Production has no registered Arabic catalog -> falls back safely to 'en'
    assert.strictEqual(b.app.i18n.locale, 'en');
    assert.strictEqual(doc.documentElement.getAttribute('lang'), 'en');
    assert.strictEqual(doc.documentElement.getAttribute('dir'), 'ltr');

    // Attempting to setLocale to 'ar' also remains 'en'
    b.app.i18n.setLocale('ar');
    assert.strictEqual(b.app.i18n.locale, 'en');
    assert.strictEqual(doc.documentElement.getAttribute('dir'), 'ltr');
  });
});
