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
    /** Only the in-memory repository uses this simulation clock. PostgreSQL ignores it. */
    private readonly clock?: () => number
  ) {}

  async getTournament(id: string): Promise<ArenaTournament> {
    return this.decide(id, (arena, nowMs) => arena.settle(nowMs));
  }

  /** Recover only pairings already committed by a database-time decision. */
  async reconcile(id: string): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    for (const [pairingId, p] of Object.entries(arena.toSnapshot().activeGames)) {
      if (!arena.gameIdFor(pairingId)) {
        const { gameId, terminalOutcome } = await this.launcher.launch({
          tournamentId: arena.config.id,
          matchId: pairingId,
          white: p.white,
          black: p.black,
          variant: arena.config.variant,
          timeControl: arena.config.timeControl,
          attempt: 0,
          committedArenaPairing: true,
          arenaLaunchNamespace: p.launchNamespace,
        });
        await this.decide(id, (current, nowMs) => {
          // A concurrent reporter may have resolved it while launch was in flight.
          if (!current.toSnapshot().activeGames[pairingId]) return;
          const existing = current.gameIdFor(pairingId);
          if (existing && existing !== gameId) throw new Error('Conflicting Arena game link');
          if (terminalOutcome !== undefined) {
            if (terminalOutcome === '*') current.abandonPairing(pairingId);
            else current.recordResult(pairingId, terminalOutcome, nowMs);
            current.pairAvailable(nowMs);
            return;
          }
          current.linkGame(pairingId, gameId);
        });
      }
    }
    return this.load(id);
  }

  private async decide(id: string, action: (arena: ArenaTournament, nowMs: number) => void): Promise<ArenaTournament> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const snapshot = await this.repo.mutateArena(id, (stored, nowMs) => {
          const arena = ArenaTournament.restore(stored);
          action(arena, nowMs);
          const snapshot = arena.toSnapshot();
          // Refuse invalid launcher links or mutations before they reach durable storage.
          ArenaTournament.restore(snapshot);
          return snapshot;
        }, this.clock);
        if (!snapshot) throw HttpError.notFound('Tournament not found');
        return ArenaTournament.restore(snapshot);
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
    await this.decide(id, (arena, nowMs) => {
      arena.register(playerId);
      arena.pairAvailable(nowMs);
    });
    return this.reconcile(id);
  }

  async withdraw(id: string, playerId: string): Promise<ArenaTournament> {
    return this.decide(id, (arena) => {
      arena.withdraw(playerId);
    });
  }

  async start(id: string, _atMs?: number): Promise<ArenaTournament> {
    await this.decide(id, (arena, nowMs) => {
      arena.start(nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.reconcile(id);
  }

  async getStandings(id: string) {
    const arena = await this.getTournament(id);
    return arena.standings();
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<ArenaTournament> {
    await this.decide(id, (arena, nowMs) => {
      arena.recordResultByGame(gameId, result, nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.reconcile(id);
  }

  /** A resolved arena link is absent on replay; CAS retries observe that absence as success. */
  async recordCommittedOutcome(id: string, gameId: string, result: GameResult | '*'): Promise<ArenaTournament> {
    await this.decide(id, (arena, nowMs) => {
      if (!arena.pairingForGame(gameId)) return;
      if (result === '*') arena.abandonGame(gameId);
      else arena.recordResultByGame(gameId, result, nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.reconcile(id);
  }

  async abandonGame(id: string, gameId: string): Promise<ArenaTournament> {
    await this.decide(id, (arena, nowMs) => {
      arena.abandonGame(gameId);
      arena.pairAvailable(nowMs);
    });
    return this.reconcile(id);
  }
}
