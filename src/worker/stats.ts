import type { Env } from "./types";
import {
	json,
	readString,
	readJson,
	rejectCrossSiteWrite,
	enforceRateLimit,
	isLikelyBot,
	hashToken,
	ensureStatsSaltCached,
	getClientIp,
} from "./utils";
import {
	RATE_LIMITS,
	STATS_ACTIVE_WINDOW_MS,
	STATS_TIMEZONE_OFFSET_MINUTES,
} from "./constants";

let statsSchemaReady = false;

/** Run data retention cleanup at most once per hour per Worker instance. */
let lastCleanupDay = "";

const STATS_RETENTION_DAYS = 2 * 365; // 2 years

const STATS_SCHEMA_STATEMENTS = [
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
];

async function ensureStatsReady(env: Env): Promise<Response | null> {
	if (!env.DB) {
		return json(
			{ error: "Missing D1 binding. Bind a D1 database as DB first." },
			503,
		);
	}

	if (!statsSchemaReady) {
		await env.DB.batch(
			STATS_SCHEMA_STATEMENTS.map((stmt) => env.DB.prepare(stmt)),
		);
		statsSchemaReady = true;
	}

	await ensureStatsSaltCached(env);
	return null;
}

// ================================================================
// Data retention cleanup (runs ~once per day)
// ================================================================

async function cleanupRetiredStats(env: Env): Promise<void> {
	const today = getStatsDay();
	if (today === lastCleanupDay) return;
	lastCleanupDay = today;

	const cutoffDate = getStatsDay(
		Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	);

	await env.DB.prepare("DELETE FROM stats_site_daily WHERE day < ?")
		.bind(cutoffDate)
		.run();
	await env.DB.prepare("DELETE FROM stats_page_daily WHERE day < ?")
		.bind(cutoffDate)
		.run();
	await env.DB.prepare("DELETE FROM stats_daily_visitors WHERE day < ?")
		.bind(cutoffDate)
		.run();
	await env.DB.prepare("DELETE FROM stats_page_daily_visitors WHERE day < ?")
		.bind(cutoffDate)
		.run();
	// rate_limits self-clean via enforceRateLimit's per-call DELETE
}

// ================================================================
// Record a visit
// ================================================================

export async function recordStatsVisit(
	request: Request,
	env: Env,
	heartbeatOnly: boolean,
): Promise<Response> {
	const originError = rejectCrossSiteWrite(request);
	if (originError) return originError;

	const rateLimit = await enforceRateLimit(
		request,
		env,
		RATE_LIMITS.statsWrite,
	);
	if (rateLimit) return rateLimit;

	const readyError = await ensureStatsReady(env);
	if (readyError) return readyError;

	// Periodic data retention cleanup (~once per day, non-blocking)
	cleanupRetiredStats(env).catch(() => {});

	const body = await readJson(request);
	const path = normalizeStatsPath(readString(body.path, 400) || "/");
	const visitorHash = await getStatsVisitorHash(
		request,
		env,
		readString(body.visitorId, 160),
	);
	const now = new Date().toISOString();
	const day = getStatsDay();

	if (!isLikelyBot(request)) {
		await env.DB.prepare(
			`INSERT INTO stats_active_visitors (visitor_hash, path, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(visitor_hash) DO UPDATE SET
         path = excluded.path,
         last_seen = excluded.last_seen`,
		)
			.bind(visitorHash, path, now)
			.run();

		if (!heartbeatOnly) {
			await env.DB.prepare(
				`INSERT INTO stats_visitors (visitor_hash, first_seen, last_seen)
         VALUES (?, ?, ?)
         ON CONFLICT(visitor_hash) DO UPDATE SET last_seen = excluded.last_seen`,
			)
				.bind(visitorHash, now, now)
				.run();

			await env.DB.prepare(
				`INSERT INTO stats_page_visitors (path, visitor_hash, first_seen, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path, visitor_hash) DO UPDATE SET last_seen = excluded.last_seen`,
			)
				.bind(path, visitorHash, now, now)
				.run();

			await env.DB.prepare(
				`INSERT OR IGNORE INTO stats_daily_visitors (day, visitor_hash, first_seen)
         VALUES (?, ?, ?)`,
			)
				.bind(day, visitorHash, now)
				.run();

			await env.DB.prepare(
				`INSERT OR IGNORE INTO stats_page_daily_visitors (path, day, visitor_hash, first_seen)
         VALUES (?, ?, ?, ?)`,
			)
				.bind(path, day, visitorHash, now)
				.run();

			await env.DB.prepare(
				`INSERT INTO stats_site_daily (day, pv, uv)
         VALUES (?, 1, (SELECT COUNT(*) FROM stats_daily_visitors WHERE day = ?))
         ON CONFLICT(day) DO UPDATE SET
           pv = pv + 1,
           uv = (SELECT COUNT(*) FROM stats_daily_visitors WHERE day = ?)`,
			)
				.bind(day, day, day)
				.run();

			await env.DB.prepare(
				`INSERT INTO stats_page_daily (path, day, pv, uv)
         VALUES (?, ?, 1, (SELECT COUNT(*) FROM stats_page_daily_visitors WHERE path = ? AND day = ?))
         ON CONFLICT(path, day) DO UPDATE SET
           pv = pv + 1,
           uv = (SELECT COUNT(*) FROM stats_page_daily_visitors WHERE path = ? AND day = ?)`,
			)
				.bind(path, day, path, day, path, day)
				.run();
		}
	}

	return json(await getStatsSummary(env, path));
}

// ================================================================
// Get stats summary
// ================================================================

export async function getStatsSummaryResponse(
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const readyError = await ensureStatsReady(env);
	if (readyError) return readyError;

	const path = normalizeStatsPath(requestUrl.searchParams.get("path") ?? "/");
	return json(await getStatsSummary(env, path));
}

async function getStatsSummary(
	env: Env,
	path: string,
): Promise<Record<string, unknown>> {
	const day = getStatsDay();
	const yesterday = getStatsDay(Date.now() - 24 * 60 * 60 * 1000);
	const monthStart = `${day.slice(0, 7)}-01`;
	const cutoff = new Date(Date.now() - STATS_ACTIVE_WINDOW_MS).toISOString();
	await cleanupInactiveVisitors(env, cutoff);

	const [
		siteTotals,
		siteToday,
		siteYesterday,
		siteMonth,
		siteVisitors,
		activeVisitors,
		pageTotals,
		pageToday,
		pageVisitors,
	] = await Promise.all([
		env.DB.prepare(
			"SELECT COALESCE(SUM(pv), 0) AS totalPv FROM stats_site_daily",
		).first<{ totalPv: number }>(),
		env.DB.prepare(
			"SELECT COALESCE(pv, 0) AS pv, COALESCE(uv, 0) AS uv FROM stats_site_daily WHERE day = ?",
		)
			.bind(day)
			.first<{ pv: number; uv: number }>(),
		env.DB.prepare(
			"SELECT COALESCE(pv, 0) AS pv FROM stats_site_daily WHERE day = ?",
		)
			.bind(yesterday)
			.first<{ pv: number }>(),
		env.DB.prepare(
			"SELECT COALESCE(SUM(pv), 0) AS pv FROM stats_site_daily WHERE day >= ? AND day <= ?",
		)
			.bind(monthStart, day)
			.first<{ pv: number }>(),
		env.DB.prepare("SELECT COUNT(*) AS totalUv FROM stats_visitors").first<{
			totalUv: number;
		}>(),
		env.DB.prepare(
			"SELECT COUNT(*) AS count FROM stats_active_visitors WHERE last_seen >= ?",
		)
			.bind(cutoff)
			.first<{ count: number }>(),
		env.DB.prepare(
			"SELECT COALESCE(SUM(pv), 0) AS totalPv FROM stats_page_daily WHERE path = ?",
		)
			.bind(path)
			.first<{ totalPv: number }>(),
		env.DB.prepare(
			"SELECT COALESCE(pv, 0) AS pv, COALESCE(uv, 0) AS uv FROM stats_page_daily WHERE path = ? AND day = ?",
		)
			.bind(path, day)
			.first<{ pv: number; uv: number }>(),
		env.DB.prepare(
			"SELECT COUNT(*) AS totalUv FROM stats_page_visitors WHERE path = ?",
		)
			.bind(path)
			.first<{ totalUv: number }>(),
	]);

	const trendDays = recentStatsDays(7);
	const trendStart = trendDays[0] ?? day;
	const trendResult = await env.DB.prepare(
		`SELECT day, pv, uv FROM stats_site_daily
     WHERE day >= ?
     ORDER BY day ASC`,
	)
		.bind(trendStart)
		.all<{ day: string; pv: number; uv: number }>();
	const trendByDay = new Map(
		(trendResult.results ?? []).map((row) => [row.day, row]),
	);

	return {
		site: {
			totalPv: Number(siteTotals?.totalPv ?? 0),
			todayPv: Number(siteToday?.pv ?? 0),
			todayUv: Number(siteToday?.uv ?? 0),
			yesterdayPv: Number(siteYesterday?.pv ?? 0),
			monthPv: Number(siteMonth?.pv ?? 0),
			totalUv: Number(siteVisitors?.totalUv ?? 0),
			realtimeVisitors: Number(activeVisitors?.count ?? 0),
		},
		page: {
			path,
			totalPv: Number(pageTotals?.totalPv ?? 0),
			todayPv: Number(pageToday?.pv ?? 0),
			todayUv: Number(pageToday?.uv ?? 0),
			totalUv: Number(pageVisitors?.totalUv ?? 0),
		},
		trend: trendDays.map((trendDay) => {
			const row = trendByDay.get(trendDay);
			return {
				day: trendDay,
				pv: Number(row?.pv ?? 0),
				uv: Number(row?.uv ?? 0),
			};
		}),
		windowSeconds: Math.round(STATS_ACTIVE_WINDOW_MS / 1000),
	};
}

function normalizeStatsPath(value: string): string {
	let path = value.trim();
	if (!path) return "/";
	try {
		if (path.startsWith("http://") || path.startsWith("https://")) {
			path = new URL(path).pathname;
		}
	} catch {
		path = "/";
	}
	path = path.split("#")[0]?.split("?")[0] ?? "/";
	if (!path.startsWith("/")) path = `/${path}`;
	path = path.replace(/\/{2,}/g, "/").slice(0, 400);
	if (path.length > 1) path = path.replace(/\/+$/, "/");
	return path || "/";
}

function getStatsDay(timestamp = Date.now()): string {
	const localTime = timestamp + STATS_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
	return new Date(localTime).toISOString().slice(0, 10);
}

function recentStatsDays(count: number): string[] {
	const days: string[] = [];
	for (let i = count - 1; i >= 0; i--) {
		days.push(getStatsDay(Date.now() - i * 24 * 60 * 60 * 1000));
	}
	return days;
}

async function cleanupInactiveVisitors(
	env: Env,
	cutoff: string,
): Promise<void> {
	await env.DB.prepare("DELETE FROM stats_active_visitors WHERE last_seen < ?")
		.bind(cutoff)
		.run();
}

async function getStatsVisitorHash(
	request: Request,
	env: Env,
	clientVisitorId: string,
): Promise<string> {
	const salt = await ensureStatsSaltCached(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	const ip = getClientIp(request);
	const source = clientVisitorId
		? `client:${clientVisitorId}:${userAgent}`
		: `request:${ip}:${userAgent}`;
	return hashToken(`${salt}:${source}`);
}
