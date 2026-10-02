import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GambitClient } from '../src/api/client.js';
import { createI18nManager } from '../src/i18n/index.js';
import { mountForum, mountForumThread } from '../src/app/forum-mounts.js';

const defaultI18n = createI18nManager();

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptyDocument(): Document {
  return { getElementById: () => null } as unknown as Document;
}

function forumClient(
  createThread: () => Promise<never>,
  createPost: () => Promise<never>,
): GambitClient {
  return {
    session: { current: { user: { id: 'viewer' } } },
    teams: {
      byId: async () => ({ id: 'team-1', name: 'Team one' }),
      threads: async () => ({ total: 0, items: [] }),
      members: async () => ({ total: 1, items: [{ playerId: 'viewer' }] }),
      thread: async () => ({ id: 'thread-1', title: 'Topic', locked: false, deletedAt: null }),
      posts: async () => ({ total: 0, items: [] }),
      createThread,
      createPost,
    },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;
}

async function settleRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('forum waits for session restoration and disposal prevents its delayed request', async () => {
  const restored = deferred();
  let requests = 0;
  const client = {
    session: { current: null },
    teams: {
      byId: async () => {
        requests += 1;
        throw new Error('unexpected request');
      },
    },
  } as unknown as GambitClient;

  const controller = mountForum({
    doc: emptyDocument(),
    client,
    slug: 'private-team',
    sessionPresent: false,
    restorePromise: restored.promise,
    i18n: defaultI18n,
  });
  assert.equal(requests, 0);

  controller.dispose();
  restored.resolve();
  await restored.promise;
  await Promise.resolve();
  assert.equal(requests, 0);
});

test('re-mounting a forum replaces its composer handler and retains text on failure', async () => {
  let firstCreates = 0;
  let secondCreates = 0;
  let focused = 0;
  const form = { hidden: false, onsubmit: null as ((event: Event) => void) | null };
  const titleInput = {
    value: '  Worth keeping  ',
    disabled: false,
    focus: () => {
      focused += 1;
    },
  };
  const bodyInput = { value: '  Draft body  ', disabled: false };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'thread-form') return form;
      if (id === 'thread-title-input') return titleInput;
      if (id === 'thread-body-input') return bodyInput;
      return null;
    },
  } as unknown as Document;
  const failure = async (): Promise<never> => {
    throw new Error('network down');
  };

  const first = mountForum({
    doc,
    client: forumClient(async () => {
      firstCreates += 1;
      return failure();
    }, failure),
    slug: 'team-one',
    sessionPresent: true,
    restorePromise: Promise.resolve(),
    i18n: defaultI18n,
  });
  const second = mountForum({
    doc,
    client: forumClient(async () => {
      secondCreates += 1;
      return failure();
    }, failure),
    slug: 'team-one',
    sessionPresent: true,
    restorePromise: Promise.resolve(),
    i18n: defaultI18n,
  });
  await settleRequests();

  form.onsubmit?.({ preventDefault: () => {} } as Event);
  await settleRequests();

  assert.equal(firstCreates, 0);
  assert.equal(secondCreates, 1);
  assert.equal(titleInput.value, '  Worth keeping  ');
  assert.equal(bodyInput.value, '  Draft body  ');
  assert.equal(titleInput.disabled, false);
  assert.equal(bodyInput.disabled, false);
  assert.equal(focused, 1);
  first.dispose();
  second.dispose();
});

test('re-mounting a thread replaces its reply handler and retains text on failure', async () => {
  let firstReplies = 0;
  let secondReplies = 0;
  let focused = 0;
  const form = { hidden: false, onsubmit: null as ((event: Event) => void) | null };
  const input = {
    value: '  Reply worth keeping  ',
    disabled: false,
    focus: () => {
      focused += 1;
    },
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'reply-form') return form;
      if (id === 'reply-input') return input;
      return null;
    },
  } as unknown as Document;
  const failure = async (): Promise<never> => {
    throw new Error('network down');
  };

  const first = mountForumThread({
    doc,
    client: forumClient(failure, async () => {
      firstReplies += 1;
      return failure();
    }),
    slug: 'team-one',
    threadId: 'thread-1',
    sessionPresent: true,
    restorePromise: Promise.resolve(),
    i18n: defaultI18n,
  });
  const second = mountForumThread({
    doc,
    client: forumClient(failure, async () => {
      secondReplies += 1;
      return failure();
    }),
    slug: 'team-one',
    threadId: 'thread-1',
    sessionPresent: true,
    restorePromise: Promise.resolve(),
    i18n: defaultI18n,
  });
  await settleRequests();

  form.onsubmit?.({ preventDefault: () => {} } as Event);
  await settleRequests();

  assert.equal(firstReplies, 0);
  assert.equal(secondReplies, 1);
  assert.equal(input.value, '  Reply worth keeping  ');
  assert.equal(input.disabled, false);
  assert.equal(focused, 1);
  first.dispose();
  second.dispose();
});
