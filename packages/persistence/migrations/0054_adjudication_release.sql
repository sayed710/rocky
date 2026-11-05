-- Migration 0054 — release of a managed stop (Issue #124; unwired, extends 0053).
--
-- 0053 refused every AdjudicationClocksStarted. This adds a RELEASE permit: the store inserts one
-- row naming the current stop, the exact release event and its position, and the deadlines the
-- domain computes once the clocks run again; the event guard admits that event alone, in that
-- transaction, and the same insert ends the stop. A managed observed-release game then refuses any
-- other unpermitted event until it ends, and the deferred validator checks every release.
--
-- Run before prepareAdjudicationGuard (or re-run it after): CREATE OR REPLACE needs the routines
-- still owned by the migration role. All routines keep search_path = pg_catalog, pg_temp.

CREATE TABLE public.game_adjudication_releases (
  game_id            UUID        NOT NULL,
  release_request_id TEXT        NOT NULL CHECK (length(release_request_id) BETWEEN 1 AND 200),
  stop_operation_id  UUID        NOT NULL,
  release_seq        INTEGER     NOT NULL CHECK (release_seq > 0),
  event_payload      JSONB       NOT NULL,
  flag_due_ms        BIGINT,
  pregame_due_ms     BIGINT      CHECK (pregame_due_ms IS NULL OR (pregame_due_ms >= 0 AND pregame_due_ms <= 8640000000000000)),
  permit_xact_id     xid8        NOT NULL DEFAULT pg_current_xact_id(),
  consumed           BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (game_id, release_request_id),
  CONSTRAINT game_adjudication_releases_one_per_stop UNIQUE (game_id, stop_operation_id),
  CONSTRAINT game_adjudication_releases_seq_uniq UNIQUE (game_id, release_seq),
  CONSTRAINT game_adjudication_releases_stop_fk FOREIGN KEY (game_id, stop_operation_id)
    REFERENCES public.game_adjudications (game_id, operation_id)
);
REVOKE ALL ON public.game_adjudication_releases FROM PUBLIC;

-- A permit is created for the current stop at the next position in its own transaction, can only
-- be consumed by that transaction, and is never deleted or otherwise changed.
CREATE FUNCTION public.game_adjudication_releases_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  head INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA30', MESSAGE = 'game_adjudication_releases rows cannot be deleted';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0::bigint));
  PERFORM public.adjudication_mark_changed(NEW.game_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA41', MESSAGE = 'A RELEASE permit starts unconsumed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_adjudications
                   WHERE game_id = NEW.game_id AND operation_id = NEW.stop_operation_id
                     AND execution_state = 'completed' AND is_current_stop)
       OR EXISTS (SELECT 1 FROM public.game_adjudications WHERE game_id = NEW.game_id AND execution_state = 'proving') THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA42', MESSAGE = 'A release needs the current stop and no proving adjudication';
    END IF;
    SELECT max(seq) INTO head FROM public.game_events WHERE game_id = NEW.game_id;
    IF NEW.release_seq IS DISTINCT FROM head + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA43', MESSAGE = 'A release must be the next event of the stream';
    END IF;
    NEW.permit_xact_id := cur;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (OLD.game_id, OLD.release_request_id, OLD.stop_operation_id, OLD.release_seq, OLD.event_payload,
      OLD.flag_due_ms, OLD.pregame_due_ms, OLD.permit_xact_id, OLD.created_at)
     IS DISTINCT FROM
     (NEW.game_id, NEW.release_request_id, NEW.stop_operation_id, NEW.release_seq, NEW.event_payload,
      NEW.flag_due_ms, NEW.pregame_due_ms, NEW.permit_xact_id, NEW.created_at)
     OR (OLD.consumed AND NOT NEW.consumed)
     OR (NEW.consumed AND NOT OLD.consumed AND OLD.permit_xact_id <> cur) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA44', MESSAGE = 'A RELEASE permit is immutable except for its own consumption';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.game_adjudication_releases_row_guard() FROM PUBLIC;

CREATE TRIGGER game_adjudication_releases_row_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.game_adjudication_releases
  FOR EACH ROW EXECUTE FUNCTION public.game_adjudication_releases_row_guard();

CREATE TRIGGER game_adjudication_releases_no_truncate
  BEFORE TRUNCATE ON public.game_adjudication_releases
  FOR EACH STATEMENT EXECUTE FUNCTION public.game_adjudications_no_truncate();

CREATE CONSTRAINT TRIGGER adjudication_deferred_validator_releases
  AFTER INSERT OR UPDATE ON public.game_adjudication_releases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.adjudication_deferred_validator();

CREATE OR REPLACE FUNCTION public.game_events_adjudication_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  adj public.game_adjudications;
  rel public.game_adjudication_releases;
  expected JSONB;
BEGIN

  -- An append at an occupied position is a stale writer: let the primary key reject it with the
  -- same 23505 every existing caller already maps to its version conflict.
  IF EXISTS (SELECT 1 FROM public.game_events WHERE game_id = NEW.game_id AND seq = NEW.seq) THEN
    RETURN NEW;
  END IF;

  -- Legacy games take no new lock: the (game_id, seq) key already orders them against a concurrent
  -- Start, and the proving-row lock below waits for an in-flight settlement.
  IF EXISTS (SELECT 1 FROM public.game_adjudications WHERE game_id = NEW.game_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0));
    PERFORM public.adjudication_mark_changed(NEW.game_id);
  END IF;

  SELECT * INTO adj FROM public.game_adjudications
    WHERE game_id = NEW.game_id AND execution_state = 'proving' FOR UPDATE;
  IF FOUND THEN
    IF NEW.type = 'AdjudicationStarted' THEN
      IF adj.start_permit_consumed THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA03', MESSAGE = 'START permit already consumed';
      END IF;
      IF adj.start_permit_xact_id <> cur THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA04', MESSAGE = 'START permit belongs to another transaction';
      END IF;
      IF adj.started_seq <> NEW.seq OR adj.started_version <> NEW.event_version
         OR adj.started_payload <> NEW.payload THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA05', MESSAGE = 'Started envelope differs from its START permit';
      END IF;
      UPDATE public.game_adjudications SET start_permit_consumed = true
        WHERE game_id = adj.game_id AND operation_id = adj.operation_id;
      RETURN NEW;
    END IF;

    IF adj.settlement_permit_xact_id = cur THEN
      IF adj.settlement_permit_cursor >= jsonb_array_length(adj.settlement_permit_envelopes) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA06', MESSAGE = 'SETTLEMENT permit exhausted';
      END IF;
      IF NEW.seq <> adj.settlement_permit_start_seq + adj.settlement_permit_cursor THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA07', MESSAGE = 'SETTLEMENT permit sequence mismatch';
      END IF;
      expected := adj.settlement_permit_envelopes->adj.settlement_permit_cursor;
      IF expected->>'type' IS DISTINCT FROM NEW.type
         OR (expected->>'event_version')::smallint IS DISTINCT FROM NEW.event_version
         OR expected->'payload' IS DISTINCT FROM NEW.payload THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA08',
          MESSAGE = 'SETTLEMENT permit envelope mismatch at position ' || adj.settlement_permit_cursor;
      END IF;
      UPDATE public.game_adjudications SET settlement_permit_cursor = settlement_permit_cursor + 1
        WHERE game_id = adj.game_id AND operation_id = adj.operation_id;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PMA09', MESSAGE = 'Unpermitted event while adjudication is proving';
  END IF;

  -- A release is admitted only as the exact event of this transaction's RELEASE permit, at its
  -- position, and it ends the stop it releases.
  IF NEW.type = 'AdjudicationClocksStarted' THEN
    SELECT * INTO rel FROM public.game_adjudication_releases
      WHERE game_id = NEW.game_id AND NOT consumed FOR UPDATE;
    IF NOT FOUND OR rel.permit_xact_id <> cur THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA01', MESSAGE = 'AdjudicationClocksStarted requires a RELEASE permit';
    END IF;
    IF rel.release_seq <> NEW.seq OR NEW.event_version <> 1 OR rel.event_payload <> NEW.payload THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA15', MESSAGE = 'Release envelope differs from its RELEASE permit';
    END IF;
    UPDATE public.game_adjudication_releases SET consumed = true
      WHERE game_id = rel.game_id AND release_request_id = rel.release_request_id;
    UPDATE public.game_adjudications SET is_current_stop = false
      WHERE game_id = rel.game_id AND operation_id = rel.stop_operation_id AND is_current_stop;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA16', MESSAGE = 'The released stop is no longer current';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type = 'AdjudicationStarted' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA02', MESSAGE = 'AdjudicationStarted requires a START permit';
  END IF;
  IF NEW.type = 'AdjudicationResolved' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA12', MESSAGE = 'AdjudicationResolved requires a SETTLEMENT permit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.game_adjudications WHERE game_id = NEW.game_id AND is_current_stop) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA10', MESSAGE = 'Unpermitted event while the game is in a managed stop';
  END IF;
  IF EXISTS (SELECT 1 FROM public.game_adjudications
             WHERE game_id = NEW.game_id AND execution_state = 'completed' AND settlement_permit_xact_id = cur) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA13', MESSAGE = 'No event may follow a settlement in its own transaction';
  END IF;
  -- A managed observed-release game takes every command through adjudication until it ends.
  IF EXISTS (SELECT 1 FROM public.game_adjudications
             WHERE game_id = NEW.game_id AND clock_policy = 'observed-release-v1')
     AND NOT EXISTS (SELECT 1 FROM public.game_events WHERE game_id = NEW.game_id AND type = 'GameEnded') THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA14', MESSAGE = 'Unpermitted event on a managed game';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.adjudication_validate_game(game UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  adj public.game_adjudications;
  latest public.game_adjudications;
  has_latest BOOLEAN := false;
  proving_row public.game_adjudications;
  has_proving BOOLEAN := false;
  prev_final INTEGER := -1;
  head INTEGER;
  n INTEGER;
  i INTEGER;
  env JSONB;
  terminal BOOLEAN;
  stops INTEGER;
  lifecycle_events INTEGER;
  expected_lifecycle INTEGER := 0;
  first_resolved JSONB;
  expected_pregame TIMESTAMPTZ;
  expected_flag BIGINT;
  latest_move RECORD;
  settled_earlier BOOLEAN;
  rel public.game_adjudication_releases;
  stop_row public.game_adjudications;
  released BOOLEAN := false;
BEGIN
  SELECT max(seq) INTO head FROM public.game_events WHERE game_id = game;
  SELECT EXISTS (SELECT 1 FROM public.game_events WHERE game_id = game AND type = 'GameEnded') INTO terminal;

  FOR adj IN SELECT * FROM public.game_adjudications WHERE game_id = game ORDER BY started_seq LOOP
    IF adj.started_seq <= prev_final THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD17', MESSAGE = 'Adjudication operations overlap in the stream';
    END IF;
    -- A completed row from an earlier transaction was fully verified at its own COMMIT and is
    -- immutable since (row guard); only ordering, counts and stop rules are re-checked for it.
    settled_earlier := adj.execution_state = 'completed' AND adj.settlement_permit_xact_id <> cur;
    IF NOT settled_earlier AND (NOT adj.start_permit_consumed OR NOT EXISTS (
      SELECT 1 FROM public.game_events
      WHERE game_id = game AND seq = adj.started_seq AND type = 'AdjudicationStarted'
        AND event_version = adj.started_version AND payload = adj.started_payload)) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD03', MESSAGE = 'Adjudication without its exact Started event';
    END IF;
    expected_lifecycle := expected_lifecycle + 1;

    IF adj.execution_state = 'proving' THEN
      has_proving := true;
      proving_row := adj;
      IF adj.settlement_permit_xact_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD16', MESSAGE = 'A SETTLEMENT permit was opened but not completed';
      END IF;
      IF head <> adj.started_seq THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD04', MESSAGE = 'Events follow a proving Started event';
      END IF;
      IF EXISTS (SELECT 1 FROM public.pregame_deadlines WHERE game_id = game)
         OR EXISTS (SELECT 1 FROM public.flag_deadlines WHERE game_id = game) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD05', MESSAGE = 'Deadlines must be suppressed while proving';
      END IF;
      prev_final := adj.started_seq;
    ELSE
      n := jsonb_array_length(adj.settlement_batch);
      IF jsonb_typeof(adj.settlement_batch) <> 'array' OR n < 1
         OR adj.final_seq <> adj.started_seq + n
         OR adj.settlement_permit_start_seq <> adj.started_seq + 1
         OR adj.settlement_permit_end_seq <> adj.final_seq
         OR adj.settlement_permit_cursor <> n
         OR adj.settlement_permit_claim_id IS DISTINCT FROM adj.completed_claim_id
         OR adj.settlement_permit_generation IS DISTINCT FROM adj.completed_generation THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD07', MESSAGE = 'Completed adjudication permit and batch disagree';
      END IF;
      first_resolved := adj.settlement_batch->0;
      IF first_resolved->>'type' IS DISTINCT FROM 'AdjudicationResolved'
         OR first_resolved->>'operationId' IS DISTINCT FROM adj.operation_id::text
         OR first_resolved->>'gameId' IS DISTINCT FROM game::text
         OR (first_resolved->'startedSeq') IS DISTINCT FROM to_jsonb(adj.started_seq) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD18', MESSAGE = 'Settlement batch must open with its own AdjudicationResolved';
      END IF;
      IF adj.settlement_receipt->>'gameId' IS DISTINCT FROM game::text
         OR adj.settlement_receipt->>'operationId' IS DISTINCT FROM adj.operation_id::text
         OR (adj.settlement_receipt->'startedSeq') IS DISTINCT FROM to_jsonb(adj.started_seq)
         OR (adj.settlement_receipt->'finalSeq') IS DISTINCT FROM to_jsonb(adj.final_seq)
         OR (adj.settlement_receipt->'eventCount') IS DISTINCT FROM to_jsonb(n)
         OR (adj.settlement_receipt->'resolvedEvent') IS DISTINCT FROM first_resolved THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD15', MESSAGE = 'Completed adjudication receipt mismatch';
      END IF;
      SELECT count(*) INTO i FROM jsonb_array_elements(adj.settlement_batch) AS e
        WHERE e->>'type' IN ('AdjudicationStarted', 'AdjudicationResolved');
      expected_lifecycle := expected_lifecycle + i;
      FOR i IN 0..(CASE WHEN settled_earlier THEN -1 ELSE n - 1 END) LOOP
        env := adj.settlement_permit_envelopes->i;
        IF (env->'payload') IS DISTINCT FROM (adj.settlement_batch->i) OR NOT EXISTS (
          SELECT 1 FROM public.game_events
          WHERE game_id = game AND seq = adj.started_seq + 1 + i
            AND type = adj.settlement_batch->i->>'type'
            AND event_version = (env->>'event_version')::smallint
            AND payload = adj.settlement_batch->i) THEN
          RAISE EXCEPTION USING ERRCODE = 'PMD14',
            MESSAGE = 'Completed adjudication suffix differs at seq ' || (adj.started_seq + 1 + i);
        END IF;
      END LOOP;
      IF adj.is_current_stop AND (adj.clock_policy IS DISTINCT FROM 'observed-release-v1'
         OR first_resolved->'clockCompletion'->>'kind' IS DISTINCT FROM 'stopped') THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD19', MESSAGE = 'Only a stopped observed-release completion can be a current stop';
      END IF;
      prev_final := adj.final_seq;
      latest := adj;
      has_latest := true;
    END IF;
  END LOOP;

  IF has_proving AND proving_row.started_seq < prev_final THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD17', MESSAGE = 'A proving operation precedes a completed one';
  END IF;

  SELECT count(*) INTO lifecycle_events FROM public.game_events
    WHERE game_id = game AND type IN ('AdjudicationStarted', 'AdjudicationResolved');
  IF lifecycle_events <> expected_lifecycle THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD20', MESSAGE = 'Adjudication lifecycle events without matching obligations';
  END IF;

  -- Every release consumed its permit, released a stopped completion right after it, and is the
  -- exact recorded event; no release event exists without one.
  FOR rel IN SELECT * FROM public.game_adjudication_releases WHERE game_id = game LOOP
    SELECT * INTO stop_row FROM public.game_adjudications WHERE game_id = game AND operation_id = rel.stop_operation_id;
    IF NOT rel.consumed OR stop_row.execution_state IS DISTINCT FROM 'completed'
       OR stop_row.is_current_stop OR stop_row.stopped_clock IS NULL
       OR rel.release_seq <> stop_row.final_seq + 1
       OR NOT EXISTS (SELECT 1 FROM public.game_events
                      WHERE game_id = game AND seq = rel.release_seq AND type = 'AdjudicationClocksStarted'
                        AND event_version = 1 AND payload = rel.event_payload) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD23', MESSAGE = 'Release does not match its permit and stop';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.game_events WHERE game_id = game AND type = 'AdjudicationClocksStarted')
     <> (SELECT count(*) FROM public.game_adjudication_releases WHERE game_id = game) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD24', MESSAGE = 'Release events without matching permits';
  END IF;

  SELECT count(*) INTO stops FROM public.game_adjudications WHERE game_id = game AND is_current_stop;
  IF terminal THEN
    IF stops > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD09', MESSAGE = 'A terminal game cannot retain a current stop';
    END IF;
    RETURN;
  END IF;

  IF has_latest AND latest.clock_policy = 'observed-release-v1'
     AND latest.settlement_batch->0->'clockCompletion'->>'kind' = 'stopped' THEN
    SELECT * INTO rel FROM public.game_adjudication_releases WHERE game_id = game AND stop_operation_id = latest.operation_id;
    released := FOUND;
    IF released THEN
      -- Released: the clocks run, nothing but the next adjudication may follow the release, and a
      -- release made in this transaction left exactly the deadlines the domain computed for it.
      IF stops <> 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD11', MESSAGE = 'A released stop cannot remain current';
      END IF;
      IF NOT has_proving AND head <> rel.release_seq THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD21', MESSAGE = 'Events follow a release without an adjudication';
      END IF;
      -- Each queue row must carry the release as its fence (seq) as well as the recorded deadline:
      -- deadline workers use seq to refuse stale work, so a right deadline under a wrong fence is wrong.
      IF rel.permit_xact_id = cur AND NOT has_proving
         AND ((SELECT ROW(f.seq::bigint, f.due_ms::bigint) FROM public.flag_deadlines f WHERE f.game_id = game)
                IS DISTINCT FROM (CASE WHEN rel.flag_due_ms IS NULL THEN NULL
                                       ELSE ROW(rel.release_seq::bigint, rel.flag_due_ms::bigint) END)
              OR (SELECT ROW(d.seq::bigint, d.due_at) FROM public.pregame_deadlines d WHERE d.game_id = game)
                IS DISTINCT FROM (CASE WHEN rel.pregame_due_ms IS NULL THEN NULL
                                       ELSE ROW(rel.release_seq::bigint,
                                                pg_catalog.to_timestamp(rel.pregame_due_ms::double precision / 1000)) END)) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD25', MESSAGE = 'Queues differ from the deadlines recorded at release';
      END IF;
    ELSE
      IF NOT latest.is_current_stop OR stops <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD11', MESSAGE = 'A stopped game requires its latest completion as the one current stop';
      END IF;
      IF NOT has_proving AND head <> latest.final_seq THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD21', MESSAGE = 'Events follow a managed stop without an adjudication';
      END IF;
      IF EXISTS (SELECT 1 FROM public.pregame_deadlines WHERE game_id = game)
         OR EXISTS (SELECT 1 FROM public.flag_deadlines WHERE game_id = game) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD12', MESSAGE = 'Deadlines must be suppressed while stopped';
      END IF;
    END IF;
  ELSIF stops <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD13', MESSAGE = 'Only a stopped latest completion may be a current stop';
  END IF;

  -- A running completion settled in this transaction must leave exactly the queues the log implies.
  IF has_latest AND NOT has_proving AND NOT latest.is_current_stop
     AND latest.settlement_permit_xact_id = cur AND head = latest.final_seq THEN
    SELECT seq, payload INTO latest_move FROM public.game_events
      WHERE game_id = game AND type = 'MovePlayed' ORDER BY seq DESC LIMIT 1;
    IF FOUND THEN
      expected_flag := public.adjudication_flag_due(game, latest_move.payload);
      IF EXISTS (SELECT 1 FROM public.pregame_deadlines WHERE game_id = game)
         OR (SELECT row(seq, due_ms) FROM public.flag_deadlines WHERE game_id = game)
            IS DISTINCT FROM (CASE WHEN expected_flag IS NULL THEN NULL ELSE row(latest_move.seq, expected_flag) END) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD22', MESSAGE = 'Flag queue not restored after a running completion';
      END IF;
    ELSE
      expected_pregame := public.adjudication_pregame_due((SELECT payload FROM public.game_events WHERE game_id = game AND seq = 0));
      IF EXISTS (SELECT 1 FROM public.flag_deadlines WHERE game_id = game)
         OR (SELECT due_at FROM public.pregame_deadlines WHERE game_id = game) IS DISTINCT FROM expected_pregame THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD22', MESSAGE = 'No-show queue not restored after a running completion';
      END IF;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.adjudication_validate_game(UUID) FROM PUBLIC;
