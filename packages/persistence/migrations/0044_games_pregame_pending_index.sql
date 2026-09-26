-- migrate:online-index games_pregame_pending_idx
CREATE INDEX CONCURRENTLY games_pregame_pending_idx
  ON games (started_at, id)
  WHERE source IS NOT NULL AND result IS NULL AND ply_count = 0;
