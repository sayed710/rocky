# D1-A actual harness review

**Reported baseline:** `4ccf8f48869335e06ac1b1de467d2161869f8fd7`.

**Verdict:** C01–C03 are valid **baseline client-boundary behavioral REDs**, consistent with the reviewed production `GameSync`. F05 and F07 are sound controls. F06 needs a narrower interpretation or a coherent replacement fixture. There is also one important C01 comparison trap when testing a server-only candidate.

I reviewed the supplied source and execution receipts; **I did not execute or independently reproduce them**.

## 1. Receipt and attribution limits

`run.json` and TAP agree on:

- Six controls plus one characterization passing;
- S01–S05 and C01–C03 failing their oracle assertions;
- No reported setup failure, cancellation or skip.

The failing assertions are inside the oracle stage, not the preparation stage. Exit 1 alone is not the evidence; the specific assertion failures are.

The manifest correctly distinguishes the inspection checkout at `dbf44d9…` from the selected frozen baseline at `4ccf8f4…`. However, `run.mjs`, the complete frozen-source manifest and observation JSONL are not attached here. I cannot independently verify extraction, hashes or bundling. Attribution remains supplied evidence.

`ORACLE_PROPOSAL.md` still says “NOT executed yet.” Retain it as a pre-execution proposal, but do not present that heading as the current execution status.

## 2. Actual client path and fixture validity

**Locations:** `harness.ts`, `checked()`, `client()`, C01–C03.

The client cases:

1. Instantiate production `WsClient` and `GameSync`.
2. Subscribe through `sync.start()`.
3. Open the fake socket.
4. Deliver a joined acknowledgment.
5. Assert connection and initial snapshot revision.
6. Deliver the tested frame through `FakeSocketFactory`, rather than calling private `GameSync` methods.

`checked()` first round-trips every delivered frame through production `encode` and strict revision decoding. The frame then enters the fake-socket/WsClient path. That strict precheck **does not mean WsClient itself was configured in strict mode**, but it excludes malformed revision payloads from these stimuli.

C01–C03 have no reconnect between initial acknowledgment and tested delivery. They therefore do not depend on an obsolete-socket callback or disputed reconnect generation. They also submit no optimistic command, so they cannot be explained by a synchronous send/reply pending-state artifact.

The complete snapshots come from actual authority results, not handcrafted board state.

## 3. C01–C03: accept the baseline REDs, with precise scope

| Case | Stimulus | Assessment |
|---|---|---|
| **C01** | Fresh revision-2 joined snapshot, then an actual warm-gateway resumed response | Valid message-boundary rollback witness. TAP fails the lower-revision predicate at bundled `harness.cjs:4059`. |
| **C02** | Actual draw snapshot revision 3, then actual earlier same-ply snapshot revision 2 wrapped as `state` | Valid same-ply stale-snapshot witness. TAP records `null !== 'w'` at `:4074`. |
| **C03** | Actual terminal snapshot, then earlier live snapshot wrapped as `resumed` | Valid terminal reopening witness. TAP records `false !== true` at `:4088`. |

The supplied `GameSync.applySnapshot` explains all three: it replaces the snapshot fields without checking a revision floor.

C02/C03 construct ordinary protocol envelopes around genuine snapshots. Those are not invalid handcrafted game states. They are injected ordering tests, however—not proof that those exact envelopes were emitted in that order by one production gateway connection.

Likewise, C01 transplants a real gateway response into a separate client fixture. It demonstrates client handling of that response, not a complete single-session browser request/server-response trace.

The helper checks initial connection and revision. For stronger recorded witnesses, preparation could additionally assert the relevant initial ply/moves, draw offer or terminal status before stale delivery. The reviewed `applySnapshot` source supports their correctness here; this omission does not invalidate the present REDs.

### Important C01 server-candidate trap

C01 obtains its supposedly stale stimulus dynamically:

```ts
const stale = resume(f);
```

A server-only freshness repair may make that response revision 2. C01 could then pass **without any client monotonicity protection**, because the older stimulus disappeared.

For comparative client-oracle runs, either:

- Preserve the baseline older response as a fixed, codec-checked stimulus; or
- Capture a legitimate older resumed response before the later writer commits, then deliver it after initializing the client with the newer snapshot.

Assert the stimulus is genuinely older during preparation. Otherwise, a C01 pass must be described as **server freshness eliminating this stimulus**, not a client-floor repair.

C02/C03 already retain their older snapshots independently of the tested recovery path.

## 4. F05: valid equal-revision membership control

**Location:** `register('F05')`.

The sequence closes the first socket, observes disconnection, advances the manual reconnect scheduler, opens the current socket, and delivers equal-revision `joined` with role `white`.

It correctly asserts:

- Connection restored;
- Role and wire color updated;
- Snapshot preserved.

This guards against a future “drop every revision ≤ current” implementation that accidentally discards membership acknowledgment.

One optional hardening makes the **new-socket/generation claim explicit**: save the first socket and generation, then assert a different current socket and changed generation before delivering the new acknowledgment. The present test invokes the intended real reconnect lifecycle, but does not independently assert those identities.

It does not test stale-generation rejection; do not claim that coverage.

## 5. F06: codec-valid, but not a coherent recovery cut

**Location:** `register('F06')`.

It sends:

- Complete snapshot revision 0, ply 0;
- `missed` containing a move at revision 1, ply 1.

Strict decoding accepts this according to the supplied passing receipt. Nevertheless, the snapshot is behind the history bundled with it. This is not a coherent complete-snapshot recovery response.

Therefore:

- It validly characterizes what current `GameSync` does with this **inconsistent input**.
- It does not establish a production-reachable resume sequence.
- It is not another behavioral RED—and the harness correctly does not count it as one.

**Minimum correction:** relabel its documentation as an inconsistent-input characterization.

Alternatively, use `one.state` with `one.broadcasts`, then assert the final state equals the snapshot and no extra resume is emitted. That tests coherent snapshot-authoritative handling. Do not claim that final state alone proves absence of every internal replay/animation operation.

This qualification does **not** invalidate C01–C03 or the eight reported REDs.

## 6. F07: accept exact-receipt and no-replay control

**Location:** `register('F07')`.

The move is submitted before any response is injected. The fixture then explicitly delivers uncertainty and snapshots, so there is no reply-inside-`send()` artifact.

It correctly distinguishes:

- Equal snapshot: uncertainty remains;
- Newer ordinary snapshot: uncertainty remains;
- Unrelated receipt: uncertainty remains;
- Exact matching receipt: notice clears;
- Only one move request was sent.

The separate writer does not generate the exact receipt for this client request; that receipt is deliberately injected. Thus this is a client receipt-handling control, not end-to-end command execution or receipt-generation proof.

Terminal and identified-ready settlement remain outside this control, as intended.

## 7. Scope disposition

- **S01–S05:** server freshness/history recovery assertions.
- **C01–C03:** prospective client monotonicity assertions, not guarantees introduced by #112.
- **F05:** equal-revision membership compatibility.
- **F07:** exact uncertainty identity and no command replay.
- **F06:** characterization requiring the qualification above.

**Do not require C01–C03 GREEN from the server-only S01–S05 candidate.** Conversely, do not credit C01 GREEN as client protection if its dynamically obtained stimulus is no longer older.

No production D1 implementation authorization, database/Redis proof, deployment safety certification or current CI clearance follows from this review. Codex 2 retains the external-harness/candidate scope.

**Bounded actual-harness review complete. Stopped.**
