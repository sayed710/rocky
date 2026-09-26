-- Migration 0040 — durable games projection work position (ADR-0147).
--
-- The projector must find every committed event exactly once, including an event whose transaction
-- commits after a later-started one. Neither server_ts nor seq orders commits globally, so each row
-- records the id of the transaction that wrote it. A reader that only consumes rows written by
-- transactions older than pg_snapshot_xmin(pg_current_snapshot()) can never pass a row that commits
-- later. The default fills the column for every existing writer, so no append path changes.
--
-- Adding a column with a volatile default rewrites game_events once; existing rows all receive this
-- migration's transaction id and are therefore replayed by the projector's first pass. The rewrite
-- does not fire the append-only row trigger.
ALTER TABLE game_events ADD COLUMN xact_id xid8 NOT NULL DEFAULT pg_current_xact_id();

-- The projector's scan index is built online by 0041, outside this rewrite's exclusive lock.

-- One row per projection. The row lock serializes projector replicas; the position advances in the
-- same transaction as the projection writes it covers.
CREATE TABLE projection_checkpoints (
  projection TEXT        PRIMARY KEY,
  xact_id    xid8        NOT NULL,
  game_id    UUID        NOT NULL,
  seq        INTEGER     NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO projection_checkpoints (projection, xact_id, game_id, seq)
VALUES ('games', '0', '00000000-0000-0000-0000-000000000000', -1);

-- Streams the projector could not fold. The checkpoint moves past their events only in the same
-- transaction that records them here, and a row stays until a later full re-fold succeeds.
CREATE TABLE games_projection_failures (
  game_id         UUID        PRIMARY KEY,
  attempts        INTEGER     NOT NULL CHECK (attempts > 0),
  last_error      TEXT        NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retry_at        TIMESTAMPTZ NOT NULL
);
