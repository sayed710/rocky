import type { GameResult } from '@chess-platform/tournament';
import type { ResultString } from '@chess-platform/game';
import { type PubSub, gameChannel } from '@chess-platform/realtime-gateway';
import type { EventStore, TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';
import type { TournamentService } from './service';
import type { ArenaService } from './arena.service';

function tournamentOutcome(result: ResultString): GameResult | '*' {
  switch (result) {
    case '*': return '*';
    case '1-0': return 'white_win';
    case '0-1': return 'black_win';
    case '1/2-1/2': return 'draw';
    default: throw new Error(`unknown durable game result: ${String(result)}`);
  }
}

export interface ReporterOptions {
  /**
   * How often to re-scan running tournaments for games launched by OTHER
   * processes (e.g. an API replica handling POST /start). The launcher
   * callback only covers games launched inside this process, and the startup
   * scan only covers games that existed at boot — the periodic scan closes
   * the gap. Pass 0 to disable the timer (tests call `scan()` directly).
   */
  readonly scanIntervalMs?: number;
}

/**
 * Reconciles committed terminal events for every linked tournament game.
 * Broadcasts only wake the durable read; startup and periodic scans recover lost wakes.
 */
export class TournamentResultReporter {
  private static readonly MAX_PROCESSED = 10_000;
  /** In-flight subscriptions, keyed by gameId, for stop() and cleanup. */
  private readonly subscriptions = new Map<string, () => void>();
  private readonly processed = new Set<string>();
  private scanInFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly scanIntervalMs: number;

  constructor(
    private readonly pubsub: PubSub,
    private readonly repo: TournamentsRepository,
    private readonly tournamentService: TournamentService,
    private readonly arenaService: ArenaService,
    private readonly events: EventStore,
    options: ReporterOptions = {}
  ) {
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
  }

  /** Reconcile durable endings before accepting periodic wake-ups. */
  async start(): Promise<void> {
    if (this.scanIntervalMs > 0 && this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.scan().catch((err: unknown) => {
          console.error('TournamentResultReporter: periodic scan failed:', err);
        });
      }, this.scanIntervalMs);
      this.timer.unref?.();
    }
    await this.scan();
  }

  async scan(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    const running = this.scanNow();
    this.scanInFlight = running;
    try {
      await running;
    } finally {
      this.scanInFlight = undefined;
    }
  }

  /** Keyset pagination avoids silently excluding older running tournaments. */
  private async scanNow(): Promise<void> {
    let afterId: string | null = null;
    for (;;) {
      const ids = await this.repo.listRunningIdsAfter(afterId, 100);
      if (ids.length === 0) return;
      for (const id of ids) {
        const stored = await this.repo.findById(id);
        if (!stored || stored.snapshot.state !== 'running') continue;
        for (const [, gameId] of stored.snapshot.gameLinks ?? []) {
          this.watch(id, gameId);
          try {
            await this.reconcile(id, gameId);
          } catch (error) {
            console.error(`TournamentResultReporter: cannot reconcile game ${gameId}:`, error);
          }
        }
      }
      afterId = ids[ids.length - 1]!;
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
    this.processed.clear();
  }

  watch(tournamentId: string, gameId: string): void {
    if (this.processed.has(gameId) || this.subscriptions.has(gameId)) return;
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
      if (msg.t !== 'ended') return;
      void this.reconcile(tournamentId, gameId).catch((error: unknown) => {
        console.error(`TournamentResultReporter: cannot reconcile game ${gameId}:`, error);
      });
    });
    this.subscriptions.set(gameId, unsubscribe);
  }

  private async reconcile(tournamentId: string, gameId: string): Promise<void> {
    if (this.processed.has(gameId)) return;
    const stored = await this.repo.findById(tournamentId);
    if (!stored) return;
    if (!(stored.snapshot.gameLinks ?? []).some(([, linked]) => linked === gameId)) return;
    const ending = (await this.events.load(gameId)).find(({ event }) => event.type === 'GameEnded')?.event;
    if (ending?.type !== 'GameEnded') return;
    const isArena = isArenaSnapshot(stored.snapshot);
    const mapped = tournamentOutcome(ending.result);
    if (isArena) {
      await this.arenaService.recordCommittedOutcome(tournamentId, gameId, mapped);
    } else {
      await this.tournamentService.recordCommittedOutcome(tournamentId, gameId, mapped);
    }
    if (this.processed.size >= TournamentResultReporter.MAX_PROCESSED) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
    this.processed.add(gameId);
    this.subscriptions.get(gameId)?.();
    this.subscriptions.delete(gameId);
  }
}
