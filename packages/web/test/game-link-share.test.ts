import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGameLink, mountGameLinkShare } from '../src/app/game-link-share.js';
import type { ClipboardWriter } from '../src/app/game-pgn-export.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { createI18nManager } from '../src/i18n/index.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

const triggerClick = (el: FakeElement) =>
  typeof (el as unknown as { click?: () => void }).click === 'function'
    ? (el as unknown as { click: () => void }).click()
    : el.dispatchEvent(new Event('click'));

function createFixture(href?: string) {
  const copyButton = new FakeElement('button');
  const sharingEl = new FakeElement('div');
  const statusEl = new FakeElement('div');
  const errorEl = new FakeElement('div');
  const doc = createFakeDoc(new Map([
    ['game-link-copy', copyButton],
    ['game-sharing', sharingEl],
    ['game-link-status', statusEl],
    ['game-link-error', errorEl],
  ]));
  if (href !== undefined) {
    Object.defineProperty(doc, 'defaultView', {
      value: { location: { href }, navigator: {} },
      writable: true,
      configurable: true,
    });
  }
  return { doc, copyButton, sharingEl, statusEl, errorEl };
}

describe('game-link-share', () => {
  describe('canonicalGameLink', () => {
    it('formats canonical HTTP/HTTPS origin, preserves gameId case, and drops userinfo/query/hash/path', () => {
      const { doc: doc1 } = createFixture('https://user:pass@chess.example.com:8443/lobby/live?token=secret#section');
      assert.equal(canonicalGameLink(doc1, 'Game-Test_1'), 'https://chess.example.com:8443/game/Game-Test_1');

      const { doc: doc2 } = createFixture('http://localhost:3000/arbitrary/path?param=1#top');
      assert.equal(canonicalGameLink(doc2, 'g1'), 'http://localhost:3000/game/g1');
    });

    it('accepts safe IDs and rejects forbidden/unsafe IDs', () => {
      const { doc } = createFixture('https://chess.example.com/');
      for (const id of ['f47ac10b-58cc-4372-a567-0e02b2c3d479', 'g1', 'g-test-1', 'GAME_99']) {
        assert.equal(canonicalGameLink(doc, id), `https://chess.example.com/game/${id}`);
      }
      for (const id of ['', 'g.1', 'g/1', 'g\\1', 'g?1', 'g#1', 'g%201', 'g 1', 'g\t1', 'g\u200E1', 'g\u202A1']) {
        assert.equal(canonicalGameLink(doc, id), null);
      }
    });

    it('rejects non-http(s) protocols, missing defaultView, and malformed URLs', () => {
      for (const href of ['ftp://chess.org/game', 'file:///app.html', 'javascript:alert(1)', 'blob:https://a.com/1', '::bad::']) {
        assert.equal(canonicalGameLink(createFixture(href).doc, 'g1'), null);
      }
      assert.equal(canonicalGameLink(createFixture().doc, 'g1'), null);
    });
  });

  describe('mountGameLinkShare - setup and visibility', () => {
    it('unhides button and parent container on mount, clearing stale status/error', () => {
      const f = createFixture('https://chess.example.com/game/g1');
      f.copyButton.hidden = true; f.sharingEl.hidden = true;
      f.statusEl.textContent = 'stale'; f.errorEl.textContent = 'stale';
      const handle = mountGameLinkShare({ doc: f.doc, gameId: 'g1', i18n: createI18nManager({ initialLocale: 'en' }), writeClipboard: async () => {} });
      assert.equal(f.copyButton.hidden, false);
      assert.equal(f.sharingEl.hidden, false);
      assert.equal(f.statusEl.hidden, false);
      assert.equal(f.statusEl.textContent, '');
      assert.equal(f.errorEl.textContent, '');
      handle.dispose();
    });

    it('hides button and parent and clears status/error when writer is null or inputs invalid', () => {
      for (const tc of [
        { href: 'https://chess.example.com/', id: 'g1', writer: null },
        { href: 'https://chess.example.com/', id: 'bad.id', writer: async () => {} },
        { href: 'ftp://chess.example.com/', id: 'g1', writer: async () => {} },
      ]) {
        const f = createFixture(tc.href);
        f.statusEl.textContent = 'stale'; f.errorEl.textContent = 'stale';
        const handle = mountGameLinkShare({ doc: f.doc, gameId: tc.id, i18n: createI18nManager({ initialLocale: 'en' }), writeClipboard: tc.writer });
        assert.equal(f.copyButton.hidden, true);
        assert.equal(f.sharingEl.hidden, true);
        assert.equal(f.statusEl.textContent, '');
        assert.equal(f.errorEl.textContent, '');
        handle.dispose();
      }
    });

    it('handles missing optional elements gracefully without throwing', () => {
      const doc = createFakeDoc(new Map());
      const handle = mountGameLinkShare({ doc, gameId: 'g1', i18n: createI18nManager({ initialLocale: 'en' }), writeClipboard: async () => {} });
      assert.doesNotThrow(() => { handle.relocalize(); handle.dispose(); });
    });
  });

  describe('mountGameLinkShare - click, single-flight, and execution', () => {
    it('calls writer synchronously with Promise<string> before click returns and preserves focus with aria-disabled', async () => {
      const f = createFixture('https://chess.example.com/lobby');
      const i18n = createI18nManager({ initialLocale: 'en' });
      const deferred = createDeferred<void>();
      let receivedPromise: Promise<string> | null = null;
      let callCount = 0;

      const handle = mountGameLinkShare({
        doc: f.doc,
        gameId: 'g-test-1',
        i18n,
        writeClipboard: (p) => { callCount++; receivedPromise = p; return deferred.promise; },
      });

      assert.equal(f.copyButton.textContent, i18n.t('game.share.copyLink'));
      triggerClick(f.copyButton);
      assert.equal(callCount, 1, 'writer must be called synchronously before click returns');
      assert.equal(f.copyButton.getAttribute('aria-disabled'), 'true');
      assert.equal(f.copyButton.disabled, false);
      assert.equal(f.copyButton.textContent, i18n.t('game.share.copying'));
      assert.equal(f.statusEl.hidden, false);
      assert.equal(f.statusEl.textContent, '');

      triggerClick(f.copyButton); // duplicate click blocked while pending
      assert.equal(callCount, 1);

      deferred.resolve();
      await flush();

      assert.equal(f.copyButton.getAttribute('aria-disabled'), 'false');
      assert.equal(f.copyButton.textContent, i18n.t('game.share.copyLink'));
      assert.equal(f.statusEl.hidden, false);
      assert.equal(f.statusEl.textContent, i18n.t('game.share.copied'));
      assert.equal(f.errorEl.hidden, true);
      assert.equal(await receivedPromise, 'https://chess.example.com/game/g-test-1');
      handle.dispose();
    });
  });

  describe('mountGameLinkShare - error handling and retry', () => {
    it('handles promise rejection with generic translated error and allows retry', async () => {
      const f = createFixture('https://chess.example.com/');
      const i18n = createI18nManager({ initialLocale: 'en' });
      let fail = true;
      let callCount = 0;

      const handle = mountGameLinkShare({
        doc: f.doc,
        gameId: 'g1',
        i18n,
        writeClipboard: async () => {
          callCount++;
          if (fail) throw new Error('DOMException: Clipboard denied');
        },
      });

      triggerClick(f.copyButton);
      await flush();
      assert.equal(callCount, 1);
      assert.equal(f.copyButton.getAttribute('aria-disabled'), 'false');
      assert.equal(f.errorEl.hidden, false);
      assert.equal(f.errorEl.textContent, i18n.t('game.share.copyError'));

      fail = false;
      triggerClick(f.copyButton); // retry succeeds
      await flush();
      assert.equal(callCount, 2);
      assert.equal(f.statusEl.textContent, i18n.t('game.share.copied'));
      assert.equal(f.errorEl.hidden, true);
      assert.equal(f.errorEl.textContent, '');
      handle.dispose();
    });

    it('handles synchronous writer exception safely', async () => {
      const f = createFixture('https://chess.example.com/');
      const i18n = createI18nManager({ initialLocale: 'en' });
      const handle = mountGameLinkShare({ doc: f.doc, gameId: 'g1', i18n, writeClipboard: () => { throw new Error('sync failure'); } });
      assert.doesNotThrow(() => triggerClick(f.copyButton));
      await flush();
      assert.equal(f.errorEl.hidden, false);
      assert.equal(f.errorEl.textContent, i18n.t('game.share.copyError'));
      handle.dispose();
    });
  });

  describe('mountGameLinkShare - lifecycle and relocalization', () => {
    it('prevents clipboard writes when clicked after disposal in idle or settled state', async () => {
      const f = createFixture('https://chess.example.com/');
      const i18n = createI18nManager({ initialLocale: 'en' });
      let callCount = 0;

      const idleHandle = mountGameLinkShare({
        doc: f.doc,
        gameId: 'g1',
        i18n,
        writeClipboard: async () => { callCount++; },
      });
      idleHandle.dispose();
      triggerClick(f.copyButton);
      assert.equal(callCount, 0, 'click after idle disposal must not trigger write');

      const settledHandle = mountGameLinkShare({
        doc: f.doc,
        gameId: 'g1',
        i18n,
        writeClipboard: async () => { callCount++; },
      });
      triggerClick(f.copyButton);
      await flush();
      assert.equal(callCount, 1);
      settledHandle.dispose();

      triggerClick(f.copyButton);
      assert.equal(callCount, 1, 'click after settled disposal must not trigger write');
    });

    it('suppresses feedback on late resolve and late reject after disposal', async () => {
      const f = createFixture('https://chess.example.com/');
      const i18n = createI18nManager({ initialLocale: 'en' });

      for (const isReject of [false, true]) {
        const deferred = createDeferred<void>();
        let callCount = 0;
        const handle = mountGameLinkShare({
          doc: f.doc,
          gameId: 'g1',
          i18n,
          writeClipboard: () => { callCount++; return deferred.promise; },
        });

        triggerClick(f.copyButton);
        assert.equal(callCount, 1);
        handle.dispose();

        f.statusEl.textContent = 'prior-feedback';
        f.errorEl.textContent = 'prior-feedback';

        if (isReject) {
          deferred.reject(new Error('late failure'));
        } else {
          deferred.resolve();
        }
        await flush();

        assert.equal(f.statusEl.textContent, 'prior-feedback');
        assert.equal(f.errorEl.textContent, 'prior-feedback');
      }
    });

    it('relocalizes pending, success, and error states using actual i18n translations in EN and AR', async () => {
      const f = createFixture('https://chess.example.com/');
      const i18n = createI18nManager({ initialLocale: 'en' });
      let shouldFail = false;
      const deferred = createDeferred<void>();
      let useDeferred = false;

      const handle = mountGameLinkShare({
        doc: f.doc,
        gameId: 'g1',
        i18n,
        writeClipboard: async () => {
          if (useDeferred) return deferred.promise;
          if (shouldFail) throw new Error('failure');
        },
      });

      await i18n.setLocale('ar');
      handle.relocalize();
      assert.equal(f.copyButton.textContent, i18n.t('game.share.copyLink'));

      await i18n.setLocale('en');
      handle.relocalize();
      triggerClick(f.copyButton);
      await flush();
      assert.equal(f.statusEl.textContent, i18n.t('game.share.copied'));
      await i18n.setLocale('ar');
      handle.relocalize();
      assert.equal(f.statusEl.textContent, i18n.t('game.share.copied'));

      shouldFail = true;
      triggerClick(f.copyButton);
      await flush();
      assert.equal(f.errorEl.textContent, i18n.t('game.share.copyError'));
      await i18n.setLocale('en');
      handle.relocalize();
      assert.equal(f.errorEl.textContent, i18n.t('game.share.copyError'));

      useDeferred = true;
      triggerClick(f.copyButton);
      await i18n.setLocale('ar');
      handle.relocalize();
      assert.equal(f.copyButton.textContent, i18n.t('game.share.copying'));
      deferred.resolve();
      await flush();
      handle.dispose();
    });
  });
});
