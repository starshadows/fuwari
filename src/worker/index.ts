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

type MusicMetadata = {
	title: string;
	artist: string;
	album: string;
};

type EmbeddedCover = {
	mimeType: string;
	bytes: Uint8Array;
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
const ADMIN_TOKEN_SETTING_KEY = "admin_token_sha256";
const MUSIC_PREFIX = "music/";
const MUSIC_OBJECT_SCAN_LIMIT = 200;
const MUSIC_METADATA_READ_BYTES = 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "webm"]);
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

	const results = await env.DB.batch(
		INIT_DB_STATEMENTS.map((statement) => env.DB.prepare(statement)),
	);
	const tokenResult = await setupAdminToken(request, env, requestUrl);
	if (tokenResult instanceof Response) return tokenResult;

	return json({
		ok: true,
		message: "Database initialized. Existing data was kept.",
		statements: results.length,
		adminTokenSource: tokenResult,
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
			objectKey: row.objectKey,
			coverUrl: row.coverUrl || embeddedCoverUrlForMusicKey(String(row.objectKey)),
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
				.map((key) => normalizeR2MusicKey(key))
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

			const metadata = await readMusicMetadata(env, object.key);
			const key = normalizeR2MusicKey(object.key);
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
			.filter(Boolean)
			.map(normalizeR2MusicKey),
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

	if (kind === "covers" && rawKey.startsWith("from-music/")) {
		return getEmbeddedCoverResponse(request, env, rawKey.slice("from-music/".length));
	}

	if (kind !== "music" && kind !== "avatars" && kind !== "covers") {
		return json({ error: "媒体类型不存在。" }, 404);
	}

	const key = normalizeMediaKey(rawKey, kind);
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
	const key = normalizeMediaKey(rawMusicKey, "music");
	const metadata = await readMusicMetadata(env, key);
	if (!metadata.cover) return new Response("Not found", { status: 404 });

	const headers = new Headers({
		"content-type": metadata.cover.mimeType,
		"cache-control": "public, max-age=86400",
	});
	headers.set("content-length", String(metadata.cover.bytes.byteLength));

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

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
	const token = readBearerToken(request);

	if (!token) {
		return json({ error: "Missing admin token." }, 401);
	}

	if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
		return null;
	}

	if (env.DB && await verifyStoredAdminToken(env, token)) {
		return null;
	}

	if (!env.ADMIN_TOKEN && env.DB && !(await getStoredAdminTokenHash(env))) {
		return json({
			error: "Admin token is not initialized. Visit /api/setup/init-db?token=your-token first.",
		}, 503);
	}

	return json({ error: "Invalid admin token." }, 401);
}

async function setupAdminToken(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response | "env" | "database"> {
	const token = readSetupToken(request, requestUrl);

	if (!token) {
		return json({
			error: "Missing setup token. Use /api/setup/init-db?token=your-token.",
		}, 401);
	}

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

function readSetupToken(request: Request, requestUrl: URL): string {
	const pathToken = requestUrl.pathname.startsWith("/setup/init-db/")
		? decodeURIComponent(requestUrl.pathname.split("/").filter(Boolean)[2] ?? "")
		: "";
	return (
		requestUrl.searchParams.get("token")?.trim() ||
		readBearerToken(request) ||
		pathToken.trim()
	);
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

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);

	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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
	return (
		isHttpUrl(value) ||
		value.startsWith("/media/avatars/") ||
		value.startsWith("/media/covers/")
	);
}

function normalizeR2MusicKey(value: string): string {
	return normalizeMediaKey(value, "music");
}

function embeddedCoverUrlForMusicKey(objectKey: string): string {
	const key = normalizeR2MusicKey(objectKey);
	if (!key.toLowerCase().endsWith(".mp3")) return "";
	return `/media/covers/from-music/${stripMediaPrefix(key, "music")}`;
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
