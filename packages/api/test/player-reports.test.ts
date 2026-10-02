/**
 * Player reports and the moderator triage queue (ADR-0152), against the in-memory composition.
 *
 * The real-PostgreSQL behaviour — concurrent claims, transactional audit, the migration's
 * constraints — is proven in `player-reports.integration.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Game } from '@chess-platform/game';
import { uuidv7 } from '@chess-platform/persistence';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { startHarness, type Harness } from './helpers';

async function playedGame(h: Harness, white: string, black: string): Promise<string> {
  const gameId = uuidv7();
  const { events } = Game.create({
    gameId,
    timeControl: { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' },
    players: { white, black },
    rated: true,
    at: 1000,
  });
  await h.repos.events.append(gameId, -1, events);
  return gameId;
}

function report(h: Harness, token: string, body: unknown) {
  return h.json('POST', '/v1/reports', { token, body });
}

test('a signed-in player reports another player, and sees none of the moderation state', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const bob = await h.makeUser('bob');
    const gameId = await playedGame(h, alice.userId, bob.userId);

    const res = await report(h, alice.token, {
      subjectId: bob.userId, gameId, reason: 'cheating', detail: '  <b>engine</b> moves  ',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'detail', 'gameId', 'id', 'reason', 'subjectId']);
    assert.equal(res.body.subjectId, bob.userId);
    assert.equal(res.body.gameId, gameId);
    assert.equal(res.body.reason, 'cheating');
    assert.equal(res.body.detail, '<b>engine</b> moves', 'detail is trimmed plain text, stored verbatim');

    const stored = await h.repos.playerReports.findById(res.body.id);
    assert.ok(stored);
    assert.equal(stored.reporterId, alice.userId, 'the reporter is the authenticated caller');
    assert.equal(stored.status, 'open');
    assert.equal(stored.version, 1);
  } finally {
    await h.close();
  }
});

test('report intake rejects what it must, before anything is stored', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const bob = await h.makeUser('bob');
    const carol = await h.makeUser('carol');
    const aliceVsCarol = await playedGame(h, alice.userId, carol.userId);

    assert.equal((await h.json('POST', '/v1/reports', { body: { subjectId: bob.userId, reason: 'spam' } })).status, 401);
    // Self-report in any UUID case.
    assert.equal((await report(h, alice.token, { subjectId: alice.userId.toUpperCase(), reason: 'spam' })).status, 422);
    assert.equal((await report(h, alice.token, { subjectId: uuidv7(), reason: 'spam' })).status, 404, 'unknown subject');
    assert.equal((await report(h, alice.token, { subjectId: bob.userId, reason: 'rude' })).status, 422, 'unknown reason');
    assert.equal((await report(h, alice.token, { subjectId: bob.userId, reason: 'spam', detail: 'x'.repeat(1001) })).status, 422);
    // The client never controls moderation fields.
    for (const extra of ['reporterId', 'status', 'assignedTo', 'moderatorNote']) {
      assert.equal((await report(h, alice.token, { subjectId: bob.userId, reason: 'spam', [extra]: bob.userId })).status, 422, extra);
    }
    // A game the subject did not play in, and a game that does not exist.
    assert.equal((await report(h, alice.token, { subjectId: bob.userId, gameId: aliceVsCarol, reason: 'cheating' })).status, 422);
    assert.equal((await report(h, alice.token, { subjectId: bob.userId, gameId: uuidv7(), reason: 'cheating' })).status, 422);

    const mod = await h.makeUser('mod', ['moderator']);
    const queue = await h.json('GET', '/v1/moderation/player-reports?status=open', { token: mod.token });
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.body.items, [], 'no rejected report was stored');
  } finally {
    await h.close();
  }
});

test('report budgets are keyed by the reporter, so nobody can spend a victim\'s ability to report or be reported', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const victim = await h.makeUser('victim');
    const others = await Promise.all([1, 2, 3, 4, 5].map((n) => h.makeUser(`other${n}`)));

    // Three reports of one player from one reporter a day; the fourth is refused with Retry-After.
    for (let i = 0; i < 3; i++) assert.equal((await report(h, alice.token, { subjectId: victim.userId, reason: 'harassment' })).status, 201);
    const repeat = await report(h, alice.token, { subjectId: victim.userId, reason: 'harassment' });
    assert.equal(repeat.status, 429);
    assert.ok(Number(repeat.headers.get('retry-after')) > 0);

    // The pair bucket is alice's alone: others still report the victim, and the victim reports alice.
    for (const other of others) assert.equal((await report(h, other.token, { subjectId: victim.userId, reason: 'spam' })).status, 201);
    assert.equal((await report(h, victim.token, { subjectId: alice.userId, reason: 'harassment' })).status, 201);

    // Five reports an hour per reporter, whoever they are about.
    const reporter = others[0]!;
    for (const subject of others.slice(1)) assert.equal((await report(h, reporter.token, { subjectId: subject.userId, reason: 'spam' })).status, 201);
    assert.equal((await report(h, reporter.token, { subjectId: alice.userId, reason: 'spam' })).status, 429);
  } finally {
    await h.close();
  }
});

test('the moderation queue is for moderators and admins only', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const bob = await h.makeUser('bob');
    const created = await report(h, alice.token, { subjectId: bob.userId, reason: 'spam' });
    const id = created.body.id;
    for (const path of ['/v1/moderation/player-reports?status=open', `/v1/moderation/player-reports/${id}`]) {
      assert.equal((await h.json('GET', path)).status, 401, path);
      assert.equal((await h.json('GET', path, { token: alice.token })).status, 403, path);
    }
    assert.equal((await h.json('POST', `/v1/moderation/player-reports/${id}/transition`, {
      token: alice.token, body: { action: 'claim', expectedVersion: 1 },
    })).status, 403);
    const admin = await h.makeUser('admin', ['admin']);
    assert.equal((await h.json('GET', '/v1/moderation/player-reports?status=open', { token: admin.token })).status, 200);
  } finally {
    await h.close();
  }
});

test('reading a report is audited first; the list carries no report text', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const bob = await h.makeUser('bob');
    const mod = await h.makeUser('mod', ['moderator']);
    const created = await report(h, alice.token, { subjectId: bob.userId, reason: 'harassment', detail: 'private words' });

    const list = await h.json('GET', '/v1/moderation/player-reports?status=open', { token: mod.token });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].detail, undefined, 'list rows omit the detail');
    assert.equal(list.body.items[0].moderatorNote, undefined, 'list rows omit the note');

    const detail = await h.json('GET', `/v1/moderation/player-reports/${created.body.id}`, { token: mod.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.detail, 'private words');
    assert.equal(detail.body.reporterId, alice.userId);
    const views = h.repos.audit.withAction('player_reports.view');
    assert.equal(views.length, 1);
    assert.equal(views[0]!.actorId, mod.userId);
    assert.equal(views[0]!.target, created.body.id);
    assert.ok(!JSON.stringify(h.repos.audit.entries()).includes('private words'), 'report text never reaches the audit log');

    assert.equal((await h.json('GET', `/v1/moderation/player-reports/${uuidv7()}`, { token: mod.token })).status, 404);
  } finally {
    await h.close();
  }
});

test('moderator transitions are compare-and-set: stale versions and illegal moves are 409s, never overwrites', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const bob = await h.makeUser('bob');
    const mod1 = await h.makeUser('mod1', ['moderator']);
    const mod2 = await h.makeUser('mod2', ['moderator']);
    const admin = await h.makeUser('admin', ['admin']);
    const id = (await report(h, alice.token, { subjectId: bob.userId, reason: 'cheating' })).body.id;
    const move = (token: string, body: unknown) => h.json('POST', `/v1/moderation/player-reports/${id}/transition`, { token, body });

    assert.equal((await move(mod1.token, { action: 'resolve', expectedVersion: 1 })).status, 409, 'cannot close an unclaimed report');
    const claimed = await move(mod1.token, { action: 'claim', expectedVersion: 1 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.status, 'reviewing');
    assert.equal(claimed.body.assignedTo, mod1.userId);
    assert.equal(claimed.body.version, 2);

    const late = await move(mod2.token, { action: 'claim', expectedVersion: 1 });
    assert.equal(late.status, 409, 'the second claim with the same version loses');
    assert.equal((await h.repos.playerReports.findById(id))!.assignedTo, mod1.userId, 'and does not take the claim');
    assert.equal((await move(mod2.token, { action: 'dismiss', expectedVersion: 2 })).status, 403, 'only the assignee or an admin closes');
    assert.equal((await move(mod1.token, { action: 'claim', expectedVersion: 2, note: 'x' })).status, 422, 'claims carry no note');

    const resolved = await move(mod1.token, { action: 'resolve', expectedVersion: 2, note: 'engine correlation confirmed' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, 'resolved');
    assert.equal(resolved.body.moderatorNote, 'engine correlation confirmed');
    assert.ok(resolved.body.closedAt);

    // A terminal report stays terminal: the retry with the old version, and with the current one.
    assert.equal((await move(admin.token, { action: 'dismiss', expectedVersion: 2 })).status, 409);
    assert.equal((await move(admin.token, { action: 'dismiss', expectedVersion: 3 })).status, 409);
    assert.equal((await h.repos.playerReports.findById(id))!.status, 'resolved');

    const transitions = h.repos.audit.entries().filter((e) => e.action === 'player_reports.claim' || e.action === 'player_reports.resolve');
    assert.deepEqual(transitions.map((e) => [e.action, e.actorId, e.target]), [
      ['player_reports.claim', mod1.userId, id],
      ['player_reports.resolve', mod1.userId, id],
    ]);
    assert.ok(!JSON.stringify(transitions).includes('engine correlation confirmed'), 'the note never reaches the audit log');

    // An admin may close a report another moderator claimed.
    const second = (await report(h, alice.token, { subjectId: bob.userId, reason: 'spam' })).body.id;
    assert.equal((await h.json('POST', `/v1/moderation/player-reports/${second}/transition`, { token: mod2.token, body: { action: 'claim', expectedVersion: 1 } })).status, 200);
    assert.equal((await h.json('POST', `/v1/moderation/player-reports/${second}/transition`, { token: admin.token, body: { action: 'dismiss', expectedVersion: 2 } })).status, 200);
  } finally {
    await h.close();
  }
});

test('the queue pages deterministically by status, oldest first', async () => {
  const h = await startHarness();
  try {
    const mod = await h.makeUser('mod', ['moderator']);
    const subject = await h.makeUser('subject');
    const reporters = await Promise.all([1, 2, 3, 4, 5].map((n) => h.makeUser(`r${n}`)));
    const ids: string[] = [];
    for (const r of reporters) ids.push((await report(h, r.token, { subjectId: subject.userId, reason: 'spam' })).body.id);
    await h.json('POST', `/v1/moderation/player-reports/${ids[2]}/transition`, { token: mod.token, body: { action: 'claim', expectedVersion: 1 } });

    const open = ids.filter((_, i) => i !== 2);
    const page1 = await h.json('GET', '/v1/moderation/player-reports?status=open&limit=2', { token: mod.token });
    assert.deepEqual(page1.body.items.map((r: { id: string }) => r.id), open.slice(0, 2));
    assert.equal(page1.body.nextAfter, open[1]);
    const page2 = await h.json('GET', `/v1/moderation/player-reports?status=open&limit=2&after=${page1.body.nextAfter}`, { token: mod.token });
    assert.deepEqual(page2.body.items.map((r: { id: string }) => r.id), open.slice(2, 4));
    assert.equal(page2.body.nextAfter, null, 'a full last page says there is nothing after it');
    assert.equal((await h.json('GET', '/v1/moderation/player-reports?status=open&after=not-a-uuid', { token: mod.token })).status, 422);

    const reviewing = await h.json('GET', `/v1/moderation/player-reports?status=reviewing&subjectId=${subject.userId}`, { token: mod.token });
    assert.deepEqual(reviewing.body.items.map((r: { id: string }) => r.id), [ids[2]]);
    assert.equal((await h.json('GET', '/v1/moderation/player-reports', { token: mod.token })).status, 422, 'status is required');
    assert.equal((await h.json('GET', '/v1/moderation/player-reports?status=closed', { token: mod.token })).status, 422);
  } finally {
    await h.close();
  }
});

test('nobody triages a report they are party to, admins included', async () => {
  const h = await startHarness();
  try {
    const alice = await h.makeUser('alice');
    const modSubject = await h.makeUser('modsubject', ['moderator']);
    const modReporter = await h.makeUser('modreporter', ['moderator']);
    const adminSubject = await h.makeUser('adminsubject', ['admin']);
    const other = await h.makeUser('othermod', ['moderator']);
    const aboutMod = (await report(h, alice.token, { subjectId: modSubject.userId, reason: 'cheating' })).body.id;
    const byMod = (await report(h, modReporter.token, { subjectId: alice.userId, reason: 'spam' })).body.id;
    const aboutAdmin = (await report(h, alice.token, { subjectId: adminSubject.userId, reason: 'harassment' })).body.id;
    const claim = (token: string, id: string) => h.json('POST', `/v1/moderation/player-reports/${id}/transition`, { token, body: { action: 'claim', expectedVersion: 1 } });

    assert.equal((await claim(modSubject.token, aboutMod)).status, 403, 'the subject cannot claim it');
    assert.equal((await claim(modReporter.token, byMod)).status, 403, 'the reporter cannot claim it');
    assert.equal((await claim(adminSubject.token, aboutAdmin)).status, 403, 'nor can an admin about whom it is');
    assert.equal((await h.json('GET', `/v1/moderation/player-reports/${aboutMod}`, { token: modSubject.token })).status, 403);
    assert.equal((await h.json('GET', `/v1/moderation/player-reports?status=open&subjectId=${modSubject.userId}`, { token: modSubject.token })).status, 403);
    const listed = await h.json('GET', '/v1/moderation/player-reports?status=open', { token: modSubject.token });
    assert.ok(!listed.body.items.some((r: { id: string }) => r.id === aboutMod), 'a moderator never sees the queue entries about them');
    assert.ok(listed.body.items.some((r: { id: string }) => r.id === byMod));
    // Nor does a moderator who filed a report see its state or the internal note.
    assert.equal((await h.json('GET', `/v1/moderation/player-reports/${byMod}`, { token: modReporter.token })).status, 403);
    const filerView = await h.json('GET', '/v1/moderation/player-reports?status=open', { token: modReporter.token });
    assert.ok(!filerView.body.items.some((r: { id: string }) => r.id === byMod), 'a moderator does not see the reports they filed');

    // Someone else can, and an admin closing another moderator's claim is recorded as an override.
    assert.equal((await claim(other.token, aboutMod)).status, 200);
    const admin = await h.makeUser('admin', ['admin']);
    assert.equal((await h.json('POST', `/v1/moderation/player-reports/${aboutMod}/transition`, { token: admin.token, body: { action: 'dismiss', expectedVersion: 2 } })).status, 200);
    const dismissed = h.repos.audit.withAction('player_reports.dismiss');
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0]!.actorId, admin.userId);
    assert.equal(dismissed[0]!.meta?.['previousAssignee'], other.userId);
    assert.equal((await h.json('POST', `/v1/moderation/player-reports/${aboutMod}/transition`, { body: { action: 'claim', expectedVersion: 1 } })).status, 401);
  } finally {
    await h.close();
  }
});

test('the address and daily budgets refuse independently of the hourly one', async () => {
  const h = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      playerReport: { ...DEFAULT_RATE_LIMIT.playerReport, perIp: { maxRequests: 2, windowMs: 3_600_000 } },
    },
  });
  try {
    const subject = await h.makeUser('subject');
    const reporters = await Promise.all([1, 2, 3].map((n) => h.makeUser(`ipr${n}`)));
    assert.equal((await report(h, reporters[0]!.token, { subjectId: subject.userId, reason: 'spam' })).status, 201);
    assert.equal((await report(h, reporters[1]!.token, { subjectId: subject.userId, reason: 'spam' })).status, 201);
    assert.equal((await report(h, reporters[2]!.token, { subjectId: subject.userId, reason: 'spam' })).status, 429, 'a third account from the same address');
  } finally {
    await h.close();
  }
  const daily = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      playerReport: { ...DEFAULT_RATE_LIMIT.playerReport, perUserDaily: { maxRequests: 2, windowMs: 86_400_000 } },
    },
  });
  try {
    const reporter = await daily.makeUser('reporter');
    const subjects = await Promise.all([1, 2, 3].map((n) => daily.makeUser(`ds${n}`)));
    for (const s of subjects.slice(0, 2)) assert.equal((await report(daily, reporter.token, { subjectId: s.userId, reason: 'spam' })).status, 201);
    assert.equal((await report(daily, reporter.token, { subjectId: subjects[2]!.userId, reason: 'spam' })).status, 429, 'a day of reports is spent');
  } finally {
    await daily.close();
  }
});
