import { test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { startHarness } from './helpers';
import { parseAuthenticatorData } from '../src/auth/webauthn-crypto';
import { DEFAULT_RATE_LIMIT } from '../src/config';

// Rate limiting off: the uniformity sweep fires several login attempts back to
// back, which would otherwise trip the per-IP/per-handle webauthn login limit.
const NO_RATE_LIMIT = { ...DEFAULT_RATE_LIMIT, enabled: false };

class FakeAuthenticator {
  private keyPair: crypto.KeyPairKeyObjectResult;
  private credentialId: Buffer;

  constructor() {
    this.keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.credentialId = crypto.randomBytes(16);
  }

  get rawId() {
    return this.credentialId.toString('base64url');
  }

  buildCoseKey(): Buffer {
    const jwk = this.keyPair.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');

    // Map of 5 items: 0xa5
    // 1: 2 => 0x01, 0x02
    // 3: -7 => 0x03, 0x26
    // -1: 1 => 0x20, 0x01
    // -2: x => 0x21, 0x58, 0x20, x (32 bytes)
    // -3: y => 0x22, 0x58, 0x20, y (32 bytes)
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y
    ]);
  }

  buildRegisterAuthData(rpId: string, uv = true): Buffer {
    const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
    // UP (0x01) + AT (0x40), plus UV (0x04) when the user was verified.
    const flags = Buffer.from([uv ? 0x45 : 0x41]);
    const sc = Buffer.alloc(4);

    const aaguid = Buffer.alloc(16, 0);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length, 0);

    return Buffer.concat([rpIdHash, flags, sc, aaguid, credLen, this.credentialId, this.buildCoseKey()]);
  }

  buildAttestationObject(authData: Buffer): Buffer {
    const authDataPrefix = Buffer.alloc(3);
    authDataPrefix[0] = 0x59; // bytes 16-bit length
    authDataPrefix.writeUInt16BE(authData.length, 1);

    return Buffer.concat([
      Buffer.from('a363666d74646e6f6e656761747453746d74a0686175746844617461', 'hex'),
      authDataPrefix,
      authData
    ]);
  }

  buildLoginAuthData(rpId: string, signCount = 1, uv = true): Buffer {
    const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
    // UP (0x01), plus UV (0x04) when the user was verified.
    const flags = Buffer.from([uv ? 0x05 : 0x01]);
    const sc = Buffer.alloc(4);
    sc.writeUInt32BE(signCount, 0);
    return Buffer.concat([rpIdHash, flags, sc]);
  }

  sign(authenticatorData: Buffer, clientDataJSON: Buffer): Buffer {
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
    const signedData = Buffer.concat([authenticatorData, clientDataHash]);
    const sign = crypto.createSign('SHA256');
    sign.update(signedData);
    return sign.sign(this.keyPair.privateKey);
  }
}

test('authenticator data enforces extension framing', () => {
  const authenticator = new FakeAuthenticator();
  const extensionMap = Buffer.from([0xa0]);

  const assertionData = authenticator.buildLoginAuthData('localhost');
  assert.throws(
    () => parseAuthenticatorData(Buffer.concat([assertionData, extensionMap])),
    /Unexpected trailing bytes without extensions flag/,
  );

  const assertionWithExtensionFlag = Buffer.from(assertionData);
  assertionWithExtensionFlag[32] = assertionWithExtensionFlag[32]! | 0x80;
  assert.doesNotThrow(() => parseAuthenticatorData(Buffer.concat([assertionWithExtensionFlag, extensionMap])));
  assert.throws(
    () => parseAuthenticatorData(assertionWithExtensionFlag),
    /Extensions flag is set but extension data is missing/,
  );

  const registrationData = authenticator.buildRegisterAuthData('localhost');
  assert.throws(
    () => parseAuthenticatorData(Buffer.concat([registrationData, extensionMap])),
    /Unexpected trailing bytes without extensions flag/,
  );

  const registrationWithExtensionFlag = Buffer.from(registrationData);
  registrationWithExtensionFlag[32] = registrationWithExtensionFlag[32]! | 0x80;
  assert.doesNotThrow(
    () => parseAuthenticatorData(Buffer.concat([registrationWithExtensionFlag, extensionMap])),
  );
});

test('WebAuthn registration and login', async (t) => {
  const rpId = 'localhost';
  const origin = 'http://localhost';

  const harness = await startHarness({
    webauthn: { rpId, origins: [origin] }
  });
  const { userId, token } = await harness.makeUser('alice');

  await t.test('register passkey', async () => {
    // 1. Get options
    const optRes = await harness.json('POST', '/v1/auth/webauthn/register/options', { token });
    assert.strictEqual(optRes.status, 200);
    const options = optRes.body;
    assert.strictEqual(options.rp.name, 'Rookzen');
    assert.strictEqual(options.rp.id, rpId);
    assert.strictEqual(options.authenticatorSelection.residentKey, 'required');

    const authenticator = new FakeAuthenticator();
    const clientData = {
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData));
    const authData = authenticator.buildRegisterAuthData(rpId);
    const attestationObject = authenticator.buildAttestationObject(authData);

    // 2. Verify
    const verifyRes = await harness.json('POST', '/v1/auth/webauthn/register/verify', {
      token,
      body: {
        id: authenticator.rawId,
        rawId: authenticator.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
        }
      }
    });

    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.body.name, 'Passkey');

    // 3. Login with passkey
    const loginOptRes = await harness.json('POST', '/v1/auth/webauthn/login/options', {
      body: { handle: 'alice' }
    });
    assert.strictEqual(loginOptRes.status, 200);

    const loginOptions = loginOptRes.body;
    assert.strictEqual(loginOptions.allowCredentials, undefined);

    const loginClientData = {
      type: 'webauthn.get',
      challenge: loginOptions.challenge,
      origin,
    };
    const loginClientDataJSON = Buffer.from(JSON.stringify(loginClientData));
    const loginAuthData = authenticator.buildLoginAuthData(rpId, 1);
    const signature = authenticator.sign(loginAuthData, loginClientDataJSON);

    const loginVerifyRes = await harness.json('POST', '/v1/auth/webauthn/login/verify', {
      body: {
        id: authenticator.rawId,
        rawId: authenticator.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: loginClientDataJSON.toString('base64url'),
          authenticatorData: loginAuthData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: userId,
        }
      }
    });

    assert.strictEqual(loginVerifyRes.status, 200);
    assert.strictEqual(loginVerifyRes.body.user.handle, 'alice');
    assert.ok(loginVerifyRes.body.tokens.accessToken);

    // Once a non-zero signature counter has been observed, a reset to zero is
    // a regression and must be treated as a cloned authenticator or replay.
    const regressionOptionsRes = await harness.json('POST', '/v1/auth/webauthn/login/options', {
      body: { handle: 'alice' }
    });
    assert.strictEqual(regressionOptionsRes.status, 200);

    const regressionClientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge: regressionOptionsRes.body.challenge,
      origin,
    }));
    const regressionAuthData = authenticator.buildLoginAuthData(rpId, 0);
    const regressionSignature = authenticator.sign(regressionAuthData, regressionClientDataJSON);
    const regressionVerifyRes = await harness.json('POST', '/v1/auth/webauthn/login/verify', {
      body: {
        id: authenticator.rawId,
        rawId: authenticator.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: regressionClientDataJSON.toString('base64url'),
          authenticatorData: regressionAuthData.toString('base64url'),
          signature: regressionSignature.toString('base64url'),
          userHandle: userId,
        }
      }
    });
    assert.strictEqual(regressionVerifyRes.status, 401);
  });

  await t.test('decoy flow for non-existent user', async () => {
    const loginOptRes = await harness.json('POST', '/v1/auth/webauthn/login/options', {
      body: { handle: 'nobody' }
    });
    assert.strictEqual(loginOptRes.status, 200);

    const loginOptions = loginOptRes.body;
    assert.strictEqual(loginOptions.allowCredentials, undefined);
  });



  await t.test('options provides random challenges for existing user', async () => {
    const res1 = await harness.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'alice' } });
    const res2 = await harness.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'alice' } });
    assert.notStrictEqual(res1.body.challenge, res2.body.challenge);
  });

  await t.test('options provides random challenges for non-existing user', async () => {
    const res1 = await harness.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'nobody' } });
    const res2 = await harness.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'nobody' } });
    assert.notStrictEqual(res1.body.challenge, res2.body.challenge);
  });

  await t.test('registration without the User Verification flag is rejected', async () => {
    const uvHarness = await startHarness({ webauthn: { rpId, origins: [origin] } });
    try {
      const { token: uvToken } = await uvHarness.makeUser('uvreg');
      const optRes = await uvHarness.json('POST', '/v1/auth/webauthn/register/options', { token: uvToken });
      const uvAuth = new FakeAuthenticator();
      const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: optRes.body.challenge, origin }));
      // UV flag omitted — userVerification is 'required', so this must fail.
      const res = await uvHarness.json('POST', '/v1/auth/webauthn/register/verify', {
        token: uvToken,
        body: {
          id: uvAuth.rawId, rawId: uvAuth.rawId, type: 'public-key',
          response: {
            clientDataJSON: cdj.toString('base64url'),
            attestationObject: uvAuth.buildAttestationObject(uvAuth.buildRegisterAuthData(rpId, false)).toString('base64url'),
          },
        },
      });
      assert.strictEqual(res.status, 422);
    } finally {
      await uvHarness.close();
    }
  });

  await t.test('login is a uniform 401 across auth failures; UV-absent assertion cannot authenticate', async () => {
    const secHarness = await startHarness({ webauthn: { rpId, origins: [origin] }, rateLimit: NO_RATE_LIMIT });
    try {
      const secUser = await secHarness.makeUser('secuser');
      const secAuth = new FakeAuthenticator();
      // Register a real UV passkey.
      const ro = await secHarness.json('POST', '/v1/auth/webauthn/register/options', { token: secUser.token });
      const rcd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ro.body.challenge, origin }));
      const reg = await secHarness.json('POST', '/v1/auth/webauthn/register/verify', {
        token: secUser.token,
        body: {
          id: secAuth.rawId, rawId: secAuth.rawId, type: 'public-key',
          response: { clientDataJSON: rcd.toString('base64url'), attestationObject: secAuth.buildAttestationObject(secAuth.buildRegisterAuthData(rpId, true)).toString('base64url') },
        },
      });
      assert.strictEqual(reg.status, 200);

      const attempt = async (
        opts: { signCount: number; uv?: boolean; rp?: string; tamper?: boolean; userHandle?: string },
      ): Promise<{ status: number; body: any }> => {
        const lo = await secHarness.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'secuser' } });
        const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: lo.body.challenge, origin }));
        const ad = secAuth.buildLoginAuthData(opts.rp ?? rpId, opts.signCount, opts.uv ?? true);
        const sig = secAuth.sign(ad, cd);
        if (opts.tamper) sig[sig.length - 1] ^= 0x01;
        const res = await secHarness.json('POST', '/v1/auth/webauthn/login/verify', {
          body: {
            id: secAuth.rawId, rawId: secAuth.rawId, type: 'public-key',
            response: { clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), userHandle: opts.userHandle ?? secUser.userId },
          },
        });
        return { status: res.status, body: res.body };
      };

      assert.strictEqual((await attempt({ signCount: 10 })).status, 200, 'valid UV login succeeds');
      // Every credential-relevant failure funnels to the SAME 401 with an
      // identical payload — no status-code or message oracle.
      const failures = [
        await attempt({ signCount: 20, uv: false }), // UV-absent
        await attempt({ signCount: 21, rp: 'evil.example' }), // bad rpIdHash
        await attempt({ signCount: 22, tamper: true }), // bad signature
        await attempt({ signCount: 23, userHandle: 'not-the-owner' }), // userHandle mismatch
        await attempt({ signCount: 1 }), // sign-count regression
      ];
      for (const f of failures) {
        assert.strictEqual(f.status, 401, 'every auth failure is 401');
      }
      // Compare only code + message (requestId is intentionally per-request).
      const messages = new Set(
        failures.map((f) => `${f.body?.error?.code}|${f.body?.error?.message}`),
      );
      assert.strictEqual(messages.size, 1, 'all auth failures return one fixed code+message');

      // The clone/replay path still records its distinct audit for defenders.
      assert.ok(
        secHarness.repos.audit.withAction('auth.webauthn.clone_suspected').length >= 1,
        'sign-count regression is audited as a suspected clone',
      );
    } finally {
      await secHarness.close();
    }
  });

  await t.test('deleting the only passkey without a password set is refused (409)', async () => {
    const delHarness = await startHarness({ webauthn: { rpId, origins: [origin] } });
    try {
      // makeUser creates a password-backed account, so first register a passkey,
      // then simulate a passwordless account by deleting the password directly.
      const delUser = await delHarness.makeUser('deluser');
      const delAuth = new FakeAuthenticator();
      const ro = await delHarness.json('POST', '/v1/auth/webauthn/register/options', { token: delUser.token });
      const rcd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ro.body.challenge, origin }));
      const reg = await delHarness.json('POST', '/v1/auth/webauthn/register/verify', {
        token: delUser.token,
        body: {
          id: delAuth.rawId, rawId: delAuth.rawId, type: 'public-key',
          response: { clientDataJSON: rcd.toString('base64url'), attestationObject: delAuth.buildAttestationObject(delAuth.buildRegisterAuthData(rpId, true)).toString('base64url') },
        },
      });
      assert.strictEqual(reg.status, 200);
      const credId = reg.body.id; // base64url

      // Drop the account's password so the passkey is the ONLY credential.
      delHarness.repos.users.dropPassword(delUser.userId);

      const del = await delHarness.json('DELETE', `/v1/auth/webauthn/passkeys/${credId}`, { token: delUser.token });
      assert.strictEqual(del.status, 409, 'last passkey without a password cannot be deleted');
    } finally {
      await delHarness.close();
    }
  });

  await t.test('malformed client data and null payloads return 422 validation errors', async () => {
    const validationHarness = await startHarness({
      webauthn: { rpId, origins: [origin] }
    });
    const cases = [
      null,
      { id: '123' },
      {
        id: 'AA',
        rawId: 'AA',
        type: 'public-key',
        response: {
          clientDataJSON: Buffer.from(JSON.stringify({
            type: 'webauthn.get',
            challenge: null,
            origin,
          })).toString('base64url'),
          authenticatorData: Buffer.alloc(37).toString('base64url'),
          signature: 'AA',
        },
      },
      {
        id: 'AA',
        rawId: 'AA',
        type: 'public-key',
        response: {
          clientDataJSON: Buffer.from(JSON.stringify({
            type: 'webauthn.get',
            challenge: 'AA',
            origin,
            topOrigin: 'https://attacker.example',
          })).toString('base64url'),
          authenticatorData: Buffer.alloc(37).toString('base64url'),
          signature: 'AA',
        },
      },
    ];

    try {
      for (const c of cases) {
        const res = await validationHarness.json('POST', '/v1/auth/webauthn/login/verify', {
          body: c,
        });
        assert.strictEqual(res.status, 422);
      }
    } finally {
      await validationHarness.close();
    }
  });

  await harness.close();
});
