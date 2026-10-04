import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { borrowClient } from '../src/pg/abortable-client';

test('aborted queued acquisition releases its eventual allocation exactly once without issuing queries', async () => {
  let allocate!: (client: PoolClient) => void;
  const releases: boolean[] = [];
  const client = { release: (destroy: boolean) => releases.push(destroy) } as unknown as PoolClient;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { allocate = resolve; }) } as Pool;
  const controller = new AbortController();
  const pending = borrowClient(pool, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  allocate(client);
  await Promise.resolve();
  assert.deepEqual(releases, [true]);
});

test('returning a borrowed client removes cancellation ownership before another caller can reuse it', async () => {
  const releases: boolean[] = [];
  const client = { release: (destroy: boolean) => releases.push(destroy) } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pool;
  const controller = new AbortController();
  const borrowed = await borrowClient(pool, controller.signal);
  borrowed.release();
  controller.abort();
  borrowed.release();
  assert.deepEqual(releases, [false]);
});

test('active cancellation destroys only its own client and release remains idempotent', async () => {
  const releases: boolean[] = [];
  const client = { release: (destroy: boolean) => releases.push(destroy) } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pool;
  const controller = new AbortController();
  const borrowed = await borrowClient(pool, controller.signal);
  controller.abort();
  borrowed.release();
  assert.deepEqual(releases, [true]);
});
