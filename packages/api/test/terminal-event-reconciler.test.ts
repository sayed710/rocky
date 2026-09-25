import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredEvent, TerminalEventInbox } from '@chess-platform/persistence';
import { InMemoryPubSub } from '@chess-platform/realtime-gateway';
import { TerminalEventReconciler } from '../src/terminal-event-reconciler';

test('a bounded scan advances past failure and later scans retry durable pending work', async () => {
  const rows: StoredEvent[] = Array.from({ length: 1_101 }, (_, number) => ({
    gameId: `game-${String(number).padStart(4, '0')}`,
    seq: 1,
    version: 1,
    serverTs: number,
    event: { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: number },
  }));
  const acknowledged = new Set<string>();
  const inbox: TerminalEventInbox = {
    pendingAfter: async (_consumer, after, limit) => rows
      .filter(({ gameId }) => !acknowledged.has(gameId) && (after === null || gameId > after.gameId))
      .slice(0, limit)
      .map((stored) => ({ stored })),
    acknowledge: async (_consumer, gameId) => { acknowledged.add(gameId); },
  };
  let failures = 0;
  const worker = new TerminalEventReconciler(
    new InMemoryPubSub(), inbox, 'test-analysis', async (gameId) => {
      if (gameId === rows[0]!.gameId && failures++ === 0) throw new Error('transient');
    },
    { scanIntervalMs: 0, onError: () => undefined },
  );
  await worker.start();
  assert.equal(acknowledged.size, 999, 'one scan processes at most ten 100-row pages, including a failed row');
  assert.equal(acknowledged.has(rows[0]!.gameId), false);
  await worker.scan();
  assert.equal(acknowledged.size, rows.length - 1, 'the next scan drains later rows before wrapping');
  await worker.scan();
  assert.equal(acknowledged.size, rows.length, 'a wrapped scan retries the earlier failure');
  worker.stop();
});

test('a thousand persistent failures cannot starve a later committed ending', async () => {
  const rows: StoredEvent[] = Array.from({ length: 1_001 }, (_, number) => ({
    gameId: `game-${String(number).padStart(4, '0')}`,
    seq: 1,
    version: 1,
    serverTs: number,
    event: { type: 'GameEnded', result: '1-0', termination: 'resignation', winner: 'w', at: number },
  }));
  const acknowledged = new Set<string>();
  const inbox: TerminalEventInbox = {
    pendingAfter: async (_consumer, after, limit) => rows
      .filter(({ gameId }) => !acknowledged.has(gameId) && (after === null || gameId > after.gameId))
      .slice(0, limit)
      .map((stored) => ({ stored })),
    acknowledge: async (_consumer, gameId) => { acknowledged.add(gameId); },
  };
  const worker = new TerminalEventReconciler(
    new InMemoryPubSub(), inbox, 'test-analysis', async (gameId) => {
      if (gameId !== rows.at(-1)!.gameId) throw new Error('persistent failure');
    },
    { scanIntervalMs: 0, onError: () => undefined },
  );
  await worker.start();
  assert.equal(acknowledged.size, 0);
  await worker.scan();
  assert.deepEqual([...acknowledged], [rows.at(-1)!.gameId]);
  worker.stop();
});
