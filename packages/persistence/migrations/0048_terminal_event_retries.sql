-- Only actual terminal work and the two deployed consumers may acquire scheduling state.
-- Like terminal_event_receipts, the event FK deliberately has no deletion cascade.
CREATE TABLE terminal_event_retries (
  consumer TEXT NOT NULL CHECK (consumer IN ('bot-analysis', 'anti-cheat-analysis')),
  game_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(next_retry_at)),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  PRIMARY KEY (consumer, game_id, seq),
  FOREIGN KEY (game_id, seq) REFERENCES game_events (game_id, seq),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (lease_until IS NULL OR (isfinite(lease_until) AND lease_until > next_retry_at))
);

CREATE INDEX terminal_event_retries_due_idx
  ON terminal_event_retries (consumer, next_retry_at, game_id, seq)
  WHERE lease_token IS NULL;
