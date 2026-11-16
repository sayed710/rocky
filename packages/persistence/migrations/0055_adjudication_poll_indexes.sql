-- Migration 0055 — ordered poll indexes for adjudication worker (Issue #124; unwired, extends 0053/0054).
--
-- Qodo finding 43f5378b-fe11-4b5e-b4a9-869f5d81f5f5:
--   listClaimableAdjudications orders eligible proving operations by (created_at, game_id)
--   listReleasableStops orders current stops by (completed_at, game_id)
--
-- The existing partial unique indexes from 0053 (game_adjudications_one_active_idx and
-- game_adjudications_one_current_stop_idx) index on (game_id) only to guarantee single-active
-- and single-current-stop semantics per game. They do not supply index ordering.
--
-- These additive partial indexes make matching ordered index scans available to the worker
-- polling loops for queries ordering by (created_at, game_id) and (completed_at, game_id).
-- The cost-based planner remains free to select an ordered index scan, bitmap scan, or sequential
-- scan based on table statistics and workload cost.
-- Time-dependent filters (clock_timestamp()) are evaluated during index scan and cannot
-- appear in index predicates.
--
-- Applied transactionally following the migration runner convention for additive tables.

CREATE INDEX game_adjudications_claimable_poll_idx
  ON public.game_adjudications (created_at, game_id)
  WHERE execution_state = 'proving';

CREATE INDEX game_adjudications_releasable_poll_idx
  ON public.game_adjudications (completed_at, game_id)
  WHERE is_current_stop;
