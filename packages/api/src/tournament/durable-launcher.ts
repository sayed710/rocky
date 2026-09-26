import { createHash } from 'node:crypto';
import { CHESS960_POSITIONS, type Variant } from '@chess-platform/core';
import { Game, type TimeControl } from '@chess-platform/game';
import type { EventStore } from '@chess-platform/persistence';
import type { Clock } from '../ports/clock';
import type { GameLauncher, LaunchInput } from './launcher';

/**
 * Production tournament launcher backed by the shared durable game event log.
 * The game id is a SHA-256 digest of the launch identity, so every API replica
 * converges on the same id even before either process has written anything.
 */
export class DurableGameLauncher implements GameLauncher {
  constructor(
    private readonly events: EventStore,
    private readonly clock: Clock,
  ) {}

  async launch(input: LaunchInput): Promise<{ gameId: string }> {
    const gameId = launchGameId(input);
    if (await this.events.exists(gameId)) return { gameId };

    const variant = input.variant as Variant;
    const { events } = Game.create({
      gameId,
      variant,
      timeControl: input.timeControl as TimeControl,
      players: { white: input.white, black: input.black },
      rated: true,
      at: this.clock.now(),
      // Readiness, first-move clock start and the tournament no-show deadline (ADR-0148).
      source: 'tournament',
      ...(variant === 'chess960' ? { chess960StartId: launchChess960StartId(input) } : {}),
    });

    try {
      await this.events.append(gameId, -1, events);
    } catch (error) {
      // A concurrent replica may have won the deterministic-id race. Only
      // accept that failure when the exact game now exists durably.
      if (!(await this.events.exists(gameId))) throw error;
    }
    return { gameId };
  }
}

/** SHA-256 of the launch identity. Both the game id and the Chess960 start position derive from it. */
function launchDigest(input: LaunchInput): Buffer {
  const identity = JSON.stringify([input.tournamentId, input.matchId, input.attempt]);
  return createHash('sha256').update(identity).digest();
}

/**
 * The game id for a tournament pairing, derived from its identity rather than generated.
 *
 * Every API replica computes the same id for the same `(tournamentId, matchId, attempt)` before any
 * of them has written anything, which is what lets them race to append and have the losers accept the
 * winner's row. `attempt` is part of the identity so a relaunched pairing gets a fresh game rather
 * than resolving to the abandoned one.
 *
 * Shaped as a UUID because the schema's id columns are `UUID`; the digest is SHA-256 rather than the
 * SHA-1 a real v5 uuid would use, with the variant and version nibbles forced so the representation
 * still parses.
 */
export function launchGameId(input: LaunchInput): string {
  const bytes = launchDigest(input).subarray(0, 16);
  // RFC 4122 variant + version-5-style marker. The digest is SHA-256 rather
  // than SHA-1, but the UUID representation remains accepted by the existing
  // UUID Postgres schema and deterministic across replicas.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The Chess960 starting-position id for a tournament pairing, derived from the launch identity
 * rather than drawn.
 *
 * **This launcher must not use the CSPRNG selector the other creation paths use.** Its whole design
 * is that every replica computes the same `gameId` and races to append, with the losers accepting the
 * winner's row (`if (!(await this.events.exists(gameId))) throw error`). A random draw would mean
 * each replica built a *different* `GameCreated` for the same id: the store would keep one, and the
 * others would return success for a game whose start position they had not agreed on. Deriving the
 * position from the same identity that already fixes the id removes the disagreement rather than
 * papering over it — every replica constructs the byte-identical event, so which one wins the append
 * stops being a question.
 *
 * It is also reproducible, which is what makes a crashed-and-relaunched pairing resume the same game
 * instead of a differently-shuffled one.
 *
 * Bytes 16..31 (the half `launchGameId` does not use) read as a 128-bit integer, modulo 960. Taking a
 * modulus biases the draw towards low ids by at most 2^-118 — not a rounding-error argument but a
 * quantity, and one far below anything 960 buckets could express. A 32-bit read would have been
 * biased by ~2^-22, which is still small but is the kind of number worth avoiding for free.
 */
export function launchChess960StartId(input: LaunchInput): number {
  const entropy = BigInt(`0x${launchDigest(input).subarray(16).toString('hex')}`);
  return Number(entropy % BigInt(CHESS960_POSITIONS));
}
