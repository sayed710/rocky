-- Migration 0044 — explicit variant × speed rating pools and the exactly-once rating ledger (ADR-0150).
--
-- A rating belongs to one pool: a variant and one of the six speed classes `classifySpeed` produces.
-- Rows keyed by variant alone cannot be assigned to a pool without guessing, and the owner decided
-- they must be neither copied into every speed, guessed, nor deleted. No runtime path has ever written
-- `ratings`, so the table is expected to be empty; if it is not, stop and say what to do.
DO $$
DECLARE
  legacy BIGINT;
BEGIN
  SELECT count(*) INTO legacy FROM ratings;
  IF legacy > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate ratings to variant x speed pools: % legacy variant-only rating row(s) exist. They cannot be assigned to a speed without guessing, so explicit handling is required: export them, decide per row which pool (if any) each belongs to, empty the ratings table, re-run migrations, then restore the decided rows with their speed. See docs/adr/0150-durable-ratings.md.',
      legacy;
  END IF;
END $$;

ALTER TABLE ratings DROP CONSTRAINT ratings_pkey;
DROP INDEX ratings_leaderboard_idx;
ALTER TABLE ratings
  ADD COLUMN speed TEXT NOT NULL
    CHECK (speed IN ('ultrabullet','bullet','blitz','rapid','classical','correspondence')),
  ADD PRIMARY KEY (user_id, variant, speed),
  -- BETWEEN rejects NaN and ±Infinity, which DOUBLE PRECISION would otherwise store.
  ADD CONSTRAINT ratings_rating_sane CHECK (rating BETWEEN -10000 AND 10000),
  -- Glicko-2 can lift RD a fraction above its 350 start; 1000 still rejects anything non-finite.
  ADD CONSTRAINT ratings_rd_sane CHECK (rd > 0 AND rd <= 1000),
  ADD CONSTRAINT ratings_vol_sane CHECK (vol > 0 AND vol < 1);
CREATE INDEX ratings_leaderboard_idx ON ratings (variant, speed, rating DESC);

-- The single ordered position of the rating applier. Endings are applied in (xact_id, server_ts,
-- game_id) order of their GameEnded row, and only below pg_snapshot_xmin, so the prefix already
-- applied can never gain an earlier ending (ADR-0147's committed-prefix argument). The row lock
-- serializes appliers; the position advances in the same transaction as the ratings it covers.
CREATE TABLE rating_checkpoint (
  singleton  BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  xact_id    xid8        NOT NULL,
  server_ts  TIMESTAMPTZ NOT NULL,
  game_id    UUID        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rating_checkpoint (xact_id, server_ts, game_id)
VALUES ('0', '-infinity', '00000000-0000-0000-0000-000000000000');

-- One row per game whose result changed ratings, written in the same transaction as both players'
-- new ratings. The primary key is the exactly-once guard: no path can apply a game twice. Player ids
-- carry no foreign key, so the guard outlives an account deletion.
CREATE TABLE rating_applications (
  game_id              UUID             PRIMARY KEY,
  variant              TEXT             NOT NULL REFERENCES variants(code),
  speed                TEXT             NOT NULL
    CHECK (speed IN ('ultrabullet','bullet','blitz','rapid','classical','correspondence')),
  white_id             UUID             NOT NULL,
  black_id             UUID             NOT NULL,
  white_score          DOUBLE PRECISION NOT NULL CHECK (white_score IN (0, 0.5, 1)),
  white_rating_before  DOUBLE PRECISION NOT NULL,
  white_rating_after   DOUBLE PRECISION NOT NULL,
  black_rating_before  DOUBLE PRECISION NOT NULL,
  black_rating_after   DOUBLE PRECISION NOT NULL,
  applied_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CHECK (white_id <> black_id)
);

-- Endings whose stream could not be proven rateable (corrupt, or internally inconsistent). They are
-- never rated automatically: applying one later would put it out of order. An operator decides.
CREATE TABLE rating_blocked_games (
  game_id    UUID        PRIMARY KEY,
  error      TEXT        NOT NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
