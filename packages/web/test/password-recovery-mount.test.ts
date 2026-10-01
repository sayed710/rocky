import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { createI18nManager } from '../src/i18n/index.js';
import { mountPasswordRecovery } from '../src/app/password-recovery-mount.js';

const defaultI18n = createI18nManager();
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import { FakeTransport, empty, json } from './support/fake-transport.js';

interface MutablePasswordRecoveryElement {
  hidden: boolean;
  textContent: string;
  disabled: boolean;
  value: string;
  onsubmit: ((event: Event) => void) | null;
  readonly attributes: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
}

const PASSWORD_RECOVERY_IDS = [
  'password-reset-request-view',
  'password-reset-confirm-view',
  'password-reset-request-form',
  'password-reset-confirm-form',
  'password-reset-request-input',
  'password-reset-confirm-password',
  'password-reset-confirm-password-confirm',
  'password-reset-request-submit',
  'password-reset-confirm-submit',
  'password-reset-status',
  'password-reset-error',
] as const;

function mutablePasswordRecoveryElement(): MutablePasswordRecoveryElement {
  const attributes = new Map<string, string>();
  return {
    hidden: false,
    textContent: '',
    disabled: false,
    value: '',
    onsubmit: null,
    attributes,
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function passwordRecoveryDocument(): {
  readonly doc: Document;
  readonly element: (id: typeof PASSWORD_RECOVERY_IDS[number]) => MutablePasswordRecoveryElement;
} {
  const elements = new Map(
    PASSWORD_RECOVERY_IDS.map((id) => [id, mutablePasswordRecoveryElement()] as const),
  );
  return {
    doc: {
      getElementById: (id: string) => elements.get(id as typeof PASSWORD_RECOVERY_IDS[number]) ?? null,
    } as unknown as Document,
    element: (id) => elements.get(id)!,
  };
}

function passwordRecoveryClient(transport: HttpTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => undefined,
    now: () => 1000,
  });
}

function submit(form: MutablePasswordRecoveryElement): void {
  form.onsubmit?.({ preventDefault: () => undefined } as unknown as Event);
}

function settleRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('successful confirmation releases the token and clears the local session once', async () => {
  const transport = new FakeTransport(() => empty(204));
  const surface = passwordRecoveryDocument();
  let sessionInvalidations = 0;
  mountPasswordRecovery({
    doc: surface.doc,
    client: passwordRecoveryClient(transport),
    resetToken: 'secret-token',
    onSessionInvalidated: () => { sessionInvalidations += 1; },
    i18n: defaultI18n,
  });

  assert.equal(surface.element('password-reset-request-view').hidden, true);
  assert.equal(surface.element('password-reset-confirm-view').hidden, false);
  surface.element('password-reset-confirm-password').value = 'newpassword123';
  surface.element('password-reset-confirm-password-confirm').value = 'newpassword123';
  submit(surface.element('password-reset-confirm-form'));
  await settleRequests();

  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0]!.body,
    JSON.stringify({ token: 'secret-token', newPassword: 'newpassword123' }),
  );
  assert.match(surface.element('password-reset-status').textContent, /reset successfully/);
  assert.equal(surface.element('password-reset-confirm-password').value, '');
  assert.equal(surface.element('password-reset-confirm-password-confirm').value, '');
  assert.equal(surface.element('password-reset-confirm-view').hidden, true);
  assert.equal(sessionInvalidations, 1);

  submit(surface.element('password-reset-confirm-form'));
  await settleRequests();
  assert.equal(transport.calls.length, 1);
  assert.equal(sessionInvalidations, 1);
});

test('invalid confirmation keeps the token and entered passwords available for retry', async () => {
  const transport = new FakeTransport(() => json(401, {
    error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' },
  }));
  const surface = passwordRecoveryDocument();
  let sessionInvalidations = 0;
  mountPasswordRecovery({
    doc: surface.doc,
    client: passwordRecoveryClient(transport),
    resetToken: 'expired-token',
    onSessionInvalidated: () => { sessionInvalidations += 1; },
    i18n: defaultI18n,
  });

  surface.element('password-reset-confirm-password').value = 'newpassword123';
  surface.element('password-reset-confirm-password-confirm').value = 'newpassword123';
  submit(surface.element('password-reset-confirm-form'));
  await settleRequests();

  assert.match(surface.element('password-reset-error').textContent, /invalid or has expired/);
  assert.equal(surface.element('password-reset-confirm-password').value, 'newpassword123');
  assert.equal(surface.element('password-reset-confirm-password-confirm').value, 'newpassword123');
  assert.equal(surface.element('password-reset-confirm-view').hidden, false);
  assert.equal(sessionInvalidations, 0);

  submit(surface.element('password-reset-confirm-form'));
  await settleRequests();
  assert.equal(transport.calls.length, 2);
  assert.equal(
    transport.calls[1]!.body,
    JSON.stringify({ token: 'expired-token', newPassword: 'newpassword123' }),
  );
});

test('disposing a pending request restores idle controls and suppresses stale completion', async () => {
  let releaseRequest!: (response: HttpResponse) => void;
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = {
    send(request) {
      calls.push(request);
      return new Promise((resolve) => { releaseRequest = resolve; });
    },
  };
  const surface = passwordRecoveryDocument();
  surface.element('password-reset-request-form').setAttribute('aria-busy', 'true');
  surface.element('password-reset-request-submit').disabled = true;
  const mounted = mountPasswordRecovery({
    doc: surface.doc,
    client: passwordRecoveryClient(transport),
    resetToken: null,
    onSessionInvalidated: () => undefined,
    i18n: defaultI18n,
  });

  assert.equal(surface.element('password-reset-request-form').attributes.get('aria-busy'), 'false');
  assert.equal(surface.element('password-reset-request-submit').disabled, false);
  surface.element('password-reset-request-input').value = 'alice@example.com';
  submit(surface.element('password-reset-request-form'));
  assert.equal(calls.length, 1);
  assert.equal(surface.element('password-reset-request-form').attributes.get('aria-busy'), 'true');
  assert.equal(surface.element('password-reset-request-submit').disabled, true);

  mounted.dispose();
  assert.equal(surface.element('password-reset-request-form').onsubmit, null);
  assert.equal(surface.element('password-reset-confirm-form').onsubmit, null);
  assert.equal(surface.element('password-reset-request-form').attributes.get('aria-busy'), 'false');
  assert.equal(surface.element('password-reset-request-submit').disabled, false);
  assert.equal(surface.element('password-reset-request-submit').textContent, 'Send reset link');

  releaseRequest(empty(202));
  await settleRequests();
  assert.equal(surface.element('password-reset-status').textContent, '');
});
