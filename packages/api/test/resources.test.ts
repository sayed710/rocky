import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';

const INC = { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' as const };

test('seek creation validates the time control and variant', async () => {
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('sk', ['user']);

    const badVariant = await h.json('POST', '/v1/seeks', { token, body: { variant: 'bughouse', timeControl: INC } });
    assert.equal(badVariant.status, 422);

    const incWithDelay = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: { initialMs: 120000, incrementMs: 1000, delayMs: 500, kind: 'increment' } },
    });
    assert.equal(incWithDelay.status, 422);

    const unlimitedNonzero = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: { initialMs: 1000, incrementMs: 0, delayMs: 0, kind: 'unlimited' } },
    });
    assert.equal(unlimitedNonzero.status, 422);

    const badRange = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: INC, minRating: 2000, maxRating: 1000 },
    });
    assert.equal(badRange.status, 422);
  } finally {
    await h.close();
  }
});

test('seek rating filters enforce the published integer interval', async () => {
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('seek-rating-contract', ['user']);
    const invalidCases = [
      { label: 'minimum below zero', minRating: -1 },
      { label: 'minimum above 4000', minRating: 4001 },
      { label: 'maximum below zero', maxRating: -1 },
      { label: 'maximum above 4000', maxRating: 4001 },
      { label: 'fractional minimum', minRating: 1500.5 },
      { label: 'fractional maximum', maxRating: 1500.5 },
    ] as const;

    for (const { label, ...ratingFilter } of invalidCases) {
      const response = await h.json('POST', '/v1/seeks', {
        token,
        body: { variant: 'standard', timeControl: INC, ...ratingFilter },
      });
      assert.equal(response.status, 422, label);
    }

    const boundaries = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: INC, minRating: 0, maxRating: 4000 },
    });
    assert.equal(boundaries.status, 201);
    assert.equal(boundaries.body.minRating, 0);
    assert.equal(boundaries.body.maxRating, 4000);
  } finally {
    await h.close();
  }
});

test('seek rating filters preserve explicit and omitted no-bound semantics', async () => {
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('seek-rating-no-bound', ['user']);
    const explicitNulls = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: INC, minRating: null, maxRating: null },
    });
    assert.equal(explicitNulls.status, 201);
    assert.equal(explicitNulls.body.minRating, null);
    assert.equal(explicitNulls.body.maxRating, null);

    const omitted = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: INC },
    });
    assert.equal(omitted.status, 201);
    assert.equal(omitted.body.minRating, null);
    assert.equal(omitted.body.maxRating, null);
  } finally {
    await h.close();
  }
});

test('a created seek is listed with its derived speed', async () => {
  const h = await startHarness();
  try {
    const { token, userId } = await h.makeUser('sp', ['user']);
    const created = await h.json('POST', '/v1/seeks', { token, body: { variant: 'standard', timeControl: INC } });
    assert.equal(created.status, 201);
    assert.equal(created.body.creatorId, userId);
    assert.equal(created.body.speed, 'blitz');
    assert.equal(created.body.rated, true);

    const list = await h.json('GET', '/v1/seeks');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, created.body.id);
  } finally {
    await h.close();
  }
});

test('the leaderboard serves exactly the requested variant and speed pool', async () => {
  const h = await startHarness();
  try {
    const a = await h.makeUser('rank-a', ['user']);
    const b = await h.makeUser('rank-b', ['user']);
    await h.repos.ratings.upsert({ userId: a.userId, variant: 'standard', speed: 'blitz', rating: 2200, rd: 45, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: b.userId, variant: 'standard', speed: 'blitz', rating: 1900, rd: 60, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: a.userId, variant: 'standard', speed: 'rapid', rating: 1400, rd: 70, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: b.userId, variant: 'standard', speed: 'classical', rating: 2500, rd: 80, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: b.userId, variant: 'crazyhouse', speed: 'blitz', rating: 2600, rd: 80, vol: 0.06 });

    const blitz = await h.json('GET', '/v1/leaderboard/standard/blitz?limit=10');
    assert.equal(blitz.status, 200);
    assert.deepEqual(blitz.body, [
      { userId: a.userId, variant: 'standard', speed: 'blitz', rating: 2200, rd: 45 },
      { userId: b.userId, variant: 'standard', speed: 'blitz', rating: 1900, rd: 60 },
    ]);
    assert.deepEqual((await h.json('GET', '/v1/leaderboard/standard/rapid')).body.map((e: { userId: string }) => e.userId), [a.userId]);
    assert.deepEqual((await h.json('GET', '/v1/leaderboard/standard/classical')).body.map((e: { userId: string }) => e.userId), [b.userId]);
    assert.deepEqual((await h.json('GET', '/v1/leaderboard/standard/bullet')).body, []);
  } finally {
    await h.close();
  }
});

test('a profile lists every rating pool separately, never collapsed by variant', async () => {
  const h = await startHarness();
  try {
    const a = await h.makeUser('rank-a', ['user']);
    await h.repos.ratings.upsert({ userId: a.userId, variant: 'standard', speed: 'rapid', rating: 1400, rd: 70, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: a.userId, variant: 'standard', speed: 'blitz', rating: 2200, rd: 45, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: a.userId, variant: 'crazyhouse', speed: 'correspondence', rating: 1600, rd: 90, vol: 0.06 });

    const ratings = await h.json('GET', '/v1/users/rank-a/ratings');
    assert.equal(ratings.status, 200);
    const pools = (rows: Array<{ variant: string; speed: string; rating: number }>) => rows.map((r) => `${r.variant}/${r.speed}:${r.rating}`);
    assert.deepEqual(pools(ratings.body), ['crazyhouse/correspondence:1600', 'standard/blitz:2200', 'standard/rapid:1400']);

    const profile = await h.json('GET', '/v1/users/rank-a');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.handle, 'rank-a');
    assert.deepEqual(pools(profile.body.ratings), pools(ratings.body));
  } finally {
    await h.close();
  }
});

test("a seek rating range checks the acceptor's rating in the seek's own variant and speed pool only", async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('range-creator', ['user']);
    const joiner = await h.makeUser('range-joiner', ['user']);
    const seek = async (): Promise<string> => {
      const res = await h.json('POST', '/v1/seeks', { token: creator.token, body: { variant: 'standard', timeControl: INC, minRating: 1800 } });
      assert.equal(res.status, 201);
      return res.body.id;
    };
    const accept = async (id: string): Promise<number> => (await h.json('POST', `/v1/seeks/${id}/accept`, { token: joiner.token })).status;

    // A high rating in other pools does not qualify for a blitz seek; the unrated blitz start (1500) does not either.
    await h.repos.ratings.upsert({ userId: joiner.userId, variant: 'standard', speed: 'rapid', rating: 2400, rd: 50, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: joiner.userId, variant: 'crazyhouse', speed: 'blitz', rating: 2400, rd: 50, vol: 0.06 });
    const first = await seek();
    assert.equal(await accept(first), 403);
    await h.repos.ratings.upsert({ userId: joiner.userId, variant: 'standard', speed: 'blitz', rating: 1700, rd: 50, vol: 0.06 });
    assert.equal(await accept(first), 403);

    await h.repos.ratings.upsert({ userId: joiner.userId, variant: 'standard', speed: 'blitz', rating: 1850, rd: 50, vol: 0.06 });
    assert.equal(await accept(first), 200);
  } finally {
    await h.close();
  }
});

test('a fresh user profile has no ratings and unknown users are 404', async () => {
  const h = await startHarness();
  try {
    await h.makeUser('fresh', ['user']);
    const profile = await h.json('GET', '/v1/users/fresh');
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.ratings, []);

    const missing = await h.json('GET', '/v1/users/nobody');
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('the leaderboard requires an explicit valid speed and rejects a bad variant or limit', async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.json('GET', '/v1/leaderboard/notavariant/blitz')).status, 422);
    assert.equal((await h.json('GET', '/v1/leaderboard/standard/hyperbullet')).status, 422);
    assert.equal((await h.json('GET', '/v1/leaderboard/standard/blitz?limit=-3')).status, 422);
    // No speed means no pool: there is no default speed to fall back to.
    assert.equal((await h.json('GET', '/v1/leaderboard/standard')).status, 404);
  } finally {
    await h.close();
  }
});

test('game summaries and per-user history are served', async () => {
  const h = await startHarness();
  try {
    const white = await h.makeUser('white', ['user']);
    const black = await h.makeUser('black', ['user']);
    await h.repos.games.start({
      id: 'game-1',
      variant: 'standard',
      rated: true,
      speed: 'blitz',
      whiteId: white.userId,
      blackId: black.userId,
      startedAt: new Date(h.clock.now()),
    });
    await h.repos.games.finish('game-1', {
      result: '1-0',
      termination: 'checkmate',
      plyCount: 41,
      lastSeq: 41,
      endedAt: new Date(h.clock.now() + 60000),
    });

    const game = await h.json('GET', '/v1/games/game-1');
    assert.equal(game.status, 200);
    assert.equal(game.body.result, '1-0');
    assert.equal(game.body.termination, 'checkmate');
    assert.equal(game.body.plyCount, 41);

    const history = await h.json('GET', '/v1/users/white/games');
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].id, 'game-1');

    const missing = await h.json('GET', '/v1/games/does-not-exist');
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

// ── M4: strict unknown-field rejection ─────────────────────────────────────

test('M4: register rejects unknown fields with 422', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'testuser', password: 'password123', extraField: true, email: 'testuser@example.test' },
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error, 'should have an error envelope');
  } finally {
    await h.close();
  }
});

test('M4: login rejects unknown fields with 422', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('POST', '/v1/auth/login', {
      body: { handle: 'testuser', password: 'pass', rogue: 'mass-assign' },
    });
    assert.equal(res.status, 422);
  } finally {
    await h.close();
  }
});

test('M4: create seek rejects unknown fields with 422', async () => {
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('sk', ['user']);
    const res = await h.json('POST', '/v1/seeks', {
      token,
      body: { variant: 'standard', timeControl: INC, injected: 'evil' },
    });
    assert.equal(res.status, 422);
  } finally {
    await h.close();
  }
});

test('M4: grant role rejects unknown fields with 422', async () => {
  const h = await startHarness();
  try {
    const { token, userId } = await h.makeUser('admin', ['user', 'admin']);
    const res = await h.json('POST', `/v1/users/${userId}/roles`, {
      token,
      body: { role: 'moderator', extra: 'field' },
    });
    assert.equal(res.status, 422);
  } finally {
    await h.close();
  }
});
