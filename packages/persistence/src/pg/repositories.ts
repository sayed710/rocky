/**
 * @packageDocumentation
 * Postgres implementations of the repository contracts in `../repositories`.
 * Hand-written SQL (no ORM); controlled-value columns are guarded by lookup-table
 * FKs and CHECK constraints in the schema, so string casts here are safe.
 */

import type { Pool, PoolClient } from 'pg';
import type { Variant } from '@chess-platform/core';
import type { ResultString, Termination, TimeControl, GameEvent } from '@chess-platform/game';
import type {
  GameFinish,
  GameStart,
  GameSummaryRow,
  GamesRepository,
  NewSeek,
  NewSession,
  NewUser,
  RatingRow,
  RatingsRepository,
  Role,
  SeekColor,
  SeekAcceptor,
  GameStarter,
  SeekRow,
  SeeksRepository,
  SessionRow,
  SessionRotationResult,
  SessionsRepository,
  Speed,
  TournamentSummaryRow,
  TournamentsRepository,
  TournamentAnySnapshot,
  UserRow,
  UsersRepository,
  IdentityTokenKind,
  IdentityTokenRow,
  NewIdentityToken,
  IdentityTokensRepository,
  WebAuthnCredentialRow,
  NewWebAuthnCredential,
  WebAuthnCredentialsRepository,
  WebAuthnLoginChallengeRow,
  NewWebAuthnLoginChallenge,
  WebAuthnLoginChallengesRepository,
} from '../repositories';
import { SEEK_TTL_MS } from '../repositories';
import { CURRENT_EVENT_VERSION } from '../event-store.js';
import { DuplicateUserError, VersionConflictError } from '../errors';

const SEEK_TTL_INTERVAL = `${Math.floor(SEEK_TTL_MS / 1000)} seconds`;

// --- row shapes as returned by pg ------------------------------------------


interface UserDbRow {
  id: string;
  handle: string;
  email: string | null;
  email_verified_at: Date | null;
  email_hash: Buffer | null;
  country: string | null;
  flags: Record<string, unknown>;
  created_at: Date;
}

interface SessionDbRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
  last_seen_at: Date | null;
  last_ip: string | null;
  last_user_agent: string | null;
  created_ip: string | null;
  created_user_agent: string | null;
}

interface RatingDbRow {
  user_id: string;
  variant: string;
  rating: number;
  rd: number;
  vol: number;
  updated_at: Date;
}

interface GameDbRow {
  id: string;
  variant: string;
  rated: boolean;
  speed: string;
  white_id: string | null;
  black_id: string | null;
  result: string | null;
  termination: string | null;
  ply_count: number;
  last_seq: number;
  started_at: Date;
  ended_at: Date | null;
}

interface SeekDbRow {
  id: string;
  creator_id: string;
  creator_handle?: string | null;
  variant: string;
  time_control: TimeControl;
  rated: boolean;
  color: string;
  min_rating: number | null;
  max_rating: number | null;
  created_at: Date;
  game_id: string | null;
  accepted_at: Date | null;
}

interface TournamentDbRow {
  id: string;
  name: string;
  format: 'round_robin' | 'swiss' | 'arena';
  state: 'registration' | 'running' | 'finished';
  participant_count: number;
  snapshot: TournamentAnySnapshot;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toUser(r: UserDbRow): UserRow {
  return {
    id: r.id,
    handle: r.handle,
    email: r.email,
    emailVerifiedAt: r.email_verified_at,
    emailHash: r.email_hash,
    country: r.country,
    flags: r.flags,
    createdAt: r.created_at,
  };
}

function toSession(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    rotatedFrom: r.rotated_from,
    lastSeenAt: r.last_seen_at,
    lastIp: r.last_ip,
    lastUserAgent: r.last_user_agent,
    createdIp: r.created_ip,
    createdUserAgent: r.created_user_agent,
  };
}

function toRating(r: RatingDbRow): RatingRow {
  return {
    userId: r.user_id,
    variant: r.variant as Variant,
    rating: r.rating,
    rd: r.rd,
    vol: r.vol,
    updatedAt: r.updated_at,
  };
}

function toGame(r: GameDbRow): GameSummaryRow {
  return {
    id: r.id,
    variant: r.variant as Variant,
    rated: r.rated,
    speed: r.speed as Speed,
    whiteId: r.white_id,
    blackId: r.black_id,
    result: r.result as ResultString | null,
    termination: r.termination as Termination | null,
    plyCount: r.ply_count,
    lastSeq: r.last_seq,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/**
 * Converts a database seek row with optional joined user handle into a domain SeekRow.
 *
 * @param r - The raw database seek row
 * @returns Domain SeekRow with creatorHandle populated
 */
function toSeek(r: SeekDbRow): SeekRow {
  return {
    id: r.id,
    creatorId: r.creator_id,
    creatorHandle: r.creator_handle ?? null,
    variant: r.variant as Variant,
    timeControl: r.time_control,
    rated: r.rated,
    color: r.color as SeekColor,
    minRating: r.min_rating,
    maxRating: r.max_rating,
    createdAt: r.created_at,
    gameId: r.game_id,
    acceptedAt: r.accepted_at,
  };
}

const SESSION_COLS =
  'id, user_id, created_at, expires_at, revoked_at, rotated_from, last_seen_at, last_ip, last_user_agent, created_ip, created_user_agent';
const GAME_COLS =
  'id, variant, rated, speed, white_id, black_id, result, termination, ply_count, last_seq, started_at, ended_at';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === '23505';
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure.
  }
}

export class PgUsersRepository implements UsersRepository {
  constructor(private readonly pool: Pool) {}

  async create(user: NewUser): Promise<UserRow> {
    const res = await this.pool.query<UserDbRow>(
      `INSERT INTO users (id, handle, email, email_hash, country)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, handle, email, email_verified_at, email_hash, country, flags, created_at`,
      [user.id, user.handle, user.email ?? null, user.emailHash ?? null, user.country ?? null],
    );
    return toUser(res.rows[0]!);
  }

  async createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query<UserDbRow>(
        `INSERT INTO users (id, handle, email, email_hash, country)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, handle, email, email_verified_at, email_hash, country, flags, created_at`,
        [user.id, user.handle, user.email ?? null, user.emailHash ?? null, user.country ?? null],
      );
      await client.query(
        `INSERT INTO credentials (user_id, kind, secret_hash)
         VALUES ($1, 'password', $2)`,
        [user.id, secretHash],
      );
      await client.query(
        'INSERT INTO roles (user_id, role) VALUES ($1, $2)',
        [user.id, role],
      );
      await client.query('COMMIT');
      return toUser(created.rows[0]!);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) throw new DuplicateUserError();
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email, email_verified_at, email_hash, country, flags, created_at FROM users WHERE id = $1',
      [id],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async findByIds(ids: readonly string[]): Promise<readonly UserRow[]> {
    // `= ANY($1::uuid[])` casts the whole array, so one malformed element fails the entire read
    // with SQLSTATE 22P02 — a single bad id in a batch would take out every other id sharing it.
    // An id that cannot name a row is dropped instead, which is the same answer `findById` gives.
    const canonical = ids.filter(isCanonicalUuid);
    if (canonical.length === 0) return [];
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email, email_verified_at, email_hash, country, flags, created_at FROM users WHERE id = ANY($1::uuid[])',
      [canonical],
    );
    return res.rows.map(toUser);
  }

  async findByHandle(handle: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email, email_verified_at, email_hash, country, flags, created_at FROM users WHERE handle = $1',
      [handle],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserDbRow>(
      'SELECT id, handle, email, email_verified_at, email_hash, country, flags, created_at FROM users WHERE email = $1',
      [email],
    );
    return res.rows[0] ? toUser(res.rows[0]) : null;
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    await this.pool.query(
      'UPDATE users SET email_verified_at = $2 WHERE id = $1',
      [userId, at],
    );
  }

  async setPassword(userId: string, secretHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO credentials (user_id, kind, secret_hash) VALUES ($1, 'password', $2)
       ON CONFLICT (user_id, kind) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, updated_at = now()`,
      [userId, secretHash],
    );
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const res = await this.pool.query<{ secret_hash: string }>(
      "SELECT secret_hash FROM credentials WHERE user_id = $1 AND kind = 'password'",
      [userId],
    );
    return res.rows[0]?.secret_hash ?? null;
  }

  async addRole(userId: string, role: Role): Promise<void> {
    await this.pool.query(
      'INSERT INTO roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, role],
    );
  }

  async rolesOf(userId: string): Promise<Role[]> {
    const res = await this.pool.query<{ role: string }>(
      'SELECT role FROM roles WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    return res.rows.map((r) => r.role as Role);
  }
}

export class PgSessionsRepository implements SessionsRepository {
  constructor(private readonly pool: Pool) {}

  async create(session: NewSession): Promise<SessionRow> {
    const res = await this.pool.query<SessionDbRow>(
      `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, rotated_from, created_ip, created_user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SESSION_COLS}`,
      [
        session.id,
        session.userId,
        session.refreshHash,
        session.expiresAt,
        session.rotatedFrom ?? null,
        session.ip ?? null,
        session.userAgent ?? null,
      ],
    );
    return toSession(res.rows[0]!);
  }

  async findActiveById(id: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [id],
    );
    return res.rows[0] ? toSession(res.rows[0]) : null;
  }

  async findByRefreshHash(refreshHash: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions WHERE refresh_hash = $1`,
      [refreshHash],
    );
    return res.rows[0] ? toSession(res.rows[0]) : null;
  }

  async rotate(
    refreshHash: string,
    replacement: NewSession,
    at: Date,
  ): Promise<SessionRotationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<SessionDbRow>(
        `SELECT ${SESSION_COLS} FROM sessions
         WHERE refresh_hash = $1 FOR UPDATE`,
        [refreshHash],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { status: 'missing' };
      }
      const previous = toSession(row);
      if (previous.revokedAt !== null) {
        await client.query('COMMIT');
        return { status: 'revoked', previous };
      }
      if (previous.expiresAt.getTime() <= at.getTime()) {
        await client.query('COMMIT');
        return { status: 'expired', previous };
      }

      await client.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [previous.id, at]);
      const inserted = await client.query<SessionDbRow>(
        `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, rotated_from, created_ip, created_user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SESSION_COLS}`,
        [
          replacement.id,
          replacement.userId,
          replacement.refreshHash,
          replacement.expiresAt,
          replacement.rotatedFrom ?? previous.id,
          replacement.ip ?? null,
          replacement.userAgent ?? null,
        ],
      );
      await client.query('COMMIT');
      return { status: 'rotated', previous, replacement: toSession(inserted.rows[0]!) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET last_seen_at = $2, last_ip = $3, last_user_agent = $4 WHERE id = $1',
      [id, at, ip ?? null, userAgent ?? null],
    );
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    // `revoked_at IS NULL` makes the transition itself the lock: two concurrent revocations of the
    // same session both succeed, but exactly one of them reports having performed it.
    const res = await this.pool.query(
      'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, at],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const res = await this.pool.query<SessionDbRow>(
      `SELECT ${SESSION_COLS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return res.rows.map(toSession);
  }
}

export class PgRatingsRepository implements RatingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: string, variant: Variant): Promise<RatingRow | null> {
    const res = await this.pool.query<RatingDbRow>(
      'SELECT user_id, variant, rating, rd, vol, updated_at FROM ratings WHERE user_id = $1 AND variant = $2',
      [userId, variant],
    );
    return res.rows[0] ? toRating(res.rows[0]) : null;
  }

  async upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ratings (user_id, variant, rating, rd, vol) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, variant)
       DO UPDATE SET rating = EXCLUDED.rating, rd = EXCLUDED.rd, vol = EXCLUDED.vol, updated_at = now()`,
      [row.userId, row.variant, row.rating, row.rd, row.vol],
    );
  }

  async leaderboard(variant: Variant, limit: number): Promise<RatingRow[]> {
    const res = await this.pool.query<RatingDbRow>(
      `SELECT user_id, variant, rating, rd, vol, updated_at FROM ratings
       WHERE variant = $1 ORDER BY rating DESC LIMIT $2`,
      [variant, limit],
    );
    return res.rows.map(toRating);
  }
}

export class PgGamesRepository implements GamesRepository {
  constructor(private readonly pool: Pool) {}

  async start(game: GameStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [game.id, game.variant, game.rated, game.speed, game.whiteId, game.blackId, game.startedAt],
    );
  }

  async updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void> {
    await this.pool.query('UPDATE games SET ply_count = $2, last_seq = $3 WHERE id = $1', [
      id,
      plyCount,
      lastSeq,
    ]);
  }

  async finish(id: string, finish: GameFinish): Promise<void> {
    await this.pool.query(
      `UPDATE games SET result = $2, termination = $3, ply_count = $4, last_seq = $5, ended_at = $6
       WHERE id = $1`,
      [id, finish.result, finish.termination, finish.plyCount, finish.lastSeq, finish.endedAt],
    );
  }

  async findById(id: string): Promise<GameSummaryRow | null> {
    // PostgreSQL throws 22P02 when a text path parameter is compared with a
    // UUID column. Treat a malformed public id exactly like an unknown game so
    // GET /v1/games/:id returns the documented 404 instead of leaking a 500.
    if (!isCanonicalUuid(id)) return null;
    const res = await this.pool.query<GameDbRow>(
      `SELECT ${GAME_COLS} FROM games WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? toGame(res.rows[0]) : null;
  }

  async recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]> {
    const res = await this.pool.query<GameDbRow>(
      `SELECT ${GAME_COLS} FROM games
       WHERE white_id = $1 OR black_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map(toGame);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Return whether a repository identifier is a canonical hyphenated UUID. */
function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * PostgreSQL implementation of SeeksRepository.
 * Performs database-level joins to include creator handles in seek rows.
 */
export class PgSeeksRepository implements SeeksRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts a new seek row and returns it with the creator's handle joined from users.
   *
   * @param seek - Parameters for the new seek
   * @returns The newly created SeekRow
   */
  async create(seek: NewSeek): Promise<SeekRow> {
    const res = await this.pool.query<SeekDbRow>(
      `WITH inserted AS (
         INSERT INTO seeks (id, creator_id, variant, time_control, rated, color, min_rating, max_rating)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
         RETURNING id, creator_id, variant, time_control, rated, color, min_rating, max_rating, created_at, game_id, accepted_at
       )
       SELECT i.id, i.creator_id, u.handle AS creator_handle, i.variant, i.time_control, i.rated, i.color, i.min_rating, i.max_rating, i.created_at, i.game_id, i.accepted_at
       FROM inserted i
       LEFT JOIN users u ON u.id = i.creator_id`,
      [
        seek.id,
        seek.creatorId,
        seek.variant,
        JSON.stringify(seek.timeControl),
        seek.rated,
        seek.color ?? 'random',
        seek.minRating ?? null,
        seek.maxRating ?? null,
      ],
    );
    return toSeek(res.rows[0]!);
  }

  /**
   * Finds a seek by id, joining creator handle.
   *
   * @param id - The seek ID
   * @returns The SeekRow if found, or null
   */
  async findById(id: string): Promise<SeekRow | null> {
    const res = await this.pool.query<SeekDbRow>(
      `SELECT s.id, s.creator_id, u.handle AS creator_handle, s.variant, s.time_control, s.rated, s.color, s.min_rating, s.max_rating, s.created_at, s.game_id, s.accepted_at
       FROM seeks s
       LEFT JOIN users u ON u.id = s.creator_id
       WHERE s.id = $1`,
      [id],
    );
    return res.rows[0] ? toSeek(res.rows[0]) : null;
  }

  /**
   * Lists unaccepted seeks within TTL and optionally the requesting creator's latest match receipt.
   * Joins creator handles directly in SQL.
   *
   * @param limit - Maximum number of open seeks to return
   * @param creatorId - Optional user ID of the requesting player
   * @returns List of open SeekRow entities
   */
  async listOpen(limit: number, creatorId?: string): Promise<SeekRow[]> {
    const cid = creatorId ?? '00000000-0000-0000-0000-000000000000';
    const res = await this.pool.query<SeekDbRow>(
      `(
         SELECT s.id, s.creator_id, u.handle AS creator_handle, s.variant, s.time_control, s.rated, s.color, s.min_rating, s.max_rating, s.created_at, s.game_id, s.accepted_at
         FROM seeks s
         LEFT JOIN users u ON u.id = s.creator_id
         LEFT JOIN games g ON g.id = s.game_id
         WHERE s.creator_id = $2 AND s.game_id IS NOT NULL AND s.accepted_at > NOW() - interval '5 minutes' AND (g.id IS NULL OR g.ended_at IS NULL)
         ORDER BY s.accepted_at DESC, s.created_at DESC
         LIMIT 1
       )
       UNION ALL
       (
         SELECT s.id, s.creator_id, u.handle AS creator_handle, s.variant, s.time_control, s.rated, s.color, s.min_rating, s.max_rating, s.created_at, s.game_id, s.accepted_at
         FROM seeks s
         LEFT JOIN users u ON u.id = s.creator_id
         WHERE s.game_id IS NULL AND s.created_at > NOW() - $3::interval
         ORDER BY s.created_at ASC
         LIMIT $1
       )`,
      [limit, cid, SEEK_TTL_INTERVAL],
    );
    return res.rows.map(toSeek);
  }

  /**
   * Removes an open seek by id.
   *
   * @param id - The seek ID
   * @returns True if deleted, false if missing or already accepted
   */
  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM seeks WHERE id = $1 AND game_id IS NULL RETURNING id',
      [id],
    );
    return res.rowCount === 1;
  }

  /**
   * Purges expired open seeks past SEEK_TTL_INTERVAL and old accepted receipts.
   *
   * @param at - Current timestamp for cleanup comparison
   */
  async cleanup(at: Date): Promise<void> {
    await this.pool.query(
      `DELETE FROM seeks
       WHERE (game_id IS NOT NULL AND accepted_at <= $1 - interval '5 minutes')
          OR (game_id IS NULL AND created_at <= $1 - $2::interval)`,
      [at, SEEK_TTL_INTERVAL],
    );
  }
}

/**
 * PostgreSQL transaction coordinator for atomically accepting seeks.
 */
export class PgSeekAcceptor implements SeekAcceptor {
  constructor(private readonly pool: Pool) {}

  /**
   * Atomically claims a seek, creates game rows, and records initial game events.
   *
   * @param seekId - ID of seek being accepted
   * @param gameId - ID of the new game
   * @param events - Initial events to append
   * @param gameStart - Metadata for game creation
   * @returns The updated SeekRow with creator handle, or null if seek not available
   */
  async accept(seekId: string, gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<SeekRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seekRes = await client.query<SeekDbRow>(
        `WITH updated AS (
           UPDATE seeks SET game_id = $1, accepted_at = NOW()
           WHERE id = $2 AND game_id IS NULL AND created_at > NOW() - $3::interval
           RETURNING id, creator_id, variant, time_control, rated, color, min_rating, max_rating, created_at, game_id, accepted_at
         )
         SELECT u_seek.id, u_seek.creator_id, u.handle AS creator_handle, u_seek.variant, u_seek.time_control, u_seek.rated, u_seek.color, u_seek.min_rating, u_seek.max_rating, u_seek.created_at, u_seek.game_id, u_seek.accepted_at
         FROM updated u_seek
         LEFT JOIN users u ON u.id = u_seek.creator_id`,
        [gameId, seekId, SEEK_TTL_INTERVAL],
      );
      if (seekRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      
      let seq = -1;
      for (const event of events) {
        seq += 1;
        await client.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)]
        );
      }
      
      await client.query(
        `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [gameId, gameStart.variant, gameStart.rated, gameStart.speed, gameStart.whiteId, gameStart.blackId, gameStart.startedAt]
      );
      
      await client.query('COMMIT');
      return toSeek(seekRes.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export class PgGameStarter implements GameStarter {
  constructor(private readonly pool: Pool) {}

  async start(gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let seq = -1;
      for (const event of events) {
        seq += 1;
        await client.query(
          `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [gameId, seq, event.type, CURRENT_EVENT_VERSION, JSON.stringify(event)]
        );
      }

      await client.query(
        `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [gameId, gameStart.variant, gameStart.rated, gameStart.speed, gameStart.whiteId, gameStart.blackId, gameStart.startedAt]
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await rollback(client);
      if (isUniqueViolation(err)) {
        return false;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}


export class PgTournamentsRepository implements TournamentsRepository {
  constructor(private readonly pool: Pool) {}

  async save(snapshot: TournamentAnySnapshot, expectedVersion: number): Promise<void> {
    if (expectedVersion === 0) {
      try {
        await this.pool.query(
          `INSERT INTO tournaments (id, name, format, state, participant_count, snapshot, version)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1)`,
          [
            snapshot.config.id,
            snapshot.config.name,
            snapshot.config.format,
            snapshot.state,
            snapshot.participants.length,
            JSON.stringify(snapshot),
          ]
        );
      } catch (err: any) {
        if (isUniqueViolation(err)) {
          throw new VersionConflictError(snapshot.config.id, expectedVersion);
        }
        throw err;
      }
    } else {
      const res = await this.pool.query(
        `UPDATE tournaments SET
           name = $2,
           format = $3,
           state = $4,
           participant_count = $5,
           snapshot = $6::jsonb,
           version = version + 1,
           updated_at = now()
         WHERE id = $1 AND version = $7`,
        [
          snapshot.config.id,
          snapshot.config.name,
          snapshot.config.format,
          snapshot.state,
          snapshot.participants.length,
          JSON.stringify(snapshot),
          expectedVersion,
        ]
      );
      if (res.rowCount === 0) {
        throw new VersionConflictError(snapshot.config.id, expectedVersion);
      }
    }
  }

  async findById(id: string): Promise<{ snapshot: TournamentAnySnapshot; version: number } | null> {
    const res = await this.pool.query<TournamentDbRow>(
      'SELECT snapshot, version FROM tournaments WHERE id = $1',
      [id]
    );
    return res.rows[0]
      ? { snapshot: res.rows[0].snapshot as TournamentAnySnapshot, version: res.rows[0].version }
      : null;
  }

  async list(limit: number): Promise<TournamentSummaryRow[]> {
    const res = await this.pool.query<TournamentDbRow>(
      `SELECT id, name, format, state, participant_count
       FROM tournaments ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map(r => ({
      id: r.id,
      name: r.name,
      format: r.format,
      state: r.state,
      participantCount: r.participant_count,
    }));
  }
}

export class PgIdentityTokensRepository implements IdentityTokensRepository {
  constructor(private readonly pool: Pool) {}

  async create(token: NewIdentityToken): Promise<IdentityTokenRow> {
    const res = await this.pool.query<{
      token_hash: string;
      user_id: string;
      kind: string;
      created_at: Date;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `INSERT INTO identity_tokens (token_hash, user_id, kind, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING token_hash, user_id, kind, created_at, expires_at, used_at`,
      [token.tokenHash, token.userId, token.kind, token.expiresAt],
    );
    const r = res.rows[0]!;
    return {
      tokenHash: r.token_hash,
      userId: r.user_id,
      kind: r.kind as IdentityTokenKind,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
    };
  }

  async replaceActive(token: NewIdentityToken, at: Date): Promise<IdentityTokenRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The user row is a stable lock even when there are no earlier token rows. It serializes two
      // concurrent resend requests so the later request supersedes the earlier token rather than
      // leaving both usable.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [token.userId]);
      await client.query(
        `UPDATE identity_tokens
         SET used_at = $3
         WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`,
        [token.userId, token.kind, at],
      );
      const res = await client.query<{
        token_hash: string;
        user_id: string;
        kind: string;
        created_at: Date;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `INSERT INTO identity_tokens (token_hash, user_id, kind, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING token_hash, user_id, kind, created_at, expires_at, used_at`,
        [token.tokenHash, token.userId, token.kind, token.expiresAt],
      );
      await client.query('COMMIT');
      const row = res.rows[0]!;
      return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        kind: row.kind as IdentityTokenKind,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceActiveEmailVerification(
    token: Omit<NewIdentityToken, 'kind'>,
    at: Date,
  ): Promise<IdentityTokenRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ email_verified_at: Date | null }>(
        'SELECT email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [token.userId],
      );
      if (!user.rows[0] || user.rows[0].email_verified_at !== null) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `UPDATE identity_tokens
         SET used_at = $2
         WHERE user_id = $1 AND kind = 'email_verify' AND used_at IS NULL`,
        [token.userId, at],
      );
      const res = await client.query<{
        token_hash: string;
        user_id: string;
        kind: string;
        created_at: Date;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `INSERT INTO identity_tokens (token_hash, user_id, kind, expires_at)
         VALUES ($1, $2, 'email_verify', $3)
         RETURNING token_hash, user_id, kind, created_at, expires_at, used_at`,
        [token.tokenHash, token.userId, token.expiresAt],
      );
      await client.query('COMMIT');
      const row = res.rows[0]!;
      return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        kind: row.kind as IdentityTokenKind,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async consume(
    tokenHash: string,
    kind: IdentityTokenKind,
    at: Date,
  ): Promise<IdentityTokenRow | null> {
    const res = await this.pool.query<{
      token_hash: string;
      user_id: string;
      kind: string;
      created_at: Date;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `UPDATE identity_tokens
       SET used_at = $3
       WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3
       RETURNING token_hash, user_id, kind, created_at, expires_at, used_at`,
      [tokenHash, kind, at],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      tokenHash: r.token_hash,
      userId: r.user_id,
      kind: r.kind as IdentityTokenKind,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
    };
  }

  async consumeEmailVerification(tokenHash: string, at: Date): Promise<IdentityTokenRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Read the owner first, then take the same stable user-row lock used by replacement. The
      // token is re-checked after the lock, so a replacement that won the race makes consumption
      // fail, while a successful consumption makes a waiting replacement observe verification.
      const owner = await client.query<{ user_id: string }>(
        `SELECT user_id FROM identity_tokens
         WHERE token_hash = $1 AND kind = 'email_verify'`,
        [tokenHash],
      );
      if (!owner.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const userId = owner.rows[0].user_id;
      const locked = await client.query<{ email_verified_at: Date | null }>(
        'SELECT email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!locked.rows[0] || locked.rows[0].email_verified_at !== null) {
        await client.query('COMMIT');
        return null;
      }
      const res = await client.query<{
        token_hash: string;
        user_id: string;
        kind: string;
        created_at: Date;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `UPDATE identity_tokens
         SET used_at = $2
         WHERE token_hash = $1
           AND kind = 'email_verify'
           AND used_at IS NULL
           AND expires_at > $2
         RETURNING token_hash, user_id, kind, created_at, expires_at, used_at`,
        [tokenHash, at],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        'UPDATE users SET email_verified_at = $2 WHERE id = $1',
        [row.user_id, at],
      );
      await client.query('COMMIT');
      return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        kind: row.kind as IdentityTokenKind,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PgWebAuthnLoginChallengesRepository implements WebAuthnLoginChallengesRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(challenge: NewWebAuthnLoginChallenge): Promise<void> {
    await this.pool.query(
      `INSERT INTO webauthn_login_challenges (challenge_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (challenge_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [challenge.challengeHash, challenge.userId, challenge.expiresAt],
    );
  }

  async consume(challengeHash: string, at: Date): Promise<WebAuthnLoginChallengeRow | null> {
    const res = await this.pool.query<{
      challenge_hash: string;
      user_id: string | null;
      expires_at: Date;
    }>(
      `DELETE FROM webauthn_login_challenges
       WHERE challenge_hash = $1 AND expires_at > $2
       RETURNING challenge_hash, user_id, expires_at`,
      [challengeHash, at],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      challengeHash: r.challenge_hash,
      userId: r.user_id,
      expiresAt: r.expires_at,
    };
  }

  async cleanup(at: Date): Promise<void> {
    await this.pool.query('DELETE FROM webauthn_login_challenges WHERE expires_at <= $1', [at]);
  }
}

export class PgWebAuthnCredentialsRepository implements WebAuthnCredentialsRepository {
  constructor(private readonly pool: Pool) {}

  async create(credential: NewWebAuthnCredential): Promise<WebAuthnCredentialRow> {
    const res = await this.pool.query<{
      id: Buffer;
      user_id: string;
      public_key: Buffer;
      sign_count: string;
      transports: string[];
      name: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, sign_count, transports, name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, public_key, sign_count, transports, name, created_at, last_used_at`,
      [
        credential.id,
        credential.userId,
        credential.publicKey,
        credential.signCount,
        credential.transports,
        credential.name,
      ],
    );
    const r = res.rows[0]!;
    return {
      id: r.id,
      userId: r.user_id,
      publicKey: r.public_key,
      signCount: parseInt(r.sign_count, 10),
      transports: r.transports,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  }

  async findByCredentialId(id: Buffer): Promise<WebAuthnCredentialRow | null> {
    const res = await this.pool.query<{
      id: Buffer;
      user_id: string;
      public_key: Buffer;
      sign_count: string;
      transports: string[];
      name: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `SELECT id, user_id, public_key, sign_count, transports, name, created_at, last_used_at
       FROM webauthn_credentials
       WHERE id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      publicKey: r.public_key,
      signCount: parseInt(r.sign_count, 10),
      transports: r.transports,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  }

  async listForUser(userId: string): Promise<WebAuthnCredentialRow[]> {
    const res = await this.pool.query<{
      id: Buffer;
      user_id: string;
      public_key: Buffer;
      sign_count: string;
      transports: string[];
      name: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `SELECT id, user_id, public_key, sign_count, transports, name, created_at, last_used_at
       FROM webauthn_credentials
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );
    return res.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      publicKey: r.public_key,
      signCount: parseInt(r.sign_count, 10),
      transports: r.transports,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async updateSignCount(id: Buffer, signCount: number, at: Date): Promise<void> {
    const res = await this.pool.query(
      `UPDATE webauthn_credentials
       SET sign_count = $2, last_used_at = $3
       WHERE id = $1 AND (sign_count = 0 OR sign_count < $2)
       RETURNING id`,
      [id, signCount, at],
    );
    if (res.rowCount === 0) {
      throw new Error('ConcurrentAssertionError'); // Captured in service layer
    }
  }

  async delete(id: Buffer): Promise<void> {
    await this.pool.query('DELETE FROM webauthn_credentials WHERE id = $1', [id]);
  }

  async countForUser(userId: string): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = $1',
      [userId],
    );
    return parseInt(res.rows[0]!.count, 10);
  }
}
