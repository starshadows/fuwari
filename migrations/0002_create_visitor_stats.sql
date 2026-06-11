CREATE TABLE IF NOT EXISTS app_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS stats_visitors (
	visitor_hash TEXT PRIMARY KEY,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_page_visitors (
	path TEXT NOT NULL,
	visitor_hash TEXT NOT NULL,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	PRIMARY KEY (path, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_stats_page_visitors_path
ON stats_page_visitors (path);

CREATE TABLE IF NOT EXISTS stats_site_daily (
	day TEXT PRIMARY KEY,
	pv INTEGER NOT NULL DEFAULT 0,
	uv INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stats_page_daily (
	path TEXT NOT NULL,
	day TEXT NOT NULL,
	pv INTEGER NOT NULL DEFAULT 0,
	uv INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (path, day)
);

CREATE INDEX IF NOT EXISTS idx_stats_page_daily_day
ON stats_page_daily (day);

CREATE TABLE IF NOT EXISTS stats_daily_visitors (
	day TEXT NOT NULL,
	visitor_hash TEXT NOT NULL,
	first_seen TEXT NOT NULL,
	PRIMARY KEY (day, visitor_hash)
);

CREATE TABLE IF NOT EXISTS stats_page_daily_visitors (
	path TEXT NOT NULL,
	day TEXT NOT NULL,
	visitor_hash TEXT NOT NULL,
	first_seen TEXT NOT NULL,
	PRIMARY KEY (path, day, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_stats_page_daily_visitors_day
ON stats_page_daily_visitors (day);

CREATE TABLE IF NOT EXISTS stats_active_visitors (
	visitor_hash TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stats_active_visitors_last_seen
ON stats_active_visitors (last_seen);
