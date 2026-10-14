/** PG-F1 protected persistence surface. No production caller uses this adapter.
 * A grant is authority, not a stateRevision or a durable command receipt.
 */
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { GameEvent } from '@chess-platform/game';
import { CURRENT_EVENT_VERSION } from '../event-store';
import { ConcurrencyError, PersistenceError } from '../errors';
import { lockGameCreationPlayers } from './event-store';

const MAX_EPOCH = 9223372036854775807n;
const MAX_SEQUENCE = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Proven noncommitting rejection; messages and fields never carry SQL parameters. */
export class FenceRejectedError extends PersistenceError {
  readonly appendRejected = true;
  constructor(readonly requestId: string) { super('protected operation rejected'); this.name = 'FenceRejectedError'; }
}

/** Not a rejection. Preserve this exact request identity; never automatically retry. */
export class FencedOutcomeUnknownError extends PersistenceError {
  constructor(readonly requestId: string) { super('protected operation outcome unknown'); this.name = 'FencedOutcomeUnknownError'; }
}

/** A head conflict is also a proven rejection, but retains the exact request. */
export class FencedHeadConflictError extends ConcurrencyError {
  constructor(readonly requestId: string,gameId: string,expectedSeq: number) {
    super(gameId,expectedSeq); this.name = 'FencedHeadConflictError';
  }
}

export interface FencingAcquireInput {
  readonly gameId: string;
  readonly databaseIncarnation: string;
  readonly processIncarnation: string;
  /** Canonical decimal BIGINT, not a JavaScript number. */
  readonly expectedEpoch: string;
  readonly leaseMs: number;
  readonly requestId: string;
}

/** Generate once per acquisition intent. Reusing this object can recover only
 * its same still-live acquisition; it never renews or adopts a successor.
 */
export class FencingAcquireIntent {
  readonly #capability = randomBytes(32);
  readonly input: Readonly<FencingAcquireInput>;
  constructor(input: FencingAcquireInput) {
    validateIdentity(input.gameId,input.databaseIncarnation,input.processIncarnation,input.requestId);
    if (!validEpoch(input.expectedEpoch) || !positiveInteger(input.leaseMs)) throw new FenceRejectedError(input.requestId);
    this.input = Object.freeze({ ...input });
    Object.freeze(this);
  }
  /** Sensitive SQL-bound bytes. Never log parameters or trace this result. */
  capabilityForQuery(): Buffer { return Buffer.from(this.#capability); }
  toJSON(): object { return { ...this.input, capability: '[REDACTED]' }; }
  [inspect.custom](): object { return this.toJSON(); }
}

export interface FencingGrantIdentity {
  readonly gameId: string;
  readonly databaseIncarnation: string;
  readonly processIncarnation: string;
  readonly epoch: string;
  readonly leaseUntil: string;
}

/** Immutable grant; raw capability is a private, non-enumerable field. */
export class FencingGrant {
  readonly #capability: Buffer;
  readonly #identity: Readonly<FencingGrantIdentity>;
  constructor(identity: FencingGrantIdentity,capability: Buffer) {
    this.#identity = Object.freeze({ ...identity });
    this.#capability = Buffer.from(capability);
    Object.freeze(this);
  }
  get gameId(): string { return this.#identity.gameId; }
  get databaseIncarnation(): string { return this.#identity.databaseIncarnation; }
  get processIncarnation(): string { return this.#identity.processIncarnation; }
  get epoch(): string { return this.#identity.epoch; }
  get leaseUntil(): string { return this.#identity.leaseUntil; }
  /** Sensitive SQL-bound bytes, deliberately excluded from serialization/inspection. */
  capabilityForQuery(): Buffer { return Buffer.from(this.#capability); }
  toJSON(): object { return { gameId:this.gameId,databaseIncarnation:this.databaseIncarnation,
    processIncarnation:this.processIncarnation,epoch:this.epoch,leaseUntil:this.leaseUntil,capability:'[REDACTED]' }; }
  [inspect.custom](): object { return this.toJSON(); }
}

/** Explicit operator-approved budgets. PG-F1 supplies no production defaults. */
export interface FencingTransactionPolicy {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
}

export interface FencingCreationInput {
  readonly gameId: string;
  readonly databaseIncarnation: string;
  readonly events: readonly GameEvent[];
  readonly requestId: string;
}

function positiveInteger(value: number): boolean { return Number.isInteger(value) && value>0 && value<=MAX_SEQUENCE; }
function validEpoch(value: string): boolean { return /^(0|[1-9][0-9]*)$/.test(value) && value.length<=19 && BigInt(value)<=MAX_EPOCH; }
function validateIdentity(game: string,db: string,process: string,requestId: string): void {
  if (!UUID.test(game) || !UUID.test(db) || !UUID.test(process) || !requestId) throw new FenceRejectedError(requestId);
}
function sqlCode(error: unknown): string | undefined {
  return typeof error==='object' && error!==null && 'code' in error && typeof error.code==='string' ? error.code : undefined;
}
function rejection(error: unknown,requestId: string,gameId: string,head?: number): Error {
  return sqlCode(error)==='PFH01' && head!==undefined ? new FencedHeadConflictError(requestId,gameId,head) : new FenceRejectedError(requestId);
}
function payload(events: readonly GameEvent[]): string {
  return JSON.stringify(events.map(event=>({type:event.type,version:CURRENT_EVENT_VERSION,payload:event})));
}
function grantArgs(g: FencingGrant): unknown[] { return [g.gameId,g.databaseIncarnation,g.epoch,g.processIncarnation,g.capabilityForQuery()]; }
function validExpiry(value: unknown): value is string { return typeof value==='string' && Number.isFinite(Date.parse(value)); }

/** Used BEFORE supplying a capability. Fixture/operator role settings must have
 * disabled bind logging from connection startup; setting them inside the function
 * is too late to prevent query logging. No authorization GUC is installed.
 */
async function checkLogging(client: PoolClient,requestId: string): Promise<void> {
  const result = await client.query<{ normal: string; error: string }>(
    "SELECT current_setting('log_parameter_max_length') AS normal,current_setting('log_parameter_max_length_on_error') AS error");
  if (result.rows[0]?.normal!=='0' || result.rows[0]?.error!=='0') throw new FenceRejectedError(requestId);
}

/** Composable callers must use this after their staged creation/projection work.
 * A lost or malformed COMMIT acknowledgment is uncertainty, never cancellation.
 * The caller still owns releasing/destroying its client; this helper does not.
 */
export async function commitFencedTransaction(client: PoolClient,requestId: string): Promise<void> {
  let transportFailed=false;
  // pg rejects the query AND emits a client error on socket loss. Observe both;
  // otherwise an already-classified unknown outcome can crash the process.
  const observeFailure=(): void=>{ transportFailed=true; };
  client.on('error',observeFailure);
  try {
    const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') {
      if (result.command === 'ROLLBACK') throw new FenceRejectedError(requestId);
      throw new FencedOutcomeUnknownError(requestId);
    }
  } catch (error) {
    if (error instanceof FenceRejectedError) throw error;
    throw new FencedOutcomeUnknownError(requestId);
  } finally {
    if (transportFailed) client.once('end',()=>client.off('error',observeFailure));
    else client.off('error',observeFailure);
  }
}

/** Independent from EventStore: there is no tokenless existing-stream overload. */
export class PostgresFencedEventStore {
  constructor(private readonly pool: Pool,private readonly policy: FencingTransactionPolicy) {
    if (![policy.lockTimeoutMs,policy.statementTimeoutMs,policy.idleTransactionTimeoutMs].every(positiveInteger))
      throw new PersistenceError('explicit positive fencing transaction budgets required');
    this.policy = Object.freeze({ ...policy });
  }

  private async transaction<Row extends QueryResultRow>(requestId: string,gameId: string,
    execute: (client: PoolClient) => Promise<Row>,head?: number): Promise<Row> {
    let client: PoolClient;
    try { client = await this.pool.connect(); }
    catch { throw new FenceRejectedError(requestId); }
    let commitDispatched=false, destroyed=false;
    const observeFailure=(): void=>{ destroyed=true; };
    client.on('error',observeFailure);
    try {
      await checkLogging(client,requestId);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),
        set_config('idle_in_transaction_session_timeout',$3,true)`,
      [`${this.policy.lockTimeoutMs}ms`,`${this.policy.statementTimeoutMs}ms`,`${this.policy.idleTransactionTimeoutMs}ms`]);
      const result=await execute(client);
      commitDispatched=true;
      await commitFencedTransaction(client,requestId);
      return result;
    } catch (error) {
      if (commitDispatched) {
        destroyed=true;
        throw error instanceof FenceRejectedError ? error : new FencedOutcomeUnknownError(requestId);
      }
      try { await client.query('ROLLBACK'); }
      catch { destroyed=true; throw new FencedOutcomeUnknownError(requestId); }
      throw rejection(error,requestId,gameId,head);
    } finally {
      if (destroyed) client.once('end',()=>client.off('error',observeFailure));
      else client.off('error',observeFailure);
      client.release(destroyed);
    }
  }

  async acquire(intent: FencingAcquireIntent): Promise<FencingGrant> {
    const i=intent.input;
    const row=await this.transaction(i.requestId,i.gameId,async client=>(await client.query(
      'SELECT epoch::text,lease_until::text AS expiry FROM game_fencing.acquire($1,$2,$3,$4,$5,$6)',
      [i.gameId,i.databaseIncarnation,i.expectedEpoch,i.processIncarnation,intent.capabilityForQuery(),i.leaseMs])).rows[0]);
    if (!row || typeof row.epoch!=='string' || !validEpoch(row.epoch) || BigInt(row.epoch)!==BigInt(i.expectedEpoch)+1n || !validExpiry(row.expiry))
      throw new FencedOutcomeUnknownError(i.requestId);
    return new FencingGrant({gameId:i.gameId,databaseIncarnation:i.databaseIncarnation,
      processIncarnation:i.processIncarnation,epoch:row.epoch,leaseUntil:row.expiry},intent.capabilityForQuery());
  }

  async renew(grant: FencingGrant,leaseMs: number,requestId: string): Promise<FencingGrant> {
    if (!positiveInteger(leaseMs) || !requestId) throw new FenceRejectedError(requestId);
    const row=await this.transaction(requestId,grant.gameId,async client=>(await client.query(
      'SELECT game_fencing.renew($1,$2,$3,$4,$5,$6)::text AS expiry',[...grantArgs(grant),leaseMs])).rows[0]);
    if (!row || !validExpiry(row.expiry)) throw new FencedOutcomeUnknownError(requestId);
    return new FencingGrant({gameId:grant.gameId,databaseIncarnation:grant.databaseIncarnation,
      processIncarnation:grant.processIncarnation,epoch:grant.epoch,leaseUntil:row.expiry},grant.capabilityForQuery());
  }

  async release(grant: FencingGrant,requestId: string): Promise<void> {
    if (!requestId) throw new FenceRejectedError(requestId);
    await this.transaction(requestId,grant.gameId,async client=>(await client.query(
      'SELECT game_fencing.release($1,$2,$3,$4,$5)',grantArgs(grant))).rows[0]);
  }

  async append(grant: FencingGrant,expectedSeq: number,events: readonly GameEvent[],requestId: string): Promise<number> {
    if (!requestId || !Number.isInteger(expectedSeq) || expectedSeq<0 || !events.length || expectedSeq+events.length>MAX_SEQUENCE)
      throw new FenceRejectedError(requestId);
    const serialized=payload(events);
    const row=await this.transaction(requestId,grant.gameId,async client=>(await client.query(
      'SELECT game_fencing.append_events($1,$2,$3,$4,$5,$6,$7) AS head',[...grantArgs(grant),expectedSeq,serialized])).rows[0],expectedSeq);
    if (!row || row.head!==expectedSeq+events.length) throw new FencedOutcomeUnknownError(requestId);
    return row.head;
  }

  /** Caller must BEGIN, then claim seek (if applicable), before calling. Player
   * locks precede control/grant locks. Result is STAGED, not a committed receipt.
   * Caller owns projection writes, COMMIT uncertainty and client destruction.
   */
  async createOnClient(client: PoolClient,input: FencingCreationInput): Promise<number> {
    const {gameId,databaseIncarnation,events,requestId}=input;
    if (!requestId || !UUID.test(gameId) || !UUID.test(databaseIncarnation) || !events.length
        || events[0]?.type!=='GameCreated' || events[0].gameId!==gameId) throw new FenceRejectedError(requestId);
    try {
      await checkLogging(client,requestId);
      await lockGameCreationPlayers(client,events);
      const result=await client.query<{ head: number }>('SELECT game_fencing.create_stream($1,$2,$3) AS head',
        [gameId,databaseIncarnation,payload(events)]);
      if (result.rows[0]?.head!==events.length-1) throw new PersistenceError('invalid staged creation result');
      return result.rows[0]!.head;
    } catch (error) {
      if (sqlCode(error)) throw rejection(error,requestId,gameId,-1);
      throw new PersistenceError('protected creation failed; caller must rollback or establish transaction outcome');
    }
  }
}
