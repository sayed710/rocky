# R-03 forward-timeout reproduction and owner decision

Historical pre-approval record: production implementation was stopped pending
the owner's timeout-contract decision. The owner subsequently approved option 1.
Current implementation and validation are recorded in
[the R-03 verification note](FORWARD_TIMEOUT_R03_VERIFICATION_2026-10-11.md).
This separate audit does not reopen historical Fable + Astra closure.

## Verified baseline

- Isolated worktree: `C:/Users/hp/rocky-fix-forward-timeout`.
- Branch: `fix/p1-forward-timeout-20261011`.
- Initial tracked/untracked state was clean.
- After `git fetch --prune origin`, HEAD, origin/main and `git ls-remote origin
  refs/heads/main` all matched `c4462c1725b108e18d6bd35a4e9306dc11be8f02`.
- That commit is merged PR #103, tournament withdrawal recovery.
- Open PRs #102 (web review/puzzles/topology tests) and #104 (deployment) had no
  overlap with the forwarding implementation or this regression file.
- Canonical checkout `C:/Users/hp/shatarang` was not modified.
- Reviewed project-state context, audit index and historical audit architecture
  findings, ARCHITECTURE realtime contract, ADRs 0008, 0010, 0077, 0078, 0144,
  0148 and 0149. Historical deferred findings are outside this task.

## Root cause and original RED

`ForwardedCommand` has a request UUID but no execution deadline or cancellation
state. `RedisCommandRouter.forward` enqueues a JSON envelope with RPUSH and waits
on a dedicated response BLPOP. A null result attempts takeover and, if it fails,
throws `AuthorityError('invalid_command', 'command forward timeout')`. Neither
branch cancels/removes the original envelope. A successful takeover applies the
command locally without using the envelope's request identity.

`OwnerCommandConsumer.processCommand` loads the game and calls authority.apply
without checking request expiry or deduplicating request IDs. Authority.apply
serializes per game, but the check would need to cover waiting on that lock and
any stale-log reload too. The event-log append contract has optimistic sequence
checks, not a durable logical-request ledger or cancellation primitive.

Focused regression:

```text
npm run build:server
npm run build --prefix services/gateway
npx tsc -p services/gateway/tsconfig.test.json
node --test services/gateway/dist-test/test/forward-timeout-regression.test.js
```

Builds and test compilation passed. Two tests ran, one failed and one passed,
with zero skips/cancellations. The delayed-consumption test first observes the
forward timeout rejection and the queued request, then invokes the production
consumer. Its unchanged-event-log assertion fails because a new seq=1
`GameEnded { result: '0-1', termination: 'resignation', winner: 'b' }` was appended.
This is a deterministic **simulated-transport** reproduction, using actual
production router/consumer/authority and shared InMemoryEventLog. It is not
real-Redis or PostgreSQL evidence.

The second test lets the owner commit, discards its acknowledgement in the
transport, and then reports a timeout. It passes: exactly one GameEnded remains,
and a newly loaded authority replays the ended game. This establishes that the
same current timeout error can describe both an unexecuted queued command and
an already committed result.

Gateway lint and `npm run check:test-topology` passed (494 files across 21 suites;
the new test is classified into the explicit gateway suite).
Real-Redis/multi-process/full gateway checks were not run:
Docker Desktop's Linux engine pipe was unavailable before and after a hidden
startup attempt; no local Redis server or connection was established. The
Windows full gateway runner requires Linux Docker, DATABASE_URL and REDIS_URL.
No complete-suite, real-Redis or persistence acceptance is claimed.

## Contract decision required before production edits

The task explicitly says: "If an unavoidable semantic decision needs owner
approval, document the alternatives and stop before implementing that policy
change." The current wire contract calls the timeout a rejection. The passing
lost-ack test proves that cannot imply cancellation of a durable result.

Choices presented to the owner:

1. **Recommended:** atomically cancel requests that have not been admitted to
   execution; report outcome unknown if execution began but the durable outcome
   cannot be confirmed. Preserve committed events and prohibit automatic replay
   of that request. Any retry identity/reconciliation behavior must be explicit.
2. Keep waiting for a definitive durable result once admitted. The configured
   forward timeout would bound queued admission rather than response latency.
3. Require timeout to guarantee no commit, and assess a broader persistence-level
   cancellation design. Redis admission/deadlines alone cannot provide that
   guarantee across an asynchronous PostgreSQL append or lost commit reply.

These are alternatives, not approved product policy. No production deadline,
deduplication, takeover or client protocol change has been made. No committed
result has been rolled back. Implementation must also account for Redis clock
authority, lock-boundary admission, lease changes, fail-closed stale envelopes,
mixed versions, bounded cleanup and durable autonomous expiry retries.

## Genuine independent pre-fix review and discussion

Installed `agy-delegate` relay, agy 1.3.3, model `gemini-3.8-flash-high`, high
effort, read-only; no fallback. Conversation:
`e6778f70-34de-4228-b0d8-07b838f8960c`.

Raw artifacts are outside the repository:

- `C:/Users/hp/AppData/Local/Temp/rocky-r03-prefix-review/result.json`
- `C:/Users/hp/AppData/Local/Temp/rocky-r03-prefix-challenge/result.json`

The initial brief supplied no proposed implementation. Gemini independently
inspected forwarding, leases, authority locking, PostgreSQL append and expiry
workers. It confirmed missing request expiry/cancellation, possible late
execution, takeover duplicate attempts and lost-ack ambiguity. It also discussed
consumer freshness, which was not added to R-03 implementation scope.

Codex challenged the initial report's PostgreSQL evidence overclaim, omission of
move `clientSeq`, conflation of duplicate attempts with duplicate commits,
unsafe optional fallback for legacy envelopes, overstated lease-margin fencing,
and dequeue-only deadlines. Gemini accepted all six corrections in a resumed
read-only discussion. It corrected misnamed ADR paths. Its initial "zero edits"
claim must be interpreted carefully: the relay's first `readOnlyViolation=true`
reflects these two files being added by **Codex while the review was running**.
That first fingerprint does not independently attest reviewer non-mutation.
The resumed challenge ran with no concurrent Codex mutations and returned
`readOnlyViolation=false`. The source baseline remains unchanged.

Codex's final adjudication preserves two limitations in the corrected report:

- Existing PgEventStore accepts optional AbortSignal and checks it before
  COMMIT, but that does not prove cancellation after COMMIT dispatch or resolve
  a lost commit acknowledgement. The authority EventLog seam does not pass that
  signal today. No cancellation guarantee is inferred from the optional type.
- A new default TTL assigned when an old envelope is consumed cannot establish
  its original age. It cannot safely authorize an arbitrarily old envelope.
  Lease/freshness changes are distinct work; Gemini's broader labeling of them
  as R-01 is not a verified mapping of the separate audit's scope.

Unresolved: owner-facing unknown-outcome contract, admission versus durable
commit deadline, Redis clock reference and safe mixed-version deployment.
These are not evidence of a completed correction. Post-fix and final-commit
reviews have not been run because no production implementation exists.

## Delivery status at the pre-approval stop

Only the focused RED regression and this evidence note are local/uncommitted.
No implementation commit, push or PR was created. Post-fix/final-head review,
CI, Qodo, Greptile, CodeRabbit and review-thread gates do not have new candidate
evidence. The owner alone controls merge.

Proposed append-only PROJECT_STATE entry for coordinated integration:

> 2026-10-11: Separate ZadLoop R-03 forwarding audit reproduced delayed
> resignation after timeout against PR #103 main c4462c1 using production
> routing/authority with simulated Redis transport. Lost-ack replay control
> confirms committed results survive. Implementation stopped before timeout
> policy changes pending owner contract choice; real Redis/full gateway evidence
> unavailable locally. NOT READY FOR MERGE; historical audit closure unchanged.

`docs/PROJECT_STATE.md` was not edited while other PRs were open.
