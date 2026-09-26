-- Migration 0042 — pregame no-show vocabulary and the pending-deadline queue (ADR-0148).
--
-- A pregame no-show is its own termination, never 'timeout' (a chess clock ran out) or 'aborted'
-- (a player aborted, which a tournament relaunches). The games projection (ADR-0147) writes it
-- from the durable GameEnded event.
INSERT INTO terminations (code, is_draw) VALUES ('no_show', false);

-- Games still waiting for their first move, with the instant their no-show deadline falls. Maintained
-- by the trigger below in the same transaction as every game_events insert, whichever code wrote it,
-- so it can neither lag the log nor miss a game created by a replica of another release. The no-show
-- worker scans it by due_at; it holds only unstarted sourced games, so it stays small.
CREATE TABLE pregame_deadlines (
  game_id UUID        PRIMARY KEY,
  due_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX pregame_deadlines_due_idx ON pregame_deadlines (due_at, game_id);

-- A creation the game aggregate would accept as sourced enters the queue: a known source and a
-- positive safe-integer deadline, the same rule `Game` applies on replay. The first move or any ending
-- leaves it. Anything else is skipped rather than raised, so this can never reject an append or
-- queue a row the worker could never settle. The checks are nested because SQL does not promise to
-- short-circuit AND, and a cast of a non-numeric value would raise.
CREATE FUNCTION pregame_deadlines_track() RETURNS trigger AS $$
DECLARE
  after_ms NUMERIC;
BEGIN
  IF NEW.seq = 0 THEN
    IF NEW.payload->>'source' IN ('seek', 'tournament')
       AND jsonb_typeof(NEW.payload->'noShowAfterMs') = 'number'
       AND jsonb_typeof(NEW.payload->'at') = 'number' THEN
      after_ms := (NEW.payload->>'noShowAfterMs')::numeric;
      IF after_ms > 0 AND after_ms = trunc(after_ms) AND after_ms <= 9007199254740991 THEN
        INSERT INTO pregame_deadlines (game_id, due_at)
        VALUES (NEW.game_id, to_timestamp(((NEW.payload->>'at')::numeric + after_ms) / 1000));
      END IF;
    END IF;
  ELSE
    DELETE FROM pregame_deadlines WHERE game_id = NEW.game_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pregame_deadlines_track
  AFTER INSERT ON game_events
  FOR EACH ROW
  WHEN (NEW.seq = 0 OR NEW.type = 'GameEnded' OR (NEW.type = 'MovePlayed' AND NEW.payload->>'ply' = '1'))
  EXECUTE FUNCTION pregame_deadlines_track();
