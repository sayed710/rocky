import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileController } from '../src/app/profile-controller.js';
import type { UserProfile, GameSummary, Variant } from '../src/api/models.js';

function makeProfile(handle: string = 'alice'): UserProfile {
  return {
    user: { id: 'u1', handle, country: null, createdAt: '2026-01-01T00:00:00Z' },
    ratings: [{ variant: 'standard' as Variant, speed: 'blitz' as const, rating: 1500, rd: 200, vol: 0.06, updatedAt: null }],
  };
}

function makeGame(id: string = 'g1'): GameSummary {
  return {
    id, variant: 'standard' as Variant, rated: true, speed: 'blitz',
    whiteId: 'u1', blackId: 'u2', result: '1-0', termination: 'checkmate',
    plyCount: 40, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:10:00Z',
  };
}

function makeFakeClient(profile: UserProfile | null = null, games: GameSummary[] = []) {
  return {
    users: {
      me: async () => ({ id: 'u1', handle: 'me', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] }),
      byHandle: async (handle: string) => profile ?? makeProfile(handle),
      ratings: async () => profile?.ratings ?? [],
      games: async () => games,
    },
  };
}

test('load fetches profile and games by handle', async () => {
  const profile = makeProfile('bob');
  const games = [makeGame('g1'), makeGame('g2')];
  const client = makeFakeClient(profile, games) as any;
  let receivedProfile: UserProfile | null = null;
  let receivedGames: GameSummary[] | null = null;
  let errors: string[] = [];
  const ctrl = new ProfileController({
    client,
    callbacks: {
      onProfile: (p) => { receivedProfile = p; },
      onGames: (g) => { receivedGames = [...g]; },
      onError: (m) => { errors.push(m); },
    },
  });
  await ctrl.load('bob');
  assert.equal((receivedProfile as UserProfile | null)?.user?.handle ?? null, 'bob');
  assert.equal((receivedGames as GameSummary[] | null)?.length ?? 0, 2);
  assert.equal(errors.length, 0);
});

test('loadSelf fetches the authenticated user profile', async () => {
  const client = makeFakeClient(makeProfile('me'), [makeGame()]) as any;
  let handles: string[] = [];
  const ctrl = new ProfileController({
    client,
    callbacks: {
      onProfile: (p) => { handles.push(p.user.handle); },
      onGames: () => {},
      onError: () => {},
    },
  });
  await ctrl.loadSelf();
  assert.equal(handles.length, 1);
  // loadSelf calls me() then load(handle), so byHandle is called with 'me'
  assert.equal(handles[0], 'me');
});

test('errors are reported via onError', async () => {
  const client = {
    users: {
      me: async () => { throw new Error('unauthorized'); },
      byHandle: async () => { throw new Error('not found'); },
      ratings: async () => [],
      games: async () => [],
    },
  };
  let errors: string[] = [];
  const ctrl = new ProfileController({
    client: client as any,
    callbacks: {
      onProfile: () => {},
      onGames: () => {},
      onError: (m) => { errors.push(m); },
    },
  });
  await ctrl.load('ghost');
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'not found');
});

test('dispose ignores future calls', async () => {
  const client = makeFakeClient(makeProfile(), [makeGame()]) as any;
  let profileCalls = 0;
  const ctrl = new ProfileController({
    client,
    callbacks: {
      onProfile: () => { profileCalls++; },
      onGames: () => {},
      onError: () => {},
    },
  });
  ctrl.dispose();
  await ctrl.load('alice');
  assert.equal(profileCalls, 0);
  assert.equal(ctrl.currentProfile, null);
});

test('reset suppresses an in-flight self-profile load from a previous session', async () => {
  let resolveAlice: ((profile: UserProfile) => void) | undefined;
  let markAliceStarted: (() => void) | undefined;
  const aliceProfile = new Promise<UserProfile>((resolve) => {
    resolveAlice = resolve;
  });
  const aliceStarted = new Promise<void>((resolve) => {
    markAliceStarted = resolve;
  });
  const client = {
    users: {
      me: async () => ({ id: 'u1', handle: 'alice', country: null, createdAt: '', roles: ['user'] }),
      byHandle: async (handle: string) => {
        if (handle === 'alice') {
          markAliceStarted!();
          return aliceProfile;
        }
        return makeProfile(handle);
      },
      ratings: async () => [],
      games: async () => [],
    },
  };
  const handles: string[] = [];
  const ctrl = new ProfileController({
    client: client as any,
    callbacks: {
      onProfile: (profile) => { handles.push(profile.user.handle); },
      onGames: () => {},
      onError: () => {},
    },
  });

  const staleLoad = ctrl.loadSelf();
  await aliceStarted;
  ctrl.reset();
  await ctrl.load('bob');
  resolveAlice!(makeProfile('alice'));
  await staleLoad;

  assert.deepEqual(handles, ['bob']);
  assert.equal(ctrl.currentProfile?.user.handle, 'bob');
});

test('currentProfile and currentGames return snapshots', async () => {
  const profile = makeProfile('alice');
  const games = [makeGame('g1'), makeGame('g2'), makeGame('g3')];
  const client = makeFakeClient(profile, games) as any;
  const ctrl = new ProfileController({
    client,
    callbacks: {
      onProfile: () => {},
      onGames: () => {},
      onError: () => {},
    },
  });
  await ctrl.load('alice');
  assert.equal(ctrl.currentProfile?.user.handle, 'alice');
  assert.equal(ctrl.currentGames.length, 3);
});

test('gameLimit is passed to the API', async () => {
  let limitReceived: number | undefined;
  const client = {
    users: {
      me: async () => ({ id: 'u1', handle: 'me', country: null, createdAt: '', roles: [] }),
      byHandle: async () => makeProfile(),
      ratings: async () => [],
      games: async (_h: string, opts: { limit?: number } = {}) => {
        limitReceived = opts.limit;
        return [makeGame()];
      },
    },
  };
  const ctrl = new ProfileController({
    client: client as any,
    callbacks: {
      onProfile: () => {},
      onGames: () => {},
      onError: () => {},
    },
    gameLimit: 5,
  });
  await ctrl.load('alice');
  assert.equal(limitReceived, 5);
});
