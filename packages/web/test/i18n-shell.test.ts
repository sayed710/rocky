import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../src/i18n/manager.js';
import { localizeShell } from '../src/i18n/shell.js';

interface FakeHtmlElement {
  tagName: string;
  textContent: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function createFakeElement(
  tagName: string,
  dataset: Record<string, string> = {},
): FakeHtmlElement {
  return {
    tagName: tagName.toUpperCase(),
    textContent: '',
    dataset,
    attributes: {},
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
  };
}

describe('i18n shell translator', () => {
  it('localizes text content, aria-label, and placeholder in template shell', () => {
    const textNode = createFakeElement('span', { i18n: 'shell.brand' });
    const ariaNode = createFakeElement('button', { i18nAriaLabel: 'shell.flipBoardAria' });
    const inputNode = createFakeElement('input', { i18nPlaceholder: 'nav.searchPlaceholder' });

    const mockDoc = {
      querySelectorAll(selector: string) {
        if (selector === '[data-i18n]') return [textNode];
        if (selector === '[data-i18n-aria-label]') return [ariaNode];
        if (selector === '[data-i18n-placeholder]') return [inputNode];
        if (selector === '[data-i18n-title]') return [];
        if (selector === '[data-i18n-alt]') return [];
        return [];
      },
    };

    const i18n = createI18n();
    const handle = localizeShell(mockDoc as unknown as Document, i18n);

    assert.equal(textNode.textContent, 'Rookzen');
    assert.equal(ariaNode.getAttribute('aria-label'), 'Flip board');
    assert.equal(inputNode.getAttribute('placeholder'), 'Search');

    handle.dispose();
  });
});
