import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { spawn, execSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as connectTcp, createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { waitForHealth } from './lib/wait-for-health.mjs';

import {
  createApiServer,
  createInMemoryRepositories,
  resolveConfig,
  ScryptPasswordHasher,
  AccessTokenService,
  ManualClock,
  uuidv7Generator,
  InMemoryRateLimiter,
  NullLogger,
  InMemoryMetrics,
  NullTracer,
} from '../packages/api/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

/**
 * Probes whether the Docker daemon is reachable and responding.
 * Used to conditionally execute or skip real-container Nginx acceptance tests.
 *
 * @returns True if Docker CLI successfully reports daemon availability, false otherwise.
 */
function isDockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Allocates an available ephemeral TCP port on loopback (127.0.0.1).
 *
 * @returns Promise resolving to an unallocated port number.
 */
async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to get port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolvePort(port));
    });
  });
}

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable && process.env['REQUIRE_DOCKER'] === '1') {
  throw new Error('Docker is required for the trusted-edge acceptance gate but is unavailable');
}

/** Resolve a WebSocket close event, failing the test if the peer remains open. */
async function waitForClose(ws, timeoutMs = 2_000) {
  return new Promise((resolveClose, reject) => {
    const onClose = (code, reason) => {
      clearTimeout(timer);
      resolveClose({ code, reason: reason.toString() });
    };
    const timer = setTimeout(() => {
      ws.off('close', onClose);
      reject(new Error('WebSocket did not close before the deadline'));
    }, timeoutMs);
    ws.once('close', onClose);
  });
}

/** Resolve once a WebSocket opens, failing if it closes or exceeds the deadline first. */
async function waitForOpen(ws, timeoutMs = 5_000) {
  if (ws.readyState === WebSocket.OPEN) return;

  return new Promise((resolveOpen, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`WebSocket closed with ${code} before opening`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket did not open before the deadline'));
    }, timeoutMs);

    ws.once('open', onOpen);
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

/** Wait until a WebSocket group reaches the expected open/closed distribution. */
async function waitForSocketStateCounts(sockets, expectedOpen, expectedClosed, timeoutMs = 5_000) {
  const counts = () => ({
    open: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
    closed: sockets.filter((socket) => socket.readyState === WebSocket.CLOSED).length,
  });

  return new Promise((resolveStates, reject) => {
    let timer;
    const listeners = sockets.map((socket) => {
      const onStateChange = () => {
        const current = counts();
        if (current.open === expectedOpen && current.closed === expectedClosed) {
          cleanup();
          resolveStates();
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      socket.on('open', onStateChange);
      socket.on('close', onStateChange);
      socket.on('error', onError);
      return { socket, onStateChange, onError };
    });
    const cleanup = () => {
      clearTimeout(timer);
      for (const { socket, onStateChange, onError } of listeners) {
        socket.off('open', onStateChange);
        socket.off('close', onStateChange);
        socket.off('error', onError);
      }
    };

    timer = setTimeout(() => {
      const current = counts();
      cleanup();
      reject(new Error(
        `WebSockets did not reach ${expectedOpen} open and ${expectedClosed} closed before the deadline `
        + `(observed ${current.open} open and ${current.closed} closed)`,
      ));
    }, timeoutMs);

    for (const { onStateChange } of listeners) {
      onStateChange();
    }
  });
}

/** Append the ingress-observed TCP peer after any untrusted forwarded prefix. */
function appendForwardedFor(forwardedFor, remoteAddress) {
  const prefix = Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor;
  return prefix ? `${prefix}, ${remoteAddress}` : remoteAddress;
}

/** Build headers for the web edge while recording the ingress-observed client address. */
function createIngressHeaders(request) {
  const remoteAddress = request.socket.remoteAddress;
  if (!remoteAddress) {
    throw new Error('Ingress request is missing its TCP peer address');
  }

  return {
    ...request.headers,
    'x-forwarded-for': appendForwardedFor(request.headers['x-forwarded-for'], remoteAddress),
  };
}

/**
 * Create an ingress-like HTTP/WebSocket forwarding hop in front of the real web Nginx edge.
 * The forwarder derives identity from the TCP peer and appends it to, rather than trusting,
 * any client-supplied X-Forwarded-For prefix.
 */
function createIngressForwarder(nginxPort) {
  const ingress = createHttpServer((request, response) => {
    let headers;
    try {
      headers = createIngressHeaders(request);
    } catch {
      response.writeHead(400).end();
      return;
    }

    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: nginxPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  ingress.on('upgrade', (request, clientSocket, head) => {
    let headers;
    try {
      headers = createIngressHeaders(request);
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstreamSocket = connectTcp(nginxPort, '127.0.0.1');
    upstreamSocket.once('connect', () => {
      upstreamSocket.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) upstreamSocket.write(`${name}: ${item}\r\n`);
      }
      upstreamSocket.write('\r\n');
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    upstreamSocket.once('error', () => clientSocket.destroy());
    clientSocket.once('error', () => upstreamSocket.destroy());
  });

  return ingress;
}

/** Send one registration request from a chosen loopback client identity. */
async function registerFromClient(port, handle, { localAddress, forwardedFor } = {}) {
  const payload = JSON.stringify({ handle, password: 'password123', email: `${handle}@example.test` });

  return new Promise((resolveResponse, reject) => {
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    };
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/v1/auth/register',
      method: 'POST',
      headers,
      ...(localAddress ? { localAddress } : {}),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(3_000, () => request.destroy(new Error('Registration request timed out')));
    request.once('error', reject);
    request.end(payload);
  });
}

describe('Real Nginx Path Acceptance: Trusted Edge Contract', { skip: !dockerAvailable }, () => {
  let apiPort;
  let gwPort;
  let gwHealthPort;
  let nginxPort;

  let httpServer;
  let gwProc;
  let nginxContainerName;
  let nginxProc;

  const secret = 'test-secret-at-least-32-bytes-long-1234567890';

  before(async () => {
    apiPort = await getFreePort();
    gwPort = await getFreePort();
    gwHealthPort = await getFreePort();
    nginxPort = await getFreePort();

    // 1. Start API server on 0.0.0.0:apiPort with TRUST_PROXY=1 and rate limiting enabled
    const clock = new ManualClock(Date.now());
    const repos = createInMemoryRepositories(clock);
    const tokens = new AccessTokenService({ secret, ttlSec: 900, clock, ids: uuidv7Generator });
    const passwordHasher = new ScryptPasswordHasher({ N: 1024 });
    const rateLimiter = new InMemoryRateLimiter(clock);
    const config = resolveConfig({
      port: apiPort,
      accessTokenSecret: secret,
      trustProxy: 1,
    });
    const apiServer = createApiServer({
      repos,
      tokens,
      hasher: passwordHasher,
      clock,
      ids: uuidv7Generator,
      config,
      logger: new NullLogger(),
      metrics: new InMemoryMetrics(),
      tracer: new NullTracer(),
      rateLimiter,
    });
    httpServer = await apiServer.listen(apiPort, '0.0.0.0');
    await waitForHealth(`http://127.0.0.1:${apiPort}/v1/health`, 'API', { timeoutMs: 15_000 });

    // 2. Start Gateway server on 0.0.0.0:gwPort with TRUST_PROXY=1 and WS_MAX_CONNECTIONS_PER_IP=20
    const gatewayDir = resolve(repoRoot, 'services/gateway');
    const serveScript = resolve(gatewayDir, 'dist/serve.js');
    gwProc = spawn(process.execPath, [serveScript], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        PORT: String(gwPort),
        HEALTH_PORT: String(gwHealthPort),
        HOST: '0.0.0.0',
        ACCESS_TOKEN_SECRET: secret,
        WS_MAX_CONNECTIONS_PER_IP: '20',
        TRUST_PROXY: '1',
        DATABASE_URL: '',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gwProc.on('error', () => {});
    await waitForHealth(`http://127.0.0.1:${gwHealthPort}/health`, 'gateway', { timeoutMs: 15_000 });

    // 3. Start real Nginx container mounting docker/web/nginx.conf.template
    nginxContainerName = `gambit-test-nginx-${randomUUID().slice(0, 8)}`;
    const templatePath = resolve(repoRoot, 'docker/web/nginx.conf.template');

    const dockerArgs = [
      'run', '--rm',
      '--name', nginxContainerName,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${nginxPort}:8080`,
      '-e', `API_UPSTREAM=host.docker.internal:${apiPort}`,
      '-e', `GATEWAY_UPSTREAM=host.docker.internal:${gwPort}`,
      '-v', `${templatePath}:/etc/nginx/templates/default.conf.template:ro`,
      'nginxinc/nginx-unprivileged:alpine',
    ];

    nginxProc = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    nginxProc.stdout?.on('data', (d) => {
      // debug if needed
    });
    nginxProc.stderr?.on('data', (d) => {
      // debug if needed
    });
    nginxProc.on('error', () => {});

    // Wait for Nginx to proxy /v1/health
    await waitForHealth(`http://127.0.0.1:${nginxPort}/v1/health`, 'nginx edge', { timeoutMs: 15_000 });
  });

  after(async () => {
    if (nginxContainerName) {
      try {
        execSync(`docker rm -f ${nginxContainerName}`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    if (nginxProc) {
      nginxProc.kill('SIGTERM');
    }
    if (gwProc) {
      gwProc.kill('SIGTERM');
    }
    if (httpServer) {
      await new Promise((r) => httpServer.close(r));
    }
  });

  test('WebSocket per-IP limit enforced through real Nginx path (20 open, 5 rejected with 1013)', async () => {
    // 25 WebSocket connections to real Nginx /ws.
    // Nginx appends client IP via $proxy_add_x_forwarded_for.
    // Gateway with TRUST_PROXY=1 attributes all 25 to the test runner IP.
    const sockets = [];
    const closeEvents = [];

    try {
      for (let i = 1; i <= 25; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`);
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await waitForSocketStateCounts(sockets, 20, 5);

      const rejected1013 = closeEvents.filter((e) => e.code === 1013);
      assert.equal(
        rejected1013.length,
        5,
        `Expected exactly 5 connections to be rejected with 1013 through real Nginx, got ${rejected1013.length}`,
      );

      const openCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount, 20, `Expected exactly 20 connections open through real Nginx, got ${openCount}`);
    } finally {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('WebSocket spoofed X-Forwarded-For prefix rejected through real Nginx path', async () => {
    // Client attempts to spoof IP by sending custom X-Forwarded-For headers to real Nginx.
    // Nginx uses `$proxy_add_x_forwarded_for`, appending the authentic client IP to the right.
    // With TRUST_PROXY=1, the gateway reads the rightmost entry, defeating the spoofed prefix.
    const sockets = [];
    const closeEvents = [];

    try {
      // Connect 20 times with spoofed prefixes
      for (let i = 1; i <= 20; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`, {
          headers: {
            'x-forwarded-for': `203.0.113.${i}`,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await Promise.all(sockets.map((socket) => waitForOpen(socket)));
      const openCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount, 20, `Expected 20 connections open, got ${openCount}`);

      // 21st connection with a fresh spoofed IP must STILL be rejected with 1013
      const ws21 = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`, {
        headers: {
          'x-forwarded-for': '203.0.113.99',
        },
      });
      sockets.push(ws21);

      const close21 = await waitForClose(ws21);

      assert.equal(
        close21.code,
        1013,
        `Expected connection 21 to be rejected with 1013 despite spoofed prefix, got ${close21.code}`,
      );
    } finally {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('API rate limiting defeats spoofed X-Forwarded-For through real Nginx path', async () => {
    // 6 rapid registrations through real Nginx /v1/auth/register, each with a different spoofed prefix.
    // Real Nginx appends the client IP to X-Forwarded-For.
    // API with TRUST_PROXY=1 enforces the rate limit (5 per hour) on the authentic client IP.
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`http://127.0.0.1:${nginxPort}/v1/auth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${i}`,
        },
        body: JSON.stringify({ handle: `realnginx${i}`, password: 'password123', email: `realnginx${i}@example.test` }),
      });
      assert.equal(res.status, 201, `Request ${i} should succeed with 201, got ${res.status}`);
    }

    // 6th request with a different spoofed prefix must be blocked with 429
    const res6 = await fetch(`http://127.0.0.1:${nginxPort}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.99',
      },
      body: JSON.stringify({ handle: 'realnginx6', password: 'password123', email: 'realnginx6@example.test' }),
    });

    assert.equal(res6.status, 429, `Expected request 6 to be rate limited (429), got ${res6.status}`);
    const body = await res6.json();
    assert.equal(body.error?.code, 'rate_limited');
  });

  test('Nginx security boundaries: /v1/metrics blocked (404) and normal /v1/ routes proxy', async () => {
    // SEC-1 verification through real Nginx
    const m1 = await fetch(`http://127.0.0.1:${nginxPort}/v1/metrics`);
    assert.equal(m1.status, 404, '/v1/metrics must return 404 through public proxy');

    const m2 = await fetch(`http://127.0.0.1:${nginxPort}/v1/metrics/`);
    assert.equal(m2.status, 404, '/v1/metrics/ must return 404 through public proxy');

    const health = await fetch(`http://127.0.0.1:${nginxPort}/v1/health`);
    assert.equal(health.status, 200, '/v1/health must proxy successfully');
  });
});

describe('Real Nginx Path Acceptance: Two-Hop Ingress Topology', { skip: !dockerAvailable }, () => {
  let apiPort;
  let gwPort;
  let gwHealthPort;
  let nginxPort;
  let ingressPort;

  let httpServer;
  let gwProc;
  let nginxContainerName;
  let nginxProc;
  let ingressServer;

  const secret = 'test-secret-at-least-32-bytes-long-1234567890';

  before(async () => {
    apiPort = await getFreePort();
    gwPort = await getFreePort();
    gwHealthPort = await getFreePort();
    nginxPort = await getFreePort();
    ingressPort = await getFreePort();

    const clock = new ManualClock(Date.now());
    const repos = createInMemoryRepositories(clock);
    const tokens = new AccessTokenService({ secret, ttlSec: 900, clock, ids: uuidv7Generator });
    const passwordHasher = new ScryptPasswordHasher({ N: 1024 });
    const rateLimiter = new InMemoryRateLimiter(clock);
    const config = resolveConfig({
      port: apiPort,
      accessTokenSecret: secret,
      trustProxy: 2,
    });
    const apiServer = createApiServer({
      repos,
      tokens,
      hasher: passwordHasher,
      clock,
      ids: uuidv7Generator,
      config,
      logger: new NullLogger(),
      metrics: new InMemoryMetrics(),
      tracer: new NullTracer(),
      rateLimiter,
    });
    httpServer = await apiServer.listen(apiPort, '0.0.0.0');
    await waitForHealth(`http://127.0.0.1:${apiPort}/v1/health`, 'two-hop API', { timeoutMs: 15_000 });

    const gatewayDir = resolve(repoRoot, 'services/gateway');
    const serveScript = resolve(gatewayDir, 'dist/serve.js');
    gwProc = spawn(process.execPath, [serveScript], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        PORT: String(gwPort),
        HEALTH_PORT: String(gwHealthPort),
        HOST: '0.0.0.0',
        ACCESS_TOKEN_SECRET: secret,
        WS_MAX_CONNECTIONS_PER_IP: '20',
        TRUST_PROXY: '2',
        DATABASE_URL: '',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gwProc.on('error', () => {});
    await waitForHealth(`http://127.0.0.1:${gwHealthPort}/health`, 'two-hop gateway', { timeoutMs: 15_000 });

    nginxContainerName = `gambit-test-nginx-two-hop-${randomUUID().slice(0, 8)}`;
    const templatePath = resolve(repoRoot, 'docker/web/nginx.conf.template');
    const dockerArgs = [
      'run', '--rm',
      '--name', nginxContainerName,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${nginxPort}:8080`,
      '-e', `API_UPSTREAM=host.docker.internal:${apiPort}`,
      '-e', `GATEWAY_UPSTREAM=host.docker.internal:${gwPort}`,
      '-v', `${templatePath}:/etc/nginx/templates/default.conf.template:ro`,
      'nginxinc/nginx-unprivileged:alpine',
    ];

    nginxProc = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    nginxProc.stdout?.on('data', () => {});
    nginxProc.stderr?.on('data', () => {});
    nginxProc.on('error', () => {});
    await waitForHealth(`http://127.0.0.1:${nginxPort}/v1/health`, 'two-hop nginx edge', {
      timeoutMs: 15_000,
    });

    ingressServer = createIngressForwarder(nginxPort);
    await new Promise((resolveListen, reject) => {
      ingressServer.once('error', reject);
      ingressServer.listen(ingressPort, '127.0.0.1', () => {
        ingressServer.off('error', reject);
        resolveListen();
      });
    });
    await waitForHealth(`http://127.0.0.1:${ingressPort}/v1/health`, 'ingress-like edge', {
      timeoutMs: 15_000,
    });
  });

  after(async () => {
    if (ingressServer) {
      await new Promise((resolveClose) => ingressServer.close(resolveClose));
    }
    if (nginxContainerName) {
      try {
        execSync(`docker rm -f ${nginxContainerName}`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    if (nginxProc) nginxProc.kill('SIGTERM');
    if (gwProc) gwProc.kill('SIGTERM');
    if (httpServer) await new Promise((resolveClose) => httpServer.close(resolveClose));
  });

  test('API rate limiting preserves client identity through two real proxy hops', async () => {
    const clientA = '127.0.0.2';
    const clientB = '127.0.0.3';

    for (let i = 1; i <= 5; i++) {
      const response = await registerFromClient(ingressPort, `twohopa${i}`, {
        localAddress: clientA,
        forwardedFor: `198.51.100.${i}`,
      });
      assert.equal(response.status, 201, `Client A request ${i} should succeed`);
    }

    const clientBResponse = await registerFromClient(ingressPort, 'twohopb1', {
      localAddress: clientB,
      forwardedFor: '198.51.100.200',
    });
    assert.equal(clientBResponse.status, 201, 'A distinct client must not share client A\'s proxy bucket');

    const clientARejected = await registerFromClient(ingressPort, 'twohopa6', {
      localAddress: clientA,
      forwardedFor: '198.51.100.201',
    });
    assert.equal(clientARejected.status, 429, 'A forged prefix must not bypass client A\'s limit');
    assert.equal(JSON.parse(clientARejected.body).error?.code, 'rate_limited');
  });

  test('API fails safely when the two-hop forwarded chain is insufficient or malformed', async () => {
    for (let i = 1; i <= 5; i++) {
      const response = await registerFromClient(nginxPort, `twohopunknown${i}`, {
        ...(i > 1 ? { forwardedFor: 'not-an-ip' } : {}),
      });
      assert.equal(response.status, 201, `Fail-closed bucket request ${i} should succeed`);
    }

    const rejected = await registerFromClient(nginxPort, 'twohopunknown6', {
      forwardedFor: 'still-not-an-ip',
    });
    assert.equal(rejected.status, 429, 'Invalid chains must remain bounded by the fail-closed bucket');
    assert.equal(JSON.parse(rejected.body).error?.code, 'rate_limited');
  });

  test('WebSocket admission preserves per-client limits through two real proxy hops', async () => {
    const sockets = [];
    const clientA = '127.0.0.2';
    const clientB = '127.0.0.3';

    try {
      for (let i = 1; i <= 20; i++) {
        const socket = new WebSocket(`ws://127.0.0.1:${ingressPort}/ws`, {
          localAddress: clientA,
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        sockets.push(socket);
      }
      await Promise.all(sockets.map((socket) => waitForOpen(socket)));

      const clientBSocket = new WebSocket(`ws://127.0.0.1:${ingressPort}/ws`, {
        localAddress: clientB,
        headers: { 'x-forwarded-for': '203.0.113.200' },
      });
      sockets.push(clientBSocket);
      await waitForOpen(clientBSocket);

      const clientAOverflow = new WebSocket(`ws://127.0.0.1:${ingressPort}/ws`, {
        localAddress: clientA,
        headers: { 'x-forwarded-for': '203.0.113.201' },
      });
      sockets.push(clientAOverflow);
      const overflowClose = await waitForClose(clientAOverflow);
      assert.equal(overflowClose.code, 1013, 'A forged prefix must not bypass client A\'s socket limit');
    } finally {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      }
      await new Promise((resolveCleanup) => setTimeout(resolveCleanup, 100));
    }
  });

  test('WebSocket admission rejects insufficient and malformed two-hop chains', async () => {
    const insufficient = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`);
    const insufficientClose = await waitForClose(insufficient);
    assert.equal(insufficientClose.code, 1008);
    assert.equal(insufficientClose.reason, 'client identity unavailable');

    const malformed = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`, {
      headers: { 'x-forwarded-for': 'not-an-ip' },
    });
    const malformedClose = await waitForClose(malformed);
    assert.equal(malformedClose.code, 1008);
    assert.equal(malformedClose.reason, 'client identity unavailable');
  });
});
