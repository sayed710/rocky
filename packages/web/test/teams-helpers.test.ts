import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamAction, membershipOf, actionExplanation, createJoinRequestQueue } from '../src/app/teams-helpers.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { TeamMembership, TeamView } from '../src/api/models.js';

const testI18n = createI18nManager();

function team(visibility: 'public' | 'private'): TeamView {
  return {
    id: 't1',
    slug: 'city-chess',
    name: 'City Chess',
    description: 'A club',
    visibility,
    // Deliberately someone who is NOT in the member list below: the creator is not necessarily the
    // current owner, and nothing may key off this field.
    createdBy: 'u-founder',
    createdAt: '2026-08-04T00:00:00Z',
  };
}

function member(playerId: string, role: 'owner' | 'admin' | 'member'): TeamMembership {
  return { teamId: 't1', playerId, role, joinedAt: '2026-08-04T00:00:00Z' };
}

test('a signed-out viewer is offered nothing and told why', () => {
  const action = teamAction(team('public'), null, null);
  assert.deepEqual(action, { kind: 'none', reason: 'signed-out' });
  assert.match(actionExplanation('signed-out', testI18n), /sign in/i);
});

test('a non-member can join a public team', () => {
  assert.deepEqual(teamAction(team('public'), null, 'u-me'), { kind: 'join' });
});

test('a non-member is not offered join on a private team', () => {
  // POST /v1/teams/:id/members answers 403 for a private team, so a Join button here would
  // always fail. Join requests are a separate feature that does not exist yet.
  const action = teamAction(team('private'), null, 'u-me');
  assert.deepEqual(action, { kind: 'none', reason: 'by-request' });
  assert.match(actionExplanation('by-request', testI18n), /request/i);
});

test('an ordinary member can leave, on a public or a private team', () => {
  const members = [member('u-other', 'owner'), member('u-me', 'member')];
  assert.deepEqual(teamAction(team('public'), 'member', 'u-me'), { kind: 'leave' });
  // Membership is checked before visibility: being in a private team still lets you out of it.
  assert.deepEqual(teamAction(team('private'), 'member', 'u-me'), { kind: 'leave' });
});

test('an admin can leave like any other member', () => {
  assert.deepEqual(teamAction(team('public'), 'admin', 'u-me'), { kind: 'leave' });
});

test('the owner is not offered leave, and ownership is read from the role not createdBy', () => {
  // DELETE answers 409 for the owner until ownership is transferred. `createdBy` is 'u-founder'
  // here while the viewer is the actual owner, so a check against createdBy would offer Leave to
  // the one person the server refuses.
  assert.deepEqual(teamAction(team('public'), 'owner', 'u-me'), { kind: 'none', reason: 'owner' });
  assert.match(actionExplanation('owner', testI18n), /transfer/i);

  // And the founder, now a plain member, can leave.
  assert.deepEqual(teamAction(team('public'), 'member', 'u-founder'), { kind: 'leave' });
});

/**
 * The regression this signature change exists for. `teamAction` used to search the member list the
 * page had fetched, which is capped at 50 and sorted owner → admin → member — so an ordinary member
 * of a team with more than a page of members was not in it, and the page offered them a Join button
 * for a team they were already in. Found in the review of PR #93.
 *
 * The role now arrives from the server on the team detail response, so the answer no longer depends
 * on whether the viewer happened to land on the page the client read.
 */
test('a member of a team larger than one page is still offered leave, not join', () => {
  assert.deepEqual(teamAction(team('public'), 'member', 'u-me-on-page-2'), { kind: 'leave' });
  assert.deepEqual(teamAction(team('private'), 'admin', 'u-me-on-page-2'), { kind: 'leave' });
});

test('membershipOf finds the viewer and returns null when absent or signed out', () => {
  const members = [member('u-a', 'owner'), member('u-b', 'member')];
  assert.equal(membershipOf(members, 'u-b')?.role, 'member');
  assert.equal(membershipOf(members, 'u-c'), null);
  assert.equal(membershipOf(members, null), null);
});

test('createJoinRequestQueue: render() renders queue not busy', () => {
  const sequence: boolean[] = [];
  const queue = createJoinRequestQueue({
    renderQueue: (busy) => sequence.push(busy),
    respond: async () => true,
  });

  queue.render();
  assert.deepEqual(sequence, [false]);
});

test('createJoinRequestQueue: respond resolving true renders busy once and does not render not-busy afterwards', async () => {
  const sequence: boolean[] = [];
  const queue = createJoinRequestQueue({
    renderQueue: (busy) => sequence.push(busy),
    respond: async () => true,
  });

  await queue.respond('r1', 'accepted');
  assert.deepEqual(sequence, [true], 'Successful response must render busy=true and not repaint not-busy');
});

test('createJoinRequestQueue: respond resolving false renders busy, then not-busy', async () => {
  const sequence: boolean[] = [];
  const queue = createJoinRequestQueue({
    renderQueue: (busy) => sequence.push(busy),
    respond: async () => false,
  });

  await queue.respond('r1', 'accepted');
  assert.deepEqual(sequence, [true, false], 'Failed response must render busy=true then busy=false');
});

test('createJoinRequestQueue: respond rejecting renders busy, then not-busy, and rethrows error', async () => {
  const sequence: boolean[] = [];
  const queue = createJoinRequestQueue({
    renderQueue: (busy) => sequence.push(busy),
    respond: async () => {
      throw new Error('API failure');
    },
  });

  await assert.rejects(
    async () => queue.respond('r1', 'accepted'),
    { message: 'API failure' },
  );
  assert.deepEqual(sequence, [true, false], 'Rejection must render busy=true then busy=false');
});
