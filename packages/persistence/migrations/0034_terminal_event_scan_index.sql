-- migrate:online-index game_events_terminal_scan_idx
CREATE INDEX CONCURRENTLY game_events_terminal_scan_idx
  ON game_events (game_id, seq) WHERE type = 'GameEnded';
