import test from 'node:test';
import assert from 'node:assert/strict';
import { PasswordResetController } from '../src/app/password-reset-controller.js';
import type { PasswordResetCallbacks } from '../src/app/password-reset-controller.js';
import { createI18nManager } from '../src/i18n/index.js';
import { GambitClient } from '../src/api/client.js';

const testI18n = createI18nManager();
import { FakeTransport, empty, json } from './support/fake-transport.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';

function makeClient(transport: HttpTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => {},
    now: () => 1000,
  });
}

function makeHarness(transport: HttpTransport) {
  const pendingLogs: boolean[] = [];
  const errorLogs: (string | null)[] = [];
  const successLogs: (string | null)[] = [];
  let invalidatedCount = 0;

  const callbacks: PasswordResetCallbacks = {
    onPending: (p) => pendingLogs.push(p),
    onError: (e) => errorLogs.push(e),
    onSuccess: (s) => successLogs.push(s),
    onSessionInvalidated: () => { invalidatedCount++; },
  };

  const client = makeClient(transport);
  const controller = new PasswordResetController({ client, callbacks, i18n: testI18n });

  return { controller, pendingLogs, errorLogs, successLogs, getInvalidatedCount: () => invalidatedCount };
}

test('requestReset: empty input sets error and returns false', async () => {
  const t = new FakeTransport();
  const { controller, errorLogs } = makeHarness(t);

  const res = await controller.requestReset('   ');
  assert.equal(res, false);
  assert.equal(t.calls.length, 0);
  assert.equal(errorLogs.at(-1), 'Please enter your handle or email address.');
});

test('requestReset: successful dispatch returns generic success message', async () => {
  const t = new FakeTransport(() => empty(202));
  const { controller, pendingLogs, successLogs, errorLogs } = makeHarness(t);

  const res = await controller.requestReset('alice@example.com');
  assert.equal(res, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/password-reset/request');
  assert.equal(t.calls[0]!.body, JSON.stringify({ handleOrEmail: 'alice@example.com' }));

  assert.equal(errorLogs.at(-1), null);
  assert.match(successLogs.at(-1) ?? '', /If an account matching/);
  assert.deepEqual(pendingLogs, [true, false]);
});

test('confirmReset: client validation errors', async () => {
  const t = new FakeTransport();
  const { controller, errorLogs } = makeHarness(t);

  // Missing token
  assert.equal(await controller.confirmReset('', 'password123', 'password123'), false);
  assert.match(errorLogs.at(-1) ?? '', /invalid or has expired/);

  // Password too short (<8)
  assert.equal(await controller.confirmReset('tok', 'short', 'short'), false);
  assert.match(errorLogs.at(-1) ?? '', /between 8 and 1024/);

  // Password mismatch
  assert.equal(await controller.confirmReset('tok', 'password123', 'different123'), false);
  assert.match(errorLogs.at(-1) ?? '', /do not match/);

  assert.equal(t.calls.length, 0);
});

test('confirmReset: success sets message and triggers onSessionInvalidated', async () => {
  const t = new FakeTransport(() => empty(204));
  const { controller, pendingLogs, successLogs, getInvalidatedCount } = makeHarness(t);

  const res = await controller.confirmReset('valid-token', 'newpassword123', 'newpassword123');
  assert.equal(res, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/password-reset/confirm');
  assert.equal(t.calls[0]!.body, JSON.stringify({ token: 'valid-token', newPassword: 'newpassword123' }));

  assert.match(successLogs.at(-1) ?? '', /reset successfully/);
  assert.equal(getInvalidatedCount(), 1);
  assert.deepEqual(pendingLogs, [true, false]);
});

test('confirmReset: 401 response sets friendly invalid/expired error message', async () => {
  const t = new FakeTransport(() => json(401, { error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } }));
  const { controller, errorLogs } = makeHarness(t);

  const res = await controller.confirmReset('expired-token', 'newpassword123', 'newpassword123');
  assert.equal(res, false);
  assert.match(errorLogs.at(-1) ?? '', /invalid or has expired/);
});

test('duplicate submission prevention', async () => {
  let resolveReq!: (res: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const deferTransport: HttpTransport = {
    send(req) {
      calls.push(req);
      return new Promise((resolve) => { resolveReq = resolve; });
    },
  };
  const { controller } = makeHarness(deferTransport);

  const p1 = controller.requestReset('alice');
  const p2 = controller.requestReset('alice'); // Concurrent call while in flight

  assert.equal(await p2, false); // Blocked immediately by isSubmitting guard
  resolveReq(empty(202));
  assert.equal(await p1, true);
  assert.equal(calls.length, 1);
});

test('disposal prevents completion callbacks and new submissions', async () => {
  let resolveReq!: (res: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const deferTransport: HttpTransport = {
    send(req) {
      calls.push(req);
      return new Promise((resolve) => { resolveReq = resolve; });
    },
  };
  const { controller, successLogs } = makeHarness(deferTransport);

  const p1 = controller.requestReset('alice');
  controller.dispose();

  assert.equal(await controller.requestReset('bob'), false);
  resolveReq(empty(202));
  assert.equal(await p1, false);
  assert.equal(successLogs.filter((s) => s !== null).length, 0);
});
