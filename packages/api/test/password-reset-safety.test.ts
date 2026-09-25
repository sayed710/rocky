import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startHarness } from './helpers';
import type { EmailDeliveryOutcome, EmailDeliveryResult, EmailSender } from '../src/ports/email';

class ResetSender implements EmailSender {
  readonly sent: { to: string; token: string }[] = [];
  outcome: EmailDeliveryOutcome = 'success';
  pending: Promise<EmailDeliveryResult> | null = null;
  started: (() => void) | null = null;

  async sendPasswordReset(to: string, token: string): Promise<EmailDeliveryResult> {
    this.sent.push({ to, token });
    this.started?.();
    return this.pending ?? { outcome: this.outcome };
  }
  async sendEmailVerification(): Promise<EmailDeliveryResult> { return { outcome: 'success' }; }
  async sendLoginCode(): Promise<EmailDeliveryResult> { return { outcome: 'success' }; }
}

test('rotating attacker addresses cannot block recovery or replace the live link', async () => {
  const sender = new ResetSender();
  const h = await startHarness({ trustProxy: true }, { emailSender: sender });
  try {
    await h.repos.users.create({ id: '01945e20-0000-7000-8000-000000000111', handle: 'resetowner', email: 'owner@example.test' });
    for (let i = 0; i < 12; i++) {
      const response = await h.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: i % 2 ? 'resetowner' : 'owner@example.test' },
        headers: { 'x-forwarded-for': `192.0.2.${i + 1}` },
      });
      assert.equal(response.status, 202);
    }
    await h.auth.drainBackground();
    assert.equal(sender.sent.length, 1, 'only the first request emails a live token');
    const owner = await h.json('POST', '/v1/auth/password-reset/request', {
      body: { handleOrEmail: 'resetowner' }, headers: { 'x-forwarded-for': '198.51.100.10' },
    });
    assert.equal(owner.status, 202, 'the target has no attacker-spendable hard bucket');
    await h.auth.drainBackground();
    assert.equal(sender.sent.length, 1);

    const first = sender.sent[0]!.token;
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: first, newPassword: 'newpassword123' },
    })).status, 204, 'the original link survives all later requests');
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: first, newPassword: 'anotherpassword123' },
    })).status, 401, 'the reset link is single-use');
  } finally { await h.close(); }
});

test('known and unknown targets have the same public answer', async () => {
  const h = await startHarness({ trustProxy: true });
  try {
    await h.repos.users.create({ id: '01945e20-0000-7000-8000-000000000112', handle: 'knownreset', email: 'known@example.test' });
    const request = (handleOrEmail: string, ip: string) => h.json('POST', '/v1/auth/password-reset/request', {
      body: { handleOrEmail }, headers: { 'x-forwarded-for': ip },
    });
    const known = await request('knownreset', '192.0.2.1');
    const unknown = await request('unknownreset', '192.0.2.2');
    assert.equal(known.status, 202);
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    const publicHeaders = (headers: Headers) => [...headers.entries()]
      .filter(([key]) => !['date', 'x-request-id', 'trace-id', 'traceparent'].includes(key));
    assert.deepEqual(publicHeaders(known.headers), publicHeaders(unknown.headers));
    await h.auth.drainBackground();
  } finally { await h.close(); }
});

test('public reset response does not wait for account lookup', async () => {
  const h = await startHarness();
  const original = h.repos.users.findByHandle.bind(h.repos.users);
  let lookupCalled = false;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  h.repos.users.findByHandle = async (handle) => {
    lookupCalled = true;
    await blocked;
    return original(handle);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      h.json('POST', '/v1/auth/password-reset/request', { body: { handleOrEmail: 'delayedlookup' } }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('request waited for lookup')), 2_000);
      }),
    ]);
    assert.equal(response.status, 202);
  } finally {
    if (timer) clearTimeout(timer);
    release!();
    await h.auth.drainBackground();
    await h.close();
  }
  assert.equal(lookupCalled, true, 'lookup really ran after the public response');
});

test('definitive rejection drops only its token and allows retry', async () => {
  const sender = new ResetSender();
  sender.outcome = 'provider_rejected';
  const h = await startHarness({}, { emailSender: sender });
  try {
    await h.repos.users.create({ id: '01945e20-0000-7000-8000-000000000113', handle: 'rejectedreset', email: 'rejected@example.test' });
    const request = () => h.json('POST', '/v1/auth/password-reset/request', { body: { handleOrEmail: 'rejectedreset' } });
    assert.equal((await request()).status, 202);
    await h.auth.drainBackground();
    const rejected = sender.sent[0]!.token;
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: rejected, newPassword: 'newpassword123' },
    })).status, 401);

    sender.outcome = 'success';
    assert.equal((await request()).status, 202);
    await h.auth.drainBackground();
    assert.equal(sender.sent.length, 2);
    assert.notEqual(sender.sent[1]!.token, rejected);
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: sender.sent[1]!.token, newPassword: 'newpassword123' },
    })).status, 204);
  } finally { await h.close(); }
});

for (const ambiguousOutcome of ['timeout', 'provider_error'] as const) {
test(`${ambiguousOutcome} keeps the original usable link and suppresses another email`, async () => {
  const sender = new ResetSender();
  sender.outcome = ambiguousOutcome;
  const h = await startHarness({}, { emailSender: sender });
  try {
    await h.repos.users.create({ id: '01945e20-0000-7000-8000-000000000114', handle: 'timeoutreset', email: 'timeout@example.test' });
    for (let i = 0; i < 4; i++) {
      assert.equal((await h.json('POST', '/v1/auth/password-reset/request', {
        body: { handleOrEmail: 'timeoutreset' },
      })).status, 202);
      await h.auth.drainBackground();
    }
    assert.equal(sender.sent.length, 1);
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: sender.sent[0]!.token, newPassword: 'newpassword123' },
    })).status, 204);
  } finally { await h.close(); }
});
}

test('graceful drain waits for an email queued by accepted reset work', async () => {
  const sender = new ResetSender();
  let release: ((result: EmailDeliveryResult) => void) | undefined;
  sender.pending = new Promise((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { sender.started = resolve; });
  const h = await startHarness({}, { emailSender: sender });
  try {
    await h.repos.users.create({ id: '01945e20-0000-7000-8000-000000000115', handle: 'drainreset', email: 'drain@example.test' });
    assert.equal((await h.json('POST', '/v1/auth/password-reset/request', {
      body: { handleOrEmail: 'drainreset' },
    })).status, 202);
    await started;
    let drained = false;
    const draining = h.auth.drainBackground().then(() => { drained = true; });
    await setImmediate();
    assert.equal(drained, false, 'accepted delivery remains tracked');
    release!({ outcome: 'provider_throttled' });
    await draining;
    assert.equal(drained, true);
    assert.equal((await h.json('POST', '/v1/auth/password-reset/confirm', {
      body: { token: sender.sent[0]!.token, newPassword: 'newpassword123' },
    })).status, 401, 'the definitively unsent token was discarded before shutdown completed');
  } finally { await h.close(); }
});
