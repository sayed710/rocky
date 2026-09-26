-- Migration 0043 — the running-clock flag queue (ADR-0149).
--
-- Games whose chess clock is running after a first move, with the epoch millisecond at which the side
-- to move flags. Maintained by the trigger below in the same transaction as every game_events insert,
-- whichever code or release wrote it, so it can never lag the log: each move replaces the game's row
-- with the new side to move's deadline, and an ending removes it. The flag worker scans it by due_ms.
-- It holds only ongoing timed games that have a move, so it stays as small as the set of live games.
--
-- due_ms is an integer, not a timestamptz, so it is exact: a timestamp conversion rounds through
-- microseconds and could read back a millisecond early. `seq` is the MovePlayed that set the row, so
-- the worker can correct a deadline without overwriting one a newer move wrote.
CREATE TABLE flag_deadlines (
  game_id UUID    PRIMARY KEY,
  seq     INTEGER NOT NULL,
  due_ms  BIGINT  NOT NULL
);
CREATE INDEX flag_deadlines_due_idx ON flag_deadlines (due_ms, game_id);

-- The deadline a stored MovePlayed starts, computed as `Game.flagDeadline` / `flagDeadline()` in
-- packages/game/src/clock.ts does: the side to move is the mover's opponent, whose clock runs from
-- the move's `at` with the `remaining` the domain recorded for it (replay recomputes exactly that
-- value from `moveTimeMs`); it flags at `at + delay + remaining` (delay only for kind 'delay'), or at
-- `at` when nothing remains. The arithmetic is float8, the same IEEE operations in the same order as
-- JavaScript, and ceil gives the first whole millisecond at which `hasFlagged` holds. Unlimited
-- games get NULL. A value the domain would not produce degrades safely rather than raising: an
-- unusable remaining or delay falls back to `at`, a lower bound the worker corrects from the log, and
-- an unusable `at` or a result outside ECMAScript's Date range (±8.64e15 ms) gets NULL.

-- A JSON number as the float8 JSON.parse would give, or NULL for anything else. The checks are
-- nested because SQL does not promise to short-circuit AND, and casting a non-numeric or
-- out-of-range value would raise, rolling back the append.
CREATE FUNCTION flag_deadline_number(value JSONB) RETURNS DOUBLE PRECISION AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN
    RETURN NULL;
  END IF;
  IF abs((value #>> '{}')::numeric) >= 1e300 THEN
    RETURN NULL;
  END IF;
  RETURN (value #>> '{}')::numeric::double precision;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION flag_deadline_ms(game UUID, move JSONB) RETURNS BIGINT AS $$
DECLARE
  tc JSONB;
  side TEXT;
  at_ms DOUBLE PRECISION;
  rem_ms DOUBLE PRECISION;
  delay_ms DOUBLE PRECISION := 0;
  due DOUBLE PRECISION;
BEGIN
  SELECT payload->'timeControl' INTO tc FROM game_events WHERE game_id = game AND seq = 0;
  IF tc IS NULL OR tc->>'kind' = 'unlimited' THEN
    RETURN NULL;
  END IF;
  at_ms := flag_deadline_number(move->'at');
  IF at_ms IS NULL THEN
    RETURN NULL;
  END IF;
  due := at_ms;
  side := CASE move->>'by' WHEN 'w' THEN 'b' WHEN 'b' THEN 'w' END;
  IF side IS NOT NULL THEN
    rem_ms := flag_deadline_number(move->'remaining'->side);
    IF tc->>'kind' = 'delay' THEN
      delay_ms := flag_deadline_number(tc->'delayMs');
    END IF;
    IF rem_ms IS NOT NULL AND delay_ms IS NOT NULL AND rem_ms > 0 THEN
      due := at_ms + delay_ms + rem_ms;
    END IF;
  END IF;
  due := ceil(due);
  IF due = 'NaN'::double precision OR abs(due) > 8640000000000000 THEN
    RETURN NULL;
  END IF;
  RETURN due::bigint;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION flag_deadlines_track() RETURNS trigger AS $$
DECLARE
  due BIGINT;
BEGIN
  IF NEW.type = 'MovePlayed' THEN
    due := flag_deadline_ms(NEW.game_id, NEW.payload);
    IF due IS NULL THEN
      DELETE FROM flag_deadlines WHERE game_id = NEW.game_id;
    ELSE
      INSERT INTO flag_deadlines (game_id, seq, due_ms) VALUES (NEW.game_id, NEW.seq, due)
      ON CONFLICT (game_id) DO UPDATE SET seq = EXCLUDED.seq, due_ms = EXCLUDED.due_ms;
    END IF;
  ELSE
    DELETE FROM flag_deadlines WHERE game_id = NEW.game_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flag_deadlines_track
  AFTER INSERT ON game_events
  FOR EACH ROW
  WHEN (NEW.type IN ('MovePlayed', 'GameEnded'))
  EXECUTE FUNCTION flag_deadlines_track();

-- Games already running when this migration commits: the latest move of every game with no ending.
-- CREATE TRIGGER above holds a lock that blocks concurrent appends until this transaction commits, so
-- no move can fall between the backfill and the trigger. A game whose deadline passed while nothing
-- watched it is due at once, which is the truth its log already states.
-- The deadline is computed once per game, so the lock is held no longer than it must be.
INSERT INTO flag_deadlines (game_id, seq, due_ms)
SELECT game_id, seq, due
FROM (
  SELECT latest.game_id, latest.seq, flag_deadline_ms(latest.game_id, latest.payload) AS due
  FROM (
    SELECT DISTINCT ON (game_id) game_id, seq, payload
    FROM game_events
    WHERE type = 'MovePlayed'
    ORDER BY game_id, seq DESC
  ) latest
  WHERE NOT EXISTS (SELECT 1 FROM game_events ended WHERE ended.game_id = latest.game_id AND ended.type = 'GameEnded')
) computed
WHERE due IS NOT NULL;
