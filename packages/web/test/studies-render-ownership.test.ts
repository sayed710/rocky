import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChapterDetail } from '../src/app/studies-view.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { StudyView, ChapterView, TreeNodeView } from '../src/api/models.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const D4_FEN = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

// Sacred regression test: retained move/start buttons from prior chapter renders
// must not mutate active aria-current state or invoke callbacks on subsequent render trees.
test('retained buttons from prior render do not mutate active state in new render tree', () => {
  const doc = createFakeDoc();
  const tree = new FakeElement('div');
  (tree as unknown as { ownerDocument: unknown }).ownerDocument = doc;

  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: doc,
    configurable: true,
    writable: true,
  });

  try {
    const study: StudyView = {
      id: 's1', ownerId: 'u1', name: 'Study', description: '',
      visibility: 'public', variant: 'standard',
      createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
    };
    const chapter1: ChapterView = {
      id: 'c1', studyId: 's1', name: 'Chapter', orderIndex: 0, startingFen: START_FEN,
    };
    const chapter2: ChapterView = {
      id: 'c2', studyId: 's1', name: 'Chapter 2', orderIndex: 1, startingFen: START_FEN,
    };
    const oldNode: TreeNodeView = {
      id: 'old', chapterId: 'c1', parentId: null, san: 'e4', fenAfter: E4_FEN, nags: [], orderIndex: 0,
    };
    const newNode: TreeNodeView = {
      id: 'new', chapterId: 'c2', parentId: null, san: 'd4', fenAfter: D4_FEN, nags: [], orderIndex: 0,
    };

    const i18n = createI18nManager({ initialLocale: 'en' });
    const elements = {
      studyLinkEl: null,
      chapterNameEl: null,
      exportEl: null,
      treeEl: tree as unknown as HTMLElement,
      navEl: null,
    };

    const oldSelections: Array<{ fen: string; nodeId: string | null }> = [];
    const newSelections: Array<{ fen: string; nodeId: string | null }> = [];

    renderChapterDetail(
      elements, study, chapter1, [oldNode], [chapter1], '',
      (fen, id) => { oldSelections.push({ fen, nodeId: id }); }, i18n, null,
    );

    const oldMoves = tree.querySelectorAll('.notation-move');
    const oldMoveBtn = oldMoves[0];
    const oldStartBtn = tree.querySelector('.notation-start-btn');
    assert.ok(oldMoveBtn, 'old move button should exist');
    assert.ok(oldStartBtn, 'old start button should exist');

    renderChapterDetail(
      elements, study, chapter2, [newNode], [chapter1, chapter2], '',
      (fen, id) => { newSelections.push({ fen, nodeId: id }); }, i18n, 'new',
    );

    const newMoves = tree.querySelectorAll('.notation-move');
    const newMoveBtn = newMoves[0];
    const newStartBtn = tree.querySelector('.notation-start-btn');
    assert.ok(newMoveBtn, 'new move button should exist');
    assert.ok(newStartBtn, 'new start button should exist');

    assert.equal(newMoveBtn.getAttribute('aria-current'), 'true');
    oldMoveBtn.click();
    oldStartBtn.click();
    assert.equal(newMoveBtn.getAttribute('aria-current'), 'true');
    assert.deepEqual(oldSelections, []);

    newStartBtn.click();
    assert.notEqual(newMoveBtn.getAttribute('aria-current'), 'true');

    newMoveBtn.click();
    assert.equal(newMoveBtn.getAttribute('aria-current'), 'true');
    assert.deepEqual(newSelections, [
      { fen: START_FEN, nodeId: null },
      { fen: D4_FEN, nodeId: 'new' },
    ]);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
