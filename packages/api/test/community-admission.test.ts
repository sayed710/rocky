/**
 * Abuse admission for community writes (Fable+Astra audit, "Social / messaging / teams / forums …
 * no abuse budget"). Each creation route charges the caller's account and source address in one
 * atomic admission, before the repository is touched. Nothing is keyed by the player or team the
 * write is aimed at, so strangers cannot spend a victim's budget, and the safety and clean-up
 * routes (block, decline, leave, delete) are deliberately not metered at all.
 *
 * Every refusal below is checked twice: the response is a 429, and the list that the write would
 * have changed is read back unchanged. The second write in each test targets a different player or
 * team than the first, so it cannot be refused for being a duplicate instead of for its budget.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from '../src/config';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import type { RateLimitRequest } from '../src/ports/rate-limiter';
import { ManualClock } from '../src/ports/clock';
import { startHarness, type Harness } from './helpers';

const ONE = {
  perUser: { maxRequests: 1, windowMs: 60_000 },
  perIp: { maxRequests: 1, windowMs: 60_000 },
};

type Category = 'socialInitiation' | 'teamCreation' | 'teamJoin' | 'forumThreadCreation' | 'forumPostCreation';

const ip = (address: string) => ({ 'x-forwarded-for': address });

/** A harness where only `categories` are squeezed to one request per account and per address. */
function squeezed(categories: readonly Category[], enabled = true) {
  const rateLimit: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, enabled };
  const tight = Object.fromEntries(categories.map((c) => [c, ONE]));
  return startHarness({ trustProxy: true, rateLimit: { ...rateLimit, ...tight } });
}

async function createTeam(h: Harness, token: string, slug: string, visibility: 'public' | 'private' = 'public', headers = ip('198.51.100.250')) {
  return h.json('POST', '/v1/teams', { token, headers, body: { slug, name: slug, visibility } });
}

async function totalOf(h: Harness, path: string, token?: string): Promise<number> {
  const res = await h.json('GET', path, token === undefined ? {} : { token });
  assert.equal(res.status, 200, `GET ${path}`);
  return res.body.total as number;
}

function assertRateLimited(res: { status: number; body: any; headers: Headers }, why: string): void {
  assert.equal(res.status, 429, why);
  assert.equal(res.body.error.code, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), '60');
}

describe('social initiation admission (follow, friend request)', () => {
  it('limits follows by account and by address atomically, and a refused follow creates no edge', async () => {
    const h = await squeezed(['socialInitiation']);
    try {
      const alice = await h.makeUser('ca-follow-alice');
      const bob = await h.makeUser('ca-follow-bob');
      const carol = await h.makeUser('ca-follow-carol');
      const dave = await h.makeUser('ca-follow-dave');
      const follow = (token: string, address: string, target: string) =>
        h.json('POST', `/v1/social/follows/${target}`, { token, headers: ip(address) });

      assert.equal((await follow(alice.token, '192.0.2.10', bob.userId)).status, 200);
      assertRateLimited(await follow(alice.token, '192.0.2.11', carol.userId),
        'a new address must not buy the same account more follows');
      assert.equal(await totalOf(h, `/v1/social/players/${carol.userId}/followers`), 0);

      assertRateLimited(await follow(dave.token, '192.0.2.10', carol.userId),
        'a new account on the same address must not bypass the address budget');
      assert.equal(await totalOf(h, `/v1/social/players/${dave.userId}/following`), 0);

      assert.equal((await follow(dave.token, '192.0.2.11', carol.userId)).status, 200,
        'neither refusal charged the bucket the other one would have used');
      assert.equal(await totalOf(h, `/v1/social/players/${carol.userId}/followers`), 1);
    } finally {
      await h.close();
    }
  });

  it('limits friend requests by account and by address, and a refused request is never stored', async () => {
    const h = await squeezed(['socialInitiation']);
    try {
      const alice = await h.makeUser('ca-friend-alice');
      const bob = await h.makeUser('ca-friend-bob');
      const carol = await h.makeUser('ca-friend-carol');
      const dave = await h.makeUser('ca-friend-dave');
      const request = (token: string, address: string, addresseeId: string) =>
        h.json('POST', '/v1/social/friend-requests', { token, headers: ip(address), body: { addresseeId } });

      assert.equal((await request(alice.token, '192.0.2.20', bob.userId)).status, 201);
      assertRateLimited(await request(alice.token, '192.0.2.21', carol.userId), 'account budget');
      assert.equal(await totalOf(h, '/v1/social/friend-requests/incoming', carol.token), 0);

      assertRateLimited(await request(dave.token, '192.0.2.20', carol.userId), 'address budget');
      assert.equal(await totalOf(h, '/v1/social/friend-requests/outgoing', dave.token), 0);

      assert.equal((await request(dave.token, '192.0.2.21', carol.userId)).status, 201);
      assert.equal(await totalOf(h, '/v1/social/friend-requests/incoming', carol.token), 1);
    } finally {
      await h.close();
    }
  });

  it('bounds the decline-and-resend loop a requester could otherwise repeat without end', async () => {
    const h = await startHarness({ trustProxy: true, rateLimit: { ...DEFAULT_RATE_LIMIT, socialInitiation: {
      perUser: { maxRequests: 3, windowMs: 60_000 },
      perIp: { maxRequests: 100, windowMs: 60_000 },
    } } });
    try {
      const pest = await h.makeUser('ca-loop-pest');
      const victim = await h.makeUser('ca-loop-victim');
      const statuses: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const sent = await h.json('POST', '/v1/social/friend-requests', {
          token: pest.token, body: { addresseeId: victim.userId },
        });
        statuses.push(sent.status);
        if (sent.status !== 201) continue;
        const declined = await h.json('POST', `/v1/social/friend-requests/${sent.body.id}/respond`, {
          token: victim.token, body: { action: 'decline' },
        });
        assert.equal(declined.status, 200, 'declining is never metered');
      }
      assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
    } finally {
      await h.close();
    }
  });

  it('shares one budget between follows and friend requests', async () => {
    const h = await squeezed(['socialInitiation']);
    try {
      const alice = await h.makeUser('ca-share-alice');
      const bob = await h.makeUser('ca-share-bob');
      assert.equal((await h.json('POST', `/v1/social/follows/${bob.userId}`, {
        token: alice.token, headers: ip('192.0.2.30'),
      })).status, 200);
      assertRateLimited(await h.json('POST', '/v1/social/friend-requests', {
        token: alice.token, headers: ip('192.0.2.31'), body: { addresseeId: bob.userId },
      }), 'one outbound-initiation budget covers both');
      assert.equal(await totalOf(h, '/v1/social/friend-requests/incoming', bob.token), 0);
    } finally {
      await h.close();
    }
  });
});

describe('requests refused by validation spend no budget', () => {
  it('rejects a self follow or self friend request, in any UUID case, before charging', async () => {
    const h = await squeezed(['socialInitiation']);
    try {
      const alice = await h.makeUser('ca-self-alice');
      const bob = await h.makeUser('ca-self-bob');
      const headers = ip('192.0.2.130');
      for (const self of [alice.userId, alice.userId.toUpperCase()]) {
        const follow = await h.json('POST', `/v1/social/follows/${self}`, { token: alice.token, headers });
        assert.equal(follow.status, 422);
        assert.equal(follow.body.error.details.actor, 'self_relation');
        const request = await h.json('POST', '/v1/social/friend-requests', {
          token: alice.token, headers, body: { addresseeId: self },
        });
        assert.equal(request.status, 422);
        assert.equal(request.body.error.details.actor, 'self_relation');
      }
      assert.equal((await h.json('POST', `/v1/social/follows/${bob.userId}`, { token: alice.token, headers })).status, 200,
        'four self requests spent neither the account nor the address slot');
    } finally {
      await h.close();
    }
  });

  it('rejects a malformed team, thread or post before charging', async () => {
    const h = await squeezed(['teamCreation', 'forumThreadCreation', 'forumPostCreation']);
    try {
      const alice = await h.makeUser('ca-valid-alice');
      const headers = ip('192.0.2.131');
      for (const body of [
        { slug: 'Not A Slug', name: 'n', visibility: 'public' },
        { slug: '-leading-hyphen', name: 'n', visibility: 'public' },
        { slug: 'ca-valid-blank', name: '   ', visibility: 'public' },
        { slug: 'ca-valid-long', name: 'n', description: 'd'.repeat(5000), visibility: 'public' },
      ]) {
        assert.equal((await h.json('POST', '/v1/teams', { token: alice.token, headers, body })).status, 422, JSON.stringify(body).slice(0, 80));
      }
      const team = await createTeam(h, alice.token, 'ca-valid-team', 'public', headers);
      assert.equal(team.status, 201, 'the malformed teams spent no team budget');

      const threads = `/v1/teams/${team.body.id}/forum/threads`;
      for (const body of [{ title: '   ', body: 'text' }, { title: 'title', body: '   ' }]) {
        assert.equal((await h.json('POST', threads, { token: alice.token, headers, body })).status, 422);
      }
      const thread = await h.json('POST', threads, { token: alice.token, headers, body: { title: 't', body: 'opening' } });
      assert.equal(thread.status, 201, 'the malformed threads spent no thread budget');

      const posts = `${threads}/${thread.body.thread.id}/posts`;
      assert.equal((await h.json('POST', posts, { token: alice.token, headers, body: { body: '  ' } })).status, 422);
      assert.equal((await h.json('POST', posts, { token: alice.token, headers, body: { body: 'reply' } })).status, 201,
        'the malformed post spent no post budget');
    } finally {
      await h.close();
    }
  });
});

describe('no target lockout', () => {
  it('strangers aimed at one victim spend only their own budgets, never the victim\'s', async () => {
    const h = await squeezed(['socialInitiation', 'teamJoin']);
    try {
      const victim = await h.makeUser('ca-lock-victim');
      const friend = await h.makeUser('ca-lock-friend');
      const team = await createTeam(h, victim.token, 'ca-lock-team');
      assert.equal(team.status, 201);

      // Four strangers, four addresses: each spends its one slot on the victim or the victim's team.
      for (let i = 0; i < 4; i += 1) {
        const stranger = await h.makeUser(`ca-lock-stranger-${i}`);
        const headers = ip(`203.0.113.${40 + i}`);
        const res = i % 2 === 0
          ? await h.json('POST', `/v1/social/follows/${victim.userId}`, { token: stranger.token, headers })
          : await h.json('POST', `/v1/teams/${team.body.id}/members`, { token: stranger.token, headers });
        assert.ok(res.status === 200 || res.status === 201, `stranger ${i} got ${res.status}`);
      }

      assert.equal((await h.json('POST', `/v1/social/follows/${friend.userId}`, {
        token: victim.token, headers: ip('203.0.113.99'),
      })).status, 200, 'the victim\'s own social budget is untouched by writes aimed at them');
      const otherTeam = await createTeam(h, friend.token, 'ca-lock-other');
      assert.equal((await h.json('POST', `/v1/teams/${otherTeam.body.id}/members`, {
        token: victim.token, headers: ip('203.0.113.98'),
      })).status, 201, 'nor is the owner\'s join budget spent by joins to their team');
      const fifth = await h.makeUser('ca-lock-stranger-4');
      assert.equal((await h.json('POST', `/v1/teams/${team.body.id}/members`, {
        token: fifth.token, headers: ip('203.0.113.97'),
      })).status, 201, 'and the team itself has no budget for strangers to exhaust');
    } finally {
      await h.close();
    }
  });

  it('keeps every safety and clean-up action available after the caller has spent every creation budget', async () => {
    const h = await squeezed(['socialInitiation', 'teamCreation', 'teamJoin', 'forumThreadCreation', 'forumPostCreation']);
    try {
      const owner = await h.makeUser('ca-safe-owner');
      const pest = await h.makeUser('ca-safe-pest');
      const headers = ip('192.0.2.60');
      const as = (token: string) => ({ token, headers });

      const team = await createTeam(h, owner.token, 'ca-safe-team', 'public', headers);
      assert.equal(team.status, 201);
      const teamId = team.body.id as string;
      const thread = await h.json('POST', `/v1/teams/${teamId}/forum/threads`, {
        ...as(owner.token), body: { title: 'Welcome', body: 'first' },
      });
      assert.equal(thread.status, 201);
      const threadId = thread.body.thread.id as string;
      const post = await h.json('POST', `/v1/teams/${teamId}/forum/threads/${threadId}/posts`, {
        ...as(owner.token), body: { body: 'second' },
      });
      assert.equal(post.status, 201);
      const followed = await h.json('POST', `/v1/social/follows/${pest.userId}`, as(owner.token));
      assert.equal(followed.status, 200);
      // The pest, from another address, sends one request and joins the team.
      const pestHeaders = ip('192.0.2.61');
      const request = await h.json('POST', '/v1/social/friend-requests', {
        token: pest.token, headers: pestHeaders, body: { addresseeId: owner.userId },
      });
      assert.equal(request.status, 201);
      assert.equal((await h.json('POST', `/v1/teams/${teamId}/members`, {
        token: pest.token, headers: pestHeaders,
      })).status, 201);
      // A helper, from a third address, owns another team the owner joins, and asks to join the
      // owner's; an applicant, from a fourth, asks to join too. That spends every join budget.
      const helper = await h.makeUser('ca-safe-helper');
      const helperHeaders = ip('192.0.2.62');
      const helperTeam = await createTeam(h, helper.token, 'ca-safe-helper-team', 'public', helperHeaders);
      assert.equal(helperTeam.status, 201);
      assert.equal((await h.json('POST', `/v1/teams/${helperTeam.body.id}/members`, as(owner.token))).status, 201);
      const helperRequest = await h.json('POST', `/v1/teams/${teamId}/join-requests`, { token: helper.token, headers: helperHeaders });
      assert.equal(helperRequest.status, 201);
      const applicant = await h.makeUser('ca-safe-applicant');
      const applicantHeaders = ip('192.0.2.63');
      const applicantRequest = await h.json('POST', `/v1/teams/${teamId}/join-requests`, { token: applicant.token, headers: applicantHeaders });
      assert.equal(applicantRequest.status, 201);

      // Every creation budget the owner, the helper and the applicant have is now spent …
      assertRateLimited(await createTeam(h, owner.token, 'ca-safe-team-2', 'public', headers), 'team budget spent');
      assertRateLimited(await h.json('POST', `/v1/social/follows/${pest.userId}`, as(owner.token)), 'social budget spent');
      assertRateLimited(await h.json('POST', `/v1/teams/${helperTeam.body.id}/join-requests`, as(owner.token)), 'owner join budget spent');
      assertRateLimited(await h.json('POST', `/v1/teams/${helperTeam.body.id}/members`, { token: applicant.token, headers: applicantHeaders }), 'applicant join budget spent');

      // … and none of this depends on it.
      assert.equal((await h.json('DELETE', `/v1/teams/${teamId}/join-requests/${applicantRequest.body.id}`, {
        token: applicant.token, headers: applicantHeaders,
      })).status, 200, 'withdraw a join request');
      assert.equal((await h.json('POST', `/v1/teams/${teamId}/join-requests/${helperRequest.body.id}/respond`, {
        ...as(owner.token), body: { status: 'accepted' },
      })).status, 200, 'answer a join request');
      assert.equal((await h.json('PATCH', `/v1/teams/${teamId}/members/${pest.userId}`, {
        ...as(owner.token), body: { role: 'admin' },
      })).status, 200, 'change a role');
      assert.equal((await h.json('POST', `/v1/social/friend-requests/${request.body.id}/respond`, {
        ...as(owner.token), body: { action: 'decline' },
      })).status, 200, 'decline');
      assert.equal((await h.json('DELETE', `/v1/social/follows/${pest.userId}`, as(owner.token))).status, 204, 'unfollow');
      assert.equal((await h.json('POST', `/v1/social/blocks/${pest.userId}`, as(owner.token))).status, 200, 'block');
      assert.equal((await h.json('DELETE', `/v1/teams/${teamId}/members/${pest.userId}`, as(owner.token))).status, 204, 'remove member');
      assert.equal((await h.json('PATCH', `/v1/teams/${teamId}`, { ...as(owner.token), body: { name: 'Renamed' } })).status, 200, 'edit team');
      assert.equal((await h.json('PATCH', `/v1/forum/posts/${post.body.id}`, { ...as(owner.token), body: { body: 'edited' } })).status, 200, 'edit post');
      assert.equal((await h.json('DELETE', `/v1/forum/posts/${post.body.id}`, as(owner.token))).status, 200, 'delete post');
      assert.equal((await h.json('PATCH', `/v1/teams/${teamId}/forum/threads/${threadId}`, { ...as(owner.token), body: { locked: true } })).status, 200, 'lock thread');
      assert.equal((await h.json('DELETE', `/v1/teams/${teamId}/forum/threads/${threadId}`, as(owner.token))).status, 200, 'delete thread');
      assert.equal((await h.json('DELETE', `/v1/social/blocks/${pest.userId}`, as(owner.token))).status, 204, 'unblock');
      assert.equal((await h.json('POST', `/v1/teams/${teamId}/transfer-ownership`, {
        ...as(owner.token), body: { newOwnerId: helper.userId },
      })).status, 200, 'hand the team over');
    } finally {
      await h.close();
    }
  });
});

describe('team admission (create, join, join request)', () => {
  it('limits team creation by account and by address, and a refused team is never created', async () => {
    const h = await squeezed(['teamCreation']);
    try {
      const alice = await h.makeUser('ca-team-alice');
      const bob = await h.makeUser('ca-team-bob');
      assert.equal((await createTeam(h, alice.token, 'ca-team-one', 'public', ip('192.0.2.70'))).status, 201);
      assertRateLimited(await createTeam(h, alice.token, 'ca-team-two', 'public', ip('192.0.2.71')), 'account budget');
      assertRateLimited(await createTeam(h, bob.token, 'ca-team-three', 'public', ip('192.0.2.70')), 'address budget');
      assert.equal(await totalOf(h, '/v1/teams'), 1, 'neither refused team exists');
      assert.equal((await createTeam(h, bob.token, 'ca-team-four', 'public', ip('192.0.2.71'))).status, 201);
      assert.equal(await totalOf(h, '/v1/teams'), 2);
    } finally {
      await h.close();
    }
  });

  it('limits public joins and join requests from one budget, and a refused one leaves no row', async () => {
    const h = await squeezed(['teamJoin']);
    try {
      const owner = await h.makeUser('ca-join-owner');
      const alice = await h.makeUser('ca-join-alice');
      const bob = await h.makeUser('ca-join-bob');
      const open1 = await createTeam(h, owner.token, 'ca-join-open-1');
      const open2 = await createTeam(h, owner.token, 'ca-join-open-2');
      const open3 = await createTeam(h, owner.token, 'ca-join-open-3');
      for (const t of [open1, open2, open3]) assert.equal(t.status, 201);
      const join = (token: string, address: string, teamId: string) =>
        h.json('POST', `/v1/teams/${teamId}/members`, { token, headers: ip(address) });

      assert.equal((await join(alice.token, '192.0.2.80', open1.body.id)).status, 201);
      assertRateLimited(await join(alice.token, '192.0.2.81', open2.body.id), 'account budget');
      assertRateLimited(await h.json('POST', `/v1/teams/${open3.body.id}/join-requests`, {
        token: alice.token, headers: ip('192.0.2.82'),
      }), 'join requests share the join budget');
      assert.equal(await totalOf(h, '/v1/me/join-requests', alice.token), 0);
      assertRateLimited(await join(bob.token, '192.0.2.80', open2.body.id), 'address budget');
      assert.equal(await totalOf(h, `/v1/teams/${open2.body.id}/members`), 1, 'only the owner');

      const requested = await h.json('POST', `/v1/teams/${open3.body.id}/join-requests`, {
        token: bob.token, headers: ip('192.0.2.83'),
      });
      assert.equal(requested.status, 201);
      assert.equal(await totalOf(h, '/v1/me/join-requests', bob.token), 1);
    } finally {
      await h.close();
    }
  });

  it('admits only one of a concurrent join and join request racing for the last shared slot', async () => {
    const h = await startHarness({ rateLimit: { ...DEFAULT_RATE_LIMIT, teamJoin: {
      perUser: { maxRequests: 1, windowMs: 60_000 },
      perIp: { maxRequests: 100, windowMs: 60_000 },
    } } });
    try {
      const owner = await h.makeUser('ca-jrace-owner');
      const joiner = await h.makeUser('ca-jrace-joiner');
      const t1 = await createTeam(h, owner.token, 'ca-jrace-one');
      const t2 = await createTeam(h, owner.token, 'ca-jrace-two');
      const results = await Promise.all([
        h.json('POST', `/v1/teams/${t1.body.id}/members`, { token: joiner.token }),
        h.json('POST', `/v1/teams/${t2.body.id}/join-requests`, { token: joiner.token }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 429]);
      const joined = (await totalOf(h, `/v1/teams/${t1.body.id}/members`)) - 1;
      const requested = await totalOf(h, '/v1/me/join-requests', joiner.token);
      assert.equal(joined + requested, 1, 'exactly one of the two writes landed');
    } finally {
      await h.close();
    }
  });
});

describe('forum admission (thread, post)', () => {
  it('limits thread creation by account and by address, and a refused thread is never created', async () => {
    const h = await squeezed(['forumThreadCreation']);
    try {
      const owner = await h.makeUser('ca-thread-owner');
      const member = await h.makeUser('ca-thread-member');
      const team = await createTeam(h, owner.token, 'ca-thread-team');
      assert.equal(team.status, 201);
      assert.equal((await h.json('POST', `/v1/teams/${team.body.id}/members`, { token: member.token })).status, 201);
      const create = (token: string, address: string, title: string) =>
        h.json('POST', `/v1/teams/${team.body.id}/forum/threads`, { token, headers: ip(address), body: { title, body: 'text' } });
      const threads = `/v1/teams/${team.body.id}/forum/threads`;

      assert.equal((await create(owner.token, '192.0.2.90', 'one')).status, 201);
      assertRateLimited(await create(owner.token, '192.0.2.91', 'two'), 'account budget');
      assertRateLimited(await create(member.token, '192.0.2.90', 'three'), 'address budget');
      assert.equal(await totalOf(h, threads), 1);
      assert.equal((await create(member.token, '192.0.2.91', 'four')).status, 201);
      assert.equal(await totalOf(h, threads), 2);
    } finally {
      await h.close();
    }
  });

  it('limits posts by account and by address, and a refused post is never stored', async () => {
    const h = await squeezed(['forumPostCreation']);
    try {
      const owner = await h.makeUser('ca-post-owner');
      const member = await h.makeUser('ca-post-member');
      const team = await createTeam(h, owner.token, 'ca-post-team');
      assert.equal((await h.json('POST', `/v1/teams/${team.body.id}/members`, { token: member.token })).status, 201);
      const thread = await h.json('POST', `/v1/teams/${team.body.id}/forum/threads`, {
        token: owner.token, body: { title: 't', body: 'opening' },
      });
      assert.equal(thread.status, 201);
      const posts = `/v1/teams/${team.body.id}/forum/threads/${thread.body.thread.id}/posts`;
      const reply = (token: string, address: string, body: string) =>
        h.json('POST', posts, { token, headers: ip(address), body: { body } });

      assert.equal((await reply(owner.token, '192.0.2.100', 'first reply')).status, 201);
      assertRateLimited(await reply(owner.token, '192.0.2.101', 'refused'), 'account budget');
      assertRateLimited(await reply(member.token, '192.0.2.100', 'refused'), 'address budget');
      assert.equal(await totalOf(h, posts), 2, 'the opening post and the first reply');
      assert.equal((await reply(member.token, '192.0.2.101', 'second reply')).status, 201);
      assert.equal(await totalOf(h, posts), 3);
    } finally {
      await h.close();
    }
  });

  it('admits only one of many concurrent posts at the last account slot', async () => {
    const h = await startHarness({ rateLimit: { ...DEFAULT_RATE_LIMIT, forumPostCreation: {
      perUser: { maxRequests: 1, windowMs: 60_000 },
      perIp: { maxRequests: 100, windowMs: 60_000 },
    } } });
    try {
      const owner = await h.makeUser('ca-race-owner');
      const team = await createTeam(h, owner.token, 'ca-race-team');
      const thread = await h.json('POST', `/v1/teams/${team.body.id}/forum/threads`, {
        token: owner.token, body: { title: 't', body: 'opening' },
      });
      const posts = `/v1/teams/${team.body.id}/forum/threads/${thread.body.thread.id}/posts`;
      const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        h.json('POST', posts, { token: owner.token, body: { body: `race ${i}` } })));
      assert.equal(attempts.filter((r) => r.status === 201).length, 1);
      assert.equal(attempts.filter((r) => r.status === 429).length, 7);
      assert.equal(await totalOf(h, posts), 2);
    } finally {
      await h.close();
    }
  });
});

describe('admission failure modes', () => {
  /** An in-memory limiter that faults for any admission naming one of `prefixes`, once armed. */
  class FaultingLimiter extends InMemoryRateLimiter {
    armed = false;
    constructor(private readonly prefixes: readonly string[]) { super(new ManualClock(0)); }
    override admit(requests: readonly RateLimitRequest[]) {
      if (this.armed && requests.some((r) => this.prefixes.some((p) => r.key.startsWith(p)))) {
        throw new Error('rate-limit storage unavailable');
      }
      return super.admit(requests);
    }
  }

  it('fails closed before any community write when the limiter faults', async () => {
    const limiter = new FaultingLimiter(['social-initiate:', 'team-create:', 'team-join:', 'forum-thread:', 'forum-post:']);
    const h = await startHarness({}, { rateLimiter: limiter });
    try {
      const owner = await h.makeUser('ca-fault-owner');
      const other = await h.makeUser('ca-fault-other');
      const open = await createTeam(h, owner.token, 'ca-fault-open');
      const other2 = await createTeam(h, owner.token, 'ca-fault-other');
      const thread = await h.json('POST', `/v1/teams/${open.body.id}/forum/threads`, {
        token: owner.token, body: { title: 't', body: 'opening' },
      });
      assert.equal(thread.status, 201);
      const threads = `/v1/teams/${open.body.id}/forum/threads`;
      const posts = `${threads}/${thread.body.thread.id}/posts`;
      limiter.armed = true;

      const writes: Array<[string, string, object?]> = [
        [other.token, `/v1/social/follows/${owner.userId}`],
        [other.token, '/v1/social/friend-requests', { addresseeId: owner.userId }],
        [other.token, '/v1/teams', { slug: 'ca-fault-new', name: 'n', visibility: 'public' }],
        [other.token, `/v1/teams/${open.body.id}/members`],
        [other.token, `/v1/teams/${other2.body.id}/join-requests`],
        [owner.token, threads, { title: 'refused', body: 'x' }],
        [owner.token, posts, { body: 'refused' }],
      ];
      for (const [token, path, body] of writes) {
        const res = await h.json('POST', path, body === undefined ? { token } : { token, body });
        assert.equal(res.status, 500, `${path} must not treat a limiter fault as permission`);
      }

      assert.equal(await totalOf(h, `/v1/social/players/${owner.userId}/followers`), 0);
      assert.equal(await totalOf(h, '/v1/social/friend-requests/incoming', owner.token), 0);
      assert.equal(await totalOf(h, '/v1/teams'), 2);
      assert.equal(await totalOf(h, `/v1/teams/${open.body.id}/members`), 1);
      assert.equal(await totalOf(h, '/v1/me/join-requests', other.token), 0);
      assert.equal(await totalOf(h, threads), 1);
      assert.equal(await totalOf(h, posts), 1);
    } finally {
      await h.close();
    }
  });

  it('charges nothing when rate limiting is disabled', async () => {
    const h = await squeezed(['socialInitiation', 'teamCreation', 'teamJoin', 'forumThreadCreation', 'forumPostCreation'], false);
    try {
      const alice = await h.makeUser('ca-off-alice');
      const bob = await h.makeUser('ca-off-bob');
      const carol = await h.makeUser('ca-off-carol');
      const headers = ip('192.0.2.120');
      const as = { token: alice.token, headers };
      // Each category twice from one account and one address: a one-request budget would refuse
      // the second of every pair if it were being charged.
      assert.equal((await h.json('POST', `/v1/social/follows/${bob.userId}`, as)).status, 200);
      assert.equal((await h.json('POST', '/v1/social/friend-requests', { ...as, body: { addresseeId: carol.userId } })).status, 201);
      const own = await createTeam(h, alice.token, 'ca-off-1', 'public', headers);
      assert.equal(own.status, 201);
      assert.equal((await createTeam(h, alice.token, 'ca-off-2', 'public', headers)).status, 201);
      const bobTeam1 = await createTeam(h, bob.token, 'ca-off-bob-1');
      const bobTeam2 = await createTeam(h, bob.token, 'ca-off-bob-2');
      assert.equal((await h.json('POST', `/v1/teams/${bobTeam1.body.id}/members`, as)).status, 201);
      assert.equal((await h.json('POST', `/v1/teams/${bobTeam2.body.id}/join-requests`, as)).status, 201);
      const threads = `/v1/teams/${own.body.id}/forum/threads`;
      const thread = await h.json('POST', threads, { ...as, body: { title: 'one', body: 'x' } });
      assert.equal(thread.status, 201);
      assert.equal((await h.json('POST', threads, { ...as, body: { title: 'two', body: 'x' } })).status, 201);
      const posts = `${threads}/${thread.body.thread.id}/posts`;
      assert.equal((await h.json('POST', posts, { ...as, body: { body: 'a' } })).status, 201);
      assert.equal((await h.json('POST', posts, { ...as, body: { body: 'b' } })).status, 201);
    } finally {
      await h.close();
    }
  });
});

describe('community admission OpenAPI contract', () => {
  it('documents 429 on every metered community route', async () => {
    const h = await startHarness();
    try {
      const spec = (await h.json('GET', '/v1/openapi.json')).body;
      for (const path of [
        '/v1/social/follows/{playerId}',
        '/v1/social/friend-requests',
        '/v1/teams',
        '/v1/teams/{id}/members',
        '/v1/teams/{id}/join-requests',
        '/v1/teams/{id}/forum/threads',
        '/v1/teams/{id}/forum/threads/{threadId}/posts',
      ]) {
        assert.ok(spec.paths[path]?.post?.responses?.['429'], `${path} POST must document 429`);
      }
    } finally {
      await h.close();
    }
  });
});
