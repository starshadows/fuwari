/**
 * Shared DDL statements used by both the migration system (db.ts) and the
 * runtime schema bootstrap (stats.ts, etc.). Centralised here so the
 * Worker code and the migration list never drift out of sync.
 */

export const APP_SETTINGS_TABLE = `CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`;

export const STATS_INIT_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS stats_visitors (
    visitor_hash TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
	`CREATE TABLE IF NOT EXISTS stats_page_visitors (
    path TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (path, visitor_hash)
  )`,
	`CREATE INDEX IF NOT EXISTS idx_stats_page_visitors_path
   ON stats_page_visitors (path)`,
	`CREATE TABLE IF NOT EXISTS stats_site_daily (
    day TEXT PRIMARY KEY,
    pv INTEGER NOT NULL DEFAULT 0,
    uv INTEGER NOT NULL DEFAULT 0
  )`,
	`CREATE TABLE IF NOT EXISTS stats_page_daily (
    path TEXT NOT NULL,
    day TEXT NOT NULL,
    pv INTEGER NOT NULL DEFAULT 0,
    uv INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (path, day)
  )`,
	`CREATE INDEX IF NOT EXISTS idx_stats_page_daily_day
   ON stats_page_daily (day)`,
	`CREATE TABLE IF NOT EXISTS stats_daily_visitors (
    day TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    PRIMARY KEY (day, visitor_hash)
  )`,
	`CREATE TABLE IF NOT EXISTS stats_page_daily_visitors (
    path TEXT NOT NULL,
    day TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    PRIMARY KEY (path, day, visitor_hash)
  )`,
	`CREATE INDEX IF NOT EXISTS idx_stats_page_daily_visitors_day
   ON stats_page_daily_visitors (day)`,
	`CREATE TABLE IF NOT EXISTS stats_active_visitors (
    visitor_hash TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
	`CREATE INDEX IF NOT EXISTS idx_stats_active_visitors_last_seen
   ON stats_active_visitors (last_seen)`,
];

export const RATE_LIMIT_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS rate_limits (
    scope TEXT NOT NULL,
    actor_hash TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (scope, actor_hash, window_start)
  )`,
	`CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at
   ON rate_limits (updated_at)`,
];

export const TWIKOO_INIT_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS comment (
    _id TEXT NOT NULL, uid TEXT NOT NULL, nick TEXT NOT NULL,
    mail TEXT NOT NULL, mailMd5 TEXT NOT NULL, link TEXT NOT NULL,
    ua TEXT NOT NULL, ip TEXT NOT NULL, ipRegion TEXT NOT NULL DEFAULT '',
    master INTEGER NOT NULL, url TEXT NOT NULL, href TEXT NOT NULL,
    comment TEXT NOT NULL, pid TEXT NOT NULL, rid TEXT NOT NULL,
    isSpam INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    like TEXT NOT NULL, top INTEGER NOT NULL, avatar TEXT NOT NULL,
    PRIMARY KEY (_id)
  )`,
	"CREATE INDEX IF NOT EXISTS idx_comment_created ON comment (created DESC)",
	"CREATE INDEX IF NOT EXISTS idx_comment_ip_created ON comment (ip, created DESC)",
	"CREATE INDEX IF NOT EXISTS idx_comment_url_created ON comment (url, created DESC)",
	"CREATE TABLE IF NOT EXISTS config (value TEXT NOT NULL)",
	`INSERT INTO config (value)
   SELECT '' WHERE NOT EXISTS (SELECT 1 FROM config)`,
	`CREATE TABLE IF NOT EXISTS counter (
    url TEXT NOT NULL PRIMARY KEY,
    title TEXT NOT NULL,
    time INTEGER NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
];

export const FRIEND_LINKS_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS friend_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    normalized_host TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL,
    submitter_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
	`CREATE INDEX IF NOT EXISTS idx_friend_links_status_sort
   ON friend_links (status, is_active, sort_order, created_at)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_links_normalized_host_pending_approved_unique
   ON friend_links (normalized_host)
   WHERE normalized_host <> '' AND status IN ('pending', 'approved')`,
	`CREATE INDEX IF NOT EXISTS idx_friend_links_normalized_host_status
   ON friend_links (normalized_host, status)`,
	`CREATE INDEX IF NOT EXISTS idx_friend_links_submitter_pending_created
   ON friend_links (submitter_hash, status, created_at)`,
	`CREATE TRIGGER IF NOT EXISTS trg_friend_links_updated_at
   AFTER UPDATE ON friend_links FOR EACH ROW
   BEGIN
     UPDATE friend_links SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
   END`,
	`CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    object_key TEXT NOT NULL,
    cover_url TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
	`CREATE INDEX IF NOT EXISTS idx_music_tracks_active_sort
   ON music_tracks (is_active, sort_order, created_at)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_object_key_unique
   ON music_tracks (object_key)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_content_hash_unique
   ON music_tracks (content_hash)
   WHERE content_hash <> ''`,
	`CREATE INDEX IF NOT EXISTS idx_music_tracks_content_hash
   ON music_tracks (content_hash)`,
	`CREATE TRIGGER IF NOT EXISTS trg_music_tracks_updated_at
   AFTER UPDATE ON music_tracks FOR EACH ROW
   BEGIN
     UPDATE music_tracks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
   END`,
];

export const CONTENT_POSTS_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS content_posts (
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
  )`,
	`CREATE INDEX IF NOT EXISTS idx_content_posts_status_published
   ON content_posts (status, published DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_content_posts_updated_at
   ON content_posts (updated_at DESC)`,
	`CREATE TRIGGER IF NOT EXISTS trg_content_posts_updated_at
   AFTER UPDATE ON content_posts FOR EACH ROW
   BEGIN
     UPDATE content_posts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
   END`,
];

/**
 * Statements required for the runtime DDL bootstrap in stats.ts and
 * utils.ts. Mirrors migration 0001–0003 so a fresh Worker can run
 * without a prior /api/setup/init-db call.
 */
export const RUNTIME_BOOTSTRAP_STATEMENTS = [
	APP_SETTINGS_TABLE,
	...STATS_INIT_STATEMENTS,
	...RATE_LIMIT_STATEMENTS,
];
