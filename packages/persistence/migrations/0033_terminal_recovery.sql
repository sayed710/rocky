-- Receipts only suppress completed replays; game_events remains the durable work source.
CREATE TABLE terminal_event_receipts (
  consumer TEXT NOT NULL,
  game_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, game_id, seq),
  FOREIGN KEY (game_id, seq) REFERENCES game_events (game_id, seq)
);
