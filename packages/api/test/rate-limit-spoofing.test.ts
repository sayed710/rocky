import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { startHarness } from './helpers';

describe('Trusted Edge Contract: API Rate Limit Spoof Resistance', () => {
  test('client cannot bypass per-IP rate limiting by prepending spoofed IPs in X-Forwarded-For', async () => {
    // Harness with trustProxy enabled (1 proxy hop behind nginx).
    // In production, nginx appends $remote_addr to incoming X-Forwarded-For ($proxy_add_x_forwarded_for).
    // A client at real IP 198.51.100.1 sending forged XFF values results in header:
    // "spoofed-ip, 198.51.100.1"
    const h = await startHarness({ trustProxy: true });
    try {
      const realClientIp = '198.51.100.1';

      // DEFAULT_RATE_LIMIT.register.perIp is 5 requests per hour.
      // An attacker attempts 6 registrations from realClientIp, varying the spoofed prefix each time.
      for (let i = 0; i < 5; i++) {
        const spoofedPrefix = `203.0.113.${i + 1}`;
        const xffHeader = `${spoofedPrefix}, ${realClientIp}`;
        const res = await h.json('POST', '/v1/auth/register', {
          body: { handle: `spoofuser${i}`, password: 'password123' },
          headers: { 'x-forwarded-for': xffHeader },
        });
        assert.equal(res.status, 201, `Request ${i + 1} should be admitted (status 201)`);
      }

      // 6th request from the same real IP must be rate-limited (429),
      // even if the attacker invents a new spoofed prefix!
      const blocked = await h.json('POST', '/v1/auth/register', {
        body: { handle: 'spoofuser6', password: 'password123' },
        headers: { 'x-forwarded-for': `203.0.113.99, ${realClientIp}` },
      });

      assert.equal(
        blocked.status,
        429,
        `Expected request 6 to be rate limited (429) for real IP ${realClientIp}, but got status ${blocked.status} (body: ${JSON.stringify(blocked.body)})`,
      );
      assert.equal(blocked.body.error.code, 'rate_limited');
    } finally {
      await h.close();
    }
  });

  test('equivalent IPv6 spellings share one rate-limit identity', async () => {
    const h = await startHarness({ trustProxy: true });
    const spellings = [
      '2001:db8::1',
      '2001:0db8:0:0:0:0:0:1',
      '2001:DB8:0000:0000:0000:0000:0000:0001',
      '2001:db8:0::1',
      '2001:0db8::0001',
      '2001:db8:0:0::1',
    ];

    try {
      for (let i = 0; i < 5; i++) {
        const res = await h.json('POST', '/v1/auth/register', {
          body: { handle: `ipv6user${i}`, password: 'password123' },
          headers: { 'x-forwarded-for': spellings[i]! },
        });
        assert.equal(res.status, 201);
      }

      const blocked = await h.json('POST', '/v1/auth/register', {
        body: { handle: 'ipv6user5', password: 'password123' },
        headers: { 'x-forwarded-for': spellings[5]! },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'rate_limited');
    } finally {
      await h.close();
    }
  });
});
