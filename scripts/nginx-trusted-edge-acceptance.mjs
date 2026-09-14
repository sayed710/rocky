import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
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

      await new Promise((resolve) => setTimeout(resolve, 800));

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

      await new Promise((resolve) => setTimeout(resolve, 800));
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
        body: JSON.stringify({ handle: `realnginx${i}`, password: 'password123' }),
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
      body: JSON.stringify({ handle: 'realnginx6', password: 'password123' }),
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
