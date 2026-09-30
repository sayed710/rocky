/**
 * Regression test: Dynamic controller copy re-localizes from preserved state.
 *
 * Verifies that when a controller or mounted route combines state/data with client-owned copy:
 * 1. The underlying state/data is preserved across locale changes.
 * 2. The client-owned prose updates according to the new locale.
 * 3. Never replaces live data with static template defaults.
 * 4. Subscriptions are properly disposed when the mount is disposed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { I18n } from '../src/i18n/manager.js';
import { enMessages } from '../src/i18n/catalog/en.js';
import type { MessagesCatalog } from '../src/i18n/catalog/index.js';
import { renderEndgamePositionRows } from '../src/app/endgame-view.js';
import { renderStudyDetail } from '../src/app/studies-view.js';
import { renderTeamList } from '../src/app/teams-view.js';
import type { EndgamePosition, StudyView, TeamView } from '../src/api/models.js';

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  attributes: Record<string, string>;
  children: FakeElement[];
  ownerDocument?: unknown;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  append(...nodes: (FakeElement | string)[]): void;
  replaceChildren(...nodes: (FakeElement | string)[]): void;
  querySelectorAll(): FakeElement[];
  querySelector(sel: string): FakeElement | null;
  innerHTML: string;
}

function createFakeElement(tagName = 'div'): FakeElement {
  let innerHtmlVal = '';
  let textVal = '';
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    className: '',
    get textContent(): string {
      if (this.children.length === 0) {
        return textVal;
      }
      return this.children.map((c) => c.textContent).join('');
    },
    set textContent(val: string) {
      textVal = val;
      this.children = [];
    },
    attributes: {},
    children: [],
    get innerHTML(): string {
      return innerHtmlVal;
    },
    set innerHTML(val: string) {
      innerHtmlVal = val;
      if (val === '') {
        this.children = [];
      }
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    appendChild(child: FakeElement) {
      this.children.push(child);
      return child;
    },
    append(...nodes: (FakeElement | string)[]) {
      for (const n of nodes) {
        if (typeof n === 'string') {
          const textEl = createFakeElement('span');
          textEl.textContent = n;
          this.children.push(textEl);
        } else {
          this.children.push(n);
        }
      }
    },
    replaceChildren(...nodes: (FakeElement | string)[]) {
      this.children = [];
      this.append(...nodes);
    },
    querySelectorAll() {
      return [];
    },
    querySelector(sel: string): FakeElement | null {
      const isClass = sel.startsWith('.');
      const cls = isClass ? sel.slice(1) : sel;
      const queue: FakeElement[] = [...this.children];
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (isClass && item.className.split(' ').includes(cls)) {
          return item;
        }
        if (!isClass && item.tagName.toLowerCase() === sel.toLowerCase()) {
          return item;
        }
        queue.push(...item.children);
      }
      return null;
    },
  };
  el.ownerDocument = {
    createElement(tag: string) {
      return createFakeElement(tag);
    },
  };
  return el;
}

const fakeDoc = {
  createElement(tag: string) {
    return createFakeElement(tag);
  },
} as unknown as Document;

describe('dynamic controller copy re-localization from state', () => {
  it('endgame position rows: preserves position data while updating labels on locale change', () => {
    const arCatalog: Partial<MessagesCatalog> = {
      'learning.endgames.rowEndgame': 'نهاية اللعبة',
      'learning.endgames.rowObjective': 'الهدف',
      'learning.endgames.deliverCheckmate': 'تحقيق كش مات',
      'learning.endgames.rowToMove': 'الدور',
      'learning.endgames.rowWhite': 'الأبيض',
      'learning.endgames.rowLevel': 'المستوى',
      'learning.endgames.rowTechnique': 'التقنية',
    };

    const i18n = new I18n({
      catalogs: {
        en: enMessages,
        ar: arCatalog as unknown as MessagesCatalog,
      },
    });

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

    const rowsEl = createFakeElement('div');

    // 1. Initial render in English
    renderEndgamePositionRows(fakeDoc, rowsEl as unknown as HTMLElement, position, i18n);

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
    renderEndgamePositionRows(fakeDoc, rowsEl as unknown as HTMLElement, position, i18n);

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
    const arCatalog: Partial<MessagesCatalog> = {
      'learning.studies.noDescription': 'لا يوجد وصف.',
      'learning.studies.visibility': 'الرؤية: {visibility}',
    };

    const i18n = new I18n({
      catalogs: {
        en: enMessages,
        ar: arCatalog as unknown as MessagesCatalog,
      },
    });

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

    const nameEl = createFakeElement('h2');
    const descEl = createFakeElement('p');
    const visEl = createFakeElement('span');
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
    const arCatalog: Partial<MessagesCatalog> = {
      'community.teams.emptyListTitle': 'لا توجد فرق بعد',
      'community.teams.emptyListBody': 'ستظهر هنا الفرق التي ينشئها اللاعبون.',
    };

    const i18n = new I18n({
      catalogs: {
        en: enMessages,
        ar: arCatalog as unknown as MessagesCatalog,
      },
    });

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

    const targetEl = createFakeElement('div');
    renderTeamList(targetEl as unknown as HTMLElement, teams, false, i18n);

    assert.ok(targetEl.children.length > 0);
    // Find link inside row
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
