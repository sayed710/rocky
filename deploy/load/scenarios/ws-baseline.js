/**
 * Gambit WebSocket baseline against the two-gateway stack (M14 inc 47, ADR-0111).
 *
 * The gap this closes: `packages/realtime-gateway/test/load.test.ts` measures fanout cost
 * in-process with no sockets, `scripts/chaos-test.mjs` proves cross-node correctness with a handful
 * of sockets, and `api-baseline.js` never opens one. Nothing measured the real thing — TLS-free but
 * genuine TCP, a WebSocket upgrade, JSON frames crossing a container boundary, Redis forwarding
 * between two independent gateway processes.
 *
 * What it does: registers the two players a real game needs, creates that game through the public
 * seek API, opens a bounded gallery of sockets on BOTH gateway nodes, and plays a deterministic
 * legal line with white on node1 and black on node2 — so ownership lands on node1 with the first
 * command and every black move after it takes the cross-node forwarding path.
 *
 * Run through `node scripts/ws-load-test.mjs`, which brings the URLs and the tunables in and
 * checks the gateway metric surfaces around the run.
 *
 * **The latency metrics carry no thresholds on purpose.** `docs/SLO.md` has no end-to-end
 * WebSocket objective, and inventing one from a first single-machine run would be exactly the
 * unvalidated guess ADR-0064 and ADR-0065 spent two increments removing. What IS enforced is
 * coverage and correctness: every socket joins, every socket sees every ply of the planned line at
 * the same position, and nothing unexpected arrives.
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/experimental/websockets';
import {
  DEFAULTS,
  ACCEPT_SEEK_METRIC_NAME,
  K6_SYSTEM_TAGS,
  PLAYER_NODES,
  WS_SUMMARY_CONTAINER_PATH,
  classifyServerFrame,
  closeRoomLifetime,
  metricsOnlySummary,
  planBaseline,
  recordPosition,
} from './lib/ws-baseline-plan.mjs';

const API_URL = __ENV.API_URL || 'http://host.docker.internal:8080';
const NODE_WS_URLS = {
  node1: __ENV.NODE1_WS_URL || 'ws://host.docker.internal:4175',
  node2: __ENV.NODE2_WS_URL || 'ws://host.docker.internal:4177',
};

const SPECTATORS_PER_NODE = Number(__ENV.SPECTATORS_PER_NODE || DEFAULTS.spectatorsPerNode);
const MOVE_PLIES = Number(__ENV.MOVE_PLIES || DEFAULTS.plies);
const MOVE_INTERVAL_MS = Number(__ENV.MOVE_INTERVAL_MS || DEFAULTS.moveIntervalMs);

/** How long a socket may take to open, and to be answered after it asks to join. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long every socket in the room has to see one ply. Generous: this is not a latency gate. */
const PLY_TIMEOUT_MS = 15_000;

// Throws on a configuration the gateway's own limits would silently truncate. Init-context, so an
// impossible run fails in a second instead of producing a summary that describes something else.
const PLAN = planBaseline({
  spectatorsPerNode: SPECTATORS_PER_NODE,
  plies: MOVE_PLIES,
  moveIntervalMs: MOVE_INTERVAL_MS,
});

const EXPECTED_BROADCASTS = PLAN.sockets.length * PLAN.moves.length;

/**
 * Backstop only: the sum of the join timeout and every ply's timeout plus planned pacing. It must
 * not become a hidden latency threshold stricter than the explicit per-step correctness guards.
 */
const MAX_DURATION_SEC = Math.ceil(
  (CONNECT_TIMEOUT_MS + PLAN.moves.length * (PLY_TIMEOUT_MS + MOVE_INTERVAL_MS)) / 1000,
);

/** Sockets that reached `joined`. Counted, not sampled: a missing join is a failed run. */
const joinsObserved = new Counter('ws_joins_observed');
/** (socket, ply) deliveries seen. Exactly one per socket per ply — no gaps, no duplicates. */
const broadcastsObserved = new Counter('ws_broadcasts_observed');
/** Rejects, unexpected frames, position disagreements, premature closes, socket errors. */
const protocolErrors = new Counter('ws_protocol_errors');

/** WebSocket open: TCP connect plus the HTTP upgrade, as seen from outside the container. */
const connectDuration = new Trend('ws_connect_duration', true);
/** `join` sent to `joined` received: token verification, game hydration, room seating. */
const joinDuration = new Trend('ws_join_duration', true);
/** A player's own move, sent to authoritatively broadcast back to that same socket. */
const moveAckDuration = new Trend('ws_move_ack_duration', true);
/** Move sent to broadcast observed by another socket on the SAME node as the mover. */
const moveSameNodeDuration = new Trend('ws_move_same_node_duration', true);
/**
 * Move sent to a socket on the OTHER node. Owner commands include Redis fanout; non-owner commands
 * include command forwarding too, so this aggregate deliberately does not claim to isolate either.
 */
const moveOtherNodeDuration = new Trend('ws_move_other_node_duration', true);

export const options = {
  scenarios: {
    ws_baseline: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${MAX_DURATION_SEC}s`,
    },
  },
  systemTags: K6_SYSTEM_TAGS,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // Coverage, stated as exact counts rather than rates. A rate of 1.0 over the deliveries that
    // happened to arrive says nothing about the ones that never did; these numbers are known
    // before the run starts, so the run can be held to them.
    ws_joins_observed: [`count==${PLAN.sockets.length}`],
    ws_broadcasts_observed: [`count==${EXPECTED_BROADCASTS}`],
    ws_protocol_errors: ['count==0'],
  },
};

/** Persist metrics only: k6's built-in summary export would also serialize secret setup data. */
export function handleSummary(data) {
  return { [WS_SUMMARY_CONTAINER_PATH]: metricsOnlySummary(data) };
}

/**
 * Register the two players and open a real game between them through the public API.
 *
 * Two accounts is the minimum a real game needs, and registration is the scarce resource:
 * `/v1/auth/register` allows 5 per IP per hour (ADR-0013), so this budget is what limits how often
 * the baseline can be run from one host — see `deploy/load/README.md`.
 *
 * Tokens are returned to the VU stage and go no further. Nothing here logs a response body: the
 * registration response carries the access token, and an error path that echoed it would put a
 * live credential in the run output. The metrics-only summary receives k6's result object but
 * deliberately serializes only its metrics block.
 */
export function setup() {
  const suffix = crypto.hexEncode(crypto.randomBytes(6));
  const white = register(`wsl_w_${suffix}`);
  const black = register(`wsl_b_${suffix}`);
  return { gameId: openGame(white, black), tokens: { white: white.token, black: black.token } };
}

function register(handle) {
  const password = crypto.hexEncode(crypto.randomBytes(24));
  const res = http.post(`${API_URL}/v1/auth/register`, JSON.stringify({ handle, password, email: `${handle}@example.test` }), {
    headers: { 'content-type': 'application/json' },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `POST /v1/auth/register returned ${res.status}` +
        (res.status === 429
          ? ' — the 5-per-hour-per-IP registration limit is spent; this run needs 2 of them'
          : ''),
    );
  }
  const token = res.json('tokens.accessToken');
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('POST /v1/auth/register returned no access token');
  }
  return { token };
}

function openGame(white, black) {
  const seek = http.post(
    `${API_URL}/v1/seeks`,
    JSON.stringify({
      variant: 'standard',
      timeControl: { kind: 'increment', initialMs: 600_000, incrementMs: 5_000, delayMs: 0 },
      color: 'white',
      rated: false,
    }),
    { headers: { 'content-type': 'application/json', Authorization: `Bearer ${white.token}` } },
  );
  if (seek.status !== 201) throw new Error(`POST /v1/seeks returned ${seek.status}`);

  const seekId = seek.json('id');
  const accepted = http.post(`${API_URL}/v1/seeks/${encodeURIComponent(seekId)}/accept`, null, {
    headers: { Authorization: `Bearer ${black.token}` },
    tags: { name: ACCEPT_SEEK_METRIC_NAME },
  });
  if (accepted.status !== 200 && accepted.status !== 201) {
    throw new Error(`POST /v1/seeks/:id/accept returned ${accepted.status}`);
  }
  const gameId = accepted.json('gameId');
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new Error('POST /v1/seeks/:id/accept returned no gameId');
  }
  return gameId;
}

export default async function (data) {
  const room = {
    gameId: data.gameId,
    sockets: [],
    positions: new Map(),
    /** Set before the sockets are closed on purpose, so teardown is not read as a drop. */
    closing: false,
    /** Resolved when every socket in the room has seen the ply currently in flight. */
    ply: null,
    closed: false,
  };
  try {
    await Promise.all(PLAN.sockets.map((spec) => openAndJoin(spec, data.tokens, room)));
    await playPlannedLine(room);
  } finally {
    closeRoom(room);
  }
}

/** Open one socket, ask it to join, and resolve once the gateway has seated it. */
function openAndJoin(spec, tokens, room) {
  return new Promise((resolve, reject) => {
    const openedAt = Date.now();
    const socket = {
      spec,
      ws: new WebSocket(NODE_WS_URLS[spec.node]),
      nextPly: 1,
      joined: false,
      cancelJoin: () => {},
      joinedAt: 0,
      sentAt: 0,
    };
    room.sockets.push(socket);

    let settled = false;
    let timer;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(
      () => settle(new Error(`${spec.id} did not join within ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    );
    socket.cancelJoin = (reason) => settle(new Error(reason));

    socket.ws.onopen = () => {
      connectDuration.add(Date.now() - openedAt);
      socket.joinedAt = Date.now();
      socket.ws.send(JSON.stringify(joinFrame(room.gameId, spec.role, tokens)));
    };
    socket.ws.onmessage = (event) => onFrame(socket, room, event.data, settle);
    socket.ws.onerror = (event) => {
      fail(room, `${spec.id} socket error: ${String(event.error)}`);
      settle(new Error(`${spec.id} socket error`));
    };
    socket.ws.onclose = () => {
      if (room.closing) return;
      fail(room, `${spec.id} closed before the run finished`);
      settle(new Error(`${spec.id} closed early`));
    };
  });
}

/**
 * Spectators join without a token, which is the gateway's anonymous-spectator path (ADR-0004) and
 * the only way to seat a bounded gallery: the harness holds exactly two credentials.
 */
function joinFrame(gameId, role, tokens) {
  if (role === 'spectator') return { t: 'join', gameId };
  return { t: 'join', gameId, token: tokens[role] };
}

function onFrame(socket, room, raw, settleJoin) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    fail(room, `${socket.spec.id} received a frame that is not JSON`);
    return;
  }

  // The planned line runs out at the last ply, and closing the room broadcasts presence to whoever
  // is still in it — so frames legitimately arrive when there is no next move to expect. An empty
  // expectation is unmatchable, which is right: any MOVE frame arriving here is one too many.
  const pending = PLAN.moves[socket.nextPly - 1];
  const expected = {
    gameId: room.gameId,
    role: socket.spec.role,
    joined: socket.joined,
    nextPly: socket.nextPly,
    nextUci: pending ? pending.uci : '',
    nextBy: pending ? (pending.by === 'white' ? 'w' : 'b') : '',
  };
  const outcome = classifyServerFrame(frame, expected);
  if (outcome.kind === 'unexpected') {
    fail(room, `${socket.spec.id}: ${outcome.reason}`);
    return;
  }
  if (outcome.kind === 'presence') return;
  if (outcome.kind === 'joined') {
    socket.joined = true;
    joinDuration.add(Date.now() - socket.joinedAt);
    joinsObserved.add(1);
    settleJoin(null);
    return;
  }

  const disagreement = recordPosition(room.positions, frame.ply, frame.fenHash);
  if (disagreement) {
    fail(room, `${socket.spec.id}: ${disagreement}`);
    return;
  }
  socket.nextPly += 1;
  broadcastsObserved.add(1);
  recordMoveLatency(socket, room.ply);
  room.ply.arrive();
}

/**
 * Which of the three move trends this delivery belongs in.
 *
 * Split by the socket's relationship to the command, not by role: the same spectator is on the
 * mover's node for half the plies and across the cluster for the other half, and averaging those
 * together would hide the cost of the hop this baseline exists to measure.
 */
function recordMoveLatency(socket, ply) {
  const elapsed = Date.now() - ply.sentAt;
  if (socket.spec.role === ply.by) moveAckDuration.add(elapsed);
  else if (socket.spec.node === PLAYER_NODES[ply.by]) moveSameNodeDuration.add(elapsed);
  else moveOtherNodeDuration.add(elapsed);
}

async function playPlannedLine(room) {
  const clientSeq = { white: 0, black: 0 };
  for (let index = 0; index < PLAN.moves.length; index += 1) {
    const move = PLAN.moves[index];
    const mover = room.sockets.find((socket) => socket.spec.role === move.by);
    clientSeq[move.by] += 1;

    room.ply = plyBarrier(room.sockets.length, move.by, index + 1);
    mover.ws.send(
      JSON.stringify({ t: 'move', gameId: room.gameId, uci: move.uci, clientSeq: clientSeq[move.by] }),
    );
    await room.ply.reached;
    if (index + 1 < PLAN.moves.length) await sleep(MOVE_INTERVAL_MS);
  }
}

/** Resolves when every socket has been told about this ply; rejects if any of them never is. */
function plyBarrier(socketCount, by, ply) {
  let remaining = socketCount;
  const barrier = { sentAt: Date.now(), by, arrive: () => {}, abort: () => {}, reached: null };
  barrier.reached = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ply ${ply} reached only ${socketCount - remaining}/${socketCount} sockets`));
    }, PLY_TIMEOUT_MS);
    barrier.arrive = () => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    barrier.abort = (reason) => {
      clearTimeout(timer);
      reject(new Error(reason));
    };
  });
  return barrier;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count a failure and stop the whole test.
 *
 * `exec.test.abort` rather than a thrown error: an exception inside an iteration leaves k6's exit
 * code at 0 when the failure happened before any threshold had a sample to breach, and a load
 * harness that reports success on a broken run is worse than none.
 */
function fail(room, reason) {
  protocolErrors.add(1);
  closeRoom(room, reason);
  exec.test.abort(reason);
}

function closeRoom(room, reason = 'WebSocket baseline room closed') {
  closeRoomLifetime(room, reason);
}
