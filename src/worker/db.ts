import type { Env } from "./types";
import { json, hashToken, saveStoredAdminTokenHash, readBearerToken, readString, readJson, ensureStatsSaltCached } from "./utils";

const STATS_INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
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
  `CREATE INDEX IF NOT EXISTS idx_comment_created ON comment (created DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_ip_created ON comment (ip, created DESC)`,
  `CREATE TABLE IF NOT EXISTS config (value TEXT NOT NULL)`,
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
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
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

const ALL_INIT_STATEMENTS = [
  ...FRIEND_LINKS_STATEMENTS,
  ...STATS_INIT_STATEMENTS,
  ...TWIKOO_INIT_STATEMENTS,
  ...RATE_LIMIT_STATEMENTS,
];

// Deduplicate: only keep unique app_settings table creation
// (it's defined in RATE_LIMIT_STATEMENTS which comes last)

export async function initializeDatabase(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (!env.DB) {
    return json(
      { error: "Missing D1 binding. Bind a D1 database as DB first." },
      503,
    );
  }

  const tokenResult = await readSetupToken(request, requestUrl);
  if (tokenResult instanceof Response) return tokenResult;
  if (!tokenResult) {
    return json(
      {
        error:
          "Missing setup token. Use Authorization: Bearer <token> or POST JSON { \"token\": \"...\" }.",
      },
      401,
    );
  }

  // Deduplicate app_settings creation — keep only the first occurrence
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const stmt of ALL_INIT_STATEMENTS) {
    const key = stmt.replace(/\s+/g, " ").trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(stmt);
    }
  }

  const results = await env.DB.batch(
    deduped.map((statement) => env.DB.prepare(statement)),
  );

  const adminTokenSource = await setupAdminToken(env, tokenResult);
  if (adminTokenSource instanceof Response) return adminTokenSource;
  await ensureStatsSaltCached(env);

  return json({
    ok: true,
    message: "Database initialized. Existing data was kept.",
    statements: results.length,
    adminTokenSource,
  });
}

async function setupAdminToken(
  env: Env,
  token: string,
): Promise<Response | "env" | "database"> {
  if (env.ADMIN_TOKEN) {
    if (token !== env.ADMIN_TOKEN) {
      return json({ error: "Invalid setup token. Use the configured ADMIN_TOKEN." }, 401);
    }
    return "env";
  }

  const tokenHash = await hashToken(token);
  const storedHash = await getStoredToken(env);
  if (storedHash) {
    if (storedHash !== tokenHash) {
      return json({ error: "Invalid setup token." }, 401);
    }
    return "database";
  }

  await saveStoredAdminTokenHash(env, tokenHash);
  return "database";
}

async function getStoredToken(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = ?",
    )
      .bind("admin_token_sha256")
      .first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function readSetupToken(
  request: Request,
  requestUrl: URL,
): Promise<string | Response> {
  if (requestUrl.searchParams.has("token")) {
    return json(
      {
        error:
          "Setup tokens are no longer accepted in URLs. Use Authorization: Bearer <token> or POST JSON { \"token\": \"...\" }.",
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
