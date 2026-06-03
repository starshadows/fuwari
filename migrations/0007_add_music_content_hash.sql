ALTER TABLE music_tracks ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_music_tracks_content_hash
ON music_tracks (content_hash);
