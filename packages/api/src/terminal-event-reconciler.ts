import type { GameEndedEvent } from '@chess-platform/game';
import { TERMINAL_RENEW_MS, TERMINAL_RENEW_TIMEOUT_MS, type ClaimedTerminalEvent, type TerminalConsumer, type TerminalEventFailure, type TerminalEventInbox, type TerminalEventLease } from '@chess-platform/persistence';
import { safeTrustFailureCode } from './trust-failure-code';
import { gamesEndedChannel, type PubSub } from '@chess-platform/realtime-gateway';

export interface TerminalReconcilerErrorMetadata {
  readonly consumer: TerminalConsumer;
  readonly seq: number;
  readonly errorClass: 'decode-error' | 'consumer-error' | 'acknowledgement-error' | 'retry-store-error' | 'lease-lost';
  readonly retry?: TerminalEventFailure;
}

interface ReconcilerOptions {
  readonly scanIntervalMs?: number;
  readonly onError?: (gameId: string, error: unknown, metadata?: TerminalReconcilerErrorMetadata) => void;
}

/** Replays committed endings until an idempotent consumer confirms each one. */
export class TerminalEventReconciler {
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanInFlight: Promise<void> | undefined;
  /** Retained across bounded scans so a persistent failure prefix cannot starve later rows. */
  private cursor: { gameId: string; seq: number } | null = null;
  /** Independent descending sweep of the finite range below a busy forward cursor. */
  private reverseCursor: { gameId: string; seq: number } | undefined;
  /** Set by stop(): no further game is started, so shutdown waits for at most the current one. */
  private stopping = false;

  constructor(
    private readonly pubsub: PubSub,
    private readonly inbox: TerminalEventInbox,
    private readonly consumer: TerminalConsumer,
    private readonly consume: (gameId: string, ending: GameEndedEvent, signal: AbortSignal, lease: TerminalEventLease) => Promise<void>,
    private readonly options: ReconcilerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.stopping = false;
    this.unsubscribe = this.pubsub.subscribe(gamesEndedChannel(), (message) => {
      if (message.t === 'ended') void this.scan().catch((error) => this.report('', error));
    });
    const intervalMs = this.options.scanIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.scan().catch((error) => this.report('', error));
      }, intervalMs);
      this.timer.unref?.();
    }
    await this.scan();
  }

  async scan(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    const current = this.scanNow();
    this.scanInFlight = current;
    try {
      await current;
    } finally {
      this.scanInFlight = undefined;
    }
  }

  private async scanNow(): Promise<void> {
    await this.scanOlderWork();
    for (let items = 0; items < 1_000; items += 1) {
      if (this.stopping) return;
      const claim = await this.inbox.claimAfter(this.consumer, this.cursor);
      if (!claim) {
        this.cursor = null;
        this.reverseCursor = undefined;
        return;
      }
      if (this.stopping) return; // A claim in flight when stopped expires without counting a failure.
      this.cursor = { gameId: claim.lease.gameId, seq: claim.lease.seq };
      await this.processWork(claim);
    }
  }

  private async scanOlderWork(): Promise<void> {
    if (!this.cursor) return;
    this.reverseCursor ??= this.cursor;
    for (let items = 0; items < 100; items += 1) {
      if (this.stopping) return;
      const claim = await this.inbox.claimBefore(this.consumer, this.reverseCursor);
      if (!claim) {
        this.reverseCursor = undefined;
        return;
      }
      if (this.stopping) return;
      this.reverseCursor = { gameId: claim.lease.gameId, seq: claim.lease.seq };
      await this.processWork(claim);
    }
  }

  private async processWork({ work, lease }: ClaimedTerminalEvent): Promise<void> {
    const { gameId, seq } = lease;
    const controller = new AbortController();
    let closed = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const loseLease = (): void => controller.abort(new Error('terminal lease ownership lost'));
    const schedule = (): void => {
      refresh = setTimeout(() => {
        timeout = setTimeout(loseLease, TERMINAL_RENEW_TIMEOUT_MS);
        void this.inbox.renew(lease).then((owned) => {
          if (!owned) loseLease();
        }, loseLease).finally(() => {
          if (timeout) clearTimeout(timeout);
          if (!closed && !controller.signal.aborted) schedule();
        });
      }, TERMINAL_RENEW_MS);
      refresh.unref?.();
    };
    schedule();
    let errorClass: TerminalReconcilerErrorMetadata['errorClass'] = 'decode-error';
    try {
      if ('decodeError' in work) throw new Error('cannot decode committed ending');
      const stored = work.stored;
      if (stored.event.type !== 'GameEnded') throw new Error('terminal inbox returned a non-terminal event');
      errorClass = 'consumer-error';
      await this.consume(stored.gameId, stored.event, controller.signal, lease);
      controller.signal.throwIfAborted();
      errorClass = 'acknowledgement-error';
      if (!await this.inbox.acknowledge(lease)) throw new Error('terminal lease ownership lost before acknowledgement');
    } catch (error) {
      let retry: TerminalEventFailure | undefined;
      // Lease loss is not evidence of a consumer failure. Expiry recovers work without an increment.
      if (!controller.signal.aborted) {
        try { retry = await this.inbox.fail(lease); }
        catch (schedulingError) { this.report(gameId, schedulingError, { consumer: this.consumer, seq, errorClass: 'retry-store-error' }); }
      }
      this.report(gameId, error, { consumer: this.consumer, seq, errorClass: controller.signal.aborted ? 'lease-lost' : errorClass, ...(retry ? { retry } : {}) });
    } finally {
      closed = true;
      if (refresh) clearTimeout(refresh);
      if (timeout) clearTimeout(timeout);
      // Do not wait on an unavailable DB: the consumer has settled and the fencing token protects
      // any late renewal. The promise already has both rejection handlers attached.
    }
  }

  /**
   * Stop waking and scanning, and resolve once the game being processed, if any, has finished.
   * A killed process leaves an unacknowledged lease, recoverable after its expiry.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanInFlight?.catch(() => undefined);
  }

  private report(gameId: string, error: unknown, metadata?: TerminalReconcilerErrorMetadata): void {
    try {
      if (this.options.onError) this.options.onError(gameId, error, metadata);
      else console.error('Terminal reconciliation failed', { consumer: this.consumer, gameId, ...metadata, failureCode: safeTrustFailureCode(error) });
    } catch {
      console.error('Terminal reconciliation error hook failed', { consumer: this.consumer, gameId });
    }
  }
}
