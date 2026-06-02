import {
	AUDIO_EXTENSIONS,
	apiError,
	MUSIC_OBJECT_SCAN_LIMIT,
	MUSIC_PREFIX,
} from "./constants";
import type { Env } from "./types";
import type {
	EmbeddedCover,
	MusicObjectInfo,
	MusicTrackDto,
} from "./types/aliases";
import {
	auditAdminAction,
	embeddedCoverUrlForMusicKey,
	getMusicFileNameFromKey,
	incrementCacheVersion,
	isAvatarUrl,
	json,
	readBoolean,
	readInteger,
	readJson,
	readMusicMetadataFromR2,
	readString,
	safeNormalizeMediaKey,
	sanitizeFileName,
	stripMediaPrefix,
} from "./utils";

// ================================================================
// Public: GET /api/music/tracks
// ================================================================

export async function getPublicMusicTracks(env: Env): Promise<Response> {
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
			coverUrl:
				row.coverUrl || embeddedCoverUrlForMusicKey(String(row.objectKey)),
			audioUrl: `/media/music/${stripMediaPrefix(
				String(row.objectKey),
				"music",
			)}`,
		};
	});

	return json({ tracks });
}

// ================================================================
// Admin: list music
// ================================================================

export async function listAdminMusic(env: Env): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM music_tracks
     ORDER BY sort_order ASC, created_at DESC`,
	).all();
	return json({ tracks: result.results ?? [] });
}

// ================================================================
// Admin: list R2 music objects
// ================================================================

export async function listR2MusicObjects(env: Env): Promise<Response> {
	if (!env.MEDIA_BUCKET) {
		return json({ error: apiError("MISSING_R2") }, 503);
	}
	const objects = await scanR2MusicObjects(env);
	return json({ objects: objects.map(stripCoverBytes) });
}

// ================================================================
// Admin: import R2 music objects
// ================================================================

export async function importR2MusicObjects(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.MEDIA_BUCKET) {
		return json({ error: apiError("MISSING_R2") }, 503);
	}

	const body = await readJson(request);
	const requestedKeys = Array.isArray(body.objectKeys)
		? (body.objectKeys as string[])
				.filter((key): key is string => typeof key === "string")
				.map((key) => safeNormalizeMediaKey(key, "music"))
				.filter((key): key is string => Boolean(key))
		: [];
	const isActive = readBoolean(body.isActive, true) ? 1 : 0;
	const objects = await scanR2MusicObjects(env);
	const requestedKeySet = new Set(requestedKeys);
	const candidates = objects.filter((obj) => {
		if (obj.imported) return false;
		return requestedKeySet.size === 0 || requestedKeySet.has(obj.key);
	});

	if (candidates.length === 0) {
		return json({
			ok: true,
			imported: [],
			message: apiError("MUSIC_IMPORT_EMPTY"),
		});
	}

	const maxSortRow = await env.DB.prepare(
		"SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM music_tracks",
	).first<{ maxSort: number }>();
	let sortOrder = readInteger(
		body.sortOrderStart,
		Number(maxSortRow?.maxSort ?? 0) + 1,
	);
	const imported: Record<string, unknown>[] = [];

	for (const obj of candidates) {
		const coverUrl = obj.cover
			? await saveEmbeddedCover(env, obj.key, obj.cover)
			: "";
		const result = await env.DB.prepare(
			`INSERT INTO music_tracks
       (title, artist, album, object_key, cover_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				obj.title,
				obj.artist,
				obj.album,
				obj.key,
				coverUrl,
				isActive,
				sortOrder,
			)
			.run();

		imported.push({
			id: result.meta.last_row_id,
			title: obj.title,
			artist: obj.artist,
			album: obj.album,
			objectKey: obj.key,
			coverUrl,
			isActive,
			sortOrder,
		});
		sortOrder += 1;
	}

	invalidateScanCache();
	await incrementCacheVersion(env, "music");
	ctx.waitUntil(
		auditAdminAction(
			env,
			request,
			"import",
			"music",
			"",
			JSON.stringify({ count: imported.length }),
		),
	);
	return json({ ok: true, imported }, 201);
}

// ================================================================
// Admin: create / update / delete music track
// ================================================================

export async function createMusicTrack(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const body = await readJson(request);
	const title = readString(body.title, 80);
	const artist = readString(body.artist, 80);
	const album = readString(body.album, 80);
	const objectKey = safeNormalizeMediaKey(
		readString(body.objectKey, 500),
		"music",
	);
	const coverUrl = readString(body.coverUrl, 600);
	const sortOrder = readInteger(body.sortOrder, 0);
	const isActive = readBoolean(body.isActive, true) ? 1 : 0;

	if (!title || !objectKey) {
		return json({ error: apiError("MUSIC_FIELDS_MISSING") }, 400);
	}

	if (coverUrl && !isAvatarUrl(coverUrl)) {
		return json({ error: apiError("MUSIC_COVER_R2") }, 400);
	}

	const result = await env.DB.prepare(
		`INSERT INTO music_tracks
     (title, artist, album, object_key, cover_url, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(title, artist, album, objectKey, coverUrl, isActive, sortOrder)
		.run();

	invalidateScanCache();
	await incrementCacheVersion(env, "music");
	ctx.waitUntil(
		auditAdminAction(
			env,
			request,
			"create",
			"music",
			String(result.meta.last_row_id ?? 0),
			JSON.stringify({ title, artist, album, objectKey }),
		),
	);
	return json({ ok: true, id: result.meta.last_row_id }, 201);
}

export async function updateMusicTrack(
	request: Request,
	env: Env,
	id: number,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("MUSIC_ID_INVALID") }, 400);

	const body = await readJson(request);
	const fields: string[] = [];
	const values: (string | number)[] = [];

	if (typeof body.title === "string") {
		fields.push("title = ?");
		values.push(readString(body.title, 80));
	}
	if (typeof body.artist === "string") {
		fields.push("artist = ?");
		values.push(readString(body.artist, 80));
	}
	if (typeof body.album === "string") {
		fields.push("album = ?");
		values.push(readString(body.album, 80));
	}
	if (typeof body.objectKey === "string") {
		const v = safeNormalizeMediaKey(readString(body.objectKey, 500), "music");
		if (!v) return json({ error: apiError("MUSIC_OBJECT_KEY_INVALID") }, 400);
		fields.push("object_key = ?");
		values.push(v);
	}
	if (typeof body.coverUrl === "string") {
		const v = readString(body.coverUrl, 600);
		if (v && !isAvatarUrl(v))
			return json({ error: apiError("MUSIC_COVER_INVALID") }, 400);
		fields.push("cover_url = ?");
		values.push(v);
	}
	if (typeof body.isActive === "boolean") {
		fields.push("is_active = ?");
		values.push(body.isActive ? 1 : 0);
	}
	if (
		typeof body.sortOrder === "number" ||
		typeof body.sortOrder === "string"
	) {
		fields.push("sort_order = ?");
		values.push(readInteger(body.sortOrder, 0));
	}

	if (fields.length > 0) {
		await env.DB.prepare(
			`UPDATE music_tracks SET ${fields.join(", ")} WHERE id = ?`,
		)
			.bind(...values, id)
			.run();
	}

	const track = await env.DB.prepare(
		`SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM music_tracks WHERE id = ?`,
	)
		.bind(id)
		.first<MusicTrackDto>();

	if (!track) return json({ error: apiError("MUSIC_NOT_FOUND") }, 404);
	invalidateScanCache();
	await incrementCacheVersion(env, "music");
	ctx.waitUntil(
		auditAdminAction(env, request, "update", "music", id, JSON.stringify(body)),
	);
	return json({ track });
}

export async function deleteMusicTrack(
	request: Request,
	env: Env,
	id: number,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("MUSIC_ID_INVALID") }, 400);
	await env.DB.prepare("DELETE FROM music_tracks WHERE id = ?").bind(id).run();
	invalidateScanCache();
	await incrementCacheVersion(env, "music");
	ctx.waitUntil(auditAdminAction(env, request, "delete", "music", id));
	return json({ ok: true });
}

// ================================================================
// R2 scanning helpers
// ================================================================

// Per-instance in-memory scan cache (lives for the lifetime of the Worker isolate).
// Avoids re-reading ID3 metadata for every object on every admin page load.
// Cleared automatically when music tracks are created / updated / deleted.
let scanResultCache: MusicObjectInfo[] | null = null;
let scanResultCacheTs = 0;
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function invalidateScanCache(): void {
	scanResultCache = null;
	scanResultCacheTs = 0;
}

async function scanR2MusicObjects(env: Env): Promise<MusicObjectInfo[]> {
	if (scanResultCache && Date.now() - scanResultCacheTs < SCAN_CACHE_TTL_MS) {
		return scanResultCache;
	}

	const existingKeys = await getExistingMusicKeys(env);
	const objects: MusicObjectInfo[] = [];
	let cursor: string | undefined;

	do {
		const listed = await env.MEDIA_BUCKET.list({
			prefix: MUSIC_PREFIX,
			cursor,
			limit: Math.min(1000, MUSIC_OBJECT_SCAN_LIMIT - objects.length),
		});

		for (const obj of listed.objects) {
			if (objects.length >= MUSIC_OBJECT_SCAN_LIMIT) break;
			if (!isAudioObjectKey(obj.key)) continue;

			const key = safeNormalizeMediaKey(obj.key, "music");
			if (!key) continue;

			const metadata = await readMusicMetadataFromR2(env, key);
			const coverUrl = embeddedCoverUrlForMusicKey(key);
			objects.push({
				...metadata,
				key,
				fileName: getMusicFileNameFromKey(key),
				size: obj.size,
				uploaded:
					obj.uploaded instanceof Date
						? obj.uploaded.toISOString()
						: String(obj.uploaded),
				imported: existingKeys.has(key),
				audioUrl: `/media/music/${stripMediaPrefix(key, "music")}`,
				coverUrl,
				hasEmbeddedCover: Boolean(metadata.cover),
			});
		}

		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor && objects.length < MUSIC_OBJECT_SCAN_LIMIT);

	const sorted = objects.sort((a, b) =>
		a.fileName.localeCompare(b.fileName, "zh-Hans-CN"),
	);
	scanResultCache = sorted;
	scanResultCacheTs = Date.now();
	return sorted;
}

function stripCoverBytes(obj: MusicObjectInfo): Omit<MusicObjectInfo, "cover"> {
	const { cover: _c, ...safe } = obj;
	return safe;
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

function isAudioObjectKey(key: string): boolean {
	if (key.endsWith("/")) return false;
	const ext = key.split(".").pop()?.toLowerCase() ?? "";
	return AUDIO_EXTENSIONS.has(ext);
}

async function saveEmbeddedCover(
	env: Env,
	musicKey: string,
	cover: EmbeddedCover,
): Promise<string> {
	const ext = imageExtensionFromMimeType(cover.mimeType);
	const baseName = sanitizeFileName(
		getMusicFileNameFromKey(musicKey).replace(/\.[^.]+$/, ""),
	);
	const key = `covers/${baseName}-${crypto.randomUUID()}.${ext}`;
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
