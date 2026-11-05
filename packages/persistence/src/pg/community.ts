/**
 * @packageDocumentation
 * PostgreSQL implementation of CommunityRepository from @chess-platform/community.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  CommunityRepository,
  ForumPost,
  ForumThread,
  JoinRequest,
  JoinRequestId,
  JoinRequestStatus,
  Membership,
  Page,
  PageOptions,
  PlayerId,
  PostId,
  Team,
  TeamId,
  TeamRole,
  TeamVisibility,
  ThreadId,
} from '@chess-platform/community';
import {
  assertValidPostBody,
  assertValidSlug,
  assertValidTeamDescription,
  assertValidTeamName,
  assertValidThreadTitle,
  CommunityRuleError,
  roleRank,
} from '@chess-platform/community';
import { isForeignKeyViolation, isInvalidTextRepresentation, isUniqueViolation } from './sqlstate';

/**
 * An id that Postgres cannot even parse as a `uuid` names no row, so it reads as `not_found` rather
 * than as a driver error escaping to the caller as a 500. Routes still reject these at the edge with
 * `parseUuid` — a 422 is the more useful answer — but a repository that fails loudly whenever a
 * route forgets turns one missing call into an outage.
 */
function rethrowUnusableId(id: string, what: string): (err: unknown) => never {
  return (err: unknown): never => {
    if (isInvalidTextRepresentation(err)) {
      throw new CommunityRuleError('not_found', `${what} '${id}' not found`);
    }
    throw err;
  };
}

function rethrowMissingResource(err: unknown): never {
  if (isForeignKeyViolation(err)) {
    throw new CommunityRuleError('not_found', 'Referenced player or resource does not exist');
  }
  throw err;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

/**
 * Advisory lock for a team to serialize read-then-write operations within transactions.
 * Must be called BEFORE any row locks to prevent deadlocks.
 */
async function lockTeam(client: PoolClient, teamId: string): Promise<void> {
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('team:' || $1::text, 0::bigint))`,
    [teamId]
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

function paginationClause(params: unknown[], options?: PageOptions): string {
  const offset = normalizeOffset(options?.offset);
  const limit = normalizeLimit(options?.limit);

  let clause = `OFFSET $${params.push(offset)}`;
  if (limit !== undefined) {
    clause = `LIMIT $${params.push(limit)} ${clause}`;
  }
  return clause;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: string;
  created_by: string;
  created_at: Date;
}

interface MembershipRow {
  team_id: string;
  player_id: string;
  role: string;
  joined_at: Date;
}

interface JoinRequestRow {
  id: string;
  team_id: string;
  player_id: string;
  status: string;
  created_at: Date;
  responded_at: Date | null;
}

interface ThreadRow {
  id: string;
  team_id: string;
  author_id: string;
  title: string;
  created_at: Date;
  last_post_at: Date;
  locked: boolean;
  pinned: boolean;
  deleted_at: Date | null;
}

interface PostRow {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility as TeamVisibility,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
  };
}

function rowToMembership(row: MembershipRow): Membership {
  return {
    teamId: row.team_id,
    playerId: row.player_id,
    role: row.role as TeamRole,
    joinedAt: new Date(row.joined_at),
  };
}

function rowToJoinRequest(row: JoinRequestRow): JoinRequest {
  return {
    id: row.id,
    teamId: row.team_id,
    playerId: row.player_id,
    status: row.status as any,
    createdAt: new Date(row.created_at),
    ...(row.responded_at ? { respondedAt: new Date(row.responded_at) } : {}),
  };
}

function rowToThread(row: ThreadRow): ForumThread {
  return {
    id: row.id,
    teamId: row.team_id,
    authorId: row.author_id,
    title: row.title,
    createdAt: new Date(row.created_at),
    lastPostAt: new Date(row.last_post_at),
    locked: row.locked,
    pinned: row.pinned,
    ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at) } : {}),
  };
}

function rowToPost(row: PostRow): ForumPost {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: new Date(row.created_at),
    ...(row.edited_at ? { editedAt: new Date(row.edited_at) } : {}),
    ...(row.deleted_at ? { deletedAt: new Date(row.deleted_at) } : {}),
  };
}

export class PgCommunityRepository implements CommunityRepository {
  constructor(private readonly pool: Pool) {}

  private async getMembershipInternal(clientOrPool: Pool | PoolClient, teamId: TeamId, playerId: PlayerId): Promise<Membership | null> {
    const res = await clientOrPool.query<MembershipRow>(
      `SELECT team_id, player_id, role, joined_at
       FROM community_memberships
       WHERE team_id = $1 AND player_id = $2`,
      [teamId, playerId]
    );
    if (res.rows.length === 0) return null;
    return rowToMembership(res.rows[0]);
  }

  private async findVisibleTeam(clientOrPool: Pool | PoolClient, teamId: TeamId, actorId?: PlayerId): Promise<Team> {
    const res = await clientOrPool
      .query<TeamRow>(
        `SELECT id, slug, name, description, visibility, created_by, created_at
         FROM community_teams
         WHERE id = $1`,
        [teamId]
      )
      .catch(rethrowUnusableId(teamId, 'Team'));
    if (res.rows.length === 0) {
      throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
    }
    const team = rowToTeam(res.rows[0]);
    if (team.visibility === 'private') {
      if (!actorId) {
        throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
      }
      const mem = await this.getMembershipInternal(clientOrPool, teamId, actorId);
      if (!mem) {
        throw new CommunityRuleError('not_found', `Team '${teamId}' not found`);
      }
    }
    return team;
  }

  private async findVisibleThread(clientOrPool: Pool | PoolClient, threadId: ThreadId, actorId?: PlayerId): Promise<{ thread: ForumThread; team: Team }> {
    const res = await clientOrPool.query<ThreadRow>(
      `SELECT id, team_id, author_id, title, created_at, last_post_at, locked, pinned, deleted_at
       FROM community_forum_threads
       WHERE id = $1`,
      [threadId]
    );
    if (res.rows.length === 0) {
      throw new CommunityRuleError('not_found', `Thread '${threadId}' not found`);
    }
    const thread = rowToThread(res.rows[0]);
    const team = await this.findVisibleTeam(clientOrPool, thread.teamId, actorId);
    return { thread, team };
  }

  private async findVisiblePost(clientOrPool: Pool | PoolClient, postId: PostId, actorId?: PlayerId): Promise<{ post: ForumPost; thread: ForumThread; team: Team }> {
    const res = await clientOrPool.query<PostRow>(
      `SELECT id, thread_id, author_id, body, created_at, edited_at, deleted_at
       FROM community_forum_posts
       WHERE id = $1`,
      [postId]
    );
    if (res.rows.length === 0) {
      throw new CommunityRuleError('not_found', `Post '${postId}' not found`);
    }
    const post = rowToPost(res.rows[0]);
    const { thread, team } = await this.findVisibleThread(clientOrPool, post.threadId, actorId);
    return { post, thread, team };
  }

  async createTeam(
    id: TeamId,
    slug: string,
    name: string,
    description: string,
    visibility: TeamVisibility,
    ownerId: PlayerId,
    at: Date
  ): Promise<Team> {
    const normalizedSlug = assertValidSlug(slug);
    const validName = assertValidTeamName(name);
    const validDesc = assertValidTeamDescription(description);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const insertedTeam = await client.query<TeamRow>(
        `INSERT INTO community_teams (id, slug, name, description, visibility, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, slug, name, description, visibility, created_by, created_at`,
        [id, normalizedSlug, validName, validDesc, visibility, ownerId, at]
      ).catch((err) => {
        if (isUniqueViolation(err)) {
          throw new CommunityRuleError('slug_taken', `Slug '${normalizedSlug}' is already taken`);
        }
        return rethrowMissingResource(err);
      });

      await client.query(
        `INSERT INTO community_memberships (team_id, player_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)`,
        [id, ownerId, at]
      ).catch(rethrowMissingResource);

      await client.query('COMMIT');
      return rowToTeam(insertedTeam.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async getTeam(teamId: TeamId, actorId?: PlayerId): Promise<Team> {
    return this.findVisibleTeam(this.pool, teamId, actorId);
  }

  async getTeamBySlug(slug: string, actorId?: PlayerId): Promise<Team> {
    const normalizedSlug = assertValidSlug(slug);
    const res = await this.pool.query<TeamRow>(
      `SELECT id, slug, name, description, visibility, created_by, created_at
       FROM community_teams
       WHERE slug = $1`,
      [normalizedSlug]
    );

    if (res.rows.length === 0) {
      throw new CommunityRuleError('not_found', `Team with slug '${slug}' not found`);
    }

    return this.findVisibleTeam(this.pool, res.rows[0].id, actorId);
  }

  async updateTeam(
    teamId: TeamId,
    actorId: PlayerId,
    updates: { name?: string; description?: string; visibility?: TeamVisibility },
    _at: Date
  ): Promise<Team> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      const team = await this.findVisibleTeam(client, teamId, actorId);
      const mem = await this.getMembershipInternal(client, teamId, actorId);
      if (!mem || (mem.role !== 'admin' && mem.role !== 'owner')) {
        throw new CommunityRuleError('not_authorized', 'Only admins and owners can update team details');
      }

      const updatedName = updates.name !== undefined ? assertValidTeamName(updates.name) : team.name;
      const updatedDesc = updates.description !== undefined ? assertValidTeamDescription(updates.description) : team.description;
      const updatedVis = updates.visibility !== undefined ? updates.visibility : team.visibility;

      const res = await client.query<TeamRow>(
        `UPDATE community_teams
         SET name = $1, description = $2, visibility = $3
         WHERE id = $4
         RETURNING id, slug, name, description, visibility, created_by, created_at`,
        [updatedName, updatedDesc, updatedVis, teamId]
      );

      await client.query('COMMIT');
      return rowToTeam(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listTeams(
    actorId?: PlayerId,
    options?: PageOptions & { search?: string }
  ): Promise<Page<Team>> {
    const searchParam = options?.search ? `%${options.search.trim().toLowerCase()}%` : null;

    let whereClause = `WHERE (visibility = 'public' OR (visibility = 'private' AND EXISTS (
      SELECT 1 FROM community_memberships m WHERE m.team_id = community_teams.id AND m.player_id = $1
    )))`;
    const queryParams: unknown[] = [actorId ?? null];

    if (searchParam) {
      queryParams.push(searchParam);
      whereClause += ` AND (LOWER(name) LIKE $${queryParams.length} OR LOWER(slug) LIKE $${queryParams.length})`;
    }

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community_teams ${whereClause}`,
      queryParams
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const pagination = paginationClause(queryParams, options);

    const res = await this.pool.query<TeamRow>(
      `SELECT id, slug, name, description, visibility, created_by, created_at
       FROM community_teams
       ${whereClause}
       ORDER BY created_at DESC, id ASC
       ${pagination}`,
      queryParams
    );

    return { total, items: res.rows.map(rowToTeam) };
  }

  async joinTeam(teamId: TeamId, playerId: PlayerId, at: Date): Promise<Membership> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      const team = await this.findVisibleTeam(client, teamId, playerId);
      const existing = await this.getMembershipInternal(client, teamId, playerId);
      if (existing) {
        throw new CommunityRuleError('already_member', `Player '${playerId}' is already a member of team '${teamId}'`);
      }

      if (team.visibility === 'private') {
        throw new CommunityRuleError('not_authorized', 'Private teams cannot be joined directly. Submit a join request.');
      }

      const res = await client.query<MembershipRow>(
        `INSERT INTO community_memberships (team_id, player_id, role, joined_at)
         VALUES ($1, $2, 'member', $3)
         RETURNING team_id, player_id, role, joined_at`,
        [teamId, playerId, at]
      ).catch(rethrowMissingResource);

      await client.query(
        `UPDATE community_join_requests
         SET status = 'accepted', responded_at = $3
         WHERE team_id = $1 AND player_id = $2 AND status = 'pending'`,
        [teamId, playerId, at]
      );

      await client.query('COMMIT');
      return rowToMembership(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async leaveOrRemoveMember(teamId: TeamId, actorId: PlayerId, targetPlayerId: PlayerId): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      await this.findVisibleTeam(client, teamId, actorId);
      const targetMem = await this.getMembershipInternal(client, teamId, targetPlayerId);
      if (!targetMem) {
        throw new CommunityRuleError('not_found', `Player '${targetPlayerId}' is not a member of team '${teamId}'`);
      }

      if (targetMem.role === 'owner') {
        throw new CommunityRuleError('cannot_leave_as_owner', 'Owner cannot leave or be removed. Transfer ownership first.');
      }

      if (actorId !== targetPlayerId) {
        const actorMem = await this.getMembershipInternal(client, teamId, actorId);
        if (!actorMem || roleRank(actorMem.role) <= roleRank(targetMem.role)) {
          throw new CommunityRuleError('not_authorized', 'Cannot remove a member with equal or higher role');
        }
      }

      await client.query(
        `DELETE FROM community_memberships WHERE team_id = $1 AND player_id = $2`,
        [teamId, targetPlayerId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async updateMemberRole(
    teamId: TeamId,
    actorId: PlayerId,
    targetPlayerId: PlayerId,
    newRole: TeamRole
  ): Promise<Membership> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      await this.findVisibleTeam(client, teamId, actorId);
      const actorMem = await this.getMembershipInternal(client, teamId, actorId);
      if (!actorMem) {
        throw new CommunityRuleError('not_authorized', 'Actor is not a member of this team');
      }

      const targetMem = await this.getMembershipInternal(client, teamId, targetPlayerId);
      if (!targetMem) {
        throw new CommunityRuleError('not_found', `Player '${targetPlayerId}' is not a member of team '${teamId}'`);
      }

      if (newRole === 'owner') {
        throw new CommunityRuleError('invalid_role_transition', 'Cannot set owner via role update. Use transfer ownership.');
      }

      if (actorId === targetPlayerId) {
        throw new CommunityRuleError('invalid_role_transition', 'Cannot change your own role');
      }

      if (roleRank(actorMem.role) <= roleRank(targetMem.role)) {
        throw new CommunityRuleError('not_authorized', 'Cannot change role of a member with equal or higher role');
      }

      if (roleRank(newRole) >= roleRank(actorMem.role)) {
        throw new CommunityRuleError('not_authorized', 'Cannot promote a member to a role at or above your own');
      }

      const res = await client.query<MembershipRow>(
        `UPDATE community_memberships
         SET role = $1
         WHERE team_id = $2 AND player_id = $3
         RETURNING team_id, player_id, role, joined_at`,
        [newRole, teamId, targetPlayerId]
      );

      await client.query('COMMIT');
      return rowToMembership(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async transferOwnership(
    teamId: TeamId,
    actorId: PlayerId,
    newOwnerId: PlayerId
  ): Promise<{ oldOwner: Membership; newOwner: Membership }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      await this.findVisibleTeam(client, teamId, actorId);
      const actorMem = await this.getMembershipInternal(client, teamId, actorId);
      if (!actorMem || actorMem.role !== 'owner') {
        throw new CommunityRuleError('not_authorized', 'Only the current owner can transfer ownership');
      }

      if (actorId === newOwnerId) {
        throw new CommunityRuleError('invalid_role_transition', 'You are already the owner');
      }

      const targetMem = await this.getMembershipInternal(client, teamId, newOwnerId);
      if (!targetMem) {
        throw new CommunityRuleError('not_found', `Player '${newOwnerId}' is not a member of team '${teamId}'`);
      }

      // Demote FIRST, promote second. `community_memberships_one_owner_per_team` is a partial
      // unique index, and Postgres checks it per row as each UPDATE lands — so promoting first
      // means two owners exist for an instant and the statement fails with a unique violation.
      // The index cannot be deferred out of the problem either: only constraints can be
      // DEFERRABLE, and a constraint cannot be partial. The order is the mechanism, so it is not
      // free to rearrange.
      const oldRes = await client.query<MembershipRow>(
        `UPDATE community_memberships SET role = 'admin' WHERE team_id = $1 AND player_id = $2 RETURNING team_id, player_id, role, joined_at`,
        [teamId, actorId]
      );
      const newRes = await client.query<MembershipRow>(
        `UPDATE community_memberships SET role = 'owner' WHERE team_id = $1 AND player_id = $2 RETURNING team_id, player_id, role, joined_at`,
        [teamId, newOwnerId]
      );

      await client.query('COMMIT');
      return {
        oldOwner: rowToMembership(oldRes.rows[0]),
        newOwner: rowToMembership(newRes.rows[0]),
      };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listMembers(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<Membership>> {
    await this.findVisibleTeam(this.pool, teamId, actorId);

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community_memberships WHERE team_id = $1`,
      [teamId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [teamId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<MembershipRow>(
      `SELECT team_id, player_id, role, joined_at
       FROM community_memberships
       WHERE team_id = $1
       ORDER BY (CASE role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'member' THEN 1 END) DESC,
                joined_at ASC, player_id ASC
       ${pagination}`,
      params
    );

    return { total, items: res.rows.map(rowToMembership) };
  }

  async getMembership(teamId: TeamId, playerId: PlayerId, actorId?: PlayerId): Promise<Membership | null> {
    await this.findVisibleTeam(this.pool, teamId, actorId ?? playerId);
    return this.getMembershipInternal(this.pool, teamId, playerId);
  }

  async createJoinRequest(
    id: JoinRequestId,
    teamId: TeamId,
    playerId: PlayerId,
    at: Date
  ): Promise<JoinRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      try {
        await this.findVisibleTeam(client, teamId, playerId);
      } catch (err) {
        if (err instanceof CommunityRuleError && err.code === 'not_found') {
          throw new CommunityRuleError('not_found', 'Team not found');
        }
        throw err;
      }

      const existingMem = await this.getMembershipInternal(client, teamId, playerId);
      if (existingMem) {
        throw new CommunityRuleError('already_member', `Player '${playerId}' is already a member of team '${teamId}'`);
      }

      const res = await client.query<JoinRequestRow>(
        `INSERT INTO community_join_requests (id, team_id, player_id, status, created_at)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING id, team_id, player_id, status, created_at, responded_at`,
        [id, teamId, playerId, at]
      ).catch((err) => {
        if (isUniqueViolation(err)) {
          throw new CommunityRuleError('already_requested', `A pending join request already exists for team '${teamId}'`);
        }
        return rethrowMissingResource(err);
      });

      await client.query('COMMIT');
      return rowToJoinRequest(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async respondToJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    status: 'accepted' | 'declined',
    at: Date
  ): Promise<JoinRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Two reads, deliberately. The team lock has to come before the row lock, and the row is the
      // only place the team id is written down — so the first read is unlocked, purely to learn
      // which team to lock, and the second is the one whose result is trusted.
      //
      // Locking the row first and the team second is a cycle: `createJoinRequest` holds the team
      // lock and then blocks on this very row through the one-pending-per-player unique index,
      // while this transaction would be holding that row and waiting for the team. Postgres would
      // resolve it by killing one of them.
      const peek = await client.query<{ team_id: string }>(
        `SELECT team_id FROM community_join_requests WHERE id = $1`,
        [requestId]
      );
      if (peek.rows.length === 0) {
        throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
      }
      await lockTeam(client, peek.rows[0].team_id);

      const reqRes = await client.query<JoinRequestRow>(
        `SELECT id, team_id, player_id, status, created_at, responded_at
         FROM community_join_requests
         WHERE id = $1
         FOR UPDATE`,
        [requestId]
      );
      if (reqRes.rows.length === 0) {
        throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
      }
      const req = reqRes.rows[0];

      const team = await this.findVisibleTeam(client, req.team_id, actorId);
      const actorMem = await this.getMembershipInternal(client, team.id, actorId);
      if (!actorMem || (actorMem.role !== 'admin' && actorMem.role !== 'owner')) {
        throw new CommunityRuleError('not_authorized', 'Only admins and owners can respond to join requests');
      }

      if (req.status !== 'pending') {
        throw new CommunityRuleError('invalid_transition', `Join request '${requestId}' is not pending`);
      }

      const updatedReq = await client.query<JoinRequestRow>(
        `UPDATE community_join_requests
         SET status = $1, responded_at = $2
         WHERE id = $3
         RETURNING id, team_id, player_id, status, created_at, responded_at`,
        [status, at, requestId]
      );

      if (status === 'accepted') {
        await client.query(
          `INSERT INTO community_memberships (team_id, player_id, role, joined_at)
           VALUES ($1, $2, 'member', $3)
           ON CONFLICT (team_id, player_id) DO NOTHING`,
          [req.team_id, req.player_id, at]
        );
      }

      await client.query('COMMIT');
      return rowToJoinRequest(updatedReq.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async cancelJoinRequest(
    requestId: JoinRequestId,
    actorId: PlayerId,
    at: Date
  ): Promise<JoinRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const reqRes = await client.query<JoinRequestRow>(
        `SELECT id, team_id, player_id, status, created_at, responded_at
         FROM community_join_requests
         WHERE id = $1
         FOR UPDATE`,
        [requestId]
      );
      if (reqRes.rows.length === 0) {
        throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
      }
      const req = reqRes.rows[0];

      // See the in-memory adapter: a stranger must not be able to tell a real request id from an
      // invented one, so this is `not_found` rather than `not_authorized`.
      if (req.player_id !== actorId) {
        throw new CommunityRuleError('not_found', `Join request '${requestId}' not found`);
      }

      if (req.status !== 'pending') {
        throw new CommunityRuleError('invalid_transition', `Join request '${requestId}' is not pending`);
      }

      const updatedReq = await client.query<JoinRequestRow>(
        `UPDATE community_join_requests
         SET status = 'cancelled', responded_at = $1
         WHERE id = $2
         RETURNING id, team_id, player_id, status, created_at, responded_at`,
        [at, requestId]
      );

      await client.query('COMMIT');
      return rowToJoinRequest(updatedReq.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listOutgoingJoinRequests(
    playerId: PlayerId,
    options?: PageOptions
  ): Promise<Page<JoinRequest>> {
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM community_join_requests
       WHERE player_id = $1 AND status = 'pending'`,
      [playerId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [playerId];
    const pagination = paginationClause(params, options);
    const res = await this.pool.query<JoinRequestRow>(
      `SELECT id, team_id, player_id, status, created_at, responded_at
       FROM community_join_requests
       WHERE player_id = $1 AND status = 'pending'
       ORDER BY created_at DESC, id ASC
       ${pagination}`,
      params
    );

    return { total, items: res.rows.map(rowToJoinRequest) };
  }

  async listJoinRequests(
    teamId: TeamId,
    actorId: PlayerId,
    options?: PageOptions & { status?: JoinRequestStatus }
  ): Promise<Page<JoinRequest>> {
    const team = await this.findVisibleTeam(this.pool, teamId, actorId);
    const actorMem = await this.getMembershipInternal(this.pool, team.id, actorId);
    if (!actorMem || (actorMem.role !== 'admin' && actorMem.role !== 'owner')) {
      throw new CommunityRuleError('not_authorized', 'Only admins and owners can view join requests');
    }

    const countParams: unknown[] = [teamId];
    const whereClauses = ['team_id = $1'];
    if (options?.status) {
      countParams.push(options.status);
      whereClauses.push(`status = $${countParams.length}`);
    }
    const whereSql = whereClauses.join(' AND ');

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community_join_requests WHERE ${whereSql}`,
      countParams
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [...countParams];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<JoinRequestRow>(
      `SELECT id, team_id, player_id, status, created_at, responded_at
       FROM community_join_requests
       WHERE ${whereSql}
       ORDER BY created_at DESC, id ASC
       ${pagination}`,
      params
    );

    return { total, items: res.rows.map(rowToJoinRequest) };
  }

  async createThread(
    id: ThreadId,
    teamId: TeamId,
    authorId: PlayerId,
    title: string,
    initialPostBody: string,
    firstPostId: PostId,
    at: Date
  ): Promise<{ thread: ForumThread; post: ForumPost }> {
    const validTitle = assertValidThreadTitle(title);
    const validBody = assertValidPostBody(initialPostBody);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockTeam(client, teamId);

      await this.findVisibleTeam(client, teamId, authorId);
      const mem = await this.getMembershipInternal(client, teamId, authorId);
      if (!mem) {
        throw new CommunityRuleError('not_authorized', 'Only members can create forum threads');
      }

      const threadRes = await client.query<ThreadRow>(
        `INSERT INTO community_forum_threads (id, team_id, author_id, title, created_at, last_post_at, locked, pinned)
         VALUES ($1, $2, $3, $4, $5, $5, FALSE, FALSE)
         RETURNING id, team_id, author_id, title, created_at, last_post_at, locked, pinned, deleted_at`,
        [id, teamId, authorId, validTitle, at]
      ).catch(rethrowMissingResource);

      const postRes = await client.query<PostRow>(
        `INSERT INTO community_forum_posts (id, thread_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, thread_id, author_id, body, created_at, edited_at, deleted_at`,
        [firstPostId, id, authorId, validBody, at]
      ).catch(rethrowMissingResource);

      await client.query('COMMIT');
      return {
        thread: rowToThread(threadRes.rows[0]),
        post: rowToPost(postRes.rows[0]),
      };
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async getThread(threadId: ThreadId, actorId?: PlayerId): Promise<ForumThread> {
    const { thread } = await this.findVisibleThread(this.pool, threadId, actorId);
    return thread;
  }

  async updateThread(
    threadId: ThreadId,
    actorId: PlayerId,
    updates: { title?: string; locked?: boolean; pinned?: boolean },
    _at: Date
  ): Promise<ForumThread> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { thread, team } = await this.findVisibleThread(client, threadId, actorId);
      await lockTeam(client, team.id);

      const mem = await this.getMembershipInternal(client, team.id, actorId);

      if (updates.locked !== undefined || updates.pinned !== undefined) {
        if (!mem || (mem.role !== 'admin' && mem.role !== 'owner')) {
          throw new CommunityRuleError('not_authorized', 'Only admins and owners can lock or pin threads');
        }
      }

      if (updates.title !== undefined) {
        if (thread.authorId !== actorId && (!mem || (mem.role !== 'admin' && mem.role !== 'owner'))) {
          throw new CommunityRuleError('not_authorized', 'Only author, admins, or owners can update thread title');
        }
      }

      const updatedTitle = updates.title !== undefined ? assertValidThreadTitle(updates.title) : thread.title;
      const updatedLocked = updates.locked !== undefined ? updates.locked : thread.locked;
      const updatedPinned = updates.pinned !== undefined ? updates.pinned : thread.pinned;

      const res = await client.query<ThreadRow>(
        `UPDATE community_forum_threads
         SET title = $1, locked = $2, pinned = $3
         WHERE id = $4
         RETURNING id, team_id, author_id, title, created_at, last_post_at, locked, pinned, deleted_at`,
        [updatedTitle, updatedLocked, updatedPinned, threadId]
      );

      await client.query('COMMIT');
      return rowToThread(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteThread(threadId: ThreadId, actorId: PlayerId, at: Date): Promise<ForumThread> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { thread, team } = await this.findVisibleThread(client, threadId, actorId);
      await lockTeam(client, team.id);

      const mem = await this.getMembershipInternal(client, team.id, actorId);

      if (thread.authorId !== actorId && (!mem || (mem.role !== 'admin' && mem.role !== 'owner'))) {
        throw new CommunityRuleError('not_authorized', 'Only thread author, admins, or owners can delete a thread');
      }

      if (thread.deletedAt !== undefined) {
        throw new CommunityRuleError('invalid_transition', 'Thread is already deleted');
      }

      const res = await client.query<ThreadRow>(
        `UPDATE community_forum_threads
         SET deleted_at = $1
         WHERE id = $2
         RETURNING id, team_id, author_id, title, created_at, last_post_at, locked, pinned, deleted_at`,
        [at, threadId]
      );

      await client.query('COMMIT');
      return rowToThread(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listThreads(
    teamId: TeamId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumThread>> {
    await this.findVisibleTeam(this.pool, teamId, actorId);

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community_forum_threads WHERE team_id = $1 AND deleted_at IS NULL`,
      [teamId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [teamId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<ThreadRow>(
      `SELECT id, team_id, author_id, title, created_at, last_post_at, locked, pinned, deleted_at
       FROM community_forum_threads
       WHERE team_id = $1 AND deleted_at IS NULL
       ORDER BY pinned DESC, last_post_at DESC, id ASC
       ${pagination}`,
      params
    );

    return { total, items: res.rows.map(rowToThread) };
  }

  async createPost(
    id: PostId,
    threadId: ThreadId,
    authorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost> {
    const validBody = assertValidPostBody(body);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { thread, team } = await this.findVisibleThread(client, threadId, authorId);
      await lockTeam(client, team.id);

      const mem = await this.getMembershipInternal(client, team.id, authorId);
      if (!mem) {
        throw new CommunityRuleError('not_authorized', 'Only team members can post in forum threads');
      }

      if (thread.locked && mem.role === 'member') {
        throw new CommunityRuleError('not_authorized', 'Thread is locked. Only admins and owners can post in locked threads');
      }

      if (thread.deletedAt !== undefined) {
        throw new CommunityRuleError('invalid_transition', 'Cannot post in a deleted thread');
      }

      const postRes = await client.query<PostRow>(
        `INSERT INTO community_forum_posts (id, thread_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, thread_id, author_id, body, created_at, edited_at, deleted_at`,
        [id, threadId, authorId, validBody, at]
      ).catch(rethrowMissingResource);

      await client.query(
        `UPDATE community_forum_threads
         SET last_post_at = GREATEST(last_post_at, $1)
         WHERE id = $2`,
        [at, threadId]
      );

      await client.query('COMMIT');
      return rowToPost(postRes.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async getPost(postId: PostId, actorId?: PlayerId): Promise<ForumPost> {
    const { post } = await this.findVisiblePost(this.pool, postId, actorId);
    return post;
  }

  async editPost(
    postId: PostId,
    actorId: PlayerId,
    body: string,
    at: Date
  ): Promise<ForumPost> {
    const validBody = assertValidPostBody(body);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { post, thread, team } = await this.findVisiblePost(client, postId, actorId);
      await lockTeam(client, team.id);

      const mem = await this.getMembershipInternal(client, team.id, actorId);

      if (post.authorId !== actorId) {
        throw new CommunityRuleError('not_authorized', 'Only the author may edit their post');
      }

      if (post.deletedAt !== undefined) {
        throw new CommunityRuleError('invalid_transition', 'Cannot edit a deleted post');
      }

      if (thread.locked && mem && mem.role === 'member') {
        throw new CommunityRuleError('not_authorized', 'Thread is locked');
      }

      const res = await client.query<PostRow>(
        `UPDATE community_forum_posts
         SET body = $1, edited_at = $2
         WHERE id = $3
         RETURNING id, thread_id, author_id, body, created_at, edited_at, deleted_at`,
        [validBody, at, postId]
      );

      await client.query('COMMIT');
      return rowToPost(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async deletePost(
    postId: PostId,
    actorId: PlayerId,
    at: Date
  ): Promise<ForumPost> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { post, team } = await this.findVisiblePost(client, postId, actorId);
      await lockTeam(client, team.id);

      const mem = await this.getMembershipInternal(client, team.id, actorId);

      const isAuthor = post.authorId === actorId;
      const isAdminOrOwner = mem && (mem.role === 'admin' || mem.role === 'owner');

      if (!isAuthor && !isAdminOrOwner) {
        throw new CommunityRuleError('not_authorized', 'Only author, admins, or owners can delete a post');
      }

      if (post.deletedAt !== undefined) {
        throw new CommunityRuleError('invalid_transition', 'Post is already deleted');
      }

      const res = await client.query<PostRow>(
        `UPDATE community_forum_posts
         SET body = '', deleted_at = $1
         WHERE id = $2
         RETURNING id, thread_id, author_id, body, created_at, edited_at, deleted_at`,
        [at, postId]
      );

      await client.query('COMMIT');
      return rowToPost(res.rows[0]);
    } catch (err) {
      await rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async listPosts(
    threadId: ThreadId,
    actorId?: PlayerId,
    options?: PageOptions
  ): Promise<Page<ForumPost>> {
    await this.findVisibleThread(this.pool, threadId, actorId);

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community_forum_posts WHERE thread_id = $1`,
      [threadId]
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const params: unknown[] = [threadId];
    const pagination = paginationClause(params, options);

    const res = await this.pool.query<PostRow>(
      `SELECT id, thread_id, author_id, body, created_at, edited_at, deleted_at
       FROM community_forum_posts
       WHERE thread_id = $1
       ORDER BY created_at ASC, id ASC
       ${pagination}`,
      params
    );

    return { total, items: res.rows.map(rowToPost) };
  }
}
