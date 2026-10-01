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

function createLessonCallbacks(
  doc: Document,
  surface: HTMLElement,
  error: HTMLElement | null,
  submitAttempt: (
    stepId: string,
    courseId: string,
    input: SubmitAttemptRequest,
  ) => Promise<void>,
  i18n: I18nManager,
  onLessonLoaded?: (state: {
    lesson: LessonView;
    steps: readonly StepView[];
    progress: CourseProgressSummaryView | null;
    stepAttempts: ReadonlyMap<string, AttemptResultView>;
  }) => void,
  onAttemptHandled?: (stepId: string, result: AttemptResultView, courseProgress: CourseProgressSummaryView | null) => void,
): LearningCallbacks {
  let currentCourseId = '';
  return {
    onCourseList: () => {},
    onCourse: () => {},
    onLesson: (lesson, steps, progress, stepAttempts) => {
      currentCourseId = lesson.courseId;
      onLessonLoaded?.({ lesson, steps, progress, stepAttempts });
      if (error) error.textContent = '';
      renderLessonDetail(
        surface,
        lesson,
        steps,
        progress,
        stepAttempts,
        (stepId, input) => submitAttempt(stepId, currentCourseId, input),
        i18n,
      );
    },
    onAttemptResult: (stepId, result, courseProgress) => {
      onAttemptHandled?.(stepId, result, courseProgress);
      const stepCard = surface.querySelector(`[data-step-id="${stepId}"]`);
      if (stepCard) {
        const status = stepCard.querySelector('.step-status');
        if (status) status.textContent = stepStatusLabel(result, i18n);
      }
      const progress = doc.getElementById('lesson-progress');
      if (progress) progress.textContent = courseProgressLabel(courseProgress, i18n);
    },
    onLoading: (loading) => {
      const stepList = doc.getElementById('step-list');
      if (stepList) stepList.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (error) error.textContent = message;
    },
    onUnavailable: () => renderUnavailable(doc, surface, i18n),
  };
}

export function mountLesson({
  doc,
  client,
  surface,
  lessonId,
  sessionPresent,
  restorePromise,
  i18n,
}: LessonMountDependencies): LearningController {
  let controller: LearningController;
  let lastLessonState: {
    lesson: LessonView;
    steps: readonly StepView[];
    progress: CourseProgressSummaryView | null;
    stepAttempts: ReadonlyMap<string, AttemptResultView>;
  } | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  controller = new LearningController({
    client,
    callbacks: createLessonCallbacks(
      doc,
      surface,
      doc.getElementById('lesson-error'),
      async (stepId, courseId, input) => {
        await controller.submitAttempt(stepId, courseId, input);
      },
      i18n,
      (state) => {
        lastLessonState = state;
      },
      (stepId, result, courseProgress) => {
        if (lastLessonState) {
          const nextAttempts = new Map(lastLessonState.stepAttempts);
          nextAttempts.set(stepId, result);
          lastLessonState = {
            ...lastLessonState,
            progress: courseProgress,
            stepAttempts: nextAttempts,
          };
        }
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastLessonState) {
      renderLessonDetail(
        surface,
        lastLessonState.lesson,
        lastLessonState.steps,
        lastLessonState.progress,
        lastLessonState.stepAttempts,
        async (stepId, input) => {
          if (!lastLessonState) return;
          await controller.submitAttempt(stepId, lastLessonState.lesson.courseId, input);
        },
        i18n,
      );
    }
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadLesson(lessonId));
  return controller;
}
