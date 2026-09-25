/** Password-reset issuance and delivery across two real PostgreSQL-backed API replicas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { migrate, PgIdentityTokensRepository, PgUsersRepository } from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { createPgApiServer } from '../src/bootstrap';
import { InMemoryEmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');

test('two API replicas issue and email one live reset token under distributed requests', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const userId = uuidv7();
    await new PgUsersRepository(pool).create({ id: userId, handle: `reset_${userId.slice(-12)}`, email: 'reset-race@example.test' });
    const sender = new InMemoryEmailSender();
    const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
    const replicas: { http: Server; url: string; drain: () => Promise<void>; shutdown: () => Promise<void> }[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const composed = createPgApiServer({ pool, logger, emailSender: sender, config: {
          accessTokenSecret: 'test-access-token-secret-0123456789abcdef', trustProxy: true,
        } });
        const listening = await listenOnFetchablePort((p, h) => composed.server.listen(p, h), '127.0.0.1');
        replicas.push({
          http: listening.server,
          url: `http://127.0.0.1:${listening.port}`,
          drain: () => composed.server.auth.drainBackground(),
          shutdown: composed.shutdownAnalysis,
        });
      }
      const post = async (replica: typeof replicas[number], path: string, body: unknown, ip: string) => {
        const response = await fetch(`${replica.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify(body),
        });
        return response.status;
      };
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(
        replicas[i % 2]!, '/v1/auth/password-reset/request',
        { handleOrEmail: i % 2 ? 'reset-race@example.test' : `reset_${userId.slice(-12)}` },
        `192.0.2.${i + 1}`,
      )));
      assert.deepEqual(new Set(results), new Set([202]));
      await Promise.all(replicas.map((replica) => replica.drain()));
      const live = await pool.query<{ token_hash: string }>(
        `SELECT token_hash FROM identity_tokens
         WHERE user_id = $1 AND kind = 'password_reset' AND used_at IS NULL AND expires_at > now()`,
        [userId],
      );
      assert.equal(live.rows.length, 1, 'user-row locking serialized both adapters');
      const resetEmails = sender.sent.filter((message) => message.type === 'password_reset');
      assert.equal(resetEmails.length, 1, 'a concurrent request cannot bypass the email bound');
      assert.equal(live.rows[0]!.token_hash,
        createHash('sha256').update(resetEmails[0]!.token).digest('hex'),
        'storage contains the hash of the emailed token');
      assert.notEqual(live.rows[0]!.token_hash, resetEmails[0]!.token, 'storage never contains the raw token');

      assert.equal(await post(replicas[1]!, '/v1/auth/password-reset/request',
        { handleOrEmail: 'reset-race@example.test' }, '198.51.100.10'), 202);
      await Promise.all(replicas.map((replica) => replica.drain()));
      assert.equal(sender.sent.filter((message) => message.type === 'password_reset').length, 1);
      assert.equal(await post(replicas[1]!, '/v1/auth/password-reset/confirm',
        { token: resetEmails[0]!.token, newPassword: 'newpassword123' }, '198.51.100.10'), 204);
      assert.equal(await post(replicas[0]!, '/v1/auth/password-reset/confirm',
        { token: resetEmails[0]!.token, newPassword: 'newpassword456' }, '198.51.100.11'), 401);

      assert.equal(await post(replicas[0]!, '/v1/auth/password-reset/request',
        { handleOrEmail: 'reset-race@example.test' }, '198.51.100.12'), 202);
      await Promise.all(replicas.map((replica) => replica.drain()));
      assert.equal(sender.sent.filter((message) => message.type === 'password_reset').length, 2,
        'consumption permits a later token');
      // Two independent repository objects saw the same durable state throughout.
      assert.equal(await new PgIdentityTokensRepository(pool).issuePasswordReset({
        userId, tokenHash: 'third-attempt', expiresAt: new Date(Date.now() + 60_000),
      }, new Date()), false);
    } finally {
      for (const replica of replicas) {
        await replica.drain();
        await closeServer(replica.http);
        await replica.shutdown();
      }
    }
  });
});

test('PostgreSQL discard removes only the failed token, never a later live one', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const userId = uuidv7();
    await new PgUsersRepository(pool).create({ id: userId, handle: `reset_${userId.slice(-12)}`, email: 'discard-race@example.test' });
    const first = new PgIdentityTokensRepository(pool);
    const second = new PgIdentityTokensRepository(pool);
    const at = new Date();
    const candidate = (tokenHash: string, now: Date) => ({
      userId, tokenHash, expiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    assert.equal(await first.issuePasswordReset(candidate('first', at), at), true);
    assert.equal(await second.issuePasswordReset(candidate('blocked', at), at), false);
    await first.discardPasswordReset('first');
    assert.equal(await second.consume('first', 'password_reset', at), null,
      'a definitive failed delivery removes that unused token');
    assert.equal(await second.issuePasswordReset(candidate('second', at), at), true);
    await first.discardPasswordReset('first');
    assert.ok(await first.consume('second', 'password_reset', at),
      'late cleanup cannot remove a successor token');

    const expired = new Date(at.getTime() + 31 * 60_000);
    assert.equal(await first.issuePasswordReset(candidate('expired-first', at), at), true);
    assert.equal(await second.issuePasswordReset(candidate('after-expiry', expired), expired), true,
      'an expired token does not block recovery');
    assert.equal(await first.consume('expired-first', 'password_reset', expired), null);
  });
});
