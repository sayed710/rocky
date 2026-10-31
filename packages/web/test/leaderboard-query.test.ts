import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFERED_VARIANTS, SPEEDS } from '../src/api/models.js';
import { parseLeaderboardQuery, leaderboardPoolUrl } from '../src/app/leaderboard-query.js';

const firstVariant = OFFERED_VARIANTS[0];
const firstSpeed = SPEEDS[0];
if (!firstVariant || !firstSpeed) {
  throw new Error('OFFERED_VARIANTS and SPEEDS must be non-empty');
}
const altVariant = OFFERED_VARIANTS.find((v) => v !== 'standard') ?? firstVariant;

test('parseLeaderboardQuery handles defaults, invalid inputs, encoding, and duplicates', () => {
  const cases = [
    { q: '', expected: { variant: 'standard', speed: null } },
    { q: '?tab=top', expected: { variant: 'standard', speed: null } },
    { q: '?variant=unknown&speed=unknown', expected: { variant: 'standard', speed: null } },
    { q: `?speed=${firstSpeed}`, expected: { variant: 'standard', speed: firstSpeed } },
    { q: `?variant=${altVariant}`, expected: { variant: altVariant, speed: null } },
    { q: `?variant=invalid&speed=${firstSpeed}`, expected: { variant: 'standard', speed: firstSpeed } },
    { q: `?variant=${altVariant}&speed=invalid`, expected: { variant: altVariant, speed: null } },
    { q: '?variant=STANDARD&speed=BLITZ', expected: { variant: 'standard', speed: null } },
    { q: '?variant=&speed=', expected: { variant: 'standard', speed: null } },
    { q: '?variant=<script>bad()</script>&speed=%E0%A4%A', expected: { variant: 'standard', speed: null } },
    { q: `?variant=${altVariant}&variant=invalid&speed=${firstSpeed}&speed=invalid`, expected: { variant: altVariant, speed: firstSpeed } },
    { q: `?variant=${encodeURIComponent(altVariant)}&speed=${encodeURIComponent(firstSpeed)}`, expected: { variant: altVariant, speed: firstSpeed } },
  ];
  for (const { q, expected } of cases) {
    assert.deepStrictEqual(parseLeaderboardQuery(q), expected);
  }
});

test('canonical offered variants and speeds parse correctly without list drift', () => {
  for (const variant of OFFERED_VARIANTS) {
    assert.deepStrictEqual(parseLeaderboardQuery(`?variant=${variant}&speed=${firstSpeed}`), { variant, speed: firstSpeed });
  }
  for (const speed of SPEEDS) {
    assert.deepStrictEqual(parseLeaderboardQuery(`?variant=standard&speed=${speed}`), { variant: 'standard', speed });
  }
});

test('leaderboardPoolUrl preserves path, hash, and unrelated params while omitting null speed', () => {
  const href = 'https://chess.test/leaderboard?tab=top&page=2#rankings';
  const resNull = leaderboardPoolUrl(href, { variant: 'standard', speed: null });
  assert.ok(resNull.startsWith('/leaderboard'));
  const u1 = new URL(resNull, 'https://chess.test');
  assert.equal(u1.pathname, '/leaderboard');
  assert.equal(u1.hash, '#rankings');
  assert.equal(u1.searchParams.get('tab'), 'top');
  assert.equal(u1.searchParams.get('page'), '2');
  assert.equal(u1.searchParams.get('variant'), 'standard');
  assert.equal(u1.searchParams.has('speed'), false);

  const resWithSpeed = leaderboardPoolUrl(href, { variant: altVariant, speed: firstSpeed });
  const u2 = new URL(resWithSpeed, 'https://chess.test');
  assert.equal(u2.searchParams.get('variant'), altVariant);
  assert.equal(u2.searchParams.get('speed'), firstSpeed);
});

test('leaderboardPoolUrl replaces duplicate owned params canonically only once', () => {
  const href = 'https://chess.test/play?variant=v1&variant=v2&speed=s1&speed=s2&keep=yes#hash';
  const res = leaderboardPoolUrl(href, { variant: altVariant, speed: firstSpeed });
  assert.ok(res.startsWith('/play'));
  const u = new URL(res, 'https://chess.test');
  assert.deepStrictEqual(u.searchParams.getAll('variant'), [altVariant]);
  assert.deepStrictEqual(u.searchParams.getAll('speed'), [firstSpeed]);
  assert.equal(u.searchParams.get('keep'), 'yes');
  assert.equal(u.hash, '#hash');
});

test('roundtrip effective pool and sanitize hostile or duplicate queries', () => {
  const pools = [{ variant: altVariant, speed: firstSpeed }, { variant: 'standard' as const, speed: null }];
  for (const pool of pools) {
    const serialized = leaderboardPoolUrl('https://chess.test/leaderboard?unrelated=1', pool);
    assert.ok(serialized.startsWith('/leaderboard'));
    const parsed = parseLeaderboardQuery(new URL(serialized, 'https://chess.test').search);
    assert.deepStrictEqual(parsed, pool);
  }

  const hostileSearch = '?variant=<evil>&variant=standard&speed=9999&speed=bullet';
  const effective = parseLeaderboardQuery(hostileSearch);
  assert.deepStrictEqual(effective, { variant: 'standard', speed: null });
  const sanitized = leaderboardPoolUrl('https://chess.test/leaderboard' + hostileSearch, effective);
  const u = new URL(sanitized, 'https://chess.test');
  assert.equal(u.searchParams.get('variant'), 'standard');
  assert.equal(u.searchParams.has('speed'), false);
  assert.deepStrictEqual(u.searchParams.getAll('variant'), ['standard']);
  assert.deepStrictEqual(parseLeaderboardQuery(u.search), { variant: 'standard', speed: null });
});

test('leaderboardPoolUrl preserves same origin and pathname for leading double slash', () => {
  const input = 'https://chess.test//leaderboard?keep=yes#rank';
  const serialized = leaderboardPoolUrl(input, { variant: 'atomic', speed: 'blitz' });
  const resolved = new URL(serialized, input);
  assert.strictEqual(resolved.origin, 'https://chess.test');
  assert.strictEqual(resolved.pathname, '//leaderboard');
  assert.strictEqual(resolved.searchParams.get('keep'), 'yes');
  assert.strictEqual(resolved.searchParams.get('variant'), 'atomic');
  assert.strictEqual(resolved.searchParams.get('speed'), 'blitz');
  assert.strictEqual(resolved.hash, '#rank');
});
