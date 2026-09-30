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
import { renderChapterDetail, renderStudyDetail, renderStudyList } from './studies-view.js';

interface StudiesListMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly surface: HTMLElement;
  readonly i18n?: I18nManager | undefined;
}

interface StudyDetailMountDependencies extends StudiesListMountDependencies {
  readonly studyId: string;
}

interface StudyChapterMountDependencies extends StudyDetailMountDependencies {
  readonly chapterId: string;
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

function renderUnavailable(doc: Document, surface: HTMLElement, i18n?: I18nManager): void {
  surface.replaceChildren();
  const message = doc.createElement('p');
  message.className = 'count';
  message.textContent = i18n ? i18n.t('learning.studies.serviceUnavailable') : 'Studies service unavailable.';
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
  i18n?: I18nManager,
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

  unsubscribeLocale = i18n?.onLocaleChange(() => {
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
  i18n?: I18nManager,
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

  unsubscribeLocale = i18n?.onLocaleChange(() => {
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

function createStudyChapterCallbacks(
  elements: StudyChapterElements,
  board: MountedBoard | null,
  showUnavailable: () => void,
  i18n?: I18nManager,
  onChapterLoaded?: (state: {
    study: StudyView;
    chapter: ChapterView;
    tree: readonly TreeNodeView[];
    chapters: readonly ChapterView[];
    exportUrl: string;
  }) => void,
): StudiesCallbacks {
  return {
    onStudyList: () => {},
    onStudy: () => {},
    onChapterDetail: (study, chapter, tree, chapters, exportUrl) => {
      onChapterLoaded?.({ study, chapter, tree, chapters, exportUrl });
      if (elements.error) elements.error.textContent = '';
      board?.setPosition(chapter.startingFen);
      renderChapterDetail(
        elements,
        study,
        chapter,
        tree,
        chapters,
        exportUrl,
        (fenAfter) => {
          board?.setPosition(fenAfter);
        },
        i18n,
      );
    },
    onLoading: (loading) => {
      if (elements.treeEl) elements.treeEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onUnavailable: showUnavailable,
  };
}

export function mountStudyChapter({
  doc,
  client,
  surface,
  studyId,
  chapterId,
  i18n,
}: StudyChapterMountDependencies): MountedStudyChapter {
  const boardElement = doc.getElementById('chapter-board');
  const board = boardElement ? mountBoard({ boardEl: boardElement }) : null;
  board?.setTurn(false);

  const elements = studyChapterElements(doc);
  let lastChapterState: {
    study: StudyView;
    chapter: ChapterView;
    tree: readonly TreeNodeView[];
    chapters: readonly ChapterView[];
    exportUrl: string;
  } | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new StudiesController({
    client,
    callbacks: createStudyChapterCallbacks(
      elements,
      board,
      () => renderUnavailable(doc, surface, i18n),
      i18n,
      (state) => {
        lastChapterState = state;
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n?.onLocaleChange(() => {
    if (lastChapterState) {
      renderChapterDetail(
        elements,
        lastChapterState.study,
        lastChapterState.chapter,
        lastChapterState.tree,
        lastChapterState.chapters,
        lastChapterState.exportUrl,
        (fenAfter) => {
          board?.setPosition(fenAfter);
        },
        i18n,
      );
    }
  });

  void controller.loadChapter(studyId, chapterId);
  return { board, studies: controller };
}
