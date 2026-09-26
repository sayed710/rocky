-- Migration 0043: Validate games.source after its non-blocking installation in 0042.

ALTER TABLE games
    VALIDATE CONSTRAINT games_source_check;
