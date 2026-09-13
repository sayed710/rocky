import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountBoard } from '../src/app/board.js';
import { StaticMoveOracle } from '../src/ports/move-oracle.js';

/**
 * Records listener add/remove calls so a remount can be checked for stacking.
 *
 * There is no DOM in this package's unit tests, and `BoardView` touches very little of the element:
 * two class/attribute setters, `innerHTML`, and the three listeners this is about. A fake covering
 * exactly that is enough, and keeps the assertion on the thing that matters — the net number of
 * live handlers — rather than on a rendered tree Playwright already covers.
 */
function fakeElement() {
  const live = new Map<string, Set<unknown>>();
  let adds = 0;
  let html = '';
  return {
    el: {
      classList: { add: (): void => undefined },
      setAttribute: (): void => undefined,
      set innerHTML(value: string) { html = value; },
      get innerHTML() { return html; },
      getBoundingClientRect: () => ({ width: 512, height: 512, left: 0, top: 0 }),
      addEventListener(type: string, fn: unknown): void {
        adds += 1;
        const set = live.get(type) ?? new Set<unknown>();
        set.add(fn);
        live.set(type, set);
      },
      removeEventListener(type: string, fn: unknown): void {
        live.get(type)?.delete(fn);
      },
    } as unknown as HTMLElement,
    liveCount: (type: string): number => live.get(type)?.size ?? 0,
    totalAdds: (): number => adds,
  };
}

test('remounting a board does not stack listeners on the same element', () => {
  const board = fakeElement();
  const flip = fakeElement();

  // Three mounts onto the same element, as three visits to a board route would do: the elements
  // live in index.html and outlive the route, while `bootstrap` re-runs on every SPA navigation.
  mountBoard({ boardEl: board.el, flipEl: flip.el });
  mountBoard({ boardEl: board.el, flipEl: flip.el });
  const third = mountBoard({ boardEl: board.el, flipEl: flip.el });

  assert.equal(board.liveCount('click'), 1, 'one live click handler after three mounts');
  assert.equal(board.liveCount('pointerdown'), 1, 'one live pointerdown handler after three mounts');
  assert.equal(board.liveCount('keydown'), 1, 'one live keydown handler after three mounts');
  assert.equal(flip.liveCount('click'), 1, 'one live flip handler after three mounts');

  // Sanity: the mounts really did attach each time, so the counts above come from detaching the
  // previous view rather than from never attaching at all.
  assert.equal(board.totalAdds(), 9, 'each mount attaches its three handlers before the previous detaches');

  third.destroy();
  assert.equal(board.liveCount('click'), 0, 'destroy detaches the last view too');
  assert.equal(board.liveCount('keydown'), 0, 'destroy detaches keyboard input too');
  assert.equal(flip.liveCount('click'), 0);
});

/**
 * Extract the visible text from every coordinate label of the given kind
 * (`"rank"` or `"file"`) from a rendered board's HTML string.
 * Used to verify that coordinate labels appear in the correct order after
 * board orientation changes.
 */
function coordinateValues(html: string, kind: 'rank' | 'file'): string[] {
  return [...html.matchAll(new RegExp(`cb-coordinate cb-${kind}[^>]*>([^<]+)<`, 'g'))]
    .map((match) => match[1]!);
}

test('board renders every algebraic coordinate in the current orientation', () => {
  const board = fakeElement();
  const mounted = mountBoard({ boardEl: board.el });

  assert.deepEqual(coordinateValues(board.el.innerHTML, 'rank'), ['8', '7', '6', '5', '4', '3', '2', '1']);
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'file'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

  mounted.view.flip();
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'rank'), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(coordinateValues(board.el.innerHTML, 'file'), ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
  mounted.destroy();
});

class FakePromotionDocument {
  activeElement: FakePromotionElement | null = null;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  createElement(): FakePromotionElement {
    return new FakePromotionElement();
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: never) => void>();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }

  dispatchKeydown(event: object): void {
    for (const listener of this.listeners.get('keydown') ?? []) listener(event as never);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakePromotionElement {
  className = '';
  type = '';
  textContent = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakePromotionElement[] = [];
  removed = false;
  focused = false;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(_type: string, _listener: EventListener): void {}

  appendChild(child: FakePromotionElement): FakePromotionElement {
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): FakePromotionElement | null {
    if (selector === 'button') return this.children.find((child) => child.type === 'button') ?? null;
    return null;
  }

  focus(): void {
    this.focused = true;
  }

  remove(): void {
    this.removed = true;
  }
}

/** Build the smallest DOM seam needed to exercise promotion focus through the public board mount. */
function promotionBoardHarness() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const focusedSquares = new Map<string, FakePromotionElement>();
  const doc = new FakePromotionDocument();
  let html = '';
  let overlay: FakePromotionElement | null = null;

  const root = {
    ownerDocument: doc,
    classList: { add: (): void => undefined },
    setAttribute: (): void => undefined,
    set innerHTML(value: string) { html = value; },
    get innerHTML() { return html; },
    contains: (): boolean => false,
    getBoundingClientRect: () => ({ width: 512, height: 512, left: 0, top: 0 }),
    addEventListener(type: string, listener: EventListener): void {
      const registered = listeners.get(type) ?? new Set<(event: never) => void>();
      registered.add(listener as (event: never) => void);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.get(type)?.delete(listener as (event: never) => void);
    },
    appendChild(child: FakePromotionElement): FakePromotionElement {
      overlay = child;
      return child;
    },
    querySelector(selector: string): FakePromotionElement | null {
      const square = selector.match(/^\[data-square="([a-h][1-8])"\]$/)?.[1];
      if (!square) return null;
      const focusTarget = focusedSquares.get(square) ?? new FakePromotionElement();
      focusedSquares.set(square, focusTarget);
      return focusTarget;
    },
  } as unknown as HTMLElement;

  return {
    root,
    doc,
    dispatchClick(clientX: number, clientY: number): void {
      for (const listener of listeners.get('click') ?? []) {
        listener({ clientX, clientY } as never);
      }
    },
    overlay: (): FakePromotionElement | null => overlay,
    focusedSquare: (square: string): FakePromotionElement | undefined => focusedSquares.get(square),
  };
}

test('promotion cancellation stays lifecycle-safe across Escape, position sync, and destroy', () => {
  const hadDocument = 'document' in globalThis;
  const originalDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const hadHTMLElement = 'HTMLElement' in globalThis;
  const originalHTMLElementDesc = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const fen = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const board = promotionBoardHarness();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: board.doc });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakePromotionElement });
  const moves: string[] = [];
  const mounted = mountBoard(
    { boardEl: board.root },
    {
      oracle: new StaticMoveOracle({ [fen]: { e7: ['e8'] } }),
      onMove: (move) => moves.push(move),
    },
  );

  try {
    mounted.setPosition(fen);
    board.dispatchClick(288, 96); // e7
    assert.match(board.root.innerHTML, /data-square="e7"[^>]*aria-selected="true"/);
    board.dispatchClick(288, 32); // e8

    const overlay = board.overlay();
    assert.ok(overlay, 'promotion dialog should open');
    assert.equal(overlay.attributes.get('role'), 'dialog');
    assert.equal(overlay.querySelector('button')?.focused, true, 'first promotion choice receives focus');
    assert.equal(board.doc.listenerCount('keydown'), 1);

    let tabPrevented = false;
    let tabPropagationStopped = false;
    board.doc.dispatchKeydown({
      key: 'Tab',
      preventDefault: () => { tabPrevented = true; },
      stopPropagation: () => { tabPropagationStopped = true; },
    });
    assert.equal(tabPrevented, false, 'Tab must remain native');
    assert.equal(tabPropagationStopped, false, 'Tab must not be consumed by the promotion Escape handler');
    assert.equal(board.doc.listenerCount('keydown'), 1);

    const externalControl = new FakePromotionElement();
    board.doc.activeElement = externalControl;
    externalControl.focus();
    let defaultPrevented = false;
    let propagationStopped = false;
    // Focus may now be outside the board; the owning document still observes Escape.
    board.doc.dispatchKeydown({
      key: 'Escape',
      target: externalControl,
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { propagationStopped = true; },
    });

    assert.equal(defaultPrevented, true);
    assert.equal(propagationStopped, true);
    assert.equal(overlay.removed, true);
    assert.equal(board.doc.listenerCount('keydown'), 0);
    assert.equal(board.focusedSquare('e8')?.focused, true);
    assert.deepEqual(moves, [], 'cancelling promotion must not emit a move');

    board.dispatchClick(288, 96); // e7 can be selected again only if pending promotion was cleared
    assert.match(board.root.innerHTML, /data-square="e7"[^>]*aria-selected="true"/);
    board.dispatchClick(288, 32); // reopening must install exactly one fresh listener
    const reopenedOverlay = board.overlay();
    assert.ok(reopenedOverlay);
    assert.equal(board.doc.listenerCount('keydown'), 1);

    assert.throws(() => mounted.setPosition('invalid'), /FEN placement must have 8 ranks/);
    assert.equal(reopenedOverlay.removed, false, 'invalid position leaves the active dialog intact');
    assert.equal(board.doc.listenerCount('keydown'), 1, 'invalid position leaves Escape cancellation active');

    const promotionDestination = board.focusedSquare('e8');
    assert.ok(promotionDestination);
    promotionDestination.focused = false;
    mounted.setPosition(fen); // authoritative sync must dismiss stale promotion UI and listeners
    assert.equal(reopenedOverlay.removed, true);
    assert.equal(board.doc.listenerCount('keydown'), 0);
    assert.equal(promotionDestination.focused, true, 'position sync restores focus to the board');

    let staleEscapePrevented = false;
    board.doc.dispatchKeydown({
      key: 'Escape',
      preventDefault: () => { staleEscapePrevented = true; },
      stopPropagation: () => undefined,
    });
    assert.equal(staleEscapePrevented, false, 'position sync removes the stale Escape handler');

    board.dispatchClick(288, 96); // position sync must also clear pending promotion state
    board.dispatchClick(288, 32);
    const finalOverlay = board.overlay();
    assert.ok(finalOverlay);
    assert.equal(board.doc.listenerCount('keydown'), 1);

    mounted.destroy();
    assert.equal(board.doc.listenerCount('keydown'), 0);
    assert.equal(finalOverlay.removed, true);
  } finally {
    mounted.destroy();
    if (hadDocument && originalDocumentDesc) {
      Object.defineProperty(globalThis, 'document', originalDocumentDesc);
    } else if (hadDocument) {
      (globalThis as Record<string, unknown>).document = previousDocument;
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (hadHTMLElement && originalHTMLElementDesc) {
      Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElementDesc);
    } else if (hadHTMLElement) {
      (globalThis as Record<string, unknown>).HTMLElement = previousHTMLElement;
    } else {
      Reflect.deleteProperty(globalThis, 'HTMLElement');
    }
  }
});
