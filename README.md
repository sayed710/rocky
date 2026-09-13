# Rookzen — an open-source chess platform

> **Product and brand context:** [Rookzen decision record and complete research archive (Arabic)](docs/PRODUCT_BRAND_CONTEXT_AR.md). Captures the owner's current direction, provisional identity, rejected alternatives, and the distinction between local implementation and shipped work.

An ambitious, AGPL-licensed chess platform targeting feature parity with
Lichess and Chess.com, plus a first-class AI layer. This repository is built
**milestone by milestone**, and every milestone ships real, tested, typed code —
no skeletons, no placeholders.

> **Status:** Milestones 1–9, M12 (security hardening), and M13
> (observability & SRE) are complete; M10 (social & learning), M11 (search),
> and M14 (deployment & scale) have delivered core packages and UI;
> current productionization and hardening work is tracked in M15 —
> a perft-verified, variant-aware chess rules engine (`@chess-platform/core`),
> an event-sourced game authority with clocks (`@chess-platform/game`), a
> real-time gateway with authoritative fanout, durable event log, and Redis
> pub/sub (`@chess-platform/realtime-gateway`), a durable Postgres data layer
> (`@chess-platform/persistence`), a stateless REST + identity service with a
> published OpenAPI spec (`@chess-platform/api`), a provider-agnostic engine
> bridge (`@chess-platform/engine`), a playable web frontend with Playwright
> full-game e2e + Lighthouse a11y gates (`@chess-platform/web`), an AI
> orchestration layer (`@chess-platform/ai-orchestrator`), AI features
> including coaching, move explanations, puzzle generation, opening exploration,
> endgame training, and tournament commentary (`@chess-platform/ai-features`), a
> tournament system with round-robin, Swiss, and Arena formats plus live broadcast
> (`@chess-platform/tournament`), and a deployable stack: one-command
> `docker compose up` plus a Helm chart validated in CI.
> See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what is built vs. planned.

## Why "milestone by milestone" and not "all at once"

A platform of this scope (Lichess is ~15 years of work by many contributors) is
not something any single automated pass can produce as production-ready code.
Anything that claims to would be handing you thousands of placeholder files.
Instead we build a correct foundation first and grow it in vertical slices, each
one merged only after it is tested and reviewed.

## Repository layout (monorepo)

```
chess-platform/
├── packages/
│   ├── chess-core/         # ✅ Rules engine: legal moves, variants, FEN, SAN, perft
│   ├── game/               # ✅ Event-sourced game authority: clocks, commands, replay
│   ├── realtime-gateway/   # ✅ WebSocket rooms, presence, authoritative fanout, resume
│   ├── persistence/        # ✅ Durable data: event store, migrations, repositories, Glicko-2
│   ├── api/                # ✅ Stateless REST + identity service, published OpenAPI 3.1
│   ├── engine/             # ✅ UCI engine bridge & analysis orchestrator: Stockfish/Fairy-Stockfish, pools, scheduling
│   ├── web/                # ✅ Web frontend: lobby, board UI, live game play, PWA, a11y
│   ├── e2e-harness/        # ✅ In-process backend harness for Playwright acceptance
│   ├── tournament/         # ✅ Round-robin, Swiss, and Arena tournament domain
│   ├── anti-cheat/         # ✅ Engine-correlation analysis (ACPL, T1/T3, per-player suspicion, cross-game aggregation, service orchestration)
│   ├── social/             # ✅ Follows, friends, blocks, and relationship rules
│   ├── messaging/          # ✅ Direct-conversation domain and repository port
│   ├── community/          # ✅ Teams, memberships, join requests, and forums
│   ├── achievements/       # ✅ Achievement catalogue, progress, and awarding rules
│   ├── studies/            # ✅ Collaborative studies, move trees, and PGN import/export
│   ├── learning/           # ✅ Courses, lessons, steps, and progress
│   ├── search/             # ✅ Keyword, semantic, and hybrid search domain
│   ├── ai-orchestrator/    # ✅ AI provider routing, failover, caching, grounding
│   └── ai-features/        # ✅ AI capabilities: coach, puzzles, explanations, commentator, opening & endgame study
├── docs/
│   ├── ARCHITECTURE.md     # Full system design (services, data, real-time, AI, security)
│   ├── DATABASE.md         # Approved database architecture (M4 gate)
│   ├── PROJECT_STATE.md    # Living engineering handover — read this to continue
│   └── ROADMAP.md          # Milestone plan with acceptance criteria
├── .github/workflows/      # CI: build + typecheck + test every package
└── README.md
```

`services/gateway` is the deployable realtime-gateway binary with its
production adapters (Postgres event log, Redis pub/sub, `ws`). Deployment
assets live under `deploy/`; see the roadmap for remaining infrastructure work.

For a fresh clone, follow the [host build and test setup](docs/RUNNING.md#host-build-tests-and-live-counts).
It covers the root workspace build and the separate gateway dependency install required by
`npm run test:counts`.

## `@chess-platform/core`

A dependency-free, fully-typed chess engine.

- Legal move generation for **standard, Chess960, King of the Hill, Atomic,
  Crazyhouse, Three-Check, Horde, and Racing Kings**.
- FEN parse/serialize (incl. Crazyhouse pockets), UCI + SAN, check / checkmate /
  stalemate / draw detection, and variant win conditions.
- Immutable `Position` API — playing a move returns a new position.
- **Move-generation correctness validated by `perft`** test suites against published reference node
  counts for standard chess (start position, Kiwipete, edge cases), Chess960,
  and supported variants.

### Quick start

```ts
import { Position } from '@chess-platform/core';

let pos = Position.initial();                 // standard start
pos = pos.play('e2e4').play('e7e5');          // UCI
console.log(pos.fen());
console.log(pos.legalMoves().map((m) => pos.toSan(m)));
console.log(pos.status());                     // { over: false }

const atomic = Position.initial('atomic');
const koth = Position.initial('kingofthehill');
```

### Build & test

```bash
cd packages/chess-core
npm install
npm run build      # tsc → dist/
npm test           # compiles tests, runs perft + rules suites via node --test
```

The package suite covers reference perft positions plus castling, en passant,
promotions, pins, discovered checks, and variant rules. Run the commands above
for the current result.

## `@chess-platform/game`

An event-sourced game authority built on the core engine. A game is an
append-only sequence of events; state is a pure fold, so any game reconstructs
exactly from its log.

```ts
import { Game } from '@chess-platform/game';

let { game } = Game.create({
  gameId: 'g1',
  timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
  players: { white: 'alice', black: 'bob' },
  rated: true,
  at: Date.now(),
});

({ game } = game.playMove('e2e4', Date.now()));
({ game } = game.playMove('e7e5', Date.now()));
console.log(game.status);      // { over: false }
console.log(game.snapshot().clock.remaining);

// Reconstruct from the durable event log:
const rebuilt = Game.fromEvents(eventLog);
```

- Server-authoritative legality (clients never decide results).
- Clocks: Fischer increment, Bronstein/US delay, sudden-death, unlimited.
- Commands: move, resign, draw offer/accept/decline, flag claim, abort.
- The package suite verifies exact event-log reconstruction and deterministic
  replay behavior.

```bash
cd packages/game && npm install && npm run build && npm test
```

## `@chess-platform/realtime-gateway`

The real-time edge: it binds client connections to game rooms and the Game
Authority, and speaks a small, server-authoritative wire protocol. Built on
`@chess-platform/game`; dependency-free, with WebSocket and Redis bindings as
documented adapter seams (`transport.ts`, `pubsub.ts`).

- **Server is the authority.** A client sends an *intended* move with a
  monotonic `clientSeq`; the gateway validates it via the engine and either
  broadcasts the applied move or returns a `reject` referencing that `clientSeq`
  so the client rolls back its optimistic render.
- **Rooms, presence, and fanout.** Players and spectators join a game room;
  authoritative moves fan out to everyone. Cross-node fanout goes through a
  `PubSub` interface (in-memory for tests/dev, Redis in production).
- **Race-free authority.** Commands are serialized **per game**, so concurrent
  intents can never interleave into a corrupt state.
- **Reconnect/resume.** A reconnecting client rejoins (seat + current state
  restored) and asks for every move it missed since `lastPly`.
- **Latency compensation.** `ping`/`pong` carry a server timestamp; clocks stay
  authoritative on the server and clients interpolate locally.
- The package suite includes reconnection integration coverage and an
  in-process fanout benchmark validating algorithmic scaling (**p99 < 50ms**
  broadcast across 5,000 active subscribers with 50,000 idle connections
  registered in memory).

```ts
import {
  GameAuthority, RealtimeGateway, InMemoryPubSub, InMemoryConnection,
  type TokenVerifier,
} from '@chess-platform/realtime-gateway';

const pubsub = new InMemoryPubSub();
const authority = new GameAuthority(pubsub);
const tokenVerifier: TokenVerifier = {
  verify: async (token) => (token === 'token-alice' ? 'alice' : null),
};
const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier);

await authority.createGame({
  gameId: 'g1',
  timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
  players: { white: 'alice', black: 'bob' },
  rated: true,
});

const conn = new InMemoryConnection();       // a `ws` socket in production
gateway.handleConnection(conn);
conn.deliver({ t: 'join', gameId: 'g1', token: 'token-alice' });
conn.deliver({ t: 'move', gameId: 'g1', uci: 'e2e4', clientSeq: 1 });
```

```bash
cd packages/realtime-gateway && npm install && npm run build && npm test
```

> Note: connections now authenticate via token-based auth through a
> `TokenVerifier`; the gateway validates a `token` on join rather than trusting
> a raw `userId` from the upstream. Full session/passkey/RBAC flows remain with
> the API/identity service (`@chess-platform/api`).

## `@chess-platform/persistence`

The durable data layer. An append-only event store makes the M3 game authority
persistable and exactly reconstructable via `Game.fromEvents`, alongside the
relational projections and identity tables.

- **Event store as a seam:** `InMemoryEventStore` (dependency-free) +
  `PostgresEventStore` (append-only, optimistic concurrency on `(game_id, seq)`,
  `event_version` + upcaster path). The `pg` driver is isolated behind the
  `@chess-platform/persistence/pg` subpath.
- **Schema & migrations:** event log, identity/RBAC, Glicko-2 ratings, seeks,
  games projection, and an observability-rich audit log; lookup tables + CHECK
  (not native ENUM). Forward-only, checksum-verified migration runner + CLI.
- **UUIDv7** (time-ordered ids) and a **Glicko-2** implementation verified against
  Glickman's worked example.
- Postgres integration coverage is gated on `DATABASE_URL`; the play → store →
  `Game.fromEvents` round-trip is verified.

```bash
cd packages/persistence && npm install && npm run build && npm test
```

## `@chess-platform/api`

The stateless REST + identity service, built on Node's `http` module with a
typed router and dependency injection — no web framework, no third-party runtime
dependency at the root entry.

- **Identity & security:** a `PasswordHasher` abstraction with a built-in **scrypt**
  default (argon2id/KMS are drop-in replacements — the stored hash is self-describing),
  stateless **HMAC-SHA256 access tokens**, **opaque single-use refresh tokens** with
  rotation and reuse detection, **WebAuthn passkeys**, session visibility and
  revocation, password reset, and email verification.
- **RBAC** (`user`/`coach`/`tournament_director`/`moderator`/`admin`) enforced
  declaratively per route.
- **Resources:** identity and sessions, profiles and ratings, seeks and games,
  tournaments, search, social/community features, studies, and learning.
- **Published OpenAPI 3.1** generated from the live route table (served at
  `/v1/openapi.json`, committed to `packages/api/openapi.json`).
- The suite includes the M4 **authorization matrix**, route/OpenAPI coupling,
  and focused coverage for each optional subsystem.

```ts
import { createPgApiServer } from '@chess-platform/api/pg';
const { server } = createPgApiServer();     // needs ACCESS_TOKEN_SECRET + DATABASE_URL
await server.listen(8080);
```

```bash
cd packages/api && npm install && npm run build && npm test
```

See [`packages/api/README.md`](packages/api/README.md) for the canonical endpoint
contract and the in-memory (no-database) quick start.

## `@chess-platform/engine`

A provider-agnostic chess engine bridge and orchestrator that connects the UCI
protocol to the platform. It provides position evaluation, best-line analysis,
and bot play through a typed provider interface, routing requests across engine
pools for standard chess (Stockfish) and variants (Fairy-Stockfish).

- **Provider abstraction:** `AnalysisProvider` is the caller-facing contract,
  offering `analyze(request)` for position evaluation and multi-PV lines,
  `play(request)` for bot move selection with target strength, and
  `capabilitiesFor(variant)` for capability discovery.
- **Engine management & pools:** `EngineManager` routes across per-plugin
  `EnginePool` instances with priority scheduling (`JobPriority`: bot moves, live
  analysis, batch, background), circuit breakers, and worker health tracking.
- **Transport seams:** `EngineTransport` isolates process I/O —
  `FakeEngineTransport` for hermetic testing without native binaries, and
  `ChildProcessTransport` for managing native engine subprocesses.
- **Production composition:** `createEngineManager()` configures native engine
  processes from environment variables (`STOCKFISH_PATH`, `FAIRY_STOCKFISH_PATH`)
  with lazy worker warming.
- The package suite covers protocol handling, scheduling, failure isolation,
  cancellation, and capability routing. See
  [`packages/engine/README.md`](packages/engine/README.md) for detailed architecture.

```bash
cd packages/engine && npm install && npm run build && npm test
```

## `@chess-platform/web`

The web frontend for the platform — lobby, board UI, game play, and
analysis views. Built with a typed component layer and the realtime gateway
client.

- **Playable SPA:** lobby and game views, board rendering, realtime connection
  management, profiles, tournaments, search, social/community surfaces,
  learning/studies, passkeys, and password recovery.
- Unit, component, accessibility, and browser acceptance suites live with the
  package; run the commands below for the current result.

```bash
cd packages/web && npm install && npm run build && npm test
```

## License

AGPL-3.0-or-later, matching Lichess so server modifications stay open.
