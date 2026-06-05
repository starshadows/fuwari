CREATE TABLE IF NOT EXISTS comment_new (
	_id TEXT NOT NULL PRIMARY KEY,
	uid TEXT NOT NULL,
	nick TEXT NOT NULL,
	mail TEXT NOT NULL,
	mailMd5 TEXT NOT NULL,
	link TEXT NOT NULL,
	ua TEXT NOT NULL,
	ip TEXT NOT NULL,
	ipRegion TEXT NOT NULL DEFAULT '',
	master INTEGER NOT NULL,
	url TEXT NOT NULL,
	href TEXT NOT NULL,
	comment TEXT NOT NULL,
	pid TEXT NOT NULL,
	rid TEXT NOT NULL,
	isSpam INTEGER NOT NULL,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL,
	like TEXT NOT NULL,
	top INTEGER NOT NULL,
	avatar TEXT NOT NULL
);

INSERT OR IGNORE INTO comment_new (
	_id, uid, nick, mail, mailMd5, link, ua, ip, ipRegion, master,
	url, href, comment, pid, rid, isSpam, created, updated, like, top, avatar
)
SELECT
	_id, uid, nick, mail, mailMd5, link, ua, ip, ipRegion, master,
	url, href, comment, pid, rid, isSpam, created, updated, like, top, avatar
FROM comment;

DROP TABLE comment;

ALTER TABLE comment_new RENAME TO comment;

CREATE INDEX IF NOT EXISTS idx_comment_created
ON comment (created DESC);

CREATE INDEX IF NOT EXISTS idx_comment_ip_created
ON comment (ip, created DESC);

CREATE INDEX IF NOT EXISTS idx_comment_url_created
ON comment (url, created DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_links_normalized_host_pending_approved_unique
ON friend_links (normalized_host)
WHERE normalized_host <> '' AND status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_friend_links_normalized_host_status
ON friend_links (normalized_host, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_object_key_unique
ON music_tracks (object_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_content_hash_unique
ON music_tracks (content_hash)
WHERE content_hash <> '';

CREATE INDEX IF NOT EXISTS idx_music_tracks_content_hash
ON music_tracks (content_hash);
