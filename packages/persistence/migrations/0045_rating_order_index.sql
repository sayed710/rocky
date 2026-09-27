-- migrate:online-index game_events_ended_order_idx
CREATE INDEX CONCURRENTLY game_events_ended_order_idx
  ON game_events (xact_id, server_ts, game_id) WHERE type = 'GameEnded';
