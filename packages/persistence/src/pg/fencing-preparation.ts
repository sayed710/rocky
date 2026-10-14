/** Privileged, explicitly invoked PG-F1 preparation. NEVER imported by startup.
 * Does not create roles, grant runtime EXECUTE, modify legacy grants, or activate
 * enforcement. Operator supplies separately provisioned trusted NOLOGIN roles.
 */
import type { Pool } from 'pg';
import { PersistenceError } from '../errors';

const FENCING_FUNCTIONS=new Set([
  'game_fencing.lock_control(uuid)',
  'game_fencing.lock_grant(uuid)',
  'game_fencing.validate_grant(game_fencing.grants,uuid,bigint,uuid,bytea,timestamp with time zone)',
  'game_fencing.acquire(uuid,uuid,bigint,uuid,bytea,integer)',
  'game_fencing.renew(uuid,uuid,bigint,uuid,bytea,integer)',
  'game_fencing.release(uuid,uuid,bigint,uuid,bytea)',
  'game_fencing.insert_batch(uuid,integer,jsonb,boolean)',
  'game_fencing.append_events(uuid,uuid,bigint,uuid,bytea,integer,jsonb)',
  'game_fencing.create_stream(uuid,uuid,jsonb)',
]);

export interface FencingPreparation {
  readonly tableOwner: string;
  readonly functionOwner: string;
  readonly databaseIncarnation: string;
  readonly maxLeaseMs: number;
}

/** Identifier interpolation occurs only in this trusted installer, never in
 * protected functions. Conservative identifiers and catalog signatures only.
 */
function roleName(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new PersistenceError('invalid fencing owner role');
  return `"${value}"`;
}

/** Backfill is explicit: legacy games created after migration remain unseeded
 * until this is rerun. ON CONFLICT never resets a live or released epoch.
 */
export async function seedGameFencing(pool: Pool): Promise<number> {
  const result=await pool.query(`INSERT INTO game_fencing.grants(game_id)
    SELECT DISTINCT game_id FROM public.game_events ORDER BY game_id ON CONFLICT DO NOTHING`);
  return result.rowCount ?? 0;
}

/** Run only with dedicated trusted installation credentials in an isolated or
 * explicitly authorized environment. Recovery rotation requires fleet isolation;
 * PG-F1 does not automate it. Epochs remain unchanged across namespace rotation.
 */
export async function prepareGameFencing(pool: Pool,config: FencingPreparation): Promise<void> {
  const owner=roleName(config.tableOwner),executor=roleName(config.functionOwner);
  if (owner===executor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.databaseIncarnation)
      || !Number.isInteger(config.maxLeaseMs) || config.maxLeaseMs<=0 || config.maxLeaseMs>2147483647)
    throw new PersistenceError('explicit fencing ownership, incarnation and lease policy required');
  const client=await pool.connect();
  let safeToReuse=false;
  try {
    await client.query('BEGIN');
    const roles=await client.query<{ rolname: string; safe: boolean }>(`SELECT rolname,
      NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe
      FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,[[config.tableOwner,config.functionOwner]]);
    if (roles.rows.length!==2 || !roles.rows.every(role=>role.safe)) throw new PersistenceError('unsafe fencing ownership roles');
    // Neither role may be assumable by any non-superuser member, even NOINHERIT:
    // SET ROLE is sufficient to bypass otherwise correct function ACLs.
    const memberships=await client.query(`SELECT 1 FROM pg_catalog.pg_roles member
      WHERE NOT member.rolsuper AND member.rolname <> ALL($1::text[])
      AND (pg_catalog.pg_has_role(member.oid,$2::name,'MEMBER') OR pg_catalog.pg_has_role(member.oid,$3::name,'MEMBER'))`,
      [[config.tableOwner,config.functionOwner],config.tableOwner,config.functionOwner]);
    if (memberships.rowCount) throw new PersistenceError('fencing owners must have no untrusted members');
    const publicCreate=await client.query(`SELECT 1 FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.rolname <> 'pg_database_owner'
        AND r.oid <> (SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database())
        AND pg_catalog.has_schema_privilege(r.oid,'public','CREATE')`);
    if (publicCreate.rowCount) throw new PersistenceError('legacy trigger search path requires trusted public schema');
    const privateAccess=await client.query(`SELECT 1 FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.rolname <> SESSION_USER AND r.rolname <> ALL($1::text[])
      AND (r.rolcanlogin OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles login
        WHERE login.rolcanlogin AND NOT login.rolsuper AND login.rolname <> SESSION_USER
          AND pg_catalog.pg_has_role(login.oid,r.oid,'MEMBER')))
      AND (pg_catalog.has_schema_privilege(r.oid,'game_fencing','CREATE')
        OR pg_catalog.has_table_privilege(r.oid,'game_fencing.grants','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(r.oid,'game_fencing.grants','SELECT,INSERT,UPDATE,REFERENCES')
        OR pg_catalog.has_table_privilege(r.oid,'game_fencing.control','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(r.oid,'game_fencing.control','SELECT,INSERT,UPDATE,REFERENCES'))`,
      [[config.tableOwner,config.functionOwner]]);
    if (privateAccess.rowCount) throw new PersistenceError('unsafe private fencing privileges');
    await client.query('SELECT singleton FROM game_fencing.control WHERE singleton FOR UPDATE');
    await client.query(`ALTER SCHEMA game_fencing OWNER TO ${owner};
      ALTER TABLE game_fencing.control OWNER TO ${owner}; ALTER TABLE game_fencing.grants OWNER TO ${owner};
      REVOKE ALL ON SCHEMA game_fencing FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA game_fencing FROM PUBLIC;
      GRANT USAGE ON SCHEMA game_fencing TO ${executor};
      GRANT SELECT,INSERT,UPDATE ON game_fencing.grants TO ${executor};
      GRANT SELECT,UPDATE(singleton) ON game_fencing.control TO ${executor};
      GRANT SELECT,INSERT ON public.game_events TO ${executor};
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.pregame_deadlines,public.flag_deadlines TO ${executor};
      GRANT EXECUTE ON FUNCTION public.flag_deadline_ms(uuid,jsonb),public.flag_deadline_number(jsonb) TO ${executor};`);
    const functions=await client.query<{ signature: string }>(`SELECT p.oid::regprocedure::text AS signature
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='game_fencing'`);
    if (functions.rows.length!==FENCING_FUNCTIONS.size || functions.rows.some(fn=>!FENCING_FUNCTIONS.has(fn.signature)))
      throw new PersistenceError('unexpected fencing function signature');
    for (const fn of functions.rows) {
      await client.query(`ALTER FUNCTION ${fn.signature} OWNER TO ${executor}; REVOKE ALL ON FUNCTION ${fn.signature} FROM PUBLIC`);
      // Re-preparation/rotation also withholds previous explicit/default-ACL
      // execution on NEW functions. Legacy writer permissions are untouched.
      const grantees=await client.query<{ role: string }>(`SELECT DISTINCT pg_get_userbyid(a.grantee) AS role
        FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.oid=$1::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner`,[fn.signature]);
      for (const grantee of grantees.rows) await client.query(`REVOKE ALL ON FUNCTION ${fn.signature} FROM ${roleName(grantee.role)}`);
    }
    const result=await client.query(`UPDATE game_fencing.control SET database_incarnation=$1,max_lease_ms=$2
      WHERE singleton AND NOT enforced`,[config.databaseIncarnation,config.maxLeaseMs]);
    if (result.rowCount!==1) throw new PersistenceError('missing or incompatible fencing control');
    await client.query('COMMIT'); safeToReuse=true;
  } catch (error) {
    try { await client.query('ROLLBACK'); safeToReuse=true; } catch { /* discard uncertain installer client */ }
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('fencing preparation failed; inspect trusted installation state before retry');
  } finally { client.release(!safeToReuse); }
}
