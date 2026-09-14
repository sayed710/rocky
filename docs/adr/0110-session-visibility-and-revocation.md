# ADR-0110 — Session visibility and revocation

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-16                                                         |
| **Design mode** | **Operate** — the visitor is auditing where their account is signed in and ending a session they do not recognise. Scanability and consistency with the passkeys panel it sits in outrank expression; see `packages/web/CLAUDE.md`. |
| **Scope**  | `packages/api` (`routes.ts`, `auth/service.ts`, `presenters.ts`, `openapi/schemas.ts`), `packages/persistence` (`repositories.ts`, `pg/repositories.ts`), `packages/web` (`api/client.ts`, `api/models.ts`, `net/session.ts`, `app/auth-controller.ts`, `app/sessions-controller.ts`, `app/sessions-view.ts`, `app/profile-mount.ts`, `index.html`) |

---

## Context

`GET /v1/auth/sessions` has existed since M4 and the web client has had a typed `sessions()` binding
for as long, but nothing rendered it and nothing could end a session. A user who suspected one of
their sessions was compromised had no way to see it and no way to stop it: `POST /v1/auth/logout`
ends the caller's *own* session via its refresh token and cannot reach any other.

`docs/FEATURE_PARITY_AUDIT.md` recorded this row as `Runtime/API: Yes` for "Session
list/revocation", which was wrong for the revocation half. The route table has never contained a
revocation endpoint. That claim is corrected in the same change.

The domain was already complete: `SessionsRepository` exposes `revoke(id, at)` and
`listForUser(userId)`, and `AuthService.logout` already revokes through them. What was missing was a
route, a client method, and a surface.

## Decisions

### 1. Ownership is structural, not compared

`AuthService.revokeSession(userId, sessionId, meta)` looks the candidate up *within*
`sessions.listForUser(userId)`. A session belonging to anyone else is simply not in that set, so
there is no code path where a caller-supplied id reaches `sessions.revoke` without having first been
found among that user's own rows.

This is the shape `deletePasskey` already uses, and it is preferred over fetching the row and
comparing `session.userId === identity.userId`. Both are correct when written correctly; only one of
them is still correct when someone later edits the function and forgets the comparison.

A session id that is not the caller's answers **404, not 403**. Distinguishing "not yours" from
"does not exist" would make the route an oracle for whether an id names a live session anywhere on
the platform. `packages/api/test/openapi.test.ts` asserts the spec does not advertise a 403 for
exactly this reason.

### 2. Revoking twice succeeds twice, and audits once

An already-revoked session returns `204` rather than an error. The caller asked for that session to
be dead and it is dead, so there is nothing to report — and it means two simultaneous revocations of
the same id both succeed instead of one losing a race. `AuthService.logout` already applies the same
tolerance.

The audit record is written once because `SessionsRepository.revokeChainForUser` performs the
conditional update atomically and reports how many rows this call transitioned. The first shape of
this was a `revokedAt` check in the service followed by an unconditional update, which is a
read-then-write race: two concurrent `DELETE`s both saw an active row and both audited one
revocation.

### 3. A session is a chain, not a row

Every `refresh` retires the current row and inserts a successor linked by `rotatedFrom`, so what a
user points at in the list is the newest row of a chain. Revoking only that row leaves the browser
signed in whenever a refresh lands between the list being read and the revocation being written: the
`DELETE` answers `204` while the successor it never saw is still a working refresh capability.
`revokeSession` therefore asks the repository to revoke the whole descending chain in one
transaction. The PostgreSQL implementation takes the same per-account advisory lock as refresh
rotation, so neither operation can insert or overlook a successor while the other is updating the
chain.

This also decides what `refresh` does with a revoked row. It cannot treat every revoked row as token
theft, which is what it did originally: the browser whose session was *deliberately* revoked will
present its token within one access-token lifetime, doing exactly what any client does, and burning
the account for it would mean that ending one session signs the user out of all the others — the one
thing this feature promises not to do. A **live successor** separates the two cases. If the row was
rotated away and something is still refreshing from its replacement, a token the real client already
exchanged is being replayed. A presentation inside the configured bounded grace window is rejected
with `401` without revoking the successor, allowing near-simultaneous tab refreshes and immediate
network retries to fail safely; a presentation outside that window revokes every active session
chain for the account. If the row was
deliberately revoked, no descendant survives it (see above) and the answer is a plain `401`.

### 4. Current-session behaviour follows from the token design

The obvious product question is whether the endpoint should refuse to revoke the caller's own
current session, or mark it in the UI. **It cannot do either**, and this is a fact about the existing
architecture rather than a choice made here:

- `AccessTokenClaims` (`packages/api/src/auth/tokens.ts`) carries `sub`, `handle`, `roles`, `iat`,
  `exp` and `jti`. There is no session id.
- `jti` is `this.ids.next()` — a fresh id minted per token, unrelated to the session that issued it.
- The client is in the same position: the refresh token lives in an httpOnly cookie it cannot read,
  and the access token it holds names no session.

So neither side can identify "this session". Marking one in the UI would mean guessing from
`lastSeenAt` and user agent, which is a heuristic presented as a fact — the interface would be
confidently wrong for a user with two similar browsers open, which is exactly the user most likely
to be looking at this screen. Nothing is marked.

Revocation is therefore uniform: any of the caller's sessions can be ended, including the one they
are using. That is the correct security behaviour anyway — a user who suspects compromise and cannot
tell which row is theirs must still be able to end all of them.

### 5. What revocation reaches, stated honestly

A session row **is** the refresh capability. Revoking it stops that session ever minting another
access token. An access token already issued keeps working until it expires, because `authenticate`
in `packages/api/src/server.ts` verifies it by HMAC signature alone and never consults the session
table.

The UI says so, in one line above the list: revoking signs that browser out when its current access
token expires. Promising an instant cutoff would be a promise the token design does not keep, and
implementing one would mean checking session state on every authenticated request — a different
architecture from the one this endpoint was added to, and out of scope here.

### 6. The list shows only what a user can act on

`GET /v1/auth/sessions` returns the account's whole session history, including revoked and expired
rows. The view filters to sessions that are neither, because a heading reading "Active sessions"
above a revoked row is false, and a revoked row carrying a disabled Revoke control is the
"control that can never enable" `DESIGN.md` rules out. Filtering also gives revocation its feedback:
the row leaves the list.

Rows read *device · address · last seen*. The device string is a deliberately crude mapping over the
user agent — enough to notice "there is a Linux session and I only own a Windows machine", never used
for any decision, and degrading to "Unknown device" rather than dumping a 120-character user-agent
string into a row built for one line. Any of the three parts may be absent, and none leaves a stray
separator behind when it is.

Each part reads the session's **created** metadata, not its `last*` fields. `SessionsRepository.touch`
exists but has no production caller, so `last_seen_at`, `last_ip` and `last_user_agent` are null on
every row: a first version of this view read only those and would have rendered every session as a
bare "Unknown device", which is a list of identical rows on the one screen whose entire purpose is
telling sessions apart. `created_ip` and `created_user_agent` are written by every session insert and
are now carried on `SessionView`. `createdAt` is the honest last-seen time without any new
write: refresh rotates the session, so an active row was created the last time that browser was here.

### 7. A revoked session stops looking signed in

Revoking the session the caller is currently using is allowed (decision 4), which makes "this browser
just lost its session without asking" a reachable state rather than a theoretical one. `SessionManager`
already cleared its own store when a refresh failed, but `AuthController` keeps a separate snapshot
and a persisted handle hint, so the header and account controls went on showing a signed-in user
whose every protected request answered 401 — until a reload.

`SessionManager` now takes an invalidation handler, registered by `AuthController` because the
controller is built from the client and cannot be passed to its constructor. It fires only on a
failed refresh, never on a deliberate sign-out, which the caller already knows about.

### 8. No second lifecycle idiom

`SessionsController` mirrors `PasskeysController` exactly: the same `requestGeneration` /
`pendingGeneration` pair, the same `disposed` flag gating every callback, the same `reset()` for
sign-out versus `dispose()` for teardown. The two sit in the same panel and are torn down by the
same route disposal; a second idiom here would be one more thing to get wrong.

It adds one guard the passkeys controller does not need: an `inFlight` set keyed by session id.
`onPending` disables the buttons, but that flag has to travel through a callback into the DOM, and a
second click landing in the same tick would otherwise issue a second `DELETE` for a state change that
happens once — and a second audit record for it.

On sign-out the section is cleared, not left rendered. A previous account's devices, addresses and
last-seen times remaining on screen for the next visitor is a disclosure, and a stronger one than the
friends list `profile-mount.ts` already clears for the same reason.

## Consequences

- A user can see where their account is signed in and end any of those sessions.
- `SessionView` gains the schema/presenter coupling test it never had, closing the drift class
  ADR-0088 has caught four times, on the view that is now this screen's entire data source.
- The parity audit no longer claims a revocation API that did not exist.

## Out of scope

- Session-aware access tokens. Binding a session id into the token would make immediate revocation
  and current-session marking possible, and would change every authenticated request path.
- A "revoke all other sessions" control, which cannot be built without knowing which one is current.
- Email verification UI, the other backend-only auth surface the parity audit lists.
