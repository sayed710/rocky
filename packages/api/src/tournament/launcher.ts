import type { IdGenerator } from '../ports/ids';
import type { GameResult } from '@chess-platform/tournament';

export interface LaunchResult {
  readonly gameId: string;
  /** Actual slot reached by probing, when greater than the requested attempt. */
  readonly attempt?: number;
  /** Recovery found an already-ended committed game. Arena consumes its outcome
   * by pairing id; round services persist its link for durable reporter recovery. */
  readonly terminalOutcome?: GameResult | '*';
}

export interface LaunchInput {
  readonly tournamentId: string;
  readonly matchId: string;
  readonly white: string;
  readonly black: string;
  readonly variant: string;
  readonly timeControl: unknown;
  /**
   * Launch slot cursor for this pairing (0 for the first). Part of the launch identity
   * so a replayed pairing (after an abort)
   * gets a fresh, non-colliding game rather than resolving to the dead one.
   */
  readonly attempt: number;
  /** Round pairing read from committed state. New launches have a separate
   * namespace; legacy slots require compatible upgrade recovery. */
  readonly committedRoundPairing?: boolean;
  /** Arena-only: reconcile an entry in the committed active pairing snapshot.
   * Terminal recovery also requires its durable namespace; legacy ended slots are ambiguous. */
  readonly committedArenaPairing?: boolean;
  /** Stored on new Arena authorizations, isolating them from legacy CAS-loser games. */
  readonly arenaLaunchNamespace?: 'committed-v1';
}

/**
 * Port for turning a tournament pairing into a concrete, playable game.
 *
 * Idempotency contract: `launch` MUST be idempotent per
 * `(tournamentId, matchId, attempt, launch namespace)`. Calling it more than once for the same
 * identity must return the SAME `gameId` rather than creating a second game. The
 * Round services commit pairings before launch, then persist game links in a
 * separate CAS. If the process crashes before the link write, on reload the
 * loop calls `launch` again for the same pairing. An idempotent launcher hands
 * back the original `gameId`, keeping the whole flow crash-safe with no
 * duplicate games. A durable adapter enforces this with a unique key on
 * `(tournamentId, matchId, attempt)`.
 */
export interface GameLauncher {
  launch(input: LaunchInput, signal?: AbortSignal): Promise<LaunchResult>;
  /** Pure identity lookup for an already-linked round game, including legacy
   * probed slots whose actual attempt was not persisted before upgrade. */
  roundAttemptForGame?(input: LaunchInput, gameId: string): number | undefined;
}

/**
 * In-memory {@link GameLauncher} for tests and local runs. Idempotent per
 * `(tournamentId, matchId, attempt)` for the lifetime of the instance, which is
 * enough to honor the port contract within a single process.
 */
export class InMemoryGameLauncher implements GameLauncher {
  public readonly launched: LaunchInput[] = [];
  private readonly byKey = new Map<string, string>();

  constructor(private readonly ids: IdGenerator) {}

  async launch(input: LaunchInput): Promise<{ gameId: string }> {
    const key = JSON.stringify([input.tournamentId, input.matchId, input.attempt,
      input.committedRoundPairing ? 'round-committed-v1' : input.arenaLaunchNamespace]);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return { gameId: existing };
    }
    const gameId = this.ids.next();
    this.byKey.set(key, gameId);
    this.launched.push(input);
    return { gameId };
  }
}
