import { I18n, type I18nOptions } from '../../src/i18n/manager.js';
import { enMessages } from '../../src/i18n/catalog/en.js';
import type { MessagesCatalog } from '../../src/i18n/catalog/index.js';
// DOM test double capable of handling all mount and renderer operations
export class FakeElement {
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
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: 'forward' | 'backward' | 'none' | null = 'none';
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

  remove(): void {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
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
      const classes = s.split('.').filter(Boolean);
      return classes.every((cls) => this.classList.contains(cls));
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
    stopPropagation?: () => void;
    clientX?: number;
    clientY?: number;
  }): boolean {
    if (!event.preventDefault) {
      event.preventDefault = () => {};
    }
    if (!event.stopPropagation) {
      event.stopPropagation = () => {};
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
    const evt = { type: 'click', target: this, preventDefault: () => {}, stopPropagation: () => {} };
    this.onclick?.(evt);
    this.dispatchEvent(evt);
  }

  focus(): void {
    const doc = this.ownerDocument as { activeElement?: FakeElement } | undefined;
    if (doc) doc.activeElement = this;
  }
  setSelectionRange(start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none'): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
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

export class FakeHTMLButtonElement extends FakeElement {}
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

export function createFakeDoc(elementMap = new Map<string, FakeElement>()): Document {
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
    addEventListener(_type: string, _fn: unknown, _capture?: unknown) {},
    removeEventListener(_type: string, _fn: unknown, _capture?: unknown) {},
  };
  const html = docObj.documentElement as FakeElement;
  const body = docObj.body as FakeElement;
  html.ownerDocument = docObj as unknown as Document;
  body.ownerDocument = docObj as unknown as Document;
  html.children.push(body);
  body.parentElement = html;
  for (const el of elementMap.values()) {
    el.ownerDocument = docObj as unknown as Document;
    body.children.push(el);
    el.parentElement = body;
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
  'lobby.creatorUnrated': 'غير مصنف',
  'lobby.creatorRatingAria': 'التصنيف في {variant} · {speed}: {rating}',
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

  // Password Recovery
  'passwordRecovery.sentInstructions': 'إذا كان هناك حساب مطابق، فقد أرسلنا تعليمات لإعادة تعيين كلمة المرور.',
  'passwordRecovery.resetSuccess': 'تمت إعادة تعيين كلمة المرور بنجاح.',
  'passwordRecovery.enterHandleOrEmail': 'يرجى إدخال اسم المستخدم أو البريد الإلكتروني.',
  'passwordRecovery.linkInvalid': 'رابط إعادة التعيين هذا غير صالح أو انتهت صلاحيته.',
  'passwordRecovery.passwordLength': 'يجب أن تتراوح كلمة المرور بين 8 و 1024 حرفاً.',
  'passwordRecovery.passwordsDoNotMatch': 'كلمتا المرور غير متطابقتين.',
  'passwordRecovery.sending': 'جارٍ الإرسال…',
  'passwordRecovery.submit': 'إرسال تعليمات إعادة التعيين',
  'passwordRecovery.resetting': 'جارٍ إعادة التعيين…',
  'passwordRecovery.resetSubmit': 'تعيين كلمة مرور جديدة',

  // Email Verification
  'emailVerification.verifyingStatus': 'جارٍ التحقق من بريدك الإلكتروني...',
  'emailVerification.needsLink': 'تحتاج هذه الصفحة إلى رابط تحقق. افتح الرابط في رسالة التحقق الإلكترونية.',
  'emailVerification.verified': 'تم التحقق من بريدك الإلكتروني.',
  'emailVerification.linkInvalid': 'رابط التحقق هذا غير صالح، أو انتهت صلاحيته، أو تم استخدامه بالفعل.',
  'emailVerification.couldNotVerify': 'تعذر التحقق من بريدك الإلكتروني الآن. يرجى المحاولة مرة أخرى.',
  'emailVerification.retry': 'إعادة المحاولة',

  // Community & Teams
  'community.teams.notFoundTitle': 'الفريق غير موجود',
  'community.teams.notFoundBody': 'لا يوجد مثل هذا الفريق، أو أنه خاص.',
  'community.forum.threadNotFoundTitle': 'الموضوع غير موجود',
  'community.forum.threadNotFoundBody': 'ربما تمت إزالة هذا الموضوع.',
  'community.forum.teamForumTitle': 'منتدى {name}',
  'community.teams.actionJoin': 'الانضمام للفريق',
  'community.teams.actionLeave': 'مغادرة الفريق',

  // Commentary
  'tournaments.commentary.idle': 'اطلب تعليقاً على مباراة منتهية، أو ملخصاً لجولة مكتملة.',
  'tournaments.commentary.running': 'جارٍ كتابة التعليق…',
  'tournaments.commentary.failed': 'تعذر كتابة التعليق.',
  'tournaments.commentary.unavailable': 'التعليق غير متوفر حالياً.',

  // Learning Steps
  'learning.step.stepN': 'الخطوة {n}',
  'learning.step.complete': 'إكمال',
  'learning.step.submitMove': 'إرسال النقلة',
  'learning.step.sanInputLabel': 'نقلة بتنسيق SAN',
  'learning.step.sanPlaceholder': 'مثال: Nf3',
  'learning.step.boardReadOnlyAria': 'موقف رقعة الشطرنج للخطوة {n} (للقراءة فقط)',
  'learning.step.boardSrOnly': 'موقف الشطرنج FEN: {fen}. رقعة غير تفاعلية.',
  'learning.studies.activeTag': 'الحالي: {name}',
  'learning.studies.startPosition': 'موقف البداية',
  'learning.studies.startPositionAria': 'العودة لموقف البداية',

  // Auth Errors
  'auth.error.stepUpRequired': 'يلزم التحقق الإضافي. أدخل الرمز أو سجل الدخول باستخدام مفتاح مرور.',
  'auth.error.emailUnverified': 'تحقق من بريدك الإلكتروني قبل تسجيل الدخول.',
  'auth.error.handleRequiredPasskey': 'يرجى إدخال اسم المستخدم لتسجيل الدخول باستخدام مفتاح المرور.',
  'auth.error.passkeyUnsupported': 'تسجيل الدخول باستخدام مفتاح المرور غير مدعوم على هذا المتصفح.',
  'auth.error.passkeyFailed': 'فشل تسجيل الدخول باستخدام مفتاح المرور.',
  'auth.error.emailRequired': 'مطلوب عنوان بريد إلكتروني لإنشاء حساب.',
  'auth.error.handleOrEmailRequired': 'أدخل اسم المستخدم أو البريد الإلكتروني للحصول على رابط تحقق جديد.',
  'auth.notice.verificationSent': 'إذا كان هناك حساب مطابق، فقد أرسلنا رابط تحقق جديداً.',
};

export function createTestI18n(opts: Partial<I18nOptions> = {}): I18n {
  return new I18n({
    catalogs: {
      en: enMessages,
      ar: testArabicCatalog as unknown as MessagesCatalog,
    },
    ...opts,
  });
}
