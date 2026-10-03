import type { PoolClient } from 'pg';
import type { TerminalConsumer, TerminalEventLease } from '../event-store';
import { PersistenceError } from '../errors';
import { terminalDeadline, TERMINAL_LEASE_MS } from '../terminal-event-retry';

/** Trust-worker writes carry the claim that authorized their analysis. */
export interface TerminalReportFence {
  readonly lease: TerminalEventLease;
  readonly signal?: AbortSignal;
  /** Production uses PostgreSQL time; tests can advance expiry while a write is in flight. */
  readonly now?: () => number;
}

export function validateTerminalReportFence(
  fence: TerminalReportFence | undefined,
  consumer: TerminalConsumer,
  records: readonly { readonly gameId: string }[],
): void {
  if (!fence) return;
  fence.signal?.throwIfAborted();
  if (fence.lease.consumer !== consumer || records.some((record) => record.gameId !== fence.lease.gameId)) {
    throw new PersistenceError('terminal report fence does not match the report batch');
  }
}

function clockValue(fence: TerminalReportFence): Date | null {
  if (!fence.now) return null;
  const now = fence.now();
  terminalDeadline(now, TERMINAL_LEASE_MS);
  return new Date(now);
}

/** Called after BEGIN. Never hold these locks during engine or bot analysis. */
export async function lockTerminalReportFence(client: PoolClient, fence: TerminalReportFence): Promise<void> {
  fence.signal?.throwIfAborted();
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
  // Match claim/acknowledgement ordering so a competing completion cannot deadlock this writer.
  await client.query('SELECT 1 FROM game_events WHERE game_id = $1 AND seq = $2 FOR UPDATE',
    [fence.lease.gameId, fence.lease.seq]);
  await assertTerminalReportFence(client, fence);
}

/** Recheck immediately before COMMIT using a fresh statement time, retaining the same locks. */
export async function assertTerminalReportFence(client: PoolClient, fence: TerminalReportFence): Promise<void> {
  fence.signal?.throwIfAborted();
  const { lease } = fence;
  const owned = await client.query(
    `SELECT 1 FROM terminal_event_retries AS retry
     WHERE retry.consumer = $1 AND retry.game_id = $2 AND retry.seq = $3 AND retry.lease_token = $4
       AND retry.lease_until > COALESCE($5::timestamptz, statement_timestamp())
       AND NOT EXISTS (SELECT 1 FROM terminal_event_receipts AS receipt
         WHERE receipt.consumer = $1 AND receipt.game_id = $2 AND receipt.seq = $3)
     FOR UPDATE OF retry`,
    [lease.consumer, lease.gameId, lease.seq, lease.token, clockValue(fence)],
  );
  if (owned.rowCount !== 1) throw new PersistenceError('terminal report lease ownership lost');
  fence.signal?.throwIfAborted();
}
