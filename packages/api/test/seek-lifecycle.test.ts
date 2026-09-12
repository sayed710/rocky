import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEEK_TTL_MS } from '@chess-platform/persistence';
import { startHarness } from './helpers';

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

test('cleanup purges expired abandoned seeks as well as accepted receipts', async () => {
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
