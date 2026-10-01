import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { createI18nManager } from '../src/i18n/index.js';
import { mountEmailVerification } from '../src/app/email-verification-mount.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { FakeTransport, empty, json } from './support/fake-transport.js';

interface MutableEmailVerificationElement {
  hidden: boolean;
  textContent: string;
  disabled: boolean;
  onclick: ((event: Event) => void) | null;
  readonly attributes: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
}

const EMAIL_VERIFICATION_IDS = [
  'email-verify',
  'email-verify-status',
  'email-verify-error',
  'email-verify-retry',
] as const;

const defaultI18n = createI18nManager();

function mutableEmailVerificationElement(): MutableEmailVerificationElement {
  const attributes = new Map<string, string>();
  return {
    hidden: false,
    textContent: '',
    disabled: false,
    onclick: null,
    attributes,
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function emailVerificationDocument(): {
  readonly doc: Document;
  readonly element: (id: typeof EMAIL_VERIFICATION_IDS[number]) => MutableEmailVerificationElement;
} {
  const elements = new Map(
    EMAIL_VERIFICATION_IDS.map((id) => [id, mutableEmailVerificationElement()] as const),
  );
  return {
    doc: {
      getElementById: (id: string) => elements.get(id as typeof EMAIL_VERIFICATION_IDS[number]) ?? null,
    } as unknown as Document,
    element: (id) => elements.get(id)!,
  };
}

function emailVerificationClient(transport: HttpTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => undefined,
    now: () => 1000,
  });
}

function click(element: MutableEmailVerificationElement): void {
  element.onclick?.({ preventDefault: () => undefined } as unknown as Event);
}

function settleRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('missing token: no request, error copy shown, retry button stays hidden', async () => {
  const transport = new FakeTransport();
  const surface = emailVerificationDocument();

  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: null,
    i18n: defaultI18n,
  });
  await settleRequests();

  assert.equal(transport.calls.length, 0);
  assert.equal(
    surface.element('email-verify-error').textContent,
    'This page needs a verification link. Open the link in the verification email we sent you.',
  );
  assert.equal(surface.element('email-verify-retry').hidden, true);
  assert.equal(surface.element('email-verify').attributes.get('aria-busy'), 'false');
});

test('valid token: issues one request with body, shows success copy, hides retry, resets aria-busy', async () => {
  const transport = new FakeTransport(() => empty(204));
  const surface = emailVerificationDocument();

  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'valid-token-123',
    i18n: defaultI18n,
  });
  await settleRequests();

  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0]!.body,
    JSON.stringify({ token: 'valid-token-123' }),
  );
  assert.equal(surface.element('email-verify-status').textContent, 'Your email address is verified.');
  assert.equal(surface.element('email-verify-error').textContent, '');
  assert.equal(surface.element('email-verify-retry').hidden, true);
  assert.equal(surface.element('email-verify').attributes.get('aria-busy'), 'false');

  // After success, invoking retry handler issues no second request
  click(surface.element('email-verify-retry'));
  await settleRequests();
  assert.equal(transport.calls.length, 1);
});

test('401 error: error copy shown, retry hidden, and programmatic retry issues no request', async () => {
  const transport = new FakeTransport(() => json(401, {
    error: { message: 'Token invalid or expired', code: 'UNAUTHORIZED' },
  }));
  const surface = emailVerificationDocument();

  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'expired-token',
    i18n: defaultI18n,
  });
  await settleRequests();

  assert.equal(transport.calls.length, 1);
  assert.equal(
    surface.element('email-verify-error').textContent,
    'This verification link is invalid, has expired, or has already been used.',
  );
  assert.equal(surface.element('email-verify-retry').hidden, true);
  assert.equal(surface.element('email-verify').attributes.get('aria-busy'), 'false');

  // Programmatic retry is blocked because token was released on terminal failure
  click(surface.element('email-verify-retry'));
  await settleRequests();
  assert.equal(transport.calls.length, 1);
});

test('500 error: retry becomes visible, retry click issues second request, success copy appears on 204', async () => {
  let requestCount = 0;
  const transport = new FakeTransport().onEach(() => {
    requestCount++;
    if (requestCount === 1) {
      return json(500, { error: { message: 'Internal error', code: 'INTERNAL_ERROR' } });
    }
    return empty(204);
  });
  const surface = emailVerificationDocument();

  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'retryable-token',
    i18n: defaultI18n,
  });
  await settleRequests();

  assert.equal(transport.calls.length, 1);
  assert.equal(
    surface.element('email-verify-error').textContent,
    'We could not verify your email address right now. Please try again.',
  );
  assert.equal(surface.element('email-verify-retry').hidden, false);
  assert.equal(surface.element('email-verify-retry').disabled, false);

  // Invoke retry
  click(surface.element('email-verify-retry'));
  await settleRequests();

  assert.equal(transport.calls.length, 2);
  assert.equal(
    transport.calls[1]!.body,
    JSON.stringify({ token: 'retryable-token' }),
  );
  assert.equal(surface.element('email-verify-status').textContent, 'Your email address is verified.');
  assert.equal(surface.element('email-verify-retry').hidden, true);
});

test('disposing during a pending request restores idle controls and leaves UI unchanged on resolution', async () => {
  let releaseRequest!: (response: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = {
    send(request) {
      calls.push(request);
      return new Promise((resolve) => { releaseRequest = resolve; });
    },
  };
  const surface = emailVerificationDocument();

  const mounted = mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'pending-token',
    i18n: defaultI18n,
  });

  assert.equal(calls.length, 1);
  assert.equal(surface.element('email-verify').attributes.get('aria-busy'), 'true');
  assert.equal(surface.element('email-verify-retry').disabled, true);
  assert.equal(surface.element('email-verify-status').textContent, 'Verifying your email address...');

  mounted.dispose();
  assert.equal(surface.element('email-verify-retry').onclick, null);
  assert.equal(surface.element('email-verify').attributes.get('aria-busy'), 'false');
  assert.equal(surface.element('email-verify-retry').disabled, false);

  const statusTextAtDispose = surface.element('email-verify-status').textContent;
  const errorTextAtDispose = surface.element('email-verify-error').textContent;

  releaseRequest(empty(204));
  await settleRequests();

  assert.equal(surface.element('email-verify-status').textContent, statusTextAtDispose);
  assert.equal(surface.element('email-verify-error').textContent, errorTextAtDispose);
});

test('dispose twice is safe and does not re-touch the DOM', () => {
  const transport = new FakeTransport(() => empty(204));
  const surface = emailVerificationDocument();

  const mounted = mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'test-token',
    i18n: defaultI18n,
  });

  mounted.dispose();
  assert.doesNotThrow(() => {
    mounted.dispose();
  });
});

test('mounting twice on the same document leaves exactly one live retry handler', async () => {
  let callCount = 0;
  const transport = new FakeTransport().onEach(() => {
    callCount++;
    return json(500, { error: { message: 'Failed' } });
  });
  const surface = emailVerificationDocument();

  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'token-1',
    i18n: defaultI18n,
  });
  await settleRequests();
  assert.equal(transport.calls.length, 1);

  // Mount a second time (property assignment overwrites onclick)
  mountEmailVerification({
    doc: surface.doc,
    client: emailVerificationClient(transport),
    verificationToken: 'token-2',
    i18n: defaultI18n,
  });
  await settleRequests();
  assert.equal(transport.calls.length, 2);

  // One click on retry button triggers exactly one new request
  click(surface.element('email-verify-retry'));
  await settleRequests();
  assert.equal(transport.calls.length, 3);
  assert.equal(transport.calls[2]!.body, JSON.stringify({ token: 'token-2' }));
});
