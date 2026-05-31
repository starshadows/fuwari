import { apiError } from "./constants";
import type { Env } from "./types";
import {
	ensureStatsSaltCached,
	json,
	readBearerToken,
	readJson,
	readString,
	timingSafeEqual,
} from "./utils";

const APP_SETTINGS_TABLE = `CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`;

const STATS_INIT_STATEMENTS = [
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

const TWIKOO_INIT_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS comment (
    _id TEXT NOT NULL, uid TEXT NOT NULL, nick TEXT NOT NULL,
    mail TEXT NOT NULL, mailMd5 TEXT NOT NULL, link TEXT NOT NULL,
    ua TEXT NOT NULL, ip TEXT NOT NULL, ipRegion TEXT NOT NULL DEFAULT '',
    master INTEGER NOT NULL, url TEXT NOT NULL, href TEXT NOT NULL,
    comment TEXT NOT NULL, pid TEXT NOT NULL, rid TEXT NOT NULL,
    isSpam INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    like TEXT NOT NULL, top INTEGER NOT NULL, avatar TEXT NOT NULL,
    PRIMARY KEY (url, created DESC)
  )`,
	"CREATE INDEX IF NOT EXISTS idx_comment_created ON comment (created DESC)",
	"CREATE INDEX IF NOT EXISTS idx_comment_ip_created ON comment (ip, created DESC)",
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

const FRIEND_LINKS_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS friend_links (
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
  )`,
	`CREATE INDEX IF NOT EXISTS idx_friend_links_status_sort
   ON friend_links (status, is_active, sort_order, created_at)`,
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
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
	`CREATE INDEX IF NOT EXISTS idx_music_tracks_active_sort
   ON music_tracks (is_active, sort_order, created_at)`,
	`CREATE TRIGGER IF NOT EXISTS trg_music_tracks_updated_at
   AFTER UPDATE ON music_tracks FOR EACH ROW
   BEGIN
     UPDATE music_tracks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
   END`,
];

const RATE_LIMIT_STATEMENTS = [
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

/**
 * Versioned migrations, aligned with ./migrations/*.sql for Wrangler CLI parity.
 *
 * When adding a new migration:
 *   1. Create ./migrations/0005_<description>.sql for `pnpm d1:migrate:*`
 *   2. Append a new entry here with the matching version and statements
 *   3. The /api/setup/init-db endpoint applies pending migrations automatically
 */
interface Migration {
	version: string;
	description: string;
	statements: string[];
}

const MIGRATIONS: Migration[] = [
	{
		version: "0001",
		description:
			"Create social features (friend_links, music_tracks, app_settings)",
		statements: [APP_SETTINGS_TABLE, ...FRIEND_LINKS_STATEMENTS],
	},
	{
		version: "0002",
		description: "Create visitor statistics tables",
		statements: [...STATS_INIT_STATEMENTS],
	},
	{
		version: "0003",
		description: "Create rate_limits table",
		statements: [...RATE_LIMIT_STATEMENTS],
	},
	{
		version: "0004",
		description: "Create comments and notifications tables",
		statements: [...TWIKOO_INIT_STATEMENTS],
	},
];

/** Key used to track the highest applied migration version in app_settings. */
const MIGRATION_VERSION_KEY = "db_migration_version";

/**
 * Read the currently applied migration version from app_settings.
 * Returns '0000' if no version has been recorded yet.
 */
async function getAppliedMigrationVersion(env: Env): Promise<string> {
	try {
		const row = await env.DB.prepare(
			"SELECT value FROM app_settings WHERE key = ?",
		)
			.bind(MIGRATION_VERSION_KEY)
			.first<{ value: string }>();
		return row?.value ?? "0000";
	} catch {
		return "0000";
	}
}

/**
 * Update the recorded migration version in app_settings.
 */
async function setAppliedMigrationVersion(
	env: Env,
	version: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	)
		.bind(MIGRATION_VERSION_KEY, version)
		.run();
}

/**
 * Compare two migration version strings (e.g. '0002' > '0001').
 */
function compareVersions(a: string, b: string): number {
	const na = Number.parseInt(a, 10);
	const nb = Number.parseInt(b, 10);
	return na - nb;
}

export async function initializeDatabase(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return json({ error: apiError("METHOD_NOT_ALLOWED") }, 405);
	}

	if (!env.DB) {
		return json({ error: apiError("MISSING_D1") }, 503);
	}

	// Require ADMIN_TOKEN Cloudflare Secret to be configured before
	// allowing any database initialization. This prevents the "first caller
	// sets the admin token" class of vulnerability.
	if (!env.ADMIN_TOKEN) {
		return json(
			{
				error:
					"ADMIN_TOKEN Cloudflare Secret is not configured. " +
					"Set it via `wrangler secret put ADMIN_TOKEN` or the Cloudflare Dashboard, " +
					"then call this endpoint again.",
			},
			503,
		);
	}

	const tokenResult = await readSetupToken(request, requestUrl);
	if (tokenResult instanceof Response) return tokenResult;
	if (!tokenResult) {
		return json(
			{
				error:
					'Missing setup token. Use Authorization: Bearer <token> or POST JSON { "token": "..." }.',
			},
			401,
		);
	}

	// Use timing-safe comparison against the environment secret.
	if (!timingSafeEqual(tokenResult, env.ADMIN_TOKEN)) {
		return json({ error: apiError("INVALID_TOKEN") }, 401);
	}

	// --- Versioned migration logic ---

	const currentVersion = await getAppliedMigrationVersion(env);
	const pending = MIGRATIONS.filter(
		(m) => compareVersions(m.version, currentVersion) > 0,
	);

	if (pending.length === 0) {
		await ensureStatsSaltCached(env);
		return json({
			ok: true,
			message: `Database is up to date at version ${currentVersion}. No pending migrations.`,
		});
	}

	const applied: string[] = [];

	for (const migration of pending) {
		// Deduplicate within each migration batch
		const seen = new Set<string>();
		const deduped = migration.statements.filter((stmt) => {
			const key = stmt.replace(/\s+/g, " ").trim();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		const results = await env.DB.batch(
			deduped.map((stmt) => env.DB.prepare(stmt)),
		);

		if (results.some((r) => !r.success)) {
			return json(
				{
					error: `Migration ${migration.version} (${migration.description}) failed.`,
					applied,
				},
				500,
			);
		}

		await setAppliedMigrationVersion(env, migration.version);
		applied.push(migration.version);
	}

	await ensureStatsSaltCached(env);

	return json({
		ok: true,
		message: `Applied ${applied.length} migration(s): ${applied.join(", ")}. Current version: ${pending[pending.length - 1].version}.`,
		migrationsApplied: applied,
	});
}

async function readSetupToken(
	request: Request,
	requestUrl: URL,
): Promise<string | Response> {
	if (requestUrl.searchParams.has("token")) {
		return json(
			{
				error:
					'Setup tokens are no longer accepted in URLs. Use Authorization: Bearer <token> or POST JSON { "token": "..." }.',
			},
			400,
		);
	}

	const bearerToken = readBearerToken(request);
	if (bearerToken) return bearerToken;

	if (request.method === "POST") {
		const body = await readJson(request);
		return (
			readString(body.token, 512) ||
			readString(body.adminToken, 512) ||
			readString(body.setupToken, 512)
		);
	}

	return "";
}
