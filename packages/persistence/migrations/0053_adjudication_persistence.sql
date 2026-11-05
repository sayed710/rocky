-- Migration 0053 — Bounded Stage M durable adjudication persistence (Issue #124, candidate).
--
-- Implements:
-- 1. Additive sequence support on pregame_deadlines for head-fenced stale dismissal.
-- 2. game_adjudications table retaining immutable identity, Started envelope, accounting snapshot,
--    lease/claim metadata, transaction-bound Start/Settlement permits, completed receipt/batch,
--    historical GameStoppedClockState snapshot, and designated mutable is_current_stop.
-- 3. Immediate BEFORE INSERT guard on game_events enforcing game advisory fence, rejecting
--    AdjudicationClocksStarted (S) in Stage M, admitting exact unconsumed START and SETTLEMENT
--    permits, and rejecting unpermitted managed lifecycle and raw events while proving or stopped.
-- 4. AFTER INSERT trigger on game_events reconciling pregame and flag deadlines for managed games.
-- 5. Deferred constraint triggers validating final state parity at COMMIT time.
-- 6. Immutability guard on game_adjudications preventing modification of completed rows (except is_current_stop).

-- Step 1: Add sequence support to pregame_deadlines.
ALTER TABLE pregame_deadlines ADD COLUMN IF NOT EXISTS seq INTEGER NOT NULL DEFAULT 0;

-- Update pregame_deadlines_track to record establishing event seq.
CREATE OR REPLACE FUNCTION pregame_deadlines_track() RETURNS trigger AS $$
DECLARE
  after_ms DOUBLE PRECISION;
  at_ms DOUBLE PRECISION;
BEGIN
  IF NEW.seq = 0 THEN
    IF NEW.payload->>'source' IN ('seek', 'tournament')
       AND jsonb_typeof(NEW.payload->'noShowAfterMs') = 'number'
       AND jsonb_typeof(NEW.payload->'at') = 'number' THEN
      IF abs((NEW.payload->>'noShowAfterMs')::numeric) < 1e300 AND abs((NEW.payload->>'at')::numeric) < 1e300 THEN
        after_ms := (NEW.payload->>'noShowAfterMs')::numeric::double precision;
        at_ms := (NEW.payload->>'at')::numeric::double precision;
        IF after_ms > 0 AND after_ms = trunc(after_ms) AND after_ms <= 9007199254740991
           AND at_ms >= 0 AND at_ms = trunc(at_ms) AND at_ms + after_ms <= 8640000000000000 THEN
          INSERT INTO pregame_deadlines (game_id, due_at, seq)
          VALUES (NEW.game_id, to_timestamp((at_ms + after_ms) / 1000), NEW.seq)
          ON CONFLICT (game_id) DO UPDATE SET due_at = EXCLUDED.due_at, seq = EXCLUDED.seq;
        END IF;
      END IF;
    END IF;
  ELSE
    DELETE FROM pregame_deadlines WHERE game_id = NEW.game_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Step 2: Create game_adjudications table.
CREATE TABLE game_adjudications (
  game_id                   UUID        NOT NULL,
  operation_id              UUID        NOT NULL,
  base_revision             INTEGER     NOT NULL CHECK (base_revision >= -1),
  started_seq               INTEGER     NOT NULL CHECK (started_seq >= 0 AND started_seq = base_revision + 1),
  started_type              TEXT        NOT NULL DEFAULT 'AdjudicationStarted',
  started_version           SMALLINT    NOT NULL DEFAULT 1,
  started_payload           JSONB       NOT NULL,
  prepared                  JSONB       NOT NULL,
  accepted_at               BIGINT      NOT NULL CHECK (accepted_at >= 0 AND accepted_at <= 8640000000000000),
  rules_version             TEXT        NOT NULL,
  clock_policy              TEXT        CHECK (clock_policy IS NULL OR clock_policy = 'observed-release-v1'),

  -- Acceptance accounting snapshot
  original_clock            JSONB       NOT NULL,
  thinking_elapsed_at_a     BIGINT      NOT NULL CHECK (thinking_elapsed_at_a >= 0),
  original_no_show_at       BIGINT      CHECK (original_no_show_at IS NULL OR (original_no_show_at >= 0 AND original_no_show_at <= 8640000000000000)),
  remaining_no_show_time_at_a BIGINT    CHECK (remaining_no_show_time_at_a IS NULL OR (remaining_no_show_time_at_a >= 0 AND remaining_no_show_time_at_a <= 8640000000000000)),
  original_basis            JSONB,

  -- Execution lifecycle: proving -> settling -> completed
  execution_state           TEXT        NOT NULL CHECK (execution_state IN ('proving', 'settling', 'completed')),

  -- Lease, executor, and capability hash (raw capability never stored)
  generation                BIGINT      NOT NULL DEFAULT 0 CHECK (generation >= 0),
  claim_id                  UUID,
  executor_id               UUID,
  capability_hash           BYTEA       CHECK (capability_hash IS NULL OR octet_length(capability_hash) = 32),
  lease_until               TIMESTAMPTZ,

  -- START permit (binds current transaction ID and exact Started envelope)
  start_permit_xact_id      xid8        NOT NULL DEFAULT pg_current_xact_id(),
  start_permit_consumed     BOOLEAN     NOT NULL DEFAULT false,

  -- SETTLEMENT permit (binds current transaction ID, exact contiguous batch, range, and claim)
  settlement_permit_xact_id  xid8,
  settlement_permit_claim_id UUID,
  settlement_permit_generation BIGINT,
  settlement_permit_start_seq INTEGER,
  settlement_permit_end_seq  INTEGER,
  settlement_permit_envelopes JSONB,
  settlement_permit_cursor   INTEGER     NOT NULL DEFAULT 0 CHECK (settlement_permit_cursor >= 0),

  -- Completion metadata
  settlement_batch          JSONB,
  settlement_receipt        JSONB,
  final_seq                 INTEGER     CHECK (final_seq IS NULL OR final_seq >= started_seq),
  completed_at              TIMESTAMPTZ,
  completed_generation      BIGINT,
  completed_claim_id        UUID,
  completed_executor_id     UUID,
  completed_capability_hash BYTEA,

  -- Stopped clock state and current stop indicator
  stopped_clock             JSONB,
  is_current_stop           BOOLEAN     NOT NULL DEFAULT false,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (game_id, operation_id),
  CONSTRAINT game_adjudications_started_seq_uniq UNIQUE (game_id, started_seq),
  CONSTRAINT game_adjudications_claim_tuple CHECK (
    (claim_id IS NULL AND executor_id IS NULL AND capability_hash IS NULL AND lease_until IS NULL)
    OR
    (claim_id IS NOT NULL AND executor_id IS NOT NULL AND capability_hash IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until))
  )
);

-- At most one active (non-completed) operation per game
CREATE UNIQUE INDEX game_adjudications_one_active_idx ON game_adjudications (game_id) WHERE execution_state <> 'completed';

-- At most one current stop per game
CREATE UNIQUE INDEX game_adjudications_one_current_stop_idx ON game_adjudications (game_id) WHERE is_current_stop;

-- Step 3: Immutability guard on game_adjudications
CREATE OR REPLACE FUNCTION game_adjudications_immutability_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'game_adjudications rows are append-only and cannot be deleted';
  END IF;

  -- Started event must commit before claim or settlement in a subsequent transaction
  IF OLD.execution_state = 'proving' AND (NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.settlement_permit_xact_id IS NOT NULL) THEN
    IF OLD.start_permit_xact_id = pg_current_xact_id() THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA22',
        MESSAGE = 'Started event must commit before claim or settlement in a subsequent transaction';
    END IF;
  END IF;

  IF OLD.execution_state = 'completed' THEN
    IF OLD.game_id IS DISTINCT FROM NEW.game_id
       OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
       OR OLD.base_revision IS DISTINCT FROM NEW.base_revision
       OR OLD.started_seq IS DISTINCT FROM NEW.started_seq
       OR OLD.started_type IS DISTINCT FROM NEW.started_type
       OR OLD.started_version IS DISTINCT FROM NEW.started_version
       OR OLD.started_payload IS DISTINCT FROM NEW.started_payload
       OR OLD.prepared IS DISTINCT FROM NEW.prepared
       OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at
       OR OLD.rules_version IS DISTINCT FROM NEW.rules_version
       OR OLD.clock_policy IS DISTINCT FROM NEW.clock_policy
       OR OLD.original_clock IS DISTINCT FROM NEW.original_clock
       OR OLD.thinking_elapsed_at_a IS DISTINCT FROM NEW.thinking_elapsed_at_a
       OR OLD.original_no_show_at IS DISTINCT FROM NEW.original_no_show_at
       OR OLD.remaining_no_show_time_at_a IS DISTINCT FROM NEW.remaining_no_show_time_at_a
       OR OLD.original_basis IS DISTINCT FROM NEW.original_basis
       OR OLD.execution_state IS DISTINCT FROM NEW.execution_state
       OR OLD.generation IS DISTINCT FROM NEW.generation
       OR OLD.claim_id IS DISTINCT FROM NEW.claim_id
       OR OLD.executor_id IS DISTINCT FROM NEW.executor_id
       OR OLD.capability_hash IS DISTINCT FROM NEW.capability_hash
       OR OLD.lease_until IS DISTINCT FROM NEW.lease_until
       OR OLD.start_permit_xact_id IS DISTINCT FROM NEW.start_permit_xact_id
       OR OLD.start_permit_consumed IS DISTINCT FROM NEW.start_permit_consumed
       OR OLD.settlement_permit_xact_id IS DISTINCT FROM NEW.settlement_permit_xact_id
       OR OLD.settlement_permit_claim_id IS DISTINCT FROM NEW.settlement_permit_claim_id
       OR OLD.settlement_permit_generation IS DISTINCT FROM NEW.settlement_permit_generation
       OR OLD.settlement_permit_start_seq IS DISTINCT FROM NEW.settlement_permit_start_seq
       OR OLD.settlement_permit_end_seq IS DISTINCT FROM NEW.settlement_permit_end_seq
       OR OLD.settlement_permit_envelopes IS DISTINCT FROM NEW.settlement_permit_envelopes
       OR OLD.settlement_permit_cursor IS DISTINCT FROM NEW.settlement_permit_cursor
       OR OLD.settlement_batch IS DISTINCT FROM NEW.settlement_batch
       OR OLD.settlement_receipt IS DISTINCT FROM NEW.settlement_receipt
       OR OLD.final_seq IS DISTINCT FROM NEW.final_seq
       OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
       OR OLD.completed_generation IS DISTINCT FROM NEW.completed_generation
       OR OLD.completed_claim_id IS DISTINCT FROM NEW.completed_claim_id
       OR OLD.completed_executor_id IS DISTINCT FROM NEW.completed_executor_id
       OR OLD.completed_capability_hash IS DISTINCT FROM NEW.completed_capability_hash
       OR OLD.stopped_clock IS DISTINCT FROM NEW.stopped_clock THEN
      RAISE EXCEPTION 'Completed adjudication rows are immutable except for is_current_stop';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_adjudications_immutability_guard
  BEFORE UPDATE OR DELETE ON game_adjudications
  FOR EACH ROW
  EXECUTE FUNCTION game_adjudications_immutability_guard();

-- Step 3b: Trigger-owned internal storage classification tag on game_events
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS storage_tag TEXT;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_storage_tag_check;
ALTER TABLE game_events ADD CONSTRAINT game_events_storage_tag_check CHECK (
  (storage_tag IS NULL)
  OR (storage_tag = 'started' AND type = 'AdjudicationStarted')
  OR (storage_tag IN ('settling', 'tail') AND type <> 'AdjudicationStarted' AND type <> 'AdjudicationClocksStarted')
);

CREATE INDEX IF NOT EXISTS game_events_game_type_seq_idx ON game_events (game_id, type, seq);
CREATE INDEX IF NOT EXISTS game_events_storage_tag_idx ON game_events (game_id, seq) WHERE storage_tag IS NOT NULL;

-- Step 3c: Shared stream classifier reading original columns only
CREATE OR REPLACE FUNCTION adjudication_classify_stream(
  p_game_id UUID,
  p_cur_xact xid8
) RETURNS TEXT AS $$
DECLARE
  ev RECORD;
  has_started BOOLEAN := false;
  latest_started_seq INTEGER := -1;
  latest_started_op UUID := null;
  latest_clock_policy TEXT := null;
  latest_started_xid xid8 := null;
  has_observed_release BOOLEAN := false;
  is_terminal BOOLEAN := false;
  has_resolved BOOLEAN := false;
  resolved_op UUID := null;
  resolved_started_seq INTEGER := null;
  resolved_effects JSONB := null;
  resolved_xid xid8 := null;
  expected_effect_count INTEGER := 0;
  matched_effects INTEGER := 0;
  suffix_mismatch BOOLEAN := false;
  expected_eff JSONB;
BEGIN
  FOR ev IN
    SELECT seq, type, event_version, payload, xact_id
    FROM game_events
    WHERE game_id = p_game_id
    ORDER BY seq ASC
  LOOP
    IF ev.type = 'GameEnded' THEN
      is_terminal := true;
    END IF;

    IF ev.type = 'AdjudicationStarted' THEN
      IF has_started AND (NOT has_resolved OR matched_effects < expected_effect_count) THEN
        suffix_mismatch := true;
      END IF;

      has_started := true;
      latest_started_seq := ev.seq;
      latest_started_op := (ev.payload->>'operationId')::uuid;
      latest_clock_policy := ev.payload->>'clockPolicy';
      latest_started_xid := ev.xact_id;
      IF latest_clock_policy = 'observed-release-v1' THEN
        has_observed_release := true;
      END IF;

      has_resolved := false;
      resolved_op := null;
      resolved_started_seq := null;
      resolved_effects := null;
      expected_effect_count := 0;
      matched_effects := 0;
    ELSIF has_started AND NOT has_resolved THEN
      IF ev.seq = latest_started_seq + 1 THEN
        IF ev.type = 'AdjudicationResolved'
           AND (ev.payload->>'operationId')::uuid = latest_started_op
           AND (ev.payload->>'startedSeq')::integer = latest_started_seq
           AND (ev.payload->>'gameId')::uuid = p_game_id THEN
          has_resolved := true;
          resolved_op := latest_started_op;
          resolved_started_seq := latest_started_seq;
          resolved_xid := ev.xact_id;
          resolved_effects := ev.payload->'effects';
          IF jsonb_typeof(resolved_effects) = 'array' THEN
            expected_effect_count := jsonb_array_length(resolved_effects);
          ELSE
            expected_effect_count := 0;
          END IF;
          matched_effects := 0;
        ELSE
          suffix_mismatch := true;
        END IF;
      ELSE
        suffix_mismatch := true;
      END IF;
    ELSIF has_started AND has_resolved AND matched_effects < expected_effect_count THEN
      IF ev.seq = latest_started_seq + 1 + matched_effects + 1 THEN
        expected_eff := resolved_effects->matched_effects;
        IF ev.type = expected_eff->>'type'
           AND ev.event_version = 1
           AND ev.payload = expected_eff THEN
          matched_effects := matched_effects + 1;
        ELSE
          suffix_mismatch := true;
        END IF;
      ELSE
        suffix_mismatch := true;
      END IF;
    ELSIF has_started AND has_resolved AND matched_effects = expected_effect_count THEN
      IF has_observed_release AND ev.type <> 'AdjudicationStarted' THEN
        suffix_mismatch := true;
      END IF;
    END IF;
  END LOOP;

  IF is_terminal THEN
    RETURN 'terminal';
  END IF;

  IF NOT has_started THEN
    RETURN 'ordinary_legacy';
  END IF;

  IF has_observed_release THEN
    RETURN 'managed_observed_release';
  END IF;

  IF suffix_mismatch THEN
    RETURN 'ambiguous';
  END IF;

  IF NOT has_resolved THEN
    RETURN 'proving';
  END IF;

  IF matched_effects < expected_effect_count THEN
    RETURN 'ambiguous';
  END IF;

  IF latest_started_xid = p_cur_xact OR resolved_xid = p_cur_xact THEN
    RETURN 'same_xid_settlement';
  END IF;

  RETURN 'legacy_null_policy_completed';
END;
$$ LANGUAGE plpgsql;

-- Step 3d: Atomic same-client Start primitive
CREATE OR REPLACE FUNCTION adjudication_start_atomic(
  p_game_id UUID,
  p_started_event JSONB,
  p_accounting JSONB
) RETURNS INTEGER AS $$
DECLARE
  v_base_revision INTEGER;
  v_started_seq INTEGER;
  v_head_seq INTEGER;
  v_prepared JSONB;
  v_operation_id UUID;
  v_rules_version TEXT;
  v_clock_policy TEXT;
  v_at BIGINT;
  v_cur_xact xid8;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || p_game_id::text, 0));
  v_cur_xact := pg_current_xact_id();

  v_prepared := p_started_event->'prepared';
  v_operation_id := (p_started_event->>'operationId')::uuid;
  v_base_revision := (p_started_event->>'baseRevision')::integer;
  v_started_seq := v_base_revision + 1;
  v_rules_version := p_started_event->>'rulesVersion';
  v_clock_policy := p_started_event->>'clockPolicy';
  v_at := (p_started_event->>'at')::bigint;

  -- Validate head sequence of game_events
  SELECT COALESCE(MAX(seq), -1) INTO v_head_seq FROM game_events WHERE game_id = p_game_id;
  IF v_head_seq <> v_base_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA20',
      MESSAGE = 'Head sequence mismatch on Start: expected ' || v_base_revision || ', got ' || v_head_seq;
  END IF;

  -- Validate no active adjudication exists
  IF EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = p_game_id AND execution_state <> 'completed') THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA21',
      MESSAGE = 'Another adjudication operation is currently active for this game';
  END IF;

  -- Inseparably insert obligation row into game_adjudications
  INSERT INTO game_adjudications (
    game_id, operation_id, base_revision, started_seq, started_type, started_version,
    started_payload, prepared, accepted_at, rules_version, clock_policy,
    original_clock, thinking_elapsed_at_a, original_no_show_at, remaining_no_show_time_at_a,
    original_basis, execution_state, generation, start_permit_xact_id, start_permit_consumed
  ) VALUES (
    p_game_id,
    v_operation_id,
    v_base_revision,
    v_started_seq,
    p_started_event->>'type',
    1,
    p_started_event,
    v_prepared,
    v_at,
    v_rules_version,
    v_clock_policy,
    p_accounting->'originalClock',
    (p_accounting->>'thinkingElapsedAtA')::bigint,
    CASE WHEN p_accounting->>'originalNoShowAt' IS NOT NULL THEN (p_accounting->>'originalNoShowAt')::bigint ELSE NULL END,
    CASE WHEN p_accounting->>'remainingNoShowTimeAtA' IS NOT NULL THEN (p_accounting->>'remainingNoShowTimeAtA')::bigint ELSE NULL END,
    p_accounting->'originalBasis',
    'proving',
    0,
    v_cur_xact,
    false
  );

  -- Inseparably insert AdjudicationStarted event into game_events
  INSERT INTO game_events (game_id, seq, type, event_version, payload)
  VALUES (p_game_id, v_started_seq, p_started_event->>'type', 1, p_started_event);

  -- Suppress deadline queues
  DELETE FROM pregame_deadlines WHERE game_id = p_game_id;
  DELETE FROM flag_deadlines WHERE game_id = p_game_id;

  RETURN v_started_seq;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Immediate BEFORE INSERT guard on game_events
CREATE OR REPLACE FUNCTION game_events_adjudication_guard() RETURNS trigger AS $$
DECLARE
  cur_xact xid8;
  stream_status TEXT;
  has_adj_table_priv BOOLEAN;
  active_adj RECORD;
  has_active_adj BOOLEAN := false;
  expected_env JSONB;
  is_tail BOOLEAN;
BEGIN
  -- Overwrite caller tag and stamp actual transaction ID
  NEW.storage_tag := NULL;
  cur_xact := pg_current_xact_id();
  NEW.xact_id := cur_xact;

  -- 1. Acquire the common game fence and read authoritative state.
  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || NEW.game_id::text, 0));

  -- 2. Reject every AdjudicationClocksStarted insert in Stage M.
  IF NEW.type = 'AdjudicationClocksStarted' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA01',
      MESSAGE = 'AdjudicationClocksStarted inserts are prohibited in Stage M';
  END IF;

  -- Check if caller has SELECT privilege on game_adjudications
  has_adj_table_priv := has_table_privilege(current_user, 'public.game_adjudications', 'SELECT');

  -- If caller is inserting AdjudicationStarted, must have START permit in game_adjudications
  IF NEW.type = 'AdjudicationStarted' THEN
    IF NOT has_adj_table_priv THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA02',
        MESSAGE = 'AdjudicationStarted insert rejected: no active adjudication record';
    END IF;

    SELECT * INTO active_adj FROM game_adjudications
      WHERE game_id = NEW.game_id AND execution_state <> 'completed'
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA02',
        MESSAGE = 'AdjudicationStarted insert rejected: no active adjudication record';
    END IF;

    IF active_adj.start_permit_consumed THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA03',
        MESSAGE = 'AdjudicationStarted insert rejected: START permit already consumed';
    END IF;

    IF active_adj.start_permit_xact_id IS DISTINCT FROM cur_xact THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA04',
        MESSAGE = 'AdjudicationStarted insert rejected: transaction mismatch';
    END IF;

    IF active_adj.started_seq <> NEW.seq
       OR active_adj.started_type <> NEW.type
       OR active_adj.started_version <> NEW.event_version
       OR active_adj.started_payload <> NEW.payload THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA05',
        MESSAGE = 'AdjudicationStarted insert rejected: payload or sequence mismatch with START permit';
    END IF;

    UPDATE game_adjudications
      SET start_permit_consumed = true
      WHERE game_id = NEW.game_id AND operation_id = active_adj.operation_id;

    NEW.storage_tag := 'started';
    RETURN NEW;
  END IF;

  -- If caller has privilege on game_adjudications, check for active SETTLEMENT permit or completed/stopped row
  IF has_adj_table_priv THEN
    SELECT * INTO active_adj FROM game_adjudications
      WHERE game_id = NEW.game_id AND execution_state <> 'completed'
      FOR UPDATE;
    has_active_adj := FOUND;

    IF has_active_adj AND active_adj.settlement_permit_xact_id IS NOT NULL THEN
      IF active_adj.settlement_permit_xact_id = cur_xact THEN
        IF active_adj.settlement_permit_cursor >= jsonb_array_length(active_adj.settlement_permit_envelopes) THEN
          RAISE EXCEPTION USING ERRCODE = 'PMA06',
            MESSAGE = 'SETTLEMENT permit exceeded: extra effect inserted';
        END IF;

        IF NEW.seq <> active_adj.settlement_permit_start_seq + active_adj.settlement_permit_cursor THEN
          RAISE EXCEPTION USING ERRCODE = 'PMA07',
            MESSAGE = 'SETTLEMENT permit sequence mismatch';
        END IF;

        expected_env := active_adj.settlement_permit_envelopes->active_adj.settlement_permit_cursor;
        IF expected_env->>'type' <> NEW.type
           OR (expected_env->>'event_version')::smallint <> NEW.event_version
           OR expected_env->'payload' <> NEW.payload THEN
          RAISE EXCEPTION USING ERRCODE = 'PMA08',
            MESSAGE = 'SETTLEMENT permit envelope mismatch at cursor ' || active_adj.settlement_permit_cursor;
        END IF;

        is_tail := (active_adj.settlement_permit_cursor + 1 = jsonb_array_length(active_adj.settlement_permit_envelopes));
        IF is_tail THEN
          NEW.storage_tag := 'tail';
        ELSE
          NEW.storage_tag := 'settling';
        END IF;

        UPDATE game_adjudications
          SET settlement_permit_cursor = settlement_permit_cursor + 1
          WHERE game_id = NEW.game_id AND operation_id = active_adj.operation_id;

        RETURN NEW;
      END IF;
    END IF;

    -- If active adjudication exists without matching settlement permit: reject!
    IF has_active_adj THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA09',
        MESSAGE = 'Unpermitted event rejected while adjudication is active';
    END IF;

    -- Check if game has a current stop
    IF EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id AND is_current_stop = true) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA10',
        MESSAGE = 'Raw event insert rejected while game is in managed stopped state';
    END IF;

    -- Check if completed adjudication was settled in the current transaction (reject post-tail piggyback)
    IF EXISTS (
      SELECT 1 FROM game_adjudications
      WHERE game_id = NEW.game_id AND execution_state = 'completed' AND settlement_permit_xact_id = cur_xact
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMA23',
        MESSAGE = 'Cannot insert events in same transaction after settlement tail';
    END IF;
  END IF;

  -- Classify event stream using original columns only
  stream_status := adjudication_classify_stream(NEW.game_id, cur_xact);

  IF stream_status = 'terminal' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA11',
      MESSAGE = 'Cannot insert events into a terminated game';
  ELSIF stream_status = 'managed_observed_release' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA10',
      MESSAGE = 'Raw event insert rejected while game is in managed stopped state';
  ELSIF stream_status = 'proving' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA09',
      MESSAGE = 'Unpermitted event rejected while adjudication is active';
  ELSIF stream_status = 'same_xid_settlement' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA23',
      MESSAGE = 'Cannot insert events in same transaction after settlement tail';
  ELSIF stream_status = 'ambiguous' THEN
    RAISE EXCEPTION USING ERRCODE = 'PMA24',
      MESSAGE = 'Unpermitted event rejected: ambiguous or unresolved adjudication history';
  ELSIF stream_status = 'ordinary_legacy' OR stream_status = 'legacy_null_policy_completed' THEN
    NEW.storage_tag := NULL;
    RETURN NEW;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'PMA25',
      MESSAGE = 'Unpermitted event rejected by storage classifier: ' || stream_status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_events_adjudication_guard
  BEFORE INSERT ON game_events
  FOR EACH ROW
  EXECUTE FUNCTION game_events_adjudication_guard();

-- Step 5: AFTER trigger to reconcile deadline queues for managed, proving, or terminal games
CREATE OR REPLACE FUNCTION z_adjudication_queue_reconcile() RETURNS trigger AS $$
DECLARE
  has_adj_table_priv BOOLEAN;
  should_suppress BOOLEAN := false;
  stream_status TEXT;
BEGIN
  has_adj_table_priv := has_table_privilege(current_user, 'public.game_adjudications', 'SELECT');

  IF has_adj_table_priv THEN
    SELECT (
      EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id AND execution_state <> 'completed')
      OR EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = NEW.game_id AND is_current_stop = true)
      OR (NEW.type = 'GameEnded' OR EXISTS (SELECT 1 FROM game_events WHERE game_id = NEW.game_id AND type = 'GameEnded'))
    ) INTO should_suppress;
  ELSE
    stream_status := adjudication_classify_stream(NEW.game_id, pg_current_xact_id());
    IF stream_status IN ('terminal', 'managed_observed_release', 'proving', 'same_xid_settlement') THEN
      should_suppress := true;
    ELSIF NEW.type = 'GameEnded' THEN
      should_suppress := true;
    ELSE
      should_suppress := false;
    END IF;
  END IF;

  IF should_suppress THEN
    DELETE FROM pregame_deadlines WHERE game_id = NEW.game_id;
    DELETE FROM flag_deadlines WHERE game_id = NEW.game_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER z_adjudication_queue_reconcile
  AFTER INSERT ON game_events
  FOR EACH ROW
  EXECUTE FUNCTION z_adjudication_queue_reconcile();

-- Step 6: Deferred invariant validator at COMMIT
CREATE OR REPLACE FUNCTION adjudication_deferred_validator() RETURNS trigger AS $$
DECLARE
  chk_game_id UUID;
  has_adj_table_priv BOOLEAN;
  stream_status TEXT;
  adj RECORD;
  has_terminal BOOLEAN;
  cur_stop_count INTEGER;
  latest_completed RECORD;
  has_latest_completed BOOLEAN := false;
  head_seq INTEGER;
  i INTEGER;
  batch_env JSONB;
BEGIN
  chk_game_id := NEW.game_id;

  PERFORM pg_advisory_xact_lock(hashtextextended('rocky:game-adjudication:' || chk_game_id::text, 0));

  has_adj_table_priv := has_table_privilege(current_user, 'public.game_adjudications', 'SELECT');

  IF NOT has_adj_table_priv THEN
    stream_status := adjudication_classify_stream(chk_game_id, pg_current_xact_id());
    IF stream_status = 'terminal' THEN
      IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = chk_game_id)
         OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = chk_game_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD10',
          MESSAGE = 'Deadlines must be suppressed for terminal game';
      END IF;
    ELSIF stream_status IN ('proving', 'managed_observed_release', 'same_xid_settlement', 'ambiguous') THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD20',
        MESSAGE = 'Unpermitted adjudication stream state at commit for legacy caller: ' || stream_status;
    END IF;
    RETURN NEW;
  END IF;

  -- Privileged M execution path:
  -- Reject any committed settling state
  IF EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = chk_game_id AND execution_state = 'settling') THEN
    RAISE EXCEPTION USING ERRCODE = 'PMD01',
      MESSAGE = 'Committed settling state is prohibited';
  END IF;

  -- Affected operation validation
  IF TG_TABLE_NAME = 'game_adjudications' THEN
    adj := NEW;
    IF adj.execution_state = 'proving' THEN
      IF NOT adj.start_permit_consumed THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD02',
          MESSAGE = 'Proving adjudication without consumed START permit';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM game_events
        WHERE game_id = chk_game_id AND seq = adj.started_seq
          AND type = adj.started_type AND event_version = adj.started_version
          AND payload = adj.started_payload
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD03',
          MESSAGE = 'Proving adjudication without exact Started event in game_events';
      END IF;

      SELECT COALESCE(MAX(seq), -1) INTO head_seq FROM game_events WHERE game_id = chk_game_id;
      IF head_seq > adj.started_seq THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD04',
          MESSAGE = 'Proving adjudication has subsequent events in game_events';
      END IF;

      IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = chk_game_id)
         OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = chk_game_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD05',
          MESSAGE = 'Deadlines must be suppressed while adjudication is proving';
      END IF;
    ELSIF adj.execution_state = 'completed' THEN
      IF adj.final_seq IS NULL OR adj.settlement_receipt IS NULL OR adj.settlement_batch IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD06',
          MESSAGE = 'Completed adjudication missing receipt, batch or final_seq';
      END IF;
      IF adj.settlement_permit_cursor IS DISTINCT FROM jsonb_array_length(adj.settlement_permit_envelopes) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD07',
          MESSAGE = 'Completed adjudication did not consume entire settlement permit batch';
      END IF;
      IF adj.final_seq <> adj.started_seq + jsonb_array_length(adj.settlement_batch) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD08',
          MESSAGE = 'Completed adjudication final_seq mismatch with batch length';
      END IF;
      IF adj.settlement_receipt->>'gameId' <> chk_game_id::text
         OR adj.settlement_receipt->>'operationId' <> adj.operation_id::text
         OR (adj.settlement_receipt->>'startedSeq')::integer <> adj.started_seq
         OR (adj.settlement_receipt->>'finalSeq')::integer <> adj.final_seq
         OR (adj.settlement_receipt->>'eventCount')::integer <> jsonb_array_length(adj.settlement_batch) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD15',
          MESSAGE = 'Completed adjudication settlement receipt mismatch';
      END IF;

      -- Validate exact contiguous event suffix in game_events (envelope, version, and payload)
      FOR i IN 0..(jsonb_array_length(adj.settlement_batch) - 1) LOOP
        batch_env := adj.settlement_batch->i;
        IF NOT EXISTS (
          SELECT 1 FROM game_events
          WHERE game_id = chk_game_id
            AND seq = adj.started_seq + 1 + i
            AND type = batch_env->>'type'
            AND event_version = 1
            AND payload = batch_env
        ) THEN
          RAISE EXCEPTION USING ERRCODE = 'PMD14',
            MESSAGE = 'Completed adjudication event suffix mismatch with game_events at seq ' || (adj.started_seq + 1 + i);
        END IF;
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'game_events' THEN
    IF NEW.storage_tag = 'started' THEN
      SELECT * INTO adj FROM game_adjudications WHERE game_id = chk_game_id AND started_seq = NEW.seq;
      IF NOT FOUND OR adj.execution_state <> 'proving' OR NOT adj.start_permit_consumed THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD02',
          MESSAGE = 'Started tag without valid proving adjudication';
      END IF;
      SELECT COALESCE(MAX(seq), -1) INTO head_seq FROM game_events WHERE game_id = chk_game_id;
      IF head_seq > adj.started_seq THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD04',
          MESSAGE = 'Proving adjudication has subsequent events in game_events';
      END IF;
    ELSIF NEW.storage_tag IN ('settling', 'tail') THEN
      SELECT * INTO adj FROM game_adjudications
        WHERE game_id = chk_game_id AND started_seq < NEW.seq AND (final_seq IS NULL OR final_seq >= NEW.seq)
        ORDER BY started_seq DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD16',
          MESSAGE = 'Settlement tag without matching adjudication record';
      END IF;
      IF adj.execution_state = 'completed' THEN
        FOR i IN 0..(jsonb_array_length(adj.settlement_batch) - 1) LOOP
          batch_env := adj.settlement_batch->i;
          IF NOT EXISTS (
            SELECT 1 FROM game_events
            WHERE game_id = chk_game_id
              AND seq = adj.started_seq + 1 + i
              AND type = batch_env->>'type'
              AND event_version = 1
              AND payload = batch_env
          ) THEN
            RAISE EXCEPTION USING ERRCODE = 'PMD14',
              MESSAGE = 'Completed adjudication event suffix mismatch with game_events at seq ' || (adj.started_seq + 1 + i);
          END IF;
        END LOOP;
      END IF;
    ELSIF NEW.storage_tag IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM game_adjudications
        WHERE game_id = chk_game_id AND execution_state = 'proving' AND started_seq < NEW.seq
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'PMD04',
          MESSAGE = 'Proving adjudication has subsequent events in game_events';
      END IF;
    END IF;
  END IF;

  -- Validate stop and deadline boundary invariants
  SELECT (NEW.type = 'GameEnded' OR EXISTS (SELECT 1 FROM game_events WHERE game_id = chk_game_id AND type = 'GameEnded')) INTO has_terminal;
  SELECT COUNT(*) INTO cur_stop_count FROM game_adjudications WHERE game_id = chk_game_id AND is_current_stop = true;

  IF has_terminal THEN
    IF cur_stop_count > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD09',
        MESSAGE = 'Terminal game cannot retain a current stop';
    END IF;
    IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = chk_game_id)
       OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = chk_game_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'PMD10',
        MESSAGE = 'Deadlines must be suppressed for terminal game';
    END IF;
  ELSE
    SELECT * INTO latest_completed FROM game_adjudications
      WHERE game_id = chk_game_id AND execution_state = 'completed'
      ORDER BY started_seq DESC LIMIT 1;
    has_latest_completed := FOUND;

    IF has_latest_completed AND latest_completed.clock_policy = 'observed-release-v1' THEN
      IF NOT EXISTS (SELECT 1 FROM game_adjudications WHERE game_id = chk_game_id AND execution_state = 'proving') THEN
        IF cur_stop_count <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = 'PMD11',
            MESSAGE = 'Managed nonterminal idle game requires exactly one current stop, got ' || cur_stop_count;
        END IF;
        IF EXISTS (SELECT 1 FROM pregame_deadlines WHERE game_id = chk_game_id)
           OR EXISTS (SELECT 1 FROM flag_deadlines WHERE game_id = chk_game_id) THEN
          RAISE EXCEPTION USING ERRCODE = 'PMD12',
            MESSAGE = 'Deadlines must be suppressed for managed stopped game';
        END IF;
      ELSE
        IF cur_stop_count > 1 THEN
          RAISE EXCEPTION USING ERRCODE = 'PMD13',
            MESSAGE = 'Cannot have multiple current stops while proving';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER adjudication_deferred_validator_events
  AFTER INSERT ON game_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION adjudication_deferred_validator();

CREATE CONSTRAINT TRIGGER adjudication_deferred_validator_adjudications
  AFTER INSERT OR UPDATE ON game_adjudications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION adjudication_deferred_validator();
