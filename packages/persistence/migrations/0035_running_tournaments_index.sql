-- migrate:online-index tournaments_running_id_idx
CREATE INDEX CONCURRENTLY tournaments_running_id_idx
  ON tournaments (id) WHERE state = 'running';
