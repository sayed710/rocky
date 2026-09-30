/**
 * Studies view — pure DOM rendering for the studies list, study detail, and chapter notation view.
 */
import type {
  ChapterView,
  CollaboratorView,
  StudyView,
  TreeNodeView,
} from '../api/models.js';
import {
  buildMoveTree,
  formatMovePrefix,
  formatNags,
  type TreeBranchNode,
} from './studies-helpers.js';
import { applyLtrIsolation } from '../i18n/bidi.js';

/**
 * Render the studies list inside `.panel-list`.
 */
export function renderStudyList(
  containerEl: HTMLElement,
  studies: readonly StudyView[],
): void {
  containerEl.replaceChildren();

  if (studies.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'count';
    empty.textContent = 'No studies found.';
    containerEl.appendChild(empty);
    return;
  }

  for (const study of studies) {
    const row = document.createElement('div');
    row.className = 'panel-row';

    const main = document.createElement('div');
    main.className = 'row-main';

    const link = document.createElement('a');
    link.href = `/studies/${study.id}`;
    link.setAttribute('data-route', 'study');
    link.setAttribute('dir', 'auto');
    link.textContent = study.name;
    main.appendChild(link);

    if (study.description) {
      const desc = document.createElement('span');
      desc.className = 'count';
      desc.setAttribute('dir', 'auto');
      desc.textContent = ` \u2014 ${study.description}`;
      main.appendChild(desc);
    }

    row.appendChild(main);

    // Visibility tag is earned: private or unlisted tags appear, public is silent
    if (study.visibility !== 'public') {
      const tag = document.createElement('span');
      tag.className = 'count';
      tag.textContent = study.visibility;
      row.appendChild(tag);
    }

    containerEl.appendChild(row);
  }
}

/**
 * Render study details: header info, chapter list, and collaborators list.
 */
export function renderStudyDetail(
  elements: {
    nameEl: HTMLElement | null;
    descEl: HTMLElement | null;
    visEl: HTMLElement | null;
    exportEl: HTMLAnchorElement | null;
    chaptersEl: HTMLElement | null;
    collabsEl: HTMLElement | null;
  },
  study: StudyView,
  chapters: readonly ChapterView[],
  collaborators: readonly CollaboratorView[],
  exportUrl: string,
): void {
  if (elements.nameEl) {
    elements.nameEl.textContent = study.name;
    elements.nameEl.setAttribute('dir', 'auto');
  }
  if (elements.descEl) {
    elements.descEl.textContent = study.description || 'No description.';
    elements.descEl.setAttribute('dir', 'auto');
  }
  if (elements.visEl) {
    elements.visEl.textContent = study.visibility !== 'public' ? `Visibility: ${study.visibility}` : '';
  }
  if (elements.exportEl) {
    elements.exportEl.href = exportUrl;
  }

  if (elements.chaptersEl) {
    elements.chaptersEl.replaceChildren();
    if (chapters.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'count';
      empty.textContent = 'No chapters in this study.';
      elements.chaptersEl.appendChild(empty);
    } else {
      for (const ch of chapters) {
        const row = document.createElement('div');
        row.className = 'panel-row';

        const main = document.createElement('div');
        main.className = 'row-main';

        const link = document.createElement('a');
        link.href = `/studies/${study.id}/chapters/${ch.id}`;
        link.setAttribute('data-route', 'study-chapter');
        link.setAttribute('dir', 'auto');
        link.textContent = ch.name;
        main.appendChild(link);

        row.appendChild(main);
        elements.chaptersEl.appendChild(row);
      }
    }
  }

  if (elements.collabsEl) {
    elements.collabsEl.replaceChildren();
    if (collaborators.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'count';
      empty.textContent = 'Owner only.';
      elements.collabsEl.appendChild(empty);
    } else {
      for (const col of collaborators) {
        const row = document.createElement('div');
        row.className = 'panel-row';

        const main = document.createElement('div');
        main.className = 'row-main';
        main.textContent = col.playerId;

        const role = document.createElement('span');
        role.className = 'count';
        role.textContent = col.role;

        row.appendChild(main);
        row.appendChild(role);
        elements.collabsEl.appendChild(row);
      }
    }
  }
}

/**
 * Render the chapter view including chapter navigation list and the notation pane.
 */
export function renderChapterDetail(
  elements: {
    studyLinkEl: HTMLAnchorElement | null;
    chapterNameEl: HTMLElement | null;
    exportEl: HTMLAnchorElement | null;
    treeEl: HTMLElement | null;
    navEl: HTMLElement | null;
  },
  study: StudyView,
  chapter: ChapterView,
  flatTree: readonly TreeNodeView[],
  chapters: readonly ChapterView[],
  exportUrl: string,
  onNodeSelect: (fenAfter: string, nodeId: string | null) => void,
): void {
  if (elements.studyLinkEl) {
    elements.studyLinkEl.href = `/studies/${study.id}`;
    elements.studyLinkEl.textContent = study.name;
    elements.studyLinkEl.setAttribute('dir', 'auto');
  }
  if (elements.chapterNameEl) {
    elements.chapterNameEl.textContent = chapter.name;
    elements.chapterNameEl.setAttribute('dir', 'auto');
  }
  if (elements.exportEl) {
    elements.exportEl.href = exportUrl;
  }

  // Render chapter list nav
  if (elements.navEl) {
    elements.navEl.replaceChildren();
    for (const ch of chapters) {
      const row = document.createElement('div');
      row.className = 'panel-row';

      const main = document.createElement('div');
      main.className = 'row-main';

      if (ch.id === chapter.id) {
        const current = document.createElement('span');
        current.className = 'chapter-nav-current';
        current.textContent = `${ch.name} (active)`;
        current.setAttribute('dir', 'auto');
        main.appendChild(current);
      } else {
        const link = document.createElement('a');
        link.href = `/studies/${study.id}/chapters/${ch.id}`;
        link.setAttribute('data-route', 'study-chapter');
        link.setAttribute('dir', 'auto');
        link.textContent = ch.name;
        main.appendChild(link);
      }

      row.appendChild(main);
      elements.navEl.appendChild(row);
    }
  }

  // Render Notation Pane
  if (elements.treeEl) {
    elements.treeEl.replaceChildren();

    const tree = buildMoveTree(flatTree, chapter.startingFen, study.variant);
    let activeNodeId: string | null = null;

    const updateActiveButton = (selectedId: string | null): void => {
      activeNodeId = selectedId;
      const moveBtns = elements.treeEl?.querySelectorAll<HTMLButtonElement>('.notation-move');
      if (moveBtns) {
        for (const btn of moveBtns) {
          const id = btn.getAttribute('data-node-id');
          if (id === activeNodeId) {
            btn.classList.add('active');
            btn.setAttribute('aria-current', 'true');
          } else {
            btn.classList.remove('active');
            btn.removeAttribute('aria-current');
          }
        }
      }
    };

    // Reset button to return to starting FEN
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'notation-start-btn button';
    startBtn.textContent = 'Starting position';
    startBtn.setAttribute('aria-label', 'Reset to starting position');
    startBtn.addEventListener('click', () => {
      updateActiveButton(null);
      onNodeSelect(chapter.startingFen, null);
    });
    elements.treeEl.appendChild(startBtn);

    if (tree.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'count';
      empty.textContent = 'No moves in this chapter.';
      elements.treeEl.appendChild(empty);
      return;
    }

    const container = document.createElement('div');
    container.className = 'notation-content';

    renderBranchNodes(
      container,
      tree,
      { isStartOfBranch: true, afterCommentOrVariation: false },
      (node) => {
        updateActiveButton(node.id);
        onNodeSelect(node.fenAfter, node.id);
      },
    );

    elements.treeEl.appendChild(container);
  }
}

function renderBranchNodes(
  parentContainer: HTMLElement,
  branchNodes: readonly TreeBranchNode[],
  initialContext: { isStartOfBranch: boolean; afterCommentOrVariation: boolean },
  onSelect: (node: TreeNodeView) => void,
): void {
  if (branchNodes.length === 0) return;

  let currentContext = { ...initialContext };

  for (let i = 0; i < branchNodes.length; i++) {
    const item = branchNodes[i]!;
    const node = item.node;

    const prefix = formatMovePrefix(item.turn, item.fullmove, currentContext);
    const nagsStr = formatNags(node.nags);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notation-move';
    applyLtrIsolation(btn);
    btn.setAttribute('data-node-id', node.id);
    btn.setAttribute(
      'aria-label',
      `Move ${item.fullmove} ${item.turn === 'w' ? 'White' : 'Black'} ${node.san}${nagsStr}`,
    );

    if (prefix) {
      const prefixSpan = document.createElement('span');
      prefixSpan.className = 'notation-prefix';
      prefixSpan.textContent = prefix;
      btn.appendChild(prefixSpan);
    }

    const sanSpan = document.createElement('span');
    sanSpan.className = 'notation-san';
    sanSpan.textContent = `${node.san}${nagsStr}`;
    btn.appendChild(sanSpan);

    btn.addEventListener('click', () => onSelect(node));
    parentContainer.appendChild(btn);

    currentContext = { isStartOfBranch: false, afterCommentOrVariation: false };

    // Comment follows move as prose in muted .count voice
    if (node.comment) {
      const commentSpan = document.createElement('span');
      commentSpan.className = 'notation-comment count';
      commentSpan.setAttribute('dir', 'auto');
      commentSpan.textContent = ` (${node.comment}) `;
      parentContainer.appendChild(commentSpan);
      currentContext.afterCommentOrVariation = true;
    }

    // Render variations as indented blocks
    if (item.variations.length > 0) {
      for (const varBranch of item.variations) {
        const varBlock = document.createElement('div');
        varBlock.className = 'notation-variation';

        renderBranchNodes(
          varBlock,
          [varBranch],
          { isStartOfBranch: true, afterCommentOrVariation: false },
          onSelect,
        );

        parentContainer.appendChild(varBlock);
      }
      currentContext.afterCommentOrVariation = true;
    }

    // Continue along mainline
    if (item.mainline) {
      renderBranchNodes(
        parentContainer,
        [item.mainline],
        currentContext,
        onSelect,
      );
    }
  }
}
