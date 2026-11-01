import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgLearningRepository } from '../src/pg/learning';
import { uuidv7 } from '../src/ids';
import { LearningRuleError } from '@chess-platform/learning';
import type { PositionReader, StudyVariant } from '@chess-platform/studies';
import { Position } from '@chess-platform/core';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

class CorePositionReader implements PositionReader {
  legalSans(fen: string): readonly string[] {
    const pos = Position.fromFen(fen);
    return pos.legalMoves().map((m) => pos.toSan(m));
  }
  play(fen: string, san: string): string {
    const pos = Position.fromFen(fen);
    const moves = pos.legalMoves();
    const move = moves.find((m) => pos.toSan(m) === san);
    if (!move) {
      throw new Error(`Illegal move ${san}`);
    }
    return pos.play(move).fen();
  }
  initialFen(variant?: StudyVariant): string {
    return Position.initial(variant ?? 'standard').fen();
  }
}

test('pg learning repository integration tests', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, join(process.cwd(), 'migrations'));

  const repo = new PgLearningRepository(pool);
  const reader = new CorePositionReader();

  const createdUserIds: string[] = [];
  const createUser = async (name: string): Promise<string> => {
    const id = uuidv7();
    const handle = `usr-${name.toLowerCase()}-${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO users (id, handle, email_hash, created_at) VALUES ($1, $2, $3, NOW())`,
      [id, handle, Buffer.from(id)]
    );
    createdUserIds.push(id);
    return id;
  };

  try {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');

    // 1. Course creation & slug uniqueness
    const c1Id = uuidv7();
    const c1 = await repo.createCourse(c1Id, alice, 'tactics-101', 'Tactics 101', 'Learn basic tactics', 'beginner', true);
    assert.equal(c1.slug, 'tactics-101');

    // Duplicate slug violation
    const c2Id = uuidv7();
    await assert.rejects(
      () => repo.createCourse(c2Id, bob, 'tactics-101', 'Dup', 'Desc', 'beginner', true),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'duplicate_slug'
    );

    // 2. Published / Unpublished visibility rule
    const cUnpubId = uuidv7();
    await repo.createCourse(cUnpubId, alice, 'draft-course', 'Draft', 'Unpublished', 'beginner', false);

    // Non-author Bob cannot see draft (reads as not_found)
    await assert.rejects(
      () => repo.getCourse(cUnpubId, bob),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'not_found'
    );

    // 3. Lesson creation & reordering with negative index shift
    const l1Id = uuidv7();
    const l2Id = uuidv7();
    await repo.createLesson(l1Id, c1Id, alice, 'Lesson 1');
    await repo.createLesson(l2Id, c1Id, alice, 'Lesson 2');

    const reordered = await repo.reorderLessons(c1Id, alice, [l2Id, l1Id]);
    assert.equal(reordered[0].id, l2Id);
    assert.equal(reordered[0].orderIndex, 0);
    assert.equal(reordered[1].id, l1Id);
    assert.equal(reordered[1].orderIndex, 1);

    // 4. Step creation & authoring-time move legality
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const s1Id = uuidv7();
    await repo.createStep(
      s1Id,
      l1Id,
      alice,
      { kind: 'move', fen: startFen, expectedSan: 'e4', hint: 'Push king pawn' },
      reader
    );

    // Illegal move at authoring time throws invalid_move
    const sBadId = uuidv7();
    await assert.rejects(
      () =>
        repo.createStep(
          sBadId,
          l1Id,
          alice,
          { kind: 'move', fen: startFen, expectedSan: 'Ke2' },
          reader
        ),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_move'
    );

    // 5. Quiz step creation & range check
    const sQuizId = uuidv7();
    await repo.createStep(
      sQuizId,
      l1Id,
      alice,
      { kind: 'quiz', question: 'Best move?', options: ['e4', 'd4'], correctIndex: 0 },
      reader
    );

    // Out of bounds option index (Rule 6) throws invalid_input
    await assert.rejects(
      () => repo.submitAttempt(bob, sQuizId, { selectedIndex: 5 }),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'invalid_input'
    );

    // 6. Real concurrency test: N concurrent attempts on one step must all be counted
    const N = 10;
    const concurrentAttempts = Array.from({ length: N }, () =>
      repo.submitAttempt(bob, sQuizId, { selectedIndex: 1 }) // wrong option, increments attempts
    );
    const results = await Promise.all(concurrentAttempts);
    assert.equal(results.length, N);

    const progressList = await repo.listProgress(bob, c1Id);
    const quizProgress = progressList.find((p) => p.stepId === sQuizId);
    assert.ok(quizProgress);
    assert.equal(quizProgress.attempts, N);

    // 7. Idempotency test: submitting correct answer on completed step does NOT inflate attempts
    const correctRes1 = await repo.submitAttempt(bob, s1Id, { san: 'e4' });
    assert.equal(correctRes1.correct, true);
    assert.equal(correctRes1.attempts, 1);

    const correctRes2 = await repo.submitAttempt(bob, s1Id, { san: 'e4' });
    assert.equal(correctRes2.correct, true);
    assert.equal(correctRes2.attempts, 1); // Remains 1!

    // 8. Derived progress summary
    const summary = await repo.getProgressSummary(bob, c1Id);
    assert.equal(summary.totalSteps, 2);
    assert.equal(summary.completedSteps, 1);

    // 9. Cascade deletion test: deleting user cleans up courses and progress
    await pool.query(`DELETE FROM users WHERE id = $1`, [alice]);

    await assert.rejects(
      () => repo.getCourse(c1Id, bob),
      (err: unknown) => err instanceof LearningRuleError && err.code === 'not_found'
    );
  } finally {
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await pool.end();
  }
});
