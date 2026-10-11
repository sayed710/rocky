import type { Redis } from 'ioredis';
import { ENQUEUE_REQUEST, START_REQUEST, FINISH_REQUEST, SETTLE_REQUEST, RESPOND_REQUEST } from '../../src/forwarded-request.js';

interface Record { status: string; payload: string; deadline: number; expiry: number; executor?: string; result?: string }

/** Deterministic transport for scheduling races. Lua itself is tested with real Redis separately. */
export class ForwardRedis {
  now = 0;
  owner = 'owner';
  loseResponses = true;
  failFinish = false;
  failSettle = false;
  failResponse = false;
  enqueueReplyLost = false;
  reconnectAfterLostEnqueue = false;
  enqueueAttempts = 0;
  onWait: (() => Promise<void>) | undefined;
  readonly records = new Map<string, Record>();
  readonly lists = new Map<string, string[]>();
  readonly client = this as unknown as Redis;

  private record(key: string): Record | undefined {
    const rec = this.records.get(key);
    if (rec && rec.expiry <= this.now) { this.records.delete(key); return undefined; }
    return rec;
  }
  async eval(script: string, n: number, ...input: (string | number)[]): Promise<string | number> {
    const keys = input.slice(0, n).map(String);
    const args = input.slice(n).map(String);
    const key = keys[0]!;
    const rec = this.record(key);
    if (script === ENQUEUE_REQUEST) {
      this.enqueueAttempts++;
      if (rec) return 0;
      this.records.set(key, { status: 'queued', payload: args[0]!, deadline: this.now + Number(args[1]), expiry: this.now + Number(args[1]) + Number(args[2]) });
      const list = this.lists.get(keys[1]!) ?? [];
      list.push(args[0]!); this.lists.set(keys[1]!, list);
      if (this.enqueueReplyLost) throw new Error('enqueue acknowledgement lost');
      return 1;
    }
    if (script === START_REQUEST) {
      if (!rec || rec.payload !== args[0]) return 'missing';
      if (rec.status !== 'queued') return rec.status;
      if (this.now >= rec.deadline) { rec.status = 'expired'; return 'expired'; }
      if (this.owner !== args[1]) {
        const list = this.lists.get(keys[2]!) ?? []; list.push(args[0]!); this.lists.set(keys[2]!, list);
        return 'not_owner';
      }
      rec.status = 'started'; rec.executor = args[2]; rec.expiry = this.now + Number(args[3]);
      return 'admitted';
    }
    if (script === FINISH_REQUEST) {
      if (this.failFinish) throw new Error('Redis unavailable after commit');
      if (!rec || rec.status !== 'started' || rec.executor !== args[0]) return 0;
      rec.status = 'done'; rec.result = args[1]; rec.expiry = this.now + Number(args[2]); return 1;
    }
    if (script === SETTLE_REQUEST) {
      if (this.failSettle) throw new Error('Redis unavailable at timeout');
      if (rec?.status === 'done') return rec.result!;
      if (rec?.status === 'queued') {
        rec.status = 'expired';
        this.lists.set(keys[1]!, (this.lists.get(keys[1]!) ?? []).filter((payload) => payload !== args[0]));
        return 'expired';
      }
      return rec?.status ?? 'unknown';
    }
    if (script === RESPOND_REQUEST) {
      if (this.failResponse) throw new Error('response lost');
      const list = this.lists.get(key) ?? []; list.push(args[0]!); this.lists.set(key, list); return 1;
    }
    throw new Error('unexpected Lua script');
  }
  duplicate(options?: { autoResendUnfulfilledCommands?: boolean; enableOfflineQueue?: boolean }) {
    if (options) return {
      connect: async () => undefined,
      eval: async (script: string, n: number, ...input: (string | number)[]) => {
        try { return await this.eval(script, n, ...input); } catch (err) {
          if (this.reconnectAfterLostEnqueue) {
            this.now = 31_001;
            // Model the client's unfulfilled-command resend after retention.
            if (options.autoResendUnfulfilledCommands !== false) {
              this.enqueueReplyLost = false;
              return this.eval(script, n, ...input);
            }
          }
          throw err;
        }
      },
      disconnect: () => undefined,
    };
    return {
      blpop: async (key: string) => {
        await this.onWait?.();
        if (this.loseResponses) return null;
        const value = this.lists.get(key)?.shift();
        return value ? [key, value] : null;
      },
      disconnect: () => undefined,
    };
  }
}
