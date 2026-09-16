import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { migrate } from '../../src/pg/migrate';
import { PgIdentityTokensRepository, PgUsersRepository } from '../../src/pg/repositories';
import { deleteFixtureUsers, withSharedDatabase } from '../../src/test-support/fixtures';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/**
 * These ids are fixed on purpose — they keep the fixtures readable — but a fixed primary key is
 * only safe while the suite removes it again. Neither test used to, so a second run against the
 * same database re-inserted them and died on `users_pkey` (SQLSTATE 23505) before reaching an
 * assertion. The tokens themselves need no cleanup of their own: `identity_tokens.user_id`
 * cascades from `users`.
 */
const TOKEN_USER_ID = '01918300-0000-0000-0000-000000000000';
const RACE_USER_ID = '01918300-0000-0000-0000-000000000001';

describe('PgIdentityTokensRepository', { skip }, () => {
  it('creates and atomically consumes a token', async () => {
    await withSharedDatabase({
      cleanup: (pool) => deleteFixtureUsers(pool, [TOKEN_USER_ID]),
    }, async (pool) => {
      await migrate(pool, join(process.cwd(), 'migrations'));
      const users = new PgUsersRepository(pool);
      const tokens = new PgIdentityTokensRepository(pool);

      const user = await users.create({
        id: TOKEN_USER_ID,
        handle: 'tokenuser',
        email: 'tokenuser@example.com',
        emailHash: createHash('sha256').update('tokenuser@example.com').digest(),
      });

      const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');
      const expiresAt = new Date(Date.now() + 3600_000); // +1 hour

      await tokens.create({
        tokenHash,
        userId: user.id,
        kind: 'password_reset',
        expiresAt,
      });

      // 1st consume attempt: should succeed
      const at = new Date();
      const consumed = await tokens.consume(tokenHash, 'password_reset', at);
      assert.ok(consumed);
      assert.equal(consumed.userId, user.id);

      // 2nd consume attempt: should fail (already used)
      const consume2 = await tokens.consume(tokenHash, 'password_reset', new Date());
      assert.equal(consume2, null);

      // Attempt with wrong kind
      const tokenHash2 = createHash('sha256').update(randomBytes(32)).digest('hex');
      await tokens.create({
        tokenHash: tokenHash2,
        userId: user.id,
        kind: 'email_verify',
        expiresAt,
      });
      const consumeWrongKind = await tokens.consume(tokenHash2, 'password_reset', new Date());
      assert.equal(consumeWrongKind, null);

      // Attempt after expiry
      const tokenHash3 = createHash('sha256').update(randomBytes(32)).digest('hex');
      await tokens.create({
        tokenHash: tokenHash3,
        userId: user.id,
        kind: 'password_reset',
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      const consumeExpired = await tokens.consume(tokenHash3, 'password_reset', new Date());
      assert.equal(consumeExpired, null);

      // Concurrent resend requests serialize on the user row. Exactly one replacement remains
      // active, so the caller never ends up with two verification capabilities in circulation.
      const replacements = [
        createHash('sha256').update(randomBytes(32)).digest('hex'),
        createHash('sha256').update(randomBytes(32)).digest('hex'),
      ];
      await Promise.all(replacements.map((replacement) => tokens.replaceActive({
        tokenHash: replacement,
        userId: user.id,
        kind: 'email_verify',
        expiresAt,
      }, new Date())));
      const consumedReplacements = await Promise.all(replacements.map((replacement) =>
        tokens.consume(replacement, 'email_verify', new Date()),
      ));
      assert.equal(consumedReplacements.filter(Boolean).length, 1);
    });
  });

  it('serializes email verification against replacement issuance', async () => {
    await withSharedDatabase({
      cleanup: (pool) => deleteFixtureUsers(pool, [RACE_USER_ID]),
    }, async (pool) => {
      await migrate(pool, join(process.cwd(), 'migrations'));
      const users = new PgUsersRepository(pool);
      const tokens = new PgIdentityTokensRepository(pool);
      const user = await users.create({
        id: RACE_USER_ID,
        handle: 'verificationrace',
        email: 'verificationrace@example.com',
        emailHash: createHash('sha256').update('verificationrace@example.com').digest(),
      });
      const expiresAt = new Date(Date.now() + 3600_000);
      const original = createHash('sha256').update(randomBytes(32)).digest('hex');
      const replacement = createHash('sha256').update(randomBytes(32)).digest('hex');
      await tokens.replaceActiveEmailVerification({
        tokenHash: original,
        userId: user.id,
        expiresAt,
      }, new Date());

      const [verified, replaced] = await Promise.all([
        tokens.consumeEmailVerification(original, new Date()),
        tokens.replaceActiveEmailVerification({
          tokenHash: replacement,
          userId: user.id,
          expiresAt,
        }, new Date()),
      ]);

      assert.notEqual(verified === null, replaced === null, 'exactly one racing operation must win');
      const after = await users.findById(user.id);
      if (verified) {
        assert.equal(replaced, null);
        assert.ok(after?.emailVerifiedAt);
        assert.equal(await tokens.consumeEmailVerification(replacement, new Date()), null);
      } else {
        assert.ok(replaced);
        assert.equal(after?.emailVerifiedAt, null);
        assert.ok(await tokens.consumeEmailVerification(replacement, new Date()));
      }

      assert.equal(await tokens.replaceActiveEmailVerification({
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        userId: user.id,
        expiresAt,
      }, new Date()), null, 'verified users cannot receive another verification token');
    });
  });
});
