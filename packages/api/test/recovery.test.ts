import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { startHarness } from './helpers';
import type { EmailDeliveryResult, EmailSender } from '../src/ports/email';
import { JsonLogger } from '../src/ports/logger';

class FailingEmailSender implements EmailSender {
  readonly unsafeValues: string[] = [];

  sendPasswordReset(to: string, token: string): Promise<EmailDeliveryResult> {
    return this.reject(to, token, '/password-reset');
  }

  sendEmailVerification(to: string, token: string): Promise<EmailDeliveryResult> {
    return this.reject(to, token, '/email-verify');
  }

  sendLoginCode(to: string, code: string): Promise<EmailDeliveryResult> {
    return this.reject(to, code, '/');
  }

  private reject(to: string, token: string, route: string): Promise<EmailDeliveryResult> {
    const values = [to, token, `https://chess.example.com${route}#token=${token}`, 'provider-key'];
    this.unsafeValues.push(...values);
    return Promise.reject(new Error(`provider echoed ${values.join(' ')}`));
  }
}

class HangingResetSender implements EmailSender {
  sendPasswordReset(): Promise<EmailDeliveryResult> {
    return new Promise(() => undefined);
  }

  async sendEmailVerification(): Promise<EmailDeliveryResult> {
    return { outcome: 'success' };
  }

  async sendLoginCode(): Promise<EmailDeliveryResult> {
    return { outcome: 'success' };
  }
}

describe('Identity Recovery (API)', () => {
  it('handles password reset flow and email verification', async () => {
    const env = await startHarness();

    try {
      // 1. Register a user with email
      const registerRes = await env.json('POST', '/v1/auth/register', {
        body: {
          handle: 'recoverytester',
          password: 'oldpassword123',
          email: 'recoverytester@example.com',
        },
      });
      assert.equal(registerRes.status, 201);
      const authData = registerRes.body;
      assert.ok(authData.user);

      // We should receive an email verification email
      const sentEmails = env.emailSender.sent;
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, 'recoverytester@example.com');
      assert.equal(sentEmails[0].type, 'email_verify');

      const verifyToken = sentEmails[0].token;

      // Verify the email via endpoint
      const verifyRes = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: verifyToken },
      });
      assert.equal(verifyRes.status, 204);

      // Check DB that it's verified
      const userAfterVerify = await env.repos.users.findByHandle('recoverytester');
      assert.ok(userAfterVerify?.emailVerifiedAt);

      // Attempting to verify again with the same token should fail
      const verifyAgainRes = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: verifyToken },
      });
      assert.equal(verifyAgainRes.status, 401);

      // 2. Request Password Reset
      const resetReqRes = await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'recoverytester@example.com' },
      });
      assert.equal(resetReqRes.status, 202); // Anti-enumeration

      await env.auth.drainBackground();

      assert.equal(sentEmails.length, 2);
      assert.equal(sentEmails[1].to, 'recoverytester@example.com');
      assert.equal(sentEmails[1].type, 'password_reset');

      const resetToken = sentEmails[1].token;

      // 3. Confirm Password Reset
      const confirmRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: resetToken, newPassword: 'newpassword123' },
      });
      assert.equal(confirmRes.status, 204);
      // It should clear the refresh cookie
      assert.ok(confirmRes.headers.get('set-cookie')?.includes('gambit_refresh=;'));

      // 4. Try logging in with old password (should fail)
      const loginOldRes = await env.json('POST', '/v1/auth/login', {
        body: { handle: 'recoverytester', password: 'oldpassword123' },
      });
      assert.equal(loginOldRes.status, 401);

      // 5. Try logging in with new password (should succeed)
      const loginNewRes = await env.json('POST', '/v1/auth/login', {
        body: { handle: 'recoverytester', password: 'newpassword123' },
      });
      assert.equal(loginNewRes.status, 200);
      assert.equal(loginNewRes.body.user.handle, 'recoverytester');

      // 6. Confirm anti-enumeration on non-existent user
      const fakeResetRes = await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'nobody' },
      });
      assert.equal(fakeResetRes.status, 202); // Still 202
      assert.equal(sentEmails.length, 2); // No new email sent

    } finally {
      await env.close();
    }
  });

  it('rejects expired reset tokens and revokes pre-reset refresh tokens', async () => {
    const env = await startHarness();
    try {
      const reg = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'resetsec', password: 'oldpassword123', email: 'resetsec@example.com' },
      });
      assert.equal(reg.status, 201);
      const preResetRefreshToken = reg.body.tokens.refreshToken;

      // Expired token: request a reset, jump past the 30-minute TTL, confirm fails.
      await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'resetsec' },
      });
      await env.auth.drainBackground();
      const expiredToken = env.emailSender.sent.find((m) => m.type === 'password_reset')!.token;
      env.clock.advance(31 * 60 * 1000);
      const expiredRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: expiredToken, newPassword: 'newpassword456' },
      });
      assert.equal(expiredRes.status, 401);

      // Fresh token: the reset succeeds…
      await env.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'resetsec' },
      });
      await env.auth.drainBackground();
      const freshToken = env.emailSender.sent
        .filter((m) => m.type === 'password_reset')
        .at(-1)!.token;
      const okRes = await env.json('POST', '/v1/auth/password-reset/confirm', {
        body: { token: freshToken, newPassword: 'newpassword456' },
      });
      assert.equal(okRes.status, 204);

      // …and the refresh token issued BEFORE the reset is dead, not just the
      // password: an attacker holding a stolen session cannot survive a reset.
      const refreshRes = await env.json('POST', '/v1/auth/refresh', {
        body: { refreshToken: preResetRefreshToken },
      });
      assert.equal(refreshRes.status, 401, 'pre-reset refresh token must be revoked');
    } finally {
      await env.close();
    }
  });

  it('rejects registration reusing an existing email', async () => {
    const env = await startHarness();
    try {
      const first = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'emailowner', password: 'password123', email: 'owner@example.com' },
      });
      assert.equal(first.status, 201);
      const dup = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'emailthief', password: 'password123', email: 'owner@example.com' },
      });
      assert.equal(dup.status, 409);
    } finally {
      await env.close();
    }
  });

  it('rejects malformed registration email before creating an account', async () => {
    const env = await startHarness();
    try {
      const response = await env.json('POST', '/v1/auth/register', {
        body: { handle: 'invalidemail', password: 'password123', email: 'not-an-email' },
      });

      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'validation_failed');
      assert.equal(response.body.error.details.email, 'invalid format');
      assert.equal(await env.repos.users.findByHandle('invalidemail'), null);
      assert.equal(env.emailSender.sent.length, 0);
    } finally {
      await env.close();
    }
  });

  it('keeps registration successful and the account usable when verification delivery fails', async () => {
    const sender = new FailingEmailSender();
    const logs: string[] = [];
    const env = await startHarness({}, {
      emailSender: sender,
      logger: new JsonLogger({}, { level: 'debug', sink: (line) => logs.push(line) }),
    });
    try {
      const register = await env.json('POST', '/v1/auth/register', {
        body: {
          handle: 'deliveryfailure',
          password: 'password123',
          email: 'deliveryfailure@example.com',
        },
      });
      assert.equal(register.status, 201);
      assert.ok(await env.repos.users.findByHandle('deliveryfailure'));

      const resend = await env.json('POST', '/v1/auth/email/verification/request', {
        token: register.body.tokens.accessToken,
      });
      assert.equal(resend.status, 202);

      // The address never got its verification email, so the password alone cannot sign in; the
      // attempt re-sends verification, and that failed delivery must not leak into the logs either.
      const login = await env.json('POST', '/v1/auth/login', {
        body: { handle: 'deliveryfailure', password: 'password123' },
      });
      assert.equal(login.status, 403);
      assert.equal(login.body.error.details.reason, 'email_unverified');
      const rendered = logs.join('\n');
      for (const unsafe of sender.unsafeValues) assert.ok(!rendered.includes(unsafe));
    } finally {
      await env.close();
    }
  });

  it('makes reset responses indistinguishable under delivery failure and never waits on provider I/O', async () => {
    const failing = await startHarness({}, { emailSender: new FailingEmailSender() });
    try {
      await failing.json('POST', '/v1/auth/register', {
        body: { handle: 'resetfailure', password: 'password123', email: 'resetfailure@example.com' },
      });

      const existing = await failing.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'resetfailure@example.com' },
      });
      const missing = await failing.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'missing@example.com' },
      });

      assert.equal(existing.status, missing.status);
      assert.deepEqual(existing.body, missing.body);
      assert.equal(existing.headers.get('content-type'), missing.headers.get('content-type'));
    } finally {
      await failing.close();
    }

    const hanging = await startHarness({}, { emailSender: new HangingResetSender() });
    try {
      await hanging.repos.users.create({
        id: '01945e20-0000-7000-8000-000000000001',
        handle: 'hangreset',
        email: 'hangreset@example.com',
      });
      const response = await Promise.race([
        hanging.json('POST', '/v1/auth/password-reset/request', {
          body: { handleOrEmail: 'hangreset@example.com' },
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('password-reset response waited for email delivery')), 250);
        }),
      ]);
      assert.equal(response.status, 202);
    } finally {
      await hanging.close();
    }
  });

  it('lets an authenticated user replace and resend their verification token', async () => {
    const env = await startHarness();
    try {
      const register = await env.json('POST', '/v1/auth/register', {
        body: {
          handle: 'resendverify',
          password: 'password123',
          email: 'resendverify@example.com',
        },
      });
      const originalToken = env.emailSender.sent[0]!.token;

      const unauthenticated = await env.json('POST', '/v1/auth/email/verification/request');
      assert.equal(unauthenticated.status, 401);

      const resent = await env.json('POST', '/v1/auth/email/verification/request', {
        token: register.body.tokens.accessToken,
      });
      assert.equal(resent.status, 202);
      assert.equal(env.emailSender.sent.length, 2);
      const replacementToken = env.emailSender.sent[1]!.token;
      assert.notEqual(replacementToken, originalToken);

      const superseded = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: originalToken },
      });
      assert.equal(superseded.status, 401);
      const replacement = await env.json('POST', '/v1/auth/email/verify', {
        body: { token: replacementToken },
      });
      assert.equal(replacement.status, 204);

      const alreadyVerified = await env.json('POST', '/v1/auth/email/verification/request', {
        token: register.body.tokens.accessToken,
      });
      assert.equal(alreadyVerified.status, 202);
      assert.equal(env.emailSender.sent.length, 2);
    } finally {
      await env.close();
    }
  });

  it('does not issue a replacement when verification wins a concurrent resend', async () => {
    const env = await startHarness();
    try {
      const register = await env.json('POST', '/v1/auth/register', {
        body: {
          handle: 'verifyrace',
          password: 'password123',
          email: 'verifyrace@example.com',
        },
      });
      const originalToken = env.emailSender.sent[0]!.token;

      const [verification, resend] = await Promise.all([
        env.json('POST', '/v1/auth/email/verify', { body: { token: originalToken } }),
        env.json('POST', '/v1/auth/email/verification/request', {
          token: register.body.tokens.accessToken,
        }),
      ]);

      assert.equal(resend.status, 202);
      if (verification.status === 204) {
        assert.equal(env.emailSender.sent.length, 1);
        assert.ok((await env.repos.users.findByHandle('verifyrace'))?.emailVerifiedAt);
      } else {
        assert.equal(verification.status, 401);
        assert.equal(env.emailSender.sent.length, 2);
        const replacementToken = env.emailSender.sent[1]!.token;
        const replacement = await env.json('POST', '/v1/auth/email/verify', {
          body: { token: replacementToken },
        });
        assert.equal(replacement.status, 204);
      }
    } finally {
      await env.close();
    }
  });
});
