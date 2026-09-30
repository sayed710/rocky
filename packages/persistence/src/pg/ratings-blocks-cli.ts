/**
 * @packageDocumentation
 * Operator CLI for sticky rating blocks. It can inspect or record a leave-blocked decision;
 * historical single-game retry is deliberately absent because it would reorder a Glicko chain.
 */
import { createPool } from './pool';

const RECOVERY = 'A historical blocked game cannot be retried alone after later ratings. Rebuild the entire affected pool in original ending order under an approved recovery plan.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = `game_id AS "gameId", error, blocked_at AS "blockedAt",
  disposition, disposition_by AS "dispositionBy", disposition_reason AS "dispositionReason",
  disposition_at AS "dispositionAt"`;

function requireGameId(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error('a valid game UUID is required');
  return value;
}

/** Parse one bounded, deliberately limited operator action. */
async function main(): Promise<void> {
  const [action, id, operator, ...reasonParts] = process.argv.slice(2);
  if (!['list', 'show', 'leave-blocked'].includes(action ?? '')) {
    throw new Error('usage: ratings:blocked list [after-game-id] | show <game-id> | leave-blocked <game-id> <operator> <reason>');
  }
  const pool = createPool();
  try {
    if (action === 'list') {
      const after = id === undefined ? '00000000-0000-0000-0000-000000000000' : requireGameId(id);
      const rows = (await pool.query(`SELECT ${FIELDS} FROM rating_blocked_games
        WHERE game_id > $1::uuid ORDER BY game_id LIMIT 101`, [after])).rows;
      const games = rows.slice(0, 100);
      console.log(JSON.stringify({ games, nextAfter: rows.length > 100 ? games.at(-1)!.gameId : null, recovery: RECOVERY }));
      return;
    }
    const gameId = requireGameId(id);
    if (action === 'show') {
      const row = (await pool.query(`SELECT ${FIELDS} FROM rating_blocked_games WHERE game_id = $1`, [gameId])).rows[0];
      if (!row) throw new Error(`game ${gameId} is not blocked`);
      console.log(JSON.stringify({ ...row, recovery: RECOVERY }));
      return;
    }
    const reason = reasonParts.join(' ').trim();
    if (!operator?.trim() || !reason) throw new Error('operator and nonempty reason are required');
    const row = (await pool.query(`UPDATE rating_blocked_games
      SET disposition = 'leave_blocked', disposition_by = $2, disposition_reason = $3, disposition_at = now()
      WHERE game_id = $1 AND disposition IS NULL RETURNING ${FIELDS}`, [gameId, operator.trim(), reason])).rows[0];
    if (!row) throw new Error(`game ${gameId} is not blocked or already has a disposition`);
    console.log(JSON.stringify({ ...row, recovery: RECOVERY }));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
