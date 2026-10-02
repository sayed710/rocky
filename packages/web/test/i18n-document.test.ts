import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentLocale } from '../src/i18n/document.js';

interface FakeDocumentElement {
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

interface FakeDocument {
  documentElement: FakeDocumentElement;
}

function createFakeDocument(): FakeDocument {
  return {
    documentElement: {
      attributes: {},
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      },
    },
  };
}

describe('i18n document plumbing', () => {
  it('applies en locale and ltr direction to documentElement', () => {
    const doc = createFakeDocument();
    applyDocumentLocale('en', doc as unknown as Document);

    assert.equal(doc.documentElement.getAttribute('lang'), 'en');
    assert.equal(doc.documentElement.getAttribute('dir'), 'ltr');
  });

  it('applies ar locale and rtl direction to documentElement', () => {
    const doc = createFakeDocument();
    applyDocumentLocale('ar', doc as unknown as Document);

    assert.equal(doc.documentElement.getAttribute('lang'), 'ar');
    assert.equal(doc.documentElement.getAttribute('dir'), 'rtl');
  });

  it('updates attributes idempotently without throwing', () => {
    const doc = createFakeDocument();
    applyDocumentLocale('en', doc as unknown as Document);
    applyDocumentLocale('en', doc as unknown as Document);

    assert.equal(doc.documentElement.getAttribute('lang'), 'en');
    assert.equal(doc.documentElement.getAttribute('dir'), 'ltr');
  });
});
