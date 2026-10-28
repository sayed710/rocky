import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClipboardWriter } from '../src/app/game-pgn-export.js';
import { mountStudyPositionCopy } from '../src/app/study-position-copy.js';
import { createI18nManager } from '../src/i18n/index.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createHarness(options?: { locale?: 'en' | 'ar'; writer?: ClipboardWriter | null }) {
  const btn = new FakeElement('button', 'study-position-copy');
  const status = new FakeElement('div', 'study-position-status');
  const error = new FakeElement('div', 'study-position-error');
  const doc = createFakeDoc(new Map([['study-position-copy', btn], ['study-position-status', status], ['study-position-error', error]])) as unknown as Document;
  const i18n = createI18nManager({ initialLocale: options?.locale ?? 'en' });
  const writes: string[] = [];
  const defaultWriter: ClipboardWriter = async (p) => { writes.push(await p); };
  const writeClipboard = options?.writer !== undefined ? options.writer : defaultWriter;
  const mount = mountStudyPositionCopy({ doc, i18n, writeClipboard });
  return { doc, btn, status, error, i18n, writes, mount };
}

describe('mountStudyPositionCopy', () => {
  it('SC01: copies exact bytes without implicit copy or FEN reconstruction', async () => {
    const { mount, btn, status, writes, i18n } = createHarness();
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const variantFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[QQqq] w KQkq - 0 1';
    mount.setPosition(startFen);
    assert.equal(writes.length, 0);
    btn.click();
    await flush();
    assert.deepEqual(writes, [startFen]);
    assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));
    mount.setPosition(variantFen);
    assert.equal(writes.length, 1);
    btn.click();
    await flush();
    assert.deepEqual(writes, [startFen, variantFen]);
    mount.dispose();
  });

  it('SC02: invokes writer synchronously, holds focus, and manages pending state', async () => {
    let invoked = 0;
    let resolvePending!: () => void;
    const pendingPromise = new Promise<void>((res) => { resolvePending = res; });
    const writer: ClipboardWriter = async (p) => { invoked += 1; await p; await pendingPromise; };
    const { mount, btn, status, i18n, doc } = createHarness({ writer });
    mount.setPosition('8/8/8/8/8/8/8/k6K w - - 0 1');

    assert.equal(btn.getAttribute('aria-disabled'), 'false');
    btn.focus();
    btn.click();
    assert.equal(invoked, 1);
    assert.equal(doc.activeElement, btn);
    assert.equal(btn.disabled, false);
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(btn.textContent, i18n.t('learning.studies.copyingFen'));
    assert.equal(status.textContent, '');

    btn.click();
    assert.equal(invoked, 1);
    resolvePending();
    await flush();

    assert.equal(btn.getAttribute('aria-disabled'), 'false');
    assert.equal(btn.textContent, i18n.t('learning.studies.copyFen'));
    assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));
    mount.dispose();
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`SC02 (A->B->A ${outcome}): suppresses stale feedback and verifies snapshotted FEN`, async () => {
      let settle!: () => void;
      let snapshotted: string | null = null;
      const writerPromise = new Promise<void>((res, rej) => {
        settle = outcome === 'resolve' ? res : () => rej(new Error('fail'));
      });
      const writer: ClipboardWriter = async (p) => { snapshotted = await p; await writerPromise; };
      const fenA = '8/8/8/8/8/8/8/k6K w - - 0 1';
      const fenB = '8/8/8/8/8/8/8/K6k w - - 0 1';
      const { mount, btn, status, error } = createHarness({ writer });

      mount.setPosition(fenA);
      btn.click();
      await flush();
      assert.equal(snapshotted, fenA);

      mount.setPosition(fenB);
      mount.setPosition(fenA);
      settle();
      await flush();

      assert.equal(status.textContent, '');
      assert.equal(error.textContent, '');
      assert.equal(btn.getAttribute('aria-disabled'), 'false');
      mount.dispose();
    });
  }

  for (const variant of [
    { name: 'sync throw', fail: (): Promise<void> => { throw new Error('sync'); } },
    { name: 'promise rejection', fail: (): Promise<void> => Promise.reject(new Error('async')) },
  ]) {
    it(`SC02 (${variant.name}): exposes localized error, relocalizes it, and allows retry`, async () => {
      let shouldFail = true;
      const writes: string[] = [];
      const writer: ClipboardWriter = (p) => shouldFail ? variant.fail() : p.then((t) => { writes.push(t); });
      const { mount, btn, error, status, i18n } = createHarness({ writer });
      mount.setPosition('8/8/8/8/8/8/8/k6K w - - 0 1');

      btn.click();
      await flush();
      assert.equal(error.textContent, i18n.t('learning.studies.copyFenError'));
      assert.equal(btn.getAttribute('aria-disabled'), 'false');

      await i18n.setLocale('ar');
      mount.relocalize();
      assert.equal(error.textContent, i18n.t('learning.studies.copyFenError'));

      await i18n.setLocale('en');
      mount.relocalize();
      assert.equal(error.textContent, i18n.t('learning.studies.copyFenError'));

      shouldFail = false;
      btn.click();
      await flush();
      assert.equal(writes.length, 1);
      assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));
      assert.equal(error.textContent, '');
      mount.dispose();
    });
  }

  it('SC03: hides controls when target null/empty or no API, and pending settle cannot revive', async () => {
    let resolvePending!: () => void;
    const pendingPromise = new Promise<void>((res) => { resolvePending = res; });
    const { mount, btn, status, error, i18n } = createHarness({ writer: () => pendingPromise });
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    assert.equal(btn.hidden, true);
    mount.setPosition('');
    assert.equal(btn.hidden, true);

    const noApi = createHarness({ writer: null });
    noApi.mount.setPosition(fen);
    assert.equal(noApi.btn.hidden, true);
    noApi.mount.dispose();

    mount.setPosition(fen);
    assert.equal(btn.hidden, false);
    btn.click();
    assert.equal(btn.textContent, i18n.t('learning.studies.copyingFen'));
    mount.setPosition(null);
    assert.equal(btn.hidden, true);
    assert.equal(status.textContent, '');
    assert.equal(error.textContent, '');

    resolvePending();
    await flush();
    assert.equal(btn.hidden, true);
    assert.equal(status.textContent, '');
    mount.dispose();
  });

  it('SC04: preserves selection and focus across EN->AR->EN relocalize and clears success on change', async () => {
    const { mount, btn, status, writes, i18n, doc } = createHarness();
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    mount.setPosition(fen);
    btn.focus();
    assert.equal(doc.activeElement, btn);
    assert.equal(btn.textContent, i18n.t('learning.studies.copyFen'));

    await i18n.setLocale('ar');
    mount.relocalize();
    assert.equal(btn.textContent, i18n.t('learning.studies.copyFen'));
    assert.equal(doc.activeElement, btn);
    assert.equal(writes.length, 0);

    btn.click();
    await flush();
    assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));

    await i18n.setLocale('en');
    mount.relocalize();
    assert.equal(btn.textContent, i18n.t('learning.studies.copyFen'));
    assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));
    assert.equal(doc.activeElement, btn);

    mount.setPosition('8/8/8/8/8/8/8/k6K w - - 0 1');
    assert.equal(status.textContent, '');
    mount.dispose();
  });

  it('SC05: dispose while pending and second dispose do not clear new mount on same doc', async () => {
    let resolveMount1!: () => void;
    let writer1Invoked = 0;
    const mount1Promise = new Promise<void>((res) => { resolveMount1 = res; });
    const writes1: string[] = [];
    const writer1: ClipboardWriter = async (p) => {
      writer1Invoked += 1;
      writes1.push(await p);
      await mount1Promise;
    };
    const writes2: string[] = [];
    const writer2: ClipboardWriter = async (p) => { writes2.push(await p); };
    const { doc, btn, status, i18n, mount: mount1 } = createHarness({ writer: writer1 });
    const fen1 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fen2 = '8/8/8/8/8/8/8/k6K w - - 0 1';

    mount1.setPosition(fen1);
    btn.click();
    assert.equal(writer1Invoked, 1);
    mount1.dispose();

    const mount2 = mountStudyPositionCopy({ doc, i18n, writeClipboard: writer2 });
    mount2.setPosition(fen2);
    assert.equal(btn.hidden, false);

    resolveMount1();
    await flush();
    assert.deepEqual(writes1, [fen1]);
    mount1.dispose();

    assert.equal(btn.hidden, false);
    btn.click();
    await flush();

    assert.deepEqual(writes2, [fen2]);
    assert.equal(writer1Invoked, 1);
    assert.equal(status.textContent, i18n.t('learning.studies.copiedFen'));
    mount2.dispose();
  });
});
