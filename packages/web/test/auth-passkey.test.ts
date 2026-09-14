/**
 * Tests for AuthController passkey login integration.
 *
 * Verifies passkey authentication flow, session persistence without tokens,
 * and generic error handling (no account existence leakage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthController } from '../src/app/auth-controller.js';
import type { KeyValueStorage } from '../src/net/session.js';
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type { GambitClient } from '../src/api/client.js';
import type {
  AuthResponse,
  WebAuthnLoginOptions,
  WebAuthnLoginVerifyRequest,
  WebAuthnRegisterOptions,
  WebAuthnRegisterVerifyRequest,
} from '../src/api/models.js';

class InMemoryStorage implements KeyValueStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

class FakeWebAuthnAdapter implements WebAuthnAdapter {
  supported = true;
  shouldThrow = false;
  requestOptionsReceived: WebAuthnLoginOptions | null = null;
  assertionToReturn: WebAuthnLoginVerifyRequest = {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    response: {
      clientDataJSON: 'cd',
      authenticatorData: 'ad',
      signature: 'sig',
      userHandle: 'u-alice',
    },
  };

  isSupported(): boolean {
    return this.supported;
  }

  async createCredential(_options: WebAuthnRegisterOptions): Promise<WebAuthnRegisterVerifyRequest> {
    throw new Error('Not implemented');
  }

  async getCredential(options: WebAuthnLoginOptions): Promise<WebAuthnLoginVerifyRequest> {
    if (this.shouldThrow) throw new Error('User cancelled passkey prompt');
    this.requestOptionsReceived = options;
    return this.assertionToReturn;
  }
}

test('AuthController.loginWithPasskey: logs in via passkey, adopts session, and persists handle + userId without tokens', async () => {
  let loginOptionsCalls = 0;
  let verifyLoginCalls = 0;

  const mockAuthResponse: AuthResponse = {
    user: {
      id: 'u-alice',
      handle: 'alice',
      country: null,
      createdAt: '2026-01-01T00:00:00Z',
      roles: ['user'],
    },
    tokens: {
      accessToken: 'secret-access-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: '2026-01-08T00:00:00Z',
    },
  };

  const mockClient = {
    auth: {
      loginPasskeyOptions: async (body: { handle: string }) => {
        loginOptionsCalls++;
        assert.equal(body.handle, 'alice');
        return {
          challenge: 'ch1',
          timeout: 60000,
          rpId: 'localhost',
          userVerification: 'required',
        } as WebAuthnLoginOptions;
      },
      verifyPasskeyLogin: async (body: WebAuthnLoginVerifyRequest) => {
        verifyLoginCalls++;
        assert.equal(body.id, 'cred-1');
        return mockAuthResponse;
      },
    },
    session: { reset: () => {}, onInvalidated: () => {}, captureGeneration: () => 0 },
  } as unknown as GambitClient;

  const adapter = new FakeWebAuthnAdapter();
  const storage = new InMemoryStorage();
  let sessionChangeSession: unknown = null;
  const pendingStates: boolean[] = [];

  const authCtrl = new AuthController({
    client: mockClient,
    webauthnAdapter: adapter,
    storage,
    callbacks: {
      onSessionChange: (sess) => {
        sessionChangeSession = sess;
      },
      onPending: (pending) => {
        pendingStates.push(pending);
      },
      onError: (msg) => {
        assert.fail(`Unexpected error: ${msg}`);
      },
    },
  });

  const session = await authCtrl.loginWithPasskey('alice');

  assert.equal(loginOptionsCalls, 1);
  assert.equal(verifyLoginCalls, 1);
  assert.deepEqual(pendingStates, [true, false]);
  assert.ok(session);
  assert.equal(session.handle, 'alice');
  assert.equal(session.userId, 'u-alice');
  assert.equal(authCtrl.currentSession?.handle, 'alice');
  assert.equal(authCtrl.isAuthenticated(), true);

  // Check persisted storage item
  const rawStored = storage.getItem('gambit-session');
  assert.ok(rawStored);
  const parsed = JSON.parse(rawStored) as Record<string, unknown>;
  assert.deepEqual(parsed, { handle: 'alice', userId: 'u-alice' });
  assert.equal('accessToken' in parsed, false);
  assert.equal('refreshToken' in parsed, false);
});

test('AuthController.loginWithPasskey: surfaces generic error copy when passkey authentication fails', async () => {
  const mockClient = {
    auth: {
      loginPasskeyOptions: async () => {
        throw new Error('401 Unauthorized / User not found');
      },
    },
    session: { reset: () => {}, onInvalidated: () => {}, captureGeneration: () => 0 },
  } as unknown as GambitClient;

  const adapter = new FakeWebAuthnAdapter();
  let errorMessage: string | null = null;

  const authCtrl = new AuthController({
    client: mockClient,
    webauthnAdapter: adapter,
    callbacks: {
      onSessionChange: () => {},
      onPending: () => {},
      onError: (msg) => {
        errorMessage = msg;
      },
    },
  });

  const session = await authCtrl.loginWithPasskey('bob');

  assert.equal(session, null);
  assert.equal(errorMessage, 'Sign in with passkey failed.');
  assert.ok(errorMessage);
  assert.equal((errorMessage as string).includes('User not found'), false);
});

test('AuthController.loginWithPasskey: peer reset cancels the multi-step flow before verification', async () => {
  let releaseOptions!: (options: WebAuthnLoginOptions) => void;
  const options = new Promise<WebAuthnLoginOptions>((resolve) => { releaseOptions = resolve; });
  let generation = 0;
  let resetHandler: (() => void) | null = null;
  let verifyCalls = 0;
  const mockClient = {
    auth: {
      loginPasskeyOptions: async () => options,
      verifyPasskeyLogin: async () => {
        verifyCalls += 1;
        throw new Error('verification must not run after reset');
      },
    },
    session: {
      reset: () => { generation += 1; },
      onInvalidated: () => {},
      onReset: (handler: () => void) => {
        resetHandler = () => { generation += 1; handler(); };
      },
      captureGeneration: () => generation,
    },
  } as unknown as GambitClient;
  const controller = new AuthController({
    client: mockClient,
    webauthnAdapter: new FakeWebAuthnAdapter(),
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });

  const pending = controller.loginWithPasskey('alice');
  assert.ok(resetHandler);
  (resetHandler as () => void)();
  releaseOptions({ challenge: 'ch1', timeout: 60_000, rpId: 'localhost', userVerification: 'required' });

  assert.equal(await pending, null);
  assert.equal(verifyCalls, 0);
  assert.equal(controller.currentSession, null);
});

test('AuthController.loginWithPasskey: rejects missing handles and unsupported browsers before calling the API', async () => {
  let apiCalls = 0;
  const mockClient = {
    auth: {
      loginPasskeyOptions: async () => {
        apiCalls++;
        throw new Error('must not be called');
      },
    },
    session: { reset: () => {}, onInvalidated: () => {} },
  } as unknown as GambitClient;
  const adapter = new FakeWebAuthnAdapter();
  const errors: string[] = [];
  const authCtrl = new AuthController({
    client: mockClient,
    webauthnAdapter: adapter,
    callbacks: {
      onSessionChange: () => {},
      onPending: () => {},
      onError: (message) => errors.push(message),
    },
  });

  assert.equal(await authCtrl.loginWithPasskey('   '), null);
  adapter.supported = false;
  assert.equal(await authCtrl.loginWithPasskey('alice'), null);

  assert.equal(apiCalls, 0);
  assert.deepEqual(errors, [
    'Please enter your handle to sign in with a passkey.',
    'Passkey sign-in is not supported on this browser.',
  ]);
});
