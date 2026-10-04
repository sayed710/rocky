import { ArenaTournament, type ArenaConfig } from '@chess-platform/tournament';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { ArenaFormatMismatchError, isArenaSnapshot, PlayerLockUnavailableError, VersionConflictError } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';

import type { GameResult } from '@chess-platform/tournament';
import type { GameLauncher } from './launcher';
import type { Logger } from '../ports/logger';
import { arenaFailureFields } from './arena-diagnostics';

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
    private readonly clock?: () => number,
    private readonly logger?: Logger
  ) {}

  async getTournament(id: string, signal?: AbortSignal): Promise<ArenaTournament> {
    signal?.throwIfAborted();
    let read;
    try { read = await this.repo.readArena(id, this.clock, signal); }
    catch (error) {
      if (error instanceof ArenaFormatMismatchError) throw HttpError.conflict('Not an arena tournament');
      throw error;
    }
    if (!read) throw HttpError.notFound('Tournament not found');
    const arena = ArenaTournament.restore(read.snapshot);
    // Ordinary spectators need no write lock. A due idle transition still reloads
    // the row and resamples database time under the same atomic mutation boundary.
    if (arena.getState() === 'running' && Object.keys(read.snapshot.activeGames).length === 0 && arena.isExpired(read.nowMs)) {
      return this.decide(id, (current, nowMs) => current.settle(nowMs), signal);
    }
    return arena;
  }

  /** Recover only pairings already committed by a database-time decision. */
  async reconcile(id: string, signal?: AbortSignal): Promise<ArenaTournament> {
    const arena = await this.getTournament(id, signal);
    for (const [pairingId, p] of Object.entries(arena.toSnapshot().activeGames)) {
      signal?.throwIfAborted();
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
        }, signal);
        signal?.throwIfAborted();
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
        }, signal);
      }
    }
    return this.load(id, signal);
  }

  private async decide(id: string, action: (arena: ArenaTournament, nowMs: number) => void, signal?: AbortSignal): Promise<ArenaTournament> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const snapshot = await this.repo.mutateArena(id, (stored, nowMs) => {
          const arena = ArenaTournament.restore(stored);
          try { action(arena, nowMs); }
          catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message.startsWith('Unknown gameId:')) throw HttpError.notFound('Game ID not found in this tournament');
            if (message.startsWith('Unknown or already-resolved pairingId:') || message === 'Unknown or resolved Arena pairing') {
              throw HttpError.conflict('Unknown or resolved Arena pairing');
            }
            if (message.startsWith('Cannot link game for unknown or resolved pairingId:')) throw HttpError.conflict('Unknown or resolved Arena pairing');
            if (message === 'Arena pairing already linked to a live game' || message === 'Arena game belongs to another pairing') throw HttpError.conflict(message);
            throw error;
          }
          const snapshot = arena.toSnapshot();
          // Refuse invalid launcher links or mutations before they reach durable storage.
          ArenaTournament.restore(snapshot);
          return snapshot;
        }, this.clock, signal);
        if (!snapshot) throw HttpError.notFound('Tournament not found');
        return ArenaTournament.restore(snapshot);
      } catch (e: any) {
        signal?.throwIfAborted();
        if (e instanceof VersionConflictError) {
          if (attempt === 3) throw HttpError.conflict('Concurrent update failed after retries');
          continue;
        }
        if (e instanceof ArenaFormatMismatchError) throw HttpError.conflict('Not an arena tournament');
        throw e; // infrastructure/corruption reaches the router's sanitized 5xx handler
      }
    }
    throw HttpError.conflict('Concurrent update failed after retries');
  }

  async create(cmd: CreateArenaCommand): Promise<ArenaTournament> {
    if (!Number.isSafeInteger(cmd.durationMs) || cmd.durationMs <= 0) {
      throw HttpError.validation('durationMs must be a positive safe integer', { durationMs: 'must be a positive safe integer' });
    }
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

  async load(id: string, signal?: AbortSignal): Promise<ArenaTournament> {
    signal?.throwIfAborted();
    const stored = await this.repo.findById(id, signal);
    if (!stored) {
      throw HttpError.notFound('Tournament not found');
    }
    if (!isArenaSnapshot(stored.snapshot)) {
      throw HttpError.conflict('Not an arena tournament');
    }
    return ArenaTournament.restore(stored.snapshot);
  }

  async register(id: string, playerId: string): Promise<ArenaTournament> {
    const committed = await this.decide(id, (arena, nowMs) => {
      arena.register(playerId);
      arena.pairAvailable(nowMs);
    });
    return this.recoverCommitted(id, committed);
  }

  async withdraw(id: string, playerId: string): Promise<ArenaTournament> {
    return this.decide(id, (arena) => {
      arena.withdraw(playerId);
    });
  }

  async start(id: string, _atMs?: number): Promise<ArenaTournament> {
    const committed = await this.decide(id, (arena, nowMs) => {
      arena.start(nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.recoverCommitted(id, committed);
  }

  async getStandings(id: string) {
    const arena = await this.getTournament(id);
    return arena.standings();
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<ArenaTournament> {
    const committed = await this.decide(id, (arena, nowMs) => {
      arena.recordResultByGame(gameId, result, nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.recoverCommitted(id, committed);
  }

  /** A resolved arena link is absent on replay; CAS retries observe that absence as success. */
  async recordCommittedOutcome(id: string, gameId: string, result: GameResult | '*'): Promise<ArenaTournament> {
    const committed = await this.decide(id, (arena, nowMs) => {
      if (!arena.pairingForGame(gameId)) return;
      if (result === '*') arena.abandonGame(gameId);
      else arena.recordResultByGame(gameId, result, nowMs);
      arena.pairAvailable(nowMs);
    });
    return this.recoverCommitted(id, committed);
  }

  async abandonGame(id: string, gameId: string): Promise<ArenaTournament> {
    const committed = await this.decide(id, (arena, nowMs) => {
      arena.abandonGame(gameId);
      arena.pairAvailable(nowMs);
    });
    return this.recoverCommitted(id, committed);
  }

  private async recoverCommitted(id: string, committed: ArenaTournament): Promise<ArenaTournament> {
    try { return await this.reconcile(id); }
    catch (error) {
      this.logger?.warn('Arena mutation committed; launch recovery remains pending', {
        operation: 'postcommit_reconcile', tournamentId: id, ...arenaFailureFields(error),
      });
      // Preserve the established typed 503 admission-coordination contract.
      // Durable authorization still survives, and a replay/worker can recover it.
      if (error instanceof PlayerLockUnavailableError) throw error;
      // This snapshot promises only the durable mutation, never a completed launch.
      // The indexed pending work remains available to workers, including repair failures.
      return committed;
    }
  }
}
