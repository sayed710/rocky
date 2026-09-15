import assert from 'node:assert/strict';
import { test, describe, after, before } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serveScript = resolve(gatewayDir, 'dist/serve.js');

/** Releases the reservation before returning, so the test process must bind the port immediately. */
async function getFreePort(): Promise<number> {
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

/** Waits for the gateway health endpoint without exceeding the declared deadline. */
async function waitForHealth(healthPort: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const res = await fetch(`http://127.0.0.1:${healthPort}/health`, {
        signal: AbortSignal.timeout(remaining)
      });
      if (res.ok) return;
    } catch {
      // wait
    }
    const delay = Math.max(0, Math.min(100, deadline - Date.now()));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Health check failed on port ${healthPort} within ${timeoutMs}ms`);
}

/** Resolves with a WebSocket close event or rejects when the peer stays open past the deadline. */
async function waitForClose(ws: WebSocket, timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolveClose, reject) => {
    const onClose = (code: number, reason: Buffer) => {
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

describe('Trusted Edge Contract: Gateway WebSocket Admission (TRUST_PROXY=1)', () => {
  let gwProc: ChildProcess | undefined;
  let port: number;
  let healthPort: number;

  before(async () => {
    port = await getFreePort();
    healthPort = await getFreePort();

    gwProc = spawn(process.execPath, [serveScript], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        PORT: String(port),
        HEALTH_PORT: String(healthPort),
        HOST: '127.0.0.1',
        ACCESS_TOKEN_SECRET: 'test-secret-at-least-32-bytes-long-1234567890',
        WS_MAX_CONNECTIONS_PER_IP: '20',
        TRUST_PROXY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gwProc.on('error', () => {});

    await waitForHealth(healthPort);
  });

  after(() => {
    if (gwProc) {
      gwProc.kill('SIGTERM');
    }
  });

  test('25 distinct clients behind trusted proxy must all be admitted (not collapse to proxy IP)', async () => {
    const sockets: WebSocket[] = [];
    const closeEvents: { code: number; reason: string; clientIndex: number }[] = [];

    try {
      for (let i = 1; i <= 25; i++) {
        const clientIp = `198.51.100.${i}`;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            'x-forwarded-for': clientIp,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), clientIndex: index });
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const rejectedWith1013 = closeEvents.filter((e) => e.code === 1013);
      assert.equal(
        rejectedWith1013.length,
        0,
        `Expected 0 sockets rejected with 1013, but ${rejectedWith1013.length} sockets were rejected`,
      );

      const openCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount, 25, `Expected all 25 sockets to be open, but only ${openCount} were open`);
    } finally {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('same client behind trusted proxy cannot exceed 20 connections (21-25 rejected with 1013)', async () => {
    const sockets: WebSocket[] = [];
    const closeEvents: { code: number; reason: string; index: number }[] = [];
    const clientIp = '198.51.100.200';

    try {
      // Open 20 connections for the same client
      for (let i = 1; i <= 20; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            'x-forwarded-for': clientIp,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const openCount20 = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount20, 20, `Expected first 20 sockets to open, got ${openCount20}`);

      // Attempt 5 more connections for the same client
      for (let i = 21; i <= 25; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            'x-forwarded-for': clientIp,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const rejected = closeEvents.filter((e) => e.code === 1013);
      assert.equal(
        rejected.length,
        5,
        `Expected 5 sockets (21-25) to be rejected with 1013, got ${rejected.length}`,
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

  test('equivalent IPv6 spellings share one per-IP connection limit', async () => {
    const sockets: WebSocket[] = [];
    const spellings = ['2001:db8::1', '2001:0db8:0:0:0:0:0:1'];

    try {
      for (let i = 0; i < 20; i++) {
        sockets.push(new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { 'x-forwarded-for': spellings[i % spellings.length]! },
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length, 20);

      const overflow = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { 'x-forwarded-for': '2001:0DB8:0000:0000:0000:0000:0000:0001' },
      });
      sockets.push(overflow);
      const closed = await waitForClose(overflow);
      assert.deepEqual(closed, { code: 1013, reason: 'connection limit exceeded' });
    } finally {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  test('missing or malformed trusted identity is rejected without using the proxy socket address', async () => {
    for (const forwardedFor of [undefined, 'not-an-ip']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
      });
      const closed = await waitForClose(ws);
      assert.deepEqual(closed, { code: 1008, reason: 'client identity unavailable' });
    }
  });

  test('spoofed X-Forwarded-For prefix behind trusted proxy does not bypass per-IP limit', async () => {
    const sockets: WebSocket[] = [];
    const closeEvents: { code: number; reason: string; index: number }[] = [];
    const realClientIp = '198.51.100.201';

    try {
      // Connect 20 times with varying spoofed prefixes: "<spoofed_ip>, <real_ip>"
      // The trusted edge proxy appends <real_ip>, so right-to-left resolution must pick <real_ip>.
      for (let i = 1; i <= 20; i++) {
        const spoofedPrefix = `10.0.0.${i}`;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            'x-forwarded-for': `${spoofedPrefix}, ${realClientIp}`,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const openCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount, 20, `Expected 20 sockets to open for ${realClientIp}, got ${openCount}`);

      // 21st connection with another spoofed prefix must be REJECTED because realClientIp is at capacity
      const ws21 = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: {
          'x-forwarded-for': `10.0.0.99, ${realClientIp}`,
        },
      });
      sockets.push(ws21);

      const close21 = await waitForClose(ws21);

      assert.equal(
        close21.code,
        1013,
        `Expected connection 21 to be rejected with 1013 (connection limit exceeded), got ${close21.code}`,
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

  test('closing connection decrements per-IP counter allowing new connection', async () => {
    const sockets: WebSocket[] = [];
    const clientIp = '198.51.100.202';

    try {
      // Open 20 connections
      for (let i = 1; i <= 20; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { 'x-forwarded-for': clientIp },
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(sockets.filter((s) => s.readyState === WebSocket.OPEN).length, 20);

      // Close 1 connection
      const socketToClose = sockets[0]!;
      const closePromise = new Promise<void>((resolve) => socketToClose.once('close', () => resolve()));
      socketToClose.close();
      await closePromise;
      await new Promise((r) => setTimeout(r, 100));

      // Now a 21st connection must succeed
      const newWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { 'x-forwarded-for': clientIp },
      });
      sockets.push(newWs);

      const opened = await new Promise<boolean>((resolve) => {
        newWs.on('open', () => resolve(true));
        newWs.on('close', () => resolve(false));
      });

      assert.equal(opened, true, 'Expected new connection to be admitted after closing one');
    } finally {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});

describe('Trusted Edge Contract: Gateway Direct Socket Mode (TRUST_PROXY=false)', () => {
  let gwProc: ChildProcess | undefined;
  let port: number;
  let healthPort: number;

  before(async () => {
    port = await getFreePort();
    healthPort = await getFreePort();

    gwProc = spawn(process.execPath, [serveScript], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        PORT: String(port),
        HEALTH_PORT: String(healthPort),
        HOST: '127.0.0.1',
        ACCESS_TOKEN_SECRET: 'test-secret-at-least-32-bytes-long-1234567890',
        WS_MAX_CONNECTIONS_PER_IP: '20',
        TRUST_PROXY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gwProc.on('error', () => {});

    await waitForHealth(healthPort);
  });

  after(() => {
    if (gwProc) {
      gwProc.kill('SIGTERM');
    }
  });

  test('when TRUST_PROXY=false, X-Forwarded-For is ignored and peer socket IP is used', async () => {
    // In direct mode (no proxy trusted), even if client sends distinct XFF headers,
    // all connections from 127.0.0.1 are identified as 127.0.0.1.
    // Thus 25 connections will have 20 admitted and 5 rejected.
    const sockets: WebSocket[] = [];
    const closeEvents: { code: number; reason: string; index: number }[] = [];

    try {
      for (let i = 1; i <= 25; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            'x-forwarded-for': `198.51.100.${i}`,
          },
        });
        const index = i;
        ws.on('close', (code, reason) => {
          closeEvents.push({ code, reason: reason.toString(), index });
        });
        sockets.push(ws);
      }

      await new Promise((resolve) => setTimeout(resolve, 600));

      const rejected = closeEvents.filter((e) => e.code === 1013);
      assert.equal(
        rejected.length,
        5,
        `Expected 5 connections to be rejected with 1013 because direct socket IP (127.0.0.1) is capped at 20`,
      );

      const openCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      assert.equal(openCount, 20, `Expected 20 connections to be open, got ${openCount}`);
    } finally {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});
