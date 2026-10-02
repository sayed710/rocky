import type { ClaimedTerminalEvent, TerminalConsumer, TerminalEventFailure, TerminalEventInbox, TerminalEventLease, TerminalEventPosition, TerminalEventWork } from './event-store';
import { assertTerminalConsumer, terminalDeadline, terminalRetryDelay, TERMINAL_LEASE_MS, TERMINAL_MAX_FAILURES } from './terminal-event-retry';

interface RetryState {
  failures: number;
  nextRetryAt: number;
  token?: string;
  leaseUntil?: number;
}

/** Shared deterministic queue for tests/dev. Claims and fencing mirror PostgreSQL semantics. */
export class InMemoryTerminalEventInbox implements TerminalEventInbox {
  private readonly receipts = new Set<string>();
  private readonly retries = new Map<string, RetryState>();
  private tokens = 0;

  constructor(private readonly rows: readonly TerminalEventWork[], private readonly now: () => number = Date.now) {}

  private key(consumer: TerminalConsumer, position: TerminalEventPosition): string {
    return JSON.stringify([consumer, position.gameId, position.seq]);
  }

  claimAfter(consumer: TerminalConsumer, after: TerminalEventPosition | null): Promise<ClaimedTerminalEvent | undefined> {
    return Promise.resolve(this.claim(consumer, after, false));
  }

  claimBefore(consumer: TerminalConsumer, before: TerminalEventPosition): Promise<ClaimedTerminalEvent | undefined> {
    return Promise.resolve(this.claim(consumer, before, true));
  }

  private claim(consumer: TerminalConsumer, cursor: TerminalEventPosition | null, reverse: boolean): ClaimedTerminalEvent | undefined {
    assertTerminalConsumer(consumer);
    const now = this.now();
    const leaseUntil = terminalDeadline(now, TERMINAL_LEASE_MS);
    const rows = [...this.rows].sort((a, b) => compare(position(a), position(b)) * (reverse ? -1 : 1));
    for (const work of rows) {
      const pos = position(work);
      if (cursor && (reverse ? compare(pos, cursor) >= 0 : compare(pos, cursor) <= 0)) continue;
      const key = this.key(consumer, pos);
      const state = this.retries.get(key);
      if (this.receipts.has(key) || (state && (state.nextRetryAt > now || (state.leaseUntil ?? 0) > now))) continue;
      const token = String(++this.tokens);
      this.retries.set(key, { failures: state?.failures ?? 0, nextRetryAt: state?.nextRetryAt ?? now, token, leaseUntil });
      return { work, lease: { consumer, ...pos, token } };
    }
    return undefined;
  }

  private owned(lease: TerminalEventLease): RetryState | undefined {
    const state = this.retries.get(this.key(lease.consumer, lease));
    return state?.token === lease.token && (state.leaseUntil ?? 0) > this.now() ? state : undefined;
  }

  renew(lease: TerminalEventLease): Promise<boolean> {
    const state = this.owned(lease);
    if (!state) return Promise.resolve(false);
    state.leaseUntil = terminalDeadline(this.now(), TERMINAL_LEASE_MS);
    return Promise.resolve(true);
  }

  acknowledge(lease: TerminalEventLease): Promise<boolean> {
    if (!this.owned(lease)) return Promise.resolve(false);
    const key = this.key(lease.consumer, lease);
    this.receipts.add(key);
    this.retries.delete(key);
    return Promise.resolve(true);
  }

  fail(lease: TerminalEventLease): Promise<TerminalEventFailure | undefined> {
    const state = this.owned(lease);
    if (!state) return Promise.resolve(undefined);
    state.failures = Math.min(state.failures + 1, TERMINAL_MAX_FAILURES);
    state.nextRetryAt = terminalDeadline(this.now(), terminalRetryDelay(state.failures));
    delete state.token;
    delete state.leaseUntil;
    return Promise.resolve({ failures: state.failures, nextRetryAt: state.nextRetryAt });
  }
}

function position(work: TerminalEventWork): TerminalEventPosition {
  return 'stored' in work ? work.stored : work;
}

function compare(a: TerminalEventPosition, b: TerminalEventPosition): number {
  return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.seq - b.seq;
}
