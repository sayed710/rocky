import type { PoolClient } from 'pg';

/**
 * Serializes writes concerning one unordered pair of players for the rest of the transaction.
 *
 * This lives in one file on purpose. The social graph and messaging adapters are separate
 * packages' concerns but they lock the *same* pairs, and messaging depends on that: sending a
 * message checks "is there a block between these two?" by reading `social_blocks` on a different
 * connection, which at READ COMMITTED can miss a block that commits a moment later. The only thing
 * that closes it is `block()` and `sendMessage()` queueing behind the same advisory lock — which
 * they do only while the key expression below is byte-identical in both call sites.
 *
 * It was duplicated once. Two copies of a lock key are two chances to change one of them and
 * silently lose the mutual exclusion, with no test failing and no error anywhere: the block check
 * simply starts reading stale rows again. Keeping it here makes that impossible rather than
 * unlikely.
 *
 * Callers must take this lock *before* any row lock they also need, or the two orders deadlock.
 */
export async function lockPlayerPair(
  client: PoolClient,
  a: string,
  b: string
): Promise<void> {
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended(LEAST($1::text, $2::text) || '|' || GREATEST($1::text, $2::text), 0::bigint)
     )`,
    [a, b]
  );
}
