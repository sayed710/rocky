import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { GameSummary } from '../src/api/models.js';
import { mountProfile as mountProfileBase } from '../src/app/profile-mount.js';
import { createI18nManager, type I18nManager } from '../src/i18n/index.js';
import type { AuthSession } from '../src/app/auth-controller.js';

const testI18n = createI18nManager();

function mountProfile(
  deps: Omit<Parameters<typeof mountProfileBase>[0], 'i18n'> & { i18n?: I18nManager },
): ReturnType<typeof mountProfileBase> {
  return mountProfileBase({ ...deps, i18n: deps.i18n ?? testI18n });
}
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { FakeTransport, json } from './support/fake-transport.js';

// ── DOM Shim for Profile Mount Tests ─────────────────────────────────────────

const originalHTMLButtonElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
const originalHTMLSelectElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLSelectElement');
const originalPopStateEvent = Object.getOwnPropertyDescriptor(globalThis, 'PopStateEvent');

function restoreGlobal(
  name: 'HTMLButtonElement' | 'HTMLSelectElement' | 'PopStateEvent',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, descriptor);
}

class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  type = 'button';
  value = '';
  selected = false;
  hidden = false;
  disabled = false;
  title = '';
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly listeners: Record<string, ((event: any) => void)[]> = {};
  _doc: Document | null = null;
  private _textContent = '';

  constructor(tagName: string = 'DIV') {
    this.tagName = tagName.toUpperCase();
  }

  private _detachChild(child: FakeElement): void {
    const docRef = this._doc && 'activeElement' in this._doc
      ? (this._doc as unknown as { activeElement: FakeElement | null })
      : null;
    if (docRef?.activeElement && child.contains(docRef.activeElement)) {
      docRef.activeElement = null;
    }
    child.parentElement = null;
  }

  get textContent(): string {
    if (this._textContent !== '') return this._textContent;
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('');
    }
    return '';
  }

  set textContent(val: string) {
    for (const child of this.children) {
      this._detachChild(child);
    }
    this._textContent = val;
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.children.length > 0
      ? this.children.map((c) => `<${c.tagName.toLowerCase()}>${c.textContent}</${c.tagName.toLowerCase()}>`).join('')
      : '';
  }

  set innerHTML(val: string) {
    for (const child of this.children) {
      this._detachChild(child);
    }
    this.children.length = 0;
    this._textContent = '';
  }

  get ownerDocument(): Document {
    return this._doc ?? (globalThis.document as unknown as Document);
  }

  readonly classList = {
    _classes: new Set<string>(),
    add: (...tokens: string[]): void => {
      for (const t of tokens) {
        if (t) {
          this.classList._classes.add(t);
          const parts = this.className.split(' ').filter(Boolean);
          if (!parts.includes(t)) {
            this.className = parts.concat(t).join(' ');
          }
        }
      }
    },
    remove: (...tokens: string[]): void => {
      for (const t of tokens) {
        this.classList._classes.delete(t);
        const parts = this.className.split(' ').filter((p) => p !== t);
        this.className = parts.join(' ');
      }
    },
    contains: (token: string): boolean => {
      if (this.classList._classes.has(token)) return true;
      return this.className.split(/\s+/).filter(Boolean).includes(token);
    },
    toggle: (token: string, force?: boolean): boolean => {
      if (force === true) {
        this.classList.add(token);
        return true;
      }
      if (force === false) {
        this.classList.remove(token);
        return false;
      }
      if (this.classList.contains(token)) {
        this.classList.remove(token);
        return false;
      }
      this.classList.add(token);
      return true;
    },
  };

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== listener);
  }

  listenerCount(type: string): number {
    return this.listeners[type]?.length ?? 0;
  }

  get href(): string {
    return this.attributes.get('href') ?? '';
  }

  set href(value: string) {
    this.attributes.set('href', value);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'aria-busy') this.dataset['ariaBusy'] = value;
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[camel] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'href') {
      return this.attributes.get('href') ?? (this.href ? this.href : null);
    }
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const datasetVal = this.dataset[camel];
      if (datasetVal !== undefined) return datasetVal;
    }
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      delete this.dataset[camel];
    }
  }

  contains(other: FakeElement | null): boolean {
    let curr: FakeElement | null = other;
    while (curr !== null) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    child._doc = this._doc;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const textNode = new FakeElement('SPAN');
        textNode.textContent = node;
        this.appendChild(textNode);
      } else {
        this.appendChild(node);
      }
    }
  }

  removeChild<T extends FakeElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this._detachChild(child);
      this.children.splice(idx, 1);
    }
    return child;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) {
      this._detachChild(child);
    }
    this.children.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }

  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const inner = selector.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) return this.attributes.has(inner);
      const k = inner.slice(0, eq);
      const v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
      return this.getAttribute(k) === v;
    }
    const parts = selector.split('.');
    const tag = parts[0] ?? '';
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (let i = 1; i < parts.length; i++) {
      const cls = parts[i];
      if (cls && !this.classList.contains(cls)) return false;
    }
    return true;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
    const evt = { target: this, preventDefault: () => {}, ...event };
    for (const fn of this.listeners[event.type] ?? []) {
      fn(evt);
    }
    return true;
  }

  change(): void {
    this.dispatchEvent({ type: 'change', target: this });
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent({ type: 'click', target: this });
  }

  focus(): void {
    if (this._doc && 'activeElement' in this._doc) {
      (this._doc as unknown as { activeElement: FakeElement | null }).activeElement = this;
    }
  }

  blur(): void {
    if (this._doc && 'activeElement' in this._doc) {
      const docRef = this._doc as unknown as { activeElement: FakeElement | null };
      if (docRef.activeElement === this) docRef.activeElement = null;
    }
  }
}

class FakeHTMLButtonElement extends FakeElement {
  constructor() {
    super('BUTTON');
  }
}
(globalThis as any).HTMLButtonElement = FakeHTMLButtonElement;

class FakeHTMLSelectElement extends FakeElement {
  constructor() {
    super('SELECT');
  }
}
(globalThis as unknown as { HTMLSelectElement: unknown }).HTMLSelectElement = FakeHTMLSelectElement;

class FakePopStateEvent extends Event {
  constructor(type: string) {
    super(type);
  }
}
(globalThis as any).PopStateEvent = FakePopStateEvent;

after(() => {
  restoreGlobal('HTMLButtonElement', originalHTMLButtonElement);
  restoreGlobal('HTMLSelectElement', originalHTMLSelectElement);
  restoreGlobal('PopStateEvent', originalPopStateEvent);
});

const PROFILE_DOM_IDS = [
  'profile',
  'profile-handle',
  'profile-ratings',
  'profile-games',
  'profile-error',
  'social-actions',
  'social-followers',
  'social-following',
  'social-follower-count',
  'social-following-count',
  'social-self',
  'social-incoming',
  'social-outgoing',
  'social-friends',
  'social-friend-count',
  'social-blocked',
  'social-note',
  'social-error',
  'achievements',
  'achievements-list',
  'achievements-count',
  'achievements-error',
  'passkeys-self',
  'passkeys-count',
  'passkey-register',
  'passkeys-list',
  'passkeys-note',
  'passkeys-error',
  'sessions-count',
  'sessions-list',
  'sessions-note',
  'sessions-error',
  'profile-games-filter',
] as const;

function createProfileDocument(): {
  readonly doc: Document;
  readonly elements: Map<string, FakeElement>;
} {
  const elements = new Map<string, FakeElement>();
  const doc: any = {
    activeElement: null as FakeElement | null,
    createElement: (tag: string) => {
      const upper = tag.toUpperCase();
      const el = upper === 'BUTTON'
        ? new FakeHTMLButtonElement()
        : upper === 'SELECT'
          ? new FakeHTMLSelectElement()
          : new FakeElement(upper);
      el._doc = doc;
      return el;
    },
    getElementById: (id: string) => {
      const top = elements.get(id);
      if (top) return top;
      for (const root of elements.values()) {
        const found = root.querySelector(`#${id}`);
        if (found) return found;
      }
      return null;
    },
    querySelector: (selector: string) => {
      for (const root of elements.values()) {
        if (root.matches(selector)) return root;
        const found = root.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      const results: FakeElement[] = [];
      for (const root of elements.values()) {
        if (root.matches(selector)) results.push(root);
        results.push(...root.querySelectorAll(selector));
      }
      return results;
    },
  };

  for (const id of PROFILE_DOM_IDS) {
    const isButton = id === 'passkey-register';
    const el = isButton ? new FakeHTMLButtonElement() : new FakeElement('DIV');
    el.id = id;
    el._doc = doc;
    if (id === 'achievements' || id === 'passkeys-self' || id === 'social-self') {
      el.hidden = true;
    }
    elements.set(id, el);
  }

  return { doc: doc as Document, elements };
}

class AsyncFakeTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  responder: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse = () => json(404, {});
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    return this.responder(request);
  }
}

function createTestClient(transport: HttpTransport, authenticated: boolean = true): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => undefined,
    now: () => 1000,
  });
  if (authenticated) {
    client.session.adopt({
      user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
      tokens: {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshExpiresAt: '2030-01-01T00:00:00Z',
      },
    });
  }
  return client;
}

async function flush(ticks: number = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

class FakeWebAuthn implements WebAuthnAdapter {
  supported = true;
  createdCredential: any = {
    id: 'pk-cred-1',
    rawId: 'raw-1',
    response: { clientDataJSON: 'cd', attestationObject: 'ao' },
    type: 'public-key',
  };

  isSupported(): boolean {
    return this.supported;
  }

  async createCredential(): Promise<any> {
    return this.createdCredential;
  }

  async getCredential(): Promise<any> {
    return null;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('self profile session restoration and same-user deduplication', async () => {
  const { doc, elements } = createProfileDocument();
  let meCallCount = 0;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      meCallCount++;
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [{ variant: 'standard', rating: 1500, rd: 50, prog: 0 }],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/alice/games') {
      return json(200, []);
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/players/')) {
      return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], named: true });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], incoming: [], outgoing: [], friends: [], blocked: [] });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 0, pointsTotal: 0 });
      return json(200, { total: 0, items: [] });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') {
      return json(200, []);
    }
    return json(404, {});
  });

  const client = createTestClient(transport, false);
  let resolveRestore!: (session: AuthSession | null) => void;
  const restorePromise = new Promise<AuthSession | null>((res) => {
    resolveRestore = res;
  });

  let currentSession: AuthSession | null = null;

  const mounted = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => currentSession,
    restorePromise,
    webauthnAdapter: new FakeWebAuthn(),
  });

  assert.equal(elements.get('profile-handle')!.textContent, '');
  assert.equal(meCallCount, 0);

  // Restore completes with alice session
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
  currentSession = aliceSession;
  resolveRestore(aliceSession);
  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'alice');
  assert.equal(elements.get('passkeys-self')!.hidden, false);
  assert.equal(meCallCount, 1);

  // Same session change notification arrives via onSessionChange (e.g. from AuthController)
  mounted.onSessionChange(aliceSession);
  await flush();

  assert.equal(meCallCount, 1, 'Same user ID must not re-trigger profile load');
});

test('sign-out private-state clearing protects disclosure', async () => {
  const { doc, elements } = createProfileDocument();

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [{ variant: 'standard', rating: 1600, rd: 45, prog: 0 }],
      });
    }
    if (req.method === 'GET' && path.endsWith('/games')) {
      return json(200, [
        { id: 'g1', variant: 'standard', speed: 'rapid', result: '1-0', plyCount: 40, createdAt: '2026-01-01T00:00:00Z' },
      ]);
    }
    if (req.method === 'GET' && path === '/v1/social/friends') {
      return json(200, { items: ['friend1'], total: 1 });
    }
    if (req.method === 'GET' && path === '/v1/social/blocks') {
      return json(200, { items: [{ id: 'b1', blockedId: 'blocked1' }], total: 1 });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/players/')) {
      return json(200, { items: [], followerCount: 1, followingCount: 1, followers: [{ id: 'other', followerId: 'other', followeeId: 'u1' }], following: [], named: true, total: 1 });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], incoming: [], outgoing: [], friends: [], blocked: [] });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 2, pointsTotal: 50 });
      return json(200, { total: 10, items: [] });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') {
      return json(200, [{ id: 'pk-1', name: 'My Passkey', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }]);
    }
    return json(404, {});
  });

  const client = createTestClient(transport);
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
  let currentSession: AuthSession | null = aliceSession;

  const mounted = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => currentSession,
    restorePromise: Promise.resolve(aliceSession),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'alice');
  assert.equal(elements.get('social-self')!.hidden, false);
  assert.equal(elements.get('passkeys-self')!.hidden, false);
  assert.equal(elements.get('achievements')!.hidden, false);
  assert.equal(elements.get('social-friend-count')!.textContent, '1');
  const gameLink = elements.get('profile-games')!.querySelectorAll('a')[0];
  assert.ok(gameLink, 'Recent games must offer a keyboard-accessible link to the durable game');
  assert.equal(gameLink.getAttribute('href'), '/game/g1');
  assert.equal(gameLink.getAttribute('data-route'), 'game');
  assert.match(gameLink.textContent, /Standard.*Rapid.*1-0.*40/);

  // Sign out
  currentSession = null;
  mounted.onSessionChange(null);

  // Private state must be synchronously cleared to prevent disclosure
  assert.equal(elements.get('profile-handle')!.textContent, '');
  assert.equal(elements.get('profile-error')!.textContent, 'Sign in to view your profile.');
  assert.equal(elements.get('social-self')!.hidden, true);
  assert.equal(elements.get('passkeys-self')!.hidden, true);
  assert.equal(elements.get('achievements')!.hidden, true);
  assert.equal(elements.get('social-friends')!.innerHTML, '');
  assert.equal(elements.get('social-blocked')!.innerHTML, '');
  assert.equal(elements.get('social-incoming')!.innerHTML, '');
  assert.equal(elements.get('social-outgoing')!.innerHTML, '');
  assert.equal(elements.get('passkeys-list')!.innerHTML, '');
  assert.equal(elements.get('achievements-list')!.innerHTML, '');
  assert.equal(elements.get('profile-ratings')!.innerHTML, '');
  assert.equal(elements.get('profile-games')!.innerHTML, '');
});

test('account-switch clears private state synchronously before new profile data resolves', async () => {
  const { doc, elements } = createProfileDocument();
  let releaseBobMe: (() => void) | null = null;
  const bobMePromise = new Promise<HttpResponse>((resolve) => {
    releaseBobMe = () => {
      resolve(json(200, { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' }));
    };
  });
  let shouldDelayBob = false;

  const transport = new AsyncFakeTransport();
  transport.responder = (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      if (shouldDelayBob) {
        return bobMePromise;
      }
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [{ variant: 'standard', rating: 1600, rd: 45, prog: 0 }],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return json(200, {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [{ variant: 'standard', rating: 1900, rd: 30, prog: 0 }],
      });
    }
    if (req.method === 'GET' && path.endsWith('/games')) return json(200, []);
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 0, pointsTotal: 0 });
      return json(200, { total: 0, items: [] });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
    return json(404, {});
  };

  const client = createTestClient(transport);
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
  const bobSession: AuthSession = { userId: 'u2', handle: 'bob' };
  let currentSession: AuthSession | null = aliceSession;

  const mounted = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => currentSession,
    restorePromise: Promise.resolve(aliceSession),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'alice');
  assert.ok(elements.get('profile-ratings')!.children.length > 0);

  // Arm the delayed response for Bob
  shouldDelayBob = true;

  // Switch to Bob directly
  currentSession = bobSession;
  client.session.adopt({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok2', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  mounted.onSessionChange(bobSession);

  // Synchronously: Alice's state must be completely cleared before Bob's response resolves
  assert.equal(elements.get('profile-handle')!.textContent, '', 'Handle must clear synchronously on account switch');
  assert.equal(elements.get('profile-ratings')!.innerHTML, '', 'Ratings must clear synchronously on account switch');
  assert.equal(elements.get('profile-games')!.innerHTML, '', 'Games must clear synchronously on account switch');
  assert.equal(elements.get('social-friends')!.innerHTML, '', 'Friends must clear synchronously on account switch');

  // Now release Bob's network load
  if (releaseBobMe) (releaseBobMe as () => void)();
  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'bob');
  assert.ok(elements.get('profile-ratings')!.children.length > 0);
});

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeGame(id: string, variant: GameSummary['variant'], overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id,
    variant,
    speed: 'rapid',
    whiteId: 'u1',
    blackId: 'u2',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:15:00Z',
    termination: 'normal',
    plyCount: 40,
    result: '1-0',
    rated: true,
    ...overrides,
  };
}

function setupFilterEnv(initialGames: GameSummary[] = []) {
  const { doc, elements } = createProfileDocument();
  let gamesData = initialGames;
  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && (path === '/v1/users/alice' || path === '/v1/users/charlie' || path === '/v1/users/bob')) {
      const handle = path.split('/').pop()!;
      return json(200, {
        user: { id: handle === 'alice' ? 'u1' : handle === 'bob' ? 'u2' : 'u3', handle, country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path.endsWith('/games')) return json(200, gamesData);
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) return json(200, { total: 0, items: [], unlockedCount: 0, pointsTotal: 0 });
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
    return json(404, {});
  });
  const client = createTestClient(transport);
  return {
    doc,
    elements,
    transport,
    client,
    setGames: (next: GameSummary[]) => { gamesData = next; },
  };
}

test('games filter: 9 stable options with all, canonical order, filtering, reset, and zero network calls', async () => {
  const env = setupFilterEnv([
    makeGame('g/1?q=ل', 'standard'),
    makeGame('g2', 'chess960', { speed: 'blitz', result: '0-1' }),
    makeGame('g3', 'standard', { speed: 'bullet', result: '1/2-1/2' }),
    makeGame('g4', 'atomic'),
  ]);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };

  mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await waitFor(() => env.elements.get('profile-games')?.querySelectorAll('a.game-row').length === 4);

  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  const resetBtn = filterHost.querySelector('.profile-games-filter-reset')!;
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  assert.ok(variantSelect, 'Production must create select#profile-games-variant inside filter host');
  assert.ok(resetBtn, 'Production must create reset button inside filter host');
  assert.ok(statusEl, 'Production must create .profile-games-filter-status inside filter host');

  const canonicalValues = [
    'all',
    'standard',
    'chess960',
    'kingofthehill',
    'atomic',
    'crazyhouse',
    'threecheck',
    'horde',
    'racingkings',
  ];
  const enLabels = [
    'All variants',
    'Standard',
    'Chess960',
    'King of the Hill',
    'Atomic',
    'Crazyhouse',
    'Three-check',
    'Horde',
    'Racing Kings',
  ];

  const options = variantSelect.querySelectorAll('option');
  assert.equal(options.length, 9, 'Select must render all plus 8 variants');
  assert.deepEqual(Array.from(options).map((opt) => opt.value), canonicalValues);
  assert.deepEqual(Array.from(options).map((opt) => opt.textContent), enLabels);
  assert.equal(options[0]?.value, 'all', 'First option value must be string all');
  assert.equal(variantSelect.value, 'all', 'Initial filter selection must be all');
  assert.equal(statusEl.textContent, 'Showing 4 of 4');

  const gamesContainer = env.elements.get('profile-games')!;
  let rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 4, 'All games rendered in canonical order');
  assert.equal(rows[0]?.getAttribute('href'), '/game/g%2F1%3Fq%3D%D9%84');
  assert.equal(rows[3]?.getAttribute('href'), '/game/g4');

  const baseHttpCalls = env.transport.calls.length;

  // Filter by chess960
  variantSelect.value = 'chess960';
  variantSelect.change();
  assert.equal(env.transport.calls.length, baseHttpCalls, 'Filter change must not execute network requests');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.getAttribute('href'), '/game/g2');
  assert.equal(statusEl.textContent, 'Showing 1 of 4');

  // Filter by standard
  variantSelect.value = 'standard';
  variantSelect.change();
  assert.equal(env.transport.calls.length, baseHttpCalls);
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.getAttribute('href'), '/game/g%2F1%3Fq%3D%D9%84');
  assert.equal(rows[1]?.getAttribute('href'), '/game/g3');
  assert.equal(statusEl.textContent, 'Showing 2 of 4');

  // Reset filter
  resetBtn.click();
  assert.equal(env.transport.calls.length, baseHttpCalls, 'Reset must not execute network requests');
  assert.equal(variantSelect.value, 'all', 'Reset must restore select to all');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 4, 'Reset must restore full canonical games list');
  assert.equal(rows[0]?.getAttribute('href'), '/game/g%2F1%3Fq%3D%D9%84');
  assert.equal(rows[3]?.getAttribute('href'), '/game/g4');
  assert.equal(statusEl.textContent, 'Showing 4 of 4');
});

test('games filter: true empty renders find-game CTA whereas filtered no-match renders truthful copy without CTA', async () => {
  const env = setupFilterEnv([makeGame('g1', 'standard')]);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };

  mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await waitFor(() => env.elements.get('profile-games')?.querySelectorAll('a.game-row').length === 1);

  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  const gamesContainer = env.elements.get('profile-games')!;

  // Filter to a variant with 0 games
  variantSelect.value = 'horde';
  variantSelect.change();
  assert.equal(gamesContainer.querySelectorAll('a.game-row').length, 0);
  assert.equal(gamesContainer.querySelectorAll('a').length, 0, 'No anchors rendered when no games match variant');
  assert.ok(gamesContainer.textContent.includes('No games found'), 'Must render exact no-match title');
  assert.ok(gamesContainer.textContent.includes('No recent games match this variant.'), 'Must render exact no-match body');
  assert.doesNotMatch(gamesContainer.textContent, /find a game|play a game/i, 'Filtered no-match must not show Find Game CTA');
  assert.equal(statusEl.textContent, 'Showing 0 of 1');

  // True empty mount
  const envEmpty = setupFilterEnv([]);
  const bobSession: AuthSession = { userId: 'u2', handle: 'bob' };
  mountProfile({
    doc: envEmpty.doc,
    client: envEmpty.client,
    handle: null,
    getCurrentSession: () => bobSession,
    restorePromise: Promise.resolve(bobSession),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await waitFor(() => (envEmpty.elements.get('profile-games')?.querySelectorAll('a').length ?? 0) > 0);
  const emptyGamesContainer = envEmpty.elements.get('profile-games')!;
  assert.equal(emptyGamesContainer.querySelectorAll('a.game-row').length, 0);
  assert.ok(emptyGamesContainer.textContent.includes('No games yet'), 'Must render exact empty title');
  assert.ok(emptyGamesContainer.textContent.includes('Your finished games will show up here.'), 'Must render exact empty body');
  const emptyAnchors = Array.from(emptyGamesContainer.querySelectorAll('a'));
  const cta = emptyAnchors.find((a) => a.getAttribute('data-route') === 'lobby') ?? emptyAnchors[0]!;
  assert.ok(cta, 'True empty state must render find-game CTA anchor');
  assert.equal(cta.textContent.trim(), 'Find a game');
  assert.equal(cta.getAttribute('href'), '/');
  assert.equal(cta.getAttribute('data-route'), 'lobby');
});

test('games filter: pre-identification filter choice survives initial load and same-handle reload', async () => {
  const { doc, elements } = createProfileDocument();
  let releaseRestore!: (sess: AuthSession | null) => void;
  const restorePromise = new Promise<AuthSession | null>((resolve) => { releaseRestore = resolve; });
  let releaseGames!: (res: HttpResponse) => void;
  const gamesPromise = new Promise<HttpResponse>((resolve) => { releaseGames = resolve; });

  const transport = new AsyncFakeTransport();
  transport.responder = (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, { user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
    }
    if (req.method === 'GET' && path.endsWith('/games')) return gamesPromise;
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) return json(200, { total: 0, items: [], unlockedCount: 0, pointsTotal: 0 });
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
    return json(404, {});
  };
  const client = createTestClient(transport, false);
  let currentSession: AuthSession | null = null;

  const mounted = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => currentSession,
    restorePromise,
    webauthnAdapter: new FakeWebAuthn(),
  });
  await turn();

  const filterHost = elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  assert.ok(variantSelect);

  // Set filter to atomic before session restore and first profile load
  variantSelect.value = 'atomic';
  variantSelect.change();

  // Resolve genuinely deferred session restore
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
  currentSession = aliceSession;
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok1', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  releaseRestore(aliceSession);
  await turn();

  releaseGames(json(200, [
    makeGame('g1', 'standard'),
    makeGame('g2', 'atomic'),
    makeGame('g3', 'chess960'),
  ]));
  await flush();

  const gamesContainer = elements.get('profile-games')!;
  let rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1, 'Pre-identification atomic choice must survive initial profile load');
  assert.equal(rows[0]?.getAttribute('href'), '/game/g2');
  assert.equal(variantSelect.value, 'atomic');

  // Same-handle reload
  transport.responder = (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, { user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
    }
    if (req.method === 'GET' && path.endsWith('/games')) {
      return json(200, [makeGame('g1', 'standard'), makeGame('g2', 'atomic'), makeGame('g4', 'atomic')]);
    }
    return json(404, {});
  };
  await mounted.profile.load('alice');
  await flush();

  assert.equal(variantSelect.value, 'atomic', 'Variant choice atomic must survive same-handle reload');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.getAttribute('href'), '/game/g2');
  assert.equal(rows[1]?.getAttribute('href'), '/game/g4');
});

test('games filter: focus stays on select or game row, recovers on filter, and clears on innerHTML disconnect', async () => {
  const env = setupFilterEnv([makeGame('g1', 'standard'), makeGame('g2', 'chess960')]);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };
  mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await flush();

  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  const gamesContainer = env.elements.get('profile-games')!;

  // 1. Focus on select
  variantSelect.focus();
  assert.equal(env.doc.activeElement, variantSelect);
  variantSelect.value = 'standard';
  variantSelect.change();
  assert.equal(env.doc.activeElement, variantSelect, 'Focus must remain on select during filtering');

  // 2. Focus on matching row
  let rows = gamesContainer.querySelectorAll('a.game-row');
  rows[0]?.focus();
  assert.equal(env.doc.activeElement, rows[0]);
  variantSelect.value = 'standard';
  variantSelect.change();
  assert.equal((env.doc.activeElement as FakeElement | null)?.getAttribute('href'), '/game/g1', 'Focus must preserve matching game row');

  // 3. Focus on filtered-out row recovers to exact adjacent visible row
  rows[0]?.focus();
  variantSelect.value = 'chess960';
  variantSelect.change();
  assert.equal(
    (env.doc.activeElement as FakeElement | null)?.getAttribute('href'),
    '/game/g2',
    'Focus must recover to exact adjacent visible row',
  );

  // Rowless recovery: when all rows filtered out, focus recovers to selector
  variantSelect.value = 'atomic';
  variantSelect.change();
  assert.equal(env.doc.activeElement, variantSelect, 'Focus must recover to selector when no rows remain');

  // 4. Unrelated focus untouched
  const handleEl = env.elements.get('profile-handle')!;
  handleEl.focus();
  variantSelect.value = 'all';
  variantSelect.change();
  assert.equal(env.doc.activeElement, handleEl, 'Unrelated focus must remain untouched');

  // 5. innerHTML clear disconnects parent pointers and clears activeElement
  rows = gamesContainer.querySelectorAll('a.game-row');
  const targetLink = rows[0]!;
  targetLink.focus();
  assert.equal(env.doc.activeElement, targetLink);
  gamesContainer.innerHTML = '';
  assert.equal(env.doc.activeElement, null, 'activeElement must clear to null when containing innerHTML cleared');
  assert.equal(targetLink.parentElement, null, 'parentElement must disconnect when innerHTML cleared');
});

test('games filter: viewer session change preserves public profile filter, self account switch resets synchronously', async () => {
  const env = setupFilterEnv([makeGame('g1', 'standard'), makeGame('g2', 'chess960')]);
  env.client.session.reset(false);
  let viewerSession: AuthSession | null = null;
  const mountedPublic = mountProfile({
    doc: env.doc,
    client: env.client,
    handle: 'charlie',
    getCurrentSession: () => viewerSession,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await flush();

  assert.equal(env.elements.get('profile-handle')!.textContent, 'charlie');
  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  variantSelect.value = 'chess960';
  variantSelect.change();
  assert.equal(env.elements.get('profile-games')!.querySelectorAll('a.game-row').length, 1);

  // Viewer session changes
  viewerSession = { userId: 'u1', handle: 'alice' };
  env.client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok1', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  mountedPublic.onSessionChange(viewerSession);
  await flush();

  assert.equal(env.elements.get('profile-handle')!.textContent, 'charlie');
  assert.equal(variantSelect.value, 'chess960', 'Public profile variant filter must be preserved across viewer session change');
  assert.equal(env.elements.get('profile-games')!.querySelectorAll('a.game-row').length, 1);

  // Self account switch
  const envSelf = setupFilterEnv([makeGame('g1', 'standard'), makeGame('g2', 'chess960')]);
  let selfSession: AuthSession | null = { userId: 'u1', handle: 'alice' };
  const mountedSelf = mountProfile({
    doc: envSelf.doc,
    client: envSelf.client,
    handle: null,
    getCurrentSession: () => selfSession,
    restorePromise: Promise.resolve(selfSession),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await flush();

  const selfFilterHost = envSelf.elements.get('profile-games-filter')!;
  const selfSelect = selfFilterHost.querySelector('#profile-games-variant')!;
  selfSelect.value = 'chess960';
  selfSelect.change();

  // Focus on a game row before account switch
  const selfRows = envSelf.elements.get('profile-games')!.querySelectorAll('a.game-row');
  selfRows[0]?.focus();
  assert.equal(envSelf.doc.activeElement, selfRows[0]);
  const unrelatedEl = envSelf.elements.get('profile-handle')!;

  // Switch to Bob synchronously
  selfSession = { userId: 'u2', handle: 'bob' };
  envSelf.client.session.adopt({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok2', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  mountedSelf.onSessionChange(selfSession);
  assert.equal(selfSelect.value, 'all', 'Filter must reset to all synchronously on self account switch');
  assert.equal(envSelf.elements.get('profile-games')!.innerHTML, '', 'Games DOM must clear synchronously on self account switch');
  assert.equal(envSelf.doc.activeElement, selfSelect, 'Focused game row must reset focus to selector on subject change');

  unrelatedEl.focus();
  assert.equal(envSelf.doc.activeElement, unrelatedEl);

  // Sign out
  mountedSelf.onSessionChange(null);
  assert.equal(selfSelect.value, 'all', 'Filter must reset to all on sign out');
  assert.equal(envSelf.elements.get('profile-games')!.innerHTML, '', 'Games DOM must clear on sign out');
  assert.equal(envSelf.doc.activeElement, unrelatedEl, 'Unrelated focus must remain unchanged on sign out');
});

test('games filter: disposal removes control listeners, and stale callbacks cannot mutate new mount', async () => {
  const { doc, elements } = createProfileDocument();
  let releaseBob!: (res: HttpResponse) => void;
  const bobPromise = new Promise<HttpResponse>((resolve) => { releaseBob = resolve; });

  const transport = new AsyncFakeTransport();
  transport.responder = (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, { user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
    }
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return bobPromise;
    }
    if (req.method === 'GET' && path.endsWith('/games')) {
      return json(200, [makeGame('g1', 'standard')]);
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) return json(200, { total: 0, items: [], unlockedCount: 0, pointsTotal: 0 });
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
    return json(404, {});
  };
  const client = createTestClient(transport);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };
  let currentSession1: AuthSession | null = null;
  let resolveOldRestore!: (sess: AuthSession | null) => void;
  const oldDeferredRestore = new Promise<AuthSession | null>((resolve) => { resolveOldRestore = resolve; });

  const mount1 = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => currentSession1,
    restorePromise: oldDeferredRestore,
    webauthnAdapter: new FakeWebAuthn(),
  });
  await turn();
  currentSession1 = session;
  mount1.onSessionChange(session);
  await flush();

  const filterHost = elements.get('profile-games-filter')!;
  const oldSelect = filterHost.querySelector('#profile-games-variant')!;
  const oldReset = filterHost.querySelector('.profile-games-filter-reset')!;
  assert.equal(oldSelect.listenerCount('change'), 1, 'Mount 1 must attach change listener');
  assert.equal(oldReset.listenerCount('click'), 1, 'Mount 1 must attach reset listener');
  assert.equal(elements.get('profile-games')!.querySelectorAll('a.game-row').length, 1);

  mount1.profile.dispose();
  assert.equal(oldSelect.listenerCount('change'), 0, 'profile.dispose must remove old select listener');
  assert.equal(oldReset.listenerCount('click'), 0, 'profile.dispose must remove old reset listener');

  // Remount Alice -> Bob on persistent DOM while Bob request is pending
  const mount2 = mountProfile({
    doc,
    client,
    handle: 'bob',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await turn();
  assert.equal(elements.get('profile-games')!.querySelectorAll('a.game-row').length, 0, 'Pending remount must clear old rows immediately');

  // Bob request fails (500)
  releaseBob(json(500, { error: 'failed' }));
  await flush();
  assert.equal(elements.get('profile-games')!.querySelectorAll('a.game-row').length, 0, 'Failed remount keeps old rows cleared');
  mount2.profile.dispose();

  // Mount 3 on persistent DOM attaches freshly
  const mount3 = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await flush();

  assert.equal(oldSelect.listenerCount('change'), 0, 'Old detached select must remain at 0 listeners');
  assert.equal(oldReset.listenerCount('click'), 0, 'Old detached reset button must remain at 0 listeners');

  const freshSelect = filterHost.querySelector('#profile-games-variant')!;
  const freshReset = filterHost.querySelector('.profile-games-filter-reset')!;
  assert.ok(freshSelect && freshSelect !== oldSelect, 'Fresh select control must be created');
  assert.equal(freshSelect.listenerCount('change'), 1, 'Fresh select has active listener');
  assert.equal(freshReset.listenerCount('click'), 1, 'Fresh reset has active listener');

  // Disposed pending restore from mount 1 resolves AFTER new mount: must not clear new mount DOM
  resolveOldRestore(null);
  mount1.onSessionChange(null);
  await turn();
  assert.equal(elements.get('profile-handle')!.textContent, 'alice', 'Disposed restore/sessionChange must not clear new mount DOM');
  assert.equal(elements.get('profile-games')!.querySelectorAll('a.game-row').length, 1, 'New mount rows must survive disposed callback');

  // Repeated old dispose leaves fresh filter controls intact
  mount1.profile.dispose();
  assert.equal(freshSelect.listenerCount('change'), 1, 'Repeated old dispose must leave fresh filter controls intact');

  mount3.profile.dispose();
  assert.equal(freshSelect.listenerCount('change'), 0);
});

async function waitFor(predicate: () => boolean, maxTurns = 50): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail(`waitFor condition timed out after ${maxTurns} turns`);
}

test('games filter: locale switching preserves select and option object identities, chosen variant, filtered count, and active focus', async () => {
  const games: GameSummary[] = [
    makeGame('g1', 'standard'),
    makeGame('g2', 'chess960', { speed: 'blitz', result: '0-1' }),
    makeGame('g3', 'atomic'),
    makeGame('g4', 'racingkings'),
  ];
  const env = setupFilterEnv(games);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };
  const i18n = createI18nManager({ initialLocale: 'en' });

  mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
    i18n,
  });

  await waitFor(() => {
    const filter = env.elements.get('profile-games-filter')?.querySelector('#profile-games-variant');
    const rows = env.elements.get('profile-games')?.querySelectorAll('a.game-row');
    return filter !== null && (rows?.length ?? 0) === games.length;
  });

  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  const gamesContainer = env.elements.get('profile-games')!;

  const canonicalValues = [
    'all',
    'standard',
    'chess960',
    'kingofthehill',
    'atomic',
    'crazyhouse',
    'threecheck',
    'horde',
    'racingkings',
  ];
  const enLabels = [
    'All variants',
    'Standard',
    'Chess960',
    'King of the Hill',
    'Atomic',
    'Crazyhouse',
    'Three-check',
    'Horde',
    'Racing Kings',
  ];
  const arLabels = [
    'جميع الأنواع',
    'الشطرنج التقليدي',
    'Chess960',
    'ملك التل',
    'الشطرنج الذري',
    'كريزي هاوس',
    'الكش الثلاثي',
    'الحشد',
    'سباق الملوك',
  ];

  // Capture object identities of select and each option
  const selectBefore = variantSelect;
  const optionsBefore = Array.from(variantSelect.querySelectorAll('option'));
  assert.equal(optionsBefore.length, 9);
  assert.deepEqual(optionsBefore.map((opt) => opt.value), canonicalValues);
  assert.deepEqual(optionsBefore.map((opt) => opt.textContent), enLabels);

  // Filter by atomic
  variantSelect.value = 'atomic';
  variantSelect.change();
  await turn();

  let rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1, 'Only atomic game shown');
  assert.equal(statusEl.textContent, 'Showing 1 of 4');
  assert.equal(variantSelect.value, 'atomic');

  // Focus an unrelated handle element
  const handleEl = env.elements.get('profile-handle') ?? env.doc.createElement('input');
  handleEl.focus();
  assert.strictEqual(env.doc.activeElement, handleEl, 'Unrelated handle should be activeElement before locale switch');

  // Switch to Arabic
  i18n.setLocale('ar');
  await turn();

  const selectAfterAr = filterHost.querySelector('#profile-games-variant')!;
  const optionsAfterAr = Array.from(selectAfterAr.querySelectorAll('option'));
  assert.strictEqual(selectAfterAr, selectBefore, 'Select object identity must be preserved in ar');
  assert.equal(optionsAfterAr.length, optionsBefore.length);
  for (let i = 0; i < optionsBefore.length; i++) {
    assert.strictEqual(optionsAfterAr[i], optionsBefore[i], `Option ${i} object identity must be preserved in ar`);
  }

  assert.equal(variantSelect.value, 'atomic', 'Chosen atomic value must be preserved in ar');
  assert.deepEqual(optionsAfterAr.map((opt) => opt.value), canonicalValues, 'Option values must remain canonical in ar');
  assert.deepEqual(optionsAfterAr.map((opt) => opt.textContent), arLabels, 'Option labels must match Arabic dictionary');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1, 'Filtered count preserved in ar');
  assert.equal(statusEl.textContent, 'عرض 1 من 4', 'Status text updated to Arabic format');
  assert.strictEqual(env.doc.activeElement, handleEl, 'Unrelated handle must remain focused in ar');

  // Switch back to English
  i18n.setLocale('en');
  await turn();

  const selectAfterEn = filterHost.querySelector('#profile-games-variant')!;
  const optionsAfterEn = Array.from(selectAfterEn.querySelectorAll('option'));
  assert.strictEqual(selectAfterEn, selectBefore, 'Select object identity must be preserved in en');
  for (let i = 0; i < optionsBefore.length; i++) {
    assert.strictEqual(optionsAfterEn[i], optionsBefore[i], `Option ${i} object identity must be preserved in en`);
  }

  assert.equal(variantSelect.value, 'atomic', 'Chosen atomic value must be preserved in en');
  assert.deepEqual(optionsAfterEn.map((opt) => opt.value), canonicalValues, 'Option values must remain canonical in en');
  assert.deepEqual(optionsAfterEn.map((opt) => opt.textContent), enLabels, 'Option labels must match English dictionary');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1, 'Filtered count preserved in en');
  assert.equal(statusEl.textContent, 'Showing 1 of 4', 'Status text updated back to English format');
  assert.strictEqual(env.doc.activeElement, handleEl, 'Unrelated handle must remain focused in en');
});

test('games filter: invalid DOM rollback and same-value no-op preserve rows, status, focus, and HTTP call count', async () => {
  const games: GameSummary[] = [
    makeGame('g1', 'standard'),
    makeGame('g2', 'standard', { speed: 'blitz' }),
    makeGame('g3', 'chess960'),
    makeGame('g4', 'atomic'),
  ];
  const env = setupFilterEnv(games);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };

  mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await waitFor(() => {
    const filter = env.elements.get('profile-games-filter')?.querySelector('#profile-games-variant');
    const rows = env.elements.get('profile-games')?.querySelectorAll('a.game-row');
    return filter !== null && (rows?.length ?? 0) === games.length;
  });

  const filterHost = env.elements.get('profile-games-filter')!;
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  const gamesContainer = env.elements.get('profile-games')!;

  // Filter to standard
  variantSelect.value = 'standard';
  variantSelect.change();
  await turn();

  const initialRows = Array.from(gamesContainer.querySelectorAll('a.game-row'));
  assert.equal(initialRows.length, 2);
  assert.equal(statusEl.textContent, 'Showing 2 of 4');
  assert.equal(variantSelect.value, 'standard');

  const baseHttpCalls = env.transport.calls.length;

  variantSelect.focus();
  assert.strictEqual(env.doc.activeElement, variantSelect, 'Variant select should be focused');

  // 1. Same-value no-op
  variantSelect.value = 'standard';
  variantSelect.change();
  await turn();

  assert.equal(variantSelect.value, 'standard', 'Select value remains standard after same-value change');
  const sameValueRows = Array.from(gamesContainer.querySelectorAll('a.game-row'));
  assert.equal(sameValueRows.length, 2, 'Rows count preserved on same-value change');
  assert.strictEqual(sameValueRows[0], initialRows[0], 'First row DOM object identity preserved on same-value change');
  assert.strictEqual(sameValueRows[1], initialRows[1], 'Second row DOM object identity preserved on same-value change');
  assert.equal(statusEl.textContent, 'Showing 2 of 4', 'Status text preserved on same-value change');
  assert.equal(env.transport.calls.length, baseHttpCalls, 'HTTP calls must not increase on same-value change');
  assert.strictEqual(env.doc.activeElement, variantSelect, 'Focus preserved on same-value change');

  // 2. Invalid DOM value rollback
  variantSelect.value = 'antichess';
  variantSelect.change();
  await turn();

  assert.equal(variantSelect.value, 'standard', 'Invalid value must roll back to previously selected variant');
  const rolledBackRows = Array.from(gamesContainer.querySelectorAll('a.game-row'));
  assert.equal(rolledBackRows.length, 2, 'Rows count preserved after invalid value rollback');
  assert.strictEqual(rolledBackRows[0], initialRows[0], 'First row DOM object identity preserved after invalid value rollback');
  assert.strictEqual(rolledBackRows[1], initialRows[1], 'Second row DOM object identity preserved after invalid value rollback');
  assert.equal(statusEl.textContent, 'Showing 2 of 4', 'Status text preserved after invalid value rollback');
  assert.equal(env.transport.calls.length, baseHttpCalls, 'HTTP calls must not increase after invalid value rollback');
  assert.strictEqual(env.doc.activeElement, variantSelect, 'Focus preserved after invalid value rollback');
});

test('public profile handles deferred games 500 failure with clean error state', async () => {
  const { doc, elements } = createProfileDocument();
  let releaseGames: () => void = () => {};
  const gamesDeferred = new Promise<void>((resolve) => {
    releaseGames = resolve;
  });
  let gamesRequested = false;
  let gamesFailed = false;

  const transport = new AsyncFakeTransport();
  transport.responder = async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path.endsWith('/games')) {
      gamesRequested = true;
      await gamesDeferred;
      gamesFailed = true;
      return json(500, { message: 'Internal Server Error' });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      return json(200, { total: 0, items: [], unlockedCount: 0, pointsTotal: 0 });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') {
      return json(200, []);
    }
    return json(404, {});
  };

  const client = createTestClient(transport, false);
  const i18n = createI18nManager({ initialLocale: 'en' });
  const mounted = mountProfile({
    doc,
    client,
    handle: 'alice',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
    i18n,
  });

  await waitFor(() => gamesRequested || transport.calls.some((c) => new URL(c.url).pathname === '/v1/users/alice/games'));

  const gamesContainer = elements.get('profile-games')!;
  assert.ok(gamesContainer);
  const filterHost = elements.get('profile-games-filter')!;
  assert.ok(filterHost);
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  assert.ok(statusEl);
  const readStatus = (): string => statusEl.textContent ?? '';

  let rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 0);
  assert.equal(readStatus(), '');
  assert.equal(gamesContainer.textContent?.trim(), '');

  releaseGames();

  await waitFor(() => {
    const err = elements.get('profile-error') ?? doc.getElementById('profile-error');
    return (err?.textContent?.trim().length ?? 0) > 0;
  });

  const errorEl = elements.get('profile-error') ?? doc.getElementById('profile-error');
  assert.ok(errorEl);
  assert.ok(errorEl.textContent?.trim().length > 0);

  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 0);
  assert.equal(readStatus(), '');
  assert.equal(gamesContainer.textContent?.trim(), '');

  assert.equal(gamesRequested, true);
  assert.equal(gamesFailed, true);
  assert.ok(transport.calls.some((c) => new URL(c.url).pathname === '/v1/users/alice/games'));

  mounted.profile.dispose();
});

test('profile variant filter retains cached snapshot on failure and resets on user change', async () => {
  const { doc, elements } = createProfileDocument();

  const aliceGames: GameSummary[] = [
    makeGame('g1', 'atomic', { whiteId: 'u1', blackId: 'u3' }),
    makeGame('g2', 'standard', { whiteId: 'u1', blackId: 'u4' }),
  ];

  const bobGames: GameSummary[] = [
    makeGame('g3', 'atomic', { whiteId: 'u2', blackId: 'u5' }),
  ];

  type TransportMode = 'alice-success' | 'alice-fail-games' | 'bob-defer-games';
  let mode: TransportMode = 'alice-success';

  let releaseBobGames: () => void = () => {};
  const bobGamesDeferred = new Promise<void>((resolve) => {
    releaseBobGames = resolve;
  });

  const transport = new AsyncFakeTransport();
  transport.responder = async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, {
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return json(200, {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path.endsWith('/games')) {
      if (mode === 'alice-success') {
        return json(200, aliceGames);
      }
      if (mode === 'alice-fail-games') {
        return json(500, { message: 'Internal Server Error' });
      }
      if (mode === 'bob-defer-games') {
        await bobGamesDeferred;
        return json(200, bobGames);
      }
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      return json(200, { total: 0, items: [], unlockedCount: 0, pointsTotal: 0 });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') {
      return json(200, []);
    }
    return json(404, {});
  };

  const client = createTestClient(transport, false);
  const i18n = createI18nManager({ initialLocale: 'en' });
  const mounted = mountProfile({
    doc,
    client,
    handle: 'alice',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
    i18n,
  });

  await waitFor(() => {
    const filter = elements.get('profile-games-filter')?.querySelector('#profile-games-variant');
    const rows = elements.get('profile-games')?.querySelectorAll('a.game-row');
    return filter !== null && (rows?.length ?? 0) === aliceGames.length;
  });

  const filterHost = elements.get('profile-games-filter')!;
  assert.ok(filterHost);
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  assert.ok(variantSelect);
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  assert.ok(statusEl);
  const resetButton = filterHost.querySelector('.profile-games-filter-reset')!;
  assert.ok(resetButton);
  const gamesContainer = elements.get('profile-games')!;
  assert.ok(gamesContainer);
  const readStatus = (): string => statusEl.textContent ?? '';

  assert.equal(variantSelect.value, 'all');
  let rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 2);
  assert.equal(readStatus(), 'Showing 2 of 2');

  variantSelect.value = 'atomic';
  variantSelect.change();
  await turn();

  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.getAttribute('href'), '/game/g1');
  assert.equal(readStatus(), 'Showing 1 of 2');
  assert.equal(variantSelect.value, 'atomic');

  mode = 'alice-fail-games';
  await mounted.profile.load('alice');
  await turn();

  const errorEl = elements.get('profile-error') ?? doc.getElementById('profile-error');
  assert.ok(errorEl);
  assert.ok(errorEl.textContent?.trim().length > 0);
  assert.equal(variantSelect.value, 'atomic');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1);
  assert.equal(readStatus(), 'Showing 1 of 2');

  const callsBeforeReset = transport.calls.length;
  resetButton.click();
  await turn();

  assert.equal(transport.calls.length, callsBeforeReset);
  assert.equal(variantSelect.value, 'all');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 2);
  assert.equal(readStatus(), 'Showing 2 of 2');

  variantSelect.value = 'atomic';
  variantSelect.change();
  await turn();

  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1);
  rows[0]!.focus();
  assert.strictEqual(doc.activeElement, rows[0]!);

  mode = 'bob-defer-games';
  const bobLoadPromise = mounted.profile.load('bob');

  await waitFor(() => {
    const bobIdx = transport.calls.findIndex((c) => c.url.includes('/v1/users/bob'));
    return bobIdx !== -1 && transport.calls.slice(bobIdx + 1).some((c) => new URL(c.url).pathname === '/v1/users/bob/games');
  });

  assert.equal(variantSelect.value, 'all');
  assert.equal(readStatus(), '');
  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 0);
  assert.strictEqual(doc.activeElement, variantSelect);

  releaseBobGames();
  await bobLoadPromise;
  await turn();

  rows = gamesContainer.querySelectorAll('a.game-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.getAttribute('href'), '/game/g3');
  assert.equal(readStatus(), 'Showing 1 of 1');

  mounted.profile.dispose();
});

test('profile games filter announcer: persistent polite announcement, variant prefix, equal-count and zero-match dedup bypass, and write-counter silence', async () => {
  const env = setupFilterEnv([
    makeGame('g1', 'atomic'),
    makeGame('g2', 'chess960'),
    makeGame('g3', 'standard'),
    makeGame('g4', 'standard'),
  ]);
  const session: AuthSession = { userId: 'u1', handle: 'alice' };

  const mounted = mountProfile({
    doc: env.doc,
    client: env.client,
    handle: null,
    getCurrentSession: () => session,
    restorePromise: Promise.resolve(session),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await waitFor(() => env.elements.get('profile-games')?.querySelectorAll('a.game-row').length === 4);

  const filterHost = env.elements.get('profile-games-filter')!;
  assert.ok(filterHost, 'Filter host must exist');
  const variantSelect = filterHost.querySelector('#profile-games-variant')!;
  assert.ok(variantSelect, 'Variant select must exist');
  const statusEl = filterHost.querySelector('.profile-games-filter-status')!;
  assert.ok(statusEl, 'Status element must exist');
  const resetBtn = filterHost.querySelector('.profile-games-filter-reset')!;
  assert.ok(resetBtn, 'Reset button must exist');
  const announcerEl = filterHost.querySelector('.profile-games-filter-announcement')!;
  assert.ok(announcerEl, 'Production must create persistent .profile-games-filter-announcement');

  assert.equal(announcerEl.getAttribute('role'), 'status', 'Announcer must have role=status');
  assert.equal(announcerEl.getAttribute('aria-live'), 'polite', 'Announcer must have aria-live=polite');
  assert.ok(announcerEl.classList.contains('sr-only'), 'Announcer must have sr-only class');
  assert.equal(statusEl.getAttribute('role'), null, 'Visible status must NOT have role=status');
  assert.equal(statusEl.getAttribute('aria-live'), null, 'Visible status must NOT have aria-live');
  assert.equal(announcerEl.textContent, '', 'Initial mount must be silent');

  let writeCount = 0;
  const desc = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'textContent');
  let currentText = announcerEl.textContent;
  Object.defineProperty(announcerEl, 'textContent', {
    get() {
      return desc ? desc.get!.call(this) : currentText;
    },
    set(val: string) {
      writeCount++;
      currentText = val;
      if (desc) {
        desc.set!.call(this, val);
      }
    },
    configurable: true,
  });

  assert.equal(writeCount, 0, 'Initial mount must produce zero announcer writes');

  const baseHttpCalls = env.transport.calls.length;

  variantSelect.value = 'atomic';
  variantSelect.change();
  await turn();
  assert.equal(env.transport.calls.length, baseHttpCalls, 'Filter change must not execute network requests');
  assert.equal(statusEl.textContent, 'Showing 1 of 4');
  assert.equal(announcerEl.textContent, 'Atomic: Showing 1 of 4');
  assert.equal(writeCount, 1);

  variantSelect.value = 'chess960';
  variantSelect.change();
  await turn();
  assert.equal(env.transport.calls.length, baseHttpCalls);
  assert.equal(statusEl.textContent, 'Showing 1 of 4');
  assert.equal(announcerEl.textContent, 'Chess960: Showing 1 of 4');
  assert.equal(writeCount, 2, 'Equal-count different variant must increment write count');

  variantSelect.value = 'chess960';
  variantSelect.change();
  await turn();
  assert.equal(announcerEl.textContent, 'Chess960: Showing 1 of 4');
  assert.equal(writeCount, 2, 'Same-value selection must stay silent');

  variantSelect.value = 'horde';
  variantSelect.change();
  await turn();
  assert.equal(statusEl.textContent, 'Showing 0 of 4');
  assert.equal(announcerEl.textContent, 'Horde: Showing 0 of 4');
  assert.equal(writeCount, 3, 'Absent variant selection must increment write count');

  variantSelect.value = 'racingkings';
  variantSelect.change();
  await turn();
  assert.equal(statusEl.textContent, 'Showing 0 of 4');
  assert.equal(announcerEl.textContent, 'Racing Kings: Showing 0 of 4');
  assert.equal(writeCount, 4, 'Different absent variant must increment write count even with 0 matches');

  resetBtn.click();
  await turn();
  assert.equal(variantSelect.value, 'all');
  assert.equal(statusEl.textContent, 'Showing 4 of 4');
  assert.equal(announcerEl.textContent, 'All variants: Showing 4 of 4');
  assert.equal(writeCount, 5, 'Reset must announce all variants with count');

  resetBtn.click();
  await turn();
  assert.equal(variantSelect.value, 'all');
  assert.equal(writeCount, 5, 'Noop reset must stay silent');

  variantSelect.value = 'invalid-variant';
  variantSelect.change();
  await turn();
  assert.equal(writeCount, 5, 'Invalid value change must stay silent');

  await mounted.profile.loadSelf();
  await turn();
  assert.equal(writeCount, 5, 'Background reload must not write to announcer');

  env.setGames([]);
  await mounted.profile.loadSelf();
  await turn();
  assert.equal(announcerEl.textContent, '', 'Non-empty to empty transition must clear announcer');
  assert.equal(writeCount, 6, 'First empty reload must clear announcer once');

  await mounted.profile.loadSelf();
  await turn();
  assert.equal(announcerEl.textContent, '');
  assert.equal(writeCount, 6, 'Repeated empty reload must stay silent');

  mounted.profile.dispose();
});

test('profile games filter announcer: AR locale, self-session synchronous clearing, public-session preservation, subject switch, and disposal', async () => {
  const envSelf = setupFilterEnv([makeGame('g1', 'atomic'), makeGame('g2', 'standard')]);
  let selfSession: AuthSession | null = { userId: 'u1', handle: 'alice' };
  const arI18n = createI18nManager({ initialLocale: 'ar' });

  const mountedSelf = mountProfile({
    doc: envSelf.doc,
    client: envSelf.client,
    handle: null,
    getCurrentSession: () => selfSession,
    restorePromise: Promise.resolve(selfSession),
    webauthnAdapter: new FakeWebAuthn(),
    i18n: arI18n,
  });

  await waitFor(() => envSelf.elements.get('profile-games')?.querySelectorAll('a.game-row').length === 2);

  const selfFilterHost = envSelf.elements.get('profile-games-filter')!;
  assert.ok(selfFilterHost, 'Self filter host must exist');
  const selfSelect = selfFilterHost.querySelector('#profile-games-variant')!;
  assert.ok(selfSelect, 'Self variant select must exist');
  const selfAnnouncer = selfFilterHost.querySelector('.profile-games-filter-announcement')!;
  assert.ok(selfAnnouncer, 'Self announcer must exist');

  selfSelect.value = 'atomic';
  selfSelect.change();
  await turn();
  const expectedArStatus = arI18n.t('profile.games.filterStatus', { shown: 1, total: 2 });
  const expectedArVariant = arI18n.t('variant.atomic');
  assert.equal(selfAnnouncer.textContent, `${expectedArVariant}: ${expectedArStatus}`);

  arI18n.setLocale('en');
  await turn();
  const expectedEnStatus = arI18n.t('profile.games.filterStatus', { shown: 1, total: 2 });
  const expectedEnVariant = arI18n.t('variant.atomic');
  assert.equal(selfAnnouncer.textContent, `${expectedEnVariant}: ${expectedEnStatus}`);

  selfSession = { userId: 'u2', handle: 'bob' };
  envSelf.client.session.adopt({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok2', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  mountedSelf.onSessionChange(selfSession);
  assert.equal(selfAnnouncer.textContent, '', 'Announcer must clear synchronously on self account switch');

  selfSelect.value = 'atomic';
  selfSelect.change();
  await turn();
  mountedSelf.onSessionChange(null);
  assert.equal(selfAnnouncer.textContent, '', 'Announcer must clear synchronously on signout');

  mountedSelf.profile.dispose();
  selfSelect.value = 'atomic';
  selfSelect.change();
  await turn();
  assert.equal(selfAnnouncer.textContent, '', 'Disposed controller must not revive announcer');
  assert.equal(selfFilterHost.querySelector('.profile-games-filter-announcement'), null, 'Disposed filter host must be emptied');

  const envPublic = setupFilterEnv([makeGame('g1', 'atomic'), makeGame('g2', 'standard')]);
  let viewerSession: AuthSession | null = null;
  const mountedPublic = mountProfile({
    doc: envPublic.doc,
    client: envPublic.client,
    handle: 'alice',
    getCurrentSession: () => viewerSession,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
  });

  await waitFor(() => envPublic.elements.get('profile-games')?.querySelectorAll('a.game-row').length === 2);

  const publicFilterHost = envPublic.elements.get('profile-games-filter')!;
  assert.ok(publicFilterHost, 'Public filter host must exist');
  const publicSelect = publicFilterHost.querySelector('#profile-games-variant')!;
  assert.ok(publicSelect, 'Public variant select must exist');
  const publicAnnouncer = publicFilterHost.querySelector('.profile-games-filter-announcement')!;
  assert.ok(publicAnnouncer, 'Public profile must create persistent announcer');

  publicSelect.value = 'atomic';
  publicSelect.change();
  await turn();
  assert.equal(publicAnnouncer.textContent, 'Atomic: Showing 1 of 2');

  viewerSession = { userId: 'u2', handle: 'bob' };
  envPublic.client.session.adopt({
    user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'tok2', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  mountedPublic.onSessionChange(viewerSession);
  assert.equal(
    publicAnnouncer.textContent,
    'Atomic: Showing 1 of 2',
    'Public profile announcer must be preserved across viewer sign-in',
  );

  viewerSession = null;
  mountedPublic.onSessionChange(null);
  assert.equal(
    publicAnnouncer.textContent,
    'Atomic: Showing 1 of 2',
    'Public profile announcer must be preserved across viewer sign-out',
  );

  await mountedPublic.profile.load('bob');
  await turn();
  assert.equal(
    publicAnnouncer.textContent,
    '',
    'Announcer must clear after loading different public profile subject',
  );

  publicSelect.value = 'horde';
  publicSelect.change();
  await turn();
  assert.equal(publicAnnouncer.textContent, 'Horde: Showing 0 of 2');

  mountedPublic.profile.dispose();
  assert.equal(publicAnnouncer.textContent, '', 'Disposal must clear retained announcer text');

  publicSelect.value = 'atomic';
  publicSelect.change();
  await turn();
  assert.equal(publicAnnouncer.textContent, '', 'Late control change after disposal must not revive announcer');

  const emptyEnv = setupFilterEnv([]);
  const emptyMounted = mountProfile({
    doc: emptyEnv.doc,
    client: emptyEnv.client,
    handle: 'charlie',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
    webauthnAdapter: new FakeWebAuthn(),
  });
  await waitFor(() => emptyEnv.elements.get('profile-games') !== null);
  await turn();

  const emptyHost = emptyEnv.elements.get('profile-games-filter')!;
  assert.ok(emptyHost, 'Filter host must exist on empty profile');
  const emptyAnnouncer = emptyHost.querySelector('.profile-games-filter-announcement')!;
  assert.ok(emptyAnnouncer, 'Announcer must exist on empty profile');
  assert.equal(emptyAnnouncer.textContent, '', 'Genuine empty profile must have silent announcer');

  let emptyWrites = 0;
  const emptyDesc = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'textContent');
  let emptyCurrent = emptyAnnouncer.textContent;
  Object.defineProperty(emptyAnnouncer, 'textContent', {
    get() {
      return emptyDesc ? emptyDesc.get!.call(this) : emptyCurrent;
    },
    set(val: string) {
      emptyWrites++;
      emptyCurrent = val;
      if (emptyDesc) emptyDesc.set!.call(this, val);
    },
    configurable: true,
  });

  await emptyMounted.profile.load('charlie');
  await turn();
  assert.equal(emptyWrites, 0, 'Repeated empty profile reload must produce 0 additional announcer writes');
  assert.equal(emptyAnnouncer.textContent, '');
  emptyMounted.profile.dispose();
});

test('passkey listener does not stack across remounts and is cleanly disposed', async () => {
  const { doc, elements } = createProfileDocument();
  let registerOptionsCalls = 0;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/me') {
      return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && path === '/v1/users/alice') {
      return json(200, { user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
    }
    if (req.method === 'GET' && path.endsWith('/games')) return json(200, []);
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 0, pointsTotal: 0 });
      return json(200, { total: 0, items: [] });
    }
    if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
    if (req.method === 'POST' && path === '/v1/auth/webauthn/register/options') {
      registerOptionsCalls++;
      return json(200, { challenge: 'c', rp: { name: 'Gambit', id: 'api.test' }, user: { id: 'u1', name: 'alice', displayName: 'alice' }, pubKeyCredParams: [] });
    }
    if (req.method === 'POST' && path === '/v1/auth/webauthn/register/verify') {
      return json(200, { id: 'pk-1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null });
    }
    return json(404, {});
  });

  const client = createTestClient(transport);
  const registerButton = elements.get('passkey-register')!;
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };

  // Mount 1
  const mount1 = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => aliceSession,
    restorePromise: Promise.resolve(aliceSession),
    webauthnAdapter: new FakeWebAuthn(),
  });

  assert.ok(mount1.passkeys);
  assert.equal(registerButton.listenerCount('click'), 1, 'First mount attaches 1 listener');

  // Dispose 1
  mount1.passkeys.dispose();
  assert.equal(registerButton.listenerCount('click'), 0, 'Disposing first mount cleans listener');

  // Mount 2 on same document
  const mount2 = mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => aliceSession,
    restorePromise: Promise.resolve(aliceSession),
    webauthnAdapter: new FakeWebAuthn(),
  });

  assert.ok(mount2.passkeys);
  assert.equal(registerButton.listenerCount('click'), 1, 'Second mount has exactly 1 listener, not stacked');

  registerButton.click();
  await flush();

  assert.equal(registerOptionsCalls, 1, 'Clicking register triggers exactly one registration request');

  // Dispose 2
  mount2.passkeys.dispose();
  assert.equal(registerButton.listenerCount('click'), 0, 'Disposing second mount cleans listener');
});

test('public-profile session-change reloads social relationships without re-fetching profile', async () => {
  const { doc, elements } = createProfileDocument();
  let userBobFetchCount = 0;
  let socialFollowersCalls = 0;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/bob') {
      userBobFetchCount++;
      return json(200, {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [{ variant: 'standard', rating: 1750, rd: 40, prog: 0 }],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/bob/games') {
      return json(200, []);
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/players/u2/followers')) {
      socialFollowersCalls++;
      return json(200, { items: [], followerCount: 5, followingCount: 3, followers: [], following: [], named: true });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/players/')) {
      return json(200, { items: [], followerCount: 5, followingCount: 3, followers: [], following: [], named: true });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], incoming: [], outgoing: [], friends: [], blocked: [] });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 0, pointsTotal: 0 });
      return json(200, { total: 0, items: [] });
    }
    return json(404, {});
  });

  const client = createTestClient(transport);
  const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
  const charlieSession: AuthSession = { userId: 'u3', handle: 'charlie' };
  let currentSession: AuthSession | null = aliceSession;

  const mounted = mountProfile({
    doc,
    client,
    handle: 'bob',
    getCurrentSession: () => currentSession,
    restorePromise: Promise.resolve(aliceSession),
  });

  assert.equal(mounted.passkeys, null, 'Public profile mount has no passkeys disposable');

  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'bob');
  assert.equal(userBobFetchCount, 1, 'Initial load fetches Bob profile once');
  assert.equal(socialFollowersCalls, 1, 'Initial load fetches social followers once');

  // Viewer changes: Alice signs out
  currentSession = null;
  mounted.onSessionChange(null);

  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'bob', 'Public profile handle remains');
  assert.equal(userBobFetchCount, 1, 'Profile data must NOT be re-fetched on viewer sign-out');
  assert.equal(socialFollowersCalls, 2, 'Social region reloaded for signed-out visitor');

  // Viewer changes: Charlie signs in
  currentSession = charlieSession;
  mounted.onSessionChange(charlieSession);

  await flush();

  assert.equal(elements.get('profile-handle')!.textContent, 'bob', 'Public profile handle remains');
  assert.equal(userBobFetchCount, 1, 'Profile data must NOT be re-fetched on new viewer sign-in');
  assert.equal(socialFollowersCalls, 3, 'Social region reloaded for Charlie');
});

test('public-profile message action SPA navigates and retains error on failure', async () => {
  const { doc, elements } = createProfileDocument();
  let messageRecipientId: string | null = null;
  let shouldFailMessage = false;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return json(200, {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/bob/games') return json(200, []);
    if (req.method === 'GET' && path.startsWith('/v1/social/players/')) {
      return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], named: true });
    }
    if (req.method === 'GET' && path.startsWith('/v1/social/')) {
      return json(200, { items: [], incoming: [], outgoing: [], friends: [], blocked: [] });
    }
    if (req.method === 'GET' && path.includes('/achievements')) {
      if (path.endsWith('/summary')) return json(200, { unlockedCount: 0, pointsTotal: 0 });
      return json(200, { total: 0, items: [] });
    }
    if (req.method === 'POST' && path === '/v1/messages/conversations') {
      const body = JSON.parse(req.body ?? '{}');
      messageRecipientId = body.playerId;
      if (shouldFailMessage) {
        return json(500, { message: 'Messaging service unavailable' });
      }
      return json(200, { id: 'conv-123', participants: ['u1', 'u2'], createdAt: '2026-01-01T00:00:00Z', lastMessageAt: null });
    }
    return json(404, {});
  });

  const client = createTestClient(transport);
  const pushedUrls: string[] = [];
  let popstateDispatched = false;

  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  const fakeHistory = {
    pushState: (_state: any, _title: string, url: string) => pushedUrls.push(url),
  };
  const fakeWindow = {
    history: fakeHistory,
    dispatchEvent: (evt: any) => {
      if (evt?.type === 'popstate') popstateDispatched = true;
    },
  };

  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: fakeHistory,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });

  try {
    const aliceSession: AuthSession = { userId: 'u1', handle: 'alice' };
    mountProfile({
      doc,
      client,
      handle: 'bob',
      getCurrentSession: () => aliceSession,
      restorePromise: Promise.resolve(aliceSession),
    });

    await flush();

    const socialActionsEl = elements.get('social-actions')!;
    const messageBtn = socialActionsEl.querySelectorAll('button').find((b) => b.textContent === 'Message');
    assert.ok(messageBtn, 'Message button should appear for signed-in viewer on another player profile');

    messageBtn.click();
    await flush();

    assert.equal(messageRecipientId, 'u2');
    assert.equal(pushedUrls.includes('/messages/conv-123'), true, 'SPA navigates to conversation thread');
    assert.equal(popstateDispatched, true, 'popstate event is dispatched');

    // Test failure retention
    shouldFailMessage = true;
    messageBtn.click();
    await flush();

    assert.equal(elements.get('social-error')!.textContent, 'HTTP 500', 'Exact messaging error text is retained');
  } finally {
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
    else delete (globalThis as any).history;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
  }
});

test('achievements unavailable and error rendering', async () => {
  const { doc, elements } = createProfileDocument();
  let achievementsStatusCode = 503;

  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return json(200, { user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
    }
    if (req.method === 'GET' && path === '/v1/users/bob/games') return json(200, []);
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], named: true });
    if (req.method === 'GET' && path.includes('/achievements')) {
      return json(achievementsStatusCode, { message: 'Achievements failed' });
    }
    return json(404, {});
  });

  const client = createTestClient(transport, false);

  mountProfile({
    doc,
    client,
    handle: 'bob',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
  });

  await flush();

  assert.equal(elements.get('achievements')!.hidden, true, '503 hides achievements section');

  // Test with a 500 error instead
  achievementsStatusCode = 500;
  const { doc: doc2, elements: elements2 } = createProfileDocument();
  mountProfile({
    doc: doc2,
    client,
    handle: 'bob',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
  });

  await flush();

  assert.equal(elements2.get('achievements')!.hidden, false, '500 error reveals achievements section');
  assert.equal(elements2.get('achievements-error')!.textContent, 'HTTP 500');
});

test('a profile shows each rating pool on its own row, named by variant and speed', async () => {
  const { doc, elements } = createProfileDocument();
  const transport = new FakeTransport().onEach((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/v1/users/bob') {
      return json(200, {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z' },
        ratings: [
          { variant: 'standard', speed: 'blitz', rating: 1712.4, rd: 61.2, vol: 0.06, updatedAt: null },
          { variant: 'standard', speed: 'correspondence', rating: 1480, rd: 300, vol: 0.06, updatedAt: null },
        ],
      });
    }
    if (req.method === 'GET' && path === '/v1/users/bob/games') return json(200, []);
    if (req.method === 'GET' && path.startsWith('/v1/social/')) return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], named: true });
    return json(404, {});
  });

  mountProfile({
    doc,
    client: createTestClient(transport, false),
    handle: 'bob',
    getCurrentSession: () => null,
    restorePromise: Promise.resolve(null),
  });
  await flush();

  const rows = Array.from(elements.get('profile-ratings')!.children).map((row) => row.textContent);
  assert.deepEqual(rows, ['Standard · Blitz: 1712 (RD 61)', 'Standard · Correspondence: 1480 (RD 300)']);
});
