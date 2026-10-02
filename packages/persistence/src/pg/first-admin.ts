/**
 * @packageDocumentation
 * The first admin role on a fresh installation, granted by an operator (ADR-0152).
 *
 * `POST /v1/users/:userId/roles` needs an admin, so the very first one has to come from somewhere
 * else. This is that somewhere: an operator with direct database access names an existing human
 * account by id. It never creates an account or a credential, never promotes a bot, and refuses as
 * soon as any admin exists — every later grant goes through the authenticated API. There is no
 * force option.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '../ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A printable label naming the person who ran the command, recorded in the audit row. */
const OPERATOR = /^[A-Za-z0-9._@-]{1,64}$/;

export type FirstAdminOutcome =
  | { readonly kind: 'granted'; readonly userId: string; readonly auditId: string }
  | { readonly kind: 'refused'; readonly reason: 'admin_exists' | 'unknown_user' | 'bot_account' };

/**
 * Grant `userId` the admin role if, and only if, no admin exists yet.
 *
 * The roles table is locked in SHARE ROW EXCLUSIVE mode for the whole check-then-insert: that mode
 * conflicts with itself and with every INSERT/UPDATE/DELETE, so two operators racing for different
 * accounts serialize, and the second sees the first one's admin and refuses. The role and its audit
 * row commit together or not at all.
 */
export async function bootstrapFirstAdmin(pool: Pool, rawUserId: string, operator: string): Promise<FirstAdminOutcome> {
  if (!UUID.test(rawUserId)) throw new Error('a valid user UUID is required');
  const userId = rawUserId.toLowerCase();
  if (!OPERATOR.test(operator)) throw new Error('operator must be 1-64 characters of A-Z a-z 0-9 . _ @ -');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Behind a stuck roles writer, fail fast instead of queueing every later roles write behind us.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE roles IN SHARE ROW EXCLUSIVE MODE');
    const refuse = async (reason: 'admin_exists' | 'unknown_user' | 'bot_account'): Promise<FirstAdminOutcome> => {
      await client.query('ROLLBACK');
      return { kind: 'refused', reason };
    };
    if ((await client.query(`SELECT 1 FROM roles WHERE role = 'admin' LIMIT 1`)).rowCount) return await refuse('admin_exists');
    const user = (await client.query<{ bot: boolean }>(
      `SELECT COALESCE(flags->>'bot' = 'true', false) AS bot FROM users WHERE id = $1 FOR KEY SHARE`, [userId],
    )).rows[0];
    if (!user) return await refuse('unknown_user');
    if (user.bot) return await refuse('bot_account');
    await client.query(`INSERT INTO roles (user_id, role) VALUES ($1, 'admin')`, [userId]);
    const auditId = uuidv7();
    await client.query(
      `INSERT INTO audit_log (id, actor_id, action, target, meta)
       VALUES ($1, NULL, 'roles.bootstrap_first_admin', $2,
               jsonb_build_object('role', 'admin', 'source', 'operator-cli', 'operator', $3::text,
                                  'databaseUser', current_user, 'database', current_database()))`,
      [auditId, userId, operator],
    );
    await client.query('COMMIT');
    return { kind: 'granted', userId, auditId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
