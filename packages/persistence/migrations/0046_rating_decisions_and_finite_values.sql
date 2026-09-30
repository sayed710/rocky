-- Preserve migration 0044's checksum. Upgrade its rating constraints and persist all rating decisions.
ALTER TABLE ratings
  DROP CONSTRAINT ratings_rating_sane,
  DROP CONSTRAINT ratings_rd_sane,
  DROP CONSTRAINT ratings_vol_sane,
  -- PostgreSQL orders NaN above Infinity. These strict comparisons reject both infinities and NaN.
  ADD CONSTRAINT ratings_rating_sane CHECK (rating > '-Infinity'::float8 AND rating < 'Infinity'::float8),
  ADD CONSTRAINT ratings_rd_sane CHECK (rd > 0 AND rd < 'Infinity'::float8),
  ADD CONSTRAINT ratings_vol_sane CHECK (vol > 0 AND vol < 'Infinity'::float8);

ALTER TABLE rating_blocked_games
  ADD COLUMN disposition TEXT CHECK (disposition = 'leave_blocked'),
  ADD COLUMN disposition_by TEXT,
  ADD COLUMN disposition_reason TEXT,
  ADD COLUMN disposition_at TIMESTAMPTZ,
  ADD CONSTRAINT rating_block_disposition_complete CHECK (
    (disposition IS NULL AND disposition_by IS NULL AND disposition_reason IS NULL AND disposition_at IS NULL)
    OR (disposition = 'leave_blocked' AND disposition_by IS NOT NULL
        AND disposition_reason IS NOT NULL AND length(trim(disposition_by)) > 0
        AND length(trim(disposition_reason)) > 0 AND disposition_at IS NOT NULL)
  );

-- A first-pass no-rating decision must survive replay. A changed bot flag or restored account
-- cannot retroactively insert an old game after later ratings.
CREATE TABLE rating_ineligible_games (
  game_id UUID PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('casual', 'no_result', 'not_human', 'bot_account', 'missing_account', 'pre_upgrade')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Application, block and no-rating decisions are mutually exclusive, including concurrent inserts.
-- Every insert path takes the same transaction-scoped lock before checking the other tables.
CREATE FUNCTION guard_rating_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.game_id::text, 0));
  IF TG_TABLE_NAME = 'rating_applications' THEN
    IF EXISTS (SELECT 1 FROM rating_blocked_games WHERE game_id = NEW.game_id) THEN
      RAISE EXCEPTION 'game % is permanently blocked from automatic rating', NEW.game_id;
    END IF;
    IF EXISTS (SELECT 1 FROM rating_ineligible_games WHERE game_id = NEW.game_id) THEN
      RAISE EXCEPTION 'game % is permanently ineligible for automatic rating', NEW.game_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'rating_blocked_games' THEN
    IF EXISTS (SELECT 1 FROM rating_applications WHERE game_id = NEW.game_id)
       OR EXISTS (SELECT 1 FROM rating_ineligible_games WHERE game_id = NEW.game_id) THEN
      RAISE EXCEPTION 'game % already has a rating decision', NEW.game_id;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM rating_applications WHERE game_id = NEW.game_id)
     OR EXISTS (SELECT 1 FROM rating_blocked_games WHERE game_id = NEW.game_id) THEN
    RAISE EXCEPTION 'game % already has a rating decision', NEW.game_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rating_application_disposition_guard
  BEFORE INSERT ON rating_applications FOR EACH ROW EXECUTE FUNCTION guard_rating_disposition();
CREATE TRIGGER rating_block_disposition_guard
  BEFORE INSERT ON rating_blocked_games FOR EACH ROW EXECUTE FUNCTION guard_rating_disposition();

-- Published 0044–0045 code acknowledged ineligible endings only by advancing the checkpoint.
-- Freeze those earlier decisions before any new applier can replay them with changed account flags.
-- The checkpoint lock waits for an in-flight old applier and holds it throughout this backfill.
SELECT 1 FROM rating_checkpoint FOR UPDATE;
INSERT INTO rating_ineligible_games (game_id, reason)
SELECT e.game_id, 'pre_upgrade'
FROM game_events e CROSS JOIN rating_checkpoint c
WHERE e.type = 'GameEnded'
  AND (e.xact_id, e.server_ts, e.game_id) <= (c.xact_id, c.server_ts, c.game_id)
  AND NOT EXISTS (SELECT 1 FROM rating_applications a WHERE a.game_id = e.game_id)
  AND NOT EXISTS (SELECT 1 FROM rating_blocked_games b WHERE b.game_id = e.game_id);

-- Guard this table only after the backfill. The trigger takes one advisory lock per inserted row, and a
-- lock per historical ending could exhaust max_locks_per_transaction. The backfill needs no guard: its
-- NOT EXISTS clauses exclude every other decision, and the held checkpoint lock keeps appliers out.
CREATE TRIGGER rating_ineligible_disposition_guard
  BEFORE INSERT ON rating_ineligible_games FOR EACH ROW EXECUTE FUNCTION guard_rating_disposition();

-- A gateway still running the 0044 code during a rolling deploy does not write explicit ineligible
-- decisions. Its checkpoint update closes that gap in the same transaction. New gateways already
-- wrote every decision; this indexed range insert then has nothing to add.
CREATE FUNCTION preserve_rating_decisions_on_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.xact_id, NEW.server_ts, NEW.game_id) > (OLD.xact_id, OLD.server_ts, OLD.game_id) THEN
    INSERT INTO rating_ineligible_games (game_id, reason)
    SELECT e.game_id, 'pre_upgrade'
    FROM game_events e
    WHERE e.type = 'GameEnded'
      AND (e.xact_id, e.server_ts, e.game_id) > (OLD.xact_id, OLD.server_ts, OLD.game_id)
      AND (e.xact_id, e.server_ts, e.game_id) <= (NEW.xact_id, NEW.server_ts, NEW.game_id)
      AND NOT EXISTS (SELECT 1 FROM rating_applications a WHERE a.game_id = e.game_id)
      AND NOT EXISTS (SELECT 1 FROM rating_blocked_games b WHERE b.game_id = e.game_id)
    ON CONFLICT (game_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rating_checkpoint_preserve_decisions
  AFTER UPDATE ON rating_checkpoint FOR EACH ROW EXECUTE FUNCTION preserve_rating_decisions_on_checkpoint();
