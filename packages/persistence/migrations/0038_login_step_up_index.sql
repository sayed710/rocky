-- migrate:online-index identity_tokens_one_login_step_up
CREATE UNIQUE INDEX CONCURRENTLY identity_tokens_one_login_step_up
  ON identity_tokens (user_id) WHERE kind = 'login_step_up';
