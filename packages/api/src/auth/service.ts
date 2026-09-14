/**
 * @packageDocumentation
 * The identity service: registration, login, stateless access tokens, and
 * rotating opaque refresh tokens with theft detection.
 *
 * Security properties enforced here:
 * - Passwords are only ever stored via the {@link PasswordHasher} (scrypt by
 *   default); plaintext never persists and never appears in logs or audit meta.
 * - Login does a hash comparison even when the handle is unknown, so response
 *   timing does not reveal whether an account exists.
 * - Refresh tokens are single-use. Each refresh rotates to a fresh token and
 *   revokes the presenting session (`rotated_from` links the chain). A replay
 *   inside the bounded grace window is rejected without chain revocation;
 *   replay outside it is treated as theft, revokes the user's session chains,
 *   and is audited.
 */

import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { DuplicateUserError } from '@chess-platform/persistence';
import type { WebAuthnCredentialRow } from '@chess-platform/persistence';
import { decodeFirst } from './cbor';
import { parseAuthenticatorData, extractPublicKey, verifyWebAuthnSignature } from './webauthn-crypto';
import type { ParsedAuthenticatorData } from './webauthn-crypto';
import type { NewSession, Role, SessionRow, UserRow } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Repositories } from '../deps';
import { generateRefreshToken, hashRefreshToken } from './refresh';
import type { AccessTokenService } from './tokens';
import type { PasswordHasher } from './password';
import type { EmailSender } from '../ports/email';

/** Per-request metadata attached to sessions and audit records. */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly traceId?: string | null;
}

/** The credential set returned to a client after auth. */
export interface TokenPair {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  readonly expiresIn: number;
  readonly refreshToken: string;
  /** Refresh-token absolute expiry (ISO 8601). */
  readonly refreshExpiresAt: string;
}

/** An authenticated principal with its granted roles. */
export interface AuthenticatedUser {
  readonly user: UserRow;
  readonly roles: readonly Role[];
}

/** Result of a successful auth flow. */
export interface AuthResult extends AuthenticatedUser {
  readonly tokens: TokenPair;
}

// A fixed decoy hash so an unknown handle still incurs a verify cost (anti-enumeration).
const DECOY_HASH =
  'scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Reused for unknown credentials so unauthenticated requests cannot force an
// expensive synchronous key generation on the event loop.
const DUMMY_WEBAUTHN_PUBLIC_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;

function strictBase64UrlDecode(input: unknown, name: string): Buffer {
  if (typeof input !== 'string') throw HttpError.validation(`${name} must be a string`);
  if (input.length > 8192) throw HttpError.validation(`${name} exceeds maximum length`);
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw HttpError.validation(`${name} contains invalid base64url characters`);
  const buf = Buffer.from(input, 'base64url');
  if (buf.toString('base64url') !== input) throw HttpError.validation(`${name} is not canonical base64url`);
  return buf;
}

/**
 * Every session rotated from `rootId`, directly or transitively — the rest of the login session it
 * belongs to. `rootId` itself is not included.
 *
 * A refresh retires the presented row and inserts a successor carrying `rotatedFrom`, so one login
 * is a chain of rows and only its newest member is live. Both callers need the whole chain rather
 * than the direct successor: after two refreshes the direct successor is revoked too.
 */
function descendantsOf(sessions: readonly SessionRow[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.rotatedFrom) continue;
    const children = childrenByParent.get(session.rotatedFrom) ?? [];
    children.push(session.id);
    childrenByParent.set(session.rotatedFrom, children);
  }

  const descendants = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (child !== rootId && !descendants.has(child)) {
        descendants.add(child);
        pending.push(child);
      }
    }
  }
  return descendants;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCollectedClientData(
  encodedClientData: unknown,
  expectedType: 'webauthn.create' | 'webauthn.get',
  allowedOrigins: readonly string[],
): { clientDataJSON: Buffer; challenge: string } {
  const clientDataJSON = strictBase64UrlDecode(encodedClientData, 'clientDataJSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw HttpError.validation('Invalid JSON in clientDataJSON');
  }

  if (!isRecord(parsed)) throw HttpError.validation('clientData must be an object');
  if (parsed.type !== expectedType) throw HttpError.validation('Invalid type in clientDataJSON');
  if (typeof parsed.challenge !== 'string') {
    throw HttpError.validation('clientData.challenge must be a string');
  }
  strictBase64UrlDecode(parsed.challenge, 'clientData.challenge');
  if (typeof parsed.origin !== 'string' || !allowedOrigins.includes(parsed.origin)) {
    throw HttpError.validation('Invalid origin');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'crossOrigin') && parsed.crossOrigin !== false) {
    throw HttpError.validation('Invalid crossOrigin');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'topOrigin')) {
    throw HttpError.validation('topOrigin is not allowed');
  }

  return { clientDataJSON, challenge: parsed.challenge };
}

/** Default grace window in milliseconds for near-simultaneous refreshes (e.g. multi-tab or network retries). */
export const DEFAULT_REFRESH_GRACE_PERIOD_MS = 10_000;
/** Maximum tolerated collision window; larger values would weaken rotated-token reuse detection. */
const MAX_REFRESH_GRACE_PERIOD_MS = 60_000;

export class AuthService {
  private readonly repos: Repositories;
  private readonly hasher: PasswordHasher;
  private readonly tokens: AccessTokenService;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly refreshTtlSec: number;
  private readonly emailSender: EmailSender;
  private readonly webauthn: { rpId: string; origins: readonly string[] };
  private readonly refreshGracePeriodMs: number;

  /** Compose authentication dependencies and enforce the bounded refresh-collision policy. */
  constructor(deps: {
    repos: Repositories;
    hasher: PasswordHasher;
    tokens: AccessTokenService;
    clock: Clock;
    ids: IdGenerator;
    refreshTtlSec: number;
    emailSender: EmailSender;
    webauthn: { rpId: string; origins: readonly string[] };
    refreshGracePeriodMs?: number;
  }) {
    this.repos = deps.repos;
    this.hasher = deps.hasher;
    this.tokens = deps.tokens;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.refreshTtlSec = deps.refreshTtlSec;
    this.emailSender = deps.emailSender;
    this.webauthn = deps.webauthn;
    const refreshGracePeriodMs = deps.refreshGracePeriodMs ?? DEFAULT_REFRESH_GRACE_PERIOD_MS;
    if (
      !Number.isFinite(refreshGracePeriodMs) ||
      refreshGracePeriodMs < 0 ||
      refreshGracePeriodMs > MAX_REFRESH_GRACE_PERIOD_MS
    ) {
      throw new RangeError(
        `refreshGracePeriodMs must be finite and between 0 and ${MAX_REFRESH_GRACE_PERIOD_MS}`,
      );
    }
    this.refreshGracePeriodMs = refreshGracePeriodMs;
  }

  /** Create an account, grant the base `user` role, and start a session. */
  async register(
    input: { handle: string; password: string; email?: string | null },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const existing = await this.repos.users.findByHandle(input.handle);
    if (existing) {
      throw HttpError.conflict('handle is already taken', { handle: 'taken' });
    }
    const secretHash = await this.hasher.hash(input.password);
    let user: UserRow;
    try {
      user = await this.repos.users.createWithPasswordAndRole({
        id: this.ids.next(),
        handle: input.handle,
        email: input.email ?? null,
        emailHash: input.email ? emailHash(input.email) : null,
      }, secretHash, 'user');
    } catch (error) {
      if (error instanceof DuplicateUserError || (await this.repos.users.findByHandle(input.handle))) {
        throw HttpError.conflict('handle is already taken', { handle: 'taken' });
      }
      throw error;
    }
    const roles: Role[] = ['user'];

    if (input.email) {
      await this.issueEmailVerification(user.id, input.email);
    }

    const tokens = await this.startSession(user, roles, meta);
    await this.audit(meta, user.id, 'auth.register', user.id);
    return { user, roles, tokens };
  }

  /** Verify credentials and start a session. */
  async login(
    input: { handle: string; password: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const user = await this.repos.users.findByHandle(input.handle);
    if (!user) {
      // Spend comparable time to a real verify so timing does not leak existence.
      await this.hasher.verify(input.password, DECOY_HASH);
      throw HttpError.unauthorized('invalid credentials');
    }
    const stored = await this.repos.users.getPasswordHash(user.id);
    const ok = stored ? await this.hasher.verify(input.password, stored) : false;
    if (!ok) {
      await this.audit(meta, user.id, 'auth.login.fail', user.id);
      throw HttpError.unauthorized('invalid credentials');
    }
    const roles = await this.repos.users.rolesOf(user.id);
    const prepared = this.prepareSession(user, roles, meta);
    await this.repos.sessions.create(prepared.session);
    // Password reset updates the hash before revoking the account's sessions. Re-read it after
    // creation so an old-password login that straddled that boundary cannot survive by inserting
    // its session just after the bulk revocation completed.
    if ((await this.repos.users.getPasswordHash(user.id)) !== stored) {
      await this.repos.sessions.revoke(prepared.session.id, new Date(this.clock.now()));
      await this.audit(meta, user.id, 'auth.login.fail', user.id);
      throw HttpError.unauthorized('invalid credentials');
    }
    await this.audit(meta, user.id, 'auth.login', user.id);
    return { user, roles, tokens: prepared.tokens };
  }

  /**
   * Reject a refresh presented against a revoked session, burning the account's other sessions only
   * when the presentation actually looks like theft. Never returns.
   *
   * A revoked row has two very different causes, and the response to them is not the same:
   *
   * - It was **rotated away** by a legitimate refresh, and a live successor is holding the account.
   *   Something is replaying a token the real client already exchanged, so a replay outside the
   *   bounded grace window burns the account — this is the reuse detection the rotation scheme
   *   exists for.
   *   To prevent false-positive account burns under near-simultaneous multi-tab refreshes or immediate
   *   network retries, presentations within `[0, refreshGracePeriodMs]` of rotation are tolerated
   *   (rejected with 401 without burning the account). Presentations with negative elapsed time
   *   (e.g. wall clock rollback or NTP skew) or elapsed time exceeding the grace window are strictly
   *   treated as illegitimate and revoke every active session chain for the account.
   * - It was **deliberately revoked**, by {@link revokeSession} or {@link logout}. Then the browser
   *   presenting it is simply the one the user just signed out, doing what any client does when its
   *   access token expires. Burning the account here would mean that revoking one session signs the
   *   user out of every *other* session within an access-token lifetime, which is precisely what the
   *   feature promises not to do.
   *
   * A live successor is what separates them, because {@link revokeSession} revokes the whole
   * rotation chain: after a deliberate revocation none of its descendants can still be refreshing.
   */
  private async rejectRevokedRefresh(
    session: SessionRow,
    now: number,
    meta: RequestMeta,
    isConcurrentRotation = false,
  ): Promise<never> {
    const sessions = await this.repos.sessions.listForUser(session.userId);
    // The whole descending chain, not just the direct successor: after two refreshes the successor
    // of the presented row has itself been rotated away, and only the newest row is still live.
    const descendants = descendantsOf(sessions, session.id);
    const rotatedAway = sessions.some(
      (s) => descendants.has(s.id) && !s.revokedAt && s.expiresAt.getTime() > now,
    );
    if (rotatedAway && !isConcurrentRotation) {
      const rotatedAt = session.revokedAt ? session.revokedAt.getTime() : 0;
      const elapsed = now - rotatedAt;
      // Legitimate concurrent/retry refresh can only happen forward within [0, gracePeriodMs].
      // A negative elapsed time (e.g. wall clock rollback/skew) must NOT extend or reopen the grace
      // window; any presentation outside [0, gracePeriodMs] triggers the reuse security response.
      if (elapsed < 0 || elapsed > this.refreshGracePeriodMs) {
        await this.revokeAllForUser(session.userId, now);
        await this.audit(meta, session.userId, 'auth.refresh.reuse', session.id);
      }
    }
    throw HttpError.unauthorized('refresh token has been revoked');
  }

  /**
   * Rotate a refresh token, detecting reuse of an already-rotated token.
   *
   * Concurrent state transitions are explicitly handled:
   * - A grace period applies to newly rotated sessions to tolerate benign races (e.g. multi-tab refresh).
   * - Presentations outside the grace window revoke every active session chain for the account.
   * - If a session was explicitly logged out, a concurrent refresh attempt correctly throws 401 without burning all sessions.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthResult> {
    const hash = hashRefreshToken(refreshToken);
    const session = await this.repos.sessions.findByRefreshHash(hash);
    if (!session) {
      await this.audit(meta, null, 'auth.refresh.unknown', null);
      throw HttpError.unauthorized('invalid refresh token');
    }
    const now = this.clock.now();
    if (session.revokedAt) {
      await this.rejectRevokedRefresh(session, now, meta);
    }
    if (session.expiresAt.getTime() <= now) {
      throw HttpError.unauthorized('refresh token has expired');
    }

    const user = await this.repos.users.findById(session.userId);
    if (!user) {
      await this.repos.sessions.revoke(session.id, new Date(now));
      throw HttpError.unauthorized('account no longer exists');
    }
    const roles = await this.repos.users.rolesOf(user.id);

    const prepared = this.prepareSession(user, roles, meta, session.id);
    const rotation = await this.repos.sessions.rotate(hash, prepared.session, new Date(now));
    if (rotation.status === 'missing') {
      throw HttpError.unauthorized('invalid refresh token');
    }
    if (rotation.status === 'expired') {
      throw HttpError.unauthorized('refresh token has expired');
    }
    if (rotation.status === 'revoked') {
      await this.rejectRevokedRefresh(rotation.previous, now, meta, true);
    }
    await this.audit(meta, user.id, 'auth.refresh', session.id);
    return { user, roles, tokens: prepared.tokens };
  }

  /**
   * Revoke the session behind a refresh token (idempotent). The session must
   * belong to `actingUserId`, so an authenticated caller cannot revoke another
   * user's session by submitting their token.
   */
  async logout(refreshToken: string, meta: RequestMeta, actingUserId: string): Promise<void> {
    const session = await this.repos.sessions.findByRefreshHash(hashRefreshToken(refreshToken));
    if (session && session.userId === actingUserId) {
      const revoked = await this.repos.sessions.revokeChainForUser(
        actingUserId,
        session.id,
        new Date(this.clock.now()),
      );
      if (!revoked) return;
      await this.audit(meta, session.userId, 'auth.logout', session.id);
    }
  }

  /** List a user's sessions (most recent first). */
  listSessions(userId: string): Promise<SessionRow[]> {
    return this.repos.sessions.listForUser(userId);
  }

  /**
   * Revoke one of the caller's own sessions by id.
   *
   * Ownership is enforced inside the repository's atomic chain operation: a root belonging to
   * another user is indistinguishable from a missing root and cannot be reached. Same shape as
   * {@link deletePasskey}, and for the same reason.
   *
   * A session id that does not belong to the caller is reported as `404`, not `403`: distinguishing
   * "not yours" from "does not exist" would turn this route into an oracle for whether an id is a
   * live session somewhere on the platform.
   *
   * Revoking an already-revoked session succeeds rather than erroring. The caller asked for that
   * session to be dead and it is dead, so there is nothing to report; this also makes simultaneous
   * revocations all succeed. The audit record is written by whichever atomic call transitioned at
   * least one row.
   *
   * What a user calls "a session" is a *chain* of rows, not one row: every {@link refresh} retires
   * the current row and inserts a successor linked by `rotatedFrom`. Revoking only the row the user
   * clicked would leave that browser signed in whenever a refresh landed during revocation. The
   * repository therefore serializes the recursive chain update with rotation for this account.
   *
   * What revocation does and does not reach is a consequence of the existing token design, not a
   * choice made here. A session row *is* the refresh capability, so revoking it stops that session
   * from ever minting another access token. Access tokens already issued are stateless HMACs that
   * `authenticate` verifies by signature alone (`server.ts`) without consulting this table, so an
   * outstanding one keeps working until it expires on its own — bounded by `accessTokenTtlSec`.
   * Immediate cutoff would require checking session state per request, which is a different
   * architecture from the one this endpoint was added to.
   */
  async revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
    const at = new Date(this.clock.now());
    const revoked = await this.repos.sessions.revokeChainForUser(userId, sessionId, at);
    if (revoked === null) throw HttpError.notFound('Session not found');
    if (revoked > 0) await this.audit(meta, userId, 'auth.session.revoke', sessionId);
  }

  /**
   * Initiate a password-reset flow for the account identified by handle or email.
   *
   * Always resolves successfully regardless of whether the handle or email exists
   * (anti-enumeration). If a matching account with a verified email is found, a
   * single-use reset token is issued (replacing any active prior token) and a
   * password-reset email is dispatched asynchronously in a fire-and-forget manner.
   * The audit record is written whether or not a matching user is found.
   */
  async requestPasswordReset(handleOrEmail: string, meta: RequestMeta): Promise<void> {
    const isEmail = handleOrEmail.includes('@');
    let user: UserRow | null = null;
    if (isEmail) {
      user = await this.repos.users.findByEmail(handleOrEmail);
    } else {
      user = await this.repos.users.findByHandle(handleOrEmail);
    }

    await this.audit(meta, user?.id ?? null, 'auth.password_reset.request', null);

    if (user && user.email) {
      const resetToken = randomBytes(32).toString('hex');
      const resetHash = createHash('sha256').update(resetToken).digest('hex');
      await this.repos.identityTokens.replaceActive({
        tokenHash: resetHash,
        userId: user.id,
        kind: 'password_reset',
        expiresAt: new Date(this.clock.now() + 30 * 60 * 1000), // 30 minutes
      }, new Date(this.clock.now()));
      this.dispatchEmail(() => this.emailSender.sendPasswordReset(user.email!, resetToken));
    }
  }

  async requestEmailVerification(userId: string, meta: RequestMeta): Promise<void> {
    const user = await this.repos.users.findById(userId);
    await this.audit(meta, user?.id ?? null, 'auth.email.verification.request', null);
    if (!user?.email) return;
    await this.issueEmailVerification(user.id, user.email);
  }

  private async issueEmailVerification(userId: string, email: string): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const issued = await this.repos.identityTokens.replaceActiveEmailVerification({
      tokenHash,
      userId,
      expiresAt: new Date(this.clock.now() + 24 * 60 * 60 * 1000), // 24 hours
    }, new Date(this.clock.now()));
    if (!issued) return;
    this.dispatchEmail(() => this.emailSender.sendEmailVerification(email, token));
  }

  /** Delivery is best-effort on the request path; provider outcomes belong to bounded metrics. */
  private dispatchEmail(send: () => Promise<unknown>): void {
    try {
      void send().catch(() => undefined);
    } catch {
      // Contain a sender that violates its async contract without exposing its error or payload.
    }
  }

  /**
   * Complete a password-reset flow: consume the single-use token, update the
   * password hash, and revoke all existing refresh sessions for the account so
   * that every device must re-authenticate with the new password.
   *
   * Throws `401` if the token is invalid, already consumed, or expired.
   */
  async confirmPasswordReset(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const consumed = await this.repos.identityTokens.consume(
      tokenHash,
      'password_reset',
      new Date(this.clock.now())
    );
    if (!consumed) {
      await this.audit(meta, null, 'auth.password_reset.confirm.fail', null);
      throw HttpError.unauthorized('invalid or expired reset token');
    }

    const secretHash = await this.hasher.hash(newPassword);
    await this.repos.users.setPassword(consumed.userId, secretHash);
    await this.revokeAllForUser(consumed.userId, this.clock.now());
    await this.audit(meta, consumed.userId, 'auth.password_reset.confirm', consumed.userId);
  }

  /**
   * Consume an email-verification token and mark the associated address as verified.
   *
   * Throws `401` if the token is invalid, already consumed, or expired.
   * Does not rotate sessions — the user remains signed in on all devices.
   */
  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const consumed = await this.repos.identityTokens.consumeEmailVerification(
      tokenHash,
      new Date(this.clock.now())
    );
    if (!consumed) {
      await this.audit(meta, null, 'auth.email.verify.fail', null);
      throw HttpError.unauthorized('invalid or expired verification token');
    }
    await this.audit(meta, consumed.userId, 'auth.email.verify', consumed.userId);
  }

  async listPasskeys(userId: string): Promise<WebAuthnCredentialRow[]> {
    return this.repos.webauthnCredentials.listForUser(userId);
  }

  async deletePasskey(userId: string, credentialIdHex: string, meta: RequestMeta): Promise<void> {
    const creds = await this.repos.webauthnCredentials.listForUser(userId);
    const cred = creds.find(c => c.id.toString('hex') === credentialIdHex);
    if (!cred) throw HttpError.notFound('Passkey not found');
    // Deleting the account's last passkey is only safe when a password remains —
    // otherwise the user locks themselves out with no credential to sign in.
    if (creds.length === 1) {
      const passwordHash = await this.repos.users.getPasswordHash(userId);
      if (!passwordHash) {
        throw HttpError.conflict('Cannot delete your only passkey without a password set');
      }
    }
    await this.repos.webauthnCredentials.delete(cred.id);
    await this.audit(meta, userId, 'auth.webauthn.delete', credentialIdHex);
  }

  async generateWebAuthnRegisterOptions(userId: string): Promise<any> {
    const user = await this.repos.users.findById(userId);
    if (!user) throw HttpError.notFound('account not found');

    const challenge = randomBytes(32);
    const challengeBase64 = challenge.toString('base64url');

    await this.repos.identityTokens.create({
      tokenHash: createHash('sha256').update(challengeBase64).digest('hex'),
      userId: user.id,
      kind: 'webauthn_register',
      expiresAt: new Date(this.clock.now() + 5 * 60 * 1000),
    });

    return {
      challenge: challengeBase64,
      rp: { name: 'Rookzen', id: this.webauthn.rpId },
      user: { id: user.id, name: user.handle, displayName: user.handle },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
    };
  }

  async verifyWebAuthnRegister(userId: string, response: any, meta: RequestMeta): Promise<any> {
    if (!response || typeof response !== 'object') throw HttpError.validation('response must be an object');
    if (!response.response || typeof response.response !== 'object') throw HttpError.validation('response.response must be an object');
    if (response.type !== 'public-key') throw HttpError.validation('response.type must be public-key');
    if (typeof response.id !== 'string') throw HttpError.validation('response.id must be a string');
    if (response.id !== response.rawId) throw HttpError.validation('id and rawId mismatch');

    const { challenge } = parseCollectedClientData(
      response.response.clientDataJSON,
      'webauthn.create',
      this.webauthn.origins,
    );

    const challengeHash = createHash('sha256').update(challenge).digest('hex');
    const consumed = await this.repos.identityTokens.consume(challengeHash, 'webauthn_register', new Date(this.clock.now()));

    if (!consumed || consumed.userId !== userId) throw HttpError.validation('Invalid or expired challenge');

    const attestationObject = strictBase64UrlDecode(response.response.attestationObject, 'attestationObject');

    let decodedAttestation: Map<unknown, unknown>;
    try {
      const decoded = decodeFirst(attestationObject);
      if (decoded.offset !== attestationObject.length) {
        throw HttpError.validation('Trailing bytes in attestationObject');
      }
      if (!(decoded.value instanceof Map)) {
        throw HttpError.validation('attestationObject is not a Map');
      }
      decodedAttestation = decoded.value;
    } catch (error: unknown) {
      if (error instanceof HttpError) throw error;
      throw HttpError.validation('Invalid CBOR in attestationObject');
    }

    if (decodedAttestation.get('fmt') !== 'none') throw HttpError.validation('Only none attestation is supported');
    const attStmt = decodedAttestation.get('attStmt');
    if (!(attStmt instanceof Map) || attStmt.size !== 0) throw HttpError.validation('attStmt must be empty Map for fmt none');

    const authData = decodedAttestation.get('authData');
    if (!authData || !Buffer.isBuffer(authData)) throw HttpError.validation('Missing authData');

    let parsedData: ParsedAuthenticatorData;
    try {
      parsedData = parseAuthenticatorData(authData);
    } catch (error: unknown) {
      throw HttpError.validation(errorMessage(error));
    }

    if (!parsedData.credentialId || !parsedData.publicKey) throw HttpError.validation('Missing credential data');

    const rawId = strictBase64UrlDecode(response.rawId, 'rawId');
    if (!parsedData.credentialId.equals(rawId)) throw HttpError.validation('rawId and credentialId mismatch');

    const expectedRpIdHash = createHash('sha256').update(this.webauthn.rpId).digest();
    if (!timingSafeEqual(parsedData.rpIdHash, expectedRpIdHash)) throw HttpError.validation('Invalid rpIdHash');
    if ((parsedData.flags & 0x01) === 0) throw HttpError.validation('User Present flag is not set');
    // We request userVerification:'required', so a passkey registered without a
    // verified user (biometric/PIN) must be rejected — not silently downgraded.
    if ((parsedData.flags & 0x04) === 0) throw HttpError.validation('User Verification flag is not set');

    const be = (parsedData.flags & 0x08) !== 0;
    const bs = (parsedData.flags & 0x10) !== 0;
    if (bs && !be) throw HttpError.validation('Invalid flags: BS=1 but BE=0');

    try {
      extractPublicKey(parsedData.publicKey);
    } catch (error: unknown) {
      throw HttpError.validation(errorMessage(error));
    }

    await this.repos.webauthnCredentials.create({
      id: parsedData.credentialId,
      userId,
      publicKey: parsedData.publicKey,
      signCount: parsedData.signCount,
      transports: [],
      name: 'Passkey',
    });

    await this.audit(meta, userId, 'auth.webauthn.register', parsedData.credentialId.toString('hex'));

    return {
      id: parsedData.credentialId.toString('base64url'),
      name: 'Passkey',
      createdAt: new Date(this.clock.now()).toISOString(),
    };
  }

  async generateWebAuthnLoginOptions(handle: string): Promise<any> {
    const normalizedHandle = handle.trim().toLowerCase();
    const user = await this.repos.users.findByHandle(normalizedHandle);

    let challengeBase64: string;
    let effectiveUserId: string | null = null;

    if (user) {
      effectiveUserId = user.id;
    }
    const challenge = randomBytes(32);
    challengeBase64 = challenge.toString('base64url');

    const expiresAt = new Date(this.clock.now() + 5 * 60 * 1000);

    // Occasional cleanup of expired challenges
    if (Math.random() < 0.1) {
      this.repos.webauthnLoginChallenges.cleanup(new Date(this.clock.now())).catch(() => {});
    }

    await this.repos.webauthnLoginChallenges.upsert({
      challengeHash: createHash('sha256').update(challengeBase64).digest('hex'),
      userId: effectiveUserId,
      expiresAt,
    });

    return {
      challenge: challengeBase64,
      timeout: 60000,
      rpId: this.webauthn.rpId,
      userVerification: 'required',
    };
  }

  async verifyWebAuthnLogin(response: any, meta: RequestMeta): Promise<AuthResult> {
    if (!response || typeof response !== 'object') throw HttpError.validation('response must be an object');
    if (!response.response || typeof response.response !== 'object') throw HttpError.validation('response.response must be an object');
    if (response.type !== 'public-key') throw HttpError.validation('response.type must be public-key');
    if (typeof response.id !== 'string') throw HttpError.validation('response.id must be a string');
    if (response.id !== response.rawId) throw HttpError.validation('id and rawId mismatch');

    const { clientDataJSON, challenge } = parseCollectedClientData(
      response.response.clientDataJSON,
      'webauthn.get',
      this.webauthn.origins,
    );

    const challengeHash = createHash('sha256').update(challenge).digest('hex');
    const consumed = await this.repos.webauthnLoginChallenges.consume(challengeHash, new Date(this.clock.now()));

    // Every authentication failure below funnels into a single unified path
    // and returns ONE fixed 401 payload — distinct messages or status codes
    // would hand an attacker an oracle (e.g. credential-exists vs bad-signature).
    let isFailure = false;

    if (!consumed) {
      isFailure = true;
    }

    const rawId = strictBase64UrlDecode(response.rawId, 'rawId');
    const credential = await this.repos.webauthnCredentials.findByCredentialId(rawId);

    if (!credential || (consumed && credential.userId !== consumed.userId)) {
      isFailure = true;
    }

    const authenticatorData = strictBase64UrlDecode(response.response.authenticatorData, 'authenticatorData');
    const signature = strictBase64UrlDecode(response.response.signature, 'signature');

    let parsedData: ParsedAuthenticatorData;
    try {
      parsedData = parseAuthenticatorData(authenticatorData);
    } catch (error: unknown) {
      throw HttpError.validation(errorMessage(error));
    }

    // Authentication decisions (rpIdHash, User Present, User Verification, and
    // the BE/BS flag invariant) must all funnel to ONE indistinguishable 401 —
    // throwing a 422 here would hand an attacker an oracle distinguishing which
    // check failed. Structural parse failures above are the only 4xx path.
    const expectedRpIdHash = createHash('sha256').update(this.webauthn.rpId).digest();
    if (parsedData.rpIdHash.length !== expectedRpIdHash.length
      || !timingSafeEqual(parsedData.rpIdHash, expectedRpIdHash)) {
      isFailure = true;
    }
    if ((parsedData.flags & 0x01) === 0) isFailure = true; // User Present
    if ((parsedData.flags & 0x04) === 0) isFailure = true; // User Verification (required)

    const be = (parsedData.flags & 0x08) !== 0;
    const bs = (parsedData.flags & 0x10) !== 0;
    if (bs && !be) isFailure = true; // BS=1 requires BE=1

    // A malformed or mismatched userHandle is an authentication failure, not a
    // distinct 4xx — fold it into the unified path so the response stays uniform.
    if (response.response.userHandle !== undefined && response.response.userHandle !== null) {
      if (typeof response.response.userHandle !== 'string'
        || (credential && response.response.userHandle !== credential.userId)) {
        isFailure = true;
      }
    }

    let publicKeyObj: KeyObject;
    try {
      publicKeyObj = credential ? extractPublicKey(credential.publicKey) : DUMMY_WEBAUTHN_PUBLIC_KEY;
    } catch (error: unknown) {
      throw HttpError.validation(errorMessage(error));
    }

    const isValid = verifyWebAuthnSignature(publicKeyObj, authenticatorData, clientDataJSON, signature);

    // A signature-counter regression on an otherwise-valid assertion means a
    // cloned authenticator or a replay. Fold it into the unified failure path
    // (same 401 payload) while still recording the distinct clone audit below.
    let cloneSuspected = false;
    if (
      isValid && !isFailure && consumed && consumed.userId !== null && credential
      && (parsedData.signCount !== 0 || credential.signCount !== 0)
      && parsedData.signCount <= credential.signCount
    ) {
      cloneSuspected = true;
      isFailure = true;
    }

    if (!isValid || isFailure || !consumed || consumed.userId === null) {
      if (credential) {
        await this.audit(
          meta,
          credential.userId,
          cloneSuspected ? 'auth.webauthn.clone_suspected' : 'auth.login.fail',
          credential.id.toString('hex'),
        );
      }
      throw HttpError.unauthorized('Invalid credentials');
    }

    if (!credential) throw new Error('Unreachable: credential must exist if not failed');

    try {
      await this.repos.webauthnCredentials.updateSignCount(credential.id, parsedData.signCount, new Date(this.clock.now()));
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'ConcurrentAssertionError') {
        throw HttpError.unauthorized('Suspected cloned authenticator or concurrent replay');
      }
      throw error;
    }

    const user = await this.repos.users.findById(credential.userId);
    if (!user) throw HttpError.unauthorized('account no longer exists');

    const roles = await this.repos.users.rolesOf(user.id);
    const tokens = await this.startSession(user, roles, meta);

    await this.audit(meta, user.id, 'auth.login', user.id);

    return { user, roles, tokens };
  }

  private async startSession(
    user: UserRow,
    roles: readonly Role[],
    meta: RequestMeta,
    rotatedFrom?: string,
  ): Promise<TokenPair> {
    const prepared = this.prepareSession(user, roles, meta, rotatedFrom);
    await this.repos.sessions.create(prepared.session);
    return prepared.tokens;
  }

  private prepareSession(
    user: UserRow,
    roles: readonly Role[],
    meta: RequestMeta,
    rotatedFrom?: string,
  ): { session: NewSession; tokens: TokenPair } {
    const now = this.clock.now();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(now + this.refreshTtlSec * 1000);
    const session: NewSession = {
      id: this.ids.next(),
      userId: user.id,
      refreshHash: hashRefreshToken(refreshToken),
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
      ...(rotatedFrom ? { rotatedFrom } : {}),
    };
    const { token, claims } = this.tokens.issue({ userId: user.id, handle: user.handle, roles });
    const tokens: TokenPair = {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: claims.exp - claims.iat,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
    return { session, tokens };
  }

  private async revokeAllForUser(userId: string, now: number): Promise<void> {
    await this.repos.sessions.revokeAllForUser(userId, new Date(now));
  }

  private async audit(
    meta: RequestMeta,
    actorId: string | null,
    action: string,
    target: string | null,
  ): Promise<void> {
    await this.repos.audit.record({
      actorId,
      action,
      target,
      requestId: meta.requestId,
      traceId: meta.traceId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      at: this.clock.now(),
    });
  }
}

/** SHA-256 of a normalized email, for privacy-preserving uniqueness/lookup. */
export function emailHash(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest();
}
