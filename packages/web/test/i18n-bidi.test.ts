import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLtrElement,
  applyLtrIsolation,
  isChessNotation,
  wrapLtrHtml,
} from '../src/i18n/bidi.js';

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function createFakeElement(tagName: string): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    attributes: {},
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
  };
}

describe('i18n bidi & chess isolation', () => {
  it('createLtrElement builds an element with dir=ltr and bidi-ltr class', () => {
    const fakeDoc = {
      createElement(tag: string) {
        return createFakeElement(tag);
      },
    };

    const el = createLtrElement(
      fakeDoc as unknown as Document,
      'bdi',
      'e2e4',
      'chess-uci',
    );
    assert.equal(el.tagName, 'BDI');
    assert.equal(el.getAttribute('dir'), 'ltr');
    assert.equal(el.textContent, 'e2e4');
    assert.ok(el.className.includes('bidi-ltr'));
    assert.ok(el.className.includes('chess-uci'));
  });

  it('applyLtrIsolation sets dir=ltr and preserves existing classes', () => {
    const el = createFakeElement('span');
    el.className = 'existing-class';

    applyLtrIsolation(el as unknown as HTMLElement);
    assert.equal(el.getAttribute('dir'), 'ltr');
    assert.ok(el.className.includes('existing-class'));
    assert.ok(el.className.includes('bidi-ltr'));
  });

  it('wrapLtrHtml generates valid HTML markup with dir=ltr and isolate class', () => {
    assert.equal(
      wrapLtrHtml('Nf3'),
      '<bdi dir="ltr" class="bidi-ltr">Nf3</bdi>',
    );
    assert.equal(
      wrapLtrHtml('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'span'),
      '<span dir="ltr" class="bidi-ltr">rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1</span>',
    );
  });

  it('wrapLtrHtml escapes dangerous characters in content', () => {
    assert.equal(
      wrapLtrHtml('<script>alert("xss")</script>'),
      '<bdi dir="ltr" class="bidi-ltr">&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</bdi>',
    );
  });

  it('isChessNotation identifies SAN, UCI, FEN, and clock notation', () => {
    // UCI
    assert.equal(isChessNotation('e2e4'), true);
    assert.equal(isChessNotation('e7e8q'), true);

    // SAN
    assert.equal(isChessNotation('Nf3'), true);
    assert.equal(isChessNotation('O-O'), true);
    assert.equal(isChessNotation('O-O-O'), true);
    assert.equal(isChessNotation('exd5'), true);
    assert.equal(isChessNotation('Qxd8#'), true);
    assert.equal(isChessNotation('Rd1+'), true);

    // FEN
    assert.equal(
      isChessNotation('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
      true,
    );

    // Clock
    assert.equal(isChessNotation('10:00'), true);
    assert.equal(isChessNotation('3:05'), true);

    // Not chess notation
    assert.equal(isChessNotation('Play chess'), false);
    assert.equal(isChessNotation('Sign in to play'), false);
    assert.equal(isChessNotation('Tournament Details'), false);
  });
});
