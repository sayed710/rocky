# Launch Preparation O10 — Windows Signature B verification (2026-10-05)

Outcome: **O10 closed as bounded historical host evidence.** Signature B was not observed in one bounded
current-main Windows pass. Its root cause remains unproven, and non-observation does not show it is gone.

## What Signature B is (committed record, ADR-0140 §4)

- **Known fact:** a per-test-file `node --test` child on Windows dies with the parent reporting a bare
  `test failed`. Early occurrences hit non-integration files (`move-explanation-route`,
  `tournament-commentary-route`, `bot-detection-analyze`, `anti-cheat-analysis`) with no exit status
  captured. A later instrumented campaign captured it five times, in DB-backed `*.integration` files of
  `packages/api` and `packages/persistence`. All five reported `exitCode 3221226505` (`0xC0000409`), no
  signal, child lifecycle `start`, `preload-installed` only. The four fully instrumented captures had no
  fatal markers and no Node diagnostic report.
- **Excluded by measurement (ADR-0140):** `process.exit`, an uncaught exception, an unhandled rejection,
  an instrumented JS `process.abort()`, V8/Node heap-OOM fatal paths, and runner cancellation.
- **Candidate (not a cause):** an in-process Windows fail-fast, or an external `TerminateProcess(0xC0000409)`.
  Avast's `aswhook.dll` was seen injected into `node.exe`; injection is not causation, and no A/B was done there.
- **Never proven:** the terminating party. ADR-0140 records it as UNRESOLVED at acceptance Level C.
- **Linux/CI:** Linux CI is the required gate and has no Signature B history. No required gate depends on
  resolving the Windows cause.

## Bounded verification

| Item | Value |
|---|---|
| Tested SHA | `5ee3441222e94a30f31e0e630bfd941dc3eaec44` (`origin/main`, unchanged at start) |
| Host | Windows 11 Home 10.0.26300, 16 GB RAM, Node v24.15.0 |
| Database | `pgvector/pgvector:pg16` container, all 49 migrations applied; `DATABASE_URL` set, so the DB-backed suites ran and did not self-skip |
| Command (`packages/api`) | `node ./test/diagnostics/run-signature-b-pass.mjs --runs 3 --max-minutes 25 --out <dir>` after `npm ci --ignore-scripts`, `npm run build`, `tsc -p tsconfig.test.json` |
| Runs | 3 readable, 0 unreadable, 0 timed out; 270 s, 241 s, 227 s (about 12 min) |
| Captures | **0** (`captures=0`, `reportFiles=0`, `collectionError=null` in every run) |
| Per-run suite | 1368 tests: 1358 pass, 1 fail, 9 skipped, concurrency 1 as in `npm test` |
| `summary.json` sha256 | `be6a32afb86714e0bf2e4a6f9295cdd0dccc7789b7ee33da9e4ba6466be8cfd5` (kept outside the repo; every figure above is reproduced here) |

The DB-backed suites from the instrumented captures (`pg-security`, `auth-signin-schema`, and the rest of
the `*.integration` set) executed in all three runs.

**The one failure and the 9 skips (no success credit taken for either):**

- `signature-b-correlate.posix.test` ("an existing group-readable --out is secured or refused", mode
  `54 !== 0`) failed identically in all 3 runs. It is a POSIX file-mode assertion. The pass's default glob
  `dist-test/test/**/*.test.js` includes `*.posix` files, while `npm test` and CI exclude them on Windows
  and run them under `test:posix` on Linux. It is not Signature B (an ordinary assertion failure, which the
  correlator itself classifies as not a capture). It does not impair evidence collection, so the pass
  tooling was left unchanged.
- 9 skips are the engine-gated Stockfish/Fairy suites (`STOCKFISH_PATH` / `FAIRY_STOCKFISH_PATH` unset).
  Those are not DB-backed integration files and are outside the historical capture set.

## Disposition

Case A. No fresh Signature B on current main, no required gate failing on it, and no product behaviour
shown broken. O10 stays a Windows-only historical host diagnostic. The mechanism family in ADR-0140 stands
unchanged, and its leading candidate (Avast hook injection) remains untested.

**Limits.** Three runs on one host and one Node version. This bounds the rate on this host and nothing
more. It identifies no cause and does not prove permanent elimination. The pass tooling's own wording
applies: "not observed" is not "fixed". Any fresh required-gate Signature B failure reopens O10, and the
instrumented pass above is the tool to capture it.

**Launch significance.** None for the Linux-hosted gates. It does not block public launch.
