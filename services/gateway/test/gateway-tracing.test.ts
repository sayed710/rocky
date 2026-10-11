/**
 * Hermetic tests for gateway tracing and traceparent propagation (ADR-0062).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import type { TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryPubSub,
  InMemoryEventLog,
  LocalCommandRouter,
} from '@chess-platform/realtime-gateway';
import {
  RecordingTracer,
  InMemorySpanRecorder,
  formatTraceparent,
} from '@chess-platform/api';
import { OwnerCommandConsumer, TracingCommandRouter } from '../src/command-forwarder.js';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

function setupTestEnvironment() {
  const recorder = new InMemorySpanRecorder();
  const tracer = new RecordingTracer({ sink: recorder.record });
  const pubsub = new InMemoryPubSub();
  const store = new InMemoryEventLog();
  const authority = new GameAuthority(pubsub, () => Date.now(), store);

  const fakeRedis = {
    eval: async (script: string) => script.startsWith('-- r03-start') ? 'admitted' : 1,
  } as unknown as Redis;

  return { recorder, tracer, authority, fakeRedis };
}

test('TracingCommandRouter records gateway.command span for local routing', async () => {
  const { recorder, tracer, authority } = setupTestEnvironment();
  const gameId = 'g-tracing-local';

  await authority.createGame({
    gameId,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const localRouter = new LocalCommandRouter(authority);
  const router = new TracingCommandRouter(localRouter, tracer);

  const result = await router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  assert.equal(result.state.ply, 1);

  const spans = recorder.spans();
  assert.equal(spans.length, 1);
  const span = spans[0]!;

  assert.equal(span.name, 'gateway.command');
  assert.equal(span.kind, 'server');
  assert.equal(span.status, 'ok');
  assert.equal(span.attributes['cmd.kind'], 'move');
  assert.equal(span.attributes['cmd.outcome'], 'ok');

  // PII discipline: span attributes bypass JsonLogger's redaction, so the game id, user id and
  // move payload must appear in neither the keys NOR the values. Checking keys alone would pass
  // even if the uci were recorded under an innocuous name like `cmd.detail`.
  const serialisedAttrs = JSON.stringify(span.attributes);
  for (const secret of [gameId, 'alice', 'e2e4']) {
    assert.equal(
      serialisedAttrs.includes(secret),
      false,
      `span attributes must not contain "${secret}", found in ${serialisedAttrs}`,
    );
  }
});

test('Forwarded command with valid traceparent produces child span on receiving side', async () => {
  const { recorder, tracer, authority, fakeRedis } = setupTestEnvironment();
  const gameId = 'g-tracing-forward-child';

  await authority.createGame({
    gameId,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const consumer = new OwnerCommandConsumer(authority, fakeRedis, tracer);

  const parentTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentSpanId = '00f067aa0ba902b7';
  const traceparent = formatTraceparent({
    traceId: parentTraceId,
    spanId: parentSpanId,
    sampled: true,
  });

  const envelope = {
    version: 2,
    requestId: 'req-1',
    gameId,
    userId: 'alice',
    cmd: { kind: 'move', uci: 'e2e4' },
    responseKey: 'game:resp:req-1',
    traceparent,
  };

  // Process command as the receiving node
  // @ts-expect-error accessing private method for unit test
  await consumer.processCommand(JSON.stringify(envelope));

  const spans = recorder.spans();
  assert.equal(spans.length, 1);
  const span = spans[0]!;

  assert.equal(span.name, 'gateway.command');
  assert.equal(span.traceId, parentTraceId, 'Child span must share the parent trace id');
  assert.equal(span.parentId, parentSpanId, 'Child span parentId must match forwarder span id');
  assert.equal(span.status, 'ok');
  assert.equal(span.attributes['cmd.kind'], 'move');
  assert.equal(span.attributes['cmd.outcome'], 'ok');
});

test('Forwarded command with NO traceparent starts a new root span', async () => {
  const { recorder, tracer, authority, fakeRedis } = setupTestEnvironment();
  const gameId = 'g-tracing-no-traceparent';

  await authority.createGame({
    gameId,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const consumer = new OwnerCommandConsumer(authority, fakeRedis, tracer);

  const envelope = {
    version: 2,
    requestId: 'req-2',
    gameId,
    userId: 'alice',
    cmd: { kind: 'resign' },
    responseKey: 'game:resp:req-2',
  };

  // @ts-expect-error accessing private method for unit test
  await consumer.processCommand(JSON.stringify(envelope));

  const spans = recorder.spans();
  assert.equal(spans.length, 1);
  const span = spans[0]!;

  assert.equal(span.name, 'gateway.command');
  assert.ok(/^[0-9a-f]{32}$/.test(span.traceId), 'Must generate valid 32-hex traceId');
  assert.equal(span.parentId, null, 'Root span must have null parentId');
  assert.equal(span.status, 'ok');
  assert.equal(span.attributes['cmd.kind'], 'resign');
  assert.equal(span.attributes['cmd.outcome'], 'ok');
});

test('Forwarded command with malformed traceparent is ignored and does not throw', async () => {
  const { recorder, tracer, authority, fakeRedis } = setupTestEnvironment();
  const gameId = 'g-tracing-malformed-traceparent';

  await authority.createGame({
    gameId,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const consumer = new OwnerCommandConsumer(authority, fakeRedis, tracer);

  const envelope = {
    version: 2,
    requestId: 'req-3',
    gameId,
    userId: 'alice',
    cmd: { kind: 'abort' },
    responseKey: 'game:resp:req-3',
    traceparent: 'invalid-traceparent-header-format',
  };

  // @ts-expect-error accessing private method for unit test
  await consumer.processCommand(JSON.stringify(envelope));

  const spans = recorder.spans();
  assert.equal(spans.length, 1);
  const span = spans[0]!;

  assert.equal(span.name, 'gateway.command');
  assert.ok(/^[0-9a-f]{32}$/.test(span.traceId));
  assert.equal(span.parentId, null, 'Malformed traceparent falls back to root span');
  assert.equal(span.attributes['cmd.kind'], 'abort');
});

test('Span attributes never contain PII or unbounded fields', async () => {
  const { recorder, tracer, authority, fakeRedis } = setupTestEnvironment();
  const gameId = 'g-tracing-pii-check';

  await authority.createGame({
    gameId,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });

  const consumer = new OwnerCommandConsumer(authority, fakeRedis, tracer);

  const envelope = {
    version: 2,
    requestId: 'req-4',
    gameId,
    userId: 'secret-user-123',
    cmd: { kind: 'move', uci: 'g1f3' },
    responseKey: 'game:resp:req-4',
  };

  // @ts-expect-error accessing private method for unit test
  await consumer.processCommand(JSON.stringify(envelope));

  const span = recorder.spans()[0]!;
  const keys = Object.keys(span.attributes);

  for (const key of keys) {
    assert.ok(
      key === 'cmd.kind' || key === 'cmd.outcome' || key === 'cmd.error_code',
      `Unexpected attribute key: ${key}`,
    );
  }
  assert.equal('secret-user-123' in span.attributes, false);
  assert.equal('g1f3' in span.attributes, false);
});
