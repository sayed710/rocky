import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Termination } from '@chess-platform/game';
import { upcast, type ClaimedTerminalEvent, type TerminalConsumer, type TerminalEventFailure, type TerminalEventInbox, type TerminalEventLease, type TerminalEventPosition, type TerminalEventWork } from '../event-store';
import { assertTerminalConsumer, terminalDeadline, terminalRetryDelay, TERMINAL_LEASE_MS, TERMINAL_MAX_FAILURES } from '../terminal-event-retry';

interface TerminalRow {
  game_id: string;
  seq: number;
  event_version: number;
  payload: unknown;
  server_ts: Date;
}

/** Event rows remain the work source. Short claim transactions serialize with completion. */
export class PgTerminalEventInbox implements TerminalEventInbox {
  /** Production uses database time. An injected clock lets integration tests advance without sleeps. */
  constructor(private readonly pool: Pool, private readonly now?: () => number) {}

  claimAfter(consumer: TerminalConsumer, after: TerminalEventPosition | null): Promise<ClaimedTerminalEvent | undefined> {
    return this.claim(consumer, after, false);
  }

  claimBefore(consumer: TerminalConsumer, before: TerminalEventPosition): Promise<ClaimedTerminalEvent | undefined> {
    return this.claim(consumer, before, true);
  }

  private clockValue(): Date | null {
    if (!this.now) return null;
    const now = this.now();
    terminalDeadline(now, TERMINAL_LEASE_MS);
    return new Date(now);
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async claim(consumer: TerminalConsumer, cursor: TerminalEventPosition | null, reverse: boolean): Promise<ClaimedTerminalEvent | undefined> {
    assertTerminalConsumer(consumer);
    const time = this.clockValue();
    return this.transaction(async (client) => {
      // Lock the event before inspecting/updating its scheduling row. Completion takes the same
      // lock; the following statement's fresh READ COMMITTED snapshot sees a just-written receipt.
      // SKIP LOCKED avoids waiting on another claimant. Released before any analysis begins.
      const result = await client.query<TerminalRow>(
        `SELECT ended.game_id, ended.seq, ended.event_version, ended.payload, ended.server_ts
         FROM game_events AS ended
         LEFT JOIN terminal_event_retries AS retry
           ON retry.consumer = $1 AND retry.game_id = ended.game_id AND retry.seq = ended.seq
         WHERE ended.type = 'GameEnded'
           AND ($2::uuid IS NULL OR (ended.game_id, ended.seq) ${reverse ? '<' : '>'} ($2::uuid, $3::integer))
           AND NOT EXISTS (SELECT 1 FROM terminal_event_receipts AS receipt
             WHERE receipt.consumer = $1 AND receipt.game_id = ended.game_id AND receipt.seq = ended.seq)
           AND (retry.next_retry_at IS NULL OR retry.next_retry_at <= COALESCE($4::timestamptz, statement_timestamp()))
           AND (retry.lease_until IS NULL OR retry.lease_until <= COALESCE($4::timestamptz, statement_timestamp()))
         ORDER BY ended.game_id ${reverse ? 'DESC' : 'ASC'}, ended.seq ${reverse ? 'DESC' : 'ASC'}
         LIMIT 1 FOR UPDATE OF ended SKIP LOCKED`,
        [consumer, cursor?.gameId ?? null, cursor?.seq ?? null, time],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const token = randomUUID();
      const leased = await client.query(
        `INSERT INTO terminal_event_retries (consumer, game_id, seq, next_retry_at, lease_token, lease_until)
         SELECT $1, $2, $3, COALESCE($5::timestamptz, statement_timestamp()), $4,
                COALESCE($5::timestamptz, statement_timestamp()) + $6 * interval '1 millisecond'
         WHERE NOT EXISTS (SELECT 1 FROM terminal_event_receipts WHERE consumer = $1 AND game_id = $2 AND seq = $3)
         ON CONFLICT (consumer, game_id, seq) DO UPDATE
         SET lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until
         WHERE terminal_event_retries.next_retry_at <= COALESCE($5::timestamptz, statement_timestamp())
           AND (terminal_event_retries.lease_until IS NULL OR terminal_event_retries.lease_until <= COALESCE($5::timestamptz, statement_timestamp()))
         RETURNING seq`,
        [consumer, row.game_id, row.seq, token, time, TERMINAL_LEASE_MS],
      );
      if (!leased.rowCount) return undefined;
      return { work: decodeTerminalRow(row), lease: { consumer, gameId: row.game_id, seq: Number(row.seq), token } };
    });
  }

  async renew(lease: TerminalEventLease): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE terminal_event_retries SET lease_until = COALESCE($5::timestamptz, statement_timestamp()) + $6 * interval '1 millisecond'
         WHERE consumer = $1 AND game_id = $2 AND seq = $3 AND lease_token = $4
           AND lease_until > COALESCE($5::timestamptz, statement_timestamp()) RETURNING seq`,
        [lease.consumer, lease.gameId, lease.seq, lease.token, this.clockValue(), TERMINAL_LEASE_MS],
      );
      return result.rowCount === 1;
    });
  }

  async acknowledge(lease: TerminalEventLease): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query('SELECT 1 FROM game_events WHERE game_id = $1 AND seq = $2 FOR UPDATE', [lease.gameId, lease.seq]);
      const owned = await client.query(
        `DELETE FROM terminal_event_retries
         WHERE consumer = $1 AND game_id = $2 AND seq = $3 AND lease_token = $4
           AND lease_until > COALESCE($5::timestamptz, statement_timestamp()) RETURNING seq`,
        [lease.consumer, lease.gameId, lease.seq, lease.token, this.clockValue()],
      );
      if (!owned.rowCount) return false;
      await client.query(
        `INSERT INTO terminal_event_receipts (consumer, game_id, seq) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [lease.consumer, lease.gameId, lease.seq],
      );
      return true;
    });
  }

  async fail(lease: TerminalEventLease): Promise<TerminalEventFailure | undefined> {
    return this.transaction(async (client) => {
      // The fencing token and row lock count a replayed failure exactly once. A crash increments nothing.
      const owned = await client.query<{ failures: number; now: Date }>(
        `SELECT failures, COALESCE($5::timestamptz, statement_timestamp()) AS now FROM terminal_event_retries
         WHERE consumer = $1 AND game_id = $2 AND seq = $3 AND lease_token = $4
           AND lease_until > COALESCE($5::timestamptz, statement_timestamp()) FOR UPDATE`,
        [lease.consumer, lease.gameId, lease.seq, lease.token, this.clockValue()],
      );
      const row = owned.rows[0];
      if (!row) return undefined;
      const failures = Math.min(row.failures + 1, TERMINAL_MAX_FAILURES);
      const nextRetryAt = terminalDeadline(row.now.getTime(), terminalRetryDelay(failures));
      await client.query(
        `UPDATE terminal_event_retries SET failures = $5, next_retry_at = $6, lease_token = NULL, lease_until = NULL
         WHERE consumer = $1 AND game_id = $2 AND seq = $3 AND lease_token = $4`,
        [lease.consumer, lease.gameId, lease.seq, lease.token, failures, new Date(nextRetryAt)],
      );
      return { failures, nextRetryAt };
    });
  }
}

const TERMINATIONS: Readonly<Record<Termination, true>> = {
  checkmate: true, resignation: true, timeout: true, stalemate: true, agreement: true,
  insufficient_material: true, fifty_move: true, threefold: true, variant: true,
  aborted: true, no_show: true,
};

function decodeTerminalRow(row: TerminalRow): TerminalEventWork {
  try {
    const event = upcast('GameEnded', Number(row.event_version), row.payload);
    if (!event || event.type !== 'GameEnded' || !['1-0', '0-1', '1/2-1/2', '*'].includes(event.result)
      || !Object.hasOwn(TERMINATIONS, event.termination)
      || !['w', 'b', null].includes(event.winner)
      || !Number.isSafeInteger(event.at) || event.at < 0) {
      throw new Error('invalid terminal event shape');
    }
    return { stored: { gameId: row.game_id, seq: Number(row.seq), version: Number(row.event_version), event, serverTs: row.server_ts.getTime() } };
  } catch {
    return { gameId: row.game_id, seq: Number(row.seq), decodeError: 'invalid committed terminal event' };
  }
}
