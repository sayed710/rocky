# Independent Server-Oracle Review: D1-A Hermetic Reproduction Harness (S01–S05 / F01–F04)

**Evaluation Base:** Commit `4ccf8f48869335e06ac1b1de467d2161869f8fd7` (`origin/main`)  
**Harness Location:** `<ARTIFACT_ROOT>/D1A_CURRENT_MAIN_REPRO_2026-10-15/harness.ts`  
**Execution Receipts Reviewed:** `run.json`, `raw-results.tap`, `observations.ndjson`, `ORACLE_PROPOSAL.md`  
**Review Scope:** Strictly Server-Oracle Cases: F01–F04 (Controls) & S01–S05 (Candidate REDs)  
**Reviewer Role:** Independent Server Oracle Reviewer (Pi reviewing client GameSync; Claude reviewing harness structure; OpenCode reviewing source provenance)  
**Mode:** Strictly Read-Only (Receipt & source verification; NOT runtime executed by reviewer)

---

## 1. Executive Verdict

- **Control Cases F01–F04:** **ACCEPTED (PASS).** All 4 server control cases establish sound baseline invariants across discrete state revision progression, prefix-accurate move/terminal frames, wire revision codec discrimination, and cold rehydration truth.
- **Server Freshness Candidate REDs S01–S05:** **ACCEPTED (BEHAVIORAL_RED).** All 5 server candidate tests accurately reproduce authentic server-side stale emission defects on unmutated production code (`4ccf8f4`), driven by causality-validated fixtures rather than synthetic mock overrides.
- **Fixture & Protocol Invariant Compliance:**
  1. No invented D2 draw broadcast requirement: draw offer and decline are correctly treated as state-only revisions emitting zero broadcasts.
  2. Causality is strictly enforced: edge warming precedes completed writer appends.
  3. Real wire frames are decoded and asserted (`RealtimeGateway` -> `joined` / `resumed`).
  4. Node runner exited with exit code 1 due strictly to the 8 candidate assertion failures (`AssertionError`), with zero setup failures (`SETUP_FAILURE`).

---

## 2. Detailed Adjudication of Server Control Cases (F01–F04)

| ID | Title / Purpose | Execution Result | Mechanism & Source Rationale | Verdict |
| :--- | :--- | :---: | :--- | :---: |
| **F01** | State revision progression vs. same-ply draw/terminal | **PASS** | Validates `revisions` `[0,1,2,3,4,5]` matches exact event sequence `seq` `[0,1,2,3,4,5]`, while `plies` remains `[0,1,2,2,2,2]`. Explicitly asserts `drawBroadcasts: [0, 0]`, verifying that non-broadcast domain events increment `stateRevision` without emitting synthetic broadcasts. | **ACCEPT** |
| **F02** | Move + terminal batch frames & replay identity | **PASS** | Evaluates a 50-move terminal transition producing `MovePlayed` + `GameEnded`. Confirms `revisions: [1, 2]`, intermediate legal moves present on move prefix, empty on terminal state, and identical replay from durable log after eviction. | **ACCEPT** |
| **F03** | Revision wire codec validation & legacy mode | **PASS** | Validates that `decodeServer(..., 'revision')` strictly rejects non-safe or fractional integers (`-1, 0.5, '0', null, 2147483648`), while accepting valid integers and allowing unversioned frames only in legacy mode. | **ACCEPT** |
| **F04** | Cold edge durable positive control | **PASS** | Proves that an independent cold `GameAuthority` rehydrates the exact terminal state and broadcast log (`['move', 'move', 'ended']`) directly from the shared `InMemoryEventLog`. Demonstrates that backing log data is completely intact. | **ACCEPT** |

---

## 3. Detailed Adjudication of Server Candidate REDs (S01–S05)

### S01 — Warm Non-Writer Join After Moves
- **Harness Lines:** [`harness.ts#L115-L118`](../baseline/harness.ts#L115)
- **Observed Result:** `BEHAVIORAL_RED` (`AssertionError [ERR_ASSERTION]: 0 !== 2`)
- **Execution Telemetry:** `hot: true`, `additionalLoads: 0`, returned `stateRevision: 0`, expected `2`.
- **Causality & Seam Analysis:**
  1. `f.edge` warms at creation (`seq: 0`).
  2. `f.writer` commits `e2e4` (seq 1) and `e7e5` (seq 2) to shared `backing`.
  3. Client issues `{ t: 'join', gameId: 'd1a-current' }` to `f.gateway`.
  4. In `gateway.ts#L168`: `this.authority.hasFresh(gameId)` returns `true` because process-local memory is warm.
  5. `gateway.ts` bypasses all store reads (`additionalLoads === 0`) and emits `{ t: 'joined', state: { stateRevision: 0, ply: 0 } }`.
- **Verdict:** **ACCEPT.** Valid witness of stale join emission.

### S02 — Warm Non-Writer Resume After Moves
- **Harness Lines:** [`harness.ts#L120-L123`](../baseline/harness.ts#L120)
- **Observed Result:** `BEHAVIORAL_RED` (`AssertionError [ERR_ASSERTION]: 0 !== 2`)
- **Execution Telemetry:** `additionalLoads: 0`, returned `stateRevision: 0`, expected `2`.
- **Causality & Seam Analysis:**
  1. Client joins at `seq: 0`.
  2. Writer commits moves to `seq: 2`.
  3. Client sends `{ t: 'resume', gameId, lastPly: 0 }`.
  4. In `gateway.ts#L299`: `!this.authority.hasFresh(gameId)` evaluates to `false`.
  5. `completeResume` executes directly from the cached `GameRecord`, emitting `{ t: 'resumed', state: { stateRevision: 0 }, missed: [] }`.
- **Verdict:** **ACCEPT.** Valid witness of stale resume emission.

### S03 — Missed Broadcast History on Warm Non-Writer Resume
- **Harness Lines:** [`harness.ts#L125-L127`](../baseline/harness.ts#L125)
- **Observed Result:** `BEHAVIORAL_RED` (`AssertionError: Expected values to be strictly deep-equal: actual [] !== expected [move 1, move 2]`)
- **Causality & Seam Analysis:**
  1. Warm non-owner authority has empty `rec.broadcasts` from creation time.
  2. Resume at `lastPly: 0` invokes `edge.getMissedSince('d1a-current', 0)`.
  3. Returns `[]` instead of the 2 move broadcasts committed on writer.
- **Verdict:** **ACCEPT.** Valid witness of missed broadcast truncation.

### S04 — Same-Ply Draw Offer Snapshot Freshness
- **Harness Lines:** [`harness.ts#L129-L133`](../baseline/harness.ts#L129)
- **Observed Result:** `BEHAVIORAL_RED` (`AssertionError [ERR_ASSERTION]: null !== 'w'`)
- **Causality & Seam Analysis:**
  1. Setup uses `f.edge.reloadFromLog()` to establish a clean warm baseline at `ply: 2, seq: 2`.
  2. Writer applies `offerDraw` (advancing durable log to `seq: 3`, maintaining `ply: 2`).
  3. Client resumes on edge (`resume(f)`).
  4. Edge returns cached snapshot from `seq: 2` with `drawOffer: null` instead of `'w'`.
  5. Does not require a synthetic draw broadcast; correctly checks `state.drawOffer` in the resumed full snapshot.
- **Verdict:** **ACCEPT.** Valid witness of same-ply draw offer state loss.

### S05 — Same-Ply Terminal Resignation Snapshot Freshness
- **Harness Lines:** [`harness.ts#L135-L139`](../baseline/harness.ts#L135)
- **Observed Result:** `BEHAVIORAL_RED` (`AssertionError [ERR_ASSERTION]: false !== true`)
- **Causality & Seam Analysis:**
  1. Setup synchronizes edge to `ply: 2, seq: 2` via `reloadFromLog()`.
  2. Writer applies `resign` (advancing durable log to `seq: 3`, maintaining `ply: 2`, `status.over: true`).
  3. Client resumes on edge.
  4. Edge returns cached snapshot where `status.over === false` (active game).
  5. Demonstrates that a warm non-owner resume fails to observe same-ply game termination.
- **Verdict:** **ACCEPT.** Valid witness of same-ply terminal state loss.

---

## 4. Evaluation of Harness Structure & Fixture Integrity

1. **Isolation of Setup vs. Assertion Failures:**  
   In `harness.ts#L21-L34`, `register()` separates `prepare()` from `oracle()`. Any import, fixture, or connection failure produces `SETUP_FAILURE`. The 8 failures recorded in `run.json` and `raw-results.tap` were strictly `AssertionError` instances thrown in `oracle()`, confirming true behavioral RED status.
2. **Spectator Role Privilege Isolation:**  
   In `fixture()`, the token verifier returns `null`, assigning the connection role `'spectator'`. This ensures that join/resume calls do not trigger `commitReadiness` routing or lease acquisitions, keeping the edge node strictly passive.
3. **Absence of Mock Leakage:**  
   `InMemoryEventLog`, `GameAuthority`, and `RealtimeGateway` run their real production implementations from frozen source. No method on `GameAuthority` or `RealtimeGateway` is monkey-patched or bypassed.

---

## 5. Summary Table of Server Case Adjudications

| Test ID | Category | TAP Result | Root Cause In Current Main | Adjudication |
| :---: | :---: | :---: | :--- | :---: |
| **F01** | CONTROL | `ok 1` | Verified sequence progression and 0 draw broadcasts | **ACCEPTED (PASS)** |
| **F02** | CONTROL | `ok 2` | Verified multi-event batch prefix revisions | **ACCEPTED (PASS)** |
| **F03** | CONTROL | `ok 3` | Verified wire codec rejection of malformed seqs | **ACCEPTED (PASS)** |
| **F04** | CONTROL | `ok 4` | Verified cold reload matches writer state | **ACCEPTED (PASS)** |
| **S01** | CANDIDATE | `not ok 5` | `hasFresh` short-circuits `onJoin` | **ACCEPTED (BEHAVIORAL_RED)** |
| **S02** | CANDIDATE | `not ok 6` | `hasFresh` short-circuits `onResume` | **ACCEPTED (BEHAVIORAL_RED)** |
| **S03** | CANDIDATE | `not ok 7` | Stale `rec.broadcasts` returns empty missed | **ACCEPTED (BEHAVIORAL_RED)** |
| **S04** | CANDIDATE | `not ok 8` | Stale cache ignores same-ply draw offer | **ACCEPTED (BEHAVIORAL_RED)** |
| **S05** | CANDIDATE | `not ok 9` | Stale cache ignores same-ply resignation | **ACCEPTED (BEHAVIORAL_RED)** |

---

## 6. Recommendations for Candidate Patch Preparation

1. **Scope Bounding:** Codex 2's upcoming candidate patch must be strictly external and server-focused, targeting the head-verification seam (`EventLog` head check / conditional rehydration on warm join/resume).
2. **Preserve Production Repo Immutability:** The production repository remains untouched; no merge or production changes authorized.
3. **Hold State Preserved:** PR #107 and D1-A production implementation remain on **HOLD**.
