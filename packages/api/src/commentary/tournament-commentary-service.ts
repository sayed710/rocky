/**
 * @packageDocumentation
 * The API-owned Tournament Commentary service (ADR-0130).
 *
 * Two questions, one rule: **the caller names a resource, the server supplies every fact.** The
 * routes above this service carry path identifiers and an empty body, and every value that reaches
 * a prompt — the position, the move, the players, the results, the standings — is read here from
 * the tournament aggregate and the durable game log. A caller cannot describe a game that was never
 * played, and cannot decide how much engine or provider budget their request spends.
 *
 * The library feature this wraps (`TournamentCommentator`) accepts all of that from its caller,
 * because in M9 its caller was a test. Productionizing it is mostly the work of taking those
 * parameters away.
 */
import type { TournamentCommentator } from '@chess-platform/ai-features';
import type { EngineResult } from '@chess-platform/engine';

import { aiErrorToHttp } from '../ai/provider-errors.js';
import type { AnalysisPort } from '../analysis/service.js';
import { HttpError } from '../http/errors.js';
import type { FinishedGameArchive } from '../tournament/finished-game.js';

import type { PairingResult, PlayerHandles, TournamentFacts, TournamentLookup } from './ports.js';

/**
 * Fixed engine policy, owned here and reachable from no request body.
 *
 * Matched to the job rather than copied: one line of principal variation is all a citation quotes,
 * and the position is a settled one from a finished game, so there is no interactive latency budget
 * to respect — only a bound on what a single accepted request may cost.
 */
export const COMMENTARY_DEPTH = 18;
export const COMMENTARY_MOVETIME_MS = 1_500;
export const COMMENTARY_MULTI_PV = 1;

/** The engine facts a commentary quotes. */
export interface CommentaryCitation {
  readonly fen: string;
  readonly move: string;
  readonly evalKind: 'cp' | 'mate';
  readonly evalValue: number;
  readonly evalLabel: string;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

/** One pairing of a round, as the tournament recorded it. */
export interface RecapPairing {
  /** Display handle, or a stand-in when the account is gone. */
  readonly white: string;
  /** Display handle, or `null` for a bye, which has no opponent. */
  readonly black: string | null;
  /** The tournament's own vocabulary, and exactly the six values the OpenAPI enum publishes. */
  readonly result: PairingResult;
}

/** One row of the standings as they stood at the end of the recapped round. */
export interface RecapStanding {
  readonly rank: number;
  readonly player: string;
  readonly points: number;
}

/** What {@link TournamentCommentaryService.commentateGame} produces. */
export interface GameCommentaryOutcome {
  readonly tournamentId: string;
  readonly gameId: string;
  readonly round: number;
  readonly white: string;
  readonly black: string;
  /** How the game itself ended, from its event log: `1-0`, `0-1`, `1/2-1/2`. */
  readonly result: string;
  /**
   * What the tournament recorded for this pairing, or `null` while it has not recorded one.
   *
   * A different fact from `result`, published beside it rather than in place of it. The game log
   * says how the game ended; the aggregate says how the tournament scored it, and the two can
   * disagree — a director may record a forfeit over a game that was played out, and a pairing may be
   * voided. Publishing only the game's result would let a commentary contradict the standings on the
   * same page; publishing only the tournament's would leave the field empty for the interval after a
   * game ends and before `TournamentResultReporter` records it, which is exactly the interval this
   * feature is most likely to be used in.
   *
   * Raised in the Qodo review of PR #153, which proposed replacing one with the other.
   */
  readonly tournamentResult: string | null;
  readonly termination: string;
  readonly ply: number;
  /** The position the final move was played from — the position the citation describes. */
  readonly fen: string;
  readonly variant: string;
  readonly finalMove: { readonly uci: string; readonly san: string };
  readonly citation: CommentaryCitation;
  /** Model prose. Never the source of any fact above it. */
  readonly commentary: string;
  readonly providerId: string;
  readonly model: string;
}

/** What {@link TournamentCommentaryService.recapRound} produces. */
export interface RoundRecapOutcome {
  readonly tournamentId: string;
  readonly round: number;
  readonly results: readonly RecapPairing[];
  readonly standings: readonly RecapStanding[];
  /**
   * How many of `results` the narrative was given.
   *
   * A bye, a void and a double forfeit have no representation in the library's three-valued match
   * vocabulary, so they reach the reader in `results` and never reach the model. Publishing the
   * count makes that gap visible instead of leaving a recap that quietly describes fewer games than
   * the round contained.
   */
  readonly pairingsNarrated: number;
  /** Model prose. Never the source of any fact above it. */
  readonly narrative: string;
  readonly providerId: string;
  readonly model: string;
}

export interface TournamentCommentaryOptions {
  readonly analysis: AnalysisPort;
  readonly commentator: TournamentCommentator;
  readonly archive: FinishedGameArchive;
  readonly tournaments: TournamentLookup;
  readonly players: PlayerHandles;
}

/** A request for commentary on one finished game. */
export interface GameCommentaryInput {
  readonly tournamentId: string;
  readonly gameId: string;
  readonly signal?: AbortSignal | undefined;
}

/** A request for a recap of one complete round. */
export interface RoundRecapInput {
  readonly tournamentId: string;
  readonly round: number;
  readonly signal?: AbortSignal | undefined;
}

/** Charge the caller's quota. Called once, after validation and before any expensive work. */
export type ChargeQuota = () => Promise<void>;

export class TournamentCommentaryService {
  private readonly analysis: AnalysisPort;
  private readonly commentator: TournamentCommentator;
  private readonly archive: FinishedGameArchive;
  private readonly tournaments: TournamentLookup;
  private readonly players: PlayerHandles;

  constructor(options: TournamentCommentaryOptions) {
    this.analysis = options.analysis;
    this.commentator = options.commentator;
    this.archive = options.archive;
    this.tournaments = options.tournaments;
    this.players = options.players;

    // The same construction-time assertion the endgame trainer makes: a deployment whose limits
    // policy cannot accommodate this feature's fixed search should fail at boot, where an operator
    // sees it, rather than at the first request, where a user does.
    if (
      !this.analysis.canSatisfyLimits({
        depth: COMMENTARY_DEPTH,
        movetimeMs: COMMENTARY_MOVETIME_MS,
        multiPv: COMMENTARY_MULTI_PV,
      })
    ) {
      throw new Error('Tournament commentary requires the fixed depth, time, and MultiPV policy.');
    }
  }

  /**
   * Commentate the decisive moment of a finished tournament game.
   *
   * The order below is the security property, not an implementation detail. Everything that can
   * refuse the request is free — two map lookups and a log read — and all of it happens before
   * `charge` and long before an engine or a provider is touched.
   *
   * @param input - the tournament, the game, and the caller's cancellation signal.
   * @param charge - spends the caller's quota; awaited once, after validation.
   * @returns the game's facts, the engine's citation, and the model's prose, kept apart.
   */
  async commentateGame(input: GameCommentaryInput, charge: ChargeQuota): Promise<GameCommentaryOutcome> {
    const tournament = await this.requireRoundBased(input.tournamentId);

    // Authoritative membership. The link is written when the game is launched, so this answers
    // "is this game part of this tournament" without depending on a result having been recorded.
    const pairing = tournament.pairingForGame(input.gameId);
    if (pairing === null) throw HttpError.notFound('game is not part of this tournament');

    // Authoritative terminality, and deliberately not the tournament's recorded result. Results
    // reach the aggregate asynchronously through `TournamentResultReporter`; a game can be over in
    // the log while the tournament still shows it unresolved. Reading the log is what makes
    // "finished games only" a guarantee rather than a race.
    const game = await this.archive.finishedGame(input.gameId);
    if (game === undefined) throw HttpError.conflict('game is not finished');
    const finalMove = game.finalMove;
    const fen = game.fenBeforeFinalMove;
    if (finalMove === null || fen === null) {
      throw HttpError.conflict('game ended before a move was played');
    }
    // Refused before any quota or engine work, as review and anti-cheat do: the stored final move only
    // the pre-#127 atomic rules allowed is not a legal move, so there is nothing true to narrate (#127).
    if (finalMove.historical === true) {
      throw HttpError.conflict('the final move was recorded under earlier atomic rules and cannot be analysed');
    }
    if (!this.analysis.supportsVariant(game.variant)) {
      throw HttpError.unavailable('no engine is configured for this variant');
    }

    await charge();

    const outcome = await this.analysis.analyze({
      fen,
      variant: game.variant,
      depth: COMMENTARY_DEPTH,
      movetimeMs: COMMENTARY_MOVETIME_MS,
      multiPv: COMMENTARY_MULTI_PV,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // Refused rather than passed on, and this is the one guard in the file that exists because of
    // the library rather than because of a caller. `commentateMoment` builds its citation from
    // `results[0]`, and when there is no `results[0]` it publishes `+0.00` at depth 0 as though an
    // engine had said so — an authored number presented as a measured one, the defect ADR-0127
    // named and ADR-0116 named before it. Keeping `lines` non-empty here is what makes that branch
    // unreachable in production.
    const best = firstUsableLine(outcome.lines);
    if (outcome.terminal !== undefined || best === undefined) {
      throw HttpError.unavailable('the engine produced no evaluation for this position');
    }

    const names = await this.players.handles([game.white, game.black]);
    const white = displayName(names, game.white, 'White');
    const black = displayName(names, game.black, 'Black');

    const commentary = await this.narrate(() =>
      this.commentator.commentateMoment({
        fen,
        lastMove: finalMove.uci,
        variant: game.variant,
        // Supplying the analysis is what keeps the library off the engine: it searches only when
        // this field is absent, and the provider it is constructed with refuses every call
        // (`composition.ts`). There is no path by which the library chooses its own limits.
        analysis: outcome.lines,
        ...(input.signal ? { signal: input.signal } : {}),
        context: {
          whitePlayer: white,
          blackPlayer: black,
          round: pairing.roundIndex + 1,
        },
      }),
    );

    return {
      tournamentId: input.tournamentId,
      gameId: input.gameId,
      round: pairing.roundIndex,
      white,
      black,
      result: game.result,
      tournamentResult: tournament.resultFor(pairing.roundIndex, pairing.pairingIndex) ?? null,
      termination: game.termination,
      ply: game.ply,
      fen,
      variant: game.variant,
      finalMove: { uci: finalMove.uci, san: finalMove.san },
      // Built from the engine result this service holds, not from the library's citation, with the
      // single exception of the human-readable label — the one field of the six that is a rendering
      // of the evaluation rather than a second opinion about it.
      citation: {
        fen,
        move: finalMove.uci,
        evalKind: best.evaluation.type,
        evalValue: best.evaluation.value,
        evalLabel: commentary.citation.evalLabel,
        bestLine: [...best.principalVariation],
        depth: best.depth,
      },
      commentary: commentary.commentary,
      providerId: commentary.providerId,
      model: commentary.model,
    };
  }

  /**
   * Narrate a round every pairing of which has a result.
   *
   * @param input - the tournament, the round index, and the caller's cancellation signal.
   * @param charge - spends the caller's quota; awaited once, after validation.
   * @returns the round's recorded facts and the model's prose about them, kept apart.
   */
  async recapRound(input: RoundRecapInput, charge: ChargeQuota): Promise<RoundRecapOutcome> {
    const tournament = await this.requireRoundBased(input.tournamentId);

    const round = tournament.getRounds().find((candidate) => candidate.roundIndex === input.round);
    if (round === undefined) throw HttpError.notFound('round not found');

    // The whole basis of the endpoint. A recap of a round still being played would present a
    // partial table as a finished one, and no wording in the prompt can undo a heading that says
    // "after round 3" over three of five games. There is no partial mode because the product has no
    // partial recap to be consistent with: `GET /v1/tournaments/:id/rounds` shows a round in
    // progress as pairings, which is a different thing than a narrative about how it went.
    if (!tournament.isRoundComplete(input.round)) {
      throw HttpError.conflict('round is not complete');
    }

    await charge();

    const standings = tournament.standingsAfterRound(input.round);
    const playerIds = new Set<string>();
    for (const pairing of round.pairings) {
      if (pairing.kind === 'game') {
        playerIds.add(pairing.white);
        playerIds.add(pairing.black);
      } else {
        playerIds.add(pairing.player);
      }
    }
    for (const standing of standings) playerIds.add(standing.playerId);

    const names = nameEveryone(await this.players.handles([...playerIds]), playerIds);

    const results: RecapPairing[] = round.pairings.map((pairing, index) => {
      // A pairing with no recorded result cannot occur here — `isRoundComplete` has just said every
      // one of them has one — so the fallback is unreachable rather than a default worth choosing.
      const result = tournament.resultFor(input.round, index) ?? 'void';
      if (pairing.kind === 'bye') {
        return { white: names.get(pairing.player)!, black: null, result };
      }
      return {
        white: names.get(pairing.white)!,
        black: names.get(pairing.black)!,
        result,
      };
    });

    const standingsView: RecapStanding[] = standings.map((standing, index) => ({
      rank: index + 1,
      player: names.get(standing.playerId)!,
      points: standing.points,
    }));

    // Only the pairings the library's vocabulary can state. A bye is not a game, and `void` and
    // `double_forfeit` have no `1-0`/`0-1`/`1/2-1/2` spelling — offering one as a draw or a win
    // would be telling the model something untrue about a real pairing.
    const narratable = results.flatMap((entry) => {
      const wire = wireResult(entry.result);
      if (wire === undefined || entry.black === null) return [];
      return [{ white: entry.white, black: entry.black, result: wire }];
    });

    const recap = await this.narrate(() =>
      this.commentator.recapRound({
        round: input.round + 1,
        results: narratable,
        standings: standingsView.map((row) => ({
          rank: row.rank,
          player: row.player,
          points: row.points,
        })),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );

    return {
      tournamentId: input.tournamentId,
      round: input.round,
      results,
      standings: standingsView,
      pairingsNarrated: narratable.length,
      narrative: recap.recap,
      providerId: recap.providerId,
      model: recap.model,
    };
  }

  /**
   * Load a round-based tournament or refuse with the reason it cannot be commentated.
   *
   * @param tournamentId - the tournament named in the path.
   * @returns the aggregate's read surface.
   */
  private async requireRoundBased(tournamentId: string): Promise<TournamentFacts> {
    const found = await this.tournaments.roundBased(tournamentId);
    if (found === 'not_found') throw HttpError.notFound('Tournament not found');
    if (found === 'arena') throw HttpError.conflict('arenas are played continuously and have no rounds');
    return found;
  }

  /**
   * Run a provider call, translating its failures and forwarding none of their text.
   *
   * @param call - the library call to make.
   * @returns whatever the call returned.
   */
  private async narrate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw aiErrorToHttp(err, 'tournament commentary');
    }
  }
}

/**
 * The first line an engine actually measured, or `undefined`.
 *
 * A line with a non-finite or zero depth is not a weaker measurement, it is the absence of one, and
 * publishing it as a citation would put a number in front of a reader that no search produced. The
 * endgame trainer guards its evaluations the same way for the same reason.
 *
 * @param lines - the analysis service's lines, best first.
 * @returns the best line, or `undefined` when there is nothing measured to quote.
 */
function firstUsableLine(lines: readonly EngineResult[]): EngineResult | undefined {
  const best = lines[0];
  if (best === undefined) return undefined;
  if (!Number.isFinite(best.depth) || best.depth <= 0) return undefined;
  if (!Number.isFinite(best.evaluation.value)) return undefined;
  return best;
}

/**
 * The tournament's result vocabulary in the library's, or `undefined` when it has no equivalent.
 *
 * @param result - a value from the aggregate's results map.
 * @returns the PGN-style result string, or `undefined` for a bye, a void or a double forfeit.
 */
function wireResult(result: string): '1-0' | '0-1' | '1/2-1/2' | undefined {
  if (result === 'white_win') return '1-0';
  if (result === 'black_win') return '0-1';
  if (result === 'draw') return '1/2-1/2';
  return undefined;
}

/**
 * The one shape a name may have before it is put in front of a language model.
 *
 * The character class is the same one `HANDLE_PATTERN` in `domain.ts` enforces — and every handle
 * in the database has passed it, since registration is the only path that writes one and there is no
 * rename route. The length bounds are deliberately looser (`{1,64}` against that pattern's
 * `{3,30}`), because length is not what makes a string safe to interpolate and a name too short or
 * too long for a handle is not thereby an injection.
 *
 * Stated separately rather than imported because the two are not the same rule: that one decides
 * what a person may call themselves, this one decides what may be put in front of a language model,
 * and they should be free to diverge. Should handles ever gain punctuation or a display-name field
 * appear, this is the guard that keeps the change from silently becoming an injection vector.
 */
const NARRATABLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The display name for a player id, or a stand-in that identifies nobody.
 *
 * The fallback is deliberately not the id. An account can be deleted while the games it played
 * remain in a finished tournament, and answering that with a UUID would send an internal identifier
 * to a third-party provider to no purpose — the narrative needs a name to write with, not a key to
 * look anything up by.
 *
 * A handle that does not match {@link NARRATABLE_NAME} takes the same fallback. Not a sanitised
 * version of itself: silently stripping characters would rename a real player in a narrative that
 * reads as official, which is a worse answer than declining to name them.
 *
 * @param handles - resolved handles by player id.
 * @param playerId - the player to name.
 * @param fallback - what to call them when the account is gone or the handle cannot be narrated.
 * @returns the handle, or the fallback.
 */
function displayName(handles: ReadonlyMap<string, string>, playerId: string, fallback: string): string {
  const handle = handles.get(playerId);
  if (handle === undefined || !NARRATABLE_NAME.test(handle)) return fallback;
  return handle;
}

/**
 * Give every player in a recap a name, and give no two of them the same one.
 *
 * A game commentary names exactly two people and can call them `White` and `Black`, which are
 * distinct by construction. A recap names a whole field, and a single shared fallback collapses
 * every unresolved player into one: two deleted accounts become two standings rows called
 * `Player`, indistinguishable to the reader, and the model is asked to narrate two competitors
 * under one name. Raised in the CodeRabbit review of PR #153.
 *
 * The ordinal is assigned over a sorted id list rather than over iteration order, so the same
 * tournament produces the same names on every request — the response and the prompt built from it
 * should not depend on the order a `Set` happened to be filled in.
 *
 * No check that a label collides with a real handle, because it cannot: {@link NARRATABLE_NAME}
 * admits no whitespace, and every label has a space in it. That is a property of the pattern rather
 * than of this function, so if the pattern ever widens this is a second place to revisit.
 *
 * @param handles - resolved handles by player id.
 * @param playerIds - every player the recap will mention.
 * @returns a name for each id, unique across the returned map.
 */
function nameEveryone(
  handles: ReadonlyMap<string, string>,
  playerIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const named = new Map<string, string>();
  let ordinal = 0;
  for (const playerId of [...playerIds].sort()) {
    const handle = handles.get(playerId);
    if (handle !== undefined && NARRATABLE_NAME.test(handle)) {
      named.set(playerId, handle);
      continue;
    }
    ordinal += 1;
    named.set(playerId, `Player ${String(ordinal)}`);
  }
  return named;
}
