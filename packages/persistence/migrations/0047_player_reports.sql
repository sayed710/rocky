-- Migration 0047: durable player reports and the moderator triage queue (ADR-0152).
--
-- A report is intake for human review, never a verdict: nothing here bans, scores or resolves a
-- player automatically. Status is a deliberately small state machine (open -> reviewing ->
-- resolved | dismissed) and `version` is the compare-and-set token every moderator transition
-- must name, so two moderators cannot both claim a report or overwrite each other's decision.
--
-- The user foreign keys deliberately take no ON DELETE action: deleting an account must not erase
-- the reports about it, the reports it filed, or a moderator's claim. Account deletion, when it
-- exists, has to decide retention for these rows explicitly rather than inherit a cascade.
CREATE TABLE player_reports (
  id             UUID PRIMARY KEY,                                   -- UUIDv7
  reporter_id    UUID NOT NULL REFERENCES users(id),
  subject_id     UUID NOT NULL REFERENCES users(id),
  -- No foreign key: `games` is a rebuildable projection. The API checks the event log instead.
  game_id        UUID,
  reason         TEXT NOT NULL CHECK (reason IN ('cheating', 'harassment', 'spam', 'other')),
  -- Plain text written by the reporter. Never rendered as HTML and never copied into audit_log.
  detail         TEXT CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 1000),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  assigned_to    UUID REFERENCES users(id),
  -- Internal to moderators; no player-facing response includes it.
  moderator_note TEXT CHECK (moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  CONSTRAINT player_reports_not_self CHECK (reporter_id <> subject_id),
  CONSTRAINT player_reports_claim_matches_status CHECK ((status = 'open') = (assigned_to IS NULL)),
  CONSTRAINT player_reports_closed_matches_status
    CHECK ((status IN ('resolved', 'dismissed')) = (closed_at IS NOT NULL))
);

-- The moderator queue: one status, oldest first, keyset-paged on the time-ordered id.
CREATE INDEX player_reports_queue_idx ON player_reports (status, id);
-- Every report about one player, for a moderator investigating them.
CREATE INDEX player_reports_subject_idx ON player_reports (subject_id, status, id);
