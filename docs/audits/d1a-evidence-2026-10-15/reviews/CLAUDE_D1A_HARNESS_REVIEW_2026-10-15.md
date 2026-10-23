# D1-A current-main harness — independent test-quality review (Claude, read-only)

Artifact reviewed: `D1A_CURRENT_MAIN_REPRO_2026-10-15/` (`harness.ts`, `ORACLE_PROPOSAL.md`, `run.json`,
`raw-results.tap`, `observations.ndjson`, `source-manifest.json`, `prepare-setup-failure-01.json`, the frozen sources).

What this review was: source inspection, plus a read-only re-hash of the frozen sources.
What it was not: I re-ran nothing, built nothing, and made no edits, commits or services calls. The harness belongs to Codex2.
Scope: harness validity, source binding, raw attribution, and whether each test's intent matches the failure it records.
Excluded: the production client oracle (Pi) and the server oracle (Gemini).

## 1. Source binding and attribution: VALID

- **Source binding.** `source-manifest.json` has baseline `4ccf8f48869335e06ac1b1de467d2161869f8fd7` and lists 42 files.
  I re-hashed every file under `frozen-src/`: **42/42 SHA-256 match**.
  `run.json` records `frozenSourcesUnchanged: true`, along with the bundle, harness and runner SHA-256 values.
- **Which checkout.** The run used checkout `<REPOSITORY>` at `dbf44d9…`.
  Its status was clean before and after, and `run.json` records `originMain` = `4ccf8f4`.
  The frozen sources come from main's objects, not from that checkout's tree; the proposal discloses this.
- **Earlier setup failure.** One prior run failed in setup with an esbuild resolve error
  (`@chess-platform/realtime-gateway/latency`, `../api/models.js`).
  It is recorded separately as `setup: FAIL` (`prepare-setup-failure-01.json`) and earned no RED credit.
  The run being reviewed had `setup: PASS`.
- **Raw consistency.** `testExit 1`, `testSignal null`, `spawnError null`, and `raw-stderr.log` is empty.
  The TAP output shows `ok` for 1–4 and 13–15, and `not ok` for 5–12.
  This matches `run.json` (7 PASS, 8 BEHAVIORAL_RED) and the `observations.ndjson` rows one-for-one.
- **Classification wrapper** (`harness.ts:21-34`).
  - Failures inside `prepare`, including setup assertions such as `join()`/`resume()` `assert.ok`, are recorded as `SETUP_FAILURE`.
  - Only an `AssertionError` raised inside `oracle` for a `CANDIDATE` is recorded as `BEHAVIORAL_RED`.
  - Non-assertion errors are recorded as `SETUP_FAILURE`.
  - None of the 8 REDs is an import, codec or fixture error: each observation holds a decoded message with concrete values.
- **Side effects.** Everything is in memory: `InMemoryEventLog`, `InMemoryPubSub` and `InMemoryConnection`.
  There is no network, DB or Redis.
  The client's socket goes through `FakeSocket` (`url wss://unused.invalid`).
  Writes are limited to the `D1A_OBSERVATIONS` file in the artifact directory.

## 2. Production semantics the REDs rely on (frozen source, verified)

- `GameAuthority.applyNow` publishes broadcasts itself, after the durable commit (`authority.ts:649-654`).
  So in the harness, `writer.apply(...)` really does emit on the shared bus; no payload is faked.
- `InMemoryPubSub.publish` delivers synchronously (`pubsub.ts:57-61`), so causality inside one turn is deterministic.
- In the gateway, a room subscription only **forwards** bus messages to connections (`gateway.ts:367`).
  It never updates the edge authority's hot record.
- `onJoin` and `onResume` serve from the hot cache whenever `hasFresh(gameId)`.
  They do this synchronously, with no reload: `gateway.ts:172-174` for join, and `321` → `completeResume` at `334-342` for resume.
- `completeResume` returns `authority.getState` / `getMissedSince` from that cache.
- Only commands re-validate the cache (`authority.ts:494`, `slot.record?.stale` → `refreshSlot`).
- `reloadFromLog` is documented as the takeover path (`authority.ts:317-327`); it is not called on read paths.

## 3. Case-by-case verdict

| ID | Recorded | Verdict | Evidence / attribution |
|---|---|---|---|
| F01 | PASS | **Valid control** | Revisions are `[0..5]` and equal to the log `seq`; plies are `[0,1,2,2,2,2]`; draw broadcasts are `[0,0]`. This establishes same-ply seq advance and that no draw broadcast exists. |
| F02 | PASS | **Valid control** | Real move+terminal batch with broadcast revisions `[1,2]`; legal moves appear only on the intermediate frame; the terminal state is 2; evict+reload replays it identically. |
| F03 | PASS | **Valid control** | The real revision codec rejects `-1, 0.5, '0', null, 2^31`, and handles a frame without a stamp correctly in each mode. |
| F04 | PASS | **Valid control** | A cold authority on the same backing log reproduces the writer's terminal state, with missed = `move, move, ended`. This proves the shared log holds the newer state. It runs in a separate fixture, though (see §4.1). |
| S01 | RED | **Valid server RED** | Warm edge, then the writer commits two moves, then a spectator joins. Real `joined` shows **rev 0 / ply 0 / 0 moves**, against rev 2 expected; `hot:true`, `additionalLoads:0`. This matches `gateway.ts:172` serving a stale hot cache. |
| S02 | RED | **Valid server RED** | Same root cause on resume: real `resumed` shows rev 0, against rev 2 committed. The connection was in the room while the moves were committed, so it got the move broadcasts live; the resume snapshot then **regresses** below what the client already saw. |
| S03 | RED | **Valid but derivative** | `missed: []`, where `[move, move]` was expected. Same stale cache as S02 (it reads `getMissedSince` from rev 0). It is not an independent defect, so don't count it as a separate root cause. |
| S04 | RED | **Valid server RED** | The edge `reloadFromLog`s to rev 2 and joins; the writer then makes a draw offer (rev 3, ply 2). Real `resumed` shows rev 2 with `drawOffer: null`. Since draw offers have no broadcast (F01), only a fresh read could show it. |
| S05 | RED | **Valid server RED** | Same setup, then a real resign at rev 3. The real `ended` broadcast **was** published and forwarded to the room, yet `resumed` reports rev 2 with `over: false`. A server read path reopening a terminal game is the most serious server finding. |
| C01 | RED | **Valid client RED, real stimulus** | The stale frame is the **actual gateway `resumed`** from the edge (rev 0), not a hand-made payload. `GameSync`, holding a snapshot at rev 2, falls back to rev 0 / ply 0 / no moves. |
| C02 | RED | **Valid client RED, synthetic ordering** | `GameSync` accepts an older same-ply full `state` (rev 2 after rev 3) and erases `drawOffer`. The state body is genuine authority output; the `{t:'state'}` envelope and the arrival order are hand-built. That is valid for the D1-B client revision floor, but not an end-to-end reproduction. |
| C03 | RED | **Valid client RED, synthetic envelope** | A hand-built `resumed` carrying rev-2 state after a terminal rev-3 snapshot reopens the game. The real server does emit such a frame (S05), but C03 does not use that emitted message, and its `missed: []` differs from the real `missed` (2 items). |
| F05 | PASS | **Valid control** | Server close, then scheduled reconnect, then `joined` as white with an **equal** revision: role and colour accepted, snapshot unchanged. This shows the client defects concern *lower* revisions, not equal-revision acknowledgements. |
| F06 | PASS | **Correctly labelled characterization** | `GameSync` ignores `resumed.missed`. Recorded as a limitation, not a pass on replay. |
| F07 | PASS | **Valid control** | Neither an equal nor a newer plain `state`, nor an unrelated `commandConfirmed`, clears `outcomeUnknown`. Only the exact `requestId` does, with no resend (1 move request). |

**Bottom line:**
- Valid server REDs: S01, S02, S04, S05, plus S03 as a derivative of S02.
- Valid client REDs: C01 (real stimulus), C02 and C03 (synthetic ordering or envelope).
- No case is invalid, a setup-only failure, or an artefact of the harness.
- No RED is an inverted assertion: every oracle asserts the desired contract, and the failure values in the observations match the intent.

## 4. Limitations and minimal corrections (none invalidates a RED)

1. **No in-case durable control in S01/S02/S04/S05.**
   Each case checks the writer's returned state, while the proof that the shared log holds that state lives only in F04.
   - Minimal correction: at the end of each `prepare`, add an independent cold read:
     `const cold = new GameAuthority(f.bus, () => 1000, f.backing); assert.equal(await cold.ensureLoaded(params.gameId), true);`
     and record `cold.getState(...).stateRevision`, asserting it equals `expected.stateRevision`.
   - This keeps every RED self-contained. It is a hardening step, not a correction to any result.
2. **C03 fidelity.**
   - Minimal correction: build C03's stale frame from the real gateway output, as C01 does. Reproduce the S05 sequence and pass the actual `resumed`, with its real `missed`, to `deliver()`.
   - C02 can stay synthetic, but label it "client revision floor (synthetic ordering)", not an end-to-end stale-server scenario.
3. **S03 accounting.** Report it as a consequence of S02, not as an independent root cause.
4. **What the setup proves, and what it doesn't.**
   - The two-authority, one-log model is a hermetic seam. It shows that a warm **non-owner** cache answers join/resume stale.
   - It does not show that production routing lets a non-owner node serve those reads, which depends on ownership/fencing in the Redis/PG deployment.
   - The proposal already says this ("not PostgreSQL/Redis ownership/MVCC proof"); keep that qualification next to any severity claim.
5. **Timing.** `ORACLE_PROPOSAL.md` still labels the cases "NOT executed yet". That is stale now that `run.json` exists; this is an editorial note only.

## 5. Disposition

The harness is valid for its stated, hermetic purpose.
- Its attribution is clean.
- Its source binding is verified (42/42 hashes).
- Every one of the 8 REDs records a behavioural failure that matches the intended contract.
- All controls pass for the right reasons.

Recommended hardening is §4.1 and §4.2. These are test-only and belong to Codex2; I made no changes.
I hold no D1 production-fix authority, and this is not an executed reproduction by me.
