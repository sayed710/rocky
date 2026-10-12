# ADR-0160: Execution-time ownership admission

Date: 2026-10-12
Status: Owner-authorized R-01 PR2 D3 implementation; manual merge pending.
Prerequisite: PR #108, merged at `202eee3f833e479e43fcafb07f80e539b3361809`.

## Decision

A Redis-routed local intent captures one immutable admission identity before
hydration or waiting: node identity, registry claim generation and GameAuthority
slot lifecycle generation. Registry identity persists independently of router
reload debt. Continuous renewals keep identity; new claims, release and detected
loss invalidate old tickets. Slot generations are never reused after recreation.
Local expiry ends continuity: claim invalidates expired tracking before I/O,
and renewal checks expiry before dispatch and after its acknowledgement.
Ticket invalidation retains the consumer while Redis may still route to this
node. A successful renewal after local expiry establishes a new generation and
reload debt. Claim responses preserve continuity only for the same still-valid
generation observed before claim I/O, including overlapping claims.
Claim, release and renewal I/O is ordered in a separate per-game operation lane,
independent of the authority slot. Release changes a lane epoch synchronously,
even when admission identity is absent, so an in-flight claim or renewal cannot
restore released ownership. A cancelled claim gesture becomes command_expired
without forwarding. Continuous valid claims preserve identity; queued lease I/O
starts its expiry clock only when dispatched. Idle lanes are removed and repeated
renewal ticks share the outstanding write. Hooks never await slot hydration.

After takeover reload, application enters PR1's stable slot. Admission requires
current identity, settled reload debt, conservative local expiry and a matching
Redis owner. The comparison uses a dedicated connection with no offline queue,
resend or reconnect, bounded by one total deadline (default 1000 ms). It neither
renews nor acquires ownership. Lease expiry starts at Redis dispatch time,
rather than acknowledgement time.
The isolated per-intent connection is a deliberate minimal-repair tradeoff;
shared connection pooling and public-scale throughput are not certified here.
Operators can observe comparison duration via
`gateway_ownership_check_duration_seconds` and refusals via
`gateway_ownership_check_failures_total`, with only the bounded reasons
timeout, error, mismatch and invalidated. No game IDs or raw errors are labels.

After asynchronous validation, the slot synchronously rechecks identity,
expiry, lifecycle and freshness immediately before domain execution. Reload
requested during validation causes refusal; admission never calls a public
reload that would enqueue behind its own lock. Failure is a definite
`command_expired` refusal before mutation/persistence, without success receipt,
reacquisition, rebinding, forwarding or automatic replay of the obsolete gesture.

Forwarded commands prepare claim debt outside the slot and retain their original
ticket. START_REQUEST remains the separate atomic Redis owner/deadline/exact
identity admission. An early refusal settles the queued identity before
reporting expiration; a START_REQUEST expiry already proves its tombstone.
Existing requestId, commandConfirmed, duplicate and unknown-outcome semantics
remain. LocalCommandRouter requires no Redis lease or ownership ticket.

## Boundary

The first command already admitted before ownership loss may complete its
durable append. This closes the demonstrated waiting window; a Redis comparison
is not PostgreSQL fencing. Takeover after admission, including an old owner's
late append, remains possible. Strong PostgreSQL fencing must be staged
separately before public multi-gateway production.

No revision contract, durable recovery, draw propagation, capacity policy,
production migrations or changes to PR #106/#107 are included.
