/**
 * DOM renderers for the learning UI (courses, lessons, steps).
 */
import type {
  AttemptResultView,
  CourseProgressSummaryView,
  CourseView,
  LessonView,
  StepView,
} from '../api/models.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18nManager } from '../i18n/manager.js';
import { mountBoard } from './board.js';
import { difficultyLabel, courseProgressLabel, stepStatusLabel } from './learning-helpers.js';
import { renderEmpty } from './render-helpers.js';

/**
 * Render the list of published courses.
 */
export function renderCourseList(
  container: HTMLElement,
  courses: readonly CourseView[],
  i18n: I18nManager,
): void {
  container.innerHTML = '';
  if (courses.length === 0) {
    renderEmpty(container, {
      mark: '♟',
      title: i18n.t('learning.emptyCoursesTitle'),
      body: i18n.t('learning.emptyCoursesBody'),
      inline: true,
    });
    return;
  }

  for (const course of courses) {
    const row = document.createElement('div');
    row.className = 'panel-row';

    const main = document.createElement('div');
    main.className = 'row-main';

    const titleLink = document.createElement('a');
    titleLink.href = `/courses/${encodeURIComponent(course.slug)}`;
    titleLink.dataset.route = 'course';
    titleLink.textContent = course.title;
    applyAutoDirection(titleLink);
    main.appendChild(titleLink);

    if (course.description) {
      const desc = document.createElement('span');
      desc.className = 'count';
      desc.textContent = course.description;
      applyAutoDirection(desc);
      main.appendChild(desc);
    }
    row.appendChild(main);

    const difficulty = document.createElement('span');
    difficulty.className = 'count';
    difficulty.textContent = difficultyLabel(course.difficulty, i18n);
    row.appendChild(difficulty);

    container.appendChild(row);
  }
}

/**
 * Render course details and its lesson list.
 */
export function renderCourseDetail(
  container: HTMLElement,
  course: CourseView,
  lessons: readonly LessonView[],
  progress: CourseProgressSummaryView | null,
  i18n: I18nManager,
): void {
  const titleEl = container.querySelector('#course-title');
  const descEl = container.querySelector('#course-description');
  const progressEl = container.querySelector('#course-progress');
  const listEl = container.querySelector('#lesson-list');

  if (titleEl) {
    titleEl.textContent = course.title;
    if (titleEl instanceof HTMLElement) applyAutoDirection(titleEl);
  }
  if (descEl) {
    descEl.textContent = course.description;
    if (descEl instanceof HTMLElement) applyAutoDirection(descEl);
  }
  if (progressEl) progressEl.textContent = courseProgressLabel(progress, i18n);

  if (!listEl) return;
  listEl.innerHTML = '';

  if (lessons.length === 0) {
    renderEmpty(listEl as HTMLElement, {
      title: i18n.t('learning.emptyLessonsTitle'),
      body: i18n.t('learning.emptyLessonsBody'),
      inline: true,
    });
    return;
  }

  for (const lesson of lessons) {
    const row = document.createElement('div');
    row.className = 'panel-row';

    const main = document.createElement('div');
    main.className = 'row-main';

    const link = document.createElement('a');
    link.href = `/lessons/${encodeURIComponent(lesson.id)}`;
    link.dataset.route = 'lesson';
    link.textContent = i18n.t('learning.step.lessonN', { n: String(lesson.orderIndex + 1), title: lesson.title });
    applyAutoDirection(link);
    main.appendChild(link);
    row.appendChild(main);

    listEl.appendChild(row);
  }
}

/**
 * Render lesson details and all steps on one scrolling page.
 */
export function renderLessonDetail(
  container: HTMLElement,
  lesson: LessonView,
  steps: readonly StepView[],
  progress: CourseProgressSummaryView | null,
  stepAttempts: ReadonlyMap<string, AttemptResultView>,
  onAttemptSubmit: (stepId: string, input: { san?: string; selectedIndex?: number }) => Promise<void>,
  i18n: I18nManager,
  pendingSteps: ReadonlySet<string> = new Set(),
): () => void {
  const titleEl = container.querySelector('#lesson-title');
  const progressEl = container.querySelector('#lesson-progress');
  const stepListEl = container.querySelector('#step-list');

  if (titleEl) {
    titleEl.textContent = lesson.title;
    if (titleEl instanceof HTMLElement) applyAutoDirection(titleEl);
  }
  if (progressEl) progressEl.textContent = courseProgressLabel(progress, i18n);

  if (!stepListEl) return () => {};
  const doc = container.ownerDocument ?? document;
  const focused = doc.activeElement;
  const focusId = focused && stepListEl.contains(focused) ? focused.id : null;
  const selection = focused instanceof HTMLInputElement
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
    : null;
  const previousInputs = new Map<string, string>();
  for (const input of stepListEl.querySelectorAll<HTMLInputElement>('input')) {
    if (input.id) previousInputs.set(input.id, input.value);
  }
  const boards: Array<{ dispose: () => void }> = [];
  const dispose = (): void => { for (const board of boards) board.dispose(); };
  stepListEl.innerHTML = '';

  if (steps.length === 0) {
    renderEmpty(stepListEl as HTMLElement, {
      title: i18n.t('learning.emptyStepsTitle'),
      body: i18n.t('learning.emptyStepsBody'),
      inline: true,
    });
    return dispose;
  }

  for (const step of steps) {
    const block = doc.createElement('div');
    block.className = 'step-block';
    block.dataset.stepId = step.id;
    block.setAttribute('aria-busy', String(pendingSteps.has(step.id)));

    const header = doc.createElement('div');
    header.className = 'step-header';

    const numberLabel = doc.createElement('span');
    numberLabel.className = 'step-number count';
    numberLabel.textContent = i18n.t('learning.step.stepN', { n: String(step.orderIndex + 1) });
    header.appendChild(numberLabel);

    const statusLabel = doc.createElement('span');
    statusLabel.className = 'step-status count';
    statusLabel.textContent = stepStatusLabel(stepAttempts.get(step.id), i18n);
    header.appendChild(statusLabel);

    block.appendChild(header);

    if (step.kind === 'text') {
      const prose = doc.createElement('div');
      prose.className = 'step-prose';
      prose.textContent = step.prose;
      applyAutoDirection(prose);
      block.appendChild(prose);

      const actions = doc.createElement('div');
      actions.className = 'step-actions';

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'step-complete-btn';
      btn.textContent = i18n.t('learning.step.complete');
      btn.id = `complete-${step.id}`;
      btn.disabled = pendingSteps.has(step.id);
      btn.addEventListener('click', () => { void onAttemptSubmit(step.id, {}); });
      actions.appendChild(btn);
      block.appendChild(actions);
    } else if (step.kind === 'move') {
      const boardContainer = doc.createElement('div');
      boardContainer.className = 'step-board-wrapper';
      boardContainer.setAttribute('role', 'region');
      boardContainer.setAttribute(
        'aria-label',
        i18n.t('learning.step.boardReadOnlyAria', { n: String(step.orderIndex + 1) }),
      );

      const boardDesc = doc.createElement('p');
      boardDesc.className = 'sr-only';
      boardDesc.textContent = i18n.t('learning.step.boardSrOnly', { fen: step.fen });
      boardContainer.appendChild(boardDesc);

      const boardEl = doc.createElement('div');
      boardEl.className = 'step-board';
      boardContainer.appendChild(boardEl);
      block.appendChild(boardContainer);

      // Mount read-only board
      const mounted = mountBoard({ boardEl });
      boards.push(mounted);
      mounted.setTurn(false);
      mounted.setPosition(step.fen);

      if (step.hint) {
        const hint = doc.createElement('p');
        hint.className = 'step-hint count';
        hint.textContent = step.hint;
        applyAutoDirection(hint);
        block.appendChild(hint);
      }

      const form = doc.createElement('form');
      form.className = 'step-form';

      const label = doc.createElement('label');
      label.className = 'sr-only';
      label.htmlFor = `san-input-${step.id}`;
      label.textContent = i18n.t('learning.step.sanInputLabel');
      form.appendChild(label);

      const input = doc.createElement('input');
      input.id = `san-input-${step.id}`;
      input.type = 'text';
      input.className = 'step-san-input';
      input.placeholder = i18n.t('learning.step.sanPlaceholder');
      input.autocomplete = 'off';
      input.required = true;

      input.value = previousInputs.get(input.id) ?? '';
      input.disabled = pendingSteps.has(step.id);
      form.appendChild(input);

      const submitBtn = doc.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = i18n.t('learning.step.submitMove');
      submitBtn.id = `submit-${step.id}`;
      submitBtn.disabled = pendingSteps.has(step.id);
      form.appendChild(submitBtn);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const san = input.value.trim();
        if (!san) return;
        void onAttemptSubmit(step.id, { san });
      });

      block.appendChild(form);
    } else if (step.kind === 'quiz') {
      const question = doc.createElement('div');
      question.className = 'step-question';
      question.textContent = step.question;
      applyAutoDirection(question);
      block.appendChild(question);

      const optionsGroup = doc.createElement('div');
      optionsGroup.className = 'step-quiz-options';
      optionsGroup.setAttribute('role', 'group');
      optionsGroup.setAttribute('aria-label', step.question);

      step.options.forEach((optionText, idx) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-option-btn';
        btn.textContent = optionText;
        applyAutoDirection(btn);
        btn.id = `quiz-${step.id}-${idx}`;
        btn.disabled = pendingSteps.has(step.id);
        btn.addEventListener('click', () => { void onAttemptSubmit(step.id, { selectedIndex: idx }); });
        optionsGroup.appendChild(btn);
      });

      block.appendChild(optionsGroup);
    }

    stepListEl.appendChild(block);
  }
  if (focusId) {
    const replacement = Array.from(stepListEl.querySelectorAll<HTMLElement>('[id]')).find((el) => el.id === focusId);
    replacement?.focus();
    if (replacement instanceof HTMLInputElement && selection?.start !== null && selection?.end !== null && selection) {
      replacement.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    }
  }
  return dispose;
}
