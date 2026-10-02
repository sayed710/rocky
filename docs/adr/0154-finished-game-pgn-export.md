# ADR-0154 — Finished-game PGN export from the durable event log

**Status:** Accepted
**Date:** 2026-10-02

## Context

The Fable + Astra audit (`docs/audits/FABLE_ASTRA_FULL_AUDIT.md`) lists game PGN export as absent.
The Codex adjudication (`docs/audits/CODEX_GEMINI_PLANNING_ADJUDICATION_2026-10-02.md`) narrowed it:
studies already import and export PGN, but no finished game could be downloaded. Re-verified on
`origin/main` `499a861`: the only PGN route was `GET /v1/studies/:id/export.pgn`, and the game page
had no export.

A finished game's moves exist in one place: its append-only event stream (`GameCreated`,
`MovePlayed`…, `GameEnded`). The `games` projection (ADR-0147) stores no moves and can lag the log.

## Decision

### 1. The event log is the only source

`packages/api/src/game-export/finished-game-pgn.ts` loads one complete stream with
`EventStore.load` and reads it with `readFinishedGame`:

- **Stream invariants** come from the projection's own validator, `projectGameStream`
  (`packages/persistence/src/games-projection.ts`). It refuses a stream with a gap, without a
  leading `GameCreated`, with a second creation, with a skipped ply, or with anything after
  `GameEnded`. There is no second, weaker validator.
- **Replay** through `Game.fromEvents` checks every stored UCI against the authority's rules,
  including the Chess960 start-id/FEN agreement (ADR-0137). A `GameCreated` naming another game id
  and a `GameEnded` with a result outside PGN's four tokens are also refused.
- **Stored SAN shape**: replay checks the UCI, not the SAN text. A stored SAN that fails the PGN
  parser's own `isSanShaped` is refused, because it would be written into the movetext as is and
  could forge moves or tags (for example `1-0 [Evil "x"]`).
- A refused stream raises `CorruptGameStreamError` (HTTP 500, logged). A prefix is never exported.
- A valid stream without `GameEnded` is not finished (409). The `games` row is never read, so it
  cannot override `GameEnded`.

Moves are the stored `MovePlayed.san` values in committed order. They are not re-derived from the
board, so the export says what the log says. Zero `MovePlayed` events is not corruption: a
resignation before the first move, an abort and a no-show are finished games whose movetext is the
result token alone, which PGN permits.

### 2. One serializer

The study serializer in `packages/studies/src/pgn-serialize.ts` already writes the PGN model the
parser reads, and `@chess-platform/api` already depends on `@chess-platform/studies`, so it is
reused rather than copied or moved. Two additive changes, both covered by studies tests:

- `PgnGame.startingMove` (optional) numbers movetext from a FEN with Black to move or a later
  fullmove number. Absent means `1.` with White, so study export output is unchanged.
- Tag values have each non-printing character (U+0000–U+001F, U+007F) written as a space, after
  the existing `\\` and `"` escapes. The parser ends a string at a newline, so a raw newline
  previously split a tag and turned its remainder into movetext. Study chapter names gain the
  same protection.

Every tag value, including player names, goes through this escaping. No tag line is interpolated
anywhere else.

### 3. Tags: facts or PGN's unknown

| Tag | Value |
| --- | --- |
| `Event`, `Site`, `Round` | `?`. The log records no event, site or round, and the Seven Tag Roster requires the tags. |
| `Date` | UTC calendar date of `GameCreated.at`, `YYYY.MM.DD`. `????.??.??` if that has no four-digit year. |
| `White`, `Black` | See §4. |
| `Result` | `GameEnded.result`, which is also the movetext's final token. |
| `Variant` | The Rookzen variant id (`chess960`, `kingofthehill`, `atomic`, `crazyhouse`, `threecheck`, `horde`, `racingkings`), omitted for `standard`. This is how the study export already writes it. |
| `SetUp` `"1"` + `FEN` | `GameCreated.initialFen`, whenever it differs from the standard start, and always for `chess960`. Position 518 has the standard FEN, so leaving it out would make that game read as standard chess. |
| `TimeControl` | See §5. |

Nothing else is written: no Elo, ECO, opening, title, country, `Termination`, clock comments or
`PlyCount`. `chess960StartId` gets no tag, because no convention exists and the FEN already pins
the start. A historical Chess960 game without the id exports from its `initialFen` and is never
given 518. ADR-0137 deferred this `Variant`/`SetUp`/`FEN` triple to this increment.

### 4. Player names

One `UsersRepository.findByIds` call for both seats, through the existing `PlayerHandles` port
(`RepositoryPlayerHandles`), and then for each seat:

1. the account's current handle;
2. else, for the reserved engine-bot ids, the catalogue handle from
   `packages/api/src/bot/catalogue.ts` (the same value migration 0021 seeds);
3. else `?`, never the internal seat reference.

This adds no exposure. Search already indexes finished games under both handles, public profiles,
seeks and leaderboards pair handles with ids, and `GET /v1/games/:id` publishes the seat ids.

### 5. Time control

PGN's `TimeControl` counts whole seconds and has no delay notation. The tag follows what the clock
does (`packages/game/src/clock.ts`), which is decided by `kind`:

| Rookzen `kind` | Tag |
| --- | --- |
| `increment` | `base+inc`, for example `180+2` |
| `sudden_death` | `base` (the clock ignores any stored increment) |
| `unlimited` | `-`, PGN's own value for no time control |
| `delay` | omitted: writing it as increment would change its meaning |
| any fractional second | omitted rather than rounded |

### 6. Access policy: public, matching what is already public

`GET /v1/games/:id/export.pgn` is `PUBLIC`. Evidence that it exposes nothing new to the same caller:

- ADR-0004: a WebSocket join without a token is an anonymous spectator, and the `joined`
  `StateView` (`packages/realtime-gateway/src/protocol.ts`) carries every move's SAN, both seat ids,
  the variant, the time control and the result, for any game, including finished ones.
- `GET /v1/games/:id` and `GET /v1/users/:handle/games` are public, and search indexes finished
  games with player handles.

A future private-game policy must therefore cover the spectator join, the game summary and this
route together.

### 7. HTTP contract

- The path follows the study export, `…/export.pgn`.
- The id must pass `parseUuid` (422 otherwise), and the router reads no body on a `GET`.
- Responses:
  - 404 when no stream exists.
  - 409 when the game is not finished. Game existence and live state are already public, so this
    is not an oracle.
  - 503 when the request was cancelled before a read.
- `200` sends `Content-Type: application/x-chess-pgn; charset=utf-8`, the type the study export
  already uses, and `Content-Disposition: attachment; filename="game-<uuid>.pgn"`. The filename is
  built only from the validated id, so no handle or CR/LF can reach the header.
- `X-Content-Type-Options: nosniff` is set on every API response. nginx proxies `/v1/` unchanged
  with gzip off, and the service worker never caches `/v1/`.
- No cache header is added. Without validators there is no heuristic caching, and a later handle
  change is reflected on the next request.
- Cost: one indexed stream read, one batched identity read and pure in-memory serialization, the
  same read a spectator join performs. No engine, no Game Review, and no per-ply or per-move
  queries. No rate-limit bucket was added: comparable public reads (`/v1/games/:id`, the study
  export, profiles) are unmetered.
- OpenAPI gained a per-response media type (`DocResponse.mediaType`), so both PGN exports are
  documented as `application/x-chess-pgn` rather than JSON. The study export's existing 200 was
  corrected the same way.

### 8. Web download

`packages/web/src/app/game-pgn-export.ts` mounts a "Download PGN" control in its own
`#game-export` section. The section is shown only while the authoritative game state is over, for
players and spectators, so a live game shows no PGN control.

- The request goes through `GamesApi.exportPgn` with the new `text` request mode, which:
  - sends `Accept: application/x-chess-pgn`;
  - refuses any other 2xx media type, so an HTML fallback page is never saved as PGN;
  - returns the body unmodified.
- The bytes are saved through a Blob and a detached `download` link. The router already ignores
  `download` links, so the page does not navigate. The object URL is always revoked by a timer.
- The filename is `game-<uuid>.pgn` for a UUID route id and `game.pgn` otherwise.
- Nothing is regenerated in the browser, and nothing is stored in localStorage or sessionStorage.
- Ownership:
  - one request at a time;
  - `aria-disabled` rather than `disabled` while pending, so keyboard focus stays;
  - a `role=status` line and a `role=alert` failure, both translated keys;
  - dispose aborts the request and drops its late answer;
  - a new mount starts hidden and clean.
- Copy is English-only in production. RTL is tested with the test-only Arabic catalog, and the
  saved document is never direction-transformed.

## Consequences

- Finished games can be exported to standard PGN tools. Every non-standard variant stays
  identifiable, and every non-standard start replays from the export alone.
- A corrupt stream fails the export loudly, the same way the projector reports it, instead of
  producing a plausible but wrong file.

## Not done here

This is not D-12 personal-data export, and it adds no bulk or multi-game download. It also adds no
clock comments (`%clk`), annotations, Game Review content, `Termination` mapping or rating tags.
