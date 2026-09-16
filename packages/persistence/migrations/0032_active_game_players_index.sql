-- migrate:online-index game_events_active_players_idx
CREATE INDEX CONCURRENTLY game_events_active_players_idx
    ON game_events USING GIN ((payload->'players'))
    WHERE seq = 0 AND type = 'GameCreated';
