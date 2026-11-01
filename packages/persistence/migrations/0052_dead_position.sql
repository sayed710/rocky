-- Migration 0052 — Add dead_position termination code (AUD-03a, FIDE 5.2.2 compatibility).
--
-- Adds the 'dead_position' dictionary code to the terminations table as a draw outcome (is_draw = true).
-- Prepared for FIDE Article 5.2.2 structural dead position compatibility.
-- Additive only: writes dictionary row; does not alter existing rows or history.
-- Rollback safety: additive dictionary rows remain inert in PostgreSQL if backend code rolls back.
INSERT INTO terminations (code, is_draw) VALUES ('dead_position', true);
