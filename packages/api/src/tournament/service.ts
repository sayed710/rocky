import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot, PlayerLockUnavailableError, VersionConflictError } from '@chess-platform/persistence';
import type { RoundBasedConfig } from '@chess-platform/tournament';
import { Tournament, createPairingStrategy } from '@chess-platform/tournament';
import type { GameResult } from '@chess-platform/tournament';
import { HttpError } from '../http/errors';
import type { GameLauncher } from './launcher';

export interface CreateTournamentCommand {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin' | 'swiss';
  /** From `RoundBasedConfig`, as `timeControl` below. See `CreateArenaCommand.variant`. */
  readonly variant: RoundBasedConfig['variant'];
  readonly timeControl: RoundBasedConfig['timeControl'];
  readonly rounds?: number; // required if swiss
  readonly tiebreakOrder?: RoundBasedConfig['tiebreakOrder'];
}

export interface RecordResultCommand {
  readonly roundIndex: number;
  readonly pairingIndex: number;
  readonly result: 'white_win' | 'black_win' | 'draw';
}

export class TournamentService {
  constructor(
    private readonly repo: TournamentsRepository,
    private readonly launcher: GameLauncher
  ) {}

  private async withRetry(
    id: string,
    action: (tournament: Tournament) => Promise<void | false> | void | false
  ): Promise<Tournament> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stored = await this.repo.findById(id);
      if (!stored) {
        throw HttpError.notFound('Tournament not found');
      }
      if (isArenaSnapshot(stored.snapshot)) {
        throw HttpError.conflict('Not a round-based tournament');
      }
      const strategy = createPairingStrategy(stored.snapshot.config);
      const tournament = Tournament.restore(stored.snapshot, strategy);
      
      try {
        const changed = await action(tournament);
        if (changed === false) return tournament;
        await this.repo.save(tournament.toSnapshot(), stored.version);
        return tournament;
      } catch (e: unknown) {
        if (e instanceof VersionConflictError) {
          if (attempt === 3) throw HttpError.conflict('Concurrent update failed after retries');
          continue;
        }
        if (e instanceof HttpError) throw e;
        if (e instanceof PlayerLockUnavailableError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('Unknown game ID')) {
          throw HttpError.notFound('Game ID not found in this tournament');
        }
        throw HttpError.conflict(message);
      }
    }
    throw HttpError.conflict('Concurrent update failed after retries');
  }

  async create(cmd: CreateTournamentCommand): Promise<Tournament> {
    const existing = await this.repo.findById(cmd.id);
    if (existing) {
      throw HttpError.conflict('Tournament ID already exists', { id: cmd.id });
    }

    if (cmd.format === 'swiss' && (typeof cmd.rounds !== 'number' || cmd.rounds < 1)) {
      throw HttpError.validation('Swiss tournaments require a positive number of rounds', { rounds: cmd.rounds });
    }

    let config: RoundBasedConfig;
    if (cmd.format === 'round_robin') {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'round_robin',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
        tiebreakOrder: cmd.tiebreakOrder,
      };
    } else {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'swiss',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
        rounds: cmd.rounds!,
        tiebreakOrder: cmd.tiebreakOrder,
      };
    }

    const strategy = createPairingStrategy(config);
    const tournament = new Tournament(config, strategy);
    // New tournaments are saved with expectedVersion 0
    await this.repo.save(tournament.toSnapshot(), 0);
    return tournament;
  }

  async load(id: string): Promise<Tournament> {
    const stored = await this.repo.findById(id);
    if (!stored) {
      throw HttpError.notFound('Tournament not found');
    }
    if (isArenaSnapshot(stored.snapshot)) {
      throw HttpError.conflict('Not a round-based tournament');
    }
    const strategy = createPairingStrategy(stored.snapshot.config);
    return Tournament.restore(stored.snapshot, strategy);
  }

  async register(id: string, playerId: string): Promise<Tournament> {
    return this.withRetry(id, (tournament) => {
      tournament.register(playerId);
    });
  }

  async withdraw(id: string, playerId: string): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      tournament.withdraw(playerId);
    });
  }

  async start(id: string): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      tournament.start();
    });
  }

  async recordResult(id: string, cmd: RecordResultCommand): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      tournament.recordResult(cmd.roundIndex, cmd.pairingIndex, cmd.result);
    });
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      tournament.recordResultByGame(gameId, result);
    });
  }

  /** Apply a committed game ending once, even when two reporters race or retry after a crash. */
  async recordCommittedOutcome(id: string, gameId: string, result: GameResult | '*'): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      const pairing = tournament.pairingForGame(gameId);
      if (!pairing) return false;
      const prior = tournament.resultFor(pairing.roundIndex, pairing.pairingIndex);
      if (prior !== undefined) {
        if (prior === result) {
          const corrected = tournament.correctWithdrawalForfeit(gameId, result);
          const confirmed = tournament.confirmCommittedResult(gameId, result);
          return corrected || confirmed ? undefined : false;
        }
        if (result !== '*' && tournament.correctWithdrawalForfeit(gameId, result)) return;
        throw HttpError.conflict('Committed game outcome conflicts with tournament result');
      }
      if (result === '*') this.abandonLinkedGame(tournament, gameId);
      else {
        tournament.recordResultByGame(gameId, result);
        tournament.confirmCommittedResult(gameId, result);
      }
    });
  }

  /**
   * Abandon an undecided game (e.g. it was aborted) and immediately reconcile,
   * which launches a fresh game for the same pairing so the round can proceed.
   */
  async abandonGame(id: string, gameId: string): Promise<Tournament> {
    return this.mutateAndReconcile(id, (tournament) => {
      this.abandonLinkedGame(tournament, gameId);
    });
  }

  private abandonLinkedGame(tournament: Tournament, gameId: string): void {
    const location = tournament.pairingForGame(gameId);
    if (location && this.launcher.roundAttemptForGame) {
      const { roundIndex, pairingIndex } = location;
      const pairing = tournament.getRounds()[roundIndex]?.pairings[pairingIndex];
      if (pairing?.kind === 'game') {
        const attempt = this.launcher.roundAttemptForGame({
          tournamentId: tournament.config.id,
          matchId: `${roundIndex}-${pairingIndex}`,
          white: pairing.white,
          black: pairing.black,
          variant: tournament.config.variant,
          timeControl: tournament.config.timeControl,
          attempt: tournament.launchAttemptFor(roundIndex, pairingIndex),
        }, gameId);
        if (attempt !== undefined) tournament.linkGame(roundIndex, pairingIndex, gameId, attempt);
      }
    }
    tournament.abandonGame(gameId);
  }

  /** Commit domain decisions before any game creation, including CAS retries. */
  private async mutateAndReconcile(
    id: string,
    action: (tournament: Tournament) => void | false
  ): Promise<Tournament> {
    await this.withRetry(id, action);
    return this.reconcile(id);
  }

  /** Recover missing links from durable pairings; safe across replicas and restarts. */
  async reconcile(id: string): Promise<Tournament> {
    return this.withRetry(id, (tournament) => this.reconcileLaunch(tournament));
  }

  private async reconcileLaunch(tournament: Tournament): Promise<void | false> {
    if (tournament.getState() !== 'running') return false;
    let changed = false;
    const rounds = tournament.getRounds();
    for (const round of rounds) {
      for (let pIndex = 0; pIndex < round.pairings.length; pIndex++) {
        const pairing = round.pairings[pIndex];
        if (pairing.kind === 'game' && tournament.resultFor(round.roundIndex, pIndex) === undefined) {
          if (!tournament.gameIdFor(round.roundIndex, pIndex)) {
            const result = await this.launcher.launch({
              tournamentId: tournament.config.id,
              matchId: `${round.roundIndex}-${pIndex}`,
              white: pairing.white,
              black: pairing.black,
              variant: tournament.config.variant,
              timeControl: tournament.config.timeControl,
              attempt: tournament.launchAttemptFor(round.roundIndex, pIndex),
              committedRoundPairing: true,
            });
            tournament.linkGame(round.roundIndex, pIndex, result.gameId, result.attempt);
            changed = true;
          }
        }
      }
    }
    if (!changed) return false;
  }
}
