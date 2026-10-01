import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToPath } from '../src/app/router.js';
import {
  getOtherParticipantId,
  getMessageDisplayBody,
  truncatePreview,
} from '../src/app/messages-helpers.js';
import { MessagesController } from '../src/app/messages-controller.js';
import { formatInboxTimestamp } from '../src/app/messages-view.js';
import { createI18nManager } from '../src/i18n/index.js';
import type { ConversationView, MessageView } from '../src/api/models.js';
import type { GambitClient } from '../src/api/client.js';

const testI18n = createI18nManager();

test('router parses /messages and /messages/:id routes', () => {
  assert.deepEqual(parseRoute('/messages'), { name: 'messages' });
  assert.deepEqual(parseRoute('/messages/c-123'), { name: 'conversation', id: 'c-123' });
  assert.deepEqual(parseRoute('/messages/c%20456'), { name: 'conversation', id: 'c 456' });
});

test('router serializes messages and conversation routes', () => {
  assert.equal(routeToPath({ name: 'messages' }), '/messages');
  assert.equal(routeToPath({ name: 'conversation', id: 'c-123' }), '/messages/c-123');
});

test('getOtherParticipantId derives other participant correctly', () => {
  const conv: ConversationView = {
    id: 'conv-1',
    participantA: 'user-alice',
    participantB: 'user-bob',
    createdAt: '2026-08-04T00:00:00Z',
    lastMessageAt: '2026-08-04T00:00:00Z',
  };

  // Caller is participantA -> other is participantB
  assert.equal(getOtherParticipantId(conv, 'user-alice'), 'user-bob');
  // Caller is participantB -> other is participantA
  assert.equal(getOtherParticipantId(conv, 'user-bob'), 'user-alice');
});

test('getMessageDisplayBody returns message body or tombstone placeholder', () => {
  const normalMsg: MessageView = {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-alice',
    body: 'Hello there!',
    sentAt: '2026-08-04T00:00:00Z',
    editedAt: null,
    deletedAt: null,
  };
  assert.equal(getMessageDisplayBody(normalMsg, testI18n), 'Hello there!');

  const tombstoneMsg: MessageView = {
    id: 'msg-2',
    conversationId: 'conv-1',
    senderId: 'user-alice',
    body: '',
    sentAt: '2026-08-04T00:01:00Z',
    editedAt: null,
    deletedAt: '2026-08-04T00:02:00Z',
  };
  assert.equal(getMessageDisplayBody(tombstoneMsg, testI18n), '[Message deleted]');
});

test('truncatePreview truncates text exceeding max length', () => {
  assert.equal(truncatePreview('Short text', 50), 'Short text');
  const longText = 'This is a very long message body that exceeds fifty characters easily';
  const truncated = truncatePreview(longText, 20);
  assert.equal(truncated, 'This is a very long …');
});

test('sending a message in an open conversation preserves active thread polling', async () => {
  let activeCallback: (() => void) | null = null;
  let activeTimerId: number | null = null;
  let nextId = 1;

  const fakeSetInterval = (fn: () => void, _ms: number) => {
    const id = nextId++;
    activeTimerId = id;
    activeCallback = fn;
    return id as unknown as ReturnType<typeof setInterval>;
  };

  const fakeClearInterval = (id: ReturnType<typeof setInterval>) => {
    if (activeTimerId === (id as unknown as number)) {
      activeTimerId = null;
      activeCallback = null;
    }
  };

  let threadCallbackCount = 0;

  const stubClient = {
    messages: {
      send: async () => ({ id: 'msg-1' }),
      messages: async () => ({
        total: 1,
        items: [
          {
            id: 'msg-1',
            conversationId: 'c-1',
            senderId: 'u-1',
            body: 'hello',
            sentAt: '2026-08-04T12:00:00Z',
            editedAt: null,
            deletedAt: null,
          },
        ],
      }),
      markRead: async () => ({}),
    },
    graphql: {
      resolvePlayers: async () => new Map(),
    },
  } as any;

  const controller = new MessagesController({
    client: stubClient,
    callbacks: {
      onInbox: () => {},
      onThread: () => {
        threadCallbackCount++;
      },
      onLoading: () => {},
      onError: () => {},
    },
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  controller.startPolling('c-1');
  assert.notEqual(activeTimerId, null, 'timer should be registered after startPolling');
  assert.notEqual(activeCallback, null, 'timer callback should be set');

  await controller.send('c-1', 'hello world');

  assert.notEqual(activeTimerId, null, 'timer should remain active after sending a message');
  assert.notEqual(activeCallback, null, 'timer callback should remain set after sending a message');

  const prevCount = threadCallbackCount;
  // The controller registers `() => void poll()`, so the callback returns undefined synchronously —
  // awaiting it does NOT await the poll's own `messages` + `resolvePlayers` hops. Flush the
  // microtask queue with a macrotask so those settle before asserting.
  activeCallback!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(threadCallbackCount, prevCount + 1, 'polling callback should still trigger onThread after send');
});

test('formatInboxTimestamp formats today as time, older as short date, and unparseable as raw input', () => {
  const nowMs = new Date('2026-08-04T12:00:00Z').getTime();

  const todayIso = '2026-08-04T10:30:00Z';
  const todayFormatted = formatInboxTimestamp(todayIso, nowMs);
  assert.ok(todayFormatted.includes('30') || todayFormatted.includes('10'), 'today timestamp should render clock time');

  const olderIso = '2026-07-15T10:30:00Z';
  const olderFormatted = formatInboxTimestamp(olderIso, nowMs);
  assert.ok(!olderFormatted.includes('10:30'), 'older timestamp should not render time-only');

  const unparseable = 'not-a-valid-date';
  assert.equal(formatInboxTimestamp(unparseable, nowMs), 'not-a-valid-date');
});

test('send reports failure so a caller can keep the text it took from the user', async () => {
  // The composer clears its input only on a true return. Before `send` reported an outcome, it
  // cleared first and a failed request silently destroyed whatever the user had typed.
  const failing = {
    messages: {
      send: async () => {
        throw new Error('network down');
      },
    },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;

  let reportedError: string | null = null;
  const controller = new MessagesController({
    client: failing,
    callbacks: {
      onInbox: () => {},
      onThread: () => {},
      onLoading: () => {},
      onError: (msg) => {
        reportedError = msg;
      },
    },
  });

  assert.equal(await controller.send('c-1', 'text worth keeping'), false);
  assert.equal(reportedError, 'network down');
});

test('send reports success when the message lands', async () => {
  const ok = {
    messages: {
      send: async () => ({ id: 'm-1' }),
      conversation: async () => ({
        id: 'c-1',
        participantA: 'u-1',
        participantB: 'u-2',
        createdAt: '2026-08-04T12:00:00Z',
        lastMessageAt: '2026-08-04T12:00:00Z',
      }),
      messages: async () => ({ total: 0, items: [] }),
      markRead: async () => ({}),
    },
    session: { current: null },
    graphql: { resolvePlayers: async () => new Map() },
  } as unknown as GambitClient;

  const controller = new MessagesController({
    client: ok,
    callbacks: { onInbox: () => {}, onThread: () => {}, onLoading: () => {}, onError: () => {} },
  });

  assert.equal(await controller.send('c-1', 'hello'), true);
});
