import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, type GameEvent } from '@chess-platform/game';
import { migrate, migrationsDir } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PlayerLockBusyError, lockGameCreationPlayers } from '../src/pg/event-store';
import { withTestDatabase } from '../src/test-support/database';
import { uuidv7 } from '../src/ids';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { prepareGameFencing, seedGameFencing } from '../src/pg/fencing-preparation';
import { FencingAcquireIntent, FencingGrant, PostgresFencedEventStore, FenceRejectedError, FencedOutcomeUnknownError,
  commitFencedTransaction } from '../src/pg/fenced-event-store';
import { inspect } from 'node:util';
import { createServer, connect, type Socket } from 'node:net';
import { mkdir, mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const connectionString = process.env['DATABASE_URL'];
const skip = connectionString ? false : 'DATABASE_URL not set';

test('PG-F1 migration supplies an inactive protected boundary without changing legacy creation', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const gameId = uuidv7();
    const { events } = Game.create({ gameId, at: 1000, rated: false,
      players: { white: 'a', black: 'b' },
      timeControl: { kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 } });
    assert.equal(await new PostgresEventStore(pool).append(gameId, -1, events), 0);
    const schema = await pool.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'game_fencing') AS present");
    assert.equal(schema.rows[0]?.present, true, 'additive fencing schema must be installed');
    const control = await pool.query('SELECT * FROM game_fencing.control');
    assert.equal(control.rowCount, 1);
    assert.equal(control.rows[0]?.database_incarnation, null);
    assert.equal(control.rows[0]?.max_lease_ms, null);
    assert.equal(control.rows[0]?.enforced, false);
    assert.equal((await pool.query('SELECT * FROM game_fencing.grants WHERE game_id=$1', [gameId])).rowCount, 0,
      'late legacy creation is deliberately not activated or auto-granted');
    assert.equal(await migrate(pool, migrationsDir()), 0);
  }, { connectionString, max: 4 });
});

/** Authenticated logins, never SET ROLE as a stand-in for authentication. */
async function restrictedDatabase(run: (admin: Pool, a: Pool, b: Pool, db: string) => Promise<void>): Promise<void> {
  const suffix = randomBytes(8).toString('hex');
  const owner = `pgf1_owner_${suffix}`, executor = `pgf1_exec_${suffix}`;
  const alice = `pgf1_a_${suffix}`, bob = `pgf1_b_${suffix}`;
  const names = [owner, executor, alice, bob];
  const password = randomBytes(24).toString('hex');
  const cluster = new Pool({ connectionString });
  try {
    for (const name of names) await cluster.query(`CREATE ROLE ${name} NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      ${name === alice || name === bob ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}`);
    await withTestDatabase(async ({ pool, connectionString: url }) => {
      await migrate(pool, migrationsDir());
      const db = randomUUID();
      await prepareGameFencing(pool,{tableOwner:owner,functionOwner:executor,databaseIncarnation:db,maxLeaseMs:60000});
      await pool.query(`GRANT USAGE ON SCHEMA game_fencing TO ${alice},${bob};
        GRANT SELECT ON public.game_events TO ${alice},${bob};`);
      const functions = await pool.query<{ signature: string; proname: string }>(
        `SELECT p.oid::regprocedure::text AS signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='game_fencing'`);
      for (const fn of functions.rows) {
        if (['acquire', 'renew', 'release', 'append_events', 'create_stream'].includes(fn.proname))
          await pool.query(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO ${alice},${bob}`);
      }
      for (const name of [alice, bob]) await pool.query(`ALTER ROLE ${name} SET log_parameter_max_length=0;
        ALTER ROLE ${name} SET log_parameter_max_length_on_error=0;`);
      const login = (user: string) => { const target = new URL(url); target.username=user; target.password=password;
        return new Pool({ connectionString: target.toString(), max: 3 }); };
      const a=login(alice), b=login(bob);
      try {
        assert.equal((await a.query('SELECT session_user')).rows[0]?.session_user, alice);
        assert.equal((await b.query('SELECT session_user')).rows[0]?.session_user, bob);
        await run(pool,a,b,db);
      } finally { await a.end(); await b.end(); }
    }, { connectionString, max: 4 });
  } finally {
    for (const name of names.reverse()) await cluster.query(`DROP ROLE IF EXISTS ${name}`);
    await cluster.end();
  }
}

type Grant = { game: string; db: string; epoch: string; process: string; capability: Buffer; expiry: string };
function initialEvents(gameId: string) {
  return Game.create({ gameId, at: 1000, rated: false, players: { white: 'a', black: 'b' },
    timeControl: { kind: 'sudden_death', initialMs: 60_000, incrementMs: 0, delayMs: 0 } }).events;
}
const batch = (events: readonly GameEvent[]) => JSON.stringify(events.map(event => ({ type:event.type,version:1,payload:event })));
async function seed(admin: Pool, game = randomUUID()): Promise<string> {
  await new PostgresEventStore(admin).append(game,-1,initialEvents(game));
  await admin.query('INSERT INTO game_fencing.grants(game_id) VALUES($1) ON CONFLICT DO NOTHING',[game]);
  return game;
}
async function acquire(a: Pool | PoolClient, game: string, db: string, expected='0', lease=60000): Promise<Grant> {
  const process=randomUUID(), capability=randomBytes(32);
  const result=await a.query<{ epoch: string; expiry: string }>(
    'SELECT epoch::text,lease_until::text AS expiry FROM game_fencing.acquire($1,$2,$3,$4,$5,$6)',
    [game,db,expected,process,capability,lease]);
  return {game,db,epoch:result.rows[0]!.epoch,process,capability,expiry:result.rows[0]!.expiry};
}
const args = (g: Grant) => [g.game,g.db,g.epoch,g.process,g.capability];
const ready: GameEvent = {type:'PlayerReady',by:'w',at:1001};
async function append(a: Pool | PoolClient,g: Grant,head=0,events=[ready]): Promise<number> {
  return (await a.query<{ head: number }>('SELECT game_fencing.append_events($1,$2,$3,$4,$5,$6,$7) AS head',
    [...args(g),head,batch(events)])).rows[0]!.head;
}
const hasCode = (code: string) => (error: unknown): boolean =>
  typeof error==='object' && error!==null && 'code' in error && error.code===code;

/** Observe a real row-lock wait; polling is bounded and yields, never a timing assertion. */
async function blocked(admin: Pool,pid: number): Promise<void> {
  const deadline=Date.now()+10000;
  for (;;) {
    if ((await admin.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0]?.waiting) return;
    assert.ok(Date.now()<deadline,'contender must wait on the actual grant transaction');
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
}

test('PG-F1 real logins: concurrent acquisition, epoch monotonicity, stale and forged grants', { skip }, async () => {
  await restrictedDatabase(async(admin,a,b,db)=>{
    const game=await seed(admin);
    const results=await Promise.allSettled([acquire(a,game,db),acquire(b,game,db)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const winner=results.find(r=>r.status==='fulfilled'); assert.ok(winner?.status==='fulfilled');
    const grant=winner.value, pool=results[0]?.status==='fulfilled'?a:b, other=pool===a?b:a;
    assert.equal(grant.epoch,'1');
    await assert.rejects(append(other,grant),hasCode('PFG01'));
    await assert.rejects(append(pool,{...grant,process:randomUUID()}),hasCode('PFG01'));
    await assert.rejects(append(pool,{...grant,capability:randomBytes(32)}),hasCode('PFG01'));
    const retry=await pool.query('SELECT epoch::text,lease_until::text FROM game_fencing.acquire($1,$2,0,$3,$4,60000)',
      [game,db,grant.process,grant.capability]);
    assert.equal(retry.rows[0]?.epoch,'1'); assert.equal(retry.rows[0]?.lease_until,grant.expiry);
    await pool.query('SELECT game_fencing.release($1,$2,$3,$4,$5)',args(grant));
    const successor=await acquire(other,game,db,'1'); assert.equal(successor.epoch,'2');
    await assert.rejects(append(pool,grant),hasCode('PFG01'));
    await assert.rejects(pool.query('SELECT game_fencing.renew($1,$2,$3,$4,$5,60000)',args(grant)),hasCode('PFG01'));
    await assert.rejects(pool.query('SELECT game_fencing.release($1,$2,$3,$4,$5)',args(grant)),hasCode('PFG01'));
    assert.equal(await append(other,successor),1);
    assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(r=>r.seq),[0,1]);
  });
});

test('PG-F1 append lock first: successor waits for old commit, then reads its committed head', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db,'0',1000);
    const old=await a.connect(),next=await b.connect();
    try {
      await old.query('BEGIN'); assert.equal(await append(old,grant),1);
      await admin.query('SELECT pg_sleep_until($1::timestamptz)',[grant.expiry]);
      const pid=(await next.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const takeover=acquire(next,game,db,'1');
      await blocked(admin,pid);
      assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(r=>r.seq),[0]);
      await old.query('COMMIT'); const successor=await takeover;
      assert.equal(successor.epoch,'2');
      assert.equal((await next.query('SELECT max(seq) AS head FROM public.game_events WHERE game_id=$1',[game])).rows[0]?.head,1);
      await assert.rejects(append(a,grant,1),hasCode('PFG01'));
    } finally { await old.query('ROLLBACK'); old.release(); next.release(); }
  });
});

test('PG-F1 lease check uses database time after waiting, not transaction-start time', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    const holder=await admin.connect(),writer=await a.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT * FROM game_fencing.grants WHERE game_id=$1 FOR UPDATE',[game]);
      await writer.query('BEGIN');
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const pending=append(writer,grant); const rejected=assert.rejects(pending,hasCode('PFG01'));
      await blocked(admin,pid);
      await holder.query('UPDATE game_fencing.grants SET lease_until=clock_timestamp() WHERE game_id=$1',[game]);
      await holder.query('COMMIT'); await rejected;
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM public.game_events WHERE game_id=$1',[game])).rows[0]?.count,1);
    } finally { await holder.query('ROLLBACK'); await writer.query('ROLLBACK'); holder.release(); writer.release(); }
  });
});

test('PG-F1 restricted roles cannot mutate control/grants, access hashes, execute helpers or escalate schemas', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin); await acquire(a,game,db);
    for (const sql of [
      'SELECT capability_hash FROM game_fencing.grants',
      'UPDATE game_fencing.grants SET epoch=0', 'DELETE FROM game_fencing.grants',
      'TRUNCATE game_fencing.grants','UPDATE game_fencing.control SET max_lease_ms=1',
      'CREATE TABLE game_fencing.shadow(id int)','CREATE TABLE public.shadow(id int)',
      "SELECT game_fencing.lock_control('00000000-0000-0000-0000-000000000000')",
    ]) await assert.rejects(a.query(sql),hasCode('42501'));
    const funcs=await admin.query<{ signature: string; public_allowed: boolean }>(
      `SELECT p.oid::regprocedure::text AS signature,EXISTS(
         SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE'
       ) AS public_allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='game_fencing'`);
    assert.ok(funcs.rows.length>=5); assert.ok(funcs.rows.every(fn=>!fn.public_allowed));
    const owner=(await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure")).rows[0]!.owner;
    await assert.rejects(a.query(`SET ROLE ${owner}`),hasCode('42501'));
  });
});

test('PG-F1 atomic batches, create-only transaction rollback, corruption and INTEGER/epoch exhaustion', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    await assert.rejects(a.query('SELECT game_fencing.append_events($1,$2,$3,$4,$5,0,$6)',
      [...args(grant),JSON.stringify([{type:'PlayerReady',version:1,payload:ready},{type:'Bad',version:0,payload:{type:'Bad'}}])]),hasCode('PFV01'));
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.game_events WHERE game_id=$1',[game])).rows[0]?.n,1);
    await assert.rejects(append(a,grant,1),hasCode('PFH01'));
    await assert.rejects(a.query('SELECT game_fencing.append_events($1,$2,$3,$4,$5,$6::integer,$7)',[...args(grant),'2147483648',batch([ready])]),hasCode('22003'));
    await assert.rejects(admin.query('SELECT game_fencing.insert_batch($1,2147483647,$2,false)',[game,batch([ready])]),hasCode('PFV01'));
    const fresh=randomUUID(),client=await a.connect();
    try {
      await client.query('BEGIN');
      assert.equal((await client.query('SELECT game_fencing.create_stream($1,$2,$3) AS head',[fresh,db,batch(initialEvents(fresh))])).rows[0]?.head,0);
      assert.equal((await admin.query('SELECT 1 FROM public.game_events WHERE game_id=$1',[fresh])).rowCount,0);
      await client.query('ROLLBACK');
      assert.equal((await admin.query('SELECT 1 FROM game_fencing.grants WHERE game_id=$1',[fresh])).rowCount,0);
      assert.equal((await client.query('SELECT game_fencing.create_stream($1,$2,$3) AS head',[fresh,db,batch(initialEvents(fresh))])).rows[0]?.head,0);
      await assert.rejects(client.query('SELECT game_fencing.create_stream($1,$2,$3)',[fresh,db,batch(initialEvents(fresh))]),hasCode('PFH01'));
    } finally { client.release(); }
    await a.query('SELECT game_fencing.release($1,$2,$3,$4,$5)',args(grant));
    await admin.query('UPDATE game_fencing.grants SET epoch=9223372036854775807 WHERE game_id=$1',[game]);
    await assert.rejects(acquire(a,game,db,'9223372036854775807'),hasCode('PFG01'));
    assert.equal((await admin.query('SELECT epoch::text FROM game_fencing.grants WHERE game_id=$1',[game])).rows[0]?.epoch,'9223372036854775807');
  });
});

test('PG-F1 migration installs protected acquisition, renewal, release, append and create-only functions', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrate(pool, migrationsDir());
    const functions = await pool.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='game_fencing' AND p.proname IN ('acquire','renew','release','append_events','create_stream')
       ORDER BY p.proname`);
    assert.deepEqual(functions.rows.map(row => row.proname),
      ['acquire', 'append_events', 'create_stream', 'release', 'renew'], 'new protected contract must exist');
  }, { connectionString, max: 4 });
});

test('PG-F1 controlled preparation works with safe existing NOLOGIN owners and remains inactive', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const owners=(await admin.query(`SELECT pg_get_userbyid(c.relowner) AS tables,
      pg_get_userbyid(p.proowner) AS functions FROM pg_class c,pg_proc p
      WHERE c.oid='game_fencing.grants'::regclass AND p.oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure`)).rows[0]!;
    await assert.doesNotReject(prepareGameFencing(admin,{tableOwner:owners.tables,functionOwner:owners.functions,
      databaseIncarnation:db,maxLeaseMs:60000}));
    const controls=(await admin.query('SELECT enforced FROM game_fencing.control')).rows[0]!;
    assert.equal(controls.enforced,false);
    const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
    await assert.rejects(acquire(a,randomUUID(),db),hasCode('42501'));
    await admin.query(`GRANT EXECUTE ON FUNCTION game_fencing.acquire(uuid,uuid,bigint,uuid,bytea,integer) TO ${login}`);
    const game=await seed(admin); assert.equal((await acquire(a,game,db)).epoch,'1');
  });
});

test('PG-F1 create-only rejects a mismatched durable GameCreated identity atomically', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=randomUUID(),wrong=randomUUID();
    await assert.rejects(a.query('SELECT game_fencing.create_stream($1,$2,$3)',[game,db,batch(initialEvents(wrong))]),hasCode('PFV01'));
    assert.equal((await admin.query('SELECT 1 FROM public.game_events WHERE game_id=$1',[game])).rowCount,0);
    assert.equal((await admin.query('SELECT 1 FROM game_fencing.grants WHERE game_id=$1',[game])).rowCount,0);
  });
});

test('PG-F1 adapter preserves receipts, redacts capabilities and reuses clean clients after known rejection', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),processIncarnation=randomUUID();
    const policy={lockTimeoutMs:3000,statementTimeoutMs:5000,idleTransactionTimeoutMs:5000};
    const adapter=new PostgresFencedEventStore(a,policy);
    const intent=new FencingAcquireIntent({gameId:game,databaseIncarnation:db,processIncarnation,
      expectedEpoch:'0',leaseMs:60000,requestId:'acquisition-original'});
    const grant=await adapter.acquire(intent),secret=intent.capabilityForQuery().toString('hex');
    for(const rendered of [JSON.stringify(intent),inspect(intent),JSON.stringify(grant),inspect(grant)])
      assert.ok(!rendered.includes(secret));
    assert.equal(grant.epoch,'1');
    await assert.rejects(adapter.append(grant,2147483647,[ready],'overflow-original'),
      error=>error instanceof FenceRejectedError && error.requestId==='overflow-original' && error.appendRejected===true);
    assert.equal(await adapter.append(grant,0,[ready],'ready-original'),1);
    await assert.rejects(adapter.append(grant,0,[ready],'head-original'),/concurrent append/);
    assert.equal((await a.query('SELECT current_setting(\'lock_timeout\') AS timeout')).rows[0]?.timeout,'0');
    const renewed=await adapter.renew(grant,60000,'renew-original'); assert.equal(renewed.epoch,grant.epoch);
    await adapter.release(renewed,'release-original');
    await assert.rejects(adapter.append(grant,1,[ready],'stale-original'),
      error=>error instanceof FenceRejectedError && error.requestId==='stale-original');
    const fresh=randomUUID(),client=await a.connect();
    try {
      await client.query('BEGIN');
      assert.equal(await adapter.createOnClient(client,{gameId:fresh,databaseIncarnation:db,events:initialEvents(fresh),requestId:'create-original'}),0);
      await client.query('ROLLBACK');
      assert.equal((await admin.query('SELECT 1 FROM game_fencing.grants WHERE game_id=$1',[fresh])).rowCount,0);
      await client.query('BEGIN');
      assert.equal(await adapter.createOnClient(client,{gameId:fresh,databaseIncarnation:db,events:initialEvents(fresh),requestId:'create-again'}),0);
      await commitFencedTransaction(client,'create-again');
      assert.equal((await admin.query('SELECT 1 FROM public.game_events WHERE game_id=$1',[fresh])).rowCount,1);
    } finally { client.release(); }
  });
});

/** Fault injection at the actual PostgreSQL wire, after server COMMIT. No
 * mocked query result: an independent connection proves whether it committed.
 */
async function lostCommitPool(source: string,mode: 'drop' | 'malformed') {
  const target=new URL(source),sockets=new Set<Socket>();
  const upstreamPort=Number(target.port),upstreamHost=target.hostname;
  const server=createServer(down=>{
    const up=connect(upstreamPort,upstreamHost);
    sockets.add(down); sockets.add(up);
    down.on('data',chunk=>up.write(chunk));
    down.on('error',()=>up.destroy()); up.on('error',()=>down.destroy());
    down.on('close',()=>{sockets.delete(down);up.destroy();});
    up.on('close',()=>{sockets.delete(up);down.destroy();});
    let buffered=Buffer.alloc(0);
    up.on('data',chunk=>{
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length>=5){
        const length=buffered.readInt32BE(1)+1;
        if(buffered.length<length)break;
        const frame=buffered.subarray(0,length); buffered=buffered.subarray(length);
        if(frame[0]===67 && frame.subarray(5).toString()==='COMMIT\0'){
          if(mode==='drop'){ down.destroy(); up.destroy(); return; }
          const corrupt=Buffer.from('BROKEN\0'),header=Buffer.alloc(5); header[0]=67;header.writeInt32BE(corrupt.length+4,1);
          down.write(Buffer.concat([header,corrupt]));
        }else down.write(frame);
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); assert.ok(address && typeof address!=='string');
  target.hostname='127.0.0.1';target.port=String(address.port);
  const pool=new Pool({connectionString:target.toString(),max:1});
  return {pool,close:async()=>{await pool.end();for(const socket of sockets)socket.destroy();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

test('PG-F1 real wire: lost or malformed COMMIT reply is unknown, retains request identity and never replays', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const adapter=new PostgresFencedEventStore(a,{lockTimeoutMs:3000,statementTimeoutMs:5000,idleTransactionTimeoutMs:5000});
    for(const mode of ['drop','malformed'] as const){
      const game=await seed(admin);
      const grant=await adapter.acquire(new FencingAcquireIntent({gameId:game,databaseIncarnation:db,
        processIncarnation:randomUUID(),expectedEpoch:'0',leaseMs:60000,requestId:`acquire-${mode}`}));
      const source=a.options.connectionString; assert.ok(source);
      const proxy=await lostCommitPool(source,mode);
      const faulty=new PostgresFencedEventStore(proxy.pool,{lockTimeoutMs:3000,statementTimeoutMs:5000,idleTransactionTimeoutMs:5000});
      try {
        await assert.rejects(faulty.append(grant,0,[ready],`original-${mode}`),error=>
          error instanceof FencedOutcomeUnknownError && error.requestId===`original-${mode}` && !('appendRejected' in error));
        assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0,1]);
        assert.equal(proxy.pool.totalCount,0,'uncertain client must be destroyed');
      }finally{await proxy.close();}
    }
  });
});

test('PG-F1 backfill preserves live epochs, late legacy streams, incarnation rotation and missing-control rejection', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    const before=(await admin.query('SELECT epoch::text,active,lease_until FROM game_fencing.grants WHERE game_id=$1',[game])).rows;
    assert.equal(await seedGameFencing(admin),0);
    assert.deepEqual((await admin.query('SELECT epoch::text,active,lease_until FROM game_fencing.grants WHERE game_id=$1',[game])).rows,before);
    const late=randomUUID(); await new PostgresEventStore(admin).append(late,-1,initialEvents(late));
    await assert.rejects(acquire(a,late,db),hasCode('PFG01'));
    assert.equal(await seedGameFencing(admin),1); assert.equal(await seedGameFencing(admin),0);
    assert.equal((await acquire(a,late,db)).epoch,'1');
    const rotated=randomUUID();
    await admin.query('UPDATE game_fencing.control SET database_incarnation=$1',[rotated]);
    await assert.rejects(append(a,grant),hasCode('PFG01'));
    assert.equal((await acquire(a,game,rotated,'1')).epoch,'2');
    await admin.query('DELETE FROM game_fencing.control');
    await assert.rejects(acquire(a,randomUUID(),rotated),hasCode('PFG01'));
    assert.equal((await admin.query('SELECT epoch::text FROM game_fencing.grants WHERE game_id=$1',[game])).rows[0]?.epoch,'2');
  });
});

test('PG-F1 batch trigger failure rolls back every inserted event and deadline side effect', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=randomUUID();
    const created=Game.create({gameId:game,at:1000,rated:false,players:{white:'a',black:'b'},
      source:'seek',noShowAfterMs:60000,
      timeControl:{kind:'sudden_death',initialMs:60000,incrementMs:0,delayMs:0}});
    await a.query('SELECT game_fencing.create_stream($1,$2,$3)',[game,db,batch(created.events)]);
    const grant=await acquire(a,game,db),ending=created.game.abort(1001).events;
    const deadline=(await admin.query('SELECT * FROM public.pregame_deadlines WHERE game_id=$1',[game])).rows;
    assert.equal(deadline.length,1);
    await admin.query(`CREATE FUNCTION public.pg_f1_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='PlayerReady' AND NEW.payload->>'by'='b' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='test batch barrier'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER pg_f1_injected_failure BEFORE INSERT ON public.game_events FOR EACH ROW EXECUTE FUNCTION public.pg_f1_injected_failure();`);
    await assert.rejects(a.query('SELECT game_fencing.append_events($1,$2,$3,$4,$5,0,$6)',
      [...args(grant),batch([...ending,{type:'PlayerReady',by:'b',at:1002}])]),hasCode('23514'));
    assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0]);
    assert.deepEqual((await admin.query('SELECT * FROM public.pregame_deadlines WHERE game_id=$1',[game])).rows,deadline);
    await admin.query('DROP TRIGGER pg_f1_injected_failure ON public.game_events; DROP FUNCTION public.pg_f1_injected_failure()');
    assert.equal(await append(a,grant,0,ending),1);
    assert.equal((await admin.query('SELECT 1 FROM public.pregame_deadlines WHERE game_id=$1',[game])).rowCount,0);
  });
});

test('PG-F1 fixed path resists temporary shadow tables and PUBLIC cannot execute a protected operation', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db),client=await a.connect();
    try{
      await client.query('CREATE TEMP TABLE game_events(LIKE public.game_events INCLUDING ALL); SET search_path=pg_temp,public');
      assert.equal(await append(client,grant),1);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_temp.game_events')).rows[0]?.n,0);
      const login=(await client.query('SELECT session_user AS name')).rows[0]!.name;
      await admin.query(`REVOKE EXECUTE ON FUNCTION game_fencing.acquire(uuid,uuid,bigint,uuid,bytea,integer) FROM ${login}`);
      await assert.rejects(acquire(client,game,db),hasCode('42501'));
      assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0,1]);
    }finally{client.release();}
  });
});

test('PG-F1 successor-first and old rollback schedules retain authoritative grant/head ordering', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db,'0',1000),client=await a.connect();
    try{
      await client.query('BEGIN');assert.equal(await append(client,grant),1);
      await admin.query('SELECT pg_sleep_until($1::timestamptz)',[grant.expiry]);
      const next=await b.connect();
      try{
        const pid=(await next.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const takeover=acquire(next,game,db,'1');await blocked(admin,pid);
        await client.query('ROLLBACK');const successor=await takeover;
        assert.equal(successor.epoch,'2');
        await assert.rejects(append(a,grant),hasCode('PFG01'));
        assert.equal(await append(next,successor),1);
        assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0,1]);
      }finally{next.release();}
    }finally{await client.query('ROLLBACK');client.release();}
  });
});

test('PG-F1 upgrade from 0049 preserves every old checksum and populated event/projection row', { skip }, async()=>{
  const scratch=join(tmpdir(),'opencode');
  await mkdir(scratch,{recursive:true});
  const earlier=await mkdtemp(join(scratch,'pg-f1-earlier-'));
  try{
    const dir=migrationsDir();
    for(const name of await readdir(dir))if(/^\d{4}_.*\.sql$/.test(name) && name<'0050')await copyFile(join(dir,name),join(earlier,name));
    await withTestDatabase(async({pool})=>{
      await migrate(pool,earlier);
      const game=await seedLegacy(pool),white=randomUUID(),black=randomUUID();
      await pool.query('INSERT INTO public.users(id,handle) VALUES($1,$2),($3,$4)',[white,`w_${white}`,black,`b_${black}`]);
      await pool.query(`INSERT INTO public.games(id,variant,rated,speed,white_id,black_id,started_at)
        VALUES($1,'standard',false,'bullet',$2,$3,to_timestamp(1))`,[game,white,black]);
      const events=(await pool.query('SELECT * FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows;
      const projections=(await pool.query('SELECT * FROM public.games WHERE id=$1',[game])).rows;
      const checksums=(await pool.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version')).rows;
      assert.equal(await migrate(pool,dir),1);
      assert.deepEqual((await pool.query('SELECT * FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows,events);
      assert.deepEqual((await pool.query('SELECT * FROM public.games WHERE id=$1',[game])).rows,projections);
      assert.deepEqual((await pool.query('SELECT version,checksum FROM public.schema_migrations WHERE version<50 ORDER BY version')).rows,checksums);
      assert.deepEqual((await pool.query('SELECT epoch::text,active FROM game_fencing.grants WHERE game_id=$1',[game])).rows,[{epoch:'0',active:false}]);
      assert.equal(await migrate(pool,dir),0);
      assert.equal(await new PostgresEventStore(pool).append(game,0,[ready]),1,'inactive legacy append still works');
    },{connectionString,max:4});
  }finally{await rm(earlier,{recursive:true,force:true});}
});

async function seedLegacy(pool: Pool): Promise<string> {
  const game=randomUUID();await new PostgresEventStore(pool).append(game,-1,initialEvents(game));return game;
}

test('PG-F1 rejects a SECURITY DEFINER accidentally owned by the private table owner', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    const owner=(await admin.query("SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='game_fencing.grants'::regclass")).rows[0]!.name;
    const executor=(await admin.query("SELECT pg_get_userbyid(proowner) AS name FROM pg_proc WHERE oid='game_fencing.append_events(uuid,uuid,bigint,uuid,bytea,integer,jsonb)'::regprocedure")).rows[0]!.name;
    await admin.query(`ALTER FUNCTION game_fencing.lock_control(uuid) OWNER TO ${owner}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION game_fencing.lock_control(uuid) TO ${executor}`);
    await assert.rejects(append(a,grant),hasCode('PFG01'));
  });
});

test('PG-F1 preparation rejects private runtime/default-ACL read access without silently activating it', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const owners=(await admin.query(`SELECT pg_get_userbyid(c.relowner) AS tables,pg_get_userbyid(p.proowner) AS functions
      FROM pg_class c,pg_proc p WHERE c.oid='game_fencing.grants'::regclass
      AND p.oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure`)).rows[0]!;
    const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
    await admin.query(`GRANT SELECT ON game_fencing.grants TO ${login}`);
    await assert.rejects(prepareGameFencing(admin,{tableOwner:owners.tables,functionOwner:owners.functions,
      databaseIncarnation:randomUUID(),maxLeaseMs:60000}),/unsafe private fencing privileges/);
    assert.equal((await admin.query('SELECT database_incarnation::text AS id FROM game_fencing.control')).rows[0]?.id,db);
  });
});

for (const table of ['grants','control']) for (const privilege of ['TRIGGER','REFERENCES']) {
  test(`PG-F1 preparation refuses restricted ${privilege} on private ${table}`, { skip },async()=>{
    await restrictedDatabase(async(admin,a,_b,db)=>{
      const owners=(await admin.query(`SELECT pg_get_userbyid(c.relowner) AS tables,pg_get_userbyid(p.proowner) AS functions
        FROM pg_class c,pg_proc p WHERE c.oid='game_fencing.grants'::regclass
        AND p.oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure`)).rows[0]!;
      const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
      await admin.query(`GRANT ${privilege} ON game_fencing.${table} TO ${login}`);
      if(privilege==='TRIGGER') {
        // No private SELECT/UPDATE or public CREATE needed: an executable legacy
        // trigger function suffices to interfere with SECURITY DEFINER writes.
        await a.query(`CREATE TRIGGER pg_f1_block_private BEFORE UPDATE ON game_fencing.${table}
          FOR EACH ROW EXECUTE FUNCTION public.game_events_no_mutate()`);
        const sql=table==='control'?'UPDATE game_fencing.control SET singleton=singleton':
          'UPDATE game_fencing.grants SET epoch=epoch WHERE game_id=$1';
        const values=table==='control'?[]:[await seed(admin)];
        await assert.rejects(admin.query(sql,values),hasCode('P0001'));
        await admin.query(`DROP TRIGGER pg_f1_block_private ON game_fencing.${table}`);
      }
      await assert.rejects(prepareGameFencing(admin,{tableOwner:owners.tables,functionOwner:owners.functions,
        databaseIncarnation:randomUUID(),maxLeaseMs:30000}),/unsafe private fencing privileges/);
      assert.deepEqual((await admin.query('SELECT database_incarnation::text AS id,max_lease_ms FROM game_fencing.control')).rows,
        [{id:db,max_lease_ms:60000}]);
      assert.equal((await a.query('SELECT has_function_privilege(session_user,$1,\'EXECUTE\') AS allowed',
        ['game_fencing.create_stream(uuid,uuid,jsonb)'])).rows[0]?.allowed,true,'refused preparation makes no partial ACL changes');
    });
  });
}

test('PG-F1 append uses the original serialized batch length when a caller mutates its waiting array', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    const single=new Pool({connectionString:a.options.connectionString,max:1});
    const adapter=new PostgresFencedEventStore(single,{lockTimeoutMs:5000,statementTimeoutMs:10000,idleTransactionTimeoutMs:10000});
    const pid=(await single.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const holder=await admin.connect();
    try {
      await holder.query('BEGIN');await holder.query('SELECT game_id FROM game_fencing.grants WHERE game_id=$1 FOR UPDATE',[game]);
      const events: GameEvent[]=[ready];
      const writing=adapter.append(new FencingGrant({gameId:game,databaseIncarnation:db,epoch:grant.epoch,
        processIncarnation:grant.process,leaseUntil:grant.expiry},grant.capability),0,events,'original-array');
      await blocked(admin,pid);events.length=0;
      await holder.query('ROLLBACK');
      assert.equal(await writing,1);
      assert.deepEqual((await admin.query('SELECT seq,payload FROM public.game_events WHERE game_id=$1 AND seq>0',[game])).rows,
        [{seq:1,payload:ready}]);
    }finally{await holder.query('ROLLBACK');holder.release();await single.end();}
  });
});

test('PG-F1 caller-client creation snapshots events before waiting on the control lock', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=randomUUID(),events=initialEvents(game),original=structuredClone(events[0]);
    const adapter=new PostgresFencedEventStore(a,{lockTimeoutMs:5000,statementTimeoutMs:10000,idleTransactionTimeoutMs:10000});
    const holder=await admin.connect(),client=await a.connect();
    try {
      await holder.query('BEGIN');await holder.query('SELECT singleton FROM game_fencing.control FOR UPDATE');
      await client.query('BEGIN');
      const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const writing=adapter.createOnClient(client,{gameId:game,databaseIncarnation:db,events,requestId:'original-creation'});
      await blocked(admin,pid);events.length=0;
      await holder.query('ROLLBACK');
      assert.equal(await writing,0);await commitFencedTransaction(client,'original-creation');
      assert.deepEqual((await admin.query('SELECT seq,payload FROM public.game_events WHERE game_id=$1',[game])).rows,
        [{seq:0,payload:original}]);
    }finally{await holder.query('ROLLBACK');await client.query('ROLLBACK');holder.release();client.release();}
  });
});

test('PG-F1 caller-client creation retains typed pre-write logging and player-lock refusals', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=randomUUID(),events=initialEvents(game);
    const adapter=new PostgresFencedEventStore(a,{lockTimeoutMs:5000,statementTimeoutMs:10000,idleTransactionTimeoutMs:10000});
    const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
    await admin.query(`ALTER ROLE ${login} SET log_parameter_max_length=-1`);
    const unsafe=new Pool({connectionString:a.options.connectionString,max:1}),client=await unsafe.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(adapter.createOnClient(client,{gameId:game,databaseIncarnation:db,events,requestId:'logging-rejection'}),
        error=>error instanceof FenceRejectedError && error.requestId==='logging-rejection');
      await client.query('ROLLBACK');
    }finally{client.release();await unsafe.end();await admin.query(`ALTER ROLE ${login} SET log_parameter_max_length=0`);}
    const holder=await admin.connect(),writer=await a.connect();
    try {
      await holder.query('BEGIN');await lockGameCreationPlayers(holder,events);
      await writer.query('BEGIN');
      await assert.rejects(adapter.createOnClient(writer,{gameId:game,databaseIncarnation:db,events,requestId:'player-refusal'}),PlayerLockBusyError);
      await writer.query('ROLLBACK');await holder.query('ROLLBACK');
      assert.equal((await admin.query('SELECT 1 FROM public.game_events WHERE game_id=$1',[game])).rowCount,0);
      await writer.query('BEGIN');
      assert.equal(await adapter.createOnClient(writer,{gameId:game,databaseIncarnation:db,events,requestId:'fresh-creation'}),0);
      await commitFencedTransaction(writer,'fresh-creation');
    }finally{await holder.query('ROLLBACK');await writer.query('ROLLBACK');holder.release();writer.release();}
  });
});

test('PG-F1 preparation refuses untrusted private CREATE and unexpected function adoption', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const owners=(await admin.query(`SELECT pg_get_userbyid(c.relowner) AS tables,pg_get_userbyid(p.proowner) AS functions
      FROM pg_class c,pg_proc p WHERE c.oid='game_fencing.grants'::regclass
      AND p.oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure`)).rows[0]!;
    const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
    await admin.query(`GRANT CREATE ON SCHEMA game_fencing TO ${login}`);
    const config={tableOwner:owners.tables,functionOwner:owners.functions,databaseIncarnation:randomUUID(),maxLeaseMs:30000};
    await assert.rejects(prepareGameFencing(admin,config),/unsafe private fencing privileges/);
    await a.query('CREATE FUNCTION game_fencing.unexpected() RETURNS integer LANGUAGE sql AS $$SELECT 1$$');
    await admin.query(`REVOKE CREATE ON SCHEMA game_fencing FROM ${login}`);
    await assert.rejects(prepareGameFencing(admin,config),/unexpected fencing function signature/);
    assert.equal((await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='game_fencing.unexpected()'::regprocedure")).rows[0]?.owner,login);
    assert.deepEqual((await admin.query('SELECT database_incarnation::text AS id,max_lease_ms FROM game_fencing.control')).rows,
      [{id:db,max_lease_ms:60000}]);
  });
});

test('PG-F1 preparation canonicalizes signatures without changing the installer session search path', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b)=>{
    const owners=(await admin.query(`SELECT pg_get_userbyid(c.relowner) AS tables,pg_get_userbyid(p.proowner) AS functions
      FROM pg_class c,pg_proc p WHERE c.oid='game_fencing.grants'::regclass
      AND p.oid='game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure`)).rows[0]!;
    const installer=new Pool({connectionString:admin.options.connectionString,max:1,
      options:'-c search_path=game_fencing,pg_catalog,public,pg_temp'});
    try {
      const path=(await installer.query('SHOW search_path')).rows[0]?.search_path;
      assert.equal((await installer.query("SELECT 'game_fencing.create_stream(uuid,uuid,jsonb)'::regprocedure::text AS signature")).rows[0]?.signature,
        'create_stream(uuid,uuid,jsonb)','the valid caller path renders an unqualified signature');
      const db=randomUUID();
      await prepareGameFencing(installer,{tableOwner:owners.tables,functionOwner:owners.functions,
        databaseIncarnation:db,maxLeaseMs:30000});
      assert.equal((await installer.query('SHOW search_path')).rows[0]?.search_path,path,'transaction-local path does not leak into pool reuse');
      await admin.query('CREATE FUNCTION game_fencing.unexpected_path_test() RETURNS integer LANGUAGE sql AS $$SELECT 1$$');
      await assert.rejects(prepareGameFencing(installer,{tableOwner:owners.tables,functionOwner:owners.functions,
        databaseIncarnation:randomUUID(),maxLeaseMs:60000}),/unexpected fencing function signature/);
      assert.equal((await installer.query('SHOW search_path')).rows[0]?.search_path,path,'rollback restores the caller path too');
      assert.deepEqual((await admin.query('SELECT database_incarnation::text AS id,max_lease_ms FROM game_fencing.control')).rows,
        [{id:db,max_lease_ms:30000}]);
      const deniedGame=randomUUID();
      await assert.rejects(a.query('SELECT game_fencing.create_stream($1,$2,$3)',[deniedGame,db,JSON.stringify(initialEvents(deniedGame))]),hasCode('42501'));
    }finally{await installer.end();}
  });
});

test('PG-F1 caller-client creation keeps seek, player locks, events and projection in one rollback/commit', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const login=(await a.query('SELECT session_user AS name')).rows[0]!.name;
    await admin.query(`CREATE TABLE public.pg_f1_seek_fixture (id uuid PRIMARY KEY, claimed boolean NOT NULL DEFAULT false);
      CREATE TABLE public.pg_f1_projection_fixture (game_id uuid PRIMARY KEY, marker text NOT NULL);
      GRANT SELECT,INSERT,UPDATE ON public.pg_f1_seek_fixture,public.pg_f1_projection_fixture TO ${login}`);
    const seek=randomUUID(),game=randomUUID();
    await admin.query('INSERT INTO public.pg_f1_seek_fixture(id) VALUES($1)',[seek]);
    const adapter=new PostgresFencedEventStore(a,{lockTimeoutMs:3000,statementTimeoutMs:5000,idleTransactionTimeoutMs:5000});
    const client=await a.connect();
    try {
      for(const commit of [false,true]){
        await client.query('BEGIN');
        await client.query('UPDATE public.pg_f1_seek_fixture SET claimed=true WHERE id=$1',[seek]);
        assert.equal(await adapter.createOnClient(client,{gameId:game,databaseIncarnation:db,
          events:initialEvents(game),requestId:`creation-${commit}`}),0);
        await client.query('INSERT INTO public.pg_f1_projection_fixture(game_id,marker) VALUES($1,$2)',[game,'complete']);
        const locks=await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
          WHERE pid=$1 AND locktype='advisory' AND granted`,[(await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid]);
        assert.equal(locks.rows[0]?.n,2,'both ordered human player locks retained through transaction');
        assert.equal((await admin.query('SELECT claimed FROM public.pg_f1_seek_fixture WHERE id=$1',[seek])).rows[0]?.claimed,false);
        assert.equal((await admin.query('SELECT 1 FROM public.game_events WHERE game_id=$1',[game])).rowCount,0);
        if(commit) await commitFencedTransaction(client,'creation-true');else await client.query('ROLLBACK');
        assert.equal((await admin.query('SELECT claimed FROM public.pg_f1_seek_fixture WHERE id=$1',[seek])).rows[0]?.claimed,commit);
        for(const table of ['public.game_events','game_fencing.grants','public.pg_f1_projection_fixture'])
          assert.equal((await admin.query(`SELECT 1 FROM ${table} WHERE game_id=$1`,[game])).rowCount,commit?1:0);
      }
    }finally{await client.query('ROLLBACK');client.release();}
  });
});

test('PG-F1 rotation waits for the protected transaction; repeatable-read and expired retries fail closed', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db,'0',1000),client=await a.connect(),rotator=await admin.connect();
    const rotated=randomUUID();
    try {
      await client.query('BEGIN');assert.equal(await append(client,grant),1);
      const pid=(await rotator.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const rotation=rotator.query('UPDATE game_fencing.control SET database_incarnation=$1',[rotated]);
      await blocked(admin,pid);
      assert.equal((await admin.query('SELECT database_incarnation::text AS id FROM game_fencing.control')).rows[0]?.id,db);
      await client.query('COMMIT');await rotation;
      await assert.rejects(append(a,grant,1),hasCode('PFG01'));
      const next=await acquire(a,game,rotated,'1',1000);
      await admin.query('SELECT pg_sleep_until($1::timestamptz)',[next.expiry]);
      await assert.rejects(a.query('SELECT * FROM game_fencing.acquire($1,$2,1,$3,$4,1000)',
        [game,rotated,next.process,next.capability]),hasCode('PFG01'));
      await assert.rejects(a.query('SELECT game_fencing.renew($1,$2,$3,$4,$5,1000)',args(next)),hasCode('PFG01'));
      await assert.rejects(a.query('SELECT game_fencing.release($1,$2,$3,$4,$5)',args(next)),hasCode('PFG01'));
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(append(client,next,1),hasCode('PFV01'));await client.query('ROLLBACK');
      assert.equal((await acquire(a,game,rotated,'2')).epoch,'3');
    }finally{await client.query('ROLLBACK');client.release();rotator.release();}
  });
});

test('PG-F1 restricted adapter lock timeout is known noncommit and returns a clean one-client pool', { skip }, async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const source=a.options.connectionString;assert.ok(source);
    const single=new Pool({connectionString:source,max:1,connectionTimeoutMillis:3000});
    const adapter=new PostgresFencedEventStore(single,{lockTimeoutMs:150,statementTimeoutMs:1000,idleTransactionTimeoutMs:2000});
    const game=await seed(admin),grant=await adapter.acquire(new FencingAcquireIntent({gameId:game,databaseIncarnation:db,
      processIncarnation:randomUUID(),expectedEpoch:'0',leaseMs:60000,requestId:'single-acquire'}));
    const holder=await admin.connect();
    try{
      await holder.query('BEGIN');await holder.query('SELECT game_id FROM game_fencing.grants WHERE game_id=$1 FOR UPDATE',[game]);
      await assert.rejects(adapter.append(grant,0,[ready],'lock-timeout-original'),error=>
        error instanceof FenceRejectedError && error.requestId==='lock-timeout-original');
      await holder.query('ROLLBACK');
      assert.equal(single.totalCount,1);assert.equal(single.idleCount,1);
      assert.equal((await single.query("SELECT current_setting('lock_timeout') AS timeout,current_setting('statement_timeout') AS statement")).rows[0]?.timeout,'0');
      assert.equal(await adapter.append(grant,0,[ready],'single-after-rejection'),1);
      assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0,1]);
    }finally{await holder.query('ROLLBACK');holder.release();await single.end();}
  });
});

test('PG-F1 malformed control/grant/batch inputs and trusted gapped legacy streams never append', { skip },async()=>{
  await restrictedDatabase(async(admin,a,_b,db)=>{
    const game=await seed(admin),grant=await acquire(a,game,db);
    for(const cap of [null,randomBytes(31),randomBytes(33)])await assert.rejects(
      a.query('SELECT game_fencing.append_events($1,$2,$3,$4,$5,0,$6)',
        [game,db,grant.epoch,grant.process,cap,batch([ready])]),hasCode('PFG01'));
    for(const value of [null,{},[],[{type:'GameCreated',version:1,payload:initialEvents(game)[0]}]])
      await assert.rejects(a.query('SELECT game_fencing.append_events($1,$2,$3,$4,$5,0,$6)',
        [...args(grant),value===null?null:JSON.stringify(value)]),hasCode('PFV01'));
    await assert.rejects(acquire(a,game,db,'9223372036854775808'),hasCode('22003'));
    await assert.rejects(admin.query('UPDATE game_fencing.grants SET epoch=-1 WHERE game_id=$1',[game]),hasCode('23514'));
    await assert.rejects(admin.query("UPDATE game_fencing.grants SET lease_until='infinity' WHERE game_id=$1",[game]),hasCode('23514'));
    await assert.rejects(admin.query('UPDATE game_fencing.control SET max_lease_ms=0'),hasCode('23514'));
    await admin.query(`INSERT INTO public.game_events(game_id,seq,type,event_version,payload) VALUES($1,2,'PlayerReady',1,$2)`,[game,JSON.stringify(ready)]);
    await assert.rejects(append(a,grant,2),hasCode('PFV01'));
    assert.deepEqual((await admin.query('SELECT seq FROM public.game_events WHERE game_id=$1 ORDER BY seq',[game])).rows.map(row=>row.seq),[0,2]);
    await admin.query('UPDATE game_fencing.control SET database_incarnation=NULL,max_lease_ms=NULL');
    await assert.rejects(append(a,grant,2),hasCode('PFG01'));
  });
});
