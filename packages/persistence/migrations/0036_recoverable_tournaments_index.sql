-- migrate:online-index tournaments_terminal_recovery_id_idx
CREATE INDEX CONCURRENTLY tournaments_terminal_recovery_id_idx
  ON tournaments (id)
  WHERE state = 'running' OR (state = 'finished' AND
    (snapshot ? 'withdrawalForfeits' OR snapshot ? 'unconfirmedResults'));
