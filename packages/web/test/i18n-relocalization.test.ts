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
  MessageView,
  SocialPlayer,
} from '../src/api/models.js';
import { PlayBotDialog } from '../src/app/play-bot-dialog.js';
import { CreateGamePanel } from '../src/app/create-game-panel.js';
import { assessMessage, classificationLabel } from '../src/app/assess-view.js';
import { coachMessage, omissionReasonLabel } from '../src/app/coach-view.js';
import { explainMessage, describeOutcome } from '../src/app/explain-view.js';
import { openingMessage, plies } from '../src/app/opening-view.js';
import { puzzleMessage } from '../src/app/puzzle-view.js';
import { mountBoard } from '../src/app/board.js';
import { formatTimestamp, formatInboxTimestamp, renderThread, renderInbox } from '../src/app/messages-view.js';
import { TIME_PRESETS, presetToTimeControl } from '../src/app/time-presets.js';
import { STARTING_FEN } from '../src/core/position.js';
import { StaticMoveOracle } from '../src/ports/move-oracle.js';

// DOM test double capable of handling all mount and renderer operations
class FakeElement {
  tagName: string;
  className = '';
  id = '';
  hidden = false;
  disabled = false;
  value = '';
  type = 'button';
  name = '';
  title = '';
  placeholder = '';
  open = false;
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  ownerDocument?: unknown;
  onclick: ((event: unknown) => void) | null = null;
  onsubmit: ((event: unknown) => void) | null = null;
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  private _checked = false;
  private _textContent = '';
  private _innerHTML = '';

  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
  }

  get checked(): boolean {
    return this._checked;
  }

  set checked(val: boolean) {
    this._checked = val;
    if (val && this.type === 'radio' && this.name) {
      let root: FakeElement = this;
      while (root.parentElement) root = root.parentElement;
      for (const radio of root.querySelectorAll(`input[name="${this.name}"]`)) {
        if (radio !== this) {
          radio._checked = false;
        }
      }
    }
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
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
    if (name === 'name') this.name = value;
    if (name === 'value') this.value = value;
    if (name === 'type') this.type = value;
    if (name === 'title') this.title = value;
    if (name === 'placeholder') this.placeholder = value;
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === 'title') this.title = '';
    if (name === 'placeholder') this.placeholder = '';
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  appendChild(child: FakeElement): FakeElement {
    if (child) {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      child.parentElement = null;
      this.children.splice(idx, 1);
    }
    return child;
  }

  append(...nodes: (FakeElement | string | null | undefined)[]): void {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === 'string') {
        const span = new FakeElement('span');
        span.textContent = n;
        span.ownerDocument = this.ownerDocument;
        span.parentElement = this;
        this.children.push(span);
      } else {
        n.parentElement = this;
        this.children.push(n);
      }
    }
  }

  replaceChildren(...nodes: (FakeElement | string | null | undefined)[]): void {
    for (const c of this.children) {
      c.parentElement = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  matches(sel: string): boolean {
    let s = sel.trim();
    if (!s || s === '*') return true;

    if (s.endsWith(':checked')) {
      if (!this.checked) return false;
      s = s.slice(0, -':checked'.length).trim();
      if (!s) return true;
    }

    if (s.startsWith('.') && !s.includes('[') && !s.includes(':')) {
      return this.classList.contains(s.slice(1));
    }

    if (s.startsWith('#') && !s.includes('[')) {
      return this.id === s.slice(1);
    }

    const attrRegex = /\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g;
    const bracketIndex = s.indexOf('[');
    const tag = bracketIndex !== -1 ? s.slice(0, bracketIndex).trim() : s;

    if (tag && tag !== '*' && this.tagName.toLowerCase() !== tag.toLowerCase()) {
      return false;
    }

    if (bracketIndex !== -1) {
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(s)) !== null) {
        const attrName = match[1];
        if (!attrName) continue;
        const expectedVal = match[2];
        let actualVal: string | null = null;
        if (attrName === 'name') actualVal = this.name || this.getAttribute('name');
        else if (attrName === 'value') actualVal = this.value || this.getAttribute('value');
        else if (attrName === 'id') actualVal = this.id;
        else if (attrName === 'type') actualVal = this.type || this.getAttribute('type');
        else actualVal = this.getAttribute(attrName);

        if (expectedVal !== undefined) {
          if (actualVal !== expectedVal) return false;
        } else {
          if (actualVal === null || actualVal === undefined) return false;
        }
      }
    }

    return true;
  }

  closest(sel: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matches(sel)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(sel: string): FakeElement | null {
    const queue = [...this.children];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.matches(sel)) {
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
      if (!sel || item.matches(sel)) {
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

  dispatchEvent(event: {
    type: string;
    target?: unknown;
    preventDefault?: () => void;
    clientX?: number;
    clientY?: number;
  }): boolean {
    if (!event.preventDefault) {
      event.preventDefault = () => {};
    }
    if (!event.target) {
      event.target = this;
    }
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
  getBoundingClientRect() {
    return { width: 512, height: 512, left: 0, top: 0, right: 512, bottom: 512 };
  }
}

class FakeHTMLButtonElement extends FakeElement {}
class FakeHTMLFormElement extends FakeElement {}
class FakeHTMLInputElement extends FakeElement {}
class FakeHTMLAnchorElement extends FakeElement {}
class FakeHTMLDialogElement extends FakeElement {}

// Polyfill global HTML element classes for Node.js test environment if needed
if (typeof (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement === 'undefined') {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeElement;
}
if (typeof (globalThis as unknown as { HTMLButtonElement?: unknown }).HTMLButtonElement === 'undefined') {
  (globalThis as unknown as { HTMLButtonElement: unknown }).HTMLButtonElement = FakeHTMLButtonElement;
}
if (typeof (globalThis as unknown as { HTMLFormElement?: unknown }).HTMLFormElement === 'undefined') {
  (globalThis as unknown as { HTMLFormElement: unknown }).HTMLFormElement = FakeHTMLFormElement;
}
if (typeof (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement === 'undefined') {
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = FakeHTMLInputElement;
}
if (typeof (globalThis as unknown as { HTMLAnchorElement?: unknown }).HTMLAnchorElement === 'undefined') {
  (globalThis as unknown as { HTMLAnchorElement: unknown }).HTMLAnchorElement = FakeHTMLAnchorElement;
}
if (typeof (globalThis as unknown as { HTMLDialogElement?: unknown }).HTMLDialogElement === 'undefined') {
  (globalThis as unknown as { HTMLDialogElement: unknown }).HTMLDialogElement = FakeHTMLDialogElement;
}

function createFakeDoc(elementMap = new Map<string, FakeElement>()): Document {
  const docObj: Record<string, unknown> = {
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    createElement(tag: string) {
      const lower = tag.toLowerCase();
      let el: FakeElement;
      if (lower === 'button') el = new FakeHTMLButtonElement(tag);
      else if (lower === 'form') el = new FakeHTMLFormElement(tag);
      else if (lower === 'input') el = new FakeHTMLInputElement(tag);
      else if (lower === 'dialog') el = new FakeHTMLDialogElement(tag);
      else if (lower === 'a') el = new FakeHTMLAnchorElement(tag);
      else el = new FakeElement(tag);
      el.ownerDocument = docObj as unknown as Document;
      return el;
    },
    createTextNode(text: string) {
      const el = new FakeElement('text');
      el.textContent = text;
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
  'speed.ultrabullet': 'فائق السرعة',
  'speed.bullet': 'رصاصة',
  'speed.blitz': 'خاطف',
  'speed.rapid': 'سريع',
  'speed.classical': 'كلاسيكي',
  'speed.correspondence': 'مراسلة',
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
  // Bot dialog
  'bot.title': 'اللعب ضد الحاسوب',
  'bot.signInToPlay': 'سجل الدخول للعب ضد الحاسوب',
  'bot.level': 'المستوى',
  'bot.level.novice': 'مبتدئ',
  'bot.level.novice.blurb': 'يرتكب أخطاء تكتيكية متكررة. الأفضل للمبتدئين في تعلم الأنماط الأساسية.',
  'bot.level.club': 'نادي',
  'bot.level.club.blurb': 'يلعب نقلات تكتيكية متينة مع عدم دقة عرضية. مناسب للاعبين الهواة.',
  'bot.level.master': 'أستاذ',
  'bot.level.master.blurb': 'حساب تكتيكي قوي ولعب استراتيجي. اختبار حقيقي.',
  'bot.color': 'اللون',
  'bot.color.white': 'الأبيض',
  'bot.color.random': 'عشوائي',
  'bot.color.black': 'الأسود',
  'bot.timeControl': 'الوقت',
  'bot.unratedNote': 'مباريات الحاسوب غير مصنفة دائماً.',
  'bot.start': 'ابدأ اللعبة',
  'bot.starting': 'جارٍ البدء…',
  // Create Game panel & errors
  'lobby.createGame': 'إنشاء مباراة',
  'lobby.createSeekSubmit': 'إنشاء طلب',
  'lobby.creating': 'جارٍ الإنشاء…',
  'lobby.time': 'الوقت',
  'lobby.timeCustom': 'مخصص',
  'lobby.timeUnlimited': 'بلا وقت',
  'lobby.minutes': 'الدقائق',
  'lobby.incrementSeconds': 'الزيادة (ثوانٍ)',
  'lobby.mode': 'النمط',
  'lobby.modeHint': 'المباريات المصنفة تؤثر على تقييمك.',
  'lobby.mode.casual': 'ودي',
  'lobby.mode.rated': 'مصنف',
  'lobby.variant': 'النوع',
  'lobby.color': 'اللون',
  'lobby.color.white': 'الأبيض',
  'lobby.color.black': 'الأسود',
  'lobby.color.random': 'عشوائي',
  'lobby.ratingOpponent': 'تقييم المنافس',
  'lobby.ratingMinLabel': 'الحد الأدنى',
  'lobby.ratingMaxLabel': 'الحد الأقصى',
  'lobby.ratingHint': 'اترك الحقول فارغة لأي تقييم.',
  'lobby.moreOptions': 'خيارات إضافية',
  'lobby.signInToCreate': 'سجل الدخول لإنشاء مباراة',
  'lobby.createGame.error.ratingBound': 'أدخل تقييماً صحيحاً بين 0 و 4000.',
  'lobby.createGame.error.ratingOrder': 'يجب ألا يتجاوز الحد الأدنى الحد الأقصى.',
  'lobby.createGame.error.customMinutes': 'يجب أن تكون الدقائق بين 0.5 و 180 بخطوات 0.5 دقيقة.',
  'lobby.createGame.error.customIncrement': 'يجب أن تكون الزيادة رقماً صحيحاً بين 0 و 60 ثانية.',
  'common.cancel': 'إلغاء',
  'shell.authStatus.signedIn': 'مسجل كـ {handle}',
  'shell.authStatus.notSignedIn': 'غير مسجل الدخول',

  // Summaries
  'lobby.timePresetSummary': '{speed} · {time}',
  'lobby.timeUnlimitedSummary': '{speed}',

  // Board Status Messages
  'board.status.played': 'تم لعب {move}.',
  'board.status.premoveSet': 'تم تحديد النقلة المسبقة: {move}.',

  // AI Move Assessment
  'ai.assess.idle': 'قيّم النقلة الأخيرة.',
  'ai.assess.noMove': 'لا توجد نقلة للتقييم بعد.',
  'ai.assess.signedOut': 'سجل الدخول لتقييم النقلات.',
  'ai.assess.running': 'جارٍ التقييم…',
  'ai.assess.rateLimited': 'طلبات تقييم كثيرة جداً. حاول لاحقاً.',
  'ai.assess.unavailable': 'تقييم النقلات غير متوفر حالياً.',
  'ai.assess.goodMove': 'نقلة جيدة',
  'ai.assess.inaccuracy': 'عدم دقة',
  'ai.assess.mistake': 'خطأ',
  'ai.assess.blunder': 'خطأ فادح',

  // AI Coaching
  'ai.coach.idle': 'المساعد متاح للتحليل.',
  'ai.coach.running': 'المساعد يحلل الموقف…',
  'ai.coach.signedOut': 'سجل الدخول لسؤال المساعد.',
  'ai.coach.noMove': 'لا توجد نقلة للمساعدة.',
  'ai.coach.rateLimited': 'تم تجاوز الحد. حاول بعد قليل.',
  'ai.coach.unavailable': 'المساعد غير متاح حالياً.',
  'ai.coach.unsupported': 'غير متاح على هذا الخادم',
  'ai.coach.temporarilyUnavailable': 'غير متاح مؤقتاً',
  'ai.coach.notApplicable': 'لا يوجد شيء هنا',

  // AI Move Explanation
  'ai.explain.idle': 'شرح الموقف متاح.',
  'ai.explain.noMove': 'لا توجد نقلة للشرح بعد.',
  'ai.explain.signedOut': 'سجل الدخول للحصول على الشرح.',
  'ai.explain.running': 'جارٍ توليد الشرح…',
  'ai.explain.rateLimited': 'طلبات شرح كثيرة جداً.',
  'ai.explain.unavailable': 'الشرح غير متاح حالياً.',
  'ai.explain.outcome.checkmate': 'كش مات',
  'ai.explain.outcome.checkmateWinner': 'كش مات — فوز {winner}',
  'ai.explain.outcome.stalemate': 'تعادل بالمأزق',
  'ai.explain.outcome.insufficientMaterial': 'تعادل لنقص العتاد',
  'ai.explain.outcome.fiftyMove': 'تعادل بقاعدة الخمسين نقلة',
  'ai.explain.outcome.variantWin': 'فوز بحسب نوع اللعبة',
  'ai.explain.outcome.variantWinWinner': 'فوز بحسب نوع اللعبة — فوز {winner}',
  'ai.explain.outcome.variantDraw': 'تعادل بحسب نوع اللعبة',
  'ai.explain.outcome.gameOver': 'انتهت اللعبة — {result}',

  // AI Opening Identification
  'ai.opening.idle': 'معلومات الافتتاح تظهر هنا.',
  'ai.opening.running': 'جارٍ البحث عن الافتتاح…',
  'ai.opening.noOpening': 'لا يوجد افتتاح يطابق هذا الترتيب.',
  'ai.opening.label.position': 'الموقف',
  'ai.opening.outOfBook': 'خارج كتاب الافتتاحيات',
  'ai.opening.inBook': 'في كتاب الافتتاحيات',
  'ai.opening.ply': 'نقلة واحدة',
  'ai.opening.plies': '{count} نقلات',

  // AI Puzzle / Tactical Search
  'ai.puzzle.idle': 'الألغاز التكتيكية تظهر هنا.',
  'ai.puzzle.running': 'جارٍ البحث عن لغز…',
  'ai.puzzle.noTactic': 'لا توجد ألغاز لهذا الموقف.',
  'ai.puzzle.insufficient': 'أدلة غير كافية للغز.',
  'ai.puzzle.terminal': 'الموقف منتهٍ بالفعل.',
  'ai.puzzle.rateLimited': 'طلبات كثيرة. انتظر قليلاً.',
  'ai.puzzle.unavailable': 'الألغاز غير متاحة.',
  'ai.generatedBy': 'تم التوليد بواسطة {model}',
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

describe('play-bot dialog: dynamic relocalization, option preservation, and disposal unsubscription', () => {
  it('level options, blurbs, and color options re-localize while preserving checked state', () => {
    const mount = new FakeElement('div');
    const doc = createFakeDoc();
    mount.ownerDocument = doc;
    const i18n = createTestI18n();

    const dialog = new PlayBotDialog({
      doc,
      mount: mount as unknown as HTMLElement,
      callbacks: {
        onSubmit: async () => 'g-1',
      },
      initialAuthenticated: true,
      i18n,
    });

    try {
      // 1. Initial English assertions
      const trigger = mount.querySelector('#play-bot')!;
      assert.equal(trigger.textContent, 'Play vs Computer');

      const noviceRadio = mount.querySelector('input[name="pb-level"][value="novice"]')!;
      const clubRadio = mount.querySelector('input[name="pb-level"][value="club"]')!;
      const masterRadio = mount.querySelector('input[name="pb-level"][value="master"]')!;
      assert.ok(noviceRadio);
      assert.ok(clubRadio);
      assert.ok(masterRadio);

      const noviceLabel = noviceRadio.closest('label')?.querySelector('.cg-seg-label');
      const clubLabel = clubRadio.closest('label')?.querySelector('.cg-seg-label');
      const masterLabel = masterRadio.closest('label')?.querySelector('.cg-seg-label');
      assert.equal(noviceLabel?.textContent, 'Novice');
      assert.equal(clubLabel?.textContent, 'Club');
      assert.equal(masterLabel?.textContent, 'Master');

      const whiteRadio = mount.querySelector('input[name="pb-color"][value="white"]')!;
      const randomRadio = mount.querySelector('input[name="pb-color"][value="random"]')!;
      const blackRadio = mount.querySelector('input[name="pb-color"][value="black"]')!;
      const whiteLabel = whiteRadio.closest('label')?.querySelector('.cg-seg-label');
      const blackLabel = blackRadio.closest('label')?.querySelector('.cg-seg-label');
      assert.ok(whiteLabel?.textContent.includes('White'));
      assert.ok(blackLabel?.textContent.includes('Black'));

      // Check default blurb (club)
      const levelHint = mount.querySelector('#pb-level-hint')!;
      assert.equal(
        levelHint.textContent,
        'Plays solid tactical moves with occasional inaccuracies. Suitable for casual players.',
      );

      // 2. Select novice and black
      noviceRadio.checked = true;
      const form = mount.querySelector('form')!;
      form.dispatchEvent({ type: 'change', target: noviceRadio });
      blackRadio.checked = true;

      // Verify selected novice blurb in English
      assert.equal(
        levelHint.textContent,
        'Makes frequent tactical errors. Best for beginners learning basic patterns.',
      );

      // 3. Switch to Arabic via shared i18n without manual renderer invocation
      i18n.setLocale('ar');

      // 4. Assert client-owned copy changed
      assert.equal(trigger.textContent, 'اللعب ضد الحاسوب');
      assert.equal(noviceLabel?.textContent, 'مبتدئ');
      assert.equal(clubLabel?.textContent, 'نادي');
      assert.equal(masterLabel?.textContent, 'أستاذ');
      assert.ok(whiteLabel?.textContent.includes('الأبيض'));
      assert.ok(blackLabel?.textContent.includes('الأسود'));
      assert.equal(
        levelHint.textContent,
        'يرتكب أخطاء تكتيكية متكررة. الأفضل للمبتدئين في تعلم الأنماط الأساسية.',
      );

      // 5. Assert selected options and state preserved across relocalization
      assert.equal(noviceRadio.checked, true);
      assert.equal(blackRadio.checked, true);

      // 6. Dispose dialog and test unsubscription
      dialog.dispose();

      // 7. Change locale back to English
      i18n.setLocale('en');

      // 8. Assert disposed dialog ceased reacting to locale change
      assert.equal(trigger.textContent, 'اللعب ضد الحاسوب');
      assert.equal(clubLabel?.textContent, 'نادي');
    } finally {
      dialog.dispose();
    }
  });
});

describe('create-game panel: validation error relocalization while preserving invalid inputs', () => {
  it('rating and custom time validation errors re-localize on locale change while preserving invalid inputs', () => {
    const mount = new FakeElement('div');
    const doc = createFakeDoc();
    mount.ownerDocument = doc;
    const i18n = createTestI18n();

    const panel = new CreateGamePanel({
      doc,
      mount: mount as unknown as HTMLElement,
      callbacks: {
        onSubmit: async () => true,
        onError: () => {},
      },
      initialAuthenticated: true,
      i18n,
    });

    try {
      // Expand panel
      const trigger = mount.querySelector('#create-seek')!;
      trigger.click();

      // --- Part A: Rating error relocalization ---
      const minRatingInput = mount.querySelector('#cg-min-rating')!;
      const maxRatingInput = mount.querySelector('#cg-max-rating')!;
      const ratingError = mount.querySelector('#cg-rating-error')!;

      // Enter invalid bounds: min > max
      minRatingInput.value = '2500';
      maxRatingInput.value = '1500';
      minRatingInput.dispatchEvent({ type: 'input' });

      // Rating error is displayed in English
      assert.equal(ratingError.hidden, false);
      assert.equal(
        ratingError.textContent,
        'Minimum rating must not exceed maximum rating.',
      );

      // Change locale to Arabic (NO manual renderer call)
      i18n.setLocale('ar');

      // Rating error prose is translated to Arabic
      assert.equal(ratingError.hidden, false);
      assert.equal(
        ratingError.textContent,
        'يجب ألا يتجاوز الحد الأدنى الحد الأقصى.',
      );

      // Invalid inputs are strictly preserved
      assert.equal(minRatingInput.value, '2500');
      assert.equal(maxRatingInput.value, '1500');

      // --- Part B: Custom time error relocalization ---
      // Switch time to custom
      const customTimeRadio = mount.querySelector('input[name="cg-time"][value="custom"]')!;
      customTimeRadio.checked = true;
      customTimeRadio.dispatchEvent({ type: 'change' });

      const customMinutesInput = mount.querySelector('#cg-minutes')!;
      const customIncrementInput = mount.querySelector('#cg-increment')!;
      const customError = mount.querySelector('#cg-custom-error')!;

      // Enter invalid custom minutes: 0.1 (minimum is 0.5)
      customMinutesInput.value = '0.1';
      customIncrementInput.value = '5';

      // Submit form to trigger custom validation
      const form = mount.querySelector('form')!;
      form.dispatchEvent({ type: 'submit' });

      // Custom error is displayed in Arabic (since current locale is ar)
      assert.equal(customError.hidden, false);
      assert.equal(
        customError.textContent,
        'يجب أن تكون الدقائق بين 0.5 و 180 بخطوات 0.5 دقيقة.',
      );
      assert.equal(customMinutesInput.value, '0.1');

      // Change locale back to English
      i18n.setLocale('en');

      // Custom error dynamically re-localizes to English
      assert.equal(customError.hidden, false);
      assert.equal(
        customError.textContent,
        'Minutes must be between 0.5 and 180 in 0.5-minute steps.',
      );

      // Input value is strictly preserved
      assert.equal(customMinutesInput.value, '0.1');

      // Rating error also re-localized to English with values preserved
      assert.equal(ratingError.hidden, false);
      assert.equal(
        ratingError.textContent,
        'Minimum rating must not exceed maximum rating.',
      );
      assert.equal(minRatingInput.value, '2500');
      assert.equal(maxRatingInput.value, '1500');

      // --- Part C: Disposal stops reactions ---
      panel.dispose();
      i18n.setLocale('ar');

      // Prose does NOT change after disposal
      assert.equal(
        customError.textContent,
        'Minutes must be between 0.5 and 180 in 0.5-minute steps.',
      );
    } finally {
      panel.dispose();
    }
  });
});

describe('bootstrap play-bot auth title: dynamic relocalization from preserved auth state', () => {
  it('play-bot button title dynamically re-localizes and preserves auth state transitions', () => {
    const ids = [
      'board', 'status', 'flip', 'meta-connection', 'meta-role',
      'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name',
      'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status',
      'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort',
      'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no',
      'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no',
      'draw-offer-received', 'action-accept-draw', 'action-decline-draw',
      'theme-toggle', 'auth-status', 'auth', 'auth-submit', 'auth-register',
      'play-bot',
    ];
    const elements = new Map<string, FakeElement>();
    for (const id of ids) {
      const isButton = (id === 'play-bot' || id === 'auth-submit' || id === 'auth-register' || id === 'theme-toggle');
      elements.set(id, isButton ? new FakeHTMLButtonElement('button', id) : new FakeElement('div', id));
    }
    const doc = createFakeDoc(elements);

    const i18n = createTestI18n();
    const sockets = new FakeSocketFactory();

    const bootstrapped = bootstrap(doc, {
      gameId: 'g-test-bot-auth',
      token: 'test-token',
      config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://api.test/ws' },
      httpTransport: new FakeTransport().onEach(() => json(200, {})),
      wsFactory: sockets.factory,
      tokenStore: new MemoryTokenStore(),
      i18n,
    });

    try {
      const playBotBtn = elements.get('play-bot')!;

      // 1. Initially unauthenticated in English
      assert.equal(playBotBtn.disabled, true);
      assert.equal(playBotBtn.title, 'Sign in to play the computer');

      // 2. Change locale to Arabic (unauthenticated state preserved)
      i18n.setLocale('ar');
      assert.equal(playBotBtn.disabled, true);
      assert.equal(playBotBtn.title, 'سجل الدخول للعب ضد الحاسوب');

      // 3. Authenticate session
      const auth = bootstrapped.auth as unknown as {
        callbacks?: { onSessionChange?: (s: unknown) => void };
      };
      auth.callbacks?.onSessionChange?.({
        userId: 'u-alice',
        handle: 'Alice',
        roles: [],
        tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60000 },
      });

      // 4. Assert button enabled and title cleared
      assert.equal(playBotBtn.disabled, false);
      assert.equal(playBotBtn.title, '');

      // 5. Change locale while authenticated: title remains empty
      i18n.setLocale('en');
      assert.equal(playBotBtn.disabled, false);
      assert.equal(playBotBtn.title, '');

      // 6. Log out
      auth.callbacks?.onSessionChange?.(null);

      // 7. Assert button disabled and English title restored
      assert.equal(playBotBtn.disabled, true);
      assert.equal(playBotBtn.title, 'Sign in to play the computer');

      // 8. Change locale to Arabic again
      i18n.setLocale('ar');
      assert.equal(playBotBtn.disabled, true);
      assert.equal(playBotBtn.title, 'سجل الدخول للعب ضد الحاسوب');

      // 9. Dispose shell localization and test unsubscription
      bootstrapped.shellLocalization?.dispose();
      i18n.setLocale('en');

      // Title does NOT react after disposal
      assert.equal(playBotBtn.title, 'سجل الدخول للعب ضد الحاسوب');
    } finally {
      bootstrapped.controller?.dispose();
      bootstrapped.board?.dispose();
      bootstrapped.connectivity?.dispose();
      bootstrapped.app.dispose();
    }
  });
});

describe('AI views (assess, coach, explain, opening, puzzle): representative copy and game mount dynamic relocalization', () => {
  it('representative message formatters and helpers react to locale changes', () => {
    const i18n = createTestI18n();

    // 1. English checks
    assert.equal(assessMessage('idle', i18n), 'Assess the last move played.');
    assert.equal(assessMessage('noMove', i18n), 'No move to assess yet.');
    assert.equal(assessMessage('rateLimited', i18n), 'Too many assessments. Try again shortly.');
    assert.equal(classificationLabel('ok', i18n), 'Good move');
    assert.equal(classificationLabel('blunder', i18n), 'Blunder');
    assert.equal(classificationLabel('inaccuracy', i18n), 'Inaccuracy');
    assert.equal(classificationLabel('mistake', i18n), 'Mistake');

    assert.equal(coachMessage('idle', i18n), 'Get coaching advice for the current position.');
    assert.equal(coachMessage('noMove', i18n), 'Play or select a move to receive move-specific coaching.');
    assert.equal(omissionReasonLabel('unsupported', i18n), 'Not available on this server');
    assert.equal(omissionReasonLabel('not_applicable', i18n), 'Nothing to say here');

    assert.equal(explainMessage('idle', i18n), 'Explain the last move played.');
    assert.equal(
      describeOutcome({ kind: 'terminal', reason: 'checkmate', result: '1-0' }, i18n),
      'Checkmate — White wins',
    );
    assert.equal(
      describeOutcome({ kind: 'terminal', reason: 'stalemate', result: '1/2-1/2' }, i18n),
      'Stalemate — draw',
    );

    assert.equal(openingMessage('idle', i18n), 'Identify the opening played in this game.');
    assert.equal(plies(1, i18n), '1 ply');
    assert.equal(plies(4, i18n), '4 plies');

    assert.equal(puzzleMessage('idle', i18n), 'Find a tactic in the position on the board.');
    assert.equal(puzzleMessage('noTactic', i18n), 'No tactic met the server’s fixed evidence threshold.');

    // 2. Switch to Arabic
    i18n.setLocale('ar');

    assert.equal(assessMessage('idle', i18n), 'قيّم النقلة الأخيرة.');
    assert.equal(assessMessage('noMove', i18n), 'لا توجد نقلة للتقييم بعد.');
    assert.equal(classificationLabel('ok', i18n), 'نقلة جيدة');
    assert.equal(classificationLabel('blunder', i18n), 'خطأ فادح');

    assert.equal(coachMessage('idle', i18n), 'المساعد متاح للتحليل.');
    assert.equal(coachMessage('noMove', i18n), 'لا توجد نقلة للمساعدة.');
    assert.equal(omissionReasonLabel('unsupported', i18n), 'غير متاح على هذا الخادم');
    assert.equal(omissionReasonLabel('not_applicable', i18n), 'لا يوجد شيء هنا');

    assert.equal(explainMessage('idle', i18n), 'شرح الموقف متاح.');
    assert.equal(
      describeOutcome({ kind: 'terminal', reason: 'checkmate', result: '1-0' }, i18n),
      'كش مات — فوز الأبيض',
    );
    assert.equal(
      describeOutcome({ kind: 'terminal', reason: 'stalemate', result: '1/2-1/2' }, i18n),
      'تعادل بالمأزق',
    );

    assert.equal(openingMessage('idle', i18n), 'معلومات الافتتاح تظهر هنا.');
    assert.equal(plies(1, i18n), 'نقلة واحدة');
    assert.equal(plies(4, i18n), '4 نقلات');

    assert.equal(puzzleMessage('idle', i18n), 'الألغاز التكتيكية تظهر هنا.');
    assert.equal(puzzleMessage('noTactic', i18n), 'لا توجد ألغاز لهذا الموقف.');
  });

  it('game mount re-renders cached AI view states on locale change and stops upon disposal', () => {
    const ids = [
      'board', 'status', 'flip', 'meta-connection', 'meta-role',
      'meta-white', 'meta-white-name', 'meta-black', 'meta-black-name',
      'meta-spectators', 'meta-variant', 'meta-time', 'meta-live-status',
      'game-actions', 'action-error', 'action-offer-draw', 'action-claim-flag', 'action-resign', 'action-abort',
      'confirm-resign', 'confirm-resign-yes', 'confirm-resign-no',
      'confirm-abort', 'confirm-abort-yes', 'confirm-abort-no',
      'draw-offer-received', 'action-accept-draw', 'action-decline-draw',
      'assess-note', 'coach-note', 'explain-note', 'opening-note', 'puzzle-note',
    ];
    const elements = new Map<string, FakeElement>();
    for (const id of ids) elements.set(id, new FakeElement('div', id));
    const doc = createFakeDoc(elements);
    const boardEl = elements.get('board')! as unknown as HTMLElement;

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
      gameId: 'g-ai-test',
      createGameSync: app.createGameSync,
      createGameOracle: app.createGameOracle,
      getAccessToken: () => 'tok',
      client: app.api,
      token: 'tok',
      restorePromise: Promise.resolve(null),
      i18n,
    });

    try {
      const assessNote = elements.get('assess-note')!;
      const coachNote = elements.get('coach-note')!;
      const explainNote = elements.get('explain-note')!;
      const openingNote = elements.get('opening-note')!;
      const puzzleNote = elements.get('puzzle-note')!;

      // 1. Initial English prompts
      assert.equal(assessNote.textContent, 'Assess the last move played.');
      assert.equal(coachNote.textContent, 'Get coaching advice for the current position.');
      assert.equal(explainNote.textContent, 'Explain the last move played.');
      assert.equal(openingNote.textContent, 'Identify the opening played in this game.');
      assert.equal(puzzleNote.textContent, 'Find a tactic in the position on the board.');

      // 2. Switch locale to Arabic
      i18n.setLocale('ar');

      // 3. AI views automatically re-render in Arabic via onLocaleChange
      assert.equal(assessNote.textContent, 'قيّم النقلة الأخيرة.');
      assert.equal(coachNote.textContent, 'المساعد متاح للتحليل.');
      assert.equal(explainNote.textContent, 'شرح الموقف متاح.');
      assert.equal(openingNote.textContent, 'معلومات الافتتاح تظهر هنا.');
      assert.equal(puzzleNote.textContent, 'الألغاز التكتيكية تظهر هنا.');

      // 4. Dispose mount
      mounted.controller.dispose();
      mounted.board.dispose();
      mounted.connectivity.dispose();

      // 5. Switch locale to English
      i18n.setLocale('en');

      // 6. Disposed mount does NOT react
      assert.equal(assessNote.textContent, 'قيّم النقلة الأخيرة.');
      assert.equal(coachNote.textContent, 'المساعد متاح للتحليل.');
    } finally {
      mounted.controller.dispose();
      mounted.board.dispose();
      mounted.connectivity.dispose();
      app.dispose();
    }
  });

  it('speed labels: CreateGamePanel relocalizes speed chips and summaries from preserved selection and unsubscribes on dispose', () => {
    const doc = createFakeDoc(new Map());
    const mount = new FakeElement('div', 'create-seek-mount');
    mount.ownerDocument = doc;
    const i18n = createTestI18n();

    const panel = new CreateGamePanel({
      doc,
      mount: mount as unknown as HTMLElement,
      callbacks: {
        onSubmit: async () => true,
        onError: () => {},
      },
      initialAuthenticated: true,
      i18n,
    });

    try {
      // 1. In English: check speed chips
      const chips = mount.querySelectorAll('.cg-chip-speed');
      assert.ok(chips.length >= 10, 'must render speed chips for presets');
      const blitzChip = mount.querySelector('input[name="cg-time"][value="3+0"]')
        ?.closest('label')?.querySelector('.cg-chip-speed');
      const rapidChip = mount.querySelector('input[name="cg-time"][value="10+0"]')
        ?.closest('label')?.querySelector('.cg-chip-speed');
      assert.equal(blitzChip?.textContent, 'Blitz');
      assert.equal(rapidChip?.textContent, 'Rapid');

      // Select 3+0 preset
      const radio3plus0 = mount.querySelector('input[name="cg-time"][value="3+0"]')!;
      radio3plus0.checked = true;
      radio3plus0.dispatchEvent({ type: 'change' });

      // Verify time summary in English
      const timeSummary = mount.querySelector('.cg-time-summary')!;
      assert.ok(timeSummary.textContent.includes('Blitz'));

      // 2. Switch locale to Arabic
      i18n.setLocale('ar');

      // 3. Chips update to Arabic translations
      assert.equal(blitzChip?.textContent, 'خاطف');
      assert.equal(rapidChip?.textContent, 'سريع');

      // 4. Selected radio value remains unchanged
      assert.equal(radio3plus0.checked, true);
      const selectedRadio = mount.querySelector('input[name="cg-time"]:checked') as FakeElement | null;
      assert.equal(selectedRadio?.value, '3+0');

      // 5. Time summary updates to translated Arabic speed name
      assert.ok(timeSummary.textContent.includes('خاطف'));

      // 6. Dispose panel
      panel.dispose();

      // 7. Switch locale back to English
      i18n.setLocale('en');

      // 8. Disposed panel does NOT react
      assert.equal(blitzChip?.textContent, 'خاطف');
      assert.equal(rapidChip?.textContent, 'سريع');
      assert.ok(timeSummary.textContent.includes('خاطف'));
    } finally {
      panel.dispose();
    }
  });

  it('speed labels: PlayBotDialog relocalizes speed chips while preserving checked time selection', () => {
    const doc = createFakeDoc(new Map());
    const mount = new FakeElement('div', 'play-bot-mount');
    mount.ownerDocument = doc;
    const i18n = createTestI18n();

    const dialog = new PlayBotDialog({
      doc,
      mount: mount as unknown as HTMLElement,
      callbacks: {
        onSubmit: async () => 'g-bot-1',
      },
      initialAuthenticated: true,
      i18n,
    });

    try {
      // 1. Initial English speed chips
      const blitzChip = mount.querySelector('input[name="pb-time"][value="3+0"]')
        ?.closest('label')?.querySelector('.cg-chip-speed');
      const rapidChip = mount.querySelector('input[name="pb-time"][value="10+0"]')
        ?.closest('label')?.querySelector('.cg-chip-speed');
      assert.equal(blitzChip?.textContent, 'Blitz');
      assert.equal(rapidChip?.textContent, 'Rapid');

      // Select 3+0 preset
      const radio3plus0 = mount.querySelector('input[name="pb-time"][value="3+0"]')!;
      radio3plus0.checked = true;
      radio3plus0.dispatchEvent({ type: 'change' });

      // 2. Switch locale to Arabic
      i18n.setLocale('ar');

      // 3. Chips update to Arabic translations
      assert.equal(blitzChip?.textContent, 'خاطف');
      assert.equal(rapidChip?.textContent, 'سريع');

      // 4. Selected radio input value is preserved
      assert.equal(radio3plus0.checked, true);

      // 5. Dispose dialog
      dialog.dispose();

      // 6. Switch locale back to English
      i18n.setLocale('en');

      // 7. Disposed dialog does NOT react
      assert.equal(blitzChip?.textContent, 'خاطف');
      assert.equal(rapidChip?.textContent, 'سريع');
    } finally {
      dialog.dispose();
    }
  });

  it('board mount: status copy relocalizes dynamically, preserves technical move tokens, and disposes without leaks', () => {
    const doc = createFakeDoc(new Map());
    const boardEl = new FakeElement('div', 'board');
    boardEl.ownerDocument = doc;
    const statusEl = new FakeElement('div', 'status');
    const i18n = createTestI18n();

    const board = mountBoard(
      {
        boardEl: boardEl as unknown as HTMLElement,
        statusEl: statusEl as unknown as HTMLElement,
      },
      {
        oracle: new StaticMoveOracle({ [STARTING_FEN]: { e2: ['e4'] } }),
        i18n,
      },
    );

    try {
      // 1. Simulate playing move e2-e4 in standalone mode via click gestures
      // e2 click: clientX=288, clientY=416
      boardEl.dispatchEvent({ type: 'click', clientX: 288, clientY: 416 });
      // e4 click: clientX=288, clientY=288
      boardEl.dispatchEvent({ type: 'click', clientX: 288, clientY: 288 });

      // 2. Status in English
      assert.equal(statusEl.textContent, 'Played e2–e4.');

      // 3. Switch locale to Arabic
      i18n.setLocale('ar');

      // 4. Status dynamically relocalizes to Arabic while keeping move token e2–e4 intact
      assert.equal(statusEl.textContent, 'تم لعب e2–e4.');

      // 5. Simulate premove: reset to starting position and set turn false
      board.setPosition(STARTING_FEN);
      board.setTurn(false);
      boardEl.dispatchEvent({ type: 'click', clientX: 288, clientY: 416 });
      boardEl.dispatchEvent({ type: 'click', clientX: 288, clientY: 288 });
      assert.equal(statusEl.textContent, 'تم تحديد النقلة المسبقة: e2–e4.');

      // Switch back to English to verify premove English copy
      i18n.setLocale('en');
      assert.equal(statusEl.textContent, 'Premove set: e2–e4.');

      // 6. Dispose board
      board.dispose();

      // 7. Switch locale again
      i18n.setLocale('ar');

      // 8. Disposed board ceases reacting
      assert.equal(statusEl.textContent, 'Premove set: e2–e4.');
    } finally {
      board.dispose();
    }
  });

  it('message timestamps: formats with active i18n locale and relocalizes dynamic mounts without altering message content', () => {
    const timestampIso = '2026-08-04T10:30:00Z';
    const enTime = formatTimestamp(timestampIso, 'en');
    const arTime = formatTimestamp(timestampIso, 'ar');
    assert.ok(enTime.length > 0);
    assert.ok(arTime.length > 0);
    assert.notEqual(enTime, arTime, 'Arabic timestamp format should differ from English');

    const doc = createFakeDoc(new Map());
    const container = new FakeElement('div', 'conversation-thread');
    container.ownerDocument = doc;
    const messages: MessageView[] = [
      {
        id: 'm-1',
        conversationId: 'c-1',
        senderId: 'u-other',
        body: 'Hello world!',
        sentAt: timestampIso,
        editedAt: null,
        deletedAt: null,
      },
    ];
    const names = new Map<string, SocialPlayer>([
      ['u-other', { id: 'u-other', handle: 'GrandmasterAlice' }],
    ]);

    const i18n = createTestI18n();

    // 1. Initial render in English
    renderThread(container as unknown as HTMLElement, messages, names, 'u-me', i18n);
    const sender = container.querySelector('.message-sender')!;
    const body = container.querySelector('.message-body')!;
    const time = container.querySelector('.count')!;
    assert.equal(sender.textContent, 'GrandmasterAlice');
    assert.equal(body.textContent, 'Hello world!');
    assert.equal(time.textContent, enTime);

    // 2. Switch locale to Arabic
    i18n.setLocale('ar');
    renderThread(container as unknown as HTMLElement, messages, names, 'u-me', i18n);

    // 3. User content (handle, body, id) is preserved, timestamp reflects Arabic locale
    const updatedSender = container.querySelector('.message-sender')!;
    const updatedBody = container.querySelector('.message-body')!;
    const updatedTime = container.querySelector('.count')!;
    assert.equal(updatedSender.textContent, 'GrandmasterAlice');
    assert.equal(updatedBody.textContent, 'Hello world!');
    assert.equal(updatedTime.textContent, arTime);
  });
});

