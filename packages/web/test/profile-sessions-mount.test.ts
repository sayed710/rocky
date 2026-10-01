/**
 * Profile route: active-sessions region (M14 inc 46).
 *
 * Kept beside `profile-mount.test.ts` rather than inside it: that file is already long, and these
 * assertions are about one region's wiring, disclosure clearing, and route-lifetime behaviour.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { mountProfile } from '../src/app/profile-mount.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { AuthSession } from '../src/app/auth-controller.js';

const testI18n = createI18nManager();
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { json } from './support/fake-transport.js';

// ── Minimal DOM shim ─────────────────────────────────────────────────────────

const originalHTMLButtonElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');

class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  type = 'button';
  hidden = false;
  disabled = false;
  title = '';
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, ((event: unknown) => void)[]> = {};
  _doc: Document | null = null;
  private _textContent = '';

  constructor(tagName = 'DIV') {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    if (this._textContent !== '') return this._textContent;
    return this.children.map((c) => c.textContent).join(' ');
  }

  set textContent(value: string) {
    this._textContent = value;
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.children.length > 0 ? this.children.map((c) => c.tagName).join('') : '';
  }

  set innerHTML(_value: string) {
    this.children.length = 0;
    this._textContent = '';
  }

  get ownerDocument(): Document {
    return this._doc as Document;
  }

  readonly classList = {
    _classes: new Set<string>(),
    add: (...tokens: string[]): void => { for (const t of tokens) this.classList._classes.add(t); },
    remove: (...tokens: string[]): void => { for (const t of tokens) this.classList._classes.delete(t); },
    contains: (token: string): boolean => this.classList._classes.has(token),
    toggle: (): boolean => false,
  };

  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((cb) => cb !== listener);
  }

  listenerCount(type: string): number {
    return this.listeners[type]?.length ?? 0;
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }

  appendChild<T extends FakeElement>(child: T): T {
    child._doc = this._doc;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new FakeElement('SPAN');
        text.textContent = node;
        this.appendChild(text);
      } else {
        this.appendChild(node);
      }
    }
  }

  removeChild<T extends FakeElement>(child: T): T {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    return child;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners['click'] ?? []) fn({ target: this, preventDefault: () => {} });
  }

  focus(): void {}
}

class FakeHTMLButtonElement extends FakeElement {
  constructor() { super('BUTTON'); }
}
(globalThis as unknown as Record<string, unknown>)['HTMLButtonElement'] = FakeHTMLButtonElement;

after(() => {
  if (originalHTMLButtonElement === undefined) {
    Reflect.deleteProperty(globalThis, 'HTMLButtonElement');
  } else {
    Object.defineProperty(globalThis, 'HTMLButtonElement', originalHTMLButtonElement);
  }
});

const DOM_IDS = [
  'profile', 'profile-handle', 'profile-ratings', 'profile-games', 'profile-error',
  'social-actions', 'social-followers', 'social-following', 'social-follower-count',
  'social-following-count', 'social-self', 'social-incoming', 'social-outgoing',
  'social-friends', 'social-friend-count', 'social-blocked', 'social-note', 'social-error',
  'achievements', 'achievements-list', 'achievements-count', 'achievements-error',
  'passkeys-self', 'passkeys-count', 'passkey-register', 'passkeys-list', 'passkeys-note',
  'passkeys-error',
  'sessions-count', 'sessions-list', 'sessions-note', 'sessions-error',
] as const;

function createProfileDocument(): { doc: Document; elements: Map<string, FakeElement> } {
  const elements = new Map<string, FakeElement>();
  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => {
      const el = tag.toLowerCase() === 'button' ? new FakeHTMLButtonElement() : new FakeElement(tag);
      el._doc = doc as unknown as Document;
      return el;
    },
  } as unknown as Document;

  for (const id of DOM_IDS) {
    const el = id === 'passkey-register' ? new FakeHTMLButtonElement() : new FakeElement();
    el.id = id;
    el._doc = doc;
    elements.set(id, el);
  }
  return { doc, elements };
}

class FakeWebAuthn implements WebAuthnAdapter {
  isSupported(): boolean { return false; }
  async createCredential(): Promise<never> { throw new Error('unused'); }
  async getCredential(): Promise<never> { throw new Error('unused'); }
}

// ── Transport ────────────────────────────────────────────────────────────────

const A_SESSION = {
  id: 'sess-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null,
  lastSeenAt: '2026-08-15T00:00:00.000Z',
  lastIp: '203.0.113.9',
  lastUserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
};

interface TransportOptions {
  sessionsFor: () => unknown[];
  onRevoke?: (id: string) => void;
  revokeStatus?: number;
  gate?: Promise<void>;
}

/** Everything a self-profile mount fetches. `sessionsFor` is a function so a test can change it. */
function selfProfileTransport(opts: TransportOptions): HttpTransport {
  return {
    async send(req: HttpRequest): Promise<HttpResponse> {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/v1/auth/sessions') {
        if (opts.gate) await opts.gate;
        return json(200, opts.sessionsFor());
      }
      if (req.method === 'DELETE' && path.startsWith('/v1/auth/sessions/')) {
        const id = decodeURIComponent(path.slice('/v1/auth/sessions/'.length));
        if ((opts.revokeStatus ?? 204) !== 204) {
          return json(opts.revokeStatus!, { error: { code: 'not_found', message: 'Session not found' } });
        }
        opts.onRevoke?.(id);
        return json(204, undefined);
      }
      if (req.method === 'GET' && path === '/v1/users/me') {
        return json(200, { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' });
      }
      if (req.method === 'GET' && path === '/v1/users/alice') {
        return json(200, { user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z' }, ratings: [] });
      }
      if (req.method === 'GET' && path.endsWith('/games')) return json(200, []);
      if (req.method === 'GET' && path.startsWith('/v1/social/')) {
        return json(200, { items: [], followerCount: 0, followingCount: 0, followers: [], following: [], incoming: [], outgoing: [], friends: [], blocked: [], named: true });
      }
      if (req.method === 'GET' && path.includes('/achievements')) {
        return path.endsWith('/summary')
          ? json(200, { unlockedCount: 0, pointsTotal: 0 })
          : json(200, { total: 0, items: [] });
      }
      if (req.method === 'GET' && path === '/v1/auth/webauthn/passkeys') return json(200, []);
      return json(404, {});
    },
  };
}

function createTestClient(transport: HttpTransport): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => undefined,
    now: () => 1000,
  });
  // The sessions routes are `auth: true`; without an adopted session the client never sends them.
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: 'test-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  });
  return client;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

const ALICE: AuthSession = { userId: 'u1', handle: 'alice' };

function mountSelf(doc: Document, client: GambitClient) {
  return mountProfile({
    doc,
    client,
    handle: null,
    getCurrentSession: () => ALICE,
    restorePromise: Promise.resolve(ALICE),
    webauthnAdapter: new FakeWebAuthn(),
    i18n: testI18n,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('the self profile renders the active sessions list', async () => {
  const { doc, elements } = createProfileDocument();
  const client = createTestClient(selfProfileTransport({ sessionsFor: () => [A_SESSION] }));

  const mount = mountSelf(doc, client);
  await settle();

  assert.equal(elements.get('sessions-count')!.textContent, '(1)');
  const list = elements.get('sessions-list')!;
  assert.match(list.textContent, /Chrome on Windows/);
  assert.match(list.textContent, /203\.0\.113\.9/);
  mount.passkeys?.dispose();
});

test('an account with no active sessions shows the empty state', async () => {
  const { doc, elements } = createProfileDocument();
  const client = createTestClient(selfProfileTransport({ sessionsFor: () => [] }));

  const mount = mountSelf(doc, client);
  await settle();

  assert.equal(elements.get('sessions-count')!.textContent, '');
  assert.match(elements.get('sessions-list')!.textContent, /No other active sessions/);
  mount.passkeys?.dispose();
});

test('revoking from the UI calls the endpoint and re-reads the list', async () => {
  const { doc, elements } = createProfileDocument();
  const revoked: string[] = [];
  let list: unknown[] = [A_SESSION];
  const client = createTestClient(selfProfileTransport({
    sessionsFor: () => list,
    onRevoke: (id) => { revoked.push(id); list = []; },
  }));

  const mount = mountSelf(doc, client);
  await settle();
  assert.equal(elements.get('sessions-count')!.textContent, '(1)');

  elements.get('sessions-list')!.querySelectorAll('button')[0]!.click();
  await settle();

  assert.deepEqual(revoked, ['sess-1']);
  assert.equal(elements.get('sessions-count')!.textContent, '', 'the list is re-read from the server');
  assert.equal(elements.get('sessions-note')!.textContent, 'Session revoked.');
  mount.passkeys?.dispose();
});

test('a failed revoke reports the error and leaves the row in place', async () => {
  const { doc, elements } = createProfileDocument();
  const client = createTestClient(selfProfileTransport({
    sessionsFor: () => [A_SESSION],
    revokeStatus: 404,
  }));

  const mount = mountSelf(doc, client);
  await settle();

  elements.get('sessions-list')!.querySelectorAll('button')[0]!.click();
  await settle();

  assert.notEqual(elements.get('sessions-error')!.textContent, '', 'the failure is reported');
  assert.equal(elements.get('sessions-note')!.textContent, '', 'no success message on failure');
  assert.equal(elements.get('sessions-count')!.textContent, '(1)', 'the session is still listed');
  mount.passkeys?.dispose();
});

test('signing out clears the previous account session list from the screen', async () => {
  const { doc, elements } = createProfileDocument();
  const client = createTestClient(selfProfileTransport({ sessionsFor: () => [A_SESSION] }));

  const mount = mountSelf(doc, client);
  await settle();
  assert.equal(elements.get('sessions-count')!.textContent, '(1)');

  mount.onSessionChange(null);

  // Devices, addresses and last-seen times of the signed-out account must not remain on screen.
  assert.equal(elements.get('sessions-count')!.textContent, '');
  assert.equal(elements.get('sessions-list')!.innerHTML, '');
  assert.equal(elements.get('sessions-error')!.textContent, '');
  mount.passkeys?.dispose();
});

test('a session response arriving after disposal does not paint the list', async () => {
  const { doc, elements } = createProfileDocument();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client = createTestClient(selfProfileTransport({ sessionsFor: () => [A_SESSION], gate }));

  const mount = mountSelf(doc, client);
  mount.passkeys?.dispose();
  release();
  await settle();

  assert.equal(elements.get('sessions-count')!.textContent, '', 'no state update into a disposed route');
  assert.equal(elements.get('sessions-list')!.innerHTML, '');
});

test('remounting the profile leaves one row and one control, not stacked copies', async () => {
  const { doc, elements } = createProfileDocument();
  let listCalls = 0;
  const client = createTestClient(selfProfileTransport({
    sessionsFor: () => { listCalls++; return [A_SESSION]; },
  }));

  const first = mountSelf(doc, client);
  await settle();
  const afterFirst = listCalls;
  first.passkeys?.dispose();

  const second = mountSelf(doc, client);
  await settle();

  assert.equal(listCalls, afterFirst * 2, 'the second mount loads once, not twice');
  assert.equal(
    elements.get('sessions-list')!.querySelectorAll('button').length,
    1,
    'one row and one control — the previous mount left nothing behind',
  );
  second.passkeys?.dispose();
});
