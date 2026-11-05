-- Migration 0053 — durable adjudication persistence (Issue #124, Stage M candidate; unwired).
--
-- Adds the obligation table for managed adjudication operations and the database-side fence that
-- keeps game_events consistent with it. Nothing in the running application writes these rows yet.
--
-- Compatibility rules this migration keeps:
--  * Games with no game_adjudications row ("legacy" games) keep their exact existing append
--    semantics. The only new restriction for them is that the adjudication lifecycle event types
--    (AdjudicationStarted / AdjudicationResolved / AdjudicationClocksStarted) cannot be appended
--    without the permits below, since no production code emits them before this feature.
--  * Every trigger function is SECURITY DEFINER with a fixed search_path, so an existing role that
--    holds only its current game_events privileges (including column-level INSERT) keeps working:
--    it needs no privilege on game_adjudications and cannot skip a check by lacking one.
--  * game_events.xact_id is never rewritten (logical-restore detection depends on stored values),
--    and pregame_deadlines_track (0042) is not redefined: legacy creation still queues with the
--    new seq column at its default 0.
--
-- Identifiers: SQLSTATE PMAxx for immediate rejections, PMDxx for deferred commit validation.

-- 1. Queue identity for head-fenced stale dismissal (PgFencedNoShowCandidates).
ALTER TABLE pregame_deadlines ADD COLUMN seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0);

-- 2. Obligation table.
CREATE TABLE game_adjudications (
  game_id                   UUID        NOT NULL,
  operation_id              UUID        NOT NULL,
  base_revision             INTEGER     NOT NULL CHECK (base_revision >= 0),
  started_seq               INTEGER     NOT NULL CHECK (started_seq = base_revision + 1),
  started_type              TEXT        NOT NULL CHECK (started_type = 'AdjudicationStarted'),
  started_version           SMALLINT    NOT NULL CHECK (started_version = 1),
  started_payload           JSONB       NOT NULL,
  prepared                  JSONB       NOT NULL,
  accepted_at               BIGINT      NOT NULL CHECK (accepted_at >= 0 AND accepted_at <= 8640000000000000),
  rules_version             TEXT        NOT NULL,
  clock_policy              TEXT        CHECK (clock_policy IS NULL OR clock_policy = 'observed-release-v1'),

  -- Acceptance accounting snapshot derived by the domain at Start.
  original_clock            JSONB       NOT NULL,
  thinking_elapsed_at_a     BIGINT      NOT NULL CHECK (thinking_elapsed_at_a >= 0),
  original_no_show_at       BIGINT      CHECK (original_no_show_at IS NULL OR (original_no_show_at >= 0 AND original_no_show_at <= 8640000000000000)),
  remaining_no_show_time_at_a BIGINT    CHECK (remaining_no_show_time_at_a IS NULL OR (remaining_no_show_time_at_a >= 0 AND remaining_no_show_time_at_a <= 8640000000000000)),
  original_basis            JSONB,

  -- proving -> completed. ('settling' is never committed; kept out of the domain entirely.)
  execution_state           TEXT        NOT NULL CHECK (execution_state IN ('proving', 'completed')),

  -- Lease. Only the SHA-256 of the 32-byte capability is stored.
  generation                BIGINT      NOT NULL DEFAULT 0 CHECK (generation >= 0),
  claim_id                  UUID,
  executor_id               UUID,
  capability_hash           BYTEA       CHECK (capability_hash IS NULL OR octet_length(capability_hash) = 32),
  lease_until               TIMESTAMPTZ,

  -- START permit: the transaction that inserted this row is the only one that may append Started.
  start_permit_xact_id      xid8        NOT NULL DEFAULT pg_current_xact_id(),
  start_permit_consumed     BOOLEAN     NOT NULL DEFAULT false,

  -- SETTLEMENT permit: one transaction, one exact contiguous batch, consumed in order.
  settlement_permit_xact_id    xid8,
  settlement_permit_claim_id   UUID,
  settlement_permit_generation BIGINT,
  settlement_permit_start_seq  INTEGER,
  settlement_permit_end_seq    INTEGER,
  settlement_permit_envelopes  JSONB,
  settlement_permit_cursor     INTEGER  NOT NULL DEFAULT 0 CHECK (settlement_permit_cursor >= 0),

  -- Completion.
  settlement_batch          JSONB,
  settlement_receipt        JSONB,
  final_seq                 INTEGER     CHECK (final_seq IS NULL OR final_seq > started_seq),
  completed_at              TIMESTAMPTZ,
  completed_generation      BIGINT,
  completed_claim_id        UUID,
  completed_executor_id     UUID,
  completed_capability_hash BYTEA,

  stopped_clock             JSONB,
  is_current_stop           BOOLEAN     NOT NULL DEFAULT false,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (game_id, operation_id),
  CONSTRAINT game_adjudications_started_seq_uniq UNIQUE (game_id, started_seq),
  CONSTRAINT game_adjudications_claim_tuple CHECK (
    (claim_id IS NULL AND executor_id IS NULL AND capability_hash IS NULL AND lease_until IS NULL)
    OR (claim_id IS NOT NULL AND executor_id IS NOT NULL AND capability_hash IS NOT NULL
        AND lease_until IS NOT NULL AND isfinite(lease_until))
  ),
  CONSTRAINT game_adjudications_settlement_permit_tuple CHECK (
    (settlement_permit_xact_id IS NULL AND settlement_permit_claim_id IS NULL
      AND settlement_permit_generation IS NULL AND settlement_permit_start_seq IS NULL
      AND settlement_permit_end_seq IS NULL AND settlement_permit_envelopes IS NULL
      AND settlement_permit_cursor = 0)
    OR (settlement_permit_xact_id IS NOT NULL AND settlement_permit_claim_id IS NOT NULL
      AND settlement_permit_generation IS NOT NULL
      AND settlement_permit_start_seq = started_seq + 1
      AND settlement_permit_end_seq >= settlement_permit_start_seq
      AND jsonb_typeof(settlement_permit_envelopes) = 'array'
      AND jsonb_array_length(settlement_permit_envelopes) = settlement_permit_end_seq - settlement_permit_start_seq + 1
      AND settlement_permit_cursor <= jsonb_array_length(settlement_permit_envelopes))
  ),
  CONSTRAINT game_adjudications_completion_tuple CHECK (
    (execution_state = 'proving' AND settlement_batch IS NULL AND settlement_receipt IS NULL
      AND final_seq IS NULL AND completed_at IS NULL AND completed_generation IS NULL
      AND completed_claim_id IS NULL AND completed_executor_id IS NULL
      AND completed_capability_hash IS NULL AND stopped_clock IS NULL AND NOT is_current_stop)
    OR (execution_state = 'completed' AND settlement_batch IS NOT NULL AND settlement_receipt IS NOT NULL
      AND final_seq IS NOT NULL AND completed_at IS NOT NULL AND completed_generation IS NOT NULL
      AND completed_claim_id IS NOT NULL AND completed_executor_id IS NOT NULL
      AND completed_capability_hash IS NOT NULL AND octet_length(completed_capability_hash) = 32
      AND start_permit_consumed AND settlement_permit_xact_id IS NOT NULL
      AND (NOT is_current_stop OR stopped_clock IS NOT NULL))
  )
);
REVOKE ALL ON game_adjudications FROM PUBLIC;

CREATE UNIQUE INDEX game_adjudications_one_active_idx ON game_adjudications (game_id) WHERE execution_state = 'proving';
CREATE UNIQUE INDEX game_adjudications_one_current_stop_idx ON game_adjudications (game_id) WHERE is_current_stop;

-- 3. Pure helpers that recompute the legacy queues exactly as 0042/0043 would from the log.

-- The pregame deadline 0042 queues for a creation payload, or NULL. Same nested checks, same float8.
CREATE FUNCTION adjudication_pregame_due(created JSONB) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  after_ms DOUBLE PRECISION;
  at_ms DOUBLE PRECISION;
BEGIN
  IF created->>'source' IN ('seek', 'tournament')
     AND jsonb_typeof(created->'noShowAfterMs') = 'number'
     AND jsonb_typeof(created->'at') = 'number' THEN
    IF abs((created->>'noShowAfterMs')::numeric) < 1e300 AND abs((created->>'at')::numeric) < 1e300 THEN
      after_ms := (created->>'noShowAfterMs')::numeric::double precision;
      at_ms := (created->>'at')::numeric::double precision;
      IF after_ms > 0 AND after_ms = trunc(after_ms) AND after_ms <= 9007199254740991
         AND at_ms >= 0 AND at_ms = trunc(at_ms) AND at_ms + after_ms <= 8640000000000000 THEN
        RETURN to_timestamp((at_ms + after_ms) / 1000);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Replace both queue rows of a game with what its committed log implies: the pregame deadline only
-- while no move and no ending exist, the flag deadline from the latest move while no ending exists.
-- `establishing_seq` becomes the pregame row's identity so an older fenced worker cannot touch it.
CREATE FUNCTION adjudication_restore_deadlines(game UUID, establishing_seq INTEGER) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  created JSONB;
  latest RECORD;
  due_pregame TIMESTAMPTZ;
  due_flag BIGINT;
BEGIN
  DELETE FROM pregame_deadlines WHERE game_id = game;
  DELETE FROM flag_deadlines WHERE game_id = game;
  IF EXISTS (SELECT 1 FROM game_events WHERE game_id = game AND type = 'GameEnded') THEN
    RETURN;
  END IF;
  SELECT seq, payload INTO latest FROM game_events
    WHERE game_id = game AND type = 'MovePlayed' ORDER BY seq DESC LIMIT 1;
  IF FOUND THEN
    due_flag := flag_deadline_ms(game, latest.payload);
    IF due_flag IS NOT NULL THEN
      INSERT INTO flag_deadlines (game_id, seq, due_ms) VALUES (game, latest.seq, due_flag);
    END IF;
  ELSE
    SELECT payload INTO created FROM game_events WHERE game_id = game AND seq = 0;
    due_pregame := adjudication_pregame_due(created);
    IF due_pregame IS NOT NULL THEN
      INSERT INTO pregame_deadlines (game_id, due_at, seq) VALUES (game, due_pregame, establishing_seq);
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION adjudication_restore_deadlines(UUID, INTEGER) FROM PUBLIC;

-- Deferred validation runs once per (transaction, game): the first deferred firing at COMMIT already
-- sees the final state. The "validated" mark lives in a table no writer role can touch (no PUBLIC
-- privileges; only these SECURITY DEFINER functions write it), never in a client-settable setting.
-- Every immediate guard removes the mark on any change, so a later change (after SET CONSTRAINTS ...
-- IMMEDIATE, say) is validated again. Marks are rolled back with their (sub)transaction, which only
-- ever causes an extra validation. The game's advisory lock admits one validating transaction at a
-- time, so a mark from any other transaction id is stale and is removed when a new one is written.
CREATE UNLOGGED TABLE adjudication_validation_marks (
  xact_id xid8 NOT NULL,
  game_id UUID NOT NULL,
  PRIMARY KEY (game_id, xact_id)
);
REVOKE ALL ON adjudication_validation_marks FROM PUBLIC;

CREATE FUNCTION adjudication_mark_changed(game UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM adjudication_validation_marks WHERE game_id = game AND xact_id = pg_current_xact_id();
END;
$$;
REVOKE ALL ON FUNCTION adjudication_mark_changed(UUID) FROM PUBLIC;

-- 4. Row lifecycle guard on game_adjudications.
CREATE FUNCTION game_adjudications_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  head INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA30', MESSAGE = 'game_adjudications rows cannot be deleted';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0));
  PERFORM adjudication_mark_changed(NEW.game_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.execution_state <> 'proving' OR NEW.generation <> 0 OR NEW.claim_id IS NOT NULL
       OR NEW.start_permit_consumed OR NEW.settlement_permit_xact_id IS NOT NULL OR NEW.is_current_stop THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA31', MESSAGE = 'A new adjudication must start proving, unclaimed and unpermitted';
    END IF;
    SELECT max(seq) INTO head FROM game_events WHERE game_id = NEW.game_id;
    IF head IS DISTINCT FROM NEW.base_revision THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA32',
        MESSAGE = 'Adjudication base revision ' || NEW.base_revision || ' is not the stream head ' || coalesce(head::text, 'none');
    END IF;
    NEW.start_permit_xact_id := cur;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  -- UPDATE: identity, Started envelope and acceptance accounting never change.
  IF (OLD.game_id, OLD.operation_id, OLD.base_revision, OLD.started_seq, OLD.started_type,
      OLD.started_version, OLD.started_payload, OLD.prepared, OLD.accepted_at, OLD.rules_version,
      OLD.clock_policy, OLD.original_clock, OLD.thinking_elapsed_at_a, OLD.original_no_show_at,
      OLD.remaining_no_show_time_at_a, OLD.original_basis, OLD.start_permit_xact_id, OLD.created_at)
     IS DISTINCT FROM
     (NEW.game_id, NEW.operation_id, NEW.base_revision, NEW.started_seq, NEW.started_type,
      NEW.started_version, NEW.started_payload, NEW.prepared, NEW.accepted_at, NEW.rules_version,
      NEW.clock_policy, NEW.original_clock, NEW.thinking_elapsed_at_a, NEW.original_no_show_at,
      NEW.remaining_no_show_time_at_a, NEW.original_basis, NEW.start_permit_xact_id, NEW.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA33', MESSAGE = 'Adjudication identity, envelope and accounting are immutable';
  END IF;

  IF OLD.execution_state = 'completed' THEN
    IF NEW.is_current_stop AND NOT OLD.is_current_stop THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA34', MESSAGE = 'A cleared stop cannot become current again';
    END IF;
    IF row(OLD.*) IS DISTINCT FROM row(NEW.*) THEN
      IF (OLD.execution_state, OLD.generation, OLD.claim_id, OLD.executor_id, OLD.capability_hash,
          OLD.lease_until, OLD.start_permit_consumed, OLD.settlement_permit_xact_id,
          OLD.settlement_permit_claim_id, OLD.settlement_permit_generation,
          OLD.settlement_permit_start_seq, OLD.settlement_permit_end_seq,
          OLD.settlement_permit_envelopes, OLD.settlement_permit_cursor, OLD.settlement_batch,
          OLD.settlement_receipt, OLD.final_seq, OLD.completed_at, OLD.completed_generation,
          OLD.completed_claim_id, OLD.completed_executor_id, OLD.completed_capability_hash,
          OLD.stopped_clock)
         IS DISTINCT FROM
         (NEW.execution_state, NEW.generation, NEW.claim_id, NEW.executor_id, NEW.capability_hash,
          NEW.lease_until, NEW.start_permit_consumed, NEW.settlement_permit_xact_id,
          NEW.settlement_permit_claim_id, NEW.settlement_permit_generation,
          NEW.settlement_permit_start_seq, NEW.settlement_permit_end_seq,
          NEW.settlement_permit_envelopes, NEW.settlement_permit_cursor, NEW.settlement_batch,
          NEW.settlement_receipt, NEW.final_seq, NEW.completed_at, NEW.completed_generation,
          NEW.completed_claim_id, NEW.completed_executor_id, NEW.completed_capability_hash,
          NEW.stopped_clock) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMA35', MESSAGE = 'Completed adjudication rows are immutable except for clearing is_current_stop';
      END IF;
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- OLD is proving.
  IF OLD.start_permit_consumed AND NOT NEW.start_permit_consumed THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA36', MESSAGE = 'A consumed START permit cannot be restored';
  END IF;
  IF NEW.generation < OLD.generation
     OR (NEW.claim_id IS DISTINCT FROM OLD.claim_id AND NEW.generation <= OLD.generation)
     OR (NEW.capability_hash IS DISTINCT FROM OLD.capability_hash AND NEW.generation <= OLD.generation)
     OR (NEW.executor_id IS DISTINCT FROM OLD.executor_id AND NEW.generation <= OLD.generation) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA37', MESSAGE = 'A new claim requires a strictly greater generation';
  END IF;
  IF OLD.start_permit_xact_id = cur
     AND (NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.settlement_permit_xact_id IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA22',
      MESSAGE = 'Started must commit before a claim or settlement in a later transaction';
  END IF;
  IF NEW.settlement_permit_xact_id IS NOT NULL THEN
    IF NEW.settlement_permit_xact_id <> cur THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA38', MESSAGE = 'A SETTLEMENT permit binds only the current transaction';
    END IF;
    IF NEW.settlement_permit_claim_id IS DISTINCT FROM NEW.claim_id
       OR NEW.settlement_permit_generation IS DISTINCT FROM NEW.generation
       OR NEW.lease_until IS NULL OR NEW.lease_until <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA39', MESSAGE = 'A SETTLEMENT permit requires the current live claim';
    END IF;
  END IF;
  IF NEW.execution_state = 'completed' THEN
    IF NEW.settlement_permit_xact_id IS DISTINCT FROM cur
       OR NEW.settlement_permit_cursor <> jsonb_array_length(NEW.settlement_permit_envelopes)
       OR NEW.final_seq IS DISTINCT FROM NEW.settlement_permit_end_seq
       OR NEW.completed_claim_id IS DISTINCT FROM NEW.claim_id
       OR NEW.completed_executor_id IS DISTINCT FROM NEW.executor_id
       OR NEW.completed_generation IS DISTINCT FROM NEW.generation
       OR NEW.completed_capability_hash IS DISTINCT FROM NEW.capability_hash
       OR NEW.lease_until IS NULL OR NEW.lease_until <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA40',
        MESSAGE = 'Completion requires the fully consumed SETTLEMENT permit of the current live claim in this transaction';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER game_adjudications_row_guard
  BEFORE INSERT OR UPDATE OR DELETE ON game_adjudications
  FOR EACH ROW EXECUTE FUNCTION game_adjudications_row_guard();

-- After a completion that leaves the game running (no stop, no ending), put back the queue rows the
-- proving window suppressed, exactly as the log implies.
CREATE FUNCTION game_adjudications_restore_queues() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.execution_state = 'proving' AND NEW.execution_state = 'completed' AND NOT NEW.is_current_stop THEN
    PERFORM adjudication_restore_deadlines(NEW.game_id, NEW.final_seq);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER game_adjudications_restore_queues
  AFTER UPDATE ON game_adjudications
  FOR EACH ROW EXECUTE FUNCTION game_adjudications_restore_queues();

-- 5. Immediate guard on game_events. Lifecycle events only through permits; nothing else while a
-- game is proving or stopped; nothing piggybacked after a settlement in its own transaction.
CREATE FUNCTION game_events_adjudication_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  adj game_adjudications;
  expected JSONB;
BEGIN
  IF NEW.type = 'AdjudicationClocksStarted' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA01', MESSAGE = 'AdjudicationClocksStarted cannot be appended in this release';
  END IF;

  -- An append at an occupied position is a stale writer: let the primary key reject it with the
  -- same 23505 every existing caller already maps to its version conflict.
  IF EXISTS (SELECT 1 FROM game_events WHERE game_id = NEW.game_id AND seq = NEW.seq) THEN
    RETURN NEW;
  END IF;

  -- Legacy games take no new lock: the (game_id, seq) key already orders them against a concurrent
  -- Start, and the proving-row lock below waits for an in-flight settlement.
  IF EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0));
    PERFORM adjudication_mark_changed(NEW.game_id);
  END IF;

  SELECT * INTO adj FROM game_adjudications
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
      UPDATE game_adjudications SET start_permit_consumed = true
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
      UPDATE game_adjudications SET settlement_permit_cursor = settlement_permit_cursor + 1
        WHERE game_id = adj.game_id AND operation_id = adj.operation_id;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PMA09', MESSAGE = 'Unpermitted event while adjudication is proving';
  END IF;

  IF NEW.type = 'AdjudicationStarted' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA02', MESSAGE = 'AdjudicationStarted requires a START permit';
  END IF;
  IF NEW.type = 'AdjudicationResolved' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA12', MESSAGE = 'AdjudicationResolved requires a SETTLEMENT permit';
  END IF;
  IF EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id AND is_current_stop) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA10', MESSAGE = 'Unpermitted event while the game is in a managed stop';
  END IF;
  IF EXISTS (SELECT 1 FROM game_adjudications
             WHERE game_id = NEW.game_id AND execution_state = 'completed' AND settlement_permit_xact_id = cur) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA13', MESSAGE = 'No event may follow a settlement in its own transaction';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER game_events_adjudication_guard
  BEFORE INSERT ON game_events
  FOR EACH ROW EXECUTE FUNCTION game_events_adjudication_guard();

-- 6. Keep queues empty while a managed game is proving or stopped. Named z_ so it runs after the
-- 0042/0043 AFTER triggers, which may have just (re)queued the game. Legacy games are untouched.
CREATE FUNCTION z_adjudication_queue_reconcile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM game_adjudications
             WHERE game_id = NEW.game_id AND (execution_state = 'proving' OR is_current_stop)) THEN
    DELETE FROM pregame_deadlines WHERE game_id = NEW.game_id;
    DELETE FROM flag_deadlines WHERE game_id = NEW.game_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER z_adjudication_queue_reconcile
  AFTER INSERT ON game_events
  FOR EACH ROW EXECUTE FUNCTION z_adjudication_queue_reconcile();

-- 7. Deferred whole-game validation at COMMIT for every managed game a transaction touched. It reads
-- the committed-to-be state from the tables (never the queued NEW snapshot beyond its game id).
CREATE FUNCTION adjudication_validate_game(game UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur xid8 := pg_current_xact_id();
  adj game_adjudications;
  latest game_adjudications;
  has_latest BOOLEAN := false;
  proving_row game_adjudications;
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
BEGIN
  SELECT max(seq) INTO head FROM game_events WHERE game_id = game;
  SELECT EXISTS (SELECT 1 FROM game_events WHERE game_id = game AND type = 'GameEnded') INTO terminal;

  FOR adj IN SELECT * FROM game_adjudications WHERE game_id = game ORDER BY started_seq LOOP
    IF adj.started_seq <= prev_final THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD17', MESSAGE = 'Adjudication operations overlap in the stream';
    END IF;
    -- A completed row from an earlier transaction was fully verified at its own COMMIT and is
    -- immutable since (row guard); only ordering, counts and stop rules are re-checked for it.
    settled_earlier := adj.execution_state = 'completed' AND adj.settlement_permit_xact_id <> cur;
    IF NOT settled_earlier AND (NOT adj.start_permit_consumed OR NOT EXISTS (
      SELECT 1 FROM game_events
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
      IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = game)
         OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = game) THEN
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
          SELECT 1 FROM game_events
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

  SELECT count(*) INTO lifecycle_events FROM game_events
    WHERE game_id = game AND type IN ('AdjudicationStarted', 'AdjudicationResolved');
  IF lifecycle_events <> expected_lifecycle THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD20', MESSAGE = 'Adjudication lifecycle events without matching obligations';
  END IF;

  SELECT count(*) INTO stops FROM game_adjudications WHERE game_id = game AND is_current_stop;
  IF terminal THEN
    IF stops > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD09', MESSAGE = 'A terminal game cannot retain a current stop';
    END IF;
    RETURN;
  END IF;

  IF has_latest AND latest.clock_policy = 'observed-release-v1'
     AND latest.settlement_batch->0->'clockCompletion'->>'kind' = 'stopped' THEN
    IF NOT latest.is_current_stop OR stops <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD11', MESSAGE = 'A stopped game requires its latest completion as the one current stop';
    END IF;
    IF NOT has_proving AND head <> latest.final_seq THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD21', MESSAGE = 'Events follow a managed stop without an adjudication';
    END IF;
    IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = game)
       OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = game) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD12', MESSAGE = 'Deadlines must be suppressed while stopped';
    END IF;
  ELSIF stops <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD13', MESSAGE = 'Only a stopped latest completion may be a current stop';
  END IF;

  -- A running completion settled in this transaction must leave exactly the queues the log implies.
  IF has_latest AND NOT has_proving AND NOT latest.is_current_stop
     AND latest.settlement_permit_xact_id = cur AND head = latest.final_seq THEN
    SELECT seq, payload INTO latest_move FROM game_events
      WHERE game_id = game AND type = 'MovePlayed' ORDER BY seq DESC LIMIT 1;
    IF FOUND THEN
      expected_flag := flag_deadline_ms(game, latest_move.payload);
      IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = game)
         OR (SELECT row(seq, due_ms) FROM flag_deadlines WHERE game_id = game)
            IS DISTINCT FROM (CASE WHEN expected_flag IS NULL THEN NULL ELSE row(latest_move.seq, expected_flag) END) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD22', MESSAGE = 'Flag queue not restored after a running completion';
      END IF;
    ELSE
      expected_pregame := adjudication_pregame_due((SELECT payload FROM game_events WHERE game_id = game AND seq = 0));
      IF EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = game)
         OR (SELECT due_at FROM pregame_deadlines WHERE game_id = game) IS DISTINCT FROM expected_pregame THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD22', MESSAGE = 'No-show queue not restored after a running completion';
      END IF;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION adjudication_validate_game(UUID) FROM PUBLIC;

CREATE FUNCTION adjudication_deferred_validator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Legacy games (no obligation row) keep their exact pre-0053 commit behavior.
  IF NOT EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0));
  IF EXISTS (SELECT 1 FROM adjudication_validation_marks
             WHERE game_id = NEW.game_id AND xact_id = pg_current_xact_id()) THEN
    RETURN NULL;
  END IF;
  PERFORM adjudication_validate_game(NEW.game_id);
  DELETE FROM adjudication_validation_marks WHERE game_id = NEW.game_id;
  INSERT INTO adjudication_validation_marks (xact_id, game_id) VALUES (pg_current_xact_id(), NEW.game_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER adjudication_deferred_validator_events
  AFTER INSERT ON game_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adjudication_deferred_validator();

CREATE CONSTRAINT TRIGGER adjudication_deferred_validator_adjudications
  AFTER INSERT OR UPDATE ON game_adjudications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adjudication_deferred_validator();

-- Deferred validation covers queue writes too, so nothing (a worker, a manual repair) can commit a
-- deadline for a managed game that is proving or stopped.
CREATE FUNCTION adjudication_queue_validator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM game_adjudications
             WHERE game_id = NEW.game_id AND (execution_state = 'proving' OR is_current_stop))
     AND (EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = NEW.game_id)
          OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = NEW.game_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD05', MESSAGE = 'Deadlines must be suppressed while proving or stopped';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER adjudication_queue_validator_pregame
  AFTER INSERT OR UPDATE ON pregame_deadlines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adjudication_queue_validator();

CREATE CONSTRAINT TRIGGER adjudication_queue_validator_flag
  AFTER INSERT OR UPDATE ON flag_deadlines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adjudication_queue_validator();

-- Trigger functions cannot be called directly, but keep EXECUTE off PUBLIC for every new routine.
REVOKE ALL ON FUNCTION game_adjudications_row_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION game_adjudications_restore_queues() FROM PUBLIC;
REVOKE ALL ON FUNCTION game_events_adjudication_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION z_adjudication_queue_reconcile() FROM PUBLIC;
REVOKE ALL ON FUNCTION adjudication_deferred_validator() FROM PUBLIC;
REVOKE ALL ON FUNCTION adjudication_queue_validator() FROM PUBLIC;
