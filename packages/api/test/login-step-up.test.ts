/**
 * Login step-up (audit P1-1, ADR-0145).
 *
 * Past a handle's account-wide failure threshold, a password alone no longer signs in. Nothing is
 * refused — the owner adds the code emailed to their verified address, or uses a passkey — and
 * none of it tells an attacker whether the handle exists or whether a guessed password was right.
 *
 * These tests use a threshold of three failures so each one can reach step-up quickly.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { JsonLogger } from '../src/ports/logger';
import type { EmailDeliveryResult, EmailSender } from '../src/ports/email';
import { startHarness, verifyEmail, type Harness } from './helpers';

const MINUTE = 60_000;
const PASSWORD = 'correct-horse-battery';
const THRESHOLD = 3;
const OWNER_IP = '198.51.100.10';

async function harness(emailSender?: EmailSender): Promise<Harness> {
  return startHarness({
    trustProxy: true,
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      login: {
        perIp: { maxRequests: 1_000, windowMs: MINUTE },
        perHandleIp: { maxRequests: 1_000, windowMs: MINUTE },
        perHandleBeforeStepUp: { maxRequests: THRESHOLD, windowMs: 15 * MINUTE },
      },
    },
  }, emailSender ? { emailSender } : {});
}

async function register(h: Harness, handle: string, verify = true): Promise<void> {
  const res = await h.json('POST', '/v1/auth/register', {
    body: { handle, password: PASSWORD, email: `${handle}@example.test` },
  });
  assert.equal(res.status, 201, `register ${handle}`);
  if (verify) await verifyEmail(h, `${handle}@example.test`);
}

function login(h: Harness, handle: string, password: string, code?: string, ip = OWNER_IP) {
  return h.json('POST', '/v1/auth/login', {
    body: code === undefined ? { handle, password } : { handle, password, code },
    headers: { 'x-forwarded-for': ip },
  });
}

/** Spend the handle's account-wide budget from a spread of addresses. */
async function passThreshold(h: Harness, handle: string): Promise<void> {
  for (let i = 0; i < THRESHOLD; i++) {
    assert.equal((await login(h, handle, 'wrong-password', undefined, `203.0.113.${i}`)).status, 401);
  }
}

/**
 * Let background work finish. The public verification re-send answers before it looks anything up
 * (so its timing cannot tell accounts apart); against in-memory storage that work completes within
 * one turn of the event loop, so this waits for no timer.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function codesSentTo(h: Harness, handle: string): string[] {
  return h.emailSender.sent
    .filter((m) => m.type === 'login_step_up' && m.to === `${handle}@example.test`)
    .map((m) => m.token);
}

/** The externally visible outcome: everything but the per-request id. */
function outcome(res: { status: number; body: any }): unknown {
  const { requestId: _requestId, ...error } = res.body?.error ?? {};
  return [res.status, error];
}

describe('login step-up past the account-wide failure threshold', () => {
  test('below the threshold a password alone signs in', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      for (let i = 0; i < THRESHOLD - 1; i++) await login(h, 'alice', 'wrong-password');
      assert.equal((await login(h, 'alice', PASSWORD)).status, 200);
      assert.deepEqual(codesSentTo(h, 'alice'), []);
    } finally {
      await h.close();
    }
  });

  test('past it, the correct password gets a code by email and signs in only with it', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');

      const challenged = await login(h, 'alice', PASSWORD);
      assert.equal(challenged.status, 401);
      assert.equal(challenged.body.error.code, 'unauthorized');
      assert.equal(challenged.body.error.details.reason, 'step_up_required');
      const [code] = codesSentTo(h, 'alice');
      assert.match(code ?? '', /^\d{8}$/);

      const res = await login(h, 'alice', PASSWORD, code);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.handle, 'alice');
    } finally {
      await h.close();
    }
  });

  test('a wrong password gets the same answer and sends nothing, from any address', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      const right = await login(h, 'alice', PASSWORD);
      const sentAfterRight = codesSentTo(h, 'alice').length;

      for (let i = 0; i < 20; i++) {
        const wrong = await login(h, 'alice', `guess-${i}`, undefined, `192.0.2.${i}`);
        assert.deepEqual(outcome(wrong), outcome(right), 'a guess cannot tell right from wrong');
      }
      assert.equal(codesSentTo(h, 'alice').length, sentAfterRight, 'guesses never email the owner');
    } finally {
      await h.close();
    }
  });

  test('a code is single-use', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await login(h, 'alice', PASSWORD);
      const [code] = codesSentTo(h, 'alice');

      assert.equal((await login(h, 'alice', PASSWORD, code)).status, 200);
      const replay = await login(h, 'alice', PASSWORD, code);
      assert.equal(replay.status, 401);
      assert.equal(replay.body.error.details.reason, 'step_up_required');
    } finally {
      await h.close();
    }
  });

  test('a code does not work without the correct password', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await login(h, 'alice', PASSWORD);
      const [code] = codesSentTo(h, 'alice');

      const res = await login(h, 'alice', 'wrong-password', code);
      assert.equal(res.body.error.details.reason, 'step_up_required');
      assert.equal((await login(h, 'alice', PASSWORD, code)).status, 200, 'and the attempt did not spend it');
    } finally {
      await h.close();
    }
  });

  test('guesses without the password cannot burn the owner\'s code', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await login(h, 'alice', PASSWORD);
      const [code] = codesSentTo(h, 'alice');

      for (let i = 0; i < 20; i++) {
        await login(h, 'alice', 'wrong-password', String(i).padStart(8, '0'), `192.0.2.${i}`);
      }
      assert.equal((await login(h, 'alice', PASSWORD, code)).status, 200);
    } finally {
      await h.close();
    }
  });

  test('a code stops working after five wrong codes, and a fresh one follows after a cooldown', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await login(h, 'alice', PASSWORD);
      const [first] = codesSentTo(h, 'alice');
      const wrong = first === '00000000' ? '11111111' : '00000000';

      for (let i = 0; i < 5; i++) await login(h, 'alice', PASSWORD, wrong);
      assert.equal((await login(h, 'alice', PASSWORD, first)).status, 401, 'the exhausted code is dead');

      await login(h, 'alice', PASSWORD);
      assert.equal(codesSentTo(h, 'alice').length, 1, 'no replacement straight away');

      h.clock.advance(5 * MINUTE);
      await login(h, 'alice', PASSWORD);
      const codes = codesSentTo(h, 'alice');
      assert.equal(codes.length, 2, 'a new code replaces the exhausted one after the cooldown');
      assert.equal((await login(h, 'alice', PASSWORD, codes[1])).status, 200);
    } finally {
      await h.close();
    }
  });

  /**
   * Someone who already has the password can spend each code with wrong guesses; they still cannot
   * sign in without the mailbox. What they must not do is flood it: a spent code blocks a new one
   * for five minutes, so a fifteen-minute step-up window sends at most three or four emails.
   * (The owner's way out is a password reset, which the code email suggests.)
   */
  test('burning codes with the password cannot flood the inbox', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      for (let minute = 0; minute < 14; minute++) {
        assert.equal((await login(h, 'alice', PASSWORD)).status, 401, `still stepped up at ${minute}m`);
        for (let i = 0; i < 5; i++) await login(h, 'alice', PASSWORD, '99999999');
        h.clock.advance(MINUTE);
      }
      const sent = codesSentTo(h, 'alice').length;
      assert.ok(sent <= 3, `fourteen minutes of burning sent ${sent} codes`);
      assert.ok(sent >= 2, 'fresh codes still follow once the cooldown passes');
    } finally {
      await h.close();
    }
  });

  test('a live code is not replaced, so repeated requests send one email', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      for (let i = 0; i < 5; i++) await login(h, 'alice', PASSWORD);
      const codes = codesSentTo(h, 'alice');
      assert.equal(codes.length, 1);
      assert.equal((await login(h, 'alice', PASSWORD, codes[0])).status, 200, 'the first code still works');
    } finally {
      await h.close();
    }
  });

  test('an expired code is refused, and the next attempt sends a new one', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await login(h, 'alice', PASSWORD);
      const [first] = codesSentTo(h, 'alice');

      h.clock.advance(10 * MINUTE);
      assert.equal((await login(h, 'alice', PASSWORD, first)).status, 401);
      await login(h, 'alice', PASSWORD);
      const codes = codesSentTo(h, 'alice');
      assert.equal(codes.length, 2);
      assert.equal((await login(h, 'alice', PASSWORD, codes[1])).status, 200);
    } finally {
      await h.close();
    }
  });

  test('step-up lasts only for the failure window', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      assert.equal((await login(h, 'alice', PASSWORD)).status, 401);
      h.clock.advance(15 * MINUTE);
      assert.equal((await login(h, 'alice', PASSWORD)).status, 200);
    } finally {
      await h.close();
    }
  });

  test('an unknown handle and a real account are indistinguishable through step-up', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      await passThreshold(h, 'alice');
      await passThreshold(h, 'nobody-here');

      const real = [
        await login(h, 'alice', 'wrong-password'),
        await login(h, 'alice', 'wrong-password', '12345678'),
      ].map(outcome);
      const unknown = [
        await login(h, 'nobody-here', 'wrong-password'),
        await login(h, 'nobody-here', 'wrong-password', '12345678'),
      ].map(outcome);
      assert.deepEqual(unknown, real);
      assert.deepEqual(real[0], [401, {
        code: 'unauthorized',
        message: 'additional verification required',
        details: { reason: 'step_up_required' },
      }]);
    } finally {
      await h.close();
    }
  });

  test('a malformed code is a validation error before any bucket is touched', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      for (let i = 0; i < THRESHOLD + 2; i++) {
        assert.equal((await login(h, 'alice', 'wrong-password', 'abc')).status, 422);
      }
      // Had any of them counted as a failure, the handle would now be past its threshold.
      assert.equal((await login(h, 'alice', PASSWORD)).status, 200);
    } finally {
      await h.close();
    }
  });

  test('concurrent failures cannot overshoot the step-up threshold', async () => {
    const h = await harness();
    try {
      await register(h, 'alice');
      // Every request is in flight before any password check finishes. The count is taken at
      // admission, so exactly THRESHOLD of them are ordinary failures and the rest need step-up.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => login(h, 'alice', 'wrong-password', undefined, `203.0.113.${i}`)),
      );
      const reasons = results.map((r) => r.body.error.details?.reason ?? 'invalid_credentials').sort();
      assert.deepEqual(reasons, [
        ...Array(THRESHOLD).fill('invalid_credentials'),
        ...Array(20 - THRESHOLD).fill('step_up_required'),
      ]);
    } finally {
      await h.close();
    }
  });
});

describe('step-up email delivery', () => {
  /** Records every message, and reports sign-in codes as undelivered. */
  class FailingCodeSender implements EmailSender {
    readonly codes: string[] = [];
    async sendPasswordReset(): Promise<EmailDeliveryResult> { return { outcome: 'success' }; }
    async sendEmailVerification(): Promise<EmailDeliveryResult> { return { outcome: 'success' }; }
    async sendLoginCode(_to: string, code: string): Promise<EmailDeliveryResult> {
      this.codes.push(code);
      return { outcome: 'provider_error' };
    }
  }

  test('an undelivered code is dropped, so the next attempt sends a fresh one', async () => {
    const sender = new FailingCodeSender();
    const h = await harness(sender);
    try {
      // Verified directly: this sender does not record verification links.
      await h.json('POST', '/v1/auth/register', {
        body: { handle: 'alice', password: PASSWORD, email: 'alice@example.test' },
      });
      const user = await h.repos.users.findByHandle('alice');
      h.repos.users.markEmailVerifiedNow(user!.id, new Date(h.clock.now()));
      await passThreshold(h, 'alice');

      await login(h, 'alice', PASSWORD);
      await new Promise((resolve) => setImmediate(resolve));
      await login(h, 'alice', PASSWORD);
      assert.equal(sender.codes.length, 2, 'the failed code did not block a new one');
      assert.notEqual(sender.codes[0], sender.codes[1]);
    } finally {
      await h.close();
    }
  });
});

test('a failed clean-up of an undelivered code is logged, without identifying data', async () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({}, { level: 'warn', sink: (line) => records.push(JSON.parse(line)) });
  const failingCodes: EmailSender = {
    sendPasswordReset: async () => ({ outcome: 'success' }),
    sendEmailVerification: async () => ({ outcome: 'success' }),
    sendLoginCode: async () => ({ outcome: 'provider_error' }),
  };
  const h = await startHarness({
    trustProxy: true,
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      login: {
        perIp: { maxRequests: 1_000, windowMs: MINUTE },
        perHandleIp: { maxRequests: 1_000, windowMs: MINUTE },
        perHandleBeforeStepUp: { maxRequests: THRESHOLD, windowMs: 15 * MINUTE },
      },
    },
  }, { emailSender: failingCodes, logger });
  try {
    await h.json('POST', '/v1/auth/register', {
      body: { handle: 'alice', password: PASSWORD, email: 'alice@example.test' },
    });
    const user = await h.repos.users.findByHandle('alice');
    h.repos.users.markEmailVerifiedNow(user!.id, new Date(h.clock.now()));
    h.repos.identityTokens.discardLoginStepUp = async () => { throw new Error('storage unavailable'); };
    await passThreshold(h, 'alice');

    await login(h, 'alice', PASSWORD);
    await settle();
    const warning = records.find((r) => r['msg'] === 'discarding an undelivered email token failed');
    assert.ok(warning, 'the failure is logged');
    assert.equal(warning['purpose'], 'login_step_up');
    const text = JSON.stringify(warning);
    for (const secret of ['alice', user!.id]) assert.ok(!text.includes(secret), `no ${secret} in the log`);
  } finally {
    await h.close();
  }
});

describe('password accounts require a verified email', () => {
  test('registration without an email is refused', async () => {
    const h = await harness();
    try {
      const res = await h.json('POST', '/v1/auth/register', { body: { handle: 'alice', password: PASSWORD } });
      assert.equal(res.status, 422);
    } finally {
      await h.close();
    }
  });

  test('an unverified account cannot sign in with its password until it verifies', async () => {
    const h = await harness();
    try {
      await register(h, 'alice', false);
      h.clock.advance(10 * MINUTE);
      const before = h.emailSender.sent.filter((m) => m.type === 'email_verify').length;

      const res = await login(h, 'alice', PASSWORD);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.details.reason, 'email_unverified');
      assert.equal(
        h.emailSender.sent.filter((m) => m.type === 'email_verify').length,
        before + 1,
        'the attempt re-sends the verification email once the last one is ten minutes old',
      );

      assert.equal((await login(h, 'alice', 'wrong-password')).status, 401, 'a wrong password learns nothing');

      await verifyEmail(h, 'alice@example.test');
      assert.equal((await login(h, 'alice', PASSWORD)).status, 200);
    } finally {
      await h.close();
    }
  });

  test('repeated sign-ins on an unverified account re-send verification at most every ten minutes', async () => {
    const h = await harness();
    try {
      await register(h, 'alice', false);
      const count = () => h.emailSender.sent.filter((m) => m.type === 'email_verify').length;
      const before = count();
      // Each 403 counts as a failure, so stay under the harness threshold of three.
      for (let i = 0; i < 2; i++) assert.equal((await login(h, 'alice', PASSWORD)).status, 403);
      assert.equal(count(), before, 'registration just sent one, so nothing more yet');

      h.clock.advance(10 * MINUTE);
      assert.equal((await login(h, 'alice', PASSWORD)).status, 403);
      assert.equal(count(), before + 1, 'one re-send once the cooldown has passed');
    } finally {
      await h.close();
    }
  });

  test('the verification link can be re-sent without a session, identically for any handle', async () => {
    const h = await harness();
    try {
      await register(h, 'verified');
      await register(h, 'pending', false);
      h.clock.advance(10 * MINUTE);
      const links = (handle: string) =>
        h.emailSender.sent.filter((m) => m.type === 'email_verify' && m.to === `${handle}@example.test`).length;
      const before = { verified: links('verified'), pending: links('pending') };

      const answers = [];
      for (const handleOrEmail of ['verified', 'pending', 'nobody-here', 'pending@example.test']) {
        const res = await h.json('POST', '/v1/auth/email/verification/resend', { body: { handleOrEmail } });
        await settle();
        answers.push([res.status, res.body]);
      }
      assert.deepEqual(answers, Array(4).fill([202, undefined]), 'the same answer every time');
      assert.equal(links('verified'), before.verified, 'a verified address gets nothing');
      assert.equal(links('pending'), before.pending + 1, 'one new link, then the cooldown holds');
    } finally {
      await h.close();
    }
  });

  test('the re-send answers without waiting on the account lookup', async () => {
    const h = await harness();
    try {
      // A lookup that never finishes: if the route waited on it, this request would hang.
      const findByHandle = h.repos.users.findByHandle.bind(h.repos.users);
      h.repos.users.findByHandle = () => new Promise(() => undefined);
      const res = await h.json('POST', '/v1/auth/email/verification/resend', {
        body: { handleOrEmail: 'alice' },
      });
      assert.equal(res.status, 202);
      h.repos.users.findByHandle = findByHandle;
    } finally {
      await h.close();
    }
  });

  test('a verification email that fails to send does not hold up the next one', async () => {
    const tokens: string[] = [];
    const failing: EmailSender = {
      sendPasswordReset: async () => ({ outcome: 'success' }),
      sendEmailVerification: async (_to, token) => {
        tokens.push(token);
        return { outcome: 'provider_error' };
      },
      sendLoginCode: async () => ({ outcome: 'success' }),
    };
    const h = await harness(failing);
    try {
      await register(h, 'alice', false);
      await settle();
      await h.json('POST', '/v1/auth/email/verification/resend', { body: { handleOrEmail: 'alice' } });
      await settle();
      assert.equal(tokens.length, 2, 'the undelivered link did not count toward the cooldown');
    } finally {
      await h.close();
    }
  });

  test('asking for a new link never invalidates the earlier one', async () => {
    const h = await harness();
    try {
      await register(h, 'alice', false);
      const [original] = h.emailSender.sent.filter((m) => m.type === 'email_verify');
      h.clock.advance(10 * MINUTE);
      const resend = await h.json('POST', '/v1/auth/email/verification/resend', {
        body: { handleOrEmail: 'alice' },
      });
      assert.equal(resend.status, 202);
      await settle();
      assert.equal(h.emailSender.sent.filter((m) => m.type === 'email_verify').length, 2);

      const verified = await h.json('POST', '/v1/auth/email/verify', { body: { token: original!.token } });
      assert.equal(verified.status, 204, 'the original link still works');
    } finally {
      await h.close();
    }
  });

  /**
   * In step-up, a correct password on an unverified account gets only the uniform answer — saying
   * "verify your email" there would tell an attacker the guess was right. The owner's way back is
   * the session-less re-send, which no amount of failed sign-ins affects.
   */
  test('an unverified owner in step-up can get a new link, verify, and sign in with a code', async () => {
    const h = await harness();
    try {
      await register(h, 'alice', false);
      h.clock.advance(10 * MINUTE);
      await passThreshold(h, 'alice');
      assert.equal((await login(h, 'alice', PASSWORD)).body.error.details.reason, 'step_up_required');

      const resend = await h.json('POST', '/v1/auth/email/verification/resend', {
        body: { handleOrEmail: 'alice' },
      });
      assert.equal(resend.status, 202);
      await settle();
      await verifyEmail(h, 'alice@example.test');

      await login(h, 'alice', PASSWORD);
      const [code] = codesSentTo(h, 'alice');
      assert.ok(code, 'a verified address now receives the code');
      assert.equal((await login(h, 'alice', PASSWORD, code)).status, 200);
    } finally {
      await h.close();
    }
  });

  test('an unverified account past the threshold is answered like any other', async () => {
    const h = await harness();
    try {
      await register(h, 'alice', false);
      await passThreshold(h, 'alice');
      const res = await login(h, 'alice', PASSWORD);
      assert.equal(res.body.error.details.reason, 'step_up_required');
      assert.deepEqual(codesSentTo(h, 'alice'), [], 'no code goes to an unverified address');
    } finally {
      await h.close();
    }
  });
});
