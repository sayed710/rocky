import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardView } from '../src/ui/board-view.js';
import { BoardInteraction } from '../src/core/interaction.js';
import { StaticMoveOracle } from '../src/ports/move-oracle.js';
import type { Square } from '../src/core/board.js';

/**
 * Minimal in-memory DOM node used by board-a11y tests. Supports attribute get/set,
 * class list, basic event dispatching, and CSS selector matching so that
 * `BoardView` can render and have its ARIA attributes inspected without a browser.
 */
class FakeDOMNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new Set<string>();
  children: FakeDOMNode[] = [];
  parentElement: FakeDOMNode | null = null;
  focused = false;
  style: Record<string, string> = {};
  textContent = '';
  type = '';
  private readonly listeners = new Map<string, Set<(e: never) => void>>();

  get tabIndex(): number {
    return parseInt(this.getAttribute('tabindex') ?? '-1', 10);
  }

  set tabIndex(val: number) {
    this.setAttribute('tabindex', String(val));
  }

  addEventListener(type: string, fn: (e: never) => void): void {
    const set = this.listeners.get(type) ?? new Set<(e: never) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (e: never) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(type: string, event: object): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event as never);
    }
  }

  constructor(public readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

  appendChild(child: FakeDOMNode): FakeDOMNode {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  focus(): void {
    this.focused = true;
  }

  closest<T extends FakeDOMNode>(selector: string): T | null {
    let curr: FakeDOMNode | null = this;
    while (curr) {
      if (curr.matches(selector)) return curr as unknown as T;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector.toLowerCase() === this.tagName.toLowerCase()) {
      return true;
    }
    if (selector.startsWith('.')) {
      const parts = selector.slice(1).split(/(?=[.\[])/);
      for (const part of parts) {
        if (part.startsWith('.')) {
          if (!this.classList.has(part.slice(1))) return false;
        } else if (part.startsWith('[')) {
          const attr = part.slice(1, -1);
          if (attr.includes('=')) {
            const [k, v] = attr.split('=');
            const cleanV = v!.replace(/^["']|["']$/g, '');
            if (this.getAttribute(k!) !== cleanV) return false;
          } else if (!this.hasAttribute(attr)) {
            return false;
          }
        } else {
          if (!this.classList.has(part)) return false;
        }
      }
      return true;
    }
    if (selector.startsWith('[')) {
      const attr = selector.slice(1, -1);
      if (attr.includes('=')) {
        const [k, v] = attr.split('=');
        const cleanV = v!.replace(/^["']|["']$/g, '');
        return this.getAttribute(k!) === cleanV;
      }
      return this.hasAttribute(attr);
    }
    return false;
  }

  querySelector<T extends FakeDOMNode>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] as T) ?? null;
  }

  querySelectorAll<T extends FakeDOMNode>(selector: string): T[] {
    const results: T[] = [];
    const walk = (node: FakeDOMNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child as unknown as T);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

// Polyfill Element and HTMLElement for Node test runner
import { before, after } from 'node:test';

let installedElement = false;
let installedHTMLElement = false;
let origElementDesc: PropertyDescriptor | undefined;
let origHTMLElementDesc: PropertyDescriptor | undefined;

before(() => {
  if (typeof globalThis.Element === 'undefined') {
    origElementDesc = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeDOMNode });
    installedElement = true;
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    origHTMLElementDesc = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeDOMNode });
    installedHTMLElement = true;
  }
});

after(() => {
  if (installedElement) {
    if (origElementDesc) {
      Object.defineProperty(globalThis, 'Element', origElementDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'Element');
    }
  }
  if (installedHTMLElement) {
    if (origHTMLElementDesc) {
      Object.defineProperty(globalThis, 'HTMLElement', origHTMLElementDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'HTMLElement');
    }
  }
});

/**
 * Robust stack-based HTML parser for BoardView.render() fragments.
 */
function parseHtmlFragment(html: string): FakeDOMNode[] {
  const root = new FakeDOMNode('fragment');
  let current = root;
  const stack: FakeDOMNode[] = [root];

  const tagTokenRegex = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagTokenRegex.exec(html)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2]!;
    const rawAttrs = match[3] ?? '';

    if (isClosing) {
      while (stack.length > 1) {
        const popped = stack.pop()!;
        if (popped.tagName.toLowerCase() === tagName.toLowerCase()) {
          break;
        }
      }
      current = stack[stack.length - 1]!;
    } else {
      const node = new FakeDOMNode(tagName);
      const attrRegex = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const attrName = attrMatch[1]!;
        const attrVal = attrMatch[2] ?? '';
        node.setAttribute(attrName, attrVal);
        if (attrName === 'class') {
          for (const cls of attrVal.split(/\s+/).filter(Boolean)) {
            node.classList.add(cls);
          }
        }
        if (attrName === 'tabindex') {
          node.tabIndex = parseInt(attrVal, 10);
        }
      }
      current.appendChild(node);
      stack.push(node);
      current = node;
    }
  }

  return root.children;
}

class FakeBoardRoot extends FakeDOMNode {
  private _html = '';
  readonly ownerDocument: FakeDocument;

  constructor() {
    super('div');
    this.ownerDocument = new FakeDocument(this);
  }

  get innerHTML(): string {
    return this._html;
  }

  set innerHTML(val: string) {
    this._html = val;
    this.children = parseHtmlFragment(val);
    for (const child of this.children) {
      child.parentElement = this;
    }
  }

  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 512, height: 512, left: 0, top: 0 };
  }

  contains(other: FakeDOMNode | null): boolean {
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }
}

class FakeDocument {
  activeElement: FakeDOMNode | null = null;
  private readonly listeners = new Map<string, Set<(e: never) => void>>();

  constructor(public readonly root: FakeBoardRoot) {}

  createElement(tagName: string): FakeDOMNode {
    return new FakeDOMNode(tagName);
  }

  addEventListener(type: string, fn: (e: never) => void): void {
    const set = this.listeners.get(type) ?? new Set<(e: never) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (e: never) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(type: string, event: object): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event as never);
    }
  }
}

/**
 * Convenience factory that wires together a `FakeBoardRoot`, a `StaticMoveOracle`,
 * a `BoardInteraction`, and a `BoardView` for a given FEN position. The default
 * starting position exposes legal moves from e2 and b1, which is sufficient for
 * the majority of ARIA-attribute assertions.
 */
function createHarness(fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
  const root = new FakeBoardRoot();
  const oracle = new StaticMoveOracle({
    [fen]: {
      e2: ['e3', 'e4'],
      b1: ['a3', 'c3'],
    },
  });
  const interaction = new BoardInteraction({ oracle });
  const results: unknown[] = [];
  const view = new BoardView(root as unknown as HTMLElement, {
    interaction,
    onResult: (res) => results.push(res),
  });
  view.setPosition(fen);

  return { root, interaction, oracle, view, results };
}

test('board container defines complete ARIA grid semantics', () => {
  const { root } = createHarness();

  assert.equal(root.getAttribute('role'), 'grid');
  assert.equal(root.getAttribute('aria-label'), 'Chess board');
  assert.equal(root.getAttribute('aria-rowcount'), '8', 'grid must declare aria-rowcount="8"');
  assert.equal(root.getAttribute('aria-colcount'), '8', 'grid must declare aria-colcount="8"');
});

test('grid contains 8 rows each containing 8 gridcells with proper row/col indices', () => {
  const { root } = createHarness();

  const rows = root.querySelectorAll('[role="row"]');
  assert.equal(rows.length, 8, 'grid must contain exactly 8 role="row" containers');

  for (let r = 0; r < 8; r++) {
    const row = rows[r]!;
    assert.equal(
      row.getAttribute('aria-rowindex'),
      String(r + 1),
      `row ${r} must have aria-rowindex="${r + 1}"`,
    );

    const cells = row.querySelectorAll('[role="gridcell"]');
    assert.equal(cells.length, 8, `row ${r + 1} must contain exactly 8 gridcells`);

    for (let c = 0; c < 8; c++) {
      const cell = cells[c]!;
      assert.equal(
        cell.getAttribute('aria-colindex'),
        String(c + 1),
        `cell ${c} in row ${r + 1} must have aria-colindex="${c + 1}"`,
      );
      assert.equal(
        cell.getAttribute('aria-rowindex'),
        String(r + 1),
        `cell ${c} in row ${r + 1} must have aria-rowindex="${r + 1}"`,
      );
    }
  }
});

test('square accessible labels announce clear square names and piece descriptions', () => {
  const { root } = createHarness();

  // White pieces
  const e2 = root.querySelector('[data-square="e2"]');
  assert.ok(e2);
  assert.equal(e2.getAttribute('aria-label'), 'e2, white pawn');

  const e1 = root.querySelector('[data-square="e1"]');
  assert.ok(e1);
  assert.equal(e1.getAttribute('aria-label'), 'e1, white king');

  const b1 = root.querySelector('[data-square="b1"]');
  assert.ok(b1);
  assert.equal(b1.getAttribute('aria-label'), 'b1, white knight');

  // Black pieces
  const e8 = root.querySelector('[data-square="e8"]');
  assert.ok(e8);
  assert.equal(e8.getAttribute('aria-label'), 'e8, black king');

  const d8 = root.querySelector('[data-square="d8"]');
  assert.ok(d8);
  assert.equal(d8.getAttribute('aria-label'), 'd8, black queen');

  // Empty squares
  const e4 = root.querySelector('[data-square="e4"]');
  assert.ok(e4);
  assert.equal(e4.getAttribute('aria-label'), 'e4, empty');

  const d5 = root.querySelector('[data-square="d5"]');
  assert.ok(d5);
  assert.equal(d5.getAttribute('aria-label'), 'd5, empty');
});

test('legal moves and selection do not conflate piece identity with highlights', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const { root } = createHarness(fen);

  const e2 = root.querySelector<FakeDOMNode>('[data-square="e2"]');
  assert.ok(e2);

  // Activate e2 via keyboard Space
  root.dispatchEvent('keydown', {
    key: ' ',
    target: e2,
    preventDefault: () => undefined,
  });

  // e2 is selected
  const e2Selected = root.querySelector('[data-square="e2"]');
  assert.ok(e2Selected);
  assert.equal(e2Selected.getAttribute('aria-selected'), 'true');
  assert.equal(e2Selected.getAttribute('aria-label'), 'e2, white pawn');

  // e4 is a legal destination (empty)
  const e4 = root.querySelector('[data-square="e4"]');
  assert.ok(e4);
  assert.equal(e4.getAttribute('aria-label'), 'e4, empty', 'piece identity must remain intact');
  assert.equal(e4.getAttribute('aria-description'), 'legal move', 'legal move conveyed via aria-description');

  // Non-selected square has aria-selected="false"
  assert.equal(e4.getAttribute('aria-selected'), 'false');
});

test('capture destination announces piece identity with capture description', () => {
  // White pawn on e4, black pawn on d5
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const root = new FakeBoardRoot();
  const oracle = new StaticMoveOracle({
    [fen]: {
      e4: ['d5', 'e5'],
    },
  });
  const interaction = new BoardInteraction({ oracle });
  const view = new BoardView(root as unknown as HTMLElement, { interaction });
  view.setPosition(fen);

  const e4 = root.querySelector<FakeDOMNode>('[data-square="e4"]');
  assert.ok(e4);

  // Select e4
  root.dispatchEvent('keydown', {
    key: 'Enter',
    target: e4,
    preventDefault: () => undefined,
  });

  const d5 = root.querySelector('[data-square="d5"]');
  assert.ok(d5);
  assert.equal(d5.getAttribute('aria-label'), 'd5, black pawn', 'piece identity must remain black pawn');
  assert.equal(d5.getAttribute('aria-description'), 'capture', 'capture announced via aria-description');
});

test('last move squares declare semantic state with aria-current only on destination', () => {
  const { root, view } = createHarness();
  view.setLastMove('e2' as Square, 'e4' as Square);

  const e2 = root.querySelector('[data-square="e2"]');
  const e4 = root.querySelector('[data-square="e4"]');
  assert.ok(e2);
  assert.ok(e4);

  // Both squares carry the last-move highlight and description
  assert.equal(e2.getAttribute('aria-description'), 'last move');
  assert.equal(e4.getAttribute('aria-description'), 'last move');

  // WAI-ARIA / MDN: Only the destination square represents the current piece position
  assert.equal(e2.hasAttribute('aria-current'), false, 'origin square must not have aria-current');
  assert.equal(e4.getAttribute('aria-current'), 'true', 'destination square must have aria-current="true"');

  const e3 = root.querySelector('[data-square="e3"]');
  assert.ok(e3);
  assert.equal(e3.hasAttribute('aria-current'), false);
});

test('extended keyboard navigation supports Home, End, PageUp, PageDown', () => {
  const { root } = createHarness();

  const getFocused = () => root.querySelector<FakeDOMNode>('[tabindex="0"]');
  assert.equal(getFocused()?.dataset['square'], 'a8');

  // Move right 3 times -> d8
  for (let i = 0; i < 3; i++) {
    const current = getFocused()!;
    root.dispatchEvent('keydown', {
      key: 'ArrowRight',
      target: current,
      preventDefault: () => undefined,
    });
  }
  assert.equal(getFocused()?.dataset['square'], 'd8');

  // End -> h8 (last cell in current row)
  root.dispatchEvent('keydown', {
    key: 'End',
    ctrlKey: false,
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'h8');

  // Home -> a8 (first cell in current row)
  root.dispatchEvent('keydown', {
    key: 'Home',
    ctrlKey: false,
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'a8');

  // PageDown -> a1 (bottom cell of column a)
  root.dispatchEvent('keydown', {
    key: 'PageDown',
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'a1');

  // PageUp -> a8 (top cell of column a)
  root.dispatchEvent('keydown', {
    key: 'PageUp',
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'a8');

  // Ctrl+End -> h1 (bottom-right cell of grid)
  root.dispatchEvent('keydown', {
    key: 'End',
    ctrlKey: true,
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'h1');

  // Ctrl+Home -> a8 (top-left cell of grid)
  root.dispatchEvent('keydown', {
    key: 'Home',
    ctrlKey: true,
    target: getFocused()!,
    preventDefault: () => undefined,
  });
  assert.equal(getFocused()?.dataset['square'], 'a8');
});

test('flip updates row and col semantics for black orientation', () => {
  const { root, view } = createHarness();
  view.flip();

  const rows = root.querySelectorAll('[role="row"]');
  assert.equal(rows.length, 8);

  // In black orientation, row 1 is rank 1 (h1 to a1)
  const row1 = rows[0]!;
  assert.equal(row1.getAttribute('aria-rowindex'), '1');
  const row1Cells = row1.querySelectorAll('[role="gridcell"]');
  assert.equal(row1Cells[0]?.dataset['square'], 'h1');
  assert.equal(row1Cells[7]?.dataset['square'], 'a1');

  // Row 8 is rank 8 (h8 to a8)
  const row8 = rows[7]!;
  assert.equal(row8.getAttribute('aria-rowindex'), '8');
  const row8Cells = row8.querySelectorAll('[role="gridcell"]');
  assert.equal(row8Cells[0]?.dataset['square'], 'h8');
  assert.equal(row8Cells[7]?.dataset['square'], 'a8');
});

test('promotion overlay announces accessible dialog and full piece labels', () => {
  // Setup promotion scenario: white pawn on e7 moving to e8
  const fen = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const root = new FakeBoardRoot();
  const oracle = new StaticMoveOracle({
    [fen]: {
      e7: ['e8'],
    },
  });
  const interaction = new BoardInteraction({ oracle });
  const view = new BoardView(root as unknown as HTMLElement, { interaction });
  view.setPosition(fen);

  const prevDoc = globalThis.document;
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: root.ownerDocument });

    // Select e7
    const e7 = root.querySelector<FakeDOMNode>('[data-square="e7"]');
    assert.ok(e7);
    root.dispatchEvent('keydown', {
      key: 'Enter',
      target: e7,
      preventDefault: () => undefined,
    });

    // Move to e8 to trigger promotion overlay
    const e8 = root.querySelector<FakeDOMNode>('[data-square="e8"]');
    assert.ok(e8);
    root.dispatchEvent('keydown', {
      key: 'Enter',
      target: e8,
      preventDefault: () => undefined,
    });

    const overlay = root.querySelector('[role="dialog"]');
    assert.ok(overlay, 'promotion dialog must open');
    assert.equal(overlay.getAttribute('aria-label'), 'Choose promotion piece');

    const buttons = overlay.querySelectorAll('button');
    // 4 promotion choices + 1 cancel button
    assert.equal(buttons.length, 5);
    assert.equal(buttons[0]?.getAttribute('aria-label'), 'Promote to queen');
    assert.equal(buttons[1]?.getAttribute('aria-label'), 'Promote to rook');
    assert.equal(buttons[2]?.getAttribute('aria-label'), 'Promote to bishop');
    assert.equal(buttons[3]?.getAttribute('aria-label'), 'Promote to knight');
    assert.equal(buttons[4]?.getAttribute('aria-label'), 'Cancel promotion');
  } finally {
    if (prevDoc !== undefined) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
