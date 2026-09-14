import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEEK_TTL_MS } from '@chess-platform/persistence';
import { startHarness } from './helpers';

const MATCH_RECEIPT_TTL_MS = 5 * 60 * 1000;

test('abandoned seek expires deterministically and is omitted from listOpen', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-expire', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Immediately after creation, seek is listed
    const list1 = await h.json('GET', '/v1/seeks');
    assert.equal(list1.status, 200);
    assert.ok(list1.body.some((s: { id: string }) => s.id === seekId));

    // Advance clock past SEEK_TTL_MS
    h.clock.advance(SEEK_TTL_MS + 1_000);

    // After TTL, seek must no longer appear in open seeks
    const list2 = await h.json('GET', '/v1/seeks');
    assert.equal(list2.status, 200);
    assert.ok(!list2.body.some((s: { id: string }) => s.id === seekId), 'expired seek must not be listed');
  } finally {
    await h.close();
  }
});

test('expired seek cannot be accepted', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-expired-accept', ['user']);
    const acceptor = await h.makeUser('acceptor-expired', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Advance past expiration
    h.clock.advance(SEEK_TTL_MS + 1_000);

    // Acceptor tries to accept the expired seek
    const acceptRes = await h.json('POST', `/v1/seeks/${seekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 404, 'expired seek accept must return 404');
  } finally {
    await h.close();
  }
});

test('seek expiry uses an exact inclusive ten-minute boundary for listing, acceptance, and cleanup', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-boundary', ['user']);
    const acceptor = await h.makeUser('acceptor-boundary', ['user']);
    const createSeek = async (): Promise<string> => {
      const response = await h.json('POST', '/v1/seeks', {
        token: creator.token,
        body: {
          variant: 'standard',
          timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
          rated: false,
        },
      });
      assert.equal(response.status, 201);
      return response.body.id as string;
    };

    const listedSeekId = await createSeek();
    const acceptedSeekId = await createSeek();
    h.clock.advance(SEEK_TTL_MS - 1);

    const beforeBoundary = await h.json('GET', '/v1/seeks');
    assert.ok(beforeBoundary.body.some((seek: { id: string }) => seek.id === listedSeekId));
    assert.ok(beforeBoundary.body.some((seek: { id: string }) => seek.id === acceptedSeekId));

    h.clock.advance(1);
    const atBoundary = await h.json('GET', '/v1/seeks');
    assert.ok(!atBoundary.body.some((seek: { id: string }) => seek.id === listedSeekId));
    assert.ok(!atBoundary.body.some((seek: { id: string }) => seek.id === acceptedSeekId));

    const acceptResponse = await h.json('POST', `/v1/seeks/${acceptedSeekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptResponse.status, 404);

    await h.repos.seeks.cleanup(new Date(h.clock.now()));
    assert.equal(await h.repos.seeks.findById(listedSeekId), null);
    assert.equal(await h.repos.seeks.findById(acceptedSeekId), null);
  } finally {
    await h.close();
  }
});

test('creator is not redirected to an already-ended game', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-redirect', ['user']);
    const acceptor = await h.makeUser('acceptor-redirect', ['user']);

    // Creator posts seek
    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Acceptor accepts
    const acceptRes = await h.json('POST', `/v1/seeks/${seekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 200);
    const gameId = acceptRes.body.gameId;

    // While game is active, creator sees the match receipt
    const activeReceipts = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.equal(activeReceipts.status, 200);
    const matchedActive = activeReceipts.body.find((s: { gameId: string | null }) => s.gameId === gameId);
    assert.ok(matchedActive, 'active game match receipt must be returned to creator');

    // The game finishes (e.g. resigned / checkmated / aborted)
    await h.repos.games.finish(gameId, {
      result: '1-0',
      termination: 'resignation',
      plyCount: 2,
      lastSeq: 2,
      endedAt: new Date(h.clock.now()),
    });

    // Creator polls lobby again: already-ended game must NOT be returned as match receipt
    const endedReceipts = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.equal(endedReceipts.status, 200);
    const matchedEnded = endedReceipts.body.find((s: { gameId: string | null }) => s.gameId === gameId);
    assert.equal(matchedEnded, undefined, 'creator must not be returned a match receipt for an already-ended game');
  } finally {
    await h.close();
  }
});

test('cleanup purges expired abandoned seeks', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-cleanup', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Advance clock past seek TTL
    h.clock.advance(SEEK_TTL_MS + 5_000);

    // Run cleanup
    await h.repos.seeks.cleanup(new Date(h.clock.now()));

    // Seek row should be purged from database entirely
    const row = await h.repos.seeks.findById(seekId);
    assert.equal(row, null, 'expired abandoned seek must be purged by cleanup');
  } finally {
    await h.close();
  }
});

test('accepted match receipts remain visible before five minutes and expire and clean up at the boundary', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-receipt-ttl', ['user']);
    const acceptor = await h.makeUser('acceptor-receipt-ttl', ['user']);
    const seekResponse = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
        rated: false,
      },
    });
    assert.equal(seekResponse.status, 201);

    const acceptResponse = await h.json('POST', `/v1/seeks/${seekResponse.body.id}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptResponse.status, 200);
    const gameId = acceptResponse.body.gameId as string;

    h.clock.advance(MATCH_RECEIPT_TTL_MS - 1);
    await h.repos.seeks.cleanup(new Date(h.clock.now()));
    assert.ok(await h.repos.seeks.findById(seekResponse.body.id));
    const beforeBoundary = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.ok(beforeBoundary.body.some((seek: { gameId: string | null }) => seek.gameId === gameId));

    h.clock.advance(1);
    const atBoundary = await h.json('GET', '/v1/seeks', { token: creator.token });
    assert.ok(!atBoundary.body.some((seek: { gameId: string | null }) => seek.gameId === gameId));
    await h.repos.seeks.cleanup(new Date(h.clock.now()));
    assert.equal(await h.repos.seeks.findById(seekResponse.body.id), null);
  } finally {
    await h.close();
  }
});

test('list open seek returns human-readable creatorHandle without optional GraphQL', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('magnus_carlsen', ['user']);

    const createRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.creatorHandle, 'magnus_carlsen');

    // Listing open seeks must directly contain creatorHandle
    const listRes = await h.json('GET', '/v1/seeks');
    assert.equal(listRes.status, 200);
    const found = listRes.body.find((s: { id: string }) => s.id === createRes.body.id);
    assert.ok(found, 'seek must be in open seeks list');
    assert.equal(found.creatorHandle, 'magnus_carlsen', 'seek in listOpen must have creatorHandle');
  } finally {
    await h.close();
  }
});

test('accepting seek returns creatorHandle in match view', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('hikaru_nakamura', ['user']);
    const acceptor = await h.makeUser('acceptor_player', ['user']);

    const createRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
        rated: false,
      },
    });
    assert.equal(createRes.status, 201);

    const acceptRes = await h.json('POST', `/v1/seeks/${createRes.body.id}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.body.creatorHandle, 'hikaru_nakamura', 'accepted seek must have creatorHandle');
  } finally {
    await h.close();
  }
});

test('seek with unresolvable or deleted user falls back to null creatorHandle', async () => {
  const h = await startHarness();
  try {
    // Create seek with a synthetic/nonexistent creatorId directly in repos
    const syntheticId = '018f0000-0000-7000-8000-000000000099';
    const seek = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000001',
      creatorId: syntheticId,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    assert.equal(seek.creatorHandle, null, 'unresolvable creator must have null creatorHandle');

    const listRes = await h.json('GET', '/v1/seeks');
    assert.equal(listRes.status, 200);
    const found = listRes.body.find((s: { id: string }) => s.id === seek.id);
    assert.ok(found);
    assert.equal(found.creatorHandle, null, 'unresolvable creator in REST API must fall back to null');
  } finally {
    await h.close();
  }
});

test('resolved null creator handles do not trigger repeated user lookups', async () => {
  const h = await startHarness();
  try {
    let findByIdCalls = 0;
    let findByIdsCalls = 0;
    const originalFindById = h.repos.users.findById.bind(h.repos.users);
    const originalFindByIds = h.repos.users.findByIds.bind(h.repos.users);
    h.repos.users.findById = async (id) => {
      findByIdCalls += 1;
      return originalFindById(id);
    };
    h.repos.users.findByIds = async (ids) => {
      findByIdsCalls += 1;
      return originalFindByIds(ids);
    };

    const seek = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000002',
      creatorId: '018f0000-0000-7000-8000-000000000098',
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    assert.equal(seek.creatorHandle, null);

    assert.ok(await h.repos.seeks.findById(seek.id));
    await h.json('GET', '/v1/seeks');
    await h.json('GET', '/v1/seeks');

    assert.equal(findByIdCalls, 0, 'explicit null is already a resolved absence');
    assert.equal(findByIdsCalls, 0, 'list polling must not retry a resolved absence');
  } finally {
    await h.close();
  }
});

test('listOpen caches lazily resolved legacy creator handles', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('legacy-seek-creator', ['user']);
    const known = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000003',
      creatorId: creator.userId,
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    const unknown = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000004',
      creatorId: '018f0000-0000-7000-8000-000000000097',
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });

    const storage = h.repos.seeks as unknown as { byId: Map<string, typeof known> };
    storage.byId.set(known.id, { ...known, creatorHandle: undefined });
    storage.byId.set(unknown.id, { ...unknown, creatorHandle: undefined });

    let findByIdsCalls = 0;
    const originalFindByIds = h.repos.users.findByIds.bind(h.repos.users);
    h.repos.users.findByIds = async (ids) => {
      findByIdsCalls += 1;
      return originalFindByIds(ids);
    };

    const first = await h.repos.seeks.listOpen(10);
    const second = await h.repos.seeks.listOpen(10);

    assert.equal(findByIdsCalls, 1, 'legacy handle resolution must be cached after the first list');
    for (const rows of [first, second]) {
      assert.equal(rows.find((seek) => seek.id === known.id)?.creatorHandle, 'legacy-seek-creator');
      assert.equal(rows.find((seek) => seek.id === unknown.id)?.creatorHandle, null);
    }
  } finally {
    await h.close();
  }
});

test('findById lazy handle resolution cannot resurrect a concurrently removed seek', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('removed-find-legacy-seek-creator', ['user']);
    const seek = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000005',
      creatorId: creator.userId,
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    const storage = h.repos.seeks as unknown as { byId: Map<string, typeof seek> };
    storage.byId.set(seek.id, { ...seek, creatorHandle: undefined });

    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const originalFindById = h.repos.users.findById.bind(h.repos.users);
    h.repos.users.findById = async (id) => {
      signalLookupStarted();
      await lookupGate;
      return originalFindById(id);
    };

    const pendingFind = h.repos.seeks.findById(seek.id);
    await lookupStarted;
    assert.equal(await h.repos.seeks.remove(seek.id), true);
    releaseLookup();

    assert.equal(await pendingFind, null);
    assert.equal(storage.byId.has(seek.id), false);
  } finally {
    await h.close();
  }
});

test('listOpen lazy handle resolution preserves concurrent lifecycle changes', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('removed-legacy-seek-creator', ['user']);
    const removedSeek = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000006',
      creatorId: creator.userId,
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    const claimedSeek = await h.repos.seeks.create({
      id: '018f0000-0000-7000-8000-000000000007',
      creatorId: creator.userId,
      creatorHandle: null,
      variant: 'standard',
      timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rated: false,
    });
    const storage = h.repos.seeks as unknown as { byId: Map<string, typeof removedSeek> };
    storage.byId.set(removedSeek.id, { ...removedSeek, creatorHandle: undefined });
    storage.byId.set(claimedSeek.id, { ...claimedSeek, creatorHandle: undefined });

    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const originalFindByIds = h.repos.users.findByIds.bind(h.repos.users);
    h.repos.users.findByIds = async (ids) => {
      signalLookupStarted();
      await lookupGate;
      return originalFindByIds(ids);
    };

    const pendingList = h.repos.seeks.listOpen(10);
    await lookupStarted;
    assert.equal(await h.repos.seeks.remove(removedSeek.id), true);
    const acceptedAt = new Date(h.clock.now());
    const gameId = '018f0000-0000-7000-8000-000000000008';
    assert.ok(h.repos.seeks._claim(claimedSeek.id, gameId, acceptedAt));
    releaseLookup();
    await pendingList;

    assert.equal(storage.byId.has(removedSeek.id), false);
    const storedClaim = storage.byId.get(claimedSeek.id);
    assert.equal(storedClaim?.gameId, gameId);
    assert.deepEqual(storedClaim?.acceptedAt, acceptedAt);
  } finally {
    await h.close();
  }
});

test('accept defers entirely to storage layer to avoid split-brain under clock skew', async () => {
  const h = await startHarness();
  try {
    const creator = await h.makeUser('creator-skew', ['user']);
    const acceptor = await h.makeUser('acceptor-skew', ['user']);

    const seekRes = await h.json('POST', '/v1/seeks', {
      token: creator.token,
      body: {
        variant: 'standard',
        timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
        rated: false,
      },
    });
    assert.equal(seekRes.status, 201);
    const seekId = seekRes.body.id;

    // Advance clock past expiration
    h.clock.advance(SEEK_TTL_MS + 1_000);

    // Stub the storage layer to pretend the DB clock hasn't expired yet
    const originalAccept = h.repos.seekAcceptor.accept;
    h.repos.seekAcceptor.accept = async (sid, gid, events, gameStart) => {
      // Temporarily rewind clock just for the inner storage check
      h.clock.advance(-(SEEK_TTL_MS + 1_000));
      const res = await originalAccept.call(h.repos.seekAcceptor, sid, gid, events, gameStart);
      h.clock.advance(SEEK_TTL_MS + 1_000);
      return res;
    };

    const acceptRes = await h.json('POST', `/v1/seeks/${seekId}/accept`, {
      token: acceptor.token,
    });
    assert.equal(acceptRes.status, 200, 'API must allow acceptance if the storage layer atomically accepts it');
  } finally {
    await h.close();
  }
});
