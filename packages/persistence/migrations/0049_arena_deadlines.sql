-- Durable projection of Arena work. Run before upgraded API/gateway writers.
-- One row per running Arena, including malformed legacy rows needing operator repair.
CREATE TABLE arena_deadlines (
  tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  deadline_ms BIGINT,
  pending_launch BOOLEAN NOT NULL,
  invalid BOOLEAN NOT NULL,
  CHECK (invalid OR deadline_ms IS NOT NULL)
);
CREATE INDEX arena_deadlines_due_idx ON arena_deadlines (deadline_ms, tournament_id)
  WHERE NOT invalid;
CREATE INDEX arena_deadlines_recovery_idx ON arena_deadlines (tournament_id)
  WHERE invalid OR pending_launch;

CREATE FUNCTION project_arena_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  start_ms NUMERIC;
  duration_ms NUMERIC;
  deadline NUMERIC;
  bad BOOLEAN := false;
  pending BOOLEAN := false;
BEGIN
  IF NEW.format <> 'arena' THEN
    DELETE FROM arena_deadlines WHERE tournament_id = NEW.id;
    RETURN NEW;
  END IF;
  -- Cast only proven JSON numbers. NUMERIC arithmetic avoids bigint overflow.
  IF (NEW.state <> 'registration' AND jsonb_typeof(NEW.snapshot->'startedAtMs') IS DISTINCT FROM 'number')
     OR (NEW.state = 'registration' AND NEW.snapshot ? 'startedAtMs')
     OR jsonb_typeof(NEW.snapshot->'config'->'durationMs') IS DISTINCT FROM 'number'
     OR NEW.snapshot->>'state' IS DISTINCT FROM NEW.state
     OR NEW.snapshot->'config'->>'id' IS DISTINCT FROM NEW.id
     OR NEW.snapshot->'config'->>'format' IS DISTINCT FROM 'arena'
     OR jsonb_typeof(NEW.snapshot->'activeGames') IS DISTINCT FROM 'object'
     OR jsonb_typeof(coalesce(NEW.snapshot->'gameLinks', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    bad := true;
  ELSE
    start_ms := coalesce((NEW.snapshot->>'startedAtMs')::numeric, 0);
    duration_ms := (NEW.snapshot->'config'->>'durationMs')::numeric;
    deadline := start_ms + duration_ms;
    bad := start_ms < 0 OR start_ms <> trunc(start_ms)
      OR duration_ms <= 0 OR duration_ms <> trunc(duration_ms)
      OR deadline > 9007199254740991;
    IF NEW.state <> 'running' AND NEW.snapshot->'activeGames' <> '{}'::jsonb THEN bad := true; END IF;
    IF NOT bad THEN
      pending := EXISTS (
        SELECT 1 FROM jsonb_object_keys(NEW.snapshot->'activeGames') AS pairing(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(NEW.snapshot->'gameLinks', '[]'::jsonb)) AS link(value)
          WHERE link.value->>0 = pairing.id));
    END IF;
  END IF;
  IF NOT bad AND NEW.state <> 'running' THEN
    DELETE FROM arena_deadlines WHERE tournament_id = NEW.id;
    RETURN NEW;
  END IF;
  INSERT INTO arena_deadlines (tournament_id, deadline_ms, pending_launch, invalid)
  VALUES (NEW.id, CASE WHEN bad THEN NULL ELSE deadline::bigint END, pending, bad)
  ON CONFLICT (tournament_id) DO UPDATE SET deadline_ms = EXCLUDED.deadline_ms,
    pending_launch = EXCLUDED.pending_launch, invalid = EXCLUDED.invalid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tournaments_arena_deadline AFTER INSERT OR UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION project_arena_deadline();
-- The migration framework owns the transaction. This takes the same row locks as
-- a writer, so the projection cannot miss a concurrent committed start.
UPDATE tournaments SET snapshot = snapshot WHERE format = 'arena';
