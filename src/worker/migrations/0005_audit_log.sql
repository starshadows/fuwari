-- Migration 0005: Admin audit log
-- Tracks admin operations for security review.

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_hash TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import', 'toggle')),
    resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db')),
    resource_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON admin_audit_log (actor_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource
    ON admin_audit_log (resource, created_at);
