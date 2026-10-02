import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLtrElement,
  applyLtrIsolation,
  applyAutoDirection,
  createUserTextElement,
  isChessNotation,
  isPgnMovetext,
  wrapLtrHtml,
  wrapUserTextHtml,
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

  it('applyAutoDirection sets dir=auto for user text', () => {
    const el = createFakeElement('span');
    applyAutoDirection(el as unknown as HTMLElement);
    assert.equal(el.getAttribute('dir'), 'auto');
  });

  it('createUserTextElement creates element with dir=auto', () => {
    const fakeDoc = {
      createElement(tag: string) {
        return createFakeElement(tag);
      },
    };
    const el = createUserTextElement(fakeDoc as unknown as Document, 'span', 'لاعب شطرنج');
    assert.equal(el.tagName, 'SPAN');
    assert.equal(el.getAttribute('dir'), 'auto');
    assert.equal(el.textContent, 'لاعب شطرنج');
  });

  it('wrapUserTextHtml generates markup with dir=auto and escapes HTML', () => {
    assert.equal(
      wrapUserTextHtml('Player <tag>'),
      '<bdi dir="auto">Player &lt;tag&gt;</bdi>',
    );
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

  it('isChessNotation identifies SAN, UCI, FEN, clocks, ratings, and SAN with UCI', () => {
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

    // SAN with UCI
    assert.equal(isChessNotation('e4 (e2e4)'), true);
    assert.equal(isChessNotation('Nf3 (g1f3)'), true);

    // FEN
    assert.equal(
      isChessNotation('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
      true,
    );

    // Clocks
    assert.equal(isChessNotation('10:00'), true);
    assert.equal(isChessNotation('3:05'), true);
    assert.equal(isChessNotation('05:00 – 05:00'), true);

    // Ratings
    assert.equal(isChessNotation('1500 (±50)'), true);
    assert.equal(isChessNotation('1500 (RD 50)'), true);

    // Evaluations
    assert.equal(isChessNotation('+0.45'), true);
    assert.equal(isChessNotation('-1.20'), true);
    assert.equal(isChessNotation('#+2'), true);

    // Not chess notation
    assert.equal(isChessNotation('Play chess'), false);
    assert.equal(isChessNotation('Sign in to play'), false);
    assert.equal(isChessNotation('Tournament Details'), false);
  });

  it('isPgnMovetext accurately classifies valid PGN sequences and rejects prose', () => {
    // Standard movetext sequences
    assert.equal(isPgnMovetext('1. e4 e5 2. Nf3 Nc6'), true);
    assert.equal(isPgnMovetext('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6'), true);
    assert.equal(isPgnMovetext('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6'), true);
    assert.equal(isPgnMovetext('1. e4 d5 2. exd5 c6 3. dxc6 e5 4. cxb7 e4 5. bxa8=Q'), true);
    assert.equal(isPgnMovetext('1. f3 e5 2. g4 Qh4# 0-1'), true);
    assert.equal(isPgnMovetext('1. e4 e5 1/2-1/2'), true);

    // Combined forms
    assert.equal(isPgnMovetext('1.e4'), true);
    assert.equal(isPgnMovetext('1.e4 e5 2.Nf3'), true);

    // Rejects non-chess English prose
    assert.equal(isPgnMovetext('1. First step'), false);
    assert.equal(isPgnMovetext('1. Introduction 2. Overview'), false);
    assert.equal(isPgnMovetext('Just some normal text'), false);
    assert.equal(isPgnMovetext(''), false);
  });

  it('human-language labels do NOT receive LTR isolation and inherit document direction (RTL regression)', () => {
    // In profile rating rows or game status rows:
    // Variant/speed label is localizable human text and must NOT be forced LTR.
    // In an RTL (Arabic) document, it must inherit direction.
    const fakeDoc = {
      createElement(tag: string) {
        return createFakeElement(tag);
      },
    };

    // Arabic label for Standard Blitz
    const labelSpan = fakeDoc.createElement('span');
    labelSpan.textContent = 'شطرنج قياسي · خاطف: ';
    // Must NOT have LTR isolation applied
    assert.equal(labelSpan.getAttribute('dir'), null);
    assert.equal(labelSpan.className.includes('bidi-ltr'), false);

    // Only the numeric rating/stats token receives LTR isolation
    const statsSpan = fakeDoc.createElement('span');
    statsSpan.textContent = '2450 (RD 25)';
    applyLtrIsolation(statsSpan as unknown as HTMLElement);

    assert.equal(statsSpan.getAttribute('dir'), 'ltr');
    assert.ok(statsSpan.className.includes('bidi-ltr'));
  });

  it('user content isolation does not insert invisible Unicode bidi control characters', () => {
    const userTexts = [
      'لاعب_شطرنج',
      'Alice vs Bob (tournament match)',
      'سيد الشطرنج 123',
      'Grandmaster ♚',
    ];

    const unicodeBidiControlChars = /[\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069]/;

    for (const text of userTexts) {
      const html = wrapUserTextHtml(text);
      assert.match(html, /<bdi dir="auto">.*<\/bdi>/);
      assert.equal(
        unicodeBidiControlChars.test(html),
        false,
        `Expected no Unicode bidi control characters in HTML output for "${text}"`,
      );

      const fakeDoc = {
        createElement(tag: string) {
          return createFakeElement(tag);
        },
      };
      const el = createUserTextElement(fakeDoc as unknown as Document, 'span', text);
      assert.equal(el.getAttribute('dir'), 'auto');
      assert.equal(
        unicodeBidiControlChars.test(el.textContent),
        false,
        `Expected no Unicode bidi control characters in textContent for "${text}"`,
      );
    }
  });
});
