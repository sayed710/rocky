import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { PgSeekAcceptor, PgSeeksRepository } from '../src/pg/repositories';

test('PgSeeksRepository findById rejects malformed UUIDs before querying PostgreSQL', async () => {
  let queryCount = 0;
  const pool = {
    query: async (): Promise<never> => {
      queryCount += 1;
      throw new Error('malformed seek id must not reach PostgreSQL');
    },
  } as unknown as Pool;
  const seeks = new PgSeeksRepository(pool);

  assert.equal(await seeks.findById('not-a-uuid'), null);
  assert.equal(queryCount, 0);
});

test('PgSeeksRepository cleanup uses the database clock for expiry decisions', async () => {
  let capturedSql = '';
  let capturedValues: readonly unknown[] = [];
  const pool = {
    query: async (sql: string, values: readonly unknown[]): Promise<object> => {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const seeks = new PgSeeksRepository(pool);

  await seeks.cleanup(new Date('2999-01-01T00:00:00.000Z'));

  assert.match(capturedSql, /created_at\s*<=\s*NOW\(\)\s*-\s*\$1::interval/);
  assert.deepEqual(capturedValues, ['600 seconds']);
});

test('PgSeeksRepository listOpen explicitly orders receipts before deterministic open seeks', async () => {
  let capturedSql = '';
  const pool = {
    query: async (sql: string): Promise<object> => {
      capturedSql = sql;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const seeks = new PgSeeksRepository(pool);

  await seeks.listOpen(10, '00000000-0000-0000-0000-000000000001');

  const sql = capturedSql.replace(/\s+/g, ' ').trim();
  assert.match(sql, /SELECT 0 AS result_kind/);
  assert.match(sql, /ORDER BY s\.accepted_at DESC, s\.created_at DESC, s\.id DESC LIMIT 1/);
  assert.match(sql, /SELECT 1 AS result_kind/);
  assert.match(sql, /ORDER BY s\.created_at ASC, s\.id ASC LIMIT \$1/);
  assert.match(
    sql,
    /\) AS ordered_seeks ORDER BY result_kind ASC, created_at ASC, id ASC$/,
    'the outer query must define the order of the UNION ALL result',
  );
});

test('PgSeekAcceptor preserves the transaction failure when rollback also fails', async () => {
  const transactionFailure = new Error('connection lost during seek claim');
  const rollbackFailure = new Error('connection unavailable during rollback');
  const client = {
    query: async (sql: string): Promise<never | object> => {
      if (sql === 'BEGIN') return {};
      if (sql === 'ROLLBACK') throw rollbackFailure;
      throw transactionFailure;
    },
    release: (): void => {},
  } as unknown as PoolClient;
  const pool = {
    connect: async (): Promise<PoolClient> => client,
  } as unknown as Pool;
  const acceptor = new PgSeekAcceptor(pool);

  await assert.rejects(
    acceptor.accept('seek-id', 'game-id', [], {
      id: 'game-id',
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: 'creator-id',
      blackId: 'acceptor-id',
      startedAt: new Date(0),
    }),
    (error: unknown) => error === transactionFailure,
  );
});
