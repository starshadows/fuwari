CREATE TABLE IF NOT EXISTS content_posts (
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
	deploy_status TEXT NOT NULL DEFAULT 'idle' CHECK (deploy_status IN ('idle', 'pending', 'triggered', 'failed')),
	deployment_error TEXT NOT NULL DEFAULT '',
	last_deploy_triggered_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_content_posts_status_published
ON content_posts (status, published DESC);

CREATE INDEX IF NOT EXISTS idx_content_posts_updated_at
ON content_posts (updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_content_posts_updated_at
AFTER UPDATE ON content_posts FOR EACH ROW
BEGIN
	UPDATE content_posts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS admin_audit_log_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	actor_hash TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import', 'toggle')),
	resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db', 'content')),
	resource_id TEXT NOT NULL DEFAULT '',
	details TEXT NOT NULL DEFAULT '',
	ip TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO admin_audit_log_new (
	id, actor_hash, action, resource, resource_id, details, ip, created_at
)
SELECT id, actor_hash, action, resource, resource_id, details, ip, created_at
FROM admin_audit_log;

DROP TABLE admin_audit_log;
ALTER TABLE admin_audit_log_new RENAME TO admin_audit_log;

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
ON admin_audit_log (actor_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource
ON admin_audit_log (resource, created_at);
