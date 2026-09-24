import { ArenaTournament, type ArenaConfig } from '@chess-platform/tournament';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot, PlayerLockUnavailableError, VersionConflictError } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';

import type { GameResult } from '@chess-platform/tournament';
import type { GameLauncher } from './launcher';

export interface CreateArenaCommand {
  readonly id: string;
  readonly name: string;
  /**
   * Taken from `ArenaConfig`, the same way `timeControl` below already is, because that is where
   * this value is going and it is the only place entitled to say what it may be.
   *
   * It used to read `'standard' | 'chess960'`, which was wrong in both directions at once: it left
   * out the five variants an arena can genuinely run, and it named the one M15 Increment 14 stopped
   * anybody creating. The route cast into it, so the compiler was silenced rather than satisfied —
   * an atomic arena worked, while the type said it could not exist. Nothing branches on this field
   * yet, so nothing was mishandled; the cost was the next person to branch on it being told there
   * were two cases when there are seven. ADR-0123 §consequences.
   */
  readonly variant: ArenaConfig['variant'];
  readonly timeControl: ArenaConfig['timeControl'];
  readonly durationMs: number;
}

export class ArenaService {
  constructor(
    private readonly repo: TournamentsRepository,
    private readonly launcher: GameLauncher,
    private readonly clock: () => number
  ) {}

  async getTournament(id: string): Promise<ArenaTournament> {
    const stored = await this.repo.findById(id);
    if (!stored) throw HttpError.notFound('arena not found');
    if (!isArenaSnapshot(stored.snapshot)) throw HttpError.conflict('not an arena tournament');
    const arena = ArenaTournament.restore(stored.snapshot);
    const wasRunning = arena.getState() === 'running';
    arena.settle(this.clock());
    if (wasRunning && arena.getState() === 'finished') {
      try {
        await this.repo.save(arena.toSnapshot(), stored.version);
      } catch (e) {
        // A version conflict means someone else already settled or mutated the
        // arena — safe to serve the settled read. Anything else is a real
        // persistence failure and must propagate.
        if (!(e instanceof VersionConflictError)) throw e;
      }
    }
    return arena;
  }

  private async reconcileLaunch(arena: ArenaTournament): Promise<void> {
    const pairings = arena.pairAvailable(this.clock());
    for (const p of pairings) {
      if (!arena.gameIdFor(p.pairingId)) {
        const { gameId } = await this.launcher.launch({
          tournamentId: arena.config.id,
          matchId: p.pairingId,
          white: p.white,
          black: p.black,
          variant: arena.config.variant,
          timeControl: arena.config.timeControl,
          attempt: 0,
        });
        arena.linkGame(p.pairingId, gameId);
      }
    }
  }

  private async withRetry(
    id: string,
    action: (arena: ArenaTournament) => Promise<void> | void
  ): Promise<ArenaTournament> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stored = await this.repo.findById(id);
      if (!stored) {
        throw HttpError.notFound('Tournament not found');
      }
      if (!isArenaSnapshot(stored.snapshot)) {
        throw HttpError.conflict('Not an arena tournament');
      }
      const arena = ArenaTournament.restore(stored.snapshot);
      
      try {
        await action(arena);
        await this.repo.save(arena.toSnapshot(), stored.version);
        return arena;
      } catch (e: any) {
        if (e instanceof VersionConflictError) {
          if (attempt === 3) throw HttpError.conflict('Concurrent update failed after retries');
          continue;
        }
        if (e instanceof HttpError) throw e;
        if (e instanceof PlayerLockUnavailableError) throw e;
        // The arena domain throws 'Unknown gameId: <id>' for an unlinked game.
        if (e.message.includes('Unknown gameId')) {
          throw HttpError.notFound('Game ID not found in this tournament');
        }
        throw HttpError.conflict(e.message);
      }
    }
    throw HttpError.conflict('Concurrent update failed after retries');
  }

  async create(cmd: CreateArenaCommand): Promise<ArenaTournament> {
    const existing = await this.repo.findById(cmd.id);
    if (existing) {
      throw HttpError.conflict('Tournament ID already exists', { id: cmd.id });
    }

    const config: ArenaConfig = {
      id: cmd.id,
      name: cmd.name,
      format: 'arena',
      variant: cmd.variant,
      timeControl: cmd.timeControl,
      durationMs: cmd.durationMs,
    };

    const arena = new ArenaTournament(config);
    await this.repo.save(arena.toSnapshot(), 0);
    return arena;
  }

  async load(id: string): Promise<ArenaTournament> {
    const stored = await this.repo.findById(id);
    if (!stored) {
      throw HttpError.notFound('Tournament not found');
    }
    if (!isArenaSnapshot(stored.snapshot)) {
      throw HttpError.conflict('Not an arena tournament');
    }
    return ArenaTournament.restore(stored.snapshot);
  }

  async register(id: string, playerId: string): Promise<ArenaTournament> {
    return this.withRetry(id, async (arena) => {
      arena.register(playerId);
      await this.reconcileLaunch(arena);
    });
  }

  async withdraw(id: string, playerId: string): Promise<ArenaTournament> {
    return this.withRetry(id, (arena) => {
      arena.withdraw(playerId);
    });
  }

  async start(id: string, atMs: number): Promise<ArenaTournament> {
    return this.withRetry(id, async (arena) => {
      arena.start(atMs);
      await this.reconcileLaunch(arena);
    });
  }

  async getStandings(id: string) {
    const arena = await this.getTournament(id);
    return arena.standings();
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<ArenaTournament> {
    return this.withRetry(id, async (arena) => {
      arena.recordResultByGame(gameId, result, this.clock());
      await this.reconcileLaunch(arena);
    });
  }

  async abandonGame(id: string, gameId: string): Promise<ArenaTournament> {
    return this.withRetry(id, async (arena) => {
      arena.abandonGame(gameId);
      await this.reconcileLaunch(arena);
    });
  }
}
