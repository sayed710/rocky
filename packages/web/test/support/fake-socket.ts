/**
 * Test doubles for the WebSocket layer: a controllable socket + factory and a
 * manual scheduler, so lifecycle/reconnect/heartbeat are fully deterministic.
 * Not a test file itself.
 */
import type { SocketHandlers, WebSocketConnection, WebSocketFactory } from '../../src/ports/ws.js';
import type { Scheduler } from '../../src/net/ws-client.js';

export class FakeSocket implements WebSocketConnection {
  readonly sent: string[] = [];
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;

  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    // Emulate the socket acknowledging a client-initiated close.
    this.handlers.onClose({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
  }

  // ── Test controls ──
  open(): void {
    this.handlers.onOpen();
  }

  emit(message: unknown): void {
    this.handlers.onMessage(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Simulate an unexpected drop initiated by the server/network. */
  serverClose(code = 1006, reason = '', wasClean = false): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.handlers.onClose({ code, reason, wasClean });
  }
}

export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];

  readonly factory: WebSocketFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    this.sockets.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1];
    if (!socket) throw new Error('FakeSocketFactory: no socket created yet');
    return socket;
  }
}

export class ManualScheduler implements Scheduler {
  private seq = 0;
  private readonly tasks = new Map<number, { fn: () => void; ms: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { fn, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  get nextDelayMs(): number | undefined {
    return [...this.tasks.values()][0]?.ms;
  }

  /** Run the oldest scheduled task (FIFO). */
  runNext(): void {
    const entry = [...this.tasks.entries()][0];
    if (!entry) throw new Error('ManualScheduler: no scheduled task');
    this.tasks.delete(entry[0]);
    entry[1].fn();
  }
}
