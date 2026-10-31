import type { GambitClient } from '../api/client.js';
import type {
  ChapterView,
  CollaboratorView,
  StudyView,
  TreeNodeView,
} from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { StudiesController } from './studies-controller.js';
import type { StudiesCallbacks } from './studies-controller.js';
import type { ClipboardWriter } from './game-pgn-export.js';
import { mountStudyPositionCopy } from './study-position-copy.js';
import type { MountedStudyPositionCopy } from './study-position-copy.js';
import { renderChapterDetail, renderStudyDetail, renderStudyList } from './studies-view.js';

interface StudiesListMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly surface: HTMLElement;
  readonly i18n: I18nManager;
}

interface StudyDetailMountDependencies extends StudiesListMountDependencies {
  readonly studyId: string;
}

interface StudyChapterMountDependencies extends StudyDetailMountDependencies {
  readonly chapterId: string;
  readonly writeClipboard?: ClipboardWriter | null | undefined;
}

interface MountedStudyChapter {
  readonly board: MountedBoard | null;
  readonly studies: StudiesController;
}

interface StudiesListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly searchForm: HTMLFormElement | null;
}

interface StudyDetailElements {
  readonly nameEl: HTMLElement | null;
  readonly descEl: HTMLElement | null;
  readonly visEl: HTMLElement | null;
  readonly exportEl: HTMLAnchorElement | null;
  readonly chaptersEl: HTMLElement | null;
  readonly collabsEl: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface StudyChapterElements {
  readonly studyLinkEl: HTMLAnchorElement | null;
  readonly chapterNameEl: HTMLElement | null;
  readonly exportEl: HTMLAnchorElement | null;
  readonly treeEl: HTMLElement | null;
  readonly navEl: HTMLElement | null;
  readonly error: HTMLElement | null;
}

function renderUnavailable(doc: Document, surface: HTMLElement, i18n: I18nManager): void {
  surface.replaceChildren();
  const message = doc.createElement('p');
  message.className = 'count';
  message.textContent = i18n.t('learning.studies.serviceUnavailable');
  surface.appendChild(message);
}

function studiesListElements(doc: Document): StudiesListElements {
  return {
    list: doc.getElementById('study-list'),
    error: doc.getElementById('studies-error'),
    searchForm: doc.getElementById('study-search-form') as HTMLFormElement | null,
  };
}

function createStudiesListCallbacks(
  elements: StudiesListElements,
  showUnavailable: () => void,
  i18n: I18nManager,
  onListLoaded?: (studies: readonly StudyView[]) => void,
): StudiesCallbacks {
  return {
    onStudyList: (studies) => {
      onListLoaded?.(studies);
      if (elements.error) elements.error.textContent = '';
      if (elements.list) renderStudyList(elements.list, studies, i18n);
    },
    onStudy: () => {},
    onChapterDetail: () => {},
    onLoading: (loading) => {
      if (elements.list) elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

function bindStudySearch(
  doc: Document,
  form: HTMLFormElement | null,
  controller: StudiesController,
): void {
  if (!form) return;
  // The form lives in persistent index markup, so assignment makes the latest route its sole owner.
  form.onsubmit = (event): void => {
    event.preventDefault();
    const input = doc.getElementById('study-search-input') as HTMLInputElement | null;
    const query = input?.value.trim() ?? '';
    void controller.loadStudies(query);
  };
}

export function mountStudiesList({
  doc,
  client,
  surface,
  i18n,
}: StudiesListMountDependencies): StudiesController {
  const elements = studiesListElements(doc);
  let lastStudies: readonly StudyView[] | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new StudiesController({
    client,
    callbacks: createStudiesListCallbacks(
      elements,
      () => renderUnavailable(doc, surface, i18n),
      i18n,
      (studies) => {
        lastStudies = studies;
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastStudies && elements.list) {
      renderStudyList(elements.list, lastStudies, i18n);
    }
  });

  bindStudySearch(doc, elements.searchForm, controller);
  void controller.loadStudies();
  return controller;
}

function studyDetailElements(doc: Document): StudyDetailElements {
  return {
    nameEl: doc.getElementById('study-name'),
    descEl: doc.getElementById('study-description'),
    visEl: doc.getElementById('study-visibility'),
    exportEl: doc.getElementById('study-export-link') as HTMLAnchorElement | null,
    chaptersEl: doc.getElementById('study-chapters'),
    collabsEl: doc.getElementById('study-collaborators'),
    error: doc.getElementById('study-error'),
  };
}

function createStudyDetailCallbacks(
  elements: StudyDetailElements,
  showUnavailable: () => void,
  i18n: I18nManager,
  onStudyLoaded?: (state: {
    study: StudyView;
    chapters: readonly ChapterView[];
    collaborators: readonly CollaboratorView[];
    exportUrl: string;
  }) => void,
): StudiesCallbacks {
  return {
    onStudyList: () => {},
    onStudy: (study, chapters, collaborators, exportUrl) => {
      onStudyLoaded?.({ study, chapters, collaborators, exportUrl });
      if (elements.error) elements.error.textContent = '';
      renderStudyDetail(elements, study, chapters, collaborators, exportUrl, i18n);
    },
    onChapterDetail: () => {},
    onLoading: (loading) => {
      if (elements.chaptersEl) {
        elements.chaptersEl.setAttribute('aria-busy', loading ? 'true' : 'false');
      }
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

export function mountStudyDetail({
  doc,
  client,
  surface,
  studyId,
  i18n,
}: StudyDetailMountDependencies): StudiesController {
  const elements = studyDetailElements(doc);
  let lastStudyState: {
    study: StudyView;
    chapters: readonly ChapterView[];
    collaborators: readonly CollaboratorView[];
    exportUrl: string;
  } | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new StudiesController({
    client,
    callbacks: createStudyDetailCallbacks(
      elements,
      () => renderUnavailable(doc, surface, i18n),
      i18n,
      (state) => {
        lastStudyState = state;
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastStudyState) {
      renderStudyDetail(
        elements,
        lastStudyState.study,
        lastStudyState.chapters,
        lastStudyState.collaborators,
        lastStudyState.exportUrl,
        i18n,
      );
    }
  });

  void controller.loadStudy(studyId);
  return controller;
}

function studyChapterElements(doc: Document): StudyChapterElements {
  return {
    studyLinkEl: doc.getElementById('chapter-study-link') as HTMLAnchorElement | null,
    chapterNameEl: doc.getElementById('chapter-name'),
    exportEl: doc.getElementById('chapter-export-link') as HTMLAnchorElement | null,
    treeEl: doc.getElementById('chapter-tree'),
    navEl: doc.getElementById('chapter-list-nav'),
    error: doc.getElementById('study-chapter-error'),
  };
}

function resetStudyChapterPresentation(
  doc: Document,
  elements: StudyChapterElements,
  boardElement?: HTMLElement | null,
): void {
  if (boardElement) {
    boardElement.hidden = true;
  }
  if (elements.studyLinkEl) {
    elements.studyLinkEl.hidden = true;
    elements.studyLinkEl.textContent = '';
    elements.studyLinkEl.removeAttribute('href');
  }
  if (elements.chapterNameEl) {
    elements.chapterNameEl.hidden = true;
    elements.chapterNameEl.textContent = '';
  }
  if (elements.exportEl) {
    elements.exportEl.hidden = true;
    elements.exportEl.removeAttribute('href');
  }
  if (elements.navEl) {
    elements.navEl.hidden = true;
    elements.navEl.replaceChildren?.();
  }
  if (elements.treeEl) {
    const active = doc.activeElement;
    const isFocusedInsideTree = Boolean(
      active && elements.treeEl.contains?.(active),
    );
    elements.treeEl.replaceChildren?.();
    if (isFocusedInsideTree) {
      const target =
        (elements.error && elements.error.textContent ? elements.error : null) ??
        elements.treeEl;
      if (target) {
        target.tabIndex = -1;
        target.focus?.({ preventScroll: true });
      }
    }
  }
}

interface StudyChapterCallbacksOptions {
  readonly doc: Document;
  readonly elements: StudyChapterElements;
  readonly board: MountedBoard | null;
  readonly boardElement?: HTMLElement | null;
  readonly showUnavailable: () => void;
  readonly i18n: I18nManager;
  readonly positionCopy: MountedStudyPositionCopy;
  readonly onChapterLoaded?: (state: {
    study: StudyView;
    chapter: ChapterView;
    tree: readonly TreeNodeView[];
    chapters: readonly ChapterView[];
    exportUrl: string;
  }) => void;
  readonly onNodeSelected?: (nodeId: string | null) => void;
  readonly onLoadStart?: () => void;
  readonly getGeneration: () => number;
  readonly isDisposed: () => boolean;
  readonly hasValidState: () => boolean;
}

function createStudyChapterCallbacks(options: StudyChapterCallbacksOptions): StudiesCallbacks {
  const {
    doc,
    elements,
    board,
    boardElement,
    showUnavailable,
    i18n,
    positionCopy,
    onChapterLoaded,
    onNodeSelected,
    onLoadStart,
    getGeneration,
    isDisposed,
    hasValidState,
  } = options;

  return {
    onStudyList: () => {},
    onStudy: () => {},
    onChapterDetail: (study, chapter, tree, chapters, exportUrl) => {
      if (isDisposed()) return;
      onChapterLoaded?.({ study, chapter, tree, chapters, exportUrl });
      onNodeSelected?.(null);
      if (elements.error) elements.error.textContent = '';
      if (boardElement) boardElement.hidden = false;
      if (elements.studyLinkEl) elements.studyLinkEl.hidden = false;
      if (elements.chapterNameEl) elements.chapterNameEl.hidden = false;
      if (elements.exportEl) elements.exportEl.hidden = false;
      if (elements.navEl) elements.navEl.hidden = false;
      board?.setPosition(chapter.startingFen);
      positionCopy.setPosition(chapter.startingFen);
      const currentGeneration = getGeneration();
      renderChapterDetail(
        elements,
        study,
        chapter,
        tree,
        chapters,
        exportUrl,
        (fenAfter, nodeId) => {
          if (isDisposed() || !hasValidState() || currentGeneration !== getGeneration()) return;
          onNodeSelected?.(nodeId);
          board?.setPosition(fenAfter);
          positionCopy.setPosition(fenAfter);
        },
        i18n,
        null,
      );
    },
    onLoading: (loading) => {
      if (elements.treeEl) elements.treeEl.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (isDisposed()) return;
      if (loading) {
        if (elements.error) elements.error.textContent = '';
        onLoadStart?.();
        positionCopy.setPosition(null);
        resetStudyChapterPresentation(doc, elements, boardElement);
      }
    },
    onError: (message) => {
      if (isDisposed()) return;
      if (elements.error) elements.error.textContent = message;
      onLoadStart?.();
      positionCopy.setPosition(null);
      resetStudyChapterPresentation(doc, elements, boardElement);
    },
    onUnavailable: () => {
      if (isDisposed()) return;
      onLoadStart?.();
      positionCopy.setPosition(null);
      resetStudyChapterPresentation(doc, elements, boardElement);
      showUnavailable();
    },
  };
}

export function mountStudyChapter({
  doc,
  client,
  surface,
  studyId,
  chapterId,
  i18n,
  writeClipboard,
}: StudyChapterMountDependencies): MountedStudyChapter {
  const boardElement = doc.getElementById('chapter-board');
  const board = boardElement ? mountBoard({ boardEl: boardElement }, { i18n }) : null;
  board?.setTurn(false);

  const positionCopy = mountStudyPositionCopy({
    doc,
    i18n,
    ...(writeClipboard !== undefined ? { writeClipboard } : {}),
  });

  const elements = studyChapterElements(doc);
  resetStudyChapterPresentation(doc, elements, boardElement);
  let lastChapterState: {
    study: StudyView;
    chapter: ChapterView;
    tree: readonly TreeNodeView[];
    chapters: readonly ChapterView[];
    exportUrl: string;
  } | null = null;
  let selectedNodeId: string | null = null;
  let selectionGeneration = 0;
  let unsubscribeLocale: (() => void) | undefined;
  let disposed = false;

  const controller = new StudiesController({
    client,
    callbacks: createStudyChapterCallbacks({
      doc,
      elements,
      board,
      boardElement,
      showUnavailable: () => renderUnavailable(doc, surface, i18n),
      i18n,
      positionCopy,
      onChapterLoaded: (state) => {
        selectionGeneration++;
        lastChapterState = state;
      },
      onNodeSelected: (nodeId) => {
        selectedNodeId = nodeId;
      },
      onLoadStart: () => {
        selectionGeneration++;
        lastChapterState = null;
        selectedNodeId = null;
      },
      getGeneration: () => selectionGeneration,
      isDisposed: () => disposed,
      hasValidState: () => lastChapterState !== null,
    }),
    onDispose: () => {
      if (disposed) return;
      disposed = true;
      selectionGeneration++;
      lastChapterState = null;
      selectedNodeId = null;
      unsubscribeLocale?.();
      positionCopy.dispose();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (disposed) return;
    positionCopy.relocalize();
    if (lastChapterState) {
      selectionGeneration++;
      const currentGeneration = selectionGeneration;
      renderChapterDetail(
        elements,
        lastChapterState.study,
        lastChapterState.chapter,
        lastChapterState.tree,
        lastChapterState.chapters,
        lastChapterState.exportUrl,
        (fenAfter, nodeId) => {
          if (disposed || !lastChapterState || currentGeneration !== selectionGeneration) return;
          selectedNodeId = nodeId;
          board?.setPosition(fenAfter);
          positionCopy.setPosition(fenAfter);
        },
        i18n,
        selectedNodeId,
      );
    }
  });

  void controller.loadChapter(studyId, chapterId);
  return { board, studies: controller };
}
