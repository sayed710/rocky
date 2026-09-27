import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GambitClient } from '../src/api/client.js';
import { MessagesController } from '../src/app/messages-controller.js';
import { mountConversation, mountMessagesInbox } from '../src/app/messaging-mounts.js';

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

test('inbox waits for session restoration and disposal prevents its delayed request', async () => {
  const restored = deferred();
  let requests = 0;
  const client = {
    session: { current: null },
    messages: {
      listConversations: async () => {
        requests += 1;
        return { total: 0, items: [] };
      },
    },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;

  const controller = mountMessagesInbox({
    doc: emptyDocument(),
    client,
    sessionPresent: false,
    restorePromise: restored.promise,
  });
  assert.equal(requests, 0);

  controller.dispose();
  restored.resolve();
  await restored.promise;
  await Promise.resolve();
  assert.equal(requests, 0);
});

test('a message submitted during session restoration waits and sends the retained draft once', async () => {
  const restored = deferred();
  const session: { current: { user: { id: string } } | null } = { current: null };
  let sends = 0;
  const composer = { onsubmit: null as ((event: Event) => void) | null };
  const input = { value: 'Hello while restoring', disabled: false, focus: () => {} };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'conversation-composer') return composer;
      if (id === 'composer-input') return input;
      return null;
    },
  } as unknown as Document;
  const client = {
    session,
    messages: {
      send: async () => {
        sends += 1;
        return {};
      },
      conversation: async () => ({ id: 'c-1', participantA: 'a', participantB: 'b' }),
      messages: async () => ({ total: 0, items: [] }),
      markRead: async () => ({}),
    },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;

  const controller = mountConversation({
    doc,
    client,
    conversationId: 'c-1',
    sessionPresent: false,
    restorePromise: restored.promise,
  });
  try {
    composer.onsubmit?.({ preventDefault: () => {} } as Event);
    composer.onsubmit?.({ preventDefault: () => {} } as Event);
    assert.equal(sends, 0, 'an unavailable session must not attempt an authenticated send');
    assert.equal(input.value, 'Hello while restoring');
    assert.equal(input.disabled, true);

    session.current = { user: { id: 'a' } };
    restored.resolve();
    await restored.promise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends, 1, 'the queued draft is sent only once after restoration');
    assert.equal(input.value, '');
    assert.equal(input.disabled, false);
  } finally {
    controller.dispose();
  }
});

test('an abandoned restore cannot leave a later composer disabled or change its draft', async () => {
  const restored = deferred();
  let firstSends = 0;
  let secondSends = 0;
  let focused = 0;
  const composer = { onsubmit: null as ((event: Event) => void) | null };
  const input = {
    value: 'old draft',
    disabled: false,
    focus: () => { focused += 1; },
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'conversation-composer') return composer;
      if (id === 'composer-input') return input;
      return null;
    },
  } as unknown as Document;
  const client = (onSend: () => void, current: { user: { id: string } } | null) => ({
    session: { current },
    messages: {
      send: async () => { onSend(); throw new Error('network down'); },
      conversation: async () => ({ id: 'c-1', participantA: 'a', participantB: 'b' }),
      messages: async () => ({ total: 0, items: [] }),
      markRead: async () => ({}),
    },
    graphql: { resolvePlayers: async () => new Map() },
  }) as unknown as GambitClient;

  const first = mountConversation({
    doc,
    client: client(() => { firstSends += 1; }, null),
    conversationId: 'c-1',
    sessionPresent: false,
    restorePromise: restored.promise,
  });
  composer.onsubmit?.({ preventDefault: () => {} } as Event);
  assert.equal(input.disabled, true);
  first.dispose();

  const second = mountConversation({
    doc,
    client: client(() => { secondSends += 1; }, { user: { id: 'a' } }),
    conversationId: 'c-1',
    sessionPresent: true,
    restorePromise: Promise.resolve(),
  });
  try {
    assert.equal(input.disabled, false, 'a new mount owns an enabled composer');
    input.value = 'new draft';
    restored.resolve();
    await restored.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstSends, 0);
    assert.equal(input.value, 'new draft');
    assert.equal(input.disabled, false);
    assert.equal(focused, 0, 'the abandoned mount must not focus the new view');

    composer.onsubmit?.({ preventDefault: () => {} } as Event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSends, 1);
    assert.equal(input.value, 'new draft');
  } finally {
    second.dispose();
  }
});

test('disposing a pending conversation unbinds its form without focusing an abandoned view', async () => {
  const restored = deferred();
  let sends = 0;
  let focused = 0;
  const composer = { onsubmit: null as ((event: Event) => void) | null };
  const input = {
    value: 'unsent draft',
    disabled: false,
    focus: () => { focused += 1; },
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'conversation-composer') return composer;
      if (id === 'composer-input') return input;
      return null;
    },
  } as unknown as Document;
  const client = {
    session: { current: null },
    messages: { send: async () => { sends += 1; return {}; } },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;
  const controller = mountConversation({
    doc,
    client,
    conversationId: 'c-1',
    sessionPresent: false,
    restorePromise: restored.promise,
  });

  composer.onsubmit?.({ preventDefault: () => {} } as Event);
  assert.equal(input.disabled, true);
  controller.dispose();
  assert.equal(composer.onsubmit, null, 'the abandoned form cannot accept another submit');
  assert.equal(input.disabled, false, 'a later route cannot inherit a locked composer');
  restored.resolve();
  await restored.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(focused, 0);
  assert.equal(input.value, 'unsent draft');
});

test('re-mounting a conversation replaces its composer handler and retains text on failure', async () => {
  let firstSends = 0;
  let secondSends = 0;
  let focused = 0;
  const composer = { onsubmit: null as ((event: Event) => void) | null };
  const input = {
    value: '  message worth keeping  ',
    disabled: false,
    focus: () => {
      focused += 1;
    },
  };
  const doc = {
    getElementById: (id: string) => {
      if (id === 'conversation-composer') return composer;
      if (id === 'composer-input') return input;
      return null;
    },
  } as unknown as Document;
  const neverRestored = new Promise<void>(() => {});
  const client = (onSend: () => void) => ({
    session: { current: { user: { id: 'a' } } },
    messages: {
      send: async () => {
        onSend();
        throw new Error('network down');
      },
    },
    graphql: { resolvePlayers: async () => new Map() },
  }) as unknown as GambitClient;

  const first = mountConversation({
    doc,
    client: client(() => {
      firstSends += 1;
    }),
    conversationId: 'c-1',
    sessionPresent: true,
    restorePromise: neverRestored,
  });
  const second = mountConversation({
    doc,
    client: client(() => {
      secondSends += 1;
    }),
    conversationId: 'c-1',
    sessionPresent: true,
    restorePromise: neverRestored,
  });

  composer.onsubmit?.({ preventDefault: () => {} } as Event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstSends, 0);
  assert.equal(secondSends, 1);
  assert.equal(input.value, '  message worth keeping  ');
  assert.equal(input.disabled, false);
  assert.equal(focused, 1);
  first.dispose();
  second.dispose();
});

test('disposing a messages controller clears conversation polling', () => {
  let cleared: ReturnType<typeof setInterval> | null = null;
  const timer = 7 as unknown as ReturnType<typeof setInterval>;
  const controller = new MessagesController({
    client: {} as unknown as GambitClient,
    callbacks: { onInbox: () => {}, onThread: () => {}, onLoading: () => {}, onError: () => {} },
    setInterval: () => timer,
    clearInterval: (id) => {
      cleared = id;
    },
  });

  controller.startPolling('c-1');
  controller.dispose();
  assert.equal(cleared, timer);
});
