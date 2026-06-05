ALTER TABLE friend_links ADD COLUMN submitter_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_friend_links_submitter_pending_created
ON friend_links (submitter_hash, status, created_at);
