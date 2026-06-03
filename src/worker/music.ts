import {
	AUDIO_EXTENSIONS,
	apiError,
	DEFAULT_MUSIC_COVER_URL,
	MAX_JSON_BODY_BYTES,
	MAX_MUSIC_UPLOAD_BYTES,
	MUSIC_OBJECT_SCAN_LIMIT,
	MUSIC_PREFIX,
	MUSIC_UPLOAD_R2_BATCH_SIZE,
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
	inferMusicMetadataFromKey,
	isAvatarUrl,
	json,
	readBoolean,
	readInteger,
	readJson,
	readMusicMetadataFromR2,
	readString,
	rejectOversizedBody,
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
			coverUrl: musicCoverUrl(
				String(row.coverUrl ?? ""),
				String(row.objectKey),
			),
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
	const tracks = (result.results ?? []).map((track) => {
		const row = track as Record<string, unknown>;
		return {
			...row,
			coverUrl: musicCoverUrl(
				String(row.coverUrl ?? ""),
				String(row.objectKey ?? ""),
			),
		};
	});
	return json({ tracks });
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

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

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
			: DEFAULT_MUSIC_COVER_URL;
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
// Admin: upload and sort music
// ================================================================

export async function normalizeMusicTrackSort(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT id
	     FROM music_tracks
	     ORDER BY sort_order ASC, created_at DESC, id ASC`,
	).all<{ id: number }>();
	const rows = result.results ?? [];

	if (rows.length === 0) {
		return json({ ok: true, updated: 0 });
	}

	const statements = rows.map((row, index) =>
		env.DB.prepare("UPDATE music_tracks SET sort_order = ? WHERE id = ?").bind(
			index + 1,
			row.id,
		),
	);
	const results = await env.DB.batch(statements);
	if (results.some((item) => !item.success)) {
		return json({ error: apiError("SERVER_ERROR") }, 500);
	}

	invalidateScanCache();
	await incrementCacheVersion(env, "music");
	ctx.waitUntil(
		auditAdminAction(
			env,
			request,
			"update",
			"music",
			"",
			JSON.stringify({ action: "normalize-sort", count: rows.length }),
		),
	);
	return json({ ok: true, updated: rows.length });
}

export async function uploadMusicFiles(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.MEDIA_BUCKET) {
		return json({ error: apiError("MISSING_R2") }, 503);
	}

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("multipart/form-data")) {
		return json({ error: apiError("MUSIC_UPLOAD_TYPE_INVALID") }, 400);
	}

	const formData = await request.formData();
	const files = formData
		.getAll("files")
		.filter((value): value is File => value instanceof File);
	const isActive = readBoolean(formData.get("isActive"), true) ? 1 : 0;

	if (files.length === 0) {
		return json({ error: apiError("MUSIC_UPLOAD_EMPTY") }, 400);
	}

	const maxSortRow = await env.DB.prepare(
		"SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM music_tracks",
	).first<{ maxSort: number }>();
	let sortOrder = Number(maxSortRow?.maxSort ?? 0) + 1;
	const uploaded: MusicUploadResult[] = [];
	const duplicates: MusicUploadResult[] = [];
	const failed: MusicUploadFailure[] = [];

	for (const batch of chunkFiles(files, MUSIC_UPLOAD_R2_BATCH_SIZE)) {
		for (const file of batch) {
			const fileName = file.name || "music-file";
			const ext = getAudioExtension(fileName);
			if (!ext) {
				failed.push({
					fileName,
					status: "failed",
					reason: "unsupported-type",
				});
				continue;
			}
			if (file.size <= 0) {
				failed.push({ fileName, status: "failed", reason: "empty-file" });
				continue;
			}
			if (file.size > MAX_MUSIC_UPLOAD_BYTES) {
				failed.push({ fileName, status: "failed", reason: "too-large" });
				continue;
			}

			try {
				const bytes = await file.arrayBuffer();
				const hash = await sha256Hex(bytes);
				const existing = await findMusicTrackByHash(env, hash);
				if (existing) {
					duplicates.push({
						fileName,
						objectKey: existing.objectKey,
						hash,
						size: file.size,
						trackId: existing.id,
						status: "duplicate",
					});
					continue;
				}

				const objectKey = buildUploadedMusicKey(fileName, hash, ext);
				const objectExists = await env.MEDIA_BUCKET.head(objectKey);
				const existingByKey = objectExists
					? await findMusicTrackByObjectKey(env, objectKey)
					: null;
				if (existingByKey) {
					duplicates.push({
						fileName,
						objectKey,
						hash,
						size: file.size,
						trackId: existingByKey.id,
						status: "duplicate",
					});
					continue;
				}

				if (!objectExists) {
					await env.MEDIA_BUCKET.put(objectKey, bytes, {
						httpMetadata: { contentType: audioContentType(ext) },
					});
				}

				const r2Metadata = await readMusicMetadataFromR2(env, objectKey);
				const uploadFallback = inferMusicMetadataFromKey(`music/${fileName}`);
				const metadata =
					r2Metadata.artist || r2Metadata.album
						? r2Metadata
						: { ...r2Metadata, ...uploadFallback, cover: r2Metadata.cover };
				const coverUrl = metadata.cover
					? await saveEmbeddedCover(env, objectKey, metadata.cover)
					: DEFAULT_MUSIC_COVER_URL;
				const insert = await env.DB.prepare(
					`INSERT INTO music_tracks
			       (title, artist, album, object_key, cover_url, is_active, sort_order, content_hash)
			       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
					.bind(
						metadata.title,
						metadata.artist,
						metadata.album,
						objectKey,
						coverUrl,
						isActive,
						sortOrder,
						hash,
					)
					.run();

				uploaded.push({
					fileName,
					objectKey,
					hash,
					size: file.size,
					trackId: Number(insert.meta.last_row_id ?? 0),
					status: "uploaded",
				});
				sortOrder += 1;
			} catch (error) {
				failed.push({
					fileName,
					status: "failed",
					reason: error instanceof Error ? error.message : "upload-failed",
				});
			}
		}
	}

	if (uploaded.length > 0) {
		invalidateScanCache();
		await incrementCacheVersion(env, "music");
		ctx.waitUntil(
			auditAdminAction(
				env,
				request,
				"import",
				"music",
				"",
				JSON.stringify({
					action: "upload",
					uploaded: uploaded.length,
					duplicates: duplicates.length,
					failed: failed.length,
				}),
			),
		);
	}

	return json({ ok: true, uploaded, duplicates, failed }, 201);
}

// ================================================================
// Admin: create / update / delete music track
// ================================================================

export async function createMusicTrack(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

	const body = await readJson(request);
	const title = readString(body.title, 80);
	const artist = readString(body.artist, 80);
	const album = readString(body.album, 80);
	const objectKey = safeNormalizeMediaKey(
		readString(body.objectKey, 500),
		"music",
	);
	const coverUrl = musicCoverUrl(readString(body.coverUrl, 600));
	const sortOrder = readInteger(body.sortOrder, 0);
	const isActive = readBoolean(body.isActive, true) ? 1 : 0;

	if (!title || !objectKey) {
		return json({ error: apiError("MUSIC_FIELDS_MISSING") }, 400);
	}

	if (!isMusicCoverUrl(coverUrl)) {
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

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

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
		const v = musicCoverUrl(readString(body.coverUrl, 600));
		if (!isMusicCoverUrl(v))
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

type MusicUploadResult = {
	fileName: string;
	objectKey: string;
	hash: string;
	size: number;
	trackId: number;
	status: "uploaded" | "duplicate";
};

type MusicUploadFailure = {
	fileName: string;
	status: "failed";
	reason: string;
};

type ExistingMusicTrackRef = {
	id: number;
	objectKey: string;
};

function musicCoverUrl(value: string, objectKey = ""): string {
	if (value) return value;
	return embeddedCoverUrlForMusicKey(objectKey) || DEFAULT_MUSIC_COVER_URL;
}

function isMusicCoverUrl(value: string): boolean {
	return value === DEFAULT_MUSIC_COVER_URL || isAvatarUrl(value);
}

function chunkFiles(files: File[], size: number): File[][] {
	const chunks: File[][] = [];
	for (let index = 0; index < files.length; index += size) {
		chunks.push(files.slice(index, index + size));
	}
	return chunks;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function getAudioExtension(fileName: string): string | null {
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	return AUDIO_EXTENSIONS.has(ext) ? ext : null;
}

function buildUploadedMusicKey(
	fileName: string,
	hash: string,
	ext: string,
): string {
	const baseName = sanitizeFileName(fileName.replace(/\.[^.]+$/, ""));
	return `music/${baseName}-${hash.slice(0, 12)}.${ext}`;
}

function audioContentType(ext: string): string {
	if (ext === "mp3") return "audio/mpeg";
	if (ext === "m4a") return "audio/mp4";
	if (ext === "aac") return "audio/aac";
	if (ext === "flac") return "audio/flac";
	if (ext === "wav") return "audio/wav";
	if (ext === "ogg") return "audio/ogg";
	if (ext === "opus") return "audio/opus";
	if (ext === "webm") return "audio/webm";
	return "application/octet-stream";
}

async function findMusicTrackByHash(
	env: Env,
	hash: string,
): Promise<ExistingMusicTrackRef | null> {
	const track = await env.DB.prepare(
		`SELECT id, object_key AS objectKey
	     FROM music_tracks
	     WHERE content_hash = ? AND content_hash != ''
	     LIMIT 1`,
	)
		.bind(hash)
		.first<ExistingMusicTrackRef>();
	return track ?? null;
}

async function findMusicTrackByObjectKey(
	env: Env,
	objectKey: string,
): Promise<ExistingMusicTrackRef | null> {
	const track = await env.DB.prepare(
		`SELECT id, object_key AS objectKey
	     FROM music_tracks
	     WHERE object_key = ?
	     LIMIT 1`,
	)
		.bind(objectKey)
		.first<ExistingMusicTrackRef>();
	return track ?? null;
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
			const coverUrl = metadata.cover
				? embeddedCoverUrlForMusicKey(key)
				: DEFAULT_MUSIC_COVER_URL;
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
