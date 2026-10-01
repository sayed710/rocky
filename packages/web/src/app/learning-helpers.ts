/**
 * Pure helpers for the learning section (courses, lessons, steps).
 */
import type {
  AttemptResultView,
  CourseDifficulty,
  CourseProgressSummaryView,
  LessonView,
  ProgressView,
  StepView,
} from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';

/**
 * Filter out deleted lessons and sort them in ascending `orderIndex` order.
 */
export function activeLessons(lessons: readonly LessonView[]): readonly LessonView[] {
  return lessons
    .filter((l) => !l.deletedAt)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * Filter out deleted steps and sort them in ascending `orderIndex` order.
 */
export function activeSteps(steps: readonly StepView[]): readonly StepView[] {
  return steps
    .filter((s) => !s.deletedAt)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * Format course difficulty with initial capital letter.
 */
export function difficultyLabel(difficulty: CourseDifficulty, i18n: I18nManager): string {
  switch (difficulty) {
    case 'beginner':
      return i18n.t('learning.difficulty.beginner');
    case 'intermediate':
      return i18n.t('learning.difficulty.intermediate');
    case 'advanced':
      return i18n.t('learning.difficulty.advanced');
  }
}

/**
 * Progress label in text format (e.g., "3 / 5 steps completed").
 */
export function courseProgressLabel(progress: CourseProgressSummaryView | null, i18n: I18nManager): string {
  if (!progress) return '';
  return i18n.t('learning.progressLabel', {
    completed: String(progress.completedSteps),
    total: String(progress.totalSteps),
  });
}

/**
 * Derive per-step attempt results from ProgressView records.
 * A step with completedAt set is done (correct: true).
 * A step with attempts > 0 and no completedAt is unfinished (correct: false).
 */
export function deriveStepAttempts(progressDetails: readonly ProgressView[]): Map<string, AttemptResultView> {
  const map = new Map<string, AttemptResultView>();
  for (const item of progressDetails) {
    if (item.completedAt) {
      map.set(item.stepId, {
        stepId: item.stepId,
        correct: true,
        attempts: item.attempts,
        completedAt: item.completedAt,
      });
    } else if (item.attempts > 0) {
      map.set(item.stepId, {
        stepId: item.stepId,
        correct: false,
        attempts: item.attempts,
      });
    }
  }
  return map;
}

/**
 * Derive the status label for a step, in the muted `.count` voice.
 *
 * `completedAt` is the only authority on whether a step is done — `correct` describes the *attempt*,
 * not the step. The two disagree in a case the domain produces deliberately: answering a
 * already-completed step wrongly returns `correct: false` with `completedAt` preserved and
 * `attempts` incremented (`packages/learning/src/in-memory-repository.ts`, the branch for an
 * incorrect answer after completion). Branching on `correct` regressed such a step to `Try again`
 * while the course summary still counted it complete, and disagreed with `deriveStepAttempts`,
 * which reads `completedAt` — so a reload silently corrected the row. Same rule as `unlockedAt` in
 * ADR-0089 §2.
 */
export function stepStatusLabel(result: AttemptResultView | null | undefined, i18n: I18nManager): string {
  if (!result) return '';
  if (result.completedAt !== undefined) return i18n.t('learning.step.done');
  if (result.attempts > 0) return i18n.t('learning.step.tryAgain');
  return '';
}
