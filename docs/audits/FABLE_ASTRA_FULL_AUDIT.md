# Rookzen Full Product & Launch Readiness Audit

**Audited revision:** `main` = `origin/main` = `d0a05bbc900e8d18f80c30f6e802222f440ddbf4` (verified against GitHub API: `edwardnewgate710/rocky`, default branch `main`, same SHA, pushed 2026-09-05T19:55Z). Tree clean before and after; no source changes made; nothing committed/pushed. A stale `old-origin` remote (`senasehs09/shatarang`) exists locally but was never used — no Codex brief or result references it.
**Correction acknowledged:** no `agy`/Gemini was used. The only `agy` call was `agy models` (a capability listing) before your correction arrived; nothing was delegated.
**Runtime:** documented `docker compose up --build`; host ports 8080/4175/3000 are inside a Windows excluded TCP range on this machine (8063–8162), so the stack ran on `PORT=18080 GATEWAY_PORT=14175 WEB_PORT=13000` (compose parameterizes these; container ports unchanged). All 5 services healthy; `scripts/smoke-test.mjs` PASSED. Browser: Playwright Chromium 1.61, viewports 1440/1024/768/390 + 320, Lighthouse 11.4.0. Evidence artefacts (screenshots, JSON logs, Codex transcripts) are in the session scratchpad, outside the repo.
**Codex:** GPT Astra (`gpt-6-astra`), `--effort medium`, read-only sandbox, three rounds in one thread, `touchedFiles: []` each time.

---

## 1. Executive verdict

**Is it launchable today?** No — not as a public product. As a closed alpha for people told it is one: yes.

**If launched today a real user would experience:** a fast, correct, server-authoritative chess game (seek → match → moves → clocks → reconnect → draw/resign → post-game Stockfish review) — and then discover that nothing counts: after a *rated* game their rating is "No ratings yet", their history shows the game with `plyCount 0, result null`, the leaderboard is empty; the 21st browser tab on the site is refused by the gateway; opening two tabs can log them out of everything; the sidebar hands them Stockfish lines *during* the rated game; the site is called Gambit, is teal, English-only, and greets them with a sign-in card on every page.

**Biggest reason it does not feel competitive:** the core loop is open. Play works; nothing accumulates into results, ratings, or progression. Sixteen feature packages exist around a hole where "your game counted" should be.

**Main problem:** a combination, in this order — (1) **missing completion of the core loop** (projections/ratings/expiry never wired), (2) **trust/fair-play** (first-party engine help in rated games; two proxy-boundary defects; refresh-race logout), (3) **product/UX shape** (login-first, admin-list layout, unfinished surfaces exposed), (4) **brand & i18n** (rejected identity shipped; zero Arabic), (5) infrastructure is comparatively strong at the core (event store, migrations, engine limits, CI) but weak at the *edge and lifecycle*.

---

## 2. What Rookzen actually is today

A well-engineered chess *engine-and-transport* with an unfinished *product* on top:

- **Works end-to-end (verified in browser):** register/sign-in/sign-out; create seek (10 presets, custom, casual/rated, colour, variant, rating range); accept on mobile; auto-route creator; click-click moves; legal-move highlights; clocks; reload/resume; draw offer/decline; resign with inline confirm; Play vs Computer (Stockfish moved d2d3 within seconds); post-game review with move classification; live engine analysis; opening identification; "find tactic"; coach aggregate; RBAC 403s; rate limiting; security headers; PWA manifest.
- **Exists but is inert or lies:** ratings (0 rows ever), games projection (all rows `ply_count 0`), leaderboard, "Rated" toggle, bot shown "Offline", "Explain last move" (no AI key), learning/studies/achievements/tournament commentary/GraphQL (off in compose), tournaments (director-only, none exist, no admin UI, lossy reporter), messaging/teams/forums (enabled, unverified in browser, no abuse budget).
- **Absent:** Arabic/RTL/i18n, Rookzen identity, legal pages, notifications, settings, game chat, rematch/friend challenge, opponent identity on seeks, spectator discovery, guest play, account deletion, game PGN export, autonomous clock expiry.

---

## 3. Route / feature evidence matrix

| Area Runtime status UX quality Tech confidence Evidence Launch impact Competitor relevance  |                                                                                              |                       |                          |                                                                            |                              |                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | ------------------------ | -------------------------------------------------------------------------- | ---------------------------- | --------------------------------------- |
| Rules engine (8 variants, 960)                                                              | Works                                                                                        | n/a                   | A (perft, 960 positions) | `chess-core` tests; ADR-0098/0136                                          | none                         | table stakes ✔                          |
| Live game (moves/clocks/resume/draw/resign)                                                 | Works                                                                                        | Good                  | B                        | journey log, screenshots 09/12/13/15                                       | —                            | table stakes ✔                          |
| Illegal/out-of-turn move                                                                    | Silently ignored                                                                             | Weak                  | B                        | journey `illegal-out-of-turn`                                              | P2                           | Lichess also silent; beginners confused |
| Clock expiry                                                                                | **No server scheduler**                                                                      | —                     | D                        | `authority.ts` only `claimFlag`; `serve.ts` timers = heartbeat/join        | **P0-adjacent**              | must match                              |
| Lobby / seek / accept                                                                       | Works                                                                                        | Fair                  | B                        | journey 06–09                                                              | —                            | table stakes                            |
| Seek lifecycle                                                                              | No expiry; creator redirected to finished game ≤5 min; creator loses \~10 s clock            | Weak                  | C                        | `pg/repositories.ts:584-616`, `lobby-controller.ts:77,98`, screenshot 9:51 | P1                           | must match                              |
| Opponent identity on seek                                                                   | Absent                                                                                       | Weak                  | —                        | `lobby-mount.ts:39`                                                        | P1                           | must match                              |
| Play vs Computer                                                                            | Works; bot "Offline" label                                                                   | Fair                  | B                        | screenshot 21                                                              | P2                           | table stakes                            |
| Ratings (Glicko-2)                                                                          | **Never applied**                                                                            | Misleading            | D                        | `ratings.upsert` 0 runtime callers; `select count(*) from ratings`=0       | **P0**                       | table stakes                            |
| Game history / projection                                                                   | **Never finalized**                                                                          | Misleading            | D                        | `games.finish/updateProgress` 0 callers; all rows ply 0                    | **P0**                       | table stakes                            |
| Leaderboard                                                                                 | Empty by lifecycle                                                                           | —                     | D                        | screenshot                                                                 | P0 (via ratings)             | table stakes                            |
| Post-game review                                                                            | Works; own moves only; ≤40 moves else rejected                                               | Fair                  | B                        | `game-review/service.ts:22,114-118`                                        | P1                           | Chess.com Game Review                   |
| Live engine tools during rated game                                                         | **Offered & working**                                                                        | —                     | —                        | journey `live-analysis-result`                                             | **P0**                       | fair-play                               |
| Analysis endpoint (arbitrary FEN)                                                           | Works, bounded                                                                               | —                     | B                        | `analysis/limits.ts`                                                       | P0 via above                 | —                                       |
| Move explanation (LLM)                                                                      | Off (no key)                                                                                 | —                     | C                        | capabilities `moveExplanation:false`                                       | P2                           | Chess.com coach                         |
| Puzzles as product                                                                          | Only "find tactic here"                                                                      | —                     | E                        | index.html                                                                 | P1                           | table stakes gap                        |
| Lessons/courses                                                                             | Off; 0 content; author-role only                                                             | —                     | D                        | capabilities; DB 0 rows                                                    | P2 (hide)                    | Chess.com                               |
| Studies/PGN                                                                                 | Off in compose                                                                               | —                     | C                        | capabilities                                                               | P2 (hide)                    | Lichess                                 |
| Endgame trainer                                                                             | 21 positions, typed UCI, layout bug signed-out                                               | Poor                  | C                        | screenshot endgames                                                        | P2                           | Lichess practice                        |
| Opening explorer                                                                            | 46 ECO, identify-only                                                                        | Fair                  | C                        | bundled DB                                                                 | P3                           | Lichess explorer                        |
| Search (kw/semantic/hybrid)                                                                 | Works; hashing "semantic"                                                                    | Fair                  | B/C                      | `bootstrap.ts:373`, `embedding.ts:10`                                      | P2 (relabel)                 | —                                       |
| Social / messaging / teams / forums                                                         | Enabled; API-verified 200s; no abuse budget                                                  | Unverified in browser | B/C                      | routes 3020-3110 have 0 `admit(`                                           | P1 before public             | community                               |
| Tournaments                                                                                 | Director-only; reporter lossy; none exist                                                    | —                     | C                        | `reporter.ts:62-90`; 403 as user                                           | P1 (operator-run)            | table stakes                            |
| Achievements                                                                                | Off                                                                                          | —                     | D                        | capabilities                                                               | P3                           | —                                       |
| Auth (password/passkey/reset/verify/sessions)                                               | Works; **refresh race revokes all**                                                          | Good                  | B                        | reproduced r1=200/r2=401/winner=401                                        | **P0/P1**                    | table stakes                            |
| Login lockout                                                                               | 5 attempts/handle/15 min incl. successes                                                     | —                     | B                        | `routes.ts:389-394`, `config.ts:139`                                       | P1                           | trust                                   |
| Gateway per-IP cap behind nginx                                                             | **20 sockets total per replica**                                                             | —                     | D                        | reproduced 20 open / 5 × 1013                                              | **P0**                       | availability                            |
| API `X-Forwarded-For` trust                                                                 | First entry, client-controllable                                                             | —                     | C                        | `scripts/serve.ts:13`, `http/router.ts:373`                                | P0 (same PR)                 | abuse                                   |
| Security headers/CORS/cookies                                                               | Good                                                                                         | —                     | A-                       | smoke + probes                                                             | —                            | —                                       |
| Moderation / anti-cheat                                                                     | APIs + workers off in compose; no UI                                                         | —                     | C                        | `BOT_AUTO_ANALYZE`/`ANTICHEAT_AUTO_ANALYZE` unset                          | P1                           | fair-play                               |
| i18n / Arabic / RTL                                                                         | Absent                                                                                       | —                     | E                        | `lang="en"`, no `dir`, 0 Arabic strings                                    | **P0 by owner decision**     | Lichess 140+ langs; Lotus AR            |
| Brand (Rookzen / Burgundy&Stone)                                                            | **Gambit/teal on main**; local rebrand exists in no branch/worktree                          | —                     | E                        | `index.html:7`, `style.css:6`                                              | **P0 by owner decision**     | —                                       |
| Landing / anonymous                                                                         | Sign-in card above every route's content; no 404                                             | Poor                  | —                        | screenshots anon                                                           | P1                           | —                                       |
| Accessibility                                                                               | grid without rows; no `<main>` off-game; 22 px nav targets                                   | Fair                  | B                        | LH a11y 0.93; extras.json                                                  | P1                           | Lichess blind mode                      |
| Performance                                                                                 | 240 KB JS uncompressed, no cache TTL; LH perf 0.88 (throttled)                               | —                     | B                        | LH json; headers                                                           | P2                           | —                                       |
| Legal pages / AGPL offer / attribution                                                      | Absent                                                                                       | —                     | E                        | grep                                                                       | P0 (wiring S; content owner) | trust                                   |
| Ops (Helm/CI/SLO/runbooks)                                                                  | Helm never cluster-deployed; no `ENGINE_BOT` in Helm; no backup/restore drill                | —                     | B                        | `deploy/`, `docs/SLO.md`                                                   | P1                           | —                                       |
| Tests                                                                                       | 3320 tests (team-measured); e2e vs in-memory harness with random bot; Signature B unresolved | —                     | B+                       | `ci.yml:602`, `e2e-harness/src/bot.ts`                                     | P1                           | —                                       |

---

## 4. Product / UX / visual audit

**First impression (anonymous, any route):** a centred grey sign-in card, then the page you asked for underneath it. The wordmark is "Gambit". At 390 px the nav wraps into three lines above the card. It reads as a developer prototype with a login gate, not a chess platform. The brand doc's own unfinished item #4 ("the site must not look like a login form") is exactly what ships.

**Play-first?** Once signed in, the lobby is: two outline buttons ("Create a game", "Play vs Computer") and an "Open seeks" list. Functional, calm, not inviting. No board on the landing, no quick-pair, no "who is online", no reason to stay.

**Board and game view (desktop 1440):** the strongest screen — board fills the height, sidebar is orderly, Cburnett pieces, classic wood squares. It looks like Lichess minus the polish: the "Engine / Find tactic / Assess / Opening / Coach" stack under the game actions is a list of developer test buttons, each with a one-line helper sentence. Five separate "panels" with identical outline buttons = admin dashboard rhythm. Mobile 390: board first, then a very long vertical list — acceptable, but the sign-in card is appended *below* the game for spectators.

**Visual identity vs owner decision:** accent is teal `#20b2aa` (explicitly rejected); dark `#161512`, not `#242224`; no burgundy anywhere; system fonts. Dark-first is not true: the OS light preference overrides (`style.css:83`), and headless/first-visit light users get light. No glow/gradients (good). Borders: every button is a 1 px outline — 15+ outlined rectangles on the lobby with the panel open. Cards: the create-game panel is a big grey card with a large empty region under the presets (screenshot 04). Pills: segmented radios everywhere (time, mode, colour, difficulty, search mode). It does not look "AI-generated SaaS"; it looks like an unstyled functional prototype with one accent.

**Empty states:** good copy ("No open seeks right now — Create a game above…", trophy icon for tournaments). **Error states:** inline red text; direct `/studies` shows "Studies service unavailable" (honest but confusing after the nav link was removed). **404:** none — unknown routes show the sign-in card. **Loading:** "Loading…" text on leaderboard only. **Feedback:** rejected/out-of-turn moves give no signal; bot shown "Offline"; finished game leaves disabled action buttons.

**Discoverability/progressive disclosure:** the "More options" disclosure on create-game is a good example. The rest is flat: 8 top-level nav links of equal weight (Lobby, Endgames, Profile, Tournaments, Leaderboard, Teams, Messages, Search) — "Endgames" as a top-level destination next to "Profile" is a signal of feature-listing rather than journey design.

**Verdict:** it looks unfinished because (a) the shell was never designed for anonymous visitors, (b) every capability is exposed as a same-weight button/section rather than folded into a play → review → train journey, (c) the approved identity is absent, (d) there is no typographic hierarchy beyond bold headings.

---

## 5. Technical architecture audit

**Strengths (verified):** dependency-free domain packages with real ports; event-sourced `Game` with exact replay; per-game command serialization; Redis ownership + command forwarding for multi-replica gateway (ADR-0010); advisory-locked, transactional, checksum-verified forward-only migrations (`migrate.ts:271,345`); durable analysis cache with retention; hard engine limits (depth 20, 2 s, MultiPV 5, 2 workers, queue 32) — clamped down only; OpenAPI generated from the live route table; capability-driven navigation; typed client models mirroring the spec.

**Weaknesses (verified):**

- **Projection layer is missing, not buggy.** `GamesRepository.start` is only reached through seek-accept SQL; `updateProgress/finish` and `RatingsRepository.upsert` have no runtime callers. `docs/DATABASE.md §4.2` calls the games table "derived from the event log; rebuildable" — nothing derives it.
- **Broadcast-as-delivery pattern** (tournament reporter subscribes to pub/sub, unsubscribes before processing, no replay; `list(100)` before filtering running). Any future projector copying this pattern inherits loss.
- **No autonomous clock expiry** — a game ends only by a late move or an explicit `claimFlag`.
- **Edge identity is wrong in both directions:** gateway ignores `X-Forwarded-For` (all browsers share nginx's IP → 20-socket cap), API trusts the *first* XFF entry with `trustProxy:true` (client-spoofable).
- **Refresh rotation + reuse detection is correct in isolation and wrong under concurrency** (two tabs → account-wide revocation; reproduced).
- **Coupling hotspots:** `routes.ts` 6,193 lines; `game-mount.ts` \~1,500 lines coordinating six assistance controllers with repeated eligibility logic; a single `index.html` carrying 29 `<section>`s (25 hidden) as the whole app.
- **Windows/Linux:** Signature B (`0xC0000409` bare `node --test` file failures) — **UNRESOLVED, Level C**; Windows-only; not evidence of Linux production instability.
- **Test realism:** hermetic unit suites are strong; pg integration real; engine smoke real; but Playwright runs against an in-process harness whose bot plays *seeded random moves* and whose repos are in-memory — it cannot see the projection, rating, nginx, or Helm gaps. No test asserts "a rating changes after a game".

---

## 6. Security / privacy / fair-play audit

| Area Finding Status      |                                                                                                                                                                                  |                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Auth                     | scrypt, HS256 15-min access tokens, rotating opaque refresh in `HttpOnly; SameSite=Strict; Path=/v1/auth` cookie, passkeys, session list/revoke                                  | good                      |
| Refresh reuse detection  | **Concurrent legitimate refreshes revoke all sessions** (reproduced)                                                                                                             | P0/P1                     |
| RBAC                     | moderation/roles/tournament create → 403 as user; unified "invalid credentials"; duplicate handle → 409 (enumeration by design of handles)                                       | good                      |
| Rate limiting            | Login handle bucket charged before verification (5/15 min incl. successes) → lockout DoS by name                                                                                 | P1                        |
| Proxy trust              | API: first XFF entry trusted → per-IP limits spoofable; Gateway: XFF ignored → shared cap                                                                                        | **P0**                    |
| Headers                  | CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'` (no script-src), XFO, HSTS, nosniff, Referrer no-referrer, Permissions-Policy; `Server: nginx/1.31.3` disclosed | good/minor                |
| Input                    | strict object schemas, FEN validator, body limits; no SQLi observed (parameterized `pg`)                                                                                         | good                      |
| XSS                      | framework-free DOM construction via `textContent`/`el()`; SECURITY\_AUDIT.md wrongly assumes React escaping — frontend never audited                                             | P2                        |
| Fair play                | **Engine, puzzle, opening, coach tools work during live rated human games**; Study Partner accepts arbitrary FEN (`routes.ts:1922,1955`) — an additional bypass path             | **P0**                    |
| Anti-cheat/bot detection | domain + workers exist; off in compose; no moderator UI; no player report flow                                                                                                   | P1                        |
| Abuse                    | messaging/seek creation have no admission control; no spam/flood budget                                                                                                          | P1                        |
| Privacy                  | no policy, no deletion/export, `audit_log` stores auth events; profiling (anti-cheat reports) has no disclosure surface                                                          | P0 wiring / owner content |
| Supply chain             | `npm audit --omit=dev` 0 vulns (root + gateway); Stockfish pinned by SHA-256 with licence/source in image; Cburnett multi-licensed with `COPYING.md`                             | good                      |

No destructive testing was performed; no security software touched.

---

## 7. Reliability / testing audit

- Documented (team, 2026-09-05): 19 workspaces, 3320 tests, 0 fail, 28 skipped; `test:counts` 3336/33. **Not re-run in this audit** (skips are env-gated; Redis suites skip without `REDIS_URL`).
- CI: Node 22/24 matrix, pg integration, real Stockfish/Fairy smoke, Playwright + Lighthouse (a11y ≥ 0.95 gate; my compose run scored 0.93 — cause of discrepancy not established; CI measures the harness on 4173), docker image builds incl. nginx template render, helm lint/kubeconform, parity guards.
- Realism gaps: harness ≠ compose (random bot, in-memory repos, no nginx); nothing asserts ratings/history after a game; no acceptance for proxy limits, concurrent refresh, seek expiry, clock expiry, tournament result replay.
- Flakiness: Signature B (Windows, unresolved Level C, mechanism family = fail-fast/external termination, source unproven); analysis-cache cold-race test fixed (Inc 52).
- Mutation/falsification: applied per-increment by the team on selected suites (documented); not repo-wide.

---

## 8. Performance audit

Environment: local Docker on Windows, warm, single user; Lighthouse 11.4.0 simulated throttling (150 ms RTT, 1.6 Mbps, 4× CPU).

- API p50: `/v1/health` 14 ms, `/v1/leaderboard/standard` 14 ms, `/v1/seeks` 15 ms, `/` 19 ms.
- Bundle: JS 240,805 B **uncompressed on the wire** (nginx gzip off), CSS 26.7 KB, no `Cache-Control` on hashed assets; Lighthouse: perf 0.88, FCP 2.7 s, LCP 3.1 s, TBT 100 ms, CLS 0; flags text-compression (220 KiB), unused JS (193 KiB).
- Engine: 2 workers × 2 s ceiling; saturation refused with 503 (good); Helm API CPU limit vs 2 workers unmeasured.
- WS: gateway fanout p99 < 50 ms in-process benchmark (team); two-node 34-connection baseline only; **20-socket proxy cap dominates any capacity question**.
- DB: 69 indexes across 31 migrations; `recentForUser(limit)` without cursor pagination; no N+1 observed on probed routes; not load-tested here.

---

## 9. Accessibility audit

| Check Result               |                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard tab order (lobby) | PASS — wordmark → nav → search → sign out → theme → create → bot                                                                                                              |
| Visible focus              | PARTIAL — 3 px teal ring on inputs verified; `:focus-visible` rules exist for buttons/nav (`style.css:459,509`) but not observed via keyboard in this pass                    |
| Landmarks                  | PARTIAL — header/nav/search on lobby; `<main>` only on game route                                                                                                             |
| Labels / button names      | PASS — 0 unlabeled controls                                                                                                                                                   |
| Forms                      | PASS — labelled inputs, autocomplete, inline errors with `role=alert`                                                                                                         |
| Dialogs                    | PASS — native `<dialog>` for bot launcher                                                                                                                                     |
| Board                      | PARTIAL — `role=grid`, 64 `gridcell` with roving tabindex and labels like "a8 br"; **no** **`row`** **children** (LH `aria-required-children`); piece names are abbreviations |
| Contrast                   | PASS on sampled tokens (body `#bababa` on `#161512`; muted `#8f8f8c` ≥ 4.5:1 per CSS notes)                                                                                   |
| Screen-reader semantics    | PARTIAL — many `aria-live` status regions; board announcements unverified                                                                                                     |
| Reduced motion             | PASS — 3 `prefers-reduced-motion` blocks                                                                                                                                      |
| Touch targets              | PARTIAL — 44 px on coarse pointers; desktop nav links 22 px high                                                                                                              |
| Text scaling 200% / 320 px | PASS — no horizontal overflow                                                                                                                                                 |
| RTL accessibility          | NOT TESTED — no RTL exists                                                                                                                                                    |

---

## 10. English / Arabic / RTL audit

State: **English only.** `html lang="en"`, no `dir`, no i18n layer, no message catalogue, 0 Arabic strings, no fonts bundled (system-ui), no locale-aware numbers/dates (clock is `M:SS`, dates via `localeCompare`/ISO). Chess notation is SAN/UCI (correct to keep). User-generated content has no bidi isolation. The brand doc itself records: "adding an Arabic font ≠ translating the UI or completing RTL" — and even the font was never added on `main`. Grade **E**; owner-required for launch (see §14 #6).

---

## 11. Operations / production-readiness audit

| Item Status                     |                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose local stack             | implemented (works; port collision on this host is environmental)                                                                                                                                                           |
| Helm chart                      | implemented as packaging; **never deployed to a cluster** (docs); **omits** **`ENGINE_BOT`**, reporter default off; probes/resources present; no PDB/HPA/NetworkPolicy; bundled single-replica Postgres; TLS off by default |
| Secrets                         | implemented (fail-closed; ExternalSecrets option)                                                                                                                                                                           |
| Migrations on deploy            | implemented (initContainer, advisory lock)                                                                                                                                                                                  |
| Rollback                        | documented-only (blue/green, canary values) — never exercised                                                                                                                                                               |
| Health/readiness                | implemented (DB/Redis reachability; not "bot moves"/"projection progressing")                                                                                                                                               |
| Logs/metrics/tracing            | implemented (structured logs, Prometheus `/v1/metrics` blocked at proxy, OTLP) — not in compose                                                                                                                             |
| Alerts/dashboards/runbooks/SLOs | documented + rule files; SLO targets unvalidated; no WebSocket SLO                                                                                                                                                          |
| Audit log                       | implemented (auth events only)                                                                                                                                                                                              |
| Backups/restore/DR              | **missing** (no backup job, no restore drill)                                                                                                                                                                               |
| DB upgrades                     | unknown                                                                                                                                                                                                                     |
| Engine sizing                   | documented, unmeasured under load                                                                                                                                                                                           |
| WS scaling / sticky sessions    | Redis ownership + forwarding implemented; **per-IP cap makes it moot**                                                                                                                                                      |
| Postgres failure behaviour      | partial (analysis cache absorbs faults; gateway/API behaviour on DB loss unverified)                                                                                                                                        |
| Release pipeline / provenance   | implemented (GHCR on tag; pinned engine; images built in CI)                                                                                                                                                                |
| Feature flags / kill switches   | implemented via `*_ENABLED` env; no runtime toggles                                                                                                                                                                         |
| Incident debugging              | request IDs + trace IDs in logs (good)                                                                                                                                                                                      |

Could someone operate it? Compose: yes. Kubernetes: not proven; Helm parity gap would ship a silent bot.

---

## 12. Competitor gap matrix

Fresh official fetches 2026-09-06: Lichess features page; Chess.com membership help article; Lotus site. Endgame.ai's site is client-rendered — **not freshly verifiable**; only the dated (2026-08-09) appendix describes it. Lotus App Store page rate-limited (Arabic/pricing claims stay "per appendix").

| Chess.com Lichess Endgame.ai Lotus Chess Rookzen today  |                                                                     |                                                                                                            |                                                                 |                                                                                   |                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Table stakes they set                                   | liquidity, Game Review, puzzles, lessons, mobile apps               | everything free, 8 variants, cloud analysis, explorer, tablebase, studies, 140+ languages, blind mode, API | modern UI, human-like bots, personalised puzzles (per appendix) | import → personal opening course, mastery, mobile-first, Arabic UI (per appendix) | play works; ratings/history don't                                                      |
| Structural advantages (not copyable by code)            | liquidity, content library, brand, events                           | community, trust, free-forever, 15 years of data                                                           | design momentum, funding                                        | focus, mobile distribution                                                        | none yet                                                                               |
| Must match                                              | rated play that counts, review, puzzles, mobile web                 | fair play, free core, reconnect quality                                                                    | onboarding clarity                                              | Arabic quality                                                                    | —                                                                                      |
| Should NOT copy                                         | ad/upsell funnel, 11-label review vocabulary as a feature in itself | feature breadth on day 1                                                                                   | AI-as-identity                                                  | narrow mobile-only scope                                                          | —                                                                                      |
| Could differentiate                                     | calm play-first shell                                               | —                                                                                                          | —                                                               | —                                                                                 | friend-challenge/rematch loop; critical-moment → practice loop; EN/AR parity done well |
| Wasteful now                                            | GraphQL, semantic search, canary/blue-green, more variants, voice   |                                                                                                            |                                                                 |                                                                                   |                                                                                        |

Rookzen's honest position: a **right to compete** (rules, authority, gateway, auth are real) with **no moat** and an open core loop.

---

## 13. Claude vs Codex debate

**Method:** Round 1 Codex received sanitized context + neutral runtime log, no conclusions. Round 2 I sealed my position first. Round 3 Codex attacked it. Round 4 I verified every new claim (10/10 confirmed in code; 2 reproduced empirically) and rebutted. Round 5 Codex challenged the reconciled state.

**Claude position (sealed):** not launchable; loop is open (ratings/projection dead); live engine help in rated games P0; brand/landing/legal P0; infra "not the bottleneck". First PR: close the loop.

**Codex position (R1, independent):** same verdict; found additionally the proxy per-IP cap (F03), Helm/compose parity (F04), 40-move review ceiling (F10), hashing "semantic" search (F12), ratings schema without speed (F20), stale security audit (F16); put assistance policy first.

**Codex challenge (R3):** my "nothing persists" too literal; tournaments "unreachable" wrong; live play/auth grades too confident; branding should be P1 technically; missed: API XFF trust, refresh race, seek expiry, redirect-to-finished-game, creator clock loss, no clock-expiry scheduler, lossy tournament reporter, messaging abuse budget, random harness bot, no rematch, no opponent identity on seeks, projection is not a security authority.

**Claude rebuttal (R4):** accepted 24 of 30 points outright (all verified; refresh race and clock loss reproduced); held: assistance guard can be M using event-log status rather than projection; branding is P0 *by owner decision*; infra core remains stronger than product layer; Lighthouse discrepancy is unknown, not a hollow gate (Codex retracted).

**Codex final challenge (R5):** Study Partner (`routes.ts:1922,1955`) is a bypass of my proposed guard list; "any live game" is containment not policy; event-log lookup isn't automatically race-free (events keyed by game, not player); refresh race should be P0; Endgames may leave nav only with another visible entry; "there are not ten independent technical P0s".

**AGREED**

- Not publicly launchable; closed alpha only.
- P0 set: proxy edge identity (WS cap + API XFF), first-party assistance in live rated games (incl. Study Partner path), durable game projection, ratings with explicit pools, concurrent-refresh safety, timed-match lifecycle (clock start, expiry, seek expiry).
- Projections/ratings must be driven from the event log with checkpoints; pub/sub may only wake workers.
- Compose/nginx acceptance job attached to the first edge PR; harness bot is not the production mover.
- Rookzen shell + EN/AR + legal pages are owner release gates, run as a parallel product track.
- Rematch/friend-challenge is the best missing product capability; seek rows need opponent identity.
- Defer: canary/blue-green adoption, semantic search prominence, review taxonomy investment, more AI breadth, rewrites.

**DISAGREED**

- *Branding severity:* Codex "P1 technical"; Claude "P0 by owner decision". Both hold — the report labels it exactly that.
- *Assistance guard sizing:* Codex L (full policy); Claude M for conservative containment now, L for the complete policy later. Reconciled as PR-2 = containment (M) with the full policy as follow-up.
- *Endgames in nav:* Codex "fix or nest under a visible Learn entry"; Claude "drop from primary nav, keep route". Owner's progressive-disclosure rule favours Codex; adopted: nest under Learn.
- *Infra strength:* Codex "not demonstrated comparatively strong"; Claude "core strong, edge/lifecycle weak". Left as stated.

**UNCERTAIN / NEEDS MORE EVIDENCE**

- Cause of Lighthouse 0.93 (compose) vs ≥0.95 CI gate (harness).
- Whether the API XFF spoof is exploitable through the shipped nginx (code-confirmed, not exercised).
- Whether Helm's missing `ENGINE_BOT` actually yields a silent bot on a cluster (not deployed).
- Endgame.ai's current capabilities.
- First-admin bootstrap procedure (not found; not exhaustively searched).
- Real-device mobile, screen-reader, and non-Chromium behaviour.

---

## 14. Top launch blockers — P0

1. **Gateway caps the whole site at 20 browser sockets per replica; API per-IP limits are spoofable.** Evidence: 25 proxied sockets → 20 open, 5 × `1013 connection limit exceeded`; `serve.ts:566-569`; `scripts/serve.ts:13` + `http/router.ts:373` + nginx `$proxy_add_x_forwarded_for`. Impact: 21st tab refused; rate limits evadable. Files: `services/gateway/src/serve.ts`, `packages/api/src/http/router.ts`, `docker/web/nginx.conf.template`, Helm gateway/web templates. Acceptance: with a trusted-hop contract, 100 proxied sockets from distinct forwarded IPs open; a spoofed XFF from an untrusted hop is ignored; regression test through real nginx. **Size M.**
2. **First-party engine/coach assistance during live rated human games.** Evidence: Analyse returned Stockfish lines mid-game; `game-mount.ts:317` gates on auth/variant only; `/v1/analysis` takes arbitrary FEN; Study Partner `routes.ts:1922,1955`. Acceptance: while the caller has a live game (authority/event-log status, not projection), analysis/puzzle/coach/opening/explanation/study-partner requests are refused server-side and hidden client-side; post-game and training contexts unaffected; concurrent tabs covered. **Size M (containment) / L (full policy).**
3. **Games are never recorded as results.** Evidence: `games` rows `ply_count 0, result NULL` after finished games; `updateProgress/finish` uncalled. Acceptance: an event-log-driven, checkpointed projector covers seek/bot/tournament creation paths, progress and completion; replay/backfill idempotent; `/v1/games/{id}` and history reflect results; integration test asserts it against Postgres. **Size L.**
4. **Ratings never applied; pools undefined.** Evidence: `ratings.upsert` 0 callers; `PRIMARY KEY (user_id, variant)`, no speed. Acceptance: pools decided (variant × speed class); each eligible result applied exactly once to both players; leaderboard/profile change after a rated game; concurrency-safe; test asserts a rating changes. **Size L (depends on 3).**
5. **Concurrent refresh revokes all sessions.** Evidence: reproduced r1=200/r2=401/winner=401, `auth.refresh.reuse` logged; `auth/service.ts:259`; `session.ts:167,180`. Acceptance: two simultaneous refreshes with one cookie yield one valid successor and no account-wide revocation; genuine reuse still revokes; transient failures don't clear the local session. **Size M.**
6. **Timed-match lifecycle: no autonomous clock expiry, clock starts before creator arrives, seeks never expire, creator redirected to finished games.** Evidence: §5; screenshot 9:51; `pg/repositories.ts:584-616`; `lobby-controller.ts:77,98`. Acceptance: server ends flagged games without a claim (incl. both-disconnected); clock starts on first join/first move per policy; abandoned seeks expire; no redirect to ended games. **Size L.**
7. **Owner release gates (functional-but-decisive):** shipped identity is the rejected Gambit/teal; Arabic absent; no privacy/terms/fair-play pages or AGPL source link. Acceptance: Rookzen tokens/wordmark/manifest/icons, dark-first default, Play-first landing, EN/AR shell with `dir` switching, policy pages (owner content). **Size XL across PRs (wiring S/M each; content is an owner dependency).**

Not P0 (deliberately): Helm parity, login lockout, messaging abuse budget, tournament reporter (conditional on enabling those surfaces publicly), a11y grid rows, performance headers.

---

## 15. P1 — launch-quality work

Login-throttle redesign (bucket after verification; keep per-handle guessing protection); messaging/seek admission budgets or ship messaging off; tournament reporter replay/retry + operator UI + first-admin bootstrap; Helm `ENGINE_BOT`/reporter parity; compose/nginx acceptance job (extends per PR); rematch + friend challenge; opponent handle/rating on seek rows; illegal-move feedback; bot presence label; finished-game action cleanup; not-found + unavailable-capability pages; `<main>` landmark on all routes; board `role=row` wrappers + piece names; 44 px nav targets; gzip + immutable cache headers; 40-move review ceiling → critical-moments fallback; game PGN export; settings surface (language, board, sound); account deletion/export; moderator report flow; backup + restore drill; stale docs (`FEATURE_PARITY_AUDIT.md:40`, `SECURITY_AUDIT.md:151`).

## 16. P2 — competitive differentiation (not table stakes)

- **Invite-a-friend → play → rematch → review together** — real opportunity (removes dependence on lobby liquidity; uses existing social graph).
- **Critical-moment → "add to my training" → spaced revisit → "did it transfer?"** — real opportunity in this product; outcome value is a hypothesis.
- **EN/AR parity done excellently inside a global product** — real opportunity by owner direction; exclusivity unproven (Lotus has Arabic UI per appendix).
- **Dialect coaching** — hypothesis (quality and benefit unmeasured).
- **Calm, play-first shell as retention lever** — hypothesis.
- **Free + AI + everything** — unsupported (Lichess owns "free"; owner rejects AI-first).

## 17. P3 — later

Chess960-only analysis variants expansion, opening explorer from user games, puzzle rating/streak modes, voice coach, tournament commentary, GraphQL, semantic search with a real embedder, canary/blue-green adoption, Terraform, 100k load, HPA/PDB/NetworkPolicy, native apps.

## 18. Things to remove, hide, simplify or defer

| Action What                      |                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REMOVE                           | Live-game assistance access in prohibited contexts; Gambit branding; "Offline" label for bots                                                                                                                                        |
| HIDE (route stays, honest state) | Rated mode until 3–4 land (say "casual only for now"); messaging/tournaments until their gates pass; Courses/Studies/Achievements while disabled (explain, don't 503); semantic/hybrid search modes (relabel "experimental" or hide) |
| NEST                             | Endgames under a visible Learn entry (not top-level nav)                                                                                                                                                                             |
| SIMPLIFY                         | The five stacked sidebar tool panels → one post-game "Review" surface with disclosure                                                                                                                                                |
| DEFER                            | Review-label taxonomy investment, voice/commentary/AI breadth, rollout strategies, rewrites, more variants, Signature B deep-dive beyond CI mitigation                                                                               |

## 19. Top 10 reasons a user would choose a competitor today

1. Their rated games count; here they don't.
2. The site hands opponents Stockfish during rated play.
3. Two tabs can log them out everywhere.
4. The match clock started \~10 s before they saw the board.
5. They see a login form before they see chess.
6. They can't tell whom they're accepting a game from.
7. They can't challenge a friend or rematch.
8. Review refuses games over 40 of their moves.
9. No Arabic, no accessible board structure.
10. Nothing here they can't already get free on Lichess, with people online.

## 20. Top 10 opportunities to become better than competitors

Real opportunity: (1) friend-challenge/rematch loop wired to teams/friends; (2) critical-moment → practice → transfer loop from the player's own games; (3) EN/AR parity with proper RTL and mixed-direction notation; (4) calm play-first shell (Lichess simplicity + Chess.com post-game guidance without the funnel); (5) engine-evidence-first explanations (fact rows before prose — already designed well).
Hypothesis: (6) dialect coaching; (7) club/academy workflows built on existing teams/studies; (8) honest "proof cards" of improvement with sample size.
Unsupported idea: (9) "most advanced platform"/feature parity as a message; (10) AI-first identity or semantic search as a moat.

## 21. Minimum Credible Launch

Casual + rated human play and vs-computer, where: sockets aren't capped by the proxy; assistance is refused during live games; every game finishes (server expiry), is recorded, and rates both players; refresh is concurrency-safe; seeks expire and show the opponent; Rookzen identity, dark-first, Play-first landing with contextual sign-in, not-found/unavailable states; EN + AR shell with RTL; privacy/terms/fair-play pages + AGPL link; post-game review (with long-game fallback) and Play vs Computer; profile/history/leaderboard truthful; messaging/teams/tournaments/learning either gated-honestly or off; compose/nginx acceptance covering the above; backup + restore proven once.

## 22. Competitive V1

Add: friend challenge + rematch; puzzles as a rated training loop; "add to my training" from review; tournaments operable (reporter replay, operator UI, public arenas); moderation UI + report flow; Arabic beyond the shell (review/coach prose); settings; PGN export; a11y board rows + screen-reader pass; performance headers; Helm-deployed staging with alerts; measured retention funnel (game → review → practice).

## 23. Recommended implementation sequence (do not implement)

| # Title Goal Scope Deps Risk Size Acceptance  |                                            |                                                                                                            |                                                                            |                |      |   |                                                                      |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------- | ---- | - | -------------------------------------------------------------------- |
| 1                                             | Trusted edge contract                      | Correct client identity for WS + HTTP behind nginx; add compose/nginx acceptance job                       | gateway admission, API `clientIp`, nginx headers, Helm parity for the same | —              | low  | M | 100 distinct-IP proxied sockets open; spoofed XFF ignored; job green |
| 2                                             | Contain live-game assistance               | Refuse analysis/puzzle/coach/opening/explanation/study-partner while caller has a live game; hide controls | api routes + game-mount                                                    | 1 (acceptance) | med  | M | live rated game → 4xx + hidden; post-game works; concurrent tabs     |
| 3                                             | Concurrent-refresh safety                  | One winner, no account-wide revocation; genuine reuse still revokes                                        | auth/service, web session                                                  | —              | med  | M | reproduced race passes                                               |
| 4                                             | Seek lifecycle                             | Expire abandoned seeks; opponent identity in rows; no redirect to finished games                           | persistence, api, lobby                                                    | —              | low  | M | stale seek gone; redirect only to live games                         |
| 5                                             | Timed-game completion                      | Server-side flag expiry; clock start policy                                                                | game/authority/gateway                                                     | 4              | high | L | both-disconnected game ends; creator sees full clock                 |
| 6                                             | Durable games projection                   | Event-log-driven projector (create/progress/finish), checkpoint, backfill                                  | new worker + persistence                                                   | 5              | med  | L | history/API truthful; backfill idempotent                            |
| 7                                             | Ratings with explicit pools                | variant×speed pools; apply once; both players                                                              | migration + projector                                                      | 6              | med  | L | rating changes; leaderboard populates                                |
| 8                                             | Rookzen Play-first shell                   | Identity tokens, dark-first, landing, contextual auth, 404/unavailable, nested Learn                       | web                                                                        | — (parallel)   | low  | L | screenshots at 4 viewports; no Gambit strings                        |
| 9                                             | EN/AR shell localization                   | i18n layer, catalogue, `dir`, Noto Sans Arabic candidate, mixed-direction notation                         | web                                                                        | 8              | med  | L | AR journey screenshots; RTL a11y                                     |
| 10                                            | Public policies + AGPL/attribution         | Pages + footer links (owner supplies text)                                                                 | web                                                                        | 8              | low  | S | pages reachable, linked                                              |
| 11                                            | Login throttle + messaging budgets         | Bucket after verify; keep guessing guard; messaging/seek admission                                         | api                                                                        | —              | med  | M | lockout by third party impossible; flood refused                     |
| 12                                            | Tournament reporter recovery + Helm parity | Replay/retry; scan all running; `ENGINE_BOT`/reporter in Helm                                              | api/tournament, deploy                                                     | 6              | med  | L | missed result recovered on restart                                   |

## 24. The FIRST next PR

**PR-1 — "Trusted edge contract: proxy-aware identity for WebSocket admission and API rate limiting, with a compose/nginx acceptance job."**
Why first: it is the only defect that *physically prevents usage* (20 sockets per replica), it closes a code-confirmed spoofing hole in the same trust boundary, it is small and isolated (gateway `connection` handler, API `clientIp`, nginx headers, one Helm value), and it creates the production-path acceptance harness every later PR needs. Claude and Codex agree on this ordering. Include an explicit trusted-hop rule — merely reading `X-Forwarded-For` in the gateway would reproduce the API's mistake.

## 25. Final confidence / unknowns

Could not verify: Helm on a real cluster; backup/restore; production TLS/email/passkey ceremonies; real-device mobile, screen readers, Firefox/Safari; sustained load; API XFF spoof exploitation; social/messaging/teams/forums/studies/learning in the browser (API-level only; learning/studies were disabled); tournament lifecycle end-to-end (none exist); Endgame.ai current state; Lotus pricing/Arabic (rate-limited); Rookzen trademark/domain (not verified — remains not verified); accuracy of the team's 3320-test figure (not re-run); Lighthouse CI/local discrepancy; first-admin bootstrap; whether Signature B has any Linux analogue (no evidence it does). Confidence is high on every P0 (each reproduced at runtime or confirmed by absent callers in code), medium on sizes, low on anything commercial.

Audit complete. Nothing was fixed, committed, pushed, or merged.