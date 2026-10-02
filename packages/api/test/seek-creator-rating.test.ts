import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers';
import { seekView } from '../src/presenters';
import { InMemoryRatingsRepository } from '../src/fakes';

test('seek views publish only persisted creator ratings in the server-classified variant × speed pool', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('rated-seek-creator');
    const acceptor = await h.makeUser('rated-seek-acceptor');
    for (const [variant, speed, rating] of [
      ['standard', 'blitz', 1842.34567], ['standard', 'rapid', 2137.6], ['atomic', 'blitz', 1293.2],
    ] as const) {
      await h.repos.ratings.upsert({ userId: creator.userId, variant, speed, rating, rd: 80, vol: 0.06 });
    }
    const cases = [
      { variant: 'standard', minutes: 3, speed: 'blitz', rating: 1842.35, rated: true },
      { variant: 'standard', minutes: 10, speed: 'rapid', rating: 2137.6, rated: false },
      { variant: 'atomic', minutes: 3, speed: 'blitz', rating: 1293.2, rated: false },
      { variant: 'atomic', minutes: 10, speed: 'rapid', rating: null, rated: true },
    ];
    const ids: string[] = [];
    for (const c of cases) {
      const response = await h.json('POST', '/v1/seeks', { token: creator.token, body: {
        variant: c.variant, rated: c.rated,
        timeControl: { initialMs: c.minutes * 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      } });
      assert.equal(response.status, 201);
      assert.equal(response.body.speed, c.speed);
      assert.equal(response.body.creatorRating, c.rating);
      ids.push(response.body.id);
    }
    const response = await h.json('GET', '/v1/seeks');
    assert.equal(response.status, 200);
    for (const [index, c] of cases.entries()) {
      const row = response.body.find((s: { id: string }) => s.id === ids[index]);
      assert.equal(row.creatorHandle, 'rated-seek-creator');
      assert.equal(row.creatorRating, c.rating);
      assert.equal(row.rated, c.rated);
    }
    const matched = await h.json('POST', `/v1/seeks/${ids[0]}/accept`, { token: acceptor.token });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.creatorRating, 1842.35);
  } finally { await h.close(); }
});

test('rating batch fake omits malformed creator identifiers like PostgreSQL', async () => {
  const ratings = new InMemoryRatingsRepository();
  const valid = { userId: randomUUID(), variant: 'standard' as const, speed: 'blitz' as const };
  const invalid = { ...valid, userId: 'not-a-uuid' };
  await ratings.upsert({ ...valid, rating: 1842, rd: 80, vol: 0.06 });
  await ratings.upsert({ ...invalid, rating: 2999, rd: 80, vol: 0.06 });
  assert.deepEqual(await ratings.getMany([invalid]), []);
  assert.deepEqual((await ratings.getMany([valid, invalid, valid])).map((r) => r.rating), [1842]);
});

test('missing creator and missing pool remain null rather than publishing a default or a constraint', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('no-pool-creator');
    await h.repos.ratings.upsert({ userId: creator.userId, variant: 'standard', speed: 'rapid', rating: 2222, rd: 80, vol: 0.06 });
    const timeControl = { initialMs: 180_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };
    const seek = await h.repos.seeks.create({ id: randomUUID(), creatorId: creator.userId, variant: 'standard', timeControl, rated: true, minRating: 1700, maxRating: 1900 });
    const missing = await h.repos.seeks.create({ id: randomUUID(), creatorId: randomUUID(), variant: 'standard', timeControl, rated: false });
    // A stale custom repository must not expose a rating for an unresolvable creator.
    await h.repos.ratings.upsert({ userId: missing.creatorId, variant: 'standard', speed: 'blitz', rating: 2999, rd: 80, vol: 0.06 });
    const response = await h.json('GET', '/v1/seeks');
    for (const id of [seek.id, missing.id]) {
      assert.equal(response.body.find((s: { id: string }) => s.id === id).creatorRating, null);
    }
    assert.equal(response.body.find((s: { id: string }) => s.id === missing.id).creatorHandle, null);
    const spec = await h.json('GET', '/v1/openapi.json');
    const schema = spec.body.components.schemas.SeekView;
    assert.ok(schema.required.includes('creatorRating'));
    assert.deepEqual(schema.properties.creatorRating.type, ['number', 'null']);
  } finally { await h.close(); }
});

test('a full seek page uses one batch rating read and refreshes current persisted values', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('batch-seek-creator');
    const timeControl = { initialMs: 180_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };
    for (let i = 0; i < 100; i++) {
      await h.repos.seeks.create({ id: randomUUID(), creatorId: creator.userId, variant: 'standard', timeControl, rated: i % 2 === 0 });
    }
    const getMany = h.repos.ratings.getMany.bind(h.repos.ratings);
    let batches = 0;
    h.repos.ratings.getMany = async (keys) => { batches++; return getMany(keys); };
    h.repos.ratings.get = async () => { throw new Error('per-row rating lookup is forbidden'); };
    await h.repos.ratings.upsert({ userId: creator.userId, variant: 'standard', speed: 'blitz', rating: 1777, rd: 80, vol: 0.06 });
    const first = await h.json('GET', '/v1/seeks?limit=100');
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 100);
    assert.ok(first.body.every((row: { creatorRating: number }) => row.creatorRating === 1777));
    assert.equal(batches, 1);
    await h.repos.ratings.upsert({ userId: creator.userId, variant: 'standard', speed: 'blitz', rating: 1888, rd: 80, vol: 0.06 });
    const next = await h.json('GET', '/v1/seeks?limit=100');
    assert.ok(next.body.every((row: { creatorRating: number }) => row.creatorRating === 1888));
    assert.equal(batches, 2);
    const row = (await h.repos.seeks.listOpen(1))[0]!;
    assert.equal(seekView(row, { userId: creator.userId, variant: 'standard', speed: 'rapid', rating: 2222, rd: 80, vol: 0.06, updatedAt: new Date() }).creatorRating, null);
  } finally { await h.close(); }
});

test('creator pool display follows increment-aware server classification and rejects a client speed override', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('classified-seek-creator');
    await h.repos.ratings.upsert({ userId: creator.userId, variant: 'standard', speed: 'rapid', rating: 2138, rd: 80, vol: 0.06 });
    await h.repos.ratings.upsert({ userId: creator.userId, variant: 'standard', speed: 'bullet', rating: 999, rd: 80, vol: 0.06 });
    const body = { variant: 'standard', rated: false, timeControl: { initialMs: 60_000, incrementMs: 12_000, delayMs: 0, kind: 'increment' } };
    const rejected = await h.json('POST', '/v1/seeks', { token: creator.token, body: { ...body, speed: 'bullet' } });
    assert.equal(rejected.status, 422);
    const created = await h.json('POST', '/v1/seeks', { token: creator.token, body });
    assert.equal(created.status, 201);
    assert.equal(created.body.speed, 'rapid');
    assert.equal(created.body.creatorRating, 2138);
  } finally { await h.close(); }
});

test('a creator-rating read failure happens before seek creation or acceptance commits', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('read-failure-creator');
    const acceptor = await h.makeUser('read-failure-acceptor');
    const get = h.repos.ratings.get.bind(h.repos.ratings);
    h.repos.ratings.get = async () => { throw new Error('rating read unavailable'); };
    const body = { variant: 'standard', rated: false, timeControl: { initialMs: 180_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } };
    const failedCreate = await h.json('POST', '/v1/seeks', { token: creator.token, body });
    assert.equal(failedCreate.status, 500);
    assert.equal((await h.repos.seeks.listOpen(100)).length, 0);
    h.repos.ratings.get = get;
    const created = await h.json('POST', '/v1/seeks', { token: creator.token, body });
    assert.equal(created.status, 201);
    h.repos.ratings.get = async () => { throw new Error('rating read unavailable'); };
    const failedAccept = await h.json('POST', `/v1/seeks/${created.body.id}/accept`, { token: acceptor.token });
    assert.equal(failedAccept.status, 500);
    assert.equal((await h.repos.seeks.findById(created.body.id))?.gameId, null);
    assert.equal((await h.repos.games.recentForUser(creator.userId, 100)).length, 0);
  } finally { await h.close(); }
});
