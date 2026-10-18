-- PG-F1 remains inactive. Forward-only security hardening of internal helpers:
-- direct EXECUTE (including named/default ACLs) must not confer table privileges.
-- SECURITY DEFINER entrypoints still invoke these as their trusted function owner.
-- ALTER preserves signatures, ownership, ACLs and pinned search_path; safe to rerun
-- before or after prepareGameFencing. No control, lease or legacy grants change.
-- Deliberately irreversible: restoring helper privilege escalation is not a rollback.
ALTER FUNCTION game_fencing.lock_control(uuid) SECURITY INVOKER;
ALTER FUNCTION game_fencing.lock_grant(uuid) SECURITY INVOKER;
ALTER FUNCTION game_fencing.validate_grant(game_fencing.grants,uuid,bigint,uuid,bytea,timestamp with time zone) SECURITY INVOKER;
ALTER FUNCTION game_fencing.insert_batch(uuid,integer,jsonb,boolean) SECURITY INVOKER;
