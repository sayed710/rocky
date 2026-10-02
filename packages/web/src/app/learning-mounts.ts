import type { GambitClient } from '../api/client.js';
import type {
  AttemptResultView,
  CourseProgressSummaryView,
  CourseView,
  LessonView,
  StepView,
  SubmitAttemptRequest,
} from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { LearningController } from './learning-controller.js';
import type { LearningCallbacks } from './learning-controller.js';
import { courseProgressLabel, stepStatusLabel } from './learning-helpers.js';
import { renderCourseDetail, renderCourseList, renderLessonDetail } from './learning-view.js';

interface LearningMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly surface: HTMLElement;
  readonly i18n: I18nManager;
}

interface SessionBoundLearningMountDependencies extends LearningMountDependencies {
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
}

interface CourseMountDependencies extends SessionBoundLearningMountDependencies {
  readonly slug: string;
}

interface LessonMountDependencies extends SessionBoundLearningMountDependencies {
  readonly lessonId: string;
}

function loadAfterSessionRestore(
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  load: () => void,
): void {
  if (sessionPresent) load();
  else void restorePromise.then(() => load()).catch(() => undefined);
}

function renderUnavailable(doc: Document, surface: HTMLElement, i18n: I18nManager): void {
  surface.replaceChildren();
  const message = doc.createElement('p');
  message.className = 'count';
  message.textContent = i18n.t('learning.serviceUnavailable');
  surface.appendChild(message);
}

export function mountCourseList({
  doc,
  client,
  surface,
  i18n,
}: LearningMountDependencies): LearningController {
  const list = doc.getElementById('course-list');
  const error = doc.getElementById('courses-error');
  let lastCourses: readonly CourseView[] | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new LearningController({
    client,
    callbacks: {
      onCourseList: (courses) => {
        lastCourses = courses;
        if (error) error.textContent = '';
        if (list) renderCourseList(list, courses, i18n);
      },
      onCourse: () => {},
      onLesson: () => {},
      onAttemptResult: () => {},
      onLoading: (loading) => {
        if (list) list.setAttribute('aria-busy', loading ? 'true' : 'false');
      },
      onError: (message) => {
        if (error) error.textContent = message;
      },
      onUnavailable: () => renderUnavailable(doc, surface, i18n),
    },
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastCourses && list) {
      renderCourseList(list, lastCourses, i18n);
    }
  });

  void controller.loadCourses();
  return controller;
}

function createCourseCallbacks(
  doc: Document,
  surface: HTMLElement,
  error: HTMLElement | null,
  i18n: I18nManager,
  onCourseLoaded?: (state: {
    course: CourseView;
    lessons: readonly LessonView[];
    progress: CourseProgressSummaryView | null;
  }) => void,
): LearningCallbacks {
  return {
    onCourseList: () => {},
    onCourse: (course, lessons, progress) => {
      onCourseLoaded?.({ course, lessons, progress });
      if (error) error.textContent = '';
      renderCourseDetail(surface, course, lessons, progress, i18n);
    },
    onLesson: () => {},
    onAttemptResult: () => {},
    onLoading: (loading) => {
      const list = doc.getElementById('lesson-list');
      if (list) list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (error) error.textContent = message;
    },
    onUnavailable: () => renderUnavailable(doc, surface, i18n),
  };
}

export function mountCourseDetail({
  doc,
  client,
  surface,
  slug,
  sessionPresent,
  restorePromise,
  i18n,
}: CourseMountDependencies): LearningController {
  let lastCourseState: {
    course: CourseView;
    lessons: readonly LessonView[];
    progress: CourseProgressSummaryView | null;
  } | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new LearningController({
    client,
    callbacks: createCourseCallbacks(
      doc,
      surface,
      doc.getElementById('course-error'),
      i18n,
      (state) => {
        lastCourseState = state;
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastCourseState) {
      renderCourseDetail(
        surface,
        lastCourseState.course,
        lastCourseState.lessons,
        lastCourseState.progress,
        i18n,
      );
    }
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadCourse(slug));
  return controller;
}

export function mountLesson({
  doc, client, surface, lessonId, sessionPresent, restorePromise, i18n,
}: LessonMountDependencies): LearningController {
  let lastLessonState: {
    lesson: LessonView;
    steps: readonly StepView[];
    progress: CourseProgressSummaryView | null;
    stepAttempts: ReadonlyMap<string, AttemptResultView>;
  } | null = null;
  const pendingSteps = new Set<string>();
  let active = true;
  let unavailable = false;
  let disposeView: (() => void) | undefined;
  let unsubscribeLocale: (() => void) | undefined;
  const error = doc.getElementById('lesson-error');
  const updatePendingControls = (stepId: string): void => {
    // Find current nodes by stable step identity; never retain replaced controls in promises.
    const card = Array.from(surface.querySelectorAll<HTMLElement>('.step-block')).find((el) => el.dataset.stepId === stepId);
    if (!card) return;
    const pending = pendingSteps.has(stepId);
    card.setAttribute('aria-busy', String(pending));
    for (const el of card.querySelectorAll<HTMLInputElement>('input')) el.disabled = pending;
    for (const el of card.querySelectorAll<HTMLButtonElement>('button')) el.disabled = pending;
  };
  const submitAttempt = async (stepId: string, input: SubmitAttemptRequest): Promise<void> => {
    if (!active || !lastLessonState || pendingSteps.has(stepId)) return;
    pendingSteps.add(stepId);
    updatePendingControls(stepId);
    try {
      await controller.submitAttempt(stepId, lastLessonState.lesson.courseId, input);
    } finally {
      pendingSteps.delete(stepId);
      if (active) updatePendingControls(stepId);
    }
  };
  const render = (): void => {
    if (!active) return;
    if (unavailable) { renderUnavailable(doc, surface, i18n); return; }
    if (!lastLessonState) return;
    disposeView?.();
    const { lesson, steps, progress, stepAttempts } = lastLessonState;
    disposeView = renderLessonDetail(surface, lesson, steps, progress, stepAttempts, submitAttempt, i18n, pendingSteps);
  };
  const controller = new LearningController({
    client,
    callbacks: {
      onCourseList: () => {},
      onCourse: () => {},
      onLesson: (lesson, steps, progress, stepAttempts) => {
        lastLessonState = { lesson, steps, progress, stepAttempts };
        if (error) error.textContent = '';
        render();
      },
      onAttemptResult: (stepId, result, progress) => {
        if (!lastLessonState) return;
        const attempts = new Map(lastLessonState.stepAttempts);
        attempts.set(stepId, result);
        lastLessonState = { ...lastLessonState, progress, stepAttempts: attempts };
        const card = Array.from(surface.querySelectorAll<HTMLElement>('.step-block')).find((el) => el.dataset.stepId === stepId);
        const status = card?.querySelector('.step-status');
        if (status) status.textContent = stepStatusLabel(result, i18n);
        const progressEl = surface.querySelector('#lesson-progress');
        if (progressEl) progressEl.textContent = courseProgressLabel(progress, i18n);
      },
      onLoading: (loading) => { surface.querySelector('#step-list')?.setAttribute('aria-busy', String(loading)); },
      onError: (message) => { if (error) error.textContent = message; },
      onUnavailable: () => {
        unavailable = true;
        lastLessonState = null;
        disposeView?.();
        renderUnavailable(doc, surface, i18n);
      },
    },
    onDispose: () => {
      active = false;
      unsubscribeLocale?.();
      disposeView?.();
      pendingSteps.clear();
      lastLessonState = null;
    },
  });
  unsubscribeLocale = i18n.onLocaleChange(render);
  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadLesson(lessonId));
  return controller;
}
