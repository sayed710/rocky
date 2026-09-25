/**
 * Browserless protocol test for the e2e harness.
 *
 * Boots the harness on ephemeral ports → registers a user over real HTTP →
 * creates a bot game via the bridge route → connects a real `ws` client →
 * plays to a terminal state (bot answering every move) → asserts the `ended`
 * broadcast and final `getState` invariants.
 *
 * This test needs no browser and runs in CI on every push via `npm test`.
 * It is the executable evidence that the harness can host a game end-to-end.
 *
 * "Done" for anything touching the harness means this test ran and passed.
 */
import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { createRng, pick } from '../src/rng.js';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createHarness, type Harness } from '../src/index.js';
import type { ServerMessage } from '@chess-platform/realtime-gateway';
import WebSocket from 'ws';

/** Find a free TCP port by listening on port 0 and closing immediately. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: NetServer = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('could not get port'));
      }
    });
    srv.on('error', reject);
  });
}

/** Make an HTTP request and return { status, body }. */
function httpReq(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const payload = body ? JSON.stringify(body) : undefined;
  if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Collect server messages from a WebSocket until a predicate returns true.
 *
 * Server frames are parsed with JSON.parse (not decode() — decode is the
 * client-message decoder and returns null for every server message type).
 * The test is the boundary that legitimately raw-parses server frames.
 */
function collectMessages(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs: number,
): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const collected: ServerMessage[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms; collected ${collected.length} messages`));
    }, timeoutMs);

    ws.on('message', (data: Buffer) => {
      let msg: ServerMessage | null = null;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return; // ignore malformed frames
      }
      if (msg) {
        collected.push(msg);
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(collected);
        }
      }
    });
  });
}

describe('e2e harness protocol test', () => {
  let harness: Harness;
  let apiPort: number;
  let wsPort: number;

  before(async () => {
    apiPort = await freePort();
    wsPort = await freePort();
    harness = await createHarness({ apiPort, wsPort });
  });

  after(async () => {
    await harness.close();
  });

  it('boots, registers a user, creates a bot game, plays to completion, and broadcasts ended', async () => {
    // 1. Register a user over real HTTP
    const handle = `test-bot-${Date.now()}`;
    const regResp = await httpReq(apiPort, 'POST', '/v1/auth/register', {
      handle,
      password: 'test-password-123',
      email: `${handle}@example.test`,
    });
    strictEqual(regResp.status, 201, `register failed: ${JSON.stringify(regResp)}`);
    const accessToken = regResp.body.tokens.accessToken;
    const userId = regResp.body.user.id;
    ok(accessToken, 'no access token in register response');
    ok(userId, 'no user id in register response');

    // 2. Create a bot game via the bridge route POST /e2e/games
    const bridgeResp = await httpReq(
      apiPort,
      'POST',
      '/e2e/games',
      // Two players choosing legal moves at random frequently fail to reach a terminal position
      // inside this test's 300-move valve, which is why it used to fail intermittently with
      // "game did not end after 301 moves". The harness already provides the lever for exactly
      // this — the bot resigns once the game reaches this ply — so termination is guaranteed by
      // construction instead of left to chance. What the test is here to prove is that the
      // protocol carries a game to `ended` and broadcasts it, not that random play finds a mate.
      { whiteId: userId, blackId: harness.bot.userId, botResignsAfterPlies: 20 },
      accessToken,
    );
    strictEqual(bridgeResp.status, 201, `bridge route failed: ${JSON.stringify(bridgeResp)}`);
    const gameId = bridgeResp.body.gameId;
    ok(gameId, 'no gameId in bridge response');

    // 3. Connect a real WebSocket client and join the game
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Send join message — use JSON.stringify for client messages (encode is for server messages)
    ws.send(JSON.stringify({ t: 'join', gameId, token: accessToken }));

    // 4. Wait for the 'joined' message
    const joinedMessages = await collectMessages(
      ws,
      (msg) => msg.t === 'joined',
      10_000,
    );
    const joined = joinedMessages.find((m) => m.t === 'joined')!;
    strictEqual(joined.t, 'joined');
    ok(joined.state, 'joined message has no state');
    ok(!joined.state.status.over, 'game should not be over at start');

    // 5. Play moves until the game ends.
    // The human (white) plays random legal moves; the bot (black) auto-responds.
    let ended = false;
    let moveCount = 0;
    const maxMoves = 300; // safety valve
    // Seeded rather than Math.random(), which removes one source of run-to-run variance. It does
    // NOT make the game identical every run: how many draws each side takes still depends on
    // message timing, and while seeded this played 109, 155 and 186 moves across three runs.
    // Guaranteed termination comes from botResignsAfterPlies above, not from this seed.
    const rng = createRng(0x1a2b3c4d);

    while (!ended && moveCount < maxMoves) {
      // Get current state from the authority (co-located)
      const state = harness.authority.getState(gameId);

      if (state.status.over) {
        ended = true;
        break;
      }

      // It's the human's turn (white) — pick a random legal move
      if (state.turn === 'w') {
        const origins = Object.keys(state.legalMoves);
        if (origins.length === 0) {
          ended = true;
          break;
        }
        const origin = pick(origins, rng);
        const dests = state.legalMoves[origin];
        const dest = pick(dests, rng);
        const uci = `${origin}${dest}`;

        ws.send(JSON.stringify({ t: 'move', gameId, uci, clientSeq: moveCount + 1 }));
        moveCount++;

        // Wait for the bot to respond (or for the game to end)
        const response = await collectMessages(
          ws,
          (msg) => msg.t === 'move' || msg.t === 'ended' || msg.t === 'reject',
          15_000,
        );
        const last = response[response.length - 1];
        if (last.t === 'ended') {
          ended = true;
        } else if (last.t === 'reject') {
          // Our move was rejected — try again with promotion suffix 'q'
          const promoUci = `${uci}q`;
          ws.send(JSON.stringify({ t: 'move', gameId, uci: promoUci, clientSeq: moveCount + 1 }));
          moveCount++;

          const retryResponse = await collectMessages(
            ws,
            (msg) => msg.t === 'move' || msg.t === 'ended' || msg.t === 'reject',
            15_000,
          );
          const retryLast = retryResponse[retryResponse.length - 1];
          if (retryLast.t === 'ended') {
            ended = true;
          }
        }
      } else {
        // It's the bot's turn — wait for the bot to move via pub/sub → gateway → ws
        const botResponse = await collectMessages(
          ws,
          (msg) => msg.t === 'move' || msg.t === 'ended',
          15_000,
        );
        const botLast = botResponse[botResponse.length - 1];
        if (botLast.t === 'ended') {
          ended = true;
        }
      }
    }

    // 6. Assert the game ended
    ok(ended, `game did not end after ${moveCount} moves`);

    // 7. Assert final state invariants via authority.getState
    const finalState = harness.authority.getState(gameId);
    ok(finalState.status.over, 'final state status.over must be true');
    strictEqual(
      Object.keys(finalState.legalMoves).length,
      0,
      'final state legalMoves must be empty {}',
    );

    ws.close();
  });

  it('bridge route POST /e2e/games returns 404 for GET', async () => {
    const resp = await httpReq(apiPort, 'GET', '/e2e/games');
    ok(resp.status === 404 || resp.status === 405, `expected 404 or 405, got ${resp.status}`);
  });

  it('search-index rejects a payload that would index nothing', async () => {
    // A fixture that indexes zero documents is a broken fixture. Answering 201 to it hides the
    // setup error behind whichever assertion fails later in the spec.
    const absent = await httpReq(apiPort, 'POST', '/e2e/search-index', {});
    strictEqual(absent.status, 400, 'a body with no entity arrays must be rejected');

    const empty = await httpReq(apiPort, 'POST', '/e2e/search-index', { players: [] });
    strictEqual(empty.status, 400, 'present-but-empty arrays index nothing and must be rejected');
  });

  it('search-index rejects a non-string optional field instead of throwing', async () => {
    // `country` and `eco` are optional but are `.trim()`-ed by the projections, so a non-string
    // reaches a TypeError and answers 500 — pointing whoever is debugging at the harness rather
    // than at their own payload.
    const badCountry = await httpReq(apiPort, 'POST', '/e2e/search-index', {
      players: [{ id: 'p-1', handle: 'someone', country: 42 }],
    });
    strictEqual(badCountry.status, 400, `expected 400 for a non-string country, got ${badCountry.status}`);

    const badEco = await httpReq(apiPort, 'POST', '/e2e/search-index', {
      games: [{
        id: 'g-1', whiteHandle: 'a', blackHandle: 'b', variant: 'standard',
        speed: 'blitz', result: '1-0', rated: true, eco: 7,
      }],
    });
    strictEqual(badEco.status, 400, `expected 400 for a non-string eco, got ${badEco.status}`);
  });

  it('search-index indexes a valid batch', async () => {
    const resp = await httpReq(apiPort, 'POST', '/e2e/search-index', {
      players: [{ id: 'p-ok', handle: 'indexable' }],
    });
    strictEqual(resp.status, 201);
    strictEqual(resp.body.indexed, 1);
  });
});
