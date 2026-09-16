/**
 * BotPlayer unit tests.
 *
 * Asserts that interleaved games do not perturb each other's move sequence,
 * and that different game IDs draw different sequences.
 */
import { describe, it } from 'node:test';
import { notStrictEqual, deepStrictEqual } from 'node:assert/strict';
import { BotPlayer } from '../src/bot.js';
import { ENGINE_BOT_USER_IDS } from '@chess-platform/game';
import type {
  GameAuthority,
  PubSub,
  Unsubscribe,
  StateView,
  Broadcast,
  Command,
  ApplyResult,
} from '@chess-platform/realtime-gateway';

class StubAuthority {
  public states = new Map<string, StateView>();
  public moveLog: Array<{ gameId: string; userId: string; uci: string }> = [];

  getState(gameId: string): StateView {
    const state = this.states.get(gameId);
    if (!state) throw new Error(`Game ${gameId} not found`);
    return state;
  }

  async apply(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    if (cmd.kind === 'move') {
      this.moveLog.push({ gameId, userId, uci: cmd.uci });
    }
    return { events: [], broadcasts: [], state: this.getState(gameId) };
  }
}

class StubPubSub implements PubSub {
  public handlers = new Map<string, (msg: Broadcast) => void>();

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    this.handlers.set(channel, handler);
    return () => {
      this.handlers.delete(channel);
    };
  }

  publish(channel: string, msg: Broadcast): void {
    const handler = this.handlers.get(channel);
    if (handler) handler(msg);
  }
}

function makeCannedState(gameId: string, ply: number): StateView {
  return {
    gameId,
    variant: 'standard',
    players: {
      white: ENGINE_BOT_USER_IDS.novice,
      black: 'human-1',
    },
    timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenHash: 'abc12345',
    ply,
    turn: 'w',
    clock: { w: 300000, b: 300000 },
    turnStartedAt: null,
    status: { over: false },
    drawOffer: null,
    moves: [],
    legalMoves: {
      e2: ['e4', 'e3'],
      d2: ['d4', 'd3'],
      g1: ['f3', 'h3'],
      b1: ['c3', 'a3'],
    },
    chess960StartId: null,
  };
}

function makeMoveBroadcast(gameId: string, ply: number): Broadcast {
  return {
    t: 'move',
    gameId,
    ply,
    uci: 'e2e4',
    san: 'e4',
    by: 'w',
    fenHash: 'abc12345',
    clock: { w: 300000, b: 300000 },
    serverTs: Date.now(),
    legalMoves: {},
  };
}

describe('BotPlayer RNG determinism', () => {
  it("interleaved games do not perturb each other's move sequence", async () => {
    // Solo run for Game A
    const authoritySolo = new StubAuthority();
    const pubsubSolo = new StubPubSub();
    const botSolo = new BotPlayer(
      authoritySolo as unknown as GameAuthority,
      pubsubSolo,
    );
    botSolo.start();

    authoritySolo.states.set('game-A', makeCannedState('game-A', 0));
    botSolo.registerGame('game-A', botSolo.userId, 'human-1');

    for (let ply = 1; ply <= 10; ply++) {
      authoritySolo.states.set('game-A', makeCannedState('game-A', ply * 2));
      pubsubSolo.publish('game:game-A', makeMoveBroadcast('game-A', ply * 2 - 1));
    }
    const movesASolo = authoritySolo.moveLog.map((m) => m.uci);

    // Interleaved run for Game A and Game B
    const authorityInterleaved = new StubAuthority();
    const pubsubInterleaved = new StubPubSub();
    const botInterleaved = new BotPlayer(
      authorityInterleaved as unknown as GameAuthority,
      pubsubInterleaved,
    );
    botInterleaved.start();

    authorityInterleaved.states.set('game-A', makeCannedState('game-A', 0));
    authorityInterleaved.states.set('game-B', makeCannedState('game-B', 0));

    botInterleaved.registerGame('game-A', botInterleaved.userId, 'human-1');
    botInterleaved.registerGame('game-B', botInterleaved.userId, 'human-2');

    for (let ply = 1; ply <= 10; ply++) {
      // Interleave turn calls between A and B
      authorityInterleaved.states.set('game-A', makeCannedState('game-A', ply * 2));
      pubsubInterleaved.publish('game:game-A', makeMoveBroadcast('game-A', ply * 2 - 1));

      authorityInterleaved.states.set('game-B', makeCannedState('game-B', ply * 2));
      pubsubInterleaved.publish('game:game-B', makeMoveBroadcast('game-B', ply * 2 - 1));
    }

    const movesAInterleaved = authorityInterleaved.moveLog
      .filter((m) => m.gameId === 'game-A')
      .map((m) => m.uci);

    deepStrictEqual(movesAInterleaved, movesASolo);
  });

  it('different game ids draw different sequences', async () => {
    const authority = new StubAuthority();
    const pubsub = new StubPubSub();
    const bot = new BotPlayer(
      authority as unknown as GameAuthority,
      pubsub,
    );
    bot.start();

    authority.states.set('game-X', makeCannedState('game-X', 0));
    bot.registerGame('game-X', bot.userId, 'human-1');

    for (let ply = 1; ply <= 10; ply++) {
      authority.states.set('game-X', makeCannedState('game-X', ply * 2));
      pubsub.publish('game:game-X', makeMoveBroadcast('game-X', ply * 2 - 1));
    }

    authority.states.set('game-Y', makeCannedState('game-Y', 0));
    bot.registerGame('game-Y', bot.userId, 'human-2');

    for (let ply = 1; ply <= 10; ply++) {
      authority.states.set('game-Y', makeCannedState('game-Y', ply * 2));
      pubsub.publish('game:game-Y', makeMoveBroadcast('game-Y', ply * 2 - 1));
    }

    const movesX = authority.moveLog.filter((m) => m.gameId === 'game-X').map((m) => m.uci);
    const movesY = authority.moveLog.filter((m) => m.gameId === 'game-Y').map((m) => m.uci);

    notStrictEqual(movesX.join(','), movesY.join(','));
  });
});
