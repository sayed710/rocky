import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canStartThread,
  canReply,
  abilityExplanation,
  sortThreads,
  postDisplayBody,
  threadDisplayTitle,
} from '../src/app/forum-helpers.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { ForumPost, ForumThread, TeamMembership } from '../src/api/models.js';

const testI18n = createI18nManager();

function member(playerId: string, role: 'owner' | 'admin' | 'member' = 'member'): TeamMembership {
  return { teamId: 't1', playerId, role, joinedAt: '2026-08-04T00:00:00Z' };
}

function thread(over: Partial<ForumThread> = {}): ForumThread {
  return {
    id: 'th1',
    teamId: 't1',
    authorId: 'u-author',
    title: 'A thread',
    createdAt: '2026-08-04T10:00:00Z',
    lastPostAt: '2026-08-04T10:00:00Z',
    locked: false,
    pinned: false,
    deletedAt: null,
    ...over,
  };
}

function post(over: Partial<ForumPost> = {}): ForumPost {
  return {
    id: 'p1',
    threadId: 'th1',
    authorId: 'u-author',
    body: 'Hello',
    createdAt: '2026-08-04T10:00:00Z',
    editedAt: null,
    deletedAt: null,
    ...over,
  };
}

test('starting a thread is refused when signed out and when not a member', () => {
  // POST .../forum/threads answers 403 "Only team members can create threads", so a control shown
  // to either of these would always fail.
  assert.deepEqual(canStartThread([member('u-me')], null), { kind: 'denied', reason: 'signed-out' });
  assert.deepEqual(canStartThread([member('u-other')], 'u-me'), { kind: 'denied', reason: 'not-member' });
});

test('a member may start a thread', () => {
  assert.deepEqual(canStartThread([member('u-me')], 'u-me'), { kind: 'allowed' });
});

test('replying needs membership AND an unlocked thread', () => {
  const open = thread();
  const locked = thread({ locked: true });

  assert.deepEqual(canReply(open, [member('u-me')], null), { kind: 'denied', reason: 'signed-out' });
  assert.deepEqual(canReply(open, [member('u-other')], 'u-me'), { kind: 'denied', reason: 'not-member' });
  assert.deepEqual(canReply(open, [member('u-me')], 'u-me'), { kind: 'allowed' });
  // The single condition that most often surprises: a member still cannot reply to a locked thread.
  assert.deepEqual(canReply(locked, [member('u-me')], 'u-me'), { kind: 'denied', reason: 'locked' });
});

test('a non-member on a locked thread is told about membership, not the lock', () => {
  // Both are true; the membership one is the reason that would still block them if it unlocked.
  assert.deepEqual(canReply(thread({ locked: true }), [member('u-other')], 'u-me'), {
    kind: 'denied',
    reason: 'not-member',
  });
});

test('every refusal has a sentence that names the actual obstacle', () => {
  assert.match(abilityExplanation('signed-out', testI18n), /sign in/i);
  assert.match(abilityExplanation('not-member', testI18n), /member/i);
  assert.match(abilityExplanation('locked', testI18n), /locked/i);
});

test('threads sort pinned first, then most recently active', () => {
  const older = thread({ id: 'a', lastPostAt: '2026-08-01T00:00:00Z' });
  const newer = thread({ id: 'b', lastPostAt: '2026-08-04T00:00:00Z' });
  const pinnedOld = thread({ id: 'c', lastPostAt: '2026-07-01T00:00:00Z', pinned: true });

  assert.deepEqual(sortThreads([older, newer, pinnedOld]).map((t) => t.id), ['c', 'b', 'a']);
});

test('sortThreads does not mutate the page it was given', () => {
  const input = [thread({ id: 'a' }), thread({ id: 'b', pinned: true })];
  sortThreads(input);
  assert.deepEqual(input.map((t) => t.id), ['a', 'b']);
});

test('a deleted post shows a placeholder, never its body', () => {
  assert.equal(postDisplayBody(post({ body: 'still here' }), testI18n), 'still here');
  assert.equal(postDisplayBody(post({ body: 'secret', deletedAt: '2026-08-04T11:00:00Z' }), testI18n), '[Post deleted]');
});

test('a deleted thread shows a placeholder, never its title', () => {
  assert.equal(threadDisplayTitle(thread({ title: 'Normal' }), testI18n), 'Normal');
  assert.equal(threadDisplayTitle(thread({ title: 'Secret', deletedAt: '2026-08-04T11:00:00Z' }), testI18n), '[Thread deleted]');
});
