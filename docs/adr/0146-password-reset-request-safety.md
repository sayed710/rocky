# ADR-0146 — Password-reset requests without a target lockout lever

**Status:** Proposed for owner review
**Date:** 2026-09-26

## Context

The public reset-request route charged a hard bucket keyed by the submitted handle or email (three
requests per hour). Anyone who knew an account identifier could spend that allowance and prevent its
owner requesting recovery. Simply dropping the bucket was unsafe: every accepted request replaced
earlier unused reset tokens, so rotating source addresses could invalidate the owner's links and
generate unbounded mail.

## Decision

- Keep the per-IP admission limit, but do not refuse based on a target identifier supplied by an
  unauthenticated caller.
- Issue a fresh, random, SHA-256-hashed reset token only when that account has no unconsumed,
  unexpired reset token. Lock the stable user row before checking and inserting, so independent API
  replicas cannot issue or email two tokens concurrently. A live token suppresses both replacement
  and further email. Existing 30-minute expiry, atomic single-use consumption, password update, and
  session revocation remain unchanged. No schema migration is needed.
- If the mail provider definitively rejects or throttles delivery, delete only that exact unused
  token so another request can retry. A timeout, thrown sender, or unreadable provider response is
  ambiguous; the token may have reached the mailbox and remains usable.
- Return the same `202` status, empty body, and response-header semantics for known and unknown
  identifiers before account lookup or email I/O. Accepted work uses the already tracked background
  lifecycle from ADR-0145; graceful shutdown drains nested delivery/cleanup work before closing
  the database pool.

An attacker can cause the first reset email to be sent, but it goes to the owner's mailbox. Further
requests cannot invalidate it or flood that mailbox while it remains usable. The policy is scoped to
password reset; login step-up and email verification retain their separate contracts.
