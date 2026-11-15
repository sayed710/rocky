/**
 * @packageDocumentation
 * Least-privilege ownership for the migration 0053 SECURITY DEFINER routines (Issue #124, ADR-0174).
 *
 * Migration 0053 leaves its trigger routines owned by the migration role, which owns the event tables
 * and can therefore ALTER, DROP or TRUNCATE them, disable their triggers, or write any table. A trusted
 * installer runs {@link prepareAdjudicationGuard} once to hand the routines to a dedicated NOLOGIN role
 * that holds exactly the table privileges the routines use and owns nothing, mirroring PG-F1's
 * `prepareGameFencing`. Like the migration it is explicit and never run by the application.
 */

import type { Pool, PoolClient } from 'pg';
import { PersistenceError } from '../errors';

/** Every SECURITY DEFINER routine migrations 0053 and 0054 install. */
export const ADJUDICATION_DEFINER_ROUTINES: readonly string[] = Object.freeze([
  'public.adjudication_deferred_validator()',
  'public.adjudication_mark_changed(uuid)',
  'public.adjudication_queue_validator()',
  'public.adjudication_restore_deadlines(uuid,integer)',
  'public.adjudication_validate_game(uuid)',
  'public.game_adjudication_releases_row_guard()',
  'public.game_adjudications_restore_queues()',
  'public.game_adjudications_row_guard()',
  'public.game_events_adjudication_guard()',
  'public.z_adjudication_queue_reconcile()',
]);

/** Exactly what the routines read and write, and nothing else. */
const GUARD_GRANTS = (owner: string): string => `
  GRANT USAGE ON SCHEMA public TO ${owner};
  GRANT SELECT ON public.game_events TO ${owner};
  GRANT SELECT, UPDATE ON public.game_adjudications TO ${owner};
  GRANT SELECT, INSERT, DELETE ON public.adjudication_validation_marks TO ${owner};
  GRANT SELECT, UPDATE ON public.game_adjudication_releases TO ${owner};
  GRANT SELECT, INSERT, DELETE ON public.pregame_deadlines, public.flag_deadlines TO ${owner};`;

export interface AdjudicationGuardPreparation {
  /** An existing NOLOGIN role, without attributes, members or owned objects. */
  readonly functionOwner: string;
}

function quotedRole(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new PersistenceError('invalid adjudication guard owner role');
  return `"${value}"`;
}

/** Refuse an owner that can log in, holds a role attribute, or can be assumed by another role. */
async function assertSafeRole(client: PoolClient, owner: string): Promise<void> {
  const role = await client.query<{ safe: boolean }>(
    `SELECT NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe
     FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [owner],
  );
  if (role.rows.length !== 1 || !role.rows[0]!.safe) throw new PersistenceError('unsafe adjudication guard owner role');
  const members = await client.query(
    `SELECT 1 FROM pg_catalog.pg_roles m
     WHERE NOT m.rolsuper AND m.rolname <> $1 AND pg_catalog.pg_has_role(m.oid, $1::name, 'MEMBER')`,
    [owner],
  );
  if (members.rowCount) throw new PersistenceError('adjudication guard owner must have no members');
  // Nor may it hold any membership itself: belonging to the table owner (even indirectly or
  // NOINHERIT, since SET ROLE suffices) would hand it the very rights this preparation removes.
  const memberships = await client.query(
    `SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname <> $1 AND pg_catalog.pg_has_role($1::name, r.oid, 'MEMBER')`,
    [owner],
  );
  if (memberships.rowCount) throw new PersistenceError('adjudication guard owner must belong to no other role');
}

/**
 * Only a superuser installer can transfer the routines to an owner that has neither CREATE on
 * `public` nor any member: PostgreSQL otherwise requires both of the new owner. Refuse up front.
 */
async function assertSuperuserInstaller(client: PoolClient): Promise<void> {
  const installer = await client.query<{ rolsuper: boolean }>(
    'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER',
  );
  if (!installer.rows[0]?.rolsuper) {
    throw new PersistenceError('adjudication guard preparation requires a superuser installer');
  }
}

/** Refuse an owner that already owns or can create objects: owning a table would undo the point. */
async function assertOwnsNothing(client: PoolClient, owner: string): Promise<void> {
  const owned = await client.query(
    `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner WHERE r.rolname = $1
     UNION ALL SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner WHERE r.rolname = $1
     UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
       WHERE r.rolname = $1 AND p.oid::regprocedure::text <> ALL($2::text[])`,
    // With search_path = pg_catalog, pg_temp the catalog renders these exactly as listed.
    [owner, ADJUDICATION_DEFINER_ROUTINES],
  );
  if (owned.rowCount) throw new PersistenceError('adjudication guard owner must own no other objects');
  const create = await client.query(
    "SELECT 1 WHERE pg_catalog.has_schema_privilege($1::name, 'public', 'CREATE')",
    [owner],
  );
  if (create.rowCount) throw new PersistenceError('adjudication guard owner must not create in public');
}

/** Hand one routine to the owner and leave nobody else able to execute it directly. */
async function transferRoutine(client: PoolClient, signature: string, owner: string): Promise<void> {
  const definer = await client.query<{ prosecdef: boolean }>(
    'SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure',
    [signature],
  );
  if (!definer.rows[0]?.prosecdef) throw new PersistenceError(`expected SECURITY DEFINER routine ${signature}`);
  await client.query(`ALTER FUNCTION ${signature} OWNER TO ${owner}; REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
  const grantees = await client.query<{ role: string }>(
    `SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee) AS role
     FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
     WHERE p.oid = $1::regprocedure AND a.grantee <> 0 AND a.grantee <> p.proowner`,
    [signature],
  );
  for (const g of grantees.rows) {
    await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM "${g.role.replace(/"/g, '""')}"`);
  }
}

/**
 * Transfer the 0053 SECURITY DEFINER routines to `functionOwner` with only the privileges they use.
 * Atomic and idempotent; requires a superuser installer and changes nothing when it refuses.
 */
export async function prepareAdjudicationGuard(pool: Pool, config: AdjudicationGuardPreparation): Promise<void> {
  const owner = quotedRole(config.functionOwner);
  const client = await pool.connect();
  let reusable = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
    await assertSuperuserInstaller(client);
    await assertSafeRole(client, config.functionOwner);
    await assertOwnsNothing(client, config.functionOwner);
    await client.query(GUARD_GRANTS(owner));
    for (const signature of ADJUDICATION_DEFINER_ROUTINES) await transferRoutine(client, signature, owner);
    await client.query('COMMIT');
    reusable = true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      reusable = true;
    } catch {
      /* discard an uncertain installer client */
    }
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('adjudication guard preparation failed; inspect installation state before retry');
  } finally {
    client.release(!reusable);
  }
}
