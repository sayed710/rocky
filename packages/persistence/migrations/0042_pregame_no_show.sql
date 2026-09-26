-- Migration 0042 — pregame no-show vocabulary and the projected game source (ADR-0148).
--
-- A pregame no-show is its own termination, never 'timeout' (a chess clock ran out) or 'aborted'
-- (a player aborted, which a tournament relaunches). The games projection (ADR-0147) writes it
-- from the durable GameEnded event.
INSERT INTO terminations (code, is_draw) VALUES ('no_show', false);

-- The pregame lifecycle a game follows, projected from GameCreated.source: 'seek' or 'tournament',
-- NULL for bot and direct games and for every game created before the field existed. The no-show
-- worker reads it to find games that are still waiting for their first move.
--
-- A nullable column without a default is a catalogue-only change. The CHECK is added NOT VALID so
-- this statement does not scan games under its exclusive lock; 0043 validates it online.
ALTER TABLE games ADD COLUMN source TEXT;
ALTER TABLE games ADD CONSTRAINT games_source_check CHECK (source IN ('seek', 'tournament')) NOT VALID;
