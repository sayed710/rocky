import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLessons,
  activeSteps,
  difficultyLabel,
  courseProgressLabel,
  deriveStepAttempts,
  stepStatusLabel,
} from '../src/app/learning-helpers.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { LessonView, StepView } from '../src/api/models.js';

const testI18n = createI18nManager();

test('activeLessons filters out deleted lessons and sorts by orderIndex', () => {
  const input: LessonView[] = [
    { id: 'l2', courseId: 'c1', title: 'Lesson 2', orderIndex: 1 },
    { id: 'l1', courseId: 'c1', title: 'Lesson 1', orderIndex: 0 },
    { id: 'l3', courseId: 'c1', title: 'Deleted', orderIndex: 2, deletedAt: '2026-08-05T00:00:00Z' },
  ];

  const sorted = activeLessons(input);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0]?.id, 'l1');
  assert.equal(sorted[1]?.id, 'l2');
});

test('activeSteps filters out deleted steps and sorts by orderIndex', () => {
  const input: StepView[] = [
    { id: 's2', lessonId: 'l1', orderIndex: 1, kind: 'text', prose: 'Second' },
    { id: 's3', lessonId: 'l1', orderIndex: 2, kind: 'text', prose: 'Deleted', deletedAt: '2026-08-05T00:00:00Z' },
    { id: 's1', lessonId: 'l1', orderIndex: 0, kind: 'text', prose: 'First' },
  ];

  const sorted = activeSteps(input);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0]?.id, 's1');
  assert.equal(sorted[1]?.id, 's2');
});

test('difficultyLabel capitalizes difficulty strings', () => {
  assert.equal(difficultyLabel('beginner', testI18n), 'Beginner');
  assert.equal(difficultyLabel('intermediate', testI18n), 'Intermediate');
  assert.equal(difficultyLabel('advanced', testI18n), 'Advanced');
});

test('courseProgressLabel formats progress summary', () => {
  assert.equal(courseProgressLabel(null, testI18n), '');
  assert.equal(
    courseProgressLabel({ courseId: 'c1', playerId: 'p1', totalSteps: 5, completedSteps: 2 }, testI18n),
    '2 / 5 steps completed',
  );
});

const COMPLETED_AT = '2026-08-05T00:00:00.000Z';

test('stepStatusLabel formats attempt status in muted voice', () => {
  assert.equal(stepStatusLabel(null, testI18n), '');
  assert.equal(stepStatusLabel(undefined, testI18n), '');
  // The server sets `completedAt` on every correct attempt, so this is the real shape of one.
  assert.equal(
    stepStatusLabel({ stepId: 's1', correct: true, attempts: 1, completedAt: COMPLETED_AT }, testI18n),
    'Done',
  );
  assert.equal(stepStatusLabel({ stepId: 's1', correct: false, attempts: 2 }, testI18n), 'Try again');
});

test('a wrong answer on an already-completed step leaves it done', () => {
  // The domain returns exactly this for an incorrect answer after completion: `correct` describes
  // the attempt and is false, while `completedAt` is preserved and `attempts` climbs
  // (packages/learning/src/in-memory-repository.ts). Reading `correct` regressed the row to
  // "Try again" while the course summary still counted the step complete — and `deriveStepAttempts`
  // disagreed, so a reload silently corrected it.
  assert.equal(
    stepStatusLabel({ stepId: 's1', correct: false, attempts: 3, completedAt: COMPLETED_AT }, testI18n),
    'Done',
  );
});

test('deriveStepAttempts derives Done and Try again states from ProgressView records', () => {
  const map = deriveStepAttempts([
    { playerId: 'p1', courseId: 'c1', lessonId: 'l1', stepId: 's1', completedAt: '2026-08-05T00:00:00Z', attempts: 1 },
    { playerId: 'p1', courseId: 'c1', lessonId: 'l1', stepId: 's2', attempts: 2 },
    { playerId: 'p1', courseId: 'c1', lessonId: 'l1', stepId: 's3', attempts: 0 },
  ]);

  assert.equal(map.get('s1')?.correct, true);
  assert.equal(map.get('s1')?.attempts, 1);
  assert.equal(map.get('s2')?.correct, false);
  assert.equal(map.get('s2')?.attempts, 2);
  assert.equal(map.has('s3'), false);
});
