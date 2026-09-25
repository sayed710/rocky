# ADR-0145 — Login step-up instead of account lockout

**Status:** Proposed for owner review
**Date:** 2026-09-25

## Context

Audit P1-1: password login charged a per-handle bucket before checking the password. Anyone who knew a handle could spend it and refuse the owner's correct password. Two intermediate fixes on PR #63 showed that the problem has two properties that pull against each other:

- Any account-wide bucket that **refuses** before authentication is a lockout lever. With a 50-failure cap, ten addresses refused the owner for the rest of the window.
- Removing account-wide limits leaves password guessing across many addresses bounded only per address, which is effectively unbounded.

Rookzen has no production users, so the owner chose to require a second proof past a threshold, rather than refuse, and to make every password account carry a verified email that can receive it.

## Decision

- **Registration requires an email.** A password account cannot sign in with its password until the email is verified. A correct password on an unverified account re-sends the verification email and answers `403` with `details.reason: email_unverified`. The registration response still carries a session, as before.
- **Normal traffic** is admitted against the per-IP bucket (every attempt) and a per-handle-and-source failure budget. That budget's slot is reserved at admission and refunded only when a session is issued. One address exhausting its own budget cannot affect anyone else.
- **Account-wide failure count.** `RateLimiter.tally` counts failed attempts per submitted handle (10 per 15 minutes by default) in the shared limiter. It never refuses. A request past the threshold is in step-up mode.
- **Step-up.** In step-up mode a password alone does not sign in. The owner either:
  - uses passkey login, whose options are limited per IP only; or
  - sends the password together with an 8-digit code emailed to the verified address.
  A code is issued only when a correct password on a verified account arrives without one. It lasts 10 minutes, is single-use (deleted when used), and dies after 5 wrong codes presented *with the correct password*. At most one is live per account, enforced by a partial unique index, and a live code is never replaced. A guess without the password can neither trigger an email nor spend the owner's code.
- **Uniform answers.** Every failure in step-up mode — wrong password, correct password, unknown handle, missing or wrong code — is the same `401` with `details.reason: step_up_required`. The code statements run in every case, with a decoy id for an unknown handle, so neither existence nor password correctness changes the answer.
- **Error vocabulary.** `ErrorCode` stays closed; the specific reasons travel in `details.reason`, following the fair-play guard's precedent.

Migration `packages/persistence/migrations/0037_login_step_up.sql` adds the token kind, the attempt counter and the one-live-code index. The web sign-in form shows a code field only after a `step_up_required` answer, and registration refuses a blank email before sending anything.

## Limits

- Past the threshold, every password sign-in for that handle needs the code or a passkey until the failure window ends. An attacker can keep a handle in step-up; that costs the owner one email round trip, never access.
- An unverified account answers a correct password differently (`403`) from a wrong one (`401`). Such an account cannot sign in with its password at all, and the per-source budget and account-wide count still bound guessing against it.
- Code issuance and checking perform slightly different database work depending on whether the password was correct. The difference is a single statement's row effect inside the same round trip, and it is dominated by the password hash; this matches the existing decoy-hash approach.
- No CAPTCHA, proof-of-work or third-party verification provider is involved.
