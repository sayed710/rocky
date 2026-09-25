import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { startHarness } from './helpers';
import { ManualClock } from '../src/ports/clock';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import { DEFAULT_RATE_LIMIT } from '../src/config';

describe('InMemoryRateLimiter', () => {
  test('allows requests within limit and denies when exceeded', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const limit = { maxRequests: 2, windowMs: 10000 };

    const r1 = limiter.admit([{ key: 'k1', limit }]);
    assert.equal(r1.allowed, true);
    assert.equal(r1.retryAfterSeconds, 0);

    const r2 = limiter.admit([{ key: 'k1', limit }]);
    assert.equal(r2.allowed, true);

    const r3 = limiter.admit([{ key: 'k1', limit }]);
    assert.equal(r3.allowed, false);
    // windowStart=1000, now=1000, windowMs=10000 -> resetMs = 1000+10000-1000 = 10000ms -> 10s
    assert.equal(r3.retryAfterSeconds, 10);
  });

  test('resets window after time passes', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const limit = { maxRequests: 1, windowMs: 10000 };

    limiter.admit([{ key: 'k2', limit }]); // count=1
    assert.equal(limiter.admit([{ key: 'k2', limit }]).allowed, false);

    clock.advance(10000); // now=11000 (past 11000 boundary)

    const r3 = limiter.admit([{ key: 'k2', limit }]);
    assert.equal(r3.allowed, true, 'Allowed after window expires');
  });

  test('sweeps stale buckets so unique-key floods do not grow memory unbounded', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const limit = { maxRequests: 5, windowMs: 1000 };

    // Fill many distinct one-off keys — their buckets should not survive
    // past their own window once the sweep threshold is crossed.
    for (let i = 0; i < 500; i += 1) {
      limiter.admit([{ key: `flood-${i}`, limit }]);
    }
    assert.equal(limiter.size, 500, 'all 500 buckets tracked before the sweep threshold');

    // Move well past every flood bucket's window, then push the call count
    // past SWEEP_INTERVAL_CALLS (500) to trigger the opportunistic sweep.
    clock.advance(2000);
    for (let i = 0; i < 500; i += 1) {
      limiter.admit([{ key: `other-${i}`, limit }]);
    }

    // Only the 500 fresh 'other-*' buckets (created at the new time) should
    // remain — every stale 'flood-*' bucket must have been evicted. If they
    // hadn't been, size would be 1000 (500 stale + 500 fresh).
    assert.equal(limiter.size, 500, 'stale flood buckets were swept, only fresh buckets remain');
  });
});

describe('Auth Endpoints Rate Limiting Integration', () => {
  test('register endpoint is rate limited per IP', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      // DEFAULT_RATE_LIMIT.register.perIp is 5 requests.
      for (let i = 0; i < 5; i++) {
        const res = await h.json('POST', '/v1/auth/register', {
          body: { handle: `user${i}`, password: 'password123' },
          headers: { 'x-forwarded-for': '10.0.0.1' },
        });
        assert.equal(res.status, 201, `Request ${i} should be 201`);
      }

      // 6th request from same IP should be blocked
      const blocked = await h.json('POST', '/v1/auth/register', {
        body: { handle: 'user6', password: 'password123' },
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'rate_limited');
      assert.equal(blocked.headers.get('retry-after'), '3600'); // 60 mins

      // Different IP is allowed
      const ok = await h.json('POST', '/v1/auth/register', {
        body: { handle: 'user7', password: 'password123' },
        headers: { 'x-forwarded-for': '10.0.0.2' },
      });
      assert.equal(ok.status, 201);
    } finally {
      await h.close();
    }
  });

  test('login endpoint is rate limited per IP and per handle independently', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      // DEFAULT_RATE_LIMIT.login: perIp 10 attempts, perHandleIp 5 failures.
      await h.json('POST', '/v1/auth/register', { body: { handle: 'alice', password: 'password123' } });

      // Hit the per-source handle limit (5) from one address.
      for (let i = 0; i < 5; i++) {
        await h.json('POST', '/v1/auth/login', {
          body: { handle: 'alice', password: 'wrong' },
          headers: { 'x-forwarded-for': '192.168.1.1' },
        });
      }

      const blockedHandle = await h.json('POST', '/v1/auth/login', {
        body: { handle: 'alice', password: 'wrong' },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      });
      assert.equal(blockedHandle.status, 429, 'Blocked by handle limit');
      assert.equal(blockedHandle.headers.get('retry-after'), '900'); // 15 mins

      // Hit IP limit (10) for different handles
      for (let i = 0; i < 10; i++) {
        await h.json('POST', '/v1/auth/login', {
          body: { handle: `ghost${i}`, password: 'wrong' },
          headers: { 'x-forwarded-for': '10.10.10.1' }, // same IP, different handles
        });
      }

      const blockedIp = await h.json('POST', '/v1/auth/login', {
        body: { handle: 'ghost10', password: 'wrong' },
        headers: { 'x-forwarded-for': '10.10.10.1' },
      });
      assert.equal(blockedIp.status, 429, 'Blocked by IP limit');
      assert.equal(blockedIp.headers.get('retry-after'), '300'); // 5 mins
    } finally {
      await h.close();
    }
  });

  test('login handle limiting is case-insensitive like the identity store', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      await h.json('POST', '/v1/auth/register', {
        body: { handle: 'CaseUser', password: 'password123' },
      });
      // One address, five spellings: they must all land in the same per-handle-and-source budget.
      const spellings = ['caseuser', 'CASEUSER', 'CaseUser', 'cAsEuSeR', 'caseUser'];
      for (const handle of spellings) {
        await h.json('POST', '/v1/auth/login', {
          body: { handle, password: 'wrong' },
          headers: { 'x-forwarded-for': '198.51.100.8' },
        });
      }
      const blocked = await h.json('POST', '/v1/auth/login', {
        body: { handle: 'CASEuser', password: 'wrong' },
        headers: { 'x-forwarded-for': '198.51.100.8' },
      });
      assert.equal(blocked.status, 429);
    } finally {
      await h.close();
    }
  });

  test('refresh endpoint is rate limited per IP', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      const reg = await h.json('POST', '/v1/auth/register', { body: { handle: 'bob', password: 'password123' } });
      const refreshToken = reg.body.tokens.refreshToken;

      // refresh limit is 60/5min
      for (let i = 0; i < 60; i++) {
        await h.json('POST', '/v1/auth/refresh', {
          body: { refreshToken },
          headers: { 'x-forwarded-for': '172.16.0.1' },
        });
      }

      const blocked = await h.json('POST', '/v1/auth/refresh', {
        body: { refreshToken },
        headers: { 'x-forwarded-for': '172.16.0.1' },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '300');
    } finally {
      await h.close();
    }
  });

  test('password-reset/request endpoint is rate limited per IP and per target independently', async () => {
    const h = await startHarness({ trustProxy: true });
    try {
      // DEFAULT_RATE_LIMIT.passwordResetRequest.perTarget is 3, perIp is 5.
      
      // Hit target limit (3)
      for (let i = 0; i < 3; i++) {
        await h.json('POST', '/v1/auth/password-reset/request', {
          body: { handleOrEmail: 'targetuser' },
          headers: { 'x-forwarded-for': `192.168.2.${i}` },
        });
      }

      const blockedTarget = await h.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'targetuser' },
        headers: { 'x-forwarded-for': '192.168.2.100' },
      });
      assert.equal(blockedTarget.status, 429, 'Blocked by target limit');
      assert.equal(blockedTarget.headers.get('retry-after'), '3600'); // 60 mins

      // Hit IP limit (5) for different targets
      for (let i = 0; i < 5; i++) {
        await h.json('POST', '/v1/auth/password-reset/request', {
          body: { handleOrEmail: `target${i}` },
          headers: { 'x-forwarded-for': '10.20.20.1' },
        });
      }

      const blockedIp = await h.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'target10' },
        headers: { 'x-forwarded-for': '10.20.20.1' },
      });
      assert.equal(blockedIp.status, 429, 'Blocked by IP limit');
      assert.equal(blockedIp.headers.get('retry-after'), '3600'); // 60 mins
    } finally {
      await h.close();
    }
  });

  test('email verification resend is rate limited per authenticated user and IP atomically', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        emailVerificationRequest: {
          perUser: { maxRequests: 1, windowMs: 60_000 },
          perIp: { maxRequests: 2, windowMs: 60_000 },
        },
      },
    });
    try {
      const alice = await h.makeUser('verify-alice');
      const bob = await h.makeUser('verify-bob');
      const carol = await h.makeUser('verify-carol');
      const headers = { 'x-forwarded-for': '192.0.2.18' };

      assert.equal((await h.json('POST', '/v1/auth/email/verification/request', {
        token: alice.token,
        headers,
      })).status, 202);
      const aliceBlocked = await h.json('POST', '/v1/auth/email/verification/request', {
        token: alice.token,
        headers,
      });
      assert.equal(aliceBlocked.status, 429);
      assert.equal(aliceBlocked.headers.get('retry-after'), '60');
      assert.equal((await h.json('POST', '/v1/auth/email/verification/request', {
        token: bob.token,
        headers,
      })).status, 202, 'a user refusal must not spend the shared IP bucket');
      assert.equal((await h.json('POST', '/v1/auth/email/verification/request', {
        token: carol.token,
        headers,
      })).status, 429);
    } finally {
      await h.close();
    }
  });
});
