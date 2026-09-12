/**
 * @packageDocumentation
 * In-memory implementations of every repository the API consumes. They exist so
 * the whole service can be exercised end-to-end — in tests and in local dev —
 * with zero external infrastructure, while behaving like the Postgres
 * implementations (case-insensitive handles, active-session filtering, ordering).
 * The Postgres implementations remain the production wiring; these fakes are the
 * contract's executable specification.
 */

import type { Variant } from '@chess-platform/core';
import type {
  GameFinish,
  GamesRepository,
  GameStart,
  GameSummaryRow,
  NewSeek,
  NewSession,
  NewUser,
  RatingRow,
  RatingsRepository,
  Role,
  SeekAcceptor,
  GameStarter,
  SeekRow,
  SeeksRepository,
  SessionRow,
  SessionsRepository,
  UserRow,
  UsersRepository,
  TournamentsRepository,
  TournamentSummaryRow,
  TournamentAnySnapshot,
  IdentityTokenKind,
  IdentityTokenRow,
  NewIdentityToken,
  IdentityTokensRepository,
} from '@chess-platform/persistence';
import { DuplicateUserError, VersionConflictError, SEEK_TTL_MS } from '@chess-platform/persistence';

import { InMemoryLearningRepository } from '@chess-platform/learning';
import type { AuditEntry, AuditRepository } from './ports/audit';
import type { Clock } from './ports/clock';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryStudyPartnerRepository } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository, InMemoryBotBehaviorReportRepository } from '@chess-platform/anti-cheat';
import type { GameEvent } from '@chess-platform/game';
import { systemClock } from './ports/clock';
import type { Repositories } from './deps';

export class InMemoryUsersRepository implements UsersRepository {
  private readonly byId = new Map<string, UserRow>();
  private readonly passwords = new Map<string, string>();
  private readonly roles = new Map<string, Set<Role>>();

  constructor(private readonly clock: Clock = systemClock) {}

  async create(user: NewUser): Promise<UserRow> {
    if (this.hasHandle(user.handle)) throw new DuplicateUserError();
    return this.insert(user);
  }

  async createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow> {
    // Deliberately contains no await: duplicate check + all three writes happen
    // in one JavaScript turn, mirroring the Postgres transaction in tests.
    if (this.hasHandle(user.handle)) throw new DuplicateUserError();
    // Mirror the CITEXT UNIQUE constraint on users.email (migration 0007).
    if (user.email && (await this.findByEmail(user.email))) throw new DuplicateUserError();
    const row = this.insert(user);
    this.passwords.set(row.id, secretHash);
    this.roles.set(row.id, new Set([role]));
    return row;
  }

  private insert(user: NewUser): UserRow {
    const row: UserRow = {
      id: user.id,
      handle: user.handle,
      email: user.email ?? null,
      emailHash: user.emailHash ?? null,
      emailVerifiedAt: null,
      country: user.country ?? null,
      flags: {},
      createdAt: new Date(this.clock.now()),
    };
    this.byId.set(row.id, row);
    return row;
  }

  private hasHandle(handle: string): boolean {
    const lower = handle.toLowerCase();
    for (const row of this.byId.values()) {
      if (row.handle.toLowerCase() === lower) return true;
    }
    return false;
  }

  async findById(id: string): Promise<UserRow | null> {
    return this.byId.get(id) ?? null;
  }

  emailIsUnverified(id: string): boolean {
    const user = this.byId.get(id);
    return user !== undefined && user.emailVerifiedAt === null;
  }

  async findByIds(ids: readonly string[]): Promise<readonly UserRow[]> {
    // Unknown ids are dropped rather than yielding a null slot, matching the Postgres adapter:
    // `WHERE id = ANY(...)` returns the rows that exist and says nothing about the rest. Callers
    // key the result by id — neither adapter promises the input order, and relying on it would
    // pass here and fail against a real query plan.
    const found: UserRow[] = [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row) found.push(row);
    }
    return found;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const lower = email.toLowerCase();
    for (const row of this.byId.values()) {
      if (row.email?.toLowerCase() === lower) return row;
    }
    return null;
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    this.markEmailVerifiedNow(userId, at);
  }

  markEmailVerifiedNow(userId: string, at: Date): void {
    const row = this.byId.get(userId);
    if (row) {
      this.byId.set(userId, { ...row, emailVerifiedAt: at });
    }
  }

  async findByHandle(handle: string): Promise<UserRow | null> {
    const lower = handle.toLowerCase();
    for (const row of this.byId.values()) {
      if (row.handle.toLowerCase() === lower) return row;
    }
    return null;
  }

  async setPassword(userId: string, secretHash: string): Promise<void> {
    this.passwords.set(userId, secretHash);
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    return this.passwords.get(userId) ?? null;
  }

  /** Test-only: simulate a passwordless (passkey-only) account. */
  dropPassword(userId: string): void {
    this.passwords.delete(userId);
  }

  async addRole(userId: string, role: Role): Promise<void> {
    const set = this.roles.get(userId) ?? new Set<Role>();
    set.add(role);
    this.roles.set(userId, set);
  }

  async rolesOf(userId: string): Promise<Role[]> {
    return [...(this.roles.get(userId) ?? [])];
  }
}

interface StoredSession {
  row: SessionRow;
  refreshHash: string;
  seq: number;
}

export class InMemorySessionsRepository implements SessionsRepository {
  private readonly byId = new Map<string, StoredSession>();
  private seq = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  async create(session: NewSession): Promise<SessionRow> {
    const row: SessionRow = {
      id: session.id,
      userId: session.userId,
      createdAt: new Date(this.clock.now()),
      expiresAt: session.expiresAt,
      revokedAt: null,
      rotatedFrom: session.rotatedFrom ?? null,
      lastSeenAt: null,
      lastIp: null,
      lastUserAgent: null,
      createdIp: session.ip ?? null,
      createdUserAgent: session.userAgent ?? null,
    };
    this.byId.set(row.id, { row, refreshHash: session.refreshHash, seq: this.seq++ });
    return row;
  }

  async findActiveById(id: string): Promise<SessionRow | null> {
    const stored = this.byId.get(id);
    if (!stored) return null;
    const { row } = stored;
    if (row.revokedAt || row.expiresAt.getTime() <= this.clock.now()) return null;
    return row;
  }

  async findByRefreshHash(refreshHash: string): Promise<SessionRow | null> {
    for (const stored of this.byId.values()) {
      if (stored.refreshHash === refreshHash) return stored.row;
    }
    return null;
  }

  async rotate(refreshHash: string, replacement: NewSession, at: Date) {
    let previous: StoredSession | undefined;
    for (const stored of this.byId.values()) {
      if (stored.refreshHash === refreshHash) {
        previous = stored;
        break;
      }
    }
    if (!previous) return { status: 'missing' as const };
    if (previous.row.revokedAt) return { status: 'revoked' as const, previous: previous.row };
    if (previous.row.expiresAt.getTime() <= at.getTime()) {
      return { status: 'expired' as const, previous: previous.row };
    }

    previous.row = { ...previous.row, revokedAt: at };
    const row: SessionRow = {
      id: replacement.id,
      userId: replacement.userId,
      createdAt: new Date(this.clock.now()),
      expiresAt: replacement.expiresAt,
      revokedAt: null,
      rotatedFrom: replacement.rotatedFrom ?? previous.row.id,
      lastSeenAt: null,
      lastIp: null,
      lastUserAgent: null,
      createdIp: replacement.ip ?? null,
      createdUserAgent: replacement.userAgent ?? null,
    };
    this.byId.set(row.id, { row, refreshHash: replacement.refreshHash, seq: this.seq++ });
    return { status: 'rotated' as const, previous: previous.row, replacement: row };
  }

  async touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void> {
    const stored = this.byId.get(id);
    if (!stored) return;
    stored.row = { ...stored.row, lastSeenAt: at, lastIp: ip ?? null, lastUserAgent: userAgent ?? null };
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const stored = this.byId.get(id);
    if (!stored) return false;
    // Mirrors the `WHERE revoked_at IS NULL` in the Postgres repository: only the call that performs
    // the transition reports having done it, so a test can hold this fake to the same contract.
    if (stored.row.revokedAt) return false;
    stored.row = { ...stored.row, revokedAt: at };
    return true;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    return [...this.byId.values()]
      .filter((s) => s.row.userId === userId)
      .sort((a, b) => b.seq - a.seq)
      .map((s) => s.row);
  }
}

function ratingKey(userId: string, variant: Variant): string {
  return `${userId}:${variant}`;
}

export class InMemoryRatingsRepository implements RatingsRepository {
  private readonly byKey = new Map<string, RatingRow>();

  constructor(private readonly clock: Clock = systemClock) {}

  async get(userId: string, variant: Variant): Promise<RatingRow | null> {
    return this.byKey.get(ratingKey(userId, variant)) ?? null;
  }

  async upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void> {
    this.byKey.set(ratingKey(row.userId, row.variant), {
      ...row,
      updatedAt: new Date(this.clock.now()),
    });
  }

  async leaderboard(variant: Variant, limit: number): Promise<RatingRow[]> {
    return [...this.byKey.values()]
      .filter((r) => r.variant === variant)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }
}

export class InMemoryGamesRepository implements GamesRepository {
  private readonly byId = new Map<string, GameSummaryRow>();
  private seq = 0;
  private readonly order = new Map<string, number>();

  async start(game: GameStart): Promise<void> {
    const row: GameSummaryRow = {
      id: game.id,
      variant: game.variant,
      rated: game.rated,
      speed: game.speed,
      whiteId: game.whiteId,
      blackId: game.blackId,
      result: null,
      termination: null,
      plyCount: 0,
      lastSeq: 0,
      startedAt: game.startedAt,
      endedAt: null,
    };
    this.byId.set(row.id, row);
    this.order.set(row.id, this.seq++);
  }

  async updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void> {
    const row = this.byId.get(id);
    if (row) this.byId.set(id, { ...row, plyCount, lastSeq });
  }

  async finish(id: string, finish: GameFinish): Promise<void> {
    const row = this.byId.get(id);
    if (row) {
      this.byId.set(id, {
        ...row,
        result: finish.result,
        termination: finish.termination,
        plyCount: finish.plyCount,
        lastSeq: finish.lastSeq,
        endedAt: finish.endedAt,
      });
    }
  }

  async findById(id: string): Promise<GameSummaryRow | null> {
    return this.byId.get(id) ?? null;
  }

  async recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]> {
    return [...this.byId.values()]
      .filter((g) => g.whiteId === userId || g.blackId === userId)
      .sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0))
      .slice(0, limit);
  }

  /** Test/local-dev transaction compensation used by the in-memory seek acceptor. */
  _remove(id: string): void {
    this.byId.delete(id);
    this.order.delete(id);
  }
}

/**
 * Deterministic in-memory seek store that mirrors open-seek ordering, expiry, and
 * single-winner acceptance semantics used by the PostgreSQL implementation.
 */
export class InMemorySeeksRepository implements SeeksRepository {
  private readonly byId = new Map<string, SeekRow>();
  private seq = 0;
  private readonly order = new Map<string, number>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly games?: GamesRepository,
    private readonly users?: UsersRepository,
  ) {}

  /**
   * Creates a new in-memory seek, resolving creatorHandle from the users repository if available.
   *
   * @param seek - The seek specification
   * @returns The created SeekRow with creatorHandle
   */
  async create(seek: NewSeek): Promise<SeekRow> {
    let creatorHandle = seek.creatorHandle ?? null;
    if (!creatorHandle && this.users) {
      const user = await this.users.findById(seek.creatorId);
      creatorHandle = user?.handle ?? null;
    }
    const row: SeekRow = {
      id: seek.id,
      creatorId: seek.creatorId,
      creatorHandle,
      variant: seek.variant,
      timeControl: seek.timeControl,
      rated: seek.rated,
      color: seek.color ?? 'random',
      minRating: seek.minRating ?? null,
      maxRating: seek.maxRating ?? null,
      createdAt: new Date(this.clock.now()),
      gameId: null,
      acceptedAt: null,
    };
    this.byId.set(row.id, row);
    this.order.set(row.id, this.seq++);
    return row;
  }

  /**
   * Looks up a seek by id, lazily enriching creatorHandle from the users repository if missing.
   *
   * @param id - Seek identifier
   * @returns SeekRow if found, or null
   */
  async findById(id: string): Promise<SeekRow | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    if (!existing.creatorHandle && this.users) {
      const user = await this.users.findById(existing.creatorId);
      if (user?.handle) {
        const enriched = { ...existing, creatorHandle: user.handle };
        this.byId.set(id, enriched);
        return enriched;
      }
    }
    return existing;
  }

  /**
   * Lists active unaccepted seeks within TTL, enriching with creatorHandle.
   *
   * @param limit - Maximum number of open seeks to return
   * @param creatorId - Optional user ID of the requesting creator
   * @returns Active open seeks, including latest match receipt for creatorId if active
   */
  async listOpen(limit: number, creatorId?: string): Promise<SeekRow[]> {
    const now = this.clock.now();
    const fiveMinsAgo = now - 5 * 60 * 1000;
    const rows = [...this.byId.values()];
    const open = rows
      .filter((s) => s.gameId === null && now - s.createdAt.getTime() < SEEK_TTL_MS)
      .sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0))
      .slice(0, limit);

    const candidatesToEnrich = [...open];
    let latestCandidate: SeekRow | undefined;

    if (creatorId) {
      const matchedCandidates = rows
        .filter(
          (s) =>
            s.creatorId === creatorId &&
            s.gameId !== null &&
            s.acceptedAt !== null &&
            s.acceptedAt.getTime() > fiveMinsAgo,
        )
        .sort(
          (a, b) =>
            b.acceptedAt!.getTime() - a.acceptedAt!.getTime() ||
            (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0),
        );

      for (const match of matchedCandidates) {
        if (!this.games) {
          latestCandidate = match;
          break;
        }
        const game = await this.games.findById(match.gameId!);
        if (game && game.endedAt !== null) {
          continue;
        }
        latestCandidate = match;
        break;
      }
      if (latestCandidate) candidatesToEnrich.push(latestCandidate);
    }

    const missingIds = [...new Set(candidatesToEnrich.filter((s) => !s.creatorHandle).map((s) => s.creatorId))];
    const userMap = new Map<string, string>();
    if (this.users && missingIds.length > 0) {
      const users = await this.users.findByIds(missingIds);
      for (const u of users) {
        userMap.set(u.id, u.handle);
      }
    }

    const enrich = (s: SeekRow): SeekRow => {
      if (s.creatorHandle) return s;
      const handle = userMap.get(s.creatorId);
      return handle ? { ...s, creatorHandle: handle } : s;
    };

    const enrichedOpen = open.map(enrich);
    if (!creatorId || !latestCandidate) return enrichedOpen;

    return [enrich(latestCandidate), ...enrichedOpen];
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.byId.get(id);
    if (!existing || existing.gameId !== null) return false;
    this.byId.delete(id);
    this.order.delete(id);
    return true;
  }

  /** Test/local-dev compare-and-set used by the in-memory seek acceptor. */
  _claim(id: string, gameId: string, acceptedAt: Date): SeekRow | null {
    const existing = this.byId.get(id);
    if (!existing || existing.gameId !== null) return null;
    if (this.clock.now() - existing.createdAt.getTime() >= SEEK_TTL_MS) return null;
    const claimed = { ...existing, gameId, acceptedAt };
    this.byId.set(id, claimed);
    return claimed;
  }

  /** Restore only the claim owned by `gameId`, leaving a newer state untouched. */
  _releaseClaim(id: string, gameId: string): void {
    const existing = this.byId.get(id);
    if (existing?.gameId === gameId) {
      this.byId.set(id, { ...existing, gameId: null, acceptedAt: null });
    }
  }

  async cleanup(at: Date): Promise<void> {
    const cutoff = at.getTime() - 5 * 60 * 1000;
    const openCutoff = at.getTime() - SEEK_TTL_MS;
    for (const [id, seek] of this.byId) {
      if (seek.gameId !== null && seek.acceptedAt && seek.acceptedAt.getTime() <= cutoff) {
        this.byId.delete(id);
        this.order.delete(id);
      } else if (seek.gameId === null && seek.createdAt.getTime() <= openCutoff) {
        this.byId.delete(id);
        this.order.delete(id);
      }
    }
  }
}

export class InMemorySeekAcceptor implements SeekAcceptor {
  constructor(
    private readonly seeks: InMemorySeeksRepository,
    private readonly events: InMemoryEventStore,
    private readonly games: InMemoryGamesRepository,
    private readonly clock: Clock,
  ) {}

  async accept(seekId: string, gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<SeekRow | null> {
    // Deliberately contains no await before the compare-and-set: only one caller
    // can claim an open seek in a single JavaScript event-loop turn.
    const claimed = this.seeks._claim(seekId, gameId, new Date(this.clock.now()));
    if (!claimed) return null;

    let eventsAppended = false;
    let gameStarted = false;
    try {
      await this.events.append(gameId, -1, events);
      eventsAppended = true;
      await this.games.start(gameStart);
      gameStarted = true;
      return claimed;
    } catch (err) {
      if (eventsAppended) this.events._removeGame(gameId);
      if (gameStarted) this.games._remove(gameId);
      this.seeks._releaseClaim(seekId, gameId);
      throw err;
    }
  }
}

export class InMemoryGameStarter implements GameStarter {
  constructor(
    private readonly events: InMemoryEventStore,
    private readonly games: InMemoryGamesRepository,
  ) {}

  async start(gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<boolean> {
    if (await this.games.findById(gameId)) return false;

    let eventsAppended = false;
    try {
      await this.events.append(gameId, -1, events);
      eventsAppended = true;
      await this.games.start(gameStart);
      return true;
    } catch (err) {
      if (eventsAppended) this.events._removeGame(gameId);
      throw err;
    }
  }
}


export class InMemoryAuditRepository implements AuditRepository {
  private readonly log: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.log.push(entry);
  }

  /** All recorded entries (for assertions/inspection). */
  entries(): readonly AuditEntry[] {
    return this.log;
  }

  /** Entries whose action equals `action`. */
  withAction(action: string): readonly AuditEntry[] {
    return this.log.filter((e) => e.action === action);
  }
}

export class InMemoryTournamentsRepository implements TournamentsRepository {
  private readonly byId = new Map<string, { snap: TournamentAnySnapshot; version: number }>();
  private readonly order: string[] = []; // for newest-first list

  async save(snapshot: TournamentAnySnapshot, expectedVersion: number): Promise<void> {
    const existing = this.byId.get(snapshot.config.id);
    const currentVersion = existing ? existing.version : 0;
    if (currentVersion !== expectedVersion) {
      throw new VersionConflictError(snapshot.config.id, expectedVersion);
    }
    const isNew = !existing;
    this.byId.set(snapshot.config.id, { snap: structuredClone(snapshot), version: expectedVersion + 1 });
    if (isNew) {
      this.order.push(snapshot.config.id);
    }
  }

  async findById(id: string): Promise<{ snapshot: TournamentAnySnapshot; version: number } | null> {
    const stored = this.byId.get(id);
    return stored ? { snapshot: structuredClone(stored.snap), version: stored.version } : null;
  }

  async list(limit: number): Promise<TournamentSummaryRow[]> {
    const summaries: TournamentSummaryRow[] = [];
    // Iterate newest first (reverse order)
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i];
      const { snap } = this.byId.get(id)!;
      summaries.push({
        id: snap.config.id,
        name: snap.config.name,
        format: snap.config.format,
        state: snap.state,
        participantCount: snap.participants.length
      });
      if (summaries.length >= limit) break;
    }
    return summaries;
  }
}

export class InMemoryIdentityTokensRepository implements IdentityTokensRepository {
  private readonly byHash = new Map<string, IdentityTokenRow>();

  constructor(private readonly users: InMemoryUsersRepository) {}

  async create(token: NewIdentityToken): Promise<IdentityTokenRow> {
    const row: IdentityTokenRow = {
      tokenHash: token.tokenHash,
      userId: token.userId,
      kind: token.kind,
      createdAt: new Date(),
      expiresAt: token.expiresAt,
      usedAt: null,
    };
    this.byHash.set(row.tokenHash, row);
    return row;
  }

  async replaceActive(token: NewIdentityToken, at: Date): Promise<IdentityTokenRow> {
    for (const [hash, row] of this.byHash) {
      if (row.userId === token.userId && row.kind === token.kind && row.usedAt === null) {
        this.byHash.set(hash, { ...row, usedAt: at });
      }
    }
    return this.create(token);
  }

  async replaceActiveEmailVerification(
    token: Omit<NewIdentityToken, 'kind'>,
    at: Date,
  ): Promise<IdentityTokenRow | null> {
    if (!this.users.emailIsUnverified(token.userId)) return null;
    return this.replaceActive({ ...token, kind: 'email_verify' }, at);
  }

  async consume(
    tokenHash: string,
    kind: IdentityTokenKind,
    at: Date,
  ): Promise<IdentityTokenRow | null> {
    const row = this.byHash.get(tokenHash);
    if (!row) return null;
    if (row.kind !== kind) return null;
    if (row.usedAt !== null) return null;
    if (row.expiresAt.getTime() <= at.getTime()) return null;
    
    // Simulate atomic update
    const consumed = { ...row, usedAt: at };
    this.byHash.set(tokenHash, consumed);
    return consumed;
  }

  async consumeEmailVerification(tokenHash: string, at: Date): Promise<IdentityTokenRow | null> {
    const row = this.byHash.get(tokenHash);
    if (!row) return null;
    if (!this.users.emailIsUnverified(row.userId)) return null;
    if (row.kind !== 'email_verify' || row.usedAt !== null || row.expiresAt.getTime() <= at.getTime()) {
      return null;
    }
    const consumed = { ...row, usedAt: at };
    this.byHash.set(tokenHash, consumed);
    this.users.markEmailVerifiedNow(consumed.userId, at);
    return consumed;
  }
}

import type {
  WebAuthnCredentialRow,
  NewWebAuthnCredential,
  WebAuthnCredentialsRepository,
  WebAuthnLoginChallengeRow,
  NewWebAuthnLoginChallenge,
  WebAuthnLoginChallengesRepository,
} from '@chess-platform/persistence';

export class InMemoryWebAuthnLoginChallengesRepository implements WebAuthnLoginChallengesRepository {
  private readonly byHash = new Map<string, WebAuthnLoginChallengeRow>();

  async upsert(challenge: NewWebAuthnLoginChallenge): Promise<void> {
    this.byHash.set(challenge.challengeHash, {
      ...challenge,
    });
  }

  async consume(challengeHash: string, at: Date): Promise<WebAuthnLoginChallengeRow | null> {
    const row = this.byHash.get(challengeHash);
    if (!row) return null;
    if (row.expiresAt.getTime() <= at.getTime()) {
      this.byHash.delete(challengeHash);
      return null;
    }
    this.byHash.delete(challengeHash);
    return row;
  }

  async cleanup(at: Date): Promise<void> {
    for (const [hash, row] of this.byHash.entries()) {
      if (row.expiresAt.getTime() <= at.getTime()) {
        this.byHash.delete(hash);
      }
    }
  }
}

export class InMemoryWebAuthnCredentialsRepository implements WebAuthnCredentialsRepository {
  private readonly byId = new Map<string, WebAuthnCredentialRow>();
  private readonly order: string[] = [];

  async create(credential: NewWebAuthnCredential): Promise<WebAuthnCredentialRow> {
    const row: WebAuthnCredentialRow = {
      id: credential.id,
      userId: credential.userId,
      publicKey: credential.publicKey,
      signCount: credential.signCount,
      transports: credential.transports,
      name: credential.name,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    const key = credential.id.toString('hex');
    this.byId.set(key, row);
    this.order.push(key);
    return row;
  }

  async findByCredentialId(id: Buffer): Promise<WebAuthnCredentialRow | null> {
    return this.byId.get(id.toString('hex')) ?? null;
  }

  async listForUser(userId: string): Promise<WebAuthnCredentialRow[]> {
    return this.order
      .map(k => this.byId.get(k)!)
      .filter(c => c.userId === userId);
  }

  async updateSignCount(id: Buffer, signCount: number, at: Date): Promise<void> {
    const key = id.toString('hex');
    const row = this.byId.get(key);
    if (!row || (row.signCount !== 0 && signCount <= row.signCount)) {
      throw new Error('ConcurrentAssertionError');
    }
    this.byId.set(key, { ...row, signCount, lastUsedAt: at });
  }

  async delete(id: Buffer): Promise<void> {
    const key = id.toString('hex');
    this.byId.delete(key);
    const idx = this.order.indexOf(key);
    if (idx !== -1) this.order.splice(idx, 1);
  }

  async countForUser(userId: string): Promise<number> {
    return this.order
      .map(k => this.byId.get(k)!)
      .filter(c => c.userId === userId).length;
  }
}

/** A bundle of in-memory repositories plus the concrete audit repo for tests. */
import { InMemoryStudiesRepository } from '@chess-platform/studies';

export interface InMemoryRepositories extends Repositories {
  /** Shared event log so local API and realtime authority can use one source of truth. */
  readonly events: InMemoryEventStore;
  readonly users: InMemoryUsersRepository;
  readonly sessions: InMemorySessionsRepository;
  readonly ratings: InMemoryRatingsRepository;
  readonly games: InMemoryGamesRepository;
  readonly seeks: InMemorySeeksRepository;
  readonly audit: InMemoryAuditRepository;
  readonly tournaments: InMemoryTournamentsRepository;
  readonly identityTokens: InMemoryIdentityTokensRepository;
  readonly webauthnLoginChallenges: InMemoryWebAuthnLoginChallengesRepository;
  readonly webauthnCredentials: InMemoryWebAuthnCredentialsRepository;
  readonly seekAcceptor: InMemorySeekAcceptor;
  readonly gameStarter: InMemoryGameStarter;
  readonly antiCheat: InMemoryAntiCheatReportRepository;
  readonly botReports: InMemoryBotBehaviorReportRepository;
  readonly studies: InMemoryStudiesRepository;
  readonly learning: InMemoryLearningRepository;
  readonly studyPartner: InMemoryStudyPartnerRepository;
}

/** Construct a fresh set of in-memory repositories sharing a clock. */
export function createInMemoryRepositories(clock: Clock = systemClock): InMemoryRepositories {
  const games = new InMemoryGamesRepository();
  const users = new InMemoryUsersRepository(clock);
  const seeks = new InMemorySeeksRepository(clock, games, users);
  const events = new InMemoryEventStore(() => clock.now());
  
  return {
    events,
    users,
    sessions: new InMemorySessionsRepository(clock),
    ratings: new InMemoryRatingsRepository(clock),
    games,
    seeks,
    audit: new InMemoryAuditRepository(),
    tournaments: new InMemoryTournamentsRepository(),
    identityTokens: new InMemoryIdentityTokensRepository(users),
    webauthnLoginChallenges: new InMemoryWebAuthnLoginChallengesRepository(),
    webauthnCredentials: new InMemoryWebAuthnCredentialsRepository(),
    seekAcceptor: new InMemorySeekAcceptor(seeks, events, games, clock),
    gameStarter: new InMemoryGameStarter(events, games),
    antiCheat: new InMemoryAntiCheatReportRepository(),
    botReports: new InMemoryBotBehaviorReportRepository(),
    studies: new InMemoryStudiesRepository(),
    learning: new InMemoryLearningRepository(),
    studyPartner: new InMemoryStudyPartnerRepository(),
  };
}
