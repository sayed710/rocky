# PR #81 localization correction evidence — 2026-10-02

Starting implementation, remote branch and GitHub PR head: `f76f1d2a13e9d6e07aac10139448ce3a59b47302`. Main: `06390437f5f979e2be8c640f092254e9546addd5`, merged Increment 79. PR #81 retains proposed Increment 80. Parallel PR #83 remains open at `e140093f69fd5ec5ab740b1b10f4394b3f640efe`; its backend changes were not integrated.

## Initial unresolved review inventory

All 15 threads were fetched before implementation. Links identify the original review comments; disposition describes the correction, not a claim that final review has already completed.

| Thread | Finding | Disposition and evidence |
| --- | --- | --- |
| [4156917254](https://github.com/sayed710/rocky/pull/81#discussion_r4156917254) | Tournament English variant labels | Retained documented Finding M decision; ADR and PR disclose the English parity exception. |
| [4157031414](https://github.com/sayed710/rocky/pull/81#discussion_r4157031414) | Bot dialog listener leak | Stale: starting head already disposes the dialog in the real lobby disposal path; existing listener-count regression verifies cleanup. |
| [4160209663](https://github.com/sayed710/rocky/pull/81#discussion_r4160209663) | Greptile lesson move lock | Fixed with semantic per-step pending ownership, current-node settlement and action-layer duplicate guard. |
| [4160209683](https://github.com/sayed710/rocky/pull/81#discussion_r4160209683) | Assessment stale note | Fixed: control refresh synchronizes the same semantic key consumed by locale replay. |
| [4160210876](https://github.com/sayed710/rocky/pull/81#discussion_r4160210876) | Throwing storage getter | Fixed: safe resolver used by locale storage, composition, bootstrap and lobby preferences. Default startup and in-memory operations tested. |
| [4160210887](https://github.com/sayed710/rocky/pull/81#discussion_r4160210887) | English analysis notices | Fixed: runtime notice/error keys translated through the injected manager; no runtime English-constant use in game mount. |
| [4160210900](https://github.com/sayed710/rocky/pull/81#discussion_r4160210900) | Completed analysis labels | Fixed: cache semantic response, replay localized metadata, clear on invalidation; translation issues no request. |
| [4160210914](https://github.com/sayed710/rocky/pull/81#discussion_r4160210914) | Variant selector mismatch | Fixed `.cg-option-label`; visible label and checked radio regression. |
| [4160210925](https://github.com/sayed710/rocky/pull/81#discussion_r4160210925) | Qodo lesson move lock | Duplicate of Greptile 4160209663; same architecture and regressions. |
| [4160210935](https://github.com/sayed710/rocky/pull/81#discussion_r4160210935) | Lesson text/quiz duplicate submission | Same pending root cause, broader control coverage; move/text/quiz mounted tests and real Chromium tests. |
| [4160210947](https://github.com/sayed710/rocky/pull/81#discussion_r4160210947) | Endgame stale judging note | Fixed final verdict ownership and clearing old result when a new request begins. Baseline reproduced an obsolete prompt beside the verdict; forcing stale judging is independently caught by mutation. |
| [4160210955](https://github.com/sayed710/rocky/pull/81#discussion_r4160210955) | Opening/puzzle/coach returned notes | Fixed shared presentation paths render returned notes on initial result and locale replay; pending state has priority. |
| [4160210966](https://github.com/sayed710/rocky/pull/81#discussion_r4160210966) | Pending verification label | Fixed retained pending state; deferred request locale test verifies one request. |
| [4160210980](https://github.com/sayed710/rocky/pull/81#discussion_r4160210980) | Lobby English capitalization | Restored raw English tokens from main; non-English catalogs retain localized labels. |
| [4160210990](https://github.com/sayed710/rocky/pull/81#discussion_r4160210990) | Premove promotion suffix | Retained technical correctness and existing promotion/bidi tests; ADR and PR disclose the exception. |

## Focused root-cause audit

Removed inference from translated DOM text for AI note ownership. Cached results no longer prevent pending notices from translating. Lesson locale replay preserves drafts and idle keyboard focus/selection; study replay restores focus while preserving selected node and `aria-current`. Lesson boards are disposed before replacement and when the mount is disposed. Signed-out private Game Review cache is cleared at the existing invalidation boundary, preventing locale replay from restoring private output. A latched unavailable lesson outcome is also retained and translated.

Read-only state/concurrency, accessibility and test-quality agents reviewed the starting sources. The separate Codex CLI review attempt failed because its configured model was unsupported for that account and is not counted as independent review evidence. Final independent review follows the owner's Gemini/Claude sequence.

## RED and falsification

The added mount regressions ran before the representative fixes. A later clean archive of exact starting head, overlaid only with the correction tests/support and strengthened Game Review test, compiled successfully and produced **17 failures, 11 passes, zero skips (28 tests)**. Failures covered throwing storage access, all three lesson pending forms, semantic assessment transition, pending verification, variant labels, final endgame note ownership, analysis loading/completed/failure copy, all three assistant result notes, lesson/study focus, and private-review invalidation. The unavailable-lesson regression separately failed before its fix on untranslated outcome replay.

The same disposable control passed all 28 tests with corrected sources. Fourteen independent source mutations were transpiled and exercised against the real mount tests, each producing the intended behavioral failure: remove pending identity; enable text controls; enable quiz controls; stop assessment synchronization after caching state A; restore unsafe storage getter access; render the English `ANALYSIS_MESSAGES.loading` constant; drop completed analysis cache; restore wrong variant selector; retain endgame judging; discard opening note; discard puzzle note; discard coach note; drop pending verification; retain invalidated private-review cache. Source and emitted module bytes were restored after each mutation; the final disposable control passed and the primary worktree source hashes were unchanged.

Local evidence logs are in `C:/Users/hp/AppData/Local/Temp/rookzen-pr81-evidence-final` (`baseline-red.log`, `green-control.log`, individual mutation logs, `summary.json`, `restored-green.log`, and validation logs). This directory is outside the repository and contains no credentials.

Five targeted real Chromium tests passed with one worker and zero retries/skips. They exercise actual bundled production lesson mounts with deferred API responses, including synthetic duplicate dispatch, current-control settlement, draft focus/selection and accessible name, and safe disposal. They do not substitute for the owner's final full backend browser gate.

Final backend browser, exact-head CI, bot re-evaluation, thread resolutions and independent review must be reported from their actual results after this correction. No merge is authorized.
