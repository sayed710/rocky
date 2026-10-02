/**
 * Learning controller — a pure, DOM-free orchestrator for the learner UI (courses, lessons, steps).
 *
 * Mirrors AchievementsController and TeamsController: a `requestGeneration` stale-response guard,
 * `dispose()`, and a 503 latch (`onUnavailable`).
 *
 * Every learning endpoint answers 503 when `learningRepository` is not configured on the API. That is a
 * deployment configuration, not a fault; the controller latches on the first 503 and stops asking for the
 * rest of this view. Not the session: `bootstrap` re-runs on every SPA navigation (`main.ts`), so the next
 * route builds a fresh controller that asks again. What keeps the cost down across views is
 * `permanentStatuses: [503]` on the reads, which stops a known-permanent answer being retried.
 */
import type { GambitClient } from '../api/client.js';
import type {
  AttemptResultView,
  CourseProgressSummaryView,
  CourseView,
  LessonView,
  ProgressView,
  StepView,
  SubmitAttemptRequest,
} from '../api/models.js';
import { ServiceUnavailableError } from '../net/errors.js';
import { activeLessons, activeSteps, deriveStepAttempts } from './learning-helpers.js';

export interface LearningCallbacks {
  onCourseList: (courses: readonly CourseView[], total: number) => void;
  onCourse: (
    course: CourseView,
    lessons: readonly LessonView[],
    progress: CourseProgressSummaryView | null,
  ) => void;
  onLesson: (
    lesson: LessonView,
    steps: readonly StepView[],
    progress: CourseProgressSummaryView | null,
    stepAttempts: ReadonlyMap<string, AttemptResultView>,
  ) => void;
  onAttemptResult: (
    stepId: string,
    result: AttemptResultView,
    courseProgress: CourseProgressSummaryView | null,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
  /**
   * The deployment runs without learning (`learningRepository` unset), so every route answers 503.
   * That is a configuration, not a fault: the view degrades quietly rather than showing an error
   * the visitor cannot act on.
   */
  onUnavailable: () => void;
}

export interface LearningControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: LearningCallbacks;
  readonly onDispose?: (() => void) | undefined;
}

export class LearningController {
  private readonly client: GambitClient;
  private readonly callbacks: LearningCallbacks;
  private readonly onDispose?: (() => void) | undefined;
  private requestGeneration = 0;
  private disposed = false;
  private unavailable = false;
  private readonly stepAttempts = new Map<string, AttemptResultView>();

  constructor(opts: LearningControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
  }

  /**
   * Load the list of published courses.
   */
  async loadCourses(): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const page = await this.client.learning.listCourses();
      if (!this.isCurrent(generation)) return;
      const active = page.items.filter((c) => !c.deletedAt);
      this.callbacks.onCourseList(active, page.total);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  /**
   * Load a course by slug, plus its lessons and current player progress (if authenticated).
   */
  async loadCourse(slug: string): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const course = await this.client.learning.courseBySlug(slug);
      if (!this.isCurrent(generation)) return;

      const rawLessons = await this.client.learning.lessons(course.id);
      if (!this.isCurrent(generation)) return;

      let progress: CourseProgressSummaryView | null = null;
      if (this.client.session.isAuthenticated) {
        try {
          progress = await this.client.learning.progress(course.id);
        } catch (err) {
          if (err instanceof ServiceUnavailableError) throw err;
          // Progress summary is supplementary to course viewing; if reading progress fails, proceed with null.
        }
      }
      if (!this.isCurrent(generation)) return;

      const lessons = activeLessons(rawLessons);
      this.callbacks.onCourse(course, lessons, progress);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  /**
   * Load a lesson by id, plus its steps, course progress, and detailed step attempt states (if authenticated).
   */
  async loadLesson(lessonId: string): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const lesson = await this.client.learning.lesson(lessonId);
      if (!this.isCurrent(generation)) return;

      const rawSteps = await this.client.learning.steps(lessonId);
      if (!this.isCurrent(generation)) return;

      let progress: CourseProgressSummaryView | null = null;
      if (this.client.session.isAuthenticated) {
        try {
          progress = await this.client.learning.progress(lesson.courseId);
        } catch (err) {
          if (err instanceof ServiceUnavailableError) throw err;
          // Progress summary is supplementary; if it fails, proceed with null.
        }

        try {
          const details: readonly ProgressView[] = await this.client.learning.progressDetails(lesson.courseId);
          const derivedMap = deriveStepAttempts(details);
          for (const [stepId, attempt] of derivedMap.entries()) {
            this.stepAttempts.set(stepId, attempt);
          }
        } catch (err) {
          if (err instanceof ServiceUnavailableError) throw err;
          // Step progress details are supplementary; if fetch fails, retain in-memory attempt state.
        }
      }
      if (!this.isCurrent(generation)) return;

      const steps = activeSteps(rawSteps);
      this.callbacks.onLesson(lesson, steps, progress, this.stepAttempts);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  /**
   * Submit an attempt for a step. Returns the result or null on failure.
   */
  async submitAttempt(
    stepId: string,
    courseId: string,
    body: SubmitAttemptRequest,
  ): Promise<AttemptResultView | null> {
    if (this.disposed) return null;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return null;
    }
    const generation = this.requestGeneration;
    try {
      const result = await this.client.learning.attempt(stepId, body);
      if (!this.isCurrent(generation)) return null;

      this.stepAttempts.set(stepId, result);

      let courseProgress: CourseProgressSummaryView | null = null;
      if (this.client.session.isAuthenticated) {
        try {
          courseProgress = await this.client.learning.progress(courseId);
        } catch (err) {
          if (err instanceof ServiceUnavailableError) throw err;
          // Progress summary update is supplementary; if it fails, proceed without updating summary.
        }
      }

      if (!this.isCurrent(generation)) return null;
      this.callbacks.onAttemptResult(stepId, result, courseProgress);
      return result;
    } catch (err) {
      if (!this.isCurrent(generation)) return null;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return null;
      }
      this.callbacks.onError(messageOf(err));
      return null;
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
  }

  dispose(): void {
    this.disposed = true;
    this.onDispose?.();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
