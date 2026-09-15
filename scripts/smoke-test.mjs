#!/usr/bin/env node
/**
 * Smoke test for the local Docker Compose stack (M14 Increment 1).
 *
 * Verifies the full stack end-to-end:
 * 1. Waits for all health checks to pass
 * 2. Registers a user over the real REST API
 * 3. Creates a seek
 * 4. Opens a WebSocket to the gateway with the auth token
 * 5. Confirms the WS connection authenticates and receives a joined response
 *
 * Usage:
 *   docker compose up -d --build
 *   node scripts/smoke-test.mjs
 *
 * Or with custom URLs:
 *   API_URL=http://localhost:3000 WS_URL=ws://localhost:3000/ws WEB_URL=http://localhost:3000 node scripts/smoke-test.mjs
 */

import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';

import { waitForHealth } from './lib/wait-for-health.mjs';

const apiUrl = process.env['API_URL'] ?? 'http://localhost:3000';
// Exercise the same nginx upgrade path a real browser uses, not the gateway's
// direct host port. Supplying Origin below also verifies the production
// same-origin guard and proxy Host forwarding.
const wsUrl = process.env['WS_URL'] ?? 'ws://localhost:3000/ws';
const webUrl = process.env['WEB_URL'] ?? 'http://localhost:3000';

/** Emit one consistently prefixed smoke-test progress message. */
function log(msg) {
  console.log(`[smoke] ${msg}`);
}

/** Assert an exact response-header contract at the public web edge. */
function requireHeader(response, name, expected) {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new Error(`GET ${webUrl}/ returned ${name}: ${actual ?? '<missing>'}; expected ${expected}`);
  }
}

/** Register a smoke-test account and return the authenticated API response body. */
async function registerUser(handle, password) {
  const res = await fetch(`${apiUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Register failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  log(`✓ Registered user "${handle}" (id: ${body.user?.id ?? '?'})`);
  return body;
}

/** Publish the standard smoke-test seek using the supplied bearer token. */
async function createSeek(token) {
  const res = await fetch(`${apiUrl}/v1/seeks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      variant: 'standard',
      timeControl: {
        kind: 'increment',
        initialMs: 300_000,
        incrementMs: 3_000,
        delayMs: 0,
      },
      color: 'random',
      rated: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create seek failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  log(`✓ Created seek (id: ${body.id ?? '?'})`);
  return body;
}

/** Accept a published seek and return its provisioned-game response body. */
async function acceptSeek(token, seekId) {
  const res = await fetch(`${apiUrl}/v1/seeks/${encodeURIComponent(seekId)}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Accept seek failed (${res.status}): ${text}`);
  }
  const body = await res.json();
  if (!body.gameId) throw new Error('Accept seek returned no gameId');
  log(`✓ Accepted seek and provisioned game (id: ${body.gameId})`);
  return body;
}

/**
 * Resolve after the authenticated socket receives the target game's initial state.
 * Reject on protocol errors, premature close, or the bounded handshake deadline.
 */
function waitForWs(url, token, gameId) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const ws = new WebSocket(url, { origin: webUrl });

    ws.addEventListener('open', () => {
      log('✓ WebSocket connected');
      ws.send(JSON.stringify({ t: 'join', gameId, token }));
    });

    ws.addEventListener('message', async (event) => {
      try {
        // Node's built-in WebSocket may expose a text frame as a Blob rather
        // than a string. Normalise every WebSocket-compatible representation
        // before decoding the protocol JSON.
        const data = event.data;
        const raw = typeof data === 'string'
          ? data
          : data instanceof Blob
            ? await data.text()
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
                : String(data);
        const msg = JSON.parse(raw);
        if (msg.t === 'joined' && msg.gameId === gameId) {
          log('✓ WebSocket joined game (token verified, state received)');
          ws.close();
          resolve(true);
        } else if (msg.t === 'reject') {
          ws.close();
          reject(new Error(`WebSocket join rejected (${msg.code}): ${msg.message}`));
        }
      } catch (err) {
        ws.close();
        reject(new Error(`WebSocket response decode failed: ${err.message}`));
      }
    });

    ws.addEventListener('error', (err) => {
      reject(new Error(`WebSocket error: ${err.message ?? 'connection failed'}`));
    });

    setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket timed out waiting for response'));
    }, deadline - Date.now());
  });
}

/** Run the public-edge health, header, REST, and WebSocket smoke journey end to end. */
async function main() {
  log(`API: ${apiUrl}`);
  log(`WS:  ${wsUrl}`);
  log('');

  // 1. Wait for health
  log('Waiting for services to be healthy...');
  await waitForHealth(`${apiUrl}/v1/health`, 'API', { log });
  await waitForHealth(webUrl, 'Web', { log });
  // Gateway health is on port+1 inside the container, but from outside we
  // can check the WS port is listening by attempting a connection later.
  log('');

  log('Checking the web document security headers...');
  const webDocument = await fetch(webUrl);
  requireHeader(webDocument, 'x-frame-options', 'DENY');
  requireHeader(webDocument, 'x-content-type-options', 'nosniff');
  requireHeader(webDocument, 'referrer-policy', 'no-referrer');
  requireHeader(webDocument, 'cross-origin-resource-policy', 'same-origin');
  requireHeader(
    webDocument,
    'permissions-policy',
    'camera=(), geolocation=(), microphone=(), payment=()',
  );
  requireHeader(webDocument, 'strict-transport-security', 'max-age=31536000; includeSubDomains');
  const contentSecurityPolicy = webDocument.headers.get('content-security-policy') ?? '';
  if (!contentSecurityPolicy.includes("frame-ancestors 'none'")) {
    throw new Error(`GET ${webUrl}/ permits framing: ${contentSecurityPolicy || '<missing CSP>'}`);
  }
  log('✓ Web document rejects framing and carries the required security headers');
  log('');

  // 1b. The Prometheus registry must not be reachable through the public web proxy. Its `route`
  // label enumerates every endpoint with per-route request volume and status distribution.
  // Prometheus scrapes the API Service directly inside the cluster, so nothing legitimate comes
  // through here. Asserted against the real nginx, which is the only place this rule exists
  // (M12 pen-test pass, SEC-1).
  // Both forms: the API router drops empty path segments, so `/v1/metrics/` resolves to the same
  // route. Checking only the bare form is how the trailing-slash bypass survived the first fix.
  log('Checking the metrics endpoint is not publicly exposed...');
  for (const path of ['/v1/metrics', '/v1/metrics/']) {
    const metricsRes = await fetch(`${webUrl}${path}`);
    const body = await metricsRes.text();
    if (metricsRes.status !== 404) {
      throw new Error(
        `GET ${webUrl}${path} returned ${metricsRes.status}, expected 404. ` +
          `The public proxy is exposing the Prometheus registry: ${body.slice(0, 200)}`,
      );
    }
    // Belt and braces: a 404 page that somehow carried the registry would still be a leak.
    if (body.includes('# HELP') || body.includes('# TYPE')) {
      throw new Error(`GET ${webUrl}${path} returned 404 but the body contains Prometheus text`);
    }
  }
  // The block must be exact — the rest of /v1/ has to keep proxying.
  const healthViaWeb = await fetch(`${webUrl}/v1/health`);
  if (!healthViaWeb.ok) {
    throw new Error(
      `GET ${webUrl}/v1/health returned ${healthViaWeb.status}; the metrics rule over-blocked /v1/`,
    );
  }
  log('✓ /v1/metrics is blocked at the proxy; the rest of /v1/ still routes');
  log('');

  // 2. Register a user
  log('Registering a test user...');
  const suffix = Date.now().toString(36);
  const handle = `smoke-a-${suffix}`;
  const opponentHandle = `smoke-b-${suffix}`;
  const auth = await registerUser(handle, 'test-password-123');
  const opponentAuth = await registerUser(opponentHandle, 'test-password-123');
  const token = auth.tokens?.accessToken;
  const opponentToken = opponentAuth.tokens?.accessToken;
  if (!token) {
    throw new Error('No accessToken in register response');
  }
  if (!opponentToken) {
    throw new Error('No opponent accessToken in register response');
  }
  log(`✓ Got access token (${token.slice(0, 20)}...)`);
  log('');

  // 3. Create a seek
  log('Creating a seek...');
  const seek = await createSeek(token);
  const matched = await acceptSeek(opponentToken, seek.id);
  log('');

  // 4. WebSocket authentication
  log('Connecting to WebSocket gateway...');
  await waitForWs(wsUrl, token, matched.gameId);
  log('');

  log('════════════════════════════════════════════════════════════');
  log('  ✅ SMOKE TEST PASSED — the stack is fully operational');
  log('════════════════════════════════════════════════════════════');
  log('');
  log('  • Postgres: schema migrated, user persisted');
  log('  • API: register + atomic seek acceptance over real REST');
  log('  • Gateway: WebSocket authenticated with real token');
  log('  • Token verification: shared-secret HMAC verified across services');
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('');
    console.error(`[smoke] ✗ FAILED: ${err.message}`);
    process.exit(1);
  });
}
