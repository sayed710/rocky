import { StudyRuleError } from './errors';
import type {
  Chapter,
  Collaborator,
  Study,
  StudyRole,
  StudyVariant,
  StudyVisibility,
  TreeNode,
} from './model';
import {
  normalizeChapterName,
  normalizeStudyName,
  DEFAULT_STARTING_FEN,
  DEFAULT_STUDY_VARIANT,
  roleRank,
} from './model';
import {
  compareChapters,
  compareCollaborators,
  compareStudies,
  compareTreeNodes,
} from './ordering';
import type { Page, PageOptions } from './pagination';
import { paginate } from './pagination';
import { parsePgn } from './pgn-parse';
import { serializePgnGames } from './pgn-serialize';
import type { PgnGame, PgnMoveNode } from './pgn-model';
import { MAX_GAMES_PER_IMPORT, MAX_PGN_BYTES, tagValue } from './pgn-model';
import type { PositionReader } from './move-resolver';
import { resolveSan } from './move-resolver';
import { chapterNameFor } from './import';

/**
 * Storage-agnostic port for studies, chapters, collaborators, and move trees.
 *
 * Every implementation owes all of these invariants:
 *
 * 1. Exactly one owner; ownership transfers rather than being abandoned, and the transfer demotes
 *    the old owner to `contributor`.
 * 2. Authority hierarchy `owner (3) > contributor (2) > viewer (1)`. Only `contributor`+ may edit
 *    chapters or the tree; only `owner` may change visibility, manage collaborators, or delete the study.
 * 3. `private` studies are invisible to non-collaborators and read as `not_found`. `unlisted` studies
 *    are readable by anyone holding the id but excluded from listings. `public` studies are listed.
 *    `not_authorized` is ONLY for something the actor can see but may not do.
 * 4. Appending a move: the node id is server-generated, and the move must be legal from the parent's
 *    `fenAfter` — resolved through `PositionReader`/`resolveSan`, never re-derived. Appending a move
 *    that already exists as a child returns that child instead of duplicating it.
 * 5. `orderIndex` is dense and stable, for chapters within a study and for siblings within a node.
 *    Reordering yields a contiguous sequence; two chapters in a study can never share an index.
 * 6. Deleting a chapter or study is a tombstone (`deletedAt` set). A tombstoned entity cannot be edited
 *    or deleted again (`invalid_transition`).
 * 7. Import creates one chapter per game in the PGN, in file order, capped by `MAX_GAMES_PER_IMPORT`.
 *    Each chapter's tree is built by walking the parsed movetext and resolving every SAN against the
 *    running position — a game whose movetext is not playable is rejected with `invalid_move` naming
 *    the move, not imported half-way.
 */
export interface StudiesRepository {
  createStudy(
    id: string,
    ownerId: string,
    name: string,
    description: string,
    visibility: StudyVisibility,
    at?: Date,
    options?: { variant?: StudyVariant },
  ): Promise<Study>;

  getStudy(studyId: string, actorId?: string): Promise<Study>;

  updateStudy(
    studyId: string,
    actorId: string,
    updates: { name?: string; description?: string; visibility?: StudyVisibility },
    at?: Date
  ): Promise<Study>;

  deleteStudy(studyId: string, actorId: string, at?: Date): Promise<Study>;

  listStudies(
    actorId?: string,
    options?: PageOptions & { search?: string; ownerId?: string }
  ): Promise<Page<Study>>;

  // Collaborator management
  addCollaborator(
    studyId: string,
    actorId: string,
    playerId: string,
    role: StudyRole,
    at?: Date
  ): Promise<Collaborator>;

  updateCollaboratorRole(
    studyId: string,
    actorId: string,
    targetPlayerId: string,
    newRole: StudyRole,
    at?: Date
  ): Promise<Collaborator>;

  removeCollaborator(
    studyId: string,
    actorId: string,
    targetPlayerId: string
  ): Promise<void>;

  transferOwnership(
    studyId: string,
    actorId: string,
    newOwnerId: string,
    at?: Date
  ): Promise<{ oldOwner: Collaborator; newOwner: Collaborator; study: Study }>;

  listCollaborators(
    studyId: string,
    actorId?: string,
    options?: PageOptions
  ): Promise<Page<Collaborator>>;

  // Chapter management
  createChapter(
    id: string,
    studyId: string,
    actorId: string,
    name: string,
    startingFen?: string,
    at?: Date
  ): Promise<Chapter>;

  getChapter(
    chapterId: string,
    actorId?: string
  ): Promise<{ chapter: Chapter; tree: readonly TreeNode[] }>;

  listChapters(
    studyId: string,
    actorId?: string
  ): Promise<readonly Chapter[]>;

  updateChapter(
    chapterId: string,
    actorId: string,
    updates: { name?: string },
    at?: Date
  ): Promise<Chapter>;

  deleteChapter(
    chapterId: string,
    actorId: string,
    at?: Date
  ): Promise<Chapter>;

  reorderChapters(
    studyId: string,
    actorId: string,
    chapterIds: readonly string[],
    at?: Date
  ): Promise<readonly Chapter[]>;

  // Tree node management
  appendNode(
    chapterId: string,
    actorId: string,
    parentId: string | null,
    san: string,
    reader: PositionReader,
    options?: { comment?: string; nags?: readonly number[]; nodeId?: string }
  ): Promise<TreeNode>;

  annotateNode(
    nodeId: string,
    actorId: string,
    updates: { comment?: string; nags?: readonly number[] }
  ): Promise<TreeNode>;

  deleteNode(nodeId: string, actorId: string): Promise<void>;

  // Import / Export PGN
  importPgn(
    studyId: string,
    actorId: string,
    pgnString: string,
    reader: PositionReader,
    at?: Date
  ): Promise<readonly Chapter[]>;

  exportPgn(
    studyId: string,
    actorId?: string,
    chapterId?: string
  ): Promise<string>;
}

export class InMemoryStudiesRepository implements StudiesRepository {
  private readonly studies = new Map<string, Study>();
  private readonly collaborators = new Map<string, Collaborator>(); // key: `${studyId}:${playerId}`
  private readonly chapters = new Map<string, Chapter>();
  private readonly treeNodes = new Map<string, TreeNode>(); // key: nodeId

  private collabKey(studyId: string, playerId: string): string {
    return `${studyId}:${playerId}`;
  }

  private getCollaboratorInternal(studyId: string, playerId: string): Collaborator | null {
    return this.collaborators.get(this.collabKey(studyId, playerId)) ?? null;
  }

  /**
   * Enforces visibility rules according to Invariant 3 & 8:
   * Private study invisible to non-collaborators -> throws `not_found`.
   */
  private findVisibleStudy(studyId: string, actorId?: string, allowDeleted = false): Study {
    const study = this.studies.get(studyId);
    if (!study) {
      throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
    }
    if (study.visibility === 'private') {
      if (!actorId) {
        throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
      }
      const collab = this.getCollaboratorInternal(studyId, actorId);
      if (!collab) {
        throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
      }
    }
    if (!allowDeleted && study.deletedAt !== undefined) {
      throw new StudyRuleError('not_found', `Study '${studyId}' not found`);
    }
    return study;
  }

  private findVisibleChapter(chapterId: string, actorId?: string, allowDeleted = false): { chapter: Chapter; study: Study } {
    const chapter = this.chapters.get(chapterId);
    if (!chapter) {
      throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
    }
    const study = this.findVisibleStudy(chapter.studyId, actorId, allowDeleted);
    if (!allowDeleted && chapter.deletedAt !== undefined) {
      throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found`);
    }
    return { chapter, study };
  }

  private findVisibleNode(nodeId: string, actorId?: string): { node: TreeNode; chapter: Chapter; study: Study } {
    const node = this.treeNodes.get(nodeId);
    if (!node) {
      throw new StudyRuleError('not_found', `Node '${nodeId}' not found`);
    }
    const { chapter, study } = this.findVisibleChapter(node.chapterId, actorId);
    return { node, chapter, study };
  }

  /** Ensures actor has required authority rank on study. */
  private assertAuthority(studyId: string, actorId: string, minRole: StudyRole): Collaborator {
    const collab = this.getCollaboratorInternal(studyId, actorId);
    if (!collab || roleRank(collab.role) < roleRank(minRole)) {
      throw new StudyRuleError('not_authorized', `Action requires ${minRole} role or higher`);
    }
    return collab;
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

    if (this.studies.has(id)) {
      throw new StudyRuleError('invalid_input', `Study '${id}' already exists`);
    }

    const study: Study = {
      id,
      ownerId,
      name: validName,
      description: description.trim(),
      visibility,
      variant: options?.variant ?? DEFAULT_STUDY_VARIANT,
      createdAt: at,
      updatedAt: at,
    };
    this.studies.set(id, study);

    const ownerCollab: Collaborator = {
      studyId: id,
      playerId: ownerId,
      role: 'owner',
    };
    this.collaborators.set(this.collabKey(id, ownerId), ownerCollab);

    return study;
  }

  async getStudy(studyId: string, actorId?: string): Promise<Study> {
    return this.findVisibleStudy(studyId, actorId);
  }

  async updateStudy(
    studyId: string,
    actorId: string,
    updates: { name?: string; description?: string; visibility?: StudyVisibility },
    at = new Date()
  ): Promise<Study> {
    const study = this.findVisibleStudy(studyId, actorId, true);
    this.assertAuthority(studyId, actorId, updates.visibility !== undefined ? 'owner' : 'contributor');

    if (study.deletedAt !== undefined) {
      throw new StudyRuleError('invalid_transition', `Study '${studyId}' is already deleted`);
    }

    const updatedName = updates.name !== undefined ? normalizeStudyName(updates.name) : study.name;
    const updatedDesc = updates.description !== undefined ? updates.description.trim() : study.description;
    const updatedVis = updates.visibility !== undefined ? updates.visibility : study.visibility;

    const updatedStudy: Study = {
      ...study,
      name: updatedName,
      description: updatedDesc,
      visibility: updatedVis,
      updatedAt: at,
    };
    this.studies.set(studyId, updatedStudy);
    return updatedStudy;
  }

  async deleteStudy(studyId: string, actorId: string, at = new Date()): Promise<Study> {
    const study = this.findVisibleStudy(studyId, actorId, true);
    this.assertAuthority(studyId, actorId, 'owner');

    if (study.deletedAt !== undefined) {
      throw new StudyRuleError('invalid_transition', `Study '${studyId}' is already deleted`);
    }

    const tombstoned: Study = {
      ...study,
      deletedAt: at,
      updatedAt: at,
    };
    this.studies.set(studyId, tombstoned);
    return tombstoned;
  }

  async listStudies(
    actorId?: string,
    options?: PageOptions & { search?: string; ownerId?: string }
  ): Promise<Page<Study>> {
    const searchLower = options?.search ? options.search.trim().toLowerCase() : '';
    const matching: Study[] = [];

    for (const study of this.studies.values()) {
      if (study.deletedAt !== undefined) continue;

      if (options?.ownerId && study.ownerId !== options.ownerId) continue;

      if (study.visibility === 'private') {
        if (!actorId) continue;
        const collab = this.getCollaboratorInternal(study.id, actorId);
        if (!collab) continue;
      } else if (study.visibility === 'unlisted') {
        // Unlisted studies are excluded from public listings
        continue;
      }

      if (searchLower) {
        const nameMatch = study.name.toLowerCase().includes(searchLower);
        const descMatch = study.description.toLowerCase().includes(searchLower);
        if (!nameMatch && !descMatch) continue;
      }

      matching.push(study);
    }

    matching.sort(compareStudies);
    return paginate(matching, options);
  }

  async addCollaborator(
    studyId: string,
    actorId: string,
    playerId: string,
    role: StudyRole,
    _at = new Date()
  ): Promise<Collaborator> {
    this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'owner');

    if (role === 'owner') {
      throw new StudyRuleError('invalid_input', 'Cannot add owner role via addCollaborator. Use transferOwnership.');
    }

    const key = this.collabKey(studyId, playerId);
    const existing = this.collaborators.get(key);
    if (existing) {
      if (existing.role === 'owner') {
        throw new StudyRuleError('invalid_transition', 'Cannot overwrite owner role');
      }
    }

    const collab: Collaborator = { studyId, playerId, role };
    this.collaborators.set(key, collab);
    return collab;
  }

  async updateCollaboratorRole(
    studyId: string,
    actorId: string,
    targetPlayerId: string,
    newRole: StudyRole,
    _at = new Date()
  ): Promise<Collaborator> {
    this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'owner');

    if (newRole === 'owner') {
      throw new StudyRuleError('invalid_transition', 'Cannot promote to owner via role update. Use transferOwnership.');
    }

    if (actorId === targetPlayerId) {
      throw new StudyRuleError('invalid_transition', 'Cannot change your own role');
    }

    const existing = this.getCollaboratorInternal(studyId, targetPlayerId);
    if (!existing) {
      throw new StudyRuleError('not_found', `Player '${targetPlayerId}' is not a collaborator on study '${studyId}'`);
    }

    const updated: Collaborator = { ...existing, role: newRole };
    this.collaborators.set(this.collabKey(studyId, targetPlayerId), updated);
    return updated;
  }

  async removeCollaborator(studyId: string, actorId: string, targetPlayerId: string): Promise<void> {
    this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'owner');

    const existing = this.getCollaboratorInternal(studyId, targetPlayerId);
    if (!existing) {
      throw new StudyRuleError('not_found', `Player '${targetPlayerId}' is not a collaborator on study '${studyId}'`);
    }

    if (existing.role === 'owner') {
      throw new StudyRuleError('invalid_transition', 'Cannot remove owner from study. Transfer ownership first.');
    }

    this.collaborators.delete(this.collabKey(studyId, targetPlayerId));
  }

  async transferOwnership(
    studyId: string,
    actorId: string,
    newOwnerId: string,
    at = new Date()
  ): Promise<{ oldOwner: Collaborator; newOwner: Collaborator; study: Study }> {
    const study = this.findVisibleStudy(studyId, actorId);
    const actorCollab = this.assertAuthority(studyId, actorId, 'owner');

    if (actorId === newOwnerId) {
      throw new StudyRuleError('invalid_transition', 'You are already the owner');
    }

    // The new owner must already be a collaborator. Inventing one here reads as convenience and is
    // a one-way door: a transfer to a mistyped id would succeed, demote the real owner to
    // contributor, and hand the study to an account nobody can sign in as. There is no path back,
    // because taking it back is itself an owner-only action.
    const targetCollab = this.getCollaboratorInternal(studyId, newOwnerId);
    if (!targetCollab) {
      throw new StudyRuleError(
        'not_found',
        `Player '${newOwnerId}' is not a collaborator on study '${studyId}'`
      );
    }

    const oldOwnerUpdated: Collaborator = { ...actorCollab, role: 'contributor' };
    const newOwnerUpdated: Collaborator = { ...targetCollab, role: 'owner' };

    this.collaborators.set(this.collabKey(studyId, actorId), oldOwnerUpdated);
    this.collaborators.set(this.collabKey(studyId, newOwnerId), newOwnerUpdated);

    const updatedStudy: Study = {
      ...study,
      ownerId: newOwnerId,
      updatedAt: at,
    };
    this.studies.set(studyId, updatedStudy);

    return { oldOwner: oldOwnerUpdated, newOwner: newOwnerUpdated, study: updatedStudy };
  }

  async listCollaborators(studyId: string, actorId?: string, options?: PageOptions): Promise<Page<Collaborator>> {
    this.findVisibleStudy(studyId, actorId);

    const collabs: Collaborator[] = [];
    for (const c of this.collaborators.values()) {
      if (c.studyId === studyId) collabs.push(c);
    }

    collabs.sort(compareCollaborators);
    return paginate(collabs, options);
  }

  async createChapter(
    id: string,
    studyId: string,
    actorId: string,
    name: string,
    startingFen = DEFAULT_STARTING_FEN,
    at = new Date()
  ): Promise<Chapter> {
    this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'contributor');

    const validName = normalizeChapterName(name);

    if (this.chapters.has(id)) {
      throw new StudyRuleError('invalid_input', `Chapter '${id}' already exists`);
    }

    const activeChapters = Array.from(this.chapters.values()).filter(
      (c) => c.studyId === studyId && c.deletedAt === undefined
    );
    const orderIndex = activeChapters.length;

    const chapter: Chapter = {
      id,
      studyId,
      name: validName,
      orderIndex,
      startingFen,
    };
    this.chapters.set(id, chapter);

    const study = this.studies.get(studyId)!;
    this.studies.set(studyId, { ...study, updatedAt: at });

    return chapter;
  }

  async getChapter(chapterId: string, actorId?: string): Promise<{ chapter: Chapter; tree: readonly TreeNode[] }> {
    const { chapter } = this.findVisibleChapter(chapterId, actorId);

    const nodes: TreeNode[] = [];
    for (const node of this.treeNodes.values()) {
      if (node.chapterId === chapterId) {
        nodes.push(node);
      }
    }
    nodes.sort(compareTreeNodes);

    return { chapter, tree: nodes };
  }

  async listChapters(studyId: string, actorId?: string): Promise<readonly Chapter[]> {
    this.findVisibleStudy(studyId, actorId);

    const activeChapters: Chapter[] = [];
    for (const c of this.chapters.values()) {
      if (c.studyId === studyId && c.deletedAt === undefined) {
        activeChapters.push(c);
      }
    }
    activeChapters.sort(compareChapters);
    return activeChapters;
  }

  async updateChapter(chapterId: string, actorId: string, updates: { name?: string }, at = new Date()): Promise<Chapter> {
    const { chapter, study } = this.findVisibleChapter(chapterId, actorId, true);
    this.assertAuthority(study.id, actorId, 'contributor');

    if (chapter.deletedAt !== undefined) {
      throw new StudyRuleError('invalid_transition', `Chapter '${chapterId}' is already deleted`);
    }

    const updatedName = updates.name !== undefined ? normalizeChapterName(updates.name) : chapter.name;
    const updatedChapter: Chapter = { ...chapter, name: updatedName };
    this.chapters.set(chapterId, updatedChapter);

    this.studies.set(study.id, { ...study, updatedAt: at });
    return updatedChapter;
  }

  async deleteChapter(chapterId: string, actorId: string, at = new Date()): Promise<Chapter> {
    const { chapter, study } = this.findVisibleChapter(chapterId, actorId, true);
    this.assertAuthority(study.id, actorId, 'contributor');

    if (chapter.deletedAt !== undefined) {
      throw new StudyRuleError('invalid_transition', `Chapter '${chapterId}' is already deleted`);
    }

    const tombstoned: Chapter = { ...chapter, deletedAt: at };
    this.chapters.set(chapterId, tombstoned);

    // Re-compact active chapters orderIndex
    const remaining = Array.from(this.chapters.values())
      .filter((c) => c.studyId === study.id && c.deletedAt === undefined)
      .sort(compareChapters);

    remaining.forEach((c, idx) => {
      this.chapters.set(c.id, { ...c, orderIndex: idx });
    });

    this.studies.set(study.id, { ...study, updatedAt: at });
    return tombstoned;
  }

  async reorderChapters(
    studyId: string,
    actorId: string,
    chapterIds: readonly string[],
    at = new Date()
  ): Promise<readonly Chapter[]> {
    const study = this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'contributor');

    const activeChapters = Array.from(this.chapters.values()).filter(
      (c) => c.studyId === studyId && c.deletedAt === undefined
    );

    if (activeChapters.length !== chapterIds.length) {
      throw new StudyRuleError('invalid_input', 'chapterIds count does not match active chapters count');
    }

    const activeMap = new Map(activeChapters.map((c) => [c.id, c]));
    for (const id of chapterIds) {
      if (!activeMap.has(id)) {
        throw new StudyRuleError('invalid_input', `Chapter '${id}' is not an active chapter of study '${studyId}'`);
      }
    }

    const updatedChapters: Chapter[] = [];
    chapterIds.forEach((id, index) => {
      const ch = activeMap.get(id)!;
      const updated: Chapter = { ...ch, orderIndex: index };
      this.chapters.set(id, updated);
      updatedChapters.push(updated);
    });

    this.studies.set(studyId, { ...study, updatedAt: at });
    return updatedChapters;
  }

  async appendNode(
    chapterId: string,
    actorId: string,
    parentId: string | null,
    san: string,
    reader: PositionReader,
    options?: { comment?: string; nags?: readonly number[]; nodeId?: string }
  ): Promise<TreeNode> {
    const { chapter, study } = this.findVisibleChapter(chapterId, actorId);
    this.assertAuthority(study.id, actorId, 'contributor');

    let parentFen = chapter.startingFen;
    if (parentId !== null) {
      const parentNode = this.treeNodes.get(parentId);
      if (!parentNode || parentNode.chapterId !== chapterId) {
        throw new StudyRuleError('not_found', `Parent node '${parentId}' not found in chapter '${chapterId}'`);
      }
      parentFen = parentNode.fenAfter;
    }

    const resolvedSan = resolveSan(reader, parentFen, san, study.variant);

    // Rule 4: Appending a move that already exists as a child returns that child instead of duplicating it
    for (const node of this.treeNodes.values()) {
      if (node.chapterId === chapterId && node.parentId === parentId) {
        if (node.san === resolvedSan) {
          return node;
        }
      }
    }

    const fenAfter = reader.play(parentFen, resolvedSan, study.variant);
    const siblings = Array.from(this.treeNodes.values()).filter(
      (n) => n.chapterId === chapterId && n.parentId === parentId
    );

    const newNodeId = options?.nodeId ?? crypto.randomUUID();
    const node: TreeNode = {
      id: newNodeId,
      chapterId,
      parentId,
      san: resolvedSan,
      fenAfter,
      comment: options?.comment,
      nags: options?.nags ? [...options.nags] : [],
      orderIndex: siblings.length,
    };

    this.treeNodes.set(newNodeId, node);
    return node;
  }

  async annotateNode(
    nodeId: string,
    actorId: string,
    updates: { comment?: string; nags?: readonly number[] }
  ): Promise<TreeNode> {
    const { node, study } = this.findVisibleNode(nodeId, actorId);
    this.assertAuthority(study.id, actorId, 'contributor');

    const updatedNode: TreeNode = {
      ...node,
      ...(updates.comment !== undefined ? { comment: updates.comment } : {}),
      ...(updates.nags !== undefined ? { nags: [...updates.nags] } : {}),
    };
    this.treeNodes.set(nodeId, updatedNode);
    return updatedNode;
  }

  async deleteNode(nodeId: string, actorId: string): Promise<void> {
    const { node, chapter, study } = this.findVisibleNode(nodeId, actorId);
    this.assertAuthority(study.id, actorId, 'contributor');

    const parentId = node.parentId;

    // Delete node and recursively delete descendant nodes
    const toDelete = new Set<string>([nodeId]);
    let added = true;
    while (added) {
      added = false;
      for (const n of this.treeNodes.values()) {
        if (n.chapterId === chapter.id && n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          added = true;
        }
      }
    }

    for (const id of toDelete) {
      this.treeNodes.delete(id);
    }

    // Re-compact sibling orderIndex under parentId
    const remainingSiblings = Array.from(this.treeNodes.values())
      .filter((n) => n.chapterId === chapter.id && n.parentId === parentId)
      .sort(compareTreeNodes);

    remainingSiblings.forEach((n, idx) => {
      this.treeNodes.set(n.id, { ...n, orderIndex: idx });
    });
  }

  async importPgn(
    studyId: string,
    actorId: string,
    pgnString: string,
    reader: PositionReader,
    at = new Date()
  ): Promise<readonly Chapter[]> {
    const study = this.findVisibleStudy(studyId, actorId);
    this.assertAuthority(studyId, actorId, 'contributor');

    if (Buffer.byteLength(pgnString, 'utf8') > MAX_PGN_BYTES) {
      throw new StudyRuleError('too_large', `PGN exceeds max limit of ${MAX_PGN_BYTES} bytes`);
    }

    const games = parsePgn(pgnString);
    if (games.length > MAX_GAMES_PER_IMPORT) {
      throw new StudyRuleError('too_large', `Import exceeds max limit of ${MAX_GAMES_PER_IMPORT} games`);
    }

    // Validate playability in memory first before writing any rows!
    const validatedGames: { name: string; startingFen: string; moves: readonly PgnMoveNode[] }[] = [];

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const name = chapterNameFor(game, i);

      const startingFen = tagValue(game, 'FEN') || reader.initialFen(study.variant);

      // The starting position itself, before the movetext. A game with moves already reaches the
      // reader on its first SAN, so this is load-bearing only for a game with none — and that is
      // exactly the case that used to slip through: `[FEN "... 2+3 17 42"]` with an empty movetext
      // was never parsed by anyone, so the import returned 200 and stored a chapter holding a FEN
      // this server cannot read. Every later append to it then failed, permanently. The direct
      // chapter route validates its `startingFen` at the input for the same reason; the import path
      // reached `createChapter` underneath that check. Raised in the CodeRabbit review of PR #140.
      //
      // Through the existing port rather than a FEN parser: this package is deliberately free of an
      // engine dependency, and asking the reader about the position is the seam that already exists.
      // The call runs in the dry-run loop, so nothing is written before it throws.
      reader.legalSans(startingFen, study.variant);

      // Dry run move resolution to ensure the entire movetext is valid
      this.validatePlayableMovetext(game.moves, startingFen, reader, study.variant);

      validatedGames.push({ name, startingFen, moves: game.moves });
    }

    // Perform actual chapter and tree creation
    const importedChapters: Chapter[] = [];
    for (const g of validatedGames) {
      const chapterId = crypto.randomUUID();
      const chapter = await this.createChapter(chapterId, studyId, actorId, g.name, g.startingFen, at);
      await this.buildTreeFromMovetext(chapter.id, actorId, null, g.moves, g.startingFen, reader);
      importedChapters.push(chapter);
    }

    return importedChapters;
  }

  private validatePlayableMovetext(
    moves: readonly PgnMoveNode[],
    fen: string,
    reader: PositionReader,
    variant: StudyVariant,
  ): void {
    let currentFen = fen;
    for (const moveNode of moves) {
      // Validate variations from the position BEFORE moveNode
      for (const varLine of moveNode.variations) {
        this.validatePlayableMovetext(varLine, currentFen, reader, variant);
      }

      // Validate mainline move
      const resolvedSan = resolveSan(reader, currentFen, moveNode.san, variant);
      currentFen = reader.play(currentFen, resolvedSan, variant);
    }
  }

  private async buildTreeFromMovetext(
    chapterId: string,
    actorId: string,
    parentId: string | null,
    moves: readonly PgnMoveNode[],
    fen: string,
    reader: PositionReader
  ): Promise<void> {
    let currentParentId = parentId;
    let currentFen = fen;

    for (const moveNode of moves) {
      const parentBefore = currentParentId;
      const fenBefore = currentFen;

      const comment = moveNode.comments.length > 0 ? moveNode.comments.join('\n') : undefined;
      const appended = await this.appendNode(chapterId, actorId, parentBefore, moveNode.san, reader, {
        comment,
        nags: moveNode.nags,
      });

      // Variations are alternatives to this move, so they hang off the same parent — appended
      // *after* it so the mainline keeps orderIndex 0, which is what `exportPgn` and every tree
      // reader assume. The Postgres adapter already did this; see ADR-0091 §10.
      for (const varLine of moveNode.variations) {
        await this.buildTreeFromMovetext(chapterId, actorId, parentBefore, varLine, fenBefore, reader);
      }

      currentParentId = appended.id;
      currentFen = appended.fenAfter;
    }
  }

  async exportPgn(studyId: string, actorId?: string, chapterId?: string): Promise<string> {
    const study = this.findVisibleStudy(studyId, actorId);

    const activeChapters = Array.from(this.chapters.values())
      .filter((c) => c.studyId === studyId && c.deletedAt === undefined)
      .sort(compareChapters);

    const targetChapters = chapterId
      ? activeChapters.filter((c) => c.id === chapterId)
      : activeChapters;

    if (chapterId && targetChapters.length === 0) {
      throw new StudyRuleError('not_found', `Chapter '${chapterId}' not found in study '${studyId}'`);
    }

    const pgnGames: PgnGame[] = [];

    for (const chapter of targetChapters) {
      const nodes = Array.from(this.treeNodes.values())
        .filter((n) => n.chapterId === chapter.id)
        .sort(compareTreeNodes);

      const moves = this.serializeNodeTree(nodes, null);
      const tags = [
        { key: 'Event', value: chapter.name },
        ...(study.variant !== DEFAULT_STUDY_VARIANT ? [{ key: 'Variant', value: study.variant }] : []),
        ...(chapter.startingFen !== DEFAULT_STARTING_FEN ? [{ key: 'FEN', value: chapter.startingFen }] : []),
      ];

      pgnGames.push({
        tags,
        preComments: [],
        moves,
        result: '*',
      });
    }

    return serializePgnGames(pgnGames);
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
