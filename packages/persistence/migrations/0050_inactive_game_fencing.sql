-- PG-F1 only (ADR-0162): additive, INACTIVE protected boundary. No runtime grants,
-- roles, legacy privilege revocation, event rewrites or automatic restore behavior.
-- Explicit privileged preparation is required before even test-only execution.
CREATE SCHEMA game_fencing;
REVOKE ALL ON SCHEMA game_fencing FROM PUBLIC;

CREATE TABLE game_fencing.control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  database_incarnation UUID,
  max_lease_ms INTEGER CHECK (max_lease_ms > 0),
  enforced BOOLEAN NOT NULL DEFAULT false CHECK (NOT enforced),
  CHECK ((database_incarnation IS NULL) = (max_lease_ms IS NULL))
);
INSERT INTO game_fencing.control (singleton) VALUES (true);

-- Independent of asynchronous projections. Ordinary release never deletes a row.
CREATE TABLE game_fencing.grants (
  game_id UUID PRIMARY KEY,
  epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  active BOOLEAN NOT NULL DEFAULT false,
  database_incarnation UUID,
  owner_principal NAME,
  owner_incarnation UUID,
  capability_hash BYTEA,
  lease_until TIMESTAMPTZ,
  CHECK (
    (NOT active AND database_incarnation IS NULL AND owner_principal IS NULL
      AND owner_incarnation IS NULL AND capability_hash IS NULL AND lease_until IS NULL)
    OR (active AND epoch > 0 AND database_incarnation IS NOT NULL AND owner_principal IS NOT NULL
      AND owner_incarnation IS NOT NULL AND capability_hash IS NOT NULL
      AND octet_length(capability_hash) = 32 AND lease_until IS NOT NULL AND isfinite(lease_until))
  )
);
REVOKE ALL ON ALL TABLES IN SCHEMA game_fencing FROM PUBLIC;
INSERT INTO game_fencing.grants (game_id)
  SELECT DISTINCT game_id FROM public.game_events ORDER BY game_id ON CONFLICT DO NOTHING;

-- Control SHARE is held through COMMIT: explicit recovery rotation uses UPDATE.
-- Helpers are also private; neither principal identity nor authority comes from GUCs.
CREATE FUNCTION game_fencing.lock_control(expected_incarnation UUID)
RETURNS game_fencing.control LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c game_fencing.control; login_role RECORD; executor RECORD;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='read committed transaction required';
  END IF;
  SELECT * INTO login_role FROM pg_catalog.pg_roles WHERE rolname = SESSION_USER;
  SELECT * INTO executor FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER;
  IF login_role.rolsuper OR login_role.rolcreaterole OR login_role.rolcreatedb
     OR login_role.rolreplication OR login_role.rolbypassrls
     OR executor.rolcanlogin OR executor.rolsuper OR executor.rolcreaterole
     OR executor.rolcreatedb OR executor.rolreplication OR executor.rolbypassrls
     OR pg_catalog.has_schema_privilege(CURRENT_USER, 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege(CURRENT_USER, 'game_fencing', 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN
       ('game_fencing.control'::regclass,'game_fencing.grants'::regclass,'public.game_events'::regclass)
       AND relowner=executor.oid)
     OR pg_catalog.pg_has_role(SESSION_USER, CURRENT_USER, 'MEMBER')
     OR pg_catalog.has_schema_privilege(SESSION_USER, 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege(SESSION_USER, 'game_fencing', 'CREATE') THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='unsafe fencing role configuration';
  END IF;
  IF current_setting('log_parameter_max_length') <> '0'
     OR current_setting('log_parameter_max_length_on_error') <> '0' THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='fencing parameter logging must be disabled';
  END IF;
  SELECT * INTO c FROM game_fencing.control WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.database_incarnation IS NULL OR c.max_lease_ms IS NULL
     OR expected_incarnation IS NULL OR expected_incarnation <> c.database_incarnation THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='fencing control absent or obsolete';
  END IF;
  RETURN c;
END;
$$;

CREATE FUNCTION game_fencing.lock_grant(game UUID)
RETURNS game_fencing.grants LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g game_fencing.grants;
BEGIN
  SELECT * INTO g FROM game_fencing.grants WHERE game_id=game FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='game grant absent';
  END IF;
  RETURN g;
END;
$$;

CREATE FUNCTION game_fencing.validate_grant(g game_fencing.grants, db UUID,
  generation BIGINT, process UUID, capability BYTEA, fresh_time TIMESTAMPTZ)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF generation IS NULL OR process IS NULL OR capability IS NULL OR octet_length(capability) <> 32
     OR NOT g.active OR g.database_incarnation IS DISTINCT FROM db
     OR g.epoch IS DISTINCT FROM generation OR g.owner_incarnation IS DISTINCT FROM process
     OR g.owner_principal IS DISTINCT FROM SESSION_USER
     OR g.capability_hash IS DISTINCT FROM pg_catalog.sha256(capability)
     OR g.lease_until <= fresh_time THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='grant rejected';
  END IF;
END;
$$;

-- The caller generates 32 cryptographically random bytes once per acquisition
-- intent. Lost replies may recover ONLY that same still-live acquisition.
CREATE FUNCTION game_fencing.acquire(game UUID, db UUID, expected_epoch BIGINT,
  process UUID, capability BYTEA, lease_ms INTEGER)
RETURNS TABLE (epoch BIGINT, lease_until TIMESTAMPTZ) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c game_fencing.control; g game_fencing.grants; fresh TIMESTAMPTZ; expiry TIMESTAMPTZ;
BEGIN
  c := game_fencing.lock_control(db);
  g := game_fencing.lock_grant(game);
  fresh := pg_catalog.clock_timestamp();
  IF expected_epoch IS NULL OR expected_epoch < 0 OR process IS NULL OR capability IS NULL
     OR octet_length(capability) <> 32 OR lease_ms IS NULL OR lease_ms <= 0 OR lease_ms > c.max_lease_ms THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='invalid acquisition';
  END IF;
  IF g.active AND g.database_incarnation = db AND g.lease_until > fresh THEN
    IF g.epoch = expected_epoch + 1::numeric AND g.owner_principal = SESSION_USER
       AND g.owner_incarnation = process AND g.capability_hash = pg_catalog.sha256(capability) THEN
      RETURN QUERY SELECT g.epoch, g.lease_until;
      RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='live grant already held';
  END IF;
  IF g.epoch <> expected_epoch OR g.epoch = 9223372036854775807 THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='grant epoch conflict or exhaustion';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.game_events WHERE game_id=game AND seq=0 AND type='GameCreated') THEN
    RAISE EXCEPTION USING ERRCODE='PFG01', MESSAGE='existing stream required';
  END IF;
  expiry := fresh + lease_ms * interval '1 millisecond';
  UPDATE game_fencing.grants SET epoch=g.epoch+1, active=true, database_incarnation=db,
    owner_principal=SESSION_USER, owner_incarnation=process, capability_hash=pg_catalog.sha256(capability),
    lease_until=expiry WHERE game_id=game;
  RETURN QUERY SELECT g.epoch+1, expiry;
END;
$$;

CREATE FUNCTION game_fencing.renew(game UUID, db UUID, generation BIGINT, process UUID,
  capability BYTEA, lease_ms INTEGER)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c game_fencing.control; g game_fencing.grants; fresh TIMESTAMPTZ; expiry TIMESTAMPTZ;
BEGIN
  c := game_fencing.lock_control(db);
  g := game_fencing.lock_grant(game);
  fresh := pg_catalog.clock_timestamp();
  PERFORM game_fencing.validate_grant(g, db, generation, process, capability, fresh);
  IF lease_ms IS NULL OR lease_ms <= 0 OR lease_ms > c.max_lease_ms THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='invalid renewal duration';
  END IF;
  expiry := greatest(g.lease_until, fresh + lease_ms * interval '1 millisecond');
  UPDATE game_fencing.grants SET lease_until=expiry WHERE game_id=game;
  RETURN expiry;
END;
$$;

CREATE FUNCTION game_fencing.release(game UUID, db UUID, generation BIGINT, process UUID, capability BYTEA)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g game_fencing.grants;
BEGIN
  PERFORM game_fencing.lock_control(db);
  g := game_fencing.lock_grant(game);
  PERFORM game_fencing.validate_grant(g, db, generation, process, capability, pg_catalog.clock_timestamp());
  UPDATE game_fencing.grants SET active=false, database_incarnation=NULL, owner_principal=NULL,
    owner_incarnation=NULL, capability_hash=NULL, lease_until=NULL WHERE game_id=game;
END;
$$;

-- Whole-batch shape validation occurs before any insertion. Domain replay remains
-- a caller responsibility; this is an authority/sequence boundary, not chess validation.
CREATE FUNCTION game_fencing.insert_batch(game UUID, head INTEGER, batch JSONB, creating BOOLEAN)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE item JSONB; count BIGINT; position BIGINT := 0;
BEGIN
  IF batch IS NULL OR jsonb_typeof(batch) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='event batch must be an array';
  END IF;
  count := jsonb_array_length(batch);
  IF count = 0 OR head::bigint + count > 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='empty batch or event sequence exhaustion';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(batch) LOOP
    IF jsonb_typeof(item) <> 'object' OR jsonb_typeof(item->'type') IS DISTINCT FROM 'string'
       OR length(item->>'type') = 0 OR jsonb_typeof(item->'payload') IS DISTINCT FROM 'object'
       OR item->'payload'->>'type' IS DISTINCT FROM item->>'type'
       OR item->'version' IS DISTINCT FROM '1'::jsonb
       OR (creating AND position=0 AND (item->>'type' <> 'GameCreated'
         OR item->'payload'->>'gameId' IS DISTINCT FROM game::text))
       OR ((NOT creating OR position>0) AND item->>'type' = 'GameCreated') THEN
      RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='invalid event batch';
    END IF;
    position := position+1;
  END LOOP;
  position := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(batch) LOOP
    position := position+1;
    INSERT INTO public.game_events (game_id,seq,type,event_version,payload)
      VALUES (game, (head::bigint+position)::integer, item->>'type', 1, item->'payload');
  END LOOP;
  RETURN (head::bigint+count)::integer;
END;
$$;

CREATE FUNCTION game_fencing.append_events(game UUID, db UUID, generation BIGINT, process UUID,
  capability BYTEA, expected_head INTEGER, batch JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g game_fencing.grants; head INTEGER; count BIGINT;
BEGIN
  PERFORM game_fencing.lock_control(db);
  g := game_fencing.lock_grant(game);
  PERFORM game_fencing.validate_grant(g, db, generation, process, capability, pg_catalog.clock_timestamp());
  SELECT max(seq), count(*) INTO head,count FROM public.game_events WHERE game_id=game;
  IF head IS NULL OR count <> head::bigint+1
     OR NOT EXISTS (SELECT 1 FROM public.game_events WHERE game_id=game AND seq=0 AND type='GameCreated') THEN
    RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='missing or noncontiguous stream';
  END IF;
  IF expected_head IS NULL OR expected_head < 0 OR head <> expected_head THEN
    RAISE EXCEPTION USING ERRCODE='PFH01', MESSAGE='event head conflict';
  END IF;
  RETURN game_fencing.insert_batch(game,head,batch,false);
END;
$$;

CREATE FUNCTION game_fencing.create_stream(game UUID, db UUID, batch JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g game_fencing.grants;
BEGIN
  PERFORM game_fencing.lock_control(db);
  IF game IS NULL THEN RAISE EXCEPTION USING ERRCODE='PFV01', MESSAGE='game identity required'; END IF;
  INSERT INTO game_fencing.grants (game_id) VALUES (game) ON CONFLICT DO NOTHING;
  g := game_fencing.lock_grant(game);
  IF g.epoch <> 0 OR g.active OR EXISTS (SELECT 1 FROM public.game_events WHERE game_id=game) THEN
    RAISE EXCEPTION USING ERRCODE='PFH01', MESSAGE='create-only stream already exists';
  END IF;
  RETURN game_fencing.insert_batch(game,-1,batch,true);
END;
$$;

-- No implicit PUBLIC execution, including helpers. A controlled installer changes
-- ownership; it never grants these functions to a production runtime role in PG-F1.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA game_fencing FROM PUBLIC;
