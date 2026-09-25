-- migrate:online-index identity_tokens_live_password_reset_lookup
CREATE INDEX CONCURRENTLY identity_tokens_live_password_reset_lookup
  ON identity_tokens (user_id, expires_at)
  WHERE kind = 'password_reset' AND used_at IS NULL;
