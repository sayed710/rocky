-- Durable projection of Arena work. Run before upgraded API/gateway writers.
-- One row per running Arena, including malformed legacy rows needing operator repair.
CREATE TABLE arena_deadlines (
  tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  work_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
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
  participant JSONB;
  player_id TEXT;
  stats JSONB;
  field TEXT;
  count_value NUMERIC;
  active_pairing RECORD;
  sequence_text TEXT;
  sequence_value DOUBLE PRECISION;
  max_sequence DOUBLE PRECISION;
  white_player TEXT;
  black_player TEXT;
  active_players TEXT[] := ARRAY[]::TEXT[];
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
     OR jsonb_typeof(NEW.snapshot->'pairingSequence') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.snapshot->'participants') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.snapshot->'playerStates') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.snapshot->'withdrawn') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.snapshot->'playedAsWhite') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.snapshot->'playedAsBlack') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.snapshot->'lastOpponents') IS DISTINCT FROM 'object'
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
      -- Validate persisted participant state before it can hide behind a future
      -- deadline. Proven container types guard expansion and numeric casts.
      SELECT count(*) <> count(DISTINCT value) INTO bad
        FROM jsonb_array_elements(NEW.snapshot->'participants');
      FOR participant IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'participants') LOOP
        EXIT WHEN bad;
        IF jsonb_typeof(participant) IS DISTINCT FROM 'string' THEN bad := true; EXIT; END IF;
        player_id := participant #>> '{}';
        stats := NEW.snapshot->'playerStates'->player_id;
        IF jsonb_typeof(stats) IS DISTINCT FROM 'object'
           OR jsonb_typeof(stats->'onFire') IS DISTINCT FROM 'boolean' THEN bad := true; EXIT; END IF;
        FOREACH field IN ARRAY ARRAY['points','wins','draws','losses','consecutiveWins','gamesPlayed'] LOOP
          IF jsonb_typeof(stats->field) IS DISTINCT FROM 'number' THEN bad := true; EXIT; END IF;
          count_value := (stats->>field)::numeric;
          IF count_value < 0 OR count_value > 9007199254740991 OR count_value <> trunc(count_value) THEN bad := true; EXIT; END IF;
        END LOOP;
        EXIT WHEN bad;
        IF (stats->>'gamesPlayed')::numeric <> (stats->>'wins')::numeric + (stats->>'draws')::numeric + (stats->>'losses')::numeric THEN bad := true; EXIT; END IF;
        FOREACH field IN ARRAY ARRAY['playedAsWhite','playedAsBlack'] LOOP
          IF jsonb_typeof(NEW.snapshot->field->player_id) IS DISTINCT FROM 'number' THEN bad := true; EXIT; END IF;
          count_value := (NEW.snapshot->field->>player_id)::numeric;
          IF count_value < 0 OR count_value > 9007199254740991 OR count_value <> trunc(count_value) THEN bad := true; EXIT; END IF;
        END LOOP;
      END LOOP;
      IF NOT bad THEN
        bad := EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'withdrawn') AS withdrawn(value)
          WHERE NOT (NEW.snapshot->'participants' @> jsonb_build_array(withdrawn.value)));
      END IF;
    END IF;
    IF NOT bad THEN
      -- Match restoration's safe JS-number sequence comparisons. Deadline
      -- arithmetic above remains NUMERIC. JSONB has already proven this number.
      BEGIN
        max_sequence := (NEW.snapshot->>'pairingSequence')::double precision;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        -- JS JSON parsing rounds tiny magnitudes to zero; PostgreSQL reports
        -- underflow. Overflow cannot be a safe integer.
        IF abs((NEW.snapshot->>'pairingSequence')::numeric) < 1 THEN max_sequence := 0;
        ELSE bad := true; END IF;
      END;
      IF NOT bad THEN
        bad := max_sequence < 0 OR max_sequence > 9007199254740991 OR max_sequence <> trunc(max_sequence);
      END IF;
      FOR active_pairing IN SELECT key, value FROM jsonb_each(NEW.snapshot->'activeGames') LOOP
        EXIT WHEN bad;
        IF left(active_pairing.key, 2) <> 'a:' OR jsonb_typeof(active_pairing.value) IS DISTINCT FROM 'object'
           OR jsonb_typeof(active_pairing.value->'white') IS DISTINCT FROM 'string'
           OR jsonb_typeof(active_pairing.value->'black') IS DISTINCT FROM 'string'
           OR (active_pairing.value ? 'launchNamespace' AND active_pairing.value->'launchNamespace' IS DISTINCT FROM '"committed-v1"'::jsonb) THEN
          bad := true; EXIT;
        END IF;
        -- Number(id.slice(2)) accepts decimal/exponent and unsigned base-prefixed
        -- spellings. Do not impose a new canonical-ID policy. Trim ECMAScript
        -- whitespace explicitly, then prove syntax before guarded conversions.
        sequence_text := btrim(substr(active_pairing.key, 3), U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
        IF sequence_text !~ '^([+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$' THEN bad := true; EXIT; END IF;
        BEGIN
          IF sequence_text ~ '^0[xXoObB]' THEN sequence_value := sequence_text::numeric::double precision;
          ELSE sequence_value := sequence_text::double precision; END IF;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          bad := true;
        END;
        EXIT WHEN bad;
        IF sequence_value <= 0 OR sequence_value > 9007199254740991
           OR sequence_value <> trunc(sequence_value) OR sequence_value > max_sequence THEN bad := true; EXIT; END IF;
        white_player := active_pairing.value->>'white'; black_player := active_pairing.value->>'black';
        IF white_player = black_player
           OR NOT (NEW.snapshot->'participants' @> jsonb_build_array(white_player))
           OR NOT (NEW.snapshot->'participants' @> jsonb_build_array(black_player))
           OR white_player = ANY(active_players) OR black_player = ANY(active_players) THEN bad := true; EXIT; END IF;
        active_players := active_players || ARRAY[white_player, black_player];
      END LOOP;
    END IF;
    IF NOT bad THEN
      -- A malformed/duplicate/foreign tuple cannot suppress pending recovery.
      -- CASE guards array operations; SQL predicate evaluation order is not assumed.
      bad := EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(NEW.snapshot->'gameLinks', '[]'::jsonb)) AS link(value)
        WHERE CASE
          WHEN jsonb_typeof(link.value) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(link.value) <> 2 THEN true
          ELSE jsonb_typeof(link.value->0) IS DISTINCT FROM 'string'
            OR jsonb_typeof(link.value->1) IS DISTINCT FROM 'string'
            OR NOT (NEW.snapshot->'activeGames' ? (link.value->>0)) END);
      IF NOT bad THEN
        SELECT count(*) <> count(DISTINCT link.value->>0)
          OR count(*) <> count(DISTINCT link.value->>1) INTO bad
          FROM jsonb_array_elements(coalesce(NEW.snapshot->'gameLinks', '[]'::jsonb)) AS link(value);
      END IF;
    END IF;
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
