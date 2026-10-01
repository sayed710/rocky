/**
 * Tests for Passkeys UI rendering.
 *
 * Verifies empty states, row generation, accessible button names, and callback wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPasskeys } from '../src/app/passkeys-view.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { PasskeyView } from '../src/api/models.js';

const testI18n = createI18nManager();

class FakeHTMLElement {
  innerHTML = '';
  children: FakeHTMLElement[] = [];
  classList = new Set<string>();
  attributes = new Map<string, string>();
  textContent = '';
  type = '';
  disabled = false;
  listeners: Record<string, Array<() => void>> = {};

  className = '';

  appendChild(child: FakeHTMLElement) {
    this.children.push(child);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(event: string, fn: () => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  get ownerDocument() {
    return {
      createElement: (_tag: string) => new FakeHTMLElement() as unknown as HTMLElement,
    } as unknown as Document;
  }
}

test('renderPasskeys: empty list renders the inline empty state', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;

  renderPasskeys(container, [], () => {}, false, testI18n);

  const html = (container as unknown as FakeHTMLElement).innerHTML;
  // renderEmpty replaces contents and appends a wrapper.
  const wrapper = (container as unknown as FakeHTMLElement).children[0]!;
  assert.equal(wrapper.className, 'empty empty-inline');
  assert.equal(wrapper.children[0]!.textContent, 'No passkeys registered yet');
});

test('renderPasskeys: list renders rows with accessible delete buttons and correct callback IDs', () => {
  const container = new FakeHTMLElement() as unknown as HTMLElement;

  const passkeys: PasskeyView[] = [
    { id: 'cred-1', name: 'MacBook', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'cred-2', name: '', createdAt: '2026-02-02T12:00:00Z' },
  ];

  let deletedId: string | null = null;
  const onDelete = (id: string) => {
    deletedId = id;
  };

  renderPasskeys(container, passkeys, onDelete, false, testI18n);

  const children = (container as unknown as FakeHTMLElement).children;
  assert.equal(children.length, 2);

  const firstRow = children[0]!;
  assert.equal(firstRow.className, 'panel-row');
  assert.equal(firstRow.children[0]!.textContent, 'MacBook (2026-01-01)');

  const firstBtnGroup = firstRow.children[1]!;
  assert.equal(firstBtnGroup.className, 'panel-row-actions');
  const firstBtn = firstBtnGroup.children[0]!;
  assert.equal(firstBtn.getAttribute('aria-label'), 'Delete MacBook (2026-01-01)');

  const secondRow = children[1]!;
  const secondBtn = secondRow.children[1]!.children[0]!;
  assert.equal(secondBtn.getAttribute('aria-label'), 'Delete Passkey (2026-02-02)');

  firstBtn.listeners['click']![0]!();
  assert.equal(deletedId, 'cred-1');

  secondBtn.listeners['click']![0]!();
  assert.equal(deletedId, 'cred-2');
});
