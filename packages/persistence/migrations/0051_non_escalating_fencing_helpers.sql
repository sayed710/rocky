-- PG-F1 remains inactive. Forward-only security hardening of internal helpers:
-- direct EXECUTE (including named/default ACLs) must not confer table privileges.
-- SECURITY DEFINER entrypoints still invoke these as their trusted function owner.
-- ALTER preserves signatures, ownership, ACLs and pinned function search_path.
-- After preparation, a non-owner migration role skips executor-owned helpers:
-- re-run trusted prepareGameFencing to enforce INVOKER rights on those helpers.
-- Idempotent; no control, lease or legacy grants change. No activation.
-- Deliberately irreversible: restoring helper privilege escalation is not a rollback.
DO $hardening$
DECLARE
  helper regprocedure;
BEGIN
  SET LOCAL search_path = pg_catalog, public, pg_temp;
  FOREACH helper IN ARRAY ARRAY[
    'game_fencing.lock_control(uuid)'::regprocedure,
    'game_fencing.lock_grant(uuid)'::regprocedure,
    'game_fencing.validate_grant(game_fencing.grants,uuid,bigint,uuid,bytea,timestamp with time zone)'::regprocedure,
    'game_fencing.insert_batch(uuid,integer,jsonb,boolean)'::regprocedure
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      WHERE p.oid = helper AND (p.proowner = r.oid
        OR pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE') OR r.rolsuper)
    ) THEN
      EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', helper);
    ELSE
      RAISE NOTICE 'Skipping helper %: current role cannot alter it; re-run prepareGameFencing with trusted installation credentials', helper;
    END IF;
  END LOOP;
END
$hardening$;
