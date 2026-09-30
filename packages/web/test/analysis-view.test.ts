/**
 * Tests for the engine analysis view rendering (M15 inc 2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLines,
  renderError,
  renderLimits,
  renderLines,
  renderNote,
  renderReached,
  setBusy,
} from '../src/app/analysis-view.js';
import type { AnalysisResponse } from '../src/api/models.js';

class FakeHTMLElement {
  private _innerHTML = '';
  children: FakeHTMLElement[] = [];
  classList = new Set<string>();
  attributes = new Map<string, string>();
  textContent = '';
  hidden = false;
  className = '';

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  appendChild(child: FakeHTMLElement) {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  get ownerDocument() {
    return {
      createElement: (_tag: string) => new FakeHTMLElement() as unknown as HTMLElement,
    } as unknown as Document;
  }
}

function sampleResult(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    variant: 'standard',
    applied: {
      depth: 16,
      movetimeMs: 1000,
      multiPv: 3,
    },
    lines: [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 40 },
        moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
        depth: 12,
        nodes: 100000,
        timeMs: 900,
      },
    ],
    ...overrides,
  };
}

test('result rendering: one row per line, in multipv order', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;
  const result = sampleResult({
    lines: [
      {
        multipv: 2,
        evaluation: { type: 'cp', value: 20 },
        moves: ['d2d4', 'd7d5'],
        depth: 12,
        nodes: 90000,
        timeMs: 900,
      },
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 40 },
        moves: ['e2e4', 'e7e5'],
        depth: 12,
        nodes: 100000,
        timeMs: 900,
      },
    ],
  });

  renderLines(container, result);

  const fake = container as unknown as FakeHTMLElement;
  assert.equal(fake.children.length, 2);

  // Line 1 is rendered first despite arriving second in array
  const row1 = fake.children[0]!;
  assert.equal(row1.className, 'panel-row');
  assert.equal(row1.children.length, 1);
  const row1Main = row1.children[0]!;
  assert.ok(row1Main.children[0]!.className.includes('analysis-eval'));
  assert.equal(row1Main.children[0]!.getAttribute('dir'), 'ltr');
  assert.equal(row1Main.children[0]!.textContent, '+0.40');
  assert.ok(row1Main.children[1]!.className.includes('analysis-moves'));
  assert.equal(row1Main.children[1]!.getAttribute('dir'), 'ltr');
  assert.equal(row1Main.children[1]!.textContent, 'e2e4 e7e5');

  // Line 2 is rendered second
  const row2 = fake.children[1]!;
  assert.equal(row2.className, 'panel-row');
  const row2Main = row2.children[0]!;
  assert.equal(row2Main.children[0]!.textContent, '+0.20');
  assert.equal(row2Main.children[1]!.textContent, 'd2d4 d7d5');
});

test('MultiPV: three lines render three rows, each with its own eval and moves', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;
  const result = sampleResult({
    lines: [
      { multipv: 1, evaluation: { type: 'cp', value: 45 }, moves: ['e2e4'], depth: 14, nodes: 150000, timeMs: 950 },
      { multipv: 2, evaluation: { type: 'cp', value: 30 }, moves: ['d2d4'], depth: 14, nodes: 140000, timeMs: 950 },
      { multipv: 3, evaluation: { type: 'cp', value: 15 }, moves: ['c2c4'], depth: 14, nodes: 130000, timeMs: 950 },
    ],
  });

  renderLines(container, result);

  const fake = container as unknown as FakeHTMLElement;
  assert.equal(fake.children.length, 3);

  assert.equal(fake.children[0]!.children[0]!.children[0]!.textContent, '+0.45');
  assert.equal(fake.children[0]!.children[0]!.children[1]!.textContent, 'e2e4');

  assert.equal(fake.children[1]!.children[0]!.children[0]!.textContent, '+0.30');
  assert.equal(fake.children[1]!.children[0]!.children[1]!.textContent, 'd2d4');

  assert.equal(fake.children[2]!.children[0]!.children[0]!.textContent, '+0.15');
  assert.equal(fake.children[2]!.children[0]!.children[1]!.textContent, 'c2c4');
});

test('evaluation is White-relative: the same {type:\'cp\',value:40} renders +0.40 for White-to-move and -0.40 for Black-to-move', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;

  const whiteResult = sampleResult({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    lines: [{ multipv: 1, evaluation: { type: 'cp', value: 40 }, moves: ['e2e4'], depth: 10, nodes: 50000, timeMs: 400 }],
  });
  renderLines(container, whiteResult);
  assert.equal((container as unknown as FakeHTMLElement).children[0]!.children[0]!.children[0]!.textContent, '+0.40');

  const blackResult = sampleResult({
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    lines: [{ multipv: 1, evaluation: { type: 'cp', value: 40 }, moves: ['e7e5'], depth: 10, nodes: 50000, timeMs: 400 }],
  });
  renderLines(container, blackResult);
  assert.equal((container as unknown as FakeHTMLElement).children[0]!.children[0]!.children[0]!.textContent, '-0.40');
});

test('reached vs limits are not conflated: with applied.depth = 16 and lines[0].depth = 12, reached says 12 and limits says 16', () => {
  const reachedEl = new FakeHTMLElement() as unknown as HTMLElement;
  const limitsEl = new FakeHTMLElement() as unknown as HTMLElement;

  const result = sampleResult({
    applied: {
      depth: 16,
      movetimeMs: 1000,
      multiPv: 3,
    },
    lines: [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 35 },
        moves: ['e2e4'],
        depth: 12,
        nodes: 120000,
        timeMs: 900,
      },
    ],
  });

  renderReached(reachedEl, result);
  renderLimits(limitsEl, result);

  assert.equal(reachedEl.textContent, 'Reached depth 12 · 0.9 s');
  assert.equal(reachedEl.hidden, false);

  assert.equal(limitsEl.textContent, 'Limits: depth 16 · 1.0 s · 3 lines');
  assert.equal(limitsEl.hidden, false);
});

test('renderReached hides element when there are no lines', () => {
  const reachedEl = new FakeHTMLElement() as unknown as HTMLElement;
  const result = sampleResult({ lines: [] });

  renderReached(reachedEl, result);

  assert.equal(reachedEl.hidden, true);
  assert.equal(reachedEl.textContent, '');
});

test('setBusy toggles aria-busy attribute', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;
  setBusy(container, true);
  assert.equal((container as unknown as FakeHTMLElement).getAttribute('aria-busy'), 'true');
  setBusy(container, false);
  assert.equal((container as unknown as FakeHTMLElement).getAttribute('aria-busy'), 'false');
});

test('renderNote and renderError toggle text and hidden property', () => {
  const noteEl = new FakeHTMLElement() as unknown as HTMLElement;
  const errorEl = new FakeHTMLElement() as unknown as HTMLElement;

  renderNote(noteEl, 'Analysing…');
  assert.equal(noteEl.textContent, 'Analysing…');
  assert.equal(noteEl.hidden, false);

  renderNote(noteEl, null);
  assert.equal(noteEl.textContent, '');
  assert.equal(noteEl.hidden, true);

  renderError(errorEl, 'Analysis failed. Try again.');
  assert.equal(errorEl.textContent, 'Analysis failed. Try again.');
  assert.equal(errorEl.hidden, false);

  renderError(errorEl, null);
  assert.equal(errorEl.textContent, '');
  assert.equal(errorEl.hidden, true);
});

test('clearLines clears innerHTML', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;
  container.innerHTML = '<div class="panel-row">Row</div>';
  clearLines(container);
  assert.equal(container.innerHTML, '');
});
