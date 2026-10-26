import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { ManualScheduler } from './support/fake-socket.js';
import type { WebSocketFactory, WebSocketConnection } from '../src/ports/ws.js';
import {
  GameAuthority,
  InMemoryPubSub,
  InMemoryEventLog,
  RealtimeGateway,
  encode,
  decode,
  type Connection,
  type ServerMessage,
  type ClientMessage,
  type CommandRouter,
} from '@chess-platform/realtime-gateway';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let nextConnId = 1;

interface Bridge {
  readonly factory: WebSocketFactory;
  readonly sentToServer: ClientMessage[];
  setOutboundFilter(filter: ((msg: ServerMessage) => boolean) | null): void;
  setHoldResume(hold: boolean): void;
  releaseResume(): void;
  deliverToClient(msg: ServerMessage): void;
  closeAll(): void;
}

function createGatewayBridge(gateway: RealtimeGateway): Bridge {
  const sentToServer: ClientMessage[] = [];
  const connections: Connection[] = [];
  let outboundFilter: ((msg: ServerMessage) => boolean) | null = null;
  let holdResume = false;
  let heldResumeDelivery: (() => void) | null = null;
  let lastClientHandlers: { onMessage(data: string): void } | null = null;

  const factory: WebSocketFactory = (_url, handlers) => {
    lastClientHandlers = handlers;
    let serverOnMessage: ((msg: ClientMessage) => void) | null = null;
    let serverOnClose: (() => void) | null = null;

    const serverConn: Connection = {
      id: `conn-${nextConnId++}`,
      send(msg: ServerMessage) {
        if (outboundFilter && !outboundFilter(msg)) {
          return;
        }
        handlers.onMessage(encode(msg));
      },
      onMessage(handler) {
        serverOnMessage = handler;
      },
      onClose(handler) {
        serverOnClose = handler;
      },
      close() {
        const onClose = serverOnClose;
        serverOnClose = null;
        onClose?.();
        handlers.onClose({ code: 1000, reason: 'normal', wasClean: true });
      },
    };

    connections.push(serverConn);
    gateway.handleConnection(serverConn);

    const clientConn: WebSocketConnection = {
      send(data: string) {
        const msg = decode(data);
        if (!msg) return;
        sentToServer.push(msg);
        if (msg.t === 'resume' && holdResume) {
          heldResumeDelivery = () => {
            queueMicrotask(() => {
              serverOnMessage?.(msg);
            });
          };
          return;
        }
        queueMicrotask(() => {
          serverOnMessage?.(msg);
        });
      },
      close() {
        const onClose = serverOnClose;
        serverOnClose = null;
        onClose?.();
      },
    };

    setImmediate(() => {
      handlers.onOpen();
    });

    return clientConn;
  };

  return {
    factory,
    sentToServer,
    setOutboundFilter(filter) {
      outboundFilter = filter;
    },
    setHoldResume(hold) {
      holdResume = hold;
    },
    releaseResume() {
      const deliver = heldResumeDelivery;
      heldResumeDelivery = null;
      deliver?.();
    },
    deliverToClient(msg: ServerMessage) {
      lastClientHandlers?.onMessage(encode(msg));
    },
    closeAll() {
      while (connections.length > 0) {
        const c = connections.pop();
        c?.close();
      }
    },
  };
}

function createClientSync(factory: WebSocketFactory, token?: string) {
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g1', ...(token ? { token } : {}), scheduler });
  return { client, sync, scheduler };
}

test('healthy ordered offer/decline and nextmove fanout projection with retained duplicates and transport delay replay', async (t) => {
  const pubsub = new InMemoryPubSub();
  const eventLog = new InMemoryEventLog();
  const now = () => 1_000;
  const tc = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };

  const ownerAuthority = new GameAuthority(pubsub, now, eventLog);
  const edge1Authority = new GameAuthority(pubsub, now, eventLog);
  const edge2Authority = new GameAuthority(pubsub, now, eventLog);
  await ownerAuthority.createGame({ gameId: 'g1', timeControl: tc, players: { white: 'u1', black: 'u2' }, rated: false });

  const verifier = {
    verify(token: string): { readonly userId: string } | null {
      if (token === 'token-u1') return { userId: 'u1' };
      if (token === 'token-u2') return { userId: 'u2' };
      return null;
    },
  };

  const commandRouter: CommandRouter = {
    route: (gameId, userId, cmd) => ownerAuthority.apply(gameId, userId, cmd),
  };

  const edge1Gateway = new RealtimeGateway(edge1Authority, pubsub, verifier, now, commandRouter);
  const edge2Gateway = new RealtimeGateway(edge2Authority, pubsub, verifier, now, commandRouter);
  const edge1Bridge = createGatewayBridge(edge1Gateway);
  const edge2Bridge = createGatewayBridge(edge2Gateway);

  let capturedDrawState: ServerMessage | null = null;
  edge2Bridge.setOutboundFilter((msg) => {
    if (msg.t === 'state' && msg.state.drawOffer === 'w') {
      capturedDrawState = msg;
    }
    return true;
  });

  const white = createClientSync(edge1Bridge.factory, 'token-u1');
  const black = createClientSync(edge2Bridge.factory, 'token-u2');
  const spectator = createClientSync(edge1Bridge.factory);
  const allClients = [white, black, spectator];

  t.after(() => {
    for (const u of unsubs) u();
    for (const c of allClients) {
      c.sync.stop();
      c.client.close();
    }
    edge1Bridge.closeAll();
    edge2Bridge.closeAll();
  });

  let recoveringObserved = false;
  const unsubs = allClients.map((c) =>
    c.sync.subscribe((state) => {
      if (state.recovering) recoveringObserved = true;
    }),
  );

  for (const c of allClients) c.sync.start();
  await waitFor(() => white.sync.getState().connected && black.sync.getState().connected && spectator.sync.getState().connected);
  assert.equal(white.sync.getState().role, 'white');
  assert.equal(black.sync.getState().role, 'black');
  assert.equal(spectator.sync.getState().role, 'spectator');

  assert.ok(white.sync.submitMove('e2e4'));
  await waitFor(() => white.sync.getState().ply === 1 && black.sync.getState().ply === 1 && spectator.sync.getState().ply === 1);

  assert.ok(black.sync.submitMove('e7e5'));
  await waitFor(() => white.sync.getState().ply === 2 && black.sync.getState().ply === 2 && spectator.sync.getState().ply === 2);

  assert.equal(white.sync.offerDraw(), true);
  await waitFor(() => white.sync.getState().drawOffer === 'w' && black.sync.getState().drawOffer === 'w' && spectator.sync.getState().drawOffer === 'w');
  assert.ok(capturedDrawState !== null);

  const committed = await ownerAuthority.readRecovery('g1', 2);
  for (const c of allClients) {
    const s = c.sync.getState();
    assert.equal(s.recovering, false);
    assert.equal(s.ply, committed.state.ply);
    assert.equal(s.turn, committed.state.turn);
    assert.equal(s.drawOffer, committed.state.drawOffer);
    assert.equal(s.fenHash, committed.state.fenHash);
    assert.equal(s.snapshot?.fen, committed.state.fen);
    assert.deepEqual(s.moves, committed.state.moves);
    assert.deepEqual(s.legalMoves, committed.state.legalMoves);
    assert.deepEqual(s.clock, committed.state.clock);
    assert.deepEqual(s.ready, committed.state.ready);
    assert.deepEqual(s.status, committed.state.status);
    assert.equal(s.turnStartedAt, committed.state.turnStartedAt);
    assert.equal(c.sync.stateRevision, committed.state.stateRevision);
  }

  assert.equal(edge1Bridge.sentToServer.filter((m) => m.t === 'resume').length, 0);
  assert.equal(edge2Bridge.sentToServer.filter((m) => m.t === 'resume').length, 0);

  assert.equal(black.sync.declineDraw(), true);
  await waitFor(() => white.sync.getState().drawOffer === null && black.sync.getState().drawOffer === null);

  assert.ok(white.sync.submitMove('g1f3'));
  await waitFor(() => white.sync.getState().ply === 3 && black.sync.getState().ply === 3);

  const latestCommitted = await ownerAuthority.readRecovery('g1', 3);
  edge2Bridge.deliverToClient({ t: 'state', gameId: 'g1', state: latestCommitted.state });
  assert.equal(black.sync.getState().moves.length, 3);
  assert.equal(black.sync.getState().recovering, false);

  edge2Bridge.deliverToClient(capturedDrawState!);
  assert.equal(black.sync.getState().drawOffer, null);
  assert.equal(black.sync.getState().ply, 3);
  assert.equal(black.sync.getState().role, 'black');
  assert.equal(black.sync.getState().recovering, false);

  assert.equal(recoveringObserved, false);
  assert.equal(edge1Bridge.sentToServer.filter((m) => m.t === 'resume').length, 0);
  assert.equal(edge2Bridge.sentToServer.filter((m) => m.t === 'resume').length, 0);
  for (const c of allClients) {
    assert.equal(c.sync.getState().recovering, false);
  }
});

test('loss test: withheld draw state triggers bounded recovery and debt settlement without command replay', async (t) => {
  const pubsub = new InMemoryPubSub();
  const eventLog = new InMemoryEventLog();
  const now = () => 1_000;
  const tc = { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' as const };

  const ownerAuthority = new GameAuthority(pubsub, now, eventLog);
  const edge1Authority = new GameAuthority(pubsub, now, eventLog);
  const edge2Authority = new GameAuthority(pubsub, now, eventLog);
  await ownerAuthority.createGame({ gameId: 'g1', timeControl: tc, players: { white: 'u1', black: 'u2' }, rated: false });

  const verifier = {
    verify(token: string): { readonly userId: string } | null {
      if (token === 'token-u1') return { userId: 'u1' };
      if (token === 'token-u2') return { userId: 'u2' };
      return null;
    },
  };

  const commandRouter: CommandRouter = {
    route: (gameId, userId, cmd) => ownerAuthority.apply(gameId, userId, cmd),
  };

  const edge1Gateway = new RealtimeGateway(edge1Authority, pubsub, verifier, now, commandRouter);
  const edge2Gateway = new RealtimeGateway(edge2Authority, pubsub, verifier, now, commandRouter);
  const edge1Bridge = createGatewayBridge(edge1Gateway);
  const edge2Bridge = createGatewayBridge(edge2Gateway);

  let withholdDrawForBlack = true;
  edge2Bridge.setOutboundFilter((msg) => {
    if (withholdDrawForBlack && msg.t === 'state' && msg.state.drawOffer === 'w') {
      return false;
    }
    return true;
  });

  const white = createClientSync(edge1Bridge.factory, 'token-u1');
  const black = createClientSync(edge2Bridge.factory, 'token-u2');

  t.after(() => {
    white.sync.stop();
    white.client.close();
    black.sync.stop();
    black.client.close();
    edge1Bridge.closeAll();
    edge2Bridge.closeAll();
  });

  white.sync.start();
  black.sync.start();
  await waitFor(() => white.sync.getState().connected && black.sync.getState().connected);

  assert.ok(white.sync.submitMove('e2e4'));
  await waitFor(() => white.sync.getState().ply === 1 && black.sync.getState().ply === 1);

  assert.ok(black.sync.submitMove('e7e5'));
  await waitFor(() => white.sync.getState().ply === 2 && black.sync.getState().ply === 2);

  edge2Bridge.setHoldResume(true);
  assert.equal(white.sync.offerDraw(), true);
  await waitFor(() => white.sync.getState().drawOffer === 'w');
  assert.equal(black.sync.getState().drawOffer, null);

  assert.ok(white.sync.submitMove('g1f3'));
  await waitFor(() => black.sync.getState().recovering);

  assert.equal(black.sync.getState().ply, 2);
  assert.equal(edge2Bridge.sentToServer.filter((m) => m.t === 'resume').length, 1);
  const commandsBefore = edge2Bridge.sentToServer.length;
  assert.equal(black.sync.offerDraw(), false);
  assert.equal(black.sync.resign(), false);
  assert.equal(black.sync.submitMove('b8c6'), null);
  assert.equal(edge2Bridge.sentToServer.length, commandsBefore);

  withholdDrawForBlack = false;
  edge2Bridge.releaseResume();

  await waitFor(() => !black.sync.getState().recovering);
  assert.equal(black.sync.getState().ply, 3);
  assert.equal(black.sync.getState().moves.length, 3);
  assert.equal(black.sync.getState().pending, null);
  assert.equal(black.sync.getState().pendingAction, null);
  assert.equal(edge2Bridge.sentToServer.filter((m) => m.t === 'resume').length, 1);
  assert.equal(edge2Bridge.sentToServer.length, commandsBefore);
});
