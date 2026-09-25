import type { GameEndedEvent } from '@chess-platform/game';
import type { TerminalEventInbox } from '@chess-platform/persistence';
import { gamesEndedChannel, type PubSub } from '@chess-platform/realtime-gateway';

interface ReconcilerOptions {
  readonly scanIntervalMs?: number;
  readonly onError?: (gameId: string, error: unknown) => void;
}

/** Replays committed endings until an idempotent consumer confirms each one. */
export class TerminalEventReconciler {
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanInFlight: Promise<void> | undefined;

  constructor(
    private readonly pubsub: PubSub,
    private readonly inbox: TerminalEventInbox,
    private readonly consumer: string,
    private readonly consume: (gameId: string, ending: GameEndedEvent) => Promise<void>,
    private readonly options: ReconcilerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
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
    let cursor: { gameId: string; seq: number } | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await this.inbox.pendingAfter(this.consumer, cursor, 100);
      if (page.length === 0) return;
      for (const stored of page) {
        cursor = { gameId: stored.gameId, seq: stored.seq };
        try {
          if (stored.event.type !== 'GameEnded') throw new Error('terminal inbox returned a non-terminal event');
          await this.consume(stored.gameId, stored.event);
          await this.inbox.acknowledge(this.consumer, stored.gameId, stored.seq);
        } catch (error) {
          this.report(stored.gameId, error);
        }
      }
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private report(gameId: string, error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(gameId, error);
      else console.error(`TerminalEventReconciler(${this.consumer}): ${gameId}`, error);
    } catch {
      console.error(`TerminalEventReconciler(${this.consumer}): error hook failed for ${gameId}`, error);
    }
  }
}
