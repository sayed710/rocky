import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailVerificationController } from '../src/app/email-verification-controller.js';
import type { EmailVerificationCallbacks } from '../src/app/email-verification-controller.js';
import { createI18nManager } from '../src/i18n/index.js';
import { GambitClient } from '../src/api/client.js';
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
  const retryableLogs: boolean[] = [];

  const callbacks: EmailVerificationCallbacks = {
    onPending: (p) => pendingLogs.push(p),
    onError: (e) => errorLogs.push(e),
    onSuccess: (s) => successLogs.push(s),
    onRetryable: (r) => retryableLogs.push(r),
  };

  const client = makeClient(transport);
  const controller = new EmailVerificationController({ client, callbacks, i18n: createI18nManager() });

  return {
    controller,
    callbacks,
    pendingLogs,
    errorLogs,
    successLogs,
    retryableLogs,
  };
}

test('verify: null/empty token sets missing-link error copy, onRetryable(false), and makes no transport call', async () => {
  const t = new FakeTransport();
  const { controller, errorLogs, retryableLogs, successLogs } = makeHarness(t);

  const res = await controller.verify(null);
  assert.equal(res, false);
  assert.equal(t.calls.length, 0);
  assert.equal(
    errorLogs.at(-1),
    'This page needs a verification link. Open the link in the verification email we sent you.',
  );
  assert.equal(retryableLogs.at(-1), false);
  assert.equal(successLogs.at(-1), null);

  const res2 = await controller.verify('');
  assert.equal(res2, false);
  assert.equal(t.calls.length, 0);
});

test('verify: 204 success reports success copy, onRetryable(false), and prevents replay', async () => {
  const t = new FakeTransport(() => empty(204));
  const { controller, pendingLogs, successLogs, errorLogs, retryableLogs } = makeHarness(t);

  const res = await controller.verify('valid-token');
  assert.equal(res, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/email/verify');
  assert.equal(t.calls[0]!.body, JSON.stringify({ token: 'valid-token' }));

  assert.equal(errorLogs.at(-1), null);
  assert.equal(successLogs.at(-1), 'Your email address is verified.');
  assert.equal(retryableLogs.at(-1), false);
  assert.deepEqual(pendingLogs, [true, false]);

  // Terminal: second verify() with same token does not issue any request
  const res2 = await controller.verify('valid-token');
  assert.equal(res2, false);
  assert.equal(t.calls.length, 1);
});

test('verify: 401 response sets invalid/expired/used copy and prevents replay', async () => {
  const t = new FakeTransport(() => json(401, { error: { message: 'Token invalid', code: 'UNAUTHORIZED' } }));
  const { controller, errorLogs, retryableLogs, successLogs } = makeHarness(t);

  const res = await controller.verify('expired-token');
  assert.equal(res, false);
  assert.equal(t.calls.length, 1);
  assert.equal(
    errorLogs.at(-1),
    'This verification link is invalid, has expired, or has already been used.',
  );
  assert.equal(retryableLogs.at(-1), false);
  assert.equal(successLogs.at(-1), null);

  // Terminal: second verify() does not issue any request
  const res2 = await controller.verify('expired-token');
  assert.equal(res2, false);
  assert.equal(t.calls.length, 1);
});

test('verify: 500 error sets transient error copy, onRetryable(true), and allows retry', async () => {
  let callCount = 0;
  const distinctiveToken = 'distinctive-token-xyz-12345';
  const t = new FakeTransport().onEach(() => {
    callCount++;
    if (callCount === 1) {
      return json(500, { error: { message: 'Internal error with token distinctive-token-xyz-12345', code: 'SERVER_ERROR' } });
    }
    return empty(204);
  });
  const { controller, errorLogs, retryableLogs, successLogs } = makeHarness(t);

  const res1 = await controller.verify(distinctiveToken);
  assert.equal(res1, false);
  assert.equal(t.calls.length, 1);
  const errMsg = errorLogs.at(-1)!;
  assert.equal(errMsg, 'We could not verify your email address right now. Please try again.');
  assert.equal(errMsg.includes(distinctiveToken), false, 'transient error copy must not include token');
  assert.equal(errMsg.includes('500'), false, 'transient error copy must not include status code');
  assert.equal(retryableLogs.at(-1), true);

  // Retryable: second verify() DOES issue a second call
  const res2 = await controller.verify(distinctiveToken);
  assert.equal(res2, true);
  assert.equal(t.calls.length, 2);
  assert.equal(successLogs.at(-1), 'Your email address is verified.');
  assert.equal(retryableLogs.at(-1), false);
});

test('verify: concurrent verify call while in flight issues no second request', async () => {
  let resolveReq!: (res: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const deferTransport: HttpTransport = {
    send(req) {
      calls.push(req);
      return new Promise((resolve) => { resolveReq = resolve; });
    },
  };
  const { controller } = makeHarness(deferTransport);

  const p1 = controller.verify('token-in-flight');
  const p2 = controller.verify('token-in-flight');

  assert.equal(await p2, false);
  resolveReq(empty(204));
  assert.equal(await p1, true);
  assert.equal(calls.length, 1);
});

test('verify: completion after dispose() invokes no callback at all', async () => {
  let resolveReq!: (res: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const deferTransport: HttpTransport = {
    send(req) {
      calls.push(req);
      return new Promise((resolve) => { resolveReq = resolve; });
    },
  };
  const pendingLogs: boolean[] = [];
  const errorLogs: (string | null)[] = [];
  const successLogs: (string | null)[] = [];
  const retryableLogs: boolean[] = [];

  const callbacks: EmailVerificationCallbacks = {
    onPending: (p) => pendingLogs.push(p),
    onError: (e) => errorLogs.push(e),
    onSuccess: (s) => successLogs.push(s),
    onRetryable: (r) => retryableLogs.push(r),
  };

  const client = makeClient(deferTransport);
  const controller = new EmailVerificationController({ client, callbacks, i18n: createI18nManager() });

  const p1 = controller.verify('my-token');
  // Initial pending callback fired before dispose
  assert.deepEqual(pendingLogs, [true]);

  controller.dispose();
  // Snapshot every collection, not a count of the non-null entries in two of them: a stale
  // completion that pushed `onError(null)`, `onSuccess(null)` or `onRetryable(false)` would leave
  // a filtered count untouched while still having driven the surface after the route was gone.
  const atDispose = {
    pending: [...pendingLogs],
    error: [...errorLogs],
    success: [...successLogs],
    retryable: [...retryableLogs],
  };

  resolveReq(empty(204));
  assert.equal(await p1, false);

  assert.deepEqual(
    { pending: pendingLogs, error: errorLogs, success: successLogs, retryable: retryableLogs },
    atDispose,
    'a completion after dispose must not invoke any callback at all',
  );
});

test('dispose() twice is safe and later verify() is a no-op', async () => {
  const t = new FakeTransport(() => empty(204));
  const { controller } = makeHarness(t);

  controller.dispose();
  controller.dispose();

  const res = await controller.verify('any-token');
  assert.equal(res, false);
  assert.equal(t.calls.length, 0);
});
