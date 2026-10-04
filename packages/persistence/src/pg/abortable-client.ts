import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Cancellation owns only this borrowed connection. It destroys its socket,
 * rejects active queries, and waits for their callers to drain; it never races
 * a write against a timeout or closes another pool user's connection. */
export async function borrowClient(pool: Pool, signal?: AbortSignal): Promise<{ client: PoolClient; release: () => void }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let client: PoolClient | undefined;
    let released = false;
    const release = (destroy = false) => {
      signal?.removeEventListener('abort', abort);
      if (client && !released) { released = true; client.release(destroy); }
    };
    const abort = () => {
      release(true);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    // An aborted waiter issues no query. Its eventual allocation must still be
    // released, and both eventual resolution and rejection are observed.
    void pool.connect().then(acquired => {
      client = acquired;
      if (signal?.aborted) { release(true); reject(signal.reason); return; }
      resolve({ client, release: () => release() });
    }, error => { release(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export async function abortableQuery<Row extends QueryResultRow = QueryResultRow>(pool: Pool, signal: AbortSignal | undefined,
  text: string, values?: unknown[]): Promise<QueryResult<Row>> {
  if (!signal) return pool.query<Row>(text, values);
  const borrowed = await borrowClient(pool, signal);
  try { signal.throwIfAborted(); return await borrowed.client.query<Row>(text, values); }
  finally { borrowed.release(); }
}
