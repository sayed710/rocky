# Gambit — Database Architecture

> **Status:** **APPROVED** (Milestone 4 gate). This is the contract the
> `persistence` package implements and the `api` package consumes. Revised after
> approval to incorporate five reviewer refinements (controlled-value modeling,
> event schema versioning, UUIDv7, richer audit log, richer session metadata) —
> see [`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md).

This document defines the durable data layer for Gambit: the storage engine, the
event store that makes the M3 game authority durable, the relational schema, the
migration strategy, the repository seams, concurrency/consistency rules, and the
testing approach. It refines and makes concrete the abbreviated model in
`docs/ARCHITECTURE.md` §5.

---

## 1. Goals & non-goals

**Goals**

1. Make games **durable and exactly reconstructable** from an append-only event
   log, so the M3 `GameAuthority` can persist, rehydrate, and resume any game via
   the existing `Game.fromEvents(...)` path — with **zero changes to the domain
   packages**.
2. Provide the relational foundation M4 needs: identity (argon2id + passkeys +
   sessions/refresh rotation), RBAC, users/profiles, seeks/lobby, **Glicko-2
   ratings per variant**, and leaderboards.
3. Keep the storage engine behind **narrow repository interfaces** so the domain
   and API never import a driver. This mirrors the existing `PubSub` / `Transport`
   seam pattern from M3.
4. Be correct first, then scalable: a schema that runs on a single Postgres today
   but partitions, shards, and adds read-replicas without a rewrite (target:
   millions of users, 100k+ concurrent connections).

**Non-goals (deferred, tracked)**

- GraphQL read models — **still a non-goal, and now deliberately so.** A read-only GraphQL layer
  shipped in M10 increment 8 (ADR-0073), but it added no read-model tables and no denormalized
  projections: resolvers read through the existing repositories, which is what keeps every
  visibility rule in one place instead of two. The only schema-adjacent addition is a batched
  lookup (`UsersRepository.findByIds`, `WHERE id = ANY($1::uuid[])`) over the existing `users`
  table, so the loader can resolve a list of players without one query per node.
- Search / pgvector embeddings — M11 (columns reserved, not populated).
- Kafka/NATS event streaming — M14. The event store here is the system of record;
  streaming is an optional downstream projection later.
- Multi-region active/active — post-M14.

---

## 2. Engine decision: PostgreSQL (single primary + read replicas)

**Decision:** PostgreSQL 16 is the primary system of record for **both** the game
event log and all relational projections.

**Reasoning**

- **One transactional boundary for events + projections.** When a game ends we
  must append the terminal event *and* update the `games` projection, ratings, and
  leaderboards. Postgres lets us do the event append and its projection update in
  a single ACID transaction, eliminating a whole class of "event stored but
  projection lost" bugs. A separate event-store product (e.g. EventStoreDB) would
  reintroduce cross-store consistency problems for no near-term benefit.
- **Append-only ordering is trivial and cheap.** A composite primary key
  `(game_id, seq)` gives per-game total ordering, gap/dup rejection, and clustered
  locality — exactly the access pattern (`load all events for one game, in order`)
  that `Game.fromEvents` needs.
- **Scales the way this workload scales.** Writes are dominated by move events,
  which are tiny and always scoped to one `game_id`; this partitions cleanly by
  time and shards cleanly by `game_id` hash later. Reads are dominated by "one
  game" and "one user's recent games", both index-friendly.
- **Operational maturity:** partitioning, logical replication, `LISTEN/NOTIFY`,
  strong JSONB, extensions (`pgcrypto`, later `pgvector`) — all first-party.

**Rejected alternatives**

- *MongoDB / document store:* weaker multi-document transactions historically, and
  we specifically want relational integrity for identity/ratings/RBAC.
- *A dedicated event-store DB alongside Postgres:* dual-write consistency burden.
- *SQLite:* fine for tests, not for the concurrency target.

**Caching (not the source of truth):** Redis (already assumed by M3 for pub/sub)
holds leaderboards (sorted sets) and hot session lookups; it is always rebuildable
from Postgres and is introduced where a measured hotspot justifies it, not
speculatively.

### 2.1 Primary keys: application-generated UUIDv7

**Decision:** all synthetic primary keys are **UUIDv7**, generated in the
`persistence` package (not the database), stored in native `UUID` columns.

- **Why UUIDv7 over random UUIDv4:** UUIDv7 is time-ordered (48-bit Unix-ms prefix
  + random tail). Time-ordered keys insert at the "right edge" of the B-tree, so we
  keep v4's collision-free client-side generation **and** get v2/bigserial-like
  index locality — far less page churn and WAL write amplification at high insert
  rates (games, events, sessions, audit rows). This directly serves the "millions
  of users" target.
- **Why generate in the app, not the DB:** Postgres 16 has no built-in `uuidv7()`
  (that lands in PG18). Generating IDs in `persistence` (a small, dependency-free
  helper, unit-tested for monotonicity and RFC-9562 layout) keeps IDs available
  *before* the insert (needed to correlate the `GameCreated` event's `gameId` with
  the `games` row), avoids a DB round-trip, and stays portable across shards.
- **Compatibility:** UUIDv7 is a standard UUID; columns stay `UUID`, and if we later
  adopt PG18's native `uuidv7()` the wire format is identical — no migration.
- **Exception:** `game_id` originates in the domain/authority (the caller supplies
  it when creating a game); `persistence` provides a UUIDv7 generator that callers
  use, but the store treats `game_id` as an opaque UUID it does not mint.

### 2.2 Controlled values: lookup tables + CHECK, not native ENUM

Several columns hold values from a fixed vocabulary (`variant`, `speed`, `result`,
`termination`, `role`, `kind`, `time_control.kind`). The reviewer asked us to stop
using unrestricted `TEXT`. We do — using **lookup tables** and **`CHECK`
constraints**, and *deliberately not* native Postgres `ENUM` types.

- **Why not native `ENUM`:** enums are compact but operationally awkward for an
  evolving product — `ALTER TYPE ... ADD VALUE` historically cannot run inside a
  transaction and cannot be reverted; values cannot be removed or reordered; and
  enum ordering is definition-order, not semantic. For a platform that will add
  variants and refine terminations over years, this rigidity is a liability.
- **Lookup tables** (a `code TEXT PRIMARY KEY` catalog + FK) for vocabularies that
  carry metadata: `variants` and `terminations`. The variants catalog also has a
  canonical-domain `CHECK`, so adding a variant is a coordinated application +
  constraint + seed migration, not an arbitrary catalog insert. This keeps FK
  enforcement and display metadata without allowing database/application drift.
- **`CHECK` constraints** for **small, fixed, security- or protocol-defined** sets
  where a whole table is overkort and the set changes only with a code+migration
  change anyway: `speed`, `result`, `role`, credential `kind`. A `CHECK` is easy to
  widen in a migration (`DROP`/`ADD CONSTRAINT`) without enum's transaction quirks.

The **event payload (JSONB) keeps the raw domain strings** verbatim (the
TypeScript union types in `@chess-platform/*` remain the source of truth); only the
relational **projection** columns are constrained by lookup/CHECK. This keeps the
immutable log faithful while making query-side columns safe.

---

## 3. The event store (the heart of M4)

### 3.1 Ordering model — `seq`, not `ply`

The domain's `GameEvent` union mixes move events (which carry a chess `ply`) with
non-move events (`GameCreated`, `PlayerReady`, `DrawOffered`, `DrawDeclined`, `GameEnded`, which
have **no** `ply`). Therefore the durable log is ordered by a **monotonic
per-game append sequence `seq`** (0-based), *not* by chess ply.

- `seq` is the storage ordering key and the optimistic-concurrency token.
- `ply` remains a pure chess concept and lives **inside the event payload** for
  `MovePlayed` events. It is never the storage key.
- Reconstruction is: `Game.fromEvents(rows ORDER BY seq ASC map(r => r.payload))`.
  This returns byte-identical state to the live authority (M2 already proves exact
  reconstruction from the in-order event array).

### 3.2 Table: `game_events` (append-only, system of record)

```sql
CREATE TABLE game_events (
  game_id        UUID        NOT NULL,
  seq            INTEGER     NOT NULL,           -- 0-based per-game append index
  type           TEXT        NOT NULL,           -- GameEvent discriminant
  event_version  SMALLINT    NOT NULL DEFAULT 1, -- payload schema version (see §3.4)
  payload        JSONB       NOT NULL,           -- the exact GameEvent object
  server_ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  xact_id        xid8        NOT NULL DEFAULT pg_current_xact_id(), -- writing transaction (0040, §4.2)
  PRIMARY KEY (game_id, seq),
  CONSTRAINT game_events_seq_nonneg CHECK (seq >= 0),
  CONSTRAINT game_events_version_pos CHECK (event_version >= 1)
);
-- Integrity guard: seq 0 must be a GameCreated event (enforced in the repository
-- and asserted by an integration test).
```

- **Append-only:** no `UPDATE`/`DELETE` in normal operation (enforced by a
  role-level revoke in production; a `BEFORE UPDATE/DELETE` trigger raises in all
  environments as defense in depth).
- **Optimistic concurrency = correctness.** An append supplies the `expected_seq`.
  Because `(game_id, seq)` is unique, two racing appends for the same `seq` → one
  wins, the other gets a unique-violation the repository surfaces as
  `ConcurrencyError`. This complements (does not replace) the authority's existing
  per-game command serialization; it makes correctness hold even across process
  restarts and multiple authority nodes.

### 3.3 `EventStore` repository interface

```ts
export interface StoredEvent {
  readonly gameId: string;
  readonly seq: number;
  readonly version: number;    // payload schema version (default 1)
  readonly event: GameEvent;   // typed from @chess-platform/game
  readonly serverTs: number;
}

export interface EventStore {
  /** Append events after `expectedSeq` (the caller's last known seq, -1 for a new
   *  game). Atomic: all-or-nothing. Throws ConcurrencyError on seq conflict. */
  append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number>; // returns new last seq
  /** Load the full ordered log for a game (for Game.fromEvents). */
  load(gameId: string): Promise<StoredEvent[]>;
  /** Load events with seq > afterSeq (resume / spectator catch-up). */
  loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** Whether any events exist for a game. */
  exists(gameId: string): Promise<boolean>;
}
```

- **Two implementations, one interface** (same pattern as M3's `InMemoryPubSub`):
  - `InMemoryEventStore` — deterministic, dependency-free; used by domain/unit
    tests and local dev.
  - `PostgresEventStore` — production, backed by `game_events` via `pg`.
- Events are appended at `event_version = 1` today; the write path accepts a
  version so a future migration can emit v2 payloads without touching v1 rows.
- **M3 integration (non-breaking):** `GameAuthority` gains an *optional*
  `EventStore` dependency. When present, `createGame`/`applyNow` also
  `append(...)`, and a new `loadGame(gameId)` rehydrates via
  `Game.fromEvents(store.load(...))`. When absent, behaviour is exactly today's
  in-memory path — so all 26 existing M3 tests keep passing unchanged. **This
  wiring is performed in the deployable service (M14);** M4 ships the store, its
  two implementations, and the round-trip acceptance test.

### 3.4 Event schema evolution (`event_version`)

Events are immutable once written, but their *shape* may need to evolve (e.g. a
future `MovePlayed` gains a field). We handle this without rewriting history:

1. Every row records the `event_version` its `payload` was written under.
2. On read, the repository routes each row through an **upcaster** keyed by
   `(type, event_version)` that maps an old payload to the current in-memory
   `GameEvent` shape. v1 → current is the identity today.
3. New writes always use the current version. Old rows are never mutated.

This keeps `Game.fromEvents` fed with current-shape events regardless of when a
game was recorded, and keeps upgrades backward-compatible and reversible.

---

## 4. Relational schema (projections + identity)

### 4.1 Lookup / catalog tables

```sql
CREATE TABLE variants (          -- closed application vocabulary, migration-evolved
  code        TEXT PRIMARY KEY,  -- 'standard','chess960','kingofthehill',...
  name        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT variants_code_check CHECK (code IN (
    'standard', 'chess960', 'kingofthehill', 'atomic',
    'crazyhouse', 'threecheck', 'horde', 'racingkings'
  ))
);
CREATE TABLE terminations (      -- evolving/annotated vocabulary
  code        TEXT PRIMARY KEY,  -- 'checkmate','resignation','timeout',...
  is_draw     BOOLEAN NOT NULL
);
-- Seeded by migration 0001 from the domain's Variant / Termination unions;
-- 0042 adds 'no_show' (a pregame no-show, never 'timeout' or 'aborted'; ADR-0148).
```

Small fixed sets use `CHECK` (see §2.2): `speed`, `result`, `role`, credential
`kind`, `time_control.kind`.

### 4.2 Games projection (derived from the event log; rebuildable)

```sql
CREATE TABLE games (
  id           UUID PRIMARY KEY,              -- UUIDv7, matches the event log's game_id
  variant      TEXT NOT NULL REFERENCES variants(code),
  rated        BOOLEAN NOT NULL,
  speed        TEXT NOT NULL
                 CHECK (speed IN ('ultrabullet','bullet','blitz','rapid','classical','correspondence')),
  white_id     UUID REFERENCES users(id),
  black_id     UUID REFERENCES users(id),
  result       TEXT CHECK (result IN ('1-0','0-1','1/2-1/2','*')),  -- NULL = ongoing
  termination  TEXT REFERENCES terminations(code),
  opening_eco  TEXT,
  ply_count    INTEGER NOT NULL DEFAULT 0,
  last_seq     INTEGER NOT NULL DEFAULT 0,     -- mirrors the event-store head
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ
) PARTITION BY RANGE (started_at);             -- monthly partitions
-- BRIN(started_at); btree(white_id), btree(black_id).
```

**How it is derived** (migration 0040, [ADR-0147](adr/0147-durable-games-projection.md)). Seek
acceptance and bot-game creation insert the creation-time row in the same transaction as
`GameCreated`. After that, and for every other creation path, only the event-log projector writes
the row. It re-folds each touched game's complete committed stream and upserts it
`WHERE games.last_seq <= EXCLUDED.last_seq`, so the row never regresses:

- **Work discovery.** `game_events.xact_id` records the writing transaction. A batch reads rows
  after the `projection_checkpoints` position whose `xact_id` is below
  `pg_snapshot_xmin(pg_current_snapshot())`, which means only finished transactions, ordered by
  `(xact_id, game_id, seq)` (index `game_events_xact_order_idx`, built online by 0041). A transaction that commits late
  sorts after the checkpoint, so it cannot be skipped. `server_ts` is never used as a cursor.
- **Atomicity.** One transaction per batch holds the checkpoint row `FOR UPDATE SKIP LOCKED`, so
  one replica works at a time, and it commits projection writes, failure records and the new
  position together.
- **Failures.** A stream that cannot be folded is rolled back to a per-game savepoint and recorded in
  `games_projection_failures (game_id, attempts, last_error, first_failed_at, retry_at)`, then
  retried with backoff until a re-fold succeeds. It never blocks other games and is never silently
  passed.
- **Rebuild.** `npm run games:rebuild` re-folds every stream independently of the checkpoint. It
  leaves to the live projector any game that projector has yet to reach, so live endings are still
  reported.
- **Pregame lifecycle** ([ADR-0148](adr/0148-pregame-readiness-and-no-show.md)). `PlayerReady`
  events advance `last_seq` but not `ply_count`, and a no-show `GameEnded` projects `result`,
  `termination = 'no_show'` and `ended_at` like any other ending.

### 4.2a Pending no-show deadlines (`0042_pregame_no_show.sql`, ADR-0148)

```sql
CREATE TABLE pregame_deadlines (
  game_id UUID        PRIMARY KEY,
  due_at  TIMESTAMPTZ NOT NULL                  -- GameCreated.at + GameCreated.noShowAfterMs
);
CREATE INDEX pregame_deadlines_due_idx ON pregame_deadlines (due_at, game_id);
```

A work queue, not a projection: the `pregame_deadlines_track` trigger on `game_events` inserts a row
when a creation carries a numeric `noShowAfterMs` and deletes it on the first move or any ending, in
the same transaction as the append. It therefore holds exactly the unstarted seek and tournament
games, whichever release wrote them, and cannot lag the log. The no-show worker scans it by
`due_at`, re-decides each game from the event log, and deletes a row the log shows will never
expire. A malformed deadline is skipped, never raised, so the trigger cannot reject an append.

### 4.3 Identity & authZ

```sql
users(id UUID PK,                              -- UUIDv7
      handle CITEXT UNIQUE, email_hash BYTEA, created_at TIMESTAMPTZ,
      country TEXT, flags JSONB DEFAULT '{}')
credentials(user_id UUID REF users, kind TEXT CHECK (kind IN ('password')),
      secret_hash TEXT,                        -- argon2id encoded string
      updated_at, PRIMARY KEY(user_id, kind))
webauthn_credentials(id BYTEA PK, user_id UUID REF users, public_key BYTEA,
      sign_count BIGINT, transports TEXT[], created_at, last_used_at)
sessions(id UUID PK,                           -- UUIDv7
      user_id UUID REF users, refresh_hash TEXT,
      created_at, expires_at, rotated_from UUID, revoked_at,
      -- account-security metadata (updated on each use):
      created_ip INET, created_user_agent TEXT,
      last_seen_at TIMESTAMPTZ, last_ip INET, last_user_agent TEXT)
roles(user_id UUID REF users,
      role TEXT CHECK (role IN ('user','coach','tournament_director','moderator','admin')),
      PRIMARY KEY(user_id, role))
ratings(user_id UUID REF users, variant TEXT REFERENCES variants(code),
      rating DOUBLE PRECISION, rd DOUBLE PRECISION, vol DOUBLE PRECISION,
      updated_at, PRIMARY KEY(user_id, variant))   -- Glicko-2
seeks(id UUID PK,                              -- UUIDv7
      creator_id UUID REF users, variant TEXT REFERENCES variants(code),
      time_control JSONB, rated BOOLEAN, min_rating INT, max_rating INT, created_at)
```

### 4.4 Audit log (observability-rich)

```sql
audit_log(
  id           UUID PRIMARY KEY,               -- UUIDv7 (time-ordered)
  actor_id     UUID,                           -- null for anonymous/system
  action       TEXT NOT NULL,
  target       TEXT,
  meta         JSONB NOT NULL DEFAULT '{}',
  -- request-correlation & forensics:
  request_id   TEXT,                           -- per-HTTP-request id (from the API gateway)
  trace_id     TEXT,                           -- OpenTelemetry trace id (links to M13 tracing)
  ip           INET,
  user_agent   TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- btree(actor_id, ts DESC); btree(request_id); btree(trace_id).
```

`request_id`/`trace_id` are populated from the API request context so an audit row
can be joined to logs/traces (M13 OpenTelemetry) for end-to-end debugging.

### 4.5 Anti-Cheat Reports

```sql
anti_cheat_reports(
  player_id  UUID NOT NULL,
  game_id    UUID NOT NULL,
  color      TEXT NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX anti_cheat_reports_player_created_idx ON anti_cheat_reports (player_id, created_at, game_id);
```

Analytical anti-cheat records store per-player engine-correlation reports. No foreign keys are attached to `player_id` or `game_id` so reports survive independently of user/game row lifecycles. Composite PK `(player_id, game_id)` indexes `player_id` as prefix for `listByPlayer` queries; the `(player_id, created_at, game_id)` index supports `listByPlayer`'s `ORDER BY created_at ASC, game_id ASC` — `game_id` is the tie-breaker so pagination is deterministic (records from one `saveBatch` share `created_at`, since `now()` is fixed per transaction).

### 4.6 Bot Detection Reports

```sql
bot_reports(
  player_id  UUID NOT NULL,
  game_id    UUID NOT NULL,
  color      TEXT NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX bot_reports_player_created_idx ON bot_reports (player_id, created_at, game_id);
```

Behavioral bot-detection records store per-player move-time reports (an engine-free signal orthogonal to `anti_cheat_reports`). Same no-FK rationale; the `(player_id, created_at, game_id)` index supports `listByPlayer`'s `ORDER BY created_at ASC, game_id ASC` — `game_id` is the tie-breaker so pagination is deterministic (records from one `saveBatch` share `created_at`, since `now()` is fixed per transaction).

### 4.7 Search Documents

```sql
search_documents(
  id     TEXT NOT NULL PRIMARY KEY,
  text   TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  tsv    tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);
CREATE INDEX search_documents_tsv_idx ON search_documents USING GIN (tsv);
CREATE INDEX search_documents_fields_idx ON search_documents USING GIN (fields);
```

Durable keyword search index supporting full-text search across arbitrary platform entities (games, players, tournaments, studies). `id` is text primary key (upsert target); `text` is raw indexed content; `fields` holds JSONB key-value metadata attributes (e.g. `variant`, `result`), stored lowercase-canonicalized so filters match case-insensitively; `tsv` is a stored generated tsvector column using the `'simple'` text search configuration. GIN indexes on `tsv` and `fields` support fast full-text matching (`tsv @@ tsquery`) and JSONB containment field filtering (`fields @> '{"k":"v"}'`).

### 4.8 Search Embeddings

```sql
CREATE EXTENSION IF NOT EXISTS vector;

search_embeddings(
  id        TEXT NOT NULL PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
  embedding vector(256) NOT NULL
);
CREATE INDEX search_embeddings_embedding_idx ON search_embeddings USING hnsw (embedding vector_cosine_ops);
```

Durable semantic search index supporting pgvector vector similarity and RRF hybrid search over platform entities (games, players, tournaments). `id` is primary key referencing `search_documents(id)` with `ON DELETE CASCADE`. `embedding` stores fixed 256-dimensional vector embeddings (`vector(256)`). The HNSW index on `embedding` using `vector_cosine_ops` supports cosine distance queries (`<=>`) for approximate nearest-neighbour retrieval. Note that `PgSemanticSearchRepository` does not currently hit this index: it keeps an `id` tie-break for deterministic pagination, which measurably forces a sort over a full scan instead. The index exists for the deferred ANN fast path — see ADR-0059 for the measurements and the reasoning.

### 4.9 Social Graph tables (`0015_social_graph.sql`, M10 inc 2)

```sql
CREATE TABLE social_follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT social_follows_not_self CHECK (follower_id <> followee_id)
);

CREATE TABLE social_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT social_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE TABLE social_friend_requests (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  CONSTRAINT social_friend_requests_not_self CHECK (requester_id <> addressee_id)
);
```

Stores directed follow edges, directed block edges, and directed friend requests with status transitions (`pending`, `accepted`, `declined`, `cancelled`, `ended`). `ON DELETE CASCADE` ensures foreign key cleanup when users are deleted. Partial unique indexes enforce one pending request per pair and one accepted request per pair. Collation for UUID columns uses standard Postgres byte-wise comparison matching code-point `compareIds` order.

### 4.10 Direct Messaging tables (`0016_messaging.sql`, M10 inc 3)

```sql
CREATE TABLE messaging_conversations (
  id              UUID        NOT NULL PRIMARY KEY,
  participant_a   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT messaging_conversations_not_self CHECK (participant_a <> participant_b)
);

CREATE UNIQUE INDEX messaging_conversations_pair_idx
  ON messaging_conversations (LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b));

CREATE TABLE messaging_messages (
  id              UUID        NOT NULL PRIMARY KEY,
  conversation_id UUID        NOT NULL REFERENCES messaging_conversations(id) ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE messaging_reads (
  conversation_id UUID        NOT NULL REFERENCES messaging_conversations(id) ON DELETE CASCADE,
  participant_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (conversation_id, participant_id)
);
```

Stores 1:1 direct conversations, direct messages (including `edited_at` and tombstone `deleted_at`), and per-participant monotonic read states. A partial-free unique index on `(LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b))` guarantees that exactly one conversation exists per player pair. `ON DELETE CASCADE` cleans up all conversation, message, and read records when users or conversations are deleted. Every referencing foreign key side is covered so cascading deletions do not scan these tables — but three of them are covered by the composite list indexes rather than by dedicated ones, since an index on `(a, b, c)` already serves a lookup on `a`; only `messaging_messages.sender_id` and `messaging_reads.participant_id` need an index of their own.

### 4.11 Teams, Communities & Team Forums tables (`0017_community.sql`, M10 inc 4)

```sql
CREATE TABLE community_teams (
  id          UUID        NOT NULL PRIMARY KEY,
  slug        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  visibility  TEXT        NOT NULL CHECK (visibility IN ('public', 'private')),
  created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX community_teams_slug_idx ON community_teams (slug);

CREATE TABLE community_memberships (
  id        UUID        NOT NULL PRIMARY KEY,
  team_id   UUID        NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
  player_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_memberships_team_player_key UNIQUE (team_id, player_id)
);

CREATE UNIQUE INDEX community_memberships_one_owner_per_team
  ON community_memberships (team_id) WHERE role = 'owner';

CREATE TABLE community_join_requests (
  id         UUID        NOT NULL PRIMARY KEY,
  team_id    UUID        NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
  player_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT        NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX community_join_requests_one_pending_per_player
  ON community_join_requests (team_id, player_id) WHERE status = 'pending';

CREATE INDEX community_join_requests_pending_by_player_idx
  ON community_join_requests (player_id, created_at DESC, id ASC)
  WHERE status = 'pending';

CREATE TABLE community_forum_threads (
  id           UUID        NOT NULL PRIMARY KEY,
  team_id      UUID        NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
  author_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  pinned       BOOLEAN     NOT NULL DEFAULT FALSE,
  locked       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  last_post_at TIMESTAMPTZ NOT NULL,
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE community_forum_posts (
  id         UUID        NOT NULL PRIMARY KEY,
  thread_id  UUID        NOT NULL REFERENCES community_forum_threads(id) ON DELETE CASCADE,
  author_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);
```

Stores teams, memberships, join requests, forum threads, and forum posts. Enforces single-owner invariant per team via partial unique index `community_memberships_one_owner_per_team` and at-most-one pending join request per player per team via `community_join_requests_one_pending_per_player`. Pending requester self-lists use the partial `(player_id, created_at DESC, id ASC)` index. All referencing FK columns are indexed to avoid full table scans on cascading user or team deletions.

### 4.18 Achievements (`achievement_progress` table, Migration 0018)

```sql
CREATE TABLE achievement_progress (
  player_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  progress        INTEGER NOT NULL CHECK (progress >= 0),
  unlocked_at     TIMESTAMPTZ,
  PRIMARY KEY (player_id, achievement_key)
);
```

Stores player achievement progress and unlock timestamps. A single `INSERT ... ON CONFLICT DO UPDATE` keeps progress monotonic and sets `unlocked_at` once, when `progress` first reaches the definition's target.

**No secondary index, deliberately.** The primary key `(player_id, achievement_key)` leads with `player_id`, so it already serves both the cascading delete and the only query this table has — `WHERE player_id = $1`. That query carries no `ORDER BY`: the catalogue lives in code rather than in rows, so a listing has to merge these rows with definitions the database has never seen, including achievements with no row at all. The merge and the ordering therefore happen in the adapter, and an ordering index here would never be consulted while still costing a write on every award.

### 4.19 Interactive Studies & PGN tables (`0019_studies.sql`, M10 inc 6)

```sql
CREATE TABLE studies (
  id          UUID        NOT NULL PRIMARY KEY,
  owner_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  visibility  TEXT        NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE study_collaborators (
  study_id   UUID        NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  player_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('owner', 'contributor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (study_id, player_id)
);

CREATE UNIQUE INDEX study_collaborators_one_owner_per_study
  ON study_collaborators (study_id) WHERE (role = 'owner');

CREATE TABLE study_chapters (
  id           UUID        NOT NULL PRIMARY KEY,
  study_id     UUID        NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  order_index  INTEGER     NOT NULL,
  starting_fen TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  deleted_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX study_chapters_study_id_order_index_idx
  ON study_chapters (study_id, order_index) WHERE (deleted_at IS NULL);

CREATE TABLE study_tree_nodes (
  id          UUID        NOT NULL PRIMARY KEY,
  chapter_id  UUID        NOT NULL REFERENCES study_chapters(id) ON DELETE CASCADE,
  parent_id   UUID        REFERENCES study_tree_nodes(id) ON DELETE CASCADE,
  san         TEXT        NOT NULL,
  fen_after   TEXT        NOT NULL,
  comment     TEXT,
  nags        INTEGER[]   NOT NULL DEFAULT '{}',
  order_index INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
```

Stores interactive studies, study collaborators, study chapters, and chapter move tree nodes. `studies` supports tombstones (`deleted_at`) and visibility levels (`public`, `unlisted`, `private`). `study_collaborators` uses partial unique index `study_collaborators_one_owner_per_study` to enforce single-ownership. `study_chapters` uses partial unique index `study_chapters_study_id_order_index_idx` for active chapter ordering. `study_tree_nodes` forms an adjacency-list move tree per chapter with parent-child cascade deletions (`parent_id REFERENCES study_tree_nodes(id) ON DELETE CASCADE`).

### 4.20 Structured Courses & Lessons Tables (M10 inc 7)

```sql
CREATE TABLE learning_courses (
  id          UUID        NOT NULL PRIMARY KEY,
  author_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  difficulty  TEXT        NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  published   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE learning_lessons (
  id          UUID        NOT NULL PRIMARY KEY,
  course_id   UUID        NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  order_index INTEGER     NOT NULL,
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE learning_steps (
  id            UUID        NOT NULL PRIMARY KEY,
  lesson_id     UUID        NOT NULL REFERENCES learning_lessons(id) ON DELETE CASCADE,
  order_index   INTEGER     NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('text', 'move', 'quiz')),
  prose         TEXT,
  fen           TEXT,
  expected_san  TEXT,
  hint          TEXT,
  question      TEXT,
  options       JSONB,
  correct_index INTEGER,
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE learning_progress (
  player_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    UUID        NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  lesson_id    UUID        NOT NULL REFERENCES learning_lessons(id) ON DELETE CASCADE,
  step_id      UUID        NOT NULL REFERENCES learning_steps(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, step_id)
);
```

Stores structured curriculum courses, lessons, interactive steps (text, move, quiz), and per-player progress history. Active course slugs are constrained by partial unique index `learning_courses_slug_idx WHERE deleted_at IS NULL`. Active lesson and step order indexes within their parent containers use partial unique indexes `WHERE deleted_at IS NULL`. Dedicated full indexes on foreign key columns (`author_id`, `course_id`, `lesson_id`, `step_id`) guarantee cascade deletion performance on tombstoned rows.

### 4.21 Durable engine analysis cache (`0026_engine_analysis_cache.sql`, ADR-0135)

```sql
CREATE TABLE engine_analysis_cache (
  fingerprint      TEXT        NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  variant          TEXT        NOT NULL CHECK (length(variant) BETWEEN 1 AND 64),
  multi_pv         INTEGER     NOT NULL CHECK (multi_pv >= 1),
  fen              TEXT        NOT NULL CHECK (length(fen) BETWEEN 1 AND 256),
  achieved_depth   INTEGER     CHECK (achieved_depth IS NULL OR achieved_depth >= 0),
  achieved_nodes   BIGINT      CHECK (achieved_nodes IS NULL OR achieved_nodes >= 0),
  achieved_time_ms BIGINT      CHECK (achieved_time_ms IS NULL OR achieved_time_ms >= 0),
  CHECK (num_nonnulls(achieved_depth, achieved_nodes, achieved_time_ms) >= 1),
  payload_version  INTEGER     NOT NULL CHECK (payload_version >= 1),
  results          JSONB       NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (fingerprint, variant, multi_pv, fen)
);
```

Durable backend for the engine's `AnalysisCache` port — the decision ADR-0002 deferred. **Not
composed by the API**: this phase ships the schema and adapter only.

The primary key is the whole of what makes two searches interchangeable (engine build fingerprint,
variant, MultiPV width, position), so a result can never be served for a different build, variant,
line count or position. FEN is stored verbatim; the platform defines no canonical FEN normalization
for cache identity, so two spellings of one position cache separately — a miss, never a wrong answer.

The `achieved_*` columns record what a search **reached**, not what it was asked for, and live
outside the JSON payload because they are the only basis on which a later request may be answered.
`NULL` means no stated bound was reached in that dimension and satisfies only a request that asks
nothing of it; a row stating no dimension at all could answer nothing and is refused. A read returns
a row only when it satisfies the request in **every** stated dimension.

Writes are a dominance-guarded upsert: an entry may only be replaced by one that could serve every
request the entry could serve, evaluated inside `ON CONFLICT DO UPDATE ... WHERE` under the row lock.
A shallower search finishing later therefore cannot destroy a deeper cached result, and concurrent
writers cannot both decide they are stronger. The payload version never excuses a write from that
comparison — a version 2 result at depth 5 does not replace a version 1 result at depth 30 — it only
gates the direction a dominating write may travel: an older version never replaces a newer, so a
rolling deploy cannot let a build that speaks an older payload contract destroy a row a newer build
can still read.

`results` is validated field-by-field on read; an unreadable or unknown-version payload is treated as
a cache miss and reported, never cast to a trusted type. The adapter fails open on every
infrastructure fault (a cache is an optimization and `EngineManager.analyze` calls it unguarded) and
reports each one through an injected hook.

#### Retention (`0027_engine_analysis_cache_retention.sql`, ADR-0138)

```sql
CREATE INDEX engine_analysis_cache_updated_at_idx ON engine_analysis_cache (updated_at);
```

The API composes this cache from ADR-0138 onward, so the table now has a retention policy. A row is
eligible once `updated_at < now() - ttl` (default 30 days, `ANALYSIS_CACHE_TTL_DAYS`, clamped to a
year). `updated_at` moves only on a dominating write, so the window measures age since the entry last
got **stronger**, not since it was last read: touching rows on read would make every cache hit a
row-locking write on the platform's hottest positions. A popular position therefore expires on
schedule, costs one recomputation, and is cached again for another window.

The engine fingerprint is the primary invalidator and the TTL is its backstop. An engine upgrade
changes the fingerprint, so every row from the old build becomes unreachable at once, is never
refreshed again, and ages out.

Cleanup is an hourly sweep from the API, deleting at most 500 rows per statement and 20 batches per
tick. The batch is chosen with `FOR UPDATE SKIP LOCKED`, which is what makes two replicas sweeping at
once claim disjoint batches, and what makes a row that a stronger write refreshes mid-statement get
re-checked against its committed version and survive. The index above is what keeps that scan from
reading the whole table; it is a plain transactional `CREATE INDEX` because the table was empty in
every deployment until this wiring landed.

The cache pool carries `statement_timeout = 250ms` and a matching connection-acquisition bound, so a
lookup that would hang becomes an absorbed fault and a cache miss rather than a stalled analysis.
Retention shares that bound; a swept batch that times out is rolled back and retried on the next
tick.





**Secrets never stored in plaintext:** passwords are argon2id **encoded strings**
(salt + params embedded); refresh tokens are stored only as hashes; `email_hash`
is a keyed hash (lookup without storing raw email). No credential is ever logged.

---

## 5. Migrations

- **Forward-only, numbered SQL files:** `persistence/migrations/NNNN_name.sql`,
  applied in order and transactionally by default. A strictly validated
  `migrate:online-index` directive permits one `CREATE INDEX CONCURRENTLY`
  statement for deployment-safe index additions.
- **Ledger table** `schema_migrations(version INT PK, name TEXT, applied_at,
  checksum TEXT, state TEXT)`; the runner refuses to run if a previously-applied
  file's checksum changed (immutability of history). Online index migrations are
  recorded as `pending` before execution, so a valid completed index is finalized
  after interruption and an invalid concurrent index is dropped and retried.
- **Canonical form.** A migration is read as UTF-8 text with LF newlines — the
  committed Git blob — and that canonical text is what gets hashed, parsed and
  executed. The repository has no `.gitattributes`, so the bytes on disk depend
  on each machine's `core.autocrlf`: one commit checks out with LF on Linux and
  CRLF on Windows. Canonicalizing at read time keeps the ledger checksum and the
  SQL sent to PostgreSQL properties of the migration rather than of the checkout,
  so a Windows working copy neither raises a false immutability error nor
  persists CR into a stored function body. Only the CRLF pair is rewritten:
  indentation, blank lines, a lone CR and a missing trailing newline are content,
  and changing any of them is still an integrity violation. Decoding is checked
  to round-trip, so a file that is not valid UTF-8 is rejected rather than having
  its malformed bytes silently folded into U+FFFD. A ledger written by
  the earlier runner on a Windows checkout holds the CRLF rendering; the runner
  accepts that one legacy form for otherwise-unchanged content and rewrites the
  row to the canonical checksum.
- **Runner** is a tiny dependency-light script (`npm run migrate`) usable in CI,
  local dev, and as a K8s init-container/Job later. No heavyweight ORM/migration
  framework — it hides SQL we want to own and review.
- **No ORM.** Hand-written SQL in typed repositories. Rationale: the schema is the
  product's crown jewels; an ORM obscures query plans and indexing, which matter
  at our scale. `pg` (node-postgres) is the only DB dependency.

---

## 6. Concurrency, consistency & scale

- **Per-game correctness:** optimistic append on `(game_id, seq)` (see §3.2).
- **Projections follow the log asynchronously:** creation-time `games` rows commit with
  `GameCreated`; progress and endings are projected by the checkpointed event-log projector
  (§4.2, ADR-0147), so a projection defect can never reject an authoritative append. Ratings are
  not yet derived.
- **Ratings** will be computed with the verified Glicko-2 implementation (unit-tested against
  the reference paper's worked example) from projected endings; not implemented yet.
- **Partitioning:** `games` and `game_events` by month on time; old partitions are
  cheap to archive to object storage (PGNs) later.
- **Sharding path (future, no rewrite):** `game_id` is a UUIDv7; a hash-shard
  router can place events on N Postgres shards keyed by `game_id` because no query
  spans multiple games. Identity stays on a primary cluster.
- **Read replicas** for analytics/leaderboard rebuilds; primary for writes only.

---

## 7. Testing strategy

- **Unit / domain:** `InMemoryEventStore` + pure logic (Glicko-2, UUIDv7 layout &
  monotonicity, upcasters) — dependency-free, run under `node --test` like every
  existing package.
- **Integration:** ephemeral **real Postgres** (Testcontainers, or a
  docker-compose service in CI) — never a mock — asserting: migrations apply
  cleanly and are idempotent; append/optimistic-concurrency semantics; lookup/CHECK
  enforcement; and the **round-trip acceptance test** from the roadmap: *events
  produced by playing a game → store → `Game.fromEvents` → state identical to the
  live game* (FEN, ply, clocks, SAN).
- **AuthZ matrix tests** for RBAC; **Glicko-2** verified against a reference vector.
- Integration tests **skip** (not fail) when no `DATABASE_URL` is present, so the
  dependency-free suites still run everywhere (incl. this sandbox and pre-DB CI).

---

## 8. Package boundaries (what M4 creates)

```
packages/
  persistence/          # NEW — durable data layer (this document)
    src/
      ids.ts             # UUIDv7 generator
      glicko2.ts         # Glicko-2 rating math
      event-store.ts     # EventStore interface + InMemoryEventStore + upcasters
      errors.ts          # ConcurrencyError, etc.
      pg/                # PostgresEventStore + pool + repositories + migrate runner
      repositories/      # users, sessions, ratings, games, seeks (interfaces + pg impls)
    migrations/*.sql
    test/
  api/                  # NEW — stateless REST service + OpenAPI (built after persistence)
```

`persistence` depends on `@chess-platform/game` (for the `GameEvent` type) and
`pg`. `api` depends on `persistence`, `@chess-platform/game`, and
`@chess-platform/core`. The domain packages depend on **neither** — the dependency
arrow always points toward the domain.

---

## 9. Resolved decisions (post-approval)

1. **Driver:** `pg` (node-postgres), hand-written SQL, no ORM. ✅
2. **Integration test infra:** Testcontainers-node (local + CI parity); tests skip
   without `DATABASE_URL`. ✅
3. **Event-store ordering key:** `seq` (append index) with `ply` in payload; plus
   `event_version` for schema evolution (§3.4). ✅
4. **IDs:** application-generated **UUIDv7** in native `UUID` columns (§2.1). ✅
5. **Controlled values:** lookup tables (`variants`, `terminations`) + `CHECK`
   constraints; **not** native ENUM (§2.2). ✅
6. **Audit log** carries `request_id`, `trace_id`, `ip`, `user_agent` (§4.4). ✅
7. **Sessions** carry `created_ip/user_agent` + `last_seen_at/last_ip/last_user_agent`
   (§4.3). ✅
8. Build order within M4: **`persistence` first**, then **`api`**. ✅

Rationale for the two places we refined a reviewer suggestion (native ENUM →
lookup+CHECK; DB-side → app-side UUIDv7) is recorded in
[`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md).
Implementation proceeds package-by-package with the same
"build → self-critique → multi-perspective review" method as M1–M3.
