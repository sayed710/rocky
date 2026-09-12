/**
 * @packageDocumentation
 * Repository contracts and row types for the relational projections and identity
 * tables. These are driver-agnostic interfaces; the Postgres implementations live
 * in `./pg/repositories`. Domain enumerations are reused from the domain packages
 * so the DB layer and the engine can never drift.
 */

import type { Variant } from '@chess-platform/core';
import type { ResultString, Termination, TimeControl, GameEvent } from '@chess-platform/game';
/** Time-control speed bucket (mirror of `classifySpeed` in @chess-platform/game). */
export type Speed = 'ultrabullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** RBAC roles enforced at the gateway and re-checked in services. */
export type Role = 'user' | 'coach' | 'tournament_director' | 'moderator' | 'admin';

// --- Users / identity ------------------------------------------------------

export interface UserRow {
  readonly id: string;
  readonly handle: string;
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly emailHash: Buffer | null;
  readonly country: string | null;
  readonly flags: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly id: string;
  readonly handle: string;
  readonly email?: string | null;
  readonly emailVerifiedAt?: Date | null;
  readonly emailHash?: Buffer | null;
  readonly country?: string | null;
}

export interface UsersRepository {
  create(user: NewUser): Promise<UserRow>;
  /** Atomically create the user, password credential, and initial role. */
  createWithPasswordAndRole(user: NewUser, secretHash: string, role: Role): Promise<UserRow>;
  findById(id: string): Promise<UserRow | null>;
  /**
   * Resolve many users in one round trip. Rows come back in an unspecified order and ids that
   * name nobody are simply absent, so callers must key the result themselves rather than zip it
   * against the input.
   *
   * This exists for the GraphQL read layer (ADR-0073): a query that walks a list of edges asks for
   * one user per node, and without a multi-key read that is N queries no batching layer can fold
   * into fewer. Deduplication alone cannot bound it — 200 distinct followers are 200 distinct ids.
   */
  findByIds(ids: readonly string[]): Promise<readonly UserRow[]>;
  findByHandle(handle: string): Promise<UserRow | null>;
  findByEmail(email: string): Promise<UserRow | null>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  /** Upsert the argon2id-encoded password hash for a user. */
  setPassword(userId: string, secretHash: string): Promise<void>;
  getPasswordHash(userId: string): Promise<string | null>;
  addRole(userId: string, role: Role): Promise<void>;
  rolesOf(userId: string): Promise<Role[]>;
}

// --- Identity Tokens -------------------------------------------------------

export type IdentityTokenKind = 'password_reset' | 'email_verify' | 'webauthn_register';

export interface IdentityTokenRow {
  readonly tokenHash: string;
  readonly userId: string;
  readonly kind: IdentityTokenKind;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface NewIdentityToken {
  readonly tokenHash: string;
  readonly userId: string;
  readonly kind: IdentityTokenKind;
  readonly expiresAt: Date;
}

export interface IdentityTokensRepository {
  create(token: NewIdentityToken): Promise<IdentityTokenRow>;
  /** Atomically supersede every unused token of the same kind for this user. */
  replaceActive(token: NewIdentityToken, at: Date): Promise<IdentityTokenRow>;
  /** Atomically issue a replacement only while the owning user's email remains unverified. */
  replaceActiveEmailVerification(
    token: Omit<NewIdentityToken, 'kind'>,
    at: Date,
  ): Promise<IdentityTokenRow | null>;
  /** Atomically consume a token. Returns null if missing, expired, or already used. */
  consume(tokenHash: string, kind: IdentityTokenKind, at: Date): Promise<IdentityTokenRow | null>;
  /** Atomically consume an email token and mark its owning user verified. */
  consumeEmailVerification(tokenHash: string, at: Date): Promise<IdentityTokenRow | null>;
}

// --- WebAuthn Credentials ----------------------------------------------------

export interface WebAuthnLoginChallengeRow {
  readonly challengeHash: string;
  readonly userId: string | null;
  readonly expiresAt: Date;
}

export interface NewWebAuthnLoginChallenge {
  readonly challengeHash: string;
  readonly userId: string | null;
  readonly expiresAt: Date;
}

export interface WebAuthnLoginChallengesRepository {
  upsert(challenge: NewWebAuthnLoginChallenge): Promise<void>;
  consume(challengeHash: string, at: Date): Promise<WebAuthnLoginChallengeRow | null>;
  cleanup(at: Date): Promise<void>;
}

export interface WebAuthnCredentialRow {
  readonly id: Buffer;            // credential ID (byte array)
  readonly userId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: string[];
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface NewWebAuthnCredential {
  readonly id: Buffer;
  readonly userId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: string[];
  readonly name: string;
}

export interface WebAuthnCredentialsRepository {
  create(credential: NewWebAuthnCredential): Promise<WebAuthnCredentialRow>;
  findByCredentialId(id: Buffer): Promise<WebAuthnCredentialRow | null>;
  listForUser(userId: string): Promise<WebAuthnCredentialRow[]>;
  updateSignCount(id: Buffer, signCount: number, at: Date): Promise<void>;
  delete(id: Buffer): Promise<void>;
  countForUser(userId: string): Promise<number>;
}

// --- Sessions --------------------------------------------------------------

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedFrom: string | null;
  readonly lastSeenAt: Date | null;
  readonly lastIp: string | null;
  readonly lastUserAgent: string | null;
  /**
   * Request metadata captured when the session was created. Unlike the `last*` fields these are
   * always populated, so they are what a session list can actually identify a session by.
   */
  readonly createdIp: string | null;
  readonly createdUserAgent: string | null;
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly refreshHash: string;
  readonly expiresAt: Date;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly rotatedFrom?: string | null;
}

export type SessionRotationResult =
  | { readonly status: 'rotated'; readonly previous: SessionRow; readonly replacement: SessionRow }
  | { readonly status: 'missing' }
  | { readonly status: 'revoked'; readonly previous: SessionRow }
  | { readonly status: 'expired'; readonly previous: SessionRow };

export interface SessionsRepository {
  create(session: NewSession): Promise<SessionRow>;
  /** Return a non-revoked, non-expired session, or null. */
  findActiveById(id: string): Promise<SessionRow | null>;
  findByRefreshHash(refreshHash: string): Promise<SessionRow | null>;
  /** Atomically consume a refresh token and insert its replacement session. */
  rotate(refreshHash: string, replacement: NewSession, at: Date): Promise<SessionRotationResult>;
  /** Record activity (last_seen_at / last_ip / last_user_agent). */
  touch(id: string, at: Date, ip?: string | null, userAgent?: string | null): Promise<void>;
  /**
   * Revoke a session, atomically and idempotently.
   *
   * Returns `true` only for the call that performed the transition, so a caller that must act
   * exactly once per revocation (writing an audit record, say) can do so without a read-then-write
   * race between two concurrent revocations of the same session.
   */
  revoke(id: string, at: Date): Promise<boolean>;
  /** Every session ever created for the user, including revoked and expired rows. */
  listForUser(userId: string): Promise<SessionRow[]>;
}

// --- Ratings ---------------------------------------------------------------

export interface RatingRow {
  readonly userId: string;
  readonly variant: Variant;
  readonly rating: number;
  readonly rd: number;
  readonly vol: number;
  readonly updatedAt: Date;
}

export interface RatingsRepository {
  get(userId: string, variant: Variant): Promise<RatingRow | null>;
  upsert(row: {
    userId: string;
    variant: Variant;
    rating: number;
    rd: number;
    vol: number;
  }): Promise<void>;
  leaderboard(variant: Variant, limit: number): Promise<RatingRow[]>;
}

// --- Games projection ------------------------------------------------------

export interface GameSummaryRow {
  readonly id: string;
  readonly variant: Variant;
  readonly rated: boolean;
  readonly speed: Speed;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly result: ResultString | null;
  readonly termination: Termination | null;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface GameStart {
  readonly id: string;
  readonly variant: Variant;
  readonly rated: boolean;
  readonly speed: Speed;
  readonly whiteId: string | null;
  readonly blackId: string | null;
  readonly startedAt: Date;
}

export interface GameFinish {
  readonly result: ResultString;
  readonly termination: Termination;
  readonly plyCount: number;
  readonly lastSeq: number;
  readonly endedAt: Date;
}

export interface GamesRepository {
  start(game: GameStart): Promise<void>;
  updateProgress(id: string, plyCount: number, lastSeq: number): Promise<void>;
  finish(id: string, finish: GameFinish): Promise<void>;
  findById(id: string): Promise<GameSummaryRow | null>;
  recentForUser(userId: string, limit: number): Promise<GameSummaryRow[]>;
}

// --- Seeks / lobby ---------------------------------------------------------

/**
 * The creator's color preference for a seek. `random` (the default) lets the
 * pairing step assign sides; `white`/`black` request that specific side.
 */
export type SeekColor = 'white' | 'black' | 'random';

/**
 * Deterministic TTL for open seeks (10 minutes). An unaccepted seek past this age
 * expires, is omitted from open-seek listings, cannot be accepted, and is purged by cleanup.
 */
export const SEEK_TTL_MS = 10 * 60 * 1000;

/** Persisted seek plus its optional acceptance receipt and denormalized creator handle. */
export interface SeekRow {
  readonly id: string;
  readonly creatorId: string;
  /**
   * Human-readable handle of the seek creator. Resolved from user repository or database
   * join, ensuring opponent identity is available without relying on optional GraphQL.
   * Null when the creator is missing, unresolvable, or deleted.
   */
  readonly creatorHandle?: string | null;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  readonly createdAt: Date;
  readonly gameId: string | null;
  readonly acceptedAt: Date | null;
}

/** Values required to publish a new open seek before any acceptance receipt exists. */
export interface NewSeek {
  readonly id: string;
  readonly creatorId: string;
  /** Optional creator handle if known at seek creation time. */
  readonly creatorHandle?: string | null;
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  /** Defaults to `random` when omitted. */
  readonly color?: SeekColor;
  readonly minRating?: number | null;
  readonly maxRating?: number | null;
}

export interface SeeksRepository {
  create(seek: NewSeek): Promise<SeekRow>;
  findById(id: string): Promise<SeekRow | null>;
  /** Returns open seeks. If `creatorId` is provided, also includes that user's latest match receipt. */
  listOpen(limit: number, creatorId?: string): Promise<SeekRow[]>;
  /** Removes an open seek. Returns false when it is missing or has already been accepted. */
  remove(id: string): Promise<boolean>;
  cleanup(at: Date): Promise<void>;
}

export interface SeekAcceptor {
  /**
   * Atomically claims a seek and creates the corresponding game.
   * Both operations happen in a single transaction.
   * Returns the updated seek on success, or null if the seek is missing/already claimed.
   */
  accept(seekId: string, gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<SeekRow | null>;
}

/**
 * Starts a game that no seek produced (today: games against an engine bot).
 * Events and the summary row commit together, for the same reason SeekAcceptor
 * does it: a crash between them would leave an event log no game row points at.
 */
export interface GameStarter {
  /** Returns false when `gameId` already exists, so the caller can treat a retry as a no-op. */
  start(gameId: string, events: readonly GameEvent[], gameStart: GameStart): Promise<boolean>;
}


// --- Tournaments -----------------------------------------------------------

import type { TournamentSnapshot, ArenaSnapshot } from '@chess-platform/tournament';

export type TournamentAnySnapshot = TournamentSnapshot | ArenaSnapshot;

/**
 * Narrow a stored snapshot to the Arena variant. Both snapshot shapes carry a
 * `config.format` discriminant, so this lets callers branch on the format
 * without unsafe casts.
 */
export function isArenaSnapshot(snapshot: TournamentAnySnapshot): snapshot is ArenaSnapshot {
  return snapshot.config.format === 'arena';
}

export interface TournamentSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin' | 'swiss' | 'arena';
  readonly state: 'registration' | 'running' | 'finished';
  readonly participantCount: number;
}

export interface TournamentsRepository {
  save(snapshot: TournamentAnySnapshot, expectedVersion: number): Promise<void>;
  findById(id: string): Promise<{ snapshot: TournamentAnySnapshot; version: number } | null>;
  list(limit: number): Promise<TournamentSummaryRow[]>;
}


