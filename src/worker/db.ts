import { apiError, MAX_JSON_BODY_BYTES, RATE_LIMITS } from "./constants";
import {
	APP_SETTINGS_TABLE,
	CONTENT_POSTS_STATEMENTS,
	FRIEND_LINKS_STATEMENTS,
	RATE_LIMIT_STATEMENTS,
	STATS_INIT_STATEMENTS,
	TWIKOO_INIT_STATEMENTS,
} from "./db-schema";
import type { Env } from "./types";
import {
	enforceRateLimit,
	json,
	readBearerToken,
	readJsonBody,
	readString,
	rejectOversizedBody,
	timingSafeEqual,
} from "./utils";

/**
 * Versioned migrations, aligned with ./migrations/*.sql for Wrangler CLI parity.
 *
 * When adding a new migration:
 *   1. Create ./migrations/<version>_<description>.sql for `pnpm d1:migrate:*`
 *   2. Append a new entry here with the matching version and statements
 *   3. The /api/setup/init-db endpoint applies pending migrations automatically
 */
interface Migration {
	version: string;
	description: string;
	statements: string[];
	isApplied: (env: Env) => Promise<boolean>;
}

const MIGRATIONS: Migration[] = [
	{
		version: "0001",
		description:
			"Create social features (friend_links, music_tracks, app_settings)",
		statements: [APP_SETTINGS_TABLE, ...FRIEND_LINKS_STATEMENTS],
		isApplied: async (env) =>
			(await hasTable(env, "app_settings")) &&
			(await hasTable(env, "friend_links")) &&
			(await hasTable(env, "music_tracks")),
	},
	{
		version: "0002",
		description: "Create visitor statistics tables",
		statements: [...STATS_INIT_STATEMENTS],
		isApplied: async (env) =>
			(await hasTable(env, "stats_visitors")) &&
			(await hasTable(env, "stats_page_daily")),
	},
	{
		version: "0003",
		description: "Create rate_limits table",
		statements: [...RATE_LIMIT_STATEMENTS],
		isApplied: (env) => hasTable(env, "rate_limits"),
	},
	{
		version: "0004",
		description: "Create comments and notifications tables",
		statements: [...TWIKOO_INIT_STATEMENTS],
		isApplied: async (env) =>
			(await hasTable(env, "comment")) &&
			(await hasTable(env, "config")) &&
			(await hasTable(env, "counter")),
	},
	{
		version: "0005",
		description: "Create admin audit log table",
		statements: [
			`CREATE TABLE IF NOT EXISTS admin_audit_log (
		    id INTEGER PRIMARY KEY AUTOINCREMENT,
		    actor_hash TEXT NOT NULL,
		    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import', 'toggle')),
		    resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db')),
		    resource_id TEXT NOT NULL DEFAULT '',
		    details TEXT NOT NULL DEFAULT '',
		    ip TEXT NOT NULL DEFAULT '',
		    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		  )`,
			`CREATE INDEX IF NOT EXISTS idx_audit_log_actor
		   ON admin_audit_log (actor_hash, created_at)`,
			`CREATE INDEX IF NOT EXISTS idx_audit_log_resource
		   ON admin_audit_log (resource, created_at)`,
		],
		isApplied: (env) => hasTable(env, "admin_audit_log"),
	},
	{
		version: "0006",
		description: "Add normalized host to friend links",
		statements: [
			"ALTER TABLE friend_links ADD COLUMN normalized_host TEXT NOT NULL DEFAULT ''",
			`UPDATE friend_links
			 SET normalized_host = lower(
			   CASE
			     WHEN instr(replace(replace(url, 'https://www.', ''), 'https://', ''), '/') > 0
			     THEN substr(
			       replace(replace(url, 'https://www.', ''), 'https://', ''),
			       1,
			       instr(replace(replace(url, 'https://www.', ''), 'https://', ''), '/') - 1
			     )
			     ELSE replace(replace(url, 'https://www.', ''), 'https://', '')
			   END
			 )
			 WHERE normalized_host = ''`,
			`CREATE INDEX IF NOT EXISTS idx_friend_links_normalized_host_status
			 ON friend_links (normalized_host, status)`,
		],
		isApplied: (env) => hasColumn(env, "friend_links", "normalized_host"),
	},
	{
		version: "0007",
		description: "Add content hash to music tracks",
		statements: [
			"ALTER TABLE music_tracks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
			`CREATE INDEX IF NOT EXISTS idx_music_tracks_content_hash
			 ON music_tracks (content_hash)`,
		],
		isApplied: (env) => hasColumn(env, "music_tracks", "content_hash"),
	},
	{
		version: "0008",
		description: "Fix comment primary key and add uniqueness constraints",
		statements: [
			`CREATE TABLE IF NOT EXISTS comment_new (
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
			)`,
			`INSERT OR IGNORE INTO comment_new (
				_id, uid, nick, mail, mailMd5, link, ua, ip, ipRegion, master,
				url, href, comment, pid, rid, isSpam, created, updated, like, top, avatar
			)
			SELECT
				_id, uid, nick, mail, mailMd5, link, ua, ip, ipRegion, master,
				url, href, comment, pid, rid, isSpam, created, updated, like, top, avatar
			FROM comment`,
			"DROP TABLE comment",
			"ALTER TABLE comment_new RENAME TO comment",
			"CREATE INDEX IF NOT EXISTS idx_comment_created ON comment (created DESC)",
			"CREATE INDEX IF NOT EXISTS idx_comment_ip_created ON comment (ip, created DESC)",
			"CREATE INDEX IF NOT EXISTS idx_comment_url_created ON comment (url, created DESC)",
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_links_normalized_host_pending_approved_unique
			 ON friend_links (normalized_host)
			 WHERE normalized_host <> '' AND status IN ('pending', 'approved')`,
			`CREATE INDEX IF NOT EXISTS idx_friend_links_normalized_host_status
			 ON friend_links (normalized_host, status)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_object_key_unique
			 ON music_tracks (object_key)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_content_hash_unique
			 ON music_tracks (content_hash)
			 WHERE content_hash <> ''`,
			`CREATE INDEX IF NOT EXISTS idx_music_tracks_content_hash
			 ON music_tracks (content_hash)`,
		],
		isApplied: async (env) =>
			(await hasPrimaryKey(env, "comment", "_id")) &&
			(await hasIndex(
				env,
				"idx_friend_links_normalized_host_pending_approved_unique",
			)) &&
			(await hasIndex(env, "idx_music_tracks_object_key_unique")) &&
			(await hasIndex(env, "idx_music_tracks_content_hash_unique")),
	},
	{
		version: "0009",
		description: "Add friend submitter hash for actor-scoped limits",
		statements: [
			"ALTER TABLE friend_links ADD COLUMN submitter_hash TEXT NOT NULL DEFAULT ''",
			`CREATE INDEX IF NOT EXISTS idx_friend_links_submitter_pending_created
			 ON friend_links (submitter_hash, status, created_at)`,
		],
		isApplied: async (env) =>
			(await hasColumn(env, "friend_links", "submitter_hash")) &&
			(await hasIndex(env, "idx_friend_links_submitter_pending_created")),
	},
	{
		version: "0010",
		description: "Create content posts table",
		statements: [
			...CONTENT_POSTS_STATEMENTS,
			`CREATE TABLE IF NOT EXISTS admin_audit_log_new (
		    id INTEGER PRIMARY KEY AUTOINCREMENT,
		    actor_hash TEXT NOT NULL,
		    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import', 'toggle')),
		    resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db', 'content')),
		    resource_id TEXT NOT NULL DEFAULT '',
		    details TEXT NOT NULL DEFAULT '',
		    ip TEXT NOT NULL DEFAULT '',
		    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		  )`,
			`INSERT INTO admin_audit_log_new (
				id, actor_hash, action, resource, resource_id, details, ip, created_at
			)
			SELECT id, actor_hash, action, resource, resource_id, details, ip, created_at
			FROM admin_audit_log`,
			"DROP TABLE admin_audit_log",
			"ALTER TABLE admin_audit_log_new RENAME TO admin_audit_log",
			`CREATE INDEX IF NOT EXISTS idx_audit_log_actor
		   ON admin_audit_log (actor_hash, created_at)`,
			`CREATE INDEX IF NOT EXISTS idx_audit_log_resource
		   ON admin_audit_log (resource, created_at)`,
		],
		isApplied: async (env) =>
			(await hasTable(env, "content_posts")) &&
			(await hasIndex(env, "idx_content_posts_status_published")),
	},
];

/** Key used to track the highest applied migration version in app_settings. */
const MIGRATION_VERSION_KEY = "db_migration_version";

async function hasTable(env: Env, tableName: string): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		)
			.bind(tableName)
			.first<{ name: string }>();
		return Boolean(row?.name);
	} catch {
		return false;
	}
}

async function hasColumn(
	env: Env,
	tableName: string,
	columnName: string,
): Promise<boolean> {
	try {
		const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all<{
			name: string;
		}>();
		return (result.results ?? []).some((column) => column.name === columnName);
	} catch {
		return false;
	}
}

async function hasPrimaryKey(
	env: Env,
	tableName: string,
	columnName: string,
): Promise<boolean> {
	try {
		const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all<{
			name: string;
			pk: number;
		}>();
		return (result.results ?? []).some(
			(column) => column.name === columnName && Number(column.pk) > 0,
		);
	} catch {
		return false;
	}
}

async function hasIndex(env: Env, indexName: string): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
		)
			.bind(indexName)
			.first<{ name: string }>();
		return Boolean(row?.name);
	} catch {
		return false;
	}
}

async function detectAppliedMigrationVersion(env: Env): Promise<string> {
	let detected = "0000";
	for (const migration of MIGRATIONS) {
		if (!(await migration.isApplied(env))) break;
		detected = migration.version;
	}
	return detected;
}

async function getEffectiveAppliedMigrationVersion(env: Env): Promise<string> {
	const recorded = await getAppliedMigrationVersion(env);
	const detected = await detectAppliedMigrationVersion(env);
	if (compareVersions(detected, recorded) <= 0) return recorded;

	await setAppliedMigrationVersion(env, detected);
	return detected;
}

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

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

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

	const rateLimit = await enforceRateLimit(
		request,
		env,
		RATE_LIMITS.setupInitDb,
	);
	if (rateLimit) return rateLimit;

	const postBody =
		request.method === "POST"
			? await readJsonBody(request, MAX_JSON_BODY_BYTES)
			: {};
	if (postBody instanceof Response) return postBody;

	const tokenResult = readSetupToken(request, requestUrl, postBody);
	if (tokenResult instanceof Response) return tokenResult;
	if (!tokenResult) {
		return json(
			{
				error:
					"Setup token missing. Pass it as Authorization: Bearer <token> or POST JSON { token: '<token>' }.",
			},
			401,
		);
	}

	if (!timingSafeEqual(tokenResult, env.ADMIN_TOKEN)) {
		return json({ error: "Invalid setup token." }, 403);
	}

	let requestedVersions: string[] = [];
	if (request.method === "POST") {
		const raw = postBody.versions;
		if (Array.isArray(raw)) {
			requestedVersions = raw
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean);
		}
	}

	const applied = await getEffectiveAppliedMigrationVersion(env);
	const pending = MIGRATIONS.filter(
		(migration) => compareVersions(migration.version, applied) > 0,
	).filter(
		(migration) =>
			requestedVersions.length === 0 ||
			requestedVersions.includes(migration.version),
	);

	if (pending.length === 0) {
		return json({ ok: true, applied: [], version: applied });
	}

	const executed: string[] = [];
	const skipped: string[] = [];
	try {
		for (const migration of pending) {
			if (await migration.isApplied(env)) {
				await setAppliedMigrationVersion(env, migration.version);
				skipped.push(migration.version);
				continue;
			}
			for (const statement of migration.statements) {
				await env.DB.prepare(statement).run();
			}
			await setAppliedMigrationVersion(env, migration.version);
			executed.push(migration.version);
		}
	} catch (error) {
		console.error(
			`Migration ${executed[executed.length - 1] ?? pending[0]?.version} failed:`,
			error,
		);
		return json(
			{
				error: "Migration failed. Check server logs for details.",
				failed: executed,
			},
			500,
		);
	}

	return json({
		ok: true,
		applied: executed,
		skipped,
		version: pending[pending.length - 1]?.version ?? applied,
	});
}

function readSetupToken(
	request: Request,
	requestUrl: URL,
	body: Record<string, unknown>,
): string | Response | null {
	if (requestUrl.searchParams.get("token")) {
		return json(
			{
				error:
					"Setup tokens are no longer accepted in URL query strings. Pass it as Authorization: Bearer <token> or POST JSON { token: '<token>' }.",
			},
			400,
		);
	}
	if (requestUrl.pathname.includes("/setup/init-db/")) {
		return json(
			{
				error:
					"Setup tokens are no longer accepted in URL paths. Use /api/setup/init-db with Authorization: Bearer <token> or a POST JSON body.",
			},
			404,
		);
	}
	const bearer = readBearerToken(request);
	if (bearer) return bearer;
	if (request.method === "POST") {
		const token = readString(body.token, 200);
		if (token) return token;
	}
	return null;
}
