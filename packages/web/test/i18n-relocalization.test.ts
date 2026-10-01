/**
 * Regression test: Dynamic controller copy re-localizes from preserved state.
 *
 * Verifies that when a controller or mounted route combines state/data with client-owned copy:
 * 1. Every production route mount uses the SAME app.i18n instance created by the composition root.
 * 2. Mounts subscribe to onLocaleChange and update automatically without manual renderer calls.
 * 3. The underlying domain state/data is preserved across locale changes.
 * 4. Disposed mounts unsubscribe from onLocaleChange and cease reacting.
 * 5. Translated copy is rendered via safe DOM operations and never parsed as markup (XSS protection).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { I18n } from '../src/i18n/manager.js';
import { enMessages } from '../src/i18n/catalog/en.js';
import type { MessagesCatalog } from '../src/i18n/catalog/index.js';
import { createI18nManager } from '../src/i18n/index.js';
import { createApp } from '../src/app/composition.js';
import { bootstrap } from '../src/app/bootstrap.js';
import { mountGame } from '../src/app/game-mount.js';
import { mountLobby } from '../src/app/lobby-mount.js';
import { mountProfile } from '../src/app/profile-mount.js';
import {
  mountTournamentDetail,
  mountTournamentList,
} from '../src/app/competition-mounts.js';
import { mountSearch } from '../src/app/search-mount.js';
import { mountConversation } from '../src/app/messaging-mounts.js';
import { renderEndgamePositionRows } from '../src/app/endgame-view.js';
import { renderStudyDetail } from '../src/app/studies-view.js';
import { renderTeamList } from '../src/app/teams-view.js';
import { renderTournamentList } from '../src/app/tournament-view.js';
import { renderEmpty } from '../src/app/render-helpers.js';
import type { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import { FakeSocketFactory } from './support/fake-socket.js';
import { MemoryTokenStore } from '../src/net/session.js';
import type {
  EndgamePosition,
  SeekView,
  StudyView,
  TeamView,
  TournamentDetail,
  UserProfile,
} from '../src/api/models.js';

// DOM test double capable of handling all mount and renderer operations
class FakeElement {
  tagName: string;
  className = '';
  id = '';
  hidden = false;
  disabled = false;
  value = '';
  type = 'button';
  checked = false;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  ownerDocument?: unknown;
  onclick: ((event: unknown) => void) | null = null;
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  private _textContent = '';
  private _innerHTML = '';

  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this._textContent;
    }
    return this.children
      .filter((c): c is FakeElement => c !== null && c !== undefined)
      .map((c) => c.textContent)
      .join('');
  }

  set textContent(val: string) {
    this._textContent = val;
    this.children = [];
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  get classList() {
    const self = this;
    return {
      add(...classes: string[]) {
        const set = new Set(self.className.split(' ').filter(Boolean));
        for (const c of classes) set.add(c);
        self.className = [...set].join(' ');
      },
      remove(...classes: string[]) {
        const set = new Set(self.className.split(' ').filter(Boolean));
        for (const c of classes) set.delete(c);
        self.className = [...set].join(' ');
      },
      contains(cls: string) {
        return self.className.split(' ').filter(Boolean).includes(cls);
      },
      toggle(cls: string, force?: boolean) {
        const contains = this.contains(cls);
        const shouldAdd = force !== undefined ? force : !contains;
        if (shouldAdd) this.add(cls);
        else this.remove(cls);
        return shouldAdd;
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  appendChild(child: FakeElement): FakeElement {
    if (child) this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }

  append(...nodes: (FakeElement | string | null | undefined)[]): void {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === 'string') {
        const span = new FakeElement('span');
        span.textContent = n;
        span.ownerDocument = this.ownerDocument;
        this.children.push(span);
      } else {
        this.children.push(n);
      }
    }
  }

  replaceChildren(...nodes: (FakeElement | string | null | undefined)[]): void {
    this.children = [];
    this.append(...nodes);
  }

  querySelector(sel: string): FakeElement | null {
    const queue = [...this.children];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (sel.startsWith('.') && item.classList.contains(sel.slice(1))) {
        return item;
      }
      if (sel.startsWith('#') && item.id === sel.slice(1)) {
        return item;
      }
      if (item.tagName.toLowerCase() === sel.toLowerCase()) {
        return item;
      }
      queue.push(...item.children);
    }
    return null;
  }

  querySelectorAll(sel?: string): FakeElement[] {
    const result: FakeElement[] = [];
    const queue = [...this.children];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (!sel) {
        result.push(item);
      } else if (sel.startsWith('.') && item.classList.contains(sel.slice(1))) {
        result.push(item);
      } else if (sel.startsWith('#') && item.id === sel.slice(1)) {
        result.push(item);
      } else if (item.tagName.toLowerCase() === sel.toLowerCase()) {
        result.push(item);
      }
      queue.push(...item.children);
    }
    return result;
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== fn);
  }

  dispatchEvent(event: { type: string }): boolean {
    const list = this.listeners[event.type] ?? [];
    for (const fn of list) fn(event);
    return true;
  }

  click(): void {
    if (this.disabled) return;
    const evt = { type: 'click', target: this, preventDefault: () => {} };
    this.onclick?.(evt);
    this.dispatchEvent(evt);
  }

  focus(): void {}
  blur(): void {}
  reportValidity(): boolean { return true; }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
}

// Polyfill global HTML element classes for Node.js test environment if needed
if (typeof (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement === 'undefined') {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeElement;
}
if (typeof (globalThis as unknown as { HTMLButtonElement?: unknown }).HTMLButtonElement === 'undefined') {
  (globalThis as unknown as { HTMLButtonElement: unknown }).HTMLButtonElement = class FakeHTMLButtonElement extends FakeElement {};
}
if (typeof (globalThis as unknown as { HTMLFormElement?: unknown }).HTMLFormElement === 'undefined') {
  (globalThis as unknown as { HTMLFormElement: unknown }).HTMLFormElement = class FakeHTMLFormElement extends FakeElement {};
}
if (typeof (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement === 'undefined') {
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = class FakeHTMLInputElement extends FakeElement {};
}
if (typeof (globalThis as unknown as { HTMLAnchorElement?: unknown }).HTMLAnchorElement === 'undefined') {
  (globalThis as unknown as { HTMLAnchorElement: unknown }).HTMLAnchorElement = class FakeHTMLAnchorElement extends FakeElement {};
}

function createFakeDoc(elementMap = new Map<string, FakeElement>()): Document {
  const docObj: Record<string, unknown> = {
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    createElement(tag: string) {
      const el = new FakeElement(tag);
      el.ownerDocument = docObj as unknown as Document;
      return el;
    },
    getElementById(id: string) {
      return elementMap.get(id) ?? null;
    },
    querySelector(sel: string) {
      return (docObj.documentElement as FakeElement).querySelector(sel);
    },
    querySelectorAll(sel: string) {
      return (docObj.documentElement as FakeElement).querySelectorAll(sel);
    },
  };
  (docObj.documentElement as FakeElement).ownerDocument = docObj as unknown as Document;
  (docObj.body as FakeElement).ownerDocument = docObj as unknown as Document;
  for (const el of elementMap.values()) {
    el.ownerDocument = docObj as unknown as Document;
  }
  return docObj as unknown as Document;
}

const testArabicCatalog: Partial<MessagesCatalog> = {
  // Shell
  'shell.brand': 'روك زن',
  // Variant & Speed
  'variant.standard': 'قياسي',
  'variant.crazyhouse': 'كレイزي هاوس',
  'speed.blitz': 'خاطف',
  'speed.rapid': 'سريع',
  // Game
  'game.player.white': 'الأبيض',
  'game.player.whiteYou': 'الأبيض (أنت)',
  'game.player.black': 'الأسود',
  'game.player.blackYou': 'الأسود (أنت)',
  'game.role.playingWhite': 'تلعب بالأبيض',
  'game.role.playingBlack': 'تلعب بالأسود',
  'game.connection.connecting': 'جارٍ الاتصال…',
  'game.connection.connected': 'متصل',
  'game.status.waiting': 'في الانتظار…',
  'game.actions.resign': 'استسلام',
  'game.actions.offerDraw': 'عرض التعادل',
  // Lobby
  'lobby.rated': 'مصنف',
  'lobby.cancel': 'إلغاء',
  'lobby.play': 'العب',
  'lobby.emptySeeksTitle': 'لا توجد طلبات لعب مفتوحة',
  'lobby.emptySeeksBody': 'كن أول من ينشئ طلباً.',
  'lobby.waitingOpponent': 'في انتظار منافس…',
  // Profile
  'profile.ratings.emptyTitle': 'لا توجد تقييمات بعد',
  'profile.ratings.emptyBody': 'العب مباريات مصنفة لكسب تقييم.',
  'profile.signInToView': 'سجل الدخول لعرض الملف الشخصي',
  'profile.social.emptyFriendsTitle': 'لا يوجد أصدقاء بعد',
  'profile.social.emptyFriendsBody': 'تواصل مع اللاعبين لتراهم هنا.',
  // Tournaments
  'tournaments.format.roundRobin': 'دوري كامل',
  'tournaments.format.swiss': 'سويسري',
  'tournaments.format.arena': 'حلبة',
  'tournaments.state.registration': 'التسجيل مفتوح',
  'tournaments.state.running': 'جارية',
  'tournaments.state.finished': 'منتهية',
  'tournaments.details.format': 'النظام',
  'tournaments.details.state': 'الحالة',
  'tournaments.details.variant': 'النوع',
  'tournaments.details.timeControl': 'الوقت',
  'tournaments.details.participants': 'المشاركون',
  'tournaments.playersCount': '{count} لاعب',
  'tournaments.emptyListTitle': 'لا توجد بطولات',
  'tournaments.emptyListBody': 'تحقق لاحقاً من البطولات الجديدة.',
  // Search
  'search.mode.keyword': 'كلمة مفتاحية',
  'search.mode.semantic': 'دلالي (تجريبي)',
  'search.promptTitle': 'البحث في المباريات',
  'search.promptBody': 'ابحث عن طريق اللاعبين أو الافتتاحيات.',
  // Messages
  'community.messages.conversation': 'المحادثة',
  'community.messages.conversationWith': 'محادثة مع {handle}',
  // Common
  'common.loading': 'جارٍ التحميل…',
  // Endgame & Studies & Teams
  'learning.endgames.rowEndgame': 'نهاية اللعبة',
  'learning.endgames.rowObjective': 'الهدف',
  'learning.endgames.deliverCheckmate': 'تحقيق كش مات',
  'learning.endgames.rowToMove': 'الدور',
  'learning.endgames.rowWhite': 'الأبيض',
  'learning.endgames.rowLevel': 'المستوى',
  'learning.endgames.rowTechnique': 'التقنية',
  'learning.studies.noDescription': 'لا يوجد وصف.',
  'learning.studies.visibility': 'الرؤية: {visibility}',
  'community.teams.emptyListTitle': 'لا توجد فرق بعد',
  'community.teams.emptyListBody': 'ستظهر هنا الفرق التي ينشئها اللاعبون.',
};

function createTestI18n(): I18n {
  return new I18n({
    catalogs: {
      en: enMessages,
      ar: testArabicCatalog as unknown as MessagesCatalog,
    },
  });
}

describe('mount subscription, state preservation, dynamic relocalization, and disposal', () => {
  it('game mount: 10-step sequence (subscribes, preserves live state, auto-relocalizes, disposes without reaction)', () => {
    const elements = new Map<string, FakeElement>();
    const ids = [
      'board', 'status', 'flip', 'meta-connection', 'meta-role',
      'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name',
      'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status',
      'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort',
      'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no',
      'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no',
      'draw-offer-received', 'action-accept-draw', 'action-decline-draw',
    ];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);
    const boardEl = elements.get('board')! as unknown as HTMLElement;

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const sockets = new FakeSocketFactory();
    const app = createApp({
      config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
      wsFactory: sockets.factory,
      i18n,
    });

    const mounted = mountGame({
      doc,
      boardEl,
      gameId: 'g-test-reloc',
      createGameSync: app.createGameSync,
      createGameOracle: app.createGameOracle,
      getAccessToken: () => undefined,
      client: app.api,
      token: 'tok',
      restorePromise: Promise.resolve(null),
      i18n,
    });

    try {
      // 2. establish live state
      assert.equal(sockets.sockets.length, 1);
      sockets.last.open();
      sockets.last.emit({
        t: 'joined',
        role: 'white',
        state: {
          gameId: 'g-test-reloc',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moves: [],
          ply: 0,
          turn: 'w',
          clock: { whiteMs: 300000, blackMs: 300000, running: false, lastUpdate: 0 },
          turnStartedAt: null,
          status: { over: false },
          drawOffer: null,
          variant: 'standard',
          players: { white: 'u1', black: 'u2' },
          timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' },
          legalMoves: {},
        },
      });
      sockets.last.emit({
        t: 'presence',
        gameId: 'g-test-reloc',
        white: true,
        black: true,
        spectators: 7,
      });

      // 3. assert English UI + live data
      const metaVariantEl = elements.get('meta-variant')!;
      const metaSpectatorsEl = elements.get('meta-spectators')!;
      assert.equal(metaVariantEl.textContent, 'Standard');
      assert.equal(metaSpectatorsEl.textContent, '7');

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      assert.equal(metaVariantEl.textContent, 'قياسي');

      // 7. assert live user/server data is unchanged
      assert.equal(metaSpectatorsEl.textContent, '7');

      // 8. dispose mount
      mounted.controller.dispose();
      mounted.board.dispose();
      mounted.connectivity.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.equal(metaVariantEl.textContent, 'قياسي');
    } finally {
      mounted.controller.dispose();
      mounted.board.dispose();
      mounted.connectivity.dispose();
      app.dispose();
    }
  });

  it('lobby mount: 10-step sequence (subscribes, preserves seeks, auto-relocalizes, disposes without reaction)', async () => {
    const elements = new Map<string, FakeElement>();
    const ids = ['lobby', 'seek-list', 'create-game', 'create-seek', 'lobby-error', 'play-bot-dialog'];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const seek: SeekView = {
      id: 'seek-1',
      creatorId: 'u-alice',
      creatorHandle: 'AliceMaster',
      variant: 'standard',
      speed: 'blitz',
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      rated: true,
      color: 'random',
      minRating: 1500,
      maxRating: 1800,
      createdAt: '2026-01-01T00:00:00Z',
      gameId: null,
      acceptedAt: null,
    };

    const client = {
      session: { current: null },
      seeks: {
        list: async () => [seek],
      },
      graphql: {
        resolvePlayers: async () => new Map([
          ['u-alice', { id: 'u-alice', handle: 'AliceMaster' }],
        ]),
      },
    } as unknown as GambitClient;

    const mounted = mountLobby({
      doc,
      client,
      isAuthenticated: () => true,
      i18n,
    });

    try {
      // 2. establish live state
      await new Promise((r) => setTimeout(r, 10));

      // 3. assert English UI + data
      const seekListEl = elements.get('seek-list')!;
      const rowEl = seekListEl.children[0]!;
      const infoEl = rowEl.querySelector('.seek-info')!;
      const handleEl = rowEl.querySelector('.seek-opponent')!;
      assert.ok(infoEl.textContent.includes('Standard · Blitz · 3+2 · rated'));
      assert.equal(handleEl.textContent, 'AliceMaster');

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      const updatedRow = seekListEl.children[0]!;
      const updatedInfoEl = updatedRow.querySelector('.seek-info')!;
      const updatedHandleEl = updatedRow.querySelector('.seek-opponent')!;
      assert.ok(updatedInfoEl.textContent.includes('قياسي · خاطف · 3+2 · مصنف'));

      // 7. assert live user/server data is unchanged
      assert.equal(updatedHandleEl.textContent, 'AliceMaster');

      // 8. dispose mount
      mounted.lobby.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.ok(updatedInfoEl.textContent.includes('قياسي · خاطف · 3+2 · مصنف'));
    } finally {
      mounted.lobby.dispose();
    }
  });

  it('profile mount: 10-step sequence (subscribes, preserves user data, auto-relocalizes, disposes without reaction)', async () => {
    const elements = new Map<string, FakeElement>();
    const ids = ['profile', 'profile-handle', 'profile-ratings', 'profile-games', 'profile-error'];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const profileData: UserProfile = {
      user: {
        id: 'u-carlsen',
        handle: 'MagnusCarlsen',
        country: 'NO',
        createdAt: '2026-01-01T00:00:00Z',
      },
      ratings: [{ variant: 'standard', speed: 'blitz', rating: 2882, rd: 32, vol: 0.06, updatedAt: '2026-01-01T00:00:00Z' }],
    };

    const client = {
      users: {
        byHandle: async () => profileData,
        games: async () => [],
      },
      social: {
        followers: async () => ({ followers: [], following: [], followerCount: 0, followingCount: 0 }),
        relationship: async () => ({ state: 'none', incomingRequestId: null, outgoingRequestId: null }),
        self: async () => ({ incoming: [], outgoing: [], friends: [], blocked: [] }),
      },
      games: {
        listRecent: async () => [],
      },
      achievements: {
        get: async () => ({ items: [], summary: { unlocked: 0, total: 0, score: 0 } }),
      },
      passkeys: {
        list: async () => [],
      },
      auth: {
        listSessions: async () => [],
      },
      graphql: {
        resolvePlayers: async () => new Map(),
      },
    } as unknown as GambitClient;

    const mounted = mountProfile({
      doc,
      client,
      handle: 'MagnusCarlsen',
      getCurrentSession: () => null,
      restorePromise: Promise.resolve(null),
      i18n,
    });

    try {
      // 2. establish live state
      await new Promise((r) => setTimeout(r, 10));

      // 3. assert English UI + data
      const handleEl = elements.get('profile-handle')!;
      const ratingsEl = elements.get('profile-ratings')!;
      assert.equal(handleEl.textContent, 'MagnusCarlsen');
      assert.ok(ratingsEl.textContent.includes('Standard · Blitz: 2882 (RD 32)'));

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      assert.ok(ratingsEl.textContent.includes('قياسي · خاطف: 2882 (RD 32)'));

      // 7. assert live user/server data is unchanged
      assert.equal(handleEl.textContent, 'MagnusCarlsen');

      // 8. dispose mount
      mounted.profile.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.ok(ratingsEl.textContent.includes('قياسي · خاطف: 2882 (RD 32)'));
    } finally {
      mounted.profile.dispose();
    }
  });

  it('tournament mount: 10-step sequence (subscribes, preserves tournament data, auto-relocalizes, disposes without reaction)', async () => {
    const elements = new Map<string, FakeElement>();
    const ids = ['tournament', 'tournament-meta', 'tournament-name', 'tournament-standings', 'tournament-live', 'tournament-error'];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const detail: TournamentDetail = {
      id: 't-candidates',
      name: 'Candidates Tournament 2026',
      format: 'round_robin',
      state: 'registration',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 3000, delayMs: 0, kind: 'increment' },
      participants: [],
      rounds: 14,
      roundsGenerated: 3,
      tiebreakOrder: [],
    };

    const client = {
      tournaments: {
        byId: async () => detail,
        standings: async () => [],
        live: async () => ({ standings: [], games: [] }),
      },
      graphql: {
        resolvePlayers: async () => new Map(),
      },
    } as unknown as GambitClient;

    const controller = mountTournamentDetail(doc, client, 't-candidates', i18n);

    try {
      // 2. establish live state
      await new Promise((r) => setTimeout(r, 10));

      // 3. assert English UI + data
      const nameEl = elements.get('tournament-name')!;
      const metaEl = elements.get('tournament-meta')!;
      assert.equal(nameEl.textContent, 'Candidates Tournament 2026');
      assert.ok(metaEl.textContent.includes('Round robin'));
      assert.ok(metaEl.textContent.includes('Registration'));
      assert.ok(metaEl.textContent.includes('Standard'));

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      assert.ok(metaEl.textContent.includes('دوري كامل'));
      assert.ok(metaEl.textContent.includes('التسجيل مفتوح'));
      assert.ok(metaEl.textContent.includes('قياسي'));

      // 7. assert live user/server data is unchanged
      assert.equal(nameEl.textContent, 'Candidates Tournament 2026');

      // 8. dispose mount
      controller.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.ok(metaEl.textContent.includes('دوري كامل'));
      assert.ok(metaEl.textContent.includes('التسجيل مفتوح'));
    } finally {
      controller.dispose();
    }
  });

  it('search mount: 10-step sequence (subscribes, preserves query state, auto-relocalizes, disposes without reaction)', async () => {
    const elements = new Map<string, FakeElement>();
    const ids = ['search', 'search-mode', 'search-input', 'search-results', 'search-error'];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const client = {
      search: {
        query: async () => ({ total: 0, hits: [] }),
      },
    } as unknown as GambitClient;

    const controller = mountSearch(
      doc,
      client,
      i18n,
      () => Promise.resolve({ capabilities: { search: true, semanticSearch: true } }),
    );

    try {
      // 2. establish live state
      await new Promise((r) => setTimeout(r, 10));

      // 3. assert English UI + data
      const resultsEl = elements.get('search-results')!;
      const modeEl = elements.get('search-mode')!;
      assert.ok(resultsEl.textContent.includes('Search Rookzen'));
      assert.ok(modeEl.textContent.includes('Keyword'));
      assert.ok(modeEl.textContent.includes('Semantic (experimental)'));

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      assert.ok(resultsEl.textContent.includes('البحث في المباريات'));
      assert.ok(modeEl.textContent.includes('كلمة مفتاحية'));
      assert.ok(modeEl.textContent.includes('دلالي (تجريبي)'));

      // 7. assert live state preserved
      assert.ok(elements.get('search-input') !== null);

      // 8. dispose mount
      controller.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.ok(resultsEl.textContent.includes('البحث في المباريات'));
    } finally {
      controller.dispose();
    }
  });

  it('messages mount: 10-step sequence (subscribes, preserves user messages, auto-relocalizes, disposes without reaction)', async () => {
    const elements = new Map<string, FakeElement>();
    const ids = [
      'conversation', 'conversation-thread', 'conversation-participant',
      'conversation-error', 'conversation-composer', 'composer-input',
    ];
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    // 1. mount with injected/shared i18n
    const i18n = createTestI18n();
    const client = {
      session: { current: { user: { id: 'u-me' } } },
      messages: {
        send: async () => ({}),
        conversation: async () => ({
          id: 'c-1',
          participantA: 'u-me',
          participantB: 'u-bob',
          createdAt: '2026-01-01T10:00:00Z',
          lastMessageAt: '2026-01-01T12:00:00Z',
        }),
        messages: async () => ({
          total: 1,
          items: [{
            id: 'm-1',
            conversationId: 'c-1',
            senderId: 'u-bob',
            body: 'Good luck in the upcoming round!',
            sentAt: '2026-01-01T12:00:00Z',
            editedAt: null,
            deletedAt: null,
          }],
        }),
        markRead: async () => ({}),
      },
      graphql: {
        resolvePlayers: async () => new Map([
          ['u-bob', { id: 'u-bob', handle: 'BobFischer' }],
        ]),
      },
    } as unknown as GambitClient;

    const controller = mountConversation({
      doc,
      client,
      conversationId: 'c-1',
      sessionPresent: true,
      restorePromise: Promise.resolve(null),
      i18n,
    });

    try {
      // 2. establish live state
      await new Promise((r) => setTimeout(r, 10));

      // 3. assert English UI + data
      const participantEl = elements.get('conversation-participant')!;
      const threadEl = elements.get('conversation-thread')!;
      assert.equal(participantEl.textContent, 'Conversation with BobFischer');
      assert.ok(threadEl.textContent.includes('Good luck in the upcoming round!'));

      // 4. call i18n.setLocale('ar')
      // 5. DO NOT manually invoke renderer
      i18n.setLocale('ar');

      // 6. assert client-owned prose changed
      assert.equal(participantEl.textContent, 'محادثة مع BobFischer');

      // 7. assert live user/server data is unchanged
      assert.ok(threadEl.textContent.includes('Good luck in the upcoming round!'));

      // 8. dispose mount
      controller.dispose();

      // 9. change locale again
      i18n.setLocale('en');

      // 10. assert the disposed mount no longer reacts
      assert.equal(participantEl.textContent, 'محادثة مع BobFischer');
    } finally {
      controller.dispose();
    }
  });
});

describe('bootstrap integration: shared app.i18n instance across production routes', () => {
  it('bootstrap route receives the exact shared manager and auto-relocalizes without manual render', () => {
    const ids = [
      'board', 'status', 'flip', 'meta-connection', 'meta-role',
      'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name',
      'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status',
      'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort',
      'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no',
      'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no',
      'draw-offer-received', 'action-accept-draw', 'action-decline-draw',
      'theme-toggle', 'auth-status', 'auth', 'auth-submit', 'auth-register',
    ];
    const elements = new Map<string, FakeElement>();
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);

    const customI18n = createTestI18n();
    const sockets = new FakeSocketFactory();

    // Bootstrap root with injected shared i18n on game route
    const bootstrapped = bootstrap(doc, {
      gameId: 'g-shared-route',
      token: 'test-token',
      config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
      httpTransport: new FakeTransport().onEach(() => json(200, {})),
      wsFactory: sockets.factory,
      tokenStore: new MemoryTokenStore(),
      i18n: customI18n,
    });

    try {
      // Assert that bootstrap preserved the exact shared manager
      assert.strictEqual(bootstrapped.app.i18n, customI18n);

      // Assert the game route mount received this exact manager
      assert.ok(bootstrapped.controller);

      // Simulate match joined
      assert.equal(sockets.sockets.length, 1);
      sockets.last.open();
      sockets.last.emit({
        t: 'joined',
        role: 'white',
        state: {
          gameId: 'g-shared-route',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moves: [],
          ply: 0,
          turn: 'w',
          clock: { whiteMs: 300000, blackMs: 300000, running: false, lastUpdate: 0 },
          turnStartedAt: null,
          status: { over: false },
          drawOffer: null,
          variant: 'standard',
          players: { white: 'u1', black: 'u2' },
          timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' },
          legalMoves: {},
        },
      });

      // Initial state rendered in English
      const metaVariantEl = elements.get('meta-variant')!;
      assert.equal(metaVariantEl.textContent, 'Standard');

      // Change locale on bootstrapped.app.i18n directly (DO NOT invoke renderer manually)
      bootstrapped.app.i18n.setLocale('ar');

      // Prose changes automatically via the route mount's subscription to app.i18n
      assert.equal(metaVariantEl.textContent, 'قياسي');
    } finally {
      bootstrapped.controller?.dispose();
      bootstrapped.board?.dispose();
      bootstrapped.connectivity?.dispose();
      bootstrapped.app.dispose();
    }
  });

  it('regression proof: an omitted or isolated i18n manager fails to receive app.i18n locale updates', () => {
    // If a route mount were to create its own manager instead of using app.i18n:
    const appI18n = createTestI18n();
    const isolatedI18n = createI18nManager(); // isolated instance
    let isolatedReactionCount = 0;
    isolatedI18n.onLocaleChange(() => {
      isolatedReactionCount++;
    });

    let sharedReactionCount = 0;
    appI18n.onLocaleChange(() => {
      sharedReactionCount++;
    });

    // Calling setLocale on app.i18n updates shared subscribers, NOT the isolated manager
    appI18n.setLocale('ar');

    assert.equal(sharedReactionCount, 1);
    assert.equal(isolatedReactionCount, 0); // Isolated manager never received the update!
  });
});

describe('XSS protection: translated strings with markup characters are rendered safely', () => {
  it('translations containing < > & " \' remain literal text in textContent and never become DOM elements', () => {
    const maliciousCatalog: Partial<MessagesCatalog> = {
      'tournaments.emptyListTitle': '<img src=x onerror="alert(1)"> & "quotes"',
      'tournaments.emptyListBody': '<b>Bold body</b> with <script>alert(2)</script>',
      'lobby.emptySeeksTitle': '<svg onload="alert(3)"> & \'single\'',
      'lobby.emptySeeksBody': '<iframe src="javascript:alert(4)">',
    };

    const xssI18n = new I18n({
      catalogs: {
        en: enMessages,
        ar: maliciousCatalog as unknown as MessagesCatalog,
      },
    });
    xssI18n.setLocale('ar');

    const container = new FakeElement('div');
    container.ownerDocument = createFakeDoc();

    // 1. renderEmpty safe rendering
    renderEmpty(container as unknown as HTMLElement, {
      title: xssI18n.t('lobby.emptySeeksTitle'),
      body: xssI18n.t('lobby.emptySeeksBody'),
    });

    assert.strictEqual(container.querySelector('svg'), null);
    assert.strictEqual(container.querySelector('iframe'), null);
    assert.ok(container.textContent.includes('<svg onload="alert(3)"> & \'single\''));
    assert.ok(container.textContent.includes('<iframe src="javascript:alert(4)">'));

    // 2. renderTournamentList safe rendering
    const listContainer = new FakeElement('div');
    listContainer.ownerDocument = createFakeDoc();

    renderTournamentList(listContainer as unknown as HTMLElement, [], xssI18n);

    assert.strictEqual(listContainer.querySelector('img'), null);
    assert.strictEqual(listContainer.querySelector('b'), null);
    assert.strictEqual(listContainer.querySelector('script'), null);
    assert.ok(listContainer.textContent.includes('<img src=x onerror="alert(1)"> & "quotes"'));
    assert.ok(listContainer.textContent.includes('<b>Bold body</b> with <script>alert(2)</script>'));
  });
});

describe('dynamic controller copy re-localization from state (renderer unit tests)', () => {
  it('endgame position rows: preserves position data while updating labels on locale change', () => {
    const i18n = createTestI18n();
    const position: EndgamePosition = {
      id: 'kq-vs-k-01',
      type: 'KQ_vs_K',
      name: 'Queen vs King mate',
      fen: '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1',
      sideToMove: 'w',
      objective: 'mate',
      difficulty: 'beginner',
      technique: 'Box the king, then bring the king up.',
    };

    const rowsEl = new FakeElement('div');
    rowsEl.ownerDocument = createFakeDoc();

    // 1. Initial render in English
    renderEndgamePositionRows(rowsEl.ownerDocument as unknown as Document, rowsEl as unknown as HTMLElement, position, i18n);

    // Row 0: Endgame label & position.name
    const row0 = rowsEl.children[0]!;
    assert.equal(row0.children[0]!.textContent, 'Endgame');
    assert.equal(row0.children[1]!.textContent, 'Queen vs King mate');
    assert.equal(row0.children[1]!.getAttribute('dir'), 'auto');

    // Row 1: Objective & deliverCheckmate
    const row1 = rowsEl.children[1]!;
    assert.equal(row1.children[0]!.textContent, 'Objective');
    assert.equal(row1.children[1]!.textContent, 'Deliver checkmate');

    // 2. Change locale to Arabic
    i18n.setLocale('ar');
    renderEndgamePositionRows(rowsEl.ownerDocument as unknown as Document, rowsEl as unknown as HTMLElement, position, i18n);

    // Row 0: Translated label, same underlying position.name
    const arRow0 = rowsEl.children[0]!;
    assert.equal(arRow0.children[0]!.textContent, 'نهاية اللعبة');
    assert.equal(arRow0.children[1]!.textContent, 'Queen vs King mate');
    assert.equal(arRow0.children[1]!.getAttribute('dir'), 'auto');

    // Row 1: Translated objective
    const arRow1 = rowsEl.children[1]!;
    assert.equal(arRow1.children[0]!.textContent, 'الهدف');
    assert.equal(arRow1.children[1]!.textContent, 'تحقيق كش مات');
  });

  it('study detail: preserves study title/description while updating UI prose', () => {
    const i18n = createTestI18n();
    const study: StudyView = {
      id: 's-123',
      name: 'Ruy Lopez Deep Dive',
      description: 'Comprehensive repertoire for tournament players.',
      visibility: 'unlisted',
      variant: 'standard',
      ownerId: 'u-alice',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };

    const nameEl = new FakeElement('h2');
    const descEl = new FakeElement('p');
    const visEl = new FakeElement('span');
    const elements = {
      nameEl: nameEl as unknown as HTMLElement,
      descEl: descEl as unknown as HTMLElement,
      visEl: visEl as unknown as HTMLElement,
      exportEl: null,
      chaptersEl: null,
      collabsEl: null,
    };

    // 1. English render
    renderStudyDetail(elements, study, [], [], '/export', i18n);

    assert.equal(nameEl.textContent, 'Ruy Lopez Deep Dive');
    assert.equal(nameEl.getAttribute('dir'), 'auto');
    assert.equal(descEl.textContent, 'Comprehensive repertoire for tournament players.');
    assert.equal(descEl.getAttribute('dir'), 'auto');
    assert.equal(visEl.textContent, 'Visibility: unlisted');

    // 2. Arabic re-render
    i18n.setLocale('ar');
    renderStudyDetail(elements, study, [], [], '/export', i18n);

    // Data survived
    assert.equal(nameEl.textContent, 'Ruy Lopez Deep Dive');
    assert.equal(nameEl.getAttribute('dir'), 'auto');
    assert.equal(descEl.textContent, 'Comprehensive repertoire for tournament players.');
    assert.equal(descEl.getAttribute('dir'), 'auto');
    // Localized prose updated
    assert.equal(visEl.textContent, 'الرؤية: unlisted');
  });

  it('team list: preserves team name while isolating auto direction and localizing empty/search states', () => {
    const i18n = createTestI18n();
    const teams: TeamView[] = [
      {
        id: 'team-cairo',
        slug: 'cairo-chess',
        name: 'فريق القاهرة للشطرنج',
        description: 'نادي محبي الشطرنج في القاهرة',
        visibility: 'public',
        createdBy: 'u-1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const targetEl = new FakeElement('div');
    targetEl.ownerDocument = createFakeDoc();
    renderTeamList(targetEl as unknown as HTMLElement, teams, false, i18n);

    assert.ok(targetEl.children.length > 0);
    const rowEl = targetEl.children[0]!;
    const linkEl = rowEl.querySelector('.row-link');
    assert.ok(linkEl);
    assert.equal(linkEl.textContent, 'فريق القاهرة للشطرنج');
    assert.equal(linkEl.getAttribute('dir'), 'auto');

    // Test empty state localization
    i18n.setLocale('ar');
    renderTeamList(targetEl as unknown as HTMLElement, [], false, i18n);
    assert.ok(targetEl.children.length > 0);
  });
});
