# ZadLoop R-04 — reconnect authentication verification

This newly verified issue is separate from the historical Fable/Astra remediation closure.
`docs/PROJECT_STATE.md` is unchanged; its coordinated append is proposed below.

## Baseline and RED

- Isolated worktree `C:/Users/hp/rocky-fix-reconnect-auth`, branch
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
anonymous join. A later online/reconnect event may start another bounded recovery,
still subject to the same session cooldown. Definitive loss suspends joining.

Each asynchronous join checks route and socket generations, current user, current
token and expiry before sending. Socket callbacks are fenced by generation and
duplicate opens are ignored. A successful gateway `joined` establishes connection
state; unsolicited snapshots cannot establish authorization. A rejected join clears
role/color and closes the socket without an automatic rejection loop. Moves/actions
require an authorized connection. Authoritative snapshots clear pending commands;
reconnect never resubmits them and retains the existing ply/resume behavior.

Logout invalidates queued joins synchronously before AuthApi can await a shared
refresh. Account changes close the old socket and require a new server-assigned
seat. GameController updates board ownership when that seat changes. A join frame
also rechecks ownership after synchronously observing a persisted logout barrier.
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
- Focused final reconnect/socket regressions: 19/19, zero failures/skips. The
  controlled gateway connection also closes on disconnect. A missed real
  authoritative move is recovered through a refreshed join and last-ply resume.
- Corrected full build and root lint/typecheck pass. All 19 hermetic workspaces pass
  with zero skips; the final full web suite is 1537/1537. Scripts are 333/333.
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
  using one worker, zero failures, retries or skips.
- Gateway-service build passes. The complete runtime test command fails its
  required DATABASE_URL/REDIS_URL preflight. Docker Desktop's Linux engine remains
  unavailable after a startup attempt; Windows denied starting its service. No
  test skip, topology bypass, factory reset or host configuration change is used.

### Genuine independent review and adjudication

Both reviews used the installed `agy-delegate` relay, agy 1.3.3,
`gemini-3.8-flash-high`, effort `high`, `--read-only`; no fallback was used.

| Review | Conversation | Result artifact SHA-256 |
| --- | --- | --- |
| Pre-fix, HEAD `2f94dab` | `a7aad7ff-d823-4ba0-a929-714092f40285` | `02d8980deabaeec3e30b7b221aa5bfade2484a7b713e498eef4576265e0ce9c2` |
| Initial post-fix diff against `2f94dab` | `31bce5a2-882a-4114-a326-a0adba6f4267` | `2a746dc4a3c598cc30c4431aef9318d391d7f9ecf7b24ecc6c097e4d3978a206` |

Local artifacts are under `C:/Users/hp/AppData/Local/Temp/r04-pre-review` and
`r04-post-review`. The pre-review fingerprint reports a change because Codex added
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

A fresh independent review of the exact committed final HEAD with a clean worktree
and no concurrent writers remains required after these corrections. CI, exact-head
Qodo (bugs/rules/actionable requirement gaps), Greptile, optional CodeRabbit and
zero unresolved threads remain publication gates. NOT READY FOR MERGE at this
source checkpoint. Owner alone merges. PR #105 (R-03) overlaps GameSync and its
test file; its timeout handling is not included here.

## Proposed coordinated PROJECT_STATE append

ZadLoop R-04 was independently reverified against main `2f94dab`: a mounted game
reconnect sent its cached expired access token and the real gateway rejected it.
The correction reuses SessionManager validity/refresh/cooldown, requires gateway
join acknowledgment, fences obsolete sockets/async work, suspends on logout and
reauthorizes account changes. Component expiry RED/GREEN, 19 focused regressions,
full web 1537/1537, all 19 hermetic workspaces, lint/build, scripts 333/333 and full
Chromium 282/282 (including three live reconnect cases) pass with zero skips.
Initial genuine Gemini review
was critically corrected; exact-head delivery gates remain separate. Gateway
runtime is locally blocked by unavailable Docker/services. This new issue does
not reopen or rewrite the historical Fable/Astra closure. Owner integrates the
final PR/head/gate record after verification; PROJECT_STATE is untouched here.
