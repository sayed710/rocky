import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameAuthority,
  InMemoryPubSub,
  InMemoryConnection,
  RealtimeGateway,
  InMemoryEventLog,
  type CommandRouter,
  type EventLog,
  type LoggedEvent,
  type ServerMessage,
} from '@chess-platform/realtime-gateway';
import type { GameEvent } from '@chess-platform/game';
import { GameSync } from '../src/net/game-sync.js';
import { WsClient } from '../src/net/ws-client.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const TC = { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };

interface LoadGate {
  entered: boolean;
  release: () => void;
  readonly releasePromise: Promise<void>;
}

class GatedLog implements EventLog {
  private activeGate: LoadGate | null = null;

  constructor(private readonly inner: EventLog) {}

  armLoadGate(): LoadGate {
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate: LoadGate = {
      entered: false,
      release: () => {
        release();
      },
      releasePromise,
    };
    this.activeGate = gate;
    return gate;
  }

  async load(id: string): Promise<readonly LoggedEvent[]> {
    const snapshot = await this.inner.load(id);
    if (this.activeGate) {
      const g = this.activeGate;
      this.activeGate = null;
      g.entered = true;
      await g.releasePromise;
    }
    return snapshot;
  }

  async exists(id: string): Promise<boolean> {
    return this.inner.exists(id);
  }

  async append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
    return this.inner.append(gameId, expectedSeq, events);
  }
}

async function awaitGate(gate: LoadGate, maxFlushes = 50): Promise<void> {
  for (let i = 0; i < maxFlushes; i++) {
    if (gate.entered) return;
    await flush();
  }
  assert.ok(gate.entered, 'load gate must be entered within bounded flushes');
}

interface HarnessOptions {
  token?: string;
  router?: (writer: GameAuthority) => CommandRouter;
  gameId?: string;
}

async function setupHarness(options: HarnessOptions = {}) {
  const gameId = options.gameId ?? 'g1';
  const innerLog = new InMemoryEventLog();
  const gatedLog = new GatedLog(innerLog);
  const pubsub = new InMemoryPubSub();
  const writer = new GameAuthority(pubsub, () => 1000, gatedLog);
  const edge = new GameAuthority(pubsub, () => 1000, gatedLog);

  const defaultRouter: CommandRouter = {
    route: (gId, uId, cmd) => writer.apply(gId, uId, cmd),
  };
  const router = options.router ? options.router(writer) : defaultRouter;

  const verifier = {
    verify: (token: string) => {
      if (token === 'tok-alice') return { userId: 'alice' };
      if (token === 'tok-bob') return { userId: 'bob' };
      return null;
    },
  };

  const gateway = new RealtimeGateway(edge, pubsub, verifier, () => 1000, router);

  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, jitter: 'none' },
  });

  const sync = new GameSync(client, {
    gameId,
    scheduler,
    ...(options.token !== undefined ? { token: options.token } : {}),
  });

  const serverConn = new InMemoryConnection('conn-1');
  gateway.handleConnection(serverConn);

  const emittedToClient: ServerMessage[] = [];
  let clientDelivered = 0;
  let serverDelivered = 0;

  const pump = async (): Promise<void> => {
    for (let round = 0; round < 20; round++) {
      let progressed = false;
      while (factory.sockets.length > 0 && clientDelivered < factory.last.sent.length) {
        const raw = factory.last.sent[clientDelivered++];
        serverConn.deliver(JSON.parse(raw!));
        progressed = true;
      }
      await flush();
      while (serverDelivered < serverConn.sent.length) {
        const frame = serverConn.sent[serverDelivered++];
        if (frame && factory.sockets.length > 0) {
          emittedToClient.push(frame);
          factory.last.emit(frame);
        }
        progressed = true;
      }
      await flush();
      if (!progressed) break;
    }
  };

  return {
    gameId,
    innerLog,
    gatedLog,
    pubsub,
    writer,
    edge,
    gateway,
    factory,
    scheduler,
    client,
    sync,
    serverConn,
    emittedToClient,
    pump,
  };
}

test('W1 warm delayed resume: stale resumed does not regress GameSync', async () => {
  const h = await setupHarness({ token: 'tok-alice' });
  await h.writer.createGame({
    gameId: h.gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  h.sync.start();
  h.factory.last.open();
  await h.pump();
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.stateRevision, 0);

  // Arm load gate: the edge's recovery read will be gated holding snapshot at N = 0
  const gate = h.gatedLog.armLoadGate();

  // Client sends resume
  h.client.send({ t: 'resume', gameId: h.gameId, lastPly: 0 });
  await h.pump(); // delivers resume to serverConn
  await awaitGate(gate);

  // Writer commits move N+1 (1)
  await h.writer.apply(h.gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Move broadcast reaches the client live
  await h.pump();
  assert.equal(h.sync.stateRevision, 1);
  assert.equal(h.sync.getState().ply, 1);

  // Release the gate; deliver the late resumed (revision 0)
  gate.release();
  await h.pump();

  // Assert server connection sent exactly one resumed frame with older revision N = 0
  const serverResumed = h.serverConn.sent.filter(
    (m): m is ServerMessage & { t: 'resumed' } => m.t === 'resumed' && m.gameId === h.gameId,
  );
  assert.equal(serverResumed.length, 1, 'server connection sent exactly one resumed frame');
  assert.equal(serverResumed[0]!.state.stateRevision, 0, 'server sent resumed frame with older revision N = 0');

  // Assert the resumed frame was forwarded to the client socket (emitted to factory.last)
  const clientResumed = h.emittedToClient.filter(
    (m): m is ServerMessage & { t: 'resumed' } => m.t === 'resumed' && m.gameId === h.gameId,
  );
  assert.equal(clientResumed.length, 1, 'resumed frame was forwarded to the client socket');
  assert.equal(clientResumed[0]!.state.stateRevision, 0, 'client received resumed frame at revision 0');

  // Only then assert GameSync stayed at N+1
  assert.equal(h.sync.stateRevision, 1);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().moves.length, 1);
  assert.equal(h.sync.getState().moves[0]!.uci, 'e2e4');
});

test('W2 cold delayed resume: cold hydration delayed resumed does not regress GameSync', async () => {
  const h = await setupHarness({ token: 'tok-alice' });
  await h.writer.createGame({
    gameId: h.gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  h.sync.start();
  h.factory.last.open();
  await h.pump();
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.stateRevision, 0);

  // Edge evicted after join so next request hydrates cold
  h.edge.evict(h.gameId);
  assert.equal(h.edge.has(h.gameId), false);

  // Arm load gate: ensureLoaded's hydration will be gated holding snapshot at N = 0
  const gate = h.gatedLog.armLoadGate();

  // Client sends resume
  h.client.send({ t: 'resume', gameId: h.gameId, lastPly: 0 });
  await h.pump(); // delivers resume to serverConn
  await awaitGate(gate);

  // gate the final (post-hydration recovery) read so the reply snapshot predates the commits
  const gate2 = h.gatedLog.armLoadGate();
  gate.release();
  await awaitGate(gate2);

  // Writer commits move N+1 (1)
  await h.writer.apply(h.gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Move broadcast reaches client live
  await h.pump();
  assert.equal(h.sync.stateRevision, 1);
  assert.equal(h.sync.getState().ply, 1);

  // Release gate; deliver late resumed (revision 0)
  gate2.release();
  await h.pump();

  // Assert server connection sent exactly one resumed frame with older revision N = 0
  const serverResumed = h.serverConn.sent.filter(
    (m): m is ServerMessage & { t: 'resumed' } => m.t === 'resumed' && m.gameId === h.gameId,
  );
  assert.equal(serverResumed.length, 1, 'server connection sent exactly one resumed frame');
  assert.equal(serverResumed[0]!.state.stateRevision, 0, 'server sent resumed frame with older revision N = 0');

  // Assert the resumed frame was forwarded to the client socket (emitted to factory.last)
  const clientResumed = h.emittedToClient.filter(
    (m): m is ServerMessage & { t: 'resumed' } => m.t === 'resumed' && m.gameId === h.gameId,
  );
  assert.equal(clientResumed.length, 1, 'resumed frame was forwarded to the client socket');
  assert.equal(clientResumed[0]!.state.stateRevision, 0, 'client received resumed frame at revision 0');

  // Only then assert GameSync stayed at N+1
  assert.equal(h.sync.stateRevision, 1);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().moves.length, 1);
  assert.equal(h.sync.getState().moves[0]!.uci, 'e2e4');
});

test('W3 join during commits: join buffered commits apply correctly once in GameSync', async () => {
  const h = await setupHarness({ token: 'tok-alice' });
  await h.writer.createGame({
    gameId: h.gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  // Client joins while the edge's read is gated
  const gate = h.gatedLog.armLoadGate();
  h.sync.start();
  h.factory.last.open();
  await h.pump();
  await awaitGate(gate);

  // gate the final (post-hydration recovery) read so the reply snapshot predates the commits
  const gate2 = h.gatedLog.armLoadGate();
  gate.release();
  await awaitGate(gate2);

  // The writer commits N+1 and N+2
  await h.writer.apply(h.gameId, 'alice', { kind: 'move', uci: 'e2e4' });
  await h.writer.apply(h.gameId, 'bob', { kind: 'move', uci: 'e7e5' });

  // Release gate
  gate2.release();
  await h.pump();

  // Assert each move frame reached the client exactly once (count move frames per ply)
  const clientMoves = h.emittedToClient.filter(
    (m): m is ServerMessage & { t: 'move' } => m.t === 'move' && m.gameId === h.gameId,
  );
  const ply1Moves = clientMoves.filter((m) => m.ply === 1);
  const ply2Moves = clientMoves.filter((m) => m.ply === 2);
  assert.equal(ply1Moves.length, 1, 'ply 1 move reached client exactly once');
  assert.equal(ply2Moves.length, 1, 'ply 2 move reached client exactly once');
  assert.equal(clientMoves.length, 2, 'exactly two move frames reached the client');

  // GameSync ends at N+2 with the correct move list, each move applied once
  assert.equal(h.sync.stateRevision, 2);
  assert.equal(h.sync.getState().ply, 2);
  assert.equal(h.sync.getState().moves.length, 2);
  assert.equal(h.sync.getState().moves[0]!.uci, 'e2e4');
  assert.equal(h.sync.getState().moves[1]!.uci, 'e7e5');
});

test('W4 late draw frame: delayed draw response resolves after newer move without regressing GameSync', async () => {
  let drawGate: LoadGate | undefined;
  const h = await setupHarness({
    token: 'tok-alice',
    router: (writer) => ({
      route: async (gameId, userId, cmd) => {
        const res = await writer.apply(gameId, userId, cmd);
        if (cmd.kind === 'offerDraw' && drawGate) {
          const g = drawGate;
          drawGate = undefined;
          g.entered = true;
          await g.releasePromise;
        }
        return res;
      },
    }),
  });

  await h.writer.createGame({
    gameId: h.gameId,
    players: { white: 'alice', black: 'bob' },
    timeControl: TC,
    rated: false,
  });

  h.sync.start();
  h.factory.last.open();
  await h.pump();
  assert.equal(h.sync.getState().connected, true);
  assert.equal(h.sync.stateRevision, 0);

  // Arm draw gate: offerDraw routed response will be held
  let releaseDraw!: () => void;
  const releasePromise = new Promise<void>((r) => {
    releaseDraw = r;
  });
  const gate: LoadGate = { entered: false, release: releaseDraw, releasePromise };
  drawGate = gate;

  // White sends offerDraw through GameSync
  const sent = h.sync.offerDraw();
  assert.equal(sent, true);
  await h.pump(); // delivers offerDraw to serverConn
  await awaitGate(gate);

  // Writer commits a newer move (N+1 = rev 2; offerDraw was rev 1)
  await h.writer.apply(h.gameId, 'alice', { kind: 'move', uci: 'e2e4' });

  // Newer move broadcast reaches client live
  await h.pump();
  assert.equal(h.sync.stateRevision, 2);
  assert.equal(h.sync.getState().ply, 1);

  // Release the held offerDraw response
  gate.release();
  await h.pump();

  // Assert explicitly which late frames reached the client
  const clientStates = h.emittedToClient.filter(
    (m): m is ServerMessage & { t: 'state' } => m.t === 'state' && m.gameId === h.gameId,
  );
  const moveRev = 2;
  const olderStates = clientStates.filter((s) => s.state.stateRevision < moveRev);
  const caseObserved =
    olderStates.length === 0
      ? 'CASE A: no state frame with revision lower than the move reached the client (server-side suppression/refresh in D1-A)'
      : 'CASE B: older state frame was delivered but GameSync ignored it';

  if (olderStates.length === 0) {
    assert.equal(
      olderStates.length,
      0,
      `W4 outcome: ${caseObserved} (received ${clientStates.length} state frame(s), all >= move revision ${moveRev})`,
    );
  } else {
    assert.equal(
      h.sync.stateRevision,
      moveRev,
      `W4 outcome: ${caseObserved} (GameSync stateRevision stayed at ${moveRev})`,
    );
    assert.equal(h.sync.getState().ply, 1);
  }

  // GameSync must end at the newer revision and must not regress
  assert.equal(h.sync.stateRevision, 2);
  assert.equal(h.sync.getState().ply, 1);
  assert.equal(h.sync.getState().moves.length, 1);
  assert.equal(h.sync.getState().moves[0]!.uci, 'e2e4');
});
