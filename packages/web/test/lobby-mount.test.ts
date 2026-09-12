import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLobby, renderSeeks } from '../src/app/lobby-mount.js';
import { formatMoreOptionsSummary } from '../src/app/create-game-panel.js';
import { LobbyController } from '../src/app/lobby-controller.js';
import { OFFERED_VARIANTS } from '../src/api/models.js';
import { VARIANT_LABELS } from '../src/app/variant-labels.js';
import type {
  CreateBotGameRequest,
  CreateSeekRequest,
  GameSummary,
  SeekView,
  Variant,
} from '../src/api/models.js';
import type { GambitClient } from '../src/api/client.js';
import type { KeyValueStorage } from '../src/net/session.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: resolvePromise,
  };
}

class FakeDOMElement {
  readonly tagName: string;
  id = '';
  className = '';
  type = '';
  value = '';
  hidden = false;
  disabled = false;
  title = '';
  open = false;
  checked = false;
  selected = false;
  name = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeDOMElement[] = [];
  parentElement: FakeDOMElement | null = null;
  readonly listeners: Record<string, ((event: Event) => void)[]> = {};
  _doc: Document | null = null;
  private _textContent = '';

  constructor(tagName: string) {
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

  get ownerDocument(): Document | null {
    return this._doc;
  }

  readonly classList = {
    _classes: new Set<string>(),
    add: (...tokens: string[]): void => {
      for (const t of tokens) {
        if (t) {
          this.classList._classes.add(t);
          if (!this.className.split(' ').includes(t)) {
            this.className = this.className ? `${this.className} ${t}` : t;
          }
        }
      }
    },
    remove: (...tokens: string[]): void => {
      for (const t of tokens) {
        this.classList._classes.delete(t);
      }
      this.className = Array.from(this.classList._classes).join(' ');
    },
    contains: (token: string): boolean => {
      return this.classList._classes.has(token) || this.className.split(' ').includes(token);
    },
    toggle: (token: string, force?: boolean): boolean => {
      const exists = this.classList.contains(token);
      const next = force !== undefined ? force : !exists;
      if (next) this.classList.add(token);
      else this.classList.remove(token);
      return next;
    },
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') {
      this.className = value;
      this.classList._classes = new Set(value.split(' ').filter(Boolean));
    }
    if (name === 'type') this.type = value;
    if (name === 'value') this.value = value;
    if (name === 'name') this.name = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild<T extends FakeDOMElement>(child: T): T {
    child.parentElement = this;
    child._doc = this._doc;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeDOMElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const textNode = new FakeDOMElement('#text');
        textNode.textContent = n;
        this.appendChild(textNode);
      } else {
        this.appendChild(n);
      }
    }
  }

  replaceChildren(...nodes: (FakeDOMElement | string)[]): void {
    this.children.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }

  addEventListener(type: string, fn: (event: Event) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(fn);
  }

  removeEventListener(type: string, fn: (event: Event) => void): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type]!.filter((cb) => cb !== fn);
  }

  listenerCount(type: string): number {
    return this.listeners[type]?.length ?? 0;
  }

  dispatchEvent(event: Event): boolean {
    if (!event.target) {
      Object.defineProperty(event, 'target', { value: this, configurable: true });
    }
    if (!event.preventDefault) {
      Object.defineProperty(event, 'preventDefault', { value: () => {}, configurable: true });
    }
    const handlers = this.listeners[event.type] ?? [];
    for (const h of handlers) {
      h(event);
    }
    return true;
  }

  click(): void {
    if (this.disabled) return;
    let prevented = false;
    const clickEvent = {
      type: 'click',
      target: this as unknown as EventTarget,
      get defaultPrevented(): boolean { return prevented; },
      preventDefault(): void { prevented = true; },
    } as unknown as Event;
    this.dispatchEvent(clickEvent);
    if (this.parentElement) {
      let p: FakeDOMElement | null = this.parentElement;
      while (p) {
        p.dispatchEvent(clickEvent);
        p = p.parentElement;
      }
    }
  }

  focusCount = 0;

  /**
   * Take focus, as the real DOM does: count the call and become the document's
   * active element. Both matter — the panel's disclosure claims focus on every
   * toggle, and the tests assert where it ended up.
   */
  focus(): void {
    this.focusCount++;
    if (this._doc) (this._doc as unknown as { activeElement: unknown }).activeElement = this;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.dispatchEvent({
      type: 'close',
      target: this as unknown as EventTarget,
      defaultPrevented: false,
      preventDefault(): void {},
    } as unknown as Event);
  }

  querySelector<T extends FakeDOMElement = FakeDOMElement>(selector: string): T | null {
    const matches = this.querySelectorAll<T>(selector);
    return matches[0] ?? null;
  }

  /** Node.contains: self-inclusive, walking up the parent chain. */
  contains(other: unknown): boolean {
    for (let node = other as FakeDOMElement | null; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  querySelectorAll<T extends FakeDOMElement = FakeDOMElement>(selector: string): T[] {
    const results: T[] = [];
    const walk = (node: FakeDOMElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) {
          results.push(child as unknown as T);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

/** Match the limited selector grammar exercised by the lobby mount's fake DOM. */
function matchesSelector(node: FakeDOMElement, selector: string): boolean {
  if (selector.startsWith('input[name="') && selector.endsWith('"]:checked')) {
    const name = selector.slice('input[name="'.length, -'"]:checked'.length);
    return node.tagName === 'INPUT' && (node.getAttribute('name') === name || node.name === name) && node.checked;
  }
  if (selector.startsWith('input[name="') && selector.endsWith('"]')) {
    const name = selector.slice('input[name="'.length, -'"]'.length);
    return node.tagName === 'INPUT' && (node.getAttribute('name') === name || node.name === name);
  }
  if (selector === 'button') {
    return node.tagName === 'BUTTON';
  }
  if (selector.includes('.')) {
    const [tag, ...classes] = selector.split('.');
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    return classes.every((c) => node.classList.contains(c));
  }
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

// Global prototype setup for instanceof checks in browser controllers
(globalThis as unknown as { HTMLElement: typeof FakeDOMElement }).HTMLElement = FakeDOMElement;
(globalThis as unknown as { HTMLButtonElement: typeof FakeDOMElement }).HTMLButtonElement = FakeDOMElement;
(globalThis as unknown as { HTMLInputElement: typeof FakeDOMElement }).HTMLInputElement = FakeDOMElement;
(globalThis as unknown as { HTMLSelectElement: typeof FakeDOMElement }).HTMLSelectElement = FakeDOMElement;
(globalThis as unknown as { HTMLDialogElement: typeof FakeDOMElement }).HTMLDialogElement = FakeDOMElement;
(globalThis as unknown as { HTMLFormElement: typeof FakeDOMElement }).HTMLFormElement = FakeDOMElement;
(globalThis as unknown as { HTMLParagraphElement: typeof FakeDOMElement }).HTMLParagraphElement = FakeDOMElement;
(globalThis as unknown as { HTMLLabelElement: typeof FakeDOMElement }).HTMLLabelElement = FakeDOMElement;

function createTestDoc(): {
  doc: Document;
  elements: Map<string, FakeDOMElement>;
} {
  const elements = new Map<string, FakeDOMElement>();

  const doc = {
    createElement: (tag: string): FakeDOMElement => {
      const el = new FakeDOMElement(tag);
      el._doc = doc as unknown as Document;
      return el;
    },
    getElementById: (id: string): FakeDOMElement | null => elements.get(id) ?? null,
    // Writable so `focus()` can record it, which is how a test asserts where
    // focus ended up. The panel itself never reads it — the toggle claims focus
    // rather than inspecting it.
    activeElement: null as FakeDOMElement | null,
  } as unknown as Document;

  const ids = [
    'lobby',
    'seek-list',
    'create-game',
    'play-bot-mount',
    'lobby-error',
    'auth',
    'auth-status',
    'auth-logout',
    'auth-submit',
    'auth-register',
    'auth-passkey',
    'auth-error',
    'auth-form',
    'auth-handle',
    'auth-password',
    'theme-toggle',
  ];

  for (const id of ids) {
    const el = new FakeDOMElement('div');
    el.id = id;
    el._doc = doc;
    elements.set(id, el);
  }

  return { doc, elements };
}

/** Build a valid lobby seek fixture with concise per-test overrides. */
function makeSeek(overrides: Partial<SeekView> = {}): SeekView {
  return {
    id: 'seek-1',
    creatorId: 'user-1',
    creatorHandle: null,
    variant: 'standard' as Variant,
    speed: 'blitz',
    timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
    rated: true,
    color: 'random',
    minRating: null,
    maxRating: null,
    createdAt: '2026-01-01T00:00:00Z',
    gameId: null,
    acceptedAt: null,
    ...overrides,
  };
}

function makeFakeGameSummary(id: string): GameSummary {
  return {
    id,
    variant: 'standard',
    rated: false,
    speed: 'blitz',
    whiteId: 'u1',
    blackId: 'bot',
    result: null,
    termination: null,
    plyCount: 0,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
  };
}

/** Build a typed lobby client seam and capture every create/accept/cancel call. */
function makeFakeClient(opts: {
  seeks?: SeekView[];
  createSeekResult?: SeekView;
  createSeek?: (body: CreateSeekRequest) => Promise<SeekView>;
  createBotGameError?: string;
  createBotGameResultId?: string;
  acceptSeek?: (id: string) => Promise<SeekView>;
  createBotGame?: (body: CreateBotGameRequest) => Promise<GameSummary>;
  userId?: string | null;
} = {}) {
  const createdSeeks: CreateSeekRequest[] = [];
  const canceledSeeks: string[] = [];
  const acceptedSeeks: string[] = [];
  const botGameCalls: CreateBotGameRequest[] = [];

  const client = {
    session: {
      current: opts.userId ? { user: { id: opts.userId, handle: 'alice' } } : null,
    },
    seeks: {
      list: async (): Promise<SeekView[]> => opts.seeks ?? [],
      create: async (body: CreateSeekRequest): Promise<SeekView> => {
        createdSeeks.push(body);
        if (opts.createSeek) return opts.createSeek(body);
        return opts.createSeekResult ?? makeSeek({ id: 'new-seek-id', ...(body as Partial<SeekView>) });
      },
      cancel: async (id: string): Promise<void> => {
        canceledSeeks.push(id);
      },
      accept: async (id: string): Promise<SeekView> => {
        acceptedSeeks.push(id);
        if (opts.acceptSeek) return opts.acceptSeek(id);
        return makeSeek({ id, gameId: 'game-matched-1' });
      },
    },
    games: {
      createVsBot: async (body: CreateBotGameRequest): Promise<GameSummary> => {
        botGameCalls.push(body);
        if (opts.createBotGame) return opts.createBotGame(body);
        if (opts.createBotGameError) {
          throw new Error(opts.createBotGameError);
        }
        return makeFakeGameSummary(opts.createBotGameResultId ?? 'bot-game-100');
      },
    },
  } as unknown as GambitClient;

  return { client, createdSeeks, canceledSeeks, acceptedSeeks, botGameCalls };
}

const mountedControllers = new Set<LobbyController>();

function mountTestLobby(deps: Parameters<typeof mountLobby>[0]): ReturnType<typeof mountLobby> {
  const mounted = mountLobby(deps);
  mountedControllers.add(mounted.lobby);
  return mounted;
}

afterEach(() => {
  for (const controller of mountedControllers) controller.dispose();
  mountedControllers.clear();
});

function submit(form: FakeDOMElement): void {
  let prevented = false;
  form.dispatchEvent({
    type: 'submit',
    target: form as unknown as EventTarget,
    get defaultPrevented(): boolean { return prevented; },
    preventDefault(): void { prevented = true; },
  } as unknown as Event);
}

/** Select exactly one radio in the fake DOM's named group. */
function selectRadio(form: FakeDOMElement, name: string, value: string): void {
  const radios = form.querySelectorAll<FakeDOMElement>(`input[name="${name}"]`);
  for (const radio of radios) radio.checked = radio.value === value;
}

/** Select a time control the way a click does — the panel only syncs on change. */
function chooseTime(form: FakeDOMElement, value: string): void {
  selectRadio(form, 'cg-time', value);
  form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')!
    .dispatchEvent(new Event('change'));
}

/** The disclosure toggle for the advanced controls. */
function moreToggle(form: FakeDOMElement): FakeDOMElement {
  const button = form.querySelector<FakeDOMElement>('.cg-more-toggle');
  assert.ok(button, 'no more-options toggle');
  return button;
}

/** The region the toggle controls. */
function advancedRegion(form: FakeDOMElement): FakeDOMElement {
  const region = form.querySelector<FakeDOMElement>('#cg-more-options');
  assert.ok(region, 'no more-options region');
  return region;
}

/** What the closed row currently says about the advanced choices. */
function summaryText(form: FakeDOMElement): string {
  return form.querySelector<FakeDOMElement>('.cg-more-summary')?.textContent ?? '';
}

/** One time-control radio by value. The fake DOM matches a single attribute. */
function timeRadio(form: FakeDOMElement, value: string): FakeDOMElement {
  const radio = form
    .querySelectorAll<FakeDOMElement>('input[name="cg-time"]')
    .find((candidate) => candidate.value === value);
  assert.ok(radio, `no cg-time radio for ${value}`);
  return radio;
}

/** Storage backed by a plain object, so a test can read back what was persisted. */
function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  readonly entries: Record<string, string>;
} {
  const entries = { ...seed };
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => { entries[key] = value; },
    removeItem: (key) => { delete entries[key]; },
  };
}

/** The one wire shape the server accepts for an untimed seek. */
const UNLIMITED_WIRE = { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' } as const;

const UNLIMITED_SUMMARY = 'Correspondence — no clock, so neither side can run out of time.';

// ── Tests ─────────────────────────────────────────────────────────────

test('renderSeeks: renders empty state when no seeks are open', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;

  renderSeeks(container, [], null);

  assert.ok(container.children.length > 0);
  const empty = container.children[0];
  assert.ok(empty);
  assert.ok(empty.classList.contains('empty'));
  assert.equal(empty.querySelector('.empty-mark')?.textContent, '♟');
  assert.equal(empty.querySelector('.empty-title')?.textContent, 'No open seeks right now');
  assert.equal(empty.querySelector('.empty-body')?.textContent, 'Create a game above — the first player to accept joins you.');
});

test('renderSeeks: renders owned seek with cancel affordance and waiting indicator', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-own',
    creatorId: 'user-me',
    variant: 'standard',
    speed: 'blitz',
    rated: true,
  });

  renderSeeks(container, [seek], 'user-me');

  assert.equal(container.children.length, 1);
  const row = container.children[0];
  assert.ok(row);
  assert.ok(row.classList.contains('seek-row'));
  assert.ok(row.classList.contains('seek-row-own'));
  assert.equal(row.dataset['seekId'], 's-own');

  const info = row.querySelector('.seek-info');
  assert.equal(info?.textContent, 'standard · blitz · 3+2 · rated');

  const waiting = row.querySelector('.seek-waiting');
  assert.ok(waiting);
  assert.equal(waiting.querySelector('.seek-dot')?.getAttribute('aria-hidden'), 'true');
  assert.equal(waiting.children[1]?.textContent, 'Waiting for an opponent…');

  const cancelBtn = row.querySelector<FakeDOMElement>('.seek-cancel');
  assert.ok(cancelBtn);
  assert.equal(cancelBtn.textContent, 'Cancel');
  assert.equal(cancelBtn.dataset['seekId'], 's-own');
  assert.equal(cancelBtn.getAttribute('aria-label'), 'Cancel your seek');
});

test('renderSeeks: renders other player seek with accept Play button', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-other',
    creatorId: 'user-them',
    variant: 'standard',
    speed: 'rapid',
    timeControl: { initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
  });

  renderSeeks(container, [seek], 'user-me');

  assert.equal(container.children.length, 1);
  const row = container.children[0];
  assert.ok(row);
  assert.ok(row.classList.contains('seek-row'));
  assert.ok(!row.classList.contains('seek-row-own'));
  assert.equal(row.dataset['seekId'], 's-other');

  const info = row.querySelector('.seek-info');
  assert.equal(info?.textContent, 'standard · rapid · 10 min');

  const acceptBtn = row.querySelector<FakeDOMElement>('.seek-accept');
  assert.ok(acceptBtn);
  assert.ok(acceptBtn.classList.contains('button'));
  assert.ok(acceptBtn.classList.contains('primary'));
  assert.equal(acceptBtn.textContent, 'Play');
  assert.equal(acceptBtn.dataset['seekId'], 's-other');
  assert.equal(acceptBtn.getAttribute('aria-label'), 'Accept seek');
});

test('renderSeeks: renders opponent identity with handle link when resolved', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-other',
    creatorId: 'user-them',
    variant: 'standard',
    speed: 'rapid',
    color: 'white',
    minRating: 1500,
    maxRating: 1800,
  });
  const names = new Map([['user-them', { id: 'user-them', handle: 'grandmaster1' }]]);

  renderSeeks(container, [seek], 'user-me', names);

  const row = container.children[0];
  assert.ok(row);
  const opponent = row.querySelector('.seek-opponent');
  assert.ok(opponent, 'seek row must render opponent identity');
  const link = opponent.querySelector('a.row-link');
  assert.ok(link, 'opponent handle should be a profile link');
  assert.equal(link.textContent, 'grandmaster1');
  assert.equal(link.getAttribute('href'), '/profile/grandmaster1');

  const details = row.querySelector('.seek-details');
  assert.ok(details);
  assert.ok(details.textContent?.includes('plays White'));
  assert.ok(details.textContent?.includes('1500–1800'));

  const acceptBtn = row.querySelector<FakeDOMElement>('.seek-accept');
  assert.equal(acceptBtn?.getAttribute('aria-label'), 'Accept seek from grandmaster1');
});

test('renderSeeks: falls back to shortId when opponent handle is unresolved', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-other',
    creatorId: '01a073ad-6e90-7000-8f14-45b38ea957c1',
    creatorHandle: null,
  });

  renderSeeks(container, [seek], 'user-me', new Map());

  const row = container.children[0];
  assert.ok(row);
  const opponent = row.querySelector('.seek-opponent');
  assert.ok(opponent);
  assert.ok(opponent.textContent?.includes('01a073ad'));
  const acceptBtn = row.querySelector<FakeDOMElement>('.seek-accept');
  assert.equal(acceptBtn?.getAttribute('aria-label'), 'Accept seek');
});

test('renderSeeks: renders opponent handle directly from seek.creatorHandle when GraphQL is unavailable (empty names)', () => {
  const { doc } = createTestDoc();
  const container = doc.createElement('div') as unknown as HTMLElement & FakeDOMElement;
  const seek = makeSeek({
    id: 's-other',
    creatorId: 'user-them',
    creatorHandle: 'challenger99',
  });

  // No names map passed (GraphQL unavailable or unconfigured)
  renderSeeks(container, [seek], 'user-me');

  const row = container.children[0];
  assert.ok(row);
  const opponent = row.querySelector('.seek-opponent');
  assert.ok(opponent, 'seek row must render opponent identity');
  const link = opponent.querySelector('a.row-link');
  assert.ok(link, 'opponent handle should be a profile link');
  assert.equal(link.textContent, 'challenger99');
  assert.equal(link.getAttribute('href'), '/profile/challenger99');

  const acceptBtn = row.querySelector<FakeDOMElement>('.seek-accept');
  assert.equal(acceptBtn?.getAttribute('aria-label'), 'Accept seek from challenger99');
});

test('mountLobby: wires delegated cancel button click to lobby.cancelSeek', async () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client, canceledSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  renderSeeks(seekListEl as unknown as HTMLElement, [makeSeek({ id: 'seek-to-cancel', creatorId: 'me' })], 'me');

  const cancelBtn = seekListEl.querySelector('.seek-cancel');
  assert.ok(cancelBtn);
  cancelBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(canceledSeeks, ['seek-to-cancel']);
});

test('mountLobby: wires delegated accept button click to lobby.acceptSeek', async () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client, acceptedSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  renderSeeks(seekListEl as unknown as HTMLElement, [makeSeek({ id: 'seek-to-accept', creatorId: 'other' })], 'me');

  const acceptBtn = seekListEl.querySelector('.seek-accept');
  assert.ok(acceptBtn);
  acceptBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(acceptedSeeks, ['seek-to-accept']);
});

test('POST-AUD-001: repeated lobby mounts do not stack delegated seek listeners', () => {
  const { doc, elements } = createTestDoc();
  const seekListEl = elements.get('seek-list')!;
  const { client } = makeFakeClient();

  const first = mountTestLobby({ doc, client, isAuthenticated: () => true });
  assert.equal(seekListEl.listenerCount('click'), 1);

  first.lobby.dispose();
  assert.equal(seekListEl.listenerCount('click'), 0);

  const second = mountTestLobby({ doc, client, isAuthenticated: () => true });
  assert.equal(seekListEl.listenerCount('click'), 1);

  second.lobby.dispose();
  second.lobby.dispose();
  assert.equal(seekListEl.listenerCount('click'), 0);
});

test('POST-AUD-001: deferred seek acceptance cannot navigate after disposal', async () => {
  const pendingAcceptance = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient({ acceptSeek: () => pendingAcceptance.promise });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const originalWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
    renderSeeks(
      elements.get('seek-list') as unknown as HTMLElement,
      [makeSeek({ id: 'pending-seek', creatorId: 'other' })],
      'me',
    );
    elements.get('seek-list')!.querySelector('.seek-accept')!.click();
    mounted.lobby.dispose();
    pendingAcceptance.resolve(makeSeek({ id: 'pending-seek', gameId: 'stale-game' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(locationState.href, '');
  } finally {
    if (originalWindow === undefined) delete target['window'];
    else target['window'] = originalWindow;
  }
});

test('mountLobby: session changes update PlayBotDialog without changing create-panel state', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  const mounted = mountTestLobby({
    doc,
    client,
    isAuthenticated: () => false,
  });

  const createBtn = elements.get('create-game')!.querySelector('#create-seek')!;
  const playBotBtn = elements.get('play-bot-mount')!.querySelector('#play-bot')!;

  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, true);
  assert.equal(playBotBtn.title, 'Sign in to play the computer');

  // Bootstrap owns the persistent create trigger. This seam preserves the existing dialog-only
  // update that also closes an open dialog on sign-out.
  mounted.setPlayBotAuthenticated(true);

  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, false);
  assert.equal(playBotBtn.title, '');

  mounted.setPlayBotAuthenticated(false);
  assert.equal(createBtn.disabled, true);
  assert.equal(createBtn.title, 'Sign in to create a seek');
  assert.equal(playBotBtn.disabled, true);
  assert.equal(playBotBtn.title, 'Sign in to play the computer');

});

test('mountLobby: failed play-bot submission keeps the dialog open with its error', async () => {
  const { doc, elements } = createTestDoc();
  const { client, botGameCalls } = makeFakeClient({
    createBotGameError: 'Engine service offline',
  });

  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const origWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    mountTestLobby({
      doc,
      client,
      isAuthenticated: () => true,
    });

    const playBotMount = elements.get('play-bot-mount')!;
    const playBotBtn = playBotMount.querySelector('#play-bot')!;
    playBotBtn.click();

    const dialog = playBotMount.querySelector('dialog')!;
    assert.equal(dialog.open, true);

    const form = playBotMount.querySelector('form')!;
    submit(form);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(botGameCalls.length, 1);
    assert.equal(botGameCalls[0]?.variant, 'standard');
    assert.equal(playBotMount.querySelector('#pb-error')?.textContent, 'Engine service offline');
    assert.equal(locationState.href, '');

  } finally {
    if (origWindow === undefined) {
      delete target['window'];
    } else {
      target['window'] = origWindow;
    }
  }
});

test('mountLobby: successful play-bot submission navigates to the created standard game', async () => {
  const { doc, elements } = createTestDoc();
  const { client, botGameCalls } = makeFakeClient({ createBotGameResultId: 'game-success-99' });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const origWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    mountTestLobby({ doc, client, isAuthenticated: () => true });
    const form = elements.get('play-bot-mount')!.querySelector('form')!;
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(botGameCalls.length, 1);
    assert.equal(botGameCalls[0]?.variant, 'standard');
    assert.equal(locationState.href, '/game/game-success-99');
  } finally {
    if (origWindow === undefined) delete target['window'];
    else target['window'] = origWindow;
  }
});

test('POST-AUD-001: deferred bot creation cannot navigate after disposal', async () => {
  const pendingGame = deferred<GameSummary>();
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient({ createBotGame: () => pendingGame.promise });
  const locationState = { href: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const originalWindow = target['window'];
  target['window'] = { location: locationState };

  try {
    const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
    submit(elements.get('play-bot-mount')!.querySelector('form')!);
    mounted.lobby.dispose();
    pendingGame.resolve(makeFakeGameSummary('stale-bot-game'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(locationState.href, '');
  } finally {
    if (originalWindow === undefined) delete target['window'];
    else target['window'] = originalWindow;
  }
});

test('mountLobby: create-game renders canonical choices with the advanced ones disclosed', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });

  const form = elements.get('create-game')!.querySelector('#create-game-form')!;
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-time"]').map((radio) => radio.value),
    ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+20', 'unlimited', 'custom'],
  );
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-mode"]').map((radio) => radio.value),
    ['casual', 'rated'],
  );
  const variantRadios = form.querySelectorAll<FakeDOMElement>('input[name="cg-variant"]');
  assert.deepEqual(variantRadios.map((radio) => radio.value), OFFERED_VARIANTS);
  assert.deepEqual(
    variantRadios.map((radio) => radio.parentElement?.textContent),
    OFFERED_VARIANTS.map((variant) => VARIANT_LABELS[variant]),
  );
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'standard');
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-color"]').map((radio) => radio.value),
    ['random', 'white', 'black'],
  );
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'random');
  assert.deepEqual(
    form.querySelectorAll<FakeDOMElement>('legend').map((legend) => legend.textContent),
    ['Time', 'Mode', 'Color', 'Variant', 'Opponent rating'],
  );
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating');
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating');
  assert.equal(minimum?.type, 'text');
  assert.equal(maximum?.type, 'text');
  assert.equal(minimum?.getAttribute('inputmode'), 'numeric');
  assert.equal(maximum?.getAttribute('inputmode'), 'numeric');
  assert.equal(minimum?.getAttribute('aria-describedby'), 'cg-rating-hint cg-rating-error');
  assert.equal(maximum?.getAttribute('aria-describedby'), 'cg-rating-hint cg-rating-error');
  assert.equal(form.querySelector('#cg-rating-hint')?.textContent, 'Leave blank for no restriction.');
  const toggle = form.querySelector<FakeDOMElement>('.cg-more-toggle')!;
  const advanced = form.querySelector<FakeDOMElement>('#cg-more-options')!;
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('type'), 'button');
  assert.equal(toggle.getAttribute('aria-controls'), 'cg-more-options');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(toggle.textContent.includes('More options'));
  // Default state: nothing advanced is set, so the section stays out of the way.
  assert.equal(advanced.hidden, true);
  assert.equal(form.querySelector('.cg-more-summary')?.textContent, 'Standard · Any rating');
  // Both advanced fieldsets live inside the one region, and nowhere else.
  assert.equal(advanced.querySelectorAll('input[name="cg-variant"]').length, OFFERED_VARIANTS.length);
  assert.equal(form.querySelectorAll('input[name="cg-variant"]').length, OFFERED_VARIANTS.length);
  assert.ok(advanced.contains(form.querySelector('#cg-min-rating')));
  assert.ok(advanced.contains(form.querySelector('#cg-max-rating')));
  assert.equal(form.querySelector('select'), null);
  assert.equal(form.querySelector('.cg-custom')?.hidden, true);
  assert.equal(form.querySelector('.cg-time-summary')?.hidden, false);
});

test('mountLobby: default submit sends the exact 10+0 casual request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  submit(mount.querySelector('#create-game-form')!);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: {
      initialMs: 600_000,
      incrementMs: 0,
      delayMs: 0,
      kind: 'sudden_death',
    },
    rated: false,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: unrestricted, one-sided, both, and endpoint rating bounds reach the exact request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;
  const cases = [
    { min: '', max: '', expectedMin: null, expectedMax: null },
    { min: '1500', max: '', expectedMin: 1500, expectedMax: null },
    { min: '', max: '1800', expectedMin: null, expectedMax: 1800 },
    { min: '1500', max: '1800', expectedMin: 1500, expectedMax: 1800 },
    { min: '0', max: '4000', expectedMin: 0, expectedMax: 4000 },
    { min: '1500', max: '1500', expectedMin: 1500, expectedMax: 1500 },
  ] as const;

  for (const ratingCase of cases) {
    mount.querySelector('#create-seek')!.click();
    selectRadio(form, 'cg-time', '5+3');
    selectRadio(form, 'cg-mode', 'rated');
    selectRadio(form, 'cg-variant', 'atomic');
    selectRadio(form, 'cg-color', 'black');
    minimum.value = ratingCase.min;
    maximum.value = ratingCase.max;
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(form.hidden, true, `${ratingCase.min}/${ratingCase.max}`);
  }

  assert.deepEqual(createdSeeks, cases.map((ratingCase) => ({
    variant: 'atomic',
    timeControl: {
      initialMs: 300_000,
      incrementMs: 3_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
    color: 'black',
    minRating: ratingCase.expectedMin,
    maxRating: ratingCase.expectedMax,
  })));
});

test('mountLobby: malformed and out-of-range rating literals block submission at their field', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;

  for (const value of ['-1', '4001', '1.5', '1e3', 'rating']) {
    minimum.value = value;
    maximum.value = '';
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(createdSeeks.length, 0, value);
    assert.equal(minimum.getAttribute('aria-invalid'), 'true', value);
    assert.equal(form.querySelector('#cg-rating-error')?.textContent, 'Enter a whole rating from 0 to 4000.');
    minimum.value = '';
    minimum.dispatchEvent(new Event('input'));
  }

  maximum.value = '4001';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(maximum.getAttribute('aria-invalid'), 'true');
  assert.equal(createdSeeks.length, 0);

  minimum.value = '1000';
  minimum.dispatchEvent(new Event('input'));
  assert.equal(maximum.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, false);

  maximum.value = '3000';
  maximum.dispatchEvent(new Event('input'));
  assert.equal(maximum.getAttribute('aria-invalid'), null);
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, true);

  minimum.value = '-1';
  maximum.value = '2000';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  maximum.value = '3000';
  maximum.dispatchEvent(new Event('input'));
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, false);
});

test('mountLobby: minimum above maximum blocks submission and owns the relationship error', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;
  minimum.value = '1800';
  maximum.value = '1500';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 0);
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
  assert.equal(maximum.getAttribute('aria-invalid'), null);
  assert.equal(form.querySelector('#cg-rating-error')?.textContent, 'Minimum rating must not exceed maximum rating.');

  maximum.value = '1900';
  maximum.dispatchEvent(new Event('input'));
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, true);
  assert.equal(minimum.getAttribute('aria-invalid'), null);
  assert.equal(maximum.getAttribute('aria-invalid'), null);
});

test('mountLobby: rating feedback is isolated from unrelated choices and custom-time feedback', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  minimum.value = '-1';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');

  selectRadio(form, 'cg-variant', 'atomic');
  selectRadio(form, 'cg-color', 'black');
  selectRadio(form, 'cg-mode', 'rated');
  selectRadio(form, 'cg-time', '5+3');
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, false);

  selectRadio(form, 'cg-time', 'custom');
  form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')!.dispatchEvent(new Event('change'));
  form.querySelector<FakeDOMElement>('#cg-increment')!.value = '';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('#cg-custom-error')?.hidden, false);
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, false);
  assert.equal(createdSeeks.length, 0);

  minimum.value = '1500';
  minimum.dispatchEvent(new Event('input'));
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, true);
  assert.equal(form.querySelector('#cg-custom-error')?.hidden, false);
});

test('mountLobby: creates the exact V1 seek request and collapses on success', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  const createGameMount = elements.get('create-game')!;
  const createBtn = createGameMount.querySelector('#create-seek')!;
  createBtn.click(); // Expand form

  const form = createGameMount.querySelector('#create-game-form')!;
  assert.equal(form.hidden, false);

  selectRadio(form, 'cg-time', '15+10');
  selectRadio(form, 'cg-mode', 'rated');

  submit(form);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(createdSeeks.length, 1);
  assert.deepEqual(createdSeeks[0], {
    variant: 'standard',
    timeControl: {
      initialMs: 900_000,
      incrementMs: 10_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
    color: 'random',
    minRating: null,
    maxRating: null,
  });
  assert.equal(form.hidden, true); // Collapses on successful create

});

test('mountLobby: a newly exposed preset changes the exact rated seek payload', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', '2+1');
  selectRadio(form, 'cg-mode', 'rated');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: {
      initialMs: 120_000,
      incrementMs: 1_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: every offered variant reaches the request unchanged', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  const form = mount.querySelector('#create-game-form')!;
  for (const variant of OFFERED_VARIANTS) {
    mount.querySelector('#create-seek')!.click();
    selectRadio(form, 'cg-variant', variant);
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(createdSeeks.map((request) => request.variant), OFFERED_VARIANTS);
});

test('mountLobby: selected variant and color reach the exact existing seek payload', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', '5+3');
  selectRadio(form, 'cg-mode', 'rated');
  selectRadio(form, 'cg-variant', 'atomic');
  selectRadio(form, 'cg-color', 'black');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'atomic',
    color: 'black',
    timeControl: {
      initialMs: 300_000,
      incrementMs: 3_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: a second non-standard variant preserves White and casual mode', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', '2+1');
  selectRadio(form, 'cg-variant', 'racingkings');
  selectRadio(form, 'cg-color', 'white');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'racingkings',
    color: 'white',
    timeControl: {
      initialMs: 120_000,
      incrementMs: 1_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: false,
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: tampered variant or color radio values never reach the API', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const variant = form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')!;
  const color = form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')!;

  variant.value = 'antichess';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 0);

  variant.value = 'standard';
  color.value = 'green';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 0);
});

test('mountLobby: valid Custom values create and persist the exact request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  const memoryStorage: Record<string, string> = {};
  const storage: KeyValueStorage = {
    getItem: (key) => memoryStorage[key] ?? null,
    setItem: (key, value) => { memoryStorage[key] = value; },
    removeItem: (key) => { delete memoryStorage[key]; },
  };

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', 'custom');
  form.querySelector<FakeDOMElement>('#cg-minutes')!.value = '7.5';
  form.querySelector<FakeDOMElement>('#cg-increment')!.value = '4';
  selectRadio(form, 'cg-mode', 'rated');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: {
      initialMs: 450_000,
      incrementMs: 4_000,
      delayMs: 0,
      kind: 'increment',
    },
    rated: true,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
  assert.deepEqual(JSON.parse(memoryStorage['gambit-create-game']!), {
    time: 'custom',
    minutes: 7.5,
    increment: 4,
    mode: 'rated',
    variant: 'standard',
    color: 'random',
    minRating: null,
    maxRating: null,
  });
});

test('mountLobby: invalid Custom values show a field error and send no request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', 'custom');
  const minutes = form.querySelector<FakeDOMElement>('#cg-minutes')!;
  minutes.value = '0';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 0);
  assert.equal(minutes.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.cg-field-error')?.textContent, 'Minutes must be between 0.5 and 180 in 0.5-minute steps.');
  assert.equal(form.querySelector('.cg-submit')?.disabled, false);

  minutes.value = '5';
  const increment = form.querySelector<FakeDOMElement>('#cg-increment')!;
  increment.value = '';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 0);
  assert.equal(increment.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.cg-field-error')?.textContent, 'Increment must be a whole number between 0 and 60 seconds.');
});

test('mountLobby: editing the other Custom field preserves current validation feedback', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', 'custom');
  const minutes = form.querySelector<FakeDOMElement>('#cg-minutes')!;
  const increment = form.querySelector<FakeDOMElement>('#cg-increment')!;
  minutes.value = '5';
  increment.value = '';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 0);
  assert.equal(increment.getAttribute('aria-invalid'), 'true');

  minutes.value = '6';
  minutes.dispatchEvent(new Event('input'));
  assert.equal(increment.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.cg-field-error')?.textContent, 'Increment must be a whole number between 0 and 60 seconds.');

  increment.value = '2';
  increment.dispatchEvent(new Event('input'));
  assert.equal(increment.getAttribute('aria-invalid'), null);
  assert.equal(form.querySelector('.cg-field-error')?.hidden, true);
});

test('mountLobby: variant and color changes preserve another custom field validation error', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', 'custom');
  const increment = form.querySelector<FakeDOMElement>('#cg-increment')!;
  increment.value = '';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 0);
  assert.equal(increment.getAttribute('aria-invalid'), 'true');

  selectRadio(form, 'cg-variant', 'atomic');
  assert.equal(increment.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.cg-field-error')?.hidden, false);

  selectRadio(form, 'cg-color', 'black');
  assert.equal(increment.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.cg-field-error')?.hidden, false);
});

test('mountLobby: blocks duplicate seek submissions while the first is pending', async () => {
  const pendingSeek = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({ createSeek: () => pendingSeek.promise });

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;

  submit(form);
  submit(form);

  assert.equal(createdSeeks.length, 1);
  assert.equal(form.querySelector('.cg-submit')?.disabled, true);
  assert.equal(form.querySelector('.cg-submit')?.textContent, 'Creating…');
  assert.equal(form.getAttribute('aria-busy'), 'true');
  const radios = [
    ...form.querySelectorAll<FakeDOMElement>('input[name="cg-time"]'),
    ...form.querySelectorAll<FakeDOMElement>('input[name="cg-mode"]'),
    ...form.querySelectorAll<FakeDOMElement>('input[name="cg-variant"]'),
    ...form.querySelectorAll<FakeDOMElement>('input[name="cg-color"]'),
  ];
  assert.ok(radios.length > 0);
  assert.ok(radios.every((input) => input.disabled));
  assert.equal(minimum.disabled, true);
  assert.equal(maximum.disabled, true);
  assert.equal(form.querySelector('.cg-cancel')?.disabled, true);

  pendingSeek.resolve(makeSeek({ id: 'pending-created' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(form.hidden, true);
  assert.equal(form.getAttribute('aria-busy'), 'false');
});

test('mountLobby: failed create preserves choices, unlocks submit, and retries', async () => {
  let attempt = 0;
  const savedPrefs: string[] = [];
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({
    createSeek: async (body) => {
      attempt++;
      if (attempt === 1) throw new Error('Seek service unavailable');
      return makeSeek({ id: 'retry-created', ...(body as Partial<SeekView>) });
    },
  });
  const storage: KeyValueStorage = {
    getItem: () => null,
    setItem: (_key, value) => { savedPrefs.push(value); },
    removeItem: () => {},
  };

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-time', '3+0');
  selectRadio(form, 'cg-mode', 'rated');
  selectRadio(form, 'cg-variant', 'horde');
  selectRadio(form, 'cg-color', 'white');
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;
  minimum.value = '1400';
  maximum.value = '1900';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(form.hidden, false);
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '3+0');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'horde');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'white');
  assert.equal(minimum.value, '1400');
  assert.equal(maximum.value, '1900');
  assert.deepEqual(savedPrefs, []);
  assert.equal(elements.get('lobby-error')?.textContent, 'Seek service unavailable');
  assert.equal(form.querySelector('.cg-submit')?.disabled, false);
  assert.equal(form.querySelector('.cg-submit')?.textContent, 'Create seek');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.disabled, false);
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.disabled, false);

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 2);
  assert.equal(savedPrefs.length, 1);
  assert.deepEqual(JSON.parse(savedPrefs[0]!), {
    time: '3+0',
    mode: 'rated',
    variant: 'horde',
    color: 'white',
    minRating: 1400,
    maxRating: 1900,
  });
  assert.equal(form.hidden, true);
});

test('mountLobby: session loss collapses and disables the create-game panel', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();
  const mounted = mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  const trigger = mount.querySelector('#create-seek')!;
  const form = mount.querySelector('#create-game-form')!;
  trigger.click();

  mounted.setCreateGameAuthenticated(false);

  assert.equal(form.hidden, true);
  assert.equal(trigger.disabled, true);
  assert.equal(trigger.title, 'Sign in to create a seek');
});

test('mountLobby: reports errors to #lobby-error element', async () => {
  const { doc, elements } = createTestDoc();
  const errorEl = elements.get('lobby-error')!;
  const client = {
    session: { current: null },
    seeks: {
      list: async (): Promise<SeekView[]> => { throw new Error('Service unavailable'); },
      create: async () => null,
      cancel: async () => {},
      accept: async () => null,
    },
    games: {
      createVsBot: async () => makeFakeGameSummary('g1'),
    },
  } as unknown as GambitClient;

  const mounted = mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
  });

  await mounted.lobby.refresh();
  assert.equal(errorEl.textContent, 'Service unavailable');

});

test('mountLobby: the untimed choice is offered with an accessible name and a speed', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });

  const form = elements.get('create-game')!.querySelector('#create-game-form')!;
  const unlimited = timeRadio(form, 'unlimited');
  assert.equal(unlimited.type, 'radio');
  assert.equal(unlimited.checked, false);
  // The word itself, not a glyph standing in for it.
  assert.equal(unlimited.parentElement?.textContent, 'UnlimitedCorrespondence');
  // One group, so the browser's own radio semantics carry selection and roving focus.
  assert.equal(unlimited.getAttribute('name'), 'cg-time');
  // The same chip the presets use, so it inherits their checked/focus styling.
  assert.equal(unlimited.parentElement?.classList.contains('cg-chip'), true);
});

test('mountLobby: choosing the untimed control describes it and hides the custom fields', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const summary = form.querySelector<FakeDOMElement>('.cg-time-summary')!;

  chooseTime(form, '10+0');
  assert.equal(summary.textContent, 'Rapid — 10 minutes per side, no increment.');

  chooseTime(form, 'unlimited');
  assert.equal(form.querySelector('.cg-custom')?.hidden, true);
  assert.equal(summary.hidden, false);
  // Not the stale 10+0 sentence a missing branch would leave in the live region.
  assert.equal(summary.textContent, UNLIMITED_SUMMARY);

  chooseTime(form, '5+3');
  assert.equal(summary.textContent, 'Blitz — 5 minutes per side, 3 second increment.');
});

test('mountLobby: the untimed choice reaches the exact zero-duration request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();
  const storage = memoryStorage();

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  chooseTime(form, 'unlimited');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: UNLIMITED_WIRE,
    rated: false,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
  assert.deepEqual(JSON.parse(storage.entries['gambit-create-game']!), {
    time: 'unlimited',
    mode: 'casual',
    variant: 'standard',
    color: 'random',
    minRating: null,
    maxRating: null,
  });
});

test('mountLobby: the untimed choice carries variant, rated, color, and rating bounds', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  selectRadio(form, 'cg-variant', 'atomic');
  selectRadio(form, 'cg-mode', 'rated');
  selectRadio(form, 'cg-color', 'black');
  form.querySelector<FakeDOMElement>('#cg-min-rating')!.value = '1500';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1800';
  chooseTime(form, 'unlimited');

  // Choosing the time control resets nothing else.
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'atomic');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'black');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '1500');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '1800');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'atomic',
    timeControl: UNLIMITED_WIRE,
    rated: true,
    color: 'black',
    minRating: 1500,
    maxRating: 1800,
  }]);
});

test('mountLobby: one-sided and equal rating bounds reach the untimed request unchanged', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;
  chooseTime(form, 'unlimited');

  for (const [low, high] of [['1200', ''], ['', '2200'], ['1600', '1600']] as const) {
    minimum.value = low;
    maximum.value = high;
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(createdSeeks.map((seek) => [seek.minRating, seek.maxRating]), [
    [1200, null],
    [null, 2200],
    [1600, 1600],
  ]);
  assert.ok(createdSeeks.every((seek) => seek.timeControl.kind === 'unlimited'));
  for (const seek of createdSeeks) assert.deepEqual(seek.timeControl, UNLIMITED_WIRE);
});

/**
 * The custom fields keep whatever the player last typed, valid or not. They
 * describe a choice that is not selected, so they must neither block the request
 * nor leak a duration into it.
 */
test('mountLobby: invalid custom values neither block nor reach the untimed request', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  chooseTime(form, 'custom');
  const minutes = form.querySelector<FakeDOMElement>('#cg-minutes')!;
  minutes.value = '0';
  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 0);
  assert.equal(minutes.getAttribute('aria-invalid'), 'true');

  chooseTime(form, 'unlimited');
  assert.equal(form.querySelector('#cg-custom-error')?.hidden, true);
  assert.equal(minutes.getAttribute('aria-invalid'), null);

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: UNLIMITED_WIRE,
    rated: false,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: custom values survive a detour through the untimed choice', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const minutes = form.querySelector<FakeDOMElement>('#cg-minutes')!;
  const increment = form.querySelector<FakeDOMElement>('#cg-increment')!;

  chooseTime(form, 'custom');
  minutes.value = '12';
  increment.value = '3';

  chooseTime(form, 'unlimited');
  assert.equal(minutes.value, '12');
  assert.equal(increment.value, '3');

  chooseTime(form, 'custom');
  assert.equal(minutes.value, '12');
  assert.equal(increment.value, '3');
  assert.equal(form.querySelector('.cg-custom')?.hidden, false);

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'standard',
    timeControl: { initialMs: 720_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' },
    rated: false,
    color: 'random',
    minRating: null,
    maxRating: null,
  }]);
});

test('mountLobby: a rating error blocks the untimed request and owns its own field', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  chooseTime(form, 'unlimited');
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  minimum.value = '1800';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1500';

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 0);
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('#cg-rating-error')?.hidden, false);
  // The untimed choice raises no clock error of its own.
  assert.equal(form.querySelector('#cg-custom-error')?.hidden, true);
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'unlimited');
});

test('mountLobby: a pending untimed create disables its own selector and blocks a second submit', async () => {
  const pendingSeek = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({ createSeek: () => pendingSeek.promise });

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  chooseTime(form, 'unlimited');

  submit(form);
  submit(form);

  assert.equal(createdSeeks.length, 1);
  assert.equal(
    timeRadio(form, 'unlimited').disabled,
    true,
  );
  assert.ok(
    form.querySelectorAll<FakeDOMElement>('input[name="cg-time"]').every((radio) => radio.disabled),
  );
  assert.equal(form.querySelector('.cg-submit')?.disabled, true);
  assert.equal(form.querySelector('.cg-cancel')?.disabled, true);
  assert.equal(form.getAttribute('aria-busy'), 'true');

  pendingSeek.resolve(makeSeek({ id: 'unlimited-created' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    timeRadio(form, 'unlimited').disabled,
    false,
  );
});

test('mountLobby: a failed untimed create keeps the choice, retries, and does not persist', async () => {
  let attempt = 0;
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient({
    createSeek: async (body) => {
      attempt++;
      if (attempt === 1) throw new Error('network down');
      return makeSeek({ id: 'retried', variant: body.variant });
    },
  });
  const storage = memoryStorage({
    'gambit-create-game': JSON.stringify({ time: '5+3', mode: 'rated' }),
  });

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  chooseTime(form, 'unlimited');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 1);
  assert.equal(form.hidden, false);
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'unlimited');
  assert.equal(form.querySelector('.cg-submit')?.disabled, false);
  // The last known-good preference survives the failure untouched.
  assert.deepEqual(JSON.parse(storage.entries['gambit-create-game']!), { time: '5+3', mode: 'rated' });

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 2);
  assert.deepEqual(createdSeeks[1]?.timeControl, UNLIMITED_WIRE);
  // The restored rated mode rode through the time-control change untouched.
  assert.deepEqual(JSON.parse(storage.entries['gambit-create-game']!), {
    time: 'unlimited', mode: 'rated', variant: 'standard', color: 'random',
    minRating: null, maxRating: null,
  });
});

test('mountLobby: a stored untimed preference restores every choice', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage = memoryStorage({
    'gambit-create-game': JSON.stringify({
      time: 'unlimited', mode: 'rated', variant: 'crazyhouse', color: 'white',
      minRating: 1400, maxRating: 2100,
    }),
  });

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'unlimited');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'crazyhouse');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'white');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '1400');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '2100');
  assert.equal(form?.querySelector('.cg-custom')?.hidden, true);
  assert.equal(form?.querySelector('.cg-time-summary')?.textContent, UNLIMITED_SUMMARY);
});

test('mountLobby: a preference naming an unknown time control never selects the untimed one', () => {
  for (const time of ['7+7', 'infinite', 'Unlimited', '0+0', '']) {
    const { doc } = createTestDoc();
    const { client } = makeFakeClient();
    const storage = memoryStorage({
      'gambit-create-game': JSON.stringify({ time, mode: 'rated', variant: 'horde' }),
    });

    mountTestLobby({ doc, client, isAuthenticated: () => true, storage });

    const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
      .querySelector('#create-game-form');
    assert.equal(
      form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value,
      '10+0',
      time,
    );
    assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'casual', time);
  }
});

/**
 * The formatter is what stands in for the hidden controls, so a wrong string is
 * a user looking at a filter they cannot see.
 */
test('the disclosure summary names the variant and the rating bound in words', () => {
  const cases: readonly (readonly [Variant, number | null, number | null, string])[] = [
    ['standard', null, null, 'Standard · Any rating'],
    ['atomic', null, null, 'Atomic · Any rating'],
    ['standard', 1200, null, 'Standard · Rating 1200 and up'],
    ['standard', null, 1800, 'Standard · Rating up to 1800'],
    ['standard', 1600, 1600, 'Standard · Rating 1600 exactly'],
    ['standard', 1200, 1800, 'Standard · Rating 1200 to 1800'],
    ['crazyhouse', 1200, 1800, 'Crazyhouse · Rating 1200 to 1800'],
    ['kingofthehill', 0, 4000, 'King of the Hill · Rating 0 to 4000'],
  ];
  for (const [variant, minRating, maxRating, expected] of cases) {
    assert.equal(
      formatMoreOptionsSummary(variant, { ok: true, minRating, maxRating }),
      expected,
      expected,
    );
  }
});

/** A range the panel would reject must never read as a settled choice. */
test('the disclosure summary refuses to describe an invalid rating as valid', () => {
  assert.equal(
    formatMoreOptionsSummary('standard', { ok: false }),
    'Standard · Opponent rating needs attention',
  );
  assert.equal(
    formatMoreOptionsSummary('horde', { ok: false }),
    'Horde · Opponent rating needs attention',
  );
});

test('mountLobby: the default panel hides the advanced controls behind the disclosure', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;

  assert.equal(advancedRegion(form).hidden, true);
  assert.equal(moreToggle(form).getAttribute('aria-expanded'), 'false');
  assert.equal(summaryText(form), 'Standard · Any rating');
  // The values are still there to submit — only the presentation is closed.
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'standard');
});

test('mountLobby: the disclosure toggles and reports its state on the button', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(advancedRegion(form).hidden, false);
  // Expanded, the real controls speak for themselves.
  assert.equal(form.querySelector<FakeDOMElement>('.cg-more-summary')?.hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(advancedRegion(form).hidden, true);
  assert.equal(form.querySelector<FakeDOMElement>('.cg-more-summary')?.hidden, false);
});

test('mountLobby: toggling the disclosure changes nothing that gets submitted', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);

  toggle.click();
  chooseTime(form, 'custom');
  form.querySelector<FakeDOMElement>('#cg-minutes')!.value = '12';
  form.querySelector<FakeDOMElement>('#cg-increment')!.value = '3';
  selectRadio(form, 'cg-variant', 'atomic');
  selectRadio(form, 'cg-mode', 'rated');
  selectRadio(form, 'cg-color', 'black');
  form.querySelector<FakeDOMElement>('#cg-min-rating')!.value = '1200';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1800';

  for (let cycle = 0; cycle < 3; cycle++) {
    toggle.click();
    toggle.click();
  }

  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'custom');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-minutes')?.value, '12');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-increment')?.value, '3');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'atomic');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'black');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '1200');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '1800');

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(createdSeeks, [{
    variant: 'atomic',
    timeControl: { initialMs: 720_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' },
    rated: true,
    color: 'black',
    minRating: 1200,
    maxRating: 1800,
  }]);
});

test('mountLobby: the collapsed summary follows every advanced edit', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;
  const maximum = form.querySelector<FakeDOMElement>('#cg-max-rating')!;

  toggle.click();
  selectRadio(form, 'cg-variant', 'atomic');
  form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')!
    .dispatchEvent(new Event('change'));
  minimum.value = '1200';
  minimum.dispatchEvent(new Event('input'));
  toggle.click();
  assert.equal(summaryText(form), 'Atomic · Rating 1200 and up');

  toggle.click();
  minimum.value = '';
  minimum.dispatchEvent(new Event('input'));
  maximum.value = '1800';
  maximum.dispatchEvent(new Event('input'));
  toggle.click();
  assert.equal(summaryText(form), 'Atomic · Rating up to 1800');

  toggle.click();
  minimum.value = '1800';
  minimum.dispatchEvent(new Event('input'));
  toggle.click();
  assert.equal(summaryText(form), 'Atomic · Rating 1800 exactly');
});

/**
 * The whole point of the summary: a filter the player cannot see must still be
 * announced, and a bad one must not read as settled.
 */
test('mountLobby: a collapsed invalid range says so instead of implying a choice', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;

  toggle.click();
  minimum.value = '2000';
  minimum.dispatchEvent(new Event('input'));
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1500';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.dispatchEvent(new Event('input'));
  toggle.click();

  assert.equal(summaryText(form), 'Standard · Opponent rating needs attention');
  // Closing retires the inline message but keeps what was typed.
  assert.equal(minimum.value, '2000');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '1500');
});

/**
 * Focusing a field inside a closed section would leave the player staring at a
 * form that refuses to submit and says nothing about why.
 */
test('mountLobby: submitting a hidden invalid range opens the section before reporting it', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);
  const minimum = form.querySelector<FakeDOMElement>('#cg-min-rating')!;

  toggle.click();
  minimum.value = '2000';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1500';
  toggle.click();
  assert.equal(advancedRegion(form).hidden, true);

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createdSeeks.length, 0);
  assert.equal(advancedRegion(form).hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-rating-error')?.hidden, false);
  assert.equal(minimum.getAttribute('aria-invalid'), 'true');
});

/**
 * Collapsing hides whatever the player was editing. Browsers disagree about what
 * a click does to focus — Chromium focuses the button, Safari and Firefox on
 * macOS blur to the document — so the panel claims focus rather than inspecting
 * it, and the result has to hold from either starting point.
 */
test('mountLobby: toggling the section always leaves focus on the toggle', () => {
  for (const startInside of [true, false]) {
    const { doc, elements } = createTestDoc();
    const { client } = makeFakeClient();

    mountTestLobby({ doc, client, isAuthenticated: () => true });
    const mount = elements.get('create-game')!;
    mount.querySelector('#create-seek')!.click();
    const form = mount.querySelector('#create-game-form')!;
    const toggle = moreToggle(form);
    toggle.click();
    assert.equal(advancedRegion(form).hidden, false);

    // Either the browser left focus on the field being edited, or it dropped it
    // somewhere outside the region entirely.
    const origin = startInside
      ? form.querySelector<FakeDOMElement>('#cg-min-rating')!
      : form.querySelector<FakeDOMElement>('.cg-submit')!;
    origin.focus();
    const before = toggle.focusCount;

    toggle.click();

    const where = startInside ? 'from inside' : 'from outside';
    assert.equal(advancedRegion(form).hidden, true, where);
    assert.equal(toggle.focusCount, before + 1, where);
    assert.equal((doc as unknown as { activeElement: unknown }).activeElement, toggle, where);
  }
});

/** Opening ends on the toggle too, so Tab walks straight into the region. */
test('mountLobby: opening the section leaves focus on the toggle', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);

  toggle.click();

  assert.equal(advancedRegion(form).hidden, false);
  assert.equal((doc as unknown as { activeElement: unknown }).activeElement, toggle);
});

test('mountLobby: a pending create locks the disclosure with every other control', async () => {
  const pendingSeek = deferred<SeekView>();
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient({ createSeek: () => pendingSeek.promise });

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);

  submit(form);

  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  pendingSeek.resolve(makeSeek({ id: 'disclosure-pending' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(toggle.disabled, false);
});

test('mountLobby: restored advanced preferences open the section instead of hiding', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage = memoryStorage({
    'gambit-create-game': JSON.stringify({
      time: '5+3', mode: 'rated', variant: 'atomic', color: 'black',
      minRating: 1200, maxRating: 1800,
    }),
  });

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form')!;

  assert.equal(advancedRegion(form).hidden, false);
  assert.equal(moreToggle(form).getAttribute('aria-expanded'), 'true');
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'atomic');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '1200');
});

test('mountLobby: a rating bound alone is enough to open the section', () => {
  for (const [stored, expectedSummary] of [
    [{ minRating: 1200 }, 'Standard · Rating 1200 and up'],
    [{ maxRating: 1800 }, 'Standard · Rating up to 1800'],
    [{ variant: 'horde' }, 'Horde · Any rating'],
  ] as const) {
    const { doc } = createTestDoc();
    const { client } = makeFakeClient();
    const storage = memoryStorage({
      'gambit-create-game': JSON.stringify({ time: '10+0', mode: 'casual', ...stored }),
    });

    mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
    const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
      .querySelector('#create-game-form')!;

    assert.equal(advancedRegion(form).hidden, false, JSON.stringify(stored));
    // Still useful once the player closes it by hand.
    moreToggle(form).click();
    assert.equal(summaryText(form), expectedSummary, JSON.stringify(stored));
  }
});

test('mountLobby: default preferences leave the section closed', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage = memoryStorage({
    'gambit-create-game': JSON.stringify({
      time: '5+3', mode: 'rated', variant: 'standard', color: 'white',
      minRating: null, maxRating: null,
    }),
  });

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form')!;

  assert.equal(advancedRegion(form).hidden, true);
  assert.equal(summaryText(form), 'Standard · Any rating');
});

/** Malformed prefs fall back to defaults, which must not read as a hidden filter. */
test('mountLobby: malformed preferences leave no advanced state hidden', () => {
  for (const raw of ['not json', '{"time":"7+7","mode":"rated","variant":"atomic"}', '{"time":"10+0"}']) {
    const { doc } = createTestDoc();
    const { client } = makeFakeClient();
    const storage = memoryStorage({ 'gambit-create-game': raw });

    mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
    const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
      .querySelector('#create-game-form')!;

    assert.equal(advancedRegion(form).hidden, true, raw);
    assert.equal(summaryText(form), 'Standard · Any rating', raw);
    assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'standard', raw);
  }
});

/**
 * A seek posted with advanced settings must not come back looking default, or
 * the next Create seek quietly repeats a filter the player cannot see.
 */
test('mountLobby: reopening after an advanced create shows the settings it used', async () => {
  const { doc, elements } = createTestDoc();
  const { client, createdSeeks } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  moreToggle(form).click();
  selectRadio(form, 'cg-variant', 'atomic');
  form.querySelector<FakeDOMElement>('#cg-min-rating')!.value = '1200';
  form.querySelector<FakeDOMElement>('#cg-max-rating')!.value = '1800';
  moreToggle(form).click();

  submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdSeeks.length, 1);
  assert.equal(form.hidden, true);

  mount.querySelector('#create-seek')!.click();
  assert.equal(advancedRegion(form).hidden, false);
  assert.equal(moreToggle(form).getAttribute('aria-expanded'), 'true');
});

test('mountLobby: the disclosure leaves the time control alone', () => {
  const { doc, elements } = createTestDoc();
  const { client } = makeFakeClient();

  mountTestLobby({ doc, client, isAuthenticated: () => true });
  const mount = elements.get('create-game')!;
  mount.querySelector('#create-seek')!.click();
  const form = mount.querySelector('#create-game-form')!;
  const toggle = moreToggle(form);
  const summary = form.querySelector<FakeDOMElement>('.cg-time-summary')!;

  chooseTime(form, 'unlimited');
  const unlimitedText = summary.textContent;
  toggle.click();
  toggle.click();
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'unlimited');
  assert.equal(summary.textContent, unlimitedText);

  chooseTime(form, 'custom');
  form.querySelector<FakeDOMElement>('#cg-minutes')!.value = '7.5';
  form.querySelector<FakeDOMElement>('#cg-increment')!.value = '4';
  toggle.click();
  toggle.click();
  assert.equal(form.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'custom');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-minutes')?.value, '7.5');
  assert.equal(form.querySelector<FakeDOMElement>('#cg-increment')?.value, '4');
  assert.equal(form.querySelector<FakeDOMElement>('.cg-custom')?.hidden, false);
});

test('mountLobby: a valid V3 preset preference restores every choice', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const memoryStorage: Record<string, string> = {
    'gambit-create-game': JSON.stringify({
      time: '3+2', mode: 'rated', variant: 'horde', color: 'white',
    }),
  };
  const customStorage: KeyValueStorage = {
    getItem: (key: string): string | null => memoryStorage[key] ?? null,
    setItem: (key: string, value: string): void => { memoryStorage[key] = value; },
    removeItem: (key: string): void => { delete memoryStorage[key]; },
  };

  mountTestLobby({
    doc,
    client,
    isAuthenticated: () => true,
    storage: customStorage,
  });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '3+2');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'horde');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'white');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '');
});

test('mountLobby: a valid V4 preference restores its exact rating range', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage: KeyValueStorage = {
    getItem: () => JSON.stringify({
      time: '5+3', mode: 'rated', variant: 'atomic', color: 'black',
      minRating: 1500, maxRating: 1800,
    }),
    setItem: () => {},
    removeItem: () => {},
  };
  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });
  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-min-rating')?.value, '1500');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-max-rating')?.value, '1800');
});

test('mountLobby: a valid Custom preference restores its inputs and mode', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage: KeyValueStorage = {
    getItem: () => JSON.stringify({ time: 'custom', minutes: 12.5, increment: 7, mode: 'rated' }),
    setItem: () => {},
    removeItem: () => {},
  };

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, 'custom');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-minutes')?.value, '12.5');
  assert.equal(form?.querySelector<FakeDOMElement>('#cg-increment')?.value, '7');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'rated');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'standard');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'random');
});

test('mountLobby: stale storage falls back to 10+0 casual', () => {
  const { doc } = createTestDoc();
  const { client } = makeFakeClient();
  const storage: KeyValueStorage = {
    getItem: () => JSON.stringify({ time: '7+7', mode: 'rated' }),
    setItem: () => {},
    removeItem: () => {},
  };

  mountTestLobby({ doc, client, isAuthenticated: () => true, storage });

  const form = (doc.getElementById('create-game') as unknown as FakeDOMElement)
    .querySelector('#create-game-form');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-time"]:checked')?.value, '10+0');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-mode"]:checked')?.value, 'casual');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-variant"]:checked')?.value, 'standard');
  assert.equal(form?.querySelector<FakeDOMElement>('input[name="cg-color"]:checked')?.value, 'random');
});
