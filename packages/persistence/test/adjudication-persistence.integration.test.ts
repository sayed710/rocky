/**
 * @packageDocumentation
 * Real PostgreSQL tests for migration 0053 and PgAdjudicationStore beyond Start (Issue #124).
 *
 * Every test drives genuine domain operations through a real proof job; nothing is faked except the
 * transport faults named in each test. Covered:
 * 1. Existing roles holding only their pre-0053 game_events / queue privileges (including
 *    column-level INSERT) keep appending to legacy games, cannot read the new table, and are fenced
 *    out of proving games without any new grant.
 * 2. Legacy commit semantics are unchanged: stored xact_id kept, appends after an ending accepted,
 *    duplicate positions still fail with 23505, no extra advisory lock.
 * 3. A running completion restores exactly the queues the proving window suppressed (flag and
 *    no-show), and a stopped completion keeps them suppressed and fences raw appends.
 * 4. Lost replies: claim recovery by intent, settlement recovery after a lost COMMIT reply in the
 *    same process and after a restart that lost the retained evaluation.
 * 5. Rollback: an expired lease and an injected failure before COMMIT leave no trace; the retained
 *    evaluation then settles without re-running the consumed job.
 * 6. Races: concurrent Starts, concurrent claims, and a legacy append racing a Start.
 * 7. Direct SQL tampering is rejected by the immediate guards and the deferred validator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { Game, type GameEvent } from '@chess-platform/game';
import {
  AdjudicationClaimExpiredError,
  AdjudicationConflictError,
} from '../src/errors';
import { migrate } from '../src/pg/migrate';
import { PgAdjudicationStore, type AdjudicationClaimGrant } from '../src/pg/adjudication-store';
import { withTestDatabase } from '../src/test-support/database';

const migrationsDir = [
  join(__dirname, '../../migrations'),
  join(__dirname, '../migrations'),
  join(process.cwd(), 'migrations'),
  join(process.cwd(), 'packages/persistence/migrations'),
].find((d) => existsSync(d))!;

const USER_W = '018f2780-0000-7000-8000-000000000010';
const USER_B = '018f2780-0000-7000-8000-000000000020';
const EXECUTOR = '018f2780-0000-7000-8000-000000000099';
const EXECUTOR_2 = '018f2780-0000-7000-8000-000000000098';
const RULES = 'standard@1.0.0';
/** White mates with e7g7; e7e4 is a quiet, non-terminal move whose proof finishes quickly. */
const FEN_MATE1 = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
const TC = { kind: 'increment', initialMs: 180_000, incrementMs: 2_000, delayMs: 0 } as const;

let idCounter = 0;
function uuid(): string {
  idCounter += 1;
  return `018f2780-0000-7000-8000-${(0xc00000000000 + idCounter).toString(16)}`;
}

function hasCode(code: string) {
  return (err: unknown): boolean => {
    assert.equal((err as { code?: string }).code, code, `expected SQLSTATE ${code}, got ${String((err as Error).message)}`);
    return true;
  };
}

async function setup(pool: Pool): Promise<void> {
  await migrate(pool, migrationsDir);
  await pool.query(
    `INSERT INTO users (id, handle, email, email_verified_at, created_at)
     VALUES ($1, 'white_player', 'white@example.com', NOW(), NOW()),
            ($2, 'black_player', 'black@example.com', NOW(), NOW())`,
    [USER_W, USER_B],
  );
}

interface BaseGame {
  readonly gameId: string;
  readonly events: GameEvent[];
}

async function createGame(
  pool: Pool | PoolClient,
  opts: { fen?: string; sourced?: boolean; gameId?: string } = {},
): Promise<BaseGame> {
  const gameId = opts.gameId ?? uuid();
  const created = Game.create({
    gameId,
    players: { white: USER_W, black: USER_B },
    timeControl: TC,
    rated: false,
    at: 1000,
    ...(opts.sourced ? { source: 'seek' as const, noShowAfterMs: 60_000 } : {}),
    ...(opts.fen ? { initialFen: opts.fen } : {}),
  });
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
     VALUES ($1, 'standard', false, 'blitz', $2, $3, NOW())`,
    [gameId, USER_W, USER_B],
  );
  await pool.query(
    `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, $2, 1, $3::jsonb)`,
    [gameId, created.events[0]!.type, JSON.stringify(created.events[0]!)],
  );
  return { gameId, events: [...created.events] };
}

async function startMove(
  store: PgAdjudicationStore,
  gameId: string,
  uci: string,
  opts: { observed?: boolean; operationId?: string } = {},
): Promise<string> {
  const operationId = opts.operationId ?? uuid();
  const res = await store.startAdjudication({
    gameId,
    command: { kind: 'move', uci },
    context: {
      operationId,
      color: 'w',
      at: 1100,
      rulesVersion: RULES,
      ...(opts.observed ? { clockPolicy: 'observed-release-v1' as const } : {}),
    },
  });
  assert.equal(res.status, 'started');
  return operationId;
}

async function claim(
  store: PgAdjudicationStore,
  gameId: string,
  operationId: string,
  expectedGeneration = '0',
  leaseMs = 60_000,
  executorId = EXECUTOR,
): Promise<AdjudicationClaimGrant> {
  return store.claimAdjudication({
    gameId,
    operationId,
    executorId,
    expectedGeneration,
    leaseMs,
    intent: PgAdjudicationStore.newClaimIntent(),
  });
}

async function prove(store: PgAdjudicationStore, gameId: string, operationId: string): Promise<void> {
  await store.createProofJob(gameId, operationId);
  let status = store.getProofJob(operationId)?.status;
  for (let i = 0; status === 'active' && i < 100_000; i++) {
    status = store.stepProofJob(operationId, 100).status;
  }
  assert.equal(status, 'ready');
}

async function queues(pool: Pool, gameId: string) {
  const pregame = await pool.query<{ due_at: Date; seq: number }>('SELECT due_at, seq FROM pregame_deadlines WHERE game_id = $1', [gameId]);
  const flag = await pool.query<{ seq: number; due_ms: string }>('SELECT seq, due_ms FROM flag_deadlines WHERE game_id = $1', [gameId]);
  return { pregame: pregame.rows, flag: flag.rows };
}

async function head(pool: Pool, gameId: string): Promise<number | null> {
  return (await pool.query<{ h: number | null }>('SELECT max(seq) AS h FROM game_events WHERE game_id = $1', [gameId])).rows[0]!.h;
}

async function adjudication(pool: Pool, gameId: string, operationId: string) {
  return (await pool.query('SELECT * FROM game_adjudications WHERE game_id = $1 AND operation_id = $2', [gameId, operationId])).rows[0];
}

/** A pool whose clients can fail a chosen COMMIT reply *after* the server committed it. */
function lossyCommitPool(base: Pool): { pool: Pool; armCommitLoss(skip?: number): void; armFailOn(fragment: string): void } {
  let commitsUntilLoss = -1;
  let failOn: string | null = null;
  // pg reuses pooled client objects: wrap each one once, or wrappers would stack.
  const wrapped = new WeakSet<PoolClient>();
  const pool = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          if (wrapped.has(client)) return client;
          wrapped.add(client);
          const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
          client.query = (async (text: unknown, ...rest: unknown[]) => {
            const sql = typeof text === 'string' ? text : '';
            if (failOn !== null && sql.includes(failOn)) {
              failOn = null;
              throw new Error('injected failure before commit');
            }
            const result = await original(text, ...rest);
            if (sql === 'COMMIT' && commitsUntilLoss >= 0) {
              commitsUntilLoss -= 1;
              if (commitsUntilLoss < 0) throw new Error('Connection terminated unexpectedly');
            }
            return result;
          }) as typeof client.query;
          return client;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    pool,
    /** Lose the reply of the COMMIT after `skip` further commits (0: the next one). */
    armCommitLoss: (skip = 0) => { commitsUntilLoss = skip; },
    armFailOn: (fragment: string) => { failOn = fragment; },
  };
}

test('pre-0053 roles keep their exact legacy behavior with no new grant, and are fenced out of managed games', async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await setup(pool);
    const role = `legacy_app_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    let legacy: Pool | null = null;
    try {
      // Exactly the privileges an append-only writer needed before 0053: column-level INSERT on the
      // event columns it writes, and what the 0042/0043 invoker triggers touch on the queues.
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT ON game_events TO ${role};
        GRANT INSERT (game_id, seq, type, event_version, payload) ON game_events TO ${role};
        GRANT SELECT, DELETE ON pregame_deadlines TO ${role};
        GRANT INSERT (game_id, due_at) ON pregame_deadlines TO ${role};
        GRANT SELECT, INSERT, UPDATE, DELETE ON flag_deadlines TO ${role};`);
      const url = new URL(connectionString);
      url.username = role;
      url.password = password;
      legacy = new Pool({ connectionString: url.toString(), max: 2 });

      // A sourced legacy game written entirely by the restricted role.
      const gameId = uuid();
      const created = Game.create({
        gameId, players: { white: USER_W, black: USER_B }, timeControl: TC, rated: false, at: 1000,
        source: 'seek', noShowAfterMs: 60_000,
      });
      await legacy.query(
        'INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 0, $2, 1, $3::jsonb)',
        [gameId, 'GameCreated', JSON.stringify(created.events[0])],
      );
      assert.deepEqual((await queues(pool, gameId)).pregame.map((r) => r.seq), [0]);
      const white = created.game.markReady('w', 1500);
      const black = white.game.markReady('b', 1600);
      const moved = black.game.move('e2e4', 2000);
      let seq = 0;
      for (const event of [...white.events, ...black.events, ...moved.events]) {
        seq += 1;
        await legacy.query(
          'INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, $3, 1, $4::jsonb)',
          [gameId, seq, event.type, JSON.stringify(event)],
        );
      }
      assert.equal(seq, 3);
      const afterMove = await queues(pool, gameId);
      assert.equal(afterMove.pregame.length, 0);
      assert.equal(afterMove.flag.length, 1);

      // A stale writer still gets the primary-key conflict every caller maps to a version conflict.
      await assert.rejects(
        legacy.query(
          'INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 3, $2, 1, $3::jsonb)',
          [gameId, 'MovePlayed', JSON.stringify(moved.events[0])],
        ),
        hasCode('23505'),
      );

      // The role was never granted the new table and does not need it.
      await assert.rejects(legacy.query('SELECT 1 FROM game_adjudications'), hasCode('42501'));

      // Lifecycle events cannot be forged without permits.
      const forgedStarted = { type: 'AdjudicationStarted', gameId, operationId: uuid() };
      await assert.rejects(
        legacy.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 4, $2, 1, $3::jsonb)',
          [gameId, 'AdjudicationStarted', JSON.stringify(forgedStarted)]),
        hasCode('PMA02'),
      );
      await assert.rejects(
        legacy.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 4, $2, 1, $3::jsonb)',
          [gameId, 'AdjudicationResolved', JSON.stringify({ ...forgedStarted, type: 'AdjudicationResolved' })]),
        hasCode('PMA12'),
      );
      await assert.rejects(
        legacy.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 4, $2, 1, $3::jsonb)',
          [gameId, 'AdjudicationClocksStarted', JSON.stringify({ ...forgedStarted, type: 'AdjudicationClocksStarted' })]),
        hasCode('PMA01'),
      );

      // A managed game that is proving fences the legacy role out, again without any grant.
      const store = new PgAdjudicationStore(pool);
      const managed = await createGame(pool, { fen: FEN_MATE1 });
      await startMove(store, managed.gameId, 'e7e4');
      await assert.rejects(
        legacy.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 2, $2, 1, $3::jsonb)',
          [managed.gameId, 'DrawOffered', JSON.stringify({ type: 'DrawOffered', by: 'b', at: 1200 })]),
        hasCode('PMA09'),
      );
      // ...and a stale append at the Started position is still a plain version conflict.
      await assert.rejects(
        legacy.query('INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 1, $2, 1, $3::jsonb)',
          [managed.gameId, 'DrawOffered', JSON.stringify({ type: 'DrawOffered', by: 'w', at: 1200 })]),
        hasCode('23505'),
      );
    } finally {
      await legacy?.end();
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});

test('legacy commit semantics are unchanged: stored xact_id, appends after an ending, no new lock', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const { gameId, events } = await createGame(pool);
    const game = Game.fromEvents(events);
    const resigned = game.resign('w', 1500);

    // A logical restore writes historical xact_id values; the guard must keep them.
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload, xact_id) VALUES ($1, 1, 'GameEnded', 1, $2::jsonb, '7'::xid8)`,
      [gameId, JSON.stringify(resigned.events[0])],
    );
    assert.equal((await pool.query('SELECT xact_id::text AS x FROM game_events WHERE game_id = $1 AND seq = 1', [gameId])).rows[0]!.x, '7');

    // Before 0053 the store accepted an append after an ending (the domain refuses it); still so.
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 2, 'DrawOffered', 1, $2::jsonb)`,
      [gameId, JSON.stringify({ type: 'DrawOffered', by: 'w', at: 1600 })],
    );

    // A legacy append takes no adjudication advisory lock.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 3, 'DrawDeclined', 1, $2::jsonb)`,
        [gameId, JSON.stringify({ type: 'DrawDeclined', by: 'b', at: 1700 })],
      );
      const locks = await client.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
      assert.equal(locks.rows[0]!.n, 0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

test('a running completion restores exactly the suppressed flag queue; a retried settle is a no-op', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');
    assert.deepEqual(await queues(pool, gameId), { pregame: [], flag: [] });

    const grant = await claim(store, gameId, operationId);
    await prove(store, gameId, operationId);
    const receipt = await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });
    assert.equal(receipt.finalSeq, 3);

    const q = await queues(pool, gameId);
    const moveRow = (await pool.query('SELECT seq, payload FROM game_events WHERE game_id = $1 AND seq = 3', [gameId])).rows[0];
    assert.equal(moveRow.payload.type, 'MovePlayed');
    const expected = (await pool.query('SELECT flag_deadline_ms($1, $2::jsonb)::text AS due', [gameId, JSON.stringify(moveRow.payload)])).rows[0]!.due;
    assert.deepEqual(q, { pregame: [], flag: [{ seq: 3, due_ms: expected }] });
    // The restored deadline is the one the domain itself computes after the settled move.
    const replayed = Game.fromEvents((await pool.query('SELECT payload FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId])).rows.map((r) => r.payload));
    assert.equal(String(replayed.flagDeadline), expected);

    // Retry with the same grant answers from the database and appends nothing.
    assert.deepEqual(await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 }), receipt);
    assert.equal(await head(pool, gameId), 3);

    // The game runs on as a legacy-shaped stream: an ordinary append is admitted afterwards.
    await pool.query(
      `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 4, 'DrawOffered', 1, $2::jsonb)`,
      [gameId, JSON.stringify({ type: 'DrawOffered', by: 'b', at: 5000 })],
    );
  });
});

test('a running ready completion restores the no-show deadline with the completion as its identity', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1, sourced: true });
    const before = await queues(pool, gameId);
    assert.equal(before.pregame.length, 1);
    assert.equal(before.pregame[0]!.seq, 0);

    const operationId = uuid();
    const res = await store.startAdjudication({
      gameId,
      command: { kind: 'ready' },
      context: { operationId, color: 'w', at: 1100, rulesVersion: RULES },
    });
    assert.equal(res.status, 'started');
    assert.deepEqual(await queues(pool, gameId), { pregame: [], flag: [] });

    const grant = await claim(store, gameId, operationId);
    await prove(store, gameId, operationId);
    const receipt = await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });

    const after = await queues(pool, gameId);
    assert.equal(after.flag.length, 0);
    assert.equal(after.pregame.length, 1);
    assert.equal(after.pregame[0]!.due_at.getTime(), before.pregame[0]!.due_at.getTime());
    assert.equal(after.pregame[0]!.seq, receipt.finalSeq);
  });
});

test('a stopped completion keeps queues suppressed, fences raw appends and admits the next Start', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4', { observed: true });
    const grant = await claim(store, gameId, operationId);
    await prove(store, gameId, operationId);
    const receipt = await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });

    const row = await adjudication(pool, gameId, operationId);
    assert.equal(row.execution_state, 'completed');
    assert.equal(row.is_current_stop, true);
    assert.ok(row.stopped_clock);
    assert.deepEqual(await queues(pool, gameId), { pregame: [], flag: [] });

    await assert.rejects(
      pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, $2, 'DrawOffered', 1, $3::jsonb)`,
        [gameId, receipt.finalSeq + 1, JSON.stringify({ type: 'DrawOffered', by: 'b', at: 1300 })]),
      hasCode('PMA10'),
    );
    // A deadline cannot be committed for a stopped game.
    await assert.rejects(
      pool.query(`INSERT INTO flag_deadlines (game_id, seq, due_ms) VALUES ($1, $2, 99999)`, [gameId, receipt.finalSeq]),
      hasCode('PMD05'),
    );
    // A cleared stop cannot be revived, and the current stop cannot be dropped while the game is stopped.
    await assert.rejects(
      pool.query('UPDATE game_adjudications SET is_current_stop = false WHERE game_id = $1', [gameId]),
      hasCode('PMD11'),
    );
  });
});

test('lost replies: a claim is recovered by its intent; a settle is recovered after a lost COMMIT and after a restart', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const lossy = lossyCommitPool(pool);
    const store = new PgAdjudicationStore(lossy.pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');

    // Claim: the COMMIT reply is lost, so the caller does not know the claim committed.
    const intent = PgAdjudicationStore.newClaimIntent();
    const params = { gameId, operationId, executorId: EXECUTOR, expectedGeneration: '0', leaseMs: 60_000, intent };
    lossy.armCommitLoss();
    await assert.rejects(store.claimAdjudication(params), /Connection terminated/);
    assert.equal((await adjudication(pool, gameId, operationId)).generation, '1');
    const recovered = await store.claimAdjudication(params);
    assert.equal(recovered.generation, '1');
    assert.equal(recovered.claimId, intent.claimId);
    // Another intent cannot pass itself off as the live claim.
    await assert.rejects(
      store.claimAdjudication({ ...params, intent: PgAdjudicationStore.newClaimIntent() }),
      AdjudicationConflictError,
    );

    await prove(store, gameId, operationId);
    // Skip the read-only grant pre-check; lose the reply of the settlement transaction itself.
    lossy.armCommitLoss(1);
    await assert.rejects(store.settleAdjudication({ gameId, operationId, grant: recovered, resolutionAt: 1200 }), /Connection terminated/);
    const committedHead = await head(pool, gameId);
    assert.equal(committedHead, 3);

    const sameProcess = await store.settleAdjudication({ gameId, operationId, grant: recovered, resolutionAt: 1200 });
    assert.equal(sameProcess.finalSeq, 3);

    // A restarted process has no retained evaluation and no proof job; the database answers.
    const restarted = new PgAdjudicationStore(pool);
    assert.deepEqual(await restarted.settleAdjudication({ gameId, operationId, grant: recovered, resolutionAt: 1200 }), sameProcess);
    assert.equal(await head(pool, gameId), 3);

    // A grant that did not complete the operation is refused even though it is completed.
    const forged = await (async () => {
      const g2 = await createGame(pool, { fen: FEN_MATE1 });
      const op2 = await startMove(restarted, g2.gameId, 'e7e4');
      return claim(restarted, g2.gameId, op2);
    })();
    await assert.rejects(
      restarted.settleAdjudication({ gameId, operationId, grant: forged, resolutionAt: 1200 }),
      AdjudicationConflictError,
    );
  });
});

test('rollback: an expired lease and an injected pre-COMMIT failure leave nothing; the retained evaluation then settles', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const lossy = lossyCommitPool(pool);
    const store = new PgAdjudicationStore(lossy.pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');

    const shortGrant = await claim(store, gameId, operationId, '0', 1);
    await prove(store, gameId, operationId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      store.settleAdjudication({ gameId, operationId, grant: shortGrant, resolutionAt: 1200 }),
      AdjudicationClaimExpiredError,
    );
    const untouched = async () => {
      const row = await adjudication(pool, gameId, operationId);
      assert.equal(row.execution_state, 'proving');
      assert.equal(row.settlement_permit_xact_id, null);
      assert.equal(await head(pool, gameId), 1);
      assert.deepEqual(await queues(pool, gameId), { pregame: [], flag: [] });
    };
    await untouched();

    // The stale holder cannot renew; a successor takes over with a strictly greater generation.
    await assert.rejects(store.renewAdjudication({ grant: shortGrant, extensionMs: 60_000 }), AdjudicationClaimExpiredError);
    const successor = await claim(store, gameId, operationId, '1', 60_000, EXECUTOR_2);
    assert.equal(successor.generation, '2');

    // Fail inside the settlement transaction, after events were appended, before COMMIT.
    lossy.armFailOn("execution_state = 'completed'");
    await assert.rejects(
      store.settleAdjudication({ gameId, operationId, grant: successor, resolutionAt: 1200 }),
      /injected failure/,
    );
    await untouched();

    // The proof job was consumed by the first evaluation; the successor learns the retained instant
    // and settles from the retained evaluation.
    assert.equal(store.retainedResolutionAt(gameId, operationId), 1200);
    const receipt = await store.settleAdjudication({
      gameId, operationId, grant: successor, resolutionAt: store.retainedResolutionAt(gameId, operationId)!,
    });
    assert.equal(store.retainedResolutionAt(gameId, operationId), undefined);
    assert.equal(receipt.finalSeq, 3);
    const row = await adjudication(pool, gameId, operationId);
    assert.equal(row.completed_generation, '2');
    assert.equal(row.completed_executor_id, EXECUTOR_2);
    // A different resolution instant would be a different settlement and is refused.
    const g2 = await createGame(pool, { fen: FEN_MATE1 });
    const op2 = await startMove(store, g2.gameId, 'e7e4');
    const grant2 = await claim(store, g2.gameId, op2);
    await prove(store, g2.gameId, op2);
    lossy.armFailOn("execution_state = 'completed'");
    await assert.rejects(store.settleAdjudication({ gameId: g2.gameId, operationId: op2, grant: grant2, resolutionAt: 1200 }), /injected/);
    await assert.rejects(
      store.settleAdjudication({ gameId: g2.gameId, operationId: op2, grant: grant2, resolutionAt: 1300 }),
      AdjudicationConflictError,
    );
  });
});

test('renewal is bounded by database now and idempotent under retry', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');
    const grant = await claim(store, gameId, operationId, '0', 60_000);
    const first = await store.renewAdjudication({ grant, extensionMs: 60_000 });
    const second = await store.renewAdjudication({ grant: first, extensionMs: 60_000 });
    const now = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
    assert.ok(second.leaseUntil.getTime() <= now + 60_000 + 50, 'renewals do not stack');
    assert.ok(second.leaseUntil.getTime() >= first.leaseUntil.getTime(), 'renewal never shortens');
  });
});

test('races: one of two Starts wins, one of two claims wins, a legacy append and a Start never both commit', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const storeA = new PgAdjudicationStore(pool);
    const storeB = new PgAdjudicationStore(pool);

    for (let round = 0; round < 5; round++) {
      const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
      const results = await Promise.allSettled([
        startMove(storeA, gameId, 'e7e4'),
        startMove(storeB, gameId, 'e7e5'),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_adjudications WHERE game_id = $1', [gameId])).rows[0]!.n, 1);
      assert.equal(await head(pool, gameId), 1);
      const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value;

      const claims = await Promise.allSettled([claim(storeA, gameId, winner), claim(storeB, gameId, winner)]);
      assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await adjudication(pool, gameId, winner)).generation, '1');
    }

    for (let round = 0; round < 5; round++) {
      const { gameId, events } = await createGame(pool, { fen: FEN_MATE1 });
      const legacyMove = Game.fromEvents(events).move('e7e4', 1050).events[0]!;
      const legacy = (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 1, 'MovePlayed', 1, $2::jsonb)`,
            [gameId, JSON.stringify(legacyMove)],
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      })();
      const results = await Promise.allSettled([legacy, startMove(storeA, gameId, 'e7e4')]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
      const types = (await pool.query('SELECT type FROM game_events WHERE game_id = $1 ORDER BY seq', [gameId])).rows.map((r) => r.type);
      assert.equal(types.length, 2);
      const rows = (await pool.query('SELECT count(*)::int AS n FROM game_adjudications WHERE game_id = $1', [gameId])).rows[0]!.n;
      assert.equal(rows, types[1] === 'AdjudicationStarted' ? 1 : 0);
    }
  });
});

test('direct SQL tampering is rejected immediately or at COMMIT', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');

    // While proving: identity is immutable, rows cannot be deleted, deadlines cannot be committed.
    await assert.rejects(pool.query(`UPDATE game_adjudications SET accepted_at = 5 WHERE game_id = $1`, [gameId]), hasCode('PMA33'));
    await assert.rejects(pool.query(`DELETE FROM game_adjudications WHERE game_id = $1`, [gameId]), hasCode('PMA30'));
    await assert.rejects(pool.query(`INSERT INTO flag_deadlines (game_id, seq, due_ms) VALUES ($1, 1, 1)`, [gameId]), hasCode('PMD05'));
    // A claim that reuses the generation is refused.
    await assert.rejects(
      pool.query(`UPDATE game_adjudications SET claim_id = $2, executor_id = $3, capability_hash = $4, lease_until = now() + interval '1 minute' WHERE game_id = $1`,
        [gameId, uuid(), EXECUTOR, randomBytes(32)]),
      hasCode('PMA37'),
    );

    // A Start and a claim in one transaction: the claim must wait for Started to commit.
    const other = await createGame(pool, { fen: FEN_MATE1 });
    const client = await pool.connect();
    try {
      const otherOp = uuid();
      const started = Game.fromEvents(other.events);
      const prepared = (await import('@chess-platform/game')).prepareMove(started, { uci: 'e7e4', at: 1100, operationId: otherOp, rulesVersion: RULES });
      const startedEvent = { type: 'AdjudicationStarted', gameId: other.gameId, operationId: otherOp, baseRevision: 0, at: 1100, rulesVersion: RULES, prepared };
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO game_adjudications (game_id, operation_id, base_revision, started_seq, started_type, started_version,
           started_payload, prepared, accepted_at, rules_version, original_clock, thinking_elapsed_at_a, execution_state)
         VALUES ($1, $2, 0, 1, 'AdjudicationStarted', 1, $3::jsonb, $4::jsonb, 1100, $5, '{}'::jsonb, 0, 'proving')`,
        [other.gameId, otherOp, JSON.stringify(startedEvent), JSON.stringify(prepared), RULES],
      );
      // The Started envelope must match its permit exactly.
      await client.query('SAVEPOINT s');
      await assert.rejects(
        client.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
          [other.gameId, JSON.stringify({ ...startedEvent, at: 1101 })]),
        hasCode('PMA05'),
      );
      await client.query('ROLLBACK TO SAVEPOINT s');
      await client.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 1, 'AdjudicationStarted', 1, $2::jsonb)`,
        [other.gameId, JSON.stringify(startedEvent)]);
      await assert.rejects(
        client.query(`UPDATE game_adjudications SET generation = 1, claim_id = $2, executor_id = $3, capability_hash = $4, lease_until = now() + interval '1 minute' WHERE game_id = $1`,
          [other.gameId, uuid(), EXECUTOR, randomBytes(32)]),
        hasCode('PMA22'),
      );
      await client.query('ROLLBACK');

      // A row without its Started event cannot commit.
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO game_adjudications (game_id, operation_id, base_revision, started_seq, started_type, started_version,
           started_payload, prepared, accepted_at, rules_version, original_clock, thinking_elapsed_at_a, execution_state)
         VALUES ($1, $2, 0, 1, 'AdjudicationStarted', 1, $3::jsonb, $4::jsonb, 1100, $5, '{}'::jsonb, 0, 'proving')`,
        [other.gameId, otherOp, JSON.stringify(startedEvent), JSON.stringify(prepared), RULES],
      );
      await assert.rejects(client.query('COMMIT'), hasCode('PMD03'));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Completed rows are frozen except for clearing a current stop.
    const grant = await claim(store, gameId, operationId);
    await prove(store, gameId, operationId);
    await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });
    await assert.rejects(pool.query(`UPDATE game_adjudications SET settlement_batch = '[]'::jsonb WHERE game_id = $1`, [gameId]), hasCode('PMA35'));
    await assert.rejects(pool.query(`UPDATE game_adjudications SET is_current_stop = true WHERE game_id = $1`, [gameId]), hasCode('PMA34'));
    // A settled event cannot be altered underneath its obligation.
    await assert.rejects(
      pool.query(`INSERT INTO game_events (game_id, seq, type, event_version, payload) VALUES ($1, 4, 'AdjudicationResolved', 1, '{}'::jsonb)`, [gameId]),
      hasCode('PMA12'),
    );
  });
});

test('an expired or superseded claimant cannot consume the proof job or pin the resolution instant', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const lossy = lossyCommitPool(pool);
    const storeA = new PgAdjudicationStore(lossy.pool);
    const storeB = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(storeA, gameId, 'e7e4');

    // An expired claimant is refused before any evaluation: nothing is retained or consumed.
    const expired = await claim(storeA, gameId, operationId, '0', 1);
    await prove(storeA, gameId, operationId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(storeA.settleAdjudication({ gameId, operationId, grant: expired, resolutionAt: 1200 }), AdjudicationClaimExpiredError);
    assert.equal(storeA.retainedResolutionAt(gameId, operationId), undefined);
    assert.equal(storeA.getProofJob(operationId)?.status, 'ready');

    // A live claimant evaluates at its instant, then fails before COMMIT: the evaluation is retained.
    const live = await claim(storeA, gameId, operationId, '1', 400);
    lossy.armFailOn("execution_state = 'completed'");
    await assert.rejects(storeA.settleAdjudication({ gameId, operationId, grant: live, resolutionAt: 1300 }), /injected/);
    assert.equal(storeA.retainedResolutionAt(gameId, operationId), 1300);

    // Its lease lapses and another executor completes the operation with its own proof job.
    await new Promise((resolve) => setTimeout(resolve, 450));
    const successor = await claim(storeB, gameId, operationId, '2', 60_000, EXECUTOR_2);
    await prove(storeB, gameId, operationId);
    const receipt = await storeB.settleAdjudication({ gameId, operationId, grant: successor, resolutionAt: 1250 });
    assert.equal(receipt.resolvedEvent.at, 1250);

    // The superseded grant is refused, and its retained evaluation is dropped rather than leaked.
    await assert.rejects(storeA.settleAdjudication({ gameId, operationId, grant: live, resolutionAt: 1300 }), AdjudicationConflictError);
    assert.equal(storeA.retainedResolutionAt(gameId, operationId), undefined);
  });
});

test('deferred validation runs once per transaction but re-runs after any later change', async () => {
  await withTestDatabase(async ({ pool }) => {
    await setup(pool);
    const store = new PgAdjudicationStore(pool);
    const { gameId } = await createGame(pool, { fen: FEN_MATE1 });
    const operationId = await startMove(store, gameId, 'e7e4');
    const grant = await claim(store, gameId, operationId);
    await prove(store, gameId, operationId);
    await store.settleAdjudication({ gameId, operationId, grant, resolutionAt: 1200 });
    const row = await adjudication(pool, gameId, operationId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A no-op managed change, validated early: the marker is now set for this game.
      await client.query('UPDATE game_adjudications SET is_current_stop = false WHERE game_id = $1', [gameId]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      // A later obligation row without its Started event must still be caught at COMMIT.
      await client.query(
        `INSERT INTO game_adjudications (game_id, operation_id, base_revision, started_seq, started_type, started_version,
           started_payload, prepared, accepted_at, rules_version, original_clock, thinking_elapsed_at_a, execution_state)
         VALUES ($1, $2, 3, 4, 'AdjudicationStarted', 1, $3::jsonb, $4::jsonb, 1300, $5, '{}'::jsonb, 0, 'proving')`,
        [gameId, uuid(), JSON.stringify(row.started_payload), JSON.stringify(row.prepared), RULES],
      );
      await assert.rejects(client.query('COMMIT'), hasCode('PMD03'));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
