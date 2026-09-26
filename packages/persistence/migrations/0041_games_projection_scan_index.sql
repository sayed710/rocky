-- migrate:online-index game_events_xact_order_idx
CREATE INDEX CONCURRENTLY game_events_xact_order_idx
  ON game_events (xact_id, game_id, seq);
