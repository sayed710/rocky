# ZadLoop R-04 — reconnect authentication verification

This newly verified issue is separate from the historical Fable/Astra remediation closure.
`docs/PROJECT_STATE.md` is unchanged; its coordinated append is proposed below.

## Baseline and RED

- Isolated worktree `rocky-fix-reconnect-auth`, branch
  `fix/p1-reconnect-auth-20261011`, clean before reproduction tests.
- Origin is `https://github.com/sayed710/rocky.git`. Fresh origin/main and live GitHub
  main both equal `2f94dab05290eb33a8ce7c58b5790c65e37354d1`.
- GitHub confirms PRs #102, #103 and #104 merged; no open PRs at preflight.
- Read-only inspection of the R-03 worktree found overlap in GameSync and its tests.
  Owner coordination was requested; R-04 does not modify forwarding or backend authorization.
- Baseline full build and lint passed.
- Executed `node --test packages/web/dist-test/test/reconnect-auth.test.js` after test
  compilation: 2 discovered, pre-expiry control passed, expiry regression failed,
  zero skips. Token A initially joined as white; fake clock advanced 60 seconds;
  the real `AccessTokenService.verify()` returned `expired`; reconnect reused A;
  real `RealtimeGateway` returned `unauthorized`, with no `joined` player response.
  Transport is controlled/in-memory: this is real server-component integration,
  not live network or browser evidence.
- Executed `ws-generation.test.js`: obsolete socket `open` produced an extra open
  notification (3 rather than 2); the regression failed with zero skips.

## Root cause

GameSync caches the mount-time token and sends it on every open. The session manager
already owns proactive expiry, single-flight refresh, cooldown and invalidation, but
the mounted game's reconnect path does not consult it. GameSync also reports
`connected` on transport open before gateway authorization. WsClient has no socket
generation guard, so callbacks from a replaced socket can affect its successor.

## Delivery status

The correction uses the existing SessionManager expiry/leeway predicate for a
fresh token in the same JavaScript turn and `validAccessToken()` for a required
refresh. There is no JWT parser or second expiry/refresh lifecycle. SessionManager
still owns single-flight refresh, generation protection, definitive invalidation
and cooldown. Its only addition exposes the remaining cooldown for scheduling.

GameSync has three bounded recovery retries. They wait at least until the session
cooldown expires, including a server Retry-After. A transient failure keeps the
authenticated identity disconnected; it sends neither expired credentials nor an
anonymous join. After exhaustion, a localized Try again control starts another
bounded recovery without requiring a browser online event or reload, still subject
to the same session cooldown. The owner explicitly approved public-game spectator
continuation after completed logout or definitive invalidation. Logout request
immediately clears player role, pending commands and route privileges and suspends
joins while AuthApi settles. Completed loss opens a fresh anonymous socket and
requires a new gateway acknowledgment before marking the spectator connected.
Temporary refresh/network failures never take this anonymous path.

Each asynchronous join checks route and socket generations, current user, current
token and expiry before sending. Socket callbacks are fenced by generation and
duplicate opens are ignored. A successful gateway `joined` establishes connection
state; unsolicited snapshots cannot establish authorization. A rejected join clears
role/color. Hydration failures receive bounded join retries; authentication rejects
close without an automatic rejection loop and expose explicit recovery. Unknown
games remain terminal. Moves/actions
require an authorized connection. Authoritative snapshots clear pending commands;
reconnect never resubmits them and retains the existing ply/resume behavior.

Logout invalidates queued joins synchronously before AuthApi can await a shared
refresh. Account changes close the old socket and require a new server-assigned
seat. A newer same-account adoption surviving an older logout is mirrored again
when that logout settles, without reusing its obsolete authentication result.
GameController updates board ownership when that seat changes. A join frame
also rechecks ownership after synchronously observing a persisted logout barrier.
The current backend exposes no separate private-game visibility policy in its
gateway/game contracts. This change neither introduces nor bypasses one: a
server-denied anonymous join remains disconnected without the previous player
role. The access-denial seam test is not evidence of a deployed private-game ACL.
Tokens remain in memory and join frames; no new persistent storage, URL, log or
telemetry token path is introduced. Backend authorization is unchanged.

### Additional executed RED/GREEN checks

- A controller driver reproduced the account switch gap: color callbacks remained
  `[white]` rather than `[white, null, black]`. The corrected controller and the
  committed regression emit the expected ownership transitions.
- A cooldown driver reproduced scheduling a bounded recovery inside a 30-second
  server cooldown. The correction schedules at the manager's remaining cooldown;
  the real gateway accepts the later refreshed player join.
- A controlled SessionManager barrier callback reproduced `joined` setting
  connected=true after synchronously clearing the route. The corrected join
  publication checks epoch/socket again; the regression passes. This is a seam
  test of reentrancy, not a new live cross-tab certification claim.
- Initial committed-head reconnect/socket regressions: 19/19, zero failures/skips. The
  controlled gateway connection also closes on disconnect. A missed real
  authoritative move is recovered through a refreshed join and last-ply resume.
- Corrected full build and root lint/typecheck pass. All 19 hermetic workspaces pass
  with zero skips; that full web suite is 1537/1537. Scripts are 333/333.
- Test topology verifies 497 files across 21 explicit zero-skip suites, including
  the new regression files. Live-provider and database-dependent suites are separate.
- Chromium presence/reconnect suite: 3/3, zero skips/retries, including held refresh
  followed by actual UI logout, with no extra authenticated join. Browser time was
  advanced only in that page; verifier expiry is proved separately by component
  integration. No deployed Compose/Nginx/PostgreSQL certification is claimed.
- An earlier concurrent full browser run had 274 direct passes, six successful
  retries and one hard failure in the profile portion of the Arabic journey.
  A single-worker isolated rerun of all affected suites passed 131/131 with zero
  retries/skips. The corrected full Chromium acceptance then passed 282/282
  using four workers, zero failures, retries or skips. The command's worker/retry
  flags were later found to have been consumed by npm; only the observed reporter
  counts, not the intended invocation options, receive execution credit.
- The Windows gateway runner initially failed its service-URL preflight, and
  Docker Desktop's Linux engine was unavailable. That local execution blocker was
  subsequently resolved through an isolated native Linux source snapshot of
  `c0e51c13756bbaca385033fdc948a378f7b7ea41`, with hash-verified Node 22.23.3,
  PostgreSQL 18 and extracted Redis 8.0.5 binaries. The unchanged complete
  `npm test --prefix services/gateway` runner passed 88/88, zero skips, including
  genuine Linux SIGTERM and real database/Redis tests. Both disposable services
  stopped afterward. Snapshot archive SHA-256:
  `dbdbc6999e25879985e3d5de87c427c05081f2253dc5b2e72606ed53ec56d0ae`.
  No test-topology bypass or system package installation was used.
- All applicable CI jobs passed on `c0e51c1`, including the hosted complete gateway,
  Node 22/24 build/test, PostgreSQL integration, real-engine smoke, and browser/
  Lighthouse jobs. This older-head CI success does not certify later repairs.

### Genuine independent review and adjudication

Both reviews used the installed `agy-delegate` relay, agy 1.3.3,
`gemini-3.8-flash-high`, effort `high`, `--read-only`; no fallback was used.

| Review | Conversation | Result artifact SHA-256 |
| --- | --- | --- |
| Pre-fix, HEAD `2f94dab` | `a7aad7ff-d823-4ba0-a929-714092f40285` | `02d8980deabaeec3e30b7b221aa5bfade2484a7b713e498eef4576265e0ce9c2` |
| Initial post-fix diff against `2f94dab` | `31bce5a2-882a-4114-a326-a0adba6f4267` | `2a746dc4a3c598cc30c4431aef9318d391d7f9ecf7b24ecc6c097e4d3978a206` |
| Initial committed head `c0e51c1`, SOURCE VERIFICATION: PASS | `58f4b4fd-ab31-4696-b0f3-51ad7d4e1af2` | `ef7abd6cec4cd0393b8e97c9621912479423d57b47e8a8f4e6fc51b2c7f1b357` |

Artifacts were retained in task-specific temporary directories named
`r04-pre-review`, `r04-post-review`, and `r04-final-review`. The pre-review
fingerprint reports a change because Codex added
tests/evidence while Gemini inspected unchanged production. Those are Codex-authored
changes, not independently authored reproductions. The post-review fingerprint
reports `readOnlyViolation=false`.

Pre-review confirmed token stagnation, premature connected state, socket generation
gaps and missing mounted session-change handling. Its treatment of intentional
per-route session disposal as a defect was rejected. Some initial proposed race
tests failed because the refresh path did not exist; those failures receive no
standalone race proof credit.

Initial post-review verdict was APPROVE with no blockers. Codex nevertheless
reproduced and corrected the board ownership, long cooldown and synchronous logout
barrier gaps above. Gemini's 60-second default leeway claim was incorrect (the
manager defaults to 30 seconds). Its claim that active games are private was also
rejected: anonymous spectators remain legitimate. Snapshots/resumes cannot establish
authorization before `joined`, despite the report's imprecise wording.

A fresh independent review of the next exact committed HEAD with a clean worktree
and no concurrent writers is required after the review repairs below. CI, exact-head
Qodo (bugs/rules/actionable requirement gaps), Greptile, optional CodeRabbit and
zero unresolved threads remain publication gates. NOT READY FOR MERGE at this
source checkpoint. Owner alone merges. PR #105 (R-03) overlaps GameSync and its
test file; its timeout handling is not included here.

### PR #106 first external review round

Greptile's genuine fresh review explicitly identified `c0e51c1` and found a
same-account peer-refresh race: the old refresh could reject with NoSessionError
after the peer supplied fresh credentials, while AuthController suppresses
same-user notifications. A deterministic test exercised the actual SessionManager
channel adoption and reproduced no rejoin. The repair starts a new guarded join
operation using only the current fresh credentials for the same user.

Qodo reported five bugs and zero rule violations. Confirmed failures were
reproduced before production repairs: Black-to-White board orientation remained
flipped, transient hydration rejection scheduled no retry, and explicit recovery
could not reopen an intentionally closed rejected join. They are corrected with
orientation for each assigned player seat, bounded hydration retries, and explicit
recovery through a new socket. Spectators keep their chosen view orientation.
Refresh retry exhaustion now exposes a localized recovery control, with focus
restoration and listener cleanup regressions. The stale proposed gateway blocker
is corrected by the native Linux execution evidence above. The signed-out
live-update finding follows the owner's explicit approval: completed logout or
confirmed invalidation may watch a public game only after a fresh anonymous join.
Deterministic regressions cover immediate gesture/action revocation, delayed
refresh and obsolete player responses after spectator authorization, rejection of
anonymous access, and retained player identity during transient refresh failures.
A real AuthController/SessionManager logout regression also reproduced a missing
same-account adoption notification after an older logout; the repair publishes
only the current canonical session, never the old logout/refresh result.

The pre-policy repair suite passed all 19 hermetic workspaces (web 1544/1544).
The approved-policy suite passed all 19 hermetic workspaces (web 1549/1549),
full build, root lint/typecheck, scripts 333/333, and topology (498 files/21 suites).
The focused controller/route/recovery/reconnect selection passed 80/80; the
reconnect/socket security matrix passed 26/26, and live presence passed 4/4.
All have zero skips. The prior full Chromium repair pass was 283/283 with one
worker and zero retries/skips. The first approved-policy full run had 282 passes
and one `browser.newContext: Target page, context or browser has been closed`
failure before the Arabic/light seek-focus test entered its page. The complete
affected spec passed 7/7 in isolation with zero retries/skips. No source failure
or underlying browser-exit cause was established. The second full run (two
workers, zero retries) again had 282 passes and one identical context-creation
failure, this time before the seek-acceptance page opened. No application assertion
failed in either incident. The final committed snapshot will be verified with
the complete native Linux browser suite; its result and final-head gateway/model/
hosted gates are tracked on PR #106 rather than retroactively certified here.

These repairs require new exact-head model/CI/Qodo/Greptile evidence. Older-head
reviews and passing checks are historical only. No thread is resolved as fixed
before its correction is published. NOT READY FOR MERGE.

## Further independent review repairs (publication checkpoint)

All applicable hosted CI jobs passed on `9e1a2c7` in run `38138159529`.
Its exact git archive (SHA-256
`59ce376dafdf173209abe854cd300f2ada96a74bb0dc8d1eb4b21647e5544705`)
passed the unchanged native Linux gateway runner 88/88 and full Chromium 283/283
(two workers, zero retries/skips). Owned PostgreSQL and Redis services stopped.
These earlier-head checks do not certify the subsequent repairs.

Genuine installed agy-delegate Gemini 3.8 Flash High/high/read-only inspection of
clean `9e1a2c7` completed in conversation `8fe52eaf-e71a-4ded-8177-2cd33e8bd3a8`;
result SHA-256 `1155cde9474b1dd3c031a91b255cd702006ec1d3e75541c5c0c121b61477c68b`,
`readOnlyViolation=false`, no touched files. Its architecture PASS was challenged:
fresh Qodo and Greptile reviews found two functional gaps, both executed RED before
production repair. Gemini's requested new fixture cast cleanup was also accepted.

- Qodo: a locally fresh token rejected by the gateway was resent on Try again.
  Separate deterministic server/browser clocks reproduce real verifier expiry,
  real gateway unauthorized rejection and zero refresh attempts on recovery.
  The repair remembers the rejected join credential only in memory and uses the
  existing `SessionManager.refreshNow()` HTTP-401 recovery contract before reuse.
  Normal expiry still uses `validAccessToken()`. Both paths share manager refresh,
  generation protection and cooldown, without bypassing backoff. Repeated rejected
  credentials cannot be resent or create an unbounded refresh loop. Temporary
  recovery failure retains player identity and never anonymously downgrades it.
- Greptile: a second logout returned before the first held real AuthApi HTTP
  logout, causing early spectator continuation. The executed controller RED
  confirms the second operation settled early; logout now shares one pending
  operation, including synchronous callback reentrancy, until it settles. A held
  HTTP browser regression verifies two actual clicks cannot authorize watching
  early. Newer canonical adoptions and disposal still fence older completions.
- Qodo's low-priority browser assertion-message issue was valid: its message now
  belongs to `expect(actual, message)`, rather than an ignored `toBe` argument.

The repairs pass full build, root lint/typecheck, all 19 hermetic workspaces
(web 1553/1553), focused controller/route/recovery 84/84, reconnect/socket matrix
29/29, live presence 5/5, and topology (498 files/21 suites), with zero skips.
Fresh native Linux runtime/browser checks and a clean exact-final-head
model/CI/Qodo/Greptile review are required for publication certification.
No prior exact-head approval is reused. NOT READY FOR MERGE at this checkpoint.

## Subsequent account-boundary verification

The exact `14ffd0f` archive (SHA-256
`8c57f74a0bd8a3d2bfb2aab6a24649021e51abedf73ce19600ceebcc34ef7134`)
passed native Linux gateway 88/88 and full Chromium 284/284 with no retries/skips;
owned services stopped. Genuine Gemini high-effort read-only review completed
with source PASS, conversation `058ed8c5-6fe8-4f0f-a789-9ac3a1cfe559`, result hash
`058723fb0898ffc1268853131c419d5549db23b50c507daa574a98b3e6178176`,
`readOnlyViolation=false`, no touched files. This is superseded by later repairs.
The report's broad resource-leak assurance receives no heap-profiling credit.

Codex challenged that PASS with executed observer/API regressions. A newer
canonical credential set (same or different account) could have its explicit
logout absorbed by the old global pending lock. Both cases failed before repair.
Coalescing now matches the targeted user/credentials (or their already-cleared
store), and the existing controller generation fences older UI completions.
An older promise cannot clear the newer pending operation or resume watching.
The peer observer is deliberately injected; these are real manager/AuthApi tests
with controlled HTTP, not live cross-tab server integration claims.

A separate real AuthApi RED proved that a failed proactive refresh could return
a fresh different peer account through established manager recovery, then send
logout for that different account. A minimal frontend API guard checks the
original logout user after refreshing and observing the manager generation; it
cancels the obsolete operation without resetting or revoking the newer account.
SessionManager's existing refresh contract and backend authorization are unchanged.
Full build/root lint and all 19 hermetic workspaces pass again (web 1556/1556),
alongside focused controller/API/route/recovery 146/146 and live presence 5/5,
all with zero skips. Fresh native checks and exact-final-head
model/CI/Qodo/Greptile certification remain required and are tracked on PR #106.

## Proposed coordinated PROJECT_STATE append

ZadLoop R-04 was independently reverified against main `2f94dab`: a mounted game
reconnect sent its cached expired access token and the real gateway rejected it.
The correction reuses SessionManager validity/refresh/cooldown, requires gateway
join acknowledgment, fences obsolete sockets/async work, suspends when logout is
requested, and reauthorizes account changes. Owner-approved completed logout and
definitive invalidation require a fresh anonymous server join to watch public
games; temporary refresh failures preserve player identity and bounded recovery.
Server-rejected credentials use the same manager refresh recovery as HTTP 401,
and repeated logout requests coalesce by target credentials until settlement.
Controller generation and an original-user API guard protect newer account
adoption and newer explicit logout from older completions.
Component expiry RED/GREEN, 29 reconnect/socket regressions, full web 1556/1556,
all 19 hermetic workspaces, lint/build, and scripts 333/333 pass with zero skips.
Initial genuine Gemini review
was critically corrected; complete native Linux gateway runtime 88/88 also passed.
External review repairs and their fresh exact-head delivery gates remain pending.
This new issue does
not reopen or rewrite the historical Fable/Astra closure. Owner integrates the
final PR/head/gate record after verification; PROJECT_STATE is untouched here.

## R-03 integration checkpoint — 2026-10-11

Owner merged PR #105 into main 84b3d9d253dffcedab601967d2814600f6234cf5. R-04 integrates freshly fetched origin/main by a normal merge, preserving published history. The sole source conflict was the applySnapshot tail: retain lastReject: this.commandNotice(), connected: true, and recoveryAvailable: false. Surrounding message gates allow snapshot application to authorize only through a current joined acknowledgment; state/resumed frames require an already authorized connection.

Seven additional deterministic regressions combine real SessionManager/token verifier/gateway joins with controlled command receipt events. They cover unknown outcomes during expiry refresh, command gating, obsolete-socket receipts, exact late confirmations, multiple outstanding outcomes and refusal ordering, rejected rejoin, logout/account adoption during held refresh, transient recovery without anonymous fallback, original-seat readiness after account switching, and no automatic replay. Controlled receipt injection is not live Redis integration evidence.

Executed RED: with the conflict resolved but before the integration correction, a gateway unauthorized rejoin replaced the visible unknown-outcome warning with a rejection (33/34 tests passed, one failed). The correction records the join refusal in the existing refusal/uncertainty state and publishes commandNotice(), keeping prior uncertainty visible while revoking role and connection. Existing request identity, bounded retention, committed-state/readiness reconciliation and no-replay semantics remain unchanged.

The prior exact-head CI/review certification of 2187a14 is historical after this integration. Fresh combined full-repository, native Redis/PostgreSQL, browser, Gemini and hosted final-head gates are required before delivery readiness. docs/PROJECT_STATE.md remains untouched. This checkpoint is not a passing certification of pending gates or an owner merge.

### Combined-head Qodo correction checkpoint

Fresh Qodo review of integration head8982c1a reported one real defect: storing a join refusal as latestCommandReject overwrote an earlier definite command refusal and retained the authorization error after a successful join while uncertainty remained. Two executed regressions failed (34/36 reconnect-auth tests passed): prior refusal disappeared, and a recovered player still displayed the old token refusal. Genuine Gemini SOURCE PASS on8982c1a missed this behavior; its earlier universal completeness wording is not accepted as proof.

Correction: a separate in-memory joinReject tracks the active join refusal. commandNotice() can display it alongside unresolved command outcomes and the existing definite command refusal. A current authorized joined acknowledgment clears only joinReject before applying the snapshot; logout/session boundaries also clear it. The original command refusal, exact outstanding request identities, receipt ordering, readiness settlement and no-replay contract remain intact. Successful reauthorization does not imply an uncertain command was cancelled or confirmed. This is a source checkpoint; all new exact-head tests/reviews/publication gates must complete before readiness.
