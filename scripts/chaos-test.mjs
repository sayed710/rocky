#!/usr/bin/env node
/**
 * Chaos and Failover Validation Suite (M14 Increment 11, ADR-0077).
 *
 * Verifies the multi-node game authority and command forwarding architecture specified in ADR-0010
 * against a real two-node Docker Compose stack.
 *
 * Scenarios tested:
 * 1. Cross-node correctness: two players on DIFFERENT gateway nodes play a sequence of alternating
 *    moves. Validates that non-owner command forwarding works without spurious move rejections and
 *    that both clients arrive at identical positions.
 * 2. Ungraceful owner loss: SIGKILL (`docker kill`) the owning node. Validates that once the lease
 *    TTL expires the surviving node claims ownership and play continues.
 * 3. Graceful drain: SIGTERM (`docker stop`) the owning node. Validates that the release path runs
 *    (compare-and-delete) and the successor claims ownership measurably faster than lease expiry.
 * 4. Non-owner loss: SIGKILL the node that owns NOTHING. Validates that removing a peer neither
 *    moves the owner's lease nor interrupts play on it.
 * 5. Redis loss: stop Redis. Validates the owner's fast path inside its lease window, non-owner
 *    forwarding failure, fail-closed behaviour once that window expires, and recovery.
 *
 * ## What makes a run here evidence
 *
 * Every scenario induces a failure and then asserts something about it, so the ways this suite
 * could report success without having tested anything are what it has to defend against first:
 *
 * - **The stack must be a cluster.** Two gateways each routing locally answer every health check,
 *   serve every socket, and forward nothing. `assertTopology` refuses to start without
 *   `commandRouting: redis` on both, and without two genuinely distinct endpoints.
 * - **The chaos target must actually go away.** Killing a container and then sleeping is not the
 *   same as the container being gone, so every induced outage is confirmed observable before
 *   anything is asserted about it.
 * - **Waits are derived, never guessed.** Every deadline comes from `leaseTiming()` over the same
 *   lease numbers the stack runs with, so editing `docker-compose.chaos.yml` cannot leave a sleep
 *   here silently testing something else.
 * - **"It failed as expected" has to say how.** A client deadline shorter than the gateway's own
 *   forwarding budget cannot tell a refusal from an unfinished decision, so the budget is longer
 *   than that and the outcome is classified and recorded rather than collapsed into pass/fail.
 * - **Ownership is read as a delta.** `ownedGames` is a per-node count that outlives the scenario
 *   which created it, so a raw `>= 1` on the survivor is satisfied by a game an earlier scenario
 *   left behind.
 *
 * ## What it does not prove
 *
 * One stack, one host, a handful of sockets. This is a correctness suite for the failover paths,
 * not a capacity measurement, and nothing it produces supports a claim about scale.
 */

import { execSync } from 'node:child_process';
import WebSocket from 'ws';

import { readPrometheusCounter } from './lib/prometheus-text.mjs';
import {
  CHAOS_SERVICES,
  FORWARD_TIMEOUT_MS,
  KNOWN_OPEN_DEFECTS,
  SCENARIO_PLAN,
  classifyExit,
  classifyInducedOutcome,
  inducedFailureBudgetMs,
  inducedFailureVerdict,
  leaseTiming,
  mergeOwnedCounts,
  ownershipFromCounts,
  ownershipHeldProblem,
  ownershipTakeoverProblem,
  restorationRequired,
  topologyProblems,
} from './lib/chaos-plan.mjs';
import {
  EVIDENCE_DIR,
  beginEvidence,
  buildEvidence,
  writeEvidence,
} from './lib/run-evidence.mjs';

const apiUrl = process.env['API_URL'] ?? 'http://localhost:8080';

/**
 * The two nodes, each carrying every URL a scenario needs to reach it.
 *
 * `/ready` is derived from the health endpoint rather than added as a sixth environment variable:
 * the gateway serves both from one HTTP server (`services/gateway/src/serve.ts`), so a deployment
 * where the two live at different origins does not exist.
 */
const nodes = [
  {
    index: 1,
    name: 'node1',
    service: CHAOS_SERVICES.node1,
    wsUrl: process.env['NODE1_WS_URL'] ?? 'ws://localhost:4175',
    healthUrl: process.env['NODE1_HEALTH_URL'] ?? 'http://localhost:4176/health',
    metricsUrl: process.env['NODE1_METRICS_URL'] ?? 'http://localhost:4176/metrics',
  },
  {
    index: 2,
    name: 'node2',
    service: CHAOS_SERVICES.node2,
    wsUrl: process.env['NODE2_WS_URL'] ?? 'ws://localhost:4177',
    healthUrl: process.env['NODE2_HEALTH_URL'] ?? 'http://localhost:4178/health',
    metricsUrl: process.env['NODE2_METRICS_URL'] ?? 'http://localhost:4178/metrics',
  },
].map((node) => ({ ...node, readyUrl: node.healthUrl.replace(/\/health$/, '/ready') }));

const [node1, node2] = nodes;
const nodeByIndex = (index) => (index === 1 ? node1 : node2);

const COMPOSE_CMD = 'docker compose -f docker-compose.yml -f docker-compose.chaos.yml';
const REDIS_SERVICE = CHAOS_SERVICES.redis;

/**
 * The lease numbers the chaos stack runs with, and every deadline derived from them.
 *
 * Keep these in step with `docker-compose.chaos.yml`; `deploy/load/test/chaos-plan.test.mjs` pins
 * the two files against each other, so a change to one cannot quietly leave the other testing a
 * differently configured service.
 */
const LEASE_TTL_SEC = Number(process.env['OWNERSHIP_LEASE_TTL_SEC'] ?? 6);
const RENEWAL_INTERVAL_SEC = Number(process.env['OWNERSHIP_RENEWAL_INTERVAL_SEC'] ?? 2);
const TIMING = leaseTiming({
  leaseTtlSec: LEASE_TTL_SEC,
  renewalIntervalSec: RENEWAL_INTERVAL_SEC,
});

/** How long a command issued into an induced outage gets before its silence is recorded. */
const INDUCED_BUDGET_MS = inducedFailureBudgetMs(FORWARD_TIMEOUT_MS);

const TIMEOUT_MS = 60_000;
const POLL_INTERVAL = 1_000;
/** How long an induced outage has to become observable before the suite disbelieves it. */
const OUTAGE_OBSERVATION_MS = 20_000;
/** A single HTTP probe against a service that may be mid-outage must not hang the suite. */
const PROBE_TIMEOUT_MS = 4_000;
/** Ordinary, healthy command latency. Generous: nothing here is a latency measurement. */
const MOVE_TIMEOUT_MS = 5_000;

const EVIDENCE_FILE = 'chaos-evidence.json';

/** One prefixed progress line. Everything this suite prints is safe to paste into a ticket. */
function log(msg) {
  console.log(`[chaos] ${msg}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one compose command against the two-gateway stack, or throw with what docker said.
 *
 * Every service this suite stops is stopped through here, so a compose invocation that silently
 * did nothing would be an induced outage that never happened — which is why the failure carries
 * the full command and stderr rather than an exit code.
 */
function execDocker(cmd) {
  try {
    return execSync(`${COMPOSE_CMD} ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`Docker command failed (${COMPOSE_CMD} ${cmd}): ${err.stderr ?? err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Probing the stack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One bounded HTTP probe, reporting an unreachable service as an outcome rather than an exception.
 *
 * Bounded because these run against services that are deliberately being broken: `/ready` pings
 * Redis, and a Redis that has gone away can leave that ping outstanding. A probe with no deadline
 * would turn "Redis is unreachable" — the thing under test — into a hung suite.
 */
async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.text();
    return { reachable: true, status: res.status, body };
  } catch (err) {
    return { reachable: false, status: null, body: null, error: err?.message ?? String(err) };
  }
}

/** A bounded JSON read that throws; use `probe` for an endpoint that is allowed to be down. */
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json();
}

/**
 * Wait until a node reports itself READY, not merely alive.
 *
 * `/health` is a liveness answer: the gateway returns 200 from it with Redis on the floor. The
 * suite used to restore the stack, wait for `/health`, and print "stack restored and healthy" —
 * which is how a scenario could go on to run against a stack whose Redis had not come back.
 * `/ready` pings Redis and the database (`services/gateway/src/serve.ts`), so it is the endpoint
 * that answers the question the caller is actually asking.
 */
async function waitForReady(node, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never probed';
  for (;;) {
    const result = await probe(node.readyUrl);
    if (result.reachable && result.status === 200) return;
    last = result.reachable ? `HTTP ${result.status}` : `unreachable (${result.error})`;
    if (Date.now() >= deadline) break;
    await delay(POLL_INTERVAL);
  }
  throw new Error(
    `${node.name} at ${node.readyUrl} was not ready within ${timeoutMs / 1000}s (last: ${last})`,
  );
}

/**
 * Wait until an induced outage is actually observable, and fail if it never becomes so.
 *
 * Without this the destructive scenarios are `docker kill` followed by a sleep. `docker compose
 * kill` exits 0 for a service that was already stopped, and a killed container a restart policy
 * brings straight back looks identical to one that never went down — in both cases the scenario
 * would go on to "verify failover" against a stack that never failed over. This suite is only
 * evidence if the failure it induces is confirmed to have happened.
 */
async function waitForOutage(what, isDown, timeoutMs = OUTAGE_OBSERVATION_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never probed';
  for (;;) {
    const observation = await isDown();
    if (observation.down) return observation;
    last = observation.detail;
    if (Date.now() >= deadline) break;
    await delay(250);
  }
  throw new Error(
    `${what} never became unavailable within ${timeoutMs / 1000}s (last: ${last}). ` +
      'The chaos target is still serving, so nothing after this point would be testing a failure.',
  );
}

/** A gateway is down when its liveness endpoint stops answering at all. */
function gatewayIsDown(node) {
  return async () => {
    const result = await probe(node.healthUrl);
    return result.reachable
      ? { down: false, detail: `${node.name} still answers /health with HTTP ${result.status}` }
      : { down: true, detail: `${node.name} /health is unreachable (${result.error})` };
  };
}

/**
 * Redis is down, from the gateway's point of view, when the gateway says its dependency check
 * fails. Probing Redis directly would prove the container stopped; probing `/ready` proves the
 * thing the scenario actually depends on — that the gateway has lost Redis.
 */
function redisIsDownFor(node) {
  return async () => {
    const result = await probe(node.readyUrl);
    if (!result.reachable) return { down: true, detail: `${node.name} /ready did not answer` };
    return result.status === 200
      ? { down: false, detail: `${node.name} still reports ready` }
      : { down: true, detail: `${node.name} /ready is HTTP ${result.status}` };
  };
}

const FORWARDED_METRIC = 'gateway_forwarded_commands_total';

/**
 * The forwarded-command counter one node exposes, reading a counter that is not there as 0.
 *
 * Scenario A asserts the count GREW across the moves it played, so a counter this suite cannot read
 * leaves before and after equal and fails the scenario — the safe direction for evidence that
 * forwarding happened. Matching the name exactly is what makes the number that evidence:
 * `gateway_forwarded_commands_total_extra`, or any histogram series later added on the same stem,
 * would otherwise be counted as forwarded commands (ADR-0010).
 */
async function readForwardedCommands(node) {
  const res = await fetch(node.metricsUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Fetch metrics failed (${res.status}) for ${node.metricsUrl}`);
  return readPrometheusCounter(await res.text(), FORWARDED_METRIC) ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registration failures report the status and never the body.
 *
 * A registration response carries an access token, and an error path that echoed a body would put
 * one in the run output — which is also a CI log and, now, an uploaded artifact's neighbour.
 */
async function registerUser(handle, password) {
  const res = await fetch(`${apiUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password, email: `${handle}@example.test` }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /v1/auth/register returned ${res.status} for ${handle}` +
        (res.status === 429
          ? ' — the 5-per-hour-per-IP registration limit is spent (ADR-0013); this suite needs 2'
          : ''),
    );
  }
  const body = await res.json();
  const token = body.tokens?.accessToken;
  const userId = body.user?.id;
  if (!token || !userId) throw new Error(`Registration returned no token/userId for ${handle}`);
  return { token, userId, handle };
}

/**
 * The two players are registered ONCE for the whole suite and reused.
 *
 * `POST /v1/auth/register` is rate limited to 5 per hour per IP (packages/api/src/config.ts), and
 * this suite needs a fresh game for each of its scenarios. Registering a new pair per scenario
 * costs two apiece and hits 429 partway through — from any IP, so the suite could never finish a
 * run locally, while a CI runner's fresh IP would only push the failure to whichever scenario
 * crossed the limit. Registrations are the scarce resource here; games are not, so only the game
 * is recreated per scenario.
 */
let players;

async function getPlayers() {
  if (!players) {
    const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    players = {
      white: await registerUser(`cw-${suffix}`, 'pass-123456789'),
      black: await registerUser(`cb-${suffix}`, 'pass-123456789'),
    };
  }
  return players;
}

async function createAndAcceptGame() {
  const { white, black } = await getPlayers();

  const seekRes = await fetch(`${apiUrl}/v1/seeks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${white.token}` },
    body: JSON.stringify({
      variant: 'standard',
      timeControl: { kind: 'increment', initialMs: 300_000, incrementMs: 3_000, delayMs: 0 },
      color: 'white',
      rated: false,
    }),
  });
  if (!seekRes.ok) throw new Error(`POST /v1/seeks returned ${seekRes.status}`);
  const seek = await seekRes.json();

  const acceptRes = await fetch(`${apiUrl}/v1/seeks/${encodeURIComponent(seek.id)}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${black.token}` },
  });
  if (!acceptRes.ok) throw new Error(`POST /v1/seeks/:id/accept returned ${acceptRes.status}`);
  const game = await acceptRes.json();

  return { gameId: game.gameId, white, black };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every client this run opens, so a failure anywhere closes all of them.
 *
 * Scenarios used to close their own sockets on the success path only, which left every socket of a
 * failing run — and, in the ungraceful-loss scenario, one socket of a passing run — open until the
 * process exited.
 */
const openClients = new Set();

class WsClient {
  constructor(node, token, gameId, name) {
    this.node = node;
    this.url = node.wsUrl;
    this.token = token;
    this.gameId = gameId;
    this.name = name;
    this.ws = null;
    this.messages = [];
    this.joinedState = null;
    this.rejections = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      openClients.add(this);

      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(this);
      };
      /**
       * The join deadline is cleared once the join settles.
       *
       * An uncleared timer keeps Node's event loop alive for its full term after the suite is
       * otherwise finished, and then fires a rejection into an already-settled promise.
       */
      const timer = setTimeout(() => {
        settle(new Error(`[${this.name}] timed out waiting for the joined acknowledgement`));
      }, 10_000);

      ws.on('open', () => {
        const frame = { t: 'join', gameId: this.gameId };
        if (this.token) frame.token = this.token;
        ws.send(JSON.stringify(frame));
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          // A frame that is not JSON is the gateway's problem, and not a reason to take the process
          // down from inside an event handler. Waiters time out and name what they were waiting for.
          return;
        }
        this.messages.push(msg);
        if (msg.t === 'joined' && msg.gameId === this.gameId) {
          this.joinedState = msg.state;
          settle(null);
        } else if (msg.t === 'reject') {
          this.rejections.push(msg);
        }
      });

      ws.on('error', (err) => settle(new Error(`[${this.name}] WebSocket error: ${err.message}`)));
    });
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendMove(uci, clientSeq) {
    if (!this.isOpen) throw new Error(`[${this.name}] cannot send move; socket is not OPEN`);
    this.ws.send(JSON.stringify({ t: 'move', gameId: this.gameId, uci, clientSeq }));
    return clientSeq;
  }

  /**
   * What happened to a command THIS client sent: accepted, rejected, or unanswered.
   *
   * Rejections are matched by `ref`, which the gateway sets to the command's `clientSeq`
   * (`packages/realtime-gateway/src/gateway.ts`). Scanning the whole rejection list instead — as
   * this client used to — reports any earlier refusal, including one for a completely different
   * command, as this command's outcome.
   */
  async awaitOwnCommand({ ply, clientSeq, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const move = this.messages.find((m) => m.t === 'move' && m.ply === ply);
      if (move) return { accepted: true, move, rejectCode: null };
      const rejected = this.rejections.find((r) => r.ref === clientSeq);
      if (rejected) {
        return { accepted: false, move: null, rejectCode: String(rejected.code ?? 'unspecified') };
      }
      if (Date.now() >= deadline) return { accepted: false, move: null, rejectCode: null };
      await delay(50);
    }
  }

  /** A command this client sent that MUST be accepted. */
  async playMove(uci, clientSeq, ply, timeoutMs = MOVE_TIMEOUT_MS) {
    this.sendMove(uci, clientSeq);
    const outcome = await this.awaitOwnCommand({ ply, clientSeq, timeoutMs });
    if (!outcome.accepted) {
      throw new Error(
        `[${this.name}] ply ${ply} (${uci}) was not accepted: ` +
          (outcome.rejectCode ? `rejected with "${outcome.rejectCode}"` : 'no answer at all'),
      );
    }
    return outcome.move;
  }

  /**
   * A broadcast this client only observes. Deliberately blind to this client's own rejections: a
   * spectator's unrelated refusal says nothing about whether the room was told about a ply.
   */
  async awaitBroadcast(ply, timeoutMs = MOVE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const move = this.messages.find((m) => m.t === 'move' && m.ply === ply);
      if (move) return move;
      if (Date.now() >= deadline) {
        throw new Error(`[${this.name}] was never told about ply ${ply}`);
      }
      await delay(50);
    }
  }

  close() {
    openClients.delete(this);
    try {
      this.ws?.close();
    } catch {
      // A socket whose node was killed is already gone; the run is finished with it either way.
    }
  }
}

/** Close every socket this run opened, in any order, without letting one failure stop the rest. */
function closeAllClients() {
  for (const client of [...openClients]) client.close();
}

/** Every client must be told the same position for a ply, or the nodes have diverged. */
function assertSamePosition(ply, ...frames) {
  const hashes = frames.map((frame) => frame.fenHash);
  if (new Set(hashes).size !== 1) {
    throw new Error(`Position desync at ply ${ply}: ${hashes.join(' vs ')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership
// ─────────────────────────────────────────────────────────────────────────────

/** The owned-game count one node reports, or `null` when that node cannot be reached. */
async function readOwnedGames(node) {
  try {
    return (await fetchJson(node.healthUrl)).ownedGames;
  } catch {
    return null;
  }
}

/**
 * Owned-game counts on both nodes, tolerating a node that is part of an induced outage.
 *
 * Reading both through one `Promise.all` that rejects is what every post-outage ownership check
 * used to do, and a killed gateway refuses the connection — so the three destructive scenarios
 * failed with a connection error before they could evaluate the delta they exist to evaluate.
 * `previous` supplies the last known value for a node that is currently down, and the merged
 * reading records which halves were actually observed so an assertion about an unread node
 * refuses rather than holding vacuously.
 */
async function captureOwnedCounts(previous = { n1: 0, n2: 0 }) {
  const [n1, n2] = await Promise.all([readOwnedGames(node1), readOwnedGames(node2)]);
  return mergeOwnedCounts(previous, { n1, n2 });
}

/**
 * Which node claimed THIS game, decided by growth against a baseline.
 *
 * Ownership is claimed by the first game COMMAND, not by `join` — the only callers of
 * `OwnershipRegistry.claim()` are on the command path in `command-forwarder.ts` — so callers must
 * play at least one move before asking. The claim also races the command that triggered it: the
 * owning node has already answered the client before it necessarily reports the new count on
 * `/health`, so this polls rather than sampling once.
 */
async function determineOwnerNode(baseline, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = baseline;
  for (;;) {
    current = await captureOwnedCounts();
    const decided = ownershipFromCounts(baseline, current);
    if (decided) return decided;
    if (Date.now() >= deadline) break;
    await delay(POLL_INTERVAL);
  }
  throw new Error(
    `Cannot determine which node claimed this game after ${timeoutMs / 1000}s ` +
      `(baseline ${baseline.n1}/${baseline.n2}, now ${current.n1}/${current.n2}). ` +
      'Ownership is claimed by the first command — has a move been played yet?',
  );
}

/** Poll the owned counts until a takeover shows up, and report the last reading either way. */
async function awaitOwnershipTakeover(baseline, expectedNode, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = baseline;
  for (;;) {
    current = await captureOwnedCounts(baseline);
    if (!ownershipTakeoverProblem(baseline, current, expectedNode)) return current;
    if (Date.now() >= deadline) return current;
    await delay(500);
  }
}

/**
 * Retry an action until it succeeds or the budget runs out, then fail with the last error. Used
 * only where a component is coming back from an induced outage and "ready" is known not to mean
 * "already serving every socket" — never to paper over a genuine failure.
 */
async function withRetry(action, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      if (Date.now() >= deadline) break;
      await delay(POLL_INTERVAL);
    }
  }
  throw new Error(
    `${what} did not succeed within ${timeoutMs / 1000}s: ${lastErr?.message ?? lastErr}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight and restoration
// ─────────────────────────────────────────────────────────────────────────────

async function assertTopology() {
  log('Checking both gateway nodes are ready and routing through Redis...');
  for (const node of nodes) await waitForReady(node);

  const inspected = await Promise.all(
    nodes.map(async (node) => ({ ...node, health: await fetchJson(node.healthUrl) })),
  );
  const problems = topologyProblems(inspected);
  if (problems.length > 0) {
    throw new Error(
      'The stack in front of this suite is not the one it claims to test:\n' +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\n  Start the two-gateway stack with:\n' +
        `    ${COMPOSE_CMD} up -d --build`,
    );
  }
  for (const node of inspected) {
    log(
      `✓ ${node.name}: ${node.health.commandRouting} routing, ` +
        `${node.health.ownedGames} owned games`,
    );
  }
  return inspected.map((node) => ({
    name: node.name,
    wsUrl: node.wsUrl,
    healthUrl: node.healthUrl,
    commandRouting: node.health.commandRouting,
    ownershipRegistry: node.health.ownershipRegistry,
    pubsub: node.health.pubsub,
  }));
}

/**
 * Put every service this suite can stop back, and report it when that does not work.
 *
 * Called from a `finally`, not from the end of each scenario. Restoration used to run only on the
 * success path, so any failure after `docker kill` left the developer's stack — and the next run's —
 * with a dead gateway or no Redis, and the run after that failed somewhere unrelated. A cleanup
 * that did not work is reported and fails the run rather than being swallowed: a half-restored
 * stack is a worse outcome than a red build, because the next person does not know about it.
 */
async function restoreStack() {
  log('Restoring stack services...');
  execDocker(`start ${node1.service} ${node2.service} ${REDIS_SERVICE}`);
  for (const node of nodes) await waitForReady(node);
  log('✓ Stack restored and every node reports ready');
}

/**
 * The interrupt path's version of the above: synchronous, and it does not wait for readiness.
 *
 * Ctrl-C between `docker kill` and the assertion that follows it is the most common way a developer
 * ends up with a gateway that is down and no memory of having stopped it. A signal handler cannot
 * await, so this restarts the services and says so rather than confirming they came back — the
 * process is about to die by the signal either way, and a handler that blocked on readiness would
 * make Ctrl-C feel broken.
 *
 * Passed to `beginEvidence` as `onSignal` rather than installed as this file's own listener: two
 * listeners on one signal means two termination policies, which is how SIGTERM here used to exit
 * with SIGINT's code.
 */
function restoreStackOnInterrupt(signal) {
  console.error(`\n[chaos] ${signal} received — restoring the stack before exiting.`);
  closeAllClients();
  try {
    execDocker(`start ${node1.service} ${node2.service} ${REDIS_SERVICE}`);
    console.error('[chaos] Stack services restarted; they may need a moment to become ready.');
  } catch (err) {
    console.error(`[chaos] ✗ could not restore the stack: ${err.message}`);
    console.error(`[chaos]   Restore it by hand: ${COMPOSE_CMD} up -d`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

/** Two players on different nodes, one fresh game, ownership baseline taken before any command. */
async function openCrossNodeGame(label) {
  const { gameId, white, black } = await createAndAcceptGame();
  const clientW = new WsClient(node1, white.token, gameId, `${label}-White-node1`);
  const clientB = new WsClient(node2, black.token, gameId, `${label}-Black-node2`);
  await clientW.connect();
  await clientB.connect();
  return { gameId, clientW, clientB, baseline: await captureOwnedCounts() };
}

/**
 * The baseline every other scenario stands on: the cluster works when nothing is broken.
 *
 * Two players on different nodes, six alternating plies, and the non-owner's forwarding counter
 * asserted to have grown — that counter is the only thing separating a real two-node run from two
 * isolated gateways that would answer every health check and pass every other assertion here.
 */
async function scenarioA_CrossNodeCorrectness() {
  log('Asserting two players on DIFFERENT gateway nodes play with zero rejections and converge.');

  const { clientW, clientB, baseline } = await openCrossNodeGame('A');
  log('✓ White connected to node1, Black connected to node2');

  // Ownership is established by the first command, so play White's opening move before asking who
  // owns the game. Both clients must still observe it — this ply is part of the sequence under
  // test, not a throwaway warm-up.
  const opening = await clientW.playMove('e2e4', 1, 1);
  assertSamePosition(1, opening, await clientB.awaitBroadcast(1));

  const { owner, nonOwner } = await determineOwnerNode(baseline);
  log(`✓ node${owner} claimed the game; node${nonOwner} is the non-owner`);

  const nonOwnerNode = nodeByIndex(nonOwner);
  const forwardedBefore = await readForwardedCommands(nonOwnerNode);

  const line = [
    { by: clientB, uci: 'e7e5', seq: 1, ply: 2 },
    { by: clientW, uci: 'g1f3', seq: 2, ply: 3 },
    { by: clientB, uci: 'b8c6', seq: 2, ply: 4 },
    { by: clientW, uci: 'f1c4', seq: 3, ply: 5 },
    { by: clientB, uci: 'g8f6', seq: 3, ply: 6 },
  ];
  for (const step of line) {
    const observer = step.by === clientW ? clientB : clientW;
    const played = await step.by.playMove(step.uci, step.seq, step.ply);
    assertSamePosition(step.ply, played, await observer.awaitBroadcast(step.ply));
  }
  log(`✓ ${line.length + 1} alternating plies executed across both nodes`);

  if (clientW.rejections.length > 0 || clientB.rejections.length > 0) {
    throw new Error('Spurious move rejection occurred during cross-node play');
  }

  const forwardedAfter = await readForwardedCommands(nonOwnerNode);
  if (forwardedAfter <= forwardedBefore) {
    throw new Error(
      `node${nonOwner} did not increment ${FORWARDED_METRIC} (${forwardedBefore} → ` +
        `${forwardedAfter}); nothing crossed to the owner, so this measured two isolated nodes`,
    );
  }
  log(`✓ non-owner forwarding observed: ${FORWARDED_METRIC} ${forwardedBefore} → ${forwardedAfter}`);

  clientW.close();
  clientB.close();
  return {
    owner: `node${owner}`,
    forwardedBefore,
    forwardedAfter,
    pliesPlayed: line.length + 1,
  };
}

/**
 * A SIGKILLed owner releases nothing, so the successor has to wait the lease out.
 *
 * This is the slow failover path, and the wait is derived from the lease rather than guessed. The
 * takeover is read as growth in the survivor's owned-game count against a baseline taken while the
 * original owner still held the game.
 */
async function scenarioB_UngracefulOwnerLoss() {
  log('Asserting the surviving node takes the game over after the owner is SIGKILLed.');

  const { clientW, clientB, baseline } = await openCrossNodeGame('B');

  const opening = await clientW.playMove('e2e4', 1, 1);
  assertSamePosition(1, opening, await clientB.awaitBroadcast(1));

  const { owner } = await determineOwnerNode(baseline);
  if (owner !== 1) throw new Error(`Expected node1 to own the game, found node${owner}`);
  const beforeKill = await captureOwnedCounts();
  log('✓ node1 confirmed as owner');

  log(`Executing docker kill on ${node1.service} (SIGKILL)...`);
  execDocker(`kill ${node1.service}`);
  const outage = await waitForOutage('node1', gatewayIsDown(node1));
  log(`✓ ${outage.detail}`);

  log(`Waiting ${TIMING.ungracefulFailoverWaitMs}ms for the ${LEASE_TTL_SEC}s lease to expire...`);
  await delay(TIMING.ungracefulFailoverWaitMs);

  const moved = await clientB.playMove('e7e5', 1, 2, MOVE_TIMEOUT_MS * 2);
  log(`✓ ply ${moved.ply} (${moved.san}) accepted on the surviving node`);

  const after = await awaitOwnershipTakeover(beforeKill, 2);
  const problem = ownershipTakeoverProblem(beforeKill, after, 2);
  if (problem) throw new Error(`node2 did not take the game over after the SIGKILL: ${problem}`);
  log(`✓ node2 owned games grew ${beforeKill.n2} → ${after.n2}`);

  closeAllClients();
  return { ownedBefore: beforeKill, ownedAfter: after, waitedMs: TIMING.ungracefulFailoverWaitMs };
}

/**
 * A SIGTERMed owner runs its release path, so the successor must not have to wait the lease out.
 *
 * The whole claim is comparative: "faster than expiry". A budget at or above the TTL would be met
 * by the ungraceful path too, and would assert nothing about the release having run at all.
 */
async function scenarioC_GracefulDrain() {
  log('Asserting a SIGTERM release lets the successor claim the game faster than lease expiry.');

  const { clientW, clientB, baseline } = await openCrossNodeGame('C');

  const opening = await clientW.playMove('e2e4', 1, 1);
  assertSamePosition(1, opening, await clientB.awaitBroadcast(1));

  const { owner } = await determineOwnerNode(baseline);
  if (owner !== 1) throw new Error(`Expected node1 to own the game, found node${owner}`);
  const beforeDrain = await captureOwnedCounts();
  log('✓ node1 confirmed as owner');

  log(`Executing docker stop on ${node1.service} (SIGTERM graceful drain)...`);
  const drainStart = Date.now();
  execDocker(`stop ${node1.service}`);
  log(`✓ node1 stopped gracefully in ${Date.now() - drainStart}ms`);
  const outage = await waitForOutage('node1', gatewayIsDown(node1));
  log(`✓ ${outage.detail}`);

  /**
   * Watched for longer than the budget it is held to, on purpose.
   *
   * The previous version waited exactly as long as its own budget, so the assertion that followed
   * — "did this take under 5000 ms?" — could never be reached with a value at or above 5000: the
   * wait timed out first and the check was unreachable. A failover that is merely slow reported an
   * opaque timeout instead of the number the scenario is about.
   */
  const moveStart = Date.now();
  const moved = await clientB.playMove('e7e5', 1, 2, TIMING.gracefulObservationWindowMs);
  const moveDuration = Date.now() - moveStart;
  log(`✓ ply ${moved.ply} accepted on node2 in ${moveDuration}ms`);

  if (moveDuration >= TIMING.gracefulFailoverBudgetMs) {
    throw new Error(
      `Graceful drain failover took ${moveDuration}ms, at or over the ` +
        `${TIMING.gracefulFailoverBudgetMs}ms budget derived from the ${LEASE_TTL_SEC}s lease TTL. ` +
        'A release no faster than waiting for expiry has not been shown to have run at all.',
    );
  }

  const after = await awaitOwnershipTakeover(beforeDrain, 2);
  const problem = ownershipTakeoverProblem(beforeDrain, after, 2);
  if (problem) throw new Error(`node2 did not take the game over after the drain: ${problem}`);
  log(`✓ node2 owned games grew ${beforeDrain.n2} → ${after.n2}`);

  closeAllClients();
  return {
    failoverMs: moveDuration,
    budgetMs: TIMING.gracefulFailoverBudgetMs,
    ownedBefore: beforeDrain,
    ownedAfter: after,
  };
}

/**
 * Losing a node that owns nothing must be a non-event.
 *
 * The other scenarios all remove either the node that owns the game or the Redis every node
 * depends on, so all of them would still pass if a peer's departure triggered a global reshuffle —
 * a released lease, a re-claim, a torn-down room. This is the case where the correct behaviour is
 * that *nothing happens*, and the only one that asserts the owner's lease stayed put. Both players
 * sit on node1 so play can continue while node2 is gone.
 */
async function scenarioE_NonOwnerLoss() {
  log('Asserting removing the node that owns NOTHING moves no lease and interrupts no play.');

  const { gameId, white, black } = await createAndAcceptGame();
  const clientW = new WsClient(node1, white.token, gameId, 'E-White-node1');
  const clientB = new WsClient(node1, black.token, gameId, 'E-Black-node1');
  // Anonymous, per the spectator path in ADR-0004: this suite holds only two credentials.
  const spectator = new WsClient(node2, null, gameId, 'E-Spectator-node2');
  await clientW.connect();
  await clientB.connect();
  await spectator.connect();
  const baseline = await captureOwnedCounts();

  const opening = await clientW.playMove('e2e4', 1, 1);
  assertSamePosition(1, opening, await clientB.awaitBroadcast(1), await spectator.awaitBroadcast(1));

  const { owner } = await determineOwnerNode(baseline);
  if (owner !== 1) throw new Error(`Expected node1 to own the game, found node${owner}`);
  const beforeKill = await captureOwnedCounts();
  log('✓ node1 confirmed as owner; node2 holds only a spectator');

  log(`Executing docker kill on ${node2.service} (the non-owner)...`);
  execDocker(`kill ${node2.service}`);
  const outage = await waitForOutage('node2', gatewayIsDown(node2));
  log(`✓ ${outage.detail}`);
  spectator.close();

  const second = await clientB.playMove('e7e5', 1, 2);
  assertSamePosition(2, second, await clientW.awaitBroadcast(2));
  const third = await clientW.playMove('g1f3', 2, 3);
  assertSamePosition(3, third, await clientB.awaitBroadcast(3));
  log('✓ play continued on the owner across two further plies');

  const after = await captureOwnedCounts(beforeKill);
  const problem = ownershipHeldProblem(beforeKill, after, 1);
  if (problem) throw new Error(`The owner's lease moved when its peer was removed: ${problem}`);
  log(`✓ node1 owned games unchanged at ${after.n1}`);

  closeAllClients();
  return { ownedBefore: beforeKill, ownedAfter: after, pliesAfterLoss: 2 };
}

async function scenarioD_RedisLoss() {
  log('Asserting the owner serves from its lease during a Redis outage, then fails closed.');

  const { gameId, white, black } = await createAndAcceptGame();
  const clientW = new WsClient(node1, white.token, gameId, 'D-White-node1');
  const clientBOwner = new WsClient(node1, black.token, gameId, 'D-Black-node1');
  const clientBNonOwner = new WsClient(node2, black.token, gameId, 'D-Black-node2');
  await clientW.connect();
  await clientBOwner.connect();
  await clientBNonOwner.connect();
  const baseline = await captureOwnedCounts();

  const opening = await clientW.playMove('e2e4', 1, 1);
  assertSamePosition(1, opening, await clientBOwner.awaitBroadcast(1));

  const { owner } = await determineOwnerNode(baseline);
  if (owner !== 1) throw new Error(`Expected node1 to own the game, found node${owner}`);
  log('✓ node1 confirmed as owner');

  log('Stopping Redis...');
  execDocker(`stop ${REDIS_SERVICE}`);
  const outage = await waitForOutage('Redis, as seen by node1', redisIsDownFor(node1));
  log(`✓ ${outage.detail}`);

  // 1. The owner keeps serving its own game from the unexpired lease.
  const inWindow1 = await clientBOwner.playMove('e7e5', 1, 2, MOVE_TIMEOUT_MS);
  log(`✓ ply ${inWindow1.ply} served by the owner inside the lease window`);
  const inWindow2 = await clientW.playMove('g1f3', 2, 3, MOVE_TIMEOUT_MS);
  log(`✓ ply ${inWindow2.ply} served by the owner inside the lease window`);

  // 2. A non-owner command needs Redis to forward, so it must not be applied.
  log(
    `Attempting a non-owner move on node2 (budget ${INDUCED_BUDGET_MS}ms, past the gateway's own ` +
      `${FORWARD_TIMEOUT_MS}ms forwarding timeout)...`,
  );
  const nonOwnerSeq = clientBNonOwner.sendMove('b8c6', 2);
  const nonOwnerOutcome = classifyInducedOutcome(
    await clientBNonOwner.awaitOwnCommand({
      ply: 4,
      clientSeq: nonOwnerSeq,
      timeoutMs: INDUCED_BUDGET_MS,
    }),
  );
  const nonOwnerVerdict = inducedFailureVerdict(nonOwnerOutcome, 'a non-owner move with Redis down');
  if (nonOwnerVerdict) throw new Error(nonOwnerVerdict);
  log(`✓ non-owner move did not apply (${describeOutcome(nonOwnerOutcome)})`);

  // 3. Once the fast-path window ages out, even the owner must fail closed. The wait is DERIVED
  //    from the numbers the gateway uses: an earlier version slept a flat 3s against a ~3.6s
  //    window and could only pass by luck.
  log(
    `Waiting ${TIMING.fastPathExpiryWaitMs}ms for the ${TIMING.fastPathWindowMs}ms fast-path ` +
      `window (TTL ${LEASE_TTL_SEC}s / renewal ${RENEWAL_INTERVAL_SEC}s) to age out...`,
  );
  await delay(TIMING.fastPathExpiryWaitMs);

  const expiredSeq = clientBOwner.sendMove('b8c6', 2);
  const expiredOutcome = classifyInducedOutcome(
    await clientBOwner.awaitOwnCommand({
      ply: 4,
      clientSeq: expiredSeq,
      timeoutMs: INDUCED_BUDGET_MS,
    }),
  );
  const expiredVerdict = inducedFailureVerdict(
    expiredOutcome,
    'an owner move after its lease window expired',
  );
  if (expiredVerdict) throw new Error(`${expiredVerdict} — the split-brain guard did not hold`);
  log(`✓ owner failed closed after lease expiry (${describeOutcome(expiredOutcome)})`);

  // 4. Recovery.
  log('Restarting Redis...');
  execDocker(`start ${REDIS_SERVICE}`);
  for (const node of nodes) await waitForReady(node);
  log('✓ Redis is back and both nodes report ready');

  const recovered = await createAndAcceptGame();
  const recW = new WsClient(node1, recovered.white.token, recovered.gameId, 'D-Rec-White-node1');
  const recB = new WsClient(node2, recovered.black.token, recovered.gameId, 'D-Rec-Black-node2');
  await withRetry(() => recW.connect(), 'node1 join after Redis recovery');
  await withRetry(() => recB.connect(), 'node2 join after Redis recovery');

  const rec1 = await recW.playMove('e2e4', 1, 1);
  assertSamePosition(1, rec1, await recB.awaitBroadcast(1));
  const rec2 = await recB.playMove('e7e5', 1, 2);
  assertSamePosition(2, rec2, await recW.awaitBroadcast(2));
  log('✓ cross-node play recovered after Redis returned');

  closeAllClients();
  return {
    nonOwnerDuringOutage: nonOwnerOutcome,
    ownerAfterLeaseExpiry: expiredOutcome,
    fastPathWindowMs: TIMING.fastPathWindowMs,
    inducedBudgetMs: INDUCED_BUDGET_MS,
  };
}

/** An induced-outage outcome as one readable token, with the reject code when there was one. */
function describeOutcome(outcome) {
  return outcome.code ? `${outcome.kind}: ${outcome.code}` : outcome.kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const RUNNERS = {
  A: scenarioA_CrossNodeCorrectness,
  B: scenarioB_UngracefulOwnerLoss,
  C: scenarioC_GracefulDrain,
  E: scenarioE_NonOwnerLoss,
  D: scenarioD_RedisLoss,
};

/**
 * The scenarios to run, each carrying the declaration of what it breaks.
 *
 * The order and the `disturbs` declarations live in `chaos-plan.mjs` so a test can hold them
 * against what the scenario bodies actually stop; this only supplies the function per key, and
 * refuses to start if a declared scenario has none.
 */
const SCENARIOS = SCENARIO_PLAN.map((scenario) => {
  const run = RUNNERS[scenario.key];
  if (!run) throw new Error(`SCENARIO_PLAN declares "${scenario.key}" with no runner in this file`);
  return { ...scenario, run };
});

/**
 * Exit contract:
 *   0 — every scenario held and the stack was restored.
 *   1 — a REGRESSION, or the environment could not be restored afterwards.
 *   2 — only defects listed in `KNOWN_OPEN_DEFECTS` were observed.
 */
/**
 * Run every scenario in order, restore what each one broke, and leave an artifact behind.
 *
 * Stops at the first failure: the scenarios share one stack, and continuing past a failure would
 * report results measured against a system already known to be in an unexpected state.
 */
async function main() {
  const startedAt = new Date();
  // Arms the fallback, then clears the previous run's artifact — in that order, so an interrupt
  // between the two leaves this run's aborted envelope rather than nothing at all. Clearing at the
  // START is what stops a reader taking a previous run's file for this one's; the fallback is the
  // other half of that bargain, because `process.exit` on the signal path bypasses every `catch`
  // below. `onSignal` is where this suite's interrupt cleanup goes: a second listener of its own
  // would give SIGTERM two termination policies.
  const fallback = beginEvidence(
    EVIDENCE_DIR,
    EVIDENCE_FILE,
    (exitCode) =>
      buildEvidence({
        harness: 'chaos',
        outcome: 'aborted',
        exitCode,
        startedAt,
        finishedAt: new Date(),
        topology: { compose: COMPOSE_CMD, apiUrl },
        configuration: { leaseTtlSec: LEASE_TTL_SEC, renewalIntervalSec: RENEWAL_INTERVAL_SEC },
        observed: { scenariosPlanned: SCENARIOS.length },
        notes: ['The run was interrupted or died before any scenario could be recorded.'],
      }),
    { onSignal: restoreStackOnInterrupt },
  );

  const results = [];
  const notes = [];
  let topology = [];
  let failedScenario = null;
  let failure = null;

  try {
    topology = await assertTopology();
    for (const scenario of SCENARIOS) {
      log(`\n=== Scenario ${scenario.name} ===`);
      const at = Date.now();
      try {
        const detail = await scenario.run();
        results.push({ name: scenario.name, status: 'passed', durationMs: Date.now() - at, detail });
        log(`✅ Scenario ${scenario.name} PASSED`);
      } catch (err) {
        results.push({
          name: scenario.name,
          status: 'failed',
          durationMs: Date.now() - at,
          detail: { error: err?.message ?? String(err) },
        });
        failedScenario = scenario.name;
        failure = err;
        break;
      }

      // Put back whatever this scenario stopped, before the next one connects to it. The suite
      // used to do this at the end of each destructive scenario's own body; centralising
      // restoration into the `finally` below removed those calls and left the following scenario
      // opening a socket on a gateway its predecessor had killed.
      if (restorationRequired(scenario)) {
        try {
          await restoreStack();
        } catch (err) {
          failedScenario = scenario.name;
          failure = new Error(
            `${scenario.name} passed, but the services it stopped ` +
              `(${scenario.disturbs.join(', ')}) could not be restored: ${err?.message ?? err}`,
          );
          break;
        }
      }
    }
  } catch (err) {
    failedScenario = 'preflight';
    failure = err;
    results.push({
      name: 'preflight',
      status: 'failed',
      durationMs: Date.now() - startedAt.getTime(),
      detail: { error: err?.message ?? String(err) },
    });
  } finally {
    closeAllClients();
  }

  // Restoration runs whatever happened above, including after a preflight that never started a
  // scenario. A run interrupted between `docker kill` and its assertion is exactly the case that
  // used to leave a dead gateway behind.
  let cleanupError = null;
  try {
    await restoreStack();
  } catch (err) {
    cleanupError = err;
    notes.push(`stack restoration FAILED: ${err?.message ?? String(err)}`);
  }

  const verdict = classifyExit({ failedScenario, knownOpenDefects: KNOWN_OPEN_DEFECTS });
  // A damaged environment is a failure even when every scenario held: the next run starts here.
  const cleanupOnlyFailure = Boolean(cleanupError) && verdict.code === 0;
  const exitCode = cleanupOnlyFailure ? 1 : verdict.code;

  const evidencePath = writeEvidence(
    EVIDENCE_DIR,
    EVIDENCE_FILE,
    buildEvidence({
      harness: 'chaos',
      outcome: cleanupOnlyFailure ? 'cleanup-failed' : verdict.outcome,
      exitCode,
      startedAt,
      finishedAt: new Date(),
      topology: { compose: COMPOSE_CMD, apiUrl, nodes: topology },
      configuration: {
        leaseTtlSec: LEASE_TTL_SEC,
        renewalIntervalSec: RENEWAL_INTERVAL_SEC,
        gatewayForwardTimeoutMs: FORWARD_TIMEOUT_MS,
      },
      expected: { ...TIMING, inducedFailureBudgetMs: INDUCED_BUDGET_MS },
      observed: {
        scenariosPlanned: SCENARIOS.length,
        scenariosRun: results.length,
        scenariosPassed: results.filter((r) => r.status === 'passed').length,
        stackRestored: cleanupError === null,
      },
      scenarios: results,
      notes,
    }),
  );
  fallback.markWritten();

  console.error('');
  if (failure) {
    console.error(`[chaos] ✗ FAILED (${failedScenario}): ${failure.message}`);
    if (failure.stack) console.error(failure.stack);
    if (verdict.defect) {
      console.error(`[chaos] This matches a known open defect: ${verdict.defect.description}`);
      console.error('[chaos] Exiting 2 (known open defect), not 1 (regression).');
    }
  }
  if (cleanupError) {
    console.error(`[chaos] ✗ CLEANUP FAILED: ${cleanupError.message}`);
    console.error('[chaos] The stack may be partially down. Restore it before the next run:');
    console.error(`[chaos]   ${COMPOSE_CMD} up -d`);
  }
  if (!failure && !cleanupError) {
    log('════════════════════════════════════════════════════════════');
    log('  ✅ ALL CHAOS & FAILOVER SCENARIOS PASSED');
    log('════════════════════════════════════════════════════════════');
  }
  log(`Evidence written to ${evidencePath}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[chaos] ✗ Fatal error: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
