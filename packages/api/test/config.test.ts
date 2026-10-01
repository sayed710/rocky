/**
 * Tests for `resolveConfig`: messaging and community admission budgets, CORS invariants,
 * refresh-cookie transport policy, and trusted proxy configuration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMIT, resolveConfig } from '../src/config.js';

const SECRET = 'x'.repeat(32);

describe('resolveConfig messaging admission', () => {
  it('uses explicit sender and shared-IP budgets', () => {
    const rateLimit = resolveConfig({ accessTokenSecret: SECRET }).rateLimit;
    assert.deepEqual(rateLimit.conversationCreation.perUser, { maxRequests: 20, windowMs: 300_000 });
    assert.deepEqual(rateLimit.conversationCreation.perIp, { maxRequests: 200, windowMs: 300_000 });
    assert.deepEqual(rateLimit.messageSend.perUser, { maxRequests: 30, windowMs: 60_000 });
    assert.deepEqual(rateLimit.messageSend.perIp, { maxRequests: 300, windowMs: 60_000 });
  });

  it('rejects missing, fractional, zero and oversized messaging budgets at startup', () => {
    for (const bad of [undefined, 0, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const perUser = bad === undefined ? undefined : { maxRequests: bad, windowMs: 60_000 };
      const rateLimit = {
        ...DEFAULT_RATE_LIMIT,
        messageSend: { ...DEFAULT_RATE_LIMIT.messageSend, perUser },
      } as unknown as typeof DEFAULT_RATE_LIMIT;
      assert.throws(() => resolveConfig({ accessTokenSecret: SECRET, rateLimit }),
        /rateLimit.messageSend.perUser/);
    }
    const rateLimit = {
      ...DEFAULT_RATE_LIMIT,
      conversationCreation: {
        ...DEFAULT_RATE_LIMIT.conversationCreation,
        perIp: { maxRequests: 200, windowMs: Number.NaN },
      },
    };
    assert.throws(() => resolveConfig({ accessTokenSecret: SECRET, rateLimit }),
      /rateLimit.conversationCreation.perIp/);
  });
});

describe('resolveConfig community admission', () => {
  const USER_AND_IP = ['perUser', 'perIp'] as const;
  const WRITE_BUDGETS: ReadonlyArray<readonly [keyof typeof DEFAULT_RATE_LIMIT, readonly string[]]> = [
    ['seekCreation', USER_AND_IP], ['conversationCreation', USER_AND_IP], ['messageSend', USER_AND_IP],
    ['socialInitiation', USER_AND_IP], ['teamCreation', USER_AND_IP], ['teamJoin', USER_AND_IP],
    ['forumThreadCreation', USER_AND_IP], ['forumPostCreation', USER_AND_IP], ['friendRequestRepeat', ['perPair']],
  ];

  it('defaults every community budget to its account limit with a 10-account address margin', () => {
    const rateLimit = resolveConfig({ accessTokenSecret: SECRET }).rateLimit;
    const FIVE_MIN = 300_000;
    assert.deepEqual(rateLimit.socialInitiation, {
      perUser: { maxRequests: 20, windowMs: FIVE_MIN }, perIp: { maxRequests: 200, windowMs: FIVE_MIN },
    });
    assert.deepEqual(rateLimit.teamCreation, {
      perUser: { maxRequests: 5, windowMs: 3_600_000 }, perIp: { maxRequests: 50, windowMs: 3_600_000 },
    });
    assert.deepEqual(rateLimit.teamJoin, {
      perUser: { maxRequests: 20, windowMs: FIVE_MIN }, perIp: { maxRequests: 200, windowMs: FIVE_MIN },
    });
    assert.deepEqual(rateLimit.forumThreadCreation, {
      perUser: { maxRequests: 20, windowMs: FIVE_MIN }, perIp: { maxRequests: 200, windowMs: FIVE_MIN },
    });
    assert.deepEqual(rateLimit.forumPostCreation, {
      perUser: { maxRequests: 30, windowMs: 60_000 }, perIp: { maxRequests: 300, windowMs: 60_000 },
    });
    assert.deepEqual(rateLimit.friendRequestRepeat, { perPair: { maxRequests: 3, windowMs: 86_400_000 } });
  });

  it('refuses at startup any write budget that is missing, malformed or out of range', () => {
    const badLimits: unknown[] = [
      undefined, null, 'x', {},
      { maxRequests: 0, windowMs: 60_000 }, { maxRequests: -1, windowMs: 60_000 },
      { maxRequests: 1.5, windowMs: 60_000 }, { maxRequests: Number.NaN, windowMs: 60_000 },
      { maxRequests: Number.POSITIVE_INFINITY, windowMs: 60_000 }, { maxRequests: 2 ** 31, windowMs: 60_000 },
      { maxRequests: '5', windowMs: 60_000 }, { maxRequests: 5 },
      { maxRequests: 5, windowMs: 0 }, { maxRequests: 5, windowMs: -60_000 }, { maxRequests: 5, windowMs: 0.5 },
      { maxRequests: 5, windowMs: Number.MAX_SAFE_INTEGER + 1 }, { maxRequests: 5, windowMs: '60000' },
    ];
    for (const [name, dimensions] of WRITE_BUDGETS) {
      for (const dimension of dimensions) {
        for (const bad of badLimits) {
          const rateLimit = {
            ...DEFAULT_RATE_LIMIT,
            [name]: { ...(DEFAULT_RATE_LIMIT[name] as object), [dimension]: bad },
          } as unknown as typeof DEFAULT_RATE_LIMIT;
          assert.throws(() => resolveConfig({ accessTokenSecret: SECRET, rateLimit }),
            new RegExp(`rateLimit\\.${name}\\.${dimension} must`), `${name}.${dimension} = ${JSON.stringify(bad)}`);
        }
      }
      for (const policy of [undefined, null, 7, 'policy', []]) {
        const rateLimit = { ...DEFAULT_RATE_LIMIT, [name]: policy } as unknown as typeof DEFAULT_RATE_LIMIT;
        assert.throws(() => resolveConfig({ accessTokenSecret: SECRET, rateLimit }),
          new RegExp(`rateLimit\\.${name}\\.${dimensions[0]} must`), `${name} = ${JSON.stringify(policy)}`);
      }
    }
  });

  it('accepts the defaults and a valid override, and keeps the disabled switch', () => {
    const rateLimit = {
      ...DEFAULT_RATE_LIMIT,
      enabled: false,
      forumPostCreation: { perUser: { maxRequests: 1, windowMs: 1 }, perIp: { maxRequests: 2_147_483_647, windowMs: 2_147_483_647 } },
    };
    const resolved = resolveConfig({ accessTokenSecret: SECRET, rateLimit }).rateLimit;
    assert.equal(resolved.enabled, false);
    assert.deepEqual(resolved.forumPostCreation, rateLimit.forumPostCreation);
  });
});

describe('resolveConfig CORS validation', () => {
  it('rejects a wildcard "*" in allowedOrigins', () => {
    assert.throws(
      () =>
        resolveConfig({
          accessTokenSecret: SECRET,
          cors: { allowedOrigins: ['*'], allowCredentials: false },
        }),
      /must not contain '\*'/,
    );
  });

  it('rejects allowCredentials with an empty allowlist', () => {
    assert.throws(
      () =>
        resolveConfig({
          accessTokenSecret: SECRET,
          cors: { allowedOrigins: [], allowCredentials: true },
        }),
      /allowCredentials is true but cors.allowedOrigins is empty/,
    );
  });

  it('accepts credentials with explicit origins', () => {
    const cfg = resolveConfig({
      accessTokenSecret: SECRET,
      cors: { allowedOrigins: ['https://app.example.com'], allowCredentials: true },
    });
    assert.equal(cfg.cors.allowCredentials, true);
    assert.deepEqual(cfg.cors.allowedOrigins, ['https://app.example.com']);
  });

  it('accepts the safe default (empty allowlist, no credentials)', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET });
    assert.deepEqual(cfg.cors.allowedOrigins, []);
    assert.equal(cfg.cors.allowCredentials, false);
    assert.equal(cfg.enableHsts, true);
  });
});

describe('resolveConfig cookieSecure', () => {
  it('defaults cookieSecure to true', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET }, {});
    assert.equal(cfg.cookieSecure, true);
  });

  it('accepts cookieSecure: false for local/dev over HTTP', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET, cookieSecure: false });
    assert.equal(cfg.cookieSecure, false);
  });

  it('keeps cookies Secure when local runtime configuration is missing', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET }, { NODE_ENV: 'development' });
    assert.equal(cfg.cookieSecure, true);
  });

  it('accepts an explicit insecure-cookie policy only in local development', () => {
    const cfg = resolveConfig(
      { accessTokenSecret: SECRET },
      { NODE_ENV: 'development', REFRESH_COOKIE_SECURE: 'false' },
    );
    assert.equal(cfg.cookieSecure, false);
  });

  it('accepts an explicit Secure cookie policy in production', () => {
    const cfg = resolveConfig(
      { accessTokenSecret: SECRET },
      { NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'true' },
    );
    assert.equal(cfg.cookieSecure, true);
  });

  it('rejects insecure-cookie environment configuration outside development', () => {
    assert.throws(
      () =>
        resolveConfig(
          { accessTokenSecret: SECRET },
          { NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'false' },
        ),
      /REFRESH_COOKIE_SECURE=false is allowed only when NODE_ENV=development/,
    );
  });

  it('rejects invalid cookie security configuration', () => {
    assert.throws(
      () =>
        resolveConfig(
          { accessTokenSecret: SECRET },
          { NODE_ENV: 'development', REFRESH_COOKIE_SECURE: 'off' },
        ),
      /REFRESH_COOKIE_SECURE must be either "true" or "false"/,
    );
  });
});

describe('resolveConfig trustProxy', () => {
  it('defaults trustProxy to false when input and env are omitted', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET }, {});
    assert.equal(cfg.trustProxy, false);
  });

  it('resolves TRUST_PROXY hop count from environment', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET }, { TRUST_PROXY: '2' });
    assert.equal(cfg.trustProxy, 2);
  });

  it('resolves TRUST_PROXY boolean from environment', () => {
    const cfgTrue = resolveConfig({ accessTokenSecret: SECRET }, { TRUST_PROXY: 'true' });
    assert.equal(cfgTrue.trustProxy, true);

    const cfgFalse = resolveConfig({ accessTokenSecret: SECRET }, { TRUST_PROXY: 'false' });
    assert.equal(cfgFalse.trustProxy, false);
  });

  it('preserves programmatic trustProxy override over environment variable', () => {
    const cfg = resolveConfig(
      { accessTokenSecret: SECRET, trustProxy: 1 },
      { TRUST_PROXY: '2' },
    );
    assert.equal(cfg.trustProxy, 1);

    const cfgDisabled = resolveConfig(
      { accessTokenSecret: SECRET, trustProxy: false },
      { TRUST_PROXY: '2' },
    );
    assert.equal(cfgDisabled.trustProxy, false);
  });

  it('rejects invalid programmatic trustProxy hop counts', () => {
    for (const trustProxy of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => resolveConfig({ accessTokenSecret: SECRET, trustProxy }, {}),
        /TRUST_PROXY must be/,
      );
    }
  });
});
