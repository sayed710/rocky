# D1-A candidate boundary controls — executable test-patch proposal (Claude)

**What this is**
- An independent pre-fix test specification for Codex2's upcoming *external, server-only* D1-A candidate, which reads join/resume state through a non-mutating, coherent `EventLog.load` replay.
- Source-grounded in the frozen main sources at `D1A_CURRENT_MAIN_REPRO_2026-10-15/frozen-src` (42/42 SHA-256 verified, baseline `4ccf8f4`).

**What I did not do**
- I executed nothing.
- I did not edit Codex2's harness. These are proposed **additional** cases for a separate file.
- This is not implementation authority.

## 0. Already covered (not repeated)

The existing 15-case matrix (F01–F07, S01–S05, C01–C03) covers:
- staleness of a warm non-owner on join/resume, plus resume missed history (S01–S03);
- same-ply draw offer and resign (S04/S05);
- revision codec (F03);
- batch prefixes (F02);
- cold-reload truth (F04);
- client regression and equal-revision role ACK (C01–C03, F05);
- the exact `requestId` receipt on the **client** (F07).

**None** of the existing cases:
- (1) pauses an owner append while a read happens;
- (2) commits between a load's snapshot and its reply;
- (3) completes an asynchronous load after the session has gone.

The client-side R04 and R03 suites already exist on main: `packages/web/test/reconnect-auth.test.ts`, `ws-generation.test.ts`, `game-sync.test.ts`, and `services/gateway/test/forward-timeout-regression.test.ts`. They are not duplicated here. Control 3 adds only the **server-gateway** counterpart.

## 1. Shared seam (deterministic, no sleeps, no new DB API)

```ts
import { InMemoryEventLog, type EventLog } from './frozen-src/packages/realtime-gateway/src/event-log';
import { InMemoryConnection } from './frozen-src/packages/realtime-gateway/src/transport';
import { gameChannel, InMemoryPubSub } from './frozen-src/packages/realtime-gateway/src/pubsub';

type Gate = { entered: Promise<void>; release: () => void };
function gate(): Gate & { enter: () => Promise<void> } {
  let release!: () => void, signal!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (signal = r));
  return { entered, release, enter: async () => { signal(); await open; } };
}
const flush = () => new Promise<void>((r) => setImmediate(r)); // drains already-settled microtasks; it never waits on wall time

/** Wraps the production in-memory log. Hooks only gate timing; they never alter data. */
class DeferredLog implements EventLog {
  readonly inner = new InMemoryEventLog();
  appendBeforeCommit?: Gate & { enter(): Promise<void> };   // pause *before* the durable append
  appendAfterCommit?: Gate & { enter(): Promise<void> };    // pause after the durable append, before the authority commits it to the hot record/publishes
  loadAfterSnapshot?: Gate & { enter(): Promise<void> };    // the snapshot is taken first, so the returned prefix is fixed
  appends = 0; loads = 0;
  async append(id: string, exp: number, ev: Parameters<EventLog['append']>[2]) {
    this.appends++;
    const g1 = this.appendBeforeCommit; this.appendBeforeCommit = undefined; if (g1) await g1.enter();
    const head = await this.inner.append(id, exp, ev);
    const g2 = this.appendAfterCommit; this.appendAfterCommit = undefined; if (g2) await g2.enter();
    return head;
  }
  async load(id: string) {
    this.loads++;
    const snap = await this.inner.load(id);
    const g = this.loadAfterSnapshot; this.loadAfterSnapshot = undefined; if (g) await g.enter();
    return snap;
  }
  exists(id: string) { return this.inner.exists(id); }
}

/** InMemoryConnection drops sends after close (transport.ts:46-48); record every attempt so "no frame after close" is observable. */
class RecordingConnection extends InMemoryConnection {
  readonly attempts: { t: string; afterClose: boolean }[] = [];
  private isClosed = false;
  override send(msg: any) { this.attempts.push({ t: msg.t, afterClose: this.isClosed }); super.send(msg); }
  override close(c?: number, r?: string) { this.isClosed = true; super.close(c, r); }
}

/** Bus spy: every game-channel publication, in order. */
const spy = (bus: InMemoryPubSub, id: string) => { const seen: any[] = []; bus.subscribe(gameChannel(id), (m) => seen.push(m)); return seen; };
```

**Gate design**
- Each gate is one-shot: its hook clears itself before waiting, so only the targeted call pauses.
- Assertions wait on `gate.entered` (a real barrier) before acting, and call `release()` explicitly.
- `flush()` only drains continuations that have already settled. It is never a timing guess.

## 2. Control A: an owner command paused around the durable append, while a fresh join/resume read runs

**Risk in the candidate:**
- A read path that installs its replay into the busy `GameSlot` (`refreshSlot` replaces `slot.record`, `authority.ts:341-353`).
- A read that returns the command's uncommitted events.
- A second append, publish, or `commandConfirmed` for the same command.

On main, `commit` appends first and only then sets `rec.game`, `persistedSeq` and the broadcasts, then publishes (`authority.ts:619-656`).

**Setup:**
- One authority acts as owner and serves the gateway (`new GameAuthority(bus, () => 1000, log)` plus `new RealtimeGateway(owner, bus, verifier, () => 1000)`).
- Create the game, then play `e2e4` and `e7e5` (revision 2).
- A spectator connection `c` joins.

```ts
// A1: paused BEFORE the durable append
const gA1 = gate(); log.appendBeforeCommit = gA1;
const busSeen = spy(bus, id);
const cmd = owner.apply(id, 'alice', { kind: 'move', uci: 'g1f3' }, { requestId: 'r03-exact' });
await gA1.entered;                                 // the command is now inside append, before anything is durable
c.deliver({ t: 'resume', gameId: id, lastPly: 0 }); await flush();
const r1 = c.last('resumed')!;
assert.equal(r1.state.stateRevision, 2);            // uncommitted revision 3 is never admitted
assert.equal(r1.missed.filter((m: any) => m.t === 'move').length, 2);
assert.equal(busSeen.length, 0);                   // nothing published while the command is not yet durable
gA1.release(); const res = await cmd;
assert.equal(res.state.stateRevision, 3);
assert.equal(log.appends, 3 /*create+2 moves*/ + 1);     // exactly one append for the command
assert.deepEqual(busSeen.map((m) => m.t), ['move', 'commandConfirmed']); // each exactly once (R-03 receipt identity preserved)
assert.equal(busSeen[1].requestId, 'r03-exact');
assert.equal(owner.getState(id).stateRevision, 3);  // hot record not overwritten by the read's older replay
// The persisted head stayed correct: a follow-up command appends at expectedSeq 3, with no EventLogConcurrencyError.
await owner.apply(id, 'bob', { kind: 'move', uci: 'b8c6' });
assert.equal((await log.inner.load(id)).length - 1, 4);

// A2: same scenario, but paused AFTER the durable append (log head 3, hot record still 2, nothing published yet)
//   const gA2 = gate(); log.appendAfterCommit = gA2; start the same command; await gA2.entered; resume; flush.
//   Allowed: r.state.stateRevision ∈ {2, 3} (both are durably committed prefixes; 3 is only durable, not yet published).
//   Coherence: r.state.moves.length === r.state.ply === r.missed.filter(m => m.t === 'move').length,
//              and r.state.ply === r.state.stateRevision here (this fixture has only moves after creation).
//   After release: same single-append, single-publish and single-confirmation assertions; owner.getState revision 3.
```

**Expected on current main (source-derived, not run):** **PASS.**
- The owner's `hasFresh` is true, so the read serves the untouched hot record (revision 2), and the commit lands afterwards.
- This is a **regression guard**: the candidate must keep it green.
- Under A2, a candidate whose replay *installs* into the slot would hit one of two failures:
  - it rolls back `persistedSeq`, causing an `EventLogConcurrencyError` on the next command;
  - or it doubles the history.

## 3. Control B: a new commit after the chosen load prefix

**Risk in the candidate:**
- `state` and `missed` are taken from different reads or snapshots, so the returned prefix is incoherent.
- Or the test demands the impossible "latest at delivery".

**Setup:**
- Writer authority `W` (owner) and a non-owner edge `E` with its gateway share `DeferredLog` and the bus.
- The writer reaches revision 2.
- The edge connection joins, which loads and caches revision 2.
- To force a fresh read on main as well, call `E.evict(id)` and keep the session joined.

```ts
const gB = gate(); log.loadAfterSnapshot = gB;      // the next load snapshots revision 2, then waits
c.deliver({ t: 'resume', gameId: id, lastPly: 0 }); // on main: !hasFresh → ensureLoaded → refreshSlot → store.load
await gB.entered;                                    // the snapshot is fixed at revision 2
await W.apply(id, 'alice', { kind: 'move', uci: 'g1f3' }); // durable revision 3, published to the room
const liveRev = c.last('move')!.stateRevision;       // 3: arrives on the room BEFORE the resume reply
gB.release(); await flush();
const r = c.last('resumed')!;
// Oracle: one coherent prefix. "latest at delivery" is NOT required.
assert.ok([2, 3].includes(r.state.stateRevision));
assert.equal(r.missed.filter((m: any) => m.t === 'move').length, r.state.ply);   // missed and state from the same prefix
assert.deepEqual(r.state.moves.slice(0, 2), ['e2e4', 'e7e5']);
assert.equal(r.state.moves.length, r.state.ply);
assert.equal(liveRev, 3);                             // documents the ordering hazard: a live revision-3 frame, then a revision-2 resume
```

**Expected on current main:** **PASS.**
- `getState` and `getMissedSince` read one installed record, so the prefix is coherent.
- The returned revision is 2.

**Out of scope here:**
- The ordering hazard (a live revision-3 broadcast, then a revision-2 `resumed`) is real. It is the D1-B client revision floor (C01–C03), not a server requirement in this control.
- Do not assert `r.state.stateRevision === 3`.

For the candidate: if it loads `state` and `missed` with two separate `load()` calls, put the gate on the **second** load only, and expect the coherence assertion to fail. That is the falsification probe for this control.

## 4. Control C: an asynchronous fresh recovery load completes after leave, socket replacement or auth revocation

**Risk in the candidate:**
- A replay that completes late sends a stale `joined`/`resumed`.
- It recreates a room, subscription, or `onGameLoaded` for a departed session.
- It verifies the token *before* waiting, and so admits a token revoked during the load.

The existing guards on main:
- `completeJoin` checks that the session is still the same (`gateway.ts:189`) and verifies the token **after** loading (`gateway.ts:192-205`).
- `completeResume` re-checks the session and its membership (`gateway.ts:335`).
- `onClose` tears down the room and calls `onGameUnloaded` (`gateway.ts:344-360`).
- There is no client `leave` message; leaving means closing the connection.

**Setup:**
- A cold edge (`E` never loaded, or evicted) with its gateway, a `RecordingConnection` `c1`, and `log.loadAfterSnapshot = gC`.
- A mutable verifier: `let valid = true; const verifier = { verify: (t: string) => (valid && t === 'tok-alice' ? { userId: 'alice' } : null) }`.
- Spies: `onGameLoaded` and `onGameUnloaded` counters, passed to the `RealtimeGateway` constructor.

```ts
// C1: close while the load is in flight
const gC = gate(); log.loadAfterSnapshot = gC;
c1.deliver({ t: 'join', gameId: id, token: 'tok-alice' }); await gC.entered;
c1.close();
gC.release(); await flush();
assert.equal(c1.attempts.filter((a) => a.afterClose).length, 0); // no frame attempted to the departed session
assert.equal(gw.hasLocalSessions(id), false); assert.equal(gw.roomCount, 0);
assert.equal(loadedCalls, 0);                                     // no resurrection of a room or subscription

// C2: socket replaced (same user, new connection) while the first load is in flight
const c2 = new RecordingConnection(); gw.handleConnection(c2);
//   join on c1 (gated), close c1, join on c2 (the second load may also be gated with its own gate), release both in reverse order.
//   Expect: c2 receives exactly one `joined` for alice (role white); c1 attempted nothing after its close;
//   room size 1 (only c2); readiness is routed at most once per completed join, and the durable `PlayerReady` is unique (domain idempotence).

// C3: auth revoked during the load (fresh fixture: cold edge again, new RecordingConnection c1b)
const gC3 = gate(); log.loadAfterSnapshot = gC3;
c1b.deliver({ t: 'join', gameId: id, token: 'tok-alice' }); await gC3.entered;
valid = false; gC3.release(); await flush();
assert.equal(c1b.last('joined'), undefined);
assert.equal(c1b.last('reject')?.code, 'unauthorized');          // verification happens at completion, not before the await

// C4: a resume pending when the session closes
//   join, then evict, then resume (gated load), then close, then release.
//   Expect: no `resumed` attempted after close; room torn down.

// R-03 receipt check (same file): while a resume load is gated on a non-owner, the owner applies a command with requestId 'r03-c'.
//   Expect: exactly one bus `commandConfirmed{requestId:'r03-c'}`; the delayed resume adds none and emits no outcomeUnknown.
```

**Expected on current main:** **PASS** for C1–C4 and the R-03 check.
- The session-identity and membership re-checks drop late completions.
- Token verification runs in `completeJoin` after the load.
- Reads never publish `commandConfirmed`.

These are regression guards: the candidate must keep each one green.

## 5. Notes for the harness owner

- Put these in a **new** external file using the same `register` prepare/oracle split, so that gate wiring or import failures stay `SETUP_FAILURE` and never count as RED.
- These controls are expected to PASS on main. A failure there means a harness bug, not D1-A evidence.
- They exist to catch candidate regressions. Pair them with the S01–S05 REDs, which the candidate must turn green.
- Every gate is a promise barrier. There are no timers or `sleep`s; `flush()` only drains settled continuations.
- Out of scope: PostgreSQL MVCC, Redis ownership fencing, D2 draw fanout, and the D1-B client revision floor.

**Disposition:** the three missing boundary controls are specified, with seams, barriers, baseline expectations and falsification probes. Nothing was executed and nothing was edited. Stopped.
