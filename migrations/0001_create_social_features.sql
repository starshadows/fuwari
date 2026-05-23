CREATE TABLE IF NOT EXISTS friend_links (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	url TEXT NOT NULL,
	avatar_url TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_friend_links_status_sort
ON friend_links (status, is_active, sort_order, created_at);

CREATE TRIGGER IF NOT EXISTS trg_friend_links_updated_at
AFTER UPDATE ON friend_links
FOR EACH ROW
BEGIN
	UPDATE friend_links
	SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS music_tracks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	artist TEXT NOT NULL DEFAULT '',
	album TEXT NOT NULL DEFAULT '',
	object_key TEXT NOT NULL,
	cover_url TEXT NOT NULL DEFAULT '',
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_music_tracks_active_sort
ON music_tracks (is_active, sort_order, created_at);

CREATE TRIGGER IF NOT EXISTS trg_music_tracks_updated_at
AFTER UPDATE ON music_tracks
FOR EACH ROW
BEGIN
	UPDATE music_tracks
	SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS app_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
