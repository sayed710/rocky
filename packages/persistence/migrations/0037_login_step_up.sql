-- Migration 0037 — Login step-up codes (audit P1-1). See docs/adr/0145-login-step-up.md
--
-- When distributed failed logins push a handle past its account-wide threshold, a password alone no
-- longer signs in: the owner also proves control of the account's verified email with a short-lived
-- code. A code row is deleted when it is used, so the table never keeps a spent one.

ALTER TABLE identity_tokens DROP CONSTRAINT identity_tokens_kind_check;
ALTER TABLE identity_tokens ADD CONSTRAINT identity_tokens_kind_check
  CHECK (kind IN ('password_reset', 'email_verify', 'webauthn_register', 'login_step_up'));

-- Wrong codes presented alongside the correct password. A code stops working after a few.
ALTER TABLE identity_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);

-- At most one outstanding code per account, so repeated requests cannot mint a spread of valid codes.
CREATE UNIQUE INDEX identity_tokens_one_login_step_up
  ON identity_tokens (user_id) WHERE kind = 'login_step_up';
