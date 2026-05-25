CREATE TABLE IF NOT EXISTS rate_limits (
	scope TEXT NOT NULL,
	actor_hash TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (scope, actor_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at
ON rate_limits (updated_at);
