import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { GameAuthority } from './frozen-src/packages/realtime-gateway/src/authority';
import { InMemoryEventLog } from './frozen-src/packages/realtime-gateway/src/event-log';
import { InMemoryPubSub } from './frozen-src/packages/realtime-gateway/src/pubsub';
import { RealtimeGateway } from './frozen-src/packages/realtime-gateway/src/gateway';
import { InMemoryConnection } from './frozen-src/packages/realtime-gateway/src/transport';
import { encode } from './frozen-src/packages/realtime-gateway/src/protocol';
import { GameSync } from './frozen-src/packages/web/src/net/game-sync';
import { WsClient } from './frozen-src/packages/web/src/net/ws-client';
import { decodeServer } from './frozen-src/packages/web/src/net/ws-protocol';
import { FakeSocketFactory, ManualScheduler } from './frozen-src/packages/web/test/support/fake-socket';

const TC = { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' } as const;
const params = { gameId: 'd1a-current', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: false };
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown) => appendFileSync(process.env.D1A_OBSERVATIONS!, JSON.stringify(value) + '\n');

// The prepare/oracle split prevents fixture/import/protocol failure receiving RED credit.
function register(id: string, kind: 'CONTROL' | 'CANDIDATE' | 'CHARACTERIZATION', prepare: () => Promise<any>, oracle: (o: any) => void) {
  test(`${id} ${kind}`, { concurrency: false }, async () => {
    let observation: any;
    try { observation = await prepare(); }
    catch (error) { record({ id, kind, result: 'SETUP_FAILURE', error: String(error) }); throw error; }
    try {
      oracle(observation);
      record({ id, kind, result: 'PASS', observation });
    } catch (error) {
      record({ id, kind, result: error instanceof assert.AssertionError ? (kind === 'CANDIDATE' ? 'BEHAVIORAL_RED' : 'CONTROL_FAILURE') : 'SETUP_FAILURE', observation, error: String(error) });
      throw error;
    }
  });
}

async function fixture(warm = true) {
  const backing = new InMemoryEventLog();
  const bus = new InMemoryPubSub();
  const counts = { loads: 0, exists: 0, appends: 0 };
  const edgeLog = {
    append: (...args: Parameters<InMemoryEventLog['append']>) => { counts.appends++; return backing.append(...args); },
    load: (id: string) => { counts.loads++; return backing.load(id); },
    exists: (id: string) => { counts.exists++; return backing.exists(id); },
  };
  const writer = new GameAuthority(bus, () => 1000, backing);
  const edge = new GameAuthority(bus, () => 1000, edgeLog);
  await writer.createGame(params);
  if (warm) { assert.equal(await edge.ensureLoaded(params.gameId), true); assert.equal(edge.getState(params.gameId).stateRevision, 0); }
  const gateway = new RealtimeGateway(edge, bus, { verify: () => null }, () => 1000);
  const conn = new InMemoryConnection('edge-observer'); gateway.handleConnection(conn);
  return { backing, bus, writer, edge, gateway, conn, counts };
}
async function moves(f: Awaited<ReturnType<typeof fixture>>) {
  const one = await f.writer.apply(params.gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  const two = await f.writer.apply(params.gameId, 'bob', { kind: 'move', uci: 'e7e5' });
  assert.equal(two.state.stateRevision, 2); assert.equal(two.state.ply, 2);
  return { one, two };
}
function checked(frame: any) {
  const decoded = decodeServer(encode(frame), 'revision');
  assert.ok(decoded, 'real revision codec must accept fixture');
  return decoded;
}
function join(f: Awaited<ReturnType<typeof fixture>>) {
  f.conn.deliver({ t: 'join', gameId: params.gameId });
  const message = f.conn.last('joined'); assert.ok(message, 'warm spectator join must acknowledge');
  return checked(clone(message)) as any;
}
function resume(f: Awaited<ReturnType<typeof fixture>>) {
  f.conn.deliver({ t: 'resume', gameId: params.gameId, lastPly: 0 });
  const message = f.conn.last('resumed'); assert.ok(message, 'joined warm resume must acknowledge');
  return checked(clone(message)) as any;
}
function client(initial: any, role = 'spectator') {
  const factory = new FakeSocketFactory(); const scheduler = new ManualScheduler();
  const transport = new WsClient({ url: 'wss://unused.invalid/ws', factory: factory.factory, scheduler, now: () => 1000, rng: () => 0, heartbeatMs: 0, reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' } });
  const sync = new GameSync(transport, { gameId: params.gameId, scheduler });
  const deliver = (frame: any) => { checked(frame); factory.last.emit(frame); };
  sync.start(); factory.last.open(); deliver({ t: 'joined', gameId: params.gameId, role, state: clone(initial) });
  assert.equal(sync.getState().connected, true); assert.equal(sync.getState().snapshot?.stateRevision, initial.stateRevision);
  return { factory, scheduler, transport, sync, deliver };
}

register('F01', 'CONTROL', async () => {
  const f = await fixture(); const states = [f.writer.getState(params.gameId)];
  const { one, two } = await moves(f); states.push(one.state, two.state);
  const offer = await f.writer.apply(params.gameId, 'alice', { kind: 'offerDraw' }); states.push(offer.state);
  const decline = await f.writer.apply(params.gameId, 'bob', { kind: 'declineDraw' }); states.push(decline.state);
  states.push((await f.writer.apply(params.gameId, 'bob', { kind: 'resign' })).state);
  return { revisions: states.map(s => s.stateRevision), plies: states.map(s => s.ply), seq: (await f.backing.load(params.gameId)).map(e => e.seq), drawBroadcasts: [offer.broadcasts.length, decline.broadcasts.length] };
}, o => { assert.deepEqual(o.revisions, [0,1,2,3,4,5]); assert.deepEqual(o.seq, o.revisions); assert.deepEqual(o.plies, [0,1,2,2,2,2]); assert.deepEqual(o.drawBroadcasts, [0,0]); });

register('F02', 'CONTROL', async () => {
  const bus = new InMemoryPubSub(); const store = new InMemoryEventLog(); const authority = new GameAuthority(bus, () => 1000, store);
  await authority.createGame({ ...params, initialFen: '4k2r/8/8/8/8/8/8/R3K3 w - - 99 1' });
  const result = await authority.apply(params.gameId, 'alice', { kind: 'move', uci: 'a1a2' });
  assert.deepEqual(result.events.map(e => e.type), ['MovePlayed', 'GameEnded']);
  authority.evict(params.gameId); assert.equal(await authority.ensureLoaded(params.gameId), true);
  return { revisions: result.broadcasts.map(e => e.stateRevision), moveLegal: Object.keys((result.broadcasts[0] as any).legalMoves).length, final: result.state, replay: authority.getMissedSince(params.gameId,0), original: result.broadcasts };
}, o => { assert.deepEqual(o.revisions,[1,2]); assert.ok(o.moveLegal > 0); assert.equal(o.final.stateRevision,2); assert.equal(o.final.status.over,true); assert.deepEqual(o.final.legalMoves,{}); assert.deepEqual(o.replay,o.original); });

register('F03', 'CONTROL', async () => {
  const f = await fixture(); const good = { t: 'state', gameId: params.gameId, state: clone(f.writer.getState(params.gameId)) }; checked(good);
  const bad = [-1,0.5,'0',null,2147483648].map(v => { const frame = clone(good); (frame.state as any).stateRevision=v; return decodeServer(JSON.stringify(frame),'revision'); });
  const legacy = clone(good); delete (legacy.state as any).stateRevision;
  return { bad, legacyAccepted: !!decodeServer(JSON.stringify(legacy)), revisionRejected: decodeServer(JSON.stringify(legacy),'revision') === null };
}, o => { assert.deepEqual(o.bad,[null,null,null,null,null]); assert.equal(o.legacyAccepted,true); assert.equal(o.revisionRejected,true); });

register('F04', 'CONTROL', async () => {
  const f = await fixture(); await moves(f); await f.writer.apply(params.gameId,'alice',{kind:'offerDraw'}); await f.writer.apply(params.gameId,'bob',{kind:'resign'});
  const cold = new GameAuthority(f.bus,()=>1000,f.backing); assert.equal(await cold.ensureLoaded(params.gameId),true);
  return { cold: cold.getState(params.gameId), writer: f.writer.getState(params.gameId), missed: cold.getMissedSince(params.gameId,0), expected: f.writer.getMissedSince(params.gameId,0) };
}, o => { assert.deepEqual(o.cold,o.writer); assert.equal(o.cold.status.over,true); assert.deepEqual(o.missed,o.expected); assert.deepEqual(o.missed.map((e:any)=>e.t),['move','move','ended']); });

register('S01', 'CANDIDATE', async () => {
  const f=await fixture(); const {two}=await moves(f); const loads=f.counts.loads; const message=join(f);
  return { expected: two.state, message, hot:f.edge.hasFresh(params.gameId), additionalLoads:f.counts.loads-loads };
}, o => { assert.equal(o.message.state.stateRevision,o.expected.stateRevision); assert.deepEqual(o.message.state.moves,o.expected.moves); });

register('S02', 'CANDIDATE', async () => {
  const f=await fixture(); join(f); const {two}=await moves(f); const loads=f.counts.loads; const message=resume(f);
  return {expected:two.state,message,additionalLoads:f.counts.loads-loads};
}, o => { assert.equal(o.message.state.stateRevision,o.expected.stateRevision); assert.deepEqual(o.message.state.moves,o.expected.moves); });

register('S03', 'CANDIDATE', async () => {
  const f=await fixture(); join(f); await moves(f); return {message:resume(f),expected:f.writer.getMissedSince(params.gameId,0)};
}, o => assert.deepEqual(o.message.missed,o.expected));

register('S04', 'CANDIDATE', async () => {
  const f=await fixture(); await moves(f); assert.equal(await f.edge.reloadFromLog(params.gameId),true); join(f);
  const offered=await f.writer.apply(params.gameId,'alice',{kind:'offerDraw'}); assert.equal(offered.state.drawOffer,'w');
  return {expected:offered.state,message:resume(f)};
}, o => { assert.equal(o.message.state.drawOffer,o.expected.drawOffer); assert.equal(o.message.state.stateRevision,o.expected.stateRevision); });

register('S05', 'CANDIDATE', async () => {
  const f=await fixture(); await moves(f); assert.equal(await f.edge.reloadFromLog(params.gameId),true); join(f);
  const ended=await f.writer.apply(params.gameId,'bob',{kind:'resign'}); assert.equal(ended.state.status.over,true);
  return {expected:ended.state,message:resume(f)};
}, o => { assert.equal(o.message.state.status.over,true); assert.equal(o.message.state.stateRevision,o.expected.stateRevision); });

register('C01', 'CANDIDATE', async () => {
  const f=await fixture(); const {two}=await moves(f); join(f); const stale=resume(f); const c=client(two.state); c.deliver(stale);
  const observed=clone(c.sync.getState()); c.sync.stop(); return {expected:two.state,stale,observed};
}, o => { assert.ok(o.observed.snapshot.stateRevision >= o.expected.stateRevision,'older recovery must not lower revision'); assert.equal(o.observed.ply,o.expected.ply); assert.deepEqual(o.observed.moves,o.expected.moves); });

register('C02', 'CANDIDATE', async () => {
  const f=await fixture(); const {two}=await moves(f); const offered=await f.writer.apply(params.gameId,'alice',{kind:'offerDraw'}); const c=client(offered.state);
  const stale={t:'state',gameId:params.gameId,state:clone(two.state)}; c.deliver(stale); const observed=clone(c.sync.getState()); c.sync.stop(); return {expected:offered.state,stale,observed};
}, o => { assert.equal(o.observed.drawOffer,'w','same-ply older state must not erase newer draw'); assert.equal(o.observed.snapshot.stateRevision,o.expected.stateRevision); });

register('C03', 'CANDIDATE', async () => {
  const f=await fixture(); const {two}=await moves(f); const ended=await f.writer.apply(params.gameId,'bob',{kind:'resign'}); const c=client(ended.state);
  const stale={t:'resumed',gameId:params.gameId,state:clone(two.state),missed:[]}; c.deliver(stale); const observed=clone(c.sync.getState()); c.sync.stop(); return {expected:ended.state,stale,observed};
}, o => { assert.equal(o.observed.status.over,true,'older recovery must not reopen terminal game'); assert.equal(o.observed.snapshot.stateRevision,o.expected.stateRevision); });

register('F05', 'CONTROL', async () => {
  const f=await fixture(); const {two}=await moves(f); const c=client(two.state); c.factory.last.serverClose(); assert.equal(c.sync.getState().connected,false);
  c.scheduler.runNext(); c.factory.last.open(); c.deliver({t:'joined',gameId:params.gameId,role:'white',state:clone(two.state)});
  const observed=clone(c.sync.getState()); c.sync.stop(); return {observed,expected:two.state};
}, o => { assert.equal(o.observed.connected,true); assert.equal(o.observed.role,'white'); assert.equal(o.observed.myColor,'w'); assert.deepEqual(o.observed.snapshot,o.expected); });

register('F06', 'CHARACTERIZATION', async () => {
  const f=await fixture(); const old=f.writer.getState(params.gameId); const {one}=await moves(f); const c=client(old);
  c.deliver({t:'resumed',gameId:params.gameId,state:clone(old),missed:clone(one.broadcasts)}); const observed=clone(c.sync.getState()); c.sync.stop(); return {observed,missed:one.broadcasts};
}, o => { assert.equal(o.missed.length,1); assert.equal(o.observed.ply,0); assert.equal(o.observed.snapshot.stateRevision,0); });

register('F07', 'CONTROL', async () => {
  const f=await fixture(); const old=f.writer.getState(params.gameId); const c=client(old,'white'); const pending=c.sync.submitMove('e2e4'); assert.ok(pending);
  c.deliver({t:'outcomeUnknown',gameId:params.gameId,ref:pending.clientSeq,requestId:'d1a-exact',code:'outcome_unknown',message:'Unknown.'});
  c.deliver({t:'state',gameId:params.gameId,state:clone(old)}); const equalNotice=c.sync.getState().lastReject?.t;
  const {one}=await moves(f); c.deliver({t:'state',gameId:params.gameId,state:clone(one.state)}); const newerNotice=c.sync.getState().lastReject?.t;
  c.deliver({t:'commandConfirmed',gameId:params.gameId,requestId:'unrelated'}); const unrelatedNotice=c.sync.getState().lastReject?.t;
  c.deliver({t:'commandConfirmed',gameId:params.gameId,requestId:'d1a-exact'}); const finalNotice=c.sync.getState().lastReject;
  const moveRequests=c.factory.last.sent.map(JSON.parse).filter((m:any)=>m.t==='move').length; c.sync.stop();
  return {equalNotice,newerNotice,unrelatedNotice,finalNotice,moveRequests};
}, o => { assert.equal(o.equalNotice,'outcomeUnknown'); assert.equal(o.newerNotice,'outcomeUnknown'); assert.equal(o.unrelatedNotice,'outcomeUnknown'); assert.equal(o.finalNotice,null); assert.equal(o.moveRequests,1); });
