DROP TRIGGER IF EXISTS trg_content_posts_updated_at;
DROP TABLE IF EXISTS content_posts_new;

CREATE TABLE content_posts_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT NOT NULL UNIQUE,
	source_key TEXT NOT NULL,
	format TEXT NOT NULL CHECK (format IN ('md', 'mdx')),
	title TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	image TEXT NOT NULL DEFAULT '',
	tags_json TEXT NOT NULL DEFAULT '[]',
	category TEXT NOT NULL DEFAULT '',
	lang TEXT NOT NULL DEFAULT '',
	published TEXT NOT NULL DEFAULT '',
	updated TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
	content_hash TEXT NOT NULL DEFAULT '',
	assets_manifest TEXT NOT NULL DEFAULT '[]',
	deploy_status TEXT NOT NULL DEFAULT 'idle' CHECK (deploy_status IN ('idle', 'pending', 'triggered', 'succeeded', 'failed')),
	deployment_error TEXT NOT NULL DEFAULT '',
	last_deploy_triggered_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO content_posts_new (
	id, slug, source_key, format, title, description, image, tags_json, category,
	lang, published, updated, status, content_hash, assets_manifest, deploy_status,
	deployment_error, last_deploy_triggered_at, created_at, updated_at
)
SELECT
	id, slug, source_key, format, title, description, image, tags_json, category,
	lang, published, updated, status, content_hash, assets_manifest,
	CASE
		WHEN deploy_status IN ('idle', 'pending', 'triggered', 'succeeded', 'failed')
		THEN deploy_status
		ELSE 'idle'
	END,
	deployment_error, last_deploy_triggered_at, created_at, updated_at
FROM content_posts;

DROP TABLE content_posts;
ALTER TABLE content_posts_new RENAME TO content_posts;

CREATE INDEX IF NOT EXISTS idx_content_posts_status_published
ON content_posts (status, published DESC);

CREATE INDEX IF NOT EXISTS idx_content_posts_updated_at
ON content_posts (updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_posts_updated_at
AFTER UPDATE ON content_posts FOR EACH ROW
BEGIN
	UPDATE content_posts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
END;
