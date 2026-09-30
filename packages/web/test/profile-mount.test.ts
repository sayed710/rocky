import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { mountProfile } from '../src/app/profile-mount.js';
import type { AuthSession } from '../src/app/auth-controller.js';
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { FakeTransport, json } from './support/fake-transport.js';

// ── DOM Shim for Profile Mount Tests ─────────────────────────────────────────

const originalHTMLButtonElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
const originalPopStateEvent = Object.getOwnPropertyDescriptor(globalThis, 'PopStateEvent');

function restoreGlobal(
  name: 'HTMLButtonElement' | 'PopStateEvent',
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

  get textContent(): string {
    if (this._textContent !== '') return this._textContent;
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('');
    }
    return '';
  }

  set textContent(val: string) {
    this._textContent = val;
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.children.length > 0
      ? this.children.map((c) => `<${c.tagName.toLowerCase()}>${c.textContent}</${c.tagName.toLowerCase()}>`).join('')
      : '';
  }

  set innerHTML(val: string) {
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
    contains: (token: string): boolean => this.classList._classes.has(token),
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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'aria-busy') this.dataset['ariaBusy'] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') {
          results.push(child);
        } else if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) {
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

  click(): void {
    if (this.disabled) return;
    const evt = { target: this, type: 'click', preventDefault: () => {} };
    for (const fn of this.listeners['click'] ?? []) {
      fn(evt);
    }
  }

  focus(): void {}
}

class FakeHTMLButtonElement extends FakeElement {
  constructor() {
    super('BUTTON');
  }
}
(globalThis as any).HTMLButtonElement = FakeHTMLButtonElement;

class FakePopStateEvent extends Event {
  constructor(type: string) {
    super(type);
  }
}
(globalThis as any).PopStateEvent = FakePopStateEvent;

after(() => {
  restoreGlobal('HTMLButtonElement', originalHTMLButtonElement);
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
] as const;

function createProfileDocument(): {
  readonly doc: Document;
  readonly elements: Map<string, FakeElement>;
} {
  const elements = new Map<string, FakeElement>();
  const doc: any = {
    createElement: (tag: string) => {
      const el = tag.toUpperCase() === 'BUTTON' ? new FakeHTMLButtonElement() : new FakeElement(tag);
      el._doc = doc;
      return el;
    },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
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
