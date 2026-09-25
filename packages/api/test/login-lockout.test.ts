/**
 * Audit P1-1: login throttling must not become an account-lockout lever.
 *
 * The login route used to charge a per-handle bucket on every attempt, before the password was
 * checked. Anyone who knew a handle could spend that bucket with wrong passwords and keep its owner
 * out for the whole window, from one address, forever. `/v1/auth/webauthn/login/options` had the
 * same shape: a per-handle bucket charged for merely asking for a challenge.
 *
 * The policy these tests hold:
 *
 * - Per-IP admission is charged on every attempt, before any credential work, as before.
 * - Failed password attempts are counted per handle *and source address*. A slot is reserved at
 *   admission, so concurrent attempts cannot overshoot, and handed back when the password is right.
 * - There is no account-wide pre-authentication bucket. Anything a remote third party can fill is
 *   a lever to refuse the owner's correct password, however many addresses filling it takes.
 * - Passkey login options are limited per IP only.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { ManualClock } from '../src/ports/clock';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import { JsonLogger } from '../src/ports/logger';
import { startHarness, verifyEmail, type Harness } from './helpers';

const MINUTE = 60_000;
const PASSWORD = 'correct-horse-battery';
const VICTIM_IP = '198.51.100.10';
const ATTACKER_IP = '203.0.113.66';

async function register(h: Harness, handle: string): Promise<void> {
  const res = await h.json('POST', '/v1/auth/register', {
    body: { handle, password: PASSWORD, email: `${handle}@example.test` },
    headers: { 'x-forwarded-for': `192.0.2.${handle.length}` },
  });
  assert.equal(res.status, 201, `register ${handle}`);
  await verifyEmail(h, `${handle}@example.test`);
}

function login(h: Harness, handle: string, password: string, ip: string) {
  return h.json('POST', '/v1/auth/login', {
    body: { handle, password },
    headers: { 'x-forwarded-for': ip },
  });
}

describe('password login throttling cannot lock an account out', () => {
  test('an attacker exhausting their budget for a handle does not refuse its owner', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      await register(h, 'alice');
      for (let i = 0; i < DEFAULT_RATE_LIMIT.login.perHandleIp.maxRequests; i++) {
        assert.equal((await login(h, 'alice', 'wrong', ATTACKER_IP)).status, 401, `guess ${i}`);
      }
      assert.equal((await login(h, 'alice', 'wrong', ATTACKER_IP)).status, 429, 'attacker is stopped');
      assert.equal((await login(h, 'alice', PASSWORD, VICTIM_IP)).status, 200, 'owner still gets in');
    } finally {
      await h.close();
    }
  });

  /**
   * The distributed form of the attack. Every source spends its whole per-handle budget and is then
   * refused, and together they pass the account-wide threshold — which refuses no one. The owner,
   * from a clean address, is asked for a second proof instead: the code emailed to their verified
   * address, which no number of attacker addresses can read. Before this, a hard account-wide cap
   * let ten addresses refuse the owner's correct password for the rest of the window.
   */
  test('failures from many sources never refuse the owner, who signs in with the emailed code', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      await register(h, 'alice');
      const perSource = DEFAULT_RATE_LIMIT.login.perHandleIp.maxRequests;
      const sources = Array.from({ length: 25 }, (_, i) => `203.0.113.${i + 1}`);
      for (const ip of sources) {
        for (let i = 0; i < perSource; i++) {
          assert.notEqual((await login(h, 'alice', 'wrong', ip)).status, 429, `${ip} guess ${i}`);
        }
        assert.equal((await login(h, 'alice', 'wrong', ip)).status, 429, `${ip} is stopped`);
      }

      const challenged = await login(h, 'alice', PASSWORD, VICTIM_IP);
      assert.equal(challenged.status, 401);
      assert.equal(challenged.body.error.details.reason, 'step_up_required');
      const code = h.emailSender.sent.find((m) => m.type === 'login_step_up' && m.to === 'alice@example.test');
      assert.ok(code, 'the correct password emailed a code to the verified address');

      const owner = await h.json('POST', '/v1/auth/login', {
        body: { handle: 'alice', password: PASSWORD, code: code.token },
        headers: { 'x-forwarded-for': VICTIM_IP },
      });
      assert.equal(owner.status, 200, `the owner gets in after ${sources.length * perSource} failures`);
      assert.equal(typeof owner.body.tokens.accessToken, 'string');
    } finally {
      await h.close();
    }
  });

  test('a successful login spends no failure budget', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: {
          ...DEFAULT_RATE_LIMIT.login,
          perIp: { maxRequests: 100, windowMs: MINUTE },
          perHandleIp: { maxRequests: 2, windowMs: MINUTE },
        },
      },
    });
    try {
      await register(h, 'alice');
      for (let i = 0; i < 5; i++) {
        assert.equal((await login(h, 'alice', PASSWORD, VICTIM_IP)).status, 200, `success ${i}`);
      }
      // The failure budget still holds its full two slots.
      assert.equal((await login(h, 'alice', 'wrong', VICTIM_IP)).status, 401);
      assert.equal((await login(h, 'alice', 'wrong', VICTIM_IP)).status, 401);
      assert.equal((await login(h, 'alice', 'wrong', VICTIM_IP)).status, 429, 'and exactly two');
    } finally {
      await h.close();
    }
  });

  test('repeated failures from one source are blocked, and so is the owner from that source', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      await register(h, 'alice');
      const cap = DEFAULT_RATE_LIMIT.login.perHandleIp.maxRequests;
      for (let i = 0; i < cap; i++) {
        assert.equal((await login(h, 'alice', 'wrong', ATTACKER_IP)).status, 401);
      }
      const blocked = await login(h, 'alice', PASSWORD, ATTACKER_IP);
      assert.equal(blocked.status, 429, 'the right password does not reopen an exhausted source');
      assert.equal(
        blocked.headers.get('retry-after'),
        String(DEFAULT_RATE_LIMIT.login.perHandleIp.windowMs / 1000),
      );

      // The source budget is per handle: the same address may still try another account.
      assert.equal((await login(h, 'someone-else', 'wrong', ATTACKER_IP)).status, 401);
    } finally {
      await h.close();
    }
  });

  test('the per-IP bucket still charges every attempt, successful or not', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: { ...DEFAULT_RATE_LIMIT.login, perIp: { maxRequests: 3, windowMs: MINUTE } },
      },
    });
    try {
      await register(h, 'alice');
      assert.equal((await login(h, 'alice', PASSWORD, ATTACKER_IP)).status, 200);
      assert.equal((await login(h, 'ghost-a', 'wrong', ATTACKER_IP)).status, 401);
      assert.equal((await login(h, 'ghost-b', 'wrong', ATTACKER_IP)).status, 401);
      const blocked = await login(h, 'alice', PASSWORD, ATTACKER_IP);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '60');
      assert.equal((await login(h, 'alice', PASSWORD, VICTIM_IP)).status, 200, 'other addresses unaffected');
    } finally {
      await h.close();
    }
  });

  test('a refund that faults does not turn a successful login into an error', async () => {
    const records: Array<{ level: string; msg: string; buckets?: number }> = [];
    const logger = new JsonLogger({}, { level: 'warn', sink: (line) => records.push(JSON.parse(line)) });
    const faulty = new (class extends InMemoryRateLimiter {
      override refund(): void {
        throw new Error('database unavailable');
      }
    })(new ManualClock(0));
    const h = await startHarness({ trustProxy: true }, { rateLimiter: faulty, logger });
    try {
      await register(h, 'alice');
      const res = await login(h, 'alice', PASSWORD, VICTIM_IP);
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.tokens.accessToken, 'string');
      const warning = records.find((r) => r.msg.startsWith('rate limit refund failed'));
      assert.ok(warning, 'the fault is logged');
      assert.equal(warning.level, 'warn');
      assert.equal(warning.buckets, 2, 'the source budget and the account-wide count');
    } finally {
      await h.close();
    }
  });

  test('unknown and real handles are throttled identically', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      await register(h, 'alice');
      // Status, body and Retry-After for the cap plus one attempt. Each handle is driven from its
      // own address so the shared per-IP bucket is not what answers.
      const transcript = async (handle: string, ip: string) => {
        const seen: unknown[] = [];
        for (let i = 0; i <= DEFAULT_RATE_LIMIT.login.perHandleIp.maxRequests; i++) {
          const res = await login(h, handle, 'wrong', ip);
          // `requestId` is unique per request by design; everything else must match.
          const { requestId: _requestId, ...error } = res.body.error;
          seen.push([res.status, error, res.headers.get('retry-after')]);
        }
        return seen;
      };
      const real = await transcript('alice', ATTACKER_IP);
      const unknown = await transcript('nobody-here', VICTIM_IP);
      assert.equal((real.at(-1) as unknown[])[0], 429, 'the transcript reaches the throttle');
      assert.deepEqual(unknown, real);
    } finally {
      await h.close();
    }
  });

  test('concurrent failures from one source cannot overshoot its budget', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: {
          ...DEFAULT_RATE_LIMIT.login,
          perIp: { maxRequests: 100, windowMs: MINUTE },
          perHandleIp: { maxRequests: 3, windowMs: MINUTE },
        },
      },
    });
    try {
      await register(h, 'alice');
      // Every request is in flight before any password check finishes. A check-then-charge design
      // would admit all twenty; a reservation admits exactly three.
      const results = await Promise.all(
        Array.from({ length: 20 }, () => login(h, 'alice', 'wrong', ATTACKER_IP)),
      );
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      assert.deepEqual(statuses, [...Array(3).fill(401), ...Array(17).fill(429)]);
      assert.equal((await login(h, 'alice', PASSWORD, VICTIM_IP)).status, 200, 'owner unaffected');
    } finally {
      await h.close();
    }
  });
});

describe('passkey login options cannot lock an account out', () => {
  const webauthn = { rpId: 'localhost', origins: ['http://localhost:5173'] };

  test('requesting options for a victim handle does not refuse the victim', async () => {
    const h = await startHarness({ trustProxy: true, webauthn });
    try {
      await register(h, 'alice');
      for (let i = 0; i < 20; i++) {
        const res = await h.json('POST', '/v1/auth/webauthn/login/options', {
          body: { handle: 'alice' },
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        assert.equal(res.status, 200, `attacker request ${i}`);
      }
      const victim = await h.json('POST', '/v1/auth/webauthn/login/options', {
        body: { handle: 'alice' },
        headers: { 'x-forwarded-for': VICTIM_IP },
      });
      assert.equal(victim.status, 200);
      assert.equal(typeof victim.body.challenge, 'string');
    } finally {
      await h.close();
    }
  });

  test('options are still limited per IP', async () => {
    const h = await startHarness({ trustProxy: true, webauthn });
    try {
      const cap = DEFAULT_RATE_LIMIT.webauthnLogin.perIp.maxRequests;
      for (let i = 0; i < cap; i++) {
        const res = await h.json('POST', '/v1/auth/webauthn/login/options', {
          body: { handle: `h${i}` },
          headers: { 'x-forwarded-for': ATTACKER_IP },
        });
        assert.equal(res.status, 200);
      }
      const blocked = await h.json('POST', '/v1/auth/webauthn/login/options', {
        body: { handle: 'alice' },
        headers: { 'x-forwarded-for': ATTACKER_IP },
      });
      assert.equal(blocked.status, 429);
    } finally {
      await h.close();
    }
  });
});
