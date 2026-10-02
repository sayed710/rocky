/**
 * Player reports against real PostgreSQL behind two API replicas (ADR-0152): the migration's
 * constraints, the shared report budget, racing moderator claims, and the transition and its audit
 * row committing together or not at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { Game } from '@chess-platform/game';
import { migrate, PgUsersRepository, PostgresEventStore } from '@chess-platform/persistence/pg';
import { uuidv7, type Role } from '@chess-platform/persistence';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { AccessTokenService } from '../src/auth/tokens';
import { createPgApiServer } from '../src/bootstrap';
import { InMemoryEmailSender } from '../src/ports/email';
import { systemClock } from '../src/ports/clock';
import { uuidv7Generator } from '../src/ports/ids';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';
import { JsonLogger } from '../src/ports/logger';
import { closeServer, listenOnFetchablePort } from './listen';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const MIGRATIONS = join(process.cwd(), '../persistence/migrations');
const SECRET = 'test-access-token-secret-0123456789abcdef';

interface Replica { readonly url: string; readonly http: Server; readonly shutdown: () => Promise<void> }

async function withReplicas(body: (pool: Pool, replicas: readonly [Replica, Replica], makeUser: (name: string, roles?: Role[]) => Promise<{ userId: string; token: string }>) => Promise<void>): Promise<void> {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const tokens = new AccessTokenService({ secret: SECRET, ttlSec: 900, clock: systemClock, ids: uuidv7Generator });
    const users = new PgUsersRepository(pool);
    const makeUser = async (name: string, roles: Role[] = ['user']) => {
      const id = uuidv7();
      const handle = `pg_reports_${name}_${id.slice(-12)}`;
      await users.create({ id, handle });
      for (const role of roles) await users.addRole(id, role);
      return { userId: id, token: tokens.issue({ userId: id, handle, roles }).token };
    };
    const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
    const replicas: Replica[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const composed = createPgApiServer({
          pool, logger, emailSender: new InMemoryEmailSender(), rateLimiter: new PgRateLimiter(pool),
          config: { accessTokenSecret: SECRET, trustProxy: true },
        });
        const listening = await listenOnFetchablePort((port, host) => composed.server.listen(port, host), '127.0.0.1');
        replicas.push({ http: listening.server, url: `http://127.0.0.1:${listening.port}`, shutdown: composed.shutdownAnalysis });
      }
      await body(pool, replicas as unknown as readonly [Replica, Replica], makeUser);
    } finally {
      for (const replica of replicas) {
        await closeServer(replica.http);
        await replica.shutdown();
      }
    }
  });
}

async function call(replica: Replica, method: string, path: string, opts: { token?: string; body?: unknown; address?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.address) headers['x-forwarded-for'] = opts.address;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${replica.url}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

test('the schema refuses self-reports, unknown states and a claim without an owner', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, MIGRATIONS);
    const users = new PgUsersRepository(pool);
    const a = uuidv7();
    const b = uuidv7();
    await users.create({ id: a, handle: `pg_rc_a_${a.slice(-12)}` });
    await users.create({ id: b, handle: `pg_rc_b_${b.slice(-12)}` });
    const insert = (sql: string, params: unknown[]) => pool.query(sql, params);
    await assert.rejects(insert(`INSERT INTO player_reports (id, reporter_id, subject_id, reason) VALUES ($1, $2, $2, 'spam')`, [uuidv7(), a]), /player_reports_not_self/);
    await assert.rejects(insert(`INSERT INTO player_reports (id, reporter_id, subject_id, reason) VALUES ($1, $2, $3, 'rude')`, [uuidv7(), a, b]), /check constraint/);
    await assert.rejects(insert(`INSERT INTO player_reports (id, reporter_id, subject_id, reason, status) VALUES ($1, $2, $3, 'spam', 'reviewing')`, [uuidv7(), a, b]), /player_reports_claim_matches_status/);
    await assert.rejects(insert(`INSERT INTO player_reports (id, reporter_id, subject_id, reason, status, assigned_to) VALUES ($1, $2, $3, 'spam', 'resolved', $2)`, [uuidv7(), a, b]), /player_reports_closed_matches_status/);
    await assert.rejects(insert(`INSERT INTO player_reports (id, reporter_id, subject_id, reason, detail) VALUES ($1, $2, $3, 'spam', $4)`, [uuidv7(), a, b, 'x'.repeat(1001)]), /check constraint/);
  });
});

test('report admission is shared across replicas and a refused report is never written', { skip }, async () => {
  await withReplicas(async (pool, [a, b], makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    for (let i = 0; i < 3; i++) {
      const replica = i % 2 === 0 ? a : b;
      assert.equal((await call(replica, 'POST', '/v1/reports', { token: reporter.token, address: `192.0.2.${10 + i}`, body: { subjectId: subject.userId, reason: 'spam' } })).status, 201);
    }
    assert.equal((await call(b, 'POST', '/v1/reports', { token: reporter.token, address: '192.0.2.20', body: { subjectId: subject.userId, reason: 'spam' } })).status, 429);
    const stored = await pool.query('SELECT count(*)::int AS n FROM player_reports WHERE reporter_id = $1', [reporter.userId]);
    assert.equal(stored.rows[0].n, 3);
  });
});

test('of many moderators racing to claim one report on two replicas, exactly one wins and is audited', { skip }, async () => {
  await withReplicas(async (pool, replicas, makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    const mods = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => makeUser(`mod${n}`, ['moderator'])));
    const id = (await call(replicas[0], 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: subject.userId, reason: 'cheating' } })).body.id;

    const claims = await Promise.all(mods.map((mod, i) => call(replicas[i % 2]!, 'POST', `/v1/moderation/player-reports/${id}/transition`, {
      token: mod.token, body: { action: 'claim', expectedVersion: 1 },
    })));
    const statuses = claims.map((c) => c.status);
    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one claim wins: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 409).length, mods.length - 1, 'every loser gets a conflict, not a 500');
    const winner = mods[statuses.indexOf(200)]!;

    const row = (await pool.query('SELECT status, assigned_to, version FROM player_reports WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { status: 'reviewing', assigned_to: winner.userId, version: 2 });
    const audits = (await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'player_reports.claim' AND target = $1`, [id])).rows;
    assert.deepEqual(audits, [{ actor_id: winner.userId }]);
  });
});

test('a transition whose audit row cannot be written does not happen', { skip }, async () => {
  await withReplicas(async (pool, [a], makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    const mod = await makeUser('mod', ['moderator']);
    const id = (await call(a, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: subject.userId, reason: 'cheating' } })).body.id;
    assert.equal((await call(a, 'POST', `/v1/moderation/player-reports/${id}/transition`, { token: mod.token, body: { action: 'claim', expectedVersion: 1 } })).status, 200);

    // Make the audit insert fail, only for this action, in this throwaway database.
    await pool.query(`CREATE FUNCTION refuse_resolve_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'player_reports.resolve' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER refuse_resolve_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_resolve_audit()');
    const failed = await call(a, 'POST', `/v1/moderation/player-reports/${id}/transition`, { token: mod.token, body: { action: 'resolve', expectedVersion: 2, note: 'n' } });
    assert.equal(failed.status, 500);
    const row = (await pool.query('SELECT status, version, moderator_note, closed_at FROM player_reports WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { status: 'reviewing', version: 2, moderator_note: null, closed_at: null }, 'the decision rolled back with its audit row');

    await pool.query('DROP TRIGGER refuse_resolve_audit ON audit_log');
    assert.equal((await call(a, 'POST', `/v1/moderation/player-reports/${id}/transition`, { token: mod.token, body: { action: 'resolve', expectedVersion: 2, note: 'n' } })).status, 200);
  });
});

test('the queue pages by time-ordered id across replicas without gaps or repeats', { skip }, async () => {
  await withReplicas(async (_pool, [a, b], makeUser) => {
    const subject = await makeUser('subject');
    const mod = await makeUser('mod', ['moderator']);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      const reporter = await makeUser(`r${i}`);
      created.push((await call(i % 2 ? a : b, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: subject.userId, reason: 'other' } })).body.id);
    }
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query: string = `/v1/moderation/player-reports?status=open&subjectId=${subject.userId}&limit=3${after ? `&after=${after}` : ''}`;
      const res = await call(page % 2 ? a : b, 'GET', query, { token: mod.token });
      assert.equal(res.status, 200);
      seen.push(...res.body.items.map((item: { id: string }) => item.id));
      after = res.body.nextAfter;
      if (after === null) break;
    }
    assert.deepEqual(seen, [...created].sort());
  });
});

test('on PostgreSQL, refusals leave the row untouched and map to 403, 404 and 409', { skip }, async () => {
  await withReplicas(async (pool, [a, b], makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    const [mod1, mod2] = [await makeUser('mod1', ['moderator']), await makeUser('mod2', ['moderator'])];
    const admin = await makeUser('admin', ['admin']);
    const id = (await call(a, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: subject.userId, reason: 'cheating' } })).body.id;
    const move = (replica: Replica, token: string, body: unknown) => call(replica, 'POST', `/v1/moderation/player-reports/${id}/transition`, { token, body });
    const row = async () => (await pool.query('SELECT status, assigned_to, version, moderator_note FROM player_reports WHERE id = $1', [id])).rows[0];

    assert.equal((await move(a, mod1.token, { action: 'claim', expectedVersion: 1 })).status, 200);
    const claimed = await row();
    assert.equal((await move(b, mod2.token, { action: 'resolve', expectedVersion: 2, note: 'x' })).status, 403, 'not the assignee');
    assert.equal((await move(b, mod1.token, { action: 'resolve', expectedVersion: 1, note: 'x' })).status, 409, 'stale version');
    assert.equal((await move(a, subject.token, { action: 'resolve', expectedVersion: 2 })).status, 403, 'not a moderator');
    assert.deepEqual(await row(), claimed, 'no refusal changed the report');
    assert.equal((await call(a, 'POST', `/v1/moderation/player-reports/${uuidv7()}/transition`, { token: mod1.token, body: { action: 'claim', expectedVersion: 1 } })).status, 404);

    assert.equal((await move(b, admin.token, { action: 'dismiss', expectedVersion: 2, note: 'override' })).status, 200);
    assert.deepEqual(await row(), { status: 'dismissed', assigned_to: mod1.userId, version: 3, moderator_note: 'override' });
    const audit = (await pool.query(`SELECT actor_id, meta FROM audit_log WHERE action = 'player_reports.dismiss' AND target = $1`, [id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, admin.userId);
    assert.deepEqual(audit[0].meta, { subjectId: subject.userId, from: 'reviewing', to: 'dismissed', version: 3, previousAssignee: mod1.userId });
    assert.equal((await move(a, admin.token, { action: 'dismiss', expectedVersion: 3 })).status, 409, 'terminal stays terminal');
  });
});

test('on PostgreSQL, a report is never read without its audit row, and parties cannot act on it', { skip }, async () => {
  await withReplicas(async (pool, [a], makeUser) => {
    const reporter = await makeUser('reporter');
    const modSubject = await makeUser('modsubject', ['moderator']);
    const mod = await makeUser('mod', ['moderator']);
    const id = (await call(a, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: modSubject.userId, reason: 'harassment', detail: 'secret words' } })).body.id;

    assert.equal((await call(a, 'POST', `/v1/moderation/player-reports/${id}/transition`, { token: modSubject.token, body: { action: 'claim', expectedVersion: 1 } })).status, 403);
    assert.equal((await call(a, 'GET', `/v1/moderation/player-reports/${id}`, { token: modSubject.token })).status, 403);
    // In the SQL queue too, nobody sees a report they are party to, as subject or as filer.
    const modFiler = await makeUser('modfiler', ['moderator']);
    const filed = (await call(a, 'POST', '/v1/reports', { token: modFiler.token, body: { subjectId: reporter.userId, reason: 'spam' } })).body.id;
    const queueOf = async (token: string) => (await call(a, 'GET', '/v1/moderation/player-reports?status=open', { token })).body.items.map((r: { id: string }) => r.id);
    assert.ok(!(await queueOf(modSubject.token)).includes(id), 'the subject does not see it');
    assert.ok(!(await queueOf(modFiler.token)).includes(filed), 'the filer does not see it');
    assert.deepEqual((await queueOf(mod.token)).sort(), [id, filed].sort(), 'an uninvolved moderator sees both');

    await pool.query(`CREATE FUNCTION refuse_view_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'player_reports.view' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER refuse_view_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_view_audit()');
    const blind = await call(a, 'GET', `/v1/moderation/player-reports/${id}`, { token: mod.token });
    assert.equal(blind.status, 500);
    assert.ok(!JSON.stringify(blind.body).includes('secret words'), 'no report text without an audit row');
    await pool.query('DROP TRIGGER refuse_view_audit ON audit_log');

    const seen = await call(a, 'GET', `/v1/moderation/player-reports/${id}`, { token: mod.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.detail, 'secret words');
    const views = (await pool.query(`SELECT actor_id, meta FROM audit_log WHERE action = 'player_reports.view' AND target = $1`, [id])).rows;
    // The subject's refused attempt is on record too: access is audited before anything is read.
    assert.deepEqual(views.map((v) => v.actor_id).sort(), [modSubject.userId, mod.userId].sort());
    assert.ok(!JSON.stringify((await pool.query('SELECT meta FROM audit_log')).rows).includes('secret words'));
  });
});

test('on PostgreSQL, the game check reads the real event log', { skip }, async () => {
  await withReplicas(async (pool, [a], makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    const stranger = await makeUser('stranger');
    const gameId = uuidv7();
    const { events } = Game.create({
      gameId, timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
      players: { white: reporter.userId, black: subject.userId }, rated: true, at: 1000,
    });
    await new PostgresEventStore(pool).append(gameId, -1, events);
    const file = (subjectId: string, game: string) => call(a, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId, gameId: game, reason: 'cheating' } });
    assert.equal((await file(subject.userId, gameId.toUpperCase())).status, 201, 'a game the subject played, in any UUID case');
    assert.equal((await file(stranger.userId, gameId)).status, 422, 'a game the subject did not play');
    assert.equal((await file(subject.userId, uuidv7())).status, 422, 'a game that does not exist');
    assert.equal((await pool.query('SELECT game_id FROM player_reports')).rows[0].game_id, gameId);
  });
});

test('two claims provably in flight at once: exactly one wins, the other gets a conflict', { skip }, async () => {
  await withReplicas(async (pool, [a, b], makeUser) => {
    const reporter = await makeUser('reporter');
    const subject = await makeUser('subject');
    const [mod1, mod2] = [await makeUser('mod1', ['moderator']), await makeUser('mod2', ['moderator'])];
    const id = (await call(a, 'POST', '/v1/reports', { token: reporter.token, body: { subjectId: subject.userId, reason: 'spam' } })).body.id;
    // Hold the report row so both claims reach the database and queue behind it before either runs.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM player_reports WHERE id = $1 FOR UPDATE', [id]);
      const claims = Promise.all([mod1, mod2].map((mod, i) => call([a, b][i]!, 'POST', `/v1/moderation/player-reports/${id}/transition`, {
        token: mod.token, body: { action: 'claim', expectedVersion: 1 },
      })));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%player_reports%'`)).rows[0].n;
        if (waiting >= 2) break;
        assert.ok(Date.now() < deadline, 'both claims should be waiting on the report row');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query('COMMIT');
      assert.deepEqual((await claims).map((c) => c.status).sort(), [200, 409]);
    } finally {
      holder.release();
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'player_reports.claim' AND target = $1`, [id])).rows[0].n, 1);
  });
});
