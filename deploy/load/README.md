# Gambit — load and chaos harnesses

Three on-demand harnesses. Two of them are k6 from the same pinned image measuring different things;
the third breaks the stack on purpose.

| Harness | Runs | Measures | Pass criteria |
|---|---|---|---|
| **HTTP** (ADR-0065) | `npm run load-test` | the REST API | the SLOs in `docs/SLO.md` |
| **WebSocket** (ADR-0111) | `npm run load-test:ws` | real sockets against two gateway nodes | coverage and correctness only |
| **Chaos** (ADR-0077) | `node scripts/chaos-test.mjs` | failover across two gateway nodes and a Redis outage | correctness of the failover paths |

All three are manual. Their *logic* is not: `npm run test:load-harness` runs on every PR and covers
the planning, verification, timing, ownership, verdict and evidence code all three depend on,
without a container in sight. See **Its own tests** and **CI cost** below.

## What this is not

**None of them is the 100k-user validation.** That remains deferred in `docs/ROADMAP.md` and needs real
infrastructure — a cluster, generated load from multiple hosts, and production-shaped data. What
these give you is a baseline you can run on one machine, so a regression shows up as a number rather
than as a feeling, and so the SLO targets stop being pure guesses.

Treat the numbers in `results/` as *this hardware, this dataset, this concurrency* — not as the
service's capacity.

---

# HTTP baseline

Pass/fail criteria **are** the SLOs in `docs/SLO.md`. If a target is unachievable, this run fails
and the SLO is wrong; the objective and the thing that validates it cannot drift apart.

## Running it

```bash
docker compose up -d --build     # the stack under test
npm run load-test
```

Tunables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `READ_VUS` | 20 | concurrent virtual users on the read path |
| `AUTH_VUS` | 3 | concurrent users registering; scrypt-bound, so keep this low |
| `DURATION` | 30s | per-scenario duration |
| `BASE_URL` | `http://host.docker.internal:3000` | API through the trusted web edge as seen **from inside the k6 container** |
| `HEALTH_URL` | `http://localhost:3000` | API through the trusted web edge as seen from the runner process |

## Why two scenarios

They stress different resources, and mixing them would hide which one moved:

- **`read`** — public GETs against Postgres (`/v1/health`, `/v1/leaderboard/:variant`, `/v1/search`,
  `/v1/tournaments`, `/v1/seeks`). This is the path the API latency SLO describes.
- **`auth`** — registration, which runs scrypt on purpose (ADR-0012). A handful of concurrent
  registrations saturates a core in a way no volume of read traffic does, so it is held to a
  separate, explicitly looser threshold. Folding it into the API latency SLO would either make that
  SLO meaningless or make password hashing look like a regression.

## Thresholds

Taken directly from `docs/SLO.md`:

| k6 threshold | SLO |
|---|---|
| `http_req_failed: rate<0.005` | availability 99.5% — only 5xx counts, a 4xx is a valid response |
| `http_req_duration{scenario:read}: p(99)<250` | 99% of requests under 250 ms |
| `http_req_duration{scenario:auth}: p(95)<2000` | not an SLO — a guard on the deliberately expensive path |
| `auth_failures: rate<0.01` | registration must succeed **or** be cleanly rate-limited; anything else is a real failure |
| `checks{scenario:read}: rate>0.999` | every read URL must return 200 — a 4xx would otherwise pass silently while still entering the latency baseline |

Availability and correctness are measured by different mechanisms on purpose:
`http_req_failed` is relaxed to 5xx-only via `setResponseCallback`, because a 429 from the rate
limiter is the service working; the per-request **checks** are strict, because a scenario pointed at
a wrong URL must fail loudly rather than quietly measure the wrong thing.

---

# WebSocket baseline

Real sockets against the two-gateway stack: a WebSocket upgrade per connection, JSON frames crossing
a container boundary, and command forwarding between two independent gateway processes over Redis.
It closes the gap between `packages/realtime-gateway/test/load.test.ts` (fanout cost measured
in-process, no sockets) and `scripts/chaos-test.mjs` (real sockets, but two or three of them).

## Running it

The two-gateway stack, not the single-gateway one:

```bash
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
npm run load-test:ws
```

Run it against an otherwise idle stack: the exact forwarding-counter check intentionally fails if
unrelated game traffic shares the two gateway nodes during the measurement.

Tunables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SPECTATORS_PER_NODE` | 16 | anonymous spectator sockets per gateway node |
| `MOVE_PLIES` | 32 | plies of the planned line to play (32 is the whole line) |
| `MOVE_INTERVAL_MS` | 250 | pause between plies |
| `API_URL` | `http://host.docker.internal:8080` | API as seen **from inside the k6 container** |
| `NODE1_WS_URL` | `ws://host.docker.internal:4175` | node1 WebSocket, from inside the container |
| `NODE2_WS_URL` | `ws://host.docker.internal:4177` | node2 WebSocket, from inside the container |
| `NODE1_HEALTH_URL`, `NODE2_HEALTH_URL` | `http://localhost:417{6,8}/health` | as seen from the runner process |
| `NODE1_METRICS_URL`, `NODE2_METRICS_URL` | `http://localhost:417{6,8}/metrics` | as seen from the runner process |

**A run costs two registrations, and `/v1/auth/register` allows five per IP per hour** (ADR-0013).
That is about two runs an hour from one host; the third fails in `setup()` with a 429 and says so.
It is the abuse control working as designed, not something to work around.

## What it does

1. Registers two players and opens one real game through `POST /v1/seeks` and
   `POST /v1/seeks/:id/accept`. No test-only endpoint exists or is needed.
2. Opens `1 + SPECTATORS_PER_NODE` sockets on each node — white plays through node1, black through
   node2, spectators join anonymously (no token, per ADR-0004).
3. Plays a deterministic legal line. White's first move claims ownership for node1, so **every black
   move after it is forwarded to node1 over Redis** — that alternation is what makes this a
   multi-node measurement rather than a single-node one.
4. Checks every frame every socket receives, and compares the `fenHash` all of them were given for
   each ply.

## What is enforced, and what is only reported

| k6 threshold | Why |
|---|---|
| `ws_joins_observed: count==<sockets>` | every socket must be seated; a socket that never joined would otherwise just be absent from the averages |
| `ws_broadcasts_observed: count==<sockets × plies>` | every socket must see every ply, exactly once — an exact count, because a delivery *rate* of 1.0 says nothing about deliveries that never arrived |
| `ws_protocol_errors: count==0` | a reject, an unexpected frame type, a ply out of order, a position two nodes disagree on, or a socket that closed early |

`scripts/ws-load-test.mjs` adds two checks k6 cannot make from inside a socket: both nodes must
report `commandRouting: redis` on `/health`, and `gateway_forwarded_commands_total` must grow by
exactly the number of commands the isolated plan sends to the non-owning node. Two gateways each routing
locally would answer every health check and serve every socket, and the run would look identical.

**The latency trends — `ws_connect_duration`, `ws_join_duration`, `ws_move_ack_duration`,
`ws_move_same_node_duration`, `ws_move_other_node_duration` — carry no thresholds.** `docs/SLO.md` has no
end-to-end WebSocket objective, and one run on one workstation is not the evidence needed to write
one. They are printed, labelled informational, and recorded in `docs/SLO.md` as an observation.

Note also that they are an **upper bound**: one k6 VU drives every socket on one event loop,
so a measurement includes whatever client-side queueing that loop added.

## Limits this stays under

The gateway allows 20 connections per source IP per node (`WS_MAX_CONNECTIONS_PER_IP`) and 60 client
frames per connection per 10 seconds (`WS_MAX_MESSAGES_PER_WINDOW`). k6 generates all its load from
one container, so the gateway sees every socket as one IP — the per-IP ceiling, not the hardware, is
what bounds this baseline. The default sits at 17 sockets per node. The finite 32-ply plan sends at
most 17 client frames on either player socket (one join plus 16 moves), so it also stays below the
60-frame message window even at the fastest accepted pacing.

Those limits are **not relaxed**, and no load-only Compose override ships: raising an abuse control
to make a number look better produces a number describing a service nobody deploys. A configuration
that would cross the connection limit is refused before the run starts. The plan also computes its
finite per-connection frame count against the message limit rather than projecting an unbounded stream.

## The move plan

Every pawn advances one square, file by file, colours alternating: `a2a3 a7a6 b2b3 b7b6 … h3h4 h6h5`.
Both properties it needs are provable by inspection rather than by having run it once — every move
is a single step into an empty square with neither king ever attacked, and a pawn advance is
irreversible, so no position can repeat. That second one matters: the engine ends a game on
threefold repetition, so a piece shuffle would end the game mid-run, and a famous opening line could
end it in mate. Either would fail the run for a reason that has nothing to do with the gateway.

---

# Chaos & failover suite

`scripts/chaos-test.mjs` (ADR-0077) is the odd one out: it runs no k6, generates no load, and breaks
the stack on purpose. It validates the multi-node ownership and command-forwarding architecture of
ADR-0010 by removing pieces of it.

```bash
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
node scripts/chaos-test.mjs
```

| Scenario | Induces | Asserts |
|---|---|---|
| A — cross-node correctness | nothing | two players on different nodes play with no spurious rejections, converge on every position, and the non-owner's `gateway_forwarded_commands_total` grows |
| B — ungraceful owner loss | `docker kill` the owner | after the lease TTL expires, the survivor takes the game over and play continues |
| C — graceful drain | `docker stop` the owner | the SIGTERM release path runs, so the successor claims **faster than the TTL** |
| E — non-owner loss | `docker kill` the node that owns nothing | the owner's lease does not move in either direction, and play is uninterrupted |
| D — Redis loss | `docker stop redis` | the owner serves from its unexpired lease, the non-owner cannot forward, the owner fails closed once the window ages out, and everything recovers when Redis returns |

Scenario E is the only one whose correct outcome is that *nothing happens*, which is why it is worth
its ~20 seconds: every other scenario would still pass if a peer's departure triggered a global
ownership reshuffle.

## What makes a run here evidence

Every scenario induces a failure and then asserts something about it, so the ways a run could report
success without having tested anything are what the suite defends against first:

- **The stack must be a cluster.** Two gateways each routing locally answer every health check, serve
  every socket, own every game they are asked about, and forward nothing. The preflight refuses to
  start without `commandRouting: redis` on both, and without two genuinely distinct endpoints.
- **The chaos target must actually go away.** `docker compose kill` exits 0 for a service that was
  already stopped, so every induced outage is confirmed observable — node liveness stops answering,
  or `/ready` starts reporting 503 — before anything is asserted about it.
- **Waits are derived, never guessed.** Every deadline comes from `leaseTiming()` over the same
  `OWNERSHIP_LEASE_TTL_SEC` / `OWNERSHIP_RENEWAL_INTERVAL_SEC` the stack runs with, so editing
  `docker-compose.chaos.yml` cannot leave a sleep here silently testing something else.
- **"It failed as expected" has to say how.** The budget for a command issued into an outage is
  longer than the gateway's own 5 s forwarding timeout, because a shorter one cannot tell a refusal
  from a decision that has not finished. The outcome is recorded as `rejected` (with the reject code)
  or `silent`, not collapsed into a pass.
- **Ownership is read as a delta.** `ownedGames` is a per-node count that outlives the scenario which
  created it, so a raw `>= 1` on the survivor is satisfied by a game an earlier scenario left behind.

## Cleanup

Restoration happens at three levels, because each covers a case the others do not:

1. **After every scenario that declares it broke something.** Each entry in `SCENARIO_PLAN` names the
   services it leaves stopped, and the runner puts them back before the next scenario starts. The
   declaration is what makes this hard to get wrong: a scenario that stops a service without saying
   so fails a contract test rather than handing the *next* scenario a dead gateway.
2. **From a `finally`,** so a scenario that throws partway through is still followed by restoration.
3. **On `SIGINT`/`SIGTERM`,** because Ctrl-C between `docker kill` and the assertion after it is the
   most common way to end up with a gateway that is down and no memory of having stopped it.

A restoration that does not work is reported and **fails the run even when every scenario passed**: a
half-restored stack is a worse outcome than a red build, because the next person does not know
about it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every scenario held and the stack was restored |
| 1 | a regression, or the environment could not be restored |
| 2 | only defects listed in `KNOWN_OPEN_DEFECTS` were observed |

That list is currently **empty**, so every failure is a regression. It is a list of decisions, not an
escape hatch: adding an entry silences a real failure, and `chaos-plan.test.mjs` is where that
decision is recorded.

---

# Run evidence

All three harnesses write a self-identifying envelope next to their metrics, into the same gitignored
`results/` directory:

| Harness | File |
|---|---|
| HTTP | `results/http-load-evidence.json` |
| WebSocket | `results/ws-load-evidence.json` |
| Chaos | `results/chaos-evidence.json` |

Each carries the scenario, a run id, start and finish timestamps, the runner, the target topology,
the harness configuration, the thresholds the run was held to, what was actually measured, and the
outcome. A k6 metrics blob alone cannot answer the two questions a reader has — *what was this
measured against* and *is this from the run I just did* — and the chaos suite previously produced no
artifact at all.

**No evidence file ever carries a credential.** `scripts/lib/run-evidence.mjs` walks the envelope and
*refuses to write it* when any field is named like a token, password, secret, cookie, authorization
or session; when any value looks like a JWT or an `Authorization` header; or when any value is a URL
carrying credentials in its user-info (`https://user:pass@host`) or in a secret-bearing query
parameter (`wss://host/live?access_token=…`). That last one matters because every URL in an envelope
comes from an environment variable and lands under a perfectly innocent key like `topology.baseUrl`.
It fails closed rather than trusting its callers, which is what makes the chaos evidence safe to
upload as a CI artifact.

Stale artifacts cannot be mistaken for a current run: each harness clears its evidence file at the
*start* of a run, so a run that dies partway can never leave the previous run's file behind.
`runK6` already did the same for the k6 summaries.

Clearing first would be a poor trade if it meant a failed run had nothing to show, so each harness
also **arms a fallback envelope** — and arms it *before* clearing. A stack that will not come up, a
k6 image that will not pull, a summary that will not parse, or a Ctrl-C all leave an `aborted`
envelope recording the exit code and the configuration, instead of an empty directory. The two steps
are one call, `beginEvidence`, because the order is the whole point: clearing first opens a window
where the old artifact is gone and no handler is installed yet, and an interrupt landing there
leaves neither run's evidence.

It hangs off `process.on('exit')` rather than a `catch`, because several of those paths call
`process.exit` directly. `exit` alone is not enough either: under the default disposition for
`SIGINT` and `SIGTERM`, Node terminates *without* running exit handlers, so signal listeners are
installed as well. They write the envelope, run whatever cleanup the harness passed as `onSignal`,
then re-raise, so the process still dies by the signal rather than turning an interrupt into an
ordinary exit.

There is exactly **one listener per signal**, owned by the evidence lifecycle. Harness-specific
interrupt cleanup — the chaos suite's stack restoration — goes through `onSignal` rather than a
second listener of its own: two listeners on one signal is two termination policies, which is how
the chaos suite came to exit with `SIGINT`'s code on a `SIGTERM`.

---

# Its own tests

`npm run test:load-harness` exercises the pure logic all three harnesses depend on, directly:

- `deploy/load/scenarios/lib/ws-baseline-plan.mjs` — planning and frame verification for the k6
  scenario, which `node --test` cannot execute because it imports `k6/*`.
- `scripts/lib/chaos-plan.mjs` — the chaos suite's lease timing, topology preconditions, ownership
  deltas, induced-failure classification and exit-code contract. `scripts/chaos-test.mjs` cannot be
  imported either: importing it starts a run against a live stack.
- `scripts/lib/run-evidence.mjs` — the envelope, and the credential scan that guards it.
- `scripts/lib/prometheus-text.mjs` — the counter reader both the WebSocket and chaos harnesses use
  to prove commands crossed between nodes.

They run in CI even though none of the harnesses does: the runs need a stack, their correctness
guards are pure functions.

The WebSocket scenario deliberately does not use k6's built-in `--summary-export`: k6 includes
`setup_data` there, which contains the two short-lived access tokens. Its `handleSummary` writes a
metrics-only `results/ws-summary.json`, and the contract test proves representative setup data and
tokens cannot enter that serialization. Results remain gitignored.

# CI cost

Nothing expensive runs routinely, and that is deliberate.

| Runs | What |
|---|---|
| every PR and push | `npm run test:load-harness` — pure functions, no containers, well under a second |
| manual only | the HTTP baseline, the WebSocket baseline, and `chaos.yml` (`workflow_dispatch`) |

`chaos.yml` builds a gateway image and stands up two gateways, Postgres and Redis, then spends real
wall-clock time waiting out ownership leases. It is capped with `timeout-minutes` so a wedged
container cannot bill the six-hour GitHub default, and superseded dispatches cancel each other.
Adding a push or schedule trigger to it needs a reason the hermetic tests cannot cover.

---

Both load harnesses run k6 from a pinned Docker image (`grafana/k6:0.55.0`), like helm, kubeconform
and promtool elsewhere in this repo — load tooling is not something the application should carry as a
dependency. The version is pinned, in one place (`scripts/lib/k6-docker.mjs`), because a baseline
measured with a drifting tool is not a baseline.

The WebSocket scenario uses `k6/experimental/websockets`, whose global event loop is what lets one
VU own the bounded room. Revalidate that runtime behavior before changing the pinned k6 version.
