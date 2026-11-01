import type { Pool, PoolClient } from 'pg';
import type {
  Chapter,
  Collaborator,
  Page,
  PageOptions,
  InitialPositionPort,
  PositionReader,
  StudiesRepository,
  Study,
  StudyRole,
  StudyVariant,
  StudyVisibility,
  TreeNode,
  PgnMoveNode,
  PgnGame,
} from '@chess-platform/studies';
import {
  StudyRuleError,
  DEFAULT_STUDY_VARIANT,
  MAX_GAMES_PER_IMPORT,
  MAX_PGN_BYTES,
  normalizeChapterName,
  normalizeStudyName,
  roleRank,
  parsePgn,
  serializePgnGames,
  chapterNameFor,
  resolveSan,
  tagValue,
  compareChapters,
  compareCollaborators,
  compareTreeNodes,
} from '@chess-platform/studies';
import { uuidv7 } from '../ids';
import {
  isForeignKeyViolation,
  isInvalidTextRepresentation,
  isUniqueViolation,
} from './sqlstate';

interface StudyRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  visibility: StudyVisibility;
  variant: StudyVariant;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface CollaboratorRow {
  study_id: string;
  player_id: string;
  role: StudyRole;
}

interface ChapterRow {
  id: string;
  study_id: string;
  name: string;
  order_index: number;
  starting_fen: string;
  deleted_at: Date | null;
}

interface TreeNodeRow {
  id: string;
  chapter_id: string;
  parent_id: string | null;
  san: string;
  fen_after: string;
  comment: string | null;
  nags: number[];
  order_index: number;
}

function mapStudy(row: StudyRow): Study {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    variant: row.variant,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function mapCollaborator(row: CollaboratorRow): Collaborator {
  return {
    studyId: row.study_id,
    playerId: row.player_id,
    role: row.role,
  };
}

function mapChapter(row: ChapterRow): Chapter {
  return {
    id: row.id,
    studyId: row.study_id,
    name: row.name,
    orderIndex: row.order_index,
    startingFen: row.starting_fen,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function mapTreeNode(row: TreeNodeRow): TreeNode {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    parentId: row.parent_id,
    san: row.san,
    fenAfter: row.fen_after,
    ...(row.comment !== null && row.comment !== undefined ? { comment: row.comment } : {}),
    nags: row.nags ?? [],
    orderIndex: row.order_index,
  };
}

async function lockStudy(client: PoolClient, studyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('study:' || $1::text, 0))`,
    [studyId]
  );
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

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

export class PgStudiesRepository implements StudiesRepository {
  constructor(
    private readonly pool: Pool,
    private readonly positionReader: InitialPositionPort
  ) {}

  private handleSqlError(err: unknown, entityLabel = 'Resource'): never {
    if (err instanceof StudyRuleError) {
      throw err;
    }
    if (isInvalidTextRepresentation(err)) {
      throw new StudyRuleError('not_found', `${entityLabel} not found`);
    }
    if (isForeignKeyViolation(err)) {
      throw new StudyRuleError('not_found', `Referenced user or resource does not exist`);
    }
    if (isUniqueViolation(err)) {
      throw new StudyRuleError('invalid_input', `${entityLabel} already exists or violates constraint`);
    }
    throw err;
  }

  private async getCollaboratorInternal(
    client: PoolClient | Pool,
    studyId: string,
    playerId: string,
    forUpdate = false
  ): Promise<Collaborator | null> {
    const sql = `SELECT study_id, player_id, role FROM study_collaborators WHERE study_id = $1 AND player_id = $2${
      forUpdate ? ' FOR UPDATE' : ''
    }`;
    const res = await client.query<CollaboratorRow>(sql, [studyId, playerId]);
    if (res.rows.length === 0) return null;
    return mapCollaborator(res.rows[0]);
  }

  private async findVisibleStudyInternal(
    client: PoolClient | Pool,
    studyId: string,
    actorId?: string,
    allowDeleted = false,
    forUpdate = false
  ): Promise<Study> {
    const lockClause = forUpdate ? ' FOR UPDATE' : '';
    const res = await client.query<StudyRow>(
      `SELECT id, owner_id, name, description, visibility, variant, created_at, updated_at, deleted_at
       FROM studies
       WHERE id = $1${lockClause}`,
      [studyId]
    );

    if (res.rows.length === 0) {
      throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
    }

    const row = res.rows[0];
    if (row.visibility === 'private') {
      if (!actorId) {
        throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
      }
      const collab = await this.getCollaboratorInternal(client, studyId, actorId, forUpdate);
      if (!collab) {
        throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
      }
    }

    if (!allowDeleted && row.deleted_at !== null) {
      throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
    }

    return mapStudy(row);
  }

  private async assertAuthorityInternal(
    client: PoolClient | Pool,
    studyId: string,
    actorId: string,
    minRole: StudyRole,
    forUpdate = false
  ): Promise<Collaborator> {
    const collab = await this.getCollaboratorInternal(client, studyId, actorId, forUpdate);
    if (!collab || roleRank(collab.role) < roleRank(minRole)) {
      throw new StudyRuleError('not_authorized', `Action requires ${minRole} role or higher`);
    }
    return collab;
  }

  private async peekStudyIdByChapterId(client: PoolClient, chapterId: string): Promise<string> {
    const res = await client.query<{ study_id: string }>(
      `SELECT study_id FROM study_chapters WHERE id = $1`,
      [chapterId]
    );
    if (res.rows.length === 0) {
      throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
    }
    return res.rows[0].study_id;
  }

  private async peekStudyIdByNodeId(client: PoolClient, nodeId: string): Promise<{ studyId: string; chapterId: string }> {
    const res = await client.query<{ study_id: string; chapter_id: string }>(
      `SELECT c.study_id, n.chapter_id
       FROM study_tree_nodes n
       JOIN study_chapters c ON c.id = n.chapter_id
       WHERE n.id = $1`,
      [nodeId]
    );
    if (res.rows.length === 0) {
      throw new StudyRuleError('not_found', `Node '${nodeId}' not found`);
    }
    return { studyId: res.rows[0].study_id, chapterId: res.rows[0].chapter_id };
  }

  async createStudy(
    id: string,
    ownerId: string,
    name: string,
    description: string,
    visibility: StudyVisibility,
    at = new Date(),
    options?: { variant?: StudyVariant },
  ): Promise<Study> {
    const validName = normalizeStudyName(name);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, id);

      const existing = await client.query(`SELECT id FROM studies WHERE id = $1`, [id]);
      if (existing.rows.length > 0) {
        throw new StudyRuleError('invalid_input', `Study '${id}' already exists`);
      }

      const res = await client.query<StudyRow>(
        `INSERT INTO studies (id, owner_id, name, description, visibility, variant, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id, owner_id, name, description, visibility, variant, created_at, updated_at, deleted_at`,
        [id, ownerId, validName, description.trim(), visibility, options?.variant ?? DEFAULT_STUDY_VARIANT, at]
      );

      await client.query(
        `INSERT INTO study_collaborators (study_id, player_id, role)
         VALUES ($1, $2, 'owner')`,
        [id, ownerId]
      );

      await client.query('COMMIT');
      return mapStudy(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Study');
    } finally {
      client.release();
    }
  }

  async getStudy(studyId: string, actorId?: string): Promise<Study> {
    try {
      return await this.findVisibleStudyInternal(this.pool, studyId, actorId);
    } catch (err) {
      this.handleSqlError(err, 'Study');
    }
  }

  async updateStudy(
    studyId: string,
    actorId: string,
    updates: { name?: string; description?: string; visibility?: StudyVisibility },
    at = new Date()
  ): Promise<Study> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      const study = await this.findVisibleStudyInternal(client, studyId, actorId, true, true);
      await this.assertAuthorityInternal(
        client,
        studyId,
        actorId,
        updates.visibility !== undefined ? 'owner' : 'contributor',
        true
      );

      if (study.deletedAt !== undefined) {
        throw new StudyRuleError('invalid_transition', `Study '${studyId}' is already deleted`);
      }

      const updatedName = updates.name !== undefined ? normalizeStudyName(updates.name) : study.name;
      const updatedDesc = updates.description !== undefined ? updates.description.trim() : study.description;
      const updatedVis = updates.visibility !== undefined ? updates.visibility : study.visibility;

      const res = await client.query<StudyRow>(
        `UPDATE studies
         SET name = $2, description = $3, visibility = $4, updated_at = $5
         WHERE id = $1
         RETURNING id, owner_id, name, description, visibility, variant, created_at, updated_at, deleted_at`,
        [studyId, updatedName, updatedDesc, updatedVis, at]
      );

      await client.query('COMMIT');
      return mapStudy(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Study');
    } finally {
      client.release();
    }
  }

  async deleteStudy(studyId: string, actorId: string, at = new Date()): Promise<Study> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      const study = await this.findVisibleStudyInternal(client, studyId, actorId, true, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'owner', true);

      if (study.deletedAt !== undefined) {
        throw new StudyRuleError('invalid_transition', `Study '${studyId}' is already deleted`);
      }

      const res = await client.query<StudyRow>(
        `UPDATE studies
         SET deleted_at = $2, updated_at = $2
         WHERE id = $1
         RETURNING id, owner_id, name, description, visibility, variant, created_at, updated_at, deleted_at`,
        [studyId, at]
      );

      await client.query('COMMIT');
      return mapStudy(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Study');
    } finally {
      client.release();
    }
  }

  async listStudies(
    actorId?: string,
    options?: PageOptions & { search?: string; ownerId?: string }
  ): Promise<Page<Study>> {
    try {
      const params: unknown[] = [];
      const conditions: string[] = ['s.deleted_at IS NULL', "s.visibility != 'unlisted'"];

      if (actorId) {
        params.push(actorId);
        const actorIdx = params.length;
        conditions.push(
          `(s.visibility = 'public' OR (s.visibility = 'private' AND EXISTS (
             SELECT 1 FROM study_collaborators c WHERE c.study_id = s.id AND c.player_id = $${actorIdx}
           )))`
        );
      } else {
        conditions.push("s.visibility = 'public'");
      }

      if (options?.ownerId) {
        params.push(options.ownerId);
        conditions.push(`s.owner_id = $${params.length}`);
      }

      if (options?.search && options.search.trim().length > 0) {
        const searchPattern = `%${options.search.trim().toLowerCase()}%`;
        params.push(searchPattern);
        const searchIdx = params.length;
        conditions.push(`(LOWER(s.name) LIKE $${searchIdx} OR LOWER(s.description) LIKE $${searchIdx})`);
      }

      const whereClause = conditions.join(' AND ');

      // Total count query
      const countRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM studies s WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countRes.rows[0].count, 10);

      const offset = normalizeOffset(options?.offset);
      const limit = normalizeLimit(options?.limit);

      const itemsParams = [...params];
      let limitOffsetClause = `OFFSET $${itemsParams.push(offset)}`;
      if (limit !== undefined) {
        limitOffsetClause = `LIMIT $${itemsParams.push(limit)} ${limitOffsetClause}`;
      }

      const query = `
        SELECT s.id, s.owner_id, s.name, s.description, s.visibility, s.variant, s.created_at, s.updated_at, s.deleted_at
        FROM studies s
        WHERE ${whereClause}
        ORDER BY s.created_at DESC, s.id ASC
        ${limitOffsetClause}
      `;

      const itemsRes = await this.pool.query<StudyRow>(query, itemsParams);
      const items = itemsRes.rows.map(mapStudy);

      return { total, items };
    } catch (err) {
      this.handleSqlError(err, 'Study');
    }
  }

  async addCollaborator(
    studyId: string,
    actorId: string,
    playerId: string,
    role: StudyRole,
    _at = new Date()
  ): Promise<Collaborator> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'owner', true);

      if (role === 'owner') {
        throw new StudyRuleError('invalid_input', 'Cannot add owner role via addCollaborator. Use transferOwnership.');
      }

      const existing = await this.getCollaboratorInternal(client, studyId, playerId, true);
      if (existing && existing.role === 'owner') {
        throw new StudyRuleError('invalid_transition', 'Cannot overwrite owner role');
      }

      const res = await client.query<CollaboratorRow>(
        `INSERT INTO study_collaborators (study_id, player_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (study_id, player_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING study_id, player_id, role`,
        [studyId, playerId, role]
      );

      await client.query('COMMIT');
      return mapCollaborator(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Collaborator');
    } finally {
      client.release();
    }
  }

  async updateCollaboratorRole(
    studyId: string,
    actorId: string,
    targetPlayerId: string,
    newRole: StudyRole,
    _at = new Date()
  ): Promise<Collaborator> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'owner', true);

      if (newRole === 'owner') {
        throw new StudyRuleError('invalid_transition', 'Cannot promote to owner via role update. Use transferOwnership.');
      }

      if (actorId === targetPlayerId) {
        throw new StudyRuleError('invalid_transition', 'Cannot change your own role');
      }

      const existing = await this.getCollaboratorInternal(client, studyId, targetPlayerId, true);
      if (!existing) {
        throw new StudyRuleError('not_found', `Player '${targetPlayerId}' is not a collaborator on study '${studyId}'`);
      }

      const res = await client.query<CollaboratorRow>(
        `UPDATE study_collaborators
         SET role = $3
         WHERE study_id = $1 AND player_id = $2
         RETURNING study_id, player_id, role`,
        [studyId, targetPlayerId, newRole]
      );

      await client.query('COMMIT');
      return mapCollaborator(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Collaborator');
    } finally {
      client.release();
    }
  }

  async removeCollaborator(studyId: string, actorId: string, targetPlayerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'owner', true);

      const existing = await this.getCollaboratorInternal(client, studyId, targetPlayerId, true);
      if (!existing) {
        throw new StudyRuleError('not_found', `Player '${targetPlayerId}' is not a collaborator on study '${studyId}'`);
      }

      if (existing.role === 'owner') {
        throw new StudyRuleError('invalid_transition', 'Cannot remove owner from study. Transfer ownership first.');
      }

      await client.query(
        `DELETE FROM study_collaborators WHERE study_id = $1 AND player_id = $2`,
        [studyId, targetPlayerId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Collaborator');
    } finally {
      client.release();
    }
  }

  async transferOwnership(
    studyId: string,
    actorId: string,
    newOwnerId: string,
    at = new Date()
  ): Promise<{ oldOwner: Collaborator; newOwner: Collaborator; study: Study }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'owner', true);

      if (actorId === newOwnerId) {
        throw new StudyRuleError('invalid_transition', 'You are already the owner');
      }

      const targetCollab = await this.getCollaboratorInternal(client, studyId, newOwnerId, true);
      if (!targetCollab) {
        throw new StudyRuleError(
          'not_found',
          `Player '${newOwnerId}' is not a collaborator on study '${studyId}'`
        );
      }

      // NON-NEGOTIABLE: Demote old owner BEFORE promoting new owner to avoid 2 owners constraint violation
      await client.query(
        `UPDATE study_collaborators SET role = 'contributor' WHERE study_id = $1 AND player_id = $2`,
        [studyId, actorId]
      );

      await client.query(
        `UPDATE study_collaborators SET role = 'owner' WHERE study_id = $1 AND player_id = $2`,
        [studyId, newOwnerId]
      );

      const studyRes = await client.query<StudyRow>(
        `UPDATE studies
         SET owner_id = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, owner_id, name, description, visibility, variant, created_at, updated_at, deleted_at`,
        [studyId, newOwnerId, at]
      );

      await client.query('COMMIT');

      const oldOwner: Collaborator = { studyId, playerId: actorId, role: 'contributor' };
      const newOwner: Collaborator = { studyId, playerId: newOwnerId, role: 'owner' };
      return { oldOwner, newOwner, study: mapStudy(studyRes.rows[0]) };
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Study');
    } finally {
      client.release();
    }
  }

  async listCollaborators(studyId: string, actorId?: string, options?: PageOptions): Promise<Page<Collaborator>> {
    try {
      await this.findVisibleStudyInternal(this.pool, studyId, actorId);

      const res = await this.pool.query<CollaboratorRow>(
        `SELECT study_id, player_id, role FROM study_collaborators WHERE study_id = $1`,
        [studyId]
      );

      const collabs = res.rows.map(mapCollaborator);
      collabs.sort(compareCollaborators);

      const offset = normalizeOffset(options?.offset);
      const limit = normalizeLimit(options?.limit);
      const total = collabs.length;
      const end = limit === undefined ? total : offset + limit;

      return { total, items: collabs.slice(offset, end) };
    } catch (err) {
      this.handleSqlError(err, 'Collaborator');
    }
  }

  async createChapter(
    id: string,
    studyId: string,
    actorId: string,
    name: string,
    startingFen?: string,
    at = new Date()
  ): Promise<Chapter> {
    const validName = normalizeChapterName(name);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      const study = await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      const existing = await client.query(`SELECT id FROM study_chapters WHERE id = $1`, [id]);
      if (existing.rows.length > 0) {
        throw new StudyRuleError('invalid_input', `Chapter '${id}' already exists`);
      }

      const resolvedStartingFen = startingFen !== undefined
        ? startingFen
        : this.positionReader.initialFen(study.variant);

      const activeCountRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM study_chapters WHERE study_id = $1 AND deleted_at IS NULL`,
        [studyId]
      );
      const orderIndex = parseInt(activeCountRes.rows[0].count, 10);

      const res = await client.query<ChapterRow>(
        `INSERT INTO study_chapters (id, study_id, name, order_index, starting_fen)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, study_id, name, order_index, starting_fen, deleted_at`,
        [id, studyId, validName, orderIndex, resolvedStartingFen]
      );

      await client.query(`UPDATE studies SET updated_at = $2 WHERE id = $1`, [studyId, at]);

      await client.query('COMMIT');
      return mapChapter(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Chapter');
    } finally {
      client.release();
    }
  }

  async getChapter(chapterId: string, actorId?: string): Promise<{ chapter: Chapter; tree: readonly TreeNode[] }> {
    try {
      const chapterRes = await this.pool.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE id = $1`,
        [chapterId]
      );

      if (chapterRes.rows.length === 0) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
      }

      const chapterRow = chapterRes.rows[0];
      if (chapterRow.deleted_at !== null) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
      }

      await this.findVisibleStudyInternal(this.pool, chapterRow.study_id, actorId);

      // Single query loading all nodes for chapter (NO N+1)
      const nodesRes = await this.pool.query<TreeNodeRow>(
        `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
         FROM study_tree_nodes
         WHERE chapter_id = $1
         ORDER BY order_index ASC, id ASC`,
        [chapterId]
      );

      // No second sort. `ORDER BY order_index ASC, id ASC` is exactly `compareTreeNodes`, and the
      // `id` tie-break agrees because these are `uuid` columns: Postgres compares them byte-wise,
      // which coincides with the code-point order the comparator uses on canonical lowercase UUID
      // text (ADR-0067 §2). Re-sorting in JS could only ever confirm what the database already did.
      // The coupling is real, so the two must be changed together.
      const tree = nodesRes.rows.map(mapTreeNode);

      return { chapter: mapChapter(chapterRow), tree };
    } catch (err) {
      this.handleSqlError(err, 'Chapter');
    }
  }

  async listChapters(studyId: string, actorId?: string): Promise<readonly Chapter[]> {
    try {
      await this.findVisibleStudyInternal(this.pool, studyId, actorId);

      const res = await this.pool.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE study_id = $1 AND deleted_at IS NULL
         ORDER BY order_index ASC, id ASC`,
        [studyId]
      );

      const chapters = res.rows.map(mapChapter);
      chapters.sort(compareChapters);
      return chapters;
    } catch (err) {
      this.handleSqlError(err, 'Chapter');
    }
  }

  async updateChapter(chapterId: string, actorId: string, updates: { name?: string }, at = new Date()): Promise<Chapter> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const studyId = await this.peekStudyIdByChapterId(client, chapterId);
      await lockStudy(client, studyId);

      const chapterRes = await client.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE id = $1 FOR UPDATE`,
        [chapterId]
      );

      if (chapterRes.rows.length === 0) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
      }

      const chapterRow = chapterRes.rows[0];
      await this.findVisibleStudyInternal(client, studyId, actorId, true, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      if (chapterRow.deleted_at !== null) {
        throw new StudyRuleError('invalid_transition', `Chapter '${chapterId}' is already deleted`);
      }

      const updatedName = updates.name !== undefined ? normalizeChapterName(updates.name) : chapterRow.name;
      const res = await client.query<ChapterRow>(
        `UPDATE study_chapters
         SET name = $2
         WHERE id = $1
         RETURNING id, study_id, name, order_index, starting_fen, deleted_at`,
        [chapterId, updatedName]
      );

      await client.query(`UPDATE studies SET updated_at = $2 WHERE id = $1`, [studyId, at]);

      await client.query('COMMIT');
      return mapChapter(res.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Chapter');
    } finally {
      client.release();
    }
  }

  async deleteChapter(chapterId: string, actorId: string, at = new Date()): Promise<Chapter> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const studyId = await this.peekStudyIdByChapterId(client, chapterId);
      await lockStudy(client, studyId);

      const chapterRes = await client.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE id = $1 FOR UPDATE`,
        [chapterId]
      );

      if (chapterRes.rows.length === 0) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
      }

      const chapterRow = chapterRes.rows[0];
      await this.findVisibleStudyInternal(client, studyId, actorId, true, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      if (chapterRow.deleted_at !== null) {
        throw new StudyRuleError('invalid_transition', `Chapter '${chapterId}' is already deleted`);
      }

      const tombstonedRes = await client.query<ChapterRow>(
        `UPDATE study_chapters
         SET deleted_at = $2
         WHERE id = $1
         RETURNING id, study_id, name, order_index, starting_fen, deleted_at`,
        [chapterId, at]
      );

      // Re-compact remaining active chapters orderIndex
      const remainingRes = await client.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE study_id = $1 AND deleted_at IS NULL
         ORDER BY order_index ASC, id ASC
         FOR UPDATE`,
        [studyId]
      );

      const remaining = remainingRes.rows.map(mapChapter).sort(compareChapters);
      for (let i = 0; i < remaining.length; i++) {
        await client.query(
          `UPDATE study_chapters SET order_index = $2 WHERE id = $1`,
          [remaining[i].id, i]
        );
      }

      await client.query(`UPDATE studies SET updated_at = $2 WHERE id = $1`, [studyId, at]);

      await client.query('COMMIT');
      return mapChapter(tombstonedRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Chapter');
    } finally {
      client.release();
    }
  }

  async reorderChapters(
    studyId: string,
    actorId: string,
    chapterIds: readonly string[],
    at = new Date()
  ): Promise<readonly Chapter[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      const activeRes = await client.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE study_id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [studyId]
      );

      const activeMap = new Map(activeRes.rows.map((r) => [r.id, mapChapter(r)]));
      if (activeMap.size !== chapterIds.length) {
        throw new StudyRuleError('invalid_input', 'chapterIds count does not match active chapters count');
      }

      for (const id of chapterIds) {
        if (!activeMap.has(id)) {
          throw new StudyRuleError('invalid_input', `Chapter '${id}' is not an active chapter of study '${studyId}'`);
        }
      }

      // Temporarily set active order_index to negative values to prevent unique constraint collision
      await client.query(
        `UPDATE study_chapters SET order_index = -1 - order_index WHERE study_id = $1 AND deleted_at IS NULL`,
        [studyId]
      );

      const updatedChapters: Chapter[] = [];
      for (let index = 0; index < chapterIds.length; index++) {
        const id = chapterIds[index];
        const res = await client.query<ChapterRow>(
          `UPDATE study_chapters SET order_index = $2 WHERE id = $1
           RETURNING id, study_id, name, order_index, starting_fen, deleted_at`,
          [id, index]
        );
        updatedChapters.push(mapChapter(res.rows[0]));
      }

      await client.query(`UPDATE studies SET updated_at = $2 WHERE id = $1`, [studyId, at]);

      await client.query('COMMIT');
      return updatedChapters;
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'Chapter');
    } finally {
      client.release();
    }
  }

  async appendNode(
    chapterId: string,
    actorId: string,
    parentId: string | null,
    san: string,
    reader: PositionReader,
    options?: { comment?: string; nags?: readonly number[]; nodeId?: string }
  ): Promise<TreeNode> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const studyId = await this.peekStudyIdByChapterId(client, chapterId);
      await lockStudy(client, studyId);

      const chapterRes = await client.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters WHERE id = $1 FOR UPDATE`,
        [chapterId]
      );
      if (chapterRes.rows.length === 0 || chapterRes.rows[0].deleted_at !== null) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
      }

      const study = await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      let parentFen = chapterRes.rows[0].starting_fen;
      if (parentId !== null) {
        const parentRes = await client.query<TreeNodeRow>(
          `SELECT id, chapter_id, fen_after FROM study_tree_nodes WHERE id = $1 FOR UPDATE`,
          [parentId]
        );
        if (parentRes.rows.length === 0 || parentRes.rows[0].chapter_id !== chapterId) {
          throw new StudyRuleError('not_found', `Parent node '${parentId}' not found in chapter '${chapterId}'`);
        }
        parentFen = parentRes.rows[0].fen_after;
      }

      const resolvedSan = resolveSan(reader, parentFen, san, study.variant);

      // Rule 4: Return existing child if move already exists under parent
      const siblingsRes = await client.query<TreeNodeRow>(
        `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
         FROM study_tree_nodes
         WHERE chapter_id = $1 AND parent_id IS NOT DISTINCT FROM $2
         FOR UPDATE`,
        [chapterId, parentId]
      );

      for (const row of siblingsRes.rows) {
        if (row.san === resolvedSan) {
          await client.query('COMMIT');
          return mapTreeNode(row);
        }
      }

      const fenAfter = reader.play(parentFen, resolvedSan, study.variant);
      const newNodeId = options?.nodeId ?? uuidv7();
      const orderIndex = siblingsRes.rows.length;

      const insertRes = await client.query<TreeNodeRow>(
        `INSERT INTO study_tree_nodes (id, chapter_id, parent_id, san, fen_after, comment, nags, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, chapter_id, parent_id, san, fen_after, comment, nags, order_index`,
        [
          newNodeId,
          chapterId,
          parentId,
          resolvedSan,
          fenAfter,
          options?.comment ?? null,
          options?.nags ? [...options.nags] : [],
          orderIndex,
        ]
      );

      await client.query('COMMIT');
      return mapTreeNode(insertRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'TreeNode');
    } finally {
      client.release();
    }
  }

  async annotateNode(
    nodeId: string,
    actorId: string,
    updates: { comment?: string; nags?: readonly number[] }
  ): Promise<TreeNode> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { studyId } = await this.peekStudyIdByNodeId(client, nodeId);
      await lockStudy(client, studyId);

      const nodeRes = await client.query<TreeNodeRow>(
        `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
         FROM study_tree_nodes WHERE id = $1 FOR UPDATE`,
        [nodeId]
      );
      if (nodeRes.rows.length === 0) {
        throw new StudyRuleError('not_found', `Node '${nodeId}' not found`);
      }

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      const existing = mapTreeNode(nodeRes.rows[0]);
      const newComment = updates.comment !== undefined ? updates.comment : existing.comment;
      const newNags = updates.nags !== undefined ? [...updates.nags] : existing.nags;

      const updateRes = await client.query<TreeNodeRow>(
        `UPDATE study_tree_nodes
         SET comment = $2, nags = $3
         WHERE id = $1
         RETURNING id, chapter_id, parent_id, san, fen_after, comment, nags, order_index`,
        [nodeId, newComment ?? null, newNags]
      );

      await client.query('COMMIT');
      return mapTreeNode(updateRes.rows[0]);
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'TreeNode');
    } finally {
      client.release();
    }
  }

  async deleteNode(nodeId: string, actorId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { studyId, chapterId } = await this.peekStudyIdByNodeId(client, nodeId);
      await lockStudy(client, studyId);

      const nodeRes = await client.query<TreeNodeRow>(
        `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
         FROM study_tree_nodes WHERE id = $1 FOR UPDATE`,
        [nodeId]
      );
      if (nodeRes.rows.length === 0) {
        throw new StudyRuleError('not_found', `Node '${nodeId}' not found`);
      }

      const parentId = nodeRes.rows[0].parent_id;
      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      // ON DELETE CASCADE in Postgres automatically deletes descendant tree nodes
      await client.query(`DELETE FROM study_tree_nodes WHERE id = $1`, [nodeId]);

      // Re-compact sibling orderIndex under parentId
      const remainingSiblings = await client.query<TreeNodeRow>(
        `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
         FROM study_tree_nodes
         WHERE chapter_id = $1 AND parent_id IS NOT DISTINCT FROM $2
         ORDER BY order_index ASC, id ASC
         FOR UPDATE`,
        [chapterId, parentId]
      );

      const sortedSiblings = remainingSiblings.rows.map(mapTreeNode).sort(compareTreeNodes);
      for (let i = 0; i < sortedSiblings.length; i++) {
        await client.query(
          `UPDATE study_tree_nodes SET order_index = $2 WHERE id = $1`,
          [sortedSiblings[i].id, i]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'TreeNode');
    } finally {
      client.release();
    }
  }

  async importPgn(
    studyId: string,
    actorId: string,
    pgnString: string,
    reader: PositionReader,
    at = new Date()
  ): Promise<readonly Chapter[]> {
    if (Buffer.byteLength(pgnString, 'utf8') > MAX_PGN_BYTES) {
      throw new StudyRuleError('too_large', `PGN exceeds max limit of ${MAX_PGN_BYTES} bytes`);
    }

    const games = parsePgn(pgnString);
    if (games.length > MAX_GAMES_PER_IMPORT) {
      throw new StudyRuleError('too_large', `Import exceeds max limit of ${MAX_GAMES_PER_IMPORT} games`);
    }

    const study = await this.findVisibleStudyInternal(this.pool, studyId, actorId);

    // Dry-run validate playability BEFORE opening transaction or writing rows!
    const validatedGames: { name: string; startingFen: string; moves: readonly PgnMoveNode[] }[] = [];
    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const name = chapterNameFor(game, i);

      const startingFen = tagValue(game, 'FEN') || this.positionReader.initialFen(study.variant);
      reader.legalSans(startingFen, study.variant);
      this.validatePlayableMovetext(game.moves, startingFen, reader, study.variant);
      validatedGames.push({ name, startingFen, moves: game.moves });
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockStudy(client, studyId);

      await this.findVisibleStudyInternal(client, studyId, actorId, false, true);
      await this.assertAuthorityInternal(client, studyId, actorId, 'contributor', true);

      const importedChapters: Chapter[] = [];
      for (const g of validatedGames) {
        const chapterId = uuidv7();
        const activeCountRes = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM study_chapters WHERE study_id = $1 AND deleted_at IS NULL`,
          [studyId]
        );
        const orderIndex = parseInt(activeCountRes.rows[0].count, 10);
        const validName = normalizeChapterName(g.name);

        const chRes = await client.query<ChapterRow>(
          `INSERT INTO study_chapters (id, study_id, name, order_index, starting_fen)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, study_id, name, order_index, starting_fen, deleted_at`,
          [chapterId, studyId, validName, orderIndex, g.startingFen]
        );
        const chapter = mapChapter(chRes.rows[0]);

        await this.buildTreeFromMovetextInternal(
          client,
          chapter.id,
          null,
          g.moves,
          g.startingFen,
          reader,
          study.variant,
        );
        importedChapters.push(chapter);
      }

      await client.query(`UPDATE studies SET updated_at = $2 WHERE id = $1`, [studyId, at]);

      await client.query('COMMIT');
      return importedChapters;
    } catch (err) {
      await rollback(client);
      this.handleSqlError(err, 'PGN Import');
    } finally {
      client.release();
    }
  }

  private validatePlayableMovetext(
    moves: readonly PgnMoveNode[],
    fen: string,
    reader: PositionReader,
    variant: StudyVariant,
  ): void {
    let currentFen = fen;
    for (const moveNode of moves) {
      for (const varLine of moveNode.variations) {
        this.validatePlayableMovetext(varLine, currentFen, reader, variant);
      }
      const resolvedSan = resolveSan(reader, currentFen, moveNode.san, variant);
      currentFen = reader.play(currentFen, resolvedSan, variant);
    }
  }

  private async buildTreeFromMovetextInternal(
    client: PoolClient,
    chapterId: string,
    parentId: string | null,
    moves: readonly PgnMoveNode[],
    fen: string,
    reader: PositionReader,
    variant: StudyVariant,
  ): Promise<void> {
    let currentParentId = parentId;
    let currentFen = fen;

    for (const moveNode of moves) {
      // The move goes in BEFORE its variations, and the order is the whole meaning of the tree.
      //
      // `orderIndex` is assigned as the current sibling count, and `exportPgn` treats the first
      // child as the mainline. Inserting the variations first therefore gives them index 0 and
      // demotes the move actually played to a variation of itself — every import carrying a `(...)`
      // came back with its mainline and its sidelines swapped. Nothing errored; the game was simply
      // a different game.
      //
      // The variations still hang off `parentForVariations`, the position BEFORE this move, because
      // that is what a PGN variation is: an alternative to the move, not a continuation of it.
      const parentForVariations = currentParentId;
      const fenForVariations = currentFen;

      const resolvedSan = resolveSan(reader, currentFen, moveNode.san, variant);
      const fenAfter = reader.play(currentFen, resolvedSan, variant);
      const nodeId = uuidv7();

      const sibCountRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM study_tree_nodes WHERE chapter_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
        [chapterId, currentParentId]
      );
      const orderIndex = parseInt(sibCountRes.rows[0].count, 10);

      const comment = moveNode.comments.length > 0 ? moveNode.comments.join('\n') : null;
      await client.query(
        `INSERT INTO study_tree_nodes (id, chapter_id, parent_id, san, fen_after, comment, nags, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [nodeId, chapterId, currentParentId, resolvedSan, fenAfter, comment, moveNode.nags ?? [], orderIndex]
      );

      for (const varLine of moveNode.variations) {
        await this.buildTreeFromMovetextInternal(
          client,
          chapterId,
          parentForVariations,
          varLine,
          fenForVariations,
          reader,
          variant,
        );
      }

      currentParentId = nodeId;
      currentFen = fenAfter;
    }
  }

  async exportPgn(studyId: string, actorId?: string, chapterId?: string): Promise<string> {
    try {
      const study = await this.findVisibleStudyInternal(this.pool, studyId, actorId);

      const activeChaptersRes = await this.pool.query<ChapterRow>(
        `SELECT id, study_id, name, order_index, starting_fen, deleted_at
         FROM study_chapters
         WHERE study_id = $1 AND deleted_at IS NULL
         ORDER BY order_index ASC, id ASC`,
        [studyId]
      );

      const activeChapters = activeChaptersRes.rows.map(mapChapter).sort(compareChapters);
      const targetChapters = chapterId
        ? activeChapters.filter((c) => c.id === chapterId)
        : activeChapters;

      if (chapterId && targetChapters.length === 0) {
        throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found in study '${studyId}'`);
      }

      const pgnGames: PgnGame[] = [];
      const canonicalStartingFen = this.positionReader.initialFen(study.variant);
      for (const chapter of targetChapters) {
        const nodesRes = await this.pool.query<TreeNodeRow>(
          `SELECT id, chapter_id, parent_id, san, fen_after, comment, nags, order_index
           FROM study_tree_nodes
           WHERE chapter_id = $1
           ORDER BY order_index ASC, id ASC`,
          [chapter.id]
        );
        // Ordered by the query, as in `getChapter` — see the note there on why the SQL and
        // `compareTreeNodes` agree and must stay that way.
        const nodes = nodesRes.rows.map(mapTreeNode);

        const moves = this.serializeNodeTree(nodes, null);
        const tags = [
          { key: 'Event', value: chapter.name },
          ...(study.variant !== DEFAULT_STUDY_VARIANT ? [{ key: 'Variant', value: study.variant }] : []),
          ...(chapter.startingFen !== canonicalStartingFen ? [{ key: 'FEN', value: chapter.startingFen }] : []),
        ];

        pgnGames.push({
          tags,
          preComments: [],
          moves,
          result: '*',
        });
      }

      return serializePgnGames(pgnGames);
    } catch (err) {
      this.handleSqlError(err, 'PGN Export');
    }
  }

  private serializeNodeTree(nodes: readonly TreeNode[], parentId: string | null): PgnMoveNode[] {
    const children = nodes
      .filter((n) => n.parentId === parentId)
      .sort(compareTreeNodes);

    if (children.length === 0) return [];

    const mainline = children[0];
    const siblingVariations = children.slice(1);

    const variations: PgnMoveNode[][] = siblingVariations.map((vNode) => {
      const varContinuation = this.serializeNodeTree(nodes, vNode.id);
      const firstVarMove: PgnMoveNode = {
        san: vNode.san,
        nags: vNode.nags,
        comments: vNode.comment ? [vNode.comment] : [],
        variations: [],
      };
      return [firstVarMove, ...varContinuation];
    });

    const mainlineContinuation = this.serializeNodeTree(nodes, mainline.id);
    const mainlineMove: PgnMoveNode = {
      san: mainline.san,
      nags: mainline.nags,
      comments: mainline.comment ? [mainline.comment] : [],
      variations,
    };

    return [mainlineMove, ...mainlineContinuation];
  }
}
