# Handoff: Issue #124 durable adjudication (delete this file before merging)

## Branch / PR stack (merge in this order; nothing merged, nothing deployed)
1. #145 `claude/funny-lamport-hy7jyc` - durable persistence (migration 0053)
2. #149 - least-privilege owner for SECURITY DEFINER functions
3. #151 `claude/adjudication-clock-release` - release (0054), playouts, escalation, flag rule, witness memo (head d5fa8ca)
4. #152 `claude/adjudication-worker` - worker; immediate release after notice (head a4cf02e)
5. #153 `claude/adjudication-gateway` - authority + resync behind ADJUDICATION_ENABLED (head 0e74a34)
6. #154 `claude/adjudication-web` - client UI (head cdd272b)
7. `claude/adjudication-soak` (this branch, no PR yet) - soak test + worker concurrency (WIP)
Independent on main: #150 (Docker probe + hashtextextended), #155 (ENOTEMPTY orphan reap).
Always forward-merge (no force push): 151 -> 152 -> 153 -> 154 -> soak.

## Done in the latest round
- #151: playout work no longer charged to the first DFS attempt (Qodo finding; regression test, mutant killed);
  owner authorization for the AUD-03a scope exceptions recorded in ADR 0174 §7 and the PR description; Qodo replied.
- #151: bounded memo (4096) of verified witnesses in `verifyUciWitnessReplay` (packages/game/src/adjudication-lifecycle.ts).
  Profiling showed ~48% of CPU re-verifying every recorded witness on each `Game.fromEvents` (quadratic per game).
- #152: the settling worker releases its own stop right after its notice is delivered (removes ~1 s of free
  thinking time per move from the grace+poll path); 4 hermetic + 1 PG test; ADR 0175 updated.
- #153 CI failure at d1089d4 was the known `docker info` 4 s probe flake in the Nginx step (fixed by #150), not the PR.

## WIP on this branch (needs finishing)
- `services/gateway/src/adjudication-worker.ts`: option `concurrency` (default 4), held + claimable operations
  run with bounded concurrency (`#eachBounded`). Hermetic suite passes (20/20). TODO: add a hermetic test that
  two claimable operations overlap and that `concurrency: 1` keeps order; run the PG worker suite; update ADR 0175;
  move this commit to #152 (cherry-pick onto claude/adjudication-worker, then forward-merge).
- `services/gateway/test/adjudication-soak.integration.test.ts`: two replicas on one PG, random play, lost COMMIT
  replies, worker death, owner cold restart; invariants: nothing left proving/stopped, owner == replay, every
  AdjudicationStarted settled once, clocks within bounds. It contains a temporary per-store-call timing wrapper
  (`timed`, `storeMs` in the report) - keep or remove. Scale: SOAK_GAMES / SOAK_PLIES / SOAK_THINK_MS.

## Soak numbers (6 games x 16 plies, one process hosting everything)
| | before memo | after memo + concurrency |
| --- | --- | --- |
| move latency p50 / p90 / p99 | 906 / 1384 / 6360 ms | 414 / 599 / 6190 ms |
| proving p50 | 651 ms | 335 ms |
| clocks stopped p50 / max | 123 / 450 ms | 20 / 207 ms |
| event-loop delay p99 | 84 ms | 49 ms |
Invariants passed in every run.

## Open items
1. p99 ~6 s: one long proof (escalated timeout or exhausted move proof). Investigate which question,
   consider capping the move-proof (non-timeout) time before concluding unresolved (play continues anyway).
2. `settleAdjudication` p50 65 ms / p90 168 ms and `startAdjudication` p90 148 ms: whole-game
   validation per transaction; measure at 100+ plies (SOAK_PLIES=120) for growth.
3. Run the soak at realistic scale (e.g. SOAK_GAMES=40 SOAK_PLIES=80) and under the 512Mi/500m pod limits.
4. Reconnect test from the web client side (ws resubscribe while proving/stopped) - not yet automated.
5. Uncovered #124 scope: dead positions whose state space exceeds exact capacity and that the frozen/static
   detectors miss (game continues, never a false result); only standard/chess960 proofs.

## Measurements (#151, 30 seeded games, proofbench)
Move proof p50 31.8 ms, p90 81.6 ms, 0.5% unresolved (play continues). Flag proof p50 24.2 ms, p90 85.4 ms,
0.4% unresolved after escalation (flag rule, max ~19 s). Before playouts: move p50 1418 ms, 52% unresolved.

## Needs the owner's explicit approval (not done)
Merging, deploying, applying migrations 0053/0054 to production, running prepareAdjudicationGuard and
runtime grants in production, setting ADJUDICATION_ENABLED.
