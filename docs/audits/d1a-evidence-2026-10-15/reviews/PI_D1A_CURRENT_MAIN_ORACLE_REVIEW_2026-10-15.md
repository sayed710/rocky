# D1-A — current-main oracle check

**Session:** `01a134ec-852d-7699-9aec-d55d8ce3e59b`  
**Source attribution:** main `4ccf8f48869335e06ac1b1de467d2161869f8fd7`, supplied, not independently verified.

**Critical conclusion:** #112 supplies durable revisions and wire validation, but the supplied production `GameSync` **does not compare revisions when applying snapshots or broadcasts**. Do not import a lower/equal-revision suppression invariant into this reproduction.

All findings below are source deductions. No harness or tests were executed.

## 1. What is actually guarded

| Behavior | Current source |
|---|---|
| Malformed revision bounds/types | Foundation decoder tests require rejection. Snapshot revision zero is valid; ended-event revision zero is invalid. |
| Missing revision | Accepted in legacy mode; rejected in explicit revision mode. Do not assume production WsClient selects strict mode—the supplied source does not establish that. |
| Lower-revision `state`/`resumed` snapshot | **Applied unconditionally** while connected. |
| Equal-revision snapshot | Applied; clears optimistic pending state and updates the supplied snapshot fields. |
| Equal-revision `joined` | Can establish connection/role. No revision comparison. |
| Revision-based move ordering | Absent. `applyMove` checks **ply equals current ply + 1**. |
| Duplicate/gapped move | Requests `resume`; does not apply the move. |
| Readiness broadcast | OR-merges readiness; a late false cannot undo a known true. |
| Readiness snapshot | Explicit readiness replaces current readiness. It can undo a known true. Missing readiness preserves it; explicit null clears it. |
| Terminal notification | `applyEnded` applies without comparing revision or timestamp. |
| Snapshot following terminal notification | Can reopen the game; no terminal or revision floor prevents it. |
| Exact command uncertainty | Ordinary position/revision equality does not settle it. Exact receipt, terminal state, and identified-ready satisfaction have separate handling. |

**Locations:** `packages/web/src/net/game-sync.ts`, `handleMessage`, `applySnapshot`, `applyMove`, `applyEnded`, `reconcileUncertainty`.

`GameSyncState` has **no top-level `stateRevision`**. Its `snapshot.stateRevision` describes the last full snapshot, not subsequent live broadcasts.

## 2. Minimal server-freshness oracle

Use the existing public authority APIs and shared `InMemoryEventLog`. Separate pubsubs intentionally drop cross-authority fanout.

```ts
const store = new InMemoryEventLog();
const a = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);
const b = new GameAuthority(new InMemoryPubSub(), () => 1_000, store);

await a.createGame(params); // foundation params: alice/bob, ordinary game
await a.apply(params.gameId, 'alice', { kind: 'move', uci: 'e2e4' });
await a.apply(params.gameId, 'bob', { kind: 'move', uci: 'e7e5' });

assert.equal(await b.ensureLoaded(params.gameId), true);
const before = b.getState(params.gameId);
assert.equal(before.stateRevision, 2);
assert.equal(before.ply, 2);
assert.equal(before.drawOffer, null);

const changed = await a.apply(params.gameId, 'alice', { kind: 'offerDraw' });
const durable = await store.load(params.gameId);
assert.deepEqual(durable.map(e => e.seq), [0, 1, 2, 3]);
assert.equal(changed.state.stateRevision, 3);
assert.equal(changed.state.ply, 2);
assert.equal(changed.state.drawOffer, 'w');
```

These commands mirror the known-valid REV-01 sequence rather than assuming an offer before any moves is valid.

Next, capture the **actual gateway join/resume response** from the warm authority path:

```ts
assert.equal(reply.state.stateRevision, 3);
assert.equal(reply.state.ply, 2);
assert.equal(reply.state.drawOffer, 'w');
```

This is the prospective **server-freshness regression assertion**. A captured revision-2 response after that completed append is a genuine stale-response witness.

Do not:

- substitute `b.getState()` for an actual gateway response and call it a join/resume reproduction;
- evict/reload `b` before the tested response;
- require a nonexistent current `readHead` method;
- count interface/compiler/setup failure as behavioral RED.

The gateway handler source is not in this bundle, so the exact reply must remain an observed harness result, not an asserted reproduction here.

## 3. Client rollback is a separate oracle

Use `before` and `changed.state` above as complete, genuine snapshots. Deliver through the subscribed WsClient message callback, preferably after decoding.

The local fixture’s `deliver` is **not a production API**:

```ts
const decode: (
  frame: string,
  mode?: 'legacy' | 'revision'
) => ServerMessage | null = decodeServer;

const deliver = (frame: unknown): void => {
  const parsed = decode(JSON.stringify(frame), 'revision');
  assert.ok(parsed, 'oracle payload must pass the real decoder');
  received.message?.(parsed); // captured from the fixture's client.on(...)
};
```

Start `GameSync` through `start()`, open the fixture socket, and observe its join before delivering:

```ts
deliver({
  t: 'joined', gameId: params.gameId, role: 'white',
  state: changed.state,
});
assert.equal(sync.getState().snapshot?.stateRevision, 3);
assert.equal(sync.getState().drawOffer, 'w');

deliver({
  t: 'resumed', gameId: params.gameId,
  state: before, missed: [],
});

// Current-client characterization, not desired future behavior:
assert.equal(sync.getState().snapshot?.stateRevision, 2);
assert.equal(sync.getState().drawOffer, null);
assert.equal(sync.getState().ply, 2);
```

**Current control:** those assertions follow the supplied implementation.  
**Prospective client monotonicity RED:** asserting revision remains 3 would fail under this implementation. That is not proof that D1-A alone owns or implements a client ordering policy.

A client receiving only revision 2 has not “rolled back” from revision 3. It may still have received a stale server snapshot. Keep those witnesses separate.

Also, `resumed.missed` is ignored by `GameSync`; do not assert animation/replay from that array.

## 4. Equal-revision acknowledgment must remain distinct

For a valid reconnect test:

1. Emit the fixture’s non-open state event.
2. Reopen with an updated socket generation.
3. Observe the new join request.
4. Deliver `joined` at the same revision, possibly with a different authorized role.

For example, after a fresh join is awaiting acknowledgment:

```ts
deliver({
  t: 'joined', gameId: params.gameId, role: 'spectator',
  state: changed.state,
});
assert.equal(sync.getState().connected, true);
assert.equal(sync.getState().role, 'spectator');
assert.equal(sync.getState().myColor, null);
assert.equal(sync.getState().snapshot?.stateRevision, 3);
```

Do not require equal-revision `joined` to be ignored: its membership envelope matters.

A `joined` frame is also accepted while already connected. Use an actual reconnect/request lifecycle for the membership control rather than exploiting that permissive path accidentally.

With equal ply on reconnect, `handleMessage('joined')` does not send the additional ply-based resume. It does not compare revisions to decide that.

## 5. No-op and uncertainty controls

### No-op readiness

The supplied authority REV-02 test establishes:

```ts
const white = await authority.apply(id, 'alice', { kind: 'ready' });
const repeated = await authority.apply(id, 'alice', { kind: 'ready' });

assert.equal(repeated.state.stateRevision, white.state.stateRevision);
assert.deepEqual(repeated.events, []);
assert.deepEqual(repeated.broadcasts, []);
```

Use a seek-created game as that test does.

There is no public `GameSync.ready()` in the supplied class. Do not invent one. Nor does REV-02 establish receipt publication for a repeat with request metadata—the test supplies no request ID.

### Snapshot acknowledgment does not prove execution

On a connected, nonterminal client with no pending intent:

```ts
assert.equal(sync.resign(), true);

deliver({
  t: 'outcomeUnknown', code: 'outcome_unknown',
  gameId: params.gameId, ref: null,
  requestId: 'oracle-request', message: 'Outcome unknown.',
});

deliver({ t: 'state', gameId: params.gameId, state: changed.state });

assert.equal(sync.getState().pendingAction, null);
assert.equal(sync.getState().lastReject?.t, 'outcomeUnknown');
assert.equal(sync.getState().lastReject?.requestId, 'oracle-request');

deliver({
  t: 'commandConfirmed', gameId: params.gameId,
  requestId: 'different-request',
});
assert.equal(sync.getState().lastReject?.requestId, 'oracle-request');

deliver({
  t: 'commandConfirmed', gameId: params.gameId,
  requestId: 'oracle-request',
});
assert.equal(sync.getState().lastReject, null);
```

Check that the command was not resent. **Do not require zero resume traffic**: uncertainty and confirmation can legitimately send resume requests.

“Only exact confirmation clears uncertainty” is too broad: terminal reconciliation clears uncertainty, and identified-ready satisfaction can clear a ready intent.

## 6. Terminal and readiness oracle traps

- Obtain an actual ended broadcast from an authority result rather than constructing an incomplete revisioned frame.
- `applyEnded` updates top-level status/legal moves, **not the stored snapshot**.
- A subsequent valid preterminal snapshot currently restores nonterminal status.
- Repeated ended frames invoke `patch` repeatedly. There is no terminal notification deduplication; do not assert exactly one subscriber notification.
- `applyEnded` clears `pendingAction`, but does **not** explicitly clear a pending move. A terminal snapshot does clear it.
- Live ready broadcasts merge monotonically; snapshots do not. Test those as separate paths.
- A move broadcast’s pending matching uses own color plus UCI, not exact request ID. It is not an exact execution receipt.

For live move-plus-ending, retain REV-03’s prefix oracle: move revision 1, ended revision 2, final snapshot revision 2. The move prefix can still have legal moves. Requiring every frame to carry the final revision or requiring revision to equal ply would be incorrect.

## 7. Harness discipline and disposition

The fake transport should record `send()` and deliver replies at explicit later barriers. Synchronously delivering a move reply inside `send()` can race `submitMove`’s subsequent pending-state installation and manufacture an optimistic-state artifact.

Deliver no ordinary messages before connection acknowledgment; `GameSync` ignores them while disconnected. Remove callbacks on unsubscribe. Preserve the distinction between:

- decoder controls already established by #112;
- expected warm-cache server-freshness RED;
- current client rollback characterization;
- future client ordering requirements.

**Oracle verdict:** valid stale-server assertions remain available, especially same-ply draw-state changes. Lower-revision client rejection, equal-revision suppression, terminal deduplication and snapshot readiness monotonicity are **not current-main guarantees**.

Codex 2 retains ownership of the external harness only. No D1 production implementation or new policy is authorized by this review. **Stopped.**
