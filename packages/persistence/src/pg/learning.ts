import type { Pool, PoolClient } from 'pg';
import type { PositionReader } from '@chess-platform/studies';
import { resolveSan } from '@chess-platform/studies';
import type {
  AttemptResult,
  Course,
  CourseDifficulty,
  CourseProgressSummary,
  CreateStepInput,
  LearningRepository,
  Lesson,
  LessonStep,
  MoveLessonStep,
  Page,
  PageOptions,
  Progress,
  QuizLessonStep,
  StepAttemptInput,
  TextLessonStep,
  UpdateStepInput,
} from '@chess-platform/learning';
import {
  LearningRuleError,
  compareLessons,
  compareProgress,
  compareSteps,
  validateAndNormalizeSlug,
} from '@chess-platform/learning';
import {
  isForeignKeyViolation,
  isInvalidTextRepresentation,
  isUniqueViolation,
  uniqueConstraintName,
} from './sqlstate';

interface CourseRow {
  id: string;
  author_id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: CourseDifficulty;
  published: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface LessonRow {
  id: string;
  course_id: string;
  title: string;
  order_index: number;
  deleted_at: Date | null;
}

interface StepRow {
  id: string;
  lesson_id: string;
  order_index: number;
  kind: 'text' | 'move' | 'quiz';
  prose: string | null;
  fen: string | null;
  expected_san: string | null;
  hint: string | null;
  question: string | null;
  options: string[] | null;
  correct_index: number | null;
  deleted_at: Date | null;
}

interface ProgressRow {
  player_id: string;
  course_id: string;
  lesson_id: string;
  step_id: string;
  completed_at: Date | null;
  attempts: number;
}

function bareSan(san: string): string {
  return san.replace(/[+#!?]+$/, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

function mapCourse(row: CourseRow): Course {
  return {
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    difficulty: row.difficulty,
    published: row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function mapLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    orderIndex: row.order_index,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function mapStep(row: StepRow): LessonStep {
  const base = {
    id: row.id,
    lessonId: row.lesson_id,
    orderIndex: row.order_index,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };

  if (row.kind === 'text') {
    return {
      ...base,
      kind: 'text',
      prose: row.prose ?? '',
    } satisfies TextLessonStep;
  }

  if (row.kind === 'move') {
    return {
      ...base,
      kind: 'move',
      fen: row.fen ?? '',
      expectedSan: row.expected_san ?? '',
      ...(row.hint ? { hint: row.hint } : {}),
    } satisfies MoveLessonStep;
  }

  return {
    ...base,
    kind: 'quiz',
    question: row.question ?? '',
    options: row.options ?? [],
    correctIndex: row.correct_index ?? 0,
  } satisfies QuizLessonStep;
}

function mapProgress(row: ProgressRow): Progress {
  return {
    playerId: row.player_id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    attempts: row.attempts,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

/**
 * Builds the `LIMIT/OFFSET` tail, appending its parameters to `params`.
 *
 * The clamping is the domain's (`packages/learning/src/pagination.ts`), applied here in TypeScript
 * rather than in SQL because neither `NaN` nor `Infinity` may reach `pg`: both are values
 * `Array.slice` absorbs quietly and `LIMIT`/`OFFSET` reject as malformed bigints.
 */
function paginationClause(params: unknown[], options?: PageOptions): string {
  const offset = normalizeOffset(options?.offset);
  const limit = normalizeLimit(options?.limit);

  let clause = `OFFSET $${params.push(offset)}`;
  if (limit !== undefined) {
    clause = `LIMIT $${params.push(limit)} ${clause}`;
  }
  return clause;
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || Number.isNaN(offset)) {
    return 0;
  }
  if (offset === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.trunc(offset));
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (Number.isNaN(limit)) {
    return 0;
  }
  if (limit === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Math.max(0, Math.trunc(limit));
}

async function lockCourse(client: PoolClient, courseId: string): Promise<void> {
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('course:' || $1::text, 0::bigint))`,
    [courseId]
  );
}

async function peekCourseIdByLessonId(
  client: PoolClient | Pool,
  lessonId: string
): Promise<string | undefined> {
  const res = await client.query<{ course_id: string }>(
    `SELECT course_id FROM learning_lessons WHERE id = $1 AND deleted_at IS NULL`,
    [lessonId]
  );
  return res.rows[0]?.course_id;
}

async function peekCourseIdByStepId(
  client: PoolClient | Pool,
  stepId: string
): Promise<string | undefined> {
  const res = await client.query<{ course_id: string }>(
    `SELECT l.course_id
     FROM learning_steps s
     JOIN learning_lessons l ON l.id = s.lesson_id
     WHERE s.id = $1 AND s.deleted_at IS NULL AND l.deleted_at IS NULL`,
    [stepId]
  );
  return res.rows[0]?.course_id;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

export class PgLearningRepository implements LearningRepository {
  constructor(private readonly pool: Pool) {}

  private handleSqlError(err: unknown, entityLabel = 'Resource'): never {
    if (err instanceof LearningRuleError) {
      throw err;
    }
    if (isInvalidTextRepresentation(err)) {
      throw new LearningRuleError('not_found', `${entityLabel} not found`);
    }
    if (isForeignKeyViolation(err)) {
      throw new LearningRuleError('not_found', `${entityLabel} not found`);
    }
    if (isUniqueViolation(err)) {
      // This schema has three unique constraints, not one: the course slug, and the ordering
      // indexes for lessons and steps. Answering "slug is already taken" to all of them tells a
      // client to fix a field that is fine, and tells whoever reads the log to look in the wrong
      // place — an ordering collision is a bug in the reorder, not a name clash.
      const constraint = uniqueConstraintName(err);
      if (constraint === undefined || constraint.includes('slug')) {
        throw new LearningRuleError('duplicate_slug', 'Course slug is already taken');
      }
      throw new LearningRuleError(
        'invalid_input',
        `Ordering conflict: two siblings would share a position (${constraint})`
      );
    }
    throw err;
  }

  // --- Courses -------------------------------------------------------------

  async createCourse(
    id: string,
    authorId: string,
    slug: string,
    title: string,
    description: string,
    difficulty: CourseDifficulty,
    published = false,
    at = new Date()
  ): Promise<Course> {
    const validSlug = validateAndNormalizeSlug(slug);

    if (!title.trim()) {
      throw new LearningRuleError('invalid_input', 'Course title cannot be empty');
    }

    try {
      const res = await this.pool.query<CourseRow>(
        `INSERT INTO learning_courses (id, author_id, slug, title, description, difficulty, published, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at`,
        [id, authorId, validSlug, title.trim(), description.trim(), difficulty, published, at]
      );
      return mapCourse(res.rows[0]);
    } catch (err) {
      this.handleSqlError(err, 'User');
    }
  }

  /**
   * Reads a course on a caller-supplied connection.
   *
   * Every write path needs this rather than `getCourse`. A method that has opened a transaction and
   * taken the course advisory lock on its own `PoolClient`, then reads through `this.pool`, is
   * asking a *second* connection for state the first one is holding a lock over: the read cannot
   * see the transaction's own uncommitted work, and on a pool of one it waits forever for a
   * connection the caller is already holding. The authorization check would be answered from
   * outside the very transaction meant to make it trustworthy.
   */
  private async getCourseOn(
    client: PoolClient | Pool,
    courseId: string,
    actorId?: string
  ): Promise<Course> {
    try {
      const res = await client.query<CourseRow>(
        `SELECT id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at FROM learning_courses WHERE id = $1 AND deleted_at IS NULL`,
        [courseId]
      );
      if (res.rows.length === 0) {
        throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
      }
      const course = mapCourse(res.rows[0]);
      if (!course.published && course.authorId !== actorId) {
        throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
      }
      return course;
    } catch (err) {
      this.handleSqlError(err, 'Course');
    }
  }

  async getCourse(courseId: string, actorId?: string): Promise<Course> {
    return this.getCourseOn(this.pool, courseId, actorId);
  }

  async getCourseBySlug(slug: string, actorId?: string): Promise<Course> {
    const validSlug = validateAndNormalizeSlug(slug);

    try {
      const res = await this.pool.query<CourseRow>(
        `SELECT id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at FROM learning_courses WHERE slug = $1 AND deleted_at IS NULL`,
        [validSlug]
      );
      if (res.rows.length === 0) {
        throw new LearningRuleError('not_found', `Course with slug '${validSlug}' not found`);
      }

      const course = mapCourse(res.rows[0]);
      if (!course.published && course.authorId !== actorId) {
        throw new LearningRuleError('not_found', `Course with slug '${validSlug}' not found`);
      }

      return course;
    } catch (err) {
      this.handleSqlError(err, 'Course');
    }
  }

  async updateCourse(
    courseId: string,
    actorId: string,
    updates: {
      slug?: string;
      title?: string;
      description?: string;
      difficulty?: CourseDifficulty;
      published?: boolean;
    },
    at = new Date()
  ): Promise<Course> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const courseRes = await client.query<CourseRow>(
        `SELECT id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at FROM learning_courses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [courseId]
      );
      if (courseRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
      }

      const course = mapCourse(courseRes.rows[0]);
      if (!course.published && course.authorId !== actorId) {
        throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
      }
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may update the course');
      }

      let newSlug = course.slug;
      if (updates.slug !== undefined) {
        newSlug = validateAndNormalizeSlug(updates.slug);
      }

      let newTitle = course.title;
      if (updates.title !== undefined) {
        if (!updates.title.trim()) {
          throw new LearningRuleError('invalid_input', 'Course title cannot be empty');
        }
        newTitle = updates.title.trim();
      }

      const newDesc = updates.description !== undefined ? updates.description.trim() : course.description;
      const newDiff = updates.difficulty ?? course.difficulty;
      const newPub = updates.published ?? course.published;

      const updateRes = await client.query<CourseRow>(
        `UPDATE learning_courses
         SET slug = $1, title = $2, description = $3, difficulty = $4, published = $5, updated_at = $6
         WHERE id = $7
         RETURNING id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at`,
        [newSlug, newTitle, newDesc, newDiff, newPub, at, courseId]
      );

      await client.query('COMMIT');
      return mapCourse(updateRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Course');
    } finally {
      client.release();
    }
  }

  async deleteCourse(courseId: string, actorId: string, at = new Date()): Promise<Course> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const courseRes = await client.query<CourseRow>(
        `SELECT id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at FROM learning_courses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [courseId]
      );
      if (courseRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Course '${courseId}' not found`);
      }

      const course = mapCourse(courseRes.rows[0]);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may delete the course');
      }

      const updateRes = await client.query<CourseRow>(
        `UPDATE learning_courses
         SET deleted_at = $1, updated_at = $1
         WHERE id = $2
         RETURNING id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at`,
        [at, courseId]
      );

      await client.query('COMMIT');
      return mapCourse(updateRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Course');
    } finally {
      client.release();
    }
  }

  async listCourses(
    actorId?: string,
    options?: PageOptions & {
      authorId?: string;
      difficulty?: CourseDifficulty;
      search?: string;
    }
  ): Promise<Page<Course>> {
    // Filtered, ordered and paged in SQL, not in JavaScript.
    //
    // The in-memory adapter's shape — read everything, then filter, sort and slice — is correct and
    // is not a database query. Copied here it transfers the entire course table on every listing,
    // page one included, and grows with the catalogue rather than with the page. The database is
    // the thing that can answer this cheaply; asking it for all the rows and then doing the work
    // anyway is paying for a database and using a file.
    const params: unknown[] = [];
    const conditions: string[] = ['deleted_at IS NULL'];

    // Unpublished courses are visible only to their author (invariant 1). Expressed as SQL so an
    // unpublished course cannot leak through a page boundary.
    if (actorId === undefined) {
      conditions.push('published = TRUE');
    } else {
      conditions.push(`(published = TRUE OR author_id = $${params.push(actorId)})`);
    }
    if (options?.authorId !== undefined) {
      conditions.push(`author_id = $${params.push(options.authorId)}`);
    }
    if (options?.difficulty !== undefined) {
      conditions.push(`difficulty = $${params.push(options.difficulty)}`);
    }
    if (options?.search) {
      // ILIKE with an escaped pattern: a search term containing `%` or `_` is a term, not a
      // wildcard the caller gets to inject into someone else's query.
      const pattern = `%${options.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const idx = params.push(pattern);
      conditions.push(`(title ILIKE $${idx} ESCAPE '\\' OR description ILIKE $${idx} ESCAPE '\\')`);
    }

    const where = conditions.join(' AND ');

    try {
      const countRes = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM learning_courses WHERE ${where}`,
        params
      );
      const total = Number(countRes.rows[0]?.count ?? '0');

      // `ORDER BY created_at DESC, id ASC` is `compareCourses`; the `id` tie-break agrees because
      // `uuid` compares byte-wise, which coincides with code-point order on canonical lowercase
      // UUID text (ADR-0067 §2). The two must change together.
      const pageParams = [...params];
      const pagination = paginationClause(pageParams, options);
      const res = await this.pool.query<CourseRow>(
        `SELECT id, author_id, slug, title, description, difficulty, published, created_at, updated_at, deleted_at
         FROM learning_courses
         WHERE ${where}
         ORDER BY created_at DESC, id ASC
         ${pagination}`,
        pageParams
      );

      return { total, items: res.rows.map(mapCourse) };
    } catch (err) {
      this.handleSqlError(err, 'Course');
    }
  }

  // --- Lessons -------------------------------------------------------------

  async createLesson(id: string, courseId: string, actorId: string, title: string, _at = new Date()): Promise<Lesson> {
    if (!title.trim()) {
      throw new LearningRuleError('invalid_input', 'Lesson title cannot be empty');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const course = await this.getCourseOn(client, courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may add lessons');
      }

      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM learning_lessons WHERE course_id = $1 AND deleted_at IS NULL`,
        [courseId]
      );
      const nextIndex = Number(countRes.rows[0]?.count ?? 0);

      const res = await client.query<LessonRow>(
        `INSERT INTO learning_lessons (id, course_id, title, order_index)
         VALUES ($1, $2, $3, $4)
         RETURNING id, course_id, title, order_index, deleted_at`,
        [id, courseId, title.trim(), nextIndex]
      );

      await client.query('COMMIT');
      return mapLesson(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Lesson');
    } finally {
      client.release();
    }
  }

  /** Reads a lesson on a caller-supplied connection. See `getCourseOn` for why this exists. */
  private async getLessonWithCourseOn(
    client: PoolClient | Pool,
    lessonId: string,
    actorId?: string
  ): Promise<{ lesson: Lesson; course: Course }> {
    try {
      const res = await client.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE id = $1 AND deleted_at IS NULL`,
        [lessonId]
      );
      if (res.rows.length === 0) {
        throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
      }

      const lesson = mapLesson(res.rows[0]);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      return { lesson, course };
    } catch (err) {
      this.handleSqlError(err, 'Lesson');
    }
  }

  private async getLessonOn(
    client: PoolClient | Pool,
    lessonId: string,
    actorId?: string
  ): Promise<Lesson> {
    return (await this.getLessonWithCourseOn(client, lessonId, actorId)).lesson;
  }

  async getLesson(lessonId: string, actorId?: string): Promise<Lesson> {
    return this.getLessonOn(this.pool, lessonId, actorId);
  }

  async listLessons(courseId: string, actorId?: string): Promise<readonly Lesson[]> {
    await this.getCourse(courseId, actorId);

    try {
      const res = await this.pool.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE course_id = $1 AND deleted_at IS NULL`,
        [courseId]
      );
      const list = res.rows.map(mapLesson);
      list.sort(compareLessons);
      return list;
    } catch (err) {
      this.handleSqlError(err, 'Lesson');
    }
  }

  async updateLesson(
    lessonId: string,
    actorId: string,
    updates: { title?: string },
    _at = new Date()
  ): Promise<Lesson> {
    const courseId = await peekCourseIdByLessonId(this.pool, lessonId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const lessonRes = await client.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [lessonId]
      );
      if (lessonRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
      }

      const lesson = mapLesson(lessonRes.rows[0]);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may update lessons');
      }

      let newTitle = lesson.title;
      if (updates.title !== undefined) {
        if (!updates.title.trim()) {
          throw new LearningRuleError('invalid_input', 'Lesson title cannot be empty');
        }
        newTitle = updates.title.trim();
      }

      const updateRes = await client.query<LessonRow>(
        `UPDATE learning_lessons SET title = $1 WHERE id = $2 RETURNING id, course_id, title, order_index, deleted_at`,
        [newTitle, lessonId]
      );

      await client.query('COMMIT');
      return mapLesson(updateRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Lesson');
    } finally {
      client.release();
    }
  }

  async reorderLessons(
    courseId: string,
    actorId: string,
    lessonIds: readonly string[],
    _at = new Date()
  ): Promise<readonly Lesson[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const course = await this.getCourseOn(client, courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may reorder lessons');
      }

      const activeRes = await client.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE course_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [courseId]
      );
      const activeLessons = activeRes.rows.map(mapLesson);

      if (lessonIds.length !== activeLessons.length) {
        throw new LearningRuleError(
          'invalid_input',
          `Reorder lessonIds count (${lessonIds.length}) does not match active lessons count (${activeLessons.length})`
        );
      }

      const activeSet = new Set(activeLessons.map((l) => l.id));
      for (const id of lessonIds) {
        if (!activeSet.has(id)) {
          throw new LearningRuleError('invalid_input', `Lesson '${id}' does not belong to course '${courseId}'`);
        }
      }

      if (new Set(lessonIds).size !== lessonIds.length) {
        throw new LearningRuleError('invalid_input', 'Duplicate lesson IDs in reorder request');
      }

      // ADR-0071 §5a: Shift to negative indices first to avoid unique index collision on (course_id, order_index)
      for (let i = 0; i < lessonIds.length; i++) {
        await client.query(
          `UPDATE learning_lessons SET order_index = $1 WHERE id = $2`,
          [-1 - i, lessonIds[i]]
        );
      }

      // Shift to final contiguous 0..N-1 indices
      const result: Lesson[] = [];
      for (let i = 0; i < lessonIds.length; i++) {
        const updateRes = await client.query<LessonRow>(
          `UPDATE learning_lessons SET order_index = $1 WHERE id = $2 RETURNING id, course_id, title, order_index, deleted_at`,
          [i, lessonIds[i]]
        );
        result.push(mapLesson(updateRes.rows[0]));
      }

      await client.query('COMMIT');
      result.sort(compareLessons);
      return result;
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Lesson');
    } finally {
      client.release();
    }
  }

  async deleteLesson(lessonId: string, actorId: string, at = new Date()): Promise<Lesson> {
    const courseId = await peekCourseIdByLessonId(this.pool, lessonId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const lessonRes = await client.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [lessonId]
      );
      if (lessonRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
      }

      const lesson = mapLesson(lessonRes.rows[0]);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may delete lessons');
      }

      const delRes = await client.query<LessonRow>(
        `UPDATE learning_lessons SET deleted_at = $1 WHERE id = $2 RETURNING id, course_id, title, order_index, deleted_at`,
        [at, lessonId]
      );

      // Compact remaining active lessons downward
      const activeRes = await client.query<LessonRow>(
        `SELECT id, course_id, title, order_index, deleted_at FROM learning_lessons WHERE course_id = $1 AND deleted_at IS NULL ORDER BY order_index ASC, id ASC`,
        [courseId]
      );

      for (let i = 0; i < activeRes.rows.length; i++) {
        await client.query(
          `UPDATE learning_lessons SET order_index = $1 WHERE id = $2`,
          [i, activeRes.rows[i].id]
        );
      }

      await client.query('COMMIT');
      return mapLesson(delRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Lesson');
    } finally {
      client.release();
    }
  }

  // --- Steps ---------------------------------------------------------------

  async createStep(
    id: string,
    lessonId: string,
    actorId: string,
    input: CreateStepInput,
    positionReader: PositionReader,
    _at = new Date()
  ): Promise<LessonStep> {
    const courseId = await peekCourseIdByLessonId(this.pool, lessonId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const lesson = await this.getLessonOn(client, lessonId, actorId);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may add steps');
      }

      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM learning_steps WHERE lesson_id = $1 AND deleted_at IS NULL`,
        [lessonId]
      );
      const nextIndex = Number(countRes.rows[0]?.count ?? 0);

      let prose: string | null = null;
      let fen: string | null = null;
      let expectedSan: string | null = null;
      let hint: string | null = null;
      let question: string | null = null;
      let options: string[] | null = null;
      let correctIndex: number | null = null;

      if (input.kind === 'text') {
        if (!input.prose.trim()) throw new LearningRuleError('invalid_input', 'Prose cannot be empty');
        prose = input.prose.trim();
      } else if (input.kind === 'move') {
        if (!input.fen.trim()) throw new LearningRuleError('invalid_input', 'FEN cannot be empty');
        if (!input.expectedSan.trim()) throw new LearningRuleError('invalid_input', 'expectedSan cannot be empty');

        // Rule 4: Validate move legality at authoring time
        try {
          resolveSan(positionReader, input.fen.trim(), input.expectedSan.trim());
        } catch (_err) {
          throw new LearningRuleError('invalid_move', `'${input.expectedSan}' is not a legal move from FEN '${input.fen}'`);
        }

        fen = input.fen.trim();
        expectedSan = input.expectedSan.trim();
        hint = input.hint ? input.hint.trim() : null;
      } else if (input.kind === 'quiz') {
        if (!input.question.trim()) throw new LearningRuleError('invalid_input', 'Question cannot be empty');
        if (input.options.length < 2 || input.options.length > 6) {
          throw new LearningRuleError('invalid_input', `Quiz must have between 2 and 6 options (received ${input.options.length})`);
        }
        for (const opt of input.options) {
          if (typeof opt !== 'string' || !opt.trim()) throw new LearningRuleError('invalid_input', 'Quiz options cannot contain empty strings');
        }
        if (
          typeof input.correctIndex !== 'number' ||
          !Number.isInteger(input.correctIndex) ||
          input.correctIndex < 0 ||
          input.correctIndex >= input.options.length
        ) {
          throw new LearningRuleError('invalid_input', `Quiz correctIndex (${input.correctIndex}) out of bounds`);
        }

        question = input.question.trim();
        options = input.options.map((o: string) => o.trim());
        correctIndex = input.correctIndex;
      } else {
        throw new LearningRuleError('invalid_input', 'Invalid step kind');
      }

      const res = await client.query<StepRow>(
        `INSERT INTO learning_steps (id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at`,
        [id, lessonId, nextIndex, input.kind, prose, fen, expectedSan, hint, question, options ? JSON.stringify(options) : null, correctIndex]
      );

      await client.query('COMMIT');
      return mapStep(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Step');
    } finally {
      client.release();
    }
  }

  async getStepWithCourse(
    stepId: string,
    actorId?: string
  ): Promise<{ step: LessonStep; course: Course }> {
    try {
      const res = await this.pool.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE id = $1 AND deleted_at IS NULL`,
        [stepId]
      );
      if (res.rows.length === 0) {
        throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
      }

      const step = mapStep(res.rows[0]);
      const { course } = await this.getLessonWithCourseOn(this.pool, step.lessonId, actorId);
      return { step, course };
    } catch (err) {
      this.handleSqlError(err, 'Step');
    }
  }

  async getStep(stepId: string, actorId?: string): Promise<LessonStep> {
    return (await this.getStepWithCourse(stepId, actorId)).step;
  }

  async listStepsWithCourse(
    lessonId: string,
    actorId?: string
  ): Promise<{ steps: readonly LessonStep[]; course: Course }> {
    const { course } = await this.getLessonWithCourseOn(this.pool, lessonId, actorId);

    try {
      const res = await this.pool.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE lesson_id = $1 AND deleted_at IS NULL`,
        [lessonId]
      );
      const list = res.rows.map(mapStep);
      list.sort(compareSteps);
      return { steps: list, course };
    } catch (err) {
      this.handleSqlError(err, 'Step');
    }
  }

  async listSteps(lessonId: string, actorId?: string): Promise<readonly LessonStep[]> {
    return (await this.listStepsWithCourse(lessonId, actorId)).steps;
  }

  async updateStep(
    stepId: string,
    actorId: string,
    updates: UpdateStepInput,
    positionReader: PositionReader,
    _at = new Date()
  ): Promise<LessonStep> {
    const courseId = await peekCourseIdByStepId(this.pool, stepId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const stepRes = await client.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [stepId]
      );
      if (stepRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
      }

      const existingStep = mapStep(stepRes.rows[0]);
      const lesson = await this.getLessonOn(client, existingStep.lessonId, actorId);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may update steps');
      }

      let prose = stepRes.rows[0].prose;
      let fen = stepRes.rows[0].fen;
      let expectedSan = stepRes.rows[0].expected_san;
      let hint = stepRes.rows[0].hint;
      let question = stepRes.rows[0].question;
      let options = stepRes.rows[0].options;
      let correctIndex = stepRes.rows[0].correct_index;

      if (existingStep.kind === 'text') {
        const proseUpdate = (updates as { prose?: string }).prose;
        if (proseUpdate !== undefined) {
          if (!proseUpdate.trim()) throw new LearningRuleError('invalid_input', 'Prose cannot be empty');
          prose = proseUpdate.trim();
        }
      } else if (existingStep.kind === 'move') {
        const moveUpdates = updates as { fen?: string; expectedSan?: string; hint?: string };
        const newFen = moveUpdates.fen !== undefined ? moveUpdates.fen.trim() : fen;
        const newSan = moveUpdates.expectedSan !== undefined ? moveUpdates.expectedSan.trim() : expectedSan;

        if (!newFen) throw new LearningRuleError('invalid_input', 'FEN cannot be empty');
        if (!newSan) throw new LearningRuleError('invalid_input', 'expectedSan cannot be empty');

        try {
          resolveSan(positionReader, newFen, newSan);
        } catch (_err) {
          throw new LearningRuleError('invalid_move', `'${newSan}' is not a legal move from FEN '${newFen}'`);
        }

        fen = newFen;
        expectedSan = newSan;
        hint = moveUpdates.hint !== undefined ? moveUpdates.hint.trim() : hint;
      } else if (existingStep.kind === 'quiz') {
        const quizUpdates = updates as { question?: string; options?: readonly string[]; correctIndex?: number };
        const newQ = quizUpdates.question !== undefined ? quizUpdates.question.trim() : question;
        const newOpts = quizUpdates.options !== undefined ? quizUpdates.options.map((o: string) => o.trim()) : options;
        const newIdx = quizUpdates.correctIndex !== undefined ? quizUpdates.correctIndex : correctIndex;

        if (!newQ) throw new LearningRuleError('invalid_input', 'Question cannot be empty');
        if (!newOpts || newOpts.length < 2 || newOpts.length > 6) {
          throw new LearningRuleError('invalid_input', 'Quiz must have between 2 and 6 options');
        }
        for (const opt of newOpts) {
          if (!opt) throw new LearningRuleError('invalid_input', 'Quiz options cannot contain empty strings');
        }
        if (
          typeof newIdx !== 'number' ||
          !Number.isInteger(newIdx) ||
          newIdx < 0 ||
          newIdx >= newOpts.length
        ) {
          throw new LearningRuleError('invalid_input', `Quiz correctIndex (${newIdx}) out of bounds`);
        }

        question = newQ;
        options = newOpts;
        correctIndex = newIdx;
      }

      const updateRes = await client.query<StepRow>(
        `UPDATE learning_steps
         SET prose = $1, fen = $2, expected_san = $3, hint = $4, question = $5, options = $6, correct_index = $7
         WHERE id = $8
         RETURNING id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at`,
        [prose, fen, expectedSan, hint, question, options ? JSON.stringify(options) : null, correctIndex, stepId]
      );

      await client.query('COMMIT');
      return mapStep(updateRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Step');
    } finally {
      client.release();
    }
  }

  async reorderSteps(
    lessonId: string,
    actorId: string,
    stepIds: readonly string[],
    _at = new Date()
  ): Promise<readonly LessonStep[]> {
    const courseId = await peekCourseIdByLessonId(this.pool, lessonId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Lesson '${lessonId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const lesson = await this.getLessonOn(client, lessonId, actorId);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may reorder steps');
      }

      const activeRes = await client.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE lesson_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [lessonId]
      );
      const activeSteps = activeRes.rows.map(mapStep);

      if (stepIds.length !== activeSteps.length) {
        throw new LearningRuleError(
          'invalid_input',
          `Reorder stepIds count (${stepIds.length}) does not match active steps count (${activeSteps.length})`
        );
      }

      const activeSet = new Set(activeSteps.map((s) => s.id));
      for (const id of stepIds) {
        if (!activeSet.has(id)) {
          throw new LearningRuleError('invalid_input', `Step '${id}' does not belong to lesson '${lessonId}'`);
        }
      }

      if (new Set(stepIds).size !== stepIds.length) {
        throw new LearningRuleError('invalid_input', 'Duplicate step IDs in reorder request');
      }

      // Shift to negative indices first
      for (let i = 0; i < stepIds.length; i++) {
        await client.query(
          `UPDATE learning_steps SET order_index = $1 WHERE id = $2`,
          [-1 - i, stepIds[i]]
        );
      }

      // Shift to final contiguous 0..N-1 indices
      const result: LessonStep[] = [];
      for (let i = 0; i < stepIds.length; i++) {
        const updateRes = await client.query<StepRow>(
          `UPDATE learning_steps SET order_index = $1 WHERE id = $2 RETURNING id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at`,
          [i, stepIds[i]]
        );
        result.push(mapStep(updateRes.rows[0]));
      }

      await client.query('COMMIT');
      result.sort(compareSteps);
      return result;
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Step');
    } finally {
      client.release();
    }
  }

  async deleteStep(stepId: string, actorId: string, at = new Date()): Promise<LessonStep> {
    const courseId = await peekCourseIdByStepId(this.pool, stepId);
    if (!courseId) {
      throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockCourse(client, courseId);

      const stepRes = await client.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [stepId]
      );
      if (stepRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
      }

      const step = mapStep(stepRes.rows[0]);
      const lesson = await this.getLessonOn(client, step.lessonId, actorId);
      const course = await this.getCourseOn(client, lesson.courseId, actorId);
      if (course.authorId !== actorId) {
        throw new LearningRuleError('not_authorized', 'Only the course author may delete steps');
      }

      const delRes = await client.query<StepRow>(
        `UPDATE learning_steps SET deleted_at = $1 WHERE id = $2 RETURNING id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at`,
        [at, stepId]
      );

      // Compact remaining active steps downward
      const activeRes = await client.query<StepRow>(
        `SELECT id, lesson_id, order_index, kind, prose, fen, expected_san, hint, question, options, correct_index, deleted_at FROM learning_steps WHERE lesson_id = $1 AND deleted_at IS NULL ORDER BY order_index ASC, id ASC`,
        [step.lessonId]
      );

      for (let i = 0; i < activeRes.rows.length; i++) {
        await client.query(
          `UPDATE learning_steps SET order_index = $1 WHERE id = $2`,
          [i, activeRes.rows[i].id]
        );
      }

      await client.query('COMMIT');
      return mapStep(delRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Step');
    } finally {
      client.release();
    }
  }

  // --- Progress & Attempts -------------------------------------------------

  async submitAttempt(
    playerId: string,
    stepId: string,
    attempt: StepAttemptInput,
    at = new Date()
  ): Promise<AttemptResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const stepRes = await client.query<
        StepRow & { course_id: string; author_id: string; published: boolean }
      >(
        `SELECT s.id, s.lesson_id, s.order_index, s.kind, s.prose, s.fen, s.expected_san, s.hint,
                s.question, s.options, s.correct_index, s.deleted_at,
                l.course_id, c.author_id, c.published
         FROM learning_steps s
         JOIN learning_lessons l ON l.id = s.lesson_id
         JOIN learning_courses c ON c.id = l.course_id
         WHERE s.id = $1 AND s.deleted_at IS NULL AND l.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [stepId]
      );

      if (stepRes.rows.length === 0) {
        throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
      }

      const row = stepRes.rows[0];
      if (!row.published && row.author_id !== playerId) {
        throw new LearningRuleError('not_found', `Step '${stepId}' not found`);
      }

      let isCorrect = false;

      if (row.kind === 'text') {
        isCorrect = true;
      } else if (row.kind === 'move') {
        if (!attempt.san || typeof attempt.san !== 'string' || !attempt.san.trim()) {
          throw new LearningRuleError('invalid_input', 'SAN move required for move step');
        }
        isCorrect = bareSan(attempt.san.trim()) === bareSan(row.expected_san!);
      } else if (row.kind === 'quiz') {
        if (
          attempt.selectedIndex === undefined ||
          typeof attempt.selectedIndex !== 'number' ||
          !Number.isInteger(attempt.selectedIndex)
        ) {
          throw new LearningRuleError('invalid_input', 'Quiz selectedIndex required');
        }

        const options = (row.options as string[]) ?? [];
        // Rule 6: Quiz answer index outside options range is rejected, not scored as wrong.
        if (attempt.selectedIndex < 0 || attempt.selectedIndex >= options.length) {
          throw new LearningRuleError(
            'invalid_input',
            `Quiz answer index (${attempt.selectedIndex}) outside options range (0-${options.length - 1})`
          );
        }

        isCorrect = attempt.selectedIndex === row.correct_index;
      }

      // Recording an attempt must be ONE atomic SQL statement:
      // ON CONFLICT (player_id, step_id) DO UPDATE SET attempts = ..., completed_at = COALESCE(learning_progress.completed_at, ...)
      const completedAtParam = isCorrect ? at : null;
      const insertRes = await client.query<{ attempts: number; completed_at: Date | null }>(
        `INSERT INTO learning_progress (player_id, course_id, lesson_id, step_id, attempts, completed_at)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (player_id, step_id) DO UPDATE SET
           attempts = CASE
             WHEN learning_progress.completed_at IS NOT NULL AND EXCLUDED.completed_at IS NOT NULL THEN learning_progress.attempts
             ELSE learning_progress.attempts + 1
           END,
           completed_at = COALESCE(learning_progress.completed_at, EXCLUDED.completed_at)
         RETURNING attempts, completed_at`,
        [playerId, row.course_id, row.lesson_id, stepId, completedAtParam]
      );

      await client.query('COMMIT');

      const resRow = insertRes.rows[0];
      return {
        stepId,
        correct: isCorrect,
        ...(resRow.completed_at ? { completedAt: resRow.completed_at } : {}),
        attempts: resRow.attempts,
      };
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Step');
    } finally {
      client.release();
    }
  }

  async getProgressSummary(playerId: string, courseId: string): Promise<CourseProgressSummary> {
    await this.getCourse(courseId, playerId);

    try {
      const res = await this.pool.query<{ total_steps: string; completed_steps: string }>(
        `SELECT
           COUNT(s.id) AS total_steps,
           COUNT(p.step_id) FILTER (WHERE p.completed_at IS NOT NULL) AS completed_steps
         FROM learning_steps s
         JOIN learning_lessons l ON l.id = s.lesson_id
         LEFT JOIN learning_progress p ON p.step_id = s.id AND p.player_id = $1
         WHERE l.course_id = $2 AND s.deleted_at IS NULL AND l.deleted_at IS NULL`,
        [playerId, courseId]
      );

      const row = res.rows[0];
      return {
        courseId,
        playerId,
        totalSteps: Number(row?.total_steps ?? 0),
        completedSteps: Number(row?.completed_steps ?? 0),
      };
    } catch (err) {
      this.handleSqlError(err, 'Course');
    }
  }

  async listProgress(playerId: string, courseId: string): Promise<readonly Progress[]> {
    await this.getCourse(courseId, playerId);

    try {
      const res = await this.pool.query<ProgressRow>(
        `SELECT player_id, course_id, lesson_id, step_id, completed_at, attempts FROM learning_progress WHERE player_id = $1 AND course_id = $2`,
        [playerId, courseId]
      );
      const list = res.rows.map(mapProgress);
      list.sort(compareProgress);
      return list;
    } catch (err) {
      this.handleSqlError(err, 'Course');
    }
  }
}
