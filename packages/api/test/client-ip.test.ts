import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  normalizeIp,
  parseForwardedFor,
  resolveTrustProxyEnv,
  resolveClientIp,
} from '../src/http/client-ip';

describe('client-ip: normalizeIp', () => {
  test('normalizes standard IPv4 addresses with whitespace trimming', () => {
    assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIp('  192.168.1.100  '), '192.168.1.100');
  });

  test('unmaps IPv4-mapped IPv6 addresses to pure IPv4', () => {
    assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(normalizeIp('::FFFF:10.0.0.1'), '10.0.0.1');
    assert.equal(normalizeIp('  ::ffff:127.0.0.1  '), '127.0.0.1');
  });

  test('normalizes standard and bracketed IPv6 addresses to lowercase', () => {
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
    assert.equal(normalizeIp('2001:DB8::ABCD'), '2001:db8::abcd');
    assert.equal(normalizeIp('::1'), '::1');
    assert.equal(normalizeIp('[::1]'), '::1');
  });

  test('canonicalizes equivalent IPv6 and IPv4-mapped IPv6 spellings', () => {
    assert.equal(normalizeIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(normalizeIp('0:0:0:0:0:ffff:c000:0201'), '192.0.2.1');
    assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(normalizeIp('FE80:0:0:0::1%eth0'), 'fe80::1%eth0');
  });

  test('returns null for empty, missing, or invalid IP strings', () => {
    assert.equal(normalizeIp(undefined), null);
    assert.equal(normalizeIp(null), null);
    assert.equal(normalizeIp(''), null);
    assert.equal(normalizeIp('   '), null);
    assert.equal(normalizeIp('invalid-host'), null);
    assert.equal(normalizeIp('999.999.999.999'), null);
    assert.equal(normalizeIp('1.2.3.4.5'), null);
  });
});

describe('client-ip: parseForwardedFor', () => {
  test('parses comma-separated values into trimmed array', () => {
    assert.deepEqual(parseForwardedFor('1.1.1.1, 2.2.2.2, 3.3.3.3'), ['1.1.1.1', '2.2.2.2', '3.3.3.3']);
    assert.deepEqual(parseForwardedFor('  1.1.1.1 ,  , 2.2.2.2  '), ['1.1.1.1', '2.2.2.2']);
  });

  test('handles single value and array header representations', () => {
    assert.deepEqual(parseForwardedFor('198.51.100.1'), ['198.51.100.1']);
    assert.deepEqual(parseForwardedFor(['1.1.1.1, 2.2.2.2', '3.3.3.3']), ['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  test('returns empty array for missing or empty header', () => {
    assert.deepEqual(parseForwardedFor(undefined), []);
    assert.deepEqual(parseForwardedFor(''), []);
    assert.deepEqual(parseForwardedFor('   '), []);
  });
});

describe('client-ip: resolveTrustProxyEnv', () => {
  test('resolves falsy values to false (0 hops)', () => {
    assert.equal(resolveTrustProxyEnv(undefined), false);
    assert.equal(resolveTrustProxyEnv(''), false);
    assert.equal(resolveTrustProxyEnv('false'), false);
    assert.equal(resolveTrustProxyEnv('0'), false);
  });

  test('resolves boolean true to true (1 hop)', () => {
    assert.equal(resolveTrustProxyEnv('true'), true);
    assert.equal(resolveTrustProxyEnv('TRUE'), true);
  });

  test('resolves non-negative integer strings to numeric hop counts', () => {
    assert.equal(resolveTrustProxyEnv('1'), 1);
    assert.equal(resolveTrustProxyEnv('2'), 2);
    assert.equal(resolveTrustProxyEnv('3'), 3);
  });

  test('throws on invalid or negative values to prevent unsafe startup', () => {
    assert.throws(() => resolveTrustProxyEnv('banana'), /TRUST_PROXY must be/);
    assert.throws(() => resolveTrustProxyEnv('-1'), /TRUST_PROXY must be/);
    assert.throws(() => resolveTrustProxyEnv('1.5'), /TRUST_PROXY must be/);
  });
});

describe('client-ip: resolveClientIp', () => {
  test('direct connection (trustProxy = false) uses socket address and ignores XFF', () => {
    const req = {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      socket: { remoteAddress: '198.51.100.77' },
    };
    assert.equal(resolveClientIp(req, false), '198.51.100.77');
    assert.equal(resolveClientIp(req, 0), '198.51.100.77');
  });

  test('single proxy hop (trustProxy = true or 1) takes 1st IP from right (nginx appended client IP)', () => {
    // Normal proxied request: client 203.0.113.1 -> nginx -> app
    const reqNormal = {
      headers: { 'x-forwarded-for': '203.0.113.1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(resolveClientIp(reqNormal, true), '203.0.113.1');
    assert.equal(resolveClientIp(reqNormal, 1), '203.0.113.1');

    // Spoofed request: client sent forged XFF "1.2.3.4", nginx appended client IP "203.0.113.1"
    const reqSpoofed = {
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(resolveClientIp(reqSpoofed, true), '203.0.113.1');
    assert.equal(resolveClientIp(reqSpoofed, 1), '203.0.113.1');
  });

  test('two proxy hops (trustProxy = 2) takes 2nd IP from right (ingress -> web nginx -> app)', () => {
    // Client 203.0.113.1 -> Ingress -> web nginx (10.244.0.5) -> app
    const reqTwoHops = {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.244.0.5' },
      socket: { remoteAddress: '10.244.0.10' },
    };
    assert.equal(resolveClientIp(reqTwoHops, 2), '203.0.113.1');

    // With client spoofing: client sent "1.2.3.4", ingress appended "203.0.113.1", web appended "10.244.0.5"
    const reqSpoofedTwoHops = {
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.1, 10.244.0.5' },
      socket: { remoteAddress: '10.244.0.10' },
    };
    assert.equal(resolveClientIp(reqSpoofedTwoHops, 2), '203.0.113.1');
  });

  test('returns null when header is absent or has fewer entries than configured hops', () => {
    // Missing header with 1 configured hop: short chain → null (not socket IP, which would be
    // the proxy address and would allow rate-limit bypass by a forged short chain)
    const reqMissing = {
      headers: {},
      socket: { remoteAddress: '198.51.100.99' },
    };
    assert.equal(resolveClientIp(reqMissing, 1), null);

    const reqFewerHops = {
      headers: { 'x-forwarded-for': '203.0.113.1' },
      socket: { remoteAddress: '10.244.0.10' },
    };
    // 2 hops requested, but only 1 entry present: chain too short → null
    assert.equal(resolveClientIp(reqFewerHops, 2), null);
  });

  test('returns null when candidate in forwarded header is not a valid IP', () => {
    // Chain has exactly 1 entry (= trustedHopCount), so it passes the length check,
    // but normalizeIp returns null for the invalid value → resolveClientIp returns null.
    const reqMalformed = {
      headers: { 'x-forwarded-for': 'invalid-not-an-ip' },
      socket: { remoteAddress: '198.51.100.88' },
    };
    assert.equal(resolveClientIp(reqMalformed, true), null);
  });

  test('normalizes socket IP when IPv4-mapped IPv6 is used', () => {
    const req = {
      headers: {},
      socket: { remoteAddress: '::ffff:198.51.100.42' },
    };
    assert.equal(resolveClientIp(req, false), '198.51.100.42');
  });

  test('rejects invalid numeric hop counts instead of silently changing trust mode', () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.1' },
      socket: { remoteAddress: '198.51.100.42' },
    };

    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => resolveClientIp(req, value), /TRUST_PROXY must be/);
    }
  });
});
