/// <reference types="@cloudflare/workers-types" />

type Env = {
	DB: D1Database;
	MEDIA_BUCKET: R2Bucket;
	ASSETS: Fetcher;
	ADMIN_TOKEN?: string;
};

type JsonRecord = Record<string, unknown>;

type RangeResult =
	| { ok: true; start: number; end: number; length: number }
	| { ok: false };

const FRIEND_STATUSES = new Set(["pending", "approved", "rejected"]);
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
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
];

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const requestUrl = new URL(request.url);

		try {
			if (requestUrl.pathname.startsWith("/setup/init-db")) {
				return await initializeDatabase(request, env, requestUrl);
			}

			if (requestUrl.pathname.startsWith("/api/")) {
				return await handleApi(request, env, requestUrl);
			}

			if (requestUrl.pathname.startsWith("/media/")) {
				return await handleMedia(request, env, requestUrl);
			}

			return env.ASSETS.fetch(request);
		} catch (error) {
			console.error(error);
			return json({ error: "服务器暂时开小差了，请稍后再试。" }, 500);
		}
	},
};

async function handleApi(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const { pathname } = requestUrl;

	if (pathname === "/api/setup/init-db") {
		return initializeDatabase(request, env, requestUrl);
	}

	if (pathname === "/api/friends") {
		if (request.method === "GET") return getApprovedFriends(env);
		if (request.method === "POST") return submitFriendLink(request, env);
	}

	if (pathname === "/api/music/tracks" && request.method === "GET") {
		return getPublicMusicTracks(env);
	}

	if (pathname.startsWith("/api/admin/")) {
		const auth = requireAdmin(request, env);
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

	const auth = requireSetupToken(request, env, requestUrl);
	if (auth) return auth;

	const results = await env.DB.batch(
		INIT_DB_STATEMENTS.map((statement) => env.DB.prepare(statement)),
	);
	return json({
		ok: true,
		message: "Database initialized. Existing data was kept.",
		statements: results.length,
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

async function submitFriendLink(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJson(request);
	const name = readString(body.name, 40);
	const description = readString(body.description, 120);
	const linkUrl = readString(body.url, 400);
	const avatarUrl = readString(body.avatarUrl, 600);

	if (!name || !description || !linkUrl || !avatarUrl) {
		return json({ error: "请填写完整的名称、简介、链接和头像。" }, 400);
	}

	if (!isHttpUrl(linkUrl)) {
		return json({ error: "链接必须是 http 或 https 地址。" }, 400);
	}

	if (!isAvatarUrl(avatarUrl)) {
		return json({ error: "头像需要使用公网 http/https 地址或站内头像地址。" }, 400);
	}

	await env.DB.prepare(
		`INSERT INTO friend_links (name, description, url, avatar_url, status)
		VALUES (?, ?, ?, ?, 'pending')`,
	)
		.bind(name, description, linkUrl, avatarUrl)
		.run();

	return json({ ok: true, message: "申请已提交，审核通过后会自动展示。" }, 201);
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
			coverUrl: row.coverUrl,
			objectKey: row.objectKey,
			audioUrl: `/media/music/${stripMediaPrefix(String(row.objectKey), "music")}`,
		};
	});

	return json({ tracks });
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

	if (segments[2] === "friends") {
		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminFriends(env, requestUrl);
		if (request.method === "PATCH" && id) return updateFriend(request, env, id);
		if (request.method === "DELETE" && id) return deleteFriend(env, id);
	}

	if (segments[2] === "music") {
		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminMusic(env);
		if (request.method === "POST" && !id) return createMusicTrack(request, env);
		if (request.method === "PATCH" && id) return updateMusicTrack(request, env, id);
		if (request.method === "DELETE" && id) return deleteMusicTrack(env, id);
	}

	return json({ error: "后台接口不存在。" }, 404);
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
		if (!isHttpUrl(value)) return json({ error: "链接必须是 http 或 https 地址。" }, 400);
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

	if (!file.type.startsWith("image/")) {
		return json({ error: "头像必须是图片文件。" }, 400);
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

async function createMusicTrack(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJson(request);
	const title = readString(body.title, 80);
	const artist = readString(body.artist, 80);
	const album = readString(body.album, 80);
	const objectKey = normalizeR2MusicKey(readString(body.objectKey, 500));
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
		fields.push("object_key = ?");
		values.push(normalizeR2MusicKey(readString(body.objectKey, 500)));
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
	const rawKey = decodeURIComponent(segments.slice(2).join("/"));

	if (kind !== "music" && kind !== "avatars") {
		return json({ error: "媒体类型不存在。" }, 404);
	}

	const prefix = kind === "music" ? "music" : "avatars";
	const key = normalizeMediaKey(rawKey, prefix);
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

function requireAdmin(request: Request, env: Env): Response | null {
	if (!env.ADMIN_TOKEN) {
		return json({ error: "ADMIN_TOKEN 尚未配置。" }, 503);
	}

	const authorization = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${env.ADMIN_TOKEN}`;

	if (authorization !== expected) {
		return json({ error: "管理口令不正确。" }, 401);
	}

	return null;
}

function requireSetupToken(
	request: Request,
	env: Env,
	requestUrl: URL,
): Response | null {
	if (!env.ADMIN_TOKEN) {
		return json({ error: "ADMIN_TOKEN is not configured." }, 503);
	}

	const authorization = request.headers.get("authorization") ?? "";
	const bearerToken = authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: "";
	const pathToken = requestUrl.pathname.startsWith("/setup/init-db/")
		? decodeURIComponent(requestUrl.pathname.split("/").filter(Boolean)[2] ?? "")
		: "";
	const token = requestUrl.searchParams.get("token") || bearerToken || pathToken;

	if (token !== env.ADMIN_TOKEN) {
		return json({
			error: "Invalid setup token. Use /api/setup/init-db?token=ADMIN_TOKEN.",
		}, 401);
	}

	return null;
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

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isAvatarUrl(value: string): boolean {
	return isHttpUrl(value) || value.startsWith("/media/avatars/");
}

function normalizeR2MusicKey(value: string): string {
	return normalizeMediaKey(value, "music");
}

function normalizeMediaKey(value: string, prefix: string): string {
	const clean = value.replace(/^\/+/, "").replace(/\.\./g, "");
	if (clean.startsWith(`${prefix}/`)) return clean;
	return `${prefix}/${clean}`;
}

function stripMediaPrefix(value: string, prefix: string): string {
	return value.replace(new RegExp(`^${prefix}/`), "");
}

function sanitizeFileName(value: string): string {
	const clean = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	return clean || "avatar";
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: {
			"cache-control": "no-store",
		},
	});
}
