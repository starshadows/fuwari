/// <reference types="@cloudflare/workers-types" />

import {
	createChallenge,
	sha,
	verifySolution,
	type Payload,
} from "altcha/lib";
import twikooWorker from "./twikoo-adapter";

type Env = {
	DB: D1Database;
	MEDIA_BUCKET: R2Bucket;
	ASSETS: Fetcher;
	ADMIN_TOKEN?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
};

type JsonRecord = Record<string, unknown>;

type RangeResult =
	| { ok: true; start: number; end: number; length: number }
	| { ok: false };

type RateLimitConfig = {
	scope: string;
	limit: number;
	windowSeconds: number;
};

type MusicMetadata = {
	title: string;
	artist: string;
	album: string;
};

type EmbeddedCover = {
	mimeType: string;
	bytes: Uint8Array;
};

type TurnstileVerifyResult = {
	success?: boolean;
	"error-codes"?: string[];
};

type HumanProof =
	| { type?: "altcha"; payload?: string }
	| { type?: "turnstile"; token?: string; turnstileToken?: string };

type HumanProofContext = "friends" | "comments";

type TelegramSettings = {
	enabled: boolean;
	botToken: string;
	chatId: string;
	threadId: string;
};

type CommentsSessionCookie = {
	context: "comments";
	expiresAt: number;
	actorHash: string;
	signature: string;
};

type MusicObjectInfo = MusicMetadata & {
	key: string;
	fileName: string;
	size: number;
	uploaded: string;
	imported: boolean;
	audioUrl: string;
	coverUrl: string;
	hasEmbeddedCover: boolean;
	cover?: EmbeddedCover;
};

const FRIEND_STATUSES = new Set(["pending", "approved", "rejected"]);
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
const ALLOWED_AVATAR_MIME_TYPES = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
const ADMIN_TOKEN_SETTING_KEY = "admin_token_sha256";
const STATS_SALT_SETTING_KEY = "stats_salt";
const COMMENTS_ENABLED_SETTING_KEY = "comments_enabled";
const TELEGRAM_SETTINGS_KEY = "telegram_friend_notification";
const COMMENTS_SESSION_COOKIE = "fuwari_comments_session";
const COMMENTS_SESSION_MAX_AGE_SECONDS = 20 * 60;
const ALTCHA_CHALLENGE_TTL_SECONDS = 10 * 60;
const ALTCHA_COST = 800;
const STATS_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const STATS_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const MUSIC_PREFIX = "music/";
const MUSIC_OBJECT_SCAN_LIMIT = 200;
const MUSIC_METADATA_READ_BYTES = 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "webm"]);
const RATE_LIMIT_MAX_AGE_SECONDS = 24 * 60 * 60;
const RATE_LIMITS = {
	friendSubmit: { scope: "friend-submit", limit: 5, windowSeconds: 10 * 60 },
	commentsSession: { scope: "comments-session", limit: 8, windowSeconds: 10 * 60 },
	humanProofFailure: { scope: "human-proof-fail", limit: 2, windowSeconds: 10 * 60 },
	statsWrite: { scope: "stats-write", limit: 240, windowSeconds: 10 * 60 },
	adminFailure: { scope: "admin-auth-fail", limit: 6, windowSeconds: 5 * 60 },
};
const HUMAN_PROOF_CONTEXTS = new Set(["friends", "comments"]);
const TURNSTILE_SUBMIT_THRESHOLD = 3;
const SECURITY_HEADERS = {
	"content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
	"permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-content-type-options": "nosniff",
};
const RATE_LIMIT_INIT_STATEMENTS = [
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
	...RATE_LIMIT_INIT_STATEMENTS,
];
const TWIKOO_INIT_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS comment (
		_id TEXT NOT NULL,
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
		avatar TEXT NOT NULL,
		PRIMARY KEY (url, created DESC)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_comment_created
	ON comment (created DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_comment_ip_created
	ON comment (ip, created DESC)`,
	`CREATE TABLE IF NOT EXISTS config (
		value TEXT NOT NULL
	)`,
	`INSERT INTO config (value)
	SELECT ''
	WHERE NOT EXISTS (SELECT 1 FROM config)`,
	`CREATE TABLE IF NOT EXISTS counter (
		url TEXT NOT NULL PRIMARY KEY,
		title TEXT NOT NULL,
		time INTEGER NOT NULL,
		created INTEGER NOT NULL,
		updated INTEGER NOT NULL
	)`,
];
const INIT_DB_STATEMENTS = [
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
	AFTER UPDATE ON friend_links
	FOR EACH ROW
	BEGIN
		UPDATE friend_links
		SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = OLD.id;
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
	AFTER UPDATE ON music_tracks
	FOR EACH ROW
	BEGIN
		UPDATE music_tracks
		SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = OLD.id;
	END`,
	`CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`,
	...STATS_INIT_STATEMENTS,
	...TWIKOO_INIT_STATEMENTS,
];
let statsSchemaReady = false;
let statsSaltCache: string | null = null;
let rateLimitSchemaReady = false;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const startedAt = performance.now();
		const requestUrl = new URL(request.url);

		try {
			let response: Response;

			if (requestUrl.pathname.startsWith("/setup/init-db")) {
				response = json({
					error: "Setup tokens are no longer accepted in URL paths. Use /api/setup/init-db with Authorization: Bearer <token> or a POST JSON body.",
				}, 410);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/api/")) {
				response = await handleApi(request, env, requestUrl, ctx);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/media/")) {
				response = await handleMedia(request, env, requestUrl);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			response = await env.ASSETS.fetch(request);
			return withSecurityHeaders(response);
		} catch (error) {
			console.error(error);
			const response = json({ error: "服务器暂时开小差了，请稍后再试。" }, 500);
			return withServerTiming(response, startedAt);
		}
	},
};

async function handleApi(
	request: Request,
	env: Env,
	requestUrl: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const { pathname } = requestUrl;

	if (pathname === "/api/setup/init-db") {
		return initializeDatabase(request, env, requestUrl);
	}

	if (pathname === "/api/turnstile/config" && request.method === "GET") {
		return cachedResponse(request, ctx, 300, () => getTurnstileConfig(env));
	}

	if (pathname === "/api/anti-abuse/challenge" && request.method === "GET") {
		return getAntiAbuseChallenge(request, env, requestUrl);
	}

	if (pathname === "/api/comments/config" && request.method === "GET") {
		return cachedResponse(request, ctx, 300, () => getCommentsConfig(env));
	}

	if (pathname === "/api/comments/session" && request.method === "POST") {
		return createCommentsSession(request, env);
	}

	if (pathname === "/api/twikoo") {
		return handleTwikooRequest(request, env, requestUrl);
	}

	if (pathname === "/api/friends") {
		if (request.method === "GET") {
			return cachedResponse(request, ctx, 300, () => getApprovedFriends(env));
		}
		if (request.method === "POST") return submitFriendLink(request, env, ctx);
	}

	if (pathname === "/api/music/tracks" && request.method === "GET") {
		return cachedResponse(request, ctx, 300, () => getPublicMusicTracks(env));
	}

	if (pathname === "/api/stats/summary" && request.method === "GET") {
		return cachedResponse(request, ctx, 60, () => getStatsSummaryResponse(env, requestUrl));
	}

	if (pathname === "/api/stats/visit" && request.method === "POST") {
		return recordStatsVisit(request, env, false);
	}

	if (pathname === "/api/stats/heartbeat" && request.method === "POST") {
		return recordStatsVisit(request, env, true);
	}

	if (pathname.startsWith("/api/admin/")) {
		const auth = await requireAdmin(request, env);
		if (auth) return auth;

		return handleAdminApi(request, env, requestUrl);
	}

	return json({ error: "接口不存在。" }, 404);
}

async function initializeDatabase(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return json({ error: "Method not allowed." }, 405);
	}

	if (!env.DB) {
		return json({ error: "Missing D1 binding. Bind a D1 database as DB first." }, 503);
	}

	const tokenResult = await readSetupToken(request, requestUrl);
	if (tokenResult instanceof Response) return tokenResult;
	if (!tokenResult) {
		return json({
			error: "Missing setup token. Use Authorization: Bearer <token> or POST JSON { \"token\": \"...\" }.",
		}, 401);
	}

	const results = await env.DB.batch(
		INIT_DB_STATEMENTS.map((statement) => env.DB.prepare(statement)),
	);
	const adminTokenSource = await setupAdminToken(env, tokenResult);
	if (adminTokenSource instanceof Response) return adminTokenSource;
	await ensureStatsSalt(env);

	return json({
		ok: true,
		message: "Database initialized. Existing data was kept.",
		statements: results.length,
		adminTokenSource,
	});
}

async function getApprovedFriends(env: Env): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id, name, description, url, avatar_url AS avatarUrl
		FROM friend_links
		WHERE status = 'approved' AND is_active = 1
		ORDER BY sort_order ASC, created_at DESC`,
	).all();

	return json({ friends: result.results ?? [] });
}

function getTurnstileConfig(env: Env): Response {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";

	return json({
		enabled: Boolean(siteKey && secretKey),
		siteKey,
	});
}

async function getAntiAbuseChallenge(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const context = normalizeHumanProofContext(requestUrl.searchParams.get("context"));
	const turnstile = await shouldRequireTurnstile(request, env, context);

	if (turnstile.required) {
		const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
		const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
		if (!siteKey || !secretKey) {
			return json({
				mode: "turnstile",
				error: "当前访问需要 Turnstile 验证，但站点尚未配置 Turnstile。请稍后再试或联系站长。",
				reason: turnstile.reason,
			}, 503);
		}

		return json({
			mode: "turnstile",
			siteKey,
			reason: turnstile.reason,
		});
	}

	const salt = await ensureStatsSalt(env);
	const challenge = await createChallenge({
		algorithm: "SHA-256",
		cost: ALTCHA_COST,
		data: { context },
		deriveKey: sha.deriveKey,
		expiresAt: Math.floor(Date.now() / 1000) + ALTCHA_CHALLENGE_TTL_SECONDS,
		hmacSignatureSecret: salt,
	});

	return json({
		mode: "altcha",
		challenge,
	});
}

async function submitFriendLink(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const originError = rejectCrossSiteWrite(request);
	if (originError) return originError;

	const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.friendSubmit);
	if (rateLimit) return rateLimit;

	const body = await readJson(request);
	const name = readString(body.name, 40);
	const description = readString(body.description, 120);
	const linkUrl = readString(body.url, 400);
	const avatarUrl = readString(body.avatarUrl, 600);
	const humanProof = readHumanProof(body.humanProof) ??
		(readString(body.turnstileToken, 2048)
			? { type: "turnstile", token: readString(body.turnstileToken, 2048) }
			: null);

	if (!name || !description || !linkUrl || !avatarUrl) {
		return json({ error: "请填写完整的名称、简介、链接和头像。" }, 400);
	}

	if (!isHttpsUrl(linkUrl)) {
		return json({ error: "链接必须是 https 地址。" }, 400);
	}

	if (!isAvatarUrl(avatarUrl)) {
		return json({ error: "头像需要使用公网 https 地址或站内头像地址。" }, 400);
	}

	const duplicate = await env.DB.prepare(
		`SELECT id, status
		FROM friend_links
		WHERE url = ? AND status IN ('pending', 'approved')
		LIMIT 1`,
	)
		.bind(linkUrl)
		.first<{ id: number; status: string }>();
	if (duplicate) {
		return json({ error: "这个站点已经提交过申请或已经在友链中。" }, 409);
	}

	const proofError = await verifyHumanProof(request, env, "friends", humanProof);
	if (proofError) return proofError;

	const insert = await env.DB.prepare(
		`INSERT INTO friend_links (name, description, url, avatar_url, status)
		VALUES (?, ?, ?, ?, 'pending')`,
	)
		.bind(name, description, linkUrl, avatarUrl)
		.run();

	ctx.waitUntil(sendTelegramFriendNotification(env, {
		id: Number(insert.meta.last_row_id ?? 0),
		name,
		description,
		url: linkUrl,
		avatarUrl,
	}).catch((error) => {
		console.warn("Telegram friend notification failed", error);
	}));

	return json({ ok: true, message: "申请已提交，审核通过后会自动展示。" }, 201);
}

async function verifyTurnstile(
	request: Request,
	env: Env,
	token: string,
): Promise<Response | null> {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";

	if (!siteKey || !secretKey) {
		return json({ error: "人机验证尚未配置，暂时无法提交友链申请。" }, 503);
	}

	if (!token) {
		return json({ error: "请先完成人机验证。" }, 400);
	}

	const form = new FormData();
	form.append("secret", secretKey);
	form.append("response", token);

	const remoteIp = request.headers.get("cf-connecting-ip");
	if (remoteIp) form.append("remoteip", remoteIp);

	try {
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body: form,
		});
		const result = (await response.json()) as TurnstileVerifyResult;

		if (!response.ok || !result.success) {
			console.warn("Turnstile verification failed", result["error-codes"] ?? []);
			return json({ error: "人机验证失败，请刷新后重试。" }, 400);
		}
	} catch (error) {
		console.error("Turnstile verification request failed", error);
		return json({ error: "人机验证暂时不可用，请稍后再试。" }, 503);
	}

	return null;
}

async function verifyHumanProof(
	request: Request,
	env: Env,
	context: HumanProofContext,
	humanProof: HumanProof | null,
): Promise<Response | null> {
	const proofType = humanProof?.type;
	const turnstile = await shouldRequireTurnstile(request, env, context);

	if (turnstile.required || proofType === "turnstile") {
		if (
			turnstile.required &&
			(!env.TURNSTILE_SITE_KEY?.trim() || !env.TURNSTILE_SECRET_KEY?.trim())
		) {
			return json({
				error: "当前访问需要 Turnstile 验证，但站点尚未配置 Turnstile。请稍后再试或联系站长。",
				requiresTurnstile: true,
				reason: turnstile.reason,
			}, 503);
		}
		const proof = humanProof as Extract<HumanProof, { type?: "turnstile" }> | null;
		const token = readString(proof?.token, 2048) ||
			readString(proof?.turnstileToken, 2048);
		if (!token) {
			await recordHumanProofFailure(request, env, context);
			return json({
				error: "当前访问需要 Turnstile 验证，请刷新验证后重试。",
				requiresTurnstile: true,
				reason: turnstile.reason,
			}, 400);
		}
		const turnstileError = await verifyTurnstile(request, env, token);
		if (turnstileError) {
			await recordHumanProofFailure(request, env, context);
			return turnstileError;
		}
		return null;
	}

	const proof = humanProof as Extract<HumanProof, { type?: "altcha" }> | null;
	const payload = readString(proof?.payload, 20000);
	if (!payload) {
		await recordHumanProofFailure(request, env, context);
		return json({ error: "请先完成人机验证。" }, 400);
	}

	const ok = await verifyAltchaPayload(env, payload, context);
	if (!ok) {
		await recordHumanProofFailure(request, env, context);
		return json({
			error: "人机验证失败，请刷新后重试。",
			requiresTurnstile: (await shouldRequireTurnstile(request, env, context)).required,
		}, 400);
	}

	return null;
}

async function verifyAltchaPayload(
	env: Env,
	payloadValue: string,
	context: HumanProofContext,
): Promise<boolean> {
	try {
		const payload = JSON.parse(atob(payloadValue)) as Partial<Payload>;
		if (!payload.challenge || !payload.solution) return false;
		if (payload.challenge.parameters?.data?.context !== context) return false;

		const result = await verifySolution({
			challenge: payload.challenge,
			deriveKey: sha.deriveKey,
			hmacSignatureSecret: await ensureStatsSalt(env),
			solution: payload.solution,
		});

		return result.verified;
	} catch (error) {
		console.warn("ALTCHA verification failed", error);
		return false;
	}
}

async function getPublicMusicTracks(env: Env): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl
		FROM music_tracks
		WHERE is_active = 1
		ORDER BY sort_order ASC, created_at DESC`,
	).all();

	const tracks = (result.results ?? []).map((track) => {
		const row = track as Record<string, string | number>;
		return {
			id: row.id,
			title: row.title,
			artist: row.artist,
			album: row.album,
			objectKey: row.objectKey,
			coverUrl: row.coverUrl || embeddedCoverUrlForMusicKey(String(row.objectKey)),
			audioUrl: `/media/music/${stripMediaPrefix(String(row.objectKey), "music")}`,
		};
	});

	return json({ tracks });
}

async function getStatsSummaryResponse(env: Env, requestUrl: URL): Promise<Response> {
	const readyError = await ensureStatsReady(env);
	if (readyError) return readyError;

	const path = normalizeStatsPath(requestUrl.searchParams.get("path") ?? "/");
	return json(await getStatsSummary(env, path));
}

async function recordStatsVisit(
	request: Request,
	env: Env,
	heartbeatOnly: boolean,
): Promise<Response> {
	const originError = rejectCrossSiteWrite(request);
	if (originError) return originError;

	const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.statsWrite);
	if (rateLimit) return rateLimit;

	const readyError = await ensureStatsReady(env);
	if (readyError) return readyError;

	const body = await readJson(request);
	const path = normalizeStatsPath(readString(body.path, 400) || "/");
	const visitorHash = await getStatsVisitorHash(request, env, readString(body.visitorId, 160));
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

async function getStatsSummary(env: Env, path: string): Promise<JsonRecord> {
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
		env.DB.prepare("SELECT COALESCE(SUM(pv), 0) AS totalPv FROM stats_site_daily").first<{ totalPv: number }>(),
		env.DB.prepare("SELECT COALESCE(pv, 0) AS pv, COALESCE(uv, 0) AS uv FROM stats_site_daily WHERE day = ?")
			.bind(day)
			.first<{ pv: number; uv: number }>(),
		env.DB.prepare("SELECT COALESCE(pv, 0) AS pv FROM stats_site_daily WHERE day = ?")
			.bind(yesterday)
			.first<{ pv: number }>(),
		env.DB.prepare("SELECT COALESCE(SUM(pv), 0) AS pv FROM stats_site_daily WHERE day >= ? AND day <= ?")
			.bind(monthStart, day)
			.first<{ pv: number }>(),
		env.DB.prepare("SELECT COUNT(*) AS totalUv FROM stats_visitors").first<{ totalUv: number }>(),
		env.DB.prepare("SELECT COUNT(*) AS count FROM stats_active_visitors WHERE last_seen >= ?")
			.bind(cutoff)
			.first<{ count: number }>(),
		env.DB.prepare("SELECT COALESCE(SUM(pv), 0) AS totalPv FROM stats_page_daily WHERE path = ?")
			.bind(path)
			.first<{ totalPv: number }>(),
		env.DB.prepare("SELECT COALESCE(pv, 0) AS pv, COALESCE(uv, 0) AS uv FROM stats_page_daily WHERE path = ? AND day = ?")
			.bind(path, day)
			.first<{ pv: number; uv: number }>(),
		env.DB.prepare("SELECT COUNT(*) AS totalUv FROM stats_page_visitors WHERE path = ?")
			.bind(path)
			.first<{ totalUv: number }>(),
	]);

	const trendDays = recentStatsDays(7);
	const trendStart = trendDays[0] ?? day;
	const trendResult = await env.DB.prepare(
		`SELECT day, pv, uv
		FROM stats_site_daily
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

async function getCommentsConfig(env: Env): Promise<Response> {
	return json({ enabled: await areCommentsEnabled(env) });
}

async function createCommentsSession(
	request: Request,
	env: Env,
): Promise<Response> {
	const originError = rejectCrossSiteWrite(request);
	if (originError) return originError;

	const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.commentsSession);
	if (rateLimit) return rateLimit;

	if (!(await areCommentsEnabled(env))) {
		return json({ error: "评论区已关闭。" }, 403);
	}

	const body = await readJson(request);
	const proofError = await verifyHumanProof(
		request,
		env,
		"comments",
		readHumanProof(body.humanProof),
	);
	if (proofError) return proofError;

	const requestUrl = new URL(request.url);
	const cookieValue = await createCommentsSessionCookie(request, env);
	const response = json({ ok: true, expiresIn: COMMENTS_SESSION_MAX_AGE_SECONDS });
	response.headers.set(
		"set-cookie",
		`${COMMENTS_SESSION_COOKIE}=${cookieValue}; Path=/api/twikoo; Max-Age=${COMMENTS_SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${requestUrl.protocol === "https:" ? "; Secure" : ""}`,
	);
	return response;
}

async function handleTwikooRequest(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (!(await areCommentsEnabled(env))) {
		return json({ error: "评论区已关闭。" }, 403);
	}

	if (
		request.method !== "OPTIONS" &&
		!(await hasValidCommentsSession(request, env))
	) {
		return json({ error: "请先完成评论区人机验证。" }, 401);
	}

	return twikooWorker.fetch(request, {
		DB: env.DB,
		R2: createTwikooR2Binding(env.MEDIA_BUCKET),
		R2_PUBLIC_URL: `${requestUrl.origin}/media/twikoo`,
	});
}

async function areCommentsEnabled(env: Env): Promise<boolean> {
	const value = await getAppSetting(env, COMMENTS_ENABLED_SETTING_KEY);
	return value !== "false";
}

async function createCommentsSessionCookie(
	request: Request,
	env: Env,
): Promise<string> {
	const actorHash = await getRateLimitActorHash(request, env, "comments-session-cookie");
	const expiresAt = Math.floor(Date.now() / 1000) + COMMENTS_SESSION_MAX_AGE_SECONDS;
	const signature = await signSessionValue(env, `comments:${actorHash}:${expiresAt}`);
	return base64UrlEncode(JSON.stringify({
		context: "comments",
		expiresAt,
		actorHash,
		signature,
	} satisfies CommentsSessionCookie));
}

async function hasValidCommentsSession(
	request: Request,
	env: Env,
): Promise<boolean> {
	const rawCookie = readCookie(request, COMMENTS_SESSION_COOKIE);
	if (!rawCookie) return false;

	try {
		const cookie = JSON.parse(base64UrlDecode(rawCookie)) as CommentsSessionCookie;
		if (cookie.context !== "comments") return false;
		if (!Number.isFinite(cookie.expiresAt) || cookie.expiresAt < Math.floor(Date.now() / 1000)) {
			return false;
		}

		const actorHash = await getRateLimitActorHash(request, env, "comments-session-cookie");
		if (cookie.actorHash !== actorHash) return false;

		const expected = await signSessionValue(env, `comments:${cookie.actorHash}:${cookie.expiresAt}`);
		return timingSafeEqual(cookie.signature, expected);
	} catch {
		return false;
	}
}

function createTwikooR2Binding(bucket: R2Bucket): Pick<R2Bucket, "put" | "delete"> {
	return {
		put: (key, value, options) => bucket.put(normalizeTwikooObjectKey(key), value, options),
		delete: (keys) => {
			if (Array.isArray(keys)) {
				return bucket.delete(keys.map(normalizeTwikooObjectKey));
			}
			return bucket.delete(normalizeTwikooObjectKey(keys));
		},
	};
}

function normalizeTwikooObjectKey(key: string): string {
	const normalized = safeNormalizeMediaKey(key, "twikoo");
	if (!normalized) throw new Error("Invalid Twikoo media key.");
	return normalized;
}

async function handleAdminApi(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const segments = requestUrl.pathname.split("/").filter(Boolean);

	if (requestUrl.pathname === "/api/admin/avatar" && request.method === "POST") {
		return uploadAvatar(request, env);
	}

	if (segments[2] === "settings") {
		if (segments[3] === "comments") {
			if (request.method === "GET") return getAdminCommentsSettings(env);
			if (request.method === "POST") return updateAdminCommentsSettings(request, env);
		}

		if (segments[3] === "telegram") {
			if (!segments[4] && request.method === "GET") return getAdminTelegramSettings(env);
			if (!segments[4] && request.method === "POST") return updateAdminTelegramSettings(request, env);
			if (segments[4] === "test" && request.method === "POST") {
				return sendTelegramTestNotification(env);
			}
		}
	}

	if (segments[2] === "friends") {
		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminFriends(env, requestUrl);
		if (request.method === "PATCH" && id) return updateFriend(request, env, id);
		if (request.method === "DELETE" && id) return deleteFriend(env, id);
	}

	if (segments[2] === "music") {
		if (segments[3] === "objects" && request.method === "GET") {
			return listR2MusicObjects(env);
		}
		if (segments[3] === "import" && request.method === "POST") {
			return importR2MusicObjects(request, env);
		}

		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminMusic(env);
		if (request.method === "POST" && !id) return createMusicTrack(request, env);
		if (request.method === "PATCH" && id) return updateMusicTrack(request, env, id);
		if (request.method === "DELETE" && id) return deleteMusicTrack(env, id);
	}

	return json({ error: "后台接口不存在。" }, 404);
}

async function getAdminCommentsSettings(env: Env): Promise<Response> {
	return json({ enabled: await areCommentsEnabled(env) });
}

async function updateAdminCommentsSettings(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJson(request);
	const enabled = readBoolean(body.enabled, await areCommentsEnabled(env));
	await setAppSetting(env, COMMENTS_ENABLED_SETTING_KEY, enabled ? "true" : "false");
	return json({ ok: true, enabled });
}

async function getAdminTelegramSettings(env: Env): Promise<Response> {
	const settings = await readTelegramSettings(env);
	return json({
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		botTokenHint: maskSecret(settings.botToken),
		chatId: settings.chatId,
		threadId: settings.threadId,
	});
}

async function updateAdminTelegramSettings(
	request: Request,
	env: Env,
): Promise<Response> {
	const current = await readTelegramSettings(env);
	const body = await readJson(request);
	const botToken = readString(body.botToken, 256);
	const settings: TelegramSettings = {
		enabled: readBoolean(body.enabled, current.enabled),
		botToken: botToken || (readBoolean(body.clearBotToken, false) ? "" : current.botToken),
		chatId: readString(body.chatId, 120),
		threadId: readString(body.threadId, 40),
	};

	await writeTelegramSettings(env, settings);
	return json({
		ok: true,
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		botTokenHint: maskSecret(settings.botToken),
		chatId: settings.chatId,
		threadId: settings.threadId,
	});
}

async function sendTelegramTestNotification(env: Env): Promise<Response> {
	const settings = await readTelegramSettings(env);
	if (!settings.enabled || !settings.botToken || !settings.chatId) {
		return json({ error: "Telegram 通知尚未完整配置。" }, 400);
	}

	const result = await sendTelegramMessage(settings, "这是一条来自星影博客后台的 Telegram 测试通知。");
	if (!result.ok) {
		return json({ error: result.error }, 502);
	}

	return json({ ok: true });
}

async function listAdminFriends(env: Env, requestUrl: URL): Promise<Response> {
	const status = requestUrl.searchParams.get("status") ?? "pending";
	const includeAll = status === "all";

	if (!includeAll && !FRIEND_STATUSES.has(status)) {
		return json({ error: "友链状态不正确。" }, 400);
	}

	const result = includeAll
		? await env.DB.prepare(
				`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
				is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
				updated_at AS updatedAt
				FROM friend_links
				ORDER BY created_at DESC`,
			).all()
		: await env.DB.prepare(
				`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
				is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
				updated_at AS updatedAt
				FROM friend_links
				WHERE status = ?
				ORDER BY created_at DESC`,
			)
				.bind(status)
				.all();

	return json({ friends: result.results ?? [] });
}

async function updateFriend(
	request: Request,
	env: Env,
	id: number,
): Promise<Response> {
	if (!Number.isInteger(id)) return json({ error: "友链 ID 不正确。" }, 400);

	const body = await readJson(request);
	const fields: string[] = [];
	const values: (string | number)[] = [];

	addStringUpdate(fields, values, body, "name", "name", 40);
	addStringUpdate(fields, values, body, "description", "description", 120);

	if (typeof body.url === "string") {
		const value = readString(body.url, 400);
		if (!isHttpsUrl(value)) return json({ error: "链接必须是 https 地址。" }, 400);
		fields.push("url = ?");
		values.push(value);
	}

	if (typeof body.avatarUrl === "string") {
		const value = readString(body.avatarUrl, 600);
		if (!isAvatarUrl(value)) return json({ error: "头像地址不正确。" }, 400);
		fields.push("avatar_url = ?");
		values.push(value);
	}

	if (typeof body.status === "string") {
		const status = body.status.trim();
		if (!FRIEND_STATUSES.has(status)) return json({ error: "友链状态不正确。" }, 400);
		fields.push("status = ?");
		values.push(status);
	}

	addBooleanUpdate(fields, values, body, "isActive", "is_active");
	addNumberUpdate(fields, values, body, "sortOrder", "sort_order");

	if (fields.length > 0) {
		await env.DB.prepare(`UPDATE friend_links SET ${fields.join(", ")} WHERE id = ?`)
			.bind(...values, id)
			.run();
	}

	const friend = await getFriend(env, id);
	if (!friend) return json({ error: "友链不存在。" }, 404);

	return json({ friend });
}

async function deleteFriend(env: Env, id: number): Promise<Response> {
	if (!Number.isInteger(id)) return json({ error: "友链 ID 不正确。" }, 400);

	await env.DB.prepare("DELETE FROM friend_links WHERE id = ?").bind(id).run();
	return json({ ok: true });
}

async function getFriend(env: Env, id: number): Promise<Record<string, unknown> | null> {
	const friend = await env.DB.prepare(
		`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
		is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
		updated_at AS updatedAt
		FROM friend_links
		WHERE id = ?`,
	)
		.bind(id)
		.first<Record<string, unknown>>();

	return friend ?? null;
}

async function uploadAvatar(request: Request, env: Env): Promise<Response> {
	const form = await request.formData();
	const file = form.get("file");

	if (!(file instanceof File)) {
		return json({ error: "请选择头像文件。" }, 400);
	}

	if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
		return json({ error: "头像必须是 JPG、PNG、WebP、AVIF 或 GIF 图片。" }, 400);
	}

	if (file.size > MAX_AVATAR_SIZE) {
		return json({ error: "头像文件不能超过 3 MB。" }, 400);
	}

	const key = `avatars/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
	await env.MEDIA_BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type },
	});

	return json({ avatarUrl: `/media/avatars/${stripMediaPrefix(key, "avatars")}` });
}

async function listAdminMusic(env: Env): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
		is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
		updated_at AS updatedAt
		FROM music_tracks
		ORDER BY sort_order ASC, created_at DESC`,
	).all();

	return json({ tracks: result.results ?? [] });
}

async function listR2MusicObjects(env: Env): Promise<Response> {
	if (!env.MEDIA_BUCKET) {
		return json({ error: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first." }, 503);
	}

	const objects = await scanR2MusicObjects(env);
	return json({ objects: objects.map(stripCoverBytes) });
}

async function importR2MusicObjects(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!env.MEDIA_BUCKET) {
		return json({ error: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first." }, 503);
	}

	const body = await readJson(request);
	const requestedKeys = Array.isArray(body.objectKeys)
		? body.objectKeys
				.filter((key): key is string => typeof key === "string")
				.map((key) => safeNormalizeMediaKey(key, "music"))
				.filter((key): key is string => Boolean(key))
		: [];
	const isActive = readBoolean(body.isActive, true) ? 1 : 0;
	const objects = await scanR2MusicObjects(env);
	const requestedKeySet = new Set(requestedKeys);
	const candidates = objects.filter((object) => {
		if (object.imported) return false;
		return requestedKeySet.size === 0 || requestedKeySet.has(object.key);
	});

	if (candidates.length === 0) {
		return json({ ok: true, imported: [], message: "没有可导入的新音乐。" });
	}

	const maxSortRow = await env.DB.prepare(
		"SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM music_tracks",
	).first<{ maxSort: number }>();
	let sortOrder = readInteger(body.sortOrderStart, Number(maxSortRow?.maxSort ?? 0) + 1);
	const imported: Record<string, unknown>[] = [];

	for (const object of candidates) {
		const coverUrl = object.cover
			? await saveEmbeddedCover(env, object.key, object.cover)
			: "";
		const result = await env.DB.prepare(
			`INSERT INTO music_tracks
			(title, artist, album, object_key, cover_url, is_active, sort_order)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				object.title,
				object.artist,
				object.album,
				object.key,
				coverUrl,
				isActive,
				sortOrder,
			)
			.run();

		imported.push({
			id: result.meta.last_row_id,
			title: object.title,
			artist: object.artist,
			album: object.album,
			objectKey: object.key,
			coverUrl,
			isActive,
			sortOrder,
		});
		sortOrder += 1;
	}

	return json({ ok: true, imported }, 201);
}

async function scanR2MusicObjects(env: Env): Promise<MusicObjectInfo[]> {
	const existingKeys = await getExistingMusicKeys(env);
	const objects: MusicObjectInfo[] = [];
	let cursor: string | undefined;

	do {
		const listed = await env.MEDIA_BUCKET.list({
			prefix: MUSIC_PREFIX,
			cursor,
			limit: Math.min(1000, MUSIC_OBJECT_SCAN_LIMIT - objects.length),
		});

		for (const object of listed.objects) {
			if (objects.length >= MUSIC_OBJECT_SCAN_LIMIT) break;
			if (!isAudioObjectKey(object.key)) continue;

			const key = safeNormalizeMediaKey(object.key, "music");
			if (!key) continue;

			const metadata = await readMusicMetadata(env, key);
			const coverUrl = embeddedCoverUrlForMusicKey(key);
			objects.push({
				...metadata,
				key,
				fileName: getFileNameFromKey(key),
				size: object.size,
				uploaded: object.uploaded instanceof Date
					? object.uploaded.toISOString()
					: String(object.uploaded),
				imported: existingKeys.has(key),
				audioUrl: `/media/music/${stripMediaPrefix(key, "music")}`,
				coverUrl,
				hasEmbeddedCover: Boolean(metadata.cover),
			});
		}

		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor && objects.length < MUSIC_OBJECT_SCAN_LIMIT);

	return objects.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-Hans-CN"));
}

function stripCoverBytes(object: MusicObjectInfo): Omit<MusicObjectInfo, "cover"> {
	const { cover: _cover, ...safeObject } = object;
	return safeObject;
}

async function getExistingMusicKeys(env: Env): Promise<Set<string>> {
	const result = await env.DB.prepare(
		"SELECT object_key AS objectKey FROM music_tracks",
	).all();

	return new Set(
		(result.results ?? [])
			.map((row) => String((row as Record<string, unknown>).objectKey ?? ""))
			.map((key) => safeNormalizeMediaKey(key, "music"))
			.filter((key): key is string => Boolean(key)),
	);
}

async function readMusicMetadata(
	env: Env,
	key: string,
): Promise<MusicMetadata & { cover?: EmbeddedCover }> {
	const fallback = inferMusicMetadataFromKey(key);
	if (!key.toLowerCase().endsWith(".mp3")) return fallback;

	try {
		const object = await env.MEDIA_BUCKET.get(key, {
			range: { offset: 0, length: MUSIC_METADATA_READ_BYTES },
		});
		if (!object) return fallback;

		const bytes = new Uint8Array(await object.arrayBuffer());
		const metadata = parseId3Metadata(bytes);
		return {
			title: truncateText(metadata.title || fallback.title, 80),
			artist: truncateText(metadata.artist || fallback.artist, 80),
			album: truncateText(metadata.album || fallback.album, 80),
			cover: metadata.cover,
		};
	} catch {
		return fallback;
	}
}

function parseId3Metadata(bytes: Uint8Array): Partial<MusicMetadata> & { cover?: EmbeddedCover } {
	if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return {};

	const version = bytes[3];
	if (version < 3 || version > 4) return {};

	const flags = bytes[5];
	const tagSize = readSyncSafeInteger(bytes, 6);
	const end = Math.min(bytes.length, 10 + tagSize);
	let offset = 10;

	if (flags & 0x40) {
		if (offset + 4 > end) return {};
		const extendedSize = version === 4
			? readSyncSafeInteger(bytes, offset)
			: readUint32(bytes, offset);
		offset += version === 4 ? extendedSize : extendedSize + 4;
	}

	const frameMap: Record<string, keyof MusicMetadata> = {
		TIT2: "title",
		TPE1: "artist",
		TALB: "album",
	};
	const metadata: Partial<MusicMetadata> & { cover?: EmbeddedCover } = {};

	while (offset + 10 <= end) {
		const frameId = ascii(bytes, offset, 4);
		if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

		const frameSize = version === 4
			? readSyncSafeInteger(bytes, offset + 4)
			: readUint32(bytes, offset + 4);
		if (frameSize <= 0) break;

		const frameStart = offset + 10;
		const frameEnd = Math.min(frameStart + frameSize, end);
		const field = frameMap[frameId];
		if (field && frameStart < frameEnd) {
			const value = decodeId3Text(bytes.slice(frameStart, frameEnd));
			if (value) metadata[field] = value;
		} else if (frameId === "APIC" && frameStart < frameEnd && !metadata.cover) {
			metadata.cover = parseApicFrame(bytes.slice(frameStart, frameEnd));
		}

		offset = frameEnd;
	}

	return metadata;
}

function decodeId3Text(bytes: Uint8Array): string {
	if (bytes.length === 0) return "";

	const encoding = bytes[0];
	let payload = bytes.slice(1);
	let decoder = new TextDecoder("iso-8859-1");

	if (encoding === 1) {
		if (payload[0] === 0xfe && payload[1] === 0xff) {
			decoder = new TextDecoder("utf-16be");
			payload = payload.slice(2);
		} else {
			decoder = new TextDecoder("utf-16le");
			if (payload[0] === 0xff && payload[1] === 0xfe) payload = payload.slice(2);
		}
	} else if (encoding === 2) {
		decoder = new TextDecoder("utf-16be");
	} else if (encoding === 3) {
		decoder = new TextDecoder("utf-8");
	}

	return cleanMetadataText(decoder.decode(payload));
}

function parseApicFrame(bytes: Uint8Array): EmbeddedCover | undefined {
	if (bytes.length < 5) return undefined;

	const encoding = bytes[0];
	let offset = 1;
	const mimeEnd = indexOfTerminator(bytes, offset, 1);
	if (mimeEnd < 0) return undefined;

	const mimeType = cleanMetadataText(
		new TextDecoder("iso-8859-1").decode(bytes.slice(offset, mimeEnd)),
	).toLowerCase();
	offset = mimeEnd + 1;

	if (!mimeType.startsWith("image/") || offset >= bytes.length) return undefined;
	offset += 1;

	const descriptionTerminatorLength = encoding === 1 || encoding === 2 ? 2 : 1;
	const descriptionEnd = indexOfTerminator(bytes, offset, descriptionTerminatorLength);
	if (descriptionEnd < 0) return undefined;

	const imageStart = descriptionEnd + descriptionTerminatorLength;
	if (imageStart >= bytes.length) return undefined;

	return {
		mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
		bytes: bytes.slice(imageStart),
	};
}

function indexOfTerminator(
	bytes: Uint8Array,
	start: number,
	terminatorLength: 1 | 2,
): number {
	for (let index = start; index <= bytes.length - terminatorLength; index += 1) {
		if (terminatorLength === 1 && bytes[index] === 0) return index;
		if (terminatorLength === 2 && bytes[index] === 0 && bytes[index + 1] === 0) {
			return index;
		}
	}
	return -1;
}

async function saveEmbeddedCover(
	env: Env,
	musicKey: string,
	cover: EmbeddedCover,
): Promise<string> {
	const extension = imageExtensionFromMimeType(cover.mimeType);
	const baseName = sanitizeFileName(getFileNameFromKey(musicKey).replace(/\.[^.]+$/, ""));
	const key = `covers/${baseName}-${crypto.randomUUID()}.${extension}`;

	await env.MEDIA_BUCKET.put(key, cover.bytes, {
		httpMetadata: { contentType: cover.mimeType },
	});

	return `/media/covers/${stripMediaPrefix(key, "covers")}`;
}

function imageExtensionFromMimeType(mimeType: string): string {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "image/webp") return "webp";
	return "jpg";
}

function inferMusicMetadataFromKey(key: string): MusicMetadata {
	const fileName = getFileNameFromKey(key);
	const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
	const parts = baseName.split(/\s+-\s+/).map(cleanMetadataText).filter(Boolean);

	if (parts.length >= 2) {
		return {
			title: truncateText(parts[0], 80),
			artist: truncateText(parts.slice(1).join(" - "), 80),
			album: "",
		};
	}

	return {
		title: truncateText(cleanMetadataText(baseName) || fileName, 80),
		artist: "",
		album: "",
	};
}

function getFileNameFromKey(key: string): string {
	const fileName = stripMediaPrefix(key, "music").split("/").pop() ?? key;
	return safeDecodeURIComponent(fileName);
}

function isAudioObjectKey(key: string): boolean {
	if (key.endsWith("/")) return false;
	const extension = key.split(".").pop()?.toLowerCase() ?? "";
	return AUDIO_EXTENSIONS.has(extension);
}

function cleanMetadataText(value: string): string {
	return value
		.replace(/\u0000+/g, " / ")
		.replace(/\s+\/\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateText(value: string, maxLength: number): string {
	return value.trim().slice(0, maxLength);
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return Array.from(bytes.slice(offset, offset + length))
		.map((byte) => String.fromCharCode(byte))
		.join("");
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 24) |
		(bytes[offset + 1] << 16) |
		(bytes[offset + 2] << 8) |
		bytes[offset + 3]
	) >>> 0;
}

function readSyncSafeInteger(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 21) |
		(bytes[offset + 1] << 14) |
		(bytes[offset + 2] << 7) |
		bytes[offset + 3]
	);
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function createMusicTrack(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJson(request);
	const title = readString(body.title, 80);
	const artist = readString(body.artist, 80);
	const album = readString(body.album, 80);
	const objectKey = safeNormalizeMediaKey(readString(body.objectKey, 500), "music");
	const coverUrl = readString(body.coverUrl, 600);
	const sortOrder = readInteger(body.sortOrder, 0);
	const isActive = readBoolean(body.isActive, true) ? 1 : 0;

	if (!title || !objectKey) {
		return json({ error: "请填写歌曲名称和 R2 音频 Key。" }, 400);
	}

	if (coverUrl && !isAvatarUrl(coverUrl)) {
		return json({ error: "封面地址需要是公网图片或站内头像地址。" }, 400);
	}

	const result = await env.DB.prepare(
		`INSERT INTO music_tracks
		(title, artist, album, object_key, cover_url, is_active, sort_order)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(title, artist, album, objectKey, coverUrl, isActive, sortOrder)
		.run();

	return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function updateMusicTrack(
	request: Request,
	env: Env,
	id: number,
): Promise<Response> {
	if (!Number.isInteger(id)) return json({ error: "歌曲 ID 不正确。" }, 400);

	const body = await readJson(request);
	const fields: string[] = [];
	const values: (string | number)[] = [];

	addStringUpdate(fields, values, body, "title", "title", 80);
	addStringUpdate(fields, values, body, "artist", "artist", 80);
	addStringUpdate(fields, values, body, "album", "album", 80);

	if (typeof body.objectKey === "string") {
		const value = safeNormalizeMediaKey(readString(body.objectKey, 500), "music");
		if (!value) return json({ error: "R2 音频 Key 不正确。" }, 400);
		fields.push("object_key = ?");
		values.push(value);
	}

	if (typeof body.coverUrl === "string") {
		const value = readString(body.coverUrl, 600);
		if (value && !isAvatarUrl(value)) return json({ error: "封面地址不正确。" }, 400);
		fields.push("cover_url = ?");
		values.push(value);
	}

	addBooleanUpdate(fields, values, body, "isActive", "is_active");
	addNumberUpdate(fields, values, body, "sortOrder", "sort_order");

	if (fields.length > 0) {
		await env.DB.prepare(`UPDATE music_tracks SET ${fields.join(", ")} WHERE id = ?`)
			.bind(...values, id)
			.run();
	}

	const track = await env.DB.prepare(
		`SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
		is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
		updated_at AS updatedAt
		FROM music_tracks
		WHERE id = ?`,
	)
		.bind(id)
		.first<Record<string, unknown>>();

	if (!track) return json({ error: "歌曲不存在。" }, 404);

	return json({ track });
}

async function deleteMusicTrack(env: Env, id: number): Promise<Response> {
	if (!Number.isInteger(id)) return json({ error: "歌曲 ID 不正确。" }, 400);

	await env.DB.prepare("DELETE FROM music_tracks WHERE id = ?").bind(id).run();
	return json({ ok: true });
}

async function handleMedia(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: "不支持的请求方法。" }, 405);
	}

	const segments = requestUrl.pathname.split("/").filter(Boolean);
	const kind = segments[1];
	const rawKey = safeDecodeURIComponent(segments.slice(2).join("/"));

	if (kind === "covers" && rawKey.startsWith("from-music/")) {
		return getEmbeddedCoverResponse(request, env, rawKey.slice("from-music/".length));
	}

	if (kind !== "music" && kind !== "avatars" && kind !== "covers" && kind !== "twikoo") {
		return json({ error: "媒体类型不存在。" }, 404);
	}

	const key = safeNormalizeMediaKey(rawKey, kind);
	if (!key) {
		return json({ error: "媒体路径不正确。" }, 400);
	}
	const head = await env.MEDIA_BUCKET.head(key);

	if (!head) {
		return new Response("Not found", { status: 404 });
	}

	const rangeHeader = request.headers.get("range");
	const range = rangeHeader ? parseRange(rangeHeader, head.size) : null;

	if (range && !range.ok) {
		return new Response("Range Not Satisfiable", {
			status: 416,
			headers: {
				"content-range": `bytes */${head.size}`,
			},
		});
	}

	const headers = mediaHeaders(head);

	if (range?.ok) {
		headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
		headers.set("content-length", String(range.length));
		if (request.method === "HEAD") {
			return new Response(null, { status: 206, headers });
		}

		const object = await env.MEDIA_BUCKET.get(key, {
			range: { offset: range.start, length: range.length },
		});
		if (!object?.body) return new Response("Not found", { status: 404 });
		return new Response(object.body, { status: 206, headers });
	}

	headers.set("content-length", String(head.size));
	if (request.method === "HEAD") {
		return new Response(null, { headers });
	}

	const object = await env.MEDIA_BUCKET.get(key);
	if (!object?.body) return new Response("Not found", { status: 404 });
	return new Response(object.body, { headers });
}

async function getEmbeddedCoverResponse(
	request: Request,
	env: Env,
	rawMusicKey: string,
): Promise<Response> {
	const key = safeNormalizeMediaKey(rawMusicKey, "music");
	if (!key) {
		return json({ error: "媒体路径不正确。" }, 400);
	}
	const metadata = await readMusicMetadata(env, key);
	if (!metadata.cover) return new Response("Not found", { status: 404 });

	const headers = new Headers({
		"content-type": metadata.cover.mimeType,
		"cache-control": "public, max-age=31536000, immutable",
		"accept-ranges": "bytes",
	});
	const size = metadata.cover.bytes.byteLength;
	headers.set("content-length", String(size));

	const rangeHeader = request.headers.get("range");
	const range = rangeHeader ? parseRange(rangeHeader, size) : null;

	if (range && !range.ok) {
		return new Response("Range Not Satisfiable", {
			status: 416,
			headers: {
				"accept-ranges": "bytes",
				"content-range": `bytes */${size}`,
			},
		});
	}

	if (range?.ok) {
		headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
		headers.set("content-length", String(range.length));
		if (request.method === "HEAD") {
			return new Response(null, { status: 206, headers });
		}

		return new Response(
			arrayBufferFromBytes(metadata.cover.bytes.slice(range.start, range.end + 1)),
			{ status: 206, headers },
		);
	}

	if (request.method === "HEAD") {
		return new Response(null, { headers });
	}

	return new Response(arrayBufferFromBytes(metadata.cover.bytes), { headers });
}

function mediaHeaders(object: R2Object): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("accept-ranges", "bytes");
	headers.set("cache-control", "public, max-age=31536000, immutable");
	headers.set("etag", object.httpEtag);

	if (!headers.has("content-type")) {
		headers.set("content-type", "application/octet-stream");
	}

	return headers;
}

function parseRange(rangeHeader: string, size: number): RangeResult {
	const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return { ok: false };

	const [, startText, endText] = match;
	if (!startText && !endText) return { ok: false };

	let start: number;
	let end: number;

	if (!startText) {
		const suffixLength = Number.parseInt(endText, 10);
		if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { ok: false };
		start = Math.max(size - suffixLength, 0);
		end = size - 1;
	} else {
		start = Number.parseInt(startText, 10);
		end = endText ? Number.parseInt(endText, 10) : size - 1;
	}

	if (
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start < 0 ||
		end < start ||
		start >= size
	) {
		return { ok: false };
	}

	end = Math.min(end, size - 1);
	return { ok: true, start, end, length: end - start + 1 };
}

async function ensureStatsReady(env: Env): Promise<Response | null> {
	if (!env.DB) {
		return json({ error: "Missing D1 binding. Bind a D1 database as DB first." }, 503);
	}

	if (!statsSchemaReady) {
		await env.DB.batch(
			STATS_INIT_STATEMENTS.map((statement) => env.DB.prepare(statement)),
		);
		statsSchemaReady = true;
	}

	await ensureStatsSalt(env);
	return null;
}

async function ensureStatsSalt(env: Env): Promise<string> {
	if (statsSaltCache) return statsSaltCache;

	const existing = await env.DB.prepare(
		"SELECT value FROM app_settings WHERE key = ?",
	)
		.bind(STATS_SALT_SETTING_KEY)
		.first<{ value: string }>();

	if (existing?.value) {
		statsSaltCache = existing.value;
		return existing.value;
	}

	const salt = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(key) DO NOTHING`,
	)
		.bind(STATS_SALT_SETTING_KEY, salt)
		.run();

	const saved = await env.DB.prepare(
		"SELECT value FROM app_settings WHERE key = ?",
	)
		.bind(STATS_SALT_SETTING_KEY)
		.first<{ value: string }>();

	statsSaltCache = saved?.value ?? salt;
	return statsSaltCache;
}

async function getStatsVisitorHash(
	request: Request,
	env: Env,
	clientVisitorId: string,
): Promise<string> {
	const salt = await ensureStatsSalt(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	const ip =
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-real-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"";
	const source = clientVisitorId
		? `client:${clientVisitorId}:${userAgent}`
		: `request:${ip}:${userAgent}`;
	return hashToken(`${salt}:${source}`);
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
	for (let index = count - 1; index >= 0; index -= 1) {
		days.push(getStatsDay(Date.now() - index * 24 * 60 * 60 * 1000));
	}
	return days;
}

async function cleanupInactiveVisitors(env: Env, cutoff: string): Promise<void> {
	await env.DB.prepare("DELETE FROM stats_active_visitors WHERE last_seen < ?")
		.bind(cutoff)
		.run();
}

function isLikelyBot(request: Request): boolean {
	const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
	return /bot|crawler|spider|slurp|curl|wget|python|go-http-client|headless/.test(userAgent);
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
	const token = readBearerToken(request);

	if (!token) {
		const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.adminFailure);
		if (rateLimit) return rateLimit;
		return json({ error: "Missing admin token." }, 401);
	}

	if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
		return null;
	}

	if (env.DB && await verifyStoredAdminToken(env, token)) {
		return null;
	}

	if (!env.ADMIN_TOKEN && env.DB && !(await getStoredAdminTokenHash(env))) {
		const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.adminFailure);
		if (rateLimit) return rateLimit;
		return json({
			error: "Admin token is not initialized. Call /api/setup/init-db with Authorization: Bearer <token> first.",
		}, 503);
	}

	const rateLimit = await enforceRateLimit(request, env, RATE_LIMITS.adminFailure);
	if (rateLimit) return rateLimit;
	return json({ error: "Invalid admin token." }, 401);
}

async function setupAdminToken(
	env: Env,
	token: string,
): Promise<Response | "env" | "database"> {
	if (env.ADMIN_TOKEN) {
		if (token !== env.ADMIN_TOKEN) {
			return json({
				error: "Invalid setup token. Use the configured ADMIN_TOKEN.",
			}, 401);
		}
		return "env";
	}

	const tokenHash = await hashToken(token);
	const storedHash = await getStoredAdminTokenHash(env);

	if (storedHash) {
		if (storedHash !== tokenHash) {
			return json({ error: "Invalid setup token." }, 401);
		}
		return "database";
	}

	await saveStoredAdminTokenHash(env, tokenHash);
	return "database";
}

function readBearerToken(request: Request): string {
	const authorization = request.headers.get("authorization") ?? "";
	return authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: "";
}

async function readSetupToken(
	request: Request,
	requestUrl: URL,
): Promise<string | Response> {
	if (requestUrl.searchParams.has("token")) {
		return json({
			error: "Setup tokens are no longer accepted in URLs. Use Authorization: Bearer <token> or POST JSON { \"token\": \"...\" }.",
		}, 400);
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

async function verifyStoredAdminToken(env: Env, token: string): Promise<boolean> {
	const storedHash = await getStoredAdminTokenHash(env);
	if (!storedHash) return false;
	return storedHash === await hashToken(token);
}

async function getStoredAdminTokenHash(env: Env): Promise<string | null> {
	try {
		const row = await env.DB.prepare(
			"SELECT value FROM app_settings WHERE key = ?",
		)
			.bind(ADMIN_TOKEN_SETTING_KEY)
			.first<{ value: string }>();
		return row?.value ?? null;
	} catch {
		return null;
	}
}

async function saveStoredAdminTokenHash(
	env: Env,
	tokenHash: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = excluded.updated_at`,
	)
		.bind(ADMIN_TOKEN_SETTING_KEY, tokenHash)
		.run();
}

async function getAppSetting(env: Env, key: string): Promise<string | null> {
	const readyError = await ensureRateLimitReady(env);
	if (readyError) throw new Error("Settings table is not available.");

	const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

async function setAppSetting(
	env: Env,
	key: string,
	value: string,
): Promise<void> {
	const readyError = await ensureRateLimitReady(env);
	if (readyError) throw new Error("Settings table is not available.");

	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = excluded.updated_at`,
	)
		.bind(key, value)
		.run();
}

async function readTelegramSettings(env: Env): Promise<TelegramSettings> {
	const stored = await getAppSetting(env, TELEGRAM_SETTINGS_KEY);
	if (!stored) {
		return { enabled: false, botToken: "", chatId: "", threadId: "" };
	}

	try {
		const parsed = JSON.parse(stored) as Partial<TelegramSettings>;
		return {
			enabled: Boolean(parsed.enabled),
			botToken: readString(parsed.botToken, 256),
			chatId: readString(parsed.chatId, 120),
			threadId: readString(parsed.threadId, 40),
		};
	} catch {
		return { enabled: false, botToken: "", chatId: "", threadId: "" };
	}
}

async function writeTelegramSettings(
	env: Env,
	settings: TelegramSettings,
): Promise<void> {
	await setAppSetting(env, TELEGRAM_SETTINGS_KEY, JSON.stringify(settings));
}

async function sendTelegramFriendNotification(
	env: Env,
	friend: {
		id: number;
		name: string;
		description: string;
		url: string;
		avatarUrl: string;
	},
): Promise<void> {
	const settings = await readTelegramSettings(env);
	if (!settings.enabled || !settings.botToken || !settings.chatId) return;

	const text = [
		"新的友链申请",
		"",
		`ID：${friend.id || "-"}`,
		`名称：${friend.name}`,
		`链接：${friend.url}`,
		`头像：${friend.avatarUrl}`,
		`简介：${friend.description}`,
	].join("\n");
	const result = await sendTelegramMessage(settings, text);
	if (!result.ok) {
		console.warn("Telegram notification rejected", result.error);
	}
}

async function sendTelegramMessage(
	settings: TelegramSettings,
	text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const payload: Record<string, string | number | boolean> = {
		chat_id: settings.chatId,
		text,
		disable_web_page_preview: true,
	};
	const threadId = Number.parseInt(settings.threadId, 10);
	if (Number.isInteger(threadId) && threadId > 0) {
		payload.message_thread_id = threadId;
	}

	try {
		const response = await fetch(
			`https://api.telegram.org/bot${settings.botToken}/sendMessage`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
		);
		const data = await response.json().catch(() => ({})) as {
			ok?: boolean;
			description?: string;
		};
		if (!response.ok || data.ok === false) {
			return {
				ok: false,
				error: data.description ?? `Telegram API returned ${response.status}.`,
			};
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Telegram request failed.",
		};
	}
}

function maskSecret(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);

	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function signSessionValue(env: Env, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(await ensureStatsSalt(env)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;

	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

function base64UrlEncode(value: string): string {
	return btoa(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	return atob(padded);
}

function readCookie(request: Request, name: string): string {
	const cookie = request.headers.get("cookie") ?? "";
	for (const part of cookie.split(";")) {
		const [rawKey, ...rawValue] = part.trim().split("=");
		if (rawKey === name) {
			return rawValue.join("=");
		}
	}
	return "";
}

async function readJson(request: Request): Promise<JsonRecord> {
	try {
		const data = await request.json();
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return {};
		}
		return data as JsonRecord;
	} catch {
		return {};
	}
}

function readString(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function readInteger(value: unknown, fallback: number): number {
	const parsed =
		typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return fallback;
}

function readHumanProof(value: unknown): HumanProof | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const proof = value as Record<string, unknown>;
	const type = readString(proof.type, 20);

	if (type === "turnstile") {
		return {
			type: "turnstile",
			token: readString(proof.token, 2048) || readString(proof.turnstileToken, 2048),
		};
	}

	return {
		type: "altcha",
		payload: readString(proof.payload, 20000),
	};
}

function normalizeHumanProofContext(value: string | null): HumanProofContext {
	const context = value?.trim() ?? "";
	return HUMAN_PROOF_CONTEXTS.has(context) ? context as HumanProofContext : "friends";
}

function addStringUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
	maxLength: number,
) {
	if (typeof body[fieldName] !== "string") return;
	fields.push(`${columnName} = ?`);
	values.push(readString(body[fieldName], maxLength));
}

function addBooleanUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
) {
	if (typeof body[fieldName] !== "boolean") return;
	fields.push(`${columnName} = ?`);
	values.push(body[fieldName] ? 1 : 0);
}

function addNumberUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
) {
	if (typeof body[fieldName] !== "number" && typeof body[fieldName] !== "string") {
		return;
	}

	fields.push(`${columnName} = ?`);
	values.push(readInteger(body[fieldName], 0));
}

async function ensureRateLimitReady(env: Env): Promise<Response | null> {
	if (!env.DB) {
		return json({ error: "Missing D1 binding. Bind a D1 database as DB first." }, 503);
	}

	if (!rateLimitSchemaReady) {
		await env.DB.batch(
			RATE_LIMIT_INIT_STATEMENTS.map((statement) => env.DB.prepare(statement)),
		);
		rateLimitSchemaReady = true;
	}

	await ensureStatsSalt(env);
	return null;
}

async function enforceRateLimit(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<Response | null> {
	const readyError = await ensureRateLimitReady(env);
	if (readyError) return readyError;

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart = Math.floor(nowSeconds / config.windowSeconds) * config.windowSeconds;
	const retryAfterSeconds = Math.max(1, windowStart + config.windowSeconds - nowSeconds);
	const actorHash = await getRateLimitActorHash(request, env, config.scope);

	await env.DB.prepare(
		`INSERT INTO rate_limits (scope, actor_hash, window_start, count, updated_at)
		VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(scope, actor_hash, window_start) DO UPDATE SET
			count = count + 1,
			updated_at = excluded.updated_at`,
	)
		.bind(config.scope, actorHash, windowStart)
		.run();

	const row = await env.DB.prepare(
		`SELECT count
		FROM rate_limits
		WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();

	await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
		.bind(nowSeconds - RATE_LIMIT_MAX_AGE_SECONDS)
		.run();

	if (Number(row?.count ?? 0) <= config.limit) return null;

	const response = json({ error: "请求过于频繁，请稍后再试。" }, 429);
	response.headers.set("retry-after", String(retryAfterSeconds));
	return response;
}

async function shouldRequireTurnstile(
	request: Request,
	env: Env,
	context: HumanProofContext,
): Promise<{ required: boolean; reason: string }> {
	if (isLikelyBot(request)) {
		return { required: true, reason: "bot-user-agent" };
	}

	const failureCount = await getRateLimitCount(request, env, {
		...RATE_LIMITS.humanProofFailure,
		scope: `${RATE_LIMITS.humanProofFailure.scope}:${context}`,
	});
	if (failureCount >= RATE_LIMITS.humanProofFailure.limit) {
		return { required: true, reason: "proof-failures" };
	}

	const submitConfig = context === "friends"
		? RATE_LIMITS.friendSubmit
		: RATE_LIMITS.commentsSession;
	const submitCount = await getRateLimitCount(request, env, submitConfig);
	if (submitCount >= TURNSTILE_SUBMIT_THRESHOLD) {
		return { required: true, reason: "high-frequency" };
	}

	return { required: false, reason: "" };
}

async function recordHumanProofFailure(
	request: Request,
	env: Env,
	context: HumanProofContext,
): Promise<void> {
	await incrementRateLimitCounter(request, env, {
		...RATE_LIMITS.humanProofFailure,
		scope: `${RATE_LIMITS.humanProofFailure.scope}:${context}`,
	});
}

async function getRateLimitCount(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<number> {
	const readyError = await ensureRateLimitReady(env);
	if (readyError) return 0;

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart = getRateLimitWindowStart(nowSeconds, config.windowSeconds);
	const actorHash = await getRateLimitActorHash(request, env, config.scope);
	const row = await env.DB.prepare(
		`SELECT count
		FROM rate_limits
		WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();

	return Number(row?.count ?? 0);
}

async function incrementRateLimitCounter(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<number> {
	const readyError = await ensureRateLimitReady(env);
	if (readyError) return 0;

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart = getRateLimitWindowStart(nowSeconds, config.windowSeconds);
	const actorHash = await getRateLimitActorHash(request, env, config.scope);

	await env.DB.prepare(
		`INSERT INTO rate_limits (scope, actor_hash, window_start, count, updated_at)
		VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		ON CONFLICT(scope, actor_hash, window_start) DO UPDATE SET
			count = count + 1,
			updated_at = excluded.updated_at`,
	)
		.bind(config.scope, actorHash, windowStart)
		.run();

	const row = await env.DB.prepare(
		`SELECT count
		FROM rate_limits
		WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();

	return Number(row?.count ?? 0);
}

function getRateLimitWindowStart(nowSeconds: number, windowSeconds: number): number {
	return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

async function getRateLimitActorHash(
	request: Request,
	env: Env,
	scope: string,
): Promise<string> {
	const salt = await ensureStatsSalt(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	const ip =
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-real-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"";
	return hashToken(`${salt}:rate:${scope}:${ip}:${userAgent}`);
}

function rejectCrossSiteWrite(request: Request): Response | null {
	const origin = request.headers.get("origin");
	if (origin && !isSameOrigin(origin, request.url)) {
		return json({ error: "跨站请求已被拒绝。" }, 403);
	}

	const referer = request.headers.get("referer");
	if (!origin && referer && !isSameOrigin(referer, request.url)) {
		return json({ error: "跨站请求已被拒绝。" }, 403);
	}

	return null;
}

function isSameOrigin(value: string, requestUrl: string): boolean {
	try {
		return new URL(value).origin === new URL(requestUrl).origin;
	} catch {
		return false;
	}
}

function isHttpsUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isAvatarUrl(value: string): boolean {
	if (isHttpsUrl(value)) return true;

	if (value.startsWith("/media/avatars/")) {
		return safeNormalizeMediaKey(value.slice("/media/avatars/".length), "avatars") !== null;
	}

	if (value.startsWith("/media/covers/")) {
		return safeNormalizeMediaKey(value.slice("/media/covers/".length), "covers") !== null;
	}

	return false;
}

function embeddedCoverUrlForMusicKey(objectKey: string): string {
	const key = safeNormalizeMediaKey(objectKey, "music");
	if (!key) return "";
	if (!key.toLowerCase().endsWith(".mp3")) return "";
	return `/media/covers/from-music/${stripMediaPrefix(key, "music")}`;
}

function safeNormalizeMediaKey(value: string, prefix: string): string | null {
	const validPrefixes = new Set(["music", "avatars", "covers", "twikoo"]);
	if (!validPrefixes.has(prefix)) return null;

	let clean = safeDecodeURIComponent(value)
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.trim();
	if (clean.startsWith(`${prefix}/`)) {
		clean = clean.slice(prefix.length + 1);
	}

	if (!clean || clean.length > 1024 || clean.includes("\0")) return null;
	const parts = clean.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return null;

	return `${prefix}/${parts.join("/")}`;
}

function stripMediaPrefix(value: string, prefix: string): string {
	return value.replace(new RegExp(`^${prefix}/`), "");
}

function sanitizeFileName(value: string): string {
	const clean = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	return clean || "avatar";
}

function withSecurityHeaders(response: Response): Response {
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		if (!secured.headers.has(name)) {
			secured.headers.set(name, value);
		}
	}
	return secured;
}

function withServerTiming(response: Response, startedAt: number): Response {
	const timed = new Response(response.body, response);
	const totalMs = Math.max(0, performance.now() - startedAt).toFixed(1);
	const existing = timed.headers.get("server-timing");
	timed.headers.set(
		"server-timing",
		existing ? `${existing}, total;dur=${totalMs}` : `total;dur=${totalMs}`,
	);
	return timed;
}

async function cachedResponse(
	request: Request,
	ctx: ExecutionContext,
	ttlSeconds: number,
	producer: () => Promise<Response> | Response,
): Promise<Response> {
	if (request.method !== "GET") return producer();

	const cache = (caches as CacheStorage & { readonly default: Cache }).default;
	const cacheKey = new Request(request.url, request);
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const response = await producer();
	const next = new Response(response.body, response);

	if (next.status !== 200 || next.headers.has("set-cookie")) {
		return next;
	}

	next.headers.set(
		"cache-control",
		`public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
	);
	ctx.waitUntil(cache.put(cacheKey, next.clone()));
	return next;
}

function json(data: unknown, status = 200): Response {
	return withSecurityHeaders(Response.json(data, {
		status,
		headers: {
			"cache-control": "no-store",
		},
	}));
}
