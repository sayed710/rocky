import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PositionReader, StudyVariant } from '@chess-platform/studies';
import {
  InMemoryLearningRepository,
  LearningRuleError,
  validateAndNormalizeSlug,
} from '../src';

class TestPositionReader implements PositionReader {
  legalSans(fen: string): readonly string[] {
    if (fen.includes('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')) {
      return ['e4', 'e3', 'd4', 'd3', 'Nf3', 'Nc3'];
    }
    return ['e4', 'e5', 'Nf3', 'Nc6'];
  }
  play(fen: string, san: string): string {
    if (!this.legalSans(fen).includes(san)) {
      throw new Error(`Illegal move ${san}`);
    }
    return 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  }
  initialFen(_variant?: StudyVariant): string {
    return START_FEN;
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const posReader = new TestPositionReader();

describe('@chess-platform/learning domain core', () => {
  it('Rule 1: Only author may edit course/lessons/steps; unpublished course is invisible (not_found) to non-author', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const strangerId = '00000000-0000-7000-8000-000000000002';
    const courseId = '00000000-0000-7000-8000-000000000010';

    // Create unpublished course
    await repo.createCourse(courseId, authorId, 'my-course', 'Title', 'Desc', 'beginner', false);

    // Stranger cannot see unpublished course (reads as not_found)
    await assert.rejects(
      () => repo.getCourse(courseId, strangerId),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'not_found'
    );

    // Author can see unpublished course
    const course = await repo.getCourse(courseId, authorId);
    assert.equal(course.id, courseId);

    // Publish course
    await repo.updateCourse(courseId, authorId, { published: true });

    // Stranger can see published course
    const pubCourse = await repo.getCourse(courseId, strangerId);
    assert.equal(pubCourse.published, true);

    // Stranger attempting edit gets not_authorized (not not_found, because they can see it)
    await assert.rejects(
      () => repo.updateCourse(courseId, strangerId, { title: 'Hacked' }),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'not_authorized'
    );
  });

  it('Rule 2: Slugs are unique, normalized, non-empty, and constrained to documented character set', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';

    // Valid slug
    const c1 = await repo.createCourse('c1', authorId, 'valid-slug-1', 'Title', 'Desc', 'beginner');
    assert.equal(c1.slug, 'valid-slug-1');

    // Duplicate slug throws duplicate_slug
    await assert.rejects(
      () => repo.createCourse('c2', authorId, 'valid-slug-1', 'Title 2', 'Desc', 'beginner'),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'duplicate_slug'
    );

    // Bad slug format (uppercase, spaces, special chars) throws invalid_input (never silently rewritten)
    assert.throws(
      () => validateAndNormalizeSlug('INVALID_SLUG'),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );
    assert.throws(
      () => validateAndNormalizeSlug('slug with space'),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );
    assert.throws(
      () => validateAndNormalizeSlug('slug!'),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );
  });

  it('Rule 3: orderIndex is dense and stable; reordering yields contiguous sequence and deletion compacts', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner');

    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');
    const l2 = await repo.createLesson('l2', c1.id, authorId, 'Lesson 2');
    const l3 = await repo.createLesson('l3', c1.id, authorId, 'Lesson 3');

    assert.equal(l1.orderIndex, 0);
    assert.equal(l2.orderIndex, 1);
    assert.equal(l3.orderIndex, 2);

    // Reorder l1, l2, l3 -> l3, l1, l2
    const reordered = await repo.reorderLessons(c1.id, authorId, ['l3', 'l1', 'l2']);
    assert.equal(reordered.find((l) => l.id === 'l3')!.orderIndex, 0);
    assert.equal(reordered.find((l) => l.id === 'l1')!.orderIndex, 1);
    assert.equal(reordered.find((l) => l.id === 'l2')!.orderIndex, 2);

    // Delete l1 (index 1), remaining (l3, l2) compacted to index 0, 1
    await repo.deleteLesson('l1', authorId);
    const remaining = await repo.listLessons(c1.id, authorId);
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].id, 'l3');
    assert.equal(remaining[0].orderIndex, 0);
    assert.equal(remaining[1].id, 'l2');
    assert.equal(remaining[1].orderIndex, 1);
  });

  it('Rule 4: Move step expectedSan must be legal from FEN at authoring time', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner');
    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');

    // Legal move e4 succeeds
    const s1 = await repo.createStep(
      's1',
      l1.id,
      authorId,
      { kind: 'move', fen: START_FEN, expectedSan: 'e4' },
      posReader
    );
    assert.equal(s1.kind, 'move');

    // Illegal move Ke2 throws invalid_move at authoring time
    await assert.rejects(
      () =>
        repo.createStep(
          's2',
          l1.id,
          authorId,
          { kind: 'move', fen: START_FEN, expectedSan: 'Ke2' },
          posReader
        ),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_move'
    );
  });

  it('Rule 5: Submitting attempt is idempotent per (player, step)', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const playerId = '00000000-0000-7000-8000-000000000009';

    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner', true);
    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');
    const s1 = await repo.createStep('s1', l1.id, authorId, { kind: 'text', prose: 'Read this' }, posReader);

    const t1 = new Date('2026-08-02T10:00:00Z');
    const res1 = await repo.submitAttempt(playerId, s1.id, {}, t1);
    assert.equal(res1.correct, true);
    assert.equal(res1.attempts, 1);
    assert.equal(res1.completedAt?.getTime(), t1.getTime());

    // Re-submitting correct answer does NOT inflate attempts or move completedAt
    const t2 = new Date('2026-08-02T11:00:00Z');
    const res2 = await repo.submitAttempt(playerId, s1.id, {}, t2);
    assert.equal(res2.correct, true);
    assert.equal(res2.attempts, 1); // Not 2!
    assert.equal(res2.completedAt?.getTime(), t1.getTime()); // Not t2!
  });

  it('Rule 6: Quiz answer index outside options range is rejected (invalid_input), not scored wrong', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const playerId = '00000000-0000-7000-8000-000000000009';

    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner', true);
    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');
    const s1 = await repo.createStep(
      's1',
      l1.id,
      authorId,
      { kind: 'quiz', question: 'Best move?', options: ['e4', 'd4'], correctIndex: 0 },
      posReader
    );

    // Index 5 is outside range [0, 1] -> invalid_input
    await assert.rejects(
      () => repo.submitAttempt(playerId, s1.id, { selectedIndex: 5 }),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );

    // Negative index -> invalid_input
    await assert.rejects(
      () => repo.submitAttempt(playerId, s1.id, { selectedIndex: -1 }),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );

    // Wrong option within range -> scored as wrong (correct: false)
    const wrongRes = await repo.submitAttempt(playerId, s1.id, { selectedIndex: 1 });
    assert.equal(wrongRes.correct, false);
    assert.equal(wrongRes.attempts, 1);
  });

  it('Rule 7: Course progress is derived, never stored twice', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const playerId = '00000000-0000-7000-8000-000000000009';

    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner', true);
    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');
    const s1 = await repo.createStep('s1', l1.id, authorId, { kind: 'text', prose: 'P1' }, posReader);
    const s2 = await repo.createStep('s2', l1.id, authorId, { kind: 'text', prose: 'P2' }, posReader);

    const summary0 = await repo.getProgressSummary(playerId, c1.id);
    assert.equal(summary0.totalSteps, 2);
    assert.equal(summary0.completedSteps, 0);

    // Complete s1
    await repo.submitAttempt(playerId, s1.id, {});
    const summary1 = await repo.getProgressSummary(playerId, c1.id);
    assert.equal(summary1.totalSteps, 2);
    assert.equal(summary1.completedSteps, 1);

    // Complete s2
    await repo.submitAttempt(playerId, s2.id, {});
    const summary2 = await repo.getProgressSummary(playerId, c1.id);
    assert.equal(summary2.totalSteps, 2);
    assert.equal(summary2.completedSteps, 2);
  });

  it('Rule 8: Deleting a course/lesson/step is a tombstone; progress history is preserved', async () => {
    const repo = new InMemoryLearningRepository();
    const authorId = '00000000-0000-7000-8000-000000000001';
    const playerId = '00000000-0000-7000-8000-000000000009';

    const c1 = await repo.createCourse('c1', authorId, 'course-1', 'Title', 'Desc', 'beginner', true);
    const l1 = await repo.createLesson('l1', c1.id, authorId, 'Lesson 1');
    const s1 = await repo.createStep('s1', l1.id, authorId, { kind: 'text', prose: 'P1' }, posReader);

    await repo.submitAttempt(playerId, s1.id, {});

    // Delete step
    const deletedStep = await repo.deleteStep(s1.id, authorId);
    assert.ok(deletedStep.deletedAt);

    // Step cannot be fetched by getStep
    await assert.rejects(
      () => repo.getStep(s1.id, authorId),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'not_found'
    );

    // Progress history is still present in listProgress
    const progList = await repo.listProgress(playerId, c1.id);
    assert.equal(progList.length, 1);
    assert.equal(progList[0].stepId, s1.id);
  });
});
