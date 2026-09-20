import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { spawn, execSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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
const webDistPath = resolve(repoRoot, 'packages/web/dist');

/**
 * Probes whether the Docker daemon is reachable and responding.
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
  throw new Error('Docker is required for the web-delivery acceptance gate but is unavailable');
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

describe('Real Nginx Path Acceptance: Web Delivery Caching and Compression Contract', { skip: !dockerAvailable }, () => {
  let apiPort;
  let gwPort;
  let gwHealthPort;
  let nginxPort;

  let httpServer;
  let gwProc;
  let nginxContainerName;
  let nginxProc;

  let hashedJsFile;
  let hashedCssFile;

  const secret = 'test-secret-at-least-32-bytes-long-1234567890';

  before(async () => {
    // Verify web dist exists before starting tests
    if (!existsSync(webDistPath) || !existsSync(join(webDistPath, 'index.html'))) {
      throw new Error(`packages/web/dist does not exist or missing index.html at ${webDistPath}. Run npm run build:web first.`);
    }

    const assetsDir = join(webDistPath, 'assets');
    if (!existsSync(assetsDir)) {
      throw new Error(`assets directory missing at ${assetsDir}`);
    }

    const assetEntries = readdirSync(assetsDir);
    // Select a content-hashed JS asset meeting or exceeding Nginx's gzip minimum compression threshold (1024 bytes)
    hashedJsFile = assetEntries.find((f) => {
      if (!f.endsWith('.js') || f.endsWith('.map') || !/-[a-zA-Z0-9_-]{6,}\.js$/.test(f)) return false;
      const stat = statSync(join(assetsDir, f));
      return stat.size >= 1024;
    });
    // Select a content-hashed CSS asset meeting or exceeding Nginx's gzip minimum compression threshold (1024 bytes)
    hashedCssFile = assetEntries.find((f) => {
      if (!f.endsWith('.css') || f.endsWith('.map') || !/-[a-zA-Z0-9_-]{6,}\.css$/.test(f)) return false;
      const stat = statSync(join(assetsDir, f));
      return stat.size >= 1024;
    });

    if (!hashedJsFile) {
      throw new Error(
        `No compressible hashed JS asset (>= 1024 bytes) found in packages/web/dist/assets (found: ${assetEntries.join(', ')})`
      );
    }
    if (!hashedCssFile) {
      throw new Error(
        `No compressible hashed CSS asset (>= 1024 bytes) found in packages/web/dist/assets (found: ${assetEntries.join(', ')})`
      );
    }

    apiPort = await getFreePort();
    gwPort = await getFreePort();
    gwHealthPort = await getFreePort();
    nginxPort = await getFreePort();

    // 1. Start API server on 0.0.0.0:apiPort
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

    // 2. Start Gateway server on 0.0.0.0:gwPort
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

    // 3. Start real Nginx container mounting docker/web/nginx.conf.template and packages/web/dist
    nginxContainerName = `gambit-test-web-${randomUUID().slice(0, 8)}`;
    const templatePath = resolve(repoRoot, 'docker/web/nginx.conf.template');

    const dockerArgs = [
      'run', '--rm',
      '--name', nginxContainerName,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${nginxPort}:8080`,
      '-e', `API_UPSTREAM=host.docker.internal:${apiPort}`,
      '-e', `GATEWAY_UPSTREAM=host.docker.internal:${gwPort}`,
      '-v', `${templatePath}:/etc/nginx/templates/default.conf.template:ro`,
      '-v', `${webDistPath}:/usr/share/nginx/html:ro`,
      'nginxinc/nginx-unprivileged:alpine',
    ];

    nginxProc = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    nginxProc.on('error', () => {});

    // Wait for Nginx to proxy /v1/health
    await waitForHealth(`http://127.0.0.1:${nginxPort}/v1/health`, 'nginx web edge', { timeoutMs: 15_000 });
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

  test('1. Content-hashed static asset: HTTP 200, long-lived Cache-Control with immutable', async () => {
    const res = await fetch(`http://127.0.0.1:${nginxPort}/assets/${hashedJsFile}`);
    assert.equal(res.status, 200, 'Hashed asset must return 200 OK');

    const cacheControl = res.headers.get('cache-control');
    assert.ok(cacheControl, 'Cache-Control header must be present on hashed asset');
    assert.match(cacheControl, /public/, 'Cache-Control must declare public');
    assert.match(cacheControl, /max-age=31536000/, 'Cache-Control must set 1-year max-age (31536000)');
    assert.match(cacheControl, /immutable/, 'Cache-Control must include immutable');
  });

  test('2. index.html / SPA shell: NOT year-long immutable, explicit safe freshness/revalidation policy', async () => {
    const resIndex = await fetch(`http://127.0.0.1:${nginxPort}/index.html`);
    assert.equal(resIndex.status, 200, 'index.html must return 200 OK');

    const cacheControlIndex = resIndex.headers.get('cache-control');
    assert.ok(cacheControlIndex, 'Cache-Control header must be present on index.html');
    assert.doesNotMatch(cacheControlIndex, /immutable/, 'index.html MUST NOT be immutable');
    assert.doesNotMatch(cacheControlIndex, /max-age=31536000/, 'index.html MUST NOT have year-long max-age');
    assert.match(cacheControlIndex, /no-cache/, 'index.html must specify no-cache revalidation policy');

    const resRoot = await fetch(`http://127.0.0.1:${nginxPort}/`);
    assert.equal(resRoot.status, 200, 'root route / must return 200 OK');
    const cacheControlRoot = resRoot.headers.get('cache-control');
    assert.ok(cacheControlRoot, 'Cache-Control header must be present on /');
    assert.doesNotMatch(cacheControlRoot, /immutable/, 'root route / MUST NOT be immutable');
    assert.match(cacheControlRoot, /no-cache/, 'root route / must specify no-cache revalidation policy');
  });

  test('3. SPA deep-link fallback: returns shell correctly without inheriting immutable asset policy', async () => {
    const res = await fetch(`http://127.0.0.1:${nginxPort}/play`);
    assert.equal(res.status, 200, 'Deep link /play must resolve to 200 OK via SPA fallback');

    const body = await res.text();
    assert.match(body, /<html/i, 'Deep link response must return HTML document shell');

    const cacheControl = res.headers.get('cache-control');
    assert.ok(cacheControl, 'Cache-Control header must be present on SPA fallback');
    assert.doesNotMatch(cacheControl, /immutable/, 'SPA deep link fallback MUST NOT inherit immutable caching');
    assert.match(cacheControl, /no-cache/, 'SPA fallback must use safe revalidation policy');
  });

  test('4. gzip: compressible production resource with Accept-Encoding: gzip demonstrates Content-Encoding: gzip', async () => {
    for (const assetFile of [hashedJsFile, hashedCssFile]) {
      // 4a. Verify fetch sees Content-Encoding: gzip
      const res = await fetch(`http://127.0.0.1:${nginxPort}/assets/${assetFile}`, {
        headers: {
          'Accept-Encoding': 'gzip',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get('content-encoding'),
        'gzip',
        `Compressible asset ${assetFile} must be served with Content-Encoding: gzip`,
      );

      // 4b. Fetch raw wire bytes via http.request to prove wire compression and decompress with gunzipSync
      const { statusCode, headers, rawWireBody } = await new Promise((resolveReq, rejectReq) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: nginxPort,
          path: `/assets/${assetFile}`,
          method: 'GET',
          headers: {
            'Accept-Encoding': 'gzip',
          },
        }, (incoming) => {
          const chunks = [];
          incoming.on('data', (c) => chunks.push(c));
          incoming.on('end', () => resolveReq({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            rawWireBody: Buffer.concat(chunks),
          }));
        });
        req.on('error', rejectReq);
        req.end();
      });

      assert.equal(statusCode, 200);
      assert.equal(headers['content-encoding'], 'gzip', `Wire response for ${assetFile} must declare content-encoding: gzip`);

      // Gzip magic bytes check (0x1f, 0x8b)
      assert.equal(rawWireBody[0], 0x1f, `First magic byte of gzip header for ${assetFile} must be 0x1f`);
      assert.equal(rawWireBody[1], 0x8b, `Second magic byte of gzip header for ${assetFile} must be 0x8b`);

      const diskContent = readFileSync(join(webDistPath, 'assets', assetFile), 'utf8');
      assert.ok(
        rawWireBody.length < Buffer.byteLength(diskContent),
        `Compressed wire size for ${assetFile} (${rawWireBody.length} bytes) must be smaller than raw size (${Buffer.byteLength(diskContent)} bytes)`,
      );

      const decompressed = gunzipSync(rawWireBody).toString('utf8');
      assert.equal(decompressed, diskContent, `Decompressed wire bytes for ${assetFile} must match original disk content`);
    }
  });

  test('5. Vary: response includes Accept-Encoding variation', async () => {
    const res = await fetch(`http://127.0.0.1:${nginxPort}/assets/${hashedJsFile}`, {
      headers: {
        'Accept-Encoding': 'gzip',
      },
    });
    assert.equal(res.status, 200);
    const vary = res.headers.get('vary');
    assert.ok(vary, 'Vary header must be present');
    assert.match(vary, /Accept-Encoding/i, 'Vary header must include Accept-Encoding');
  });

  test('6. API proxy: continues routing correctly and avoids accidental public immutable caching', async () => {
    const res = await fetch(`http://127.0.0.1:${nginxPort}/v1/health`);
    assert.equal(res.status, 200, '/v1/health must proxy successfully');

    assert.equal(
      res.headers.get('content-encoding'),
      null,
      'API upstream response must not receive nginx gzip compression (gzip off)',
    );

    const cacheControl = res.headers.get('cache-control');
    if (cacheControl) {
      assert.doesNotMatch(cacheControl, /immutable/, 'API response must not have immutable caching');
      assert.doesNotMatch(cacheControl, /31536000/, 'API response must not have long-lived static max-age');
    }
  });

  test('7. WebSocket proxy: Upgrade and connection behavior not regressed', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${nginxPort}/ws`, {
      origin: `http://127.0.0.1:${nginxPort}`,
    });
    try {
      await waitForOpen(ws);
      assert.equal(ws.readyState, WebSocket.OPEN, 'WebSocket must connect successfully through Nginx');
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
  });

  test('8. Security headers: all existing security headers preserved on responses', async () => {
    const paths = ['/', `/assets/${hashedJsFile}`];

    for (const path of paths) {
      const res = await fetch(`http://127.0.0.1:${nginxPort}${path}`);
      assert.equal(res.status, 200, `${path} must return 200 OK`);

      assert.equal(
        res.headers.get('content-security-policy'),
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
        `Content-Security-Policy missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('cross-origin-resource-policy'),
        'same-origin',
        `Cross-Origin-Resource-Policy missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('permissions-policy'),
        'camera=(), geolocation=(), microphone=(), payment=()',
        `Permissions-Policy missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('referrer-policy'),
        'no-referrer',
        `Referrer-Policy missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
        `Strict-Transport-Security missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('x-content-type-options'),
        'nosniff',
        `X-Content-Type-Options missing or wrong on ${path}`,
      );
      assert.equal(
        res.headers.get('x-frame-options'),
        'DENY',
        `X-Frame-Options missing or wrong on ${path}`,
      );
    }
  });

  test('9. Nonexistent route: does not receive misleading immutable caching and preserves security headers', async () => {
    const resMissingAsset = await fetch(`http://127.0.0.1:${nginxPort}/assets/nonexistent-hash-file.js`);
    assert.equal(resMissingAsset.status, 404, 'Missing asset under /assets/ must return 404');
    const missingAssetCache = resMissingAsset.headers.get('cache-control');
    if (missingAssetCache) {
      assert.doesNotMatch(missingAssetCache, /immutable/, '404 asset must NOT have immutable cache-control');
    }

    // Verify all 7 security headers survive 404 responses via 'always' directive
    assert.equal(
      resMissingAsset.headers.get('content-security-policy'),
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
      'Content-Security-Policy must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('cross-origin-resource-policy'),
      'same-origin',
      'Cross-Origin-Resource-Policy must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('permissions-policy'),
      'camera=(), geolocation=(), microphone=(), payment=()',
      'Permissions-Policy must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('referrer-policy'),
      'no-referrer',
      'Referrer-Policy must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains',
      'Strict-Transport-Security must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('x-content-type-options'),
      'nosniff',
      'X-Content-Type-Options must be present on 404 via always',
    );
    assert.equal(
      resMissingAsset.headers.get('x-frame-options'),
      'DENY',
      'X-Frame-Options must be present on 404 via always',
    );
  });

  test('10. Hashed asset without gzip Accept-Encoding: returns valid original uncompressed representation with Vary header', async () => {
    for (const assetFile of [hashedJsFile, hashedCssFile]) {
      const diskContent = readFileSync(join(webDistPath, 'assets', assetFile), 'utf8');

      // 10a. Explicit identity encoding
      const resIdentity = await fetch(`http://127.0.0.1:${nginxPort}/assets/${assetFile}`, {
        headers: {
          'Accept-Encoding': 'identity',
        },
      });
      assert.equal(resIdentity.status, 200);
      assert.equal(resIdentity.headers.get('content-encoding'), null, `Identity request for ${assetFile} must not receive Content-Encoding`);
      assert.match(
        resIdentity.headers.get('vary') || '',
        /Accept-Encoding/i,
        `Identity request for ${assetFile} must include Vary: Accept-Encoding (gzip_vary on)`,
      );

      const identityText = await resIdentity.text();
      assert.equal(identityText, diskContent, `Uncompressed response body for ${assetFile} must exactly match disk content`);

      // 10b. Omitted Accept-Encoding header (using httpRequest to avoid fetch's automatic Accept-Encoding header)
      const { statusCode, headers, body } = await new Promise((resolveReq, rejectReq) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: nginxPort,
          path: `/assets/${assetFile}`,
          method: 'GET',
          headers: {},
        }, (incoming) => {
          const chunks = [];
          incoming.on('data', (c) => chunks.push(c));
          incoming.on('end', () => resolveReq({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('error', rejectReq);
        req.end();
      });

      assert.equal(statusCode, 200);
      assert.equal(headers['content-encoding'], undefined, `Omitted encoding request for ${assetFile} must not receive Content-Encoding`);
      assert.match(
        headers['vary'] || '',
        /Accept-Encoding/i,
        `Omitted encoding request for ${assetFile} must include Vary: Accept-Encoding (gzip_vary on)`,
      );
      assert.equal(body, diskContent, `Uncompressed response body for ${assetFile} must exactly match disk content`);
    }

    // 10c. index.html also includes Vary: Accept-Encoding
    const resIndex = await fetch(`http://127.0.0.1:${nginxPort}/index.html`, {
      headers: {
        'Accept-Encoding': 'identity',
      },
    });
    assert.equal(resIndex.status, 200);
    assert.match(
      resIndex.headers.get('vary') || '',
      /Accept-Encoding/i,
      'index.html must include Vary: Accept-Encoding (gzip_vary on)',
    );
  });
});
