# Gambit — Milestone Roadmap

Each milestone ships **real, tested code** and has explicit acceptance criteria.
We do not advance until a milestone's criteria are met and it passes a
self-critique + multi-perspective review. This is deliberately incremental: the
full platform is a multi-year effort, and correctness compounds.

Legend: ✅ done · 🚧 in progress · ⬜ planned

Timed-game lifecycle remediation is split: M15 Increment 66 (ADR-0144) recovers
committed terminal events for tournaments and event-store-backed analyzers.
Readiness/no-show, first-move clock start, autonomous in-play expiry, the durable
games projection, ratings, and projection-dependent search/achievements remain
future increments; terminal-event recovery alone does not complete timed games.

---

## ✅ Milestone 1 — Rules engine core (`@chess-platform/core`)

The correctness-critical foundation everything else depends on.

- ✅ 0x88 board, immutable `Position`, FEN parse/serialize, UCI + SAN.
- ✅ Legal move generation: castling, en passant, promotion, pins, checks.
- ✅ Variants: Chess960 scaffolding, King of the Hill, Atomic, Crazyhouse
  (drops + pockets), Three-Check, Horde, Racing Kings.
- ✅ Terminal detection: checkmate, stalemate, insufficient material, fifty-move,
  variant win/draw conditions.
- ✅ **Acceptance:** `perft` matches published reference node counts for 5
  positions (startpos d4=197,281; Kiwipete d3=97,862; +3 edge cases). 14/14 tests
  pass; strict TypeScript with zero errors.

**Known follow-ups (tracked):**

- **Perft suites for each variant (RESOLVED in Increment 32 / ADR-0098 and completed in Increment 42).** All eight variants now have perft verification against published reference vectors or equality/divergence invariants. `horde` and `racingkings` coverage added from official `lichess-org/scalachess` perft resources (ADR-0098), resolving variant-rule defects in Horde rank-1 pawn double pushes and Racing Kings 8th-rank goal turn semantics.
- **Chess960 was a label with nothing behind it (RESOLVED in M15 Increment 41 / ADR-0137; rules in ADR-0136).** Bigger than the "castling-by-file" wording suggested, and verified by running the code. (1) `Position.initial('chess960')` returns the standard array on every call, and `packages/game/src/game.ts:92` uses it for any seek without an explicit FEN — so a Chess960 game was ordinary chess. (2) `generateCastles` in `packages/chess-core/src/movegen.ts` pins the king to e1/e8 and looks for rooks at fixed offsets, so castling generates for exactly one of the 960 start positions, and that one is standard chess: king on b1 with rooks a1/h1 produces 0 castling moves, as does king g1 with rooks f1/h1. (3) `packages/chess-core/src/fen.ts` discards file-letter castling rights, so `HAha` on kiwipete gives `perft(1) = 46`, identical to no rights, against 48 for `KQkq`. **Withheld in Increment 33 (ADR-0099):** removed from the lobby's offered variants so nobody receives a mislabelled standard game; still accepted by the API and still a rule set in `chess-core`. **Open:** implementing it — 960-position generation, castling from arbitrary king and rook squares, Shredder/X-FEN in and out, the UCI king-takes-rook encoding, SAN, and perft against published values. **Server contract closed in M15 Increment 14 (ADR-0123):** withholding it in the lobby only protected browser users — `OFFERED_VARIANTS` is a list in the web bundle, and every other client (script, bot, mobile, curl) still reached `Game.create`, which wrote `variant: 'chess960'` beside a standard `initialFen` into an append-only event store. That is a durable falsehood, not a UI wart: afterwards nothing can tell such a row from a real Chess960 game. `Game.create` now refuses the variant outright — the one place every game is born, so seek acceptance, the bot route and the tournament launcher all inherit it — and `CREATABLE_VARIANTS` carries the same rule at the three creation routes so the refusal arrives as the API’s ordinary 422 rather than the 500 an unmapped `GameError` would produce. Seek acceptance re-checks the stored variant (409) because that value comes from a row, not a request. `chess960` remains valid everywhere that reads — the enum, the `variants` table, and every View schema — and only the three Request schemas narrowed. **Rules implemented in ADR-0136:** all 960 arrangements from the Scharnagl numbering, castling from arbitrary king and rook squares, Shredder-FEN in and canonical X-FEN out, the UCI king-takes-rook encoding, SAN unchanged, and perft against all 960 published reference positions — with the refusal deliberately kept, because the engine could now play any arrangement but nothing could yet *tell* it which one. **RESOLVED in M15 Increment 41 (ADR-0137):** `GameCreated` carries an optional `chess960StartId`, and the server draws it — `crypto.randomInt` at seek acceptance and on the bot route, derived from the launch identity for tournaments, so racing replicas agree on the arrangement instead of each drawing their own. Replay validates the stored id against the stored FEN rather than trusting either alone, and a legacy `chess960` event with no id replays from its FEN and reports its start as unknown, never as 518 — the guess that would look plausible. `Game.create` requires the id for the variant and refuses it for every other; `CREATABLE_VARIANTS` and `OFFERED_VARIANTS` admit `chess960`; `openapi.json` is regenerated. The seek-accept 409 is *kept* rather than removed as the checklist said, because `seek.variant` is read from a database column and the type system does not span the SQL (ADR-0137 §6). Move *input* needed no Chess960 logic in the browser — `BoardInteraction` is oracle-driven and the server's legal-move map already spells castling king-takes-rook — but move *projection* did: `applyMove` advances the client's own board between snapshots and recognised castling only at exactly two files, projecting `d1a1` as a king on a1 with the rook deleted. It now treats a king landing on a friendly rook as a castle (ADR-0137 §8). **Nothing left open on the variant.**
- **`Position.snapshot()` lost three-check state (RESOLVED in M15 Increment 8).** `snapshot()` in `packages/chess-core/src/position.ts` round-tripped through `parseFen(this.fen(), variant)`, and `toFen` does not serialise `checkCount`, so both counters reset to zero. Found during the Increment 33 audit (ADR-0099 §4) and recorded there as "latent, not live" on the grounds that a repetition key uses only the first four FEN fields. **That assessment was wrong.** `packages/chess-core/src/repetition.ts` had appended the delivered-check counters to the key for `threecheck` since 2026-07-13 — three weeks before the audit — and `packages/game/src/game.ts` builds that key from the lossy snapshot on both the live and replay paths. Every three-check position therefore reported `0+0`, and a board that repeated while the check counts climbed was treated as a repetition: `Re1+ Kf8 Rd1 Ke8 Re1+ Kf8 Rd1 Ke8` was declared a threefold draw with White one check from winning. **Resolved in M15 Increment 8:** `snapshot()` returns `cloneState(this.state)`, the existing authoritative deep copy, so no `PositionState` field is dropped; the line above now continues and White wins `1-0` on the third check. Serialising three-check counters into FEN was deferred to M15 Increment 9 and is **RESOLVED** there (ADR-0120): `toFen` emits the canonical Fairy-Stockfish field — `N+M` remaining, in field five — and `parseFen` accepts that, the trailing `+N+M` delivered form, and the legacy six-field form. The engine defect it was hiding is closed with it: Fairy-Stockfish 14 reads a missing counter field as `1+1`, so every three-check analysis had been scored as though one check won the game.
- **The supported-variant list is written out across mirrors (GUARDED in M15 Increment 10; RESOLVED in M15 Increment 42).** `Variant` in `chess-core`, `VARIANTS` in the API, `StudyVariant` in studies, `SUPPORTED_VARIANTS` in ai-features, `VARIANTS` in the web client, and the `variants` lookup table — originally seven hand-maintained copies (including an inline `CHECK` on `studies.variant`), none derived from another. The type system does not span the SQL, so `scripts/check-variant-parity.mjs` replays the immutable migration history and compares every active mirror to `Variant`. **Resolved in M15 Increment 42:** migrations `0028`–`0031` restore missing canonical catalog rows, install and validate a closed eight-value CHECK on `variants(code)`, then replace the duplicated studies CHECK with a separately validated FK. Unsupported legacy catalog rows stop validation without being rewritten or deleted; a catalog insert alone can no longer broaden any FK consumer. The guard now verifies the seed, catalog CHECK, safe validation order, final studies FK, and absence of the obsolete studies CHECK.
- **CI depends on the Ubuntu package mirror for Stockfish (RESOLVED in M15 Increment 11 / ADR-0121).** The `analysis smoke` job apt-installs Stockfish, and that step has now stalled indefinitely three times: once on PR #140 (cancelled and re-run successfully) and twice post-merge on `cbe6bce` (jobs `96156044656` and `96200357632`, the rerun cancelled after ~34 minutes). Each stall was in the mirror step, before Fairy-Stockfish was installed and before any smoke test ran, so it proves nothing about the code and costs the full job timeout. Fairy-Stockfish in the same job is already a pinned, checksummed release download and has never stalled. **Resolved in M15 Increment 11 (ADR-0121):** Stockfish now comes from release `sf_16`, asset `stockfish-ubuntu-x86-64.tar`, pinned by SHA-256 `efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983`, extracted one member by exact path, `chmod`ed only after verification, and asserted to report `id name Stockfish 16` before the suite runs. `sf_16` is the version apt was already serving, so the engine under test is unchanged. `apt-get` no longer appears in any executable line of any workflow, and the job now carries `timeout-minutes: 15` so a future stall is capped rather than inheriting the six-hour default. Production Docker images used apt until **M15 Increment 12**, which closed the last of it. Before that, `release.yml` built `Dockerfile.api` and `Dockerfile.gateway` on a `v*` tag push and those builds ran the apt layers — meaning production shipped Debian bookworm's `stockfish 15.1-4` while CI proved the engine boundary against 16, and a base-image move to trixie would have made it 17 with no commit of ours. Both images now take the binary from a pinned `stockfish` artefact stage using the same release, asset and digest as CI, with the licence and corresponding source copied beside it for GHCR redistribution, and a `docker-images` CI job builds both before merge instead of first exercising them at release time. `scripts/check-engine-pin-parity.mjs` fails if the four copies of the pin ever disagree.
- **The web image was published but never built before the tag (RESOLVED in M15 Increment 12).** `release.yml` pushes three images to GHCR on a `v*` tag — `Dockerfile.api`, `Dockerfile.gateway` and `Dockerfile.web` — but the `docker-images` CI job as first written built only the two that carry the pinned engine. `Dockerfile.web` copies `docker/web/nginx.conf.template` into `/etc/nginx/templates/`, where the image entrypoint runs `envsubst` over it at container start, so a broken template is not a build error at all: the image builds clean and the container dies on boot, and nothing before the release tag rendered it. Raised in the Qodo review of PR #143. **Resolved in the same increment:** the job builds all three images and checks the web one for what can actually break in it — the entrypoint renders the template with representative loopback upstreams (`nginx -t` resolves a literal `proxy_pass` host at config-load time, so the compose defaults would fail on a runner for the wrong reason), `nginx -t` must accept the result, both upstreams must appear substituted, and `$http_host` and `$uri` must survive, which is what `NGINX_ENVSUBST_FILTER` exists to guarantee and nothing tested. `docker/` joins the `images` path filter so the filter and the job cover the same set.
- **A study movetext walker that never asked which variant it was reading (RESOLVED in M15 Increment 13 / ADR-0122).** `importGame` in `packages/studies/src/import.ts` resolved every SAN through `resolveSan(reader, fen, san)` and `reader.play(fen, san)` with no variant, and `resolveSan` defaults to standard rather than failing — so a Crazyhouse or Three-Check game imported through it would have been validated against standard chess, rejecting legal moves and accepting illegal ones with no error to say why. Latent, not live: a whole-repository search found it referenced only by its own definition and its own test file, and both real import paths (`InMemoryStudiesRepository.buildTreeFromMovetext` via `appendNode`, and `PgStudiesRepository.buildTreeFromMovetextInternal` via a required parameter) already thread the study variant correctly. It was also a third implementation of a descent the two adapters already have, and ADR-0091 §10 records what happened the last time two copies of this walk diverged. **Resolved in M15 Increment 13 (ADR-0122):** deleted, together with the types and the `START_FEN` alias that existed only to serve it; `chapterNameFor` stays, because both adapters import it. `resolveSan`’s standard default is kept and now pinned by a test that states why — `@chess-platform/learning` relies on it and lessons carry no variant of their own. The coverage that was only reachable through the dead function moved onto `resolveSan` itself, and variant propagation through side variations — previously unverified, since the existing three-check test had no variations — is now a mutation-checked regression test.
- **PGN parser (RESOLVED).** Shipped in M10 as `packages/studies/src/pgn-parse.ts` and extended in
  Increment 26 (ADR-0093) to carry suffix annotations.

(Threefold repetition: ✅ implemented in the M2 `Game` aggregate — see Milestone 2.)

---

## ✅ Milestone 2 — Game Authority + event sourcing

- ✅ Deterministic clock model (`clock.ts`): Fischer increment, Bronstein/US
  delay, sudden-death, unlimited; flag detection; speed classification.
- ✅ Event-sourcing types (`events.ts`): `GameCreated`, `MovePlayed`,
  `DrawOffered`/`DrawDeclined`, `GameEnded`.
- ✅ `Game` aggregate (`game.ts`): server-authoritative legality via
  `@chess-platform/core`; commands (`playMove`, `resign`, `offerDraw`,
  `acceptDraw`, `declineDraw`, `claimFlag`, `abort`); pure reducer;
  `Game.fromEvents` reconstructs any game exactly.
- ✅ Terminal handling: checkmate, stalemate, timeout (with insufficient-material
  → draw), resignation, agreement, variant win/draw, abort.
- ✅ **Acceptance met:** 18/18 tests pass. Clock math property tests; a game is
  reconstructed byte-for-byte (FEN, ply, clocks, SAN) from its event log; a
  2,000-game reconstruction runs at ~1.17ms/game (headroom for high
  concurrency). Strict TypeScript, zero errors.

**Follow-ups (tracked):** per-variant timeout material rules (RESOLVED in Increment 34 / ADR-0100). `endByTimeout` called `canMate(fen, winner)` without the variant, so `parseFen` defaulted to `standard` and the classical lone-king / K+N / K+B test was applied to variants where checkmate is not the win condition — a bare king in King of the Hill or Racing Kings, a queen held in a Crazyhouse pocket, and K+N in Three-check or Atomic were all told they could not win, turning a timeout win into a draw. **Resolved in Increment 34 (ADR-0100):** `canMate` takes the variant and answers that variant own question.

**✅ Threefold repetition (implemented):** Position-hash history in the `Game`
aggregate (the aggregate owns history; `core` stays stateless), emitting
`GameEnded('threefold')` on the third occurrence. The repetition key uses the
first four FEN fields (piece placement, side to move, castling rights, en-passant
square) — halfmove/fullmove counters are excluded. (Later amended: Three-Check
appends the delivered-check counters as well, so the key is not only the first
four fields for that variant. Assuming otherwise caused the false-threefold bug
fixed in M15 Increment 8.) The history is part of
`GameState` and survives `Game.fromEvents` replay. Automatic termination on the
3rd occurrence is the accepted scope (a claim-based flow like FIDE OTB is out of
scope). 23/23 tests pass (0 skips); the formerly skipped acceptance test now
passes. En-passant and castling-rights differences correctly do **not** count as
repeats.

## ✅ Milestone 3 — Realtime Gateway (`@chess-platform/realtime-gateway`)

The real-time edge that turns the event-sourced authority into a live,
multi-client game surface.

- ✅ Server-authoritative wire protocol (`protocol.ts`): join, move (with
  `clientSeq`), resign/draw/flag/abort, resume, ping — plus authoritative
  `joined`/`state`/`move`/`ended`/`presence`/`resumed`/`reject`/`pong` frames
  and a default JSON codec (MessagePack seam documented).
- ✅ Game Authority (`authority.ts`): owns live games, validates every command
  via `@chess-platform/game`, appends to an append-only event log, and publishes
  authoritative broadcasts. Commands are **serialized per game** (race-free).
- ✅ Rooms + presence + fanout (`room.ts`, `gateway.ts`): players and spectators
  join a room; moves fan out to all members; presence tracks seats + spectators.
- ✅ Pub/sub fanout seam (`pubsub.ts`): `InMemoryPubSub` for one process; a Redis
  adapter (same interface) documented for multi-node fanout.
- ✅ Transport seam (`transport.ts`): `InMemoryConnection` for deterministic
  tests; a `ws` adapter documented for real sockets.
- ✅ Optimistic-move reconciliation: illegal / out-of-turn / stale-`clientSeq`
  moves return a `reject` referencing the seq so clients roll back.
- ✅ Reconnect/resume from `lastPly`; latency compensation via `ping`/`pong`
  server timestamps + pure client-side clock interpolation (`latency.ts`).
- ✅ **Acceptance met:** 26/26 tests pass, including a reconnection integration
  test and a fanout load test asserting **p99 < 50ms** broadcasting to 5,000
  active subscribers with 50,000 idle connections registered (observed p99
  ~16ms in CI). Strict TypeScript, zero errors. Full-scale network load is
  validated by infra load tests on the deployable service (M14).

**Follow-ups (tracked):** ship the `ws` + Redis production adapters in the
deployable gateway service (M14); binary (MessagePack) move frames; per-user
connection quotas / backpressure (hardened in M12).

## ✅ Milestone 4 — API & identity (REST)

> **Gate status:** The database architecture in [`docs/DATABASE.md`](DATABASE.md)
> is **APPROVED** (see [`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md)).
> Both packages are shipped: **`persistence`** and **`api`**. See
> [`docs/PROJECT_STATE.md`](PROJECT_STATE.md) for the live handover.

Split into two new packages: `persistence` (durable data: schema, migrations,
repositories, the game event store) and `api` (the stateless REST service).
The database architecture is defined and approved in
[`docs/DATABASE.md`](DATABASE.md) **before any DB code is written**.

- ✅ **`persistence` package (`@chess-platform/persistence`).** Append-only
  `EventStore` (in-memory + Postgres) keyed by per-game `seq` with optimistic
  concurrency and `event_version`; forward-only checksum-verified migration runner
  + `0001_init.sql` (event log, identity/RBAC, Glicko-2 ratings, seeks, games
  projection, observability-rich audit log; lookup tables + CHECK, not ENUM);
  UUIDv7 ids; verified Glicko-2; typed repositories (users/credentials/roles,
  sessions with security metadata, ratings, games, seeks). 14 tests pass
  (Postgres integration tests gated on `DATABASE_URL`); the play→store→
  `Game.fromEvents` round-trip is verified. Strict TS, zero errors.
- ✅ REST API + published **OpenAPI** spec (GraphQL deferred — see note below).
  Node built-in HTTP + a typed router with DI (`createApiServer`); OpenAPI 3.1
  generated from the live route table and committed to `packages/api/openapi.json`.
- ✅ Identity: **`PasswordHasher` abstraction with a scrypt default** (argon2id is
  a drop-in — the stored hash is self-describing), session + **refresh-token
  rotation with revocation and reuse (theft) detection**, RBAC
  (user/coach/tournament-director/moderator/admin). WebAuthn/passkeys were deferred
  at this original M4 cut and later delivered as server ceremonies in the M4
  hardening pass plus a real browser flow in M14 Inc 44 (ADR-0027, ADR-0108).
- ✅ Users, profiles, seeks/lobby, **Glicko-2 ratings per variant**, leaderboards
  (rating math implemented in `persistence`, surfaced by `api`).
- ✅ Durable **event store** for games so the M3 authority can persist and
  rehydrate game state exactly from its log (authority wiring lands with the
  deployable service in M14).
- **Acceptance:** ✅ authZ-matrix tests (in `api`); ✅ rating updates verified
  against a Glicko-2 reference (in `persistence`); ✅ OpenAPI published
  (`packages/api/openapi.json`, served at `/v1/openapi.json`); ✅ DB integration
  tests (ephemeral Postgres, gated on `DATABASE_URL`); ✅ game persistence
  round-trip (store → `Game.fromEvents` → identical state, in `persistence`).

> **Roadmap decision (M4):** GraphQL is intentionally deferred. Shipping REST +
> GraphQL together doubles the security/ops surface (query-cost limiting,
> persisted queries) for no near-term gain — gameplay real-time is already the
> WebSocket gateway's job. A GraphQL read layer is introduced with the
> features that justify nested, client-driven reads (studies, master-game
> explorer, social graph) in **M10–M11**.
>
> **Resolved (M10 increment 8):** shipped as a read-only `POST /v1/graphql` behind
> `GRAPHQL_ENABLED=1` — see [`docs/adr/0073-graphql-read-layer.md`](adr/0073-graphql-read-layer.md).
> The two costs named above are paid explicitly: query cost is bounded by depth, complexity and
> alias limits enforced before execution, and the surface is halved by staying queries-only, so
> every write keeps its single REST authorization review. Persisted queries were not needed to
> bound cost and are not implemented.

## ✅ Milestone 5 — Engine bridge (`@chess-platform/engine`)

> **Gate:** APPROVED — design in [`docs/ENGINE_BRIDGE.md`](ENGINE_BRIDGE.md); decisions in
> [`docs/adr/0002-engine-bridge.md`](adr/0002-engine-bridge.md) (Status: Accepted). The package
> is **implemented and green**; a real-engine golden test and the authority↔bot wiring are
> env-gated / deferred to M14, mirroring the M3/M4 scope split.

Provider-agnostic UCI engine bridge behind clean seams (`AnalysisProvider`, `EngineManager`,
`EnginePool`, `EngineInstance`, `EnginePlugin`, `AnalysisCache`, `EngineTransport`) driving
analysis, hints, eval bars, and rating-calibrated bots — never in the gameplay legality path.

- ✅ Dependency-free domain; native processes and any client isolated behind seams.
- ✅ Multi-engine, capability-discovery routing (Stockfish + Fairy-Stockfish + future engines);
  no engine-name conditionals; engine version negotiation + build fingerprinting.
- ✅ Worker lifecycle: warm pool, autoscale by queue depth, crash detection + hot replacement,
  per-pool circuit breaker, graceful drain, health interfaces.
- ✅ Priority scheduler (bot > live analysis > batch > background) with aging + backpressure;
  cooperative + hard (watchdog) cancellation.
- ✅ `AnalysisCache` port with in-process LRU default (durable backend deferred — future ADR-0003,
  so M5 does not touch the approved `DATABASE.md` contract).
- ✅ **Acceptance (in-package, deterministic):** 51/51 tests pass against a `FakeEngineTransport`
  — info/multi-PV parsing, pool autoscaling under queue pressure, crash → hot-replacement with no
  job loss, circuit-breaker trip, graceful drain, cancellation, watchdog kill, version-floor
  enforcement, cache correctness, and a full scripted bot game. Strict TypeScript, lint clean.
- ⬜ **Deferred to M14 (deployable service):** real-engine golden test (env-gated; needs a pinned
  binary in CI), live-infra autoscaling, and distributed remote workers.

## ✅ Milestone 6 — Web frontend (playable)

- Board UI (animation, premoves, drag + click), clock, game view, lobby,
  profile; PWA; a11y; light/dark.
- **Acceptance:** e2e (Playwright) plays a full game vs. bot and vs. human;
  Lighthouse a11y ≥ 95.
- 🚧 **Increment 1 landed:** `@chess-platform/web` scaffold + dependency-free view core (board geometry, premove queue, chess clock, FEN placement) with 21 passing `node --test` tests, strict-TS + lint clean. Next: interactive board, REST/WS client seam, Playwright e2e, Lighthouse gate.
- 🚧 **Increment 2 landed:** interactive board — drag & drop, click-to-move, selection/legal-destination/last-move/premove highlighting, promotion UI, and premove application; legality behind a `LegalMoveOracle` port (server authoritative) + view-only optimistic mover. 54 `node --test` tests green, strict-TS + lint clean. Next: REST/WS client seam.
- 🚧 **Increment 3A landed:** REST networking foundation — a `fetch`-based `HttpTransport` port, an `HttpClient` (per-request timeout, safe-method retry with exponential backoff + jitter, JSON, and a typed error taxonomy), hand-authored request/response models mirroring `packages/api/openapi.json`, the typed `GambitClient` (health, auth/session, users/profile, ratings, leaderboard, game summaries), and a session/auth abstraction (pluggable token store + proactive, single-flight token refresh with 401 replay). Framework-independent, UI kept separate from networking; no WebSocket / lobby / gameplay sync yet. 94 `node --test` tests green, strict-TS + lint clean, production build passes. Next (3B): WS game stream + core/server-backed move oracle, wired into the app/game view.
- 🚧 **Increment 3B landed:** WebSocket foundation + gameplay synchronization — a `WebSocketConnection` port + browser adapter, a typed `WsClient` (connection state machine, automatic reconnect with exponential backoff + jitter, ping/pong heartbeat with silent-link detection), hand-authored wire-protocol models mirroring `packages/realtime-gateway/src/protocol.ts` with a JSON codec, and a `GameSync` synchronization layer (join/resume lifecycle, authoritative snapshot + live move ledger, optimistic move tracking with `clientSeq`-based confirm/rollback, ply-gap resync, presence/ended/draw-offer state). Framework-independent, networking kept separate from UI; no lobby/matchmaking/profile UI yet. 115 `node --test` tests green, strict-TS + lint clean, production build passes. Next: wire the REST + WS clients into the app composition root and game view.
- 🚧 **Increment 3C-1 landed:** application composition root — a single `src/app/` layer (`createApp` + `resolveConfig` + `mountBoard` + `bootstrap`) that wires the REST stack (`GambitClient` = `HttpClient` + `SessionManager`), the realtime `WsClient`, and a per-game `GameSync` factory via **dependency injection**, with browser adapters (`fetch` / `WebSocket` / `localStorage`) as defaults and fakes injected in tests; `main.ts` is reduced to a thin DOM entry, and the UI is kept separate from infrastructure (the board module composes UI + core only, importing no networking). **Wiring only** — no connection is opened, no gameplay synchronization, and no server-backed move oracle. 121 `node --test` tests green, strict-TS + lint clean, production build passes. Next (3C-2): connect the board/game view to `WsClient` + `GameSync` and a server-backed move oracle.
- 🚧 **Increment 3C-2A landed:** the authoritative `StateView` now carries a typed `legalMoves` map (origin square → legal destination squares) for the side to move, **computed server-side by the perft-verified core engine** in the realtime-gateway `GameAuthority` (empty once the game is over); the WS protocol and its web mirror (`ws-protocol.ts`) are extended in lockstep. The frontend consumes the contract only — no chess rules in the client, no `@chess-platform/core` import in `web`. Tests green (gateway +3, web +1), strict-TS + lint clean, production build passes. This is the first of three steps toward the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Next (3C-2B): surface `legalMoves` through `GameSync` and implement the `LegalMoveOracle` adapter behind its port; then (3C-2C) wire it into the composition root.
- 🚧 **Increment 3C-2B landed:** `legalMoves` is now surfaced through `GameSync` state — populated from each authoritative `StateView` snapshot, stale (empty) after a live move broadcast until the next snapshot/resync, and empty once the game ends. A new `AuthoritativeMoveOracle` adapter (`packages/web/src/net/authoritative-oracle.ts`) implements the existing `LegalMoveOracle` port, reading the `legalMoves` map from `GameSync` state via an injected getter — no chess rules in the client, no `@chess-platform/core` import in `web`. 131 `node --test` tests green (web +9), strict-TS + lint clean, production build passes. This is the second of three steps toward the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Next (3C-2C): wire the `AuthoritativeMoveOracle` into the composition root / board.
- 🚧 **Increment 3C-2C landed:** the `AuthoritativeMoveOracle` is now wired into the composition root — `createApp` exposes `createGameOracle(gameSync)` which builds an `AuthoritativeMoveOracle` reading the live `legalMoves` from `GameSync` state, and `mountBoard` accepts an optional `LegalMoveOracle` (defaulting to `NullMoveOracle`) so the board's legal-move highlights reflect the server's authoritative state. The offline `StaticMoveOracle` placeholder is removed. 133 `node --test` tests green (web +2), strict-TS + lint clean, production build passes. The three-step server-backed `LegalMoveOracle` (ADR-0003, Option 2) is complete.
- 🚧 **Increment 3D landed:** a pure, DOM-free `GameController` (`packages/web/src/app/game-controller.ts`) bridges `GameSync` state to the board UI — it subscribes to state changes, projects the current FEN from the snapshot + move ledger via the view-only mover, exposes callbacks for position/turn/clock/status updates, and forwards move submissions to `GameSync`. 9 `node --test` tests green (web +9), strict-TS + lint clean, production build passes. Next: wire the controller callbacks to the DOM `BoardView` in `bootstrap.ts`, then lobby/profile/PWA/a11y/light-dark.
- 🚧 **Increment 3E landed:** the full live game view wiring — `bootstrap.ts` now assembles the complete game view graph (GameSync + GameController + AuthoritativeMoveOracle + mountBoard with oracle and onMove callback), connecting the controller's callbacks to the DOM BoardView (position, last-move highlight, turn, clock display, status text) and forwarding user moves through the controller to GameSync. `mountBoard` exposes `setPosition`/`setLastMove`/`setTurn` on the `MountedBoard` handle and accepts an `onMove` callback for server-authoritative mode. `extractGameId` parses the game ID from the URL path; `formatClock` formats ms as M:SS. Clock display CSS added. 17 new `node --test` tests green (web +17, 159 total), strict-TS + lint clean, production build passes. Next: lobby UI, profile, PWA, a11y, light/dark, then Playwright e2e + Lighthouse gate.
- 🚧 **Increment 3F landed:** lobby controller (`packages/web/src/app/lobby-controller.ts`) — a pure, DOM-free orchestrator that manages the seek list lifecycle (fetch, create, cancel) via the new `SeeksApi`; client-side router (`packages/web/src/app/router.ts`) with typed `Route` parsing for `/`, `/game/{id}`, `/profile`, `/profile/{handle}`; `SeeksApi` added to `GambitClient` (list/create/cancel seeks); `SeekView`, `CreateSeekRequest`, `TimeControl` types added to API models. 20 new `node --test` tests (lobby controller 7, router 11), strict-TS + lint clean. Next: wire lobby UI to DOM in bootstrap, profile page, PWA, a11y, light/dark, then Playwright e2e + Lighthouse gate.
- 🚧 **Milestone 4G landed:** lobby UI wiring — `LobbyController` connected to DOM (seek list rendering, create-seek button, cancel via event delegation); profile controller (`packages/web/src/app/profile-controller.ts`) with profile/ratings/games display; theme toggle (`packages/web/src/app/theme-toggle.ts`) with light/dark switching persisted to localStorage; client-side routing via `parseRoute` driving view selection (lobby/game/profile); updated `index.html` with nav, lobby, profile, and theme-toggle DOM elements; lobby/profile/theme CSS. 18 new tests (profile controller 6, theme toggle 8), web suite now 197 tests. Next: PWA, a11y audit, Playwright e2e + Lighthouse gate.
- 🚧 **Milestone 4H landed:** PWA infrastructure (manifest.webmanifest, service worker with app-shell caching), a11y tests (13 tests validating ARIA structure, skip link, semantic HTML, keyboard navigation), Playwright e2e setup (config + smoke tests for app load, board visibility, nav, theme toggle, skip link), main.ts updated with SPA routing (pushState + popstate) and service worker registration. 13 new a11y tests, web suite now 210 tests. M6 is feature-complete pending full Playwright e2e + Lighthouse gate with running backends.
- 🚧 **Review #04 fixes applied:** C1 router compile fix, C2 SW rework (no API caching, network-first nav), C3 PWA icons, C4 @playwright/test + acceptance specs + auth controller, M2 session-gated lobby, m1-m4 minor fixes. M6 remains 🚧 pending full Playwright + Lighthouse acceptance.
- ✅ **M6 acceptance gate PASSED (merged in PR #4):** both acceptance specs play full games through **real DOM clicks** — vs-human plays a complete Fool's Mate to checkmate with the terminal state asserted in both players' UIs, and vs-bot plays real moves with the bot replying and resigning (via the `botResignsAfterPlies` harness lever). Driven by the `@chess-platform/e2e-harness` package (real in-memory API + gateway + bot) so the specs exercise genuine HTTP + WebSocket flows. Lighthouse a11y: **0.95** (≥ 0.95 gate). The gate exercise surfaced and fixed two real product bugs: the session token was never passed into the WS join, and session/theme storage was never wired into the real app (both invisible to unit tests, caught only by driving the real UI). CI verified green (Node 22 + 24 + Postgres + Playwright/Lighthouse). **M6 complete.**

## ✅ Milestone 7 — AI orchestration layer

- Provider adapters (OpenAI-compatible HTTP adapter covering OpenAI, DeepSeek, OpenRouter,
  Ollama; Anthropic adapter), routing, benchmarking, engine-grounded prompts, caching, rate limits.
- **Voting/ensemble deferred to M8** (AI features) — ensemble behavior belongs with concrete
  AI feature use cases, not the orchestration framework.
- **Acceptance:** failover test (kill a provider mid-request); benchmark report;
  grounded move-explanation cited against engine eval.
- 🚧 **Implementation in progress:** `@chess-platform/ai-orchestrator` — provider-agnostic
  AI orchestration layer with `AiProvider` interface (complete/stream/embed),
  `AiOrchestrator` (routing + failover + cache + rate limit + health), `ProviderRegistry`
  (plugin-oriented, capability-based), `RoutingStrategy` (priority/weighted/round-robin),
  `ResponseCache` port (InMemoryLruCache), `RateLimiter` (per-user + global), `HealthTracker`
  (rolling window + circuit breaker with explicit half-open transition), `BenchmarkRunner`
  (curated chess tasks → report), engine-grounded prompting (`EngineGrounding` → provider-agnostic
  system messages), `FakeProvider` for deterministic testing.
  **HTTP adapters:** `OpenAiCompatibleAdapter` (covers OpenAI, DeepSeek, OpenRouter, Ollama via
  configurable baseUrl) and `AnthropicAdapter` (Anthropic Messages API). Both use global `fetch`
  (no SDK dependencies). Env-gated integration tests skip without API keys.
  **Engine grounding:** `engineResultsToGrounding()` bridges `@chess-platform/engine` analysis
  results into `EngineGrounding` for LLM prompts. Hermetic test using simulated engine results.
  **Voting/ensemble deferred to M8** (AI features) — ensemble behavior belongs with concrete
  AI feature use cases. ADR-0005 accepted.
- ✅ **M7 complete (merged in PR #5):** clean-tree `npm ci` → build → test → lint verified green; `@chess-platform/ai-orchestrator` adds 114 tests (2 env-gated real-API integration tests skip without keys). CI verified green on Node 22 + 24 + Postgres after fixing the Lighthouse Chrome-launch step (point Lighthouse at Playwright's Chromium via `CHROME_PATH`; environmental launch failures warn-and-pass, genuine a11y regressions still fail). Whole repo now 8 packages.

## ✅ Milestone 8 — AI features

Coach, Move Explanation, Opening/Endgame Trainer, Puzzle Generator, Tournament
Commentator, Voice Coach, Study Partner, Opening Explorer, Mistake Predictor —
each a task over M5 + M7.

M8 ships as a sequence of small, independently reviewable increments — one
feature per PR. Architecture recorded in
[ADR-0006](docs/adr/0006-ai-features.md).

### Increment 1: Move Explanation ✅

`MoveExplainer` — given a position (FEN) and a played (or candidate) move
(UCI), produces a natural-language explanation grounded in real engine
analysis. The explanation cites the engine's eval (cp/mate) and best line as a
distinct, testable `EngineCitation` field — not prose the test has to parse.

- New package `@chess-platform/ai-features` (`packages/ai-features`), depending
  on `@chess-platform/engine` + `@chess-platform/ai-orchestrator` only.
- Everything behind ports: `AnalysisProvider` (M5) + `AiProvider` (M7) are
  constructor-injected. Fully testable hermetically with `FakeEngineTransport`
  + `FakeProvider` — no keys, no binary, no network.
- Engine grounding path: `AnalysisProvider.analyze()` →
  `engineResultsToGrounding()` → `buildGroundedMessages()` →
  `AiProvider.complete()`.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite drives `MoveExplainer` end-to-end with
    `FakeEngineTransport` + `FakeProvider`, asserting the explanation carries
    the correct grounded eval and best-line citation for a known position.
  - One env-gated integration test (skips without an API key, exactly like M7's
    adapter tests) runs the real path against a real provider.
  - Package added to root build/test/lint/clean chains and CI workflow test
    matrix.
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ADR-0006 recording the M8 feature architecture and why Move Explanation is
    the template.
  - Regenerated `package-lock.json` committed in the same commit as the new
    package.

### Increment 2: Puzzle Generator ✅

`PuzzleGenerator` — given a position (FEN), determines whether it contains a
sharp tactical puzzle and, if so, produces a structured puzzle. Puzzle validity
is an objective, testable engine fact: the generator runs the engine with
`multiPv: N` and a position qualifies when the best line's eval exceeds the
second-best by a configurable threshold (default 200 cp) or the best line is
mate and the second-best is not. The LLM never decides whether a puzzle is real.

- Follows the established template (ADR-0006): ports injected, engine-verified
  structured fields, hermetic tests with fakes.
- The puzzle's correctness fields (solution move, eval gap, best line) come
  entirely from the engine. The AI provider's role is only the human-facing
  flavour (theme/hint) — additive, never load-bearing. If no AI provider is
  supplied, the generator still returns a fully valid puzzle.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: sharp position → `Puzzle` with correct
    engine-derived solution/gap/best-line; quiet position → `PuzzleRejection`
    with measured gap; mate-vs-non-mate → qualifies; AI omitted → valid puzzle
    with engine fields and no LLM text.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ROADMAP updated; ADR-0006 unchanged (follows the established template).

**Productionized in M15 Increment 17 (ADR-0125).** The game sidebar now exposes an authenticated,
capability-gated **Find tactic** action backed by one fixed MultiPV-3 request through the existing
API-owned `AnalysisService` and engine pool. The production contract is
`puzzle | no_tactic | insufficient`, with tagged centipawn/mate evidence and nullable missing moves;
it never serialises `Infinity`, `NaN`, or `"(none)"`. Engine limits and the 200 cp threshold are
server-owned, the endpoint has a separate expensive-work quota, and the UI keys each response to
exact variant + FEN. This adds no LLM hints/themes, persistence, ratings, sharing, spaced repetition,
Chess960 implementation, or second engine pool.

### Increment 3: Mistake Predictor ✅

`MistakePredictor` — given a position (FEN) and a candidate move the player is
considering, determines whether that move is a mistake and how severe. Mistake
severity is an engine-measured delta, not an LLM judgment: the predictor
analyses the original position (`evalBefore`), applies the candidate move with
`@chess-platform/core`'s `Position.play()`, analyses the resulting position
(`evalAfter`), normalises the eval to the mover's perspective (negating the
sign since it is now the opponent's turn), and computes
`centipawnLoss = evalBefore − evalAfterMoverPerspective`. Classification uses
standard thresholds (inaccuracy ≥ 50 cp, mistake ≥ 100 cp, blunder ≥ 300 cp,
configurable). A move that walks into a forced mate is always a blunder.

- Follows the established template (ADR-0006): ports injected, engine-verified
  structured fields, hermetic tests with fakes.
- The verdict's correctness fields (evalBefore, evalAfter, cp loss, better
  move) come entirely from the engine. The AI provider's role is only the
  human-facing coaching text — additive, never load-bearing. If no AI provider
  is supplied, the predictor returns a fully valid verdict.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: clear blunder → `blunder` with correct cp
    loss and better move; good move → `ok`; inaccuracy and mistake at threshold
    boundaries; sign-correctness test proving the perspective flip; move into
    mate → `blunder`; AI omitted → valid verdict with engine fields and no LLM
    text.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ROADMAP updated; ADR-0006 unchanged (follows the established template).

> **Superseded in part by M15 Increment 5 (ADR-0118).** The account above is what M8 shipped and
> stays as written. Productionising this feature found that four of its behaviours were defects:
> the requested variant never reached `Position`, so legality and adjudication ran under standard
> rules whatever the caller asked for; the post-move search always ran, so a decided position
> returned the engine placeholder and **delivering checkmate classified as a `blunder`**;
> `centipawnLoss` could be `Infinity`; and the thresholds described as "configurable" above were
> configurable *by the caller*, which let a request declare its own blunder acceptable. All four are
> fixed, and the thresholds are now server-owned at the same 50/100/300 values.

### Increment 4: Opening Explorer ✅

`OpeningExplorer` — given a game's move sequence (from the start), identifies
the opening and explains the position. This is the first M8 feature whose
primary facts are not engine evals: opening identification comes from an
`OpeningDatabase` port backed by a small, curated, original bundled dataset
(Ruy Lopez, Sicilian Najdorf, Queen's Gambit, etc.). The explorer finds the
deepest matching opening (longest known line), returns ECO code, name,
continuations, and optional stats. A non-book sequence returns a clean "no
known opening" result — never a fabricated one.

- Introduces a **new port type** (`OpeningDatabase`) — the first non-engine
  data source in M8. Sets the pattern for future data-backed features
  (endgame tablebase, etc.). ADR-0006 updated to record this.
- Optionally enriches with the engine (M5): if an `AnalysisProvider` is
  supplied, evaluates the current position. Optional — the explorer returns a
  valid result from the opening DB alone.
- The AI provider's role is only the human-facing narrative — additive, never
  load-bearing. If no AI provider is supplied, the result is fully valid.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: known opening → correct ECO/name/continuations;
    prefix-then-diverge → deepest match with `outOfBook: true`; non-book
    sequence → clean "no known opening"; engine omitted → DB fields only;
    AI omitted → valid result with no LLM text.
  - Bundled dataset is original, compact, documented, and unit-tested for
    internal consistency (every entry's move sequence is legal).
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ADR-0006 updated with the new port type and bundled-dataset decision.
  - ROADMAP updated; M8 remains 🚧.

**Productionized in M15 Increment 19 (ADR-0127).** The game sidebar now exposes an authenticated,
capability-gated **Identify opening** action backed by `POST /v1/openings/explore`. It is the first
M8 productionization that borrows no engine and no AI provider: the answer is a bundled-table lookup
plus a legality replay, so a deployment with no `STOCKFISH_PATH` and no provider key serves it in
full, and `openingExplorer` is therefore the one capability flag that neither implies nor is implied
by `analysis`. The server owns every policy — `standard` only (required, so another variant is
refused rather than silently answered), the standard start position only, and a 60-ply ceiling that
refuses rather than truncates, because `lookup` matches on a prefix and a truncated answer would
usually look right. **The bundled statistics are not published.** The dataset's own header calls its
`games`/`whiteWins` figures "approximate aggregate figures for illustration … not sourced from a
specific database", so the projection that reaches the wire has no field to carry them and
`additionalProperties: false` keeps it that way; real statistics need a real corpus. Transpositions
remain unidentified — `lookup` keys on the move sequence, not the position — and that is now pinned
by a test rather than quietly widened. This adds no engine evaluation, LLM narrative, opening
statistics, master-game database, position-keyed matcher or Chess960 support.

### Increment 5: Endgame Trainer ✅

`EndgameTrainer` — serves a training endgame and, given a learner's attempted
move, evaluates it against the engine's solution and coaches. Pairs naturally
with Opening Explorer (increment 4) and reuses two established patterns: a
bundled-dataset port (`EndgameDatabase` / `BundledEndgameDatabase`) for the
training positions, and engine analysis with perspective-flip logic (from
Mistake Predictor, increment 3) for the solution and move evaluation.

- Two entry points: `nextPosition(request)` selects a training position and
  returns it with the engine-verified solution; `evaluateAttempt(request)`
  judges the learner's move (optimal / acceptable / throws_result) and whether
  the goal (mate / win / draw) is preserved.
- The dataset supplies the position and goal; the engine judges; the LLM
  provides only the teaching narrative. All correctness fields come from the
  engine — the LLM never decides whether a move is correct.
- Bundled dataset: ~20 classic instructive endgames (K+Q vs K, K+R vs K,
  K+P vs K, Lucena, Philidor, opposition, K+BB vs K, K+BN vs K, etc.).
  Original, compact, documented, unit-tested for internal consistency.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: `nextPosition` returns goal + engine solution;
    optimal move → `optimal`, goal preserved; move that throws away the win →
    `throws_result`, goal lost; sign/perspective test proving the flip;
    mate distance surfaced correctly; AI omitted → valid results, no LLM text.
  - Bundled dataset original, compact, documented, unit-tested.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006: follows established patterns (bundled-dataset port + perspective
    flip), short note added.
  - ROADMAP updated; M8 remains 🚧.

**Productionized in M15 Increment 20 (ADR-0128).** `POST /v1/endgames/next` and
`POST /v1/endgames/attempt`, with a dedicated `/endgames` route. The engine is load-bearing here,
unlike the Opening Explorer's, so this borrows the API-owned `AnalysisService` the way the Puzzle
Generator does and adds no pool; it is stateless, so no table and no migration; and no AI provider
is composed, so the coaching narrative stays off the wire. **The learner is not handed the answer:**
`TrainingPosition` carries a full solution, and serving it beside the exercise would put the answer
in the response that asks the question — the defect ADR-0095 fixed for lesson steps. `/next`
publishes the position and the objective only and makes no engine call at all, so
`EndgameTrainer.nextPosition` is deliberately unused. The authored `goal.distance` never leaves the
dataset either, for the ADR-0127 reason. Three library hazards are contained rather than inherited:
`legacyCpLoss` returns `Infinity` (hence a tagged `loss` union), the `'(none)'` sentinel never
reaches JSON, and `random()` silently ignores its filter when nothing matches, so selection filters
the catalogue itself and refuses instead of serving an endgame nobody asked for. The one that
mattered most was not foreseen: a move that ends the game leaves `AnalysisService` with empty
`lines` and a `terminal`, so checking only `lines.length` reported the engine as unavailable at the
exact moment a learner stalemated the opponent — the classic K+Q blunder this trainer exists to
teach. The attempt outcome is therefore a `judged | terminal` union, because a decided position is
a result rather than a score (ADR-0116). The UI is its own route, not a sidebar section: every
sidebar section is about the position already on the board, and that board belongs to the live game.
Coach, Study Partner and Voice Coach remain deferred; Coach is unblocked by this increment.

### Increment 6: Coach ✅

`Coach` — a composition layer that orchestrates the five existing feature
classes (`MoveExplainer`, `MistakePredictor`, `PuzzleGenerator`,
`OpeningExplorer`, `EndgameTrainer`) into a unified coaching response. Given a
position (FEN) and optionally a move, the Coach decides which features are
relevant, calls them, and aggregates their structured outputs.

- Introduces the **composition/orchestration pattern**: a feature built from
  features. The Coach calls the underlying features; it does NOT re-implement
  their logic. Study Partner and Tournament Commentator will follow the same
  shape. ADR-0006 updated to record this.
- Every fact in the response is traceable to a feature's engine-verified
  output. The Coach's synthesized narrative is additive; if no AI provider is
  supplied, the Coach returns all structured feature results with no narrative.
- Degrades gracefully: if a feature reports "not applicable" (no opening match,
  not a puzzle, not an endgame, move is fine), the Coach omits that section —
  it never fabricates a lesson.
- Stateless — no session, no conversation memory (Study Partner will add that).
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: blunder → MistakePredictor + MoveExplainer;
    in-book → OpeningExplorer; sharp → puzzle; endgame → guidance; quiet
    non-book non-tactical non-endgame → NO fabricated lessons; AI omitted →
    structured results, no narrative; spy test proving the Coach calls the
    underlying features.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006 updated with the composition/orchestration pattern.
  - ROADMAP updated; M8 remains 🚧.

**Productionized in M15 Increment 21 (ADR-0129).** `POST /v1/coach`, as a section of the existing
game analysis sidebar rather than a route of its own — every sidebar section is about the position
already on the board, and coaching is exactly that. The `Coach` class in `ai-features` is
deliberately **not** what production runs. Its constructor builds its own `MoveExplainer`,
`MistakePredictor`, `OpeningExplorer`, `PuzzleGenerator` and `EndgameTrainer` on the raw engine
port, which would route every coaching request around all five production services and therefore
around every policy they own: the standard-only opening gate and its 60-ply ceiling (ADR-0127), the
finiteness guards and the `judged | terminal` union (ADR-0128), the terminal adjudication that
stopped checkmate reading as `+0.00` (ADR-0116), and the answer withholding of ADR-0095. None of
that would fail loudly — it would produce plausible coaching with the guards missing. So the service
calls the same five services the five routes call and adds nothing but sequencing.

**A section may never publish more than its own route does.** Four of the five render through the
feature's existing presenter, so there is no second projection to drift; the OpenAPI section schemas
`$ref` the same response schemas. The endgame section reaches the catalogue through a new
`identify(fen)` that shares `next`'s projection, closing a real back door — a learner with a
training position open could otherwise have pasted its FEN into `/v1/coach` and read the answer
`/v1/endgames/next` withholds. The puzzle section is the one deliberate narrowing: it drops
`solutionMove` and `solutionLine`, because "there is a tactic here" is a coaching prompt and
"there is a tactic here and it is `c6d4`" is the answer.

**It degrades by section**, each carrying an explicit reason rather than a null — and `unsupported`
(this deployment never built the feature) is kept apart from `unavailable` (it failed this time),
because only the second is worth retrying. The request fails only when nothing was delivered *and*
something is broken: "every section unavailable" is unreachable once three are `not_requested`, and
"nothing fired" would turn a genuinely quiet position into an error.

**Four engine searches, not five.** Mistake prediction and move explanation both issue a
byte-identical MultiPV 1 search of the position; `RequestScopedAnalysis` collapses it, keyed on the
complete argument set and storing the promise so concurrent duplicates coalesce rather than race.
The engine's own LRU would collapse the sequential case, but it has no single-flight and is
configurable, so the bound would have depended on `cacheEntries`. Sections run in sequence, never
`Promise.all`: concurrency would multiply the acquisitions one request holds, defeat that
de-duplication, and leave nothing to cancel. Its own 8/min bucket, and composing the services
internally charges none of theirs — the services never touch the limiter, and the `onAccepted`
callback comes from the route.

**Cancellation is wired for the first time.** `AnalysisRequest.signal` always existed in the engine
layer, but `RequestContext` carried no signal, no route observed disconnect, and `analyze` accepted
none. The router now derives one from the response's `close` event (the response, not the request,
whose `close` fires as soon as the body is received), and `analyze` combines a caller's signal with
its timeout via `AbortSignal.any` — combined, never substituted, so a caller can shorten a search
but never lengthen it past the ceiling.

Study Partner, Voice Coach, Tournament Commentator and the LLM narrative remain deferred.

### Increment 7: Study Partner ✅

`StudyPartner` — a stateful multi-step learning session that tracks the
learner's progress across several positions/moves. This is the first M8 feature
with session state.

- Introduces the **stateful-session pattern**: a `StudySessionStore` port
  (create / load / save / end) with an `InMemoryStudySessionStore` default
  adapter. Session state is explicit and serializable (plain data object: id,
  topic, turns, progress metrics). No hidden mutable state on the class
  instance. ADR-0006 updated to record this.
- The Study Partner orchestrates the Coach; it does not re-implement analysis.
  Each turn, it uses the `Coach` to analyze, records the outcome, and advances
  the learning plan. Verified chess facts still originate from the engine via
  the features.
- Three entry points: `startSession` (create + first step), `submitTurn` (run
  Coach + append + update progress), `endSession` (mark complete + summary).
- Progress metrics are computed by a pure function (`computeProgress`) from the
  recorded turns — making accounting testable without running the full session.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: startSession creates + persists; submitTurn
    runs Coach + appends + updates progress (assert metrics = exactly what
    turns imply); session isolation (two sessions don't corrupt each other);
    endSession summary consistent; non-existent session → clean error; AI
    omitted → valid sessions with no narrative; spy test proving the Study
    Partner calls the Coach.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006 updated with the stateful-session pattern.
  - ROADMAP updated; M8 remains 🚧.

### Increment 8: Voice Coach ✅

`VoiceCoach` — turns coaching output into speech-ready text. The Voice
Coach composes the `Coach` (it does not re-implement analysis); its real,
tested contribution is the **verbalization logic**: converting a
`CoachingResponse` and chess moves into natural spoken English.

- Introduces the **speech-ports pattern** — the pattern for any future
  device/IO-bound feature. Voice is split into **logic** (built now,
  hermetic) and **delivery** (deferred to the deployment layer via ports).
  `SpeechSynthesizer` (text → audio) and `SpeechRecognizer` (audio →
  text/command) ports are defined with fake/text-based default adapters
  for hermetic testing. A real TTS/STT adapter implements these same
  ports in the deployment layer (M13/M14) without touching this feature.
  ADR-0006 updated to record this decision.
- The core engineering idea: **chess notation is not speakable**, and that
  transformation is pure, deterministic, and exhaustively unit-testable.
  `Nxe5` → "Knight takes e five"; `O-O` → "castles kingside"; `e8=Q` →
  "e eight, promotes to queen"; `+` → "check"; `#` → "checkmate";
  `Qd1` → "Queen to d one". Coordinates spoken as "e five", not "e5".
  Uses `@chess-platform/core`'s `Position.toSan` to get standard notation,
  then transforms it to the spoken form via `verbalizeSan` / `verbalizeUci`.
- All chess facts still come from the Coach/features (engine-verified).
  The Voice Coach only reshapes text for speech; it invents no
  assessments. If no AI provider is supplied, it still verbalizes the
  structured engine facts — the move-to-speech transform needs no LLM;
  the LLM, if present, only smooths the connective narrative.
- Returns a structured `SpokenCoaching`: an ordered list of `SpokenSegment`
  objects (each a short natural-language string with a `kind` tag for
  optional prosody), plus the underlying `CoachingResponse` for
  traceability. Sentences are kept short and clearly segmented so a
  synthesizer can pace them.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite:
    - **Exhaustive move-to-speech table test**: piece moves, captures
      (`Nxe5` → "Knight takes e five"), both castlings, promotion
      (`e8=Q`), check (`+`), checkmate (`#`), pawn moves, pawn captures,
      disambiguated moves (`Nbd7`, `R1e2`, `Qh4e1`) — assert each spoken
      form. A verbalizer that reads `Nxe5` literally as "N-x-e-5" is
      broken.
    - Full `verbalize(coachingResponse)` producing an ordered segment
      list from a coaching response with a blunder + better move → assert
      the segments say the right things in speakable form.
    - The Coach is actually called (spy/fake), not re-implemented.
    - AI provider omitted → valid spoken segments from engine facts, no
      LLM narrative.
    - The fake `SpeechSynthesizer`/`SpeechRecognizer` ports are exercised,
      proving the seam works.
  - One env-gated integration test (skips without `OPENAI_API_KEY` /
    `ANTHROPIC_API_KEY`) for the narrative-smoothing path.
  - Clean-tree verification: `rm -rf node_modules packages/*/dist
    packages/*/dist-test && npm ci && npm run build && npm test && npm
    run lint` — all green.
  - ADR-0006 updated with the speech-ports + deferred-delivery decision.
  - ROADMAP updated; **M8 ✅ complete**.

### M8 completion

**M8 is complete.** 8 features delivered: Move Explanation, Puzzle
Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach,
Study Partner, Voice Coach. 1 feature explicitly deferred: **Tournament
Commentator** is deferred to M9 because it requires live-tournament
infrastructure (tournament state, game feeds, broadcast integration) that
does not exist yet. The deferral is honest and explicit — 8 features
delivered, 1 deferred with a reason.

## ✅ Milestone 9 — Tournaments & broadcast

Arena + Swiss + round-robin, pairings, tiebreaks, live broadcast multiplexing.

**M9 is complete** (12 increments, ADR-0014 → ADR-0024): a pure tournament
domain package (`@chess-platform/tournament`) with round-robin (Berger
circle method), Swiss (deterministic Monrad/Dutch-lite with backtracking
match), and Arena (continuous pairing, streak scoring, fixed duration);
Sonneborn-Berger/Buchholz standings; snapshot persistence (in-memory +
Postgres); a REST API with `tournament_director` authorization; a durable
game launcher (deterministic game ids, idempotent per
`(tournamentId, matchId, attempt)`); realtime result recording via PubSub;
live broadcast multiplexing + `GET /v1/tournaments/:id/live`; and the
Tournament Commentator AI feature deferred from M8. Full FIDE Dutch pairing
remains deferred (ADR-0015).

**Tournament Commentator productionized in M15 Increment 22 (ADR-0130).**
`POST /v1/tournaments/:id/games/:gameId/commentary` and
`POST /v1/tournaments/:id/rounds/:roundIndex/recap`, both authenticated, both taking path
identifiers and an empty body. The library takes every fact from its caller — FEN, players, results,
standings — because in M9 its caller was a test, so productionizing it is mostly the work of taking
those parameters away: the server reads the position and the move from the durable game log and the
results and standings from the tournament aggregate, and a request body carrying any of them is
refused rather than ignored.

Two refusals define the feature. A game still being played gets **no** commentary, because
`GET /v1/tournaments/:id/live` is public and already publishes live FENs — attaching an engine
evaluation to that would hand a player in the game a live engine. And a round with an unresolved
pairing is refused rather than recapped, because a narrative about three of five games under a
heading that says "after round 3" is a false account of a round.

Terminality is read from the event log rather than the tournament's recorded result:
`TournamentResultReporter` records results asynchronously from a PubSub subscription, so a game can
be over in the log before the tournament knows. The engine is pointed at the position the final move
was played *from*, never the one it produced — a decided position has an outcome, not an evaluation
(ADR-0116).

Cost: one engine search and one provider call for a game commentary, zero and one for a recap — move
explanation's bill, so it shares move explanation's budget in a bucket of its own. Deferred:
live-game commentary (it needs a spectator/participant distinction that deserves its own decision), a
durable store of generated prose, and arena tournaments, which have no rounds.

## 🚧 Milestone 10 — Social & learning

Teams/communities, forums, messaging, friends/followers, achievements; lessons,
courses, video library, PGN import, studies (collaborative), opening/endgame
encyclopedias, master game explorer. **GraphQL read layer** introduced here (and
extended in M11) for the nested, client-driven reads these features need.

- **Increment 1 complete (ADR-0066):** pure social graph domain core (`@chess-platform/social`): follows, friend requests, and blocks; explicit `FriendRequest` state machine (`pending` -> `accepted` | `declined` | `cancelled`, plus `accepted` -> `ended` via `terminateFriendship`, the only non-terminal move out of an accepted friendship), atomic block precedence (a block tears down follows in both directions, pending requests, and any active friendship, and takes effect symmetrically), `unblock` restoring nothing, crossing friend requests rejected rather than auto-accepted, caller-supplied ids and timestamps, and a `SocialGraphRepository` port + `InMemorySocialGraphRepository` adapter with pagination ordered by timestamp descending and tie-broken on code-point id order (which increment 2 found Postgres reproduces natively for `uuid`
columns, a type that is not collatable at all — the `COLLATE "C"` this line originally promised
would have been a syntax error; see ADR-0067 §2). Domain only — no table, no route, no production wiring until increment 2.
- **Increment 2 complete (ADR-0067):** social graph persistence (`PgSocialGraphRepository` in `@chess-platform/persistence`) + migration `0015_social_graph.sql` (`social_follows`, `social_blocks`, `social_friend_requests` with `ON DELETE CASCADE` FKs, partial unique indexes, standard Postgres byte-wise UUID collation matching `compareIds` order, and single-transaction `block()`) + REST API (`/v1/social/...` 12 routes with authz enforcement, `uuidv7()` request IDs, presenter mappings, `SocialRuleError` HTTP status mapping, and `socialGraphRepository` optional-dependency 503 fallback).
- **Increment 3 complete (ADR-0068):** direct 1:1 messaging domain core (`@chess-platform/messaging` with zero runtime dependencies and `BlockChecker` port inversion), Postgres adapter `PgMessagingRepository` in `@chess-platform/persistence` (`/pg` subpath) + migration `0016_messaging.sql` (`messaging_conversations`, `messaging_messages`, `messaging_reads` with partial-free unique index on normalized pair, FK coverage via the composite list indexes, and a pair advisory lock whose key is shared with the social graph adapter so the cross-connection block check has something to serialize against), and REST API (`/v1/messages/...` 9 routes with auth enforcement, `uuidv7()` server-generated IDs, `mapMessagingError` mapping, presenter schemas, and `not_found` for anything the caller is not a participant in — `not_authorized` only where the caller can already see the resource).
- **Increment 4 complete (ADR-0069):** teams/communities + team forums domain core (`@chess-platform/community` with zero runtime dependencies, single-owner invariant, role hierarchy `owner` > `admin` > `member`, Existence Oracle protection `not_found` for private teams to non-members, and code-point deterministic comparators), Postgres persistence `PgCommunityRepository` in `@chess-platform/persistence` + migration `0017_community.sql` (`community_teams`, `community_memberships`, `community_join_requests`, `community_forum_threads`, `community_forum_posts` with partial unique indexes, foreign key indexing, and transaction advisory lock `lockTeam`), and REST API (`/v1/teams/*` and `/v1/teams/:id/forum/*` 22 routes with auth matrix enforcement, `requirePlayerExists` validation, `mapCommunityError` status mapping, OpenAPI spec, presenter schemas, and optional-dependency 503 fallback).
- **Increment 5 complete (ADR-0070):** achievements system domain core (`@chess-platform/achievements` with zero runtime dependencies, 13 achievement definitions (win streaks deliberately excluded — see ADR-0070), pure evaluator `evaluateGameAchievements`, hidden achievement rules, code-point deterministic ordering, and paginated `AchievementsRepository` port with `InMemoryAchievementsRepository` implementation), Postgres persistence `PgAchievementsRepository` in `@chess-platform/persistence` + migration `0018_achievements.sql` (`achievement_progress` table with single SQL statement atomic idempotent progress update preserving `unlocked_at` timestamp, and no secondary index: the primary key already covers the FK and the only query, and ordering happens in the adapter because the catalogue lives in code), live awarding worker `AchievementsAwardWorker` in `@chess-platform/api` hosted in `services/gateway` (opt-in via `ACHIEVEMENTS_ENABLED=1`, matching `SEARCH_INDEXER` and `BOT_AUTO_ANALYZE`) subscribing to `games:ended` channel with FIFO deduplication and error containment, and public REST API (`GET /v1/achievements`, `GET /v1/players/:playerId/achievements`, `GET /v1/players/:playerId/achievements/summary` with auth/param validation, OpenAPI spec, presenter schemas, and optional-dependency 503 fallback).
- **Increment 6 complete (ADR-0071):** interactive studies & PGN system domain core (`@chess-platform/studies` with zero runtime dependencies, study/chapter/node models, PGN model/parser/serializer, SAN move resolver, code-point deterministic ordering, and `StudiesRepository` port with `InMemoryStudiesRepository` implementation), Postgres persistence `PgStudiesRepository` in `@chess-platform/persistence` + migration `0019_studies.sql` (`studies`, `study_collaborators`, `study_chapters`, `study_tree_nodes` tables with partial unique indexes, pre-row transaction advisory lock `lockStudy` preventing deadlocks, demotion-first owner transfer, and constraint-safe chapter reordering), and REST API (`/v1/studies/*` 21 routes with auth matrix enforcement, `requirePlayerExists` validation, `mapStudyError` status mapping, route-level `MAX_PGN_BYTES` body limit, OpenAPI spec, presenter schemas, and `STUDIES_ENABLED=1` opt-in feature flag).
- **Increment 9 complete (ADR-0074) — first WEB increment of M10:** increments 1–8 were all backend, leaving 91 M10 endpoints with no UI at all. This one covers the social graph on the existing `/profile/:handle` route: follower/following lists, follow/unfollow, friend requests (send, accept, decline, cancel), block/unblock, and the viewer's own friends and blocked lists. Reads go through `POST /v1/graphql` and writes through REST — not for round-trip economy but because the social endpoints return bare ids and REST has **no id-to-handle lookup**, so `player(id:)` is the only way to name anyone; when `GRAPHQL_ENABLED` is unset the page still loads and only the names degrade to truncated ids. The follow relationship is *derived* from the viewer's own lists (bounded at 100) because no relationship endpoint exists — safe because `follow` is an idempotent upsert. `.rating-row`/`.game-row`/`.panel-row` consolidated onto one shared rule per DESIGN.md's one-row-style requirement. First consumer of the ADR-0073 read layer.
- **Increment 8 complete (ADR-0073):** read-only GraphQL layer at `POST /v1/graphql` behind `GRAPHQL_ENABLED=1` — queries only (the parser refuses `mutation`/`subscription` by name), authorization delegated entirely to the existing repositories, `not_found`/`not_authorized` flattened so the endpoint is not an existence oracle, a per-request `BatchLoader` (with a new `UsersRepository.findByIds`), and depth/complexity/alias limits enforced *before* execution. No new runtime dependency; fragments, directives and block strings are refused with explicit parse errors.
- **Increment 7 complete (ADR-0072):** structured courses & interactive lessons system domain core (`@chess-platform/learning` with zero runtime dependencies, courses/lessons/steps models, text/move/quiz step discriminators, `PositionReader` move legality validation, slug normalization, code-point deterministic ordering, and `LearningRepository` port with `InMemoryLearningRepository` implementation), Postgres persistence `PgLearningRepository` in `@chess-platform/persistence` + migration `0020_learning.sql` (`learning_courses`, `learning_lessons`, `learning_steps`, `learning_progress` tables with partial unique indexes, pre-row transaction advisory lock `lockCourse` preventing deadlocks, negative-index reordering shifts, single atomic SQL statement attempt recording ON CONFLICT DO UPDATE, and FK index coverage), and REST API (`/v1/courses/*`, `/v1/lessons/*`, `/v1/steps/*` 23 routes with auth matrix enforcement, `requirePlayerExists` validation, `mapLearningError` status mapping, OpenAPI spec, presenter schemas, and `LEARNING_ENABLED=1` opt-in feature flag).


## 🚧 Milestone 11 — Search

Keyword + semantic (pgvector/Meilisearch) over games, openings, players, studies;
natural-language query parsing.

- **Increment 1 complete (ADR-0049):** pure-domain keyword search core (`@chess-platform/search`): `tokenize`, `parseSearchQuery` (terms, phrases, `[-]field:value` filters), and in-memory `search` AND matcher + ranker.
- **Increment 2 complete (ADR-0050):** `SearchRepository` port + in-memory paginated adapter (`InMemorySearchRepository`, `SearchOptions`, `SearchPage`).
- **Increment 3 complete (ADR-0051):** natural-language query normalization (`parseNaturalQuery`, `NATURAL_VOCABULARY`, `NATURAL_STOP_WORDS`).
- **Increment 4 complete (ADR-0052):** async `SearchRepository` port (`Promise`-returning signatures) enabling I/O-backed adapters (Postgres full-text search) to implement the interface.
- **Increment 5 complete (ADR-0053):** Postgres full-text adapter `PgSearchRepository` in `@chess-platform/persistence` (`/pg` subpath) + migration `0013_search_documents.sql` (`tsvector` 'simple' column + GIN index, jsonb field filters, parameterized SQL queries, `ts_rank` scoring).
- **Increment 6 complete (ADR-0054):** search REST API (`GET /v1/search`) with `parseNaturalQuery` normalization, `SearchRepository` query execution, pagination (`limit`/`offset`), `SearchResults` OpenAPI schema, and optional-dependency 503 guard.
- **Increment 7 complete (ADR-0055):** entity projections (`gameToDocument`, `playerToDocument`, `tournamentToDocument`) with PII exclusion, keyset-paginated backfill source (`SearchBackfillSource` / `PgSearchBackfillSource`), production wiring in `bootstrap.ts` (with `SEARCH_ENABLED=0` absolute kill switch), `reindex-search` CLI script + `reindexAll` helper, natural vocabulary realignment (`speed` vs `variant`, canonical codes, `match`/`matches` -> `game`, draw result mapping), player-relative query deferral to Increment 8, and end-to-end round-trip test suite.
- **Increment 8 complete (ADR-0056):** live incremental game search indexing worker (`SearchIndexWorker`) triggered by `gamesEndedChannel()`, single-game read path (`findGame`), local structural subscriber port, defensive payload type guards, bounded FIFO dedup set, error containment, gateway hosting (`SEARCH_INDEXER=1`), and aborted game skipping.
- **Increment 9 complete (ADR-0058):** pure semantic + hybrid search domain core (`@chess-platform/search`): pure vector math (`Vector`, `dot`, `magnitude`, `cosineSimilarity`, `normalize`), `EmbeddingProvider` async port, deterministic offline `HashingEmbeddingProvider` (FNV-1a 32-bit hashing trick), `semanticSearch` vector similarity ranker with shared filter evaluation (`src/filters.ts`), `hybridSearch` Reciprocal Rank Fusion (RRF) ranker, `SemanticSearchRepository` port + `InMemorySemanticSearchRepository` adapter, and a shared pagination contract (`src/pagination.ts`) now backing both the keyword and semantic repositories.
- **Increment 10 complete (ADR-0059):** pgvector semantic & hybrid search adapter (`PgSemanticSearchRepository`) in `@chess-platform/persistence` (`/pg` subpath) + migration `0014_search_embeddings.sql` (`search_embeddings` table, `vector(256)`, HNSW index with `vector_cosine_ops`, cosine distance `1 - distance` similarity mapping, RRF SQL hybrid search CTE query, shared `search-helpers.ts` for zero filter drift, and hermetic DB-gated integration tests verified against real pgvector 0.8.5). The `id` tie-break is measured to defeat the HNSW index — retained for pagination determinism, with the ANN fast path deferred; see ADR-0059.
- **Increment 11 complete (ADR-0060):** REST endpoint wiring for semantic and hybrid search (`GET /v1/search?mode=keyword|semantic|hybrid`) with query mode parsing (defaulting to `keyword`), term+phrase embedding text derivation (`[...query.terms, ...query.phrases].join(' ')` excluding filter tokens), `SEARCH_EMBEDDING_DIMENSIONS = 256` constant export coupled to `vector(256)` in migration 0014, dependency injection via `semanticSearchRepository` & `embeddingProvider`, optional-dependency 503 guards, updated OpenAPI 3.1 specification, test harness support (`withoutSemanticSearch`), and comprehensive mode validation/ranking/fusion tests.
- **Increment 12 complete (ADR-0061):** embedding backfill + live embedding pipeline (`@chess-platform/search` `embedDocument`/`embedDocuments`, single write path routing in `reindexAll` and `SearchIndexWorker` avoiding double-writing `search_documents`, refactored `ReindexOptions` options object, `reindex-search` script and `serve.ts` gateway live worker wired to `SEMANTIC_SEARCH_ENABLED !== '0'`, Helm search-indexer `SEMANTIC_SEARCH_ENABLED=0` when `search.semanticEnabled=false`, DB-gated integration tests, and manual operator backfill documentation).

## ✅ Milestone 12 — Security hardening & anti-cheat

Engine-correlation scoring, bot detection, fraud/DDoS, audit, pen-test pass.

**Increments 1–3 complete:** CORS policy + security response headers
(ADR-0011), httpOnly refresh-token cookie (ADR-0012), rate limiting for
sensitive auth endpoints with a durable Postgres bucket store (ADR-0013).
**Anti-cheat Increments 1–7 complete:** pure domain engine-correlation scoring (ADR-0029), per-player account-level aggregation (ADR-0030), `EngineBackedEvaluator` adapter (ADR-0031), `AntiCheatService`/`AntiCheatReportRepository` ports (ADR-0032), Postgres persistence with atomic `saveBatch` transactions and read-only moderation REST API (ADR-0033), on-demand analysis-trigger pipeline (ADR-0034), and automated auto-analysis worker (ADR-0035).
**Bot Detection Increments 1–6 complete:** pure domain behavioral move-time analyzer (ADR-0036), cross-game behavioral aggregation (ADR-0037), move-timing extraction (ADR-0038), service + report repository (ADR-0039), Postgres persistence + moderation REST API (ADR-0040), and automatic auto-analysis worker + gateway hosting (ADR-0041). Bot detection is now feature-complete; the pen-test pass remains.
**Anti-Cheat Correctness Hardening complete (ADR-0042):** engine-correlation correctness follow-ups landed (identical white/black player ID guard in `AntiCheatService.analyzeAndStore` and deterministic `listByPlayer` ordering via `game_id` tie-breaker + migration `0012`).
**Anti-Cheat Increment 8 complete (ADR-0043):** anti-cheat auto-analyzer gateway hosting with a real engine landed (`createEngineProviderFromEnv`, `createEngineBackedAnalysisService`, `serve.ts` `ANTICHEAT_AUTO_ANALYZE=1` hosting block and graceful engine shutdown). Anti-cheat is now fully production-hostable end-to-end.
**Pen-test pass complete — M12 CLOSED.** STRIDE audit of all seven trust boundaries, recorded in
`docs/SECURITY_AUDIT.md`. One finding (SEC-1, Medium): the public web proxy exposed
`GET /v1/metrics`, leaking the Prometheus registry — route inventory plus per-route request volume
and status distribution, moderation traffic included — unauthenticated to the internet. Fixed with an
exact-match nginx block, verified against a running proxy including path-normalisation bypasses,
and guarded by `scripts/smoke-test.mjs`. Injection, authorization, gateway command authorization,
authentication, security headers, CORS, error disclosure, command injection, secrets, and the
dependency audit (0 vulnerabilities) were all checked and found sound; the audit document records
what was verified and what the pass deliberately did not cover.



## ✅ Milestone 13 — Observability & SRE

OpenTelemetry, Prometheus, Grafana, alerting, SLOs, runbooks, chaos tests.
- **Increment 1 complete (ADR-0028):** Zero-dependency `Logger` (`JsonLogger`) & `Metrics` (`InMemoryMetrics`) ports, Prometheus text exposition (`GET /v1/metrics`), W3C `traceparent` parsing, bounded HTTP route metric labels, PII redaction.
- **Increment 2 complete (ADR-0045):** Dependency-free `Tracer` / `Span` port (`NullTracer`, `RecordingTracer`, `InMemorySpanRecorder`), `http.server` span emission in `router.ts`, `alwaysOnSampler` and `probabilitySampler`, outbound W3C `traceparent` header propagation, and structured log span emission in production.
- **Increment 3 complete (ADR-0046):** `SpanExporter` seam, `LoggingSpanExporter`, `MultiSpanExporter` composite fan-out, pure `toResourceSpans` OTLP/JSON mapping, `OtlpJsonSpanExporter` with `SpanTransport`, `OTEL_EXPORTER_OTLP_ENDPOINT` environment gate, and `FetchSpanTransport` boundary adapter.
- **Increment 4 complete (ADR-0047):** `BatchSpanProcessor` decorator buffering finished spans and exporting in batches (`maxQueueSize = 2048`, `maxExportBatchSize = 512`, 5s flush delay), `Scheduler` seam with unref'd `intervalScheduler` default, bounded queue with oldest-drop policy and drop counter, wrapping OTLP exporter in bootstrap.
- **Increment 5 complete (ADR-0048):** Span-export pipeline self-instrumentation (`BatchSpanProcessor` emits `span_export_received_total`, `span_export_dropped_total`, `span_export_exported_total`, and `span_export_batches_total` counters to `InMemoryMetrics` for scraping at `GET /v1/metrics`).
- **Increment 6 complete (ADR-0062):** Gateway tracing and reachable OTLP export (`gateway.command` and `gateway.forward` span emission, cross-node `traceparent` context propagation, bounded-attribute PII enforcement, Helm chart `tracing` configuration block, and snapshot test coverage).
- **Increment 8 complete (ADR-0064) — M13 CLOSED:** the consuming half of the stack. Three SLOs
  (API availability 99.5%, API latency 99% under 250 ms, span-export delivery 99%) in `docs/SLO.md`;
  multi-window multi-burn-rate alerts plus operational alerts in
  `deploy/observability/prometheus/rules/gambit.rules.yml` (21 rules, validated with real
  `promtool`); two Grafana dashboards; a runbook per alert in `docs/RUNBOOKS.md` with all nine
  anchors verified; and `scripts/check-observability-drift.mjs`, which fails CI when a rule or panel
  references a metric the source does not emit — the failure mode where a renamed counter silently
  disables an alert forever. Latency thresholds sit on real histogram bucket edges so the SLI is
  exact rather than interpolated. **The SLO targets are unvalidated starting points** — this repo has
  never carried production traffic or been load tested, and `docs/SLO.md` says so up front.
- **Increment 7 complete (ADR-0063):** Span-export failure visibility + bounded retry (`SpanExportOutcome` async outcome reporting, `FetchSpanTransport` HTTP 4xx/5xx status and network error classification, `span_export_failed_total` counter, `span_export_exported_total` confirmed delivery counting, bounded retries via `Scheduler` seam, and non-blocking synchronous `shutdown()`).

## 🚧 Milestone 14 — Deployment & scale

Docker, Kubernetes, Terraform, GitHub Actions, blue/green + canary, rollback,
secrets management, 100k-user load + chaos validation.

### Increment 1: Local runnable stack ✅

`docker compose up` brings the entire platform live on a developer's machine
with real Postgres, API, WebSocket gateway, and web frontend — the first time
the services run together as an integrated system.

- **Postgres 16** (compose) with schema auto-migrated on API startup via the
  existing `@chess-platform/persistence` migration runner.
- **API service** — multi-stage Dockerfile building and running the API
  against Postgres via `api/src/bootstrap.ts` (the real, non-fake composition
  root). Config via env vars (`DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `PORT`).
- **Gateway service** — multi-stage Dockerfile running a WebSocket server
  wrapping `RealtimeGateway`, with shared-secret token verification (the
  `TokenVerifier` port from ADR-0004) using the same `ACCESS_TOKEN_SECRET`
  as the API. In-memory pub/sub for single-node; Redis pub/sub is a later
  increment. ADR-0007 records this decision.
- **Web service** — multi-stage Dockerfile building the SPA with `vite build`
  and serving via nginx, with proxies for `/v1` → API and `/ws` → gateway.
- **`docker-compose.yml`** at the repo root with health-gated startup
  (`depends_on` + healthchecks: Postgres → API → gateway → web).
- **12-factor config:** everything via env vars, `.env.example` documents them,
  no secrets committed.
- **Smoke test** (`scripts/smoke-test.mjs`): waits for health, registers a
  user over the real API, creates a seek, opens a WS connection with the auth
  token, and confirms the token is verified — proving the stack actually
  serves end-to-end.
- **`docs/RUNNING.md`** documents the one-command flow and env vars.
- **Acceptance criteria:**
  - `docker compose up` from a clean checkout brings the full stack live;
    `docs/RUNNING.md` documents the flow.
  - Smoke test proves the stack serves: health, register, seek, WS auth.
  - Existing 8-package test suite passes unchanged (clean-tree verification).
  - No secrets in the repo; `.env.example` only.
  - ADR-0007 records the shared-secret token verification and single-node
    pub/sub decisions.
  - ROADMAP updated; M14 marked 🚧.

### Increment 2: Durable game authority (EventLog port + Postgres) ✅

The game authority persists and rehydrates game state exactly from its event
log via a durable `EventLog` port, with a Postgres adapter in the service layer
— mirroring the `EventStore`/`persistence` pattern. The domain package stays
dependency-free; the Postgres binding lives in the deployable service.

### Increment 3: Redis pub/sub for multi-node fanout ✅

`RedisPubSub` adapter implements the existing `PubSub` interface, backed by
Redis pub/sub for cross-node broadcast fanout. Key design:

- **Two Redis connections**: one for SUBSCRIBE (blocked), one for PUBLISH
  (Redis protocol requirement).
- **Origin node-id tagging + self-delivery skip**: each published message
  carries the publishing node's id; nodes skip their own messages to prevent
  double-fanout.
- **Ref-counted subscribe/unsubscribe**: one Redis SUBSCRIBE per channel per
  node, regardless of how many local subscribers the node has.
- **`RedisLike` interface in the domain package**: the `realtime-gateway`
  package depends only on a minimal `RedisLike` abstraction — the concrete
  `ioredis` binding lives in `services/gateway/src/redis-pubsub.ts` (the
  infrastructure seam, not the dependency-free domain package).
- **`REDIS_URL` env gate**: when set, the gateway uses `RedisPubSub`; when
  absent, falls back to `InMemoryPubSub` (single-node). Zero-config local dev
  preserved.
- **Docker Compose**: Redis 7 service with healthcheck and AOF persistence.
- **9 hermetic tests** using a `FakeRedis` bus: cross-node delivery,
  self-delivery skip, ref-counted subscribe/unsubscribe, multi-channel
  independence, subscriberCount, close cleanup, three-node fanout, malformed
  payload safety.
- ADR-0008 records the decision.

### Increment 4: Kubernetes manifests + Helm chart ✅

Package the existing stack (postgres, redis, api, gateway, web) as a Helm chart
so it deploys to a Kubernetes cluster — the next step after docker-compose. This
is infrastructure/packaging: no application source changes.

- **`deploy/helm/gambit/`** Helm chart with `Chart.yaml`, `values.yaml`, and
  templates for api (Deployment + Service + migration init container), gateway
  (Deployment replicas=1 + Service, WS port + health port), web (Deployment +
  Service + Ingress), and bundled postgres + redis as StatefulSets with PVCs.
- **Bundled vs. external datastores:** postgres + redis are gated behind
  `postgres.enabled` / `redis.enabled` (default true for self-contained install
  / kind). When disabled, `DATABASE_URL` / `REDIS_URL` come from
  `externalDatabaseUrl` / `externalRedisUrl` values.
- **Config split:** ConfigMap for non-secret env (PORT, HOST, NODE_ENV, ports),
  Secret for `ACCESS_TOKEN_SECRET` + `POSTGRES_PASSWORD`. No real secrets
  committed — placeholder defaults with `helm --set` / external-secrets note.
- **Gateway replica constraint (as shipped in inc 4; superseded by inc 5):** at
  inc 4 the gateway Deployment defaulted to `replicas: 1` and could not be scaled
  beyond 1 without sticky per-game routing or sharded authority, because
  game-command ownership was not coordinated across replicas. **Increment 5**
  lifted this: a Redis-based ownership registry + command forwarding (ADR-0010)
  now coordinates ownership across replicas, so the gateway defaults to
  `replicas: 2` (`REDIS_URL` required when > 1). The api and web are stateless and
  default to 2 replicas.
- **NODE_ID via downward API:** the gateway's `NODE_ID` is the pod name via
  `fieldRef: metadata.name`, mirroring compose's `NODE_ID: gateway-${HOSTNAME}`.
- **Migrations as init container:** the API runs
  `npm run migrate --workspace @chess-platform/persistence` in an init container
  before starting. The gateway's init container waits for the API health endpoint.
- **Liveness/readiness probes** hitting existing health endpoints (api
  `GET /v1/health`, gateway `GET :{PORT+1}/health`, web `GET /`).
- **CI job** added to `.github/workflows/ci.yml`: `helm lint` +
  `helm template | kubeconform` for both default and external-datastore values.
- **Snapshot test** (`scripts/helm-snapshot-test.sh`): verifies gateway
  replicas == 1, api+gateway share the same DATABASE_URL source, gateway gets
  REDIS_URL + NODE_ID from pod name, secrets come from the Secret.
- **Docs:** `docs/DEPLOYING.md` (Helm install flow, values, single-gateway-
  replica constraint), `docs/adr/0009-kubernetes-helm.md` (topology decisions).
- **Acceptance criteria:**
  - `helm lint deploy/helm/gambit` passes.
  - `helm template deploy/helm/gambit` renders for both default and
    external-datastore override.
  - Every rendered manifest validates with `kubeconform -strict` (zero invalid).
  - Snapshot test proves key wiring (gateway replicas, shared DATABASE_URL,
    REDIS_URL + NODE_ID, secrets from Secret).
  - CI job added; existing jobs intact.
  - Existing app gate stays green (no source changes).
  - ADR-0009 records the topology decisions.
  - ROADMAP + PROJECT_STATE updated.

### Increment 5: Safe horizontal scaling for WebSocket gateway (ADR-0010) ✅

Redis-based ownership registry and command forwarding allowing gateway scaling (`replicas: 2`).

### Increment 6: External-secrets integration (ADR-0044) ✅

External Secrets Operator (`external-secrets.io/v1`) integration for the Gambit Helm chart.
Renders an `ExternalSecret` custom resource syncing `ACCESS_TOKEN_SECRET` and `POSTGRES_PASSWORD` from a backing SecretStore / ClusterSecretStore.

### Increment 7: Search indexer Deployment (ADR-0057) ✅

Dedicated single-replica Deployment for the live search indexer (ADR-0056), gated on `gateway.searchIndexer.enabled`.
`replicas: 1` is hard-coded because the worker dedups only in-process, so the flag cannot ride the scalable gateway replicas.
Also wires ADR-0055's `SEARCH_ENABLED` kill switch into the API via a new `search.enabled` value, fails closed when the
indexer is enabled with search disabled, and pins an explicit `maxSurge: 1 / maxUnavailable: 0` rollout strategy so an
upgrade never leaves the fire-and-forget game-ended channel unsubscribed. Verified by new assertions in
`scripts/helm-snapshot-test.sh`; wiring that script into CI is still pending (the workflow file could not be committed).

### Increment 8: Load baseline + container-build repair (ADR-0065) ✅

`deploy/load` runs a k6 baseline whose thresholds **are** the SLOs from ADR-0064, so an unachievable
target fails the run rather than sitting unchallenged in a document. Measured on one workstation:
100.000% availability across 48,542 requests, p99 98.3 ms against a 250 ms target, 1,517 req/s.
`docs/SLO.md` now records the measured baseline and, just as importantly, what it cannot tell you —
near-empty dataset, no WebSocket load, and registration throughput unmeasurable from a single IP
because the limiter allows 5/hour.

Standing the stack up to measure it revealed that **`docker compose up --build` had been broken
since M11 inc 5** — the one-command local stack `docs/RUNNING.md` promises. Two hand-maintained
lists had gone stale identically: the build chain duplicated in each Dockerfile (missing `search`,
`engine`, `anti-cheat`), and the runtime `COPY` list (missing the same three, so the image built and
then died with `MODULE_NOT_FOUND`). No gate saw it: CI builds from the root chain and never builds
these images. Both Dockerfiles now delegate to a root `build:server` script, and
`scripts/check-docker-build-order.mjs` fails CI if the chain or the runtime copies drift from the
real dependency graph again.

### Increment 9: Blue/green + canary delivery (ADR-0075) ✅

`rollout.strategy` — `rolling` (unchanged default), `blueGreen` or `canary` — for the api and web.
Blue/green renders both colors and cuts over by rewriting a Service selector, so the flip and the
rollback are the same one-value change and neither restarts a pod; the standby is reachable first on
its own preview host. Canary weights traffic with ingress-nginx's `canary-weight` annotation rather
than by replica ratio, so the split does not quantise with pod count, with optional header-based
opt-in. Each web variant addresses the api variant of its own version, so a canary cohort never gets
a new frontend against the old API. The gateway is deliberately excluded (long-lived WebSocket
connections; game ownership is keyed by game, not version), as is the single-replica search indexer.

Building it surfaced a bug that predates it: `docker/web/nginx.conf` hardcoded the **compose**
service names, and nginx resolves an upstream literal at config load — so under Helm, where Services
are release-prefixed, the web pod exited with `host not found in upstream "api"` before it ever
listened. The public entrypoint had never worked in Kubernetes. The config is now an envsubst
template whose upstreams the chart injects, which is also what makes the version pairing above
possible.

32 new assertions in `scripts/helm-snapshot-test.sh` (82 total), including the flip-invariance check
that caught the standby being sized at one replica — which would have moved all production traffic
onto a single pod at the cutover — and a name-disjointness check keeping strategy switches
upgradable, since a Deployment's selector is immutable.

### Increment 10: Deploy-gated CI/CD pipeline (ADR-0076) ✅

Automated release and deploy workflows (`.github/workflows/release.yml` and `deploy.yml`) gated by
explicit verification, human approval environments, non-cancelling deployment queueing concurrency,
pre-flight image existence checks, and atomic rollouts with explicit timeouts.

`release.yml` triggers on version tags (`v*`), runs full verification (`build`, `test`, `lint`),
asserts that the tag matches `deploy/helm/gambit/Chart.yaml`'s `appVersion`, and publishes three images
(`api`, `gateway`, `web`) to GHCR tagged with version and commit SHA (`latest` is never published or deployed).
`deploy.yml` triggers via `workflow_dispatch` or `release: [published]`, enforces human-approval environment
protection gates (`environment:`), queues per environment (`cancel-in-progress: false`), verifies image existence in
GHCR before touching the cluster, passes progressive delivery strategy inputs (`rolling`, `blueGreen`, `canary`) to
Helm with `-f deploy/environments/<env>.values.yaml`, runs a pre-flight `helm template` dry-run validation to verify composed strategy arguments, and executes `helm upgrade` with `--atomic`, `--wait`, and explicit `--timeout`. Blue/green deployments set `rollout.blueGreen.colors.<active_color>.tag=$VERSION` and `images.gateway.tag=$VERSION`, leaving `images.api.tag` and `images.web.tag` at the environment baseline version (rollback target). Rollback is split: `--atomic` reverts a failed upgrade, while post-verification failures use a strict three-way branch (uninstall initial install, rollback to explicit pre-upgrade revision, or fail loudly if pre-upgrade revision cannot be parsed using explicit `require('node:fs')`).

Eight safety invariants are statically asserted by `scripts/check-deploy-gates.mjs` (`npm run check:deploy-gates`), wired into CI (`ci.yml`) under the `helm` job, and workflow flag compositions are asserted in `scripts/helm-snapshot-test.sh`. Reconciled chart `values.yaml` image references to `ghcr.io/senasehs19-oss/gambit-{api,gateway,web}` matching published repositories.

### Increment 11: Multi-node game authority chaos & failover validation (ADR-0077) ✅

Validates the multi-node game-authority design (ADR-0010) against a real two-node stack (`docker-compose.chaos.yml`) driven by `scripts/chaos-test.mjs`.

- **Observability metrics**: Added `gateway_owned_games` (gauge), `gateway_forwarded_commands_total` (counter), `gateway_forward_timeouts_total` (counter), `gateway_ownership_claims_total` (counter), `gateway_ownership_releases_total` (counter), `gateway_forward_latency_seconds` (histogram) to the gateway's `/metrics` output, and added `ownedGames` count + `ownershipRegistry: 'redis' | 'local'` to `/health`. Metric surface verified against `scripts/check-observability-drift.mjs`.
- **Two-node stack (`docker-compose.chaos.yml`)**: Applied as a Docker Compose override adding `gateway-node2` alongside `gateway`, setting `OWNERSHIP_LEASE_TTL_SEC=3` and `OWNERSHIP_RENEWAL_INTERVAL_SEC=1` on both nodes for fast, observable failover in tests. Exactly one node hosts `TOURNAMENT_REPORTER` and `SEARCH_INDEXER`.
- **Chaos test script (`scripts/chaos-test.mjs`)**: Plain Node ESM script verifying 4 scenarios against the real stack:
  - Cross-node correctness (players on different gateway nodes play alternating moves, zero rejections, positions match).
  - Ungraceful owner loss (`docker kill` owner, surviving node claims ownership within lease TTL + margin, play continues without lost/duplicated moves).
  - Graceful drain (`docker stop` owner, `releaseAll` compare-and-delete runs, successor claims immediately).
  - Redis loss (`docker stop redis`, non-owner forwarding fails; owner behavior checked vs ADR-0010 claims; recovery verified when Redis returns).
- **Opt-in CI (`.github/workflows/chaos.yml`)**: `workflow_dispatch`-only workflow running the chaos test on demand.
- **Architectural record (`docs/adr/0077-chaos-failover-validation.md`)**: Records findings, scenarios, metric additions, and Redis loss behavior differences.

### Increment 12: Local owner lease tracking & fail-closed fast path (ADR-0078) ✅

Eliminates the Redis round-trip on owner command routing by introducing local owner lease tracking in `OwnershipRegistry` and a fail-closed fast path in `RedisCommandRouter`.

- **Local lease tracking (`OwnershipRegistry`)**: Records monotonic expiry (`performance.now() + leaseTtlSec * 1000`) on successful claims and renewals. Exposes `holdsValidLease(gameId)` to check whether this node currently holds a valid, non-expired lease outside the safety margin.
- **Fail-closed fast path (`RedisCommandRouter`)**: Valid owner leases process commands locally immediately without calling Redis `claim()`. If Redis becomes unreachable, renewals fail, the recorded expiry stops advancing, the safety margin closes the fast path before lease expiration in Redis, and fallback `claim()` rejects commands (failing closed to prevent split-brain).
- **Observability metrics**: Added `gateway_ownership_renewal_failures_total` (counter) and `gateway_fast_path_commands_total` (counter) to track renewal errors and fast-path execution.
- **Chaos test suite update (`scripts/chaos-test.mjs`)**: Updated `docker-compose.chaos.yml` (`OWNERSHIP_LEASE_TTL_SEC=6`, `OWNERSHIP_RENEWAL_INTERVAL_SEC=2`). Scenario D now verifies owner moves succeed during a Redis outage (inside lease window) and fail closed after lease expiry. Cleared `KNOWN_OPEN_DEFECTS` (suite passes with exit 0).
- **Architectural record (`docs/adr/0078-owner-lease-fast-path.md`)**: Documents the availability gap, derived safety margin math, failure modes, split-brain guard, and resolution of ADR-0010 §6 claim.

### Increment 13: Wire engine bridge into live play ("play vs computer") (ADR-0080) ✅

Wires `@chess-platform/engine` into the backend for live "play vs computer" games.

- **Credential-less bot accounts**: Seeded 3 bot users (`gambit-novice`, `gambit-club`, `gambit-master`) in `packages/persistence/migrations/0021_engine_bots.sql`. Credential-less by design so bot accounts cannot authenticate.
- **Single-source catalogue**: `packages/api/src/bot/catalogue.ts` defines bot levels, user UUIDs, handles, and strength specifications (`{ elo: 1350 }`, `{ elo: 1750 }`, `{ elo: 2200 }`).
- **`GameStarter` port**: Added atomic game starter to `packages/persistence/src/repositories.ts` (`PgGameStarter` in `packages/persistence/src/pg/repositories.ts` and `InMemoryGameStarter` in `packages/api/src/fakes.ts`).
- **Route `POST /v1/games/bot`**: Implemented in `packages/api/src/routes.ts` (`AUTHED`, `rated: false`, deterministic color assignment for `random`, OpenAPI doc).
- **`EngineBotMover` & multi-node routing**: `services/gateway/src/engine-bot.ts` routes moves through `CommandRouter.route()` (respecting Redis sharding per ADR-0010), listens to game channels, executes bot moves at 300ms think time with `JobPriority.BotMove`, and exports observability metrics (`gateway_bot_moves_total`, `gateway_bot_move_failures_total`, `gateway_bot_move_seconds`).
- **Gateway integration**: Added `onGameLoaded` callback to `RealtimeGateway` (`packages/realtime-gateway/src/gateway.ts`), and wired engine sharing + mover lifecycle into `services/gateway/src/serve.ts`.
- **Architectural record (`docs/adr/0080-engine-bot-opponent.md`)**: Records security design, multi-node routing rationale, unrated policy, metric definitions, and unproven golden test status.

### Increment 14: "Play vs Computer" in the Gambit lobby (frontend only) (ADR-0081) ✅

Adds a frontend UI dialog in the Gambit lobby for starting unrated games against Stockfish engine bots.

- **Types (`packages/web/src/api/models.ts`)**: Defined `BotLevel` (`'novice' | 'club' | 'master'`) and `CreateBotGameRequest`.
- **Typed Client (`packages/web/src/api/client.ts`)**: Added `GamesApi.createVsBot()` (`POST /v1/games/bot`).
- **Pure Modules (`packages/web/src/app/bot-levels.ts`, `packages/web/src/app/dom.ts`)**: Created `bot-levels.ts` for difficulty level metadata and parsing, and extracted `el()` into `dom.ts`.
- **Dialog Component (`packages/web/src/app/play-bot-dialog.ts`)**: Built `PlayBotDialog` using native `<dialog>` with difficulty options, side selection (`♔`, `½`, `♚`), time presets, unrated note, submit/cancel actions, and modal error region.
- **Controller & Wiring (`packages/web/src/app/lobby-controller.ts`, `packages/web/src/app/bootstrap.ts`, `packages/web/index.html`)**: Added `LobbyController.createBotGame()`, mounted `#play-bot-mount` in `index.html`, and wired navigation to `/game/${gameId}` on success.
- **Styles (`packages/web/src/style.css`)**: Styled `.pb-dialog` and backdrop reusing `.cg-chip`/`.cg-seg` selection vocabulary and custom properties.
- **Tests & ADR**: Unit tests in `packages/web/test/bot-levels.test.ts` and `packages/web/test/api-client.test.ts`, static markup check in `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/play-vs-computer.spec.ts`. Architectural record in `docs/adr/0081-play-vs-computer-ui.md`.

### Increment 15: Tournaments UI (read-only) (ADR-0082) ✅

Exposes the M9 tournament system in the web frontend with a read-only interface for listing tournaments, viewing details, standings, and live games broadcast.

- **Types (`packages/web/src/api/models.ts`)**: Added `TournamentFormat`, `TournamentState`, `TournamentSummary`, `TournamentDetail` (discriminated union on `format`), `TournamentStanding` (union), `TournamentLiveBoard`, `TournamentLive`.
- **Client (`packages/web/src/api/client.ts`)**: Added `TournamentsApi` class beside `SeeksApi` and exposed `readonly tournaments: TournamentsApi` on `GambitClient` with four `auth: 'optional'` methods (`list`, `byId`, `standings`, `live`).
- **Controller (`packages/web/src/app/tournament-controller.ts`)**: Built DOM-free `TournamentController` with request generation guard, interval timer polling for live games, and batch player ID resolution via `client.graphql.resolvePlayers(ids)`.
- **Rendering (`packages/web/src/app/tournament-view.ts`)**: Pure DOM render helpers (`renderTournamentList`, `renderTournamentDetail`, `renderStandings`, `renderLiveBoards`) using `.panel-row` inside `.panel-list`, exported `renderEmpty` from `bootstrap.ts`, fallback player handles, links to `/tournaments/:id` and `/game/:gameId`, and format-specific standing column rendering.
- **Routing & Markup (`packages/web/src/app/router.ts`, `index.html`)**: Added `/tournaments` and `/tournaments/:id` routes, nav link, `#tournaments` and `#tournament` sections with proper `aria-label`s and `role="alert"` error elements.
- **Wiring & Styles (`packages/web/src/app/bootstrap.ts`, `style.css`)**: Exported `renderEmpty` and `EmptyStateOptions`. Wired section visibility and controller lifecycle. Added CSS rules conforming to DESIGN.md constraints.
- **Tests & ADR**: Added `packages/web/test/tournament-routes.test.ts`, updated `packages/web/test/api-client.test.ts` and `packages/web/test/a11y.test.ts`, added Playwright E2E spec `packages/web/e2e/tournaments.spec.ts`, and documented architectural decisions in `docs/adr/0082-tournaments-ui.md`.

### Increment 16: Search UI (ADR-0083) ✅

Exposes the M11 search backend (`GET /v1/search`) in the web frontend with a dedicated search interface, header search bar, mode selector, and per-result hydration.

- **Types (`packages/web/src/api/models.ts`)**: Added `SearchMode` (`'keyword' | 'semantic' | 'hybrid'`), `SearchResult`, and `SearchResults`.
- **Client (`packages/web/src/api/client.ts`)**: Added `SearchApi` class exposed as `readonly search` on `GambitClient` with `query({ q, mode, limit, offset })` (`auth: 'optional'`).
- **Pure Helpers (`packages/web/src/app/search-results.ts`)**: Created `parseSearchHit` (splitting namespaced entity IDs `game:<uuid>`, `player:<uuid>`, `tournament:<uuid>` on first colon without throwing on unknown/unprefixed IDs), `parseSearchMode`, and `HydratedHit` shape.
- **Controller (`packages/web/src/app/search-controller.ts`)**: Built DOM-free `SearchController` with `requestGeneration` stale-response guard, parallel `Promise.all` hydration of tournaments and games, and single-batch player ID resolution (`client.graphql.resolvePlayers(ids)`), with per-row `shortId` fallbacks for failed hydrations.
- **Views (`packages/web/src/app/search-view.ts`)**: Pure DOM render helpers (`renderSearchResults`, `renderSearchPrompt`) using `.panel-row` inside `.panel-list` (without `role="list"`), entity type labels, resolved names, links for valid `href`s, and `renderEmpty` prompt/empty states.
- **Routing & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/search` route, header search form with `role="search"`, `#search` section with mode selector (`.cg-seg` segmented control), SPA pushState+popstate navigation, and controller disposal lifecycle in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added styles for `.nav-search`, `.search`, and `.sr-only` complying with DESIGN.md tokens and 320px responsiveness.
- **Tests & ADR**: Unit tests in `packages/web/test/search-results.test.ts`, updated `packages/web/test/api-client.test.ts`, `packages/web/test/tournament-routes.test.ts`, and `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/search.spec.ts`, and architectural record in `docs/adr/0083-search-ui.md`.

### Increment 17: Playwright E2E suite stability & per-game bot RNG (ADR-0084) ✅

Stabilizes local E2E testing by capping worker concurrency and ensures bot move determinism across concurrent games.

- **Worker concurrency ceiling (`packages/web/playwright.config.ts`)**: Capped worker count using `Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))`. Prevents resource contention against the single shared `e2e-harness` process and Vite preview server on high-core machines.
- **Per-game bot RNG (`packages/e2e-harness/src/rng.ts`, `packages/e2e-harness/src/bot.ts`)**: Introduced `seedFrom(seed, key)` FNV-1a helper and updated `BotPlayer` to seed each game's RNG stream individually by `gameId`, eliminating move sequence drift between interleaved concurrent games.
- **Unit tests (`packages/e2e-harness/test/bot.test.ts`)**: Added unit tests asserting that interleaved games do not perturb each other's move sequences and that different game IDs draw distinct streams.
- **Architectural record (`docs/adr/0084-e2e-worker-cap.md`)**: Recorded measured contention benchmarks, worker ceiling decision, timing rationale, and scope boundaries.

### Increment 18: Direct Messaging UI (ADR-0085) ✅

Exposes the M10 direct messaging backend (`/v1/messages/*`) in the web frontend with an inbox, thread view, message composer, and profile entry point.

- **Harness Wiring (`packages/e2e-harness/src/harness.ts`, `package.json`)**: Wired `InMemoryMessagingRepository` into `deps.messagingRepository` so `/v1/messages/*` routes do not 503 under `GAMBIT_E2E_BACKEND=1`.
- **Types & Client (`packages/web/src/api/models.ts`, `client.ts`)**: Added `ConversationView`, `MessageView`, `ConversationSummary`, `ConversationList`, `MessageList`, and `ConversationReadState`. Added `MessagesApi` class with `listConversations`, `messages`, `send`, `markRead`, and `openWith` methods (`auth: true`).
- **Controller & Pure Helpers (`packages/web/src/app/messages-controller.ts`, `messages-helpers.ts`)**: Built DOM-free `MessagesController` with `requestGeneration` stale-response guard, open thread polling interval (5000ms), `markRead` call on thread load (quiet failure), single-batch player handle hydration (`client.graphql.resolvePlayers(ids)`), and pure helpers for participant derivation and tombstone rendering.
- **Views (`packages/web/src/app/messages-view.ts`)**: Pure DOM render helpers (`renderInbox`, `renderThread`) using `.panel-row` inside `.panel-list` (without `role="list"`), tombstone placeholder rendering (`"[Message deleted]"`), escaped text nodes, and `renderEmpty` states.
- **Routing, Profile & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/messages` and `/messages/:id` routes, nav link, `#messages` and `#conversation` sections with `aria-label`s and `role="alert"` errors, composer `<form>` with `.sr-only` label, profile "Message" action calling `openWith` + SPA navigation, and controller disposal in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added CSS rules for messaging layout, message thread items, own-message styling, composer input, and coarse-pointer touch targets according to DESIGN.md.
- **Tests & ADR**: Unit tests in `packages/web/test/messages.test.ts`, client tests in `packages/web/test/api-client.test.ts`, a11y tests in `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/messages.spec.ts`, and architectural record in `docs/adr/0085-direct-messaging-ui.md`.

### Increment 23: Learner-facing Learning UI (courses, lessons, steps) (ADR-0090) ✅

Exposes the M10 learning backend (23 routes under `/v1/courses`, `/v1/lessons`, `/v1/steps`, previously no UI at all) as a learner UI: browse published courses, view course lessons, and work through steps.

- **Routing & Client (`packages/web/src/app/router.ts`, `packages/web/src/api/client.ts`, `models.ts`)**: Added `/courses`, `/courses/:slug`, and `/lessons/:id` routes. Added `LearningApi` to `GambitClient` with 503 permanent status retry suppression. Added REST models including `StepView` discriminated union.
- **Move Steps & Answer Interaction**: Move steps render positions on a read-only board (`setTurn(false)`) and accept move attempts via a SAN text input field, evaluated server-side by `POST /v1/steps/:id/attempt`. All steps of a lesson render on one scrolling page.
- **503 Degradation & Controller (`learning-controller.ts`, `learning-helpers.ts`)**: Passes `permanentStatuses: [503]` on learning endpoints and latches `LearningController` on `ServiceUnavailableError`. On 503, the Learn surface degrades quietly with a plain sentence in the muted `.count` voice (`Learning service unavailable.`).
- **Harness & Bridge (`packages/e2e-harness/src/harness.ts`)**: Wired `learningRepository` into `packages/e2e-harness` and added bridge route `POST /e2e/courses` to seed published courses with lessons and steps.
- **Tests & ADR**: Unit tests in `learning-helpers.test.ts` and `learning-controller.test.ts`, Playwright E2E spec in `learning.spec.ts`. Recorded in `docs/adr/0090-learning-ui.md`.

### Increment 22: Achievements UI, and where the anti-gamification rule falls (ADR-0089) OK

Exposes the M10 achievements backend (3 routes, previously no UI) as a section on the profile page. The plumbing is ordinary; the substance is that `DESIGN.md` and `PRODUCT.md` both name "badge walls, streak counters, and noisy gamification" as an explicit anti-reference, so the increment had to establish where that line falls before it could render anything.

- **The design decision (`packages/web/DESIGN.md`)**: the prohibition is about treatment, not subject matter. The section uses the one List Row treatment every other list uses and adds no colour, icon, radius or accent. Tier is a word in the muted `.count` voice, never three metal colours; there is deliberately no progress bar. The Don't now carries the qualification and points at the component spec, so the next reader does not conclude the section violates the rule it was designed around.
- **Helpers (`packages/web/src/app/achievements-helpers.ts`)**: pure `progressLabel` and `summaryLabel`. `unlockedAt` is the only authority on an unlock — never `progress >= target`, which disagrees in both directions when a catalogue target moves. An absent `target` counts to 1, matching `resolveAward`'s `definition.target ?? 1`, rather than rendering one-shot achievements as `0 / undefined`. All four rules mutation-verified.
- **Controller & view (`achievements-controller.ts`, `achievements-view.ts`)**: `requestGeneration` stale-response guard as with teams and forum. A **503** hides the section rather than painting an error on every profile, because the award worker is opt-in behind `ACHIEVEMENTS_ENABLED` and its absence is a deployment configuration, not a fault; other failures do show.
- **Client (`packages/web/src/api/client.ts`)**: `AchievementsApi` with `forPlayer` and `summary`, keyed by player id and sending no token — both routes are public and their answer does not vary by viewer. `GET /v1/achievements` is deliberately not exposed: the per-player list already carries every visible definition.
- **Harness (`packages/e2e-harness/src/harness.ts`)**: wired `InMemoryAchievementsRepository` as `achievementsRepository`, the sixth optional `ApiDependencies` field the harness has needed; `/v1/achievements*` previously answered 503. Added `POST /e2e/achievements`, which calls the repository's real `award()` so the unlock follows the production rule rather than a fixture.
- **Rename**: `.team-row-main` → `.row-main`. It is a generic row-leading primitive, already shared by teams and forum rows, and achievements is a third consumer with nothing to do with teams.
- **Tests & ADR**: `achievements-helpers.test.ts` (mutation-verified), client and a11y tests, a two-case Playwright spec covering an award that unlocks and one that does not. Recorded in `docs/adr/0089-achievements-ui.md`, with the DESIGN.md component spec written through the impeccable skill.

### Increment 21: Team forums UI - read, start a thread, reply (ADR-0088) OK

Exposes the M10 team forum backend (7 routes, previously no UI) as a usable slice, and corrects a published contract that described a field the server never sends.

- **Contract fix (packages/api/src/openapi/schemas.ts, openapi.json)**: ForumPostView declared updatedAt as required and omitted editedAt, while the presenter has always emitted editedAt. MessageView in the same file was already correct. Schema corrected and openapi.json regenerated with npm run openapi.
- **Client (packages/web/src/api/client.ts)**: threads, thread, createThread, posts, createPost added to the existing TeamsApi, since every forum route is nested under a team.
- **Routing (packages/web/src/app/router.ts)**: /teams/:slug/forum and /teams/:slug/forum/:threadId. Any other path under a team slug now resolves to not-found rather than falling through to the team page.
- **Decision logic (packages/web/src/app/forum-helpers.ts)**: pure canStartThread and canReply. Replying needs membership AND an unlocked thread (the route answers 403 for either), and where both obstacles apply the membership one is reported because it would still block after a reopen. Membership reuses membershipOf from teams-helpers so the two surfaces cannot drift.
- **Tombstones**: postDisplayBody and threadDisplayTitle render placeholders, never the stored content. Mutation-verified along with the lock rule.
- **Tests & ADR**: forum-helpers.test.ts covers the truth table, ordering and tombstones; plus client, router, a11y and a two-member Playwright spec. Recorded in docs/adr/0088-team-forums-ui.md, with the DESIGN.md forum component spec written through the impeccable skill.


### Increment 20: Teams UI - browse, view, join, leave (ADR-0087) OK

Exposes the M10 community backend (20 routes under /v1/teams/*, previously no UI at all) as a usable slice: discover teams, view one with its members, join a public team, leave one.

- **Harness (packages/e2e-harness/src/harness.ts)**: wired InMemoryCommunityRepository as communityRepository, the fifth optional ApiDependencies field the harness has needed; /v1/teams/* previously answered 503 under GAMBIT_E2E_BACKEND=1.
- **Client & types (packages/web/src/api/client.ts, models.ts)**: TeamsApi (list, byId, members, join, leave) exposed as client.teams; team types narrow visibility and role to literal unions matching packages/community/src/model.ts.
- **Routing (packages/web/src/app/router.ts)**: /teams and /teams/:slug, preferring the slug since the backend accepts either.
- **Action logic (packages/web/src/app/teams-helpers.ts)**: pure teamAction over (team, members, viewer) returning join/leave/none-with-reason. Ownership is read from the viewer membership row, never team.createdBy, because ownership transfers.
- **Controller & views (teams-controller.ts, teams-view.ts)**: requestGeneration stale-response guard, one batched resolvePlayers per render, and a dedicated not-found state so a private team never renders as forbidden (ADR-0069 Existence Oracle protection).
- **Tests & ADR**: teams-helpers.test.ts covers the action truth table (mutation-verified), plus api-client, a11y and a Playwright browse-join-appear spec. Recorded in docs/adr/0087-teams-ui.md.


### Increment 19: In-memory search index in E2E harness & search hit assertion (ADR-0086) ✅

Wires `InMemorySearchRepository` into the backend harness under `GAMBIT_E2E_BACKEND=1` and exposes a test-only bridge route to seed search documents.

- **Harness Wiring (`packages/e2e-harness/src/harness.ts`, `package.json`)**: Wired `InMemorySearchRepository` from `@chess-platform/search` into `deps.searchRepository` so `GET /v1/search` does not 503 under `GAMBIT_E2E_BACKEND=1`. Added `@chess-platform/search` to `packages/e2e-harness/package.json` dependencies.
- **Bridge Route `POST /e2e/search-index` (`packages/e2e-harness/src/harness.ts`)**: Exposed test-only bridge route to project and index player, game, and tournament documents via `@chess-platform/search` projection helpers (`playerToDocument`, `gameToDocument`, `tournamentToDocument`).
- **E2E Test Assertion (`packages/web/e2e/search.spec.ts`)**: Added test registering a user, seeding the search index with that player document via `POST /e2e/search-index`, navigating to `/search?q=<handle>`, and asserting the hit renders the resolved handle via GraphQL hydration.
- **Documentation (`docs/adr/0083-search-ui.md`, `docs/ROADMAP.md`, `docs/adr/0086-e2e-search-index.md`, `docs/PROJECT_STATE.md`)**: Updated ADR-0083 §7, marked tracked debt resolved in ROADMAP.md, created ADR-0086, and updated PROJECT_STATE.md.

### Increment 24: Viewer-facing Studies UI (browse, chapters, move tree) (ADR-0091) ✅

Exposes the M10 studies backend (21 routes under `/v1/studies`, previously no UI at all) as a viewer UI: browse public/collaborative studies, view chapter lists, and analyze chapter move trees on a read-only board.

- **Routing & Client (`packages/web/src/app/router.ts`, `packages/web/src/api/client.ts`, `models.ts`)**: Added `/studies`, `/studies/:id`, and `/studies/:id/chapters/:chapterId` routes. Added `StudiesApi` class and `GambitClient.studies` with `permanentStatuses: [503]`. Added REST models for studies, chapters, tree nodes, collaborators, and chapter details.
- **Notation Pane & Read-Only Board (`studies-view.ts`, `studies-helpers.ts`)**: Move tree renders as inline wrapping move text (`1. e4 e5 2. Nf3 Nc6`) with indented variation blocks, one step per nesting level, with no bullets or list markers. Selecting a move sets board position via stored `fenAfter`. Board mounts with `setTurn(false)`. Topbar navigation adds `Studies` as a 7th plain-text nav entry.
- **Design System & Accessibility (`DESIGN.md`, `style.css`)**: Unbolded mainline typography (600 reserved for clock Numeric role). Selected move uses Grandmaster Teal (`--sel`). Moves are focusable `<button class="notation-move">` controls with accessible `aria-label` attributes and a 44px coarse pointer touch target.
- **NAG Mapping & Comments**: PGN NAG codes 1–6 map to annotation symbols (`1 → !`, `2 → ?`, `3 → !!`, `4 → ??`, `5 → !?`, `6 → ?!`), fusing to moves (`Bb5!`). Out-of-range NAGs render as empty strings. Move comments wrap as prose in muted `.count` voice (`#8f8f8c`).
- **503 Latching & Controller (`studies-controller.ts`)**: GETs pass `permanentStatuses: [503]`, and `StudiesController` latches on `ServiceUnavailableError` for the view duration. Quiet degradation displays `Studies service unavailable.`. `main.ts` disposes `previous.studies` on SPA navigation.
- **Domain Fix (`packages/studies/src/repository.ts`)**: Fixed PGN import move ordering in `buildTreeFromMovetext` so mainline moves are appended before variations, ensuring mainline receives `orderIndex 0` and variations receive `orderIndex >= 1`.
- **Harness & Bridge Route (`packages/e2e-harness/src/harness.ts`)**: Wired `studiesRepository` in `packages/e2e-harness` (`ApiDependencies`) and added bridge route `POST /e2e/studies` to seed public studies with chapters, mainline >= 4 moves, 1 variation, 1 comment, and 1 NAG in 1–6 range.
- **Tests & ADR**: Unit tests in `studies-helpers.test.ts`, `studies-controller.test.ts`, and domain test `studies.test.ts`, Playwright E2E spec in `studies.spec.ts`. Documented in `docs/adr/0091-studies-viewer.md`.

### Increment 36: The dev server had no API proxy, and the bot had no engine (ADR-0102) ✅

Two defects reported from running the platform locally — registering answered `HTTP 404`, and the computer opponent never moved. Unrelated causes, found together. Each was reproduced before being fixed.

- **`npm run dev` served an app whose every API call 404'd.** `resolveEndpoints` derives the API origin from `location.origin`, which is right in production (nginx proxies `/v1`) and right under `vite preview` (which already had a proxy for the e2e harness) — but `vite dev` had no `server.proxy` at all. Added, defaulting to the Compose ports and overridable via `GAMBIT_DEV_API_URL` / `GAMBIT_DEV_WS_URL`. "Use docker compose instead" is a usage instruction, not a fix.
- **Play vs Computer could not have worked in Compose.** `serve.ts` builds an `EngineBotMover` only when `ENGINE_BOT=1` **and** a binary exists at `STOCKFISH_PATH`; Compose never set the first and `Dockerfile.gateway` installed no engine. The failure is a log warning rather than a crash, so the lobby kept offering a mode whose opponent never moved.
- **Underneath that, the engine refused the platform's own variant name.** `@chess-platform/core` calls ordinary chess `standard` and the gateway bot passes that; UCI engines call it `chess`. `stockfishPlugin.variantSetup` already accepted `standard`, but `expectedVariants` omitted it (cold path) and `EnginePool.supportsVariant` consulted only discovered capabilities once warm (warm path) — so a real bot game threw `NoEngineForVariantError`. Routing now accepts either name; `supportsVariant` returns the union rather than preferring one.
- **The first fix was wrong and the review of PR #99 caught it.** Returning the union of discovered capabilities and `expectedVariants` fixed `standard` while letting a warm pool claim any variant its plugin merely *expected* — a Stockfish build without `UCI_Chess960` would be routed Chess960 over a Fairy that could actually play it. Capabilities must stay authoritative, so routing now **translates** the name instead: `EnginePlugin.engineVariantName` maps the platform's name to the engine's, and `supportsVariant` asks capabilities under both.
- **That surfaced a third instance the union fix would have masked**: Fairy reports `3check` where the platform says `threecheck`, so that variant had the identical warm-path failure. Fairy's hook is fed by the `FAIRY_VARIANT_NAMES` map it already used for `variantSetup`, keeping the translation in one place.
- **Why 50 passing engine tests missed it**: every one routed with `variant: 'chess'` — the engine's vocabulary, never the platform's. The new tests route `standard` warm and cold, and both fail against the unfixed code.
- **Nothing tested `vite.config.ts` at all**, which is how one server had a proxy and the other did not. `packages/web/test/dev-proxy.test.ts` now pins the parity by **importing the resolved config** — its first version searched the file as text with hard-coded indentation and quote style, which the PR #99 review rightly called fragile: reformatting could fail CI while the proxy was correct.
### Increment 35: The promotion picker rendered blank tiles (ADR-0101) ✅

A design pass over `packages/web/src/style.css` started as token-compliance work and found a user-facing bug. `.cb-promo-choice` carried a `font-size` on a button with no text; following that thread found that the promotion dialog was rendering four identical blank tiles.

- **The defect**: each choice combines `.cb-promo-choice` with the shared `.cb-p-*` class, which supplies only a `background-image`. `.cb-promo-choice` set `background: var(--promo-tile)` — the shorthand, which resets `background-image` to none — and at equal specificity the later rule won. A player promoting a pawn had nothing to tell the queen from the knight but tab order and the `aria-label`.
- **Verified, not reasoned**: the two rules were extracted verbatim into a page and the computed style read back — `background-image: none` as shipped, the SVG url with the image preserved.
- **Fixed**: `background-color` on both the rule and its `:hover`, plus the `background-size` / `repeat` / `position` trio that `.cb-piece` carries for board pieces and this button does not inherit. The dead `font-size`, the dead `color`, and the unused `--promo-tile-ink` token are removed — one fossil of the Unicode-glyph era, not three.
- **The same bug existed twice, and the review of PR #98 found the second one.** `button:not(:disabled):hover` set the shorthand too, and at specificity (0,2,1) against `.cb-p-*` at (0,1,0) it outranked the artwork outright — the piece vanished the moment the pointer touched a tile, despite a later `.cb-promo-choice:hover` rule setting the fill back. A higher-specificity rule had already reset a property the later one never restored. Both generic `button` rules now use `background-color`.
- **Pinned in `packages/web/test/style-contract.test.ts`**: nothing else could have caught either instance — the markup, classes and DOM were all correct and every test passed, with the only evidence on screen. The first version of the test checked the two obviously-named rules and missed the hover bug entirely, which is the same mistake as the bug in test form; it now asserts across every selector that can match the element. Mutation-verified against both.
- **A near-miss avoided**: white pieces on a near-white tile looked like the next bug. Rendering both colours showed the Cburnett set draws a white queen with a heavy black outline, so the tile is right. The comment justifying it was stale (it described the old Unicode glyphs) and was corrected rather than the colour.
- **The four token violations** — a second `border-radius`, and `1.2rem` / `1.75rem` / `0.7rem` off the ramp — are back on the documented steps. Detector reports zero findings.
### Increment 34: Per-variant timeout material rules (ADR-0100) ✅

A timeout win was downgraded to a draw using standard chess material rules in every variant. `endByTimeout` passed only the FEN and colour to `canMate`, so `parseFen` defaulted to `standard` and the lone-king / K+N / K+B test was applied where checkmate is not the win condition at all.

- **Live on offered variants**: a bare king in King of the Hill or Racing Kings (both won by walking a king somewhere), a queen held in a Crazyhouse pocket (which the board does not show), and K+N in Three-check or Atomic all reported that they could not win — so the player who was winning got a draw when their opponent flagged.
- **Fix (`packages/game/src/game.ts`)**: `canMate(fen, color, variant)` answers each variant own question, with the reasoning per variant recorded in ADR-0100 §1. Standard and Chess960 behaviour is unchanged and the default argument keeps existing callers correct.
- **Conservative in one direction on purpose**: where the honest answer is unclear it says the side can win. The failure modes are not symmetric — handing a draw to a player who was winning takes something from them; the guard only spares an opponent a loss they could never have converted.
- **The bias had to be applied to Crazyhouse and Horde too, and was not at first**: both returned "cannot win" for a bare king, and a test asserted that draw as correct. A king captures like any other piece, so in Crazyhouse it can seed its own pocket and in Horde it can take the pawns — no material state rules the win out in either. Caught in the review of PR #97. Three-check and Atomic stay strict for a real reason: no capture turns a king into a checking piece, and an atomic king may not capture at all.
- **Mutation-verified**: dropping the `variant` argument at the call site fails the King of the Hill timeout test.
### Increment 33: Chess960 withheld from the lobby, and a variant audit (ADR-0099) ✅

Chess960 was selectable while nothing behind it existed: `Position.initial('chess960')` returns the standard array, and castling in `packages/chess-core/src/movegen.ts` is hardcoded to e1/a1/h1 — 0 castling moves generated from any Chess960 arrangement whose king is not on e1. Picking it produced an ordinary game with a different label.

- **Withheld, not deleted (`packages/web/src/api/models.ts`, `packages/web/src/app/create-game-panel.ts`)**: `VARIANTS` keeps mirroring the server enum — the API really does accept `chess960` — and a new `OFFERED_VARIANTS` is what the lobby renders. The two lists were the same array, which is the structural reason a hollow variant stayed selectable: there was no way to withhold one without lying about the contract.
- **Offered list names what is offered, rather than subtracting what is not**: the first version was `VARIANTS.filter(v => v !== 'chess960')`, which reproduces the defect it was fixing — offering becomes the default, so a variant added tomorrow is selectable the moment it is named. Caught in PR review (#96). Same reasoning as ADR-0094's allowlist: an exhaustive statement of what is permitted fails closed, a list of exclusions fails open.
- **Test pins both directions (`packages/web/test/create-game-prefs.test.ts`)**: the offered set is asserted exactly, so a new variant fails until someone decides; `chess960` absent from what is offered, present in the contract list. Mutation-verified — slipping `chess960` back onto the offered list fails the test.
- **Audit of all eight variants (ADR-0099 §3)**: Chess960 was the only hollow one. `horde` and `racingkings` have correct start positions and enforce their own win conditions; `kingofthehill`, `threecheck`, `atomic` and `crazyhouse` were already verified in Increment 32.
- **Two first impressions corrected, and recorded because the wrong version was believable**: `racingkings` looked broken until the test position turned out to have both kings on rank 8, which genuinely is a draw; `threecheck` looked as though it never counted checks, until the measurement turned out to be taken through the lossy `snapshot()`.
- **Found, not fixed**: `Position.snapshot()` loses three-check counters. Latent — see the Milestone 1 follow-ups.
### Increment 32: Perft coverage for the chess variants (ADR-0098) ✅

Perft is the definitive correctness test for a move generator, and all five cases in `packages/chess-core/test/perft.test.ts` ran the `standard` variant while `packages/chess-core/src/movegen.ts` branches on the variant in six places. Seven rule sets had no perft verification at all.

- **No value recorded from this implementation.** Pasting in what the engine currently prints would be a golden master: it locks in present bugs and passes forever. Every added figure traces to the published reference counts already in the file, or to arithmetic over the board.
- **Equality where movegen is unchanged**: `chess960`, `kingofthehill` and `threecheck` must match the published standard counts exactly on the opening position and kiwipete, since they alter only castling or the terminal condition.
- **Divergence where it is not**: `atomic` must stop matching at depth 4, where the first captures explode; `crazyhouse` with a pawn in hand must give `perft(1) = 52` — 20 ordinary moves plus one drop per empty square on ranks 3-6. Equality alone would pass on an implementation that had forgotten a variant entirely.
- **Mutation-verified**: adding `kingofthehill` to the no-castling list fails the kiwipete equality test; disabling crazyhouse drops fails the drop-count test.
- **Cost**: the first version compared `perft(5)` totals and took 12 seconds of the package’s 15. The pocket FEN gives an exact figure instead of a `>` comparison, in 2.4 seconds total.
- **Left open, with the reason stated**: `horde` and `racingkings` need published values from an independent implementation; and Chess960 castling-by-file was found genuinely broken (see the Milestone 1 follow-ups) and left for its own increment.
### Increment 31: Delete the speculative `AttemptResult.message` (ADR-0097) ✅

Removes `readonly message?: string` from `AttemptResult` in `packages/learning/src/model.ts`. No implementation ever set it — the declaration was the only occurrence of the field in the repository — so the presenter omitting it dropped nothing, and populating it would have meant inventing the wording of a feedback feature that has never existed.

- **Domain (`packages/learning/src/model.ts`)**: field deleted. `AttemptResult` now has four fields, all of which every implementation sets.
- **Contract test (`packages/api/test/openapi.test.ts`)**: `AttemptResultView` was the last presenter without a schema/presenter coupling test, the divergence this project has found three times (ADR-0088, Increments 28 and 30). Its assertion differs from its neighbours because `completedAt` is genuinely optional on both sides: declared properties are checked against the union of both branches, `required` against the always-present keys.
- **Also in this increment**: Increment 1's status marker was still `🚧` while all five of its acceptance artifacts (`docker-compose.yml`, `.env.example`, `scripts/smoke-test.mjs`, `docs/RUNNING.md`, `docs/adr/0007-local-stack.md`) exist and its criteria are met. Corrected to ✅.
- **Not closed**: a wrong quiz answer still yields `Try again` and nothing else. ADR-0097 §2 records that as a design task rather than a dropped field.

### Increment 30: Team join-request moderation (ADR-0096) ✅

Ships the owner/admin moderation panel for private team join requests in the web UI. Adds server-side status filtering (`options?: PageOptions & { status?: JoinRequestStatus }`) to `listJoinRequests` in `@chess-platform/community` and `@chess-platform/persistence` (filtering before pagination to prevent hidden pending requests past page 1), exposes `?status=` query param on `GET /v1/teams/:id/join-requests` in `@chess-platform/api`, extracts `appendPanelRow` and `RowAction` to `render-helpers.ts`, and adds moderation UI to `@chess-platform/web`.

- **Server-side Filtering (`packages/community/src/repository.ts`, `packages/persistence/src/pg/community.ts`)**: Added optional status parameter to `listJoinRequests` filtering before pagination in both in-memory and PostgreSQL adapters.
- **API Route & Spec (`packages/api/src/routes.ts`, `packages/api/openapi.json`)**: Added `statusParam()` and `?status=` query validation (`oneOf`) to `GET /v1/teams/:id/join-requests`. Regenerated `openapi.json`.
- **Web UI & Moderation Panel (`packages/web/src/app/bootstrap.ts`, `packages/web/src/app/render-helpers.ts`, `packages/web/src/app/teams-view.ts`, `packages/web/src/app/teams-controller.ts`, `packages/web/src/api/client.ts`, `packages/web/src/api/models.ts`, `packages/web/index.html`)**: Extracted `appendPanelRow` to `render-helpers.ts`. Added `JoinRequestView` and `JoinRequestList` models and `joinRequests` / `respondToJoinRequest` API client methods. Added join requests section to team view (hidden for non-admins).
- **Tests & ADR**: Unit/integration tests in `community.test.ts`, `community.integration.test.ts`, `community-api.test.ts`, `teams-controller.test.ts`, `a11y.test.ts`, and Playwright E2E spec in `teams.spec.ts`. Documented in `docs/adr/0096-join-request-moderation.md`.

### Increment 29: Learner-scoped lesson step view (ADR-0095) ✅

Omits `expectedSan` and `correctIndex` from public step read routes (`GET /v1/lessons/:id/steps` and `GET /v1/steps/:id`) for learners and anonymous callers via `LearnerStepView`, while preserving `stepView` for course authors. Updates OpenAPI schema, web model comments, and adds contract tests.

### Increment 28: Fix JoinRequestView OpenAPI contract (ADR-0088) ✅

Corrects `JoinRequestView` schema in `packages/api/src/openapi/schemas.ts` to match `joinRequestView` presenter output and `FriendRequestView` schema pattern: replaces `updatedAt` with `respondedAt` (`nullable: true`, in `required` array).

- **OpenAPI Schema & Spec (`packages/api/src/openapi/schemas.ts`, `packages/api/openapi.json`)**: Updated `JoinRequestView` schema replacing `updatedAt` with `respondedAt` (`{ ...dateTime, nullable: true }`) in `required` list and properties. Regenerated `packages/api/openapi.json` via `npm run openapi`.
- **Contract Tests (`packages/api/test/community-api.test.ts`)**: One test covering every route that returns a join request — create, list and respond — asserting `respondedAt` is present (null when pending, ISO string once responded) and `updatedAt` is absent.
- **Schema/presenter coupling (`packages/api/test/openapi.test.ts`)**: Asserts the *served* `JoinRequestView` schema declares exactly the keys `joinRequestView` emits. Response-shape tests alone would not have caught this bug: reverting the schema while leaving the presenter correct kept all 356 tests green. Presenter-side drift is already blocked by the `JoinRequestView` TypeScript interface, so the two together pin both halves of the contract.

### Increment 27: Search hits carry their own display metadata (ADR-0094) ✅

Removes the search N+1. A page of ten cost up to **12 requests** — one query, up to ten per-result
entity fetches, one batched player resolve — and painted only once every one of them settled.
Now **one**.

- **Domain (`packages/search`)**: `SearchableDocument` and `SearchResult` gain an optional
  `display` (`type`, `title`, `subtitle`). Deliberately not in `fields` (canonicalized lowercase for
  exact-match filtering, so a title's casing would be destroyed) and not in `text` (a match corpus,
  not something a person reads).
- **Security held, and asserted**: `display` reuses only what each projection already indexed — the
  player projection's SECURITY note still holds, with a test pinning the whole serialized document
  rather than restating the rule, so a leak under any field name fails it. (The first version scanned
  for forbidden substrings and would have failed on a handle like `HashMaster`; replaced during PR
  review.)
- **API**: `SearchResult` schema exposes `display`, optional — a document indexed before the field
  existed still matches and must still be returned. Declaring it required would repeat the
  `ForumPostView` defect (ADR-0088).
- **Web**: `SearchController` maps hits straight to rows; the per-result fetches and
  `resolvePlayers` batch are deleted. `HydratedHit` became `SearchRow` — nothing hydrates any more.
- **Frontend (Impeccable audit, 16/20)**: removed the counterfeit `.panel-row` "Loading…"
  placeholder — a fake result a screen reader announces as a row — leaving `aria-busy` to carry the
  state; and renamed `.tournament-link` to `.row-link` across its six call sites, four of which were
  never tournaments. Both recorded in `packages/web/DESIGN.md`.

### Increment 26: PGN suffix annotations reach the tree (ADR-0093) ✅

Fixes a silent data-loss bug found while building the studies viewer: a move annotation written in
the suffix form (`Nf3!`, `Bb5?`, `Qh5!!`, …) was discarded on import, surviving neither in the SAN
nor in `nags`, with no error.

- **Parser (`packages/studies/src/pgn-parse.ts`)**: captures the whole trailing `[!?]+` run and maps
  it to the equivalent NAG (`! → $1` … `?! → $6`). Capturing the run rather than one character at a
  time is what makes `!!` a single `$3` instead of two `$1`s. `+`/`#` stay in the SAN; an explicit
  `$n` after a suffix is preserved alongside it (`Nf3! $16` → `nags: [1, 16]`).
- **Unrecognised runs are a located parse error**, not a silent drop — `e4!!!` rejects the file with
  a position rather than importing the move stripped of what its author wrote.
- **One change, both adapters.** `packages/persistence/src/pg/studies.ts:24` imports `parsePgn` from
  `@chess-platform/studies`, so the Postgres path inherits the fix. Verified explicitly, because
  ADR-0091 §10 found these two adapters silently diverged on import ordering.
- **Tests**: all six suffixes; `+`/`#`, castling and promotion interactions; suffix inside a
  variation; suffix plus explicit NAG; the unrecognised-run rejection; and a semantic round-trip
  (serialization writes `$n`, so equality is on parsed NAGs, not on the string).

### Increment 25: Structural bootstrap teardown & disposal exhaustiveness (ADR-0092) ✅

Eliminates manual route controller teardown in `main.ts` and fixes latent memory/subscription leaks by making un-disposed route controllers a compile error.

- **Types & Exhaustiveness (`bootstrap.ts`, `lifecycle.ts`)**: Separated `BootstrappedDisposables` from `Bootstrapped`. Derived `DisposableKey = keyof BootstrappedDisposables`. `DISPOSABLE_TEARDOWN_MAP` is typed strictly as `Record<DisposableKey, true>` so omitting a disposable controller fails TypeScript compilation (`TS2741`).
- **Lifecycle Unit & Main Entry (`lifecycle.ts`, `main.ts`)**: Extracted the run and teardown loop into `createLifecycle` in `packages/web/src/app/lifecycle.ts`. `main.ts` becomes a thin DOM entry point delegating run and theme state management to `createLifecycle`.
- **Verb Normalisation & Socket Leak Fix (`game-controller.ts`, `board.ts`)**: Normalised teardown verb to `.dispose()` across all disposables (`MountedBoard.dispose()`, `GameController.dispose()`). Cascaded `GameController.stop()` to `gameSync.stop()`, unsubscribing game socket listeners when navigating away from `/game/{id}` routes.
- **Tests & Documentation (`lifecycle.test.ts`, `0092-bootstrap-teardown.md`)**: Added unit tests covering teardown order before next bootstrap, null disposable skipping, and type-level `@ts-expect-error` exhaustiveness guard. Documented in `docs/adr/0092-bootstrap-teardown.md`.

### Increment 26 (M14 Inc 37): Live clock countdown UI interpolation (ADR-0103) ✅

Connects existing unit-tested pure latency interpolation helpers (`estimateSkewMs`, `interpolateRemaining` in `@chess-platform/realtime-gateway`) to the web UI.

- **StateView anchor (`protocol.ts`, `authority.ts`, `ws-protocol.ts`)**: Added `turnStartedAt: number | null` to `StateView` carrying `snap.clock.turnStartedAt` to anchor interpolation on snapshot resume and join.
- **Clock Skew & Sync (`ws-client.ts`, `game-sync.ts`)**: `WsClient` computes `skew` on `pong` messages using `estimateSkewMs`; `GameSync` exposes `skew` and `turnStartedAt`.
- **GameController Timer (`game-controller.ts`)**: Ticks an injectable timer on live games to emit interpolated remaining time for the side to move using `interpolateRemaining`. Suppresses `onClock` callbacks unless second boundary changes (reducing DOM writes by ~90%), while authoritative updates emit instantly.
- **Container Build Chain & Build-Order Gate (`package.json`, `Dockerfile.web`, `check-docker-build-order.mjs`)**: Moved `@chess-platform/realtime-gateway` to `dependencies` in web's manifest, added root `build:web` script, updated `Dockerfile.web` to delegate to `build:web`, and extended `scripts/check-docker-build-order.mjs` into a parameterized gate guarding both server and web container builds. Documented in `docs/adr/0103-live-clock-countdown.md`.

### Increment 39 (M14 Inc 39): Capabilities-driven navigation (ADR-0106) ✅

Removes top-level navigation links when their underlying optional subsystem is not configured in the current deployment, adhering to DESIGN.md's retryability principle.

- **Backend Capabilities Endpoint (`routes.ts`, `schemas.ts`, `presenters.ts`)**: Added public `GET /v1/capabilities` reporting boolean status for all opt-in repositories (`learning`, `studies`, `achievements`, `search`, `social`, `messaging`, `community`), derived strictly from `deps` (never `process.env`). Added `Capabilities` component schema and presenter-schema coupling test in `openapi.test.ts`.
- **Client & Navigation Logic (`client.ts`, `models.ts`, `capabilities-nav.ts`, `index.html`, `bootstrap.ts`)**: Optional nav links start `hidden` in `index.html`. `bootstrap` fetches capabilities once; enabled capabilities have `hidden` removed, while disabled capabilities are removed from the DOM. Implemented fail-open policy (reveals all links if `GET /v1/capabilities` fails) to protect against transient network errors.
- **Tests & Documentation (`capabilities.test.ts`, `capabilities-nav.test.ts`, `0106-capabilities-driven-navigation.md`)**: Added unit tests verifying dependency-driven capability reporting in API, nav DOM removal/revelation, fail-open behavior, and schema coupling. Documented in `docs/adr/0106-capabilities-driven-navigation.md`.

### Increment 43 (M14 Inc 43): SPA Leaderboard Page (ADR-0107) ✅

Exposes the pre-existing typed leaderboard REST API (`GET /v1/leaderboard/:variant`, `GambitClient.leaderboard`) as a real, accessible SPA page in the web frontend.

- **Routing & Client (`packages/web/src/app/router.ts`, `packages/web/src/api/client.ts`, `variant-labels.ts`)**: Added the exact `/leaderboard` route and topbar navigation while reusing the existing typed client. Centralized human-readable labels in the app layer so the API models remain contract-only.
- **Controller & View (`leaderboard-controller.ts`, `leaderboard-view.ts`)**: Implemented DOM-free `LeaderboardController` with `requestGeneration` stale guard and `disposed` protection. Standardized variant selector populating options from `OFFERED_VARIANTS` (omitting `chess960` per ADR-0099). Reused `.panel-row` List Row treatment for leaderboard standings with rank, handle link, rating, and RD.
- **Graceful Degradation & Fallback**: Calls `GambitClient.graphql.resolvePlayers(userIds)` as an optional read-layer path to convert player IDs to handles. If GraphQL resolution fails or leaves an ID unmapped, the page renders bare IDs via `shortId(userId)` plain text fallback without raising an error.
- **Teardown & Accessibility**: Tests cover exact route parsing/serialization, request races, post-disposal callback suppression, listener unbinding, empty/results semantics, and labelled controls. The route composite is registered in `BootstrappedDisposables` and `DISPOSABLE_TEARDOWN_MAP`; results switch between status and list semantics without placing loading copy in a result row.

### Increment 44 (M14 Inc 44): WebAuthn Passkeys Real Browser Web Flow (ADR-0108) ✅

Delivers full WebAuthn passkey authentication and management in `@chess-platform/web` over all six published server endpoints.

- **Server Contract & OpenAPI (`packages/api/src/auth/service.ts`, `schemas.ts`)**: Changed registration options `residentKey: 'preferred'` → `residentKey: 'required'` to ensure discoverable credentials for real browser flows. Updated OpenAPI schemas and regenerated `openapi.json` with 0 spec drift.
- **Typed Web Client & Adapter (`packages/web/src/api/client.ts`, `ports/webauthn.ts`)**: Added typed API methods for list, delete, register-options, register-verify, login-options, and login-verify with session adoption. Created `NativeWebAuthnAdapter` wrapping native WebAuthn L3 JSON APIs (`parseCreationOptionsFromJSON`, `create`, `parseRequestOptionsFromJSON`, `get`, `toJSON`).
- **Global Sign-in Surface**: Added `Sign in with passkey` button to `#auth-form` accepting handle alone, sharing session adoption with password auth and returning generic error copy to prevent handle enumeration.
- **Self-Profile Account Security Surface**: Added `#passkeys-self` section under profile (`/profile` only) using standard `.panel-list`/`.panel-row` 2-child structure. Managed by DOM-free `PasskeysController` with request generation counter, stale load guards, lifecycle teardown, and reset on logout.
- **Testing & Documentation**: Added unit and integration tests covering client endpoints, native WebAuthn adapter calls, session adoption, passkeys controller lifecycle/stale guards, and a11y markup. Documented in `docs/adr/0108-webauthn-passkeys-web-flow.md` and amended `docs/adr/0027-webauthn-passkeys.md`.

### Increment 45 (M14 Inc 45): Password-Recovery Web UI (ADR-0109) ✅

Delivers full password-recovery web UI flow in `@chess-platform/web` over the existing M4 server contracts (`POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`).

- **Typed Web Client & Models (`packages/web/src/api/client.ts`, `models.ts`)**: Added typed request models (`PasswordResetRequest`, `PasswordResetConfirmRequest`) and `AuthApi` methods (`requestPasswordReset`, `confirmPasswordReset`). Backend contracts were unchanged.
- **Routing & Discoverability (`packages/web/src/app/router.ts`, `index.html`)**: Added SPA route `/password-reset` (accepting optional `?token=...` query parameter) and a discoverable "Forgot password?" link (`#auth-forgot-password`) on the signed-out auth surface. *(Superseded: Increment 48 moved this token to `#token=...` — a query string reaches the web tier's access log before any script runs. See ADR-0112 §4.)*
- **Request & Reset Form Flow (`packages/web/src/app/password-reset-controller.ts`, `bootstrap.ts`)**: Managed by DOM-free `PasswordResetController` with client validation (8..1024 char password length and matching confirmation), loading/disabled/aria-busy states, duplicate submission guards, and generic success messaging to prevent handle enumeration. On password reset confirmation success (204), clears local auth session state (`auth.clearLocalSession()`).
- **Token Secrecy & Lifecycle Hygiene (`packages/web/src/app/bootstrap.ts`, `lifecycle.ts`)**: Strips secret reset tokens from the visible URL via `history.replaceState` before any background network requests run, preventing token leakage in `Referer` headers. The token is held only in route-local memory and released after success or route teardown. Integrated into `BootstrappedDisposables` and `DISPOSABLE_TEARDOWN_MAP` for leak-free route teardown.
- **Testing & Documentation**: Added unit, contract, router, controller, a11y, style contract, and Playwright browser e2e tests covering request success, confirm success, 401 invalid/expired tokens, token URL stripping, and mobile 390x844 layout without overflow. Documented in `docs/adr/0109-password-recovery-web-ui.md`. Production delivery was subsequently closed in M15 Increment 18 (ADR-0126).

### Increment 46 (M14 Inc 46): Account Security — Session Visibility and Revocation (ADR-0110) ✅

Lets a signed-in user see their active sessions and end one, closing the last half-built piece of the account-security surface `GET /v1/auth/sessions` had left open since M4.

- **Revocation endpoint (`packages/api/src/routes.ts`, `auth/service.ts`)**: `DELETE /v1/auth/sessions/:id`, authenticated, `204` on success and `404` for anything not in the caller's own session list. `AuthService.revokeSession` resolves the path id *within* `sessions.listForUser(userId)` — the same structural ownership pattern `deletePasskey` uses — so a caller-supplied id never reaches `sessions.revoke` without first having been found among that user's own rows. Audited as `auth.session.revoke`.
- **Current-session semantics, derived not invented (ADR-0110)**: access tokens are stateless HMACs carrying `sub/handle/roles/iat/exp/jti`, and `jti` is a fresh per-token id, so the server cannot tell which session the caller's own token belongs to. Revocation is therefore uniform and id-based, and it ends the session's *refresh* capability rather than an outstanding access token, which `authenticate` verifies by signature alone without consulting the session table.
- **Typed client (`packages/web/src/api/client.ts`)**: `revokeSession(id)`, URL-encoding the id. `sessions()` unchanged.
- **Account-security UI (`packages/web/src/app/sessions-controller.ts`, `sessions-view.ts`, `index.html`)**: an Active sessions list inside the existing `#passkeys-self` panel, reusing `.panel-list`/`appendPanelRow`/`renderEmpty` with no new visual language. Rows read device · address · last seen, omitting absent parts without stray separators; revoked and expired rows are filtered out so the heading stays true and revocation shows as the row leaving.
- **Route lifetime**: `SessionsController` mirrors `PasskeysController`'s dual-generation guards, is created and disposed alongside it on the self-profile, clears its rows on sign-out to avoid disclosing a previous account's devices and addresses, and drops a duplicate revoke for an id already in flight.
- **Testing**: API tests for own-session revocation, cross-user rejection, unknown ids, idempotent double revocation and unauthenticated access; a `SessionView` schema/presenter coupling test (the first for this view); controller, view, client, mount and Playwright coverage. The IDOR protection, the active-session filter, the in-flight dedupe and the route disposal were each mutation-checked against deliberately broken code.

### Increment 47 (M14 Inc 47): Local Two-Gateway WebSocket Load Baseline (ADR-0111) ✅

Adds an on-demand, workstation-bounded k6 baseline against the real two-gateway Compose topology. A
single room spans 34 real sockets across both nodes and plays a deterministic 32-ply line that forces
16 commands through Redis ownership forwarding. Exact join/delivery/protocol thresholds, position
agreement, production-limit guards, and the exact forwarding-counter delta make a passing run prove
the intended path rather than merely complete a handshake. Latency trends are recorded as
informational observations only; they are not a WebSocket SLO or a capacity claim. Access tokens stay
inside k6 memory and the custom JSON summary is metrics-only. CI runs the pure harness contract tests,
while the real load run remains on demand. Terraform and 100k-user cluster validation remain deferred.

### Increment 48 (M14 Inc 48): Email-Verification Web UI (ADR-0112) ✅

Makes the second half of the identity-recovery surface reachable from a browser. `POST /v1/auth/email/verify` and the optional register `email` field have existed since M4 (ADR-0026) with no way to supply an address or act on a link; this closes that without touching the backend.

- **Optional registration email (`packages/web/index.html`, `packages/web/src/app/auth-controller.ts`)**: one optional field on the existing combined auth form. `register` trims the value and includes the `email` key only when it is non-empty, so an email-less registration sends byte-for-byte the request it sent before. Sign-in is explicitly *not* gated by it: the form carries `novalidate` and validation is per action — register validates the whole form, sign-in validates only handle and password — because a malformed address left in an optional field must never stop an existing user signing in. Passkey sign-in is untouched.
- **Route and token transport (`packages/web/src/app/router.ts`, `route-surface.ts`, `bootstrap.ts`)**: public `/email-verify` accepting `#token=...` as an entry transport only. **The token rides the URL fragment, and this increment moved `/password-reset` off the query string with it.** ADR-0109's query transport could not be made safe client-side: a query string is part of the request line, so `?token=...` reached the web tier on the first navigation before any script parsed, and nginx's default access log kept a live credential that `replaceState` cannot retract. A fragment is never transmitted. Both flows moved together rather than leaving the older one exposed; no delivered link breaks because nothing composes these URLs yet (`EmailSender.sendEmailVerification` takes a bare token), but a real provider must emit the fragment form. The token is still captured and the fragment cleared with `history.replaceState` before app composition, the capabilities request or session restore — now protecting the location bar and history rather than the wire. The capture/strip mechanism is one helper shared with `/password-reset` instead of two copies.
- **Verification surface (`packages/web/src/app/email-verification-controller.ts`, `email-verification-mount.ts`)**: a DOM-free controller with the same dual-generation guards as `PasswordResetController`, covering pending, success, invalid/expired/already-used, missing token, and transient failure with one controlled retry. Success and 401 are terminal and release the token, so a consumed or rejected token cannot be replayed by the mounted route; only a transient failure retains it. Error copy is fixed text, never the caught error, so nothing can echo the token.
- **Lifecycle and design**: `emailVerification` is its own named disposable in `BootstrappedDisposables` and `DISPOSABLE_TEARDOWN_MAP`, so ADR-0092 exhaustiveness covers it; disposal is idempotent and terminal, and a completion after disposal touches nothing. The surface reuses `.auth`, `.auth-actions`, `.auth-meta` and the existing status/error treatments — the only new CSS is one scoped rule keeping the retry control at the system's existing 44px touch target, which the shared `@media (pointer: coarse)` rule does not reach on a narrow desktop window.
- **Testing**: 679 web unit tests including API contract, controller state machine, mount lifecycle, router and route-surface exhaustiveness, `history.replaceState` ordering against a transport call counter, a11y markup, and a style-contract assertion for the touch target — plus a regression test pinning the transport itself, which drives `/email-verify?token=...` and asserts no request is issued, so a later "accept both" edit cannot restore the query-string exposure. The Playwright specs for both recovery flows record *every* request the browser makes, navigation included, and assert none carries the token; the email-verification spec also covers success, no-replay, 401, transient-then-retry, missing token, session preservation for a signed-in visitor, and 390x844 layout. Documented in `docs/adr/0112-email-verification-web-ui.md`. **Production delivery closed in M15 Increment 18 (ADR-0126):** one required Resend transport builds both fragment links from validated `PUBLIC_WEB_ORIGIN`, production cannot fall back to console, and authenticated rate-limited verification resend replaces earlier active tokens. A durable outbox remains deferred.

## ✅ Verification hygiene — ADR claim drift guard (ADR-0079)

Cross-cutting, not tied to one milestone. Increment 11 found ADR-0010 §7 specifying six ownership
metrics that had never been implemented — ownership was unobservable in production for months,
because an ADR is prose and nothing checks it. `scripts/check-adr-claims.mjs`
(`npm run check:adr-claims`, in CI's `build-test` job) now fails when an ADR names a repo-relative
path, a metric, an `npm run` script or a sibling ADR that does not exist.

Its limits are deliberate and stated: it proves the things ADRs name **exist**, never that an ADR is
**true** — ADR-0010 §6 was a false sentence with no missing identifier, and only executing the system
(ADR-0077's chaos suite) finds that class. The audit found the corpus healthy: three stale references
across 78 ADRs, two of them from our own `nginx.conf` rename in ADR-0075.

Also fixes the `e2e-harness` protocol test, which failed intermittently with `game did not end after
301 moves` **and hung the file for 178s when it did** — presenting a failure as a frozen suite, with
the same signature as the known port-4175 conflict. Termination is now guaranteed by the harness's own
`resignAfterPlies` lever (12–14 moves against a 300 valve) rather than by luck; seeded move choice
removes one source of variance but was measurably not sufficient alone. 10 consecutive runs, 10 passed.

### Deferred (later M14 increments)

- Terraform IaC for cloud provisioning
- 100k-user cluster load testing (chaos and failover mechanisms validated in Increment 11)
- Dedicated game authority shards separate from gateway processes (ADR-0010 §3/§9; single-owner authority with Redis ownership registry and command forwarding is implemented)
- Optional sticky per-game routing as an optimization (ADR-0010 rejected sticky routing as primary authority architecture in favor of command forwarding; preserved as optional future load-balancing optimization)

### Known follow-ups (tracked)

Debt observed during M14. Each states what is known, not what is planned; items closed by a later increment stay listed with their resolution so the trail from symptom to cause survives.

- **PGN move suffix annotations (`!`, `?`, `!!`, `??`, `!?`, `?!`) are silently discarded on import (RESOLVED in Increment 26 / ADR-0093).** `packages/studies/src/pgn-parse.ts:306` pushed `{ san: token, nags: [], ... }` with empty NAGs while stripping suffix characters in `isSanShaped` (line 339) for validation only, and `appendNode` in `packages/studies/src/repository.ts:662` normalized the move via `resolveSan`. As a result, suffix annotations vanished upon import with no error and NAG symbols were unreachable via PGN text unless specified via explicit numeric NAG tokens (`$1`–`$6`). **Resolved in Increment 26 (ADR-0093):** the parser now captures the whole trailing `[!?]+` run and maps it to `$1`–`$6`, keeping `+`/`#` in the SAN; an unrecognised run (e.g. `!!!`) is a located parse error rather than a silent drop. One change covers both adapters — `packages/persistence/src/pg/studies.ts:24` imports `parsePgn` from `@chess-platform/studies` rather than duplicating it, unlike the import-ordering divergence ADR-0091 §10 found.
- **The API composition root forwarded optional dependencies by hand, and the list was silently incomplete when one was added (RESOLVED in M15 Increment 23 / ADR-0131).** The same defect as the `main.ts` disposal list below, in `packages/api`. `ApiDependencies` carries twenty-four optional keys, which passed through two hand-written literals — the bundle `createPgDependencies` assembles and the copy `createApiServer` hands `buildRouter`. Every key being optional in both types meant omitting one compiled cleanly: build, lint and the whole suite green, and the feature answering 503 from a deployment that configured it correctly. Increment 22 shipped that omission for `tournamentCommentary` — routes, presenters, OpenAPI, client, controller, view and sixty tests, all correct, all answering 503 because one line was missing from `server.ts`. It was found by calling the endpoint. **Resolved in M15 Increment 23 (ADR-0131):** `ForwardedKey = Extract<keyof ApiDependencies, keyof RouteDeps>` yields a union alias, so the mapped type over it is non-homomorphic and does not carry `?` across — every key becomes required while its value type still admits `undefined`, making `analysis: deps.analysis` legal with no engine composed and a missing line `TS2741`. `OptionalDependencies` does the same for the production bundle. Both sets derive from the declarations, so a new feature joins them when it is declared and there is no list to forget. Both mutation survivors were findings rather than weak tests, and each was closed by changing code: dropping the resolved `tracer` override compiled and passed everything — correctly, because `RouteDeps` declared `tracer?: Tracer` and no route handler ever read it, so the dead key was deleted; and widening `buildRouter`'s parameter removed the guard outright while every test still passed, because the parity predicates named `RouteDeps` instead of reading `Parameters<typeof buildRouter>[0]`. **The counted ledger lives in ADR-0131 and is deliberately not restated here** — this entry carried its own copy of the numbers and drifted from them twice, which is the same failure the increment exists to remove. It left one gap, which is a **separate defect with its own resolution** and is tracked in its own entry immediately below rather than folded in here.
- **The published capability document could omit a composed feature, and the client offered controls that could not work (RESOLVED in M15 Increment 24 / ADR-0132).** Left open by Increment 23 above. `capabilitiesView` (`packages/api/src/presenters.ts`) took a hand-written `Pick`, so a feature never added to it was invisible to `GET /v1/capabilities` and nothing complained. ADR-0131 judged that "a narrower failure than a 503 — the feature works for anyone who calls the route directly", and deferred it on the grounds that closing it meant first deciding which optional dependencies are user-facing capabilities. **Both halves of that were wrong.** The failure is narrower only when the client can still reach the feature, and a live instance already existed where it could not: `GET /v1/search` served three modes from two independently-gated dependency sets behind one published `search` flag, so a deployment running the Helm chart’s `search.semanticEnabled: false` advertised search while the client offered two mode buttons whose every request answered 503. And the judgement, while genuinely underivable, can be made **unskippable**, which was the property wanted. `semanticSearch` is now published from both of its dependencies, `Exclude<OptionalDependencyKey, keyof Parameters<typeof capabilitiesView>[0] | NotAPublishedCapability>` must be `never` so a new optional dependency cannot compile until someone gives it a flag or records why it has none, and a behavioural guard requires every capability source to change what the document publishes — because a key can sit in that parameter unread, which the compile-time half cannot see. The mutation ledger lives in ADR-0132 and is not restated here.
- **The search surface was not gated on `capabilities.search`, so an absolute kill switch still showed a search box (RESOLVED in M15 Increment 24 / ADR-0132 §5).** `SEARCH_ENABLED=0` — the chart's `search.enabled: false`, an absolute kill switch per ADR-0055 — leaves `searchRepository` unconstructed and `GET /v1/search` answering 503 on every mode, keyword included. The entry point was the persistent header form in `packages/web/index.html`, present on every page; being a `<form>` rather than an `a[data-route]`, `NAV_CAPABILITY_MAP` could not reach it, which is why the first pass at Increment 24 gated the semantic and hybrid *modes* and left keyword ungated — the same defect class one mode over. Raised by the Qodo review of PR #155. **Fixed in the same increment rather than deferred:** the form now ships `hidden` and is revealed by `applySearchCapability` only on an explicit `search: true`; the route renders an honest unavailable notice and issues no request; and keyword search waits for the capability answer, reversing this increment's own earlier latency decision, because knowing whether a request is pointless requires having asked. A markup-contract test pins the `hidden` attribute, since the gate depends on it and every other test passes without it.
- **Clicking a search mode discarded text typed since the page loaded (RESOLVED in a follow-up to M15 Increment 24 / ADR-0132).** `createModeInput` in `packages/web/src/app/search-mount.ts` closed over the query captured when the route mounted, so `navigateToSearchMode` navigated with the old term and the remount reset the input to match it. Type a new term into the header field, click **Semantic** without pressing enter, and the typed text was gone with no indication it had been discarded. Pre-existing — the closure predated Increment 24 and was untouched by it — and found by the adversarial review of PR #155 while reviewing the capability gate wrapped around the same control. **Resolved:** the query is now a `() => string` read when a mode is chosen rather than a string captured when the selector renders, matching what `main.ts`'s submit handler already does, and falling back to the mounted query only where the document has no header input. Two regression tests, one of which fails against the exact pre-fix closure.
- **`startHarness` drew ports `fetch` refuses (RESOLVED in ADR-0140); the unexplained whole-file failure is still open.** Two signatures were filed here, deliberately not as one cause, and that judgement held. **Signature A is resolved.** WHATWG Fetch blocks eighty-two ports and undici enforces the list on the port number alone, before opening a socket — so `server.listen(0)` could bind, listen and answer raw TCP while `fetch` still refused, surfacing as `TypeError: fetch failed` / `Error: bad port` at the harness’s first request rather than at the listen that caused it. Whether it can happen at all is a property of the host’s dynamic port range: a typical Linux CI range (32768–60999) contains no blocked port, while the Windows range in use here (1024–15000) contains nineteen, which is the whole of "green on CI, flaky locally". The guard that already existed was incomplete in a way that still failed — its hand-observed set of eighteen ports was the spec list intersected with one machine’s range **minus `6679`** — and it retried unboundedly, had no behaviour on exhaustion, and had been copy-pasted into `auth-signin-schema.integration.test.ts`, so the missing port had to be found twice. `packages/api/test/listen.ts` now owns port acquisition for both sites: the spec-complete eighty-two ports (verified by sweeping all 65535 through the real `fetch` on Node v24.15.0), a bounded twenty attempts, each rejected listener closed before the next is asked for, a guarded `address()` read in place of the `as AddressInfo` cast, and an exhaustion error naming the attempts and rejected ports and nothing else. **Signature B is not resolved and was not folded in.** A file still fails with `'test failed'`, no assertion, no stack and none of its own tests reported. Twenty consecutive full runs gave five failures: on pre-fix code one signature A (`auth.test.js`) and three signature B; on post-fix code one signature B and no signature A. The port fix removes A and leaves B exactly where it was, which is the evidence that they are two defects. Four different files were hit (`move-explanation-route`, `tournament-commentary-route`, `bot-detection-analyze`, `anti-cheat-analysis`), sharing no import beyond `./helpers`; each died in 589–703 ms with no test of its own reporting and no stderr. Refuted with evidence: ephemeral-port exhaustion (113 sockets in TIME_WAIT against a 13977-port range), a `Promise.race` loser becoming an unhandled rejection (`race` subscribes to every promise, confirmed on v24.15.0), a throwing `after`/`afterEach` hook (the affected files use none), and a double `close()` rejecting (awaited in a `finally`, it would be attributed to that test with a stack). A second bounded pass — twelve more full runs under the TAP reporter with a preload recording `uncaughtException`, `unhandledRejection` and any non-zero exit — produced twelve clean runs and captured nothing at the time. **A follow-up increment (`claude/node-test-signature-b`) then captured the defect directly, three more times, on three files never previously implicated** (`rate-limit-atomicity`, `dependency-parity`, `studies-api`) — seven distinct files observed with this symptom to date. Occurrences across seven distinct files make a shared or cross-cutting path more plausible and make a defect confined to one test file less likely, but do not exclude file-specific inputs or lifecycle interactions. An instrumented preload (`packages/api/test/diagnostics/signature-b-preload.cjs`) hooking process-level events — `process.exit`, `process.abort`, `process.kill`, `uncaughtExceptionMonitor` (passively observing uncaught exceptions and fatal unhandled rejections), `warning`, `beforeExit`, and Node’s own unconditional `exit` — showed **none of the hooks active at the time fired** on any of the three historical captures (though `process.abort()` was not wrapped in those initial runs and is now covered for future occurrences). A synthetic `process.exit(1)`-before-registration fixture reproduces the identical silent shape; every other synthetic mechanism tried (a post-test async throw, an emitter `'error'` with its listener removed, a synchronous module-load throw, a delayed `SIGKILL`) prints a visibly different diagnostic line, stack, or partial test output that the real defect never shows. This narrows the investigated possibilities while leaving the root cause unresolved: the per-file child process (`node --test` spawns one per file, confirmed by distinct PIDs) was not terminated by `process.exit`, uncaught exceptions, or fatal unhandled rejections, and future runs with `process.abort` instrumentation will record whether abort was called through JS; an absent record narrows in-runtime JS termination but cannot alone prove external termination without corroborating child exit status/signal data or OS-level crash evidence (e.g. distinguishing an external kill or uncatchable signal from a native C++/V8 crash). The machine had roughly 2.5 GB of 15.7 GB RAM free at capture time with several other agents’ processes concurrently running, which is circumstantially consistent with resource contention, but no crash was recorded in the Windows Application or System event logs in that window, so the exact external trigger is still not established. No fix was invented — the forbidden responses (sleeps, whole-file retries, lowering concurrency) would only hide the unresolved root cause, whose origin is not yet established. **A further increment then crossed the parent/child boundary the earlier work stopped at, and found the evidence had been there all along:** Node's runner attaches the child's `exitCode` and `signal` to the `ERR_TEST_FAILURE` it throws, and the `spec` reporter discards them — `formatError` replaces the error with `error.cause`, the bare string `'test failed'` — while the built-in `tap` reporter serializes them, so running `spec` to stdout and `tap` to a file recovers the exit status with no custom reporter and no patched internals. Exit codes were measured on this platform rather than assumed: `process.abort()` gives `134`, `Stop-Process -Force` gives `4294967295`, NTSTATUS faults surface as raw unsigned values such as `3221225477` (`0xC0000005`) — and `1` is produced alike by an uncaught exception, `process.exit(1)`, `taskkill /F` and `process.kill`, so it identifies nothing on its own and is classified `inconclusive`. `signature-b-correlate.cjs` joins the parent's TAP record to the child's JSONL log on the test file path (which also yields the child PID) and states what the pair does and does not establish; where the exit code is ambiguous, a child that reached `preload-installed` and then logged nothing still excludes `process.exit` and an uncaught exception, because both would have left a record and fired Node's `exit` event. A bounded pass of 20 runs under this instrumentation produced 0 captures — which bounds the rate and proves nothing: treating the historical ~1-in-5 as an independent per-run rate, zero captures in 20 runs has probability `(4/5)^20 ≈ 1.2%`, and independence is an assumption rather than an established fact; it ran at 3084–3834 MB free against roughly 2.5 GB at the historical captures, consistent with the resource-contention hypothesis but not evidence for it. **Signature B stays UNRESOLVED**; what changed is that the next occurrence is readable rather than silent. **During M15 Increment 46 validation, Signature B was directly observed three more times, broadening the observed scope to `packages/persistence`:** `search-backfill.integration.test.ts`, `learning.integration.test.ts`, and `test-database.integration.test.ts` each died with the documented bare whole-file `'test failed'` with zero tests reporting and no assertion or stack, and each passed standalone against the exact database state it died on. This confirms the defect is not specific to `packages/api` or its HTTP server test harness. **M15 Increment 47 hardened the diagnostic correlator across 26 bounded runs:** 1 baseline full-suite run, 20 sequential runs under `run-signature-b-pass.mjs`, and 5 concurrent repository-native load runs produced 0 captures (which bounds the rate under those conditions and does not resolve the defect). Code inspection and falsification identified and fixed four correlator blind spots in `packages/api/test/diagnostics/signature-b-correlate.cjs`: (1) cross-directory basename fallback could falsely match a child log from another directory when the target had slashes; (2) Windows path case folding was host-dependent (`process.platform === 'win32'`), breaking cross-platform correlation when logs were analyzed on a different OS; (3) signed 32-bit Windows NTSTATUS exit codes (e.g. `0xC0000005` surfacing as `-1073741819`) were not normalized to unsigned values; and (4) quoted TAP YAML scalar tokens lost exit code or duration numbers. The targeted test suite was expanded from 23 to 41 tests (39 pass, 2 skip, 0 fail), killing 4 falsification mutations. **Signature B remains UNRESOLVED;** no production fix was invented, and the next occurrence will be correlated without cross-platform or exit-code blind spots. **M15 Increment 48 recorded 0 Signature B occurrences** across its baseline reproduction, A/B/C acceptance, mutation rounds and full-repository validation — which, like Increment 47's 26 bounded runs, bounds the rate under those conditions and resolves nothing. It stays an open tracked defect. **M15 Increment 49 likewise recorded 0 occurrences** across its pre-fix reproduction on four databases, its fresh-database acceptance runs, two rounds of falsification and a full-repository run of 3304 tests. Three zero-observation increments in a row bound the rate and establish nothing about the cause; it stays an open tracked defect. See ADR-0140 §4. **M15 Increment 51 captured it five more times and named the mechanism family, without resolving it.** A bounded campaign of 39 runs across `packages/api` and `packages/persistence` produced 5 real captures, every one of them reporting exit status `3221226505` (`0xC0000409`, Windows `STATUS_STACK_BUFFER_OVERRUN`, the fail-fast-class status) with `signal: null`, a child lifecycle log holding exactly `start` and `preload-installed`, and no normal JavaScript shutdown hook running at all. On the four captures taken with the hardened harness, the fatal-marker channel and the Node diagnostic-report channel were both empty, which is what excludes the measured V8/Node fatal path (including heap OOM): the synthetic fatal path writes fatal stderr diagnostics into the TAP report **and** a PID-attributable report under `--report-on-fatalerror`, and these produced neither. `process.exit`, ordinary uncaught exceptions, fatal unhandled rejections and an instrumented JS `process.abort()` are excluded by the same silent lifecycle log, and node:test parent cancellation is excluded by reading the runner's own source: `FileTest` sets `this.timeout = null`, so no parent file-level wall clock exists, and an aborted child sets `err` through `child.on('error')` and is reported as an `AbortError` rather than the bare fallback. **Two sources remain and the evidence does not choose between them:** an in-process Windows fail-fast path (a security mitigation, `RaiseFailFastException`, or equivalent native source), or an external party calling `TerminateProcess` with `0xC0000409` as the chosen status — an exit status being an integer the terminating party picks, the status alone cannot separate them. Avast Antivirus is present and `aswhook.dll` was observed loaded inside a live `node.exe`; **injection is not causation**, so that is a concrete leading candidate for a controlled future A/B test and not a root cause. No antivirus was disabled, no exclusion was added and no security posture was changed. The Node 22 arm was 17 runs and 0 captures, which does not establish a Node-version difference. **Signature B stays UNRESOLVED at Level C** — mechanism family established, terminating source not — and the next steps (ETW `Microsoft-Windows-Kernel-Process` tracing or WER `LocalDumps`, and the AV A/B test) all change machine configuration and need owner authorization.
- **Isolated-database test teardown dropped databases out from under connections that had not finished closing (RESOLVED in M15 Increment 45).** `withDatabase` in `packages/persistence/test/variant-migrations.integration.test.ts` ended its pool and then immediately ran `DROP DATABASE ... WITH (FORCE)`. `pool.end()` does not wait for its clients to close: in pg 8.22.0 `_pulseQueue` reaches the end callback in the same synchronous turn in which `_remove` filters the last client out of `_clients`, while `client.end()` has only queued the Terminate byte — instrumentation recorded **zero of four `remove` events fired at the moment `end()` resolved**. The drop could therefore still find a backend attached; `FORCE` terminated it, and the resulting `FATAL` arrived on a socket whose pool still had `idleListener` attached, which `pg` re-emitted as `pool.emit('error')` — an unhandled EventEmitter error that `node:test` attributed to whichever test was running rather than to the teardown that caused it. It surfaced as intermittent `terminating connection due to administrator command` failures in `postgres integration (persistence)` during M15 Increment 44, on a different test each run, which is the signature of a race rather than a broken assertion. The same shape existed in `packages/api/test/auth-signin-schema.integration.test.ts`, which had absorbed SQLSTATE 57P01 with a `pool.on('error', ...)` listener — a symptom fix for the same cause. **Resolved in Increment 45:** a shared `withTestDatabase` helper (`@chess-platform/persistence/test-support`) ends the pool under a bound, waits for `pg_stat_activity` to report the database unused, and drops it *without* `FORCE`. Measured on PostgreSQL 16.14, a plain drop against a still-attached backend fails with SQLSTATE 55006 and leaves that connection untouched, where `FORCE` succeeds by killing it — so the change trades a quiet, harmful success for a loud, harmless failure. FORCE remains only on the emergency path that guarantees the disposable database is still dropped once teardown has already failed — best effort, since that last drop runs inside a `catch` so it cannot bury the error being reported. The 57P01 absorber is deleted, because the corrected lifecycle never causes one. `createPool` and `migrate` are unchanged, and no migration was added.
- **The persistence integration suite was not idempotent against a reused database (RESOLVED in M15 Increment 46).** Recorded as a known defect by Increment 45 and left open there. Against a fresh PostgreSQL 16 database the suite passed; a second run against the *same* database failed nine tests, deterministically — measured on 16.14 before any edit as **173 pass / 0 fail** then **164 pass / 9 fail**. CI provisions a fresh server per run, so it never surfaced there. One contract was being broken in two directions: a suite sharing `chess_test` must remove every row it created and remove nothing else. `achievements.integration.test.ts` broke the second half with an unqualified `DELETE FROM users` in `beforeEach` — `games.white_id` and `games.black_id` are the only references to `users` without `ON DELETE CASCADE` (thirty-one FKs point at `users`; twenty-nine cascade; the two that do not are both on `games`), so one game left behind by `pg.integration.test.ts` aborted the wipe with SQLSTATE 23503 before any assertion ran, and the same statement destroyed the bot accounts migration 0021 seeds, which nothing restores because `migrate` has already recorded 0021 as applied. `pg/identity-tokens.test.ts` and `tournaments.pg.integration.test.ts` broke the first half, leaving fixed primary keys behind and colliding on `users_pkey` and `tournaments_pkey` (the latter surfacing through the repository's compare-and-set as `VersionConflictError`). **Resolved in Increment 46:** suites that legitimately share the database delete exactly their own rows through `withSharedDatabase` (`packages/persistence/src/test-support/fixtures.ts`), the sibling of Increment 45's `withTestDatabase` and heir to its precedence rule — a cleanup failure never replaces the assertion that actually failed, and never disappears either. `pg.integration.test.ts` moved to disposable databases instead, because it cannot meet the cleanup half at all: it appends to `game_events`, which is append-only by production trigger, so cleaning up after itself would have meant weakening a production safety rule to suit a test. `users-batch`, `anti-cheat`, `bot-reports` and `analysis-cache` were corrected for the same contract though none of them ever failed — fresh `uuidv7()` ids meant their leaked rows could not collide, so the tables merely grew on every run. Serialization was not the fix and was not introduced: `--test-concurrency=1` is a pre-existing documented invariant and the second run failed identically under it. Acceptance is three consecutive runs against one database with no reset between them (186/186/186), after which only the three migration-seeded bot accounts remain, with no leaked disposable databases and no lingering backends; falsification killed 17 of 20 mutations. No production code, migration, checksum, constraint or repository conflict semantic changed, and no migration was added.
- **The API pg-security integration suite leaked every row it created into the shared database (RESOLVED in M15 Increment 48).** Recorded as a known defect by Increment 46 and deliberately left open there. `packages/api/test/pg-security.integration.test.ts` created users, password credentials, roles, sessions and rate-limit buckets through real repositories and closed its pools without removing any of them. Because every identifier it mints is a fresh `uuidv7()`, no run collided with another, so all 11 tests passed indefinitely while the database grew — measured on PostgreSQL 16.14 before any edit as **11/11 passing and 25 rows leaked on the first run (4 users, 4 credentials, 4 roles, 4 sessions, 9 rate-limit buckets), then 11/11 again and an identical further 25 on a second run against the same database**. The failure mode was silent accumulation, not a failing test, which is why nothing in the file could see it. `rate_limit_buckets` is the sharpest case: no foreign key references it, so no cascade can ever reach those rows, and `PgRateLimiter.sweep` only evicts buckets that expired over an hour ago. **Resolved in Increment 48:** every test runs inside Increment 46's `withSharedDatabase` contract and names what it owns — users deleted by exact owned id, with the proven `ON DELETE CASCADE` foreign keys removing their credentials, roles and sessions (the only non-cascading references to `users` are `games.white_id` and `games.black_id`, and this file creates no games), and rate-limit buckets deleted by exact owned key. Identifiers are recorded before the statement that creates the row, so a body that throws after a commit still surrenders it. Prefix-matched cleanup, `TRUNCATE`, broad `DELETE`, random-identifier workarounds, retries, conflict suppression and serialization were all rejected; `./test-support/fixtures` was added to the persistence package's `exports` so the canonical helper could be reused rather than duplicated. A second defect was fixed in the same increment: the bucket-creation race test read backend PIDs before the `try` whose `finally` releases the leased client, and a pool with a client still checked out never settles `pool.end()`, so a failure there hung the file instead of reporting the error — both reads now sit inside the protected region. Acceptance is three consecutive runs against one migrated database with no reset between them (**11/11, 11/11, 11/11**), after which the database state is identical to its pre-run reading, migration seeds and unrelated sentinels are preserved, no `test_db_*` databases are leaked and no backends linger; falsification killed **8 of 9 mutations**, the survivor being the `backendPid` error path, which needs fault injection no passing suite performs. No production code, migration, constraint, foreign key or repository semantic changed.
- **`analysis-cache-durable.integration.test.ts` depended on schema it did not establish (RESOLVED in M15 Increment 49).** Recorded as a known defect by Increment 48 and deliberately left open there. `packages/api/test/analysis-cache-durable.integration.test.ts` never called `migrate()`: it opened pools straight onto `DATABASE_URL` and assumed `engine_analysis_cache` — created by migration `0026` and indexed by `0027` — was already there. Re-proven on current `main` before any edit, on PostgreSQL 16.14: against a genuinely fresh, never-migrated database it was **10 tests, 4 pass, 6 fail**, three of them throwing SQLSTATE **42P01** from the suite's own `LOCK TABLE`, `DELETE` and `UPDATE`, and three failing as assertions because the durable row they expected was never written. The four that passed did so vacuously: `PgAnalysisCache` absorbs a database fault and returns a miss, so a suite about durability ran with no durability at all. Against an already-migrated database it was **10/10 — and left 5 rows behind every run**, `freshFen()` being collision-avoidance rather than cleanup. The masking was measured, not assumed: the whole `packages/api` package on a fresh database gave the same **6 failures**, while running `packages/persistence` first (186 pass) and then the file gave **10/10** — seventeen persistence suites migrate the shared `DATABASE_URL`, and both the root `test` script and the CI `postgres-integration` job run that package first. **Resolved in Increment 49:** the suite applies the canonical migrations itself, once per file behind a flag, asking the persistence package for the directory it ships (`migrationsDir()`) instead of assembling one from `process.cwd()`; every test runs inside Increment 46's `withSharedDatabase` contract; each FEN is recorded before the statement that creates its row; and cleanup deletes by exact FEN equality, never by the placement prefix every standard starting position shares. A disposable database per test was considered and rejected on cost and orphan risk; the shape chosen is the one the sibling suite for the same table already uses. Acceptance is three independent brand-new empty databases (**10/10, 10/10, 10/10**, 0 rows of residue each), an already-migrated database whose five unrelated rows survive untouched, and the whole API package on a brand-new database with no other package first (**996 tests, 986 pass, 0 fail, 10 skipped**, 0 residue, 0 leaked `test_db_*`). Falsification killed **7 of 9 mutations**; the two survivors are a failure-precedence contract owned by `withSharedDatabase` and killed by its own suite, and an equivalent mutant. No production code, migration or repository semantic changed.
- **M15 Increment 50 — test:counts / standalone gateway host setup contract (RESOLVED: SETUP / DOCUMENTATION CONTRACT DRIFT CORRECTED).** Increments 48 and 49 recorded gateway `ioredis` compilation failures during counts runs. Controlled clean states proved that root `npm ci` does not install the intentionally standalone gateway, and gateway installation alone does not build the public workspace outputs its local `file:` dependencies need. The supported host sequence, from the root with Node.js 22+, is `npm ci`, `npm run build`, `npm ci --prefix services/gateway`, then `npm run test:counts`. The counting command includes the gateway but does not install dependencies or build workspace public outputs. A root clean install preserves an already prepared gateway dependency tree and workspace outputs, explaining why prepared and unprepared hosts gave different results. No gateway implementation defect was proven; no workspace topology, script, lockfile, CI, Docker or runtime change is required. Setup instructions and the canonical handover are now synchronized; see [M15 Increment 50](PROJECT_STATE.md#m15-increment-50--testcounts--standalone-gateway-host-setup-contract) for controlled evidence and validation. **Signature B remains unresolved and under separate investigation:** historical state D passed the gateway but failed the aggregate with a bare file-level `test failed` in `openapi.test.js`; the isolated rerun passed. No mechanism is assigned to that observation and no unmerged diagnostic findings are adopted. Skips are not passes.
- **M15 Increment 51 — Signature B mechanism isolation and diagnostic hardening (UNRESOLVED — exact terminating source unproven; root-cause acceptance LEVEL C).** The increment set out to identify the process-termination mechanism behind Signature B, not to fix it, and is reported at the level the evidence reaches. **39 bounded runs produced 5 real captures** across `packages/api` and `packages/persistence`; all five reported `3221226505` (`0xC0000409`) with `signal: null` and a child log of exactly `start` and `preload-installed`. Capture 1 was taken by the pre-fix harness and its raw TAP and fatal-marker evidence was lost, so it is not claimed as decisive; captures 2–5 carry the full evidence set and reported empty fatal markers and empty diagnostic reports. Two diagnostic blind spots were **proven, not guessed**, and only those were closed: fatal markers were read from the parent runner's stderr, where a child banner can never appear (the runner re-emits child stderr as `test:stderr` reporter events, so the banner lands in the TAP report — measured at 0 bytes on the parent stream while the report held it), and child lifecycle logs were merged by test-file path across processes, which had produced the false statement that an external termination and a native fault were ruled out. Also delivered: per-failure report attribution with PID matching, stale and PID-reused evidence surfaced as explicit ambiguity, report bodies never retained on any exit path, artifact paths independent of the selected package’s working directory, artifact directories that start empty, an `--out` already holding a capture refused rather than reused, `--package` for cross-package runs, and POSIX OOM signal/status coverage alongside the Windows encoding. A 17-mechanism synthetic fingerprint matrix was measured with multi-field match criteria fixed **before** any real capture was compared against it; the correlator suite grew **41 → 57 tests** (55 pass, 2 pre-existing POSIX-only skips, 0 fail), identical on Node 22 and Node 24, and falsification killed **13 of 14 mutations**, the survivor being an equivalent region-boundary mutant under the TAP grammar Node can emit. No production code, workflow, migration or repository semantic changed. **A separate defect was observed and deliberately not fixed here:** the Increment 49 durable analysis-cache race test `two live instances racing a cold position both compute it` failed with an ordinary assertion (`expected: 2, actual: 1`, `cross-process single-flight does not exist`) — once locally on Windows and once in CI’s `postgres integration (persistence)` job on Linux at this branch’s HEAD. It is not Signature B (a full stack and a named assertion, not a bare file-level termination), it is not caused by this increment, and passing on rerun does not resolve it; two observations on two operating systems make it a real intermittent defect owned by the Increment 49 suite. See [M15 Increment 51](PROJECT_STATE.md#m15-increment-51--signature-b-mechanism-isolation-and-diagnostic-hardening) and ADR-0140 §4. **Signature B itself occurred twice during this increment’s own final validation** (`auth-signin-schema.integration.test.js` at 618.7 ms, `cookie-auth.test.js` at 707.0 ms, both on Node 24.15.0), each with the documented bare file-level shape and each on the plain `spec`-reporter path with no TAP destination and no preload — so **neither has exit-status, lifecycle, marker or report evidence**, and neither narrows Level C. Both are recorded rather than dismissed for passing on rerun. The host was under heavy memory pressure from unrelated concurrent work (699 MB free of 16077 MB at the first occurrence); an earlier attempt at the same run died differently, with `0xC0000142` (`STATUS_DLL_INIT_FAILED`) for the whole package command, which is a process that failed to start and is **not** counted as Signature B.
- **M15 Increment 52 — deterministic analysis-cache cold-race test (RESOLVED: integration-test scheduling nondeterminism).** The race test `two live instances racing a cold position both compute it` in `packages/api/test/analysis-cache-durable.integration.test.ts`, recorded as an open defect by Increment 51 after failing on Windows locally and on Linux in CI with `expected: 2, actual: 1`, is fixed — in the test, which is where the fault was. `Promise.all` starts both analyses and orders nothing in between: each instance owns a separate lazily-connecting `pg.Pool` and its own orchestrator whose single-flight map is a private field, the fake engine emits on `queueMicrotask` so a search is effectively free, and both the read and the write are real TCP round trips. Whether B’s `SELECT` is evaluated before or after A’s `UPSERT` commits was therefore decided by connection setup and OS scheduling, and when A won, B correctly read A’s row and ran no search. Measured on unmodified production code: awaiting A fully and then B gives **1** search with B recording a `cache_hit`, while starting both together gives **2** — ordering alone decides it. **Resolved** with a test-only rendezvous that holds each instance’s UCI `go` line — reachable only after the orchestrator’s cache read returned nothing — until both instances are held at once. A slot belongs to an instance rather than to a worker, because `EngineTimeoutError` is retryable and `EnginePool` retries on a fresh transport that sends its own `go`, which a line-counting barrier would have miscounted as a second party; and the barrier carries a failure ceiling rather than a delay, because the engine’s own 15s search watchdog would retry once and surface a stuck barrier after ~30s as an engine timeout. The test now asserts strictly more than before: both instances simultaneously at the boundary with one `cache_miss`, zero `cache_hit` and zero read/write faults each; exactly one search **per instance** rather than a sum; one stored row at `achieved_depth = 10`; and a later reader served without computing. 30 consecutive runs passed, the file is 10/10, the API package is 1012 tests with 0 failures, and falsification killed the pre-fix arrangement and a non-holding barrier, with two survivors reported as invisible while the barrier works. **Cross-process single-flight still does not exist and none was added; duplicate computation on a genuinely simultaneous cold miss remains expected; no production code, schema or cache semantic changed.** See [M15 Increment 52](PROJECT_STATE.md#m15-increment-52--deterministic-analysis-cache-cold-race-test).
- **`ApiServer.listen` registered no `'error'` handler, so a failed bind hung and raised an uncaught event (RESOLVED in ADR-0140 §5).** `packages/api/src/server.ts` resolved its promise from the `listening` callback only and built it with no reject path. A bind failing asynchronously (`EADDRINUSE`, `EMFILE`) left the promise pending forever and, with no `'error'` listener on the `http.Server`, was re-raised as an uncaught exception. Found while investigating ADR-0140 and independently raised by the Qodo review of PR #21. **Resolved in the same increment** rather than deferred, because ADR-0140 §2's bounded, diagnosable acquisition is not true without it — the retry can only report a bind error if the listener it is handed rejects. A one-shot `'error'` listener now rejects and is removed once listening, so later server errors keep their previous semantics rather than being swallowed by a `reject` on a settled promise. The regression test fails against the exact pre-fix code, through an uncaught `ERR_UNHANDLED_ERROR`.
- **`main.ts`'s controller-disposal list is manual, untested, and silently incomplete when a section is added (RESOLVED in Increment 25 / ADR-0092).** `run()` in `packages/web/src/main.ts` disposes the previous route's controllers by name, and its own comment says doing so "is what makes re-bootstrapping safe" — but adding a section to `bootstrap` and forgetting to add it there compiles, passes every gate, and leaks. Increment 23 shipped exactly that omission for `LearningController` and it was caught in PR review, not by a test. `main.ts` has no test coverage of any kind, so no section's disposal is verified. A structural fix (bootstrap returning its disposables as a collection, or a type-level exhaustiveness check keyed off the result type) would make the next omission a compile error; it is a refactor across ~15 return sites and belongs in its own increment. **Resolved in Increment 25 (ADR-0092):** extracted `createLifecycle` run loop in `lifecycle.ts`, defined `BootstrappedDisposables` and `DisposableKey` driving `DISPOSABLE_TEARDOWN_MAP: Record<DisposableKey, true>` for compile-time exhaustiveness, normalised `.dispose()` verb across all disposables, and cascaded `GameController.stop()` to `gameSync.stop()`.
- **`stepView` sends the answers to the learner (RESOLVED in Increment 29 / ADR-0095).** `packages/api/src/presenters.ts` emits `expectedSan` on a move step and `correctIndex` on a quiz step, and `GET /v1/lessons/:id/steps` is the route the learner's own lesson page calls. Increment 23 omits both from the client-side types (`packages/web/src/api/models.ts`), so the app cannot render or grade against them and a future edit that tries becomes a compile error — but the fields are still on the wire and readable in devtools. The authoring routes legitimately need them returned to the author, so the fix is a learner-scoped step view (or a caller-dependent projection), not a deletion: an API contract decision with its own ADR. Nothing rated or rewarded depends on step progress today, so this is a wart rather than a breach. **Resolved in Increment 29 (ADR-0095):** added `LearnerStepView` / `learnerStepView` in `packages/api/src/presenters.ts` omitting `expectedSan` and `correctIndex`. `GET /v1/lessons/:id/steps` and `GET /v1/steps/:id` now check course authorship via `repo.getLesson` / `repo.getCourse`, returning full `stepView` to the author and `learnerStepView` to learners and anonymous callers. Updated OpenAPI schema and web model comments. The first attempt resolved authorship with a separate `getLesson` + `getCourse` after the step read, which doubled both routes from 3 SQL queries to 6 because `listSteps` / `getStep` had already made those reads internally and discarded the course; caught in the PR #92 review and fixed by adding `getStepWithCourse` / `listStepsWithCourse` to `LearningRepository`, which return what was already loaded. Both routes now make exactly one repository call, pinned by a counting-proxy test.
- **`attemptResultView` drops the domain's `message` (RESOLVED in Increment 31 / ADR-0097).** `AttemptResult` in `packages/learning/src/model.ts` carried `readonly message?: string`, but the field was never populated by any repository implementation (`in-memory-repository.ts` or `persistence/src/pg/learning.ts`) — so the presenter omitting it in `packages/api/src/presenters.ts` drops nothing today. Increment 23's UI says `Try again` with no reason attached, which reflects what the system produces. Same class of contract divergence as the `ForumPostView` divergence fixed in Increment 21 (ADR-0088) and the `JoinRequestView` one resolved in Increment 28 (ADR-0088); resolving it required a product decision to either populate the field in repositories or delete it as speculative. **Resolved in Increment 31 (ADR-0097):** deleted. Populating it means writing the wording of a feedback feature that has never existed, which is a product decision rather than a contract fix; removing a field no implementation sets is the reversible direction, and the domain can regain it the day something produces a value. `AttemptResultView` gained the schema/presenter coupling test it was the last presenter to lack. The real gap this makes visible — a wrong quiz answer yields `Try again` and nothing else, since a quiz step has no author-written explanation field and ADR-0095 removed `correctIndex` from the learner's view — is recorded in ADR-0097 §2 and is a design task, not a dropped field.
- **Playwright suite flakiness across specs (RESOLVED in Increment 17 / ADR-0084).** The cause was unbounded local worker parallelism against a single shared `e2e-harness` process and Vite preview server on high-core machines, degrading every spec including static ones like `packages/web/e2e/app-loads.spec.ts` (which ranged 638ms to 200,621ms). Fixed in Increment 17 by introducing a worker ceiling in `packages/web/playwright.config.ts`. CI never encountered this because runners have fewer cores. Recorded in `docs/adr/0084-e2e-worker-cap.md`.
- **`GET /v1/search` returns no display metadata, forcing per-result hydration (RESOLVED in Increment 27 / ADR-0094).** The contract in
  `packages/api/src/openapi/schemas.ts` returned `{ id, score }` only, so the Search UI resolved every
  row through a second call — up to 12 requests for a page of 10, painting only once every one of them
  settled. ADR-0083 §2 recorded the gap and the three mitigations in place (page size
  10, parallel entity fetches, single-batch `resolvePlayers`), which bounded the cost without removing it.
  **Resolved in Increment 27 (ADR-0094):** `SearchableDocument` gained an optional `display`
  (`type`, `title`, `subtitle`) — deliberately separate from `fields`, whose values are canonicalized
  lowercase for exact-match filtering, and from `text`, which is a match corpus rather than something a
  person reads. Built only from data each entity's public view already exposes, with a test asserting a
  player document still carries no email, hash or flag. One request per query; the per-row hydration
  failure mode is gone with the fetches.
- **Private-team join requests are unreachable through discovery, so the 4 routes cannot get a UI as they stand (RESOLVED in M15 Increment 16 / ADR-0124).** Found while scoping Increment 22, which originally intended to build them. `listTeams` skips private teams for non-members and `GET /v1/teams/:id` answers 404 for them (`findVisibleTeam`, `packages/community/src/repository.ts`) — deliberately, as ADR-0069's Existence Oracle protection. `POST /v1/teams/:id/join-requests` did *not* apply that check, so a leaked team id was an existence oracle even though ordinary discovery hid the team. A second gap compounded it: `GET /v1/teams/:id/join-requests` is admin/owner-only, so a requester who reloaded could not recover the pending request id needed by the existing cancellation route. **The owner/admin moderation half shipped in Increment 30 (ADR-0096). M15 Increment 16 closes the requester half without weakening discovery:** repository adapters now make a live invisible private team and a missing team produce the same `not_found` result, and `GET /v1/me/join-requests` returns only the authenticated caller's pending rows with raw request/team identifiers and no team presentation metadata. Accepted, declined, and cancelled rows are absent; legacy pending private rows remain recoverable for cancellation. Private-team onboarding remains deferred to an explicit privacy-preserving capability rather than a bare id.
- **`JoinRequestView` in the OpenAPI spec declares a field the server never sends (RESOLVED in Increment 28 / ADR-0088).** `packages/api/src/openapi/schemas.ts` puts `updatedAt` in the `required` list and never mentions `respondedAt`; `joinRequestView` in `packages/api/src/presenters.ts` has always emitted `createdAt` and `respondedAt`. `FriendRequestView`, the same shape in the same file, has it right — which is what makes the divergence visible. This is the identical defect class fixed for `ForumPostView` in Increment 21 (ADR-0088), and dates to M10 increment 4 (#64). **Resolved in Increment 28 (ADR-0088):** `JoinRequestView` schema corrected in `packages/api/src/openapi/schemas.ts` by replacing `updatedAt` with `respondedAt` (nullable `dateTime`), regenerated `packages/api/openapi.json` via `npm run openapi`, and added contract assertions in `packages/api/test/community-api.test.ts` plus a schema/presenter coupling test in `packages/api/test/openapi.test.ts` — the latter because response-shape assertions alone left the whole suite green when the schema was reverted.
- **The E2E environment indexes no documents, so no test asserts a query returns hits (RESOLVED in Increment 19 / ADR-0086).** ADR-0083 §7 records this. `packages/web/e2e/search.spec.ts` covers navigation, deep links, prompt state and history behaviour — all reachable without an index. Resolved in Increment 19 by wiring an `InMemorySearchRepository` into `e2e-harness` and exposing `POST /e2e/search-index` to seed fixture documents in E2E tests.

---

## Working method (applied every milestone)

1. **Build** the milestone to its acceptance criteria with tests.
2. **Self-critique loop:** review for architectural mistakes, perf bottlenecks,
   security issues, poor abstractions, duplication, race conditions, API
   inconsistencies, UX gaps — then refactor.
3. **Multi-perspective review:** evaluate from the viewpoints of a distributed-
   systems engineer, a performance engineer, a security engineer, and a chess-
   server maintainer; merge and apply feedback.
4. Advance only when no critical issue remains.

